//! 投递队列（全平台方案 5.10）：任何要送到作者面前的东西——自动任务结果、心跳告警、事件汇报、
//! 前端转来的通知——先持久化成投递记录，再交给通道发送；发不出去留在队列里按通道重试，每条带来源。
//! 通道只负责"把一条记录渲染并发出去"：微信走宿主的主动推送（借最近一条入站消息的会话令牌），
//! 桌面发 `agent-notice` 事件由界面显示并回执。原来前端 `notify.ts` 的补发队列迁到这里。
use crate::writing_records::*;
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::sync::Mutex;

pub const NS: &str = "ew-agent-automation/records";
const PREFIX: &str = "delivery:";
pub const WEIXIN: &str = "weixin";
pub const DESKTOP: &str = "desktop";
pub const NONE: &str = "none";
/// 超过这个时长还没送出去的记录丢弃：三天前的"写完了"再送到只会打扰
const TTL_MS: i64 = 3 * 24 * 60 * 60 * 1000;
/// 同一事件键短时间内只送一次（任务恢复后再次停在同一章）
const DEDUPE_MS: i64 = 10 * 60 * 1000;
/// 已送出的记录保留给运行记录页看，超过这个数量清最旧的
const KEEP_SENT: usize = 200;
const WEIXIN_LOG_NS: &str = "ew-weixin-log/entries";

pub fn channel_valid(channel: &str) -> bool {
    matches!(channel, WEIXIN | DESKTOP | NONE)
}

/// 进队列。同键的待发记录只留最新一条；同键十分钟内已送出的不再送。返回记录；没什么可送时返回 None。
pub async fn enqueue(
    db: &mut SqliteConnection,
    channel: &str,
    text: &str,
    key: &str,
    source: Value,
) -> Result<Option<Value>, String> {
    let text = text.trim();
    if text.is_empty() || channel == NONE {
        return Ok(None);
    }
    if !channel_valid(channel) {
        return Err(format!("未知的投递通道：{channel}"));
    }
    let now = now();
    let existing = list(db, NS, PREFIX).await?;
    if !key.is_empty() {
        for record in &existing {
            if record["key"] != key || record["channel"] != channel {
                continue;
            }
            if record["status"] == "sent"
                && now - record["sentAt"].as_i64().unwrap_or(0) < DEDUPE_MS
            {
                return Ok(None);
            }
            if record["status"] == "pending" {
                let mut updated = record.clone();
                updated["text"] = json!(text);
                updated["source"] = source;
                updated["createdAt"] = json!(now);
                put(
                    db,
                    NS,
                    &format!("{PREFIX}{}", str_field(record, "id")?),
                    &updated,
                )
                .await?;
                return Ok(Some(updated));
            }
        }
    }
    let record = json!({"id":id(),"channel":channel,"text":text,"key":key,"source":source,
        "createdAt":now,"attempts":0,"status":"pending","lastError":"","sentAt":Value::Null});
    put(
        db,
        NS,
        &format!("{PREFIX}{}", str_field(&record, "id")?),
        &record,
    )
    .await?;
    prune(db, existing, now).await?;
    Ok(Some(record))
}

/// 清掉过期未送出与过多的已送出记录
async fn prune(db: &mut SqliteConnection, mut records: Vec<Value>, now: i64) -> Result<(), String> {
    records.sort_by_key(|r| r["createdAt"].as_i64().unwrap_or(0));
    let mut sent = records.iter().filter(|r| r["status"] == "sent").count();
    for record in &records {
        let stale = record["status"] == "pending"
            && now - record["createdAt"].as_i64().unwrap_or(0) > TTL_MS;
        let surplus = record["status"] == "sent" && sent > KEEP_SENT;
        if stale || surplus {
            delete_by_prefix(db, NS, &format!("{PREFIX}{}", str_field(record, "id")?)).await?;
            if surplus {
                sent -= 1;
            }
        }
    }
    Ok(())
}

