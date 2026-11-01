//! 作品服务事件由桌面和 Pi 的现用订阅者接收。
use tauri::Emitter;
pub fn emit<T: serde::Serialize>(app: &crate::DesktopAppHandle, name: &str, payload: T) {
    if let Ok(value) = serde_json::to_value(payload) {
        let _ = app.emit(name, value);
    }
}
