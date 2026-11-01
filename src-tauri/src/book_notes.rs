//! 写作台的作者决定与偏好；正式作品事实由 story_state 管理。
use crate::writing_records::*;
use serde_json::{json, Value};
use sqlx::SqliteConnection;

pub const NS: &str = "ew-agent/records";

/// 当前写作台备忘的写入口：落记录并同步检索索引。所有改状态、改内容、归档、删除都走这里。
pub async fn store(db: &mut SqliteConnection, memory: &Value) -> Result<(), String> {
    put(
        db,
        NS,
        &format!("memory:{}", str_field(memory, "id")?),
        memory,
    )
    .await?;
    crate::story_index::sync_memory_index(db, memory).await
}

pub async fn save_manual(db: &mut SqliteConnection, args: &Value) -> Result<Value, String> {
    let content = str_field(args, "content")?.trim();
    let status = str_field(args, "status")?;
    if !["active", "pending", "rejected", "archived"].contains(&status) {
        return Err("请核对内容后选择有效、待定、否决或归档".into());
    }
    let scope = str_field(args, "scope")?;
    if !["book", "author"].contains(&scope) {
        return Err("记忆范围无效".into());
    }
    let bid = if scope == "book" {
        let bid = str_field(args, "bookId")?;
        book(db, bid).await?;
        bid
    } else {
        ""
    };
    let memory_id = args["id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(id);
    let key = format!("memory:{memory_id}");
    let old = get(db, NS, &key).await?;
    let limit = old
        .as_ref()
        .and_then(|m| m["contentLimit"].as_u64())
        .unwrap_or(1200)
        .clamp(1200, 4000) as usize;
    if content.is_empty() || content.chars().count() > limit {
        return Err(format!("记忆内容应为 1—{limit} 字"));
    }
    if let Some(old) = &old {
        if old["deletedAt"].is_number()
            || old["revision"].as_u64().unwrap_or(0) != args["revision"].as_u64().unwrap_or(0)
        {
            return Err("记忆已更新，请重新读取后修改".into());
        }
    }
    let category = args["category"].as_str().unwrap_or(if scope == "author" {
        "作者偏好"
    } else {
        "作者决定"
    });
    let m = json!({"id":memory_id,"bookId":bid,"content":content,"category":category,
        "kind":"decision","scope":scope,"status":status,"contentLimit":limit,"source":"作者手动确认","quote":args["quote"].as_str().unwrap_or(""),
        "channel":args["channel"].as_str().unwrap_or("desktop"),
        "observedAt":old.as_ref().and_then(|v|v["observedAt"].as_i64()).unwrap_or_else(now),
        "period":args["period"].as_str().unwrap_or("全书"),"revision":old.as_ref().map_or(0,|v|v["revision"].as_u64().unwrap_or(0)+1),
        "createdAt":old.as_ref().map_or(now(),|v|v["createdAt"].as_i64().unwrap_or(now())),"updatedAt":now()});
    store(db, &m).await?;
    Ok(m)
}
