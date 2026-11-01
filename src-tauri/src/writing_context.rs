//! 上下文引擎：把作品状态层按 token 预算装配成分层上下文，Agent 对话、写作台与工作流共用。
//!
//! 分层只决定资料的相关性和保留顺序，不设置独立容量上限。
//! 仅当必要输入超过所选模型扣除输出预留后的容量时返回 budgetExceeded。
//! 不静默丢弃；其余层优先保留一个表达示例，裁剪均记录；必要事实与任务不静默删除。
//! 每个块都带来源，调用方可以像 `capture_context` 一样留下证据。
use crate::book_notes::NS;
use crate::story_index as indexer;
use crate::story_state as canon;
use crate::writing_records::{catalog, chapter, err, get, list};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

/// 与 AI 调用账本的估算口径一致。
pub const CHARS_PER_TOKEN: f64 = 1.7;
/// 续写时紧挨着写作指令的前文原文字数；预算不够才减半。
pub const PREVIOUS_TAIL_CHARS: usize = 3000;
const RECENT_CARDS: usize = 5;

pub struct ContextRequest<'a> {
    pub book_id: &'a str,
    /// write | review | chat | ghost | short
    pub purpose: &'a str,
    /// 目标章；None 表示接在最后一章之后写新章
    pub chapter_id: Option<&'a str>,
    pub query_hint: Option<&'a str>,
    pub characters_hint: Vec<String>,
    pub model_max_context: usize,
    pub output_reserve: usize,
    /// Optional retrieval target; never a hard cap on author requirements or selected skills.
    pub budget_tokens: Option<usize>,
}

pub fn estimate_tokens(text: &str) -> usize {
    (text.chars().count() as f64 / CHARS_PER_TOKEN).ceil() as usize
}

fn block(label: &str, text: String, source: Value) -> Value {
    json!({"label":label,"tokens":estimate_tokens(&text),"text":text,"source":source})
}

fn tokens_of(blocks: &[Value]) -> usize {
    blocks
        .iter()
        .map(|b| b["tokens"].as_u64().unwrap_or(0) as usize)
        .sum()
}

/// 去掉 HTML 标签，保留文字。
pub fn strip_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_owned()
}

/// 从末尾按段落取不超过 `max_chars` 的文字，不在句中切断。
pub fn tail_by_paragraph(text: &str, max_chars: usize) -> String {
    let paragraphs: Vec<&str> = text
        .split('\n')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let mut kept: Vec<String> = Vec::new();
    let mut count = 0;
    for paragraph in paragraphs.iter().rev() {
        let length = paragraph.chars().count();
        if count + length > max_chars && !kept.is_empty() {
            break;
        }
        if count + length > max_chars {
            // 单段就超预算：截断保留末尾
            let cut: String = paragraph
                .chars()
                .rev()
                .take(max_chars)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            kept.push(cut);
            break;
        }
        kept.push((*paragraph).to_owned());
        count += length;
    }
    kept.reverse();
    kept.join("\n")
}

fn total_tokens(layers: [&Vec<Value>; 5]) -> usize {
    layers.iter().map(|layer| tokens_of(layer)).sum()
}

fn state_summary(state: &Value) -> String {
    let s = &state["state"];
    let items = s["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let goals = s["goals"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("；")
        })
        .unwrap_or_default();
    format!(
        "{}：{}；位置 {}；境界 {}；持有 {}；目标 {}；截至第 {} 章",
        state["name"].as_str().unwrap_or("人物"),
        match s["alive"].as_bool() {
            Some(true) => "存活",
            Some(false) => "已死亡",
            None => "生死未记录",
        },
        s["location"].as_str().unwrap_or("未知"),
        s["realm"].as_str().unwrap_or("未知"),
        if items.is_empty() {
            "无记录".to_owned()
        } else {
            items
        },
        if goals.is_empty() {
            "无记录".to_owned()
        } else {
            goals
        },
        state["asOfChapter"].as_str().unwrap_or("?")
    )
}

