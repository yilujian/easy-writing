use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

mod window_state;

const MAIN_WINDOW_LABEL: &str = "main";
/// 主窗口关闭兜底超时：前端 onCloseRequested 正常会自行 destroy；
/// 超时后仍存在且页面已不在应用内（JS 已失联）才强制销毁。
const MAIN_WINDOW_CLOSE_TIMEOUT_SECS: u64 = 8;
/// tauri.conf.json build.devUrl 端口
const DEV_SERVER_PORT: u16 = 4414;

const WEBVIEW_DEFAULT_TITLE: &str = "网页查看";
const WEBVIEW_DEFAULT_WIDTH: f64 = 1100.0;
const WEBVIEW_DEFAULT_HEIGHT: f64 = 800.0;
const WEBVIEW_MIN_WIDTH: f64 = 900.0;
const WEBVIEW_MIN_HEIGHT: f64 = 640.0;
#[cfg(target_os = "macos")]
const MENU_RELOAD: &str = "ew_menu_reload";
#[cfg(all(target_os = "macos", debug_assertions))]
const MENU_DEVTOOLS: &str = "ew_menu_devtools";
#[cfg(target_os = "macos")]
const MENU_FEEDBACK: &str = "ew_menu_feedback";

type DesktopAppHandle = tauri::AppHandle<tauri::Wry>;
type DesktopWebviewWindow = tauri::WebviewWindow<tauri::Wry>;

fn app_display_name(app: &DesktopAppHandle) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone())
}

#[tauri::command]
fn write_export_file(file_path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(file_path, bytes).map_err(|error| error.to_string())
}

