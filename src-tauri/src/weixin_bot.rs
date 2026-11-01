//! 微信 ClawBot 通道：iLink Bot 协议客户端。
//!
//! 易创桌面端自己充当机器人后端，不依赖 OpenClaw、不需要公网服务器：
//! 扫码绑定拿到 bot_token 后，这里用长轮询从 ilinkai.weixin.qq.com 收消息，
//! 经事件推给前端跑工具循环，再把回复原路发回微信。
//!
//! 协议以腾讯官方仓库 Tencent/openclaw-weixin 的 docs/protocol.md 为准，
//! 版本相关常量集中在文件顶部，官方插件升级时只改这里。
//! 能力：收文本与语音转写、回文本、维护"正在输入"状态；发图片/文件（AES-128-ECB 加密后传 CDN，
//! 再在消息里带 CDN 引用）；用最近一次收到的会话令牌主动推送文本。
//!
//! 凭据（bot_token 等同一个微信会话的控制权）落在数据目录 weixin-bot.json，
//! 权限 0600，不进备份包；换电脑重新扫码即可。
use crate::{desktop_storage, DesktopAppHandle, DesktopWebviewWindow};
use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use md5::{Digest, Md5};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_http::reqwest;

// ---------------------------------------------------------------------------
// 协议常量（跟随官方插件版本，升级时同步修改）
// ---------------------------------------------------------------------------

/// 登录与默认 API 地址；登录成功后服务端可能下发专属 baseurl，之后以它为准
const DEFAULT_API_BASE: &str = "https://ilinkai.weixin.qq.com";
/// 我们按哪个版本的官方插件协议说话：服务端靠 channel_version 与 ClientVersion 识别协议版本
const CHANNEL_VERSION: (u32, u32, u32) = (2, 4, 10);
/// 官方插件的应用标识，目前固定为 bot，无需申请
const APP_ID: &str = "bot";
/// 观测用标识，不参与鉴权与路由
const BOT_AGENT_NAME: &str = "YiChuang";
const CREDENTIALS_FILE: &str = "weixin-bot.json";
/// 服务端长轮询最多挂 35 秒，客户端超时要留出余量
const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(50);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 扫码状态查询也是长轮询
const QR_POLL_TIMEOUT: Duration = Duration::from_secs(40);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// 服务端返回 -14 表示 bot_token 已失效，必须重新扫码
const STALE_TOKEN_CODE: i64 = -14;
/// 前端尚未就绪时在 Rust 侧暂存的入站消息上限
const PENDING_LIMIT: usize = 50;
/// 设置页展示的最近发送记录条数
const RECENT_SENDS_LIMIT: usize = 10;
/// 单条文本上限（按字符），超过由前端分段；这里兜底截断避免服务端拒收
const TEXT_MAX_CHARS: usize = 4000;
/// 媒体文件的 CDN 地址；服务端下发了完整上传地址时以服务端为准
const CDN_BASE_URL: &str = "https://novac2c.cdn.weixin.qq.com/c2c";
/// 单个媒体文件上限（官方说明 25 MiB）
const MEDIA_MAX_BYTES: usize = 25 * 1024 * 1024;
/// CDN 上传遇到非 4xx 失败最多试几次（与官方插件一致）
const UPLOAD_MAX_ATTEMPTS: usize = 3;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub const EVENT_MESSAGE: &str = "weixin-bot://message";
pub const EVENT_STATUS: &str = "weixin-bot://status";

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 扫码成功后保存到本机的凭据
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Credentials {
    bot_token: String,
    base_url: String,
    ilink_bot_id: String,
    ilink_user_id: String,
    /// getupdates 游标；收到即持久化，宁可丢一条也不重复执行
    #[serde(default)]
    get_updates_buf: String,
    bound_at_ms: i64,
    /// 最近一条入站消息的会话令牌与发送者：主动推送只能借它发；官方没写有效期，用不了时前端会排队补发
    #[serde(default)]
    last_context_token: String,
    #[serde(default)]
    last_context_user_id: String,
    #[serde(default)]
    last_context_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnState {
    /// 未绑定或未启动
    Offline,
    Connecting,
    Online,
    /// token 失效，需重新扫码
    StaleToken,
    /// 网络或服务端错误，正在退避重试
    Error,
}

impl ConnState {
    fn code(self) -> &'static str {
        match self {
            ConnState::Offline => "offline",
            ConnState::Connecting => "connecting",
            ConnState::Online => "online",
            ConnState::StaleToken => "stale_token",
            ConnState::Error => "error",
        }
    }
}

/// 一次扫码登录流程的现场：二维码值与当前应轮询的主机
#[derive(Debug, Clone)]
struct LoginSession {
    qrcode: String,
    host: String,
}

