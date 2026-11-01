//! 平台会话配置和正式保存状态。SQLite 是事实源，Pi 原生 JSONL 继续负责对话历史。
use serde_json::{json, Value};
use sqlx::{Connection, SqliteConnection};
use std::path::Path;

const NAMESPACE: &str = "ew-agent-pi/sessions";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub async fn read(db: &mut SqliteConnection, id: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NAMESPACE)
            .bind(json!(id).to_string())
            .fetch_optional(db)
            .await
            .map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
pub async fn write(db: &mut SqliteConnection, id: &str, value: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")
        .bind(NAMESPACE).bind(json!(id).to_string()).bind(value.to_string()).execute(db).await.map_err(err)?;
    Ok(())
}
pub async fn get(root: &Path, session: &Value, model: &str) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let id = session["id"].as_str().ok_or("会话编号缺失")?;
    let mut value = if let Some(value) = read(&mut db, id).await? {
        value
    } else {
        // 已有 Pi 对话也从真实采用记录恢复绑定，避免要求作者重复创建或丢弃当前历史。
        let adopted: Option<String> = sqlx::query_scalar("SELECT json_extract(value,'$.appliedBookId') FROM desktop_records WHERE namespace='ew-agent-pi/drafts' AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.entity')='book' AND json_extract(value,'$.appliedAt')>0 ORDER BY json_extract(value,'$.appliedAt') DESC LIMIT 1")
            .bind(id).fetch_optional(&mut db).await.map_err(err)?;
        json!({"bookId":adopted.as_deref().unwrap_or(session["book"]["id"].as_str().unwrap_or_default()),"modelCode":model,"revision":0})
    };
    if value["modelCode"].as_str().unwrap_or_default().is_empty() {
        value["modelCode"] = json!(model);
    }
    Ok(value)
}
/// 与作品、默认目录、候选状态及采用回执在同一事务中提交，重试不会重复绑定。
pub async fn adopted(db: &mut SqliteConnection, draft: &Value) -> Result<(), String> {
    if draft["kind"] != "entity" || draft["entity"] != "book" {
        return Ok(());
    }
    let id = draft["sessionId"].as_str().ok_or("候选会话编号缺失")?;
    let mut state = read(db, id).await?.unwrap_or_else(|| json!({"revision":0}));
    state["bookId"] = draft["appliedBookId"].clone();
    state["revision"] = json!(state["revision"].as_u64().unwrap_or(0) + 1);
    write(db, id, &state).await
}
/// 空会话在本实例内正式采用的新书，可以立即供后续工具使用。
/// 已绑定作品、仅修改配置、旧采用记录或其他会话的候选都不能改变当前轮次的归属。
pub async fn active_book(
    root: &Path,
    session_id: &str,
    initial: &Value,
    started_at: i64,
) -> Result<Value, String> {
    if !initial["id"].as_str().unwrap_or_default().is_empty() {
        return Ok(initial.clone());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let state = read(&mut db, session_id).await?.unwrap_or(Value::Null);
    let desired = state["bookId"].as_str().unwrap_or_default();
    if desired.is_empty() {
        return Ok(initial.clone());
    }
    let adopted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM desktop_records WHERE namespace='ew-agent-pi/drafts' AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.kind')='entity' AND json_extract(value,'$.entity')='book' AND json_extract(value,'$.appliedBookId')=? AND json_extract(value,'$.appliedAt')>=? AND json_extract(value,'$.appliedAt')>0")
        .bind(session_id).bind(desired).bind(started_at).fetch_one(&mut db).await.map_err(err)?;
    if adopted == 0 {
        return Ok(initial.clone());
    }
    super::read_book(root, desired).await
}
/// 每次模型调用前投影最新候选状态；不依赖前端通知、模型主动查询或未落盘的内存消息。
pub async fn snapshot(root: &Path, id: &str, active_book: &Value) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut transaction = db.begin().await.map_err(err)?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/drafts' AND json_extract(value,'$.sessionId')=? ORDER BY MAX(COALESCE(json_extract(value,'$.appliedAt'),0),COALESCE(json_extract(value,'$.dismissedAt'),0),COALESCE(json_extract(value,'$.createdAt'),0))")
        .bind(id).fetch_all(&mut *transaction).await.map_err(err)?;
    let drafts: Vec<Value> = rows.into_iter().map(|s| -> Result<Value,String> {
        let d: Value = serde_json::from_str(&s).map_err(err)?;
        Ok(json!({"draftId":d["id"],"kind":d["kind"],"entity":d["entity"],"title":d["title"],
            "status":if d["appliedAt"].as_i64().unwrap_or(0)>0 {"saved"} else if d["dismissedAt"].as_i64().unwrap_or(0)>0 {"dismissed"} else {"pending_author_confirmation"},
            "bookId":d.get("appliedBookId").filter(|v| v.as_str().is_some_and(|id| !id.is_empty())).unwrap_or(&d["bookId"]),"entityId":d["appliedEntityId"],
            "chapterId":d["chapterId"],"createdAt":d["createdAt"],"appliedAt":d["appliedAt"],"dismissedAt":d["dismissedAt"],"revision":d["revision"]}))
    }).collect::<Result<_,_>>()?;
    let task_rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-local-breakdown/kv' AND key LIKE '\"task:%' AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 20")
        .bind(id).fetch_all(&mut *transaction).await.map_err(err)?;
    let mut breakdown_tasks: Vec<Value> = task_rows.into_iter().map(|s| -> Result<Value,String> {
        let t: Value=serde_json::from_str(&s).map_err(err)?;
        Ok(json!({"kind":"breakdown","taskId":t["id"],"projectId":t["projectId"],"title":t["title"],"scope":t["scope"],"status":t["status"],"phase":t["phase"],"error":t["error"]}))
    }).collect::<Result<_,_>>()?;
    // 蒸馏任务和拆书一起给模型：同一个 tasks 列表，用 kind 区分
    let distill_rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/distillation' AND key LIKE '\"task:%' AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 20")
        .bind(id).fetch_all(&mut *transaction).await.map_err(err)?;
    for raw in distill_rows {
        let t: Value = serde_json::from_str(&raw).map_err(err)?;
        breakdown_tasks.push(json!({"kind":"distillation","taskId":t["id"],"projectId":t["projectId"],"title":t["title"],"scope":t["scope"],"status":t["status"],"phase":t["phase"],"error":t["error"],"skillName":t["skillName"],"skillId":t["skillId"]}));
    }
    let cover_rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/cover' AND key LIKE '\"task:%' AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 10")
        .bind(id).fetch_all(&mut *transaction).await.map_err(err)?;
    for raw in cover_rows {
        let t: Value = serde_json::from_str(&raw).map_err(err)?;
        breakdown_tasks.push(json!({"kind":"cover","taskId":t["id"],"bookId":t["bookId"],"title":t["bookTitle"],"scope":"封面","status":t["status"],"summary":t["summary"],"appliedAt":t["appliedAt"],"error":t["error"]}));
    }
    // 批量写作：模型要知道当前写到第几章、这章的目标和候选，"这章重写"才落得到实处
    let batch_rows: Vec<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/batch' AND key LIKE '\"task:%' AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 10")
        .bind(id).fetch_all(&mut *transaction).await.map_err(err)?;
    for raw in batch_rows {
        let t: Value = serde_json::from_str(&raw).map_err(err)?;
        let cursor = t["cursor"].as_u64().unwrap_or(0) as usize;
        let step = t["steps"]
            .as_array()
            .and_then(|s| s.get(cursor))
            .cloned()
            .unwrap_or(Value::Null);
        breakdown_tasks.push(json!({"kind":"batch","taskId":t["id"],"bookId":t["bookId"],"title":t["bookTitle"],"scope":t["scope"],"status":t["status"],"waitingReason":t["waitingReason"],
            "total":t["steps"].as_array().map_or(0,Vec::len),"currentStep":if step.is_null(){Value::Null}else{json!({"no":cursor+1,"goal":step["goal"],"status":step["status"],"draftId":step["draftId"]})},"error":t["error"]}));
    }
    // 入库中和失败的附件也进快照：模型要知道书名、章数和状态，才能先问范围或说明失败原因。
    let attachment_rows:Vec<String>=sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-local-breakdown/kv' AND key LIKE '\"attachment:%' AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 100").bind(id).fetch_all(&mut *transaction).await.map_err(err)?;
    let attachments:Vec<Value>=attachment_rows.into_iter().map(|s| ->Result<Value,String>{let a:Value=serde_json::from_str(&s).map_err(err)?;Ok(json!({"attachmentId":a["id"],"filename":a["filename"],"status":a["status"],"error":a["error"],"projectId":a["projectId"],"title":a["title"],"chapterCount":a["chapterCount"],"headingStyle":a["headingStyle"],"notes":a["notes"]}))}).collect::<Result<_,_>>()?;
    let desired = read(&mut transaction, id).await?;
    let all_memories = super::memory::list(
        &mut transaction,
        active_book["id"].as_str().unwrap_or_default(),
    )
    .await?;
    let mut memory_chars = 0;
    let memories: Vec<&Value> = all_memories
        .iter()
        .filter(|m| {
            let size = m["content"].as_str().unwrap_or_default().chars().count();
            if memory_chars + size > 12000 {
                false
            } else {
                memory_chars += size;
                true
            }
        })
        .collect();
    let memory_omitted = all_memories.len() - memories.len();
    let run_control = super::run_control::read(&mut transaction, id).await?;
    let book_payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL",
    )
    .bind(active_book["id"].as_str().unwrap_or_default())
    .fetch_optional(&mut *transaction)
    .await
    .map_err(err)?;
    let book_positioning = book_payload.map(|raw| -> Result<Value,String> {
        let book: Value = serde_json::from_str(&raw).map_err(err)?;
        Ok(json!({"platform":book["platform"],"audience":book["audience"],"category":book["category"]}))
    }).transpose()?;
    let last_volume:Option<(String,String)>=sqlx::query_as("SELECT CAST(id AS TEXT),json_extract(payload,'$.title') FROM local_volumes WHERE bookId=? AND deletedAt IS NULL ORDER BY sortNo DESC,id DESC LIMIT 1")
        .bind(active_book["id"].as_str().unwrap_or("")).fetch_optional(&mut *transaction).await.map_err(err)?;
    let append_volume = last_volume.map(|(id, title)| json!({"volumeId":id,"title":title}));
    transaction.commit().await.map_err(err)?;
    Ok(
        json!({"runControl":run_control,"appendVolume":append_volume,"bookPositioning":book_positioning,"activeBook":active_book,"nextBookId":desired.as_ref().map(|v| &v["bookId"]),"drafts":drafts,"tasks":breakdown_tasks,"attachments":attachments,"memories":memories,"memoryOmitted":memory_omitted}),
    )
}

