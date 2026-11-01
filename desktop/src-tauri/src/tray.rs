//! 系统托盘（PRD FR-1.5 最小集）：显示/隐藏主窗口、退出。
//!
//! 退出语义 = 先优雅关闭引擎（SIGTERM → 3s → SIGKILL）再退出应用，
//! 不留孤儿进程（PRD FR-1.4 / 验收标准 4）。
//! 图标为程序内生成的实心圆点（避免 M1 引入二进制资源依赖；
//! 正式应用图标已在 icons/ 就位，M5 打包时统一替换托盘图标）。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

/// 程序内生成 32×32 托盘图标（品牌蓝实心圆点，RGBA）。
fn tray_icon_image() -> tauri::image::Image<'static> {
    const SIZE: usize = 32;
    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as i32 - 16;
            let dy = y as i32 - 16;
            if dx * dx + dy * dy <= 13 * 13 {
                let i = (y * SIZE + x) * 4;
                rgba[i] = 0x2E;
                rgba[i + 1] = 0x6B;
                rgba[i + 2] = 0xFF;
                rgba[i + 3] = 0xFF;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

/// 装配系统托盘（setup 阶段调用一次）。
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    TrayIconBuilder::with_id("deepcode-tray")
        .tooltip("DeepCode")
        .icon(tray_icon_image())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("boot") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("boot") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                // 优雅关闭引擎后退出：同步清理放独立线程，不卡托盘事件循环
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Some(state) = app.try_state::<crate::ipc::AppState>() {
                        crate::engine::manager::cleanup_blocking(&state.engine);
                    }
                    app.exit(0);
                });
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
