//! 更新包只限制连续无数据的等待时间，不限制整包下载时长。

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::{UpdaterBuilder, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    raw_json: Value,
}

pub(super) fn updater_builder<R: Runtime>(
    app: &AppHandle<R>,
    idle_timeout: Duration,
) -> UpdaterBuilder {
    app.updater_builder()
        // 15 秒仅用于小体积版本清单；插件创建 Update 时不继承这个总时限。
        .timeout(CHECK_TIMEOUT)
        .configure_client(move |client| {
            client
                .connect_timeout(CHECK_TIMEOUT)
                // 每次成功读取数据后重新计时；没有下载总时限。
                .read_timeout(idle_timeout)
        })
}

#[tauri::command]
pub async fn check_desktop_update<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    if webview.label() != crate::MAIN_WINDOW_LABEL {
        return Err("请在主窗口检查更新".into());
    }
    let update = updater_builder(webview.app_handle(), DOWNLOAD_IDLE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        UpdateMetadata {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
            // 仍由官方 Update 资源负责下载、签名校验、安装及释放。
            rid: webview.resources_table().add(update),
        }
    }))
}