/// 推给前端的入站消息（只保留通道层需要的字段）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboundMessage {
    /// 微信的消息编号超出 JS 安全整数范围，按字符串原样交给前端，前端回执时也原样带回
    pub message_id: String,
    pub from_user_id: String,
    pub to_user_id: String,
    /// 回复时必须原样带回
    pub context_token: String,
    pub create_time_ms: i64,
    /// text / voice / image / file / video / other
    pub kind: String,
    /// 文本内容；语音消息为服务端转写文本（可能为空）
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRecord {
    pub at_ms: i64,
    pub ok: bool,
    /// text 普通回复 / push 主动推送 / image、file 媒体
    pub kind: String,
    /// 文本按字符数，媒体按明文字节数
    pub chars: usize,
    pub client_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub bound: bool,
    pub state: String,
    pub user_id: String,
    pub bot_id: String,
    pub bound_at_ms: i64,
    pub last_message_at_ms: i64,
    pub last_error: String,
    pub protocol_version: String,
    pub pending_count: usize,
    pub recent_sends: Vec<SendRecord>,
    /// 拿到过会话令牌才能主动推送
    pub push_available: bool,
    pub last_context_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartView {
    pub qrcode: String,
    /// 需要前端渲染成二维码的内容（通常是一个 URL）
    pub qrcode_img_content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPollView {
    /// wait / scaned / confirmed / expired / need_verifycode / verify_code_blocked / binded_redirect
    pub status: String,
    pub message: String,
}

#[derive(Default)]
struct Runtime {
    credentials: Option<Credentials>,
    /// 是否已尝试从磁盘读取凭据（避免每次状态查询都碰文件）
    loaded: bool,
    abort: Option<tokio::task::AbortHandle>,
    state: Option<ConnState>,
    last_error: String,
    last_message_at_ms: i64,
    /// 前端已注册监听：之前到达的消息走 pending，之后的直接 emit
    frontend_attached: bool,
    pending: VecDeque<InboundMessage>,
    /// 已发给网页层、网页层还没回执的消息：网页层重载（开发版热更新、窗口刷新）后重新 attach 时补发，不丢
    unacked: VecDeque<InboundMessage>,
    login: Option<LoginSession>,
    typing_ticket: Option<String>,
    recent_sends: VecDeque<SendRecord>,
}

impl Runtime {
    /// 收到一条：网页层在线就直接发事件并记入待回执，否则先攒着；返回是否立即发事件
    fn accept(&mut self, message: InboundMessage) -> bool {
        self.last_message_at_ms = now_ms();
        let queue = if self.frontend_attached { &mut self.unacked } else { &mut self.pending };
        if queue.len() >= PENDING_LIMIT {
            queue.pop_front();
        }
        queue.push_back(message);
        self.frontend_attached
    }

    /// 网页层挂好监听后取走：先补发没回执的，再给攒着的；两边都留到回执为止
    fn attach(&mut self) -> Vec<InboundMessage> {
        self.frontend_attached = true;
        let mut replay: Vec<InboundMessage> = self.unacked.iter().cloned().collect();
        let fresh: Vec<InboundMessage> = self.pending.drain(..).collect();
        for message in &fresh {
            if self.unacked.len() >= PENDING_LIMIT {
                self.unacked.pop_front();
            }
            self.unacked.push_back(message.clone());
        }
        replay.extend(fresh);
        replay
    }

    /// 网页层已记下这条消息：不再补发
    fn ack(&mut self, message_id: &str) -> bool {
        let before = self.unacked.len();
        self.unacked.retain(|m| m.message_id != message_id);
        self.unacked.len() != before
    }
}

fn runtime() -> &'static Mutex<Runtime> {
    static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(Runtime::default()))
}

fn lock_runtime() -> Result<std::sync::MutexGuard<'static, Runtime>, String> {
    runtime().lock().map_err(|_| "微信通道状态不可用".to_string())
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn protocol_version_text() -> String {
    let (major, minor, patch) = CHANNEL_VERSION;
    format!("{major}.{minor}.{patch}")
}

/// iLink-App-ClientVersion：版本号按 0x00MMNNPP 编码后以十进制字符串发送
fn encode_client_version((major, minor, patch): (u32, u32, u32)) -> String {
    ((major << 16) | (minor << 8) | patch).to_string()
}

/// X-WECHAT-UIN：随机 uint32 的十进制字符串再 base64，每次请求都变（防重放）
fn random_u32() -> u32 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = DefaultHasher::new();
    now_ms().hash(&mut hasher);
    COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    hasher.finish() as u32
}

fn uin_header(value: u32) -> String {
    BASE64.encode(value.to_string())
}

fn bot_agent() -> String {
    format!("{BOT_AGENT_NAME}/{}", env!("CARGO_PKG_VERSION"))
}

fn base_info() -> Value {
    json!({ "channel_version": protocol_version_text(), "bot_agent": bot_agent() })
}

fn require_main(window: &DesktopWebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| crate::is_app_shell_url(&url)) {
        return Err("微信通道命令只接受本地主窗口".into());
    }
    Ok(())
}

/// 服务端下发的 redirect_host / baseurl 可能不带协议，统一补成 https 且去掉尾部斜杠
fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_API_BASE.to_string();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn credentials_path(app: &DesktopAppHandle) -> Result<PathBuf, String> {
    Ok(desktop_storage::root(app)?.join(CREDENTIALS_FILE))
}

fn write_credentials_file(path: &PathBuf, credentials: &Credentials) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(credentials).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("保存微信凭据失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_credentials_file(path: &PathBuf) -> Result<Option<Credentials>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取微信凭据失败：{e}"))?;
    let parsed: Credentials =
        serde_json::from_str(&text).map_err(|_| "微信凭据文件格式无效，请解除绑定后重新扫码".to_string())?;
    if parsed.bot_token.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(parsed))
}

/// 确保内存里的凭据与磁盘一致（只在首次访问时读文件）
fn ensure_loaded(app: &DesktopAppHandle) -> Result<(), String> {
    let path = credentials_path(app)?;
    let mut rt = lock_runtime()?;
    if rt.loaded {
        return Ok(());
    }
    rt.credentials = read_credentials_file(&path)?;
    rt.loaded = true;
    Ok(())
}

fn current_credentials() -> Result<Option<Credentials>, String> {
    Ok(lock_runtime()?.credentials.clone())
}

fn set_state(app: &DesktopAppHandle, state: ConnState, error: impl Into<String>) {
    let changed = {
        let Ok(mut rt) = runtime().lock() else { return };
        let error = error.into();
        let changed = rt.state != Some(state) || rt.last_error != error;
        rt.state = Some(state);
        rt.last_error = error;
        changed
    };
    if changed {
        if let Ok(view) = build_status_view() {
            let _ = app.emit(EVENT_STATUS, view);
        }
    }
}

fn build_status_view() -> Result<StatusView, String> {
    let rt = lock_runtime()?;
    let credentials = rt.credentials.as_ref();
    let state = rt.state.unwrap_or(ConnState::Offline);
    Ok(StatusView {
        bound: credentials.is_some(),
        state: state.code().to_string(),
        user_id: credentials.map(|c| c.ilink_user_id.clone()).unwrap_or_default(),
        bot_id: credentials.map(|c| c.ilink_bot_id.clone()).unwrap_or_default(),
        bound_at_ms: credentials.map(|c| c.bound_at_ms).unwrap_or_default(),
        last_message_at_ms: rt.last_message_at_ms,
        last_error: rt.last_error.clone(),
        protocol_version: protocol_version_text(),
        pending_count: rt.pending.len(),
        recent_sends: rt.recent_sends.iter().cloned().collect(),
        push_available: credentials.is_some_and(|c| !c.last_context_token.is_empty()),
        last_context_at_ms: credentials.map(|c| c.last_context_at_ms).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("创建微信请求客户端失败：{e}"))
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "微信服务请求超时".into();
    }
    if error.is_connect() {
        return "连不上微信服务，请检查网络".into();
    }
    format!("微信服务请求失败：{error}")
}

/// 应用层通用头：二维码状态轮询只带这一组
fn with_app_headers(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request
        .header("iLink-App-Id", APP_ID)
        .header("iLink-App-ClientVersion", encode_client_version(CHANNEL_VERSION))
}

