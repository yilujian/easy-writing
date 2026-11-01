//! Platform tools served by the authenticated Pi host. Book and session identity come from the instance.
use super::control::{Instance, ToolCall};
use crate::writing_records::{book, err, get, put};
use serde_json::{json, Value};
use sqlx::{Connection, Row, SqliteConnection};
use std::{collections::HashSet, path::Path, sync::Arc};

pub const TOOLS: &[&str] = &[
    "list_books",
    "read_book",
    "list_chapters",
    "search_chapters",
    "read_memory",
    "save_skill_draft",
    "plan_chapters",
    "remember_memory",
    "forget_memory",
];

pub async fn execute(
    root: &Path,
    instance: &Arc<Instance>,
    call: &ToolCall,
) -> Result<Value, String> {
    instance.check(call)?;
    if call.tool == "save_skill_draft" {
        let fields = super::skills::candidate_fields(&super::skill_dirs(root), &call.args)?;
        let session = call.args["sessionId"].as_str().ok_or("缺少会话")?;
        let id = format!("{session}:{}", call.call_id);
        let draft = json!({"id":id,"sessionId":session,"bookId":"","kind":"skill","title":fields["name"],"content":fields.to_string(),"replaceId":fields["replaceId"]});
        let registered = instance.call(&call.id)?;
        let saved = super::drafts::commit(root, instance.clone(), registered, draft).await?;
        return Ok(
            json!({"draftId":saved["id"],"title":saved["title"],"status":if saved["appliedAt"].is_number(){"已采用"}else{"技能候选已展示，作者采用后才会安装"}}),
        );
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let bid = call.book["id"].as_str().unwrap_or_default();
    let args = &call.args;
    if call.tool == "plan_chapters"
        || (matches!(call.tool.as_str(), "remember_memory" | "forget_memory")
            && args["prepare"] != true)
    {
        let _writing = instance.writing(call)?;
        let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
        let result = if call.tool == "plan_chapters" {
            book(&mut tx, bid).await?;
            plan_chapters(&mut tx, bid, call).await?
        } else {
            super::memory::tool(&mut tx, &call.tool, args, bid).await?
        };
        let _commit = instance.commit.lock().await;
        instance.check(call)?;
        tx.commit().await.map_err(err)?;
        return Ok(result);
    }
    let mut read = db.begin().await.map_err(err)?;
    let result = match call.tool.as_str() {
        "list_books" => {
            let rows = sqlx::query("SELECT id,title FROM local_books WHERE deletedAt IS NULL ORDER BY updateTime DESC,id")
                .fetch_all(&mut *read).await.map_err(err)?;
            json!(rows.iter().map(|r|json!({"id":r.get::<i64,_>("id").to_string(),"title":r.get::<String,_>("title")})).collect::<Vec<_>>())
        }
        "remember_memory" | "forget_memory" => {
            super::memory::tool(&mut read, &call.tool, args, bid).await?
        }
        "read_memory" => {
            let query = args["query"].as_str().unwrap_or_default().to_lowercase();
            let rows: Vec<_> = super::memory::list(&mut read, bid)
                .await?
                .into_iter()
                .filter(|r| {
                    r["content"]
                        .as_str()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&query)
                })
                .collect();
            let mut chars = 0;
            let items: Vec<_> = rows
                .iter()
                .take_while(|r| {
                    chars += r["content"].as_str().unwrap_or_default().chars().count();
                    chars <= 18_000
                })
                .collect();
            json!({"items":items,"total":rows.len(),"omitted":rows.len()-items.len()})
        }
        "read_book" if args["prepare"] == true => {
            if !bid.is_empty() {
                book(&mut read, bid).await?;
                json!({"ready":true,"book":call.book})
            } else {
                let pending = pending_book(&mut read, args).await?;
                match pending {
                    Some(d) => {
                        json!({"ready":false,"bookDraftId":d["id"],"title":d["title"],"reason":"book_not_adopted"})
                    }
                    None => {
                        json!({"ready":false,"reason":"book_required","status":"请先选择作品或提交新书候选"})
                    }
                }
            }
        }
        _ if bid.is_empty() => {
            let pending = pending_book(&mut read, args).await?;
            return Err(match pending {
                Some(d) => format!(
                    "新书《{}》尚未采用，请先用 prepare_writing 完成作品准备。",
                    d["title"].as_str().unwrap_or_default()
                ),
                None => {
                    "当前对话没有绑定作品，请选择已有作品，或先提交新书候选，再准备写作。".into()
                }
            });
        }
        "read_book" => {
            let data = book(&mut read, bid).await?;
            json!({"id":bid,"title":data["title"],"intro":data["intro"],"tags":data["tags"]})
        }
        "list_chapters" => {
            book(&mut read, bid).await?;
            let tree = chapter_tree(&mut read, bid).await?;
            chapter_page(
                tree,
                args["fromChapter"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok()),
            )
        }
        "search_chapters" => {
            let data = crate::pi_prose_sources::collect(&mut read, bid, args).await?;
            json!({"evidence":data["evidence"],"notFound":data["notFound"],"coverage":data["coverage"],"suspects":data["suspects"],"facts":data["facts"],"people":data["history"]["people"]})
        }
        _ => return Err("未知的平台工具".into()),
    };
    read.commit().await.map_err(err)?;
    Ok(result)
}