async fn volume_stage(
    db: &mut SqliteConnection,
    book_id: &str,
    volume_id: &str,
) -> Result<Option<String>, String> {
    let raw: Option<String> = sqlx::query_scalar("SELECT payload FROM local_volumes WHERE bookId=? AND CAST(id AS TEXT)=? AND deletedAt IS NULL")
        .bind(book_id)
        .bind(volume_id)
        .fetch_optional(&mut *db)
        .await
        .map_err(err)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let volume: Value = serde_json::from_str(&raw).map_err(err)?;
    let mut parts = Vec::new();
    if let Some(summary) = volume["summary"].as_str().filter(|s| !s.trim().is_empty()) {
        parts.push(strip_html(summary));
    }
    for stage in volume["planMeta"]["stages"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let goal = stage["goal"].as_str().unwrap_or("");
        if !goal.is_empty() {
            parts.push(format!(
                "阶段目标：{goal}；起点 {}；终点 {}",
                stage["startState"].as_str().unwrap_or(""),
                stage["endState"].as_str().unwrap_or("")
            ));
        }
    }
    Ok(if parts.is_empty() {
        None
    } else {
        Some(format!(
            "《{}》\n{}",
            volume["title"].as_str().unwrap_or("本卷"),
            parts.join("\n")
        ))
    })
}