/// JSON POST 头：登录前不带 Authorization，登录后带 Bearer bot_token
fn with_post_headers(request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    let mut request = with_app_headers(request)
        .header("Content-Type", "application/json")
        .header("AuthorizationType", "ilink_bot_token")
        .header("X-WECHAT-UIN", uin_header(random_u32()));
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    request
}

async fn read_json(response: reqwest::Response, what: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(request_error)?;
    if !status.is_success() {
        return Err(format!("{what}返回 HTTP {status}"));
    }
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|_| format!("{what}未返回有效 JSON"))
}

async fn post_json(
    base_url: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
    timeout: Duration,
    what: &str,
) -> Result<Value, String> {
    let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
    let response = with_post_headers(client(timeout)?.post(url), token)
        .body(body.to_string())
        .send()
        .await
        .map_err(request_error)?;
    read_json(response, what).await
}

/// 业务返回码：ret 与 errcode 任一非零即失败；-14 单独识别
fn business_code(value: &Value) -> i64 {
    let ret = value.get("ret").and_then(Value::as_i64).unwrap_or(0);
    if ret != 0 {
        return ret;
    }
    value.get("errcode").and_then(Value::as_i64).unwrap_or(0)
}

fn business_message(value: &Value) -> String {
    value
        .get("errmsg")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("返回码 {}", business_code(value)))
}

// ---------------------------------------------------------------------------
// 入站消息解析
// ---------------------------------------------------------------------------

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// 把服务端消息转成前端需要的形状。
/// 过滤：只收用户发出的（message_type=1）、不收群消息；
/// 绑定用户之外的发送者也丢弃，机器人只听绑定它的那个微信号。
fn parse_inbound(value: &Value, bound_user_id: &str) -> Option<InboundMessage> {
    if value.get("message_type").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    if !str_field(value, "group_id").is_empty() {
        return None;
    }
    let from_user_id = str_field(value, "from_user_id");
    if !bound_user_id.is_empty() && from_user_id != bound_user_id {
        return None;
    }
    let items = value.get("item_list").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut kind = "other";
    let mut text = String::new();
    for item in &items {
        match item.get("type").and_then(Value::as_i64) {
            Some(1) => {
                let piece = item.get("text_item").map(|t| str_field(t, "text")).unwrap_or_default();
                if !piece.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(piece.trim());
                }
                kind = "text";
            }
            Some(3) => {
                if kind != "text" {
                    kind = "voice";
                    text = item.get("voice_item").map(|v| str_field(v, "text")).unwrap_or_default().trim().to_string();
                }
            }
            Some(2) if kind == "other" => kind = "image",
            Some(4) if kind == "other" => kind = "file",
            Some(5) if kind == "other" => kind = "video",
            _ => {}
        }
    }
    Some(InboundMessage {
        message_id: value
            .get("message_id")
            .and_then(|v| v.as_i64().map(|n| n.to_string()).or_else(|| v.as_str().map(str::to_owned)))
            .unwrap_or_default(),
        from_user_id,
        to_user_id: str_field(value, "to_user_id"),
        context_token: str_field(value, "context_token"),
        create_time_ms: value.get("create_time_ms").and_then(Value::as_i64).unwrap_or_else(now_ms),
        kind: kind.to_string(),
        text,
    })
}

/// 宿主侧的技术日志：与网页层写同一个 weixin-bot.log（网页层重载时它缓冲里的行会丢，这里的不会），
/// 事件名带 host- 前缀。写不进去不影响收发。
fn trace(app: &DesktopAppHandle, event: &str, detail: Value) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let path = dir.join("logs").join("weixin-bot.log");
    let line = format!(
        "{} INFO  host-{event} {detail}\n",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    let _ = crate::append_app_log(path.to_string_lossy().into_owned(), line, 1024 * 1024);
}

/// 投递给前端：已挂监听就直接发事件并等回执，否则先攒着等 attach 时取走
fn deliver(app: &DesktopAppHandle, message: InboundMessage) {
    let emit_now = {
        let Ok(mut rt) = runtime().lock() else { return };
        rt.accept(message.clone())
    };
    trace(app, "inbound", json!({"messageId":message.message_id,"kind":message.kind,"chars":message.text.chars().count(),
        "delivery":if emit_now { "emitted" } else { "buffered" }}));
    if emit_now {
        let _ = app.emit(EVENT_MESSAGE, message);
    }
}

// ---------------------------------------------------------------------------
// 长轮询主循环
// ---------------------------------------------------------------------------

fn stop_loop() {
    if let Ok(mut rt) = runtime().lock() {
        if let Some(abort) = rt.abort.take() {
            abort.abort();
        }
    }
}

/// 有凭据且循环未在跑时启动；重复调用安全
fn start_loop(app: &DesktopAppHandle) -> Result<(), String> {
    {
        let rt = lock_runtime()?;
        if rt.credentials.is_none() {
            return Err("尚未绑定微信，请先扫码".into());
        }
        if rt.abort.is_some() {
            return Ok(());
        }
    }
    let app_for_task = app.clone();
    let task = tauri::async_runtime::spawn(async move { poll_loop(app_for_task).await });
    let abort = task.inner().abort_handle();
    lock_runtime()?.abort = Some(abort);
    Ok(())
}

