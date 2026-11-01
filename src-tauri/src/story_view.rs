//! 故事状态与本书备忘的统一视图：写作台、直接场景、微信工具都从这里读"书里现在什么情况"和"作者定的规矩"。
//!
//! 数据只有一份：派生数据在作品状态层（章节卡、线索、折叠状态），作者数据在作者区（规则、标记）
//! 与作品记忆（决定、偏好）。这里不再生成第二份事实，只把它们摊成界面与直接场景惯用的形状。

use crate::book_notes::NS;
use crate::story_state as canon;
use crate::writing_records::{get, list, now, str_field};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn iso(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn field_label(field: &str) -> &'static str {
    match field {
        "realm" => "境界",
        "location" => "位置",
        "item" => "物品",
        "relation" => "关系",
        "goal" => "目标",
        "alive" => "生死",
        _ => "状态",
    }
}

/// 目录顺序：记录按章分组时用它排序，"截至上一章"也按它过滤
async fn chapter_orders(
    db: &mut SqliteConnection,
    book_id: &str,
) -> Result<(Vec<Value>, BTreeMap<String, i64>), String> {
    let catalog = crate::reference_books::any_catalog(db, book_id).await?;
    let mut orders = BTreeMap::new();
    let chapters = catalog
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let id = c["id"].to_string().trim_matches('"').to_owned();
            orders.insert(id.clone(), i as i64 + 1);
            json!({"id":id,"order":i as i64 + 1,"title":c["title"]})
        })
        .collect();
    Ok((chapters, orders))
}

