//! 桌宠只持有显示偏好和瞬时状态，不访问作品、模型凭据或执行 AI 任务。
use crate::{DesktopAppHandle, DesktopWebviewWindow, MAIN_WINDOW_LABEL};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "desktop-pet";
const EVENT: &str = "ew-desktop-pet-state";
const FILE: &str = "desktop-pet.json";
const PETS: [&str; 8] = [
    "cat",
    "fox",
    "girl",
    "dragon",
    "capybara",
    "robot",
    "mushroom",
    "booksmith",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    enabled: bool,
    character: String,
    size: u32,
    bubbles: bool,
    reduced_motion: bool,
    x: Option<i32>,
    y: Option<i32>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            character: "cat".into(),
            size: 200,
            bubbles: true,
            reduced_motion: false,
            x: None,
            y: None,
        }
    }
}
impl Preferences {
    fn validate(&self) -> Result<(), String> {
        if !PETS.contains(&self.character.as_str()) {
            return Err("未知桌宠形象".into());
        }
        if ![160, 200, 260].contains(&self.size) {
            return Err("桌宠大小无效".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct View {
    pub state: String,
    pub message: String,
    pub target: String,
    pub theme: String,
    pub quiet: bool,
}
impl Default for View {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            message: String::new(),
            target: String::new(),
            theme: "new".into(),
            quiet: false,
        }
    }
}
impl View {
    fn validate(&self) -> Result<(), String> {
        if !["idle", "typing", "thinking", "celebrate", "error"].contains(&self.state.as_str()) {
            return Err("桌宠状态无效".into());
        }
        if !["new", "yellow", "green", "dark"].contains(&self.theme.as_str()) {
            return Err("桌宠主题无效".into());
        }
        if self.message.chars().count() > 100 || self.target.len() > 512 {
            return Err("桌宠提示过长".into());
        }
        if !valid_target(&self.target) {
            return Err("桌宠跳转目标无效".into());
        }
        Ok(())
    }
}
fn valid_target(value: &str) -> bool {
    value.is_empty()
        || value == "settings"
        || value == "current"
        || value.starts_with("pi:")
        || value.starts_with("pi-session:")
        || value.starts_with("agent:")
        || (value.starts_with('/')
            && !value.starts_with("//")
            && !value.contains('\\')
            && !value.chars().any(char::is_control))
}

#[derive(Clone, Copy, Default, Deserialize)]
struct HitRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Default)]
struct Data {
    prefs: Preferences,
    view: View,
    hits: Vec<HitRect>,
    position_revision: u64,
    ready: bool,
}
#[derive(Default)]
pub struct DesktopPet(Mutex<Data>);

