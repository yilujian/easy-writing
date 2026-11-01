//! Pi 会话的宿主侧元数据：自定义标题、分组、置顶、归档，以及彻底删除与内容搜索。
//! 对话历史仍由 Pi 原生 JSONL 保存；元数据只存 SQLite，不写进会话文件。
use crate::writing_records::{delete_by_prefix, get, list, put};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::Path,
};

pub(super) const META_NS: &str = "ew-agent-pi/session-meta";
const GROUP_NS: &str = "ew-agent-pi/groups";
const CONTEXT_NS: &str = "ew-agent-pi/sessions";
const DRAFT_NS: &str = "ew-agent-pi/drafts";
const ATTACHMENT_NS: &str = "ew-local-breakdown/kv";
const TITLE_MAX: usize = 60;
const GROUP_NAME_MAX: usize = 40;
const MARK_OPEN: &str = "<yichuang-attachment>";
const MARK_CLOSE: &str = "</yichuang-attachment>";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
async fn remove(db: &mut SqliteConnection, ns: &str, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM desktop_records WHERE namespace=? AND key=?")
        .bind(ns)
        .bind(json!(key).to_string())
        .execute(db)
        .await
        .map_err(err)?;
    Ok(())
}
fn drop_field(value: &mut Value, field: &str) {
    if let Some(map) = value.as_object_mut() {
        map.remove(field);
    }
}