/// 追加式写入取证日志。
///
/// 丢稿类问题事后最难回答的就是"到底写没写进去"，这里为每次章节落盘留一行。
/// 超过 max_bytes 轮转一份 .1，只保留两代，避免长期占盘。
#[tauri::command]
fn append_app_log(file_path: String, content: String, max_bytes: u64) -> Result<(), String> {
    use std::io::Write;

    let path = PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if max_bytes > 0 {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= max_bytes {
                // 轮转失败不阻断写入：日志是辅助能力，丢一代也比写不进去强。
                let _ = std::fs::rename(&path, path.with_extension("log.1"));
            }
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterBackupPayload {
    backup_dir: Option<String>,
    book_id: String,
    book_title: String,
    volume_id: Option<String>,
    volume_title: Option<String>,
    chapter_id: i64,
    chapter_title: String,
    text_content: String,
    content_json: serde_json::Value,
    local_version: i64,
    remote_version: i64,
    updated_at: i64,
    backup_at: i64,
    file_stem: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChapterBackupResult {
    dir_path: String,
    txt_path: String,
    json_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChapterBackupBatchItem {
    chapter_id: i64,
    dir_path: String,
    txt_path: String,
    json_path: String,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceBackupPayload {
    backup_dir: Option<String>,
    book_id: String,
    book_title: String,
    file_stem: String,
    /// 前端已序列化好的 JSON 文本，这里只负责落盘
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceBackupBatchItem {
    book_id: String,
    dir_path: String,
    json_path: String,
    error: Option<String>,
}

fn home_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let raw = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));

    #[cfg(not(target_os = "windows"))]
    let raw = std::env::var_os("HOME");

    raw.map(PathBuf::from)
        .ok_or_else(|| "无法获取用户主目录".to_string())
}

fn default_backup_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Documents").join("易创备份"))
}

fn sanitize_segment(value: &str, fallback: &str) -> String {
    let mut output = String::new();
    for ch in value.trim().chars() {
        let illegal =
            matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control();
        output.push(if illegal { '_' } else { ch });
    }

    let output = output
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(&[' ', '.'][..])
        .to_string();

    let output = if output.is_empty() {
        fallback.to_string()
    } else {
        output
    };

    output.chars().take(80).collect()
}

fn resolve_backup_dir(backup_dir: Option<String>) -> Result<PathBuf, String> {
    let value = backup_dir.unwrap_or_default();
    if value.trim().is_empty() {
        return default_backup_path();
    }
    Ok(PathBuf::from(value))
}

fn normalize_external_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("链接不能为空".to_string());
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err("链接包含非法字符".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|_| "链接地址无效".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("仅支持打开 http/https 链接".to_string());
    }
    Ok(parsed.to_string())
}

fn build_webview_label(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("webview-{:x}", hasher.finish())
}

fn normalize_window_title(title: Option<String>) -> String {
    title
        .unwrap_or_default()
        .trim()
        .chars()
        .take(60)
        .collect::<String>()
        .trim()
        .to_string()
}

fn create_external_webview_window(
    app: &DesktopAppHandle,
    target: &str,
    title: Option<String>,
    features: Option<NewWindowFeatures>,
) -> Result<DesktopWebviewWindow, String> {
    let target = normalize_external_url(target)?;
    let parsed = Url::parse(&target).map_err(|_| "链接地址无效".to_string())?;
    let label = build_webview_label(&target);

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(window);
    }

    let window_title = match normalize_window_title(title) {
        value if value.is_empty() => WEBVIEW_DEFAULT_TITLE.to_string(),
        value => value,
    };

    let app_for_new_window = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(window_title)
        .inner_size(WEBVIEW_DEFAULT_WIDTH, WEBVIEW_DEFAULT_HEIGHT)
        .min_inner_size(WEBVIEW_MIN_WIDTH, WEBVIEW_MIN_HEIGHT)
        .resizable(true)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_new_window(move |url, features| {
            #[cfg(target_os = "windows")]
            {
                let _ = (&app_for_new_window, url, features);
                // Windows WebView2 不在新窗口回调里同步创建 WebView，避免阻塞窗口消息循环。
                NewWindowResponse::Deny
            }

            #[cfg(not(target_os = "windows"))]
            {
                let target = url.to_string();
                let label = build_webview_label(&target);
                if let Some(window) = app_for_new_window.get_webview_window(&label) {
                    let _ = window.set_focus();
                    return NewWindowResponse::Deny;
                }

                match create_external_webview_window(
                    &app_for_new_window,
                    &target,
                    Some(url.as_str().to_string()),
                    Some(features),
                ) {
                    Ok(window) => NewWindowResponse::Create { window },
                    Err(_) => NewWindowResponse::Deny,
                }
            }
        });

    if let Some(features) = features {
        #[cfg(target_os = "macos")]
        {
            builder =
                builder.with_webview_configuration(features.opener().target_configuration.clone());
        }
        builder = builder.window_features(features);
    }

    builder.build().map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_in_app_browser(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
) -> Result<(), String> {
    let window = create_external_webview_window(&app, &url, title, None)?;
    window.set_focus().map_err(|error| error.to_string())
}

fn prune_backups_in_dir(chapter_dir: &Path, retention: usize) -> Result<usize, String> {
    if retention == 0 || !chapter_dir.exists() {
        return Ok(0);
    }

    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let entries = std::fs::read_dir(chapter_dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|item| item.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension != "txt" && extension != "json" {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|item| item.to_str()) {
            groups.entry(stem.to_string()).or_default().push(path);
        }
    }

    let mut stems = groups.keys().cloned().collect::<Vec<_>>();
    stems.sort_by(|a, b| b.cmp(a));

    let mut removed = 0usize;
    for stem in stems.into_iter().skip(retention) {
        if let Some(paths) = groups.remove(&stem) {
            for path in paths {
                if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

#[tauri::command]
fn get_default_backup_dir() -> Result<String, String> {
    Ok(default_backup_path()?.to_string_lossy().to_string())
}

#[tauri::command]
fn write_chapter_backup(payload: ChapterBackupPayload) -> Result<ChapterBackupResult, String> {
    let base_dir = resolve_backup_dir(payload.backup_dir.clone())?;
    let book_dir = sanitize_segment(
        &format!("{}_{}", payload.book_title, payload.book_id),
        "未命名作品",
    );
    let volume_id = payload.volume_id.unwrap_or_else(|| "0".to_string());
    let volume_title = payload
        .volume_title
        .unwrap_or_else(|| "默认分卷".to_string());
    let volume_dir = sanitize_segment(&format!("{}_{}", volume_title, volume_id), "默认分卷");
    let chapter_dir_name = sanitize_segment(
        &format!("{}_{}", payload.chapter_title, payload.chapter_id),
        "未命名章节",
    );
    let chapter_dir = base_dir
        .join(book_dir)
        .join(volume_dir)
        .join(chapter_dir_name);

    std::fs::create_dir_all(&chapter_dir).map_err(|error| error.to_string())?;

    let file_stem = sanitize_segment(&payload.file_stem, "backup");
    let txt_path = chapter_dir.join(format!("{}.txt", file_stem));
    let json_path = chapter_dir.join(format!("{}.json", file_stem));

    std::fs::write(&txt_path, payload.text_content.as_bytes())
        .map_err(|error| error.to_string())?;

    let json_payload = json!({
      "bookId": payload.book_id,
      "volumeId": volume_id,
      "chapterId": payload.chapter_id,
      "title": payload.chapter_title,
      "textContent": payload.text_content,
      "contentJson": payload.content_json,
      "localVersion": payload.local_version,
      "remoteVersion": payload.remote_version,
      "updatedAt": payload.updated_at,
      "backupAt": payload.backup_at,
    });
    let json_text =
        serde_json::to_string_pretty(&json_payload).map_err(|error| error.to_string())?;
    std::fs::write(&json_path, json_text.as_bytes()).map_err(|error| error.to_string())?;

    Ok(ChapterBackupResult {
        dir_path: chapter_dir.to_string_lossy().to_string(),
        txt_path: txt_path.to_string_lossy().to_string(),
        json_path: json_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn prune_chapter_backups(chapter_dir: String, retention: usize) -> Result<usize, String> {
    prune_backups_in_dir(Path::new(&chapter_dir), retention)
}

/// 批量备份：一次 IPC 写全部章节并按目录去重清理，
/// 替代前端每章 2 次 invoke 的串行往返（退出备份的 IPC 开销从 C×2 降到 1）。
/// 单章失败不中断整批，错误随该章结果返回。
#[tauri::command]
fn write_chapter_backups(
    payloads: Vec<ChapterBackupPayload>,
    retention: usize,
) -> Vec<ChapterBackupBatchItem> {
    let mut pruned_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    payloads
        .into_iter()
        .map(|payload| {
            let chapter_id = payload.chapter_id;
            match write_chapter_backup(payload) {
                Ok(result) => {
                    if pruned_dirs.insert(result.dir_path.clone()) {
                        let _ = prune_backups_in_dir(Path::new(&result.dir_path), retention);
                    }
                    ChapterBackupBatchItem {
                        chapter_id,
                        dir_path: result.dir_path,
                        txt_path: result.txt_path,
                        json_path: result.json_path,
                        error: None,
                    }
                }
                Err(error) => ChapterBackupBatchItem {
                    chapter_id,
                    dir_path: String::new(),
                    txt_path: String::new(),
                    json_path: String::new(),
                    error: Some(error),
                },
            }
        })
        .collect()
}

fn write_reference_backup(payload: &ReferenceBackupPayload) -> Result<(String, String), String> {
    let base_dir = resolve_backup_dir(payload.backup_dir.clone())?;
    let book_dir = sanitize_segment(
        &format!("{}_{}", payload.book_title, payload.book_id),
        "未命名作品",
    );
    let reference_dir = base_dir.join(book_dir).join("参考数据");
    std::fs::create_dir_all(&reference_dir).map_err(|error| error.to_string())?;

    let file_stem = sanitize_segment(&payload.file_stem, "backup");
    let json_path = reference_dir.join(format!("{}.json", file_stem));
    std::fs::write(&json_path, payload.content.as_bytes()).map_err(|error| error.to_string())?;

    Ok((
        reference_dir.to_string_lossy().to_string(),
        json_path.to_string_lossy().to_string(),
    ))
}

/// 参考数据（大纲/角色/设定/时间线/故事线）按书整包备份：
/// 每书一个 参考数据/ 目录，文件按时间戳命名，与章节备份共用保留份数清理。
#[tauri::command]
fn write_reference_backups(
    payloads: Vec<ReferenceBackupPayload>,
    retention: usize,
) -> Vec<ReferenceBackupBatchItem> {
    payloads
        .into_iter()
        .map(|payload| match write_reference_backup(&payload) {
            Ok((dir_path, json_path)) => {
                let _ = prune_backups_in_dir(Path::new(&dir_path), retention);
                ReferenceBackupBatchItem {
                    book_id: payload.book_id,
                    dir_path,
                    json_path,
                    error: None,
                }
            }
            Err(error) => ReferenceBackupBatchItem {
                book_id: payload.book_id,
                dir_path: String::new(),
                json_path: String::new(),
                error: Some(error),
            },
        })
        .collect()
}

#[tauri::command]
fn open_backup_dir(path: String) -> Result<(), String> {
    let target = if path.trim().is_empty() {
        default_backup_path()?
    } else {
        PathBuf::from(path)
    };
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&target);
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let target = normalize_external_url(&url)?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(target);
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_devtools(_window: DesktopWebviewWindow) {
    #[cfg(debug_assertions)]
    {
        if _window.is_devtools_open() {
            _window.close_devtools();
        } else {
            _window.open_devtools();
        }
    }
}

#[tauri::command]
fn restart_app(app: DesktopAppHandle) {
    app.request_restart();
}

// ---------------------------------------------------------------------------
// 提示词 md 文件：全部 AI 提示词存在 Documents/易创提示词/，
// 设置中心可视化编辑与用户直接改文件双向同步（启动时读入，保存时写回）。
// ---------------------------------------------------------------------------

fn prompt_dir_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Documents").join("易创提示词"))
}

fn ensure_prompt_dir() -> Result<PathBuf, String> {
    let dir = prompt_dir_path()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    Ok(dir)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptDocument {
    file_name: String,
    content: String,
}

#[tauri::command]
fn get_prompt_dir() -> Result<String, String> {
    Ok(ensure_prompt_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
fn list_prompt_documents() -> Result<Vec<PromptDocument>, String> {
    let dir = ensure_prompt_dir()?;
    let mut documents = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_md = path
            .extension()
            .and_then(|item| item.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        let file_name = match path.file_name().and_then(|item| item.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        // 单文件容错：某个 md 读不出来（编码/占用）跳过，不挡整个目录
        if let Ok(content) = std::fs::read_to_string(&path) {
            documents.push(PromptDocument { file_name, content });
        }
    }
    Ok(documents)
}

/// 启动时只创建缺失文件，不能覆盖无法读取或 ID 损坏的用户文件。
#[tauri::command]
fn ensure_prompt_document(file_name: String, content: String) -> Result<bool, String> {
    use std::io::Write;
    let safe_name = sanitize_segment(&file_name, "提示词");
    if !safe_name.to_ascii_lowercase().ends_with(".md") { return Err("提示词文件必须是 .md".to_string()); }
    let path = ensure_prompt_dir()?.join(safe_name);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => { file.write_all(content.as_bytes()).map_err(|error| error.to_string())?; Ok(true) },
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn write_prompt_document(file_name: String, content: String) -> Result<(), String> {
    let safe_name = sanitize_segment(&file_name, "提示词");
    if !safe_name.to_ascii_lowercase().ends_with(".md") {
        return Err("提示词文件必须是 .md".to_string());
    }
    let dir = ensure_prompt_dir()?;
    std::fs::write(dir.join(safe_name), content).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_prompt_dir() -> Result<(), String> {
    let dir = ensure_prompt_dir()?;

    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&dir);
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 榜单隐藏抓取窗口：加载真实网页过反爬（起点 probe.js、番茄懒加载），
// 注入脚本等目标选择器出现、按需滚动，然后把 HTML 通过事件发回。
// 权限面收在 capabilities/rank-crawl.json：抓取窗口只被授予 event:emit。
// ---------------------------------------------------------------------------

/// 允许抓取的站点（与前端 rank-sources 配置对应；防止该命令被用来打开任意网页）
const RANK_CRAWL_ALLOWED_HOSTS: &[&str] = &[
    "fanqienovel.com",
    "www.qidian.com",
    "qidian.com",
    "www.qdmm.com",
    "qdmm.com",
    "www.qimao.com",
    "qimao.com",
];
const RANK_CRAWL_DEFAULT_TIMEOUT_MS: u64 = 60_000;
const RANK_CRAWL_MAX_TIMEOUT_MS: u64 = 180_000;
const RANK_CRAWL_MAX_SCROLL_ROUNDS: u32 = 40;

static RANK_CRAWL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankCrawlRequest {
    url: String,
    /// 页面就绪的标志选择器（出现即认为反爬已过、内容已渲染）
    wait_selector: String,
    /// 懒加载滚动轮数；0 = 不滚动（选择器出现即取 HTML）
    #[serde(default)]
    scroll_rounds: u32,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RankCrawlEmitPayload {
    html: Option<String>,
    error: Option<String>,
}

fn build_rank_crawl_script(wait_selector: &str, scroll_rounds: u32, event_name: &str) -> String {
    // 选择器/事件名经 serde_json 转成 JS 字符串字面量，杜绝注入
    let selector_json = serde_json::to_string(wait_selector).unwrap_or_else(|_| "\"body\"".into());
    let event_json = serde_json::to_string(event_name).unwrap_or_else(|_| "\"\"".into());
    // 该脚本在抓取窗口每次导航后都会执行（probe.js 跳转回真实页面时会再跑一遍）。
    // 通过 __TAURI_INTERNALS__ 走 plugin:event|emit（等价 @tauri-apps/api event.emit），
    // 抓取窗口的能力清单只放行了这一个操作。
    format!(
        r#"(function () {{
  if (window.__EW_RANK_CRAWL__) return;
  window.__EW_RANK_CRAWL__ = true;
  var SELECTOR = {selector_json};
  var SCROLL_ROUNDS = {scroll_rounds};
  var EVENT = {event_json};
  var send = function (payload) {{
    try {{
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event: EVENT, payload: payload }});
    }} catch (e) {{ /* 事件通道不可用时由 Rust 侧超时兜底 */ }}
  }};
  var finish = function () {{
    send({{ html: document.documentElement.outerHTML }});
  }};
  var scrollRoundsLeft = SCROLL_ROUNDS;
  var lastCount = -1;
  var stable = 0;
  var countItems = function () {{
    try {{ return document.querySelectorAll(SELECTOR).length; }} catch (e) {{ return 0; }}
  }};
  var scrollLoop = function () {{
    if (scrollRoundsLeft <= 0 || stable >= 2) {{ finish(); return; }}
    scrollRoundsLeft -= 1;
    var before = countItems();
    window.scrollBy(0, Math.max(1200, window.innerHeight * 2));
    setTimeout(function () {{
      var after = countItems();
      if (after <= before && after === lastCount) stable += 1; else stable = 0;
      lastCount = after;
      scrollLoop();
    }}, 800 + Math.floor(Math.random() * 400));
  }};
  var waitTimer = setInterval(function () {{
    var found = false;
    try {{ found = !!document.querySelector(SELECTOR); }} catch (e) {{ found = false; }}
    if (!found) return;
    clearInterval(waitTimer);
    // 就绪后稍等一拍，让首屏数据渲染完整
    setTimeout(function () {{
      if (SCROLL_ROUNDS > 0) scrollLoop(); else finish();
    }}, 600);
  }}, 500);
}})();"#
    )
}

#[tauri::command]
async fn rank_crawl_render_page(
    app: DesktopAppHandle,
    request: RankCrawlRequest,
) -> Result<String, String> {
    let parsed = Url::parse(&request.url).map_err(|_| "抓取地址无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("榜单抓取仅支持 https 地址".to_string());
    }
    let host = parsed
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !RANK_CRAWL_ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("不支持抓取的站点：{host}"));
    }
    if request.wait_selector.trim().is_empty() {
        return Err("缺少页面就绪选择器".to_string());
    }

    let seq = RANK_CRAWL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("rank-crawl-{seq}");
    let event_name = format!("rank-crawl-result-{seq}");
    let scroll_rounds = request.scroll_rounds.min(RANK_CRAWL_MAX_SCROLL_ROUNDS);
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(RANK_CRAWL_DEFAULT_TIMEOUT_MS)
        .min(RANK_CRAWL_MAX_TIMEOUT_MS)
        .max(5_000);
    let script = build_rank_crawl_script(&request.wait_selector, scroll_rounds, &event_name);

    let (sender, receiver) = tauri::async_runtime::channel::<String>(1);
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    let sender_for_listener = sender.clone();
    let listener_id = {
        use tauri::Listener;
        app.listen(event_name.clone(), move |event| {
            if let Some(tx) = sender_for_listener.lock().ok().and_then(|mut it| it.take()) {
                let _ = tx.try_send(event.payload().to_string());
            }
        })
    };

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title("榜单抓取")
        .inner_size(1280.0, 900.0)
        .visible(false)
        .skip_taskbar(true)
        .initialization_script(&script)
        .build()
        .map_err(|error| {
            use tauri::Listener;
            app.unlisten(listener_id);
            format!("创建抓取窗口失败：{error}")
        })?;

    let mut receiver = receiver;
    let outcome = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        receiver.recv(),
    )
    .await;

    {
        use tauri::Listener;
        app.unlisten(listener_id);
    }
    let _ = window.destroy();

    let payload_text = match outcome {
        Ok(Some(payload)) => payload,
        _ => {
            return Err("榜单页面加载超时（可能被站点限制或网络不稳），稍后再试".to_string());
        }
    };
    let payload: RankCrawlEmitPayload = serde_json::from_str(&payload_text)
        .map_err(|_| "抓取窗口返回的数据无法解析".to_string())?;
    if let Some(error) = payload.error.filter(|text| !text.trim().is_empty()) {
        return Err(error);
    }
    match payload.html {
        Some(html) if !html.trim().is_empty() => Ok(html),
        _ => Err("抓取窗口没有返回页面内容".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn build_app_menu(app: &DesktopAppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_name = app_display_name(app);
    let about_metadata = AboutMetadata {
        name: Some(app_name.clone()),
        version: Some(app.package_info().version.to_string()),
        authors: Some(vec!["Yichuang".to_string()]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        &app_name,
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some(&format!("关于{app_name}")),
                Some(about_metadata),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("隐藏{app_name}")))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("显示全部"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&format!("退出{app_name}")))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &MenuItem::with_id(app, MENU_RELOAD, "重新加载", true, Some("CmdOrCtrl+R"))?,
            #[cfg(debug_assertions)]
            &MenuItem::with_id(
                app,
                MENU_DEVTOOLS,
                "开发者工具",
                true,
                Some("CmdOrCtrl+Shift+I"),
            )?,
            #[cfg(debug_assertions)]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?,
        ],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "帮助",
        true,
        &[&MenuItem::with_id(
            app,
            MENU_FEEDBACK,
            "问题反馈",
            true,
            None::<&str>,
        )?],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

#[cfg(target_os = "macos")]
fn handle_menu_event(app: &DesktopAppHandle, event: tauri::menu::MenuEvent) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    match event.id().as_ref() {
        MENU_RELOAD => {
            let _ = window.reload();
        }
        #[cfg(debug_assertions)]
        MENU_DEVTOOLS => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        MENU_FEEDBACK => {
            // 通过 History API 触发前端路由，避免生产包直接请求 /feedback 资源。
            let _ = window.eval(
                "window.history.pushState({}, '', '/feedback'); window.dispatchEvent(new PopStateEvent('popstate'));",
            );
        }
        _ => {}
    }
}

/// 主窗口是否仍停留在应用自身页面。
/// 放行：tauri://localhost（macOS 生产）、http(s)://tauri.localhost（Windows 生产）、
/// dev 构建下的 devUrl http://localhost:4414。
fn is_app_shell_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            if host == "tauri.localhost" {
                return true;
            }
            cfg!(dev)
                && (host == "localhost" || host == "127.0.0.1")
                && url.port() == Some(DEV_SERVER_PORT)
        }
        _ => false,
    }
}

/// 主窗口改为代码创建（原在 tauri.conf.json windows 段声明）：
/// 配置声明的窗口挂不了 on_navigation，无法阻止主 webview 被外链顶级导航接管
/// （如 a[download] 跨域退化为导航），导航走后前端 JS 全灭、关窗握手失效。
fn build_main_window(app: &DesktopAppHandle) -> tauri::Result<DesktopWebviewWindow> {
    let app_name = app_display_name(app);
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::default())
        .title(&app_name)
        .inner_size(1440.0, 960.0)
        .min_inner_size(window_state::MIN_WIDTH, window_state::MIN_HEIGHT)
        .center()
        .visible(false)
        .shadow(true)
        // 对应原配置 dragDropEnabled: false
        .disable_drag_drop_handler()
        // 导航守卫：主 webview 只允许停留在应用页面，外部链接一律拒绝（外链走 open_external_url/open_in_app_browser）
        .on_navigation(|url| is_app_shell_url(url));

    // 对应原配置 decorations/titleBarStyle: Overlay/hiddenTitle/trafficLightPosition（红绿灯内嵌标题栏）
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 24.0));

    // Windows 无边框 + 阴影（前端自绘标题栏），等价于原 setup 里的 set_decorations(false) + set_shadow(true)
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);

    let window = builder.build()?;
    window_state::restore(&window);
    Ok(window)
}

