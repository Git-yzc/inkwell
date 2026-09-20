//! 书库：导入、查询、删除、进度更新。
//!
//! 设计约定（见 AGENTS.md）：
//! - 数据库只在 Rust 侧操作，前端一律通过 command 调用；
//! - 书籍本体存 `{数据目录}/books/`，封面缩略图存 `{数据目录}/covers/`；
//! - 库里只保存**相对路径**，这样数据目录整体搬走也不会失效。

use crate::error::{Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// 封面缩略图最长边的像素上限。书库网格里 480px 足够清晰，又能显著缩小体积。
const COVER_MAX_EDGE: u32 = 480;

/// 支持导入的扩展名（小写，不含点）。
///
/// 新增格式时只改这里：导入的合法性判断与错误提示都从它派生。
pub const SUPPORTED_FORMATS: [&str; 9] = [
    "epub", "mobi", "azw3", "azw", "fb2", "cbz", "pdf", "txt", "md",
];

/// 文件路径对应的格式；不支持的扩展名返回 None。
pub fn format_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    SUPPORTED_FORMATS.iter().copied().find(|f| *f == ext)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub format: String,
    /// 相对书库根目录的路径
    pub file_path: String,
    pub cover_path: Option<String>,
    pub file_size: i64,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub progress_cfi: Option<String>,
    pub progress_pct: f64,
    pub finished: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// 成功导入的数量
    pub imported: usize,
    /// 因内容重复而跳过的书名
    pub duplicates: Vec<String>,
    /// 失败的文件与原因
    pub failed: Vec<String>,
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 计算文件内容的 sha256，取前 16 位十六进制作为去重指纹。
fn file_fingerprint(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
}

/// 封面缩略图的 JPEG 质量。书库网格用不着无损，82 肉眼几乎无差、体积最划算。
const COVER_JPEG_QUALITY: u8 = 82;

/// 把封面压成适合书库网格的缩略图。
///
/// 用 **JPEG 有损**编码，而不是 `image` 内置的 webp 写出：
/// 那个 webp 编码器是**无损**的，实测把 53KB 的原始封面撑到 160KB，
/// 上千本书时会把书库拖垮。
///
/// 带透明通道的封面（多半是 PNG logo）先合成到白底再编码，否则透明区会变黑。
fn make_thumbnail(bytes: &[u8]) -> Option<(Vec<u8>, &'static str)> {
    let img = match image::load_from_memory(bytes) {
        Ok(i) => i,
        Err(e) => {
            log::warn!("封面解码失败，将保存原图：{e}");
            return None;
        }
    };

    let thumb = img.thumbnail(COVER_MAX_EDGE, COVER_MAX_EDGE);

    let rgb = if thumb.color().has_alpha() {
        let rgba = thumb.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut flat = image::RgbImage::new(w, h);
        for (x, y, p) in rgba.enumerate_pixels() {
            let a = u32::from(p[3]);
            let over_white = |c: u8| ((u32::from(c) * a + 255 * (255 - a)) / 255) as u8;
            flat.put_pixel(
                x,
                y,
                image::Rgb([over_white(p[0]), over_white(p[1]), over_white(p[2])]),
            );
        }
        flat
    } else {
        thumb.to_rgb8()
    };

    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        std::io::Cursor::new(&mut out),
        COVER_JPEG_QUALITY,
    );
    if encoder.encode_image(&rgb).is_ok() && !out.is_empty() {
        return Some((out, "jpg"));
    }

    // JPEG 编码失败就退回原图，保证「至少能看到封面」
    None
}

