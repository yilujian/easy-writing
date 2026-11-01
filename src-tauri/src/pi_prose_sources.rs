//! 正文仅取目标章以前的正式原文。历史人物和伏笔由写作台共用的章节卡提供。
use crate::story_history::{self, Chapter, History, Snapshot};
use crate::writing_records::{book, chapter, err};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub async fn book_style(db: &mut SqliteConnection, bid: &str) -> Result<String, String> {
    let key = format!("ew-pi-default-style:{bid}");
    match crate::writing_records::get(db, "app-settings", &key).await? {
        Some(Value::String(style)) => Ok(style),
        None => Ok(String::new()),
        _ => Err("作品文风设置损坏".into()),
    }
}

async fn passage(db: &mut SqliteConnection, bid: &str, c: &Chapter) -> Result<Value, String> {
    let body = chapter(db, bid, &c.id).await?;
    Ok(
        json!({"chapterId":c.id,"chapterNo":c.no,"title":c.title,"version":c.version,"text":body["textContent"]}),
    )
}

fn terms_for(task: &str, doc: &Value, state: &Snapshot, args: &Value) -> BTreeSet<String> {
    let mut terms: BTreeSet<String> = args["terms"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    for item in doc["characters"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(doc["worldSettings"].as_array().into_iter().flatten())
    {
        let names: Vec<_> = item["name"]
            .as_str()
            .into_iter()
            .chain(
                item["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            )
            .filter(|name| !name.trim().is_empty())
            .collect();
        if names
            .iter()
            .any(|name| task.contains(name) || terms.contains(*name))
        {
            terms.extend(names.into_iter().map(str::to_owned));
        }
    }
    for names in state.aliases.values() {
        if names.iter().any(|n| task.contains(n) || terms.contains(n)) {
            terms.extend(names.iter().cloned());
        }
    }
    for name in state
        .people
        .values()
        .filter_map(|p| p["name"].as_str())
        .chain(state.entities.iter().map(String::as_str))
    {
        if !name.is_empty() && task.contains(name) {
            terms.insert(name.into());
        }
    }
    terms
}

async fn search(
    db: &mut SqliteConnection,
    bid: &str,
    earlier: &[Chapter],
    terms: &BTreeSet<String>,
    numbers: &Value,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let mut evidence = Vec::new();
    let mut seen = HashSet::new();
    let mut full = HashSet::new();
    for number in numbers.as_array().into_iter().flatten() {
        let c = number
            .as_u64()
            .and_then(|n| n.checked_sub(1))
            .and_then(|i| earlier.get(i as usize))
            .filter(|c| c.words > 0)
            .ok_or("点名的章节没有已发生的正式原文，或越过目标章")?;
        if full.insert(c.id.clone()) {
            evidence.push(passage(db, bid, c).await?);
        }
    }
    let allowed: Vec<_> = earlier
        .iter()
        .filter(|c| c.words > 0)
        .map(|c| c.id.as_str())
        .collect();
    let ids = serde_json::to_string(&allowed).map_err(err)?;
    let positions: BTreeMap<_, _> = earlier.iter().map(|c| (c.id.as_str(), c)).collect();
    let owner = crate::writing_records::book_owner(&book(db, bid).await?);
    let mut missing = Vec::new();
    for term in terms {
        let mut matched = false;
        for hit in crate::story_index::bounded_chunks(db, bid, term, &allowed, 8).await? {
            let Some(c) = hit["chapterId"].as_str().and_then(|id| positions.get(id)) else {
                continue;
            };
            let snippet = hit["text"].as_str().unwrap_or("");
            if snippet.is_empty() || !snippet.contains(term) {
                continue;
            }
            let p = passage(db, bid, c).await?;
            if !p["text"].as_str().is_some_and(|s| s.contains(snippet)) {
                continue;
            }
            matched = true;
            if !full.contains(&c.id) && seen.insert((c.id.clone(), snippet.to_owned())) {
                evidence.push(json!({"chapterId":c.id,"chapterNo":c.no,"version":c.version,"title":c.title,"text":snippet}));
            }
        }
        // 索引可能尚未覆盖旧章。数据库内从当时的原文取短摘录，避免将整本书搬进内存。
        let direct:Vec<(String,String)>=sqlx::query_as(
            "WITH allowed AS (SELECT CAST(value AS INTEGER) AS cid,CAST(key AS INTEGER) AS pos FROM json_each(?1)),
            hits AS (SELECT CAST(d.chapterId AS TEXT) AS id,a.pos,substr(json_extract(d.payload,'$.textContent'),max(1,instr(json_extract(d.payload,'$.textContent'),?3)-110),length(?3)+260) AS snippet
              FROM allowed a JOIN chapter_contents d ON d.bookId=?2 AND d.chapterId=a.cid
              WHERE d.userId IN ('guest',?4) AND instr(json_extract(d.payload,'$.textContent'),?3)>0),
            first_hits AS (SELECT * FROM hits ORDER BY pos LIMIT 2), last_hits AS (SELECT * FROM hits ORDER BY pos DESC LIMIT 2)
            SELECT id,snippet FROM first_hits UNION SELECT id,snippet FROM last_hits")
            .bind(&ids).bind(bid).bind(term).bind(&owner).fetch_all(&mut *db).await.map_err(err)?;
        for (id, snippet) in direct {
            matched = true;
            if !full.contains(&id) && seen.insert((id.clone(), snippet.clone())) {
                let c = positions[id.as_str()];
                evidence.push(json!({"chapterId":id,"chapterNo":c.no,"version":c.version,"title":c.title,"text":snippet}));
            }
        }
        if !matched {
            missing.push(term.clone());
        }
    }
    Ok((evidence, missing))
}

pub async fn collect(db: &mut SqliteConnection, bid: &str, args: &Value) -> Result<Value, String> {
    let detail = book(db, bid).await?;
    let h = History::load(db, bid).await?;
    let end = h.boundary(args)?;
    let earlier = &h.chapters[..end];
    let target = if args["chapterId"].is_string() {
        Some(&h.chapters[end])
    } else {
        None
    };
    let volume = target
        .map(|c| c.volume.as_str())
        .or(args["volumeId"].as_str())
        .unwrap_or("");
    let tail = earlier.last().filter(|c| c.volume == volume);
    // 卷末连续的空白章（写了章纲还没正文）按顺序填，先填最靠前的那一章，不往后追加。
    let blank = if target.is_none() {
        earlier
            .iter()
            .rev()
            .take_while(|c| c.words == 0 && c.volume == volume)
            .last()
    } else {
        None
    };
    let target_passage = if let Some(c) = target {
        passage(db, bid, c).await?
    } else {
        Value::Null
    };
    let blank_passage = if let Some(c) = blank {
        passage(db, bid, c).await?
    } else {
        Value::Null
    };
    let mut previous = Vec::new();
    for c in earlier.iter().rev().filter(|c| c.words > 0).take(2) {
        previous.push(passage(db, bid, c).await?);
    }
    previous.reverse();
    // 最近几章还没整理出章节卡的，原文直接给写作模型，不只写一句"尚未整理"。
    let shown: HashSet<&str> = previous
        .iter()
        .filter_map(|p| p["chapterId"].as_str())
        .collect();
    let mut unindexed_recent = Vec::new();
    for c in earlier.iter().rev().filter(|c| c.words > 0).take(5) {
        if shown.contains(c.id.as_str()) || h.verified(c).is_some() {
            continue;
        }
        unindexed_recent.push(passage(db, bid, c).await?);
    }
    unindexed_recent.reverse();
    let doc = crate::book_materials::materials(db, bid).await?;
    let outlines: Vec<_> = doc["outlineNodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| {
            args["outlineIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(&n["id"]))
                || args["title"]
                    .as_str()
                    .is_some_and(|t| Some(t) == n["title"].as_str())
        })
        .collect();
    let plan = target.or(blank).map(|c| &c.plan);
    let task = json!([
        args["author"],
        args["goal"],
        args["facts"],
        plan,
        outlines,
        previous.last().map(|p| &p["text"]),
        previous.first().map(|p| &p["text"])
    ])
    .to_string();
    let state = story_history::snapshot(db, bid, &h, end).await?;
    let terms = terms_for(&task, &doc, &state, args);
    let (evidence, not_found) = search(db, bid, earlier, &terms, &args["chapterNos"]).await?;
    let relevant = |value: &Value| {
        terms
            .iter()
            .any(|name| value.as_str().is_some_and(|s| s.contains(name)))
    };
    let chapters: HashSet<&str> = previous
        .iter()
        .chain(evidence.iter())
        .filter_map(|p| p["chapterId"].as_str())
        .collect();
    let cited = |source: &Value| {
        source["chapterId"]
            .as_str()
            .is_some_and(|id| chapters.contains(id))
    };
    let named_chapter = |source: &Value| {
        args["chapterNos"]
            .as_array()
            .is_some_and(|ns| ns.contains(&source["chapterNo"]))
    };
    let mut facts: Vec<_> = state
        .facts
        .values()
        .filter(|f| relevant(&f["text"]) || cited(&f["source"]))
        .cloned()
        .collect();
    for f in &mut facts {
        f["required"] = json!(named_chapter(&f["source"]));
    }
    facts.sort_by_key(|f| {
        std::cmp::Reverse(
            terms
                .iter()
                .filter(|t| f["text"].as_str().is_some_and(|s| s.contains(*t)))
                .count(),
        )
    });
    let fact_ids: HashSet<_> = facts.iter().filter_map(|f| f["factId"].as_str()).collect();
    let mut people = Vec::new();
    for p in state
        .people
        .values()
        .filter(|p| relevant(&p["name"]) || cited(&p["lastChange"]))
    {
        let mut selected = p.clone();
        if let Some(knows) = selected["knows"].as_object_mut() {
            let total = knows.len();
            knows.retain(|id, src| {
                fact_ids.contains(id.as_str()) || cited(src) || src["source"] == "author"
            });
            let skipped = total - knows.len();
            if skipped > 0 {
                selected["otherKnownFacts"] = json!(skipped);
            }
        }
        people.push(selected);
    }
    let mut ranked = Vec::new();
    for thread in state.threads.values() {
        let description = thread.to_string();
        let matches = terms
            .iter()
            .filter(|name| description.contains(*name))
            .count();
        let required = thread["authorNote"].as_str().is_some_and(|s| !s.is_empty())
            || named_chapter(&thread["origin"])
            || named_chapter(&thread["latest"]["source"]);
        let related = required
            || matches > 0
            || cited(&thread["origin"])
            || cited(&thread["latest"]["source"]);
        let clue = if related {
            let mut clue = thread.clone();
            clue["related"] = json!(true);
            clue["required"] = json!(required);
            clue
        } else {
            json!({"related":false,"threadId":thread["threadId"],"title":thread["title"],"chapterNo":thread["origin"]["chapterNo"],"lastAdvanced":thread["latest"]["source"]["chapterNo"]})
        };
        ranked.push(((required, matches, related), clue));
    }
    ranked.sort_by_key(|(priority, _)| std::cmp::Reverse(*priority));
    let open: Vec<_> = ranked.into_iter().map(|(_, clue)| clue).collect();
    let corrections = &state.author_corrections;
    let suspects: Vec<_> = crate::story_state::list_suspects(db, bid)
        .await?
        .into_iter()
        .filter(|s| {
            s["chapterId"].as_str().is_some_and(|id| {
                chapters.contains(id)
                    && h.cards.get(id).is_some_and(|card| {
                        earlier
                            .iter()
                            .any(|c| c.id == id && card["historyRevision"] == c.stamp)
                    })
            })
        })
        .collect();
    let unindexed = story_history::ranges(&state.missing);
    // 卷纲：目标卷的摘要给写作模型；全书有没有卷纲、目标之后还有几章写好了章纲没写正文，给聊天模型判断下一步。
    let volume_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT CAST(id AS TEXT),COALESCE(json_extract(payload,'$.summary'),'') FROM local_volumes WHERE bookId=? AND deletedAt IS NULL",
    )
    .bind(bid)
    .fetch_all(&mut *db)
    .await
    .map_err(err)?;
    let volume_summary = volume_rows
        .iter()
        .find(|(id, _)| id == volume)
        .map(|(_, summary)| summary.trim().to_owned())
        .unwrap_or_default();
    let any_volume_summary = volume_rows.iter().any(|(_, s)| !s.trim().is_empty());
    let has_plan = |c: &Chapter| {
        c.words == 0
            && c.plan["summary"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
    };
    let planned_ahead = match (target, blank) {
        (Some(_), _) => h.chapters[end + 1..].iter().filter(|c| has_plan(c)).count(),
        (None, Some(first)) => earlier
            .iter()
            .skip_while(|c| c.id != first.id)
            .skip(1)
            .filter(|c| has_plan(c))
            .count(),
        (None, None) => 0,
    };
    let anchor = earlier.last().map(|c| {
        json!({
            "id":c.id,
            "revision":c.stamp,
            "corrections":crate::book_materials::version(&json!(corrections))
        })
    });
    Ok(json!({
        "book":{"title":detail["title"],"platform":detail["platform"],"category":detail["category"],"intro":detail["intro"],
            "styleSkillId": book_style(db, bid).await?, "perspective":detail["perspective"],"voice":detail["voice"],"instruction":detail["globalInstruction"]},
        "previous":previous,
        "unindexedRecent":unindexed_recent,
        "evidence":evidence,
        "notFound":not_found,
        "facts":facts,
        "suspects":suspects,
        "history":{
            "people":people,
            "openThreads":open,
            "authorCorrections":corrections,
            "unindexed":unindexed,
            "knowledgeRule":"人物没有知情记录时属未知；作者明确的更正优先。未揭晓的线索只供保持连续性。"
        },
        "historyAnchor":anchor,
        "coverage":{"eligibleChapters":earlier.iter().filter(|c|c.words>0).count(),"unindexed":unindexed},
        "chapterNo":target.or(blank).map(|c|c.no).unwrap_or(end+1),
        "chapterPlan":plan,
        "volume":{"title":h.volumes.iter().find(|(id,_)|id==volume).map(|(_,title)|title.clone()).unwrap_or_default(),"summary":volume_summary},
        "volumePlanned":any_volume_summary,
        "plannedAhead":planned_ahead,
        "appendAnchor":tail.map(|c|&c.id),
        "target":target_passage,
        "blank":blank_passage,
        "volumeTitle":h.volumes.iter().find(|(id,_)|id==volume).map(|(_,title)|title)
    }))
}
