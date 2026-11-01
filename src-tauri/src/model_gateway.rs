//! 模型网关：全平台唯一的模型出口。
//!
//! 只监听本机，端口随机，带一次性口令。调用方（Agent worker、宿主后台任务）把请求发到
//! `http://127.0.0.1:<port>/v1/chat/completions`，`model` 字段填模型管理里的记录编号；
//! 网关从模型设置里取供应商地址与 Key，按供应商差异表改写请求，转发并原样回传（含流式），
//! 每次调用写一条轨迹账本，供应商的失败翻译成中文并保留原始状态码。
//! Key 只在这里出现；worker 的载荷、检查点、日志里都没有它。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};
use sqlx::Connection;

use crate::ai_trace::{self, AiCallRecord};
use crate::model_gateway_providers::{self as providers, ModelProfile};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// 分片间空闲上限：连接挂起时主动断开，避免调用方永远"生成中"
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// 连接失败、429、5xx 在未开始回传前重试；回退链等模型分组有界面后再接
const MAX_ATTEMPTS: u32 = 3;
const BACKOFF: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(1500)];
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = BoxBody<Bytes, BoxError>;

/// 调用方拿到的只有这两样
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub token: String,
}

struct State {
    root: PathBuf,
    token: String,
}

static GATEWAYS: OnceLock<Mutex<HashMap<PathBuf, Endpoint>>> = OnceLock::new();
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(IDLE_TIMEOUT)
            .build()
            .expect("模型网关的 HTTP 客户端初始化失败")
    })
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// 某个数据目录对应的网关；没有就起一个。应用只有一个目录，测试夹具各起各的。
pub fn endpoint(root: &Path) -> Result<Endpoint, String> {
    let root = root.to_path_buf();
    let mut gateways = GATEWAYS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "模型网关状态被污染".to_string())?;
    if let Some(existing) = gateways.get(&root) {
        return Ok(existing.clone());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(err)?;
    listener.set_nonblocking(true).map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let token = random_token();
    let endpoint = Endpoint {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        token: token.clone(),
    };
    let state = Arc::new(State {
        root: root.clone(),
        token,
    });
    tauri::async_runtime::spawn(async move { serve(listener, state).await });
    gateways.insert(root, endpoint.clone());
    Ok(endpoint)
}


/// 场景码只在 HTTP 头里走 ASCII；中文标签在这里配
fn scene_label(scene: &str) -> &'static str {
    match scene {
        "agent_planner" => "Agent 规划",
        "agent_writer" => "Agent 写作",
        "agent_critic" => "Agent 评审",
        "agent_indexer" => "Agent 索引",
        _ => "Agent",
    }
}

async fn serve(listener: std::net::TcpListener, state: Arc<State>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        return;
    };
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            let service = service_fn(move |req| handle(state.clone(), req));
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

fn json_error(status: StatusCode, message: &str) -> Response<Body> {
    let body =
        json!({"error": {"message": message, "type": "gateway_error", "code": status.as_u16()}});
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(full(body.to_string()))
        .expect("错误响应构造失败")
}

async fn handle(state: Arc<State>, req: Request<Incoming>) -> Result<Response<Body>, BoxError> {
    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.strip_prefix("Bearer ").is_some_and(|t| t == state.token));
    if !authorized {
        return Ok(json_error(StatusCode::UNAUTHORIZED, "模型网关口令无效"));
    }
    let path = req.uri().path().to_owned();
    if req.method() != hyper::Method::POST || path != "/v1/chat/completions" {
        return Ok(json_error(
            StatusCode::NOT_FOUND,
            "模型网关只提供 /v1/chat/completions",
        ));
    }
    let scene = req
        .headers()
        .get("x-ew-scene")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("agent")
        .to_owned();
    let max_attempts = req
        .headers()
        .get("x-ew-max-attempts")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(MAX_ATTEMPTS)
        .clamp(1, MAX_ATTEMPTS);
    let bytes = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(e) => {
            return Ok(json_error(
                StatusCode::BAD_REQUEST,
                &format!("读取请求失败：{e}"),
            ))
        }
    };
    if bytes.len() > MAX_REQUEST_BYTES {
        return Ok(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "请求超过网关上限",
        ));
    }
    let body: Map<String, Value> = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => map,
        _ => return Ok(json_error(StatusCode::BAD_REQUEST, "请求不是 JSON 对象")),
    };
    Ok(proxy_chat(&state, &scene, body, max_attempts).await)
}