/// 导入一个文件。返回 `None` 表示内容重复、已跳过。
pub fn import_one(
    conn: &Connection,
    books_dir: &Path,
    covers_dir: &Path,
    src: &Path,
) -> Result<Option<Book>> {
    let format = match format_of(src) {
        Some(f) => f,
        None => {
            let what = match src.extension() {
                Some(e) => format!(".{}", e.to_string_lossy().to_lowercase()),
                None => "（没有扩展名）".to_string(),
            };
            return Err(Error::Other(format!(
                "暂不支持的文件格式{what}（目前支持 {}）",
                SUPPORTED_FORMATS.join("/")
            )));
        }
    };

    let hash = file_fingerprint(src)?;

    // 内容级去重：同一本书换个文件名再导入也不会重复
    let existing: Option<String> = conn
        .query_row(
            "SELECT title FROM books WHERE file_hash = ?1",
            params![hash],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(title) = existing {
        log::info!("跳过重复书籍：{title}");
        return Ok(None);
    }

    let id = uuid::Uuid::new_v4().to_string();

    // 解析元数据。非 EPUB 暂时没有内建解析器，用文件名兜底。
    let meta = if format == "epub" {
        match crate::epub::parse(src) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("EPUB 元数据解析失败（仍会导入）：{e}");
                Default::default()
            }
        }
    } else {
        Default::default()
    };

    let title = if meta.title.trim().is_empty() {
        src.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知书名".to_string())
    } else {
        meta.title.clone()
    };

    // 拷贝书籍本体
    std::fs::create_dir_all(books_dir)?;
    let file_name = format!("{id}.{format}");
    let dest = books_dir.join(&file_name);
    std::fs::copy(src, &dest)?;
    let file_size = std::fs::metadata(&dest)?.len() as i64;

    // 生成封面缩略图
    let mut cover_rel: Option<String> = None;
    if let Some(bytes) = &meta.cover {
        let (data, ext) = match make_thumbnail(bytes) {
            Some(v) => v,
            None => (bytes.clone(), "img"),
        };
        std::fs::create_dir_all(covers_dir)?;
        let cover_name = format!("{id}.{ext}");
        std::fs::write(covers_dir.join(&cover_name), &data)?;
        cover_rel = Some(cover_name);
    }

    let ts = now_secs();
    conn.execute(
        "INSERT INTO books (
            id, title, author, language, publisher, identifier,
            format, file_path, file_size, file_hash, cover_path,
            added_at, updated_at, progress_pct, finished
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,0,0)",
        params![
            id,
            title,
            meta.author,
            meta.language,
            meta.publisher,
            meta.identifier,
            format,
            file_name,
            file_size,
            hash,
            cover_rel,
            ts,
        ],
    )?;

    let book = get(conn, &id)?.ok_or_else(|| Error::Other("导入后未能读回书籍记录".into()))?;
    Ok(Some(book))
}

fn row_to_book(row: &rusqlite::Row) -> rusqlite::Result<Book> {
    Ok(Book {
        id: row.get("id")?,
        title: row.get("title")?,
        author: row.get("author")?,
        format: row.get("format")?,
        file_path: row.get("file_path")?,
        cover_path: row.get("cover_path")?,
        // 这几列在 schema 上可空：宽容读取，避免历史数据里的 NULL 让整个书库列表崩掉。
        file_size: row.get::<_, Option<i64>>("file_size")?.unwrap_or(0),
        added_at: row.get::<_, Option<i64>>("added_at")?.unwrap_or(0),
        last_opened_at: row.get("last_opened_at")?,
        progress_cfi: row.get("progress_cfi")?,
        progress_pct: row.get::<_, Option<f64>>("progress_pct")?.unwrap_or(0.0),
        finished: row.get::<_, Option<i64>>("finished")?.unwrap_or(0) != 0,
    })
}

const SELECT_BOOK: &str = "SELECT id, title, author, format, file_path, cover_path, \
    file_size, added_at, last_opened_at, progress_cfi, progress_pct, finished FROM books";

pub fn get(conn: &Connection, id: &str) -> Result<Option<Book>> {
    let mut stmt = conn.prepare(&format!("{SELECT_BOOK} WHERE id = ?1"))?;
    let mut rows = stmt.query_map(params![id], row_to_book)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 书库列表：最近打开的排前面，没打开过的按加入时间倒序。
pub fn list(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_BOOK} ORDER BY COALESCE(last_opened_at, added_at) DESC"
    ))?;
    let rows = stmt.query_map([], row_to_book)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 删除书籍：先删数据库记录，再清理磁盘文件（文件删不掉不影响记录已删的事实）。