async fn poll_loop(app: DesktopAppHandle) {
    let mut backoff = BACKOFF_MIN;
    set_state(&app, ConnState::Connecting, "");
    loop {
        let Ok(Some(credentials)) = current_credentials() else {
            set_state(&app, ConnState::Offline, "");
            break;
        };
        let body = json!({ "get_updates_buf": credentials.get_updates_buf, "base_info": base_info() });
        let result = post_json(
            &credentials.base_url,
            "ilink/bot/getupdates",
            Some(&credentials.bot_token),
            body,
            LONG_POLL_TIMEOUT,
            "收消息接口",
        )
        .await;
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                set_state(&app, ConnState::Error, error);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        let code = business_code(&value);
        if code == STALE_TOKEN_CODE {
            set_state(&app, ConnState::StaleToken, "微信登录已失效，请重新扫码绑定");
            if let Ok(mut rt) = runtime().lock() {
                rt.abort = None;
            }
            break;
        }
        if code != 0 {
            set_state(&app, ConnState::Error, format!("收消息接口异常：{}", business_message(&value)));
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
            continue;
        }
        backoff = BACKOFF_MIN;
        set_state(&app, ConnState::Online, "");

        let bound_user = credentials.ilink_user_id.clone();
        let messages: Vec<InboundMessage> = value
            .get("msgs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|raw| parse_inbound(raw, &bound_user))
            .collect();
        // 游标与最近会话令牌先落盘再投递：进程中途退出也不会把同一批消息再跑一遍
        let cursor = value.get("get_updates_buf").and_then(Value::as_str).filter(|s| !s.is_empty());
        let last_context = messages
            .iter()
            .rev()
            .find(|message| !message.context_token.is_empty())
            .map(|message| (message.from_user_id.as_str(), message.context_token.as_str()));
        if let Err(error) = persist_progress(&app, cursor, last_context) {
            set_state(&app, ConnState::Error, error);
        }
        for message in messages {
            deliver(&app, message);
        }
    }
}

/// 游标与最近一次会话令牌一起持久化；两者都没变就不碰文件
fn persist_progress(app: &DesktopAppHandle, cursor: Option<&str>, context: Option<(&str, &str)>) -> Result<(), String> {
    let path = credentials_path(app)?;
    let mut rt = lock_runtime()?;
    let Some(credentials) = rt.credentials.as_mut() else { return Ok(()) };
    let mut changed = false;
    if let Some(cursor) = cursor {
        if cursor != credentials.get_updates_buf {
            credentials.get_updates_buf = cursor.to_string();
            changed = true;
        }
    }
    let mut token_renewed = false;
    if let Some((user_id, token)) = context {
        if token != credentials.last_context_token || user_id != credentials.last_context_user_id {
            credentials.last_context_token = token.to_string();
            credentials.last_context_user_id = user_id.to_string();
            credentials.last_context_at_ms = now_ms();
            changed = true;
            token_renewed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    write_credentials_file(&path, credentials)?;
    if token_renewed {
        // 拿到新令牌：之前推不出去的通知现在能补发了
        crate::weixin_delivery::flush_soon(app, crate::weixin_delivery::WEIXIN);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令：状态与生命周期
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn weixin_bot_status(window: DesktopWebviewWindow) -> Result<StatusView, String> {
    require_main(&window)?;
    ensure_loaded(window.app_handle())?;
    build_status_view()
}

/// 应用启动时由前端调用：有凭据就拉起长轮询
#[tauri::command(async)]
pub fn weixin_bot_start(window: DesktopWebviewWindow) -> Result<StatusView, String> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    ensure_loaded(&app)?;
    if current_credentials()?.is_some() {
        start_loop(&app)?;
    }
    build_status_view()
}

/// 前端挂好事件监听后调用：标记就绪，取走此前暂存的消息，并补发网页层还没回执的消息（页面重载过）
#[tauri::command]
pub fn weixin_bot_attach(window: DesktopWebviewWindow) -> Result<Vec<InboundMessage>, String> {
    require_main(&window)?;
    let messages = lock_runtime()?.attach();
    if !messages.is_empty() {
        trace(&window.app_handle().clone(), "attach", json!({"handedOver":messages.len(),
            "messageIds":messages.iter().map(|m| m.message_id.as_str()).collect::<Vec<_>>()}));
    }
    Ok(messages)
}

/// 网页层已把这条消息记进日志：不再补发。回执必须用字符串编号，数字会在 JS 里丢精度。
#[tauri::command]
pub fn weixin_bot_ack(window: DesktopWebviewWindow, message_id: String) -> Result<bool, String> {
    require_main(&window)?;
    Ok(lock_runtime()?.ack(&message_id))
}

/// 解除绑定：停循环、删凭据文件、清内存状态
#[tauri::command(async)]
pub fn weixin_bot_logout(window: DesktopWebviewWindow) -> Result<StatusView, String> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    stop_loop();
    let path = credentials_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除微信凭据失败：{e}"))?;
    }
    {
        let mut rt = lock_runtime()?;
        rt.credentials = None;
        rt.loaded = true;
        rt.typing_ticket = None;
        rt.pending.clear();
        rt.unacked.clear();
        rt.login = None;
        rt.last_error.clear();
        rt.state = Some(ConnState::Offline);
    }
    let view = build_status_view()?;
    let _ = app.emit(EVENT_STATUS, view.clone());
    Ok(view)
}

// ---------------------------------------------------------------------------
// 命令：扫码登录
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn weixin_bot_login_start(window: DesktopWebviewWindow) -> Result<LoginStartView, String> {
    require_main(&window)?;
    let value = post_json(
        DEFAULT_API_BASE,
        "ilink/bot/get_bot_qrcode?bot_type=3",
        None,
        json!({ "local_token_list": [] }),
        REQUEST_TIMEOUT,
        "获取二维码接口",
    )
    .await?;
    let qrcode = str_field(&value, "qrcode");
    let content = str_field(&value, "qrcode_img_content");
    if qrcode.is_empty() || content.is_empty() {
        return Err(format!("获取二维码失败：{}", business_message(&value)));
    }
    lock_runtime()?.login = Some(LoginSession { qrcode: qrcode.clone(), host: DEFAULT_API_BASE.to_string() });
    Ok(LoginStartView { qrcode, qrcode_img_content: content })
}

/// 轮询扫码状态；confirmed 时保存凭据并启动长轮询。
/// 前端拿到非终态就继续调，拿到 expired 重新取码。
#[tauri::command]
pub async fn weixin_bot_login_poll(
    window: DesktopWebviewWindow,
    verify_code: Option<String>,
) -> Result<LoginPollView, String> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    let session = lock_runtime()?.login.clone().ok_or("二维码已失效，请重新获取")?;
    let url = format!("{}/ilink/bot/get_qrcode_status", session.host);
    let mut query: Vec<(&str, String)> = vec![("qrcode", session.qrcode.clone())];
    if let Some(code) = verify_code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        query.push(("verify_code", code));
    }
    let response = with_app_headers(client(QR_POLL_TIMEOUT)?.get(url))
        .query(&query)
        .send()
        .await;
    // 长轮询超时属于正常等待，前端会继续轮询
    let value = match response {
        Ok(response) => read_json(response, "扫码状态接口").await?,
        Err(error) if error.is_timeout() => return Ok(LoginPollView { status: "wait".into(), message: String::new() }),
        Err(error) => return Err(request_error(error)),
    };
    let status = str_field(&value, "status");
    match status.as_str() {
        "confirmed" => {
            let bot_token = str_field(&value, "bot_token");
            if bot_token.is_empty() {
                return Err("扫码确认成功但未下发凭据，请重试".into());
            }
            let credentials = Credentials {
                bot_token,
                base_url: normalize_host(&str_field(&value, "baseurl")),
                ilink_bot_id: str_field(&value, "ilink_bot_id"),
                ilink_user_id: str_field(&value, "ilink_user_id"),
                get_updates_buf: String::new(),
                bound_at_ms: now_ms(),
                last_context_token: String::new(),
                last_context_user_id: String::new(),
                last_context_at_ms: 0,
            };
            let path = credentials_path(&app)?;
            write_credentials_file(&path, &credentials)?;
            {
                let mut rt = lock_runtime()?;
                rt.credentials = Some(credentials);
                rt.loaded = true;
                rt.login = None;
                rt.typing_ticket = None;
                rt.last_error.clear();
            }
            stop_loop();
            start_loop(&app)?;
            Ok(LoginPollView { status, message: "绑定成功，微信里已出现 ClawBot 联系人".into() })
        }
        "scaned_but_redirect" => {
            let redirect = str_field(&value, "redirect_host");
            if !redirect.is_empty() {
                if let Some(login) = lock_runtime()?.login.as_mut() {
                    login.host = normalize_host(&redirect);
                }
            }
            Ok(LoginPollView { status: "scaned".into(), message: "已扫码，正在确认".into() })
        }
        "scaned" => Ok(LoginPollView { status, message: "已扫码，请在微信里点击确认".into() }),
        "need_verifycode" => Ok(LoginPollView { status, message: "微信要求输入验证码，请填写后继续".into() }),
        "verify_code_blocked" => Ok(LoginPollView { status, message: "验证码错误次数过多，请重新获取二维码".into() }),
        "expired" => Ok(LoginPollView { status, message: "二维码已过期，请重新获取".into() }),
        "binded_redirect" => Ok(LoginPollView { status, message: "该微信已绑定过本机，请先在微信里解除再重试".into() }),
        _ => Ok(LoginPollView { status: "wait".into(), message: String::new() }),
    }
}

