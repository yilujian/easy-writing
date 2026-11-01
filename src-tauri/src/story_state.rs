//! 作品状态层。作者维护的数据（`ew-agent-author`）与派生数据（`ew-agent-canon`）分开存放：
//! 章节卡、事实、人物状态、线索、疑点由索引器从正文提取，全部带来源指纹，来源变化即失效，可整体重建；
//! 作者规则、平台画像、线索的人工状态、疑点裁决、文风样本确认由作者维护，必须备份、恢复必须还原。
//!
//! 状态层是检索线索和疑点来源，不是裁判：折叠得出的矛盾一律作为疑点附原文交作者确认。
use crate::writing_records::{err, get, id, list, now, put, str_field};
use crate::writing_schema::{canonical_arguments, validate_document};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, BTreeSet};

pub const AUTHOR_NS: &str = "ew-agent-author/records";
pub const CANON_NS: &str = "ew-agent-canon/records";
/// 低于该置信度的状态变化不参与折叠，进入待核实。
pub const LOW_CONFIDENCE: f64 = 0.7;
pub const DEFAULT_PROFILE: &str = "general";

pub fn card_key(book_id: &str, chapter_id: &str) -> String {
    format!("card:{book_id}:{chapter_id}")
}
fn fact_key(book_id: &str, fact_id: &str) -> String {
    format!("fact:{book_id}:{fact_id}")
}
fn state_key(book_id: &str, character_id: &str) -> String {
    format!("state:{book_id}:{character_id}")
}
fn thread_key(book_id: &str, thread_id: &str) -> String {
    format!("thread:{book_id}:{thread_id}")
}
fn suspect_key(book_id: &str, issue_key: &str) -> String {
    format!("suspect:{book_id}:{issue_key}")
}
pub fn index_key(book_id: &str) -> String {
    format!("index:{book_id}")
}

fn card_source(book_id: &str, chapter_id: &str) -> Value {
    json!({"type":"chapter","bookId":book_id,"chapterId":chapter_id})
}

// ---------------------------------------------------------------------------
// 章节卡
// ---------------------------------------------------------------------------

/// 写入一章的章节卡。引文不在原文里的条目、低置信度的状态变化移入 `unresolved`，卡本身保持契约合法。
/// 来源指纹必须与当前正文一致，否则拒绝（索引器的复核协议已在领取层处理，这里是最后一道）。
pub async fn put_card(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    source_revision: &str,
    card: &Value,
) -> Result<Value, String> {
    let mut card = canonical_arguments(card);
    validate_document("chapterCard", &card)?;
    let source = card_source(book_id, chapter_id);
    let (current, text) = crate::book_materials::source_value(db, &source).await?;
    if current != source_revision {
        return Err("章节在提取期间已改变，本次章节卡未写入".into());
    }
    let mut unresolved = Vec::new();
    for field in [
        "stateChanges",
        "facts",
        "knowledge",
        "threads",
        "entityMentions",
    ] {
        let Some(items) = card[field].as_array().cloned() else {
            continue;
        };
        let mut kept = Vec::new();
        for item in items {
            let quote = item["quote"].as_str().unwrap_or("");
            if !text.contains(quote) {
                unresolved.push(json!({"field":field,"reason":"引文不在原文中","item":item}));
                continue;
            }
            if field == "stateChanges"
                && item["confidence"].as_f64().unwrap_or(0.0) < LOW_CONFIDENCE
            {
                unresolved.push(json!({"field":field,"reason":"置信度不足","item":item}));
                continue;
            }
            kept.push(item);
        }
        card[field] = json!(kept);
    }
    let history_revision = if crate::reference_books::project_of(book_id).is_none() {
        let h = crate::story_history::History::catalog(db, book_id).await?;
        h.chapters
            .into_iter()
            .find(|c| c.id == chapter_id)
            .map(|c| c.stamp)
    } else {
        None
    };
    let key = card_key(book_id, chapter_id);
    let old = get(db, CANON_NS, &key).await?;
    // 保留上一版章节卡，供“前文修改影响”比对；只保留一版，不做完整历史
    let previous = old
        .as_ref()
        .filter(|v| v["card"].is_object() && v["card"] != card)
        .map(|v| json!({"card":v["card"],"sourceRevision":v["sourceRevision"],"replacedAt":now()}))
        .or_else(|| old.as_ref().and_then(|v| v.get("previousCard").cloned()))
        .unwrap_or(Value::Null);
    let record = json!({"id":key,"bookId":book_id,"chapterId":chapter_id,"kind":"chapter_card","status":"active",
        "sourceRef":source,"sourceRevision":source_revision,"historyRevision":history_revision,"card":card,"unresolved":unresolved,"previousCard":previous,
        "revision":old.as_ref().map_or(0,|v|v["revision"].as_u64().unwrap_or(0)+1),
        "createdAt":old.as_ref().and_then(|v|v["createdAt"].as_i64()).unwrap_or_else(now),"updatedAt":now()});
    put(db, CANON_NS, &key, &record).await?;
    register_facts(db, book_id, chapter_id, &record["card"]).await?;
    apply_threads(db, book_id, chapter_id, &record["card"]).await?;
    index_entities(db, book_id, chapter_id, &record["card"]).await?;
    Ok(record)
}

pub async fn get_card(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
) -> Result<Option<Value>, String> {
    get(db, CANON_NS, &card_key(book_id, chapter_id)).await
}

/// 一本书的全部章节卡，按叙述顺序排列（含已失效的，调用方按 status 过滤）。
pub async fn list_cards(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    let mut cards = list(db, CANON_NS, &format!("card:{book_id}:")).await?;
    cards.sort_by_key(|c| {
        (
            c["card"]["narrativeOrder"].as_i64().unwrap_or(0),
            c["chapterId"].as_str().unwrap_or("").to_owned(),
        )
    });
    Ok(cards)
}

