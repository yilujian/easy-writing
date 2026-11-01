//! 还在用的几个宿主操作：拆书结果、备注与线索标记、写作台上下文与体检、状态层查询、删书清理。
use super::writing_records::*;
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::path::Path;

pub async fn command(root: &Path, action: &str, args: &Value) -> Result<Value, String> {
    if action.starts_with("reference_") {
        return crate::reference_import::command(root, action, args).await;
    }
    if action == "breakdown_results" || action == "breakdown_library" {
        let mut db = crate::desktop_storage::connect_existing_at(root).await?;
        if action == "breakdown_library" {
            return Ok(json!(crate::reference_books::list_projects(&mut db).await?));
        }
        let pid = str_field(args, "projectId")?;
        let result = crate::reference_books::results_in_range(
            &mut db,
            pid,
            args["offset"].as_u64().unwrap_or(0) as usize,
            args["from"].as_u64().unwrap_or(1) as usize,
            args["to"].as_u64().unwrap_or(0) as usize,
        )
        .await?;
        return Ok(result);
    }
    let normalized = crate::writing_schema::canonical_arguments(args);
    let args = &normalized;
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    if matches!(
        action,
        "prose_sources"
            | "story_memory"
            | "story_memory_preview"
            | "chapter_source"
            | "story_memory_status"
            | "prose_examples"
            | "prose_example_setting"
            | "prose_sample_options"
            | "prose_reference_samples"
            | "prose_personal_passages"
    ) {
        use sqlx::Connection;
        let mut tx = db.begin().await.map_err(err)?;
        let bid = str_field(args, "bookId")?;
        let result = match action {
            "prose_examples" => json!(crate::prose_examples::examples(&mut tx, bid).await?),
            "prose_example_setting" => crate::prose_examples::preference(&mut tx, bid).await?,
            "prose_sample_options" => {
                json!(crate::prose_examples::source_options(&mut tx, bid).await?)
            }
            "prose_personal_passages" => json!(
                crate::prose_examples::personal_passages(
                    &mut tx,
                    bid,
                    args["precedingChapters"].as_u64().map(|n| n as usize),
                    args["query"].as_str().unwrap_or("")
                )
                .await?
            ),
            "prose_reference_samples" => json!(
                crate::prose_examples::reference_samples(&mut tx, str_field(args, "choice")?)
                    .await?
            ),
            "prose_sources" => crate::pi_prose_sources::collect(&mut tx, bid, args).await?,
            "chapter_source" => chapter(&mut tx, bid, str_field(args, "chapterId")?).await?,
            "story_memory_status" => {
                let h = crate::story_history::History::load(&mut tx, bid).await?;
                let missing = h.pending().iter().map(|c| c.no).collect::<Vec<_>>();
                json!({"unindexed":crate::story_history::ranges(&missing),"indexed":h.chapters.iter().filter(|c|c.words>0).count()-missing.len()})
            }
            "story_memory" => crate::story_memory::view(&mut tx, bid).await?,
            _ => crate::story_memory::preview(
                &crate::story_history::History::load(&mut tx, bid).await?,
                args,
            )?,
        };
        tx.commit().await.map_err(err)?;
        return Ok(result);
    }
    let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
    let value = match action {
        "prose_configure_examples" => {
            crate::prose_examples::configure(
                &mut tx,
                str_field(args, "bookId")?,
                args["enabled"].as_bool().ok_or("缺少选择")?,
            )
            .await?
        }
        "prose_editor_saved" => {
            crate::prose_examples::editor_saved(&mut tx, str_field(args, "bookId")?, args).await?
        }
        "story_memory_backfill" => {
            model_config(
                &mut tx,
                args["modelCode"].as_str().unwrap_or(""),
                "agent_indexer",
            )
            .await?;
            crate::story_memory::backfill(&mut tx, str_field(args, "bookId")?, args).await?
        }
        "story_memory_pause" => {
            let bid = str_field(args, "bookId")?;
            let key = format!("index-control:{bid}");
            let mut control = get(&mut tx, crate::story_state::AUTHOR_NS, &key)
                .await?
                .unwrap_or_else(|| json!({}));
            control["paused"] = json!(true);
            put(&mut tx, crate::story_state::AUTHOR_NS, &key, &control).await?;
            json!({"paused":true})
        }
        "story_memory_correct" => {
            crate::story_memory::save_correction(&mut tx, str_field(args, "bookId")?, args).await?
        }
        "canon_mark" => {
            crate::story_view::mark(
                &mut tx,
                str_field(args, "bookId")?,
                str_field(args, "recordKey")?,
                str_field(args, "mark")?,
            )
            .await?
        }
        "add_note" => crate::story_view::add_note(&mut tx, args).await?,
        "delete_note" => crate::story_view::delete_note(&mut tx, str_field(args, "id")?).await?,
        "record_ai_spans" => {
            crate::story_state::record_ai_spans(
                &mut tx,
                str_field(args, "bookId")?,
                str_field(args, "chapterId")?,
                &args["spans"],
            )
            .await?
        }
        "context" => {
            // 写作台、工作流生文调用：不依赖会话，预算由调用方按所用模型传入
            let model = model_config(
                &mut tx,
                args["modelCode"].as_str().unwrap_or(""),
                "text_assist",
            )
            .await
            .ok();
            let hints = args["charactersHint"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let out = crate::writing_context::assemble(
                &mut tx,
                &crate::writing_context::ContextRequest {
                    book_id: str_field(args, "bookId")?,
                    purpose: args["purpose"].as_str().unwrap_or("write"),
                    chapter_id: args["chapterId"].as_str().filter(|v| !v.is_empty()),
                    query_hint: args["queryHint"].as_str().filter(|v| !v.is_empty()),
                    characters_hint: hints,
                    model_max_context: args["maxContext"]
                        .as_u64()
                        .or_else(|| model.as_ref().and_then(|m| m["maxContext"].as_u64()))
                        .unwrap_or(32000) as usize,
                    output_reserve: args["outputReserve"]
                        .as_u64()
                        .or_else(|| model.as_ref().and_then(|m| m["maxOutputTokens"].as_u64()))
                        .unwrap_or(2048) as usize,
                    budget_tokens: args["budgetTokens"]
                        .as_u64()
                        .filter(|v| *v > 0)
                        .map(|v| v as usize),
                },
            )
            .await?;
            let mut out = out;
            if out["ok"] == true {
                out["rendered"] = json!(crate::writing_context::render(&out));
            }
            out
        }
        "quality_check" => {
            // 写作台“本章体检”：传正文则检查该稿，否则读取正式正文；报告绑定章节版本与文本指纹
            let bid = str_field(args, "bookId")?;
            let chapter_id = args["chapterId"].as_str().filter(|v| !v.is_empty());
            let (text, revision, artifact_id) = match (args["text"].as_str(), chapter_id) {
                (Some(text), Some(cid)) => {
                    let body = chapter(&mut tx, bid, cid).await?;
                    (
                        text.to_owned(),
                        body["localVersion"].as_i64().unwrap_or(0),
                        format!("chapter:{bid}:{cid}"),
                    )
                }
                (Some(text), None) => (text.to_owned(), 0, format!("draft:{bid}")),
                (None, Some(cid)) => {
                    let body = chapter(&mut tx, bid, cid).await?;
                    (
                        body["textContent"].as_str().unwrap_or("").to_owned(),
                        body["localVersion"].as_i64().unwrap_or(0),
                        format!("chapter:{bid}:{cid}"),
                    )
                }
                (None, None) => return Err("请提供正文或章节".into()),
            };
            crate::writing_review::check(
                &mut tx,
                &crate::writing_review::CheckRequest {
                    book_id: bid,
                    text: &text,
                    chapter_id,
                    artifact_id: &artifact_id,
                    reviewed_revision: revision,
                    profile_id: args["profileId"].as_str(),
                    target_words: args["targetWords"].as_u64().map(|v| v as usize),
                },
            )
            .await?
        }
        "canon_query" => {
            use crate::story_state as canon;
            let bid = str_field(args, "bookId")?;
            match str_field(args, "view")? {
                "cards" => json!(canon::refresh_cards(&mut tx, bid).await?),
                "threads" => {
                    json!(canon::list_threads(&mut tx, bid, args["status"].as_str()).await?)
                }
                "suspects" => json!(canon::list_suspects(&mut tx, bid).await?),
                "facts" => json!(canon::list_facts(&mut tx, bid).await?),
                "rules" => json!(canon::list_rules(&mut tx, Some(bid)).await?),
                "profiles" => {
                    json!({"current":canon::book_profile_id(&mut tx,bid).await?,"profiles":canon::platform_profiles(&mut tx).await?})
                }
                "state" => {
                    canon::state_as_of(
                        &mut tx,
                        bid,
                        str_field(args, "characterId")?,
                        str_field(args, "chapterId")?,
                    )
                    .await?
                }
                "progress" => canon::index_progress(&mut tx, bid).await?,
                "story" => crate::story_view::story_view(&mut tx, bid).await?,
                "notes" => json!(crate::story_view::notes_view(&mut tx, bid).await?),
                "search" => {
                    if args["mode"]
                        .as_str()
                        .is_some_and(|mode| !mode.is_empty() && mode != "keyword")
                    {
                        return Err("当前仅支持本机关键词检索".into());
                    }
                    crate::story_view::search_view(
                        &mut tx,
                        bid,
                        args["query"].as_str().unwrap_or(""),
                        args["limit"].as_i64().unwrap_or(8),
                        args["untilChapterId"].as_str().filter(|v| !v.is_empty()),
                    )
                    .await?
                }
                "states" => json!(canon::list_states(&mut tx, bid).await?),
                "ledger" => {
                    canon::ledger(
                        &mut tx,
                        bid,
                        args["chapterId"].as_str().filter(|v| !v.is_empty()),
                    )
                    .await?
                }
                "style" => json!({
                    "style":get(&mut tx, canon::CANON_NS, &format!("style:{bid}")).await?,
                    "lock":get(&mut tx, canon::AUTHOR_NS, &format!("style-lock:{bid}")).await?,
                    "samples":canon::confirmed_samples(&mut tx, bid).await?,
                    "aiSpans":canon::ai_span_counts(&mut tx, bid).await?,
                    "minSampleChars":crate::writing_style::MIN_SAMPLE_CHARS
                }),
                _ => return Err("未知的状态层视图".into()),
            }
        }
        "breakdown_profile" => {
            crate::reference_books::profile(&mut tx, &crate::reference_books::project_id_arg(args)?)
                .await?
        }
        "breakdown_compare" => {
            crate::reference_books::compare(
                &mut tx,
                str_field(args, "bookId")?,
                &crate::reference_books::project_id_arg(args)?,
            )
            .await?
        }
        "delete_recipe" => {
            let key = str_field(args, "id")?;
            let mut recipe = get(&mut tx, crate::story_state::AUTHOR_NS, key)
                .await?
                .ok_or("配方不存在")?;
            recipe["deletedAt"] = json!(now());
            put(&mut tx, crate::story_state::AUTHOR_NS, key, &recipe).await?;
            json!(true)
        }
        _ => return Err("未知 Agent 操作".into()),
    };
    tx.commit().await.map_err(err)?;
    Ok(value)
}

/// `code` 为空时按角色解析默认模型。规划：agent_planner → text_assist；写作：agent_writer → agent_planner → text_assist
/// （正文质量跟着规划模型走）；评审、索引：各自偏好 → text_assist → agent_planner（调用多、要结构化输出，
/// 不该默认跟着思考型的规划模型）。与前端 `AI_MODEL_GROUPS` 的回退链一致。`role` 为空只看 text_assist。
pub async fn model_config(
    db: &mut SqliteConnection,
    code: &str,
    role: &str,
) -> Result<Value, String> {
    let raw = get(db, "app-settings", "ew-local-ai-models")
        .await?
        .ok_or("请先在模型管理中配置文本模型")?;
    let models: Value =
        serde_json::from_str(raw.as_str().ok_or("模型设置格式无效")?).map_err(err)?;
    let chain: Vec<&str> = match role {
        "agent_writer" => vec![role, "agent_planner", "text_assist"],
        "agent_critic" | "agent_indexer" => vec![role, "text_assist", "agent_planner"],
        "agent_planner" => vec!["agent_planner", "text_assist"],
        _ => vec!["text_assist"],
    };
    let preferences = &models["preferences"];
    let code = if code.is_empty() {
        chain
            .iter()
            .find_map(|key| preferences[*key].as_str().filter(|v| !v.is_empty()))
            .unwrap_or("")
    } else {
        code
    };
    let model = models["models"]
        .as_array()
        .and_then(|ms| ms.iter().find(|m| m["id"].to_string() == code))
        .ok_or("所选模型不存在")?;
    if model["status"] != 1 || model["scene"] != "text" {
        return Err("所选文本模型已停用".into());
    }
    // 本机部署（Ollama / LM Studio 等）不需要 Key，网关不带鉴权头；其他供应商缺 Key 先拦下并说清怎么补
    if model["provider"] != "local" && model["apiKey"].as_str().is_none_or(str::is_empty) {
        return Err("所选模型还没有填写 API Key，请在模型管理中补上".into());
    }
    Ok(model.clone())
}

// ---------------------------------------------------------------------------
// 写作工具的辅助：作者原话核验、成果渲染、段落定位
// ---------------------------------------------------------------------------
