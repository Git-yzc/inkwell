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
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

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
    /// 导入 Android content:// URI 时的中转目录（导入结束即清理）
    fn import_tmp_dir(&self) -> PathBuf {
        self.data_dir.join("import-tmp")
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

/* -------------------------------------------------- 文件来源（含 Android URI） */

/// 极简百分号解码（`%E4%B9%A6` → `书`）。只为还原文件名，够用即可，
/// 不值得为它引入 percent-encoding 依赖。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 换掉不能出现在本地文件名里的字符。
fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

/// 从 content:// URI 的末段尽力还原文件名。
///
/// SAF 给的末段有几种形态，实测常见的两种：
///   `.../document/primary%3ADownload%2F%E4%B9%A6.epub` → `书.epub`
///   `.../document/msf%3A1000000043`                    → `msf_1000000043`（拿不到真名）
/// 所以只尽力而为；实在拿不到时由调用方兜底。
fn name_from_uri(uri: &tauri::Url) -> Option<String> {
    let last = uri.path_segments()?.next_back()?;
    let decoded = percent_decode(last);
    let base = decoded.rsplit(['/', '\\']).next().unwrap_or(&decoded);
    let cleaned = sanitize_file_name(base);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// 从文件头猜格式，供「URI 末段是文档 id、看不出扩展名」时兜底。
///
/// 只认带固定魔数的几种；zip 容器分不清 EPUB 还是 CBZ，就用现成的 EPUB 解析器当判别器。
fn sniff_format(path: &Path) -> Option<&'static str> {
    let mut head = [0u8; 68];
    let n = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
    let h = &head[..n];
    if h.starts_with(b"%PDF") {
        return Some("pdf");
    }
    if h.len() >= 68 && &h[60..68] == b"BOOKMOBI" {
        return Some("mobi");
    }
    if h.starts_with(b"PK\x03\x04") {
        return Some(if crate::epub::parse(path).is_ok() {
            "epub"
        } else {
            "cbz"
        });
    }
    None
}

/// 解析出来的导入来源。
struct ImportSource {
    /// 本地可直接读取的文件路径
    path: PathBuf,
    /// content:// 落地的临时目录，导入完要删；本机路径为 None
    temp_dir: Option<PathBuf>,
}

/// 把文件选择器给出的来源解析成本地可读路径。
///
/// Windows 上选择器直接给文件路径，原样返回。
///
/// Android 上走的是 SAF，交回来的是 `content://` URI，`std::fs` 根本打不开 ——
/// 直接拿去导入只会得到「文件不存在」（真机上实际踩到过）。这里改用 fs 插件背后的
/// ContentResolver 把内容复制进数据目录的临时文件，之后整条导入链路
/// （算指纹、解析元数据、拷进书库）照旧按本地路径走。
fn resolve_import_source(
    app: &tauri::AppHandle,
    raw: &str,
    tmp_root: &Path,
) -> Result<ImportSource> {
    let uri = match FilePath::from_str(raw).expect("FilePath::from_str 不会失败") {
        FilePath::Path(p) => {
            return Ok(ImportSource {
                path: p,
                temp_dir: None,
            })
        }
        FilePath::Url(u) => u,
    };

    // `file://` 这类 URL 仍可直接还原成本地路径
    if uri.scheme() == "file" {
        let path = uri
            .to_file_path()
            .map_err(|_| Error::Other(format!("无法解析文件 URL：{raw}")))?;
        return Ok(ImportSource {
            path,
            temp_dir: None,
        });
    }

    // 其余一律当作 Android 的 content:// 处理
    let dir = tmp_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)?;

    let name = name_from_uri(&uri).unwrap_or_else(|| "book".to_string());
    let mut path = dir.join(&name);

    // 注意 OpenOptions 的 setter 返回 &mut Self（插件自身也是这么用的），
    // 而 open() 要的是 by-value，所以分两步写。
    let mut opts = OpenOptions::new();
    opts.read(true);
    let mut src = app
        .fs()
        .open(uri, opts)
        .map_err(|e| Error::Other(format!("读取所选文件失败：{e}")))?;
    let mut out = std::fs::File::create(&path)?;
    std::io::copy(&mut src, &mut out)?;
    drop(out);

    // 末段是文档 id 时看不出扩展名，补一个从内容猜出来的，
    // 否则导入会在格式判断那一步就被拒掉。
    if library::format_of(&path).is_none() {
        if let Some(fmt) = sniff_format(&path) {
            let renamed = dir.join(format!("{name}.{fmt}"));
            std::fs::rename(&path, &renamed)?;
            path = renamed;
        }
    }

    Ok(ImportSource {
        path,
        temp_dir: Some(dir),
    })
}

