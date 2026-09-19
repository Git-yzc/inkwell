//! SQLite 连接与迁移。
//!
//! 约定：所有 schema 变更都写成迁移，绝不手改表结构。
//! 用 `PRAGMA user_version` 记录已应用到第几版。

use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

/// 供其它模块的测试搭内存库用。
#[cfg(test)]
pub const MIGRATIONS_FOR_TEST: &str = MIGRATIONS[0];

/// 迁移列表。**只允许在末尾追加**，已发布的迁移不可修改。
const MIGRATIONS: &[&str] = &[
    // v1：书籍、书架、批注、阅读会话、设置
    r#"
    CREATE TABLE books (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        author         TEXT,
        series         TEXT,
        series_index   REAL,
        language       TEXT,
        publisher      TEXT,
        identifier     TEXT,
        format         TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        file_size      INTEGER,
        file_hash      TEXT,
        cover_path     TEXT,
        added_at       INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_opened_at INTEGER,
        progress_cfi   TEXT,
        progress_pct   REAL DEFAULT 0,
        finished       INTEGER DEFAULT 0
    );
    CREATE INDEX idx_books_hash   ON books(file_hash);
    CREATE INDEX idx_books_opened ON books(last_opened_at DESC);
    CREATE INDEX idx_books_added  ON books(added_at DESC);

    CREATE TABLE shelves (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE book_shelves (
        book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
        PRIMARY KEY (book_id, shelf_id)
    );

    CREATE TABLE annotations (
        id         TEXT PRIMARY KEY,
        book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        cfi        TEXT NOT NULL,
        text       TEXT,
        note       TEXT,
        color      TEXT,
        chapter    TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_ann_book ON annotations(book_id, created_at DESC);

    CREATE TABLE reading_sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        duration_sec INTEGER DEFAULT 0,
        chars_read   INTEGER DEFAULT 0
    );
    CREATE INDEX idx_sessions_started ON reading_sessions(started_at DESC);

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
];

/// 打开数据库并确保 schema 是最新的。
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let conn = Connection::open(path)?;

    // WAL 让读写并发更顺；外键约束用于级联删除批注。
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let target = MIGRATIONS.len() as i64;

    if current > target {
        // 数据库比程序还新（例如降级运行），不擅自改动。
        return Err(crate::error::Error::Other(format!(
            "数据库版本（{current}）高于程序支持的版本（{target}），请使用较新版本的程序"
        )));
    }

    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if version > current {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", version)?;
            log::info!("已应用数据库迁移 v{version}");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_from_scratch_creates_tables() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);

        // books 表可用
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
    }
}