async fn resolve_profile(root: &Path, model_ref: &str) -> Result<ModelProfile, String> {
    let mut db = crate::desktop_storage::connect_existing_at(root).await?;
    let model = crate::writing_service::model_config(&mut db, model_ref, "agent_planner").await?;
    let _ = db.close().await;
    Ok(ModelProfile::from_record(&model))
}

/// 账本里的输入预览：按消息拼成文字，工具调用写成 `[工具调用] name(args)`
fn messages_preview(messages: &Value) -> String {
    let Some(list) = messages.as_array() else {
        return String::new();
    };
    list.iter()
        .map(|m| {
            let mut parts = Vec::new();
            match &m["content"] {
                Value::String(s) if !s.is_empty() => parts.push(s.clone()),
                Value::Array(items) => parts.extend(
                    items
                        .iter()
                        .filter_map(|item| item["text"].as_str().map(str::to_owned)),
                ),
                _ => {}
            }
            if let Some(calls) = m["tool_calls"].as_array() {
                let summary: Vec<String> = calls
                    .iter()
                    .map(|c| {
                        format!(
                            "{}({})",
                            c["function"]["name"].as_str().unwrap_or(""),
                            c["function"]["arguments"].as_str().unwrap_or("")
                        )
                    })
                    .collect();
                if !summary.is_empty() {
                    parts.push(format!("[工具调用] {}", summary.join("；")));
                }
            }
            parts.join("\n")
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Default)]
struct Accumulator {
    content: String,
    tool_calls: HashMap<u64, (String, String)>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    pending: String,
}

impl Accumulator {
    fn absorb_message(&mut self, message: &Value) {
        if let Some(text) = message["content"].as_str() {
            self.content.push_str(text);
        }
        if let Some(calls) = message["tool_calls"].as_array() {
            for (position, call) in calls.iter().enumerate() {
                let index = call["index"].as_u64().unwrap_or(position as u64);
                let entry = self.tool_calls.entry(index).or_default();
                if let Some(name) = call["function"]["name"].as_str() {
                    if entry.0 != name {
                        entry.0.push_str(name);
                    }
                }
                if let Some(args) = call["function"]["arguments"].as_str() {
                    entry.1.push_str(args);
                }
            }
        }
    }

    fn absorb_usage(&mut self, usage: &Value) {
        if let Some(n) = usage["prompt_tokens"].as_u64() {
            self.prompt_tokens = Some(n);
        }
        if let Some(n) = usage["completion_tokens"].as_u64() {
            self.completion_tokens = Some(n);
        }
    }

    fn absorb_response(&mut self, body: &Value) {
        self.absorb_message(&body["choices"][0]["message"]);
        self.absorb_usage(&body["usage"]);
    }

    /// SSE 分片可能在任意位置截断，按行累积再解析
    fn absorb_stream_chunk(&mut self, chunk: &[u8]) {
        self.pending.push_str(&String::from_utf8_lossy(chunk));
        while let Some(end) = self.pending.find('\n') {
            let line = self.pending[..end].trim().to_owned();
            self.pending.drain(..=end);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<Value>(data) {
                self.absorb_message(&event["choices"][0]["delta"]);
                self.absorb_usage(&event["usage"]);
            }
        }
    }

    fn output(&self) -> String {
        let mut indices: Vec<&u64> = self.tool_calls.keys().collect();
        indices.sort();
        let calls: Vec<String> = indices
            .into_iter()
            .map(|i| &self.tool_calls[i])
            .filter(|(name, _)| !name.is_empty())
            .map(|(name, args)| format!("{name}({args})"))
            .collect();
        let mut out = self.content.clone();
        if !calls.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("[工具调用] {}", calls.join("；")));
        }
        out
    }
}

struct CallContext {
    root: PathBuf,
    scene: String,
    profile: ModelProfile,
    input: String,
    started: Instant,
}

impl CallContext {
    async fn record(&self, acc: &Accumulator, error: Option<String>) {
        let record = AiCallRecord {
            scene: self.scene.clone(),
            scene_label: scene_label(&self.scene).to_owned(),
            model_code: self.profile.id.clone(),
            model_name: if self.profile.name.is_empty() {
                self.profile.model_code.clone()
            } else {
                self.profile.name.clone()
            },
            ok: error.is_none(),
            input: self.input.clone(),
            output: acc.output(),
            input_tokens: acc.prompt_tokens,
            output_tokens: acc.completion_tokens,
            duration_ms: self.started.elapsed().as_millis() as u64,
            error,
        };
        if let Err(e) = ai_trace::record(&self.root, record).await {
            eprintln!("[model-gateway] 落账失败：{e}");
        }
    }
}

