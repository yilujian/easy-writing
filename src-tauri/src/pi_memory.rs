//! Pi 独立的长期记忆。只保存作者确认的偏好/事实，不读取旧 Agent 的推断记忆。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;

const NS: &str = "ew-agent-pi/memory";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub async fn list(db: &mut SqliteConnection, book: &str) -> Result<Vec<Value>, String> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND (json_extract(value,'$.scope')='author' OR json_extract(value,'$.bookId')=?) ORDER BY json_extract(value,'$.updatedAt') DESC, key")
        .bind(NS).bind(book).fetch_all(db).await.map_err(err)?;
    rows.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(err))
        .collect()
}

pub async fn dispatch(root: &Path, args: Value) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let result = operate(&mut tx, &args).await?;
    tx.commit().await.map_err(err)?;
    Ok(result)
}

/// Preview and apply use the same book binding and revision as the author-facing memory editor.
pub(super) async fn tool(
    db: &mut SqliteConnection,
    name: &str,
    args: &Value,
    bid: &str,
) -> Result<Value, String> {
    let rows = list(db, bid).await?;
    let id = args["id"].as_str().unwrap_or_default();
    let old = rows.iter().find(|r| r["id"] == id);
    let deleting = name == "forget_memory";
    let preview = args["prepare"] == true;
    if !id.is_empty()
        && old.is_none()
        && (preview || deleting || args["revision"].as_u64().unwrap_or(0) > 0)
    {
        return Err("记忆不存在或不属于当前作品，请重新读取".into());
    }
    if deleting {
        let old = old.ok_or("请先读取要删除的记忆")?;
        if preview {
            return Ok(old.clone());
        }
        return operate(
            db,
            &json!({"op":"delete","id":id,"bookId":old["bookId"],"revision":args["revision"]}),
        )
        .await;
    }
    let scope = args["scope"]
        .as_str()
        .or_else(|| old.and_then(|v| v["scope"].as_str()))
        .ok_or("请选择作者偏好或作品事实")?;
    if !matches!(scope, "author" | "book") || (scope == "book" && bid.is_empty()) {
        return Err("作品事实需要绑定作品".into());
    }
    if old.is_some_and(|v| v["scope"] != scope) {
        return Err("不能改变已有记忆的范围，请新建另一条".into());
    }
    let content = args["content"].as_str().unwrap_or_default().trim();
    if content.is_empty() || content.chars().count() > 1200 {
        return Err("每条记忆需为 1—1200 字".into());
    }
    let mut value = json!({"scope":scope,"content":content,"bookId":if scope=="book"{bid}else{""},
        "id":if id.is_empty(){uuid::Uuid::new_v4().to_string()}else{id.to_owned()},
        "revision":if preview{old.and_then(|o|o["revision"].as_u64()).unwrap_or(0)}else{args["revision"].as_u64().unwrap_or(0)}});
    if let Some(anchor) = args
        .get("afterChapterId")
        .or_else(|| old.and_then(|o| o.get("afterChapterId")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if scope != "book" {
            return Err("章节更正需要绑定作品".into());
        }
        let catalog = crate::writing_records::catalog(db, bid).await?;
        let chapter = catalog
            .iter()
            .find(|c| c["id"].to_string() == anchor)
            .ok_or("更正所指的章节不属于当前作品")?;
        value["afterChapterId"] = json!(anchor);
        value["afterChapterTitle"] = chapter["title"].clone();
    }
    if let Some(knowledge) = args
        .get("knowledge")
        .or_else(|| old.and_then(|o| o.get("knowledge")))
    {
        value["knowledge"] = knowledge.clone();
    }
    if preview {
        return Ok(value);
    }
    value["op"] = json!("save");
    value["source"] = json!("confirmed");
    value["sessionId"] = args["sessionId"].clone();
    operate(db, &value).await
}

async fn operate(db: &mut SqliteConnection, args: &Value) -> Result<Value, String> {
    let book = args["bookId"].as_str().unwrap_or_default();
    let op = args["op"].as_str().unwrap_or_default();
    if op == "list" {
        return Ok(json!(list(db, book).await?));
    }
    if !matches!(op, "save" | "delete") {
        return Err("未知记忆操作".into());
    }
    let id = args["id"].as_str().ok_or("缺少记忆编号")?;
    uuid::Uuid::parse_str(id).map_err(|_| "记忆编号无效")?;
    let key = json!(id).to_string();
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(&key)
            .fetch_optional(&mut *db)
            .await
            .map_err(err)?;
    let old: Option<Value> = raw
        .map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()?;
    if let Some(value) = &old {
        if value["scope"] == "book" && value["bookId"] != book {
            return Err("记忆不属于当前作品".into());
        }
        if args["revision"] != value["revision"] {
            return Err("记忆已改变，请重新读取后确认".into());
        }
    } else if op == "delete" || args["revision"].as_u64().unwrap_or(0) != 0 {
        return Err("记忆已删除或不存在".into());
    }
    if op == "delete" {
        sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(key)
            .execute(db)
            .await
            .map_err(err)?;
        return Ok(json!({"deleted":true,"id":id}));
    }
    let scope = args["scope"].as_str().unwrap_or_default();
    if !matches!(scope, "author" | "book") {
        return Err("请选择作者偏好或作品事实".into());
    }
    if scope == "book" {
        // 与 Pi 作品绑定使用同一个校验入口，不能给已删除作品建立记忆。
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL)")
            .bind(book).fetch_one(&mut *db).await.map_err(err)?;
        if !exists {
            return Err("作品不存在或已删除".into());
        }
    }
    let content = args["content"].as_str().unwrap_or_default().trim();
    if content.is_empty() || content.chars().count() > 1200 {
        return Err("每条记忆需为 1—1200 字".into());
    }
    let rows = list(db, book).await?;
    if old.is_none() && rows.iter().filter(|v| v["scope"] == scope).count() >= 100 {
        return Err("此范围已有 100 条记忆，请先整理已有内容".into());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut value = json!({"id":id,"scope":scope,"bookId":if scope=="book"{book}else{""},"content":content,
        "revision":old.as_ref().and_then(|v|v["revision"].as_u64()).unwrap_or(0)+1,
        "createdAt":old.as_ref().and_then(|v|v["createdAt"].as_i64()).unwrap_or(now),"updatedAt":now,
        "source":args["source"].as_str().unwrap_or("manual"),"sessionId":args["sessionId"].as_str().unwrap_or_default()});
    if let Some(anchor) = args["afterChapterId"]
        .as_str()
        .or_else(|| old.as_ref().and_then(|o| o["afterChapterId"].as_str()))
    {
        if scope != "book"
            || !crate::writing_records::catalog(db, book)
                .await?
                .iter()
                .any(|c| c["id"].to_string() == anchor)
        {
            return Err("更正所指的章节不属于当前作品".into());
        }
        if let Some(correction) = args
            .get("knowledge")
            .or_else(|| old.as_ref().and_then(|o| o.get("knowledge")))
        {
            let cid = crate::writing_records::str_field(correction, "characterId")?;
            let fid = crate::writing_records::str_field(correction, "factId")?;
            correction["known"]
                .as_bool()
                .ok_or("缺少作者对知情范围的决定")?;
            let h = crate::story_history::History::load(db, book).await?;
            let end = h.boundary(&json!({"chapterId":anchor}))? + 1;
            let state = crate::story_history::snapshot(db, book, &h, end).await?;
            if !state.people.contains_key(cid) || !state.facts.contains_key(fid) {
                return Err("所选章节还没有可核对的这组人物和事实，请按作者原话记录更正".into());
            }
            value["knowledge"] = correction.clone();
        }
        value["afterChapterId"] = json!(anchor);
    }
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")
        .bind(NS).bind(key).bind(value.to_string()).execute(db).await.map_err(err)?;
    Ok(value)
}

#[cfg(all(test, feature = "local-tests"))]
mod tests {
    use super::*;
    struct Env(std::path::PathBuf);
    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    async fn fixture() -> Env {
        let e = Env(std::env::temp_dir().join(format!("pi-memory-{}", uuid::Uuid::new_v4())));
        let mut db = crate::desktop_storage::connect_at(&e.0).await.unwrap();
        for id in [-1, -2] {
            sqlx::query("INSERT INTO local_books(id,payload,title,mergeStatus,updateTime) VALUES(?,?,'测试书','local','now')")
                .bind(id).bind(json!({"id":id,"title":"测试书"}).to_string()).execute(&mut db).await.unwrap();
        }
        e
    }
    fn new(scope: &str, book: &str, content: &str) -> Value {
        json!({"op":"save","id":uuid::Uuid::new_v4().to_string(),"scope":scope,"bookId":book,"content":content,"revision":0})
    }
    #[tokio::test]
    async fn scopes_are_isolated_and_visible_in_each_model_context() {
        let e = fixture().await;
        dispatch(&e.0, new("author", "", "偏好简洁")).await.unwrap();
        dispatch(&e.0, new("book", "-1", "一号书事实"))
            .await
            .unwrap();
        dispatch(&e.0, new("book", "-2", "二号书事实"))
            .await
            .unwrap();
        let state =
            super::super::context::snapshot(&e.0, "session", &json!({"id":"-1","title":"一号书"}))
                .await
                .unwrap();
        assert_eq!(state["memories"].as_array().unwrap().len(), 2);
        assert!(!state["memories"].to_string().contains("二号书"));
        let global = dispatch(&e.0, json!({"op":"list","bookId":""}))
            .await
            .unwrap();
        assert_eq!(global.as_array().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn stale_updates_deletions_and_cross_book_access_are_rejected() {
        let e = fixture().await;
        let mut request = new("book", "-1", "旧事实");
        let old = dispatch(&e.0, request.clone()).await.unwrap();
        request["content"] = json!("新事实");
        assert!(dispatch(&e.0, request.clone())
            .await
            .unwrap_err()
            .contains("已改变"));
        request["revision"] = old["revision"].clone();
        request["bookId"] = json!("-2");
        assert!(dispatch(&e.0, request.clone())
            .await
            .unwrap_err()
            .contains("不属于"));
        request["bookId"] = json!("-1");
        let saved = dispatch(&e.0, request.clone()).await.unwrap();
        request["op"] = json!("delete");
        assert!(dispatch(&e.0, request.clone())
            .await
            .unwrap_err()
            .contains("已改变"));
        request["revision"] = saved["revision"].clone();
        dispatch(&e.0, request).await.unwrap();
        assert!(dispatch(&e.0, json!({"op":"list","bookId":"-1"}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn invalid_scope_empty_content_and_missing_book_do_not_write() {
        let e = fixture().await;
        assert!(dispatch(&e.0, new("invented", "", "x")).await.is_err());
        assert!(dispatch(&e.0, new("author", "", " ")).await.is_err());
        assert!(dispatch(&e.0, new("book", "-404", "x")).await.is_err());
        assert!(dispatch(&e.0, new("author", "", &"字".repeat(1201)))
            .await
            .is_err());
        assert!(dispatch(&e.0, json!({"op":"list"}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }
}