async fn pending_book(db: &mut SqliteConnection, args: &Value) -> Result<Option<Value>, String> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/drafts' AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.entity')='book' AND json_extract(value,'$.kind')='entity' AND COALESCE(json_extract(value,'$.appliedAt'),0)=0 AND COALESCE(json_extract(value,'$.dismissedAt'),0)=0 ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 1")
        .bind(args["sessionId"].as_str().unwrap_or_default()).fetch_optional(db).await.map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}

async fn chapter_tree(db: &mut SqliteConnection, bid: &str) -> Result<Vec<Value>, String> {
    let vols: Vec<String> = sqlx::query_scalar("SELECT payload FROM local_volumes WHERE bookId=? AND deletedAt IS NULL ORDER BY sortNo,json_extract(payload,'$.createTime'),id")
        .bind(bid).fetch_all(&mut *db).await.map_err(err)?;
    // The editor stores counts independently, including zero after a chapter is cleared.
    let rows = sqlx::query("SELECT c.volumeId,c.payload,w.wordCount,w.textWordCount FROM local_chapters c LEFT JOIN chapter_contents w ON w.bookId=c.bookId AND w.chapterId=c.id AND w.userId='guest' WHERE c.bookId=? AND c.deletedAt IS NULL ORDER BY c.sortNo,json_extract(c.payload,'$.createTime'),c.id")
        .bind(bid).fetch_all(&mut *db).await.map_err(err)?;
    let mut chapters = std::collections::HashMap::<String, Vec<Value>>::new();
    for row in rows {
        let mut chapter: Value = serde_json::from_str(row.get("payload")).map_err(err)?;
        if let Some(count) = row.get::<Option<i64>, _>("wordCount") {
            chapter["wordCount"] = json!(count);
            chapter["textWordCount"] = json!(row.get::<Option<i64>, _>("textWordCount"));
        }
        chapters
            .entry(row.get("volumeId"))
            .or_default()
            .push(chapter);
    }
    vols.into_iter()
        .map(|raw| {
            let mut v: Value = serde_json::from_str(&raw).map_err(err)?;
            v["children"] = json!(chapters.remove(&v["id"].to_string()).unwrap_or_default());
            v["open"] = json!(true);
            Ok(v)
        })
        .collect()
}

fn chapter_page(tree: Vec<Value>, from: Option<usize>) -> Value {
    let count: usize = tree
        .iter()
        .filter_map(|v| v["children"].as_array())
        .map(Vec::len)
        .sum();
    if count <= 60 && from.is_none() {
        return json!(tree);
    }
    let first = from.unwrap_or_else(|| count.saturating_sub(39)).max(1);
    let mut no = 0;
    json!(tree.iter().map(|v|{
        let children:Vec<_>=v["children"].as_array().into_iter().flatten().filter_map(|c|{
            no+=1;
            (no>=first && no<first.saturating_add(40)).then(||json!({"id":c["id"],"title":c["title"],"chapterNo":no,"hasPlan":!c["summary"].as_str().unwrap_or_default().trim().is_empty(),"hasText":c["wordCount"].as_i64().unwrap_or(0)>0}))
        }).collect();
        json!({"id":v["id"],"title":v["title"],"totalChapters":count,"fromChapter":first,"children":children})
    }).collect::<Vec<_>>())
}