/// 核对来源：正文改变的卡置为 stale，章节已删除的置为 orphaned。返回刷新后的卡。
pub async fn refresh_cards(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    let mut cards = list_cards(db, book_id).await?;
    let positions = if crate::reference_books::project_of(book_id).is_none() {
        Some(
            crate::story_history::History::catalog(db, book_id)
                .await?
                .chapters
                .into_iter()
                .map(|c| (c.id, c.stamp))
                .collect::<std::collections::HashMap<_, _>>(),
        )
    } else {
        None
    };
    for card in &mut cards {
        if card["status"] != "active" {
            continue;
        }
        let next = match crate::book_materials::source_value(db, &card["sourceRef"]).await {
            Ok((revision, _))
                if revision == card["sourceRevision"]
                    && positions.as_ref().is_none_or(|p| {
                        card["chapterId"]
                            .as_str()
                            .and_then(|id| p.get(id))
                            .is_some_and(|stamp| card["historyRevision"] == *stamp)
                    }) =>
            {
                continue
            }
            Ok(_) => "stale",
            Err(_) => "orphaned",
        };
        card["status"] = json!(next);
        card["staleReason"] = json!(if next == "stale" {
            "正文已改变，等待重新提取"
        } else {
            "章节已删除"
        });
        card["updatedAt"] = json!(now());
        put(db, CANON_NS, str_field(card, "id")?, card).await?;
    }
    Ok(cards)
}

/// 删除一章的卡与它登记的事实、实体索引；线索保留（作者可能已手工维护）。
pub async fn remove_card(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
) -> Result<(), String> {
    let key = card_key(book_id, chapter_id);
    if let Some(mut card) = get(db, CANON_NS, &key).await? {
        card["status"] = json!("removed");
        card["deletedAt"] = json!(now());
        put(db, CANON_NS, &key, &card).await?;
    }
    for mut fact in list(db, CANON_NS, &format!("fact:{book_id}:")).await? {
        if fact["firstChapter"] == chapter_id {
            fact["status"] = json!("removed");
            put(db, CANON_NS, str_field(&fact, "id")?, &fact).await?;
        }
    }
    crate::story_index::drop_chapter_index(db, book_id, chapter_id).await
}

// ---------------------------------------------------------------------------
// 事实、线索、实体索引
// ---------------------------------------------------------------------------

async fn register_facts(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    card: &Value,
) -> Result<(), String> {
    for fact in card["facts"].as_array().into_iter().flatten() {
        let fact_id = str_field(fact, "factId")?;
        let key = fact_key(book_id, fact_id);
        let existing = get(db, CANON_NS, &key).await?;
        let first = existing
            .as_ref()
            .and_then(|v| v["firstChapter"].as_str())
            .unwrap_or(chapter_id)
            .to_owned();
        let record = json!({"id":key,"bookId":book_id,"factId":fact_id,"text":fact["text"],"quote":fact["quote"],
            "firstChapter":first,"lastChapter":chapter_id,"supersedes":fact["supersedes"],
            "supersededBy":existing.as_ref().map(|v|v["supersededBy"].clone()).unwrap_or(Value::Null),
            "status":"active","updatedAt":now()});
        put(db, CANON_NS, &key, &record).await?;
        if let Some(old_id) = fact["supersedes"].as_str() {
            let old_key = fact_key(book_id, old_id);
            if let Some(mut old) = get(db, CANON_NS, &old_key).await? {
                old["supersededBy"] = json!(fact_id);
                old["invalidFromChapter"] = json!(chapter_id);
                old["status"] = json!("superseded");
                put(db, CANON_NS, &old_key, &old).await?;
            }
        }
    }
    Ok(())
}

/// 有效事实：未被替代、未删除。
pub async fn list_facts(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    Ok(list(db, CANON_NS, &format!("fact:{book_id}:"))
        .await?
        .into_iter()
        .filter(|f| f["status"] == "active")
        .collect())
}

async fn apply_threads(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    card: &Value,
) -> Result<(), String> {
    for touch in card["threads"].as_array().into_iter().flatten() {
        let action = touch["action"].as_str().unwrap_or("");
        if action == "plant" {
            // 同章同标题的线索重复提取时复用，重建章节卡不产生重复线索。
            let existing = list(db, CANON_NS, &format!("thread:{book_id}:"))
                .await?
                .into_iter()
                .find(|t| t["plantedChapter"] == chapter_id && t["title"] == touch["text"]);
            let thread_id = touch["threadId"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    existing
                        .as_ref()
                        .and_then(|t| t["threadId"].as_str().map(str::to_owned))
                })
                .unwrap_or_else(id);
            let key = thread_key(book_id, &thread_id);
            let record = json!({"id":key,"bookId":book_id,"threadId":thread_id,"kind":touch["kind"],"title":touch["text"],
                "plantedChapter":chapter_id,"plantedQuote":touch["quote"],
                "advances":existing.as_ref().map(|t|t["advances"].clone()).unwrap_or(json!([])),
                "status":existing.as_ref().and_then(|t|t["status"].as_str()).unwrap_or("open"),
                "paidChapter":existing.as_ref().map(|t|t["paidChapter"].clone()).unwrap_or(Value::Null),
                "createdAt":existing.as_ref().and_then(|t|t["createdAt"].as_i64()).unwrap_or_else(now),"updatedAt":now()});
            put(db, CANON_NS, &key, &record).await?;
            continue;
        }
        let Some(thread_id) = touch["threadId"].as_str() else {
            continue; // 契约允许省略，但推进与回收必须引用已有线索；宿主在写卡时已放入 unresolved
        };
        let key = thread_key(book_id, thread_id);
        let Some(mut thread) = get(db, CANON_NS, &key).await? else {
            continue;
        };
        let advances = thread["advances"].as_array_mut().ok_or("线索格式错误")?;
        if !advances
            .iter()
            .any(|a| a["chapterId"] == chapter_id && a["quote"] == touch["quote"])
        {
            advances.push(json!({"chapterId":chapter_id,"action":action,"text":touch["text"],"quote":touch["quote"]}));
        }
        if action == "payoff" {
            thread["status"] = json!("paid");
            thread["paidChapter"] = json!(chapter_id);
        }
        thread["updatedAt"] = json!(now());
        put(db, CANON_NS, &key, &thread).await?;
    }
    Ok(())
}

/// 线索账本；作者的人工状态（`thread-override`）在读取时覆盖派生值。
pub async fn list_threads(
    db: &mut SqliteConnection,
    book_id: &str,
    status: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut threads = Vec::new();
    for mut thread in list(db, CANON_NS, &format!("thread:{book_id}:")).await? {
        let override_key = format!(
            "thread-override:{book_id}:{}",
            str_field(&thread, "threadId")?
        );
        if let Some(o) = get(db, AUTHOR_NS, &override_key).await? {
            thread["status"] = o["status"].clone();
            thread["note"] = o["note"].clone();
            thread["overridden"] = json!(true);
        }
        if status.map_or(true, |s| thread["status"] == s) {
            threads.push(thread);
        }
    }
    Ok(threads)
}

