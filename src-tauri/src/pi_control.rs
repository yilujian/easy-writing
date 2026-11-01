//! Pi 实例/请求的资源生命周期。没有模型循环或持久化任务状态。
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Notify};

/// 协调 Pi 退出与恢复维护，不接管模型或平台事务。退出收尾允许已确认保存和草稿落盘。
#[derive(Default)]
pub struct ExitGate {
    closing: AtomicBool,
    sealed: AtomicBool,
    maintenance: AtomicBool,
    authors: tokio::sync::RwLock<()>,
}
impl ExitGate {
    pub fn begin(&self) {
        self.closing.store(true, Ordering::SeqCst);
    }
    pub fn check_runtime(&self) -> Result<(), String> {
        if self.maintenance.load(Ordering::SeqCst) {
            return Err("正在恢复备份，请完成恢复并重新启动后再使用 Agent".into());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err("正在关闭应用，未启动新的 Agent 操作".into());
        }
        Ok(())
    }
    pub async fn author(&self) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, String> {
        let guard = self.authors.read().await;
        if self.maintenance.load(Ordering::SeqCst) {
            return Err("正在恢复备份，未接受 Agent 写入".into());
        }
        if self.sealed.load(Ordering::SeqCst) {
            return Err("退出保存已收尾，未接受新的保存操作".into());
        }
        Ok(guard)
    }
    pub async fn finish(&self) {
        let _guard = self.authors.write().await;
        self.sealed.store(true, Ordering::SeqCst);
    }
    pub fn cancel(&self) {
        self.sealed.store(false, Ordering::SeqCst);
        self.closing.store(false, Ordering::SeqCst);
    }
    pub fn begin_maintenance(&self) -> Result<(), String> {
        self.check_runtime()?;
        if self.maintenance.swap(true, Ordering::SeqCst) {
            return Err("Agent 数据维护已经开始，请等待完成并重新启动".into());
        }
        Ok(())
    }
    pub async fn drain_authors(&self) {
        let _guard = self.authors.write().await;
    }
    pub fn end_maintenance(&self) {
        self.maintenance.store(false, Ordering::SeqCst);
    }
}

