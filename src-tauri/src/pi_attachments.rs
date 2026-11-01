//! Chat TXT attachments retain the original decoded text separately from parsed chapters.
//! 登记时就带上传时识别出的目录（书名、章数、章名），入库在后台进行；入库中和失败的附件
//! 也能被本会话读到状态和目录，只有入库完成的才能读原文或重新识别。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;
const NS: &str = "ew-local-breakdown/kv";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
async fn get(db: &mut SqliteConnection, key: &str) -> Result<Value, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(json!(key).to_string())
            .fetch_optional(db)
            .await
            .map_err(err)?;
    serde_json::from_str(&raw.ok_or("附件不存在")?).map_err(err)
}
async fn put(db: &mut SqliteConnection, key: &str, value: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value").bind(NS).bind(json!(key).to_string()).bind(value.to_string()).execute(db).await.map_err(err)?;
    Ok(())
}
const INTERRUPTED: &str = "应用关闭时导入中断，请重新上传";
async fn delete_key(tx: &mut SqliteConnection, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
        .bind(NS)
        .bind(json!(key).to_string())
        .execute(tx)
        .await
        .map_err(err)?;
    Ok(())
}
async fn drop_source(tx: &mut SqliteConnection, meta: &mut Value) -> Result<(), String> {
    let id = meta["id"].as_str().unwrap_or_default().to_owned();
    for i in 0..meta["chunks"].as_u64().unwrap_or(0) {
        delete_key(tx, &format!("attachment-source:{id}:{i}")).await?;
    }
    meta["chunks"] = json!(0);
    meta["chars"] = json!(0);
    Ok(())
}
async fn session_rows(tx: &mut SqliteConnection, sid: &str) -> Result<Vec<Value>, String> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"attachment:%' AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt')")
        .bind(NS).bind(sid).fetch_all(tx).await.map_err(err)?;
    rows.into_iter()
        .map(|s| serde_json::from_str(&s).map_err(err))
        .collect()
}
/// 列表和模型快照不带整份目录；目录只在读取单个附件时返回。
fn brief(mut meta: Value) -> Value {
    if let Some(map) = meta.as_object_mut() {
        map.remove("catalog");
    }
    meta
}
pub async fn dispatch(root: &Path, args: Value) -> Result<Value, String> {
    let op = args["op"].as_str().unwrap_or_default();
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    if op == "recover" {
        // 启动时：上次关闭前没入库完的附件没有 worker 了，标为失败并释放原文，不让模型一直等。
        let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"attachment:%' AND json_extract(value,'$.status')='importing'")
            .bind(NS).fetch_all(&mut *tx).await.map_err(err)?;
        let mut changed = Vec::new();
        for raw in rows {
            let mut meta: Value = serde_json::from_str(&raw).map_err(err)?;
            drop_source(&mut tx, &mut meta).await?;
            meta["status"] = json!("failed");
            meta["error"] = json!(INTERRUPTED);
            put(&mut tx, &format!("attachment:{}", meta["id"].as_str().unwrap_or_default()), &meta).await?;
            changed.push(brief(meta));
        }
        tx.commit().await.map_err(err)?;
        return Ok(json!(changed));
    }
    let sid = args["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("附件必须属于一个会话")?;
    if op == "list" {
        let rows = session_rows(&mut tx, sid).await?;
        tx.commit().await.map_err(err)?;
        return Ok(json!(rows.into_iter().map(brief).collect::<Vec<_>>()));
    }
    let id = args["id"].as_str().ok_or("附件编号缺失")?;
    uuid::Uuid::parse_str(id).map_err(|_| "附件编号无效")?;
    let key = format!("attachment:{id}");
    let output = if op == "begin" {
        if get(&mut tx, &key).await.is_ok() {
            return Err("附件编号已使用".into());
        }
        let name = args["filename"]
            .as_str()
            .filter(|n| {
                let lower = n.to_lowercase();
                n.len() <= 512 && [".txt", ".md", ".markdown", ".docx", ".epub"].iter().any(|ext| lower.ends_with(ext))
            })
            .ok_or("只支持 TXT、Markdown、Word（docx）或 EPUB 附件")?;
        let catalog = args.get("catalog").filter(|c| c.is_object()).cloned();
        if catalog
            .as_ref()
            .and_then(|c| c["chapters"].as_array())
            .is_some_and(|chapters| chapters.len() > 50_000)
        {
            return Err("附件目录过大".into());
        }
        let title = catalog
            .as_ref()
            .and_then(|c| c["title"].as_str())
            .filter(|t| !t.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| name.rsplit_once('.').map_or(name, |(stem, _)| stem).to_owned());
        let count = catalog
            .as_ref()
            .and_then(|c| c["chapterCount"].as_u64())
            .unwrap_or(0);
        let notes = catalog
            .as_ref()
            .map(|c| c["warnings"].clone())
            .filter(|w| w.is_array())
            .unwrap_or(Value::Null);
        let meta = json!({"id":id,"sessionId":sid,"filename":name,"status":"importing","error":Value::Null,"title":title,"chapterCount":count,"notes":notes,"projectId":Value::Null,"catalog":catalog,"chunks":0,"chars":0,"revision":0,"headingStyle":"auto","createdAt":chrono::Utc::now().timestamp_millis()});
        put(&mut tx, &key, &meta).await?;
        meta
    } else {
        let mut meta = get(&mut tx, &key).await?;
        if meta["sessionId"] != sid {
            return Err("附件不属于当前会话".into());
        }
        match op {
            "fail" => {
                if meta["status"] == "ready" {
                    return Err("已完成的附件不能标记失败".into());
                }
                let reason: String = args["error"]
                    .as_str()
                    .filter(|e| !e.trim().is_empty())
                    .unwrap_or("入库失败")
                    .chars()
                    .take(300)
                    .collect();
                drop_source(&mut tx, &mut meta).await?;
                meta["status"] = json!("failed");
                meta["error"] = json!(reason);
                put(&mut tx, &key, &meta).await?;
                meta
            }
            "append" => {
                if meta["status"] != "importing" || meta["chunks"] != args["index"] {
                    return Err("附件写入顺序无效".into());
                }
                let text = args["text"].as_str().ok_or("附件内容无效")?;
                let size = text.chars().count();
                let total = meta["chars"].as_u64().unwrap_or(0) + size as u64;
                if size > 262144 || total > 60 * 1024 * 1024 {
                    return Err("附件超出大小限制".into());
                }
                put(
                    &mut tx,
                    &format!("attachment-source:{id}:{}", meta["chunks"]),
                    &json!(text),
                )
                .await?;
                meta["chunks"] = json!(meta["chunks"].as_u64().unwrap_or(0) + 1);
                meta["chars"] = json!(total);
                put(&mut tx, &key, &meta).await?;
                meta
            }
            "finish" => {
                if meta["revision"] != args["expectedRevision"] {
                    return Err("附件目录已更新，请重新读取".into());
                }
                if meta["chars"].as_u64().unwrap_or(0) == 0 {
                    return Err("附件原文尚未保存".into());
                }
                let pid = args["projectId"].as_i64().ok_or("参考书编号无效")?;
                let project = get(&mut tx, &format!("project:{pid}")).await?;
                if project["visibility"] == "conversation" {
                    return Err("参考书尚未保存".into());
                }
                let style = args["headingStyle"].as_str().unwrap_or("auto");
                if !["auto", "numbered", "markdown"].contains(&style) {
                    return Err("分章方式无效".into());
                }
                meta["projectId"] = json!(pid);
                meta["title"] = project["title"].clone();
                meta["chapterCount"] = json!(project["chapters"].as_array().map_or(0, Vec::len));
                meta["notes"] = project["importNotes"].clone();
                meta["headingStyle"] = json!(style);
                meta["status"] = json!("ready");
                meta["error"] = Value::Null;
                meta["revision"] = json!(meta["revision"].as_u64().unwrap_or(0) + 1);
                if let Some(map) = meta.as_object_mut() {
                    map.remove("catalog");
                }
                put(&mut tx, &key, &meta).await?;
                meta
            }
            // 入库中和失败的附件也能读到状态、目录和原因；原文只有入库完成后才开放。
            "get" => meta,
            "source" => {
                if meta["status"] != "ready" {
                    return Err("附件尚未导入完成".into());
                }
                let index = args["index"].as_u64().ok_or("原文分块编号无效")?;
                if index >= meta["chunks"].as_u64().unwrap_or(0) {
                    return Err("原文分块越界".into());
                }
                get(&mut tx, &format!("attachment-source:{id}:{index}")).await?
            }
            "abort" => {
                if meta["status"] == "ready" {
                    return Err("已完成附件不能作为临时文件清理".into());
                }
                drop_source(&mut tx, &mut meta).await?;
                delete_key(&mut tx, &key).await?;
                Value::Null
            }
            _ => return Err("未知附件操作".into()),
        }
    };
    tx.commit().await.map_err(err)?;
    Ok(output)
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
        let e = Env(std::env::temp_dir().join(format!("pi-attachment-{}", uuid::Uuid::new_v4())));
        let mut db = crate::desktop_storage::connect_at(&e.0).await.unwrap();
        put(&mut db,"project:12",&json!({"id":12,"title":"样本书","visibility":"workbench","chapters":[{"id":13}],"importNotes":["目录提示"]})).await.unwrap();
        e
    }
    async fn op(e: &Env, operation: &str, id: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = json!(operation);
        args["id"] = json!(id);
        if args["sessionId"].is_null() {
            args["sessionId"] = json!("s1")
        }
        dispatch(&e.0, args).await
    }
    async fn begin(e: &Env) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        op(e, "begin", &id, json!({"filename":"原始书籍.txt"}))
            .await
            .unwrap();
        id
    }
    async fn finish(e: &Env, id: &str) -> Value {
        op(
            e,
            "finish",
            id,
            json!({"projectId":12,"headingStyle":"auto","expectedRevision":0}),
        )
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn original_source_survives_reopen_and_only_owner_can_read() {
        let e = fixture().await;
        let id = begin(&e).await;
        op(
            &e,
            "append",
            &id,
            json!({"index":0,"text":"# 第一章\n原文😀"}),
        )
        .await
        .unwrap();
        op(
            &e,
            "append",
            &id,
            json!({"index":1,"text":"\n# 第二章\n保留原始标题"}),
        )
        .await
        .unwrap();
        finish(&e, &id).await;
        let source = op(&e, "source", &id, json!({"index":0})).await.unwrap();
        assert_eq!(source, "# 第一章\n原文😀");
        assert!(op(&e, "get", &id, json!({"sessionId":"s2"}))
            .await
            .unwrap_err()
            .contains("当前会话"));
        assert!(op(&e, "source", &id, json!({"sessionId":"s2","index":0}))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn failed_or_out_of_order_upload_is_not_an_attachment() {
        let e = fixture().await;
        let id = begin(&e).await;
        assert!(op(&e, "append", &id, json!({"index":1,"text":"迟到分块"}))
            .await
            .is_err());
        // 入库中的附件能读到状态，但原文还不开放
        assert_eq!(op(&e, "get", &id, json!({})).await.unwrap()["status"], "importing");
        assert!(op(&e, "source", &id, json!({"index":0})).await.is_err());
        assert!(op(
            &e,
            "finish",
            &id,
            json!({"projectId":12,"expectedRevision":0})
        )
        .await
        .is_err());
        op(&e, "append", &id, json!({"index":0,"text":"保留原文"}))
            .await
            .unwrap();
        op(&e, "abort", &id, json!({})).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        assert!(get(&mut db, &format!("attachment-source:{id}:0"))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn reparse_uses_revision_and_never_mutates_original_source() {
        let e = fixture().await;
        let id = begin(&e).await;
        op(
            &e,
            "append",
            &id,
            json!({"index":0,"text":"# 原始标题\n原文"}),
        )
        .await
        .unwrap();
        finish(&e, &id).await;
        let revised = op(
            &e,
            "finish",
            &id,
            json!({"projectId":12,"headingStyle":"markdown","expectedRevision":1}),
        )
        .await
        .unwrap();
        assert_eq!(revised["revision"], 2);
        assert!(op(
            &e,
            "finish",
            &id,
            json!({"projectId":12,"headingStyle":"numbered","expectedRevision":1})
        )
        .await
        .is_err());
        assert_eq!(
            op(&e, "source", &id, json!({"index":0})).await.unwrap(),
            "# 原始标题\n原文"
        );
        assert!(op(&e, "abort", &id, json!({})).await.is_err());
    }
    #[tokio::test]
    async fn model_context_includes_importing_status_but_never_source_text() {
        let e = fixture().await;
        let id = begin(&e).await;
        op(
            &e,
            "append",
            &id,
            json!({"index":0,"text":"不能整本塞进上下文的原文"}),
        )
        .await
        .unwrap();
        let importing = super::super::context::snapshot(&e.0, "s1", &Value::Null)
            .await
            .unwrap();
        assert_eq!(importing["attachments"][0]["attachmentId"], id);
        assert_eq!(importing["attachments"][0]["status"], "importing");
        assert!(!importing.to_string().contains("不能整本塞"));
        finish(&e, &id).await;
        let snapshot = super::super::context::snapshot(&e.0, "s1", &Value::Null)
            .await
            .unwrap();
        assert_eq!(snapshot["attachments"][0]["status"], "ready");
        assert_eq!(snapshot["attachments"][0]["chapterCount"], 1);
        assert!(!snapshot.to_string().contains("不能整本塞"));
        assert_eq!(
            super::super::context::snapshot(&e.0, "s2", &Value::Null)
                .await
                .unwrap()["attachments"],
            json!([])
        );
    }
    #[tokio::test]
    async fn catalog_registered_at_begin_is_readable_before_finish_and_listed_briefly() {
        let e = fixture().await;
        let id = uuid::Uuid::new_v4().to_string();
        let catalog = json!({"title":"预览书","chapterCount":2,"chars":9,"warnings":["有 1 章不到 200 字"],"book":true,"chapters":[{"no":1,"title":"第一章","chars":4},{"no":2,"title":"第二章","chars":5}]});
        let meta = op(&e, "begin", &id, json!({"filename":"预览书.txt","catalog":catalog}))
            .await
            .unwrap();
        assert_eq!(meta["status"], "importing");
        assert_eq!(meta["title"], "预览书");
        assert_eq!(meta["chapterCount"], 2);
        let read = op(&e, "get", &id, json!({})).await.unwrap();
        assert_eq!(read["catalog"]["chapters"][1]["title"], "第二章");
        assert_eq!(read["notes"][0], "有 1 章不到 200 字");
        assert!(op(&e, "get", &id, json!({"sessionId":"s2"})).await.is_err());
        let listed = op(&e, "list", &id, json!({})).await.unwrap();
        assert_eq!(listed[0]["id"], id);
        assert!(listed[0].get("catalog").is_none());
        assert!(op(&e, "source", &id, json!({"index":0})).await.is_err());
        let without = op(&e, "begin", &uuid::Uuid::new_v4().to_string(), json!({"filename":"无目录.EPUB"}))
            .await
            .unwrap();
        assert_eq!(without["title"], "无目录");
        assert!(op(&e, "begin", &uuid::Uuid::new_v4().to_string(), json!({"filename":"图.pdf"})).await.is_err());
        assert_eq!(without["chapterCount"], 0);
    }
    #[tokio::test]
    async fn failed_import_keeps_reason_and_frees_source_while_ready_cannot_fail() {
        let e = fixture().await;
        let id = begin(&e).await;
        op(&e, "append", &id, json!({"index":0,"text":"原文"}))
            .await
            .unwrap();
        let failed = op(&e, "fail", &id, json!({"error":"文件是空的"})).await.unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"], "文件是空的");
        assert_eq!(failed["chunks"], 0);
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        assert!(get(&mut db, &format!("attachment-source:{id}:0"))
            .await
            .is_err());
        assert_eq!(op(&e, "get", &id, json!({})).await.unwrap()["status"], "failed");
        assert!(op(
            &e,
            "finish",
            &id,
            json!({"projectId":12,"headingStyle":"auto","expectedRevision":0})
        )
        .await
        .is_err());
        let done = begin(&e).await;
        op(&e, "append", &done, json!({"index":0,"text":"原文"}))
            .await
            .unwrap();
        finish(&e, &done).await;
        assert!(op(&e, "fail", &done, json!({"error":"晚到"})).await.is_err());
    }
    #[tokio::test]
    async fn recover_marks_interrupted_imports_failed_and_leaves_ready_ones() {
        let e = fixture().await;
        let stuck = begin(&e).await;
        op(&e, "append", &stuck, json!({"index":0,"text":"没入库完"}))
            .await
            .unwrap();
        let done = begin(&e).await;
        op(&e, "append", &done, json!({"index":0,"text":"原文"}))
            .await
            .unwrap();
        finish(&e, &done).await;
        let changed = dispatch(&e.0, json!({"op":"recover"})).await.unwrap();
        assert_eq!(changed.as_array().unwrap().len(), 1);
        assert_eq!(changed[0]["id"], stuck);
        let read = op(&e, "get", &stuck, json!({})).await.unwrap();
        assert_eq!(read["status"], "failed");
        assert_eq!(read["error"], INTERRUPTED);
        assert_eq!(op(&e, "get", &done, json!({})).await.unwrap()["status"], "ready");
        assert_eq!(
            op(&e, "source", &done, json!({"index":0})).await.unwrap(),
            "原文"
        );
        assert!(dispatch(&e.0, json!({"op":"recover"})).await.unwrap().as_array().unwrap().is_empty());
    }
}