pub fn delete(conn: &Connection, books_dir: &Path, covers_dir: &Path, id: &str) -> Result<()> {
    let book = get(conn, id)?.ok_or_else(|| Error::Other("要删除的书不存在".into()))?;

    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;

    let book_file = books_dir.join(&book.file_path);
    if book_file.exists() {
        let _ = std::fs::remove_file(&book_file);
    }
    if let Some(cover) = &book.cover_path {
        let cover_file = covers_dir.join(cover);
        if cover_file.exists() {
            let _ = std::fs::remove_file(&cover_file);
        }
    }
    Ok(())
}

/// 更新阅读进度。
pub fn update_progress(conn: &Connection, id: &str, cfi: Option<&str>, pct: f64) -> Result<()> {
    let finished = if pct >= 0.995 { 1 } else { 0 };
    conn.execute(
        "UPDATE books SET progress_cfi = ?2, progress_pct = ?3, finished = ?4, \
         last_opened_at = ?5, updated_at = ?5 WHERE id = ?1",
        params![id, cfi, pct.clamp(0.0, 1.0), finished, now_secs()],
    )?;
    Ok(())
}

/// 仅更新「最近打开时间」（打开书时调用，不改动进度）。
pub fn touch(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET last_opened_at = ?2 WHERE id = ?1",
        params![id, now_secs()],
    )?;
    Ok(())
}

