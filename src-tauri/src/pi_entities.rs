//! Pi 创作候选写入平台既有目录/参考资料；由 adoption 的同一事务提交和记回执。
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::sync::OnceLock;

const NS: &str = "ew-local-reference/book-reference";
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn specs() -> &'static Value {
    static SPEC: OnceLock<Value> = OnceLock::new();
    SPEC.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/types/pi-entities.json"))
            .expect("valid entity contract")
    })
}
fn spec(d: &Value) -> Result<&'static Value, String> {
    specs()
        .get(d["entity"].as_str().unwrap_or(""))
        .ok_or_else(|| "不支持的创作资料类型".into())
}
pub fn fields(d: &Value) -> Result<Value, String> {
    let v: Value =
        serde_json::from_str(d["content"].as_str().ok_or("候选字段缺失")?).map_err(err)?;
    let map = v
        .as_object()
        .filter(|m| !m.is_empty())
        .ok_or("候选至少需要一个字段")?;
    let s = spec(d)?;
    let create = d["targetId"].is_null();
    if !create && (s["createOnly"] == true || d["targetId"].as_str().is_none()) {
        return Err("此类资料只支持创建候选".into());
    }
    for (key, value) in map {
        let f = s["fields"]
            .get(key)
            .ok_or_else(|| format!("不允许修改字段 {key}"))?;
        if value.is_null() && f["nullable"] == true {
            continue;
        }
        let valid = match f["type"].as_str() {
            Some("string") => value
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 150_000),
            Some("number") => value
                .as_i64()
                .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991),
            Some("strings") => value.as_array().is_some_and(|a| {
                a.len() <= 200
                    && a.iter()
                        .all(|v| v.as_str().is_some_and(|s| s.len() <= 2000))
            }),
            _ => false,
        };
        if !valid
            || f["enum"].as_array().is_some_and(|a| !a.contains(value))
            || f["min"]
                .as_i64()
                .is_some_and(|n| value.as_i64().is_some_and(|v| v < n))
            || f["max"]
                .as_i64()
                .is_some_and(|n| value.as_i64().is_some_and(|v| v > n))
            || (f["required"] == true
                && (value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty())))
        {
            return Err(format!(
                "字段「{}」无效",
                f["label"].as_str().unwrap_or(key)
            ));
        }
    }
    if create {
        for (key, f) in s["fields"].as_object().unwrap() {
            if f["required"] == true && !map.contains_key(key) {
                return Err(format!("缺少{}", f["label"]));
            }
        }
    }
    Ok(v)
}
pub fn snapshot(d: &Value) -> Result<Value, String> {
    if d["kind"] == "outline" {
        if !d["outlineId"].is_i64() || !d["baseOutline"].is_object() {
            return Err("大纲候选目标无效".into());
        }
        return Ok(
            json!({"id":d["id"],"kind":d["kind"],"bookId":d["bookId"],"revision":d.get("revision").unwrap_or(&json!(0)),"title":d["title"],"content":d["content"],"outlineId":d["outlineId"],"baseOutline":d["baseOutline"]}),
        );
    }
    fields(d)?;
    Ok(
        json!({"id":d["id"],"kind":d["kind"],"bookId":d["bookId"],"revision":d["revision"],"entity":d["entity"],"targetId":d["targetId"],"baseEntity":d["baseEntity"],"content":d["content"]}),
    )
}
pub(super) async fn doc(db: &mut SqliteConnection, bid: &str) -> Result<Value, String> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace=? AND key=?")
            .bind(NS)
            .bind(json!(bid).to_string())
            .fetch_optional(&mut *db)
            .await
            .map_err(err)?;
    let mut d = if let Some(raw) = raw {
        serde_json::from_str::<Value>(&raw).map_err(err)?
    } else {
        json!({"version":1,"bookId":bid,"characterCanvasPositions":{}})
    };
    if d["version"] != 1 || d["bookId"] != bid {
        return Err("作品参考资料格式或归属无效".into());
    }
    for key in [
        "outlineNodes",
        "commonWords",
        "characters",
        "characterGroups",
        "characterRelations",
        "worldSettings",
        "worldSettingGroups",
        "timelineEvents",
        "storylines",
        "storylineRelations",
        "storylineNodes",
        "storylineNodeRelations",
        "plotBindings",
    ] {
        if d.get(key).is_none() {
            d[key] = json!([]);
        }
        if !d[key].is_array() {
            return Err("作品参考资料已损坏，未覆盖".into());
        }
    }
    Ok(d)
}
async fn active_book(db: &mut SqliteConnection, bid: &str) -> Result<(), String> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL AND json_extract(payload,'$.deletedAt') IS NULL")
        .bind(bid).fetch_one(db).await.map_err(err)?;
    if count != 1 {
        return Err("作品不存在或已删除".into());
    }
    Ok(())
}
fn id(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
}
fn html(s: &str) -> String {
    s.replace("\r\n", "\n")
        .split('\n')
        .map(|line| {
            let value = line
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            format!("<p>{}</p>", if value.is_empty() { "<br>" } else { &value })
        })
        .collect()
}
async fn validate_refs(
    db: &mut SqliteConnection,
    bid: &str,
    doc: &Value,
    s: &Value,
    item: &Value,
) -> Result<(), String> {
    for (key, f) in s["fields"].as_object().unwrap() {
        let Some(collection) = f["reference"].as_str() else {
            continue;
        };
        let values = item[key]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![item[key].clone()]);
        for value in values {
            if value.is_null()
                || (f["nullable"] == true && value == "")
                || (key == "parentId" && value == "0")
            {
                continue;
            }
            let target = id(&value);
            let exists = if collection == "chapters" {
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM local_chapters c JOIN local_volumes v ON CAST(v.id AS TEXT)=c.volumeId AND v.bookId=c.bookId WHERE CAST(c.id AS TEXT)=? AND c.bookId=? AND c.deletedAt IS NULL AND v.deletedAt IS NULL")
                    .bind(&target).bind(bid).fetch_one(&mut *db).await.map_err(err)? == 1
            } else {
                doc[collection].as_array().is_some_and(|a| {
                    a.iter().any(|v| {
                        id(&v["id"]) == target
                            && v["deletedAt"].is_null()
                            && (key != "parentId" || v["nodeType"] == 0)
                    })
                })
            };
            if !exists {
                return Err(format!("{}目标不存在、不属于当前作品或已删除", f["label"]));
            }
        }
    }
    Ok(())
}
fn next_id(doc: &Value) -> i64 {
    loop {
        let n = -((uuid::Uuid::new_v4().as_u128() % 4_503_599_627_370_495 + 4_503_599_627_370_496)
            as i64);
        if !doc.as_object().is_some_and(|m| {
            m.values()
                .any(|v| v.as_array().is_some_and(|a| a.iter().any(|v| v["id"] == n)))
        }) {
            return n;
        }
    }
}
fn aliases(item: &Value) -> Value {
    // 与平台 normalizeCharacterAliases 同规则，兼容旧记录未存 aliases 的情况。
    let mut result = Vec::new();
    for value in item["aliases"].as_array().into_iter().flatten() {
        let Some(value) = value.as_str() else {
            continue;
        };
        let alias = value.trim_matches(super::adoption::whitespace);
        if !alias.is_empty()
            && alias
                != item["name"]
                    .as_str()
                    .unwrap_or("")
                    .trim_matches(super::adoption::whitespace)
            && !result.contains(&json!(alias))
        {
            result.push(json!(alias));
        }
    }
    json!(result)
}
fn transformed(s: &Value, key: &str, v: &Value) -> Value {
    if s["collection"] == "storylineNodes" && key == "storylineId" && v.is_null() {
        return json!("");
    }
    if s["fields"][key]["format"] == "plain_html" {
        json!(html(v.as_str().unwrap_or("")))
    } else {
        v.clone()
    }
}
async fn merge_reference(db: &mut SqliteConnection, d: &Value) -> Result<(Value, Value), String> {
    let bid = d["bookId"].as_str().ok_or("缺少作品")?;
    active_book(db, bid).await?;
    let mut doc = doc(db, bid).await?;
    let s = spec(d)?;
    let collection = s["collection"].as_str().unwrap();
    let patch = fields(d)?;
    let current = if d["targetId"].is_null() {
        None
    } else {
        Some(
            doc[collection]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| id(&v["id"]) == d["targetId"].as_str().unwrap())
                .ok_or("目标资料已删除，未重新创建")?
                .clone(),
        )
    };
    let mut item = current.clone().unwrap_or_else(|| {
        let mut v = json!({"id":next_id(&doc),"bookId":bid});
        for (key, f) in s["fields"].as_object().unwrap() {
            v[key] = f["default"].clone();
        }
        v
    });
    if let Some(old) = &current {
        if id(&d["baseEntity"]["id"]) != id(&old["id"]) {
            return Err("缺少原始读取版本，请重新读取资料".into());
        }
        // 只比较本次修改字段；并行修改其他人物或字段仍可安全合并。
        for (key, value) in patch.as_object().unwrap() {
            let unchanged = if d["entity"] == "character" && key == "aliases" {
                aliases(old) == aliases(&d["baseEntity"])
            } else {
                old[key] == d["baseEntity"][key]
            };
            if !unchanged && old[key] != transformed(s, key, value) {
                return Err(format!(
                    "{}已被修改，请重新读取，未覆盖作者内容",
                    s["fields"][key]["label"]
                ));
            }
        }
        if d["entity"] == "outline" && patch.get("nodeType").is_some_and(|v| v != &old["nodeType"])
        {
            return Err("不能改变已有大纲的节点类型".into());
        }
    }
    for (key, value) in patch.as_object().unwrap() {
        item[key] = transformed(s, key, value);
    }
    if d["entity"] == "character" {
        item["aliases"] = aliases(&item);
    }
    validate_refs(db, bid, &doc, s, &item).await?;
    if d["entity"] == "outline" {
        let mut parent = id(&item["parentId"]);
        let mut seen = std::collections::HashSet::new();
        while parent != "0" && parent != "null" {
            if parent == id(&item["id"]) || !seen.insert(parent.clone()) {
                return Err("大纲父级不能形成循环".into());
            }
            let node = doc[collection]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| id(&v["id"]) == parent)
                .ok_or("上级大纲不存在")?;
            parent = id(&node["parentId"]);
        }
    }
    for (from, to) in [
        ("fromId", "toId"),
        ("fromStorylineId", "toStorylineId"),
        ("fromNodeId", "toNodeId"),
    ] {
        if item.get(from).is_none() {
            continue;
        }
        if item[from] == item[to] {
            return Err("不能关联到自身".into());
        }
        if doc[collection].as_array().unwrap().iter().any(|v| {
            v["id"] != item["id"]
                && ((v[from] == item[from] && v[to] == item[to])
                    || (from == "fromId" && v[to] == item[from] && v[from] == item[to]))
        }) {
            return Err("关系已存在，请读取后修改原关系".into());
        }
    }
    if d["entity"] == "plot_binding"
        && item["storylineNodeId"].is_null()
        && item["timelineEventId"].is_null()
    {
        return Err("章节引用需要指定剧情节点或时间线事件".into());
    }
    let iso = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if current.is_none() {
        let order = doc[collection]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| d["entity"] != "outline" || v["parentId"] == item["parentId"])
            .map(|v| v["sortNo"].as_i64().unwrap_or(0))
            .max()
            .unwrap_or(0)
            + 10;
        item["sortNo"] = json!(order);
        if [
            "timeline_event",
            "storyline",
            "storyline_node",
            "plot_binding",
        ]
        .contains(&d["entity"].as_str().unwrap_or(""))
        {
            item["userId"] = json!("guest");
            item["createTime"] = json!(iso);
            item["payload"] = Value::Null;
        }
        if d["entity"] == "character" {
            item["avatar"] = json!("");
            item["relationships"] = Value::Null;
        }
        if d["entity"] == "world_setting" {
            item["imageUrl"] = json!("");
        }
        if d["entity"] == "storyline" {
            item["hookCount"] = json!(0);
            item["pendingHookCount"] = json!(0);
        }
        if d["entity"] == "storyline_node" {
            for k in ["predecessorNodeIds", "successorNodeIds"] {
                item[k] = json!([]);
            }
            // 与 StorylinePanel 的 nextNodePosition 一致，避免多个新节点重叠在原点。
            let index = doc[collection].as_array().unwrap().len();
            item["positionX"] = json!(if index == 0 {
                300
            } else {
                160 + (index % 3) * 260
            });
            item["positionY"] = json!(if index == 0 {
                80
            } else {
                230 + (index / 3) * 170
            });
        }
        if d["entity"] == "timeline_event" {
            item["parallelGroupId"] = Value::Null;
            if !patch.as_object().unwrap().contains_key("timeOrder") {
                item["timeOrder"] = json!(
                    doc[collection]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v["timeOrder"].as_i64().unwrap_or(0))
                        .max()
                        .unwrap_or(0)
                        + 10
                );
            }
        }
        if d["entity"] == "plot_binding" {
            item["anchorStart"] = Value::Null;
            item["anchorEnd"] = Value::Null;
            item["anchorText"] = json!("");
        }
    }
    item["updateTime"] = json!(iso);
    doc["updatedAt"] = json!(iso);
    let items = doc[collection].as_array_mut().unwrap();
    if let Some(i) = items.iter().position(|v| v["id"] == item["id"]) {
        items[i] = item.clone();
    } else {
        items.push(item.clone());
    }
    Ok((doc, item))
}
pub async fn validate_candidate(db: &mut SqliteConnection, d: &Value) -> Result<(), String> {
    fields(d)?;
    if d["entity"] == "book" {
        return Ok(());
    }
    if d["entity"] == "volume" {
        return active_book(db, d["bookId"].as_str().ok_or("缺少作品")?).await;
    }
    merge_reference(db, d).await.map(|_| ())
}
pub async fn apply(db: &mut SqliteConnection, draft: &mut Value) -> Result<(), String> {
    let converted;
    let d = if draft["kind"] == "outline" {
        converted = json!({"entity":"outline","bookId":draft["bookId"],"targetId":id(&draft["outlineId"]),"baseEntity":{"id":draft["outlineId"],"title":draft["baseOutline"]["title"],"content":draft["baseOutline"]["content"]},"content":json!({"title":draft["title"],"content":draft["content"]}).to_string()});
        &converted
    } else {
        &*draft
    };
    if d["entity"] == "book" || d["entity"] == "volume" {
        return super::catalog::apply(db, draft).await;
    }
    let (doc, item) = merge_reference(db, d).await?;
    sqlx::query("INSERT INTO desktop_records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")
        .bind(NS).bind(json!(d["bookId"].as_str().unwrap()).to_string()).bind(doc.to_string()).execute(&mut *db).await.map_err(err)?;
    draft["appliedEntityId"] = json!(id(&item["id"]));
    Ok(())
}
