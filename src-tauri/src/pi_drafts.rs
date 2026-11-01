//! Pi 模型候选的原生提交边界；不处理作者的正式采用。
use super::control::{Instance, ToolCall};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("草稿缺少 {field}"))
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub async fn commit(
    root: &Path,
    instance: Arc<Instance>,
    call: Arc<ToolCall>,
    mut draft: Value,
) -> Result<Value, String> {
    let _writing = instance.writing(&call)?;
    // 新章工具交来的候选可以是"填卷末空白章"（kind chapter）：新书自带的空白第1章、作者预留的空章直接填，不另加一章
    let prose = call.tool == "write_prose";
    let mode = call.args["mode"].as_str().unwrap_or("");
    let fill_blank = (call.tool == "save_new_chapter_draft" || (prose && mode == "new_chapter"))
        && draft["kind"] == "chapter";
    let kind = match call.tool.as_str() {
        "write_prose" => match (mode, draft["kind"].as_str()) {
            ("chapter" | "new_chapter" | "revise", Some("chapter")) => "chapter",
            ("new_chapter" | "revise", Some("new_chapter")) => "new_chapter",
            ("short_story" | "revise", Some("short_story")) => "short_story",
            ("text" | "revise", Some("text")) => "text",
            _ => return Err("简报和候选类型不一致".into()),
        },
        "save_creation_draft" => "entity",
        "save_draft" => "chapter",
        "save_new_chapter_draft" if fill_blank => "chapter",
        "save_new_chapter_draft" => "new_chapter",
        "save_outline_draft" => "outline",
        "save_skill_draft" => "skill",
        _ => return Err("此工具不能提交草稿".into()),
    };
    let new_book = kind == "entity" && call.args["entity"] == "book";
    // 技能候选是作者级的，不挂作品
    let independent = matches!(kind, "skill" | "text" | "short_story");
    let book_id = if independent {
        ""
    } else if new_book {
        call.book["id"].as_str().unwrap_or("")
    } else {
        text(&call.book, "id")?
    };
    let session_id = text(&call.args, "sessionId")?;
    let revising = (kind == "entity" || (prose && mode == "revise"))
        && call.args["draftId"].as_str().is_some();
    let id = if revising {
        text(&call.args, "draftId")?.to_owned()
    } else if prose {
        format!("{session_id}:{}:prose", text(&call.args, "turnId")?)
    } else {
        format!("{session_id}:{}", call.call_id)
    };
    let title = if kind == "entity" || independent || prose {
        text(&draft, "title")?
    } else {
        text(&call.args, "title")?.trim()
    };
    let content = if kind == "entity" || independent || prose {
        text(&draft, "content")?
    } else {
        text(&call.args, "content")?.trim()
    };
    if kind == "entity"
        && (super::entities::fields(&draft)? != call.args["fields"]
            || draft["entity"] != call.args["entity"]
            || draft["targetId"] != call.args["targetId"])
    {
        return Err("创作候选与工具请求不一致".into());
    }
    if title.is_empty()
        || content.is_empty()
        || content.encode_utf16().count() > 150_000
        || draft["id"] != id
        || draft["kind"] != kind
        || draft["bookId"] != book_id
        || draft["sessionId"] != session_id
        || draft["title"] != title
        || draft["content"] != content
        || draft.get("appliedAt").is_some()
        || draft.get("appliedVersion").is_some()
        || draft.get("appliedOperationId").is_some()
        || draft.get("appliedEntityId").is_some()
        || draft.get("appliedBookId").is_some()
    {
        return Err("候选草稿与本次工具请求不一致".into());
    }
    let target_field = match kind {
        "entity" => "targetId",
        "skill" => "replaceId",
        "chapter" => "chapterId",
        "new_chapter" => "volumeId",
        _ => "outlineId",
    };
    let target = if kind == "entity" || independent {
        0
    } else if prose && revising {
        if kind == "chapter" {
            draft["chapterId"].as_i64().ok_or("候选章节编号无效")?
        } else {
            text(&draft, "volumeId")?.parse::<i64>().map_err(error)?
        }
    } else if fill_blank {
        draft["chapterId"].as_i64().ok_or("空白章编号无效")?
    } else {
        text(&call.args, target_field)?
            .parse::<i64>()
            .map_err(error)?
    };
    let target_matches = if kind == "new_chapter" {
        draft[target_field] == target.to_string()
            && draft["placement"] == "append"
            && draft.get("chapterId").is_none()
    } else {
        draft[target_field] == target
    };
    if kind != "entity"
        && !independent
        && (target == 0 || target.unsigned_abs() > 9_007_199_254_740_991 || !target_matches)
    {
        return Err("候选目标无效".into());
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    instance.check(&call)?;
    // 先等待数据库，再进入短提交临界区；取消控制不等待数据库锁。
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    instance.check(&call)?;
    // 关联信息只能来自宿主登记过的工具参数，前端不能篡改依赖版本。
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL",
    )
    .bind(book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(error)?;
    if !new_book && !independent && exists != 1 {
        return Err("当前作品不存在或已删除".into());
    }
    if kind == "entity" {
        super::entities::validate_candidate(&mut tx, &draft).await?;
    } else if kind == "new_chapter" {
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT payload FROM local_volumes WHERE id=? AND bookId=? AND deletedAt IS NULL",
        )
        .bind(target)
        .bind(book_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(error)?;
        let volume: Value =
            serde_json::from_str(&raw.ok_or("目标卷不存在、不属于当前作品或已删除")?)
                .map_err(error)?;
        if !volume["deletedAt"].is_null() || draft["volumeTitle"] != volume["title"] {
            return Err("目标卷已改变，请重新读取目录并确认归属".into());
        }
    } else if kind == "chapter" {
        let catalog: Option<String> = sqlx::query_scalar("SELECT c.payload FROM local_chapters c JOIN local_volumes v ON CAST(v.id AS TEXT)=c.volumeId AND v.bookId=c.bookId WHERE c.id=? AND c.bookId=? AND c.deletedAt IS NULL AND v.deletedAt IS NULL")
            .bind(target).bind(book_id).fetch_optional(&mut *tx).await.map_err(error)?;
        let catalog: Value =
            serde_json::from_str(&catalog.ok_or("目标章节不存在或不属于当前作品")?)
                .map_err(error)?;
        if let Some(volume) = catalog["volumeId"].as_str() {
            draft["baseVolumeId"] = json!(volume);
        }
        let owner =
            crate::writing_records::chapter_owner(&mut tx, book_id, &target.to_string()).await?;
        let raw: Option<String> =
            sqlx::query_scalar("SELECT payload FROM chapter_contents WHERE storageKey=?")
                .bind(format!("{owner}:{book_id}:{target}"))
                .fetch_optional(&mut *tx)
                .await
                .map_err(error)?;
        let current: Value = raw
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(error)?
            .unwrap_or(Value::Null);
        let version = current["localVersion"].as_i64().unwrap_or(0);
        if draft["baseVersion"] != version
            || (!fill_blank && !prose && call.args["baseVersion"] != version)
            || draft["baseText"].as_str() != Some(current["textContent"].as_str().unwrap_or(""))
            || draft["baseTitle"] != catalog["title"]
        {
            return Err("章节已更新，请重新读取后生成草稿".into());
        }
        if fill_blank {
            if !current["textContent"]
                .as_str()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err("目标章已有正文，不能当空白章填入".into());
            }
            let volume = call.args["volumeId"].as_str().unwrap_or("");
            if !volume.is_empty() && catalog["volumeId"] != volume {
                return Err("空白章不在指定的卷里".into());
            }
        }
    } else if kind == "outline" {
        let raw: Option<String> = sqlx::query_scalar("SELECT value FROM desktop_records WHERE namespace='ew-local-reference/book-reference' AND key=?")
            .bind(json!(book_id).to_string()).fetch_optional(&mut *tx).await.map_err(error)?;
        let doc: Value = serde_json::from_str(&raw.ok_or("作品资料不存在")?).map_err(error)?;
        let outline = doc["outlineNodes"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|n| n["id"] == target && n["nodeType"] == 1)
            })
            .ok_or("目标大纲不存在")?;
        if draft["baseOutline"]["title"] != outline["title"]
            || draft["baseOutline"]["content"] != outline["content"]
        {
            return Err("大纲已更新，请重新读取后生成候选".into());
        }
    }
    if let Some(obj) = draft.as_object_mut() {
        obj.remove("modelTextHash");
    }
    if prose {
        crate::prose_examples::stamp_generation(
            &mut draft,
            !revising || call.args["selection"].is_null(),
        );
        if draft["proseSource"]["callId"] != call.call_id {
            return Err("正文调用凭据不符".into());
        }
        super::adoption::check_sources(&mut tx, &draft).await?;
    }
    // Candidate provenance is read from the host store in the same transaction as the draft.
    if let Some(obj) = draft.as_object_mut() {
        obj.remove("resourceUse");
    }
    if let Some(turn) = call.args["turnId"].as_str().filter(|s| !s.is_empty()) {
        let references: Vec<String> = sqlx::query_scalar("SELECT json_extract(value,'$.read') FROM desktop_records WHERE namespace='ew-pi-writing-resources/records' AND json_extract(value,'$.type')='usage' AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.turnId')=? AND json_extract(value,'$.bookId') IN ('',?) AND json_type(value,'$.read')='object' ORDER BY json_extract(value,'$.at'),key")
            .bind(session_id).bind(turn).bind(call.book["id"].as_str().unwrap_or_default()).fetch_all(&mut *tx).await.map_err(error)?;
        let used = references
            .iter()
            .map(|s| serde_json::from_str::<Value>(s).map_err(error))
            .collect::<Result<Vec<_>, _>>()?;
        if !used.is_empty() {
            draft["resourceUse"] = json!(used);
        }
    }
    let key = json!(id).to_string();
    let old: Option<String> = sqlx::query_scalar(
        "SELECT value FROM desktop_records WHERE namespace='ew-agent-pi/drafts' AND key=?",
    )
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(error)?;
    if let Some(old) = old {
        let prior: Value = serde_json::from_str(&old).map_err(error)?;
        if revising {
            if [
                "id",
                "kind",
                "bookId",
                "sessionId",
                "entity",
                "selection",
                target_field,
            ]
            .iter()
            .any(|field| prior[*field] != draft[*field])
                || prior["appliedAt"].as_i64().unwrap_or(0) > 0
                || prior["revision"]
                    != if prose {
                        &draft["revision"]
                    } else {
                        &call.args["draftRevision"]
                    }
                    .clone()
            {
                return Err(
                    "候选已被编辑、已采用或归属不同，请读取当前版本后修订；未覆盖作者修改".into(),
                );
            }
            draft["revision"] = json!(prior["revision"].as_u64().unwrap_or(0) + 1);
            draft["createdAt"] = prior["createdAt"].clone();
            sqlx::query(
                "UPDATE desktop_records SET value=? WHERE namespace='ew-agent-pi/drafts' AND key=?",
            )
            .bind(draft.to_string())
            .bind(&key)
            .execute(&mut *tx)
            .await
            .map_err(error)?;
            let _commit = instance.commit.lock().await;
            instance.check(&call)?;
            tx.commit().await.map_err(error)?;
            return Ok(draft);
        }
        if [
            "id",
            "kind",
            "bookId",
            "sessionId",
            "entity",
            target_field,
            "title",
            "content",
        ]
        .iter()
        .any(|field| prior[*field] != draft[*field])
        {
            return Err("同一工具调用不能改写另一份草稿".into());
        }
        instance.check(&call)?;
        return Ok(prior);
    }
    if revising {
        return Err("要修改的候选不存在".into());
    }
    draft["createdAt"] = json!(chrono::Utc::now().timestamp_millis());
    draft["revision"] = json!(1);
    sqlx::query(
        "INSERT INTO desktop_records(namespace,key,value) VALUES('ew-agent-pi/drafts',?,?)",
    )
    .bind(key)
    .bind(draft.to_string())
    .execute(&mut *tx)
    .await
    .map_err(error)?;
    let _commit = instance.commit.lock().await;
    instance.check(&call)?;
    tx.commit().await.map_err(error)?;
    Ok(draft)
}
