//! 图片 command：路径进、路径出。
//!
//! 关键点：**字节不经过 IPC**。前端传路径，Rust 读文件、处理、写文件，
//! 只把元数据回给前端。这是「桌面版能处理大文件」的根本原因 ——
//! 20 MP 图如果走 IPC 传 Uint8Array，光序列化就要几百毫秒。

use crate::commands::probe::desktop_limits;
use media_core::image::params::{EncodeOptions, ImageParams};
use media_core::image::pipeline::Ctx;
use media_native::cancel::TaskGuard;
use media_native::ProgressReporter;
use media_native::{read_limited, write_atomic, RayonParallel};
use media_ports::progress::Progress;
use media_ports::{Limits, ToolError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProcessResult {
    pub output_path: String,
    pub meta: ImageResultMeta,
    pub output_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResultMeta {
    pub out_format: String,
    pub out_width: u32,
    pub out_height: u32,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub output_hash: String,
    pub savings_ratio: f64,
    pub savings_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProcessArgs {
    pub input_path: String,
    pub params: ImageParams,
    pub encode: EncodeOptions,
    pub task_id: String,
    /// 可选：显式输出路径。不给时由 Rust 生成（同目录 + 参数摘要）
    pub output_path: Option<String>,
    /// 可选：覆盖已存在文件
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub async fn image_process(
    app: AppHandle,
    args: ImageProcessArgs,
) -> Result<ImageProcessResult, ToolError> {
    let guard = TaskGuard::new(&args.task_id);
    let cancel = guard.token().clone();

    let limits: Limits = desktop_limits();
    let parallel = RayonParallel::new();

    // 进度：100ms 节流的职责在 Tauri event 侧（前端 listen 后自行合并），
    // 这里按 phase 变化 + 每 5% 上报一次，足够顺滑且不刷爆 IPC。
    let app_for_progress = app.clone();
    // 用原子而不是捕获变量：ProgressSink 要求 Fn + Sync（rayon 多线程会并发上报）
    let last_pct = std::sync::atomic::AtomicI32::new(-1);
    let progress = ProgressReporter::new(move |p: Progress| {
        let pct = if p.total > 0 {
            (p.done as f64 / p.total as f64 * 100.0) as i32
        } else {
            -1
        };
        // 只在百分比变化时发事件：100 段接收方不会因为每像素一次而被打爆
        if last_pct.swap(pct, std::sync::atomic::Ordering::Relaxed) != pct {
            let _ = app_for_progress.emit(
                "task://progress",
                serde_json::json!({
                    "taskId": args.task_id,
                    "done": p.done,
                    "total": p.total,
                    "phase": p.phase.as_str(),
                    "unit": match p.unit {
                        media_ports::progress::Unit::Bytes => "bytes",
                        media_ports::progress::Unit::Pixels => "pixels",
                        media_ports::progress::Unit::Pages => "pages",
                        media_ports::progress::Unit::Frames => "frames",
                        media_ports::progress::Unit::Percent => "percent",
                    },
                }),
            );
        }
    });

    // 读文件（带阈值校验；桌面端阈值是「不限」，但仍走同一份代码路径）。
    // 注意：不要写 `.max(u64::MAX / 8)` 之类的兜底 —— DESKTOP.max_bytes 本身就是
    // u64::MAX/4，那个 max 恒等于后者，是把「不限」误读成「可能为 0」的遗迹。
    let input = read_limited(&args.input_path, limits.max_bytes)?;

    let params = args.params.clone();
    let encode = args.encode.clone();

    // 在 spawn_blocking 里跑 CPU 密集任务，避免阻塞 async 运行时。
    // ctx 必须在闭包内构造：它借用了 parallel/progress/cancel，而这三者的
    // 生命周期需要覆盖整个阻塞调用 —— 放到闭包外面会与 spawn_blocking 的 'static 要求冲突。
    let output = tokio::task::spawn_blocking(move || {
        let ctx = Ctx {
            parallel: &parallel,
            progress: &progress,
            cancel: &cancel,
            limits: &limits,
        };
        media_core::image::pipeline::process_image(&input, &params, &encode, &ctx)
    })
    .await
    .map_err(|e| ToolError::internal(format!("任务崩溃: {e}")))??;

    // 输出路径
    let out_path: std::path::PathBuf = match args.output_path {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let src = std::path::Path::new(&args.input_path);
            let stem = src
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "output".into());
            let name = media_core::image::pipeline::output_name(&stem, &args.params, &args.encode)?;
            let dir = src.parent().unwrap_or_else(|| std::path::Path::new("."));
            let candidate = dir.join(name);
            if args.overwrite {
                candidate
            } else {
                media_native::unique_path(candidate)
            }
        }
    };

    let out_str = out_path.to_string_lossy().into_owned();
    write_atomic(&out_path, &output.output)?;

    let meta = ImageResultMeta {
        out_format: output.out_format.extension().to_string(),
        out_width: output.out_width,
        out_height: output.out_height,
        input_bytes: output.input_bytes,
        output_bytes: output.output_bytes,
        output_hash: output.output_hash,
        savings_ratio: media_core::image::pipeline::savings_ratio(
            output.input_bytes,
            output.output_bytes,
        ),
        savings_text: media_core::image::pipeline::savings_text(
            output.input_bytes,
            output.output_bytes,
        ),
    };

    Ok(ImageProcessResult {
        output_path: out_str,
        meta,
        output_bytes: output.output_bytes,
    })
}

/// 读取输出文件用于预览（只读前 N 字节，避免大图占满内存）。
#[tauri::command]
pub fn read_output_preview(path: String) -> Result<Vec<u8>, ToolError> {
    const MAX_PREVIEW: u64 = 8 * 1024 * 1024; // 8 MB
    let meta = std::fs::metadata(&path).map_err(|e| ToolError::io(format!("读取失败: {e}")))?;
    if meta.len() > MAX_PREVIEW {
        return Err(
            ToolError::new(media_ports::ErrorCode::InputTooLarge, &[("limit", "8 MB")])
                .with_detail("预览文件过大；完整文件已写入磁盘，可用系统查看器打开"),
        );
    }
    std::fs::read(&path).map_err(|e| ToolError::io(format!("读取失败: {e}")))
}

/// 写输出文件（用于「另存为」）。数据量小（用户主动保存单个结果）。
#[tauri::command]
pub fn write_output_file(path: String, data: Vec<u8>) -> Result<(), ToolError> {
    write_atomic(&path, &data)
}
