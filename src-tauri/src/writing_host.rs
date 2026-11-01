//! 索引进程的调度：作者作品通道与参考书通道各自领取章节、调模型提取章节卡、写回状态层。
//! 还保留几个别的板块在用的入口（关闭与备份的锁、微信投递、重建索引）。
use crate::{writing_records::*, writing_service as service, DesktopAppHandle};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub struct WritingHost {
    pub(crate) gate: tokio::sync::Mutex<()>,
    pub(crate) storage_ready: AtomicBool,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    pub quitting: AtomicBool,
    maintenance: AtomicBool,
}
struct Job {
    active_book: Mutex<Option<String>>,
    cancelled: crate::story_extraction::Cancellation,
}
/// 每个索引通道有独立的执行槽与取消信号。
const INDEXER_JOB: &str = "__indexer__";
/// 参考书（拆书）索引通道：与作者作品的索引并行，一轮只领几章，暂停能很快生效。
/// 和索引器一样可以被关窗直接停止，事件留在 outbox，下次启动接着拆。
const REFERENCE_JOB: &str = "__reference_indexer__";
const SEARCH_JOB: &str = "__reference_search__";
const REFERENCE_BATCH: usize = 4;

impl WritingHost {
    pub fn active(&self) -> bool {
        self.jobs.lock().unwrap().len() > 0
    }
    pub fn stop_all(&self) {
        for job in self.jobs.lock().unwrap().values() {
            stop_job(job);
        }
    }
}
fn stop_job(job: &Job) {
    job.cancelled.cancel();
}