/// 去掉聊天附件标记并压缩空白；侧栏和搜索都不展示内部标记。
pub fn strip_markers(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(MARK_OPEN) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(MARK_CLOSE) {
            Some(end) => &rest[start + end + MARK_CLOSE.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
/// 没有作者改名或自动起名时，用第一条消息的前 28 个字当标题。
pub fn derived_title(text: &str) -> String {
    strip_markers(text).chars().take(28).collect()
}

pub async fn metas(db: &mut SqliteConnection) -> Result<HashMap<String, Value>, String> {
    Ok(list(db, META_NS, "")
        .await?
        .into_iter()
        .filter_map(|m| m["id"].as_str().map(|id| (id.to_owned(), m.clone())))
        .collect())
}
pub async fn groups(db: &mut SqliteConnection) -> Result<Vec<Value>, String> {
    let mut rows = list(db, GROUP_NS, "").await?;
    rows.sort_by_key(|g| {
        (
            g["order"].as_i64().unwrap_or(0),
            g["createdAt"].as_i64().unwrap_or(0),
        )
    });
    Ok(rows)
}
fn name_of(value: &Value, field: &str, max: usize, label: &str) -> Result<String, String> {
    let name = value[field].as_str().map(str::trim).unwrap_or_default();
    if name.is_empty() {
        return Err(format!("请输入{label}"));
    }
    if name.chars().count() > max {
        return Err(format!("{label}不超过 {max} 个字"));
    }
    Ok(name.split_whitespace().collect::<Vec<_>>().join(" "))
}
/// 更新一条会话的元数据；字段缺省表示不改，传 null 表示清除。
pub async fn update_meta(root: &Path, id: &str, change: &Value) -> Result<Value, String> {
    if id.is_empty() {
        return Err("会话编号缺失".into());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let mut meta = get(&mut tx, META_NS, id)
        .await?
        .unwrap_or_else(|| json!({ "id": id }));
    if let Some(title) = change.get("title") {
        if title.is_null() {
            drop_field(&mut meta, "title");
            drop_field(&mut meta, "titleSource");
        } else {
            let auto = change["auto"] == true;
            // 自动起名不覆盖作者手动改过的名字。
            if !(auto && meta["titleSource"] == "manual") {
                meta["title"] = json!(name_of(change, "title", TITLE_MAX, "对话名称")?);
                meta["titleSource"] = json!(if auto { "auto" } else { "manual" });
            }
        }
    }
    if let Some(group) = change.get("groupId") {
        if group.is_null() {
            drop_field(&mut meta, "groupId");
        } else {
            let gid = group
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("分组编号无效")?;
            get(&mut tx, GROUP_NS, gid).await?.ok_or("分组不存在")?;
            meta["groupId"] = json!(gid);
        }
    }
    if let Some(pinned) = change.get("pinned") {
        if *pinned == true {
            meta["pinnedAt"] = json!(now());
        } else {
            drop_field(&mut meta, "pinnedAt");
        }
    }
    if let Some(archived) = change.get("archived") {
        if *archived == true {
            meta["archivedAt"] = json!(now());
        } else {
            drop_field(&mut meta, "archivedAt");
        }
    }
    meta["updatedAt"] = json!(now());
    put(&mut tx, META_NS, id, &meta).await?;
    tx.commit().await.map_err(err)?;
    Ok(meta)
}
/// 新建或重命名分组；同名分组拒绝。
pub async fn save_group(root: &Path, args: &Value) -> Result<Value, String> {
    let name = name_of(args, "name", GROUP_NAME_MAX, "分组名称")?;
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let existing = groups(&mut tx).await?;
    let id = args["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if existing
        .iter()
        .any(|g| g["name"] == name && id.as_deref() != g["id"].as_str())
    {
        return Err("已有同名分组".into());
    }
    let mut group = match &id {
        Some(id) => existing
            .iter()
            .find(|g| g["id"] == id.as_str())
            .cloned()
            .ok_or("分组不存在")?,
        None => json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "createdAt": now(),
            "order": existing.iter().filter_map(|g| g["order"].as_i64()).max().unwrap_or(0) + 1
        }),
    };
    group["name"] = json!(name);
    if let Some(order) = args["order"].as_i64() {
        group["order"] = json!(order);
    }
    group["updatedAt"] = json!(now());
    let key = group["id"].as_str().ok_or("分组编号缺失")?.to_owned();
    put(&mut tx, GROUP_NS, &key, &group).await?;
    tx.commit().await.map_err(err)?;
    Ok(group)
}
/// 删除分组；组内对话回到未分组，不删除对话。
pub async fn delete_group(root: &Path, id: &str) -> Result<Value, String> {
    if id.is_empty() {
        return Err("分组编号缺失".into());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    get(&mut tx, GROUP_NS, id).await?.ok_or("分组不存在")?;
    remove(&mut tx, GROUP_NS, id).await?;
    for (sid, mut meta) in metas(&mut tx).await? {
        if meta["groupId"] == id {
            drop_field(&mut meta, "groupId");
            meta["updatedAt"] = json!(now());
            put(&mut tx, META_NS, &sid, &meta).await?;
        }
    }
    tx.commit().await.map_err(err)?;
    Ok(json!({ "id": id, "deleted": true }))
}
/// 彻底删除：会话文件、元数据、作品绑定、候选草稿和聊天附件原文一起清掉；文件删不掉就整体回滚。
pub async fn delete_session(root: &Path, path: &Path, id: &str) -> Result<Value, String> {
    if id.is_empty() {
        return Err("会话编号缺失".into());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    remove(&mut tx, META_NS, id).await?;
    remove(&mut tx, CONTEXT_NS, id).await?;
    delete_by_prefix(&mut tx, DRAFT_NS, &format!("{id}:")).await?;
    sqlx::query("DELETE FROM desktop_records WHERE namespace='ew-agent-pi/creation' AND json_extract(value,'$.sessionId')=?").bind(id).execute(&mut *tx).await.map_err(err)?;
    let attachments = list(&mut tx, ATTACHMENT_NS, "attachment:").await?;
    for attachment in attachments.iter().filter(|a| a["sessionId"] == id) {
        if let Some(aid) = attachment["id"].as_str() {
            remove(&mut tx, ATTACHMENT_NS, &format!("attachment:{aid}")).await?;
            delete_by_prefix(&mut tx, ATTACHMENT_NS, &format!("attachment-source:{aid}:")).await?;
        }
    }
    fs::remove_file(path).map_err(|e| format!("删除会话文件失败：{e}"))?;
    tx.commit().await.map_err(err)?;
    Ok(json!({ "id": id, "deleted": true }))
}

/// 逐字符小写，字符数与原文一致，便于把匹配位置映射回原文。
fn fold(text: &str) -> String {
    text.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}
fn message_text(message: &Value) -> String {
    match &message["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
fn snippet(text: &str, needle: &str) -> Option<String> {
    let folded = fold(text);
    let at = folded.find(needle)?;
    let start = folded[..at].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let from = start.saturating_sub(24);
    let to = (start + needle.chars().count() + 56).min(chars.len());
    let mut out: String = chars[from..to].iter().collect();
    if from > 0 {
        out.insert(0, '…');
    }
    if to < chars.len() {
        out.push('…');
    }
    Some(out)
}
/// 按内容搜索会话；只看作者和助手的文字，不读工具结果，一个会话只返回第一处命中。
pub fn search(folder: &Path, query: &str, limit: usize) -> Result<Vec<Value>, String> {
    let needle = fold(query.trim());
    let mut out = vec![];
    if needle.is_empty() || !folder.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(folder).map_err(err)? {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl")
            || !entry.file_type().map_err(err)?.is_file()
        {
            continue;
        }
        let mut id = String::new();
        let mut hit = None;
        for line in BufReader::new(fs::File::open(&path).map_err(err)?).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match v["type"].as_str() {
                Some("session") => id = v["id"].as_str().unwrap_or_default().into(),
                Some("message")
                    if matches!(
                        v["message"]["role"].as_str(),
                        Some("user" | "assistant")
                    ) =>
                {
                    let text = strip_markers(&message_text(&v["message"]));
                    if let Some(found) = snippet(&text, &needle) {
                        hit = Some(found);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let (false, Some(snippet)) = (id.is_empty(), hit) {
            out.push(json!({
                "id": id,
                "file": entry.file_name().to_string_lossy(),
                "snippet": snippet
            }));
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(all(test, feature = "local-tests"))]
mod tests {
    use super::*;

    struct Env(std::path::PathBuf);
    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    async fn env() -> Env {
        let root = std::env::temp_dir().join(format!("ew-pi-sessions-{}", uuid::Uuid::new_v4()));
        crate::desktop_storage::connect_at(&root).await.unwrap();
        fs::create_dir_all(root.join("pi-agent/sessions")).unwrap();
        Env(root)
    }

    #[test]
    fn derived_title_strips_attachment_marker_and_whitespace() {
        assert_eq!(
            derived_title("帮我拆书\n\n<yichuang-attachment>{\"id\":\"x\"}</yichuang-attachment>"),
            "帮我拆书"
        );
        assert_eq!(derived_title("  多 个   空格\n换行 "), "多 个 空格 换行");
        assert_eq!(derived_title("<yichuang-attachment>没有结尾"), "");
    }

    #[tokio::test]
    async fn manual_title_is_not_overwritten_by_auto_naming() {
        let e = env().await;
        update_meta(&e.0, "s1", &json!({ "title": "作者改的名字" }))
            .await
            .unwrap();
        let meta = update_meta(&e.0, "s1", &json!({ "title": "模型起的名字", "auto": true }))
            .await
            .unwrap();
        assert_eq!(meta["title"], "作者改的名字");
        assert_eq!(meta["titleSource"], "manual");
        let meta = update_meta(&e.0, "s2", &json!({ "title": "模型起的名字", "auto": true }))
            .await
            .unwrap();
        assert_eq!(meta["titleSource"], "auto");
        let meta = update_meta(&e.0, "s2", &json!({ "title": "  再 改  ", "pinned": true }))
            .await
            .unwrap();
        assert_eq!(meta["title"], "再 改");
        assert_eq!(meta["titleSource"], "manual");
        assert!(meta["pinnedAt"].is_i64());
        let meta = update_meta(&e.0, "s2", &json!({ "pinned": false, "title": null }))
            .await
            .unwrap();
        assert!(meta.get("pinnedAt").is_none());
        assert!(meta.get("title").is_none());
        assert!(update_meta(&e.0, "", &json!({ "title": "x" })).await.is_err());
        assert!(update_meta(&e.0, "s3", &json!({ "title": "   " })).await.is_err());
    }

    #[tokio::test]
    async fn groups_reject_duplicates_and_deleting_a_group_releases_sessions() {
        let e = env().await;
        let g = save_group(&e.0, &json!({ "name": "连载" })).await.unwrap();
        assert!(save_group(&e.0, &json!({ "name": " 连载 " })).await.is_err());
        assert!(update_meta(&e.0, "s1", &json!({ "groupId": "missing" }))
            .await
            .is_err());
        update_meta(&e.0, "s1", &json!({ "groupId": g["id"] }))
            .await
            .unwrap();
        let renamed = save_group(&e.0, &json!({ "id": g["id"], "name": "短篇" }))
            .await
            .unwrap();
        assert_eq!(renamed["name"], "短篇");
        assert_eq!(renamed["id"], g["id"]);
        let second = save_group(&e.0, &json!({ "name": "连载" })).await.unwrap();
        assert!(second["order"].as_i64().unwrap() > renamed["order"].as_i64().unwrap());
        delete_group(&e.0, g["id"].as_str().unwrap()).await.unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        assert!(metas(&mut db).await.unwrap()["s1"].get("groupId").is_none());
        let left = groups(&mut db).await.unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["name"], "连载");
    }

    #[tokio::test]
    async fn permanent_delete_removes_file_drafts_and_attachments_together() {
        let e = env().await;
        let file = e.0.join("pi-agent/sessions/a.jsonl");
        fs::write(&file, "{\"type\":\"session\",\"id\":\"s1\"}\n").unwrap();
        let mut db = crate::desktop_storage::connect_existing_at(&e.0)
            .await
            .unwrap();
        for (ns, key, value) in [
            (DRAFT_NS, "s1:call", json!({ "id": "s1:call", "sessionId": "s1" })),
            (DRAFT_NS, "s2:call", json!({ "id": "s2:call", "sessionId": "s2" })),
            (ATTACHMENT_NS, "attachment:a1", json!({ "id": "a1", "sessionId": "s1" })),
            (ATTACHMENT_NS, "attachment-source:a1:0", json!("原文")),
            (ATTACHMENT_NS, "attachment:a2", json!({ "id": "a2", "sessionId": "s2" })),
            (CONTEXT_NS, "s1", json!({ "bookId": "1", "revision": 0 })),
        ] {
            put(&mut db, ns, key, &value).await.unwrap();
        }
        update_meta(&e.0, "s1", &json!({ "title": "甲" })).await.unwrap();
        delete_session(&e.0, &file, "s1").await.unwrap();
        assert!(!file.exists());
        for (ns, key) in [
            (META_NS, "s1"),
            (CONTEXT_NS, "s1"),
            (DRAFT_NS, "s1:call"),
            (ATTACHMENT_NS, "attachment:a1"),
            (ATTACHMENT_NS, "attachment-source:a1:0"),
        ] {
            assert!(get(&mut db, ns, key).await.unwrap().is_none(), "{ns} {key}");
        }
        assert!(get(&mut db, DRAFT_NS, "s2:call").await.unwrap().is_some());
        assert!(get(&mut db, ATTACHMENT_NS, "attachment:a2")
            .await
            .unwrap()
            .is_some());
        // 文件已不存在时元数据保持不变并返回错误，不留半删除状态。
        update_meta(&e.0, "s3", &json!({ "title": "乙" })).await.unwrap();
        assert!(
            delete_session(&e.0, &e.0.join("pi-agent/sessions/missing.jsonl"), "s3")
                .await
                .is_err()
        );
        assert!(get(&mut db, META_NS, "s3").await.unwrap().is_some());
    }

    #[test]
    fn search_matches_message_text_case_insensitively_and_skips_tool_results() {
        let folder = std::env::temp_dir().join(format!("ew-pi-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("a.jsonl"),
            concat!(
                "{\"type\":\"session\",\"id\":\"s1\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"帮我拆书\\n\\n<yichuang-attachment>{}</yichuang-attachment>\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"已按 Golden Three 范围完成章节分析\"}]}}\n"
            ),
        )
        .unwrap();
        fs::write(
            folder.join("b.jsonl"),
            "{\"type\":\"session\",\"id\":\"s2\"}\n{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"golden\"}]}}\n",
        )
        .unwrap();
        let hits = search(&folder, "golden", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["id"], "s1");
        assert_eq!(hits[0]["file"], "a.jsonl");
        assert!(hits[0]["snippet"]
            .as_str()
            .unwrap()
            .contains("Golden Three"));
        assert!(search(&folder, "yichuang-attachment", 10)
            .unwrap()
            .is_empty());
        assert!(search(&folder, "  ", 10).unwrap().is_empty());
        assert_eq!(search(&folder, "拆书", 10).unwrap()[0]["id"], "s1");
        let _ = fs::remove_dir_all(&folder);
    }
}
