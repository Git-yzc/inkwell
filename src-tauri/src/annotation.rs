//! 批注：划词高亮、笔记、书签。
//!
//! 表在 `db.rs` 的迁移 v1 就建好了（`annotations`），这里只做读写。
//!
//! 几个约定：
//! - `type` 只有两种取值：`highlight`（划词高亮，可以带笔记）与 `bookmark`（书签）。
//!   「带笔记的高亮」仍然是 highlight —— 再拆一个 note 类型只会让 UI 到处判断。
//! - `color` 存**色名**（yellow/green/blue/pink）而不是色值：以后换主题或调色板时
//!   不用迁移已有数据。
//! - `cfi` 对高亮是一个 range（`epubcfi(/6/4!/4/2,/1:0,/1:12)`），对书签是一个点。
//!   两种都由 foliate-js 的 `view.getCFI(index, range)` 产出。

use crate::error::{Error, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

/// 允许的批注类型。
pub const KINDS: [&str; 2] = ["highlight", "bookmark"];

/// 允许的高亮色名。前端负责把色名映射成具体色值。
pub const COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub book_id: String,
    /// `type` 是 Rust 关键字，字段名只好叫 kind，序列化出去仍是 `type`。
    #[serde(rename = "type")]
    pub kind: String,
    pub cfi: String,
    /// 被划线的原文（书签为 None）
    pub text: Option<String>,
    pub note: Option<String>,
    pub color: Option<String>,
    /// 所在章节标题，列表里分组用
    pub chapter: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

const SELECT_ANN: &str = "SELECT id, book_id, type, cfi, text, note, color, chapter, \
    created_at, updated_at FROM annotations";

fn row_to_annotation(row: &rusqlite::Row) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        kind: row.get("type")?,
        cfi: row.get("cfi")?,
        text: row.get("text")?,
        note: row.get("note")?,
        color: row.get("color")?,
        chapter: row.get("chapter")?,
        // 这两列理论上非空，但历史数据里出现 NULL 不该让整个列表崩掉。
        created_at: row.get::<_, Option<i64>>("created_at")?.unwrap_or(0),
        updated_at: row.get::<_, Option<i64>>("updated_at")?.unwrap_or(0),
    })
}