#[tauri::command]
pub fn weixin_bot_login_cancel(window: DesktopWebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    lock_runtime()?.login = None;
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令：发送
// ---------------------------------------------------------------------------

fn record_send(record: SendRecord) {
    if let Ok(mut rt) = runtime().lock() {
        if rt.recent_sends.len() >= RECENT_SENDS_LIMIT {
            rt.recent_sends.pop_front();
        }
        rt.recent_sends.push_back(record);
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 业务返回码统一处理：-14 标记登录失效，其余非零按"微信拒收"报错
fn check_send_result(app: &DesktopAppHandle, value: &Value) -> Result<(), String> {
    let code = business_code(value);
    if code == STALE_TOKEN_CODE {
        set_state(app, ConnState::StaleToken, "微信登录已失效，请重新扫码绑定");
        return Err("微信登录已失效，请重新扫码绑定".into());
    }
    if code != 0 {
        return Err(format!("微信拒收：{}", business_message(value)));
    }
    Ok(())
}

/// 发一条消息（任意 item_list），成败都记进最近发送；context_token 必须是入站消息里的那个
async fn send_items(
    app: &DesktopAppHandle,
    credentials: &Credentials,
    to_user_id: &str,
    context_token: &str,
    items: Vec<Value>,
    kind: &str,
    chars: usize,
) -> Result<SendRecord, String> {
    if context_token.trim().is_empty() {
        return Err("缺少会话令牌，微信不会接收这条消息".into());
    }
    let client_id = format!("yc-{}-{}", now_ms(), random_u32() % 10_000);
    let body = json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": client_id,
            "message_type": 2,
            "message_state": 2,
            "context_token": context_token,
            "item_list": items
        },
        "base_info": base_info()
    });
    let outcome = post_json(
        &credentials.base_url,
        "ilink/bot/sendmessage",
        Some(&credentials.bot_token),
        body,
        REQUEST_TIMEOUT,
        "发消息接口",
    )
    .await
    .and_then(|value| check_send_result(app, &value));
    let record = SendRecord {
        at_ms: now_ms(),
        ok: outcome.is_ok(),
        kind: kind.to_string(),
        chars,
        client_id,
        error: outcome.as_ref().err().cloned().unwrap_or_default(),
    };
    record_send(record.clone());
    outcome.map(|_| record)
}

fn text_item(text: &str) -> Value {
    json!({ "type": 1, "text_item": { "text": text } })
}

/// 发一条文本回复；context_token 必须是对应入站消息里的那个
#[tauri::command]
pub async fn weixin_bot_send_text(
    window: DesktopWebviewWindow,
    to_user_id: String,
    context_token: String,
    text: String,
) -> Result<SendRecord, String> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    ensure_loaded(&app)?;
    let credentials = current_credentials()?.ok_or("尚未绑定微信")?;
    let text = truncate_chars(text.trim(), TEXT_MAX_CHARS);
    if text.is_empty() {
        return Err("回复内容为空".into());
    }
    send_items(&app, &credentials, &to_user_id, &context_token, vec![text_item(&text)], "text", text.chars().count()).await
}

/// 主动推送：借最近一条入站消息的会话令牌发文本。没收到过消息就没有令牌，宿主投递队列留着等作者下次发消息时补发
#[tauri::command]
pub async fn weixin_bot_push_text(window: DesktopWebviewWindow, text: String) -> Result<SendRecord, String> {
    require_main(&window)?;
    push_text(window.app_handle(), &text).await
}

/// 宿主侧主动推送（投递队列用）：与命令同一条路，不要求窗口
pub async fn push_text(app: &DesktopAppHandle, text: &str) -> Result<SendRecord, String> {
    ensure_loaded(app)?;
    let credentials = current_credentials()?.ok_or("尚未绑定微信")?;
    if credentials.last_context_token.is_empty() || credentials.last_context_user_id.is_empty() {
        return Err("还没有收到过微信消息，拿不到会话令牌，暂时无法主动推送".into());
    }
    let text = truncate_chars(text.trim(), TEXT_MAX_CHARS);
    if text.is_empty() {
        return Err("推送内容为空".into());
    }
    let to_user_id = credentials.last_context_user_id.clone();
    let context_token = credentials.last_context_token.clone();
    send_items(app, &credentials, &to_user_id, &context_token, vec![text_item(&text)], "push", text.chars().count()).await
}

/// 现在能不能主动推：已绑定且收到过消息（有会话令牌）
pub fn push_available(app: &DesktopAppHandle) -> bool {
    if ensure_loaded(app).is_err() {
        return false;
    }
    current_credentials().ok().flatten().is_some_and(|c| !c.last_context_token.is_empty() && !c.last_context_user_id.is_empty())
}