pub type Reply = Result<Value, String>;
pub struct PendingTool {
    pub call: Arc<ToolCall>,
    pub reply: mpsc::Sender<Reply>,
}
pub struct ToolCall {
    pub id: String,
    pub tool: String,
    pub args: Value,
    pub call_id: String,
    pub book: Value,
    pub cancelled: AtomicBool,
    deadline: Option<Instant>,
}
/// 等作者或等后台任务的调用不设截止时间：拆书确认前要等附件入库完成的那次读取也算。
pub fn is_long_tool(tool: &str, args: &Value) -> bool {
    // read_references 会先把故事状态账本整理到最新，可能要跑几次模型
    ["write_prose", "confirm_materials", "run_breakdown", "run_distillation", "run_batch", "make_cover", "refresh_rankings", "reparse_book_attachment", "ask_author", "run_skill_script", "read_references"].contains(&tool)
        || (tool == "read_breakdown" && args["prepare"] == true)
}
impl ToolCall {
    pub fn new(id: String, tool: String, args: Value, call_id: String, book: Value) -> Self {
        let deadline = if is_long_tool(&tool, &args) {
            None
        } else {
            Some(Instant::now() + Duration::from_secs(90))
        };
        Self {
            id,
            tool,
            args,
            call_id,
            book,
            cancelled: AtomicBool::new(false),
            deadline,
        }
    }
}
pub struct Instance {
    pub id: String,
    /// 本实例启动后正式采用的新书才可在未绑定的当前轮次中生效。
    pub started_at: i64,
    pub session_id: Mutex<String>,
    pub author_input: Mutex<Option<Value>>,
    pub alive: AtomicBool,
    pub turn_running: AtomicBool,
    pub accepting: AtomicBool,
    pub commit: tokio::sync::Mutex<()>,
    pub rpc: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    tools: Mutex<HashMap<String, PendingTool>>,
    cancelled: Mutex<HashSet<String>>,
    writes: AtomicUsize,
    changed: Notify,
}
impl Instance {
    pub fn new(id: String) -> Self {
        Self {
            id,
            started_at: chrono::Utc::now().timestamp_millis(),
            session_id: Mutex::new(String::new()),
            author_input: Mutex::new(None),
            alive: AtomicBool::new(true),
            turn_running: AtomicBool::new(false),
            accepting: AtomicBool::new(true),
            commit: tokio::sync::Mutex::new(()),
            rpc: Mutex::new(HashMap::new()),
            tools: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            writes: AtomicUsize::new(0),
            changed: Notify::new(),
        }
    }
    pub fn check(&self, call: &ToolCall) -> Result<(), String> {
        if !self.alive.load(Ordering::SeqCst)
            || !self.accepting.load(Ordering::SeqCst)
            || call.cancelled.load(Ordering::SeqCst)
            || call
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err("Agent 工具请求已取消或过期，未提交草稿".into());
        }
        Ok(())
    }
    pub fn register(&self, pending: PendingTool) -> Result<(), String> {
        // 与撤销采用相同的 tools 锁；关闭后不能再登记有效请求。
        let mut tools = self.tools.lock().unwrap();
        self.check(&pending.call)?;
        if self.cancelled.lock().unwrap().contains(&pending.call.id)
            || tools.contains_key(&pending.call.id)
        {
            return Err("Agent 工具请求已取消或重复".into());
        }
        tools.insert(pending.call.id.clone(), pending);
        Ok(())
    }
    pub fn call(&self, id: &str) -> Result<Arc<ToolCall>, String> {
        let tools = self.tools.lock().unwrap();
        let call = tools.get(id).ok_or("Agent 工具请求已结束")?.call.clone();
        self.check(&call)?;
        Ok(call)
    }
    pub fn reply(&self, id: &str, result: Reply) {
        if let Some(pending) = self.tools.lock().unwrap().remove(id) {
            let result = self.check(&pending.call).and(result);
            let _ = pending.reply.send(result);
        }
    }
    pub fn cancel(&self, id: &str) {
        let mut tools = self.tools.lock().unwrap();
        let mut cancelled = self.cancelled.lock().unwrap();
        // 取消通知可能先于原请求到达。墓碑不复活，随实例退出释放。
        if cancelled.len() >= 8192 {
            self.accepting.store(false, Ordering::SeqCst);
        } else {
            cancelled.insert(id.to_owned());
        }
        if let Some(pending) = tools.remove(id) {
            pending.call.cancelled.store(true, Ordering::SeqCst);
            let _ = pending.reply.send(Err("Agent 工具请求已取消".into()));
        }
    }
    pub fn revoke(&self) -> Vec<String> {
        self.accepting.store(false, Ordering::SeqCst);
        let mut tools = self.tools.lock().unwrap();
        let mut ids = Vec::new();
        for (id, pending) in tools.drain() {
            pending.call.cancelled.store(true, Ordering::SeqCst);
            let _ = pending.reply.send(Err("Agent 任务已停止".into()));
            ids.push(id);
        }
        ids
    }
    pub fn exited(&self) -> Vec<String> {
        self.alive.store(false, Ordering::SeqCst);
        let ids = self.revoke();
        for (_, reply) in self.rpc.lock().unwrap().drain() {
            let _ = reply.send(Err("Agent 进程已退出".into()));
        }
        ids
    }
    pub fn response(&self, record: &Value) {
        match record["type"].as_str() {
            Some("agent_start") => { self.turn_running.store(true, Ordering::SeqCst); return; }
            Some("agent_settled") => { self.turn_running.store(false, Ordering::SeqCst); return; }
            Some("response") => {}
            _ => return
        }
        let Some(id) = record["id"].as_str() else {
            return;
        };
        if let Some(reply) = self.rpc.lock().unwrap().remove(id) {
            let result = if record["success"] == true {
                Ok(record
                    .get("data")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})))
            } else {
                Err(format!(
                    "PI_COMMAND_REJECTED: {}",
                    record["error"].as_str().unwrap_or("Agent 命令失败")
                ))
            };
            let _ = reply.send(result);
        }
    }
    pub fn writing(self: &Arc<Self>, call: &ToolCall) -> Result<WriteGuard, String> {
        self.check(call)?;
        self.writes.fetch_add(1, Ordering::SeqCst);
        let guard = WriteGuard(self.clone());
        self.check(call)?;
        Ok(guard)
    }
    pub async fn drain_writes(&self) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let changed = self.changed.notified();
                if self.writes.load(Ordering::SeqCst) == 0 {
                    break;
                }
                changed.await;
            }
        })
        .await
        .map_err(|_| "Agent 草稿写入仍在收尾，请重试停止；未确认停止完成".to_string())
    }
    pub fn has_writes(&self) -> bool {
        self.writes.load(Ordering::SeqCst) != 0
    }
    pub fn has_tools(&self) -> bool {
        !self.tools.lock().unwrap().is_empty()
    }
}
pub struct WriteGuard(Arc<Instance>);
impl Drop for WriteGuard {
    fn drop(&mut self) {
        self.0.writes.fetch_sub(1, Ordering::SeqCst);
        self.0.changed.notify_one();
    }
}