fn retryable_status(status: reqwest::StatusCode) -> bool {
    status.as_u16() == 429 || status.is_server_error()
}

fn network_message(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!(
            "模型服务无响应（{} 秒内没有数据），请检查网络或稍后重试",
            IDLE_TIMEOUT.as_secs()
        )
    } else if error.is_connect() {
        "连不上模型服务，请检查接口地址与网络".to_owned()
    } else {
        format!("网络请求失败：{error}")
    }
}

async fn send_with_retry(
    url: &str,
    profile: &ModelProfile,
    body: &Value,
    max_attempts: u32,
) -> Result<reqwest::Response, String> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut request = client()
            .post(url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(body);
        if !profile.api_key.is_empty() {
            request = request.bearer_auth(&profile.api_key);
        }
        match request.send().await {
            Ok(response) if retryable_status(response.status()) && attempt < max_attempts => {
                let _ = response.bytes().await;
            }
            Ok(response) => return Ok(response),
            Err(error)
                if attempt < max_attempts
                    && (error.is_connect() || error.is_timeout() || error.is_request()) => {}
            Err(error) => return Err(network_message(&error)),
        }
        tokio::time::sleep(BACKOFF[(attempt as usize - 1).min(BACKOFF.len() - 1)]).await;
    }
}

async fn proxy_chat(
    state: &State,
    scene: &str,
    mut body: Map<String, Value>,
    max_attempts: u32,
) -> Response<Body> {
    let model_ref = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let profile = match resolve_profile(&state.root, &model_ref).await {
        Ok(profile) => profile,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
    };
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let context = CallContext {
        root: state.root.clone(),
        scene: scene.to_owned(),
        input: messages_preview(body.get("messages").unwrap_or(&Value::Null)),
        profile,
        started: Instant::now(),
    };
    providers::adapt_request_for(&mut body, &context.profile, scene);
    let url = providers::join_url(&context.profile.base_url, "chat/completions");
    let upstream =
        match send_with_retry(&url, &context.profile, &Value::Object(body), max_attempts).await {
            Ok(response) => response,
            Err(message) => {
                context
                    .record(&Accumulator::default(), Some(message.clone()))
                    .await;
                return json_error(StatusCode::BAD_GATEWAY, &message);
            }
        };
    let status = upstream.status();
    if !status.is_success() {
        let text = upstream.text().await.unwrap_or_default();
        let message = providers::translate_status(status.as_u16(), &providers::error_detail(&text));
        context
            .record(&Accumulator::default(), Some(message.clone()))
            .await;
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return json_error(code, &message);
    }
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if stream {
            "text/event-stream"
        } else {
            "application/json"
        })
        .to_owned();
    if !stream {
        let bytes = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                let message = network_message(&error);
                context
                    .record(&Accumulator::default(), Some(message.clone()))
                    .await;
                return json_error(StatusCode::BAD_GATEWAY, &message);
            }
        };
        let mut acc = Accumulator::default();
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(parsed) if parsed["error"]["message"].is_string() => {
                let message = providers::translate_status(
                    status.as_u16(),
                    parsed["error"]["message"].as_str().unwrap_or(""),
                );
                context.record(&acc, Some(message.clone())).await;
                return json_error(StatusCode::BAD_GATEWAY, &message);
            }
            Ok(parsed) => acc.absorb_response(&parsed),
            Err(_) => {}
        }
        context.record(&acc, None).await;
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .body(full(bytes))
            .expect("响应构造失败");
    }
    // 流式：上游每到一片就原样转给调用方，同时在旁边累计正文与用量供落账
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Frame<Bytes>, BoxError>>(64);
    tauri::async_runtime::spawn(async move {
        let mut acc = Accumulator::default();
        let mut upstream = upstream.bytes_stream();
        let mut failure: Option<String> = None;
        while let Some(item) = upstream.next().await {
            match item {
                Ok(chunk) => {
                    acc.absorb_stream_chunk(&chunk);
                    if sender.send(Ok(Frame::data(chunk))).await.is_err() {
                        failure = Some("调用方已断开".into());
                        break;
                    }
                }
                Err(error) => {
                    failure = Some(network_message(&error));
                    break;
                }
            }
        }
        drop(sender);
        context.record(&acc, failure).await;
    });
    let body = StreamBody::new(futures_util::stream::unfold(
        receiver,
        |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
    ));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(BodyExt::boxed(body))
        .expect("响应构造失败")
}
