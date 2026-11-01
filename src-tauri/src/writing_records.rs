//! 平台键值记录与作品读取；对话由 Pi 独立管理。
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn str_field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少 {key}"))
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub async fn get(db: &mut SqliteConnection, ns: &str, key: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(ns)
            .bind(json!(key).to_string())
            .fetch_optional(db)
            .await
            .map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
pub async fn put(
    db: &mut SqliteConnection,
    ns: &str,
    key: &str,
    value: &Value,
) -> Result<(), String> {
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")
        .bind(ns).bind(json!(key).to_string()).bind(value.to_string()).execute(db).await.map_err(err)?;
    Ok(())
}
pub async fn list(db: &mut SqliteConnection, ns: &str, prefix: &str) -> Result<Vec<Value>, String> {
    // 前缀在 SQL 里过滤：命名空间里其他大记录（如其他榜单的快照）不读出、不解析。
    let encoded = crate::desktop_storage::key_prefix(prefix);
    let rows = sqlx::query(
        "SELECT key,value FROM desktop_records WHERE namespace=? AND substr(key,1,length(?))=? ORDER BY key",
    )
    .bind(ns)
    .bind(&encoded)
    .bind(&encoded)
    .fetch_all(db)
    .await
    .map_err(err)?;
    rows.into_iter()
        .filter_map(|r| {
            let key = serde_json::from_str::<String>(r.get("key"));
            match key {
                Ok(key) if key.starts_with(prefix) => {
                    Some(serde_json::from_str(r.get("value")).map_err(err))
                }
                Ok(_) => None,
                Err(e) => Some(Err(err(e))),
            }
        })
        .collect()
}
/// 按键前缀删一批记录（遗忘会话时清检查点与短期回执用）；返回删掉的条数
pub async fn delete_by_prefix(
    db: &mut SqliteConnection,
    ns: &str,
    prefix: &str,
) -> Result<u64, String> {
    let encoded = crate::desktop_storage::key_prefix(prefix);
    Ok(
        sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND substr(key,1,length(?))=?")
            .bind(ns)
            .bind(&encoded)
            .bind(&encoded)
            .execute(db)
            .await
            .map_err(err)?
            .rows_affected(),
    )
}

pub async fn book(db: &mut SqliteConnection, book_id: &str) -> Result<Value, String> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL",
    )
    .bind(book_id)
    .fetch_optional(db)
    .await
    .map_err(err)?;
    serde_json::from_str(&raw.ok_or("作品不存在或已删除")?).map_err(err)
}
pub fn book_owner(book: &Value) -> String {
    match &book["ownerUserId"] {
        Value::String(owner) if !owner.is_empty() => owner.clone(),
        Value::Number(owner) => owner.to_string(),
        _ => "guest".into(),
    }
}
/// 编辑器的本机稿或书籍绑定账号的原稿。不同账号同时有稿时不能猜测或跨账号合并。
pub async fn chapter_owner(
    db: &mut SqliteConnection,
    bid: &str,
    cid: &str,
) -> Result<String, String> {
    let owner = book_owner(&book(db, bid).await?);
    let owners:Vec<String>=sqlx::query_scalar("SELECT userId FROM chapter_contents WHERE bookId=? AND chapterId=? AND userId IN (?, 'guest')")
        .bind(bid).bind(cid).bind(&owner).fetch_all(db).await.map_err(err)?;
    match owners.as_slice() {
        [] => Ok(owner),
        [one] => Ok(one.clone()),
        _ => Err("同一章有两个账号的正文，请先核对归属".into()),
    }
}
pub async fn chapter(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
) -> Result<Value, String> {
    book(db, book_id).await?;
    let catalog: Option<String> = sqlx::query_scalar("SELECT payload FROM local_chapters WHERE bookId=? AND CAST(id AS TEXT)=? AND deletedAt IS NULL")
        .bind(book_id).bind(chapter_id).fetch_optional(&mut *db).await.map_err(err)?;
    let catalog: Value =
        serde_json::from_str(&catalog.ok_or("章节不存在或不属于当前作品")?).map_err(err)?;
    let owner = chapter_owner(db, book_id, chapter_id).await?;
    let key = format!("{owner}:{book_id}:{chapter_id}");
    let raw: Option<String> =
        sqlx::query_scalar("SELECT payload FROM chapter_contents WHERE storageKey=?")
            .bind(&key)
            .fetch_optional(db)
            .await
            .map_err(err)?;
    if let Some(raw) = raw {
        return serde_json::from_str(&raw).map_err(err);
    }
    Ok(
        json!({"storageKey":key,"userId":owner,"bookId":book_id,"chapterId":catalog["id"],
        "title":catalog["title"],"textContent":"","contentJson":null,"localVersion":0,
        "remoteVersion":0,"baseRemoteVersion":0,"baseTitle":"","baseTextContent":"",
        "baseContentJson":null,"dirty":true,"conflict":false,"localOnly":true,"updatedAt":0,"lastBackedUpAt":0}),
    )
}

pub async fn catalog(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    book(db, book_id).await?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT c.payload FROM local_chapters c JOIN local_volumes v ON CAST(v.id AS TEXT)=c.volumeId AND v.bookId=c.bookId WHERE c.bookId=? AND c.deletedAt IS NULL AND v.deletedAt IS NULL ORDER BY v.sortNo,v.id,c.sortNo,c.id")
        .bind(book_id).fetch_all(db).await.map_err(err)?;
    rows.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(err))
        .collect()
}