pub async fn override_thread(
    db: &mut SqliteConnection,
    book_id: &str,
    thread_id: &str,
    status: &str,
    note: &str,
) -> Result<Value, String> {
    if !["open", "paid", "dropped"].contains(&status) {
        return Err("线索状态只能是 open、paid 或 dropped".into());
    }
    if get(db, CANON_NS, &thread_key(book_id, thread_id))
        .await?
        .is_none()
    {
        return Err("线索不存在".into());
    }
    let key = format!("thread-override:{book_id}:{thread_id}");
    let anchor = crate::story_history::History::catalog(db, book_id)
        .await?
        .chapters
        .into_iter()
        .rev()
        .find(|c| c.words > 0)
        .map(|c| c.id);
    let record = json!({"id":key,"bookId":book_id,"threadId":thread_id,"status":status,"note":note,"afterChapterId":anchor,"updatedAt":now()});
    put(db, AUTHOR_NS, &key, &record).await?;
    Ok(record)
}

async fn index_entities(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    card: &Value,
) -> Result<(), String> {
    let mut entries = Vec::new();
    // 参考书没有人物表，模型只写名字不写编号：人物按名字入索引，拆书的人名单与后续章节的人物表都从这里来
    let reference = crate::reference_books::project_of(book_id).is_some();
    let mut push = |entity: &Value, story_order: Option<i64>| {
        let name = entity["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty());
        let entity_id = entity["id"]
            .as_str()
            .or(if reference && entity["kind"] == "character" {
                name
            } else {
                None
            });
        if let (Some(kind), Some(entity_id), Some(name)) =
            (entity["kind"].as_str(), entity_id, name)
        {
            entries.push(json!({"entityType":kind,"entityId":entity_id,"name":name,"storyOrder":story_order}));
        }
    };
    for event in card["events"].as_array().into_iter().flatten() {
        let order = event["storyOrder"].as_i64();
        for character in event["characters"].as_array().into_iter().flatten() {
            push(character, order);
        }
        if event["location"].is_object() {
            push(&event["location"], order);
        }
    }
    for change in card["stateChanges"].as_array().into_iter().flatten() {
        push(&change["character"], change["storyOrder"].as_i64());
    }
    for mention in card["entityMentions"].as_array().into_iter().flatten() {
        let (Some(name), Some(kind), Some(quote)) = (
            mention["name"].as_str(),
            mention["kind"].as_str(),
            mention["quote"].as_str(),
        ) else {
            continue;
        };
        if !quote.contains(name) {
            continue;
        }
        for alias in std::iter::once(name)
            .chain(
                mention["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            )
            .filter(|n| quote.contains(n))
        {
            entries.push(json!({"entityType":kind,"entityId":name,"name":alias,"storyOrder":card["narrativeOrder"]}));
        }
    }
    crate::story_index::replace_entities(db, book_id, chapter_id, &entries).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 人物状态折叠与疑点
// ---------------------------------------------------------------------------

fn card_story_order(card: &Value) -> i64 {
    card["card"]["storyTime"]["order"]
        .as_i64()
        .unwrap_or_else(|| card["card"]["narrativeOrder"].as_i64().unwrap_or(0))
}

#[derive(Default)]
struct CharacterFold {
    name: String,
    history: Vec<Value>,
    appearances: Vec<Value>,
    knows: Vec<Value>,
}

/// 按故事顺序折叠所有有效章节卡的状态变化。伪装/误导事件里的变化不折叠；倒叙事件按其实际故事顺序折叠。
/// 折叠产生的矛盾写成疑点（附两处原文），已被作者裁决过的同一疑点不再生成。
/// 作者对派生记录的确认 / 否决：作者数据，必备份；键是记录在状态层里的稳定标识。
pub fn mark_key(book_id: &str, record_key: &str) -> String {
    format!("mark:{book_id}:{record_key}")
}

/// 状态变化的稳定标识：同章同人同字段同故事顺序；章节卡重建后仍能对上。
pub fn state_change_key(chapter_id: &str, change: &Value) -> String {
    format!(
        "state:{chapter_id}:{}:{}:{}",
        change["character"]["id"].as_str().unwrap_or(""),
        change["field"].as_str().unwrap_or(""),
        change["storyOrder"].as_i64().unwrap_or(0)
    )
}

pub async fn load_marks(
    db: &mut SqliteConnection,
    book_id: &str,
) -> Result<BTreeMap<String, String>, String> {
    let prefix = format!("mark:{book_id}:");
    Ok(list(db, AUTHOR_NS, &prefix)
        .await?
        .into_iter()
        .filter_map(|m| {
            Some((
                m["recordKey"].as_str()?.to_owned(),
                m["mark"].as_str()?.to_owned(),
            ))
        })
        .collect())
}

/// confirmed / rejected 写入作者区；auto 即清除标记
pub async fn set_mark(
    db: &mut SqliteConnection,
    book_id: &str,
    record_key: &str,
    mark: &str,
) -> Result<Value, String> {
    if !["confirmed", "rejected", "auto"].contains(&mark) {
        return Err("标记只能是确认、否决或恢复".into());
    }
    let key = mark_key(book_id, record_key);
    if mark == "auto" {
        sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
            .bind(AUTHOR_NS)
            .bind(json!(key).to_string())
            .execute(&mut *db)
            .await
            .map_err(err)?;
        return Ok(json!({"recordKey":record_key,"mark":"auto"}));
    }
    let record =
        json!({"id":key,"bookId":book_id,"recordKey":record_key,"mark":mark,"createdAt":now()});
    put(db, AUTHOR_NS, &key, &record).await?;
    Ok(record)
}

pub async fn fold_states(db: &mut SqliteConnection, book_id: &str) -> Result<Value, String> {
    let marks = load_marks(db, book_id).await?;
    let cards = list_cards(db, book_id)
        .await?
        .into_iter()
        .filter(|c| c["status"] == "active")
        .collect::<Vec<_>>();
    let mut misdirection = BTreeSet::new();
    let mut flashback = BTreeSet::new();
    for card in &cards {
        for event in card["card"]["events"].as_array().into_iter().flatten() {
            if event["isMisdirection"] == true {
                misdirection.insert(event["eventId"].as_str().unwrap_or("").to_owned());
            }
            if event["isFlashback"] == true {
                flashback.insert(event["eventId"].as_str().unwrap_or("").to_owned());
            }
        }
    }
    // (storyOrder, narrativeOrder, 序号) 决定折叠顺序
    let mut entries: Vec<(i64, i64, usize, Value, String)> = Vec::new();
    let mut appearances: Vec<(i64, i64, String, String, bool)> = Vec::new(); // order, narrative, characterId, chapterId, flashback
    let mut knowledge: Vec<(String, Value)> = Vec::new();
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    let mut pending_names: BTreeSet<String> = BTreeSet::new();
    for card in &cards {
        let chapter_id = card["chapterId"].as_str().unwrap_or("").to_owned();
        let narrative = card["card"]["narrativeOrder"].as_i64().unwrap_or(0);
        for event in card["card"]["events"].as_array().into_iter().flatten() {
            let event_id = event["eventId"].as_str().unwrap_or("");
            if misdirection.contains(event_id) {
                continue;
            }
            for character in event["characters"].as_array().into_iter().flatten() {
                match character["id"].as_str() {
                    Some(cid) => {
                        names.insert(
                            cid.to_owned(),
                            character["name"].as_str().unwrap_or("").to_owned(),
                        );
                        appearances.push((
                            event["storyOrder"].as_i64().unwrap_or(narrative),
                            narrative,
                            cid.to_owned(),
                            chapter_id.clone(),
                            flashback.contains(event_id),
                        ));
                    }
                    None => {
                        pending_names.insert(character["name"].as_str().unwrap_or("").to_owned());
                    }
                }
            }
        }
        for (index, change) in card["card"]["stateChanges"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            if change["eventId"]
                .as_str()
                .is_some_and(|e| misdirection.contains(e))
            {
                continue;
            }
            // 作者否决过的状态变化不参与折叠
            if marks
                .get(&state_change_key(&chapter_id, change))
                .is_some_and(|m| m == "rejected")
            {
                continue;
            }
            let Some(cid) = change["character"]["id"].as_str() else {
                pending_names.insert(
                    change["character"]["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                );
                continue;
            };
            names.insert(
                cid.to_owned(),
                change["character"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            );
            let mut entry = change.clone();
            entry["chapterId"] = json!(chapter_id);
            entries.push((
                change["storyOrder"].as_i64().unwrap_or(narrative),
                narrative,
                index,
                entry,
                cid.to_owned(),
            ));
        }
        for know in card["card"]["knowledge"].as_array().into_iter().flatten() {
            if let Some(cid) = know["character"]["id"].as_str() {
                let mut entry = know.clone();
                entry["chapterId"] = json!(chapter_id);
                knowledge.push((cid.to_owned(), entry));
            }
        }
    }
    entries.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
    appearances.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    let mut folds: BTreeMap<String, CharacterFold> = BTreeMap::new();
    let mut suspects: Vec<Value> = Vec::new();
    for (order, narrative, _, entry, cid) in entries {
        let fold = folds.entry(cid.clone()).or_default();
        fold.name = names.get(&cid).cloned().unwrap_or_default();
        // 同一故事顺序、同一字段出现不同结果：疑点
        if let Some(previous) = fold.history.iter().rev().find(|h| {
            h["storyOrder"] == entry["storyOrder"]
                && h["field"] == entry["field"]
                && h["after"] != entry["after"]
        }) {
            suspects.push(json!({"issueKey":format!("conflict:{cid}:{}:{order}",entry["field"].as_str().unwrap_or("")),
                "code":"state.conflict","characterId":cid,"chapterId":entry["chapterId"],"storyOrder":order,
                "quotes":[previous["quote"],entry["quote"]],"message":format!("{} 的{}在同一时间点有两种说法",fold.name,field_label(entry["field"].as_str().unwrap_or("")))}));
        }
        // 已死亡后再出现非倒叙的状态变化：疑点
        let dead_at = fold
            .history
            .iter()
            .filter(|h| h["field"] == "alive" && alive_after(h) == Some(false))
            .map(|h| (h["storyOrder"].as_i64().unwrap_or(0), h["quote"].clone()))
            .last();
        if let Some((death_order, death_quote)) = dead_at {
            let revived = entry["field"] == "alive" && alive_after(&entry) == Some(true);
            if order > death_order && !revived {
                suspects.push(json!({"issueKey":format!("alive:{cid}:{}",entry["chapterId"].as_str().unwrap_or("")),
                    "code":"state.alive","characterId":cid,"chapterId":entry["chapterId"],"storyOrder":order,
                    "quotes":[death_quote,entry["quote"]],"message":format!("{} 已死亡，之后仍有状态变化",fold.name)}));
            }
        }
        let mut record = entry.clone();
        record["narrativeOrder"] = json!(narrative);
        fold.history.push(record);
    }
    for (order, narrative, cid, chapter_id, is_flashback) in appearances {
        let fold = folds.entry(cid.clone()).or_default();
        fold.name = names.get(&cid).cloned().unwrap_or_default();
        let dead_at = fold
            .history
            .iter()
            .filter(|h| h["field"] == "alive" && alive_after(h) == Some(false))
            .map(|h| (h["storyOrder"].as_i64().unwrap_or(0), h["quote"].clone()))
            .last();
        if let Some((death_order, death_quote)) = dead_at {
            let revived_later = fold.history.iter().any(|h| {
                h["field"] == "alive"
                    && alive_after(h) == Some(true)
                    && h["storyOrder"].as_i64().unwrap_or(0) > death_order
                    && h["storyOrder"].as_i64().unwrap_or(0) <= order
            });
            if order > death_order && !is_flashback && !revived_later {
                suspects.push(json!({"issueKey":format!("alive:{cid}:{chapter_id}"),"code":"state.alive","characterId":cid,
                    "chapterId":chapter_id,"storyOrder":order,"quotes":[death_quote,Value::Null],
                    "message":format!("{} 已死亡，之后仍在非倒叙场景出场",fold.name)}));
            }
        }
        fold.appearances.push(json!({"storyOrder":order,"narrativeOrder":narrative,"chapterId":chapter_id,"flashback":is_flashback}));
    }
    for (cid, entry) in knowledge {
        folds.entry(cid).or_default().knows.push(entry);
    }
    // 写入派生状态；先清掉旧的，避免删章后残留
    for old in list(db, CANON_NS, &format!("state:{book_id}:")).await? {
        let cid = old["characterId"].as_str().unwrap_or("");
        if !folds.contains_key(cid) {
            sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
                .bind(CANON_NS)
                .bind(json!(state_key(book_id, cid)).to_string())
                .execute(&mut *db)
                .await
                .map_err(err)?;
        }
    }
    for (cid, fold) in &folds {
        let latest = fold_latest(&fold.history, i64::MAX);
        let record = json!({"id":state_key(book_id,cid),"bookId":book_id,"characterId":cid,"name":fold.name,
            "history":fold.history,"appearances":fold.appearances,"knows":fold.knows,"latest":latest,
            "lastAppearedChapter":fold.appearances.last().map(|a|a["chapterId"].clone()).unwrap_or(Value::Null),"updatedAt":now()});
        put(db, CANON_NS, &state_key(book_id, cid), &record).await?;
    }
    // 疑点：派生数据整体重写，作者已裁决的同一 issueKey 不再生成
    let mut kept = 0;
    let mut seen = BTreeSet::new();
    for old in list(db, CANON_NS, &format!("suspect:{book_id}:")).await? {
        sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
            .bind(CANON_NS)
            .bind(json!(old["id"].as_str().unwrap_or("")).to_string())
            .execute(&mut *db)
            .await
            .map_err(err)?;
    }
    for suspect in suspects {
        let issue = suspect["issueKey"].as_str().unwrap_or("").to_owned();
        if !seen.insert(issue.clone()) {
            continue;
        }
        if get(db, AUTHOR_NS, &format!("verdict:{book_id}:{issue}"))
            .await?
            .is_some()
        {
            continue;
        }
        let key = suspect_key(book_id, &issue);
        let mut record = suspect;
        record["id"] = json!(key);
        record["bookId"] = json!(book_id);
        record["createdAt"] = json!(now());
        put(db, CANON_NS, &key, &record).await?;
        kept += 1;
    }
    let mut progress = get(db, CANON_NS, &index_key(book_id))
        .await?
        .unwrap_or_else(|| json!({"id":index_key(book_id),"bookId":book_id}));
    progress["pendingEntities"] = json!(pending_names);
    progress["foldedAt"] = json!(now());
    put(db, CANON_NS, &index_key(book_id), &progress).await?;
    Ok(json!({"characters":folds.len(),"suspects":kept,"pendingEntities":pending_names.len()}))
}

/// 状态字段在疑点与影响报告里给作者看的名字。
fn field_label(field: &str) -> &str {
    match field {
        "realm" => "境界",
        "location" => "所在地",
        "item" => "持有物",
        "relation" => "关系",
        "goal" => "目标",
        "alive" => "生死",
        other => other,
    }
}

/// 一条生死变化之后此人是否还活着：None 表示正文没写清，不改变已有状态。
/// 索引器在 aliveAfter 里直接给出 alive / dead / unknown（假死、濒死、重伤都算活着），不再从措辞里猜。
/// 这个字段出现之前索引的旧章节卡只有原文说法，仍按原来的读法处理，避免已有作品的状态被改动。
fn alive_after(change: &Value) -> Option<bool> {
    match change["aliveAfter"].as_str() {
        Some("alive") => Some(true),
        Some("dead") => Some(false),
        Some(_) => None,
        None => change["after"]
            .as_str()
            .map(|text| !explicit_death_text(text)),
    }
}

fn explicit_death_text(value: &str) -> bool {
    ["死", "亡", "殒", "false", "no", "否"]
        .iter()
        .any(|w| value.contains(w))
        && !value.contains("未死")
        && !value.contains("没死")
}

/// 折叠到指定故事顺序（含）为止的状态。
pub(crate) fn fold_latest(history: &[Value], up_to: i64) -> Value {
    let mut state =
        json!({"alive":true,"location":null,"realm":null,"items":[],"relations":{},"goals":[]});
    for change in history
        .iter()
        .filter(|h| h["storyOrder"].as_i64().unwrap_or(0) <= up_to)
    {
        let after = change["after"].as_str().unwrap_or("").to_owned();
        match change["field"].as_str().unwrap_or("") {
            "alive" => {
                if let Some(alive) = alive_after(change) {
                    state["alive"] = json!(alive);
                }
            }
            "location" => state["location"] = json!(after),
            "realm" => state["realm"] = json!(after),
            "goal" => {
                state["goals"].as_array_mut().unwrap().push(json!(after));
            }
            "item" => {
                let items = state["items"].as_array_mut().unwrap();
                let before = change["before"].as_str().unwrap_or("");
                if !before.is_empty() {
                    items.retain(|i| i.as_str() != Some(before));
                }
                if !after.is_empty() && !["无", "失去", "丢失"].contains(&after.as_str()) {
                    items.push(json!(after));
                }
            }
            "relation" => {
                state["relations"][change["before"].as_str().unwrap_or("关系")] = json!(after);
            }
            _ => {}
        }
    }
    state
}

/// 某人物在某章（按该章的故事顺序）时的状态：折叠结果 + 到那时为止已知的事实。
pub async fn state_as_of(
    db: &mut SqliteConnection,
    book_id: &str,
    character_id: &str,
    chapter_id: &str,
) -> Result<Value, String> {
    if crate::reference_books::project_of(book_id).is_none() {
        let h = crate::story_history::History::load(db, book_id).await?;
        let end = h.boundary(&json!({"chapterId":chapter_id}))? + 1;
        return Ok(crate::story_history::snapshot(db, book_id, &h, end)
            .await?
            .person(character_id, chapter_id));
    }
    let card = get_card(db, book_id, chapter_id)
        .await?
        .ok_or("该章尚未建立章节卡")?;
    let up_to = card_story_order(&card);
    let Some(state) = get(db, CANON_NS, &state_key(book_id, character_id)).await? else {
        return Ok(
            json!({"characterId":character_id,"asOfChapter":chapter_id,"asOfStoryOrder":up_to,"known":false}),
        );
    };
    let history = state["history"].as_array().cloned().unwrap_or_default();
    let latest = fold_latest(&history, up_to);
    let knows = state["knows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|k| k["learnedAt"].as_i64().unwrap_or(0) <= up_to)
        .cloned()
        .collect::<Vec<_>>();
    let last_seen = state["appearances"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["storyOrder"].as_i64().unwrap_or(0) <= up_to)
        .last()
        .cloned();
    Ok(
        json!({"characterId":character_id,"name":state["name"],"asOfChapter":chapter_id,"asOfStoryOrder":up_to,"known":true,
        "state":latest,"knows":knows,"lastSeen":last_seen,
        "changes":history.iter().filter(|h|h["storyOrder"].as_i64().unwrap_or(0)<=up_to).count()}),
    )
}

/// 状态账本总览：每个人物折叠到最新故事顺序的状态，不含完整历史。
pub async fn list_states(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    Ok(list(db, CANON_NS, &format!("state:{book_id}:"))
        .await?
        .into_iter()
        .map(|s| {
            json!({"characterId":s["characterId"],"name":s["name"],"latest":s["latest"],
                "lastAppearedChapter":s["lastAppearedChapter"],"appearances":s["appearances"].as_array().map_or(0, |a| a.len()),
                "changes":s["history"].as_array().map_or(0, |a| a.len()),"knows":s["knows"].as_array().map_or(0, |a| a.len()),
                "updatedAt":s["updatedAt"]})
        })
        .collect())
}

pub async fn list_suspects(db: &mut SqliteConnection, book_id: &str) -> Result<Vec<Value>, String> {
    list(db, CANON_NS, &format!("suspect:{book_id}:")).await
}

/// 写作台“状态账本”：写到这一章时各人物的状态、还开着的线索（埋了多久、多久没动）、本章疑点。
/// 本章还没有章节卡时按已索引的最新状态给，并如实标出。
pub async fn ledger(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: Option<&str>,
) -> Result<Value, String> {
    if crate::reference_books::project_of(book_id).is_none() {
        let h = crate::story_history::History::load(db, book_id).await?;
        let end = match chapter_id {
            Some(cid) => h.boundary(&json!({"chapterId":cid}))? + 1,
            None => h.chapters.len(),
        };
        let state = crate::story_history::snapshot(db, book_id, &h, end).await?;
        let characters=state.people.iter().map(|(id,p)|json!({"characterId":id,"name":p["name"],"state":p["state"],"lastSeenChapter":p["lastSeen"]["chapterId"],"lastSeenTitle":p["lastSeen"]["chapterId"].as_str().and_then(|cid|h.chapters.iter().find(|c|c.id==cid)).map(|c|&c.title)})).collect::<Vec<_>>();
        let threads=state.threads.values().map(|t|{
            let origin=&t["origin"];let last=t.get("latest").map(|v|&v["source"]).unwrap_or(origin);
            let title=|v:&Value|v["chapterNo"].as_u64().and_then(|no|h.chapters.get(no.saturating_sub(1) as usize)).map(|c|&c.title);
            json!({"threadId":t["threadId"],"kind":t["kind"],"title":t["title"],"plantedChapter":origin["chapterId"],"plantedTitle":title(origin),"lastTouchedTitle":title(last),"idleChapters":end.saturating_sub(last["chapterNo"].as_u64().unwrap_or(0) as usize)})
        }).collect::<Vec<_>>();
        let suspects: Vec<_> = list_suspects(db, book_id)
            .await?
            .into_iter()
            .filter(|s| {
                chapter_id.is_some_and(|id| {
                    s["chapterId"] == id
                        && h.chapters[..end]
                            .iter()
                            .any(|c| c.id == id && h.verified(c).is_some())
                })
            })
            .collect();
        return Ok(
            json!({"bookId":book_id,"chapterId":chapter_id,"asOf":if chapter_id.is_some(){"chapter"}else{"latest"},"characters":characters,"threads":threads,"suspects":suspects,"unindexed":crate::story_history::ranges(&state.missing)}),
        );
    }
    const MAX_CHARACTERS: usize = 12;
    const MAX_THREADS: usize = 12;
    let catalog = crate::writing_records::catalog(db, book_id).await?;
    let position = |cid: &str| {
        catalog
            .iter()
            .position(|c| c["id"].to_string().trim_matches('"') == cid)
    };
    let title = |cid: &str| {
        position(cid)
            .map(|i| catalog[i]["title"].clone())
            .unwrap_or(Value::Null)
    };
    let has_card = match chapter_id {
        Some(cid) => get_card(db, book_id, cid).await?.is_some(),
        None => false,
    };
    let mut states = list_states(db, book_id).await?;
    states.sort_by_key(|s| -(s["appearances"].as_i64().unwrap_or(0)));
    let mut characters = Vec::new();
    for s in states.into_iter().take(MAX_CHARACTERS) {
        let cid = s["characterId"].as_str().unwrap_or("").to_owned();
        let (state, last_seen) = match (has_card, chapter_id) {
            (true, Some(chapter)) => {
                let as_of = state_as_of(db, book_id, &cid, chapter).await?;
                (
                    as_of["state"].clone(),
                    as_of["lastSeen"]["chapterId"].as_str().map(str::to_owned),
                )
            }
            _ => (
                s["latest"].clone(),
                s["lastAppearedChapter"].as_str().map(str::to_owned),
            ),
        };
        if state.is_null() {
            continue;
        }
        characters.push(
            json!({"characterId":cid,"name":s["name"],"state":state,"lastSeenChapter":last_seen,
            "lastSeenTitle":last_seen.as_deref().map(&title).unwrap_or(Value::Null)}),
        );
    }
    let here = chapter_id.and_then(&position);
    let mut threads = Vec::new();
    for t in list_threads(db, book_id, Some("open")).await? {
        let planted = t["plantedChapter"].as_str().unwrap_or("");
        let last_touch = t["advances"]
            .as_array()
            .and_then(|a| a.last())
            .and_then(|a| a["chapterId"].as_str())
            .unwrap_or(planted)
            .to_owned();
        let (planted_at, touched_at) = (position(planted), position(&last_touch));
        // 埋在本章之后的线索与写到这里无关
        if let (Some(h), Some(p)) = (here, planted_at) {
            if p > h {
                continue;
            }
        }
        let idle = match (here.or(Some(catalog.len().saturating_sub(1))), touched_at) {
            (Some(h), Some(t)) => h.saturating_sub(t),
            _ => 0,
        };
        threads.push(json!({"threadId":t["threadId"],"kind":t["kind"],"title":t["title"],"plantedChapter":planted,
            "plantedTitle":title(planted),"lastTouchedTitle":title(&last_touch),"idleChapters":idle,"overridden":t["overridden"]}));
    }
    threads.sort_by_key(|t| -(t["idleChapters"].as_i64().unwrap_or(0)));
    threads.truncate(MAX_THREADS);
    let suspects = match chapter_id {
        Some(cid) => list_suspects(db, book_id)
            .await?
            .into_iter()
            .filter(|s| s["chapterId"] == cid)
            .collect(),
        None => Vec::new(),
    };
    Ok(
        json!({"bookId":book_id,"chapterId":chapter_id,"asOf":if has_card { "chapter" } else { "latest" },
        "characters":characters,"threads":threads,"suspects":suspects}),
    )
}

// ---------------------------------------------------------------------------
// 作者维护的数据
// ---------------------------------------------------------------------------

pub async fn save_rule(
    db: &mut SqliteConnection,
    scope: &str,
    book_id: Option<&str>,
    category: &str,
    text: &str,
    source: &str,
) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 600 {
        return Err("规则应为 1—600 字".into());
    }
    if !["结构", "文风", "禁忌", "人设", "平台"].contains(&category) {
        return Err("规则类别无效".into());
    }
    let key = match (scope, book_id) {
        ("author", _) => format!("rule:author:{}", id()),
        ("book", Some(bid)) if !bid.is_empty() => format!("rule:book:{bid}:{}", id()),
        _ => return Err("作品规则必须指定作品".into()),
    };
    let record = json!({"id":key,"scope":scope,"bookId":if scope=="book"{book_id.unwrap_or("")}else{""},
        "category":category,"text":text,"source":source,"createdAt":now(),"updatedAt":now()});
    put(db, AUTHOR_NS, &key, &record).await?;
    Ok(record)
}

/// 作者规则：全局的 + 指定作品的，按创建时间排列。
pub async fn list_rules(
    db: &mut SqliteConnection,
    book_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut rules = list(db, AUTHOR_NS, "rule:author:").await?;
    if let Some(bid) = book_id.filter(|b| !b.is_empty()) {
        rules.extend(list(db, AUTHOR_NS, &format!("rule:book:{bid}:")).await?);
    }
    rules.retain(|r| !r["deletedAt"].is_number());
    rules.sort_by_key(|r| r["createdAt"].as_i64().unwrap_or(0));
    Ok(rules)
}

pub async fn delete_rule(db: &mut SqliteConnection, key: &str) -> Result<(), String> {
    let mut rule = get(db, AUTHOR_NS, key).await?.ok_or("规则不存在")?;
    rule["deletedAt"] = json!(now());
    put(db, AUTHOR_NS, key, &rule).await
}

fn gate(block: &[&str], suspect: &[&str], notice: &[&str]) -> Value {
    json!({"block":block,"suspect":suspect,"notice":notice})
}

/// 内置平台画像：可编辑的默认参数，不是定论；作者复制后的副本存作者命名空间。
pub fn builtin_profiles() -> Vec<Value> {
    let block = [
        "structure.empty",
        "structure.words_min",
        "structure.repeat",
        "structure.sensitive",
        "overlap.reference",
    ];
    let suspect = [
        "state.alive",
        "state.conflict",
        "state.item",
        "state.knowledge",
    ];
    let notice = [
        "structure.words_low",
        "structure.words_high",
        "style.repeat_head",
    ];
    let default_gate = gate(&block, &suspect, &notice);
    vec![
        json!({"id":"general","name":"通用","chapterWords":[2000,4000],"paragraphMaxChars":100,"endHookRequired":false,"openingHookWithin":500,
            "payoffEvery":3,"midPayoffEvery":8,"suppressMaxChapters":4,"infoReleaseLevel":"mid",
            "readerPersona":"普通网文读者，期待每章有推进，不喜欢连续过渡章。","gate":default_gate,"builtin":true}),
        json!({"id":"fanqie","name":"番茄 / 七猫（免费）","chapterWords":[2000,3000],"paragraphMaxChars":60,"endHookRequired":true,"openingHookWithin":300,
            "payoffEvery":1,"midPayoffEvery":3,"suppressMaxChapters":2,"infoReleaseLevel":"low",
            "readerPersona":"手机碎片阅读，三段没有冲突就划走；喜欢即时情绪反馈、打脸和反转，不耐烦设定解释。","gate":default_gate,"builtin":true}),
        json!({"id":"qidian","name":"起点男频（付费）","chapterWords":[3000,4000],"paragraphMaxChars":100,"endHookRequired":true,"openingHookWithin":1000,
            "payoffEvery":3,"midPayoffEvery":5,"suppressMaxChapters":5,"infoReleaseLevel":"mid",
            "readerPersona":"老书虫，看重设定逻辑与长线布局，能接受铺垫，但要求兑现和追更黏性。","gate":default_gate,"builtin":true}),
        json!({"id":"jinjiang","name":"晋江女频","chapterWords":[3000,6000],"paragraphMaxChars":140,"endHookRequired":false,"openingHookWithin":1500,
            "payoffEvery":1,"midPayoffEvery":5,"suppressMaxChapters":3,"infoReleaseLevel":"mid",
            "readerPersona":"看重情感线与 CP 感，每章要有情绪价值；反感人设崩塌和工具人配角。","gate":default_gate,"builtin":true}),
        json!({"id":"zhihu","name":"知乎盐选短篇","chapterWords":[8000,30000],"paragraphMaxChars":80,"endHookRequired":false,"openingHookWithin":100,
            "payoffEvery":1,"midPayoffEvery":1,"suppressMaxChapters":1,"infoReleaseLevel":"low",
            "readerPersona":"第一句就要爆点，每千字一个反转，结尾要炸；第一人称口语，讨厌升华总结。","gate":default_gate,"builtin":true}),
        json!({"id":"gongzhonghao","name":"公众号短篇","chapterWords":[3000,8000],"paragraphMaxChars":50,"endHookRequired":false,"openingHookWithin":80,
            "payoffEvery":1,"midPayoffEvery":1,"suppressMaxChapters":1,"infoReleaseLevel":"low",
            "readerPersona":"标题决定打开率，开头一句定去留；至少两次反转，结尾情绪落点明确。","gate":default_gate,"builtin":true}),
    ]
}

/// 全部画像：内置 + 作者副本（同 id 时作者副本覆盖内置）。
pub async fn platform_profiles(db: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    let mut profiles = builtin_profiles();
    for custom in list(db, AUTHOR_NS, "platform:").await? {
        if custom["deletedAt"].is_number() {
            continue;
        }
        match profiles.iter().position(|p| p["id"] == custom["id"]) {
            Some(i) => profiles[i] = custom,
            None => profiles.push(custom),
        }
    }
    Ok(profiles)
}

pub async fn platform_profile(
    db: &mut SqliteConnection,
    profile_id: &str,
) -> Result<Value, String> {
    platform_profiles(db)
        .await?
        .into_iter()
        .find(|p| p["id"] == profile_id)
        .ok_or_else(|| format!("平台画像不存在：{profile_id}"))
}

pub async fn book_profile_id(db: &mut SqliteConnection, book_id: &str) -> Result<String, String> {
    Ok(get(db, AUTHOR_NS, &format!("book-profile:{book_id}"))
        .await?
        .and_then(|v| v["profileId"].as_str().map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_PROFILE.to_owned()))
}

/// AI 写进正文的片段指纹（每段若干小截）；索引切块时命中的段落标为 AI 来源，不进文风样本。
/// 同一章最多保留最近 300 段，指纹去重。
pub async fn record_ai_spans(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
    spans: &Value,
) -> Result<Value, String> {
    let key = format!("aispans:{book_id}:{chapter_id}");
    let mut record = get(db, AUTHOR_NS, &key)
        .await?
        .unwrap_or_else(|| json!({"id":key,"bookId":book_id,"chapterId":chapter_id,"spans":[]}));
    let mut items = record["spans"].as_array().cloned().unwrap_or_default();
    for span in spans.as_array().into_iter().flatten() {
        let marks = span["marks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|m| m.chars().count() >= 8)
            .take(40)
            .map(|m| m.chars().take(32).collect::<String>())
            .collect::<Vec<_>>();
        if marks.is_empty() || items.iter().any(|s| s["marks"] == json!(marks)) {
            continue;
        }
        items.push(json!({"marks":marks,"chars":span["chars"],"at":span["at"]}));
    }
    let overflow = items.len().saturating_sub(300);
    items.drain(..overflow);
    let count = items.len();
    record["spans"] = json!(items);
    record["updatedAt"] = json!(now());
    put(db, AUTHOR_NS, &key, &record).await?;
    Ok(json!({"spans":count}))
}

/// 一章记录过的全部 AI 指纹片段。
pub async fn ai_span_marks(
    db: &mut SqliteConnection,
    book_id: &str,
    chapter_id: &str,
) -> Result<Vec<String>, String> {
    Ok(
        get(db, AUTHOR_NS, &format!("aispans:{book_id}:{chapter_id}"))
            .await?
            .map(|r| {
                r["spans"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|s| s["marks"].as_array().cloned().unwrap_or_default())
                    .filter_map(|m| m.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// 每章记录过的 AI 片段数，文风样本选择时提示作者。
pub async fn ai_span_counts(db: &mut SqliteConnection, book_id: &str) -> Result<Value, String> {
    let mut counts = serde_json::Map::new();
    for r in list(db, AUTHOR_NS, &format!("aispans:{book_id}:")).await? {
        if let Some(cid) = r["chapterId"].as_str() {
            counts.insert(
                cid.to_owned(),
                json!(r["spans"].as_array().map_or(0, |a| a.len())),
            );
        }
    }
    Ok(Value::Object(counts))
}

pub async fn confirmed_samples(
    db: &mut SqliteConnection,
    book_id: &str,
) -> Result<Vec<String>, String> {
    Ok(get(db, AUTHOR_NS, &format!("sample:{book_id}"))
        .await?
        .and_then(|v| v["chapterIds"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect())
}

pub async fn index_progress(db: &mut SqliteConnection, book_id: &str) -> Result<Value, String> {
    let progress = get(db, CANON_NS, &index_key(book_id))
        .await?
        .unwrap_or_else(|| json!({"id":index_key(book_id),"bookId":book_id}));
    let cards = list_cards(db, book_id).await?;
    let active = cards.iter().filter(|c| c["status"] == "active").count();
    let stale = cards.iter().filter(|c| c["status"] == "stale").count();
    let total = crate::reference_books::any_catalog(db, book_id)
        .await?
        .len();
    let pending = crate::story_index::pending(db, Some(book_id)).await?;
    let paused = crate::story_index::index_paused(db, book_id).await?;
    Ok(
        json!({"bookId":book_id,"indexed":active,"stale":stale,"total":total,"pendingEvents":pending,"paused":paused,
        "pendingEntities":progress["pendingEntities"],"foldedAt":progress["foldedAt"],"lastRunAt":progress["lastRunAt"],
        "failed":progress["failed"],"estimatedCost":progress["estimatedCost"]}),
    )
}

pub async fn update_index_progress(
    db: &mut SqliteConnection,
    book_id: &str,
    patch: &Value,
) -> Result<Value, String> {
    let key = index_key(book_id);
    let mut progress = get(db, CANON_NS, &key)
        .await?
        .unwrap_or_else(|| json!({"id":key,"bookId":book_id}));
    if let (Some(target), Some(source)) = (progress.as_object_mut(), patch.as_object()) {
        for (k, v) in source {
            target.insert(k.clone(), v.clone());
        }
    }
    put(db, CANON_NS, &key, &progress).await?;
    Ok(progress)
}

// ---------------------------------------------------------------------------
// 前文修改影响：比对同一章的上一版章节卡，列出引用了被改事实与人物的后续章节（候选清单）
// ---------------------------------------------------------------------------

pub fn profile_summary(profile: &Value) -> String {
    let words = &profile["chapterWords"];
    format!(
        "以下是平台参考建议，不是逐章必须达成的公式；作者要求与本章目标优先。参考篇幅 {}–{} 字，移动阅读段长参考 {} 字；开篇关注人物处境和阅读期待，结尾承接本章已经发生的变化。节奏与回报按故事阶段安排，过渡与日常场景不必新增危机、反转或爽点。设定释放参考：{}。读者画像：{}",
        words[0], words[1], profile["paragraphMaxChars"],
        match profile["infoReleaseLevel"].as_str().unwrap_or("mid") { "low" => "少", "high" => "多", _ => "中" },
        profile["readerPersona"].as_str().unwrap_or("")
    )
}
