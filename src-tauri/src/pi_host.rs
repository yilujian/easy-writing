//! Pi 版本专用进程桥。执行循环、会话和事件来自完整 Pi RPC，不进入旧 Agent。
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[path = "pi_attachments.rs"]
mod attachments;
#[path = "pi_adoption.rs"]
mod adoption;
#[path = "pi_prose_range.rs"]
mod prose_range;
#[path = "pi_breakdown.rs"]
mod breakdown;
#[path = "pi_breakdown_tasks.rs"]
mod breakdown_tasks;
#[path = "pi_catalog.rs"]
mod catalog;
#[path = "pi_run_control.rs"]
mod run_control;
#[path = "pi_task_identity.rs"]
mod task_identity;
#[path = "pi_platform.rs"]
mod platform;
#[path = "pi_context.rs"]
mod context;
#[path = "pi_memory.rs"]
mod memory;
#[path = "pi_control.rs"]
mod control;
#[path = "pi_drafts.rs"]
mod drafts;
#[path = "pi_entities.rs"]
mod entities;
#[path = "pi_skills.rs"]
mod skills;
#[path = "pi_distillation.rs"]
mod distillation;
#[path = "pi_batch.rs"]
mod batch;
#[path = "pi_cover.rs"]
mod cover;
#[path = "pi_sessions.rs"]
mod sessions_meta;
use control::{Instance, PendingTool, ToolCall};
use tokio::sync::oneshot;

