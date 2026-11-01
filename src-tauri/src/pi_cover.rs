//! 封面任务的宿主记录：简报、用的图片模型、生成结果、采用时间。生图在前端调平台画图能力，这里只管状态。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;

const NS: &str = "ew-agent-pi/cover";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn stamp() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn key(id: &str) -> String {
    format!("task:{id}")
}
fn text(args: &Value, k: &str) -> String {
    args[k].as_str().unwrap_or_default().to_owned()
}
async fn read(db: &mut SqliteConnection, key: &str) -> Result<Value, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(json!(key).to_string())
            .fetch_optional(db)
            .await
            .map_err(err)?;
    serde_json::from_str(&raw.ok_or("封面任务不存在")?).map_err(err)
}
async fn put(db: &mut SqliteConnection, key: &str, value: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value").bind(NS).bind(json!(key).to_string()).bind(value.to_string()).execute(db).await.map_err(err)?;
    Ok(())
}
pub async fn tasks(db: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"task:%' ORDER BY json_extract(value,'$.createdAt') DESC")
        .bind(NS).fetch_all(db).await.map_err(err)?;
    rows.into_iter().map(|s| serde_json::from_str(&s).map_err(err)).collect()
}
pub async fn dispatch(root: &Path, args: Value) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let op = text(&args, "op");
    let output = match op.as_str() {
        "list" => json!(tasks(&mut tx).await?),
        // 重启后正在生成的图已经丢了：标未完成，作者可以重新发起
        "recover" => {
            for mut t in tasks(&mut tx).await? {
                if t["status"] == "running" {
                    t["status"] = json!("failed");
                    t["error"] = json!("上次生成在应用关闭时中断，请重新发起");
                    t["updatedAt"] = json!(stamp());
                    put(&mut tx, &key(&text(&t, "id")), &t).await?;
                }
            }
            json!(tasks(&mut tx).await?)
        }
        "create" => {
            let id = text(&args, "id");
            uuid::Uuid::parse_str(&id).map_err(|_| "任务编号无效")?;
            if let Some(old) = super::task_identity::existing(&mut tx, NS, &args).await? {
                if old["bookId"] != args["bookId"] || old["modelCode"] != args["modelCode"]
                    || ["prompt", "negativePrompt", "style", "size", "summary"].iter()
                        .any(|k| text(&old,k) != text(&args["brief"],k)) {
                    return Err("这次确认已用于不同的封面请求".into());
                }
                tx.commit().await.map_err(err)?;
                return Ok(old);
            }
            let brief = &args["brief"];
            let prompt = text(brief, "prompt");
            if prompt.trim().is_empty() || prompt.chars().count() > 2000 {
                return Err("封面简报缺少画面描述，或超过 2000 字".into());
            }
            if text(&args, "bookId").is_empty() {
                return Err("封面任务需要先绑定作品".into());
            }
            let t = json!({
                "id": id, "sessionId": args["sessionId"], "callId": args["callId"], "anchor": args["anchor"],
                "bookId": args["bookId"], "bookTitle": args["bookTitle"], "modelCode": args["modelCode"], "modelName": args["modelName"],
                "prompt": prompt, "negativePrompt": text(brief, "negativePrompt"), "style": text(brief, "style"), "size": text(brief, "size"), "summary": text(brief, "summary"),
                "createdAt": stamp(), "updatedAt": stamp(), "status": "running", "imageId": Value::Null, "imageUrl": "", "appliedAt": Value::Null,
                "autoContinue": args["autoContinue"] != false, "continuedAt": Value::Null, "continueSkipped": Value::Null,
            });
            put(&mut tx, &key(&id), &t).await?;
            t
        }
        "get" | "cancel" | "fail" | "complete" | "apply" | "continue_state" => {
            let id = text(&args, "id");
            let mut t = read(&mut tx, &key(&id)).await?;
            if op == "get" {
                t
            } else {
                match op.as_str() {
                    "cancel" => {
                        if t["status"] != "running" {
                            return Err("任务已经结束".into());
                        }
                        t["status"] = json!("cancelled");
                    }
                    "fail" => {
                        if t["status"] != "running" {
                            return Err("任务已经结束，本次结果未写入".into());
                        }
                        t["status"] = json!("failed");
                        t["error"] = json!(text(&args, "error"));
                    }
                    "complete" => {
                        if t["status"] != "running" {
                            return Err("任务已经结束，本次结果未写入".into());
                        }
                        if text(&args, "imageUrl").is_empty() {
                            return Err("没有图片地址".into());
                        }
                        t["status"] = json!("completed");
                        t["imageId"] = args["imageId"].clone();
                        t["imageUrl"] = args["imageUrl"].clone();
                        if let Some(name) = args["modelName"].as_str() {
                            t["modelName"] = json!(name);
                        }
                    }
                    "apply" => {
                        if t["status"] != "completed" {
                            return Err("图还没生成好".into());
                        }
                        t["appliedAt"] = json!(stamp());
                    }
                    "continue_state" => {
                        if let Some(value) = args.get("autoContinue") {
                            t["autoContinue"] = json!(*value == true);
                        }
                        if let Some(value) = args.get("continuedAt") {
                            t["continuedAt"] = value.clone();
                        }
                        if let Some(value) = args.get("continueSkipped") {
                            t["continueSkipped"] = value.clone();
                        }
                    }
                    _ => unreachable!(),
                }
                t["updatedAt"] = json!(stamp());
                put(&mut tx, &key(&id), &t).await?;
                t
            }
        }
        _ => return Err("未知封面操作".into()),
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
        let e = Env(std::env::temp_dir().join(format!("pi-cover-{}", uuid::Uuid::new_v4())));
        crate::desktop_storage::connect_at(&e.0).await.unwrap();
        e
    }
    async fn call(e: &Env, op: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = json!(op);
        dispatch(&e.0, args).await
    }
    #[tokio::test]
    async fn cover_task_completes_then_applies_and_recovery_fails_interrupted_runs() {
        let e = fixture().await;
        let id = uuid::Uuid::new_v4().to_string();
        assert!(call(&e, "create", json!({"id":id,"bookId":"-5","brief":{"prompt":""},"sessionId":"s1"})).await.is_err());
        let t = call(&e, "create", json!({"id":id,"bookId":"-5","bookTitle":"我的书","modelCode":"img","modelName":"画图模型","sessionId":"s1","brief":{"prompt":"少年持剑立于城门","negativePrompt":"水印","style":"国风","size":"768x1024","summary":"玄幻·少年·国风"}})).await.unwrap();
        assert_eq!(t["status"], "running");
        assert_eq!(t["summary"], "玄幻·少年·国风");
        assert!(call(&e, "apply", json!({"id":id})).await.is_err());
        let done = call(&e, "complete", json!({"id":id,"imageId":9,"imageUrl":"blob:x","modelName":"实际模型"})).await.unwrap();
        assert_eq!(done["status"], "completed");
        assert_eq!(done["modelName"], "实际模型");
        assert!(call(&e, "fail", json!({"id":id,"error":"晚到"})).await.is_err());
        let applied = call(&e, "apply", json!({"id":id})).await.unwrap();
        assert!(applied["appliedAt"].is_number());
        let other = uuid::Uuid::new_v4().to_string();
        call(&e, "create", json!({"id":other,"bookId":"-5","bookTitle":"我的书","modelCode":"img","modelName":"m","sessionId":"s1","brief":{"prompt":"第二张"}})).await.unwrap();
        let recovered = call(&e, "recover", json!({})).await.unwrap();
        let stuck = recovered.as_array().unwrap().iter().find(|t| t["id"] == other).unwrap();
        assert_eq!(stuck["status"], "failed");
        assert!(stuck["error"].as_str().unwrap().contains("中断"));
        assert_eq!(recovered.as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["status"], "completed");
    }
}
