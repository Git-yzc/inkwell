//! 统一错误类型。
//!
//! Tauri 的 command 需要把错误序列化给前端，这里统一转成中文字符串，
//! 前端直接拿去展示即可。

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("数据库操作失败：{0}")]
    Db(#[from] rusqlite::Error),

    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),

    #[error("这本书不是有效的 EPUB：{0}")]
    Epub(String),

    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for Error {
    // 注意：这里必须写全 std::result::Result，否则会被本模块的 Result<T> 别名遮蔽。
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
