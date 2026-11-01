//! 只从本书开启后的人工修改取改例。候选采用与例句写入共用事务，重试不会增加一份样本。
use crate::writing_records::{book, chapter, delete_by_prefix, err, get, list, now, put};
use serde_json::{json, Value};
use similar::{DiffTag, TextDiff};
use sqlx::SqliteConnection;

const NS: &str = "ew-agent-author/records";
fn setting_key(bid: &str) -> String {
    format!("edit-examples:{bid}")
}
fn draft_key(bid: &str, id: &str) -> String {
    format!("edit-pending:{bid}:{id}")
}
fn origin_key(bid: &str, cid: i64) -> String {
    format!("edit-origin:{bid}:{cid}")
}
fn pair_prefix(bid: &str) -> String {
    format!("edit-pair:{bid}:")
}
pub async fn preference(db: &mut SqliteConnection, bid: &str) -> Result<Value, String> {
    Ok(get(db, NS, &setting_key(bid))
        .await?
        .unwrap_or_else(|| json!({"enabled":false})))
}
pub async fn configure(
    db: &mut SqliteConnection,
    bid: &str,
    enabled: bool,
) -> Result<Value, String> {
    book(db, bid).await?;
    let old = preference(db, bid).await?;
    if old["enabled"] == enabled {
        return Ok(old);
    }
    if !enabled {
        for prefix in [
            pair_prefix(bid),
            format!("edit-origin:{bid}:"),
            format!("edit-pending:{bid}:"),
        ] {
            delete_by_prefix(db, NS, &prefix).await?;
        }
    }
    let setting = json!({"bookId":bid,"enabled":enabled,"epoch":uuid::Uuid::new_v4().to_string()});
    put(db, NS, &setting_key(bid), &setting).await?;
    Ok(setting)
}
fn hash(text: &str) -> String {
    crate::book_materials::version(&json!(text))
}
pub fn stamp_generation(draft: &mut Value, whole: bool) {
    if whole {
        draft["modelTextHash"] = json!(hash(draft["content"].as_str().unwrap_or("")))
    } else if let Some(obj) = draft.as_object_mut() {
        obj.remove("modelTextHash");
    }
}
async fn remove(db: &mut SqliteConnection, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
        .bind(NS)
        .bind(json!(key).to_string())
        .execute(db)
        .await
        .map_err(err)?;
    Ok(())
}
pub async fn before_edit(db: &mut SqliteConnection, d: &Value, human: bool) -> Result<(), String> {
    let Some(bid) = d["bookId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    if !d["proseSource"].is_object() {
        return Ok(());
    }
    let key = draft_key(bid, d["id"].as_str().ok_or("稿件缺少编号")?);
    if !human {
        return remove(db, &key).await;
    }
    let setting = preference(db, bid).await?;
    let body = d["content"].as_str().unwrap_or("");
    if setting["enabled"] == true && d["modelTextHash"] == hash(body) {
        put(db,NS,&key,&json!({"bookId":bid,"epoch":setting["epoch"],"call":d["proseSource"]["callId"],"before":body})).await?;
    }
    Ok(())
}
/// 只记能与模型原文对应的段落。跨段重排、整段新增、无法判断属于哪次改动时跳过。
fn replacements(before: &str, after: &str) -> Vec<(String, String)> {
    let old: Vec<_> = before
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let new: Vec<_> = after
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let unique = |lines: &[&str]| {
        let mut counts = std::collections::HashMap::new();
        for &line in lines {
            *counts.entry(line.to_owned()).or_insert(0usize) += 1;
        }
        counts
    };
    let old_counts = unique(&old);
    let new_counts = unique(&new);
    let diff = TextDiff::from_slices(&old, &new);
    let mut pairs = Vec::new();
    for op in diff.ops() {
        if op.tag() != DiffTag::Replace || op.old_range().len() != op.new_range().len() {
            continue;
        }
        for (a, b) in old[op.old_range()].iter().zip(&new[op.new_range()]) {
            if old_counts.get(*a) != Some(&1)
                || new_counts.get(*b) != Some(&1)
                || new_counts.contains_key(*a)
                || old_counts.contains_key(*b)
            {
                continue;
            }
            if a != b
                && (4..=600).contains(&a.chars().count())
                && (2..=600).contains(&b.chars().count())
            {
                pairs.push((a.to_string(), b.to_string()));
            }
        }
    }
    pairs
}
async fn store_pairs(
    db: &mut SqliteConnection,
    bid: &str,
    cid: i64,
    source: &str,
    changes: Vec<(String, String)>,
) -> Result<(), String> {
    for (before, after) in changes {
        let id = hash(&format!("{source}\n{before}"));
        let key = pair_prefix(bid) + &id;
        if before == after {
            remove(db, &key).await?;
            continue;
        }
        let value = json!({"id":id,"bookId":bid,"chapterId":cid,"before":before,"after":after,"source":source,"updatedAt":now()});
        put(db, NS, &key, &value).await?;
    }
    Ok(())
}
pub async fn adopted(
    db: &mut SqliteConnection,
    d: &Value,
    body: &str,
    version: u64,
) -> Result<(), String> {
    let (Some(bid), Some(cid), Some(id)) = (
        d["bookId"].as_str(),
        d["chapterId"].as_i64(),
        d["id"].as_str(),
    ) else {
        return Ok(());
    };
    if !d["proseSource"].is_object() {
        return Ok(());
    }
    let setting = preference(db, bid).await?;
    if setting["enabled"] != true {
        return Ok(());
    }
    let key = draft_key(bid, id);
    let pending = get(db, NS, &key).await?;
    let content = d["content"].as_str().unwrap_or("");
    let source = pending
        .as_ref()
        .filter(|p| p["epoch"] == setting["epoch"] && p["call"] == d["proseSource"]["callId"])
        .and_then(|p| p["before"].as_str())
        .or_else(|| (d["modelTextHash"] == hash(content)).then_some(content));
    if let Some(original) = source {
        store_pairs(db, bid, cid, id, replacements(original, content)).await?;
        put(db,NS,&origin_key(bid,cid),&json!({"bookId":bid,"chapterId":cid,"draftId":id,"epoch":setting["epoch"],"modelText":original,"lastHash":hash(body),"version":version})).await?;
    } else {
        remove(db, &origin_key(bid, cid)).await?;
    }
    remove(db, &key).await
}
pub async fn editor_saved(
    db: &mut SqliteConnection,
    bid: &str,
    args: &Value,
) -> Result<Value, String> {
    let cid = args["chapterId"].as_i64().ok_or("缺少章节编号")?;
    let key = origin_key(bid, cid);
    let Some(mut source) = get(db, NS, &key).await? else {
        return Ok(json!(false));
    };
    let pref = preference(db, bid).await?;
    if pref["enabled"] != true || pref["epoch"] != source["epoch"] {
        return Ok(json!(false));
    }
    let old = args["before"].as_str().ok_or("缺少编辑前原文")?;
    let version = args["version"].as_u64().ok_or("章节版本无效")?;
    let saved = chapter(db, bid, &cid.to_string()).await?;
    if source["version"].as_u64().is_none_or(|v| v >= version)
        || saved["localVersion"] != version
        || source["lastHash"] != hash(old)
    {
        return Ok(json!(false));
    }
    let after = saved["textContent"].as_str().unwrap_or("");
    let model = source["modelText"].as_str().unwrap_or("");
    let id = source["draftId"].as_str().ok_or("缺少模型原稿来源")?;
    let prior = list(db, NS, &pair_prefix(bid)).await?;
    let mut pairs = Vec::new();
    for (from, to) in replacements(old, after) {
        let original = if model.lines().filter(|s| s.trim() == from).count() == 1 {
            Some(from.as_str())
        } else {
            let mut matches = prior
                .iter()
                .filter(|r| r["source"] == id && r["after"] == from);
            let one = matches.next().and_then(|r| r["before"].as_str());
            if matches.next().is_none() {
                one
            } else {
                None
            }
        };
        if let Some(base) = original {
            pairs.push((base.to_owned(), to));
        }
    }
    store_pairs(db, bid, cid, id, pairs).await?;
    source["version"] = json!(version);
    source["lastHash"] = json!(hash(after));
    put(db, NS, &key, &source).await?;
    Ok(json!(true))
}
pub async fn examples(db: &mut SqliteConnection, bid: &str) -> Result<Vec<Value>, String> {
    if preference(db, bid).await?["enabled"] != true {
        return Ok(Vec::new());
    }
    let mut rows = list(db, NS, &pair_prefix(bid)).await?;
    rows.sort_by_key(|r| std::cmp::Reverse(r["updatedAt"].as_i64().unwrap_or(0)));
    Ok(rows)
}