/// 故事状态视图：状态变化、关系、事件、事实、线索各一条记录，附作者标记；另给目录顺序与统计。
pub async fn story_view(db: &mut SqliteConnection, book_id: &str) -> Result<Value, String> {
    let marks = canon::load_marks(db, book_id).await?;
    let (chapters, orders) = chapter_orders(db, book_id).await?;
    let status_of = |key: &str| marks.get(key).cloned().unwrap_or_else(|| "auto".to_owned());
    let mut records = Vec::new();
    let cards = canon::list_cards(db, book_id).await?;
    let mut indexed = 0;
    for card in cards.iter().filter(|c| c["status"] == "active") {
        indexed += 1;
        let chapter_id = card["chapterId"].as_str().unwrap_or("").to_owned();
        let body = &card["card"];
        let order = body["narrativeOrder"]
            .as_i64()
            .filter(|n| *n > 0)
            .or_else(|| orders.get(&chapter_id).copied())
            .unwrap_or(0);
        for change in body["stateChanges"].as_array().into_iter().flatten() {
            let key = canon::state_change_key(&chapter_id, change);
            let field = change["field"].as_str().unwrap_or("");
            let subject = change["character"]["name"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let before = change["before"].as_str().unwrap_or("");
            let after = change["after"].as_str().unwrap_or("");
            records.push(json!({
                "id": key, "chapterId": chapter_id, "storyOrder": order,
                "kind": if field == "relation" { "relation" } else { "state" },
                "subject": subject, "predicate": field_label(field), "object": after,
                "text": if before.is_empty() { format!("{subject}{}：{after}", field_label(field)) } else { format!("{subject}{}：{before} → {after}", field_label(field)) },
                "quote": change["quote"], "confidence": change["confidence"].as_f64().unwrap_or(1.0),
                "status": status_of(&key),
            }));
        }
        for event in body["events"].as_array().into_iter().flatten() {
            let key = format!(
                "event:{chapter_id}:{}",
                event["eventId"].as_str().unwrap_or("")
            );
            let subject = event["characters"]
                .as_array()
                .and_then(|c| c.first())
                .and_then(|c| c["name"].as_str())
                .unwrap_or("")
                .to_owned();
            records.push(json!({
                "id": key, "chapterId": chapter_id, "storyOrder": event["storyOrder"].as_i64().filter(|n| *n > 0).unwrap_or(order),
                "kind": "event", "subject": subject, "predicate": "事件", "object": event["summary"],
                "text": event["summary"], "quote": "", "confidence": 1.0, "status": status_of(&key),
            }));
        }
        for fact in body["facts"].as_array().into_iter().flatten() {
            let key = format!(
                "fact:{chapter_id}:{}",
                fact["factId"].as_str().unwrap_or("")
            );
            records.push(json!({
                "id": key, "chapterId": chapter_id, "storyOrder": order,
                "kind": "event", "subject": "", "predicate": "事实", "object": fact["text"],
                "text": fact["text"], "quote": fact["quote"], "confidence": 1.0, "status": status_of(&key),
            }));
        }
    }
    for thread in canon::list_threads(db, book_id, None).await? {
        let thread_id = thread["threadId"].as_str().unwrap_or("").to_owned();
        let key = format!("thread:{thread_id}");
        let paid = thread["status"] == "paid";
        let chapter_id = if paid {
            thread["paidChapter"].as_str()
        } else {
            thread["plantedChapter"].as_str()
        }
        .unwrap_or("")
        .to_owned();
        let mut status = status_of(&key);
        if thread["status"] == "dropped" && status == "auto" {
            status = "rejected".to_owned();
        }
        records.push(json!({
            "id": key, "chapterId": chapter_id, "storyOrder": orders.get(&chapter_id).copied().unwrap_or(0),
            "kind": if paid { "payoff" } else { "foreshadow" }, "subject": "", "predicate": "伏笔", "object": "",
            "text": if paid { format!("{}（已回收）", thread["title"].as_str().unwrap_or("")) } else { thread["title"].as_str().unwrap_or("").to_owned() },
            "quote": thread["plantedQuote"], "confidence": 1.0, "status": status, "threadId": thread_id,
        }));
    }
    let confirmed = records
        .iter()
        .filter(|r| r["status"] == "confirmed")
        .count();
    let rejected = records.iter().filter(|r| r["status"] == "rejected").count();
    let progress = canon::index_progress(db, book_id).await?;
    Ok(json!({
        "records": records,
        "chapters": chapters,
        "summary": {"facts": records.len(), "confirmed": confirmed, "rejected": rejected, "chaptersExtracted": indexed, "chaptersTotal": chapters.len()},
        "progress": progress,
    }))
}

/// 作者的确认 / 否决 / 恢复：状态变化否决后立即重折叠；线索否决即人工标为已放弃。
pub async fn mark(
    db: &mut SqliteConnection,
    book_id: &str,
    record_key: &str,
    mark: &str,
) -> Result<Value, String> {
    let record = canon::set_mark(db, book_id, record_key, mark).await?;
    if record_key.starts_with("state:") {
        canon::fold_states(db, book_id).await?;
    } else if let Some(thread_id) = record_key.strip_prefix("thread:") {
        if mark == "rejected" {
            canon::override_thread(db, book_id, thread_id, "dropped", "作者否决").await?;
        } else {
            // 只撤销我们自己打上的"作者否决"，作者在线索页另外设的状态不动
            let key = format!("thread-override:{book_id}:{thread_id}");
            if get(db, canon::AUTHOR_NS, &key)
                .await?
                .is_some_and(|o| o["note"] == "作者否决")
            {
                sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
                    .bind(canon::AUTHOR_NS)
                    .bind(json!(key).to_string())
                    .execute(&mut *db)
                    .await
                    .map_err(err)?;
            }
        }
    }
    Ok(record)
}

/// 本书备忘视图：作者规则 + 作品记忆里的决定与偏好，按原界面的三类给出。
pub async fn notes_view(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    let mut notes = Vec::new();
    for rule in canon::list_rules(db, Some(book_id)).await? {
        notes.push(
            json!({"id":rule["id"],"bookId":book_id,"kind":"rule","text":rule["text"],
            "source":rule["source"].as_str().unwrap_or("author"),"category":rule["category"],
            "createTime":iso(rule["createdAt"].as_i64().unwrap_or(0)),"scope":rule["scope"]}),
        );
    }
    for memory in list(db, NS, "memory:").await? {
        // 决定属于这本书；偏好在作者层，对每本书都生效
        let preference = memory["scope"] == "author" && memory["category"] == "作者偏好";
        if memory["deletedAt"].is_number()
            || memory["kind"] != "decision"
            || memory["status"] != "active"
            || !(preference || (memory["scope"] == "book" && memory["bookId"] == book_id))
        {
            continue;
        }
        let kind = if preference { "preference" } else { "decision" };
        notes.push(json!({"id":memory["id"],"bookId":book_id,"kind":kind,"text":memory["content"],
            "source":memory["source"].as_str().unwrap_or("author"),"category":memory["category"],
            "createTime":iso(memory["createdAt"].as_i64().unwrap_or(0)),"revision":memory["revision"]}));
    }
    // 同一毫秒建的按规则、决定、偏好排，和原来备忘的展示顺序一致
    let rank = |n: &Value| match n["kind"].as_str() {
        Some("rule") => 0,
        Some("decision") => 1,
        _ => 2,
    };
    notes.sort_by(|a, b| {
        a["createTime"]
            .as_str()
            .cmp(&b["createTime"].as_str())
            .then(rank(a).cmp(&rank(b)))
    });
    Ok(notes)
}

/// 正文检索：三字以上走 FTS，短词走 LIKE；命中按目录顺序给出，可限定"截至某章"。
pub async fn search_view(
    db: &mut SqliteConnection,
    book_id: &str,
    query: &str,
    limit: i64,
    until_chapter: Option<&str>,
) -> Result<Value, String> {
    let (chapters, orders) = chapter_orders(db, book_id).await?;
    let until = until_chapter.and_then(|c| orders.get(c).copied());
    let order_of = |hit: &Value| {
        hit["chapterId"]
            .as_str()
            .and_then(|c| orders.get(c).copied())
            .unwrap_or(i64::MAX)
    };
    let mut raw = crate::story_index::search_chunks(db, book_id, query, limit.clamp(1, 40)).await?;
    raw.retain(|hit| until.map_or(true, |u| order_of(hit) <= u));
    // 命中按目录顺序、段落顺序给出；不在目录里的章节排最后
    raw.sort_by_key(|hit| (order_of(hit), hit["seq"].as_i64().unwrap_or(0)));
    let hits: Vec<Value> = raw
        .into_iter()
        .map(|hit| json!({"chapterId":hit["chapterId"],"chunkId":hit["chunkId"],"seq":hit["seq"],"score":1.0,"snippet":hit["text"],"via":hit["via"]}))
        .collect();
    // 记忆也在同一次检索里：这本书的决定、摘要、候选，加上作者层偏好
    let memories =
        crate::story_index::search_memories(db, book_id, query, limit.clamp(1, 20)).await?;
    Ok(json!({"hits":hits,"memories":memories,"scannedChapters":chapters.len()}))
}

/// 备忘的增删：规则走作者规则，决定与偏好走作品记忆。
pub async fn add_note(db: &mut SqliteConnection, args: &Value) -> Result<Value, String> {
    let book_id = str_field(args, "bookId")?;
    let text = str_field(args, "text")?;
    let source = args["source"].as_str().unwrap_or("author");
    match args["kind"].as_str().unwrap_or("rule") {
        "rule" => canon::save_rule(db, "book", Some(book_id), args["category"].as_str().unwrap_or("结构"), text, source).await,
        "preference" => crate::book_notes::save_manual(db, &json!({"content":text,"status":"active","scope":"author","category":"作者偏好"})).await,
        _ => crate::book_notes::save_manual(db, &json!({"bookId":book_id,"content":text,"status":"active","scope":"book","category":"作者决定"})).await,
    }
}

pub async fn delete_note(db: &mut SqliteConnection, id: &str) -> Result<Value, String> {
    if id.starts_with("rule:") {
        canon::delete_rule(db, id).await?;
        return Ok(json!(true));
    }
    let key = format!("memory:{id}");
    let mut memory = get(db, NS, &key).await?.ok_or("记录不存在")?;
    memory["deletedAt"] = json!(now());
    memory["status"] = json!("archived");
    memory["revision"] = json!(memory["revision"].as_u64().unwrap_or(0) + 1);
    crate::book_notes::store(db, &memory).await?;
    Ok(json!(true))
}