/// 导入书籍。`paths` 是文件选择器给出的「绝对路径或 URI」列表。
#[tauri::command]
fn import_books(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<library::ImportSummary> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| Error::Other("数据库锁已损坏".into()))?;
    let books_dir = state.books_dir();
    let covers_dir = state.covers_dir();
    let tmp_root = state.import_tmp_dir();

    // 上一轮若中途失败可能留下残留，开新一批前先清掉
    let _ = std::fs::remove_dir_all(&tmp_root);

    let mut summary = library::ImportSummary::default();
    let mut temporaries: Vec<PathBuf> = Vec::new();

    for raw in paths {
        let source = match resolve_import_source(&app, &raw, &tmp_root) {
            Ok(s) => s,
            Err(e) => {
                // 解析都失败了，只能拿原始串的最后一段当名字
                let short = raw.rsplit('/').next().unwrap_or(&raw).to_string();
                summary.failed.push(format!("{short}：{e}"));
                continue;
            }
        };

        let path = source.path;
        let display = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.clone());

        if let Some(dir) = source.temp_dir {
            temporaries.push(dir);
        }

        if !path.exists() {
            summary.failed.push(format!("{display}：文件不存在"));
            continue;
        }

        match library::import_one(&conn, &books_dir, &covers_dir, &path) {
            Ok(Some(book)) => {
                summary.imported += 1;
                log::info!("已导入：{}", book.title);
            }
            Ok(None) => summary.duplicates.push(display),
            Err(e) => summary.failed.push(format!("{display}：{e}")),
        }
    }

    // 临时副本用完就删；删不掉不影响导入结果
    for dir in temporaries {
        let _ = std::fs::remove_dir_all(dir);
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

    /* -------------------------- Android content:// 来源的解析（真机踩过的坑） */

    /// SAF 给的 URI 末段是 `primary:Download/文件名`，要还原出真正的文件名。
    /// 这条 URI 的形状取自真机上导入失败时的那条报错。
    #[test]
    fn extracts_file_name_from_saf_uri() {
        let uri = tauri::Url::parse(
            "content://com.android.externalstorage.documents/document/\
             primary%3ADownload%2F%E5%BE%90%E6%98%8E%E8%8B%B1%20illegal.epub",
        )
        .unwrap();
        assert_eq!(name_from_uri(&uri).as_deref(), Some("徐明英 illegal.epub"));
    }

    /// 有些 provider 的末段只是文档 id，看不出扩展名 ——
    /// 这时要能容忍（返回一个干净的占位名），由 sniff_format 去兜底。
    #[test]
    fn tolerates_document_id_uri() {
        let uri = tauri::Url::parse(
            "content://com.android.providers.downloads.documents/document/msf%3A1000000043",
        )
        .unwrap();
        let name = name_from_uri(&uri).expect("至少要给出一个占位名");
        assert_eq!(name, "msf_1000000043");
        assert!(
            library::format_of(Path::new(&name)).is_none(),
            "没有扩展名时应该交给 sniff_format 兜底，实际: {name}"
        );
    }

    #[test]
    fn percent_decode_handles_utf8_and_bad_escapes() {
        assert_eq!(percent_decode("%E4%B9%A6.epub"), "书.epub");
        assert_eq!(percent_decode("plain.epub"), "plain.epub");
        // 非法转义原样保留，不能把名字吃掉
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
    }

    #[test]
    fn sanitize_replaces_path_hostile_chars() {
        assert_eq!(sanitize_file_name("msf:1000000043"), "msf_1000000043");
        assert_eq!(sanitize_file_name("a/b\\c.epub"), "a_b_c.epub");
    }

    /// 扩展名缺失时靠文件头认格式；认不出来就返回 None（由调用方给出可读报错）。
    #[test]
    fn sniffs_format_from_magic_bytes() {
        let dir = std::env::temp_dir().join("inkwell-test-sniff");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let pdf = dir.join("a");
        std::fs::write(&pdf, b"%PDF-1.7\n").unwrap();
        assert_eq!(sniff_format(&pdf), Some("pdf"));

        let mobi = dir.join("b");
        let mut buf = vec![0u8; 68];
        buf[60..68].copy_from_slice(b"BOOKMOBI");
        std::fs::write(&mobi, &buf).unwrap();
        assert_eq!(sniff_format(&mobi), Some("mobi"));

        let plain = dir.join("c");
        std::fs::write(&plain, b"just some text").unwrap();
        assert_eq!(sniff_format(&plain), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