// ---------------------------------------------------------------------------
// 媒体：AES-128-ECB 加密 → getuploadurl → 传 CDN → sendmessage 带 CDN 引用
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Image,
    File,
}

impl MediaKind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "image" => Ok(MediaKind::Image),
            "file" => Ok(MediaKind::File),
            other => Err(format!("不支持的媒体类型「{other}」，只能发 image 或 file")),
        }
    }

    /// getuploadurl 的 media_type：1 图片 / 2 视频 / 3 文件 / 4 语音
    fn upload_media_type(self) -> u8 {
        match self {
            MediaKind::Image => 1,
            MediaKind::File => 3,
        }
    }

    fn code(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::File => "file",
        }
    }
}

/// PKCS#7 填充后的密文长度：恰好整块时也要补一整块
fn aes_ecb_padded_len(plain_len: usize) -> usize {
    (plain_len / 16 + 1) * 16
}

/// AES-128-ECB + PKCS#7（与官方插件 aes-ecb.ts 一致）
fn aes128_ecb_encrypt(plain: &[u8], key: &[u8; 16]) -> Vec<u8> {
    let cipher = aes::Aes128::new(GenericArray::from_slice(key));
    let pad = 16 - plain.len() % 16;
    let mut out = Vec::with_capacity(plain.len() + pad);
    out.extend_from_slice(plain);
    out.extend(std::iter::repeat(pad as u8).take(pad));
    for block in out.chunks_mut(16) {
        cipher.encrypt_block(GenericArray::from_mut_slice(block));
    }
    out
}

fn random_bytes16() -> [u8; 16] {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}

/// 上传地址：服务端给了完整地址就用它，否则按 CDN 规则拼
fn resolve_upload_url(value: &Value, filekey: &str) -> Result<String, String> {
    let full = str_field(value, "upload_full_url");
    if !full.trim().is_empty() {
        return Ok(full.trim().to_string());
    }
    let param = str_field(value, "upload_param");
    if param.is_empty() {
        return Err(format!("取上传地址失败：{}", business_message(value)));
    }
    reqwest::Url::parse_with_params(&format!("{CDN_BASE_URL}/upload"), &[("encrypted_query_param", param.as_str()), ("filekey", filekey)])
        .map(|url| url.to_string())
        .map_err(|e| format!("拼接上传地址失败：{e}"))
}

/// 把密文传到 CDN，成功以 HTTP 200 且返回 x-encrypted-param 头为准；4xx 不重试
async fn upload_to_cdn(url: &str, ciphertext: &[u8]) -> Result<String, String> {
    let client = client(UPLOAD_TIMEOUT)?;
    let mut last_error = String::new();
    for _ in 0..UPLOAD_MAX_ATTEMPTS {
        let response = client
            .post(url)
            .header("Content-Type", "application/octet-stream")
            .body(ciphertext.to_vec())
            .send()
            .await;
        match response {
            Ok(response) => {
                let status = response.status();
                let header = |name: &str| {
                    response
                        .headers()
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                };
                if status.is_client_error() {
                    return Err(format!("CDN 拒绝上传（HTTP {status}）：{}", header("x-error-message").unwrap_or_default()));
                }
                if status.as_u16() == 200 {
                    if let Some(param) = header("x-encrypted-param") {
                        return Ok(param);
                    }
                    last_error = "CDN 没有返回下载参数".into();
                } else {
                    last_error = format!("CDN 上传失败：{}", header("x-error-message").unwrap_or_else(|| format!("HTTP {status}")));
                }
            }
            Err(error) => last_error = request_error(error),
        }
    }
    Err(last_error)
}

/// 消息里的媒体项。aes_key 按官方插件的做法：把 32 位十六进制密钥字符串本身 base64，服务端两种编码都认
fn build_media_item(kind: MediaKind, download_param: &str, aes_key_hex: &str, raw_len: usize, cipher_len: usize, file_name: &str) -> Value {
    let media = json!({
        "encrypt_query_param": download_param,
        "aes_key": BASE64.encode(aes_key_hex.as_bytes()),
        "encrypt_type": 1
    });
    match kind {
        MediaKind::Image => json!({ "type": 2, "image_item": { "media": media, "mid_size": cipher_len } }),
        MediaKind::File => json!({ "type": 4, "file_item": { "media": media, "file_name": file_name, "len": raw_len.to_string() } }),
    }
}

/// 发图片或文件：内容由前端以 base64 传入
#[tauri::command]
pub async fn weixin_bot_send_media(
    window: DesktopWebviewWindow,
    to_user_id: String,
    context_token: String,
    media_kind: String,
    file_name: String,
    data_base64: String,
) -> Result<SendRecord, String> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    ensure_loaded(&app)?;
    let credentials = current_credentials()?.ok_or("尚未绑定微信")?;
    let kind = MediaKind::parse(&media_kind)?;
    let file_name = file_name.trim();
    if kind == MediaKind::File && file_name.is_empty() {
        return Err("文件名为空".into());
    }
    let plain = BASE64.decode(data_base64.trim()).map_err(|_| "媒体内容不是有效的 base64".to_string())?;
    if plain.is_empty() {
        return Err("媒体内容为空".into());
    }
    if plain.len() > MEDIA_MAX_BYTES {
        return Err(format!("文件 {} MB，超过微信 25 MB 上限", plain.len() / 1024 / 1024));
    }

    let key = random_bytes16();
    let key_hex = hex::encode(key);
    let filekey = hex::encode(random_bytes16());
    let cipher_len = aes_ecb_padded_len(plain.len());
    let upload_meta = post_json(
        &credentials.base_url,
        "ilink/bot/getuploadurl",
        Some(&credentials.bot_token),
        json!({
            "filekey": filekey,
            "media_type": kind.upload_media_type(),
            "to_user_id": to_user_id,
            "rawsize": plain.len(),
            "rawfilemd5": hex::encode(Md5::digest(&plain)),
            "filesize": cipher_len,
            "no_need_thumb": true,
            "aeskey": key_hex,
            "base_info": base_info()
        }),
        REQUEST_TIMEOUT,
        "取上传地址接口",
    )
    .await?;
    if business_code(&upload_meta) == STALE_TOKEN_CODE {
        set_state(&app, ConnState::StaleToken, "微信登录已失效，请重新扫码绑定");
        return Err("微信登录已失效，请重新扫码绑定".into());
    }
    let upload_url = resolve_upload_url(&upload_meta, &filekey)?;
    let ciphertext = aes128_ecb_encrypt(&plain, &key);
    debug_assert_eq!(ciphertext.len(), cipher_len);
    let download_param = upload_to_cdn(&upload_url, &ciphertext).await?;
    let item = build_media_item(kind, &download_param, &key_hex, plain.len(), ciphertext.len(), file_name);
    send_items(&app, &credentials, &to_user_id, &context_token, vec![item], kind.code(), plain.len()).await
}