pub async fn source_options(db: &mut SqliteConnection, bid: &str) -> Result<Vec<Value>, String> {
    book(db, bid).await?;
    let mut options = Vec::new();
    // 只列有真实改例的作品标题。选择之后才读取另一部作品的原句。
    let rows:Vec<(String,String)>=sqlx::query_as("SELECT CAST(b.id AS TEXT),b.title FROM local_books b WHERE b.deletedAt IS NULL AND CAST(b.id AS TEXT)<>?2 AND (EXISTS(SELECT 1 FROM desktop_records d WHERE d.namespace=?1 AND json_extract(d.value,'$.bookId')=CAST(b.id AS TEXT) AND d.key LIKE '\"edit-pair:%') OR EXISTS(SELECT 1 FROM chapter_chunks c WHERE c.bookId=CAST(b.id AS TEXT) AND c.provenance='author_confirmed')) ORDER BY b.title")
        .bind(NS).bind(bid).fetch_all(&mut *db).await.map_err(err)?;
    // 只列作者自己写过、有确认样本的书。拆书库里的参考书没有分类，整库列出来等于乱拿；
    // 参考书的写法要进正文，走蒸馏出的文风技能或作品默认文风，不在这里直接当范文。
    let mut seen = std::collections::HashSet::new();
    for (id, title) in rows {
        if !seen.insert(title.clone()) {
            continue;
        }
        options.push(json!({"id":format!("book/{id}"),"title":format!("我的《{title}》")}));
    }
    Ok(options)
}
pub async fn reference_samples(
    db: &mut SqliteConnection,
    selected: &str,
) -> Result<Vec<Value>, String> {
    let Some(pid) = selected.strip_prefix("reference/") else {
        return Err("参考书编号无效".into());
    };
    let mut samples = Vec::new();
    for c in crate::reference_books::catalog(db, pid).await? {
        let cid = c["id"].to_string();
        let ch = crate::reference_books::chapter(db, pid, &cid).await?;
        let Some(body) = ch["textContent"].as_str() else {
            continue;
        };
        if body.trim().is_empty() {
            continue;
        }
        let text: String = body.chars().take(1200).collect();
        samples.push(json!({"id":format!("{selected}:{cid}:{}",hash(&text)),"text":text,"from":ch["title"],"external":true}));
        if samples.len() == 3 {
            break;
        }
    }
    Ok(samples)
}

/// 取作者在写作台明确选作范文的片段。正文必须仍是确认的版本，改写早期章节时排除后文章节。
pub async fn personal_passages(
    db: &mut SqliteConnection,
    bid: &str,
    before: Option<usize>,
    query: &str,
) -> Result<Vec<Value>, String> {
    let allowed = crate::writing_records::catalog(db, bid)
        .await?
        .into_iter()
        .take(before.unwrap_or(usize::MAX))
        .map(|c| c["id"].to_string())
        .collect::<std::collections::HashSet<_>>();
    let material = crate::writing_style::examples(db, bid, query).await?;
    Ok(material
        .into_iter()
        .filter(|s| {
            s["source"]["type"] == "sample"
                && s["source"]["chapterId"]
                    .as_str()
                    .is_some_and(|id| allowed.contains(id))
        })
        .take(3)
        .map(|s| json!({"id":s["id"],"from":"作者确认的范文","text":s["text"]}))
        .collect())
}