const TOOLS: &[&str] = &[
    "control_session",
    "list_books",
    "read_book",
    "list_chapters",
    "read_chapter",
    "write_prose",
    "search_chapters",
    "plan_chapters",
    "read_references",
    "read_memory",
    "remember_memory",
    "forget_memory",
    "save_draft",
    "save_new_chapter_draft",
    "save_outline_draft",
    "list_drafts",
    "save_creation_draft",
    "confirm_materials",
    "save_skill_draft",
    "read_breakdown",
    "run_breakdown",
    "run_distillation",
    "run_batch",
    "make_cover",
    "control_task",
    "reparse_book_attachment",
    "list_rankings",
    "read_rankings",
    "refresh_rankings",
    "run_skill_script",
    "read_style_examples",
    "search_writing_resources",
    "read_writing_resource",
];
fn public_tool_names() -> String {
    let groups: Value = serde_json::from_str(include_str!("../../agent-pi/contracts/tool-groups.json")).expect("tool groups");
    let groups = groups.as_object().expect("tool groups object");
    let grouped: Vec<&str> = groups.values().flat_map(|g| g["operations"].as_object().into_iter().flat_map(|ops| ops.values().filter_map(Value::as_str))).collect();
    TOOLS.iter().copied().filter(|name| groups.contains_key(*name) || !grouped.contains(name))
        .chain(["ask_author", "read", "prepare_writing"]).collect::<Vec<_>>().join(",")
}
const COMMANDS: &[&str] = &[
    "prompt",
    "abort",
    "clear_queue",
    "get_state",
    "get_messages",
    "get_entries",
    "set_session_name",
    "compact",
    "set_thinking_level",
    "get_commands",
];
#[derive(Default)]
pub struct PiHost {
    gate: tokio::sync::Mutex<()>,
    exit: control::ExitGate,
    quit_requested: AtomicBool,
    workers: Mutex<HashMap<String, Worker>>,
}
struct Worker {
    id: String,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Child,
    instance: Arc<Instance>,
    session_file: Option<String>,
    client_key: String,
    model_code: String,
    model_version: String,
    book: Value,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[cfg(not(debug_assertions))]
static PACKAGED_PROJECT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn initialize_resources(_app: &crate::DesktopAppHandle) -> tauri::Result<()> {
    #[cfg(not(debug_assertions))]
    {
        let path = _app.path().resource_dir()?.join("resources/agent-pi");
        PACKAGED_PROJECT.get_or_init(|| dunce::simplified(&path).to_path_buf());
    }
    Ok(())
}

fn project() -> PathBuf {
    #[cfg(debug_assertions)]
    { Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent-pi") }
    #[cfg(not(debug_assertions))]
    { PACKAGED_PROJECT.get().expect("Pi resources initialized during application setup").clone() }
}

fn pi_root(root: &Path) -> PathBuf {
    root.join("pi-agent")
}
/// Pi's global defaults retry both the provider request and the entire agent turn. In the
/// app-owned workspace an interrupted paid request is retried only on new author input.
fn configure_runtime(settings_dir: &Path) -> Result<(), String> {
    // RPC sessions do not trust project settings. This directory is the private
    // PI_CODING_AGENT_DIR used only for this installation of the writing Agent.
    let dir = settings_dir;
    fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join("settings.json");
    let mut settings: Value = match fs::read(&path) {
        Ok(data) => serde_json::from_slice(&data).map_err(err)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(err(e)),
    };
    let obj = settings.as_object_mut().ok_or("Agent 设置格式无效")?;
    let retry = obj
        .entry("retry")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Agent 重试设置无效")?;
    let enabled = retry.get("enabled") == Some(&Value::Bool(false));
    let provider = retry
        .entry("provider")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("模型重试设置无效")?;
    if enabled && provider.get("maxRetries").and_then(Value::as_u64) == Some(0) {
        return Ok(());
    }
    provider.insert("maxRetries".into(), json!(0));
    retry.insert("enabled".into(), json!(false));
    let temporary = dir.join(format!(".settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = fs::write(
        &temporary,
        serde_json::to_vec_pretty(&settings).map_err(err)?,
    )
    .and_then(|()| fs::rename(&temporary, &path))
    .map_err(err);
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn sessions(root: &Path) -> PathBuf {
    pi_root(root).join("sessions")
}
fn skill_dirs(root: &Path) -> skills::Dirs {
    skills::dirs(&project().join("skills"), &pi_root(root))
}
fn require_main(window: &crate::DesktopWebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|u| crate::is_app_shell_url(&u)) {
        return Err("仅主窗口可操作 Agent".into());
    }
    Ok(())
}
fn runtime() -> Result<(PathBuf, PathBuf), String> {
    let path = project();
    #[cfg(debug_assertions)]
    let (node, cli) = {
        let config: Value = serde_json::from_slice(&fs::read(path.join("runtime.json"))
            .map_err(|_| "Agent 开发环境尚未就绪，请初始化 Pi 运行时")?).map_err(err)?;
        (PathBuf::from(config["node"].as_str().ok_or("Agent 运行环境配置不完整")?),
         path.join("upstream/packages/coding-agent/dist/cli.js"))
    };
    #[cfg(not(debug_assertions))]
    let (node, cli) = (path.join(if cfg!(windows) { "bin/node.exe" } else { "bin/node" }),
        path.join("pi/dist/bundle/cli.js"));
    if !node.is_file() || !cli.is_file() {
        return Err("Agent 运行环境不完整，请重新安装或初始化运行环境。".into());
    }
    Ok((node, cli))
}
fn session_path(root: &Path, file: &str) -> Result<PathBuf, String> {
    if file.contains(['/', '\\']) || !file.ends_with(".jsonl") {
        return Err("会话路径无效".into());
    }
    let folder = sessions(root).canonicalize().map_err(err)?;
    let path = folder.join(file).canonicalize().map_err(err)?;
    if !path.starts_with(folder) {
        return Err("会话路径越界".into());
    }
    Ok(dunce::simplified(&path).to_path_buf())
}
fn list_sessions(root: &Path) -> Result<Vec<Value>, String> {
    let folder = sessions(root);
    fs::create_dir_all(&folder).map_err(err)?;
    let mut out = vec![];
    for entry in fs::read_dir(&folder).map_err(err)? {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl")
            || !entry.file_type().map_err(err)?.is_file()
        {
            continue;
        }
        let mut id = String::new();
        let mut title = String::new();
        let mut named = false;
        let mut book = Value::Null;
        for line in BufReader::new(fs::File::open(&path).map_err(err)?).lines() {
            let line = line.map_err(err)?;
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match v["type"].as_str() {
                Some("session") => id = v["id"].as_str().unwrap_or_default().into(),
                Some("session_info") => {
                    if let Some(name) = v["name"].as_str().filter(|n| !n.trim().is_empty()) {
                        title = name.trim().into();
                        named = true;
                    }
                }
                Some("custom") if v["customType"] == "yichuang-book" => book = v["data"].clone(),
                Some("message") if title.is_empty() && v["message"]["role"] == "user" => {
                    let text = match &v["message"]["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(parts) => parts
                            .iter()
                            .filter_map(|p| p["text"].as_str())
                            .collect::<String>(),
                        _ => String::new(),
                    };
                    title = sessions_meta::derived_title(&text);
                }
                _ => {}
            }
        }
        if !id.is_empty() {
            let updated = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(json!({"id":id,"file":entry.file_name().to_string_lossy(),"title":if title.is_empty(){"新对话".into()}else{title},"named":named,"book":book,"updatedAt":updated}));
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or(0)));
    Ok(out)
}
fn model_version(model:&Value)->String{
    let settings:Vec<_>=["provider","modelCode","baseUrl","apiKey","maxContext","maxOutputTokens","thinking","extraParams"].iter().map(|k|&model[*k]).collect();
    crate::book_materials::version(&json!(settings))
}
async fn read_model(root: &Path, code: &str) -> Result<Value, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?",
    )
    .bind(json!("ew-local-ai-models").to_string())
    .fetch_optional(&mut db)
    .await
    .map_err(err)?;
    let stored: String =
        serde_json::from_str(&raw.ok_or("请先在模型管理配置模型")?).map_err(err)?;
    let data: Value = serde_json::from_str(&stored).map_err(err)?;
    data["models"]
        .as_array()
        .and_then(|models| {
            models
                .iter()
                .find(|m| m["id"].to_string() == code && m["status"] == 1 && m["scene"] == "text")
        })
        .cloned()
        .ok_or("所选文本模型不可用".into())
}
async fn read_book(root: &Path, id: &str) -> Result<Value, String> {
    if id.is_empty() {
        return Ok(Value::Null);
    }
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let row = sqlx::query(
        "SELECT payload FROM local_books WHERE CAST(id AS TEXT)=? AND deletedAt IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut db)
    .await
    .map_err(err)?
    .ok_or("作品不存在或已删除")?;
    let value: Value = serde_json::from_str(row.get("payload")).map_err(err)?;
    Ok(json!({"id":id,"title":value["title"]}))
}
fn cancel_notice(app: &crate::DesktopAppHandle, instance: &Instance, ids: Vec<String>) {
    if !ids.is_empty() {
        let _ = app.emit_to(
            "main",
            "pi-tools-cancelled",
            json!({"instanceId":instance.id,"ids":ids}),
        );
    }
}
impl PiHost {
    async fn active_work(&self, id: &str) -> Result<bool, String> {
        let instance = self.instance(id)?;
        // 意外退出已撤销工具资格。残留的进程句柄由 close/maintenance 回收，不要求作者停止一个不存在的任务。
        if !instance.alive.load(Ordering::SeqCst) {
            return Ok(instance.has_writes());
        }
        if !instance.accepting.load(Ordering::SeqCst) {
            return Ok(true);
        }
        let state = self.request(id, json!({"type":"get_state"})).await?;
        Ok(state["isStreaming"] == true
            || state["isCompacting"] == true
            || state["pendingMessageCount"].as_u64().unwrap_or(0) > 0
            || instance.has_writes()
            || instance.has_tools())
    }
    /// 菜单退出先记录意图，作者取消 Pi 关闭确认时不能提前停止旧 Agent。
    pub fn request_quit(&self) {
        self.quit_requested.store(true, Ordering::SeqCst);
    }
    fn ids(&self) -> Vec<String> {
        self.workers.lock().unwrap().keys().cloned().collect()
    }
    fn instance(&self, id: &str) -> Result<Arc<Instance>, String> {
        self.workers
            .lock()
            .unwrap()
            .get(id)
            .map(|w| w.instance.clone())
            .ok_or("Agent 会话已退出".into())
    }
    /// A document navigation loses its JS controllers. Invalidate only the instances owned by
    /// the departing document. A route change inside the same document never calls this.
    pub fn document_reloading(&self, app: &crate::DesktopAppHandle) {
        let instances: Vec<_> = self
            .workers
            .lock()
            .unwrap()
            .values()
            .map(|worker| {
                let i = worker.instance.clone();
                let active = i.turn_running.load(Ordering::SeqCst)
                    || i.has_tools()
                    || i.has_writes()
                    || i.author_input.lock().unwrap().is_some();
                (i, active)
            })
            .collect();
        if instances.is_empty() {
            return;
        }
        for (instance, _) in &instances {
            instance.revoke();
            let _ = self.send(&instance.id, &json!({"type":"abort"}));
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            for (instance, was_active) in instances {
                if host.instance(&instance.id).is_err() {
                    continue;
                }
                let sid = instance.session_id.lock().unwrap().clone();
                if was_active && !sid.is_empty() {
                    if let Ok(root) = crate::desktop_storage::root(&app) {
                        if let Err(error) =
                            run_control::change(&root, &sid, "pause", false, None).await
                        {
                            eprintln!("刷新窗口时未能保存对话暂停状态：{error}");
                        }
                    }
                }
                if let Err(error) = host.stop_revoked(&instance.id).await {
                    eprintln!("刷新窗口时停止 Agent 失败：{error}");
                    if let Some(mut worker) = host.workers.lock().unwrap().remove(&instance.id) {
                        worker.instance.exited();
                        worker.stdin.lock().unwrap().take();
                        let _ = worker.child.kill();
                        let _ = worker.child.wait();
                    }
                }
            }
        });
    }
    // 应用最终退出兜底；普通停止只处理指定对话。
    pub fn stop_all(&self) {
        let workers: Vec<Worker> = self
            .workers
            .lock()
            .unwrap()
            .drain()
            .map(|(_, w)| w)
            .collect();
        for mut worker in workers {
            worker.instance.exited();
            worker.stdin.lock().unwrap().take();
            let until = Instant::now() + Duration::from_secs(2);
            loop {
                if worker.child.try_wait().ok().flatten().is_some() {
                    break;
                }
                if Instant::now() >= until {
                    let _ = worker.child.kill();
                    let _ = worker.child.wait();
                    break;
                }
                thread::sleep(Duration::from_millis(30));
            }
        }
    }
    async fn close_instances(&self, app: &crate::DesktopAppHandle) -> Result<(), String> {
        let results = futures_util::future::join_all(
            self.ids()
                .into_iter()
                .map(|id| async move { self.stop_instance(app, &id).await }),
        )
        .await;
        results
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map(|_| ())
    }
    fn send(&self, instance: &str, command: &Value) -> Result<(), String> {
        let workers = self.workers.lock().unwrap();
        let w = workers.get(instance).ok_or("Agent 会话尚未启动或已退出")?;
        let name = command["type"].as_str().ok_or("缺少 Agent 命令")?;
        if ![
            "abort",
            "clear_queue",
            "get_state",
            "get_messages",
            "get_entries",
        ]
        .contains(&name)
        {
            self.exit.check_runtime()?;
        }
        if !COMMANDS.contains(&name) && name != "extension_ui_response" {
            return Err("未开放此 Agent 命令".into());
        }
        if name == "prompt" && w.instance.has_writes() {
            return Err("平台草稿操作正在收尾，请稍后发送".into());
        }
        if !w.instance.accepting.load(Ordering::SeqCst)
            && ![
                "abort",
                "clear_queue",
                "get_state",
                "get_messages",
                "get_entries",
            ]
            .contains(&name)
        {
            return Err("Agent 实例已撤销，请完成停止后恢复会话".into());
        }
        let mut input = w.stdin.lock().unwrap();
        let input = input.as_mut().ok_or("Agent 进程已退出")?;
        serde_json::to_writer(&mut *input, command).map_err(err)?;
        input.write_all(b"\n").map_err(err)?;
        input.flush().map_err(err)
    }
    fn start_request(
        &self,
        id: &str,
        mut command: Value,
    ) -> Result<(Arc<Instance>, String, oneshot::Receiver<control::Reply>), String> {
        let instance = self.instance(id)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        if !command.is_object() {
            return Err("Agent 命令无效".into());
        }
        command["id"] = json!(request_id);
        let (tx, rx) = oneshot::channel();
        instance.rpc.lock().unwrap().insert(request_id.clone(), tx);
        if let Err(error) = self.send(id, &command) {
            instance.rpc.lock().unwrap().remove(&request_id);
            return Err(error);
        }
        Ok((instance, request_id, rx))
    }
    async fn request(&self, id: &str, command: Value) -> Result<Value, String> {
        let abort = command["type"] == "abort";
        let (instance, request_id, rx) = self.start_request(id, command)?;
        let result =
            tokio::time::timeout(Duration::from_secs(if abort { 60 } else { 20 }), rx).await;
        instance.rpc.lock().unwrap().remove(&request_id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Agent 进程已退出，命令结果未确认".into()),
            Err(_) => Err("Agent 命令响应超时，执行结果尚未确认；请停止当前任务后再重试".into()),
        }
    }
    fn child_exited(&self, id: &str) -> Result<bool, String> {
        let mut workers = self.workers.lock().unwrap();
        let w = workers.get_mut(id).ok_or("Agent 会话已切换")?;
        Ok(w.child.try_wait().map_err(err)?.is_some())
    }
    async fn stop_instance(
        &self,
        app: &crate::DesktopAppHandle,
        id: &str,
    ) -> Result<Value, String> {
        let instance = self.instance(id)?;
        cancel_notice(app, &instance, instance.revoke());
        self.stop_revoked(id).await
    }
    async fn stop_revoked(&self, id: &str) -> Result<Value, String> {
        let instance = self.instance(id)?;
        instance.revoke();
        let mut state = Value::Null;
        let mut messages = Value::Null;
        let mut history = Value::Null;
        if instance.alive.load(Ordering::SeqCst) {
            // 两条命令先分别发出。clear_queue 丢回执不能阻止 abort。
            let clear = self.start_request(id, json!({"type":"clear_queue"}));
            let aborted = self.request(id, json!({"type":"abort"})).await;
            if let Ok((scope, request, _)) = clear {
                scope.rpc.lock().unwrap().remove(&request);
            }
            if instance.alive.load(Ordering::SeqCst) {
                aborted?;
                let (s, m, h) = tokio::try_join!(
                    self.request(id, json!({"type":"get_state"})),
                    self.request(id, json!({"type":"get_messages"})),
                    self.request(id, json!({"type":"get_entries"}))
                )?;
                state = s;
                messages = m["messages"].clone();
                history = h;
            }
        }
        instance.drain_writes().await?;
        {
            let workers = self.workers.lock().unwrap();
            let w = workers.get(id).ok_or("Agent 会话已切换")?;
            w.stdin.lock().unwrap().take(); // Pi 原生 EOF 关闭会话并刷新文件。
        }
        let until = tokio::time::Instant::now() + Duration::from_secs(10);
        while !self.child_exited(id)? {
            if tokio::time::Instant::now() >= until {
                return Err("Agent 尚未退出，停止未确认完成；请重试停止".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        instance.exited();
        self.workers.lock().unwrap().remove(id);
        Ok(json!({"state":state,"messages":messages,"history":history}))
    }
}

#[cfg(all(test, feature = "local-tests"))]
#[path = "pi_tests.rs"]
mod tests;
fn respond(mut stream: TcpStream, status: &str, body: Value) {
    let body = body.to_string();
    let _ = write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
}
fn tool_request_line(reader: &mut impl BufRead) -> Option<String> {
    let mut line = String::new();
    // fetch 连接池可能预建空闲连接。还没收到请求就超时/断开时只能关闭，
    // 不能发送 400，否则这份旧响应会被客户端当成下一次工具调用的结果。
    match reader.read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line),
    }
}
fn configure_tool_stream(stream: &TcpStream) -> std::io::Result<()> {
    // 监听器非阻塞用于退出检查；macOS 的 accepted socket 会继承该模式。
    // 每个连接已交给独立线程，必须显式恢复阻塞读取，不能把尚未到达的请求当成断连。
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))
}
fn handle_tool(
    mut stream: TcpStream,
    app: crate::DesktopAppHandle,
    token: String,
    instance: Arc<Instance>,
    book: Value,
) {
    if configure_tool_stream(&stream).is_err() {
        return;
    }
    let mut reader = BufReader::new(&mut stream);
    let Some(mut line) = tool_request_line(&mut reader) else {
        return;
    };
    let cancel = line.trim() == "POST /cancel HTTP/1.1";
    let snapshot = line.trim() == "POST /context HTTP/1.1";
    let deciding = line.trim() == "POST /author-input HTTP/1.1";
    let ranking_complete = line.trim() == "POST /ranking-complete HTTP/1.1";
    if !cancel && !snapshot && !deciding && !ranking_complete && line.trim() != "POST /tool HTTP/1.1" {
        return respond(stream, "400 Bad Request", json!({"error":"请求无效"}));
    }
    let mut auth = false;
    let mut size = 0usize;
    let mut header_bytes = 0;
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        header_bytes += line.len();
        if header_bytes > 16384 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("authorization") {
                auth = value.trim() == format!("Bearer {token}");
            }
            if key.eq_ignore_ascii_case("content-length") {
                size = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if !auth || !instance.alive.load(Ordering::SeqCst) {
        return respond(stream, "403 Forbidden", json!({"error":"会话授权无效"}));
    }
    if size == 0 || size > 2_000_000 {
        return respond(
            stream,
            "413 Payload Too Large",
            json!({"error":"请求大小无效"}),
        );
    }
    let mut bytes = vec![0; size];
    if reader.read_exact(&mut bytes).is_err() {
        return;
    }
    drop(reader);
    let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
        return respond(stream, "400 Bad Request", json!({"error":"参数无效"}));
    };
    let id = body["requestId"].as_str().unwrap_or_default().to_owned();
    if uuid::Uuid::parse_str(&id).is_err() {
        return respond(
            stream,
            "400 Bad Request",
            json!({"error":"工具请求编号无效"}),
        );
    }
    if cancel {
        instance.cancel(&id);
        cancel_notice(&app, &instance, vec![id]);
        return respond(stream, "200 OK", json!({"cancelRequested":true}));
    }
    if ranking_complete {
        let result = tauri::async_runtime::block_on(async {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            let _gate = host.gate.lock().await;
            if !instance.accepting.load(Ordering::SeqCst) { return Err("本次操作已停止".to_owned()); }
            let sid = instance.session_id.lock().unwrap().clone();
            let control = run_control::complete_refresh(&crate::desktop_storage::root(&app)?, &sid, body["revision"].as_u64().ok_or("缺少执行版本")?).await?;
            let _ = app.emit_to("main", "pi-event", json!({"instanceId":instance.id,"record":{"type":"author_decision","control":control}}));
            serde_json::to_value(control).map_err(err)
        });
        return match result {
            Ok(value) => respond(stream,"200 OK",json!({"result":value})),
            Err(error) => respond(stream,"409 Conflict",json!({"error":error})),
        };
    }
    if deciding {
        let result = tauri::async_runtime::block_on(async {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            let _gate = host.gate.lock().await;
            if !instance.accepting.load(Ordering::SeqCst) { return Err("作者输入已取消".to_owned()); }
            let sid = instance.session_id.lock().unwrap().clone();
            let input_id = body["inputId"].as_str().ok_or("缺少作者输入编号")?;
            let decision = body["action"].as_str().ok_or("缺少执行决定")?;
            if !["process", "pause", "end", "clarify"].contains(&decision) { return Err("执行决定无效".into()); }
            if instance.author_input.lock().unwrap().as_ref().is_none_or(|input| input["id"] != input_id) {
                return Err("作者输入已更新，未执行旧决定".into());
            }
            let root = crate::desktop_storage::root(&app)?;
            let current = run_control::read_at(&root, &sid).await?;
            if current.pending_input.as_deref() != Some(input_id) { return Err("作者输入已取消或更新".into()); }
            if decision != "process" { host.request(&instance.id, json!({"type":"clear_queue"})).await?; }
            let rankings = serde_json::from_value::<run_control::RankingPolicy>(body["rankings"].clone()).map_err(err)?;
            let changed = run_control::author_input(&root, &sid, input_id, Some(decision), Some(rankings)).await?;
            *instance.author_input.lock().unwrap() = None;
            let _ = app.emit_to("main", "pi-event", json!({"instanceId":instance.id,"record":{"type":"author_decision","control":changed.control}}));
            serde_json::to_value(changed).map_err(err)
        });
        return match result {
            Ok(value) => respond(stream, "200 OK", json!({"result":value})),
            Err(error) => respond(stream, "409 Conflict", json!({"error":error})),
        };
    }
    if snapshot {
        let sid = instance.session_id.lock().unwrap().clone();
        if sid.is_empty()
            || body["sessionId"].as_str() != Some(sid.as_str())
            || !instance.accepting.load(Ordering::SeqCst)
        {
            return respond(
                stream,
                "409 Conflict",
                json!({"error":"会话上下文授权无效"}),
            );
        }
        let result =
            app.path().app_data_dir().map_err(err).and_then(|root| {
                tauri::async_runtime::block_on(async {
                    let active = context::active_book(&root, &sid, &book, instance.started_at).await?;
                    let state = context::snapshot(&root, &sid, &active).await?;
                    let mut value = if body["detail"] == "full" { state } else { context::prompt_summary(&state) };
                    value["authorInput"] = instance.author_input.lock().unwrap().clone().unwrap_or(Value::Null);
                    Ok(value)
                })
            });
        return match result {
            Ok(value) => respond(stream, "200 OK", json!({"result":value})),
            Err(error) => respond(stream, "503 Service Unavailable", json!({"error":error})),
        };
    }
    let tool = body["tool"].as_str().unwrap_or_default();
    // ask_author 不是平台工具：扩展把引导卡交给界面渲染，作者的回答原样回给扩展。
    if !TOOLS.contains(&tool) && tool != "ask_author" {
        return respond(stream, "403 Forbidden", json!({"error":"工具未开放"}));
    }
    let sid = instance.session_id.lock().unwrap().clone();
    if sid.is_empty() || !body["args"].is_object() {
        return respond(stream, "409 Conflict", json!({"error":"工具会话或参数无效"}));
    }
    let mut args = body["args"].clone();
    // 会话身份由宿主确定，模型或扩展参数不能借此查询其他会话的私有记录。
    args["sessionId"] = json!(sid);
    if tool=="write_prose" {
        let host=app.state::<PiHost>();
        let bound=host.workers.lock().unwrap().get(&instance.id).map(|w|(w.model_code.clone(),w.model_version.clone()));
        let Some((code,version))=bound else {return respond(stream,"409 Conflict",json!({"error":"写作实例已结束"}));};
        let current=app.path().app_data_dir().map_err(err).and_then(|root|tauri::async_runtime::block_on(read_model(&root,&code)));
        if !current.is_ok_and(|m|model_version(&m)==version){return respond(stream,"409 Conflict",json!({"error":"会话模型配置已改变，请重新选择模型后再生成"}));}
        args["sessionModelCode"]=json!(code);
    }
    let book = match app.path().app_data_dir().map_err(err).and_then(|root| {
        tauri::async_runtime::block_on(context::active_book(&root, &sid, &book, instance.started_at))
    }) {
        Ok(value) => value,
        Err(error) => return respond(stream, "409 Conflict", json!({"error":error})),
    };
    match app.path().app_data_dir().map_err(err).and_then(|root| tauri::async_runtime::block_on(run_control::read_at(&root, &sid))) {
        Ok(control) if control.state == run_control::State::Active && control.pending_input.is_none() => {
            if matches!(tool, "list_rankings" | "read_rankings" | "refresh_rankings") {
                args["rankingPolicy"] = serde_json::to_value(control.rankings).unwrap();
            }
        },
        Ok(_) => return respond(stream, "409 Conflict", json!({"error":"当前阶段已暂停或结束，未执行工具"})),
        Err(error) => return respond(stream, "409 Conflict", json!({"error":error})),
    }
    let (tx, rx) = mpsc::channel();
    let call = Arc::new(ToolCall::new(
        id.clone(),
        tool.to_owned(),
        args.clone(),
        body["callId"].as_str().unwrap_or_default().to_owned(),
        book.clone(),
    ));
    if let Err(error) = instance.register(PendingTool { call: call.clone(), reply: tx }) {
        return respond(stream, "409 Conflict", json!({"error":error}));
    }
    if platform::TOOLS.contains(&tool) {
        let result = app.path().app_data_dir().map_err(err).and_then(|root| {
            tauri::async_runtime::block_on(async {
                let host = app.state::<PiHost>();
                let _author = host.exit.author().await?;
                platform::execute(&root, &instance, &call).await
            })
        });
        instance.reply(&id, result);
    } else if app.emit_to("main","pi-tool-request",json!({"id":id,"instanceId":instance.id,"tool":tool,"args":args,"callId":body["callId"],"book":book})).is_err() {
        instance.cancel(&id);
        return respond(stream, "503 Service Unavailable", json!({"error":"主窗口工具通道不可用"}));
    }
    // 长任务由取消/实例撤销唤醒通道；不以普通资料读取的 90 秒超时截断。
    let result = if control::is_long_tool(tool, &body["args"]) {
        rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
    } else {
        rx.recv_timeout(Duration::from_secs(90))
    };
    if result.is_err() {
        instance.cancel(&id);
        cancel_notice(&app, &instance, vec![id]);
    }
    match result {
        Ok(Ok(value)) => respond(stream, "200 OK", json!({"result":value})),
        Ok(Err(error)) => respond(stream, "200 OK", json!({"error":error})),
        Err(_) => respond(
            stream,
            "504 Gateway Timeout",
            json!({"error":"平台工具未响应，请回到 Agent 板块重试"}),
        ),
    }
}
#[tauri::command]
pub async fn pi_workspace(
    app: crate::DesktopAppHandle,
    window: crate::DesktopWebviewWindow,
    action: String,
    args: Value,
) -> Result<Value, String> {
    require_main(&window)?;
    let root = crate::desktop_storage::root(&app)?;
    match action.as_str() {
        "run_control" => {
            let sid = args["sessionId"].as_str().ok_or("缺少会话编号")?;
            if args["action"] == "read" { return serde_json::to_value(run_control::read_at(&root, sid).await?).map_err(err); }
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            let _gate = host.gate.lock().await;
            if args["action"] == "resume" && args["revision"].as_u64() != Some(run_control::read_at(&root, sid).await?.revision) {
                return Err("暂停状态已改变，请重新确认后继续".into());
            }
            let task = args["task"]["kind"].as_str().zip(args["task"]["id"].as_str());
            serde_json::to_value(run_control::change(&root, sid, args["action"].as_str().unwrap_or_default(), args["resumeAgent"] == true, task).await?).map_err(err)
        }
        "run_control_tool" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            let _gate = host.gate.lock().await;
            let instance = host.instance(args["instanceId"].as_str().unwrap_or_default())?;
            let call = instance.call(args["requestId"].as_str().unwrap_or_default())?;
            if call.tool != "control_session" { return Err("此请求不是会话控制操作".into()); }
            let _writing = instance.writing(&call)?;
            let action = call.args["action"].as_str().unwrap_or_default();
            if !["pause", "end"].contains(&action) { return Err("模型只能暂停或结束当前阶段".into()); }
            host.request(&instance.id, json!({"type":"clear_queue"})).await?;
            serde_json::to_value(run_control::change(&root, call.args["sessionId"].as_str().unwrap_or_default(), action, true, None).await?).map_err(err)
        }
        "memory" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            memory::dispatch(&root, args).await
        }
        "attachment" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            attachments::dispatch(&root, args).await
        }
        "breakdown_task" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            breakdown_tasks::dispatch(&root, args).await
        }
        "cover_task" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            cover::dispatch(&root, args).await
        }
        "batch_task" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            batch::dispatch(&root, args).await
        }
        "distillation_task" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            distillation::dispatch(&root, args).await
        }
        "book_style" => {
            let bid = args["bookId"].as_str().ok_or("缺少作品编号")?;
            let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
            Ok(json!(crate::pi_prose_sources::book_style(&mut db, bid).await?))
        }
        "skills" => skills::dispatch(&skill_dirs(&root), args),
        // 技能脚本：由跑 Pi 的那个 Node 执行，限制在技能目录内，两分钟超时，可取消。
        "skill_script" => match args["op"].as_str().unwrap_or_default() {
            "run" => {
                let host = app.state::<PiHost>();
                let _author = host.exit.author().await?;
                let (node, _) = runtime()?;
                let dirs = skill_dirs(&root);
                tauri::async_runtime::spawn_blocking(move || {
                    skills::run_script(&dirs, &node, &args, Duration::from_secs(120))
                })
                .await
                .map_err(err)?
            }
            "cancel" => Ok(json!({"cancelled":skills::cancel_script(args["id"].as_str().unwrap_or_default())})),
            _ => Err("未知脚本操作".into()),
        },
        // 隔离桌面测试触发菜单退出所用的原生事件；默认开发构建和发布构建均不包含此入口。
        #[cfg(all(debug_assertions, feature = "local-tests"))]
        "test_request_quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        #[cfg(all(debug_assertions, feature = "local-tests"))]
        "test_crash_runtime" => {
            let host = app.state::<PiHost>();
            let mut workers = host.workers.lock().unwrap();
            let requested = args["instanceId"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| workers.keys().next().cloned());
            if let Some(worker) = requested.and_then(|id| workers.get_mut(&id)) {
                worker.child.kill().map_err(err)?;
            }
            Ok(Value::Null)
        }
        "status" => {
            let host = app.state::<PiHost>();
            let workers = host.workers.lock().unwrap();
            let instances: Vec<Value> = workers.values().map(|w|json!({"instanceId":w.id,"file":w.session_file,"clientKey":w.client_key,"modelCode":w.model_code,"book":w.book})).collect();
            Ok(
                json!({"ready":runtime().is_ok(),"version":"1.3.0","active":workers.keys().next(),"instances":instances}),
            )
        }
        "sessions" => {
            let mut rows = list_sessions(&root)?;
            let metas = {
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                sessions_meta::metas(&mut db).await?
            };
            for row in &mut rows {
                let config = context::get(&root, row, "").await?;
                row["book"] = read_book(&root, config["bookId"].as_str().unwrap_or_default())
                    .await
                    .unwrap_or_else(|_| json!({"id":config["bookId"],"title":"作品已删除"}));
                row["modelCode"] = config["modelCode"].clone();
                row["runControl"] = serde_json::to_value(run_control::from_meta(row["id"].as_str().and_then(|id| metas.get(id)).unwrap_or(&Value::Null))?).map_err(err)?;
                // 作者改名或自动起名、分组、置顶、归档都在宿主元数据里，不写进 Pi 会话文件。
                if let Some(meta) = row["id"].as_str().and_then(|id| metas.get(id)) {
                    if let Some(title) = meta["title"].as_str() {
                        row["title"] = json!(title);
                        row["named"] = json!(true);
                    }
                    row["titleSource"] = meta["titleSource"].clone();
                    row["groupId"] = meta["groupId"].clone();
                    row["pinnedAt"] = meta["pinnedAt"].clone();
                    row["archivedAt"] = meta["archivedAt"].clone();
                }
            }
            Ok(json!(rows))
        }
        "groups" => {
            let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
            Ok(json!(sessions_meta::groups(&mut db).await?))
        }
        "session_meta" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            sessions_meta::update_meta(
                &root,
                args["sessionId"].as_str().unwrap_or_default(),
                &args["change"],
            )
            .await
        }
        "group_save" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            sessions_meta::save_group(&root, &args).await
        }
        "group_delete" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            sessions_meta::delete_group(&root, args["id"].as_str().unwrap_or_default()).await
        }
        "delete_session" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.check_runtime()?;
            let _author = host.exit.author().await?;
            let file = args["file"].as_str().ok_or("缺少会话文件")?;
            let path = session_path(&root, file)?;
            if host
                .workers
                .lock()
                .unwrap()
                .values()
                .any(|w| w.session_file.as_deref() == Some(file))
            {
                return Err("对话仍在运行，请先停止再删除".into());
            }
            let session = list_sessions(&root)?
                .into_iter()
                .find(|s| s["file"] == file)
                .ok_or("会话不存在")?;
            let id = session["id"].as_str().unwrap_or_default().to_owned();
            sessions_meta::delete_session(&root, &path, &id).await
        }
        "search_sessions" => Ok(json!(sessions_meta::search(
            &sessions(&root),
            args["query"].as_str().unwrap_or_default(),
            50
        )?)),
        "session_context" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.check_runtime()?;
            let file = args["file"].as_str().ok_or("缺少会话文件")?;
            session_path(&root, file)?;
            let session = list_sessions(&root)?
                .into_iter()
                .find(|s| s["file"] == file)
                .ok_or("会话不存在")?;
            let mut config = context::get(
                &root,
                &session,
                args["modelCode"].as_str().unwrap_or_default(),
            )
            .await?;
            let existing = host
                .workers
                .lock()
                .unwrap()
                .values()
                .find(|w| w.session_file.as_deref() == Some(file))
                .map(|w| (w.id.clone(), w.book.clone(), w.model_code.clone()));
            if let Some((id, _, _)) = &existing {
                if host.active_work(id).await? {
                    return Err("当前对话仍在运行，请完成或停止后切换".into());
                }
            }
            if let Some(change) = args.get("change") {
                if args["revision"] != config["revision"] {
                    return Err("会话配置已更新，请重新选择".into());
                }
                if let Some(book_id) = change.get("bookId") {
                    read_book(&root, book_id.as_str().ok_or("作品编号无效")?).await?;
                    config["bookId"] = book_id.clone();
                }
                if let Some(code) = change.get("modelCode") {
                    read_model(&root, code.as_str().ok_or("模型编号无效")?).await?;
                    config["modelCode"] = code.clone();
                }
                // 先回收旧实例，期间所有迟到请求仍受实例撤销约束；下一次发送原生恢复同一历史。
                if let Some((id, _, _)) = &existing {
                    host.stop_instance(&app, id).await?;
                }
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
                let latest = context::read(&mut tx, session["id"].as_str().unwrap()).await?;
                if latest.as_ref().map(|v| &v["revision"]).unwrap_or(&json!(0)) != &args["revision"]
                {
                    return Err("采用保存更新了会话配置，请重新选择".into());
                }
                config["revision"] = json!(config["revision"].as_u64().unwrap_or(0) + 1);
                context::write(&mut tx, session["id"].as_str().unwrap(), &config).await?;
                tx.commit().await.map_err(err)?;
            } else if let Some((id, book, model)) = &existing {
                if book["id"].as_str().unwrap_or_default()
                    != config["bookId"].as_str().unwrap_or_default()
                    || model != config["modelCode"].as_str().unwrap_or_default()
                {
                    host.stop_instance(&app, id).await?;
                }
            }
            config["instanceId"] = json!(host
                .workers
                .lock()
                .unwrap()
                .values()
                .find(|w| w.session_file.as_deref() == Some(file))
                .map(|w| w.id.clone())
                .unwrap_or_default());
            config["book"] = read_book(&root, config["bookId"].as_str().unwrap_or_default())
                .await
                .unwrap_or(Value::Null);
            config["runControl"] = serde_json::to_value(run_control::read_at(&root, session["id"].as_str().unwrap_or_default()).await?).map_err(err)?;
            Ok(config)
        }
        "close_status" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            let mut busy = false;
            for id in host.ids() {
                if host.active_work(&id).await.unwrap_or(true) {
                    busy = true;
                    break;
                }
            }
            Ok(json!({"busy":busy}))
        }
        "maintenance" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.begin_maintenance()?;
            let result = async {
                // 先检查所有对话，再回收空闲实例；不能只检查当前浏览的会话。
                for id in host.ids() {
                    if host.active_work(&id).await? {
                        return Err("还有 Agent 任务或工具操作在执行，请先停止再恢复备份".to_string());
                    }
                }
                host.close_instances(&app).await?;
                host.exit.drain_authors().await;
                Ok(Value::Null)
            }
            .await;
            if result.is_err() {
                host.exit.end_maintenance();
            }
            result
        }
        "end_maintenance" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.end_maintenance();
            Ok(Value::Null)
        }
        "begin_exit" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.begin();
            if host.quit_requested.load(Ordering::SeqCst) {
                app.state::<crate::writing_host::WritingHost>()
                    .quitting
                    .store(true, Ordering::SeqCst);
            }
            Ok(Value::Null)
        }
        "finish_exit" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.begin();
            host.close_instances(&app).await?;
            host.exit.finish().await;
            Ok(Value::Null)
        }
        "cancel_exit" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.cancel();
            host.quit_requested.store(false, Ordering::SeqCst);
            // 退出确认后才设置旧 Agent 的 quitting；取消关闭必须归还其运行权限。
            app.state::<crate::writing_host::WritingHost>()
                .quitting
                .store(false, Ordering::SeqCst);
            Ok(Value::Null)
        }
        "send" => {
            if args["command"]["type"] != "extension_ui_response" {
                return Err("请使用 request 发送 Agent 命令，取消任务使用 stop".into());
            }
            app.state::<PiHost>().send(
                args["instanceId"].as_str().unwrap_or_default(),
                &args["command"],
            )?;
            Ok(Value::Null)
        }
        "request" => {
            if matches!(
                args["command"]["type"].as_str(),
                Some("abort" | "clear_queue")
            ) {
                return Err("取消任务必须通过 stop 完成实例撤销和收尾".into());
            }
            let host = app.state::<PiHost>();
            let prompt = args["command"]["type"] == "prompt";
            let _gate = if prompt {
                Some(host.gate.lock().await)
            } else {
                None
            };
            let mut prompt_control = None;
            if prompt {
                let (sid, book, model) = {
                    let workers = host.workers.lock().unwrap();
                    let w = workers
                        .get(args["instanceId"].as_str().unwrap_or_default())
                        .ok_or("Agent 会话已退出")?;
                    let sid = w.instance.session_id.lock().unwrap().clone();
                    (sid, w.book.clone(), w.model_code.clone())
                };
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                if let Some(config) = context::read(&mut db, &sid).await? {
                    if config["bookId"].as_str().unwrap_or_default()
                        != book["id"].as_str().unwrap_or_default()
                        || config["modelCode"].as_str().unwrap_or_default() != model
                    {
                        return Err("会话配置已更新，请重新发送以应用新配置".into());
                    }
                }
                let control = match args["origin"].as_str() {
                    Some("author") => {
                        let control = run_control::read_at(&root, &sid).await?;
                        if args["controlRevision"].as_u64() != Some(control.revision) {
                            return Ok(json!({"disposition":"superseded","runControl":control}));
                        }
                        let instance = host.instance(args["instanceId"].as_str().unwrap_or_default())?;
                        let input_id = uuid::Uuid::new_v4().to_string();
                        let changed = run_control::author_input(&root, &sid, &input_id, None, None).await?;
                        *instance.author_input.lock().unwrap() = Some(json!({"id":input_id,"text":args["command"]["message"],"defaultAction":"continue"}));
                        changed.control
                    },
                    Some("resume") => {
                        let control = run_control::read_at(&root, &sid).await?;
                        if control.state != run_control::State::Active || control.pending_input.is_some() || args["controlRevision"].as_u64() != Some(control.revision) {
                            return Ok(json!({"disposition":"superseded","runControl":control}));
                        }
                        control
                    },
                    Some("automatic") => {
                        let kind = args["task"]["kind"].as_str().ok_or("自动继续缺少任务类型")?;
                        let task_id = args["task"]["id"].as_str().ok_or("自动继续缺少任务编号")?;
                        let (control, allowed) = run_control::automatic_allowed(&root, &sid, kind, task_id).await?;
                        if !allowed { return Ok(json!({"disposition":"blocked","runControl":control})); }
                        control
                    },
                    _ => return Err("发送来源必须为作者输入或已授权的任务继续".into()),
                };
                prompt_control = Some(control);
            }
            let mut result = host.request(
                args["instanceId"].as_str().unwrap_or_default(),
                args["command"].clone(),
            ).await?;
            if let Some(control) = prompt_control { result["runControl"] = serde_json::to_value(control).map_err(err)?; }
            Ok(result)
        }
        "stop" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            // 停止回执丢失后重试：无活动实例意味着已回收，不重新创建进程。
            if !host
                .workers
                .lock()
                .unwrap()
                .contains_key(args["instanceId"].as_str().unwrap_or_default())
            {
                return Ok(json!({"state":null,"messages":null}));
            }
            host.stop_instance(&app, args["instanceId"].as_str().unwrap_or_default())
                .await
        }
        "commit_draft" => {
            let host = app.state::<PiHost>();
            let _writing = host.exit.author().await?;
            let instance = host.instance(args["instanceId"].as_str().unwrap_or_default())?;
            let call = instance.call(args["requestId"].as_str().unwrap_or_default())?;
            drafts::commit(&root, instance, call, args["draft"].clone()).await
        }
        "commit_breakdown" => {
            let host = app.state::<PiHost>();
            let _writing = host.exit.author().await?;
            let instance = host.instance(args["instanceId"].as_str().unwrap_or_default())?;
            let call = instance.call(args["requestId"].as_str().unwrap_or_default())?;
            breakdown::commit(&root, instance, call, args["result"].clone()).await
        }
        "target_text" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            adoption::target_text(&root,&args).await
        }
        "edit_draft" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            adoption::edit_from(
                &root,
                args["id"].as_str().ok_or("缺少草稿编号")?,
                args["expectedRevision"].as_u64().ok_or("缺少草稿修订")?,
                args["content"].as_str().ok_or("缺少草稿正文")?,
                args["origin"]=="author",
            )
            .await
        }
        "dismiss_draft" => {
            let host = app.state::<PiHost>();
            let _author = host.exit.author().await?;
            adoption::dismiss(&root, args["id"].as_str().ok_or("缺少草稿编号")?).await
        }
        "prepare_adoption" => {
            adoption::prepare(
                &root,
                args["draftId"].as_str().ok_or("缺少草稿编号")?,
                args["revision"].as_u64().ok_or("缺少草稿修订")?,
            )
            .await
        }
        "adopt_draft" => {
            let host = app.state::<PiHost>();
            let _author = host
                .exit
                .author()
                .await
                .map_err(|e| format!("PI_ADOPTION_REJECTED: {e}"))?;
            let ticket =
                serde_json::from_value::<adoption::Ticket>(args["ticket"].clone()).map_err(err)?;
            let result = adoption::apply(&root, &ticket).await?;
            // 采用即整理：安静期一过就提取这一章的章节卡，不等后台巡检的一两分钟。
            crate::writing_host::schedule_index(
                app.clone(),
                Duration::from_millis(crate::story_index::QUIET_MS as u64 + 500),
            );
            Ok(result)
        }
        "adoption_status" => {
            let ticket =
                serde_json::from_value::<adoption::Ticket>(args["ticket"].clone()).map_err(err)?;
            adoption::status(&root, &ticket).await
        }
        "tool_reply" => {
            let id = args["id"].as_str().ok_or("缺少工具请求编号")?;
            if let Ok(instance) = app
                .state::<PiHost>()
                .instance(args["instanceId"].as_str().unwrap_or_default())
            {
                let result = if let Some(e) = args["error"].as_str() {
                    Err(e.to_string())
                } else {
                    let call = instance.call(id)?;
                    instance.check(&call)?;
                    let mut result = args["result"].clone();
                    if call.tool == "ask_author" {
                        if let Some(answer) = result.as_object_mut() {
                            answer.insert("questionId".into(), json!(call.call_id));
                            answer.insert("answeredAt".into(), json!(chrono::Utc::now().timestamp_millis()));
                            answer.insert("questionSpec".into(), call.args.clone());
                            if call.args["kind"] == "choice" {
                                let next = if answer.get("cancelled") == Some(&json!(true)) { "pause" } else { answer.get("nextAction").and_then(Value::as_str).or_else(|| call.args["afterAnswer"].as_str()).unwrap_or("continue") }.to_owned();
                                if !["continue", "pause"].contains(&next.as_str()) { return Err("回答后的动作无效".into()); }
                                {
                                    let host = app.state::<PiHost>();
                                    let _gate = host.gate.lock().await;
                                    instance.check(&call)?;
                                    host.request(&instance.id, json!({"type":"clear_queue"})).await?;
                                    let sid = call.args["sessionId"].as_str().unwrap_or_default();
                                    let changed = if answer.get("cancelled") == Some(&json!(true)) {
                                        run_control::change(&root, sid, "pause", true, None).await?
                                    } else {
                                        let input_id = uuid::Uuid::new_v4().to_string();
                                        let changed = run_control::author_input(&root, sid, &input_id, None, None).await?;
                                        *instance.author_input.lock().unwrap() = Some(json!({"id":input_id,"answer":answer,"question":call.args,"defaultAction":next}));
                                        changed
                                    };
                                    answer.insert("runControl".into(), serde_json::to_value(changed.control).map_err(err)?);
                                }
                                answer.insert("nextAction".into(), json!(next));
                            }
                        }
                    }
                    Ok(result)
                };
                instance.reply(id, result);
            }
            Ok(Value::Null)
        }
        "close" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            if let Some(id) = args["instanceId"].as_str().filter(|s| !s.is_empty()) {
                if host.instance(id).is_ok() {
                    host.stop_instance(&app, id).await?;
                }
            } else {
                host.close_instances(&app).await?;
            }
            Ok(Value::Null)
        }
        "open" => {
            let host = app.state::<PiHost>();
            let _gate = host.gate.lock().await;
            host.exit.check_runtime()?;
            let (node, cli) = runtime()?;
            let file = args["file"]
                .as_str()
                .filter(|x| !x.is_empty())
                .map(|x| session_path(&root, x))
                .transpose()?;
            let config = if let Some(requested) = args["file"].as_str().filter(|s| !s.is_empty()) {
                let session = list_sessions(&root)?
                    .into_iter()
                    .find(|s| s["file"] == requested)
                    .ok_or("会话不存在")?;
                context::get(
                    &root,
                    &session,
                    args["modelCode"].as_str().unwrap_or_default(),
                )
                .await?
            } else {
                json!({"bookId":args["bookId"].as_str().unwrap_or_default(),"modelCode":args["modelCode"],"revision":0})
            };
            let model_code = config["modelCode"].as_str().ok_or("模型编号缺失")?;
            let model = read_model(&root, model_code).await?;
            let book = read_book(&root, config["bookId"].as_str().unwrap_or_default()).await?;
            let client_key = args["clientKey"].as_str().unwrap_or_default().to_owned();
            let requested_file = args["file"].as_str().filter(|s| !s.is_empty());
            let existing = host
                .workers
                .lock()
                .unwrap()
                .values()
                .find(|w| {
                    requested_file.is_some_and(|f| w.session_file.as_deref() == Some(f))
                        || (!client_key.is_empty() && w.client_key == client_key)
                })
                .map(|w| {
                    (
                        w.id.clone(),
                        w.book.clone(),
                        w.model_code.clone(),
                        w.instance.alive.load(Ordering::SeqCst)
                            && w.instance.accepting.load(Ordering::SeqCst),
                    )
                });
            if let Some((id, bound, model_code, alive)) = existing {
                if bound["id"] != book["id"] {
                    return Err("会话作品绑定不一致".into());
                }
                if alive {
                    let sid = host.instance(&id)?.session_id.lock().unwrap().clone();
                    let control = run_control::read_at(&root, &sid).await?;
                    return Ok(json!({"instanceId":id,"modelCode":model_code,"context":config,"runControl":control}));
                }
                host.stop_instance(&app, &id).await?;
            }
            let home = pi_root(&root);
            let workspace = home.join("workspace");
            fs::create_dir_all(&workspace).map_err(err)?;
            configure_runtime(&home.join("config"))?;
            fs::create_dir_all(sessions(&root)).map_err(err)?;
            let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
            listener.set_nonblocking(true).map_err(err)?;
            let endpoint = format!("http://{}/tool", listener.local_addr().map_err(err)?);
            let token = uuid::Uuid::new_v4().to_string();
            let id = uuid::Uuid::new_v4().to_string();
            let instance = Arc::new(Instance::new(id.clone()));
            let tool_names = public_tool_names();
            let mut cmd = Command::new(node);
            cmd.arg(cli)
                .args([
                    "--mode",
                    "rpc",
                    "--provider",
                    "yichuang",
                    "--model",
                    model["modelCode"].as_str().ok_or("模型名称缺失")?,
                    "--thinking",
                    "off",
                    "--no-extensions",
                    "--no-skills",
                    "--no-prompt-templates",
                ])
                .arg("--extension")
                .arg(project().join(if cfg!(debug_assertions) { "extensions/yichuang.ts" } else { "extensions/yichuang.mjs" }));
            // 技能按作者的启用列表逐个传；作者改过的内置技能传覆盖文件。
            let skill_dirs = skill_dirs(&root);
            for path in skills::enabled_paths(&skill_dirs) {
                cmd.arg("--skill").arg(path);
            }
            cmd.arg("--system-prompt")
                .arg(project().join("prompts/system.md"))
                .arg("--tools")
                .arg(tool_names)
                .arg("--session-dir")
                .arg(sessions(&root))
                .current_dir(workspace)
                .env("PI_CODING_AGENT_DIR", home.join("config"))
                .env("EW_PI_MODEL", model.to_string())
                .env("EW_PI_BOOK", book.to_string())
                .env("EW_PI_TOOL_URL", endpoint)
                .env("EW_PI_TOOL_TOKEN", &token)
                .env(
                    "EW_PI_SKILL_DIRS",
                    json!(skills::allowed_roots(&skill_dirs)).to_string(),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(file) = file {
                cmd.arg("--session").arg(file);
            }
            crate::background_process::hide_console(&mut cmd);
            let mut child = cmd.spawn().map_err(err)?;
            let stdout = child.stdout.take().ok_or("Agent 输出通道不可用")?;
            let stderr = child.stderr.take().ok_or("Agent 错误输出通道不可用")?;
            let stdin = Arc::new(Mutex::new(child.stdin.take()));
            let event_app = app.clone();
            let event_id = id.clone();
            let event_instance = instance.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(record) = serde_json::from_str::<Value>(&line) {
                        event_instance.response(&record);
                        let _ = event_app.emit_to(
                            "main",
                            "pi-event",
                            json!({"instanceId":event_id,"record":record}),
                        );
                    }
                }
                cancel_notice(&event_app, &event_instance, event_instance.exited());
                let _ = event_app.emit_to(
                    "main",
                    "pi-event",
                    json!({"instanceId":event_id,"record":{"type":"host_exit"}}),
                );
            });
            // 错误尾部不向界面转发原始日志，避免供应商日志包含凭据。
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    if line.is_err() {
                        break;
                    }
                }
            });
            let server_app = app.clone();
            let server_instance = instance.clone();
            let server_book = book.clone();
            thread::spawn(move || {
                while server_instance.alive.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let a = server_app.clone();
                            let t = token.clone();
                            let i = server_instance.clone();
                            let b = server_book.clone();
                            thread::spawn(move || handle_tool(stream, a, t, i, b));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => break,
                    }
                }
            });
            host.workers.lock().unwrap().insert(
                id.clone(),
                Worker {
                    id: id.clone(),
                    stdin,
                    child,
                    instance,
                    session_file: requested_file.map(str::to_owned),
                    client_key,
                    model_code: model_code.to_owned(),
                    model_version:model_version(&model),
                    book,
                },
            );
            // 启动回执只在真实 RPC 已就绪后返回；不把 spawn 成功当作模型运行时就绪。
            let state = match host.request(&id, json!({"type":"get_state"})).await {
                Ok(state) => state,
                Err(cause) => {
                    if let Some(mut worker) = host.workers.lock().unwrap().remove(&id) {
                        worker.instance.exited();
                        worker.stdin.lock().unwrap().take();
                        let _ = worker.child.kill();
                        let _ = worker.child.wait();
                    }
                    return Err(cause);
                }
            };
            if let Some(worker) = host.workers.lock().unwrap().get_mut(&id) {
                *worker.instance.session_id.lock().unwrap() =
                    state["sessionId"].as_str().unwrap_or_default().to_owned();
                worker.session_file = state["sessionFile"]
                    .as_str()
                    .and_then(|f| Path::new(f).file_name())
                    .map(|f| f.to_string_lossy().into_owned())
                    .or(worker.session_file.clone());
            }
            let persisted = async {
                let mut db = crate::desktop_storage::connect_existing_at(&root).await?;
                let mut tx = crate::desktop_storage::begin_write(&mut db).await?;
                let sid = state["sessionId"].as_str().ok_or("Agent 会话编号缺失")?;
                if context::read(&mut tx, sid).await?.is_none() {
                    context::write(&mut tx, sid, &config).await?;
                }
                tx.commit().await.map_err(err)?;
                Ok::<(), String>(())
            }
            .await;
            if let Err(cause) = persisted {
                host.stop_instance(&app, &id).await?;
                return Err(cause);
            }
            Ok(json!({"instanceId":id,"state":state,"context":config,"runControl":run_control::read_at(&root, state["sessionId"].as_str().unwrap_or_default()).await?}))
        }
        _ => Err("未知 Agent 操作".into()),
    }
}