/// 待发记录（按进队顺序）；`channel` 为空取全部
pub async fn pending(db: &mut SqliteConnection, channel: &str) -> Result<Vec<Value>, String> {
    let now = now();
    let mut out: Vec<Value> = list(db, NS, PREFIX)
        .await?
        .into_iter()
        .filter(|r| r["status"] == "pending" && (channel.is_empty() || r["channel"] == channel))
        .filter(|r| now - r["createdAt"].as_i64().unwrap_or(0) <= TTL_MS)
        .collect();
    out.sort_by_key(|r| r["createdAt"].as_i64().unwrap_or(0));
    Ok(out)
}

/// 发送结果记回记录：成功标 sent，失败留在队列里并记原因与次数
pub async fn mark(
    db: &mut SqliteConnection,
    record_id: &str,
    outcome: Result<(), String>,
) -> Result<Value, String> {
    let key = format!("{PREFIX}{record_id}");
    let mut record = get(db, NS, &key).await?.ok_or("投递记录不存在")?;
    record["attempts"] = json!(record["attempts"].as_i64().unwrap_or(0) + 1);
    match outcome {
        Ok(()) => {
            record["status"] = json!("sent");
            record["sentAt"] = json!(now());
            record["lastError"] = json!("");
        }
        Err(error) => {
            record["lastError"] = json!(error);
        }
    }
    put(db, NS, &key, &record).await?;
    Ok(record)
}

/// 通道看到的文本：补发的微信通知带前缀，作者知道这是晚到的
pub fn render(record: &Value) -> String {
    let text = record["text"].as_str().unwrap_or("").to_owned();
    if record["channel"] == WEIXIN && record["attempts"].as_i64().unwrap_or(0) > 0 {
        format!("【补发通知】{text}")
    } else {
        text
    }
}

/// 推送也进微信"对话记录"账本：作者在设置页能看到推了什么、为什么没收到。键与前端 createLocalEntityId 同一格式。
pub async fn log_weixin_push(
    db: &mut SqliteConnection,
    text: &str,
    outcome: &Result<(), String>,
) -> Result<(), String> {
    let id = -(now() * 1000 + 1);
    let mut entry = json!({"id":id,"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "direction":"out","kind":"push","text":text,"route":"push","ok":outcome.is_ok()});
    if let Err(error) = outcome {
        entry["error"] = json!(error);
        entry["note"] = json!("留在投递队列，微信可用时补发");
    }
    put(db, WEIXIN_LOG_NS, &id.to_string(), &entry).await
}

fn flush_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 把待发记录按通道发出去；返回送出的条数。同一时刻只有一个 flush 在跑，避免同一条发两次。
/// 微信：没有会话令牌（作者还没发过消息）或发送失败，记录留在队列；桌面：发事件给界面，界面显示后回执。
pub fn flush(app: &crate::DesktopAppHandle, channel: &str) -> Result<usize, String> {
    let Ok(_guard) = flush_lock().try_lock() else {
        return Ok(0);
    };
    let root = crate::desktop_storage::root(app)?;
    crate::blocking::run(async {
        let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
        let mut sent = 0usize;
        for record in pending(&mut db, channel).await? {
            let rid = str_field(&record, "id")?.to_owned();
            if record["channel"] == WEIXIN {
                if !crate::weixin_bot::push_available(app) {
                    break;
                }
                let text = render(&record);
                let outcome = crate::weixin_bot::push_text(app, &text).await.map(|_| ());
                log_weixin_push(&mut db, &text, &outcome).await?;
                let ok = outcome.is_ok();
                mark(&mut db, &rid, outcome).await?;
                if !ok {
                    // 令牌失效、断网：后面的也发不出去，留待下次
                    break;
                }
                sent += 1;
            } else if record["channel"] == DESKTOP {
                // 界面收到后显示并 delivery_ack；没有界面时事件无人接收，记录留在队列
                crate::writing_events::emit(app, "agent-notice", &record);
            }
        }
        Ok(sent)
    })
}

/// 在后台线程里 flush：微信收到新消息（拿到新令牌）、任务刚投递时调用，不阻塞调用方
pub fn flush_soon(app: &crate::DesktopAppHandle, channel: &'static str) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = flush(&app, channel) {
            eprintln!("[delivery] 投递失败：{error}");
        }
    });
}