/// 关窗超时兜底：CloseRequested 后前端正常路径（备份→destroy）会自行关窗；
/// 若主 webview 已被导航走（JS 失联），Rust 核心因“存在 JS 关闭监听器”会永远 prevent_close，
/// 此时超时强制 destroy，避免窗口只能强杀进程。
fn schedule_main_window_close_fallback(window: &tauri::Window) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            MAIN_WINDOW_CLOSE_TIMEOUT_SECS,
        ))
        .await;
        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            // 窗口已正常销毁
            return;
        };
        // 页面仍在应用内：前端关闭流程（备份、失败确认弹窗）还在推进，交给前端 destroy，不强杀
        if matches!(window.url(), Ok(url) if is_app_shell_url(&url)) {
            return;
        }
        let _ = window.destroy();
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // 必须最先注册：第二个实例要在做任何初始化（尤其是打开 SQLite）之前就退出。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(window_state::plugin())
        .setup(|app| {
            build_main_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                window_state::save_before_close(window);
                schedule_main_window_close_fallback(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            write_export_file,
            append_app_log,
            get_default_backup_dir,
            write_chapter_backup,
            write_chapter_backups,
            write_reference_backups,
            prune_chapter_backups,
            open_backup_dir,
            open_in_app_browser,
            open_external_url,
            toggle_devtools,
            restart_app,
            rank_crawl_render_page,
            get_prompt_dir,
            list_prompt_documents,
            ensure_prompt_document,
            write_prompt_document,
            open_prompt_dir,
        ]);

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_backup_dir(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        std::env::temp_dir().join(format!("ew-writing-backup-test-{}-{}", name, timestamp))
    }

    fn backup_payload(base_dir: &Path, title: &str, stem: &str) -> ChapterBackupPayload {
        ChapterBackupPayload {
            backup_dir: Some(base_dir.to_string_lossy().to_string()),
            book_id: "12".to_string(),
            book_title: "测试作品".to_string(),
            volume_id: Some("3".to_string()),
            volume_title: "第一卷".to_string().into(),
            chapter_id: 45,
            chapter_title: title.to_string(),
            text_content: "第一段正文\n第二段正文".to_string(),
            content_json: json!({ "type": "doc", "content": [] }),
            local_version: 7,
            remote_version: 6,
            updated_at: 1_768_369_000_000,
            backup_at: 1_768_369_001_000,
            file_stem: stem.to_string(),
        }
    }

    #[test]
    fn write_backup_creates_txt_and_json_files() {
        let base_dir = temp_backup_dir("write");
        let result = write_chapter_backup(backup_payload(
            &base_dir,
            "第1章:非法/字符?",
            "20260514-213011-v7",
        ))
        .expect("backup should be written");

        let txt = std::fs::read_to_string(&result.txt_path).expect("txt file should exist");
        let json_text = std::fs::read_to_string(&result.json_path).expect("json file should exist");
        let json_value: serde_json::Value =
            serde_json::from_str(&json_text).expect("json should parse");

        assert_eq!(txt, "第一段正文\n第二段正文");
        assert_eq!(json_value["bookId"], "12");
        assert_eq!(json_value["chapterId"], 45);
        assert_eq!(json_value["localVersion"], 7);
        assert!(result.dir_path.contains("第1章_非法_字符"));
        assert!(result.dir_path.contains("_45"));

        std::fs::remove_dir_all(base_dir).ok();
    }

    #[test]
    fn prune_backup_keeps_latest_backup_groups() {
        let base_dir = temp_backup_dir("prune");
        let first = write_chapter_backup(backup_payload(&base_dir, "第1章", "20260514-213011-v1"))
            .expect("first backup should be written");
        let second = write_chapter_backup(backup_payload(&base_dir, "第1章", "20260514-213012-v2"))
            .expect("second backup should be written");
        let third = write_chapter_backup(backup_payload(&base_dir, "第1章", "20260514-213013-v3"))
            .expect("third backup should be written");

        let removed = prune_chapter_backups(third.dir_path.clone(), 2).expect("prune should work");
        assert_eq!(removed, 2);
        assert!(!Path::new(&first.txt_path).exists());
        assert!(!Path::new(&first.json_path).exists());
        assert!(Path::new(&second.txt_path).exists());
        assert!(Path::new(&second.json_path).exists());
        assert!(Path::new(&third.txt_path).exists());
        assert!(Path::new(&third.json_path).exists());

        std::fs::remove_dir_all(base_dir).ok();
    }

    #[test]
    fn normalize_external_url_accepts_only_http_links() {
        assert_eq!(
            normalize_external_url(" https://www.lkong.com/ ").unwrap(),
            "https://www.lkong.com/"
        );
        assert_eq!(
            normalize_external_url("https://example.com").unwrap(),
            "https://example.com/"
        );
        assert!(normalize_external_url("javascript:alert(1)").is_err());
        assert!(normalize_external_url("file:///tmp/a.txt").is_err());
        assert!(normalize_external_url("https://").is_err());
        assert!(normalize_external_url("https://example.com/\nnext").is_err());
    }

    #[test]
    fn app_shell_url_only_allows_app_origins() {
        assert!(is_app_shell_url(
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(is_app_shell_url(
            &Url::parse("http://tauri.localhost/").unwrap()
        ));
        assert!(is_app_shell_url(
            &Url::parse("https://tauri.localhost/home").unwrap()
        ));
        // dev server 仅在 dev 构建放行
        assert_eq!(
            is_app_shell_url(&Url::parse("http://localhost:4414/").unwrap()),
            cfg!(dev)
        );
        assert!(!is_app_shell_url(
            &Url::parse("https://p1-tt.byteimg.com/origin/novel-static/xxx").unwrap()
        ));
        assert!(!is_app_shell_url(
            &Url::parse("https://example.com/").unwrap()
        ));
        assert!(!is_app_shell_url(&Url::parse("data:text/html,hi").unwrap()));
        assert!(!is_app_shell_url(
            &Url::parse("http://localhost:9999/").unwrap()
        ));
    }

    #[test]
    fn build_webview_label_is_scoped_by_url() {
        let first = build_webview_label("https://www.lkong.com/");
        let second = build_webview_label("https://www.lkong.com/");
        let third = build_webview_label("https://example.com/");

        assert_eq!(first, second);
        assert_ne!(first, third);
        assert!(first.starts_with("webview-"));
    }
}
