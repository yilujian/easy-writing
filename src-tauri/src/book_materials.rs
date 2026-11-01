//! 创作领域操作：候选仍属于 Agent，正式资料复用编辑器 book-reference 文档。
use crate::writing_records::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

pub const MATERIAL_NS: &str = "ew-local-reference/book-reference";
pub fn version(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

/// 判断写作依据、记忆、草案是否过期时用的资料版本：只看故事内容。
/// 人物关系图与故事线画布上的坐标、文档保存时间是界面布局，拖动节点不该让候选和记忆失效。
pub fn story_version(doc: &Value) -> String {
    let mut story = doc.clone();
    if let Some(fields) = story.as_object_mut() {
        fields.remove("characterCanvasPositions");
        fields.remove("updatedAt");
    }
    for node in story["storylineNodes"].as_array_mut().into_iter().flatten() {
        if let Some(fields) = node.as_object_mut() {
            for key in ["positionX", "positionY", "updateTime"] {
                fields.remove(key);
            }
        }
    }
    version(&story)
}

pub async fn materials(db: &mut SqliteConnection, bid: &str) -> Result<Value, String> {
    book(db, bid).await?;
    let mut doc = json!({"version":1,"bookId":bid,"outlineNodes":[],"characters":[],
        "characterGroups":[],"characterRelations":[],"characterCanvasPositions":{},"worldSettings":[],
        "worldSettingGroups":[],"timelineEvents":[],"storylines":[],"storylineRelations":[],
        "storylineNodes":[],"storylineNodeRelations":[],"plotBindings":[],"updatedAt":""});
    if let Some(stored) = get(db, MATERIAL_NS, bid).await? {
        let fields = stored.as_object().ok_or("作品资料格式无效")?;
        doc.as_object_mut().unwrap().extend(fields.clone());
    }
    Ok(doc)
}

pub fn collection(kind: &str) -> Result<&'static str, String> {
    match kind {
        "character" => Ok("characters"),
        "outline" => Ok("outlineNodes"),
        "world_setting" => Ok("worldSettings"),
        _ => Err("不支持的资料类型".into()),
    }
}

fn material_source_text(entity: &Value, kind: &str) -> Result<String, String> {
    let fields = entity.as_object().ok_or("原资料格式错误")?;
    let mut parts = Vec::new();
    for (key, value) in fields {
        if matches!(
            key.as_str(),
            "id" | "bookId"
                | "parentId"
                | "createdAt"
                | "updatedAt"
                | "createTime"
                | "updateTime"
                | "sourcePlanId"
        ) {
            continue;
        }
        let Some(text) = value.as_str() else {
            continue;
        };
        if kind == "outline" && key == "content" {
            let mut html = text.to_owned();
            for tag in [
                "</p>", "</div>", "</h1>", "</h2>", "</h3>", "</h4>", "</li>", "<br>", "<br/>",
                "<br />",
            ] {
                html = html.replace(tag, "\n");
            }
            parts.push(
                crate::writing_context::strip_html(&html)
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
                    .replace("&#39;", "'")
                    .replace("&nbsp;", " ")
                    .replace("&amp;", "&"),
            );
        } else {
            parts.push(text.to_owned());
        }
    }
    Ok(parts.join("\n"))
}

pub async fn source_value(
    db: &mut SqliteConnection,
    source: &Value,
) -> Result<(String, String), String> {
    match source["type"].as_str().unwrap_or("") {
        "chapter" => {
            // 参考书（拆书项目）的章节同样按标题与正文计算来源指纹
            if let Some(pid) = crate::reference_books::project_of(str_field(source, "bookId")?) {
                let c = crate::reference_books::chapter(db, pid, str_field(source, "chapterId")?)
                    .await?;
                return Ok((
                    crate::reference_books::version_of(&c),
                    c["textContent"].as_str().unwrap_or("").to_owned(),
                ));
            }
            let c = chapter(
                db,
                str_field(source, "bookId")?,
                str_field(source, "chapterId")?,
            )
            .await?;
            Ok((
                version(&json!([c["localVersion"], c["title"], c["textContent"]])),
                c["textContent"].as_str().unwrap_or("").to_owned(),
            ))
        }
        "material" => {
            let doc = materials(db, str_field(source, "bookId")?).await?;
            let collection = collection(str_field(source, "materialKind")?)?;
            let entity = doc[collection]
                .as_array()
                .and_then(|a| a.iter().find(|v| v["id"] == source["entityId"]))
                .ok_or("原资料已删除")?;
            let text = material_source_text(entity, str_field(source, "materialKind")?)?;
            Ok((version(entity), text))
        }
        _ => Err("不支持的记忆来源".into()),
    }
}
