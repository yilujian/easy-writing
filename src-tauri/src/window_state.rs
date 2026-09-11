//! 主窗口状态由官方插件持久化；应用只负责恢复顺序与可见区域约束。

use tauri::{plugin::TauriPlugin, Manager, PhysicalPosition, PhysicalSize, Window, Wry};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

use crate::{DesktopWebviewWindow, MAIN_WINDOW_LABEL};

pub const MIN_WIDTH: f64 = 1100.0;
pub const MIN_HEIGHT: f64 = 720.0;
const GEOMETRY: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION);
const SAVED_STATE: StateFlags = GEOMETRY.union(StateFlags::MAXIMIZED);

pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_window_state::Builder::default()
        .with_state_flags(SAVED_STATE)
        .with_filter(|label| label == MAIN_WINDOW_LABEL)
        // 窗口始终可见，且不能用旧状态覆盖平台各自的标题栏样式。
        // 先恢复普通窗口的边界，再最大化，最后显示。
        .skip_initial_state(MAIN_WINDOW_LABEL)
        .build()
}

pub fn restore(window: &DesktopWebviewWindow) {
    if let Err(error) = window.restore_state(GEOMETRY) {
        eprintln!("恢复主窗口位置和尺寸失败，使用初始窗口：{error}");
    }
    let window = window.clone();
    after_native_changes(move || {
        if let Err(error) = fit_to_work_area(&window) {
            eprintln!("调整主窗口可见区域失败：{error}");
            let _ = window.center();
        }
        after_native_changes(move || {
            if let Err(error) = window.restore_state(StateFlags::MAXIMIZED) {
                eprintln!("恢复主窗口最大化状态失败：{error}");
            }
            after_native_changes(move || {
                if let Err(error) = window.show().and_then(|()| window.set_focus()) {
                    eprintln!("显示主窗口失败：{error}");
                }
            });
        });
    });
}

fn after_native_changes(action: impl FnOnce() + Send + 'static) {
    // macOS 的 set_size/set_position 本身异步派发到 GCD 主队列，
    // 继续排入同一队列，保证读取边界、最大化、显示依次发生，无需固定延时。
    #[cfg(target_os = "macos")]
    dispatch2::DispatchQueue::main().exec_async(action);
    #[cfg(not(target_os = "macos"))]
    action();
}

pub fn save_before_close(window: &Window) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    // 前端备份后直接 destroy 窗口，必须在窗口仍存活时读取最终最大化状态。
    // 插件的退出保存同时覆盖系统退出、应用重启等路径。
    if let Err(error) = window.app_handle().save_window_state(SAVED_STATE) {
        eprintln!("保存主窗口状态失败：{error}");
    }
}

fn fit_to_work_area(window: &DesktopWebviewWindow) -> tauri::Result<()> {
    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    let chrome_width = outer.width.saturating_sub(inner.width);
    let chrome_height = outer.height.saturating_sub(inner.height);
    let scale = monitor.scale_factor();
    // 普通窗口留出少量屏幕边距；完全填满工作区在 macOS 会被识别为最大化，
    // 导致插件跳过普通尺寸更新。真正的最大化在下一阶段单独恢复。
    let margin = (16.0 * scale).ceil() as u32;
    let max_width = area
        .size
        .width
        .saturating_sub(chrome_width)
        .saturating_sub(margin)
        .max(1);
    let max_height = area
        .size
        .height
        .saturating_sub(chrome_height)
        .saturating_sub(margin)
        .max(1);

    // 高缩放或较小的屏幕上，最低尺寸不能大于当前显示器的可用区域。
    let min_width = ((MIN_WIDTH * scale).ceil() as u32).min(max_width);
    let min_height = ((MIN_HEIGHT * scale).ceil() as u32).min(max_height);
    window.set_min_size(Some(PhysicalSize::new(min_width, min_height)))?;
    let width = inner.width.clamp(min_width, max_width);
    let height = inner.height.clamp(min_height, max_height);
    if width != inner.width || height != inner.height {
        window.set_size(PhysicalSize::new(width, height))?;
    }

    let position = window.outer_position()?;
    let x = clamp_axis(
        position.x,
        area.position.x,
        area.size.width,
        width + chrome_width,
    );
    let y = clamp_axis(
        position.y,
        area.position.y,
        area.size.height,
        height + chrome_height,
    );
    if x != position.x || y != position.y {
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

fn clamp_axis(position: i32, origin: i32, available: u32, extent: u32) -> i32 {
    let start = i64::from(origin);
    let end = start + i64::from(available.saturating_sub(extent));
    i64::from(position)
        .clamp(start, end)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}
