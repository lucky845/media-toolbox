//! Tauri 2 壳：sidecar 管理、菜单、文件对话框，以及把 `media-core` 的算法接到 command 上。
//!
//! 这一层的职责边界（`docs/ARCHITECTURE.md` §2.1）：
//! - 允许：文件路径、rayon、子进程、Tauri API
//! - 禁止：任何像素循环、任何算法 —— 全部来自 `media-core`

mod commands;
mod sidecar;

use media_native::cancel::TaskRegistry;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 退出时取消所有在跑的任务，避免残留子进程
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, _event| {
                let _ = &handle;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                TaskRegistry::global().cancel_all();
                let _ = window;
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::probe::probe_capabilities,
            commands::image::image_process,
            commands::image::read_output_preview,
            commands::image::write_output_file,
            commands::video::video_probe,
            commands::video::video_transcode,
            commands::video::video_extract_frame,
            commands::video::video_extract_audio,
            commands::office::office_convert,
            commands::pdf::pdf_probe,
            commands::pdf::pdf_read_preview,
            commands::pdf::pdf_run,
            commands::cancel_task,
            commands::sidecar_info,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
