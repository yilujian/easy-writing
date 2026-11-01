//! 批量写作任务的宿主记录：作者确认的每章目标、每一步写到哪、产出的候选和采用后的章节。
//! 写作本身是对话里的一轮一轮（由界面代作者发事件），这里只管状态表：
//! running → waiting(review: 等采用 | chat_busy: 对话正忙 | no_draft: 这一轮没出候选) → running → completed；
//! 作者可 paused / cancelled。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;

const NS: &str = "ew-agent-pi/batch";
pub const MAX_STEPS: usize = 20;
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
    serde_json::from_str(&raw.ok_or("批量任务不存在")?).map_err(err)
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
fn live(t: &Value) -> bool {
    matches!(t["status"].as_str(), Some("running") | Some("waiting"))
}
fn step_mut<'a>(t: &'a mut Value, index: usize) -> Result<&'a mut Value, String> {
    t["steps"]
        .as_array_mut()
        .ok_or("步骤无效")?
        .get_mut(index)
        .ok_or_else(|| "步骤超出范围".to_owned())
}
fn all_done(t: &Value) -> bool {
    t["steps"]
        .as_array()
        .is_some_and(|s| !s.is_empty() && s.iter().all(|x| matches!(x["status"].as_str(), Some("done") | Some("skipped"))))
}
pub async fn dispatch(root: &Path, args: Value) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let op = text(&args, "op");
    let output = match op.as_str() {
        "list" => json!(tasks(&mut tx).await?),
        // 重启后：正在写的那一章这一轮已经丢了，退回等作者；不自动续跑
        "recover" => {
            for mut t in tasks(&mut tx).await? {
                if live(&t) {
                    let cursor = t["cursor"].as_u64().unwrap_or(0) as usize;
                    if let Ok(step) = step_mut(&mut t, cursor) {
                        if step["status"] == "writing" {
                            step["status"] = json!("pending");
                            step["startedAt"] = Value::Null;
                        }
                    }
                    t["status"] = json!("paused");
                    t["waitingReason"] = Value::Null;
                    t["error"] = json!("上次执行已中断，点击继续后从当前这一章接着");
                    t["updatedAt"] = json!(stamp());
                    put(&mut tx, &key(&text(&t, "id")), &t).await?;
                }
            }
            json!(tasks(&mut tx).await?)
        }
        "create" => {
            let plan = &args["plan"];
            let id = text(&args, "id");
            uuid::Uuid::parse_str(&id).map_err(|_| "任务编号无效")?;
            if let Some(old) = super::task_identity::existing(&mut tx, NS, &args).await? {
                if old["plan"] != *plan || old["sessionId"] != args["sessionId"] || old["modelCode"] != args["modelCode"] {
                    return Err("任务编号已用于其他请求".into());
                }
                tx.commit().await.map_err(err)?;
                return Ok(old);
            }
            let book = text(plan, "bookId");
            if book.is_empty() {
                return Err("批量写作需要先绑定作品".into());
            }
            let steps = plan["steps"].as_array().ok_or("缺少每章目标")?;
            if steps.is_empty() || steps.len() > MAX_STEPS {
                return Err(format!("一次最多连写 {MAX_STEPS} 章，至少 1 章"));
            }
            if tasks(&mut tx).await?.iter().any(|t| t["bookId"] == plan["bookId"] && (live(t) || t["status"] == "paused")) {
                return Err("这本书已有批量写作任务，请先完成、取消或继续它".into());
            }
            let model = text(&args, "modelCode");
            if model.is_empty() {
                return Err("请选择文本模型".into());
            }
            let mut t = json!({
                "id": id, "plan": plan, "bookId": plan["bookId"], "bookTitle": plan["bookTitle"], "scope": plan["scope"], "styleSkill": plan["styleSkill"],
                "sessionId": args["sessionId"], "callId": args["callId"], "anchor": args["anchor"], "modelCode": model,
                "createdAt": stamp(), "updatedAt": stamp(), "status": "running", "waitingReason": Value::Null, "cursor": 0,
                "autoContinue": args["autoContinue"] != false, "continuedAt": Value::Null, "continueSkipped": Value::Null,
            });
            t["steps"] = json!(steps.iter().enumerate().map(|(i, s)| json!({"index":i,"goal":s["goal"],"status":"pending","draftId":Value::Null,"chapterId":Value::Null,"startedAt":Value::Null,"finishedAt":Value::Null})).collect::<Vec<_>>());
            put(&mut tx, &key(&id), &t).await?;
            t
        }
        "get" | "pause" | "resume" | "cancel" | "fail" | "step" | "continue_state" => {
            let id = text(&args, "id");
            let mut t = read(&mut tx, &key(&id)).await?;
            if op == "get" {
                t
            } else {
                match op.as_str() {
                    "pause" => {
                        if !live(&t) {
                            return Err("任务不在进行中".into());
                        }
                        t["status"] = json!("paused");
                        t["waitingReason"] = Value::Null;
                    }
                    "resume" => {
                        if !matches!(t["status"].as_str(), Some("paused") | Some("failed")) {
                            return Err("任务不在可继续的状态".into());
                        }
                        t["error"] = Value::Null;
                        let cursor = t["cursor"].as_u64().unwrap_or(0) as usize;
                        let waiting_review = step_mut(&mut t, cursor).map(|s| s["status"] == "review").unwrap_or(false);
                        t["status"] = json!(if waiting_review { "waiting" } else { "running" });
                        t["waitingReason"] = if waiting_review { json!("review") } else { Value::Null };
                    }
                    "cancel" => {
                        if matches!(t["status"].as_str(), Some("completed") | Some("cancelled")) {
                            return Err("任务已经结束".into());
                        }
                        t["status"] = json!("cancelled");
                        t["waitingReason"] = Value::Null;
                        for step in t["steps"].as_array_mut().unwrap() {
                            if step["status"] != "done" {
                                step["status"] = json!("skipped");
                            }
                        }
                    }
                    "fail" => {
                        t["status"] = json!("failed");
                        t["error"] = json!(text(&args, "error"));
                        t["waitingReason"] = Value::Null;
                    }
                    // 一步的推进：writing（这一轮发出去了）/ review（有候选了，等采用）/ done（采用了，记章节）/ waiting 原因
                    "step" => {
                        if !live(&t) {
                            // 迟到的等待通知不能逆转作者的暂停/结束；真正的进度推进仍拒绝。
                            if matches!(args["change"].as_str(), Some("chat_busy" | "no_draft")) {
                                tx.commit().await.map_err(err)?;
                                return Ok(t);
                            }
                            return Err("任务不在进行中".into());
                        }
                        let cursor = t["cursor"].as_u64().unwrap_or(0) as usize;
                        let index = args["index"].as_u64().map_or(cursor, |v| v as usize);
                        if index != cursor {
                            return Err("只能推进当前这一章".into());
                        }
                        let change = text(&args, "change");
                        let step = step_mut(&mut t, cursor)?;
                        match change.as_str() {
                            "writing" => {
                                step["status"] = json!("writing");
                                step["startedAt"] = json!(stamp());
                                t["status"] = json!("running");
                                t["waitingReason"] = Value::Null;
                            }
                            "review" => {
                                step["status"] = json!("review");
                                step["draftId"] = args["draftId"].clone();
                                t["status"] = json!("waiting");
                                t["waitingReason"] = json!("review");
                            }
                            "done" => {
                                step["status"] = json!("done");
                                step["chapterId"] = args["chapterId"].clone();
                                step["finishedAt"] = json!(stamp());
                                if args.get("draftId").is_some() {
                                    step["draftId"] = args["draftId"].clone();
                                }
                                let next = cursor + 1;
                                let total = t["steps"].as_array().map_or(0, Vec::len);
                                if all_done(&t) || next >= total {
                                    t["cursor"] = json!(total.saturating_sub(1));
                                    t["status"] = json!("completed");
                                    t["waitingReason"] = Value::Null;
                                } else {
                                    t["cursor"] = json!(next);
                                    t["status"] = json!("running");
                                    t["waitingReason"] = Value::Null;
                                }
                            }
                            "skip" => {
                                step["status"] = json!("skipped");
                                step["finishedAt"] = json!(stamp());
                                let next = cursor + 1;
                                let total = t["steps"].as_array().map_or(0, Vec::len);
                                if next >= total {
                                    t["cursor"] = json!(total.saturating_sub(1));
                                    t["status"] = json!("completed");
                                } else {
                                    t["cursor"] = json!(next);
                                    t["status"] = json!("running");
                                }
                                t["waitingReason"] = Value::Null;
                            }
                            "chat_busy" | "no_draft" => {
                                if step["status"] == "writing" {
                                    step["status"] = json!("pending");
                                }
                                t["status"] = json!("waiting");
                                t["waitingReason"] = json!(change);
                            }
                            _ => return Err("未知的步骤变化".into()),
                        }
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
        _ => return Err("未知批量操作".into()),
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
        let e = Env(std::env::temp_dir().join(format!("pi-batch-{}", uuid::Uuid::new_v4())));
        crate::desktop_storage::connect_at(&e.0).await.unwrap();
        e
    }
    async fn call(e: &Env, op: &str, mut args: Value) -> Result<Value, String> {
        args["op"] = json!(op);
        dispatch(&e.0, args).await
    }
    fn plan(n: usize) -> Value {
        json!({"bookId":"-5","bookTitle":"我的书","scope":format!("接下来 {n} 章"),"steps":(0..n).map(|i| json!({"index":i,"goal":format!("第{}章目标",i+1)})).collect::<Vec<_>>()})
    }
    async fn start(e: &Env, n: usize) -> Value {
        call(e, "create", json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan(n),"modelCode":"m","sessionId":"s1"})).await.unwrap()
    }
    #[tokio::test]
    async fn steps_advance_only_through_review_and_adoption() {
        let e = fixture().await;
        let t = start(&e, 2).await;
        assert_eq!(t["status"], "running");
        assert_eq!(t["steps"][0]["status"], "pending");
        assert!(call(&e, "create", json!({"id":uuid::Uuid::new_v4().to_string(),"plan":plan(1),"modelCode":"m","sessionId":"s1"})).await.unwrap_err().contains("已有批量写作任务"));
        let id = t["id"].clone();
        let writing = call(&e, "step", json!({"id":id,"change":"writing"})).await.unwrap();
        assert_eq!(writing["steps"][0]["status"], "writing");
        let review = call(&e, "step", json!({"id":id,"change":"review","draftId":"s1:c1"})).await.unwrap();
        assert_eq!(review["status"], "waiting");
        assert_eq!(review["waitingReason"], "review");
        assert!(call(&e, "step", json!({"id":id,"index":1,"change":"writing"})).await.is_err(), "不能越过当前这一章");
        let done = call(&e, "step", json!({"id":id,"change":"done","chapterId":77})).await.unwrap();
        assert_eq!(done["steps"][0]["chapterId"], 77);
        assert_eq!(done["cursor"], 1);
        assert_eq!(done["status"], "running");
        call(&e, "step", json!({"id":id,"change":"writing"})).await.unwrap();
        let busy = call(&e, "step", json!({"id":id,"change":"chat_busy"})).await.unwrap();
        assert_eq!(busy["status"], "waiting");
        assert_eq!(busy["steps"][1]["status"], "pending");
        call(&e, "step", json!({"id":id,"change":"writing"})).await.unwrap();
        call(&e, "step", json!({"id":id,"change":"review","draftId":"s1:c2"})).await.unwrap();
        let finished = call(&e, "step", json!({"id":id,"change":"done","chapterId":78})).await.unwrap();
        assert_eq!(finished["status"], "completed");
        assert!(call(&e, "cancel", json!({"id":id})).await.is_err());
    }
    #[tokio::test]
    async fn pause_resume_cancel_and_recovery_keep_adopted_chapters() {
        let e = fixture().await;
        let t = start(&e, 3).await;
        let id = t["id"].clone();
        call(&e, "step", json!({"id":id,"change":"writing"})).await.unwrap();
        let paused = call(&e, "pause", json!({"id":id})).await.unwrap();
        assert_eq!(paused["status"], "paused");
        for change in ["chat_busy", "no_draft"] {
            let late = call(&e, "step", json!({"id":id,"change":change})).await.unwrap();
            assert_eq!(late["status"], "paused");
            assert_eq!(late["steps"], paused["steps"], "迟到通知不修改已暂停进度");
        }
        assert!(call(&e, "step", json!({"id":id,"change":"review","draftId":"x"})).await.is_err());
        let resumed = call(&e, "resume", json!({"id":id})).await.unwrap();
        assert_eq!(resumed["status"], "running");
        call(&e, "step", json!({"id":id,"change":"review","draftId":"s1:c1"})).await.unwrap();
        call(&e, "pause", json!({"id":id})).await.unwrap();
        let resumed = call(&e, "resume", json!({"id":id})).await.unwrap();
        assert_eq!(resumed["status"], "waiting");
        assert_eq!(resumed["waitingReason"], "review");
        call(&e, "step", json!({"id":id,"change":"done","chapterId":1})).await.unwrap();
        call(&e, "step", json!({"id":id,"change":"writing"})).await.unwrap();
        let recovered = call(&e, "recover", json!({})).await.unwrap();
        assert_eq!(recovered[0]["status"], "paused");
        assert_eq!(recovered[0]["steps"][1]["status"], "pending");
        assert_eq!(recovered[0]["steps"][0]["status"], "done");
        call(&e, "resume", json!({"id":id})).await.unwrap();
        let cancelled = call(&e, "cancel", json!({"id":id})).await.unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(cancelled["steps"][0]["status"], "done");
        assert_eq!(cancelled["steps"][2]["status"], "skipped");
        let fresh = start(&e, 1).await;
        assert_eq!(fresh["bookId"], "-5");
    }
}