/// A small projection for every model request. Detailed state remains available
/// through an explicit read; no stored record is changed or silently reclassified.
pub fn prompt_summary(state: &Value) -> Value {
    let drafts = state["drafts"].as_array().cloned().unwrap_or_default();
    let tasks = state["tasks"].as_array().cloned().unwrap_or_default();
    let attachments = state["attachments"].as_array().cloned().unwrap_or_default();
    let memories = state["memories"].as_array().cloned().unwrap_or_default();
    let count = |status: &str| drafts.iter().filter(|d| d["status"] == status).count();
    let recent = drafts.iter().rev().take(5).cloned().collect::<Vec<_>>();
    let active = tasks
        .iter()
        .filter(|t| !matches!(t["status"].as_str(), Some("completed" | "cancelled")))
        .take(5)
        .cloned()
        .collect::<Vec<_>>();
    let preferences = memories
        .iter()
        .filter(|m| m["scope"] == "author")
        .take(3)
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "runControl":{"state":state["runControl"]["state"],"revision":state["runControl"]["revision"],"pendingInput":state["runControl"]["pendingInput"],"rankings":state["runControl"]["rankings"]},"activeBook":state["activeBook"], "nextBookId":state["nextBookId"],
        "bookPositioning":state["bookPositioning"],"appendVolume":state["appendVolume"],"drafts":recent,
        "draftCounts":{"pending_author_confirmation":count("pending_author_confirmation"),"saved":count("saved"),"dismissed":count("dismissed")},
        "tasks":active,"taskCount":tasks.len(),
        "attachments":attachments.iter().take(5).collect::<Vec<_>>(),"attachmentCount":attachments.len(),
        "memories":preferences,"memoryCount":memories.len()+state["memoryOmitted"].as_u64().unwrap_or(0) as usize,
        "detailsTool":"read_book(view=state)"
    })
}
