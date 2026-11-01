//! 参考书分批导入：暂存不可见，确认后一次发布目录；正文检索在独立短事务里补齐。
use crate::{desktop_storage, reference_books as book, story_state as canon, writing_records::*};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use std::{collections::BTreeMap, path::Path};

fn project_version(p: &Value) -> String {
    crate::book_materials::version(&json!([p["title"], p["chapters"], p["updateTime"]]))
}

fn staging(token: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(token).map_err(err)?;
    Ok(format!("ew-reference-import/{token}"))
}
fn digest_part(hash: &mut Sha256, text: &str) {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    hash.update(compact.as_bytes());
}
fn result(p: &Value, existing: bool) -> Value {
    let pid = p["id"].to_string();
    json!({"projectId":pid,"bookId":book::book_id(&pid),"title":p["title"],"chapters":p["chapters"].as_array().map_or(0,Vec::len),"words":p["wordCount"],"existing":existing})
}
async fn content_hash(db: &mut SqliteConnection, p: &Value) -> Result<String, String> {
    let mut hash = Sha256::new();
    for chapter in p["chapters"].as_array().into_iter().flatten() {
        digest_part(&mut hash, chapter["title"].as_str().unwrap_or(""));
        let content = get(
            db,
            book::BREAKDOWN_NS,
            &format!("content:{}", chapter["id"]),
        )
        .await?
        .ok_or("参考书正文缺失")?;
        for paragraph in content["paragraphs"].as_array().into_iter().flatten() {
            digest_part(&mut hash, paragraph.as_str().unwrap_or(""));
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// 先用文件指纹快速找；旧记录用正文指纹匹配，不以书名判断相同内容。优先复用已有章节卡最多的一份。
pub async fn find(db: &mut SqliteConnection, source: &str, content: &str) -> Result<Value, String> {
    if source.is_empty() && content.is_empty() {
        return Ok(Value::Null);
    }
    let mut best: Option<(usize, Value)> = None;
    for mut p in list(db, book::BREAKDOWN_NS, "project:").await? {
        let version = project_version(&p);
        let changed = p["fingerprintVersion"].is_string() && p["fingerprintVersion"] != version;
        if changed {
            p["sourceHash"] = Value::Null;
            p["contentHash"] = Value::Null;
            p["normalizedHashV2"] = Value::Null;
        }
        let mut matched = !source.is_empty() && p["sourceHash"] == source;
        if !matched && !content.is_empty() {
            if !p["contentHash"].is_string() {
                let Ok(hash) = content_hash(db, &p).await else {
                    continue;
                };
                let updated = p["updateTime"].as_str().map(str::to_owned);
                p["contentHash"] = json!(hash);
                sqlx::query("UPDATE desktop_records SET value=json_set(value,'$.contentHash',?,'$.fingerprintVersion',?,'$.sourceHash',?,'$.normalizedHashV2',?) WHERE namespace=? AND key=? AND json_extract(value,'$.updateTime') IS ?")
                    .bind(&hash).bind(&version).bind(p["sourceHash"].as_str()).bind(p["normalizedHashV2"].as_str()).bind(book::BREAKDOWN_NS).bind(json!(format!("project:{}",p["id"])).to_string()).bind(updated).execute(&mut *db).await.map_err(err)?;
            }
            matched = p["contentHash"] == content || p["normalizedHashV2"] == content;
        }
        if matched {
            let count = book::active_card_chapters(db, &book::book_id(&p["id"].to_string()))
                .await?
                .len();
            if best.as_ref().is_none_or(|(old, _)| count > *old) {
                best = Some((count, p));
            }
        }
    }
    Ok(best.map(|(_, p)| result(&p, true)).unwrap_or(Value::Null))
}

pub async fn command(root: &Path, action: &str, args: &Value) -> Result<Value, String> {
    let mut db = desktop_storage::connect_existing_at(root).await?;
    if action == "reference_publication" {
        let p = book::project(&mut db, str_field(args, "projectId")?).await?;
        return Ok(json!({"saved":p["visibility"]!="conversation"}));
    }
    if action == "reference_publish" {
        let pid = str_field(args, "projectId")?;
        let mut tx = desktop_storage::begin_write(&mut db).await?;
        let mut p = book::project(&mut tx, pid).await?;
        if p["visibility"] == "conversation" {
            p["visibility"] = json!("workbench");
            p["workbenchSavedAt"] = json!(now());
            put(&mut tx, book::BREAKDOWN_NS, &format!("project:{pid}"), &p).await?;
        }
        tx.commit().await.map_err(err)?;
        return Ok(json!({"projectId":pid,"saved":true}));
    }
    if action == "reference_find" {
        return find(
            &mut db,
            args["sourceHash"].as_str().unwrap_or(""),
            args["contentHash"].as_str().unwrap_or(""),
        )
        .await;
    }
    if action == "reference_candidates" {
        return Ok(json!(list(&mut db, book::BREAKDOWN_NS, "project:")
            .await?
            .into_iter()
            .filter(|p| p["title"] == args["title"] && !p["normalizedHashV2"].is_string())
            .map(|p| json!({"projectId":p["id"].to_string()}))
            .collect::<Vec<_>>()));
    }
    if action == "reference_remember" {
        let pid = str_field(args, "projectId")?;
        let mut tx = desktop_storage::begin_write(&mut db).await?;
        let mut p = book::project(&mut tx, pid).await?;
        if project_version(&p) != args["expectedVersion"].as_str().unwrap_or("") {
            return Err("参考书在查重时已改变，请重试".into());
        }
        p["normalizedHashV2"] = args["contentHash"].clone();
        p["fingerprintVersion"] = json!(project_version(&p));
        put(&mut tx, book::BREAKDOWN_NS, &format!("project:{pid}"), &p).await?;
        tx.commit().await.map_err(err)?;
        return Ok(json!(true));
    }
    if action == "reference_export" {
        let pid = str_field(args, "projectId")?;
        let p = book::project(&mut db, pid).await?;
        let chapters = p["chapters"].as_array().ok_or("章节目录无效")?;
        let offset = args["offset"].as_u64().unwrap_or(0) as usize;
        let mut items = Vec::new();
        for ch in chapters.iter().skip(offset).take(8) {
            let c = get(
                &mut db,
                book::BREAKDOWN_NS,
                &format!("content:{}", ch["id"]),
            )
            .await?
            .ok_or("正文缺失")?;
            let text = c["paragraphs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            items.push(json!({"title":ch["title"],"text":text}));
        }
        return Ok(
            json!({"title":p["title"],"chapters":items,"total":chapters.len(),"version":project_version(&p)}),
        );
    }
    let mut tx = desktop_storage::begin_write(&mut db).await?;
    // 崩溃或关窗留下的不可见暂存，24 小时后回收；正式正文和修复历史不在此命名空间。
    if action == "reference_begin" {
        sqlx::query("DELETE FROM desktop_records WHERE namespace IN (SELECT namespace FROM desktop_records WHERE namespace LIKE 'ew-reference-import/%' AND key='\"meta\"' AND json_extract(value,'$.updatedAt') < ?)")
            .bind(now()-86_400_000).execute(&mut *tx).await.map_err(err)?;
    }
    let out = match action {
        "reference_begin" => {
            let total = args["total"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= book::IMPORT_MAX_CHAPTERS as u64)
                .ok_or("章节数量无效")?;
            let token = id();
            let ns = staging(&token)?;
            let mut base = now() * 1000;
            while sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM desktop_records WHERE (namespace=? AND (key=? OR (key LIKE '\"content:%' AND CAST(substr(json_extract(key,'$'),9) AS INTEGER) BETWEEN ? AND ?))) OR (namespace LIKE 'ew-reference-import/%' AND key='\"meta\"' AND json_extract(value,'$.id') BETWEEN ? AND ?)")
                .bind(book::BREAKDOWN_NS).bind(json!(format!("project:{base}")).to_string()).bind(base).bind(base+total as i64+1)
                .bind(base-20_001).bind(base+20_001).fetch_one(&mut *tx).await.map_err(err)? > 0 { base+=100_000; }
            let replace = args["replaceProjectId"].as_str().unwrap_or("");
            let mut reuse = BTreeMap::<String, Vec<i64>>::new();
            if !replace.is_empty() {
                let p = book::project(&mut tx, replace).await?;
                if project_version(&p) != args["expectedVersion"].as_str().unwrap_or("") {
                    return Err("参考书已改变，请重新打开修复".into());
                }
                if crate::story_index::pending(&mut tx, Some(&book::book_id(replace))).await? > 0 {
                    return Err("请先暂停并取消该书的拆书任务，再修复分章；已拆结果会保留".into());
                }
                for ch in p["chapters"].as_array().into_iter().flatten() {
                    let content = get(
                        &mut tx,
                        book::BREAKDOWN_NS,
                        &format!("content:{}", ch["id"]),
                    )
                    .await?
                    .ok_or("旧章节正文缺失")?;
                    let body = content["paragraphs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n");
                    let c = json!({"title":ch["title"],"textContent":body});
                    reuse
                        .entry(book::version_of(&c))
                        .or_default()
                        .push(ch["id"].as_i64().ok_or("章节编号无效")?);
                }
            }
            put(&mut tx, &ns, "meta", &json!({"id":base,"title":str_field(args,"title")?,"total":total,"received":0,"words":0,"catalog":[],
                "sourceHash":args["sourceHash"],"contentHash":args["contentHash"],"notes":args["notes"],"replaceProjectId":replace,
                "expectedVersion":args["expectedVersion"],"reuse":reuse,"updatedAt":now(),
                "maxChapterChars":if args["preserveLongChapters"]==true {60*1024*1024}else{book::IMPORT_MAX_CHAPTER_CHARS}})).await?;
            json!({"token":token})
        }
        "reference_append" => {
            let ns = staging(str_field(args, "token")?)?;
            let mut meta = get(&mut tx, &ns, "meta").await?.ok_or("导入已取消或过期")?;
            let offset = args["offset"].as_u64().ok_or("缺少分批位置")?;
            if offset != meta["received"].as_u64().unwrap_or(0) {
                return Err("导入批次顺序不一致，请重新导入".into());
            }
            let items = args["chapters"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 8)
                .ok_or("单批最多 8 章")?;
            if offset + items.len() as u64 > meta["total"].as_u64().unwrap_or(0) {
                return Err("导入章节超出清单".into());
            }
            for (i, item) in items.iter().enumerate() {
                let text = item["text"].as_str().unwrap_or("");
                if text.chars().count()
                    > meta["maxChapterChars"]
                        .as_u64()
                        .unwrap_or(book::IMPORT_MAX_CHAPTER_CHARS as u64)
                        as usize
                {
                    return Err("章节过长，请重新分章".into());
                }
                let paragraphs: Vec<&str> = text
                    .split('\n')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .collect();
                let body = paragraphs.join("\n");
                let fingerprint =
                    book::version_of(&json!({"title":item["title"],"textContent":body}));
                let reused = meta["reuse"][&fingerprint].as_array_mut().and_then(|a| {
                    if a.is_empty() {
                        None
                    } else {
                        Some(a.remove(0))
                    }
                });
                let cid = reused
                    .and_then(|v| v.as_i64())
                    .unwrap_or(meta["id"].as_i64().unwrap() + offset as i64 + i as i64 + 1);
                let words = text.chars().filter(|c| !c.is_whitespace()).count();
                let pid = meta["replaceProjectId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(meta["id"].as_i64().unwrap());
                put(&mut tx,&ns,&format!("content:{cid}"),&json!({"projectId":pid,"chapterId":cid,"paragraphs":paragraphs,"analysis":null,"paragraphInsightIds":vec![Value::Null;paragraphs.len()]})).await?;
                meta["catalog"].as_array_mut().unwrap().push(json!({"id":cid,"title":item["title"],"status":"wait","wordCount":words,"sortNo":offset+i as u64+1}));
                meta["words"] = json!(meta["words"].as_u64().unwrap_or(0) + words as u64);
            }
            meta["received"] = json!(offset + items.len() as u64);
            meta["updatedAt"] = json!(now());
            put(&mut tx, &ns, "meta", &meta).await?;
            json!({"received":meta["received"]})
        }
        "reference_abort" => {
            let ns = staging(str_field(args, "token")?)?;
            sqlx::query("DELETE FROM desktop_records WHERE namespace=?")
                .bind(ns)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            json!(true)
        }
        "reference_commit" => {
            let ns = staging(str_field(args, "token")?)?;
            let meta = get(&mut tx, &ns, "meta").await?.ok_or("导入已取消或过期")?;
            if meta["received"] != meta["total"] {
                return Err("章节尚未全部保存".into());
            }
            let replace = meta["replaceProjectId"].as_str().unwrap_or("");
            // 终点再次查重，两个窗口并发导入也不能发布两本。
            let duplicate = if replace.is_empty() {
                find(
                    &mut tx,
                    meta["sourceHash"].as_str().unwrap_or(""),
                    meta["contentHash"].as_str().unwrap_or(""),
                )
                .await?
            } else {
                Value::Null
            };
            let out = if duplicate.is_object() {
                duplicate
            } else {
                let pid = if replace.is_empty() {
                    meta["id"].as_i64().unwrap()
                } else {
                    replace.parse::<i64>().map_err(err)?
                };
                let stamp = chrono::Utc::now().to_rfc3339();
                let mut p = if replace.is_empty() {
                    json!({"id":pid,"author":"","tags":[],"mood":"","characterCount":0,"characterNames":[],"source":"agent","visibility":"conversation","createTime":stamp,"report":null,"status":"wait","progress":0})
                } else {
                    if crate::story_index::pending(&mut tx, Some(&book::book_id(replace))).await?
                        > 0
                    {
                        return Err("拆书任务已重新开始，修复未写入；请停止任务后重试".into());
                    }
                    let old = book::project(&mut tx, replace).await?;
                    if project_version(&old) != meta["expectedVersion"].as_str().unwrap_or("") {
                        return Err("参考书已改变，修复未写入".into());
                    }
                    put(
                        &mut tx,
                        book::BREAKDOWN_NS,
                        &format!("repair:{pid}:{}", now()),
                        &old,
                    )
                    .await?;
                    let ids: std::collections::BTreeSet<i64> = meta["catalog"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|v| v["id"].as_i64())
                        .collect();
                    for ch in old["chapters"].as_array().into_iter().flatten() {
                        if !ids.contains(&ch["id"].as_i64().unwrap_or(0)) {
                            canon::remove_card(
                                &mut tx,
                                &book::book_id(replace),
                                &ch["id"].to_string(),
                            )
                            .await?;
                        }
                    }
                    let mut old = old;
                    let changed = old["chapters"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|c| c["id"].clone())
                        .collect::<Vec<_>>()
                        != meta["catalog"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|c| c["id"].clone())
                            .collect::<Vec<_>>();
                    if changed {
                        old["report"] = Value::Null;
                    }
                    old["repairNote"]=json!("已修复分章。未改变章节的拆书结果继续复用，受影响的旧章节卡和原目录保留在修复历史中。请按新目录补拆缺少的章节。");
                    old
                };
                // 重用的章节正文与旧式段落分析保持原样；只发布新增或发生变化的章节。
                sqlx::query("INSERT OR IGNORE INTO desktop_records(namespace,key,value) SELECT ?,key,value FROM desktop_records WHERE namespace=? AND key LIKE '\"content:%'")
                    .bind(book::BREAKDOWN_NS).bind(&ns).execute(&mut *tx).await.map_err(err)?;
                for (key, value) in [
                    ("title", meta["title"].clone()),
                    ("chapters", meta["catalog"].clone()),
                    ("chapterCount", meta["total"].clone()),
                    ("wordCount", meta["words"].clone()),
                    (
                        "sourceHash",
                        if replace.is_empty() {
                            meta["sourceHash"].clone()
                        } else {
                            p["sourceHash"].clone()
                        },
                    ),
                    ("contentHash", meta["contentHash"].clone()),
                    ("importNotes", meta["notes"].clone()),
                ] {
                    p[key] = value;
                }
                p["normalizedHashV2"] = meta["contentHash"].clone();
                p["parserVersion"] = json!(2);
                p["updateTime"] = json!(stamp);
                p["searchCursor"] = json!(0);
                p["fingerprintVersion"] = json!(project_version(&p));
                put(&mut tx, book::BREAKDOWN_NS, &format!("project:{pid}"), &p).await?;
                result(&p, false)
            };
            sqlx::query("DELETE FROM desktop_records WHERE namespace=?")
                .bind(ns)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            out
        }
        _ => return Err("未知参考书导入操作".into()),
    };
    tx.commit().await.map_err(err)?;
    Ok(out)
}

/// 只处理一小批，调用方在批间释放写锁；游标随正文索引一起提交，重启可续建。
pub async fn index_next(root: &Path) -> Result<bool, String> {
    let mut db = desktop_storage::connect_existing_at(root).await?;
    let raw: Option<String>=sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key LIKE '\"project:%' AND json_extract(value,'$.searchCursor') < json_array_length(value,'$.chapters') LIMIT 1")
        .bind(book::BREAKDOWN_NS).fetch_optional(&mut db).await.map_err(err)?;
    let Some(raw) = raw else { return Ok(false) };
    let p: Value = serde_json::from_str(&raw).map_err(err)?;
    let pid = p["id"].to_string();
    let mut tx = desktop_storage::begin_write(&mut db).await?;
    let mut p = book::project(&mut tx, &pid).await?;
    let cursor = p["searchCursor"].as_u64().unwrap_or(0) as usize;
    let chapters = p["chapters"].as_array().ok_or("章节目录无效")?;
    let end = (cursor + 4).min(chapters.len());
    for ch in &chapters[cursor..end] {
        let c = book::chapter(&mut tx, &pid, &ch["id"].to_string()).await?;
        crate::story_index::index_chunks(
            &mut tx,
            &book::book_id(&pid),
            &ch["id"].to_string(),
            &book::version_of(&c),
            c["textContent"].as_str().unwrap_or(""),
            "unknown",
        )
        .await?;
    }
    p["searchCursor"] = json!(end);
    put(&mut tx, book::BREAKDOWN_NS, &format!("project:{pid}"), &p).await?;
    tx.commit().await.map_err(err)?;
    Ok(true)
}

#[cfg(all(test, feature = "local-tests"))]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    async fn fixture() -> Fixture {
        let f = Fixture(std::env::temp_dir().join(format!("ew-reference-stage-{}", id())));
        std::fs::create_dir_all(&f.0).unwrap();
        desktop_storage::connect_at(&f.0).await.unwrap();
        f
    }
    async fn begin(f: &Fixture, total: usize, source: &str) -> String {
        command(&f.0,"reference_begin",&json!({"title":"测试书","total":total,"sourceHash":source,"contentHash":"","notes":[]})).await.unwrap()["token"].as_str().unwrap().to_owned()
    }
    #[test]
    fn chat_import_keeps_a_long_chapter_whole_without_changing_legacy_limits() {
        tauri::async_runtime::block_on(async {
            let f = fixture().await;
            let long = "长章正文".repeat(31_000);
            let old = begin(&f, 1, "legacy-limit").await;
            assert!(command(
                &f.0,
                "reference_append",
                &json!({"token":old,"offset":0,"chapters":[{"title":"长章","text":long}]})
            )
            .await
            .is_err());
            let token=command(&f.0,"reference_begin",&json!({"title":"聊天长章","total":1,"sourceHash":"chat-long","notes":[],"preserveLongChapters":true})).await.unwrap()["token"].as_str().unwrap().to_owned();
            command(
                &f.0,
                "reference_append",
                &json!({"token":token,"offset":0,"chapters":[{"title":"长章","text":long}]}),
            )
            .await
            .unwrap();
            let saved = command(&f.0, "reference_commit", &json!({"token":token}))
                .await
                .unwrap();
            let mut db = desktop_storage::connect_existing_at(&f.0).await.unwrap();
            let p = book::project(&mut db, saved["projectId"].as_str().unwrap())
                .await
                .unwrap();
            assert_eq!(p["chapters"].as_array().unwrap().len(), 1);
            let c = get(
                &mut db,
                book::BREAKDOWN_NS,
                &format!("content:{}", p["chapters"][0]["id"]),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(c["paragraphs"][0].as_str().unwrap(), long);
        });
    }

    #[test]
    fn staged_import_is_invisible_cancellable_and_indexed_in_short_batches() {
        tauri::async_runtime::block_on(async {
            let f = fixture().await;
            let token = begin(&f, 2, "file-one").await;
            let other = begin(&f, 1, "file-two").await;
            let mut db = desktop_storage::connect_existing_at(&f.0).await.unwrap();
            assert_ne!(
                get(&mut db, &staging(&token).unwrap(), "meta")
                    .await
                    .unwrap()
                    .unwrap()["id"],
                get(&mut db, &staging(&other).unwrap(), "meta")
                    .await
                    .unwrap()
                    .unwrap()["id"]
            );
            let batch = json!({"token":token,"offset":0,"chapters":[{"title":"第一章 开门！","text":"主角打开古老石门。"}]});
            command(&f.0, "reference_append", &batch).await.unwrap();
            assert!(book::list_projects(&mut db).await.unwrap().is_empty());
            assert!(command(&f.0, "reference_commit", &json!({"token":token}))
                .await
                .is_err());
            assert!(command(&f.0, "reference_append", &batch).await.is_err());
            command(&f.0, "reference_abort", &json!({"token":token}))
                .await
                .unwrap();
            assert!(get(&mut db, &staging(&token).unwrap(), "meta")
                .await
                .unwrap()
                .is_none());
            command(&f.0,"reference_append",&json!({"token":other,"offset":0,"chapters":[{"title":"第一章 开门！","text":"主角打开古老石门。"}]})).await.unwrap();
            let imported = command(&f.0, "reference_commit", &json!({"token":other}))
                .await
                .unwrap();
            let bid = imported["bookId"].as_str().unwrap();
            assert!(
                crate::story_index::search_chunks(&mut db, bid, "古老石门", 5)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(index_next(&f.0).await.unwrap());
            assert!(!index_next(&f.0).await.unwrap());
            assert_eq!(
                crate::story_index::search_chunks(&mut db, bid, "古老石门", 5)
                    .await
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                find(&mut db, "file-two", "").await.unwrap()["projectId"],
                imported["projectId"]
            );
        });
    }
}

/// 仅供本地浏览器验收：在带标记的数据库副本上调用真实存储入口，不启动模型。
#[cfg(all(test, feature = "local-tests"))]
#[test]
#[ignore]
fn reference_browser_fixture_bridge() {
    use std::io::{Read, Write};
    let root = std::path::PathBuf::from(
        std::env::var("EW_REFERENCE_FIXTURE").expect("isolated fixture root"),
    );
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("ew-breakdown-verify-"));
    assert!(root.join(".isolated-test").is_file());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(
        root.join("port"),
        listener.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(30)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0u8; 8192];
        let (offset, length) = loop {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                return;
            }
            bytes.extend_from_slice(&buf[..n]);
            if let Some(i) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..i]);
                let len = header
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                break (i + 4, len);
            }
        };
        assert!(length <= 8_000_000);
        while bytes.len() < offset + length {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        let request: Value = serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
        let action = request["action"].as_str().unwrap();
        let out = if action == "fixture_stop" {
            Ok(json!(true))
        } else if action == "fixture_index" {
            tauri::async_runtime::block_on(index_next(&root)).map(Value::Bool)
        } else if action.starts_with("reference_")
            || ["breakdown_results", "breakdown_library"].contains(&action)
        {
            tauri::async_runtime::block_on(crate::writing_service::command(
                &root,
                action,
                &request["args"],
            ))
        } else {
            Err("fixture action not allowed".into())
        };
        let body = match out {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error}),
        }
        .to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        if action == "fixture_stop" {
            break;
        }
    }
}