/// 取"正在输入"票据；按账号缓存，失效时重新取
async fn typing_ticket(credentials: &Credentials, context_token: &str, refresh: bool) -> Result<String, String> {
    if !refresh {
        if let Some(ticket) = lock_runtime()?.typing_ticket.clone() {
            return Ok(ticket);
        }
    }
    let value = post_json(
        &credentials.base_url,
        "ilink/bot/getconfig",
        Some(&credentials.bot_token),
        json!({ "ilink_user_id": credentials.ilink_user_id, "context_token": context_token, "base_info": base_info() }),
        REQUEST_TIMEOUT,
        "配置接口",
    )
    .await?;
    if business_code(&value) != 0 {
        return Err(format!("取输入状态票据失败：{}", business_message(&value)));
    }
    let ticket = str_field(&value, "typing_ticket");
    if ticket.is_empty() {
        return Err("服务端未下发输入状态票据".into());
    }
    lock_runtime()?.typing_ticket = Some(ticket.clone());
    Ok(ticket)
}

/// 正在输入 / 取消输入。失败只记录，不影响正常回复
#[tauri::command]
pub async fn weixin_bot_send_typing(
    window: DesktopWebviewWindow,
    context_token: String,
    typing: bool,
) -> Result<(), String> {
    require_main(&window)?;
    let app = window.app_handle().clone();
    ensure_loaded(&app)?;
    let credentials = current_credentials()?.ok_or("尚未绑定微信")?;
    let status = if typing { 1 } else { 2 };
    let mut refresh = false;
    // 票据过期会被拒，刷新一次再试
    for _ in 0..2 {
        let ticket = typing_ticket(&credentials, &context_token, refresh).await?;
        let value = post_json(
            &credentials.base_url,
            "ilink/bot/sendtyping",
            Some(&credentials.bot_token),
            json!({ "ilink_user_id": credentials.ilink_user_id, "typing_ticket": ticket, "status": status, "base_info": base_info() }),
            REQUEST_TIMEOUT,
            "输入状态接口",
        )
        .await?;
        if business_code(&value) == 0 {
            return Ok(());
        }
        refresh = true;
    }
    Err("输入状态发送失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_version_is_encoded_as_0x00mmnnpp_decimal() {
        assert_eq!(encode_client_version((2, 4, 10)), "132106");
        assert_eq!(encode_client_version((1, 0, 2)), "65538");
    }

    #[test]
    fn uin_header_is_base64_of_decimal_uint32() {
        assert_eq!(uin_header(0), BASE64.encode("0"));
        assert_eq!(uin_header(4_294_967_295), BASE64.encode("4294967295"));
        let decoded = BASE64.decode(uin_header(random_u32())).unwrap();
        assert!(String::from_utf8(decoded).unwrap().chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn host_normalization_adds_scheme_and_trims_slash() {
        assert_eq!(normalize_host(""), DEFAULT_API_BASE);
        assert_eq!(normalize_host("ilinkai.weixin.qq.com/"), "https://ilinkai.weixin.qq.com");
        assert_eq!(normalize_host("https://a.b.c/"), "https://a.b.c");
    }

    #[test]
    fn inbound_parsing_keeps_user_text_and_voice_transcript_only() {
        let text = json!({
            "message_id": 7, "message_type": 1, "from_user_id": "u@im.wechat", "to_user_id": "b@im.bot",
            "context_token": "ctx", "create_time_ms": 1,
            "item_list": [{ "type": 1, "text_item": { "text": " 你好 " } }]
        });
        let parsed = parse_inbound(&text, "u@im.wechat").unwrap();
        assert_eq!(parsed.kind, "text");
        assert_eq!(parsed.text, "你好");
        assert_eq!(parsed.context_token, "ctx");

        let voice = json!({
            "message_type": 1, "from_user_id": "u@im.wechat",
            "item_list": [{ "type": 3, "voice_item": { "text": "语音转写" } }]
        });
        let parsed = parse_inbound(&voice, "").unwrap();
        assert_eq!(parsed.kind, "voice");
        assert_eq!(parsed.text, "语音转写");

        let image = json!({ "message_type": 1, "from_user_id": "u@im.wechat", "item_list": [{ "type": 2 }] });
        assert_eq!(parse_inbound(&image, "").unwrap().kind, "image");

        // 机器人自己的消息、群消息、非绑定用户的消息都不进通道
        let bot = json!({ "message_type": 2, "from_user_id": "b@im.bot", "item_list": [] });
        assert!(parse_inbound(&bot, "").is_none());
        let group = json!({ "message_type": 1, "group_id": "g1", "from_user_id": "u@im.wechat", "item_list": [] });
        assert!(parse_inbound(&group, "").is_none());
        let stranger = json!({ "message_type": 1, "from_user_id": "x@im.wechat", "item_list": [] });
        assert!(parse_inbound(&stranger, "u@im.wechat").is_none());
    }

    #[test]
    fn business_code_prefers_ret_then_errcode() {
        assert_eq!(business_code(&json!({ "ret": 0 })), 0);
        assert_eq!(business_code(&json!({ "ret": -14, "errcode": 5 })), -14);
        assert_eq!(business_code(&json!({ "errcode": -14 })), -14);
        assert_eq!(business_message(&json!({ "ret": 3 })), "返回码 3");
        assert_eq!(business_message(&json!({ "ret": 3, "errmsg": "bad" })), "bad");
    }

    #[test]
    fn credentials_roundtrip_through_file_and_missing_file_is_none() {
        let dir = std::env::temp_dir().join(format!("ew-weixin-bot-test-{}", now_ms()));
        let path = dir.join(CREDENTIALS_FILE);
        assert_eq!(read_credentials_file(&path).unwrap(), None);
        let credentials = Credentials {
            bot_token: "token".into(),
            base_url: DEFAULT_API_BASE.into(),
            ilink_bot_id: "bot".into(),
            ilink_user_id: "user".into(),
            get_updates_buf: "cursor".into(),
            bound_at_ms: 42,
            last_context_token: "ctx".into(),
            last_context_user_id: "user".into(),
            last_context_at_ms: 43,
        };
        write_credentials_file(&path, &credentials).unwrap();
        assert_eq!(read_credentials_file(&path).unwrap(), Some(credentials));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn old_credentials_file_without_context_fields_still_loads() {
        let dir = std::env::temp_dir().join(format!("ew-weixin-bot-legacy-{}", now_ms()));
        let path = dir.join(CREDENTIALS_FILE);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            r#"{"bot_token":"t","base_url":"https://a.b","ilink_bot_id":"b","ilink_user_id":"u","get_updates_buf":"","bound_at_ms":1}"#,
        )
        .unwrap();
        let loaded = read_credentials_file(&path).unwrap().unwrap();
        assert_eq!(loaded.last_context_token, "");
        assert_eq!(loaded.last_context_at_ms, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn aes128_ecb_matches_known_answer_and_pads_pkcs7() {
        // FIPS-197 附录 C.1 的标准测试向量：单块明文加密结果固定
        let key: [u8; 16] = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap().try_into().unwrap();
        let plain = hex::decode("00112233445566778899aabbccddeeff").unwrap();
        let cipher = aes128_ecb_encrypt(&plain, &key);
        assert_eq!(cipher.len(), 32, "整块明文也要补一整块填充");
        assert_eq!(hex::encode(&cipher[..16]), "69c4e0d86a7b0430d8cdb78070b4c55a");
        // 第二块是 16 个 0x10 的填充块，与官方插件（Node createCipheriv 默认 PKCS#7）一致
        let pad_block = aes128_ecb_encrypt(&[], &key);
        assert_eq!(pad_block.len(), 16);
        assert_eq!(&cipher[16..], &pad_block[..]);

        assert_eq!(aes_ecb_padded_len(0), 16);
        assert_eq!(aes_ecb_padded_len(15), 16);
        assert_eq!(aes_ecb_padded_len(16), 32);
        assert_eq!(aes_ecb_padded_len(17), 32);
        for len in [1usize, 15, 16, 17, 100] {
            assert_eq!(aes128_ecb_encrypt(&vec![7u8; len], &key).len(), aes_ecb_padded_len(len));
        }
    }

    #[test]
    fn media_item_shapes_follow_official_builders() {
        let image = build_media_item(MediaKind::Image, "dl", "00ff", 10, 16, "");
        assert_eq!(image["type"], 2);
        assert_eq!(image["image_item"]["mid_size"], 16);
        assert_eq!(image["image_item"]["media"]["encrypt_query_param"], "dl");
        assert_eq!(image["image_item"]["media"]["encrypt_type"], 1);
        assert_eq!(image["image_item"]["media"]["aes_key"], BASE64.encode("00ff"));

        let file = build_media_item(MediaKind::File, "dl", "00ff", 10, 16, "a.txt");
        assert_eq!(file["type"], 4);
        assert_eq!(file["file_item"]["file_name"], "a.txt");
        assert_eq!(file["file_item"]["len"], "10");
        assert!(file["file_item"]["media"]["aes_key"].is_string());

        assert_eq!(MediaKind::parse("image").unwrap().upload_media_type(), 1);
        assert_eq!(MediaKind::parse(" file ").unwrap().upload_media_type(), 3);
        assert!(MediaKind::parse("video").is_err());
    }

    #[test]
    fn upload_url_prefers_full_url_then_builds_from_param() {
        let full = json!({ "upload_full_url": " https://x.y/u?p=1 ", "upload_param": "ignored" });
        assert_eq!(resolve_upload_url(&full, "fk").unwrap(), "https://x.y/u?p=1");
        let built = resolve_upload_url(&json!({ "upload_param": "a b/c+d" }), "fk").unwrap();
        assert!(built.starts_with(&format!("{CDN_BASE_URL}/upload?encrypted_query_param=")));
        assert!(built.contains("a+b%2Fc%2Bd") || built.contains("a%20b%2Fc%2Bd"));
        assert!(built.ends_with("&filekey=fk"));
        assert!(resolve_upload_url(&json!({ "ret": 3, "errmsg": "no" }), "fk").unwrap_err().contains("no"));
    }

    #[test]
    fn long_text_is_truncated_by_chars_with_ellipsis() {
        assert_eq!(truncate_chars("短", 10), "短");
        let long: String = "字".repeat(TEXT_MAX_CHARS + 5);
        let cut = truncate_chars(&long, TEXT_MAX_CHARS);
        assert_eq!(cut.chars().count(), TEXT_MAX_CHARS);
        assert!(cut.ends_with('…'));
    }

    fn inbound(id: &str, text: &str) -> InboundMessage {
        InboundMessage { message_id: id.into(), from_user_id: "u".into(), to_user_id: "b".into(), context_token: "ctx".into(),
            create_time_ms: 1, kind: "text".into(), text: text.into() }
    }

    #[test]
    fn messages_wait_for_the_page_and_unacked_ones_are_replayed_after_a_reload() {
        let mut rt = Runtime::default();
        // 页面还没挂监听：先攒着，不发事件
        assert!(!rt.accept(inbound("1", "/帮助")));
        let first = rt.attach();
        assert_eq!(first.iter().map(|m| m.message_id.as_str()).collect::<Vec<_>>(), vec!["1"]);
        // 挂上监听后直接发事件，但记为待回执
        assert!(rt.accept(inbound("2", "/状态")));
        assert!(rt.ack("1"));
        assert!(!rt.ack("1"), "重复回执不算数");
        // 页面重载：再次 attach 时补发没回执的 2，不补发已回执的 1
        let replay = rt.attach();
        assert_eq!(replay.iter().map(|m| m.message_id.as_str()).collect::<Vec<_>>(), vec!["2"]);
        assert!(rt.ack("2"));
        assert!(rt.attach().is_empty());
        // 两边都有上限，超过就丢最早的
        for i in 0..(PENDING_LIMIT + 5) {
            rt.accept(inbound(&format!("x{i}"), "…"));
        }
        assert_eq!(rt.attach().len(), PENDING_LIMIT);
    }

    #[test]
    fn message_ids_stay_strings_because_wechat_ids_exceed_js_safe_integers() {
        let raw = json!({"message_id": 7516059584577459123i64, "message_type": 1, "from_user_id": "u@im.wechat", "to_user_id": "b@im.bot",
            "context_token": "t", "item_list": [{"type": 1, "text_item": {"text": "/帮助"}}]});
        let parsed = parse_inbound(&raw, "u@im.wechat").unwrap();
        assert_eq!(parsed.message_id, "7516059584577459123");
        assert_eq!(serde_json::to_value(&parsed).unwrap()["messageId"], "7516059584577459123");
    }
}