/// 某本书的全部批注，新的排前面。
pub fn list(conn: &Connection, book_id: &str) -> Result<Vec<Annotation>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_ANN} WHERE book_id = ?1 ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![book_id], row_to_annotation)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Annotation>> {
    let mut stmt = conn.prepare(&format!("{SELECT_ANN} WHERE id = ?1"))?;
    let mut rows = stmt.query_map(params![id], row_to_annotation)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 新增一条批注。类型与颜色都走白名单，脏数据不进库。
#[allow(clippy::too_many_arguments)]
pub fn add(
    conn: &Connection,
    book_id: &str,
    kind: &str,
    cfi: &str,
    text: Option<&str>,
    note: Option<&str>,
    color: Option<&str>,
    chapter: Option<&str>,
) -> Result<Annotation> {
    if !KINDS.contains(&kind) {
        return Err(Error::Other(format!("未知的批注类型：{kind}")));
    }
    if let Some(c) = color {
        if !COLORS.contains(&c) {
            return Err(Error::Other(format!("未知的高亮颜色：{c}")));
        }
    }
    if cfi.trim().is_empty() {
        return Err(Error::Other("批注缺少定位信息".into()));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let ts = crate::library::now_secs();
    conn.execute(
        "INSERT INTO annotations
            (id, book_id, type, cfi, text, note, color, chapter, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        params![id, book_id, kind, cfi, text, note, color, chapter, ts],
    )?;

    get(conn, &id)?.ok_or_else(|| Error::Other("新增批注后未能读回记录".into()))
}

/// 改笔记与颜色。
///
/// 刻意不允许改 cfi 与 text：那是「原文在哪」的既成事实，改了反而对不上正文。
/// 传 None 表示清空该字段（前端编辑时会带上两个字段的当前值）。
pub fn update(conn: &Connection, id: &str, note: Option<&str>, color: Option<&str>) -> Result<()> {
    if let Some(c) = color {
        if !COLORS.contains(&c) {
            return Err(Error::Other(format!("未知的高亮颜色：{c}")));
        }
    }
    let n = conn.execute(
        "UPDATE annotations SET note = ?2, color = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, note, color, crate::library::now_secs()],
    )?;
    if n == 0 {
        return Err(Error::Other("要修改的批注不存在".into()));
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    Ok(())
}

/* ------------------------------------------------------------------ 导出 */

/// 转义 Markdown 里会被当成语法的字符，避免原文里的 * 或 # 打乱排版。
fn md_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '*' | '_' | '[' | ']' | '#' | '<' | '>' | '|') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// 把批注渲染成 Markdown。
pub fn to_markdown(title: &str, list: &[Annotation]) -> String {
    let mut out = format!("# {title} · 批注\n\n");
    if list.is_empty() {
        out.push_str("（这本书还没有批注）\n");
        return out;
    }

    // 列表是按时间倒序来的，导出按时间正序读起来才顺。
    let mut items: Vec<&Annotation> = list.iter().collect();
    items.reverse();

    let mut last_chapter: Option<&str> = None;
    for a in items {
        let chapter = a.chapter.as_deref().unwrap_or("");
        if Some(chapter) != last_chapter {
            out.push_str(&format!(
                "\n## {}\n\n",
                if chapter.is_empty() {
                    "未分章"
                } else {
                    chapter
                }
            ));
            last_chapter = Some(chapter);
        }
        match a.kind.as_str() {
            "bookmark" => out.push_str("- 🔖 书签\n"),
            _ => {
                if let Some(t) = a.text.as_deref().filter(|t| !t.trim().is_empty()) {
                    out.push_str(&format!("> {}\n", md_escape(t.trim())));
                }
                if let Some(n) = a.note.as_deref().filter(|n| !n.trim().is_empty()) {
                    out.push_str(&format!("\n{}\n", n.trim()));
                }
                out.push('\n');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(db::MIGRATIONS_FOR_TEST).unwrap();
        conn.execute(
            "INSERT INTO books (id,title,format,file_path,added_at,updated_at)
             VALUES ('b','书名','epub','a.epub',0,0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn add_list_update_delete_roundtrip() {
        let conn = mem_db();
        let a = add(
            &conn,
            "b",
            "highlight",
            "epubcfi(/6/4!/4/2,/1:0,/1:12)",
            Some("被划线的原文"),
            None,
            Some("yellow"),
            Some("第一章"),
        )
        .expect("新增应当成功");
        assert_eq!(a.kind, "highlight");
        assert_eq!(a.color.as_deref(), Some("yellow"));

        assert_eq!(list(&conn, "b").unwrap().len(), 1);

        update(&conn, &a.id, Some("我的笔记"), Some("green")).unwrap();
        let after = get(&conn, &a.id).unwrap().unwrap();
        assert_eq!(after.note.as_deref(), Some("我的笔记"));
        assert_eq!(after.color.as_deref(), Some("green"));

        delete(&conn, &a.id).unwrap();
        assert!(list(&conn, "b").unwrap().is_empty());
    }

    #[test]
    fn rejects_unknown_kind_and_color() {
        let conn = mem_db();
        let err = add(
            &conn,
            "b",
            "scribble",
            "epubcfi(/6/4)",
            None,
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("未知的批注类型"), "实际: {err}");

        let err = add(
            &conn,
            "b",
            "highlight",
            "epubcfi(/6/4)",
            None,
            None,
            Some("rainbow"),
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("未知的高亮颜色"), "实际: {err}");
    }

    #[test]
    fn update_missing_row_reports_clearly() {
        let conn = mem_db();
        let err = update(&conn, "nope", None, None).unwrap_err().to_string();
        assert!(err.contains("不存在"), "实际: {err}");
    }

    #[test]
    fn deleting_book_cascades_annotations() {
        let conn = mem_db();
        add(
            &conn,
            "b",
            "bookmark",
            "epubcfi(/6/4)",
            None,
            None,
            None,
            None,
        )
        .unwrap();
        conn.execute("DELETE FROM books WHERE id = 'b'", [])
            .unwrap();
        assert!(list(&conn, "b").unwrap().is_empty(), "删书应连带删掉批注");
    }

    #[test]
    fn markdown_export_groups_by_chapter_and_escapes() {
        let conn = mem_db();
        add(
            &conn,
            "b",
            "highlight",
            "epubcfi(/6/4!/4/2,/1:0,/1:6)",
            Some("*重点*"),
            Some("笔记"),
            Some("yellow"),
            Some("第一章"),
        )
        .unwrap();
        add(
            &conn,
            "b",
            "bookmark",
            "epubcfi(/6/8)",
            None,
            None,
            None,
            Some("第二章"),
        )
        .unwrap();

        let md = to_markdown("书名", &list(&conn, "b").unwrap());
        assert!(md.contains("# 书名 · 批注"), "{md}");
        assert!(md.contains("## 第一章"), "{md}");
        assert!(md.contains("## 第二章"), "{md}");
        assert!(md.contains("🔖 书签"), "{md}");
        // 原文里的 * 必须被转义，否则会变成斜体
        assert!(md.contains("\\*重点\\*"), "转义失效: {md}");
    }
}