/// 把书名/作者写回（用于手动修正元数据）。
pub fn update_metadata(
    conn: &Connection,
    id: &str,
    title: &str,
    author: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET title = ?2, author = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, title, author, now_secs()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(crate::db::MIGRATIONS_FOR_TEST).unwrap();
        conn
    }

    #[test]
    fn list_is_empty_initially() {
        let conn = mem_db();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn progress_updates_and_marks_finished() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO books (id,title,format,file_path,added_at,updated_at)
             VALUES ('a','书名','epub','a.epub',0,0)",
            [],
        )
        .unwrap();

        update_progress(&conn, "a", Some("epubcfi(/6/4!/2/2)"), 0.42).unwrap();
        let b = get(&conn, "a").unwrap().unwrap();
        assert_eq!(b.progress_cfi.as_deref(), Some("epubcfi(/6/4!/2/2)"));
        assert!((b.progress_pct - 0.42).abs() < 1e-6);
        assert!(!b.finished);

        update_progress(&conn, "a", None, 1.0).unwrap();
        assert!(get(&conn, "a").unwrap().unwrap().finished);
    }

    /// 完整导入链路的端到端验证：拷贝文件、解析元数据、生成封面、去重、入库。
    ///
    /// 默认忽略，需要真实 EPUB：
    /// ```
    /// $env:INKWELL_TEST_EPUB="D:\path\to\book.epub"
    /// cargo test --lib -- --ignored imports_real_epub
    /// ```
    #[test]
    #[ignore = "需要真实 EPUB 文件，通过 INKWELL_TEST_EPUB 指定"]
    fn imports_real_epub_end_to_end() {
        let src =
            std::env::var("INKWELL_TEST_EPUB").expect("请设置 INKWELL_TEST_EPUB 指向一个真实 EPUB");
        let src = Path::new(&src).to_path_buf();

        let conn = mem_db();
        let tmp = std::env::temp_dir().join("inkwell-import-e2e");
        let _ = std::fs::remove_dir_all(&tmp);
        let books_dir = tmp.join("books");
        let covers_dir = tmp.join("covers");

        // 第一次导入
        let book = import_one(&conn, &books_dir, &covers_dir, &src)
            .expect("导入失败")
            .expect("首次导入应返回书籍");
        println!("标题 = {}", book.title);
        println!("作者 = {:?}", book.author);
        println!("格式 = {}", book.format);
        println!("大小 = {} 字节", book.file_size);

        assert!(!book.title.trim().is_empty());
        assert_eq!(book.format, "epub");

        // 书籍本体已拷贝进书库
        let copied = books_dir.join(&book.file_path);
        assert!(
            copied.is_file(),
            "书籍文件应已拷贝到书库: {}",
            copied.display()
        );
        assert_eq!(
            std::fs::metadata(&copied).unwrap().len(),
            std::fs::metadata(&src).unwrap().len(),
            "拷贝后的文件大小应与原文件一致"
        );

        // 封面缩略图已生成，且比原始封面小
        let cover_name = book.cover_path.as_ref().expect("应生成封面");
        let cover_path = covers_dir.join(cover_name);
        assert!(
            cover_path.is_file(),
            "封面文件应存在: {}",
            cover_path.display()
        );
        let cover_size = std::fs::metadata(&cover_path).unwrap().len();
        println!("封面 = {} ({} 字节)", cover_name, cover_size);
        assert!(cover_size > 0, "封面不应为空文件");
        // 缩略图是书库网格的性能关键：单张控制在 80KB 以内，
        // 上千本书的封面总量才不至于拖垮加载。（曾因 webp 无损编码涨到 160KB）
        assert!(
            cover_size < 80_000,
            "封面缩略图应小于 80KB，实际 {cover_size} 字节——检查是否退回了无损编码"
        );

        // 数据库里能查到，且列表返回它
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert_eq!(get(&conn, &book.id).unwrap().unwrap().title, book.title);

        // 再导一次同样的文件：应按内容指纹识别为重复，不再入库
        let again = import_one(&conn, &books_dir, &covers_dir, &src).expect("二次导入不应报错");
        assert!(again.is_none(), "内容相同的书应被判定为重复");
        assert_eq!(list(&conn).unwrap().len(), 1, "重复导入不应产生第二条记录");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 开发用：把测试书导入到**真实**数据目录，方便验证界面与阅读器。
    ///
    /// 会写入 %APPDATA%\Inkwell，请只在开发/验证时使用。
    /// 用法：
    /// ```
    /// $env:INKWELL_TEST_EPUB="D:\path\a.epub"
    /// $env:INKWELL_TEST_EPUB2="D:\path\b.epub"   # 可选
    /// cargo test --lib -- --ignored seed_real_library --nocapture
    /// ```
    #[test]
    #[ignore = "会写入真实数据目录，仅供开发验证"]
    fn seed_real_library() {
        let dir = crate::data_dir().expect("无法确定数据目录");
        crate::ensure_layout(&dir).expect("创建布局失败");

        let conn = crate::db::open(&dir.join("library.db")).expect("打开数据库失败");
        let books_dir = dir.join("books");
        let covers_dir = dir.join("covers");

        let mut paths = vec![std::env::var("INKWELL_TEST_EPUB").expect("请设置 INKWELL_TEST_EPUB")];
        if let Ok(second) = std::env::var("INKWELL_TEST_EPUB2") {
            paths.push(second);
        }

        for p in paths {
            match import_one(&conn, &books_dir, &covers_dir, Path::new(&p)) {
                Ok(Some(b)) => println!("已导入: {}", b.title),
                Ok(None) => println!("已存在，跳过: {p}"),
                Err(e) => println!("导入失败 {p}: {e}"),
            }
        }

        println!("书库现有 {} 本", list(&conn).unwrap().len());
        println!("数据目录: {}", dir.display());
    }

    /// 不支持的扩展名应给出可读的中文提示，而不是静默失败。
    #[test]
    fn rejects_unsupported_format() {
        let conn = mem_db();
        let tmp = std::env::temp_dir().join("inkwell-unsupported-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("book.xyz");
        std::fs::write(&f, b"whatever").unwrap();

        let err = import_one(&conn, &tmp, &tmp, &f).unwrap_err().to_string();
        assert!(
            err.contains("暂不支持"),
            "错误信息应说明不支持该格式，实际: {err}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn delete_cascades_annotations() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO books (id,title,format,file_path,added_at,updated_at)
             VALUES ('a','书名','epub','a.epub',0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO annotations (id,book_id,type,cfi,created_at,updated_at)
             VALUES ('n1','a','highlight','cfi',0,0)",
            [],
        )
        .unwrap();

        let tmp = std::env::temp_dir().join("inkwell-del-test");
        delete(&conn, &tmp, &tmp, "a").unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM annotations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "删除书籍应级联删除批注");
    }
}