async fn plan_chapters(
    db: &mut SqliteConnection,
    bid: &str,
    call: &ToolCall,
) -> Result<Value, String> {
    const RECEIPTS: &str = "ew-agent-pi/chapter-plans";
    let a = &call.args;
    let sid = a["sessionId"].as_str().ok_or("缺少会话编号")?;
    if call.call_id.is_empty() {
        return Err("缺少调用编号".into());
    }
    let key = json!([sid, call.call_id]).to_string();
    let authorized = json!({"bookId":bid,"volumeId":a["volumeId"],"chapters":a["chapters"]});
    if let Some(saved) = get(db, RECEIPTS, &key).await? {
        if saved["request"] != authorized {
            return Err("同一调用不能提交不同章纲".into());
        }
        return Ok(saved["result"].clone());
    }
    let vid = a["volumeId"].as_str().ok_or("缺少分卷")?;
    let tree = chapter_tree(db, bid).await?;
    let volume = tree
        .iter()
        .find(|v| v["id"].to_string() == vid)
        .ok_or("目标分卷不属于当前作品")?;
    let plans = a["chapters"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 20)
        .ok_or("一次写 1 到 20 章的章纲")?;
    let doc = super::entities::doc(db, bid).await?;
    let known: HashSet<_> = doc["characters"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| {
            c["name"].as_str().into_iter().chain(
                c["aliases"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            )
        })
        .collect();
    let children = volume["children"].as_array().ok_or("分卷目录损坏")?;
    let mut blanks = Vec::new();
    for c in children.iter().rev() {
        if !c["summary"].as_str().unwrap_or_default().trim().is_empty() {
            break;
        }
        let content = crate::writing_records::chapter(db, bid, &c["id"].to_string()).await?;
        if !content["textContent"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            break;
        }
        blanks.push(c);
    }
    blanks.reverse();
    let before = tree
        .iter()
        .take_while(|v| v["id"] != volume["id"])
        .filter_map(|v| v["children"].as_array())
        .map(Vec::len)
        .sum::<usize>();
    let first = before + children.len() - blanks.len() + 1;
    let mut sort = children
        .iter()
        .filter_map(|v| v["sortNo"].as_i64())
        .max()
        .unwrap_or(0)
        .max(0);
    let iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut planned = Vec::new();
    for (i, plan) in plans.iter().enumerate() {
        let title = plan["title"].as_str().unwrap_or_default().trim();
        let summary = plan["summary"].as_str().unwrap_or_default().trim();
        if title.is_empty() || summary.is_empty() {
            return Err(format!("第 {} 条缺标题或章纲", i + 1));
        }
        let strings = |key: &str| -> Result<Vec<String>, String> {
            match plan.get(key) {
                None => Ok(vec![]),
                Some(v) => v
                    .as_array()
                    .ok_or("章纲字段需要字符串数组")?
                    .iter()
                    .map(|item| {
                        item.as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .ok_or_else(|| "章纲条目不能为空".to_owned())
                    })
                    .collect(),
            }
        };
        let characters = strings("characters")?;
        if let Some(name) = characters.iter().find(|n| !known.contains(n.as_str())) {
            return Err(format!(
                "出场人物不在人物表里：{name}。请先提交人物并由作者采用，或去掉这个名字。"
            ));
        }
        let meta = json!({"source":"agent","beats":strings("beats")?,"characters":characters});
        let id = if let Some(c) = blanks.get(i) {
            let id = c["id"].as_i64().ok_or("章节编号无效")?;
            sqlx::query("UPDATE local_chapters SET payload=json_set(payload,'$.title',?,'$.summary',?,'$.planMeta',json(?),'$.updateTime',?) WHERE id=? AND bookId=? AND volumeId=? AND deletedAt IS NULL")
                .bind(title).bind(summary).bind(meta.to_string()).bind(&iso).bind(id).bind(bid).bind(vid).execute(&mut *db).await.map_err(err)?;
            id
        } else {
            let id = super::catalog::allocate(db).await?;
            sort = sort
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or("章序号超出范围")?;
            let c = json!({"id":id,"bookId":bid,"volumeId":vid,"title":title,"summary":summary,"wordCount":0,"textWordCount":0,"sortNo":sort,"status":0,"isPaid":0,"type":"chapter","planMeta":meta,"workflowStatus":null,"createTime":iso,"updateTime":iso,"deletedAt":null});
            sqlx::query("INSERT INTO local_chapters(id,bookId,volumeId,payload,deletedAt,sortNo) VALUES(?,?,?,?,NULL,?)")
                .bind(id).bind(bid).bind(vid).bind(c.to_string()).bind(sort).execute(&mut *db).await.map_err(err)?;
            id
        };
        planned.push(json!({"chapterId":id.to_string(),"chapterNo":first+i,"title":title,"summary":summary,"filledBlank":i<blanks.len()}));
    }
    sqlx::query(include_str!("../../src/storage/sql/update-book-stats.sql"))
        .bind(bid)
        .bind(&iso)
        .execute(&mut *db)
        .await
        .map_err(err)?;
    let result = json!({"volumeId":vid,"planned":planned,"status":format!("已把 {} 章章纲写进目录，作者可在目录里改。",planned.len())});
    put(
        db,
        RECEIPTS,
        &key,
        &json!({"request":authorized,"result":result}),
    )
    .await?;
    Ok(result)
}
