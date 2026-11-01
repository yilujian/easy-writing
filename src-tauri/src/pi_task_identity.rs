//! A transport retry can have a fresh request UUID. The session and tool call still identify
//! the same author confirmation. Look up both identities inside the task creation transaction.
use crate::writing_records::{err, get};
use serde_json::Value;
use sqlx::SqliteConnection;

pub async fn existing(
    db: &mut SqliteConnection,
    namespace: &str,
    args: &Value,
) -> Result<Option<Value>, String> {
    let id = args["id"].as_str().ok_or("缺少任务编号")?;
    uuid::Uuid::parse_str(id).map_err(|_| "任务编号无效")?;
    let by_id = get(db, namespace, &format!("task:{id}")).await?;
    let session = args["sessionId"].as_str().unwrap_or_default();
    let call = args["callId"].as_str().unwrap_or_default();
    if let Some(old) = by_id {
        if old["sessionId"] != args["sessionId"] || old["callId"] != args["callId"] {
            return Err("任务编号已用于其他请求".into());
        }
        return Ok(Some(old));
    }
    if session.is_empty() || call.is_empty() {
        return Ok(None);
    }
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"task:%' AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.callId')=? LIMIT 1")
        .bind(namespace).bind(session).bind(call).fetch_optional(db).await.map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