pub async fn assemble(
    db: &mut SqliteConnection,
    req: &ContextRequest<'_>,
) -> Result<Value, String> {
    let ghost = req.purpose == "ghost";
    let total = req.model_max_context.saturating_sub(req.output_reserve);
    let book_id = req.book_id;
    let entries = catalog(db, book_id).await?;
    let ids: Vec<String> = entries.iter().map(|c| c["id"].to_string()).collect();
    let cursor = match req.chapter_id {
        Some(cid) => ids.iter().position(|id| id == cid).unwrap_or(ids.len()),
        None => ids.len(),
    };
    let previous_index = cursor.checked_sub(1);
    let materials = crate::book_materials::materials(db, book_id).await?;
    let history = crate::story_history::History::load(db, book_id).await?;
    let end = if let Some(cid) = req.chapter_id {
        history.boundary(&json!({"chapterId":cid}))?
    } else {
        history.chapters.len()
    };
    let snapshot = crate::story_history::snapshot(db, book_id, &history, end).await?;
    let valid: std::collections::HashMap<_, _> = history.chapters[..end]
        .iter()
        .filter_map(|c| history.verified(c).map(|card| (c.id.as_str(), card)))
        .collect();
    let card_for = |cid: &str| valid.get(cid).copied();
    let mut sources: Vec<Value> = vec![
        json!({"type":"materials","bookId":book_id,"revision":crate::book_materials::story_version(&materials)}),
    ];
    let mut omitted: Vec<String> = Vec::new();

    // ---------------- 固定层 ----------------
    let mut fixed: Vec<Value> = Vec::new();
    if !ghost {
        let memories = list(db, NS, "memory:").await?;
        // 作者层偏好：跨作品生效的指令式一句话，按观察时间排序，最新的在后
        let mut preferences = memories
            .iter()
            .filter(|m| {
                m["scope"] == "author"
                    && m["status"] == "active"
                    && m["kind"] == "decision"
                    && !m["deletedAt"].is_number()
            })
            .collect::<Vec<_>>();
        preferences.sort_by_key(|m| {
            m["observedAt"]
                .as_i64()
                .or_else(|| m["createdAt"].as_i64())
                .unwrap_or(0)
        });
        let preferences = preferences
            .into_iter()
            .filter_map(|m| m["content"].as_str().map(|c| format!("- {c}")))
            .collect::<Vec<_>>();
        if !preferences.is_empty() {
            fixed.push(block(
                "作者偏好（对所有作品生效）",
                preferences.join("\n"),
                json!({"type":"author-memory"}),
            ));
        }
        let rejected = memories
            .into_iter()
            .filter(|m| {
                m["bookId"] == book_id && m["status"] == "rejected" && !m["deletedAt"].is_number()
            })
            .filter_map(|m| m["content"].as_str().map(|c| format!("- {c}")))
            .collect::<Vec<_>>();
        if !rejected.is_empty() {
            fixed.push(block(
                "否决约束（绝不能当作已发生事实）",
                rejected.join("\n"),
                json!({"type":"memory"}),
            ));
        }
    }
    let rules = canon::list_rules(db, Some(book_id)).await?;
    let lines = rules
        .iter()
        .map(|r| {
            format!(
                "- [{}] {}",
                r["category"].as_str().unwrap_or(""),
                r["text"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>();
    if !lines.is_empty() {
        fixed.push(block("作者规则", lines.join("\n"), json!({"type":"rules"})));
    }
    if !ghost {
        let profile_id = canon::book_profile_id(db, book_id).await?;
        let profile = canon::platform_profile(db, &profile_id).await?;
        fixed.push(block(
            &format!("平台画像：{}", profile["name"].as_str().unwrap_or("")),
            canon::profile_summary(&profile),
            json!({"type":"profile","profileId":profile_id}),
        ));
    }
    if !ghost {
        let mut core = Vec::new();
        let systems = materials["worldSettings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| matches!(w["type"].as_i64(), Some(2) | Some(4)))
            .map(|w| {
                format!(
                    "{}：{}",
                    w["name"].as_str().unwrap_or(""),
                    strip_html(w["detail"].as_str().unwrap_or(""))
                )
            })
            .collect::<Vec<_>>();
        if !systems.is_empty() {
            core.push(format!("等级与功法：{}", systems.join("、")));
        }
        for node in materials["outlineNodes"].as_array().into_iter().flatten() {
            let root = node["parentId"] == "0" || node["parentId"] == 0;
            if !root {
                continue;
            }
            let content = strip_html(node["content"].as_str().unwrap_or(""));
            core.push(format!(
                "{}：{}",
                node["title"].as_str().unwrap_or("大纲"),
                content
            ));
        }
        if !core.is_empty() {
            fixed.push(block(
                "核心设定",
                core.join("\n"),
                json!({"type":"materials"}),
            ));
        }
        let characters = materials["characters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| {
                c["role"] == 0
                    || req
                        .characters_hint
                        .iter()
                        .any(|hint| c["name"] == hint.as_str() || c["id"].to_string() == *hint)
            })
            .cloned()
            .collect::<Vec<_>>();
        if !characters.is_empty() {
            fixed.push(block(
                "本章人物资料",
                serde_json::to_string(&characters).map_err(err)?,
                json!({"type":"materials"}),
            ));
        }
    }
    // 主角当前状态：以目标章之前最近一张有效章节卡为准
    let reference_chapter = cursor.checked_sub(1).and_then(|start| {
        (0..=start)
            .rev()
            .map(|i| ids[i].clone())
            .find(|cid| card_for(cid).is_some())
    });
    let protagonists = materials["characters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["role"] == 0)
        .map(|c| c["id"].to_string())
        .collect::<Vec<_>>();
    if let Some(reference) = &reference_chapter {
        let mut lines = Vec::new();
        for pid in &protagonists {
            let state = snapshot.person(pid, reference);
            if state["known"] == true {
                lines.push(state_summary(&state));
            }
        }
        if !lines.is_empty() {
            fixed.push(block(
                "主角当前状态",
                lines.join("\n"),
                json!({"type":"state","asOfChapter":reference}),
            ));
        }
    }

    // ---------------- 相关层 ----------------
    let mut related: Vec<Value> = Vec::new();
    if !ghost {
        if let Some(reference) = &reference_chapter {
            for hint in &req.characters_hint {
                let resolved = materials["characters"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|c| {
                        c["name"] == hint.as_str()
                            || c["id"].to_string() == *hint
                            || c["aliases"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|x| x == hint.as_str()))
                    })
                    .map(|c| c["id"].to_string());
                let Some(cid) = resolved else {
                    omitted.push(format!("人物未登记：{hint}"));
                    continue;
                };
                if protagonists.contains(&cid) {
                    continue;
                }
                let state = snapshot.person(&cid, reference);
                if state["known"] == true {
                    related.push(block(
                        &format!("人物状态：{hint}"),
                        state_summary(&state),
                        json!({"type":"state","characterId":cid,"asOfChapter":reference}),
                    ));
                }
            }
        }
        let threads: Vec<_> = snapshot.threads.values().collect();
        if !threads.is_empty() {
            let lines = threads
                .iter()
                .rev()
                .take(10)
                .map(|t| {
                    format!(
                        "- [{}] {}（埋于章节 {}）",
                        t["kind"].as_str().unwrap_or(""),
                        t["title"].as_str().unwrap_or(""),
                        t["origin"]["chapterId"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>();
            related.push(block(
                "未回收线索",
                lines.join("\n"),
                json!({"type":"threads"}),
            ));
        }
        if req.purpose == "review" {
            let suspects: Vec<_> = canon::list_suspects(db, book_id)
                .await?
                .into_iter()
                .filter(|s| {
                    s["chapterId"]
                        .as_str()
                        .is_some_and(|id| valid.contains_key(id))
                })
                .collect();
            if !suspects.is_empty() {
                let lines = suspects
                    .iter()
                    .take(10)
                    .map(|s| {
                        format!(
                            "- {}（章节 {}）",
                            s["message"].as_str().unwrap_or(""),
                            s["chapterId"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>();
                related.push(block(
                    "待作者裁决的疑点",
                    lines.join("\n"),
                    json!({"type":"suspects"}),
                ));
            }
        }
        if let Some(hint) = req.query_hint.map(str::trim).filter(|h| !h.is_empty()) {
            let allowed: Vec<_> = ids[..cursor].iter().map(String::as_str).collect();
            for hit in indexer::bounded_chunks(db, book_id, hint, &allowed, 8).await? {
                let cid = hit["chapterId"].as_str().unwrap_or("").to_owned();
                let position = ids.iter().position(|id| *id == cid);
                if position.is_some_and(|p| p >= cursor) {
                    continue; // 只用目标章之前的正文
                }
                let title = entries
                    .iter()
                    .find(|c| c["id"].to_string() == cid)
                    .and_then(|c| c["title"].as_str())
                    .unwrap_or("章节");
                related.push(block(
                    &format!("相关前文：{title}"),
                    hit["text"].as_str().unwrap_or("").to_owned(),
                    json!({"type":"chunk","chapterId":cid,"seq":hit["seq"]}),
                ));
                if related.len() >= 12 {
                    break;
                }
            }
            let entity_hits: Vec<_> = indexer::search_entities(db, book_id, hint, i64::MAX)
                .await?
                .into_iter()
                .filter(|hit| {
                    hit["chapterId"]
                        .as_str()
                        .is_some_and(|id| valid.contains_key(id))
                })
                .take(20)
                .collect();
            if !entity_hits.is_empty() {
                let chapters = entity_hits
                    .iter()
                    .filter_map(|e| e["chapterId"].as_str())
                    .collect::<Vec<_>>()
                    .join("、");
                related.push(block(
                    &format!("“{hint}”出现的章节"),
                    chapters,
                    json!({"type":"entities"}),
                ));
            }
        }
    }

    // ---------------- 邻近层 ----------------
    let mut adjacent: Vec<Value> = Vec::new();
    let mut tail_limit = if ghost { 1000 } else { PREVIOUS_TAIL_CHARS };
    let mut previous_text: Option<(String, String, String)> = None; // (chapterId, title, text)
    if let Some(index) = previous_index {
        let cid = ids[index].clone();
        let body = chapter(db, book_id, &cid).await?;
        let text = body["textContent"].as_str().unwrap_or("").to_owned();
        if !text.trim().is_empty() {
            let revision = crate::book_materials::version(&json!([
                body["localVersion"],
                body["title"],
                body["textContent"]
            ]));
            sources.push(
                json!({"type":"chapter","bookId":book_id,"chapterId":cid,"revision":revision}),
            );
            previous_text = Some((
                cid.clone(),
                body["title"].as_str().unwrap_or("上一章").to_owned(),
                text,
            ));
        }
        if !ghost {
            // 上一章本身也进概要：末尾只给了它的结尾，一句话概要才说明这一章讲了什么
            let mut lines = Vec::new();
            let start = (index + 1).saturating_sub(RECENT_CARDS);
            for i in start..=index {
                if let Some(card) = card_for(&ids[i]) {
                    lines.push(format!(
                        "- {}：{}",
                        entries[i]["title"].as_str().unwrap_or(""),
                        card["card"]["oneLine"].as_str().unwrap_or("")
                    ));
                    sources.push(json!({"type":"chapter","bookId":book_id,"chapterId":ids[i],"revision":card["sourceRevision"]}));
                }
            }
            if !lines.is_empty() {
                adjacent.push(block(
                    "前几章概要",
                    lines.join("\n"),
                    json!({"type":"cards"}),
                ));
            }
            if let Some(volume_id) = entries[index]["volumeId"].as_str() {
                if let Some(stage) = volume_stage(db, book_id, volume_id).await? {
                    adjacent.push(block(
                        "本卷阶段",
                        stage,
                        json!({"type":"volume","volumeId":volume_id}),
                    ));
                }
            }
        }
    }
    let push_tail =
        |adjacent: &mut Vec<Value>, previous: &Option<(String, String, String)>, limit: usize| {
            if let Some((cid, title, text)) = previous {
                let tail = tail_by_paragraph(text, limit);
                adjacent.retain(|b| b["source"]["type"] != "previousTail");
                adjacent.insert(
                    0,
                    block(
                        &format!("上一章末尾：{title}"),
                        tail,
                        json!({"type":"previousTail","chapterId":cid,"chars":limit}),
                    ),
                );
            }
        };
    push_tail(&mut adjacent, &previous_text, tail_limit);

    // ---------------- 风格层 ----------------
    let mut style: Vec<Value> = Vec::new();
    if !ghost {
        if let Some(profile) = get(db, canon::CANON_NS, &format!("style:{book_id}")).await? {
            if let Some(points) = profile["points"]
                .as_str()
                .filter(|p| profile["locked"] == true && !p.is_empty())
            {
                fixed.push(block(
                    "作者文风要点",
                    points.to_owned(),
                    json!({"type":"style"}),
                ));
            }
        }
        for example in
            crate::writing_style::personal_examples(db, book_id, req.query_hint.unwrap_or(""))
                .await?
        {
            style.push(crate::writing_style::example_block(&example));
        }
    }

    // ---------------- 任务层 ----------------
    let mut task: Vec<Value> = Vec::new();
    if let Some(cid) = req.chapter_id {
        if let Some(entry) = entries.iter().find(|c| c["id"].to_string() == cid) {
            let mut lines = Vec::new();
            if let Some(summary) = entry["summary"].as_str().filter(|s| !s.trim().is_empty()) {
                lines.push(format!("章纲：{}", strip_html(summary)));
            }
            let beats = &entry["planMeta"]["expandedOutline"];
            if beats.is_object() {
                lines.push(format!("细纲：{beats}"));
            }
            if !lines.is_empty() {
                task.push(block(
                    &format!("本章：{}", entry["title"].as_str().unwrap_or("")),
                    lines.join("\n"),
                    json!({"type":"chapterPlan","chapterId":cid}),
                ));
            }
        }
    }

    // ---------------- 裁剪 ----------------
    let mut seen = std::collections::BTreeSet::new();
    for layer in [
        &mut fixed,
        &mut task,
        &mut adjacent,
        &mut related,
        &mut style,
    ] {
        layer.retain(|b| seen.insert(b["text"].as_str().unwrap_or("").trim().to_owned()));
    }
    let required = tokens_of(&fixed)
        + tokens_of(&task)
        + related
            .iter()
            .filter(|b| b["source"]["type"] == "state")
            .map(|b| b["tokens"].as_u64().unwrap_or(0) as usize)
            .sum::<usize>()
        + style
            .iter()
            .filter(|b| b["required"] == true)
            .map(|b| b["tokens"].as_u64().unwrap_or(0) as usize)
            .sum::<usize>();
    let retrieval_target = req.budget_tokens.unwrap_or(total).max(required).min(total);
    while total_tokens([&fixed, &related, &adjacent, &style, &task]) > retrieval_target {
        // Keep a relevant expression example while expendable retrieval/context remains.
        if style
            .iter()
            .filter(|b| b["source"]["exampleId"].is_string())
            .count()
            > 1
        {
            if let Some(pos) = style
                .iter()
                .rposition(|b| b["source"]["exampleId"].is_string() && b["required"] != true)
            {
                omitted.push(style.remove(pos)["label"].as_str().unwrap_or("").to_owned());
                continue;
            }
        }
        if let Some(pos) = related.iter().rposition(|b| b["source"]["type"] == "chunk") {
            omitted.push(
                related.remove(pos)["label"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            );
            continue;
        }
        if let Some(pos) = adjacent.iter().position(|b| b["source"]["type"] == "cards") {
            omitted.push(
                adjacent.remove(pos)["label"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            );
            continue;
        }
        if tail_limit > 300 && previous_text.is_some() {
            tail_limit /= 2;
            push_tail(&mut adjacent, &previous_text, tail_limit);
            continue;
        }
        let dropped = related
            .iter()
            .rposition(|b| b["source"]["type"] != "state")
            .map(|p| related.remove(p))
            .or_else(|| {
                style
                    .iter()
                    .rposition(|b| b["required"] != true)
                    .map(|p| style.remove(p))
            });
        if let Some(dropped) = dropped {
            omitted.push(dropped["label"].as_str().unwrap_or("").to_owned());
            continue;
        }
        break;
    }
    let estimated = total_tokens([&fixed, &related, &adjacent, &style, &task]);
    if estimated > total {
        return Ok(
            json!({"ok":false,"budgetExceeded":{"estimatedTokens":estimated,"limit":total,
            "modelContext":req.model_max_context,"outputReserve":req.output_reserve,
            "layers":{"requirements":tokens_of(&fixed),"task":tokens_of(&task),"adjacent":tokens_of(&adjacent),"related":tokens_of(&related),"style":tokens_of(&style)},
            "message":"必要输入加输出预留超过所选模型的上下文容量；作者要求与技能均未截断，请调整任务范围或模型容量"}}),
        );
    }
    Ok(
        json!({"ok":true,"purpose":req.purpose,"bookId":book_id,"targetChapterId":req.chapter_id,"cursor":cursor,
        "layers":{"fixed":fixed,"related":related,"adjacent":adjacent,"style":style,"task":task},
        "sources":sources,"omitted":omitted,"estimatedTokens":estimated,
        "budget":{"total":total,"modelContext":req.model_max_context,"outputReserve":req.output_reserve,"previousTailChars":tail_limit}}),
    )
}

/// 把分层上下文渲染成模型可读的文本，层序即优先级。
pub fn render(context: &Value) -> String {
    let mut sections = Vec::new();
    for layer in ["fixed", "task", "adjacent", "related", "style"] {
        for block in context["layers"][layer].as_array().into_iter().flatten() {
            sections.push(format!(
                "【{}】\n{}",
                block["label"].as_str().unwrap_or(""),
                block["text"].as_str().unwrap_or("")
            ));
        }
    }
    sections.join("\n\n")
}
