//! 砚池 (Inkwell) —— Rust 后端。
//!
//! 职责划分：
//!   - `db`      SQLite 连接与迁移
//!   - `epub`    EPUB 元数据/封面解析
//!   - `library` 书库业务逻辑（导入、查询、删除、进度）
//!   - 本文件     Tauri 状态、command 注册、插件装配

mod db;
mod epub;
mod error;
mod library;

use error::{Error, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// 全局状态：数据库连接 + 数据目录。
pub struct AppState {
    pub conn: Mutex<Connection>,
    pub data_dir: PathBuf,
}

impl AppState {
    fn books_dir(&self) -> PathBuf {
        self.data_dir.join("books")
    }
    fn covers_dir(&self) -> PathBuf {
        self.data_dir.join("covers")
    }
    /// 把库里的相对路径还原成绝对路径
    fn abs(&self, sub: &str, rel: &str) -> PathBuf {
        self.data_dir.join(sub).join(rel)
    }
}

/// 应用数据根目录。
///
/// 不使用 Tauri 默认的 `app_data_dir()` —— 它会拿 identifier（com.inkwell.reader）
/// 当目录名，既不好认，也和「目录名跟随应用名」的约定不符。这里显式指定为 `Inkwell`。
#[cfg(desktop)]
fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(base.join("Inkwell"))
}

/// Android 上没有 %APPDATA%，用 Tauri 提供的应用私有目录（沙箱内，无需额外权限）。
#[cfg(mobile)]
fn data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// 子目录布局：books/ 放书籍本体，covers/ 放封面缩略图。
fn ensure_layout(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    std::fs::create_dir_all(root.join("books"))?;
    std::fs::create_dir_all(root.join("covers"))?;
    Ok(())
}

// ============================================================================
//  command
// ============================================================================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    version: String,
    platform: String,
    arch: String,
    data_dir: Option<String>,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let pkg = app.package_info();

    #[cfg(desktop)]
    let dir = data_dir();
    #[cfg(mobile)]
    let dir = data_dir(&app);

    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: dir.map(|p| p.display().to_string()),
    }
}

/// 书库列表，附带封面与书籍的绝对路径（前端直接喂给 asset 协议 / foliate-js）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BookView {
    #[serde(flatten)]
    book: library::Book,
    /// 书籍文件的绝对路径
    abs_path: String,
    /// 封面缩略图的绝对路径，没有封面则为 null
    cover_abs_path: Option<String>,
}

fn to_view(state: &AppState, b: library::Book) -> BookView {
    let abs_path = state.abs("books", &b.file_path).display().to_string();
    let cover_abs_path = b
        .cover_path
        .as_ref()
        .map(|c| state.abs("covers", c).display().to_string());
    BookView {
        book: b,
        abs_path,
        cover_abs_path,
    }
}

#[tauri::command]
fn list_books(state: tauri::State<'_, AppState>) -> Result<Vec<BookView>> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    let books = library::list(&conn)?;
    Ok(books.into_iter().map(|b| to_view(&state, b)).collect())
}

#[tauri::command]
fn get_book(state: tauri::State<'_, AppState>, id: String) -> Result<Option<BookView>> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    Ok(library::get(&conn, &id)?.map(|b| to_view(&state, b)))
}

/// 导入书籍。`paths` 是文件绝对路径列表（由前端文件选择器给出）。
#[tauri::command]
fn import_books(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<library::ImportSummary> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    let books_dir = state.books_dir();
    let covers_dir = state.covers_dir();

    let mut summary = library::ImportSummary::default();

    for p in paths {
        let path = Path::new(&p);
        let display = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| p.clone());

        if !path.exists() {
            summary.failed.push(format!("{display}：文件不存在"));
            continue;
        }

        match library::import_one(&conn, &books_dir, &covers_dir, path) {
            Ok(Some(book)) => {
                summary.imported += 1;
                log::info!("已导入：{}", book.title);
            }
            Ok(None) => summary.duplicates.push(display),
            Err(e) => summary.failed.push(format!("{display}：{e}")),
        }
    }

    Ok(summary)
}

#[tauri::command]
fn delete_book(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    library::delete(&conn, &state.books_dir(), &state.covers_dir(), &id)
}

/// 保存阅读进度。`cfi` 为 foliate-js 给出的 EPUB CFI 定位串。
#[tauri::command]
fn save_progress(
    state: tauri::State<'_, AppState>,
    id: String,
    cfi: Option<String>,
    pct: f64,
) -> Result<()> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    library::update_progress(&conn, &id, cfi.as_deref(), pct)
}

/// 标记书籍为「最近打开」（打开阅读器时调用，不改动阅读进度）。
#[tauri::command]
fn touch_book(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    library::touch(&conn, &id)
}

#[tauri::command]
fn rename_book(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
    author: Option<String>,
) -> Result<()> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    library::update_metadata(&conn, &id, &title, author.as_deref())
}

// ============================================================================
//  启动
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            #[cfg(desktop)]
            let dir = data_dir();
            #[cfg(mobile)]
            let dir = data_dir(app.handle());

            let dir = dir.ok_or_else(|| "无法确定应用数据目录".to_string())?;
            ensure_layout(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

            // 日志同时写文件与标准输出。
            // 发布版也开日志：出问题时你能直接把日志文件发我，比「点了没反应」好查得多。
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Debug
                    } else {
                        log::LevelFilter::Info
                    })
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Folder {
                            path: dir.join("logs"),
                            file_name: Some("inkwell".into()),
                        },
                    ))
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ))
                    .build(),
            )?;

            // 前端要读取的只有书籍本体与封面缩略图，scope 收到最小范围。
            // 注意 covers/ 也必须放行：书库网格用 asset 协议加载封面，
            // 漏掉它会导致封面全部加载失败、退化成首字占位（实测踩过这个坑）。
            app.asset_protocol_scope()
                .allow_directory(dir.join("books"), true)
                .map_err(|e| format!("配置资源访问范围失败：{e}"))?;
            app.asset_protocol_scope()
                .allow_directory(dir.join("covers"), true)
                .map_err(|e| format!("配置资源访问范围失败：{e}"))?;

            let db_path = dir.join("library.db");
            let conn = db::open(&db_path).map_err(|e| format!("打开数据库失败：{e}"))?;

            log::info!("数据目录：{}", dir.display());
            log::info!("数据库：{}", db_path.display());

            app.manage(AppState {
                conn: Mutex::new(conn),
                data_dir: dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_books,
            get_book,
            import_books,
            delete_book,
            touch_book,
            save_progress,
            rename_book,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn data_dir_is_named_after_app() {
        let d = data_dir().expect("APPDATA 未设置");
        assert_eq!(d.file_name().unwrap(), "Inkwell");
    }

    #[test]
    fn ensure_layout_creates_books_and_covers() {
        let tmp = std::env::temp_dir().join("inkwell-test-layout");
        let _ = std::fs::remove_dir_all(&tmp);

        ensure_layout(&tmp).expect("创建布局失败");
        assert!(tmp.join("books").is_dir());
        assert!(tmp.join("covers").is_dir());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