#[tauri::command]
pub async fn writing_workspace(
    app: DesktopAppHandle,
    action: String,
    args: Value,
) -> Result<Value, String> {
    let host = app.state::<WritingHost>();
    let root = crate::desktop_storage::root(&app)?;
    if action == "activity" {
        return Ok(json!({"active":host.active()}));
    }
    // 恢复与记录变更共用入口锁，不能只检查后台进程数量。
    let _gate = host.gate.lock().await;
    if action == "maintenance" {
        let mut jobs = host.jobs.lock().unwrap();
        if !jobs.is_empty() {
            return Err("还有后台任务在执行，请先停止再恢复数据".into());
        }
        host.maintenance.store(true, Ordering::SeqCst);
        jobs.clear();
        return Ok(json!(true));
    }
    if action == "end_maintenance" {
        host.maintenance.store(false, Ordering::SeqCst);
        return Ok(json!(true));
    }
    if action == "prepare_close" {
        host.stop_all();
        for _ in 0..100 {
            if !host.active() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if host.active() {
            return Err("后台任务仍在保存进度，请稍后退出".into());
        }
        return Ok(json!("close"));
    }
    if host.maintenance.load(Ordering::SeqCst) {
        return Err("数据恢复期间不可操作，请重启后继续".into());
    }
    // 微信主动推送：前端转来的通知进宿主投递队列，立即尝试发送，失败留队列补发
    if action == "delivery_flush" {
        let sent = crate::weixin_delivery::flush(&app, args["channel"].as_str().unwrap_or(""))?;
        return Ok(json!({"sent":sent}));
    }
    if action == "automation_notify" {
        let queued = {
            let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
            crate::weixin_delivery::enqueue(
                &mut db,
                args["channel"]
                    .as_str()
                    .unwrap_or(crate::weixin_delivery::WEIXIN),
                args["text"].as_str().unwrap_or(""),
                args["key"].as_str().unwrap_or(""),
                json!({"event":"frontend"}),
            )
            .await?
        };
        let Some(record) = queued else {
            return Ok(json!({"outcome":"skipped"}));
        };
        let sent = crate::weixin_delivery::flush(&app, record["channel"].as_str().unwrap_or(""))
            .unwrap_or(0);
        return Ok(json!({"outcome":if sent > 0 { "sent" } else { "queued" },"id":record["id"]}));
    }
    if action == "index_rebuild" {
        let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
        let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
        let chapter_ids: Vec<String> = args["chapterIds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let queued = if chapter_ids.is_empty() {
            crate::story_index::enqueue_book(
                &mut tx,
                str_field(&args, "bookId")?,
                args["onlyMissing"] == true,
            )
            .await?
        } else {
            // 写作台"重新整理本章"：只补这一章；已有章节卡的先作废再入队
            for cid in &chapter_ids {
                crate::story_state::remove_card(&mut tx, str_field(&args, "bookId")?, cid).await?;
            }
            crate::story_index::enqueue_chapters(&mut tx, str_field(&args, "bookId")?, &chapter_ids)
                .await?
        };
        tx.commit().await.map_err(err)?;
        if queued > 0 {
            schedule_index(app.clone(), Duration::from_millis(0));
        }
        return Ok(json!({"queued":queued}));
    }
    let result = service::command(&root, &action, &args).await?;
    if action == "story_memory_pause" {
        if let Some(job) = host.jobs.lock().unwrap().get(INDEXER_JOB) {
            if job.active_book.lock().unwrap().as_deref() == args["bookId"].as_str() {
                stop_job(job);
            }
        }
    }
    if action == "story_memory_backfill" {
        schedule_index(app.clone(), Duration::ZERO);
    }
    // 作者改了线索裁决或备注：写作台跟着刷新
    if [
        "canon_mark",
        "add_note",
        "delete_note",
        "story_memory_correct",
        "story_memory_pause",
    ]
    .contains(&action.as_str())
    {
        let book_id = args["bookId"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or(result["bookId"].as_str());
        crate::writing_events::emit(
            &app,
            "agent-canon-changed",
            json!({"bookId":book_id,"reason":action}),
        );
    }
    Ok(result)
}

/// 为索引通道登记一个执行槽，防止同一通道重复执行。
fn claim_job(host: &WritingHost, sid: &str) -> Result<Arc<Job>, String> {
    let job = Arc::new(Job {
        active_book: Mutex::default(),
        cancelled: crate::story_extraction::Cancellation::default(),
    });
    let mut jobs = host.jobs.lock().unwrap();
    if host.maintenance.load(Ordering::SeqCst) {
        return Err("正在恢复数据".into());
    }
    if jobs.contains_key(sid) {
        return Err("该索引通道已有任务".into());
    }
    jobs.insert(sid.to_owned(), job.clone());
    Ok(job)
}

// ---------------------------------------------------------------------------
// 索引器：独立于会话的后台进程。按 outbox 领取事件，目录与资料事件直接完成，
// 章节事件交给索引模型提取章节卡；同一时刻只有一个索引器在跑。
// ---------------------------------------------------------------------------

/// 延迟后启动一轮索引。启动、会话结束、作者点“立即索引”都走这里；已有索引器在跑就交给它。
pub fn schedule_index(app: DesktopAppHandle, delay: Duration) {
    std::thread::spawn(move || {
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        // 参考书通道各跑各的：启动恢复、运行结束触发时一并看看有没有没拆完的书
        schedule_reference_index(app.clone());
        schedule_reference_search(app.clone());
        let host = app.state::<WritingHost>();
        if !host.storage_ready.load(Ordering::SeqCst)
            || host.quitting.load(Ordering::SeqCst)
            || host.maintenance.load(Ordering::SeqCst)
        {
            return;
        }
        let job = match claim_job(&host, INDEXER_JOB) {
            Ok(job) => job,
            Err(_) => return,
        };
        let outcome = index_rounds(
            &app,
            &job,
            crate::story_index::QUIET_MS,
            crate::story_index::Lane::Author,
        );
        host.jobs.lock().unwrap().remove(INDEXER_JOB);
        emit_index(&app, &outcome);
    });
}

/// 变更事件等了这么久还没处理就补跑索引。
const BACKLOG_AGE_MS: i64 = 60_000;
const WATCH_TICK: Duration = Duration::from_secs(30);
const WATCH_MIN: Duration = Duration::from_secs(60);
const WATCH_MAX: Duration = Duration::from_secs(600);

/// 后台巡检：作者一直在写、没触发 Agent 运行时，变更事件积压超过一分钟也会补跑索引。
/// 一轮下来一章都没写成（多半没配模型或供应商故障）就逐步放慢，最长十分钟一次；有进展恢复一分钟。
pub fn start_index_watch(app: DesktopAppHandle) {
    std::thread::spawn(move || {
        let Ok(root) = crate::desktop_storage::root(&app) else {
            return;
        };
        let mut wait = WATCH_MIN;
        let mut last = Instant::now();
        loop {
            std::thread::sleep(WATCH_TICK);
            let host = app.state::<WritingHost>();
            if host.quitting.load(Ordering::SeqCst) {
                return;
            }
            if !host.storage_ready.load(Ordering::SeqCst) || host.maintenance.load(Ordering::SeqCst)
            {
                continue;
            }
            schedule_reference_search(app.clone());
            // 参考书通道不受作者通道的退避影响：有没拆完的书就接上（已在拆时什么都不做）
            let reference_due = crate::blocking::run(async {
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                crate::story_index::backlog_due_in(
                    &mut db,
                    now(),
                    BACKLOG_AGE_MS,
                    Some(crate::story_index::Lane::Reference),
                )
                .await
            })
            .unwrap_or(false);
            if reference_due {
                schedule_reference_index(app.clone());
            }
            if last.elapsed() < wait {
                continue;
            }
            let due = crate::blocking::run(async {
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                crate::story_index::backlog_due_in(
                    &mut db,
                    now(),
                    BACKLOG_AGE_MS,
                    Some(crate::story_index::Lane::Author),
                )
                .await
            })
            .unwrap_or(false);
            if !due {
                wait = WATCH_MIN;
                continue;
            }
            // 已有索引器在跑（运行结束触发的、作者手动的）就等下一轮
            let Ok(job) = claim_job(&host, INDEXER_JOB) else {
                continue;
            };
            last = Instant::now();
            let outcome = index_rounds(
                &app,
                &job,
                crate::story_index::QUIET_MS,
                crate::story_index::Lane::Author,
            );
            host.jobs.lock().unwrap().remove(INDEXER_JOB);
            emit_index(&app, &outcome);
            let progressed = outcome
                .as_ref()
                .is_ok_and(|v| v["completed"].as_u64().unwrap_or(0) > 0);
            wait = if progressed {
                WATCH_MIN
            } else {
                (wait * 2).min(WATCH_MAX)
            };
        }
    });
}

fn emit_index(app: &DesktopAppHandle, outcome: &Result<Value, String>) {
    let payload = match outcome {
        Ok(v) => json!({"event":"index_finished","summary":v}),
        Err(e) => json!({"event":"index_failed","message":e}),
    };
    crate::writing_events::emit(app, "agent-index", payload);
}

/// 反复领取直到没有可领取的事件。安静期内的事件领不到时，若还有待处理事件就等一个安静期再试，
/// 最多等三次，避免作者连续编辑时索引器长期空转。
///
/// 作者作品通道一次最多 50 轮；参考书通道一轮只领几章、一直拆到没有事件，每轮把用量记进拆书任务。
fn index_rounds(
    app: &DesktopAppHandle,
    job: &Arc<Job>,
    quiet_ms: i64,
    lane: crate::story_index::Lane,
) -> Result<Value, String> {
    use crate::story_index as indexer;
    let reference = lane == indexer::Lane::Reference;
    let root = crate::desktop_storage::root(app)?;
    let (limit, max_rounds) = if reference {
        (REFERENCE_BATCH, usize::MAX)
    } else {
        (1, 50)
    };
    let mut summary = json!({"rounds":0,"completed":0,"retried":0,"givenUp":0,"skippedPaused":0,"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}});
    let mut waited = 0;
    let mut rounds = 0usize;
    // 参考书通道连续几轮都只是模型输出格式不对（不是服务故障）：单章失败照常计次重试，连续两轮才停
    let mut format_only_rounds = 0;
    while rounds < max_rounds {
        rounds += 1;
        if job.cancelled.is_cancelled()
            || app.state::<WritingHost>().quitting.load(Ordering::SeqCst)
        {
            summary["stopped"] = json!(true);
            break;
        }
        let run_id = format!("index:{}", id());
        let batch = crate::blocking::run(async {
            let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
            let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
            let batch =
                indexer::prepare_batch_in(&mut tx, &run_id, limit, quiet_ms, Some(lane)).await?;
            tx.commit().await.map_err(err)?;
            Ok::<_, String>(batch)
        })?;
        summary["skippedPaused"] =
            json!(summary["skippedPaused"].as_u64().unwrap_or(0) + batch.skipped_paused as u64);
        if batch.jobs.is_empty() && batch.pending.is_empty() && batch.books.is_empty() {
            let pending = crate::blocking::run(async {
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                indexer::pending_in(&mut db, lane).await
            })?;
            if quiet_ms > 0 && pending > 0 && waited < 3 {
                waited += 1;
                if crate::blocking::run(
                    job.cancelled
                        .wait_for_stop(Duration::from_millis(quiet_ms as u64)),
                ) {
                    summary["stopped"] = json!(true);
                    break;
                }
                continue;
            }
            break;
        }
        let (saved, failures, usage, _book_usage) = if batch.jobs.is_empty() {
            (BTreeSet::new(), Vec::new(), Value::Null, HashMap::new())
        } else {
            if !reference {
                let bid = str_field(&batch.jobs[0], "bookId")?;
                *job.active_book.lock().unwrap() = Some(bid.to_owned());
                let paused = crate::blocking::run(async {
                    let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                    crate::story_index::index_paused(&mut db, bid).await
                })?;
                if paused {
                    stop_job(job);
                }
            }
            let selected = crate::blocking::run(async {
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                let role = batch.jobs[0]["modelCode"].as_str().unwrap_or("");
                match service::model_config(&mut db, role, "agent_indexer").await {
                    Ok(model) => Ok(Some(model)),
                    Err(_) => {
                        indexer::release(&mut db, &run_id).await?;
                        Ok::<_, String>(None)
                    }
                }
            })?;
            let Some(selected) = selected else {
                summary["skipped"] = json!("no_model");
                break;
            };
            match crate::story_extraction::index_jobs(
                app,
                &root,
                &selected,
                &batch.jobs,
                &job.cancelled,
            ) {
                Ok(out) => (out.saved, out.failures, out.usage, out.book_usage),
                Err(error) => {
                    crate::blocking::run(async {
                        let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                        crate::story_index::release(&mut db, &run_id).await?;
                        Ok::<_, String>(())
                    })?;
                    if reference {
                        eprintln!("参考书索引失败：{error}");
                    }
                    return Err(error);
                }
            }
        };
        *job.active_book.lock().unwrap() = None;
        // 作者暂停、取消或应用退出时停掉的进程：没写成的章节放回队列，不算失败
        let interrupted = job.cancelled.is_cancelled();
        let finished = crate::blocking::run(async {
            let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
            let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
            let out = indexer::finish_batch_with(
                &mut tx,
                &run_id,
                &batch,
                &saved,
                &failures,
                interrupted,
            )
            .await?;
            tx.commit().await.map_err(err)?;
            Ok::<_, String>(out)
        })?;
        summary["rounds"] = json!(summary["rounds"].as_u64().unwrap_or(0) + 1);
        for key in ["completed", "retried", "givenUp"] {
            summary[key] =
                json!(summary[key].as_u64().unwrap_or(0) + finished[key].as_u64().unwrap_or(0));
        }
        if usage.is_object() {
            for key in ["input_tokens", "output_tokens", "total_tokens"] {
                summary["usage"][key] = json!(
                    summary["usage"][key].as_u64().unwrap_or(0) + usage[key].as_u64().unwrap_or(0)
                );
            }
        }
        for book_id in &batch.books {
            crate::writing_events::emit(
                app,
                "agent-index",
                json!({"event":"index_book","bookId":book_id}),
            );
            // 写作台的体检、状态账本、编辑器上下文缓存据此刷新
            crate::writing_events::emit(
                app,
                "agent-canon-changed",
                json!({"bookId":book_id,"reason":"index"}),
            );
        }
        // 模型一章都没写成（多半是供应商故障）时不再继续领取，失败计数已在 finish_batch 记录。
        if !batch.jobs.is_empty() && saved.is_empty() && !interrupted {
            let format_only = !failures.is_empty()
                && failures
                    .iter()
                    .all(|f| matches!(f["code"].as_str(), Some("invalid_output" | "output_limit")));
            if reference && format_only {
                format_only_rounds += 1;
                if format_only_rounds < 2 {
                    continue;
                }
            }
            summary["aborted"] = json!("all_failed");
            if reference {
                let reason = failures
                    .iter()
                    .find_map(|f| f["message"].as_str())
                    .unwrap_or("这一轮的章节全部提取失败");
                let advice = if format_only {
                    "当前模型连续几章都没按格式返回章节卡，可以点继续重试，或在模型管理里给“Agent 索引”换一个模型"
                } else {
                    "多半是模型服务暂时不可用，检查模型设置或网络后点继续"
                };
                eprintln!("章节卡提取失败：{reason}。{advice}。");
            }
            break;
        }
        format_only_rounds = 0;
    }
    Ok(summary)
}

/// 参考书通道：有排队的拆书事件就在后台线程里一直拆。被作者暂停某本书打断时（只停当前进程），
/// 还有别的书在排队就换一个新任务接着拆；应用退出或维护时直接结束。
pub fn schedule_reference_index(app: DesktopAppHandle) {
    std::thread::spawn(move || loop {
        let host = app.state::<WritingHost>();
        if !host.storage_ready.load(Ordering::SeqCst)
            || host.quitting.load(Ordering::SeqCst)
            || host.maintenance.load(Ordering::SeqCst)
        {
            return;
        }
        let Ok(root) = crate::desktop_storage::root(&app) else {
            return;
        };
        let pending = crate::blocking::run(async {
            let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
            crate::story_index::pending_in(&mut db, crate::story_index::Lane::Reference).await
        })
        .unwrap_or(0);
        if pending == 0 {
            return;
        }
        let Ok(job) = claim_job(&host, REFERENCE_JOB) else {
            return;
        };
        let outcome = index_rounds(&app, &job, 0, crate::story_index::Lane::Reference);
        host.jobs.lock().unwrap().remove(REFERENCE_JOB);
        crate::writing_events::emit(
            &app,
            "agent-index",
            json!({"event":"index_finished","lane":"reference","summary":outcome.as_ref().ok()}),
        );
        // 作者暂停某本书打断了进程，或这一趟有进展（收尾时可能又有书排进来）：再看一眼队列。
        // 一章都没拆成（供应商故障等）就停下，等巡检或作者操作再来，不在这里空转。
        let again = outcome
            .as_ref()
            .is_ok_and(|v| v["stopped"] == true || v["completed"].as_u64().unwrap_or(0) > 0);
        if !again {
            return;
        }
    });
}

// ---------------------------------------------------------------------------
// 参考书全文检索：与模型提取分开执行。
// ---------------------------------------------------------------------------

/// 全文检索与模型拆书分离；每批最多四章，一个短事务，应用退出可由游标恢复。
fn schedule_reference_search(app: DesktopAppHandle) {
    std::thread::spawn(move || {
        let host = app.state::<WritingHost>();
        if !host.storage_ready.load(Ordering::SeqCst) || host.maintenance.load(Ordering::SeqCst) {
            return;
        }
        let Ok(job) = claim_job(&host, SEARCH_JOB) else {
            return;
        };
        let result = (|| -> Result<(), String> {
            let root = crate::desktop_storage::root(&app)?;
            while !job.cancelled.is_cancelled() && !host.quitting.load(Ordering::SeqCst) {
                if !crate::blocking::run(crate::reference_import::index_next(&root))? {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(())
        })();
        host.jobs.lock().unwrap().remove(SEARCH_JOB);
        if let Err(error) = result {
            eprintln!("参考书检索待续建：{error}");
        }
    });
}