fn snapshot(app: &DesktopAppHandle) -> Result<Value, String> {
    let service = app.state::<DesktopPet>();
    let data = service.0.lock().map_err(|_| "桌宠状态不可用")?;
    Ok(json!({ "preferences": data.prefs, "view": data.view }))
}
fn broadcast(app: &DesktopAppHandle) {
    if let Ok(value) = snapshot(app) {
        let _ = app.emit_to(MAIN_WINDOW_LABEL, EVENT, &value);
        let _ = app.emit_to(LABEL, EVENT, &value);
    }
}
fn persist(app: &DesktopAppHandle, prefs: &Preferences) -> Result<(), String> {
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    // 先写临时文件，再替换；失败不覆盖已有可恢复配置。
    let temporary = root.join("desktop-pet.json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, root.join(FILE)).map_err(|e| e.to_string())
}
fn size(prefs: &Preferences) -> (f64, f64) {
    (f64::from(prefs.size) + 64.0, f64::from(prefs.size) + 100.0)
}

fn fit(window: &DesktopWebviewWindow, reset: bool) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let dimensions = window.outer_size().map_err(|e| e.to_string())?;
    let monitor = if reset {
        None
    } else {
        monitors
            .iter()
            .find(|m| {
                let a = m.work_area();
                pos.x >= a.position.x
                    && pos.y >= a.position.y
                    && pos.x < a.position.x + a.size.width as i32
                    && pos.y < a.position.y + a.size.height as i32
            })
            .cloned()
    }
    .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let a = m.work_area();
        let max_x = a.position.x + a.size.width.saturating_sub(dimensions.width) as i32;
        let max_y = a.position.y + a.size.height.saturating_sub(dimensions.height) as i32;
        let (x, y) = if reset {
            (max_x - 24, max_y - 24)
        } else {
            (pos.x, pos.y)
        };
        window
            .set_position(PhysicalPosition::new(
                x.clamp(a.position.x, max_x),
                y.clamp(a.position.y, max_y),
            ))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn apply_window(app: &DesktopAppHandle, prefs: &Preferences, reset: bool) -> Result<(), String> {
    if !prefs.enabled {
        if let Some(window) = app.get_webview_window(LABEL) {
            window.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let (width, height) = size(prefs);
    if let Some(window) = app.get_webview_window(LABEL) {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        fit(&window, reset)?;
        let ready = app
            .state::<DesktopPet>()
            .0
            .lock()
            .map_err(|_| "桌宠状态不可用")?
            .ready;
        if ready {
            window.show().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("易创 · 桌宠")
        .inner_size(width, height)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        // 可见桌宠在平台失焦或主窗口最小化后仍需播放；隐藏时前端主动停止 RAF。
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .visible(false)
        .disable_drag_drop_handler()
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .on_navigation(crate::is_app_shell_url)
        .build()
        .map_err(|e| e.to_string())?;
    if let (Some(x), Some(y)) = (prefs.x, prefs.y) {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    fit(&window, reset || prefs.x.is_none())?;
    Ok(())
}

pub fn initialize(app: &DesktopAppHandle) {
    if let Ok(root) = app.path().app_config_dir() {
        if let Ok(text) = std::fs::read_to_string(root.join(FILE)) {
            match serde_json::from_str::<Preferences>(&text) {
                Ok(prefs) if prefs.validate().is_ok() => {
                    if let Ok(mut data) = app.state::<DesktopPet>().0.lock() {
                        data.prefs = prefs;
                    }
                }
                _ => eprintln!("[desktop-pet] 配置不可读，保留原文件并使用关闭状态"),
            }
        }
    }
    // 等主窗口启动联动后再恢复显示，避免迁移、恢复流程期间开启第二个存储客户端。
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_ignore = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            let Some(window) = app.get_webview_window(LABEL) else {
                last_ignore = None;
                continue;
            };
            if window.is_visible().ok() != Some(true) {
                continue;
            }
            let hits = match app.state::<DesktopPet>().0.lock() {
                Ok(d) => d.hits.clone(),
                Err(_) => continue,
            };
            if hits.is_empty() {
                continue;
            }
            if let (Ok(cursor), Ok(pos), Ok(scale)) = (
                window.cursor_position(),
                window.outer_position(),
                window.scale_factor(),
            ) {
                let (x, y) = (
                    (cursor.x - f64::from(pos.x)) / scale,
                    (cursor.y - f64::from(pos.y)) / scale,
                );
                let ignore = !hits
                    .iter()
                    .any(|r| x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
                if last_ignore != Some(ignore) && window.set_ignore_cursor_events(ignore).is_ok() {
                    last_ignore = Some(ignore);
                }
            }
        }
    });
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == MAIN_WINDOW_LABEL && matches!(event, tauri::WindowEvent::Destroyed) {
        if let Some(pet) = window.app_handle().get_webview_window(LABEL) {
            let _ = pet.destroy();
        }
    }
    if window.label() != LABEL {
        return;
    }
    if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Ok(mut data) = window.app_handle().state::<DesktopPet>().0.lock() {
            let _ = persist(window.app_handle(), &data.prefs);
            data.ready = false;
            data.hits.clear();
        }
    }
    if let tauri::WindowEvent::Moved(pos) = event {
        let app = window.app_handle().clone();
        let revision = {
            let service = app.state::<DesktopPet>();
            let Ok(mut data) = service.0.lock() else {
                return;
            };
            data.prefs.x = Some(pos.x);
            data.prefs.y = Some(pos.y);
            data.position_revision += 1;
            data.position_revision
        };
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let service = app.state::<DesktopPet>();
            let Ok(data) = service.0.lock() else {
                return;
            };
            if data.position_revision == revision {
                let _ = persist(&app, &data.prefs);
            }
        });
    }
}

#[tauri::command]
pub async fn desktop_pet(
    window: DesktopWebviewWindow,
    app: DesktopAppHandle,
    action: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let main = window.label() == MAIN_WINDOW_LABEL;
    if !(main || window.label() == LABEL)
        || !window
            .url()
            .map(|url| crate::is_app_shell_url(&url))
            .unwrap_or(false)
    {
        return Err("此窗口不能操作桌宠".into());
    }
    let args = args.unwrap_or_else(|| json!({}));
    match action.as_str() {
        "get" => {}
        "restore" if main => {
            let prefs = app
                .state::<DesktopPet>()
                .0
                .lock()
                .map_err(|_| "桌宠状态不可用")?
                .prefs
                .clone();
            apply_window(&app, &prefs, false)?;
        }
        "configure" if main => {
            let mut prefs: Preferences = serde_json::from_value(args).map_err(|e| e.to_string())?;
            prefs.validate()?;
            let previous = {
                let service = app.state::<DesktopPet>();
                let mut data = service.0.lock().map_err(|_| "桌宠状态不可用")?;
                prefs.x = data.prefs.x;
                prefs.y = data.prefs.y;
                persist(&app, &prefs)?;
                let previous = data.prefs.clone();
                data.prefs = prefs.clone();
                previous
            };
            if let Err(error) = apply_window(&app, &prefs, false) {
                let service = app.state::<DesktopPet>();
                let mut data = service.0.lock().map_err(|_| "桌宠状态不可用")?;
                persist(&app, &previous)?;
                data.prefs = previous.clone();
                drop(data);
                let _ = apply_window(&app, &previous, false);
                broadcast(&app);
                return Err(error);
            }
            broadcast(&app);
        }
        "reset_position" if main => {
            if let Some(pet) = app.get_webview_window(LABEL) {
                fit(&pet, true)?;
            }
        }
        "hide" => {
            let service = app.state::<DesktopPet>();
            let mut data = service.0.lock().map_err(|_| "桌宠状态不可用")?;
            let mut prefs = data.prefs.clone();
            prefs.enabled = false;
            persist(&app, &prefs)?;
            data.prefs = prefs;
            drop(data);
            if let Some(pet) = app.get_webview_window(LABEL) {
                pet.hide().map_err(|e| e.to_string())?;
            }
            broadcast(&app);
        }
        "publish" if main => {
            let view: View = serde_json::from_value(args).map_err(|e| e.to_string())?;
            view.validate()?;
            app.state::<DesktopPet>()
                .0
                .lock()
                .map_err(|_| "桌宠状态不可用")?
                .view = view;
            broadcast(&app);
        }
        "ready" if !main => {
            let enabled = {
                let service = app.state::<DesktopPet>();
                let mut d = service.0.lock().map_err(|_| "桌宠状态不可用")?;
                d.ready = true;
                d.prefs.enabled
            };
            if enabled {
                window.show().map_err(|e| e.to_string())?;
            }
        }
        "hit_regions" if !main => {
            let hits: Vec<HitRect> = serde_json::from_value(args).map_err(|e| e.to_string())?;
            if hits.len() > 4
                || hits.iter().any(|r| {
                    ![r.x, r.y, r.width, r.height]
                        .iter()
                        .all(|n| n.is_finite() && *n >= 0.0 && *n <= 800.0)
                })
            {
                return Err("桌宠点击区域无效".into());
            }
            app.state::<DesktopPet>()
                .0
                .lock()
                .map_err(|_| "桌宠状态不可用")?
                .hits = hits;
        }
        "activate" if !main => {
            let target = if args.get("settings").and_then(Value::as_bool) == Some(true) {
                "settings".into()
            } else {
                app.state::<DesktopPet>()
                    .0
                    .lock()
                    .map_err(|_| "桌宠状态不可用")?
                    .view
                    .target
                    .clone()
            };
            if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                main.unminimize().map_err(|e| e.to_string())?;
                main.show().map_err(|e| e.to_string())?;
                main.set_focus().map_err(|e| e.to_string())?;
                app.emit_to(MAIN_WINDOW_LABEL, "ew-desktop-pet-activate", target)
                    .map_err(|e| e.to_string())?;
            }
        }
        _ => return Err("桌宠操作不受支持".into()),
    }
    snapshot(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_reject_unknown_assets_and_oversized_windows() {
        let mut p = Preferences::default();
        assert!(p.validate().is_ok());
        p.character = "../../secret".into();
        assert!(p.validate().is_err());
        p.character = "robot".into();
        p.size = 9999;
        assert!(p.validate().is_err());
    }
    #[test]
    fn targets_cannot_launch_external_urls() {
        assert!(valid_target("pi:session-id"));
        assert!(valid_target("/writing/42"));
        assert!(!valid_target("//example.com"));
        assert!(!valid_target("https://example.com"));
        assert!(valid_target("/myBooks"));
        assert!(!valid_target("javascript:alert(1)"));
    }
}
