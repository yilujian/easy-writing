//! 作者更正、整理范围的预览/确认以及故事状态页。模型产生的状态只由章节卡提供。
use crate::story_history::{ranges, snapshot, History};
use crate::story_state;
use crate::writing_records::{err, get, list, put};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, HashMap, HashSet};

pub async fn corrections(
    db: &mut SqliteConnection,
    bid: &str,
    h: &History,
    end: usize,
) -> Result<Vec<Value>, String> {
    let mut rows = list(
        db,
        story_state::AUTHOR_NS,
        &format!("prose-correction:{bid}:"),
    )
    .await?;
    // 旧版手改存放在桌面记录库。保留作者原句和锚点，旧模型生成的摘要不迁为事实。
    if let Some(old) = get(db, "ew-agent-pi-ledger/ledger", &format!("book:{bid}")).await? {
        if let Some(v) = old["override"].as_object() {
            rows.push(Value::Object(v.clone()));
        }
    }
    let chat_corrections:Vec<String>=sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/memory' AND json_extract(value,'$.scope')='book' AND json_extract(value,'$.bookId')=? AND json_type(value,'$.afterChapterId')='text' ORDER BY json_extract(value,'$.updatedAt'),key")
        .bind(bid).fetch_all(&mut *db).await.map_err(err)?;
    for raw in chat_corrections {
        let m: Value = serde_json::from_str(&raw).map_err(err)?;
        rows.push(json!({"id":m["id"],"afterChapterId":m["afterChapterId"],"text":m["content"],"editedAt":m["updatedAt"],"knowledge":m["knowledge"]}));
    }
    let position: HashMap<_, _> = h.chapters[..end]
        .iter()
        .map(|c| (c.id.clone(), c.no))
        .collect();
    rows.retain(|r| {
        r["afterChapterId"].is_null()
            || position.contains_key(
                &r["afterChapterId"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| r["afterChapterId"].to_string()),
            )
    });
    rows.sort_by_key(|r| r["editedAt"].as_i64().unwrap_or(0));
    // 后写的作者更正覆盖同一条旧更正。
    let mut latest = BTreeMap::new();
    for row in rows {
        let anchor = row["afterChapterId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| row["afterChapterId"].to_string());
        let key = row["id"].as_str().map(str::to_owned).unwrap_or(anchor);
        latest.insert(key, row);
    }
    let mut notes: Vec<_> = latest
        .into_values()
        .filter(|r| r["text"].as_str().is_some_and(|s| !s.is_empty()))
        .collect();
    notes.sort_by_key(|r| {
        let cid = r["afterChapterId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| r["afterChapterId"].to_string());
        (
            position.get(&cid).copied().unwrap_or(0),
            r["editedAt"].as_i64().unwrap_or(0),
        )
    });
    Ok(notes)
}

pub async fn save_correction(
    db: &mut SqliteConnection,
    bid: &str,
    args: &Value,
) -> Result<Value, String> {
    let h = History::load(db, bid).await?;
    let anchor = args["afterChapterId"].as_str();
    if anchor.is_some_and(|id| !h.chapters.iter().any(|c| c.id == id)) {
        return Err("更正所指的章节不属于当前作品".into());
    }
    let text = args["text"].as_str().ok_or("缺少更正原话")?.trim();
    let key = format!("prose-correction:{bid}:{}", anchor.unwrap_or("start"));
    let saved = get(db, story_state::AUTHOR_NS, &key).await?;
    let actual = saved
        .as_ref()
        .and_then(|r| r["editedAt"].as_i64())
        .unwrap_or(0);
    if args["expectedEditedAt"]
        .as_i64()
        .is_some_and(|v| v != actual)
    {
        return Err("这条更正已经被改过，请重新打开再编辑".into());
    }
    let row = json!({"bookId":bid,"afterChapterId":anchor,"text":text,"editedAt":(actual+1).max(crate::writing_records::now()),"source":"state-page"});
    put(db, story_state::AUTHOR_NS, &key, &row).await?;
    Ok(row)
}

pub fn preview(h: &History, args: &Value) -> Result<Value, String> {
    let end = if args["chapterId"].is_string() || args["volumeId"].is_string() {
        h.boundary(args)?
    } else if let Some(through) = args["throughChapterId"].as_str() {
        h.boundary(&json!({"chapterId":through}))? + 1
    } else {
        h.chapters.len()
    };
    let scope = &h.chapters[..end];
    let pending: Vec<_> = scope
        .iter()
        .filter(|c| c.words > 0 && h.verified(c).is_none())
        .collect();
    let first = pending.first();
    let characters: usize = pending.iter().map(|c| c.words).sum();
    Ok(
        json!({"hasPreviousText":scope.iter().any(|c|c.words>0),"targetHasText":args["chapterId"].as_str().and_then(|id|h.chapters.iter().find(|c|c.id==id)).is_some_and(|c|c.words>0),"chapterIds":pending.iter().map(|c|&c.id).collect::<Vec<_>>(),"count":pending.len(),"characters":characters,
        "estimatedTokens":(characters as f64/1.7).ceil() as usize+pending.len()*1200,
        "throughChapterId":scope.last().map(|c|&c.id),"rangeKey":first.map(|c|format!("{}:{}",c.id,c.stamp)),
        "revision":scope.last().map(|c|c.stamp.as_str()).unwrap_or("empty")}),
    )
}

pub async fn view(db: &mut SqliteConnection, bid: &str) -> Result<Value, String> {
    let h = History::load(db, bid).await?;
    let state = snapshot(db, bid, &h, h.chapters.len()).await?;
    let corrections = &state.author_corrections;
    let mut entries = Vec::new();
    for c in h.chapters.iter().filter(|c| c.words > 0) {
        if let Some(card) = h.verified(c) {
            let data = &card["card"];
            entries.push(json!({"chapterNo":c.no,"chapterId":c.id,"title":c.title,"summary":data["oneLine"]}));
        }
    }
    let pending = h.pending().iter().map(|c| c.no).collect::<Vec<_>>();
    let control = get(db, story_state::AUTHOR_NS, &format!("index-control:{bid}"))
        .await?
        .unwrap_or_default();
    let paused = control["paused"] == true;
    let needs_confirmation = control["needsConfirmation"] == true;
    let queued = crate::story_index::pending(db, Some(bid)).await?;
    let page_edits = list(
        db,
        story_state::AUTHOR_NS,
        &format!("prose-correction:{bid}:"),
    )
    .await?
    .into_iter()
    .filter_map(|v| {
        let key = v["afterChapterId"].as_str().unwrap_or("").to_owned();
        Some((key, v["editedAt"].as_i64()?))
    })
    .collect::<BTreeMap<_, _>>();
    Ok(
        json!({"pageEdits":page_edits,"entries":entries,"people":state.people.values().collect::<Vec<_>>(),"openThreads":state.threads.values().collect::<Vec<_>>(),"corrections":corrections,
        "chapters":h.chapters.iter().filter(|c|c.words>0).map(|c|json!({"id":c.id,"title":c.title,"no":c.no})).collect::<Vec<_>>(),
        "pending":ranges(&pending),"paused":paused,"needsConfirmation":needs_confirmation,"queued":queued}),
    )
}

pub async fn backfill(db: &mut SqliteConnection, bid: &str, args: &Value) -> Result<Value, String> {
    let h = History::load(db, bid).await?;
    let plan = preview(&h, args)?;
    if args["revision"] != plan["revision"] {
        return Err("预览后作品已改变，请重新确认整理范围".into());
    }
    let ids: HashSet<_> = plan["chapterIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let requested = args["chapterIds"].as_array().ok_or("缺少已确认的章节")?;
    let mut approved = serde_json::Map::new();
    let mut newly_queued = 0;
    let chapters: HashMap<_, _> = h.chapters.iter().map(|c| (c.id.as_str(), c)).collect();
    for id in requested {
        let cid = id.as_str().ok_or("无效的章节编号")?;
        let chapter = chapters.get(cid).ok_or("补记范围已改变")?;
        if ids.contains(cid) {
            let stamp = &chapter.stamp;
            approved.insert(cid.to_owned(), json!(stamp));
            newly_queued+=sqlx::query("INSERT INTO agent_outbox(kind,bookId,chapterId,createdAt) SELECT 'chapter',?,?,? WHERE NOT EXISTS(SELECT 1 FROM agent_outbox WHERE bookId=? AND chapterId=? AND kind='chapter' AND processedAt IS NULL)")
            .bind(bid).bind(cid).bind(crate::writing_records::now()-crate::story_index::QUIET_MS).bind(bid).bind(cid).execute(&mut *db).await.map_err(err)?.rows_affected();
        }
    }
    put(
        db,
        story_state::AUTHOR_NS,
        &format!("index-control:{bid}"),
        &json!({"paused":false,"modelCode":args["modelCode"],"approved":approved}),
    )
    .await?;
    Ok(json!({"queued":newly_queued,"approved":approved.len()}))
}
