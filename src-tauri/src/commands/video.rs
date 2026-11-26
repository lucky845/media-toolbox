//! 视频 command：ffprobe 探测 + FFmpeg sidecar 转码（档位 L：无 libx264）。
//!
//! 阶段边界：argv 来自 `media_core::video::args` 的纯函数，进程执行/进度/取消来自
//! `media_native::process`，本文件只做「参数 → command → 结果」的胶水，不含算法与命令行拼接。

use media_core::video::args::{
    build_extract_audio_args, build_extract_frame_args, build_transcode_args, parse_ffprobe,
    RateMode, TranscodeParams,
};
use media_native::cancel::TaskGuard;
use media_native::process::{run_capture, run_with_progress};
use media_ports::error::ErrorCode;
use media_ports::{Progress, ToolError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::sidecar;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbeArgs {
    pub input_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbeResult {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub duration_sec: f64,
    pub format_name: String,
    pub has_audio: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTranscodeArgs {
    pub input_path: String,
    /// 与 Web VideoTranscodeParams 同形状（容器决定编码）
    pub container: String,
    pub bitrate_mbps: f64,
    /// 尺寸缩放百分比（10–100；按探测到的宽高等比缩放，偶数化）
    pub scale_percent: u32,
    pub fps: Option<u8>,
    pub keep_audio: bool,
    pub task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTranscodeResult {
    pub output_path: String,
    pub out_format: String,
    pub out_width: u32,
    pub out_height: u32,
    pub duration_sec: f64,
}

/// ffprobe 探测：返回视频元数据（含是否有音轨）。
#[tauri::command]
pub fn video_probe(args: VideoProbeArgs) -> Result<VideoProbeResult, ToolError> {
    let ffprobe = sidecar::binary_path("ffprobe")
        .ok_or_else(|| ToolError::new(ErrorCode::BinaryMissing, &[("name", "ffprobe")]))?;
    let a = vec![
        "-v".into(),
        "error".into(),
        "-show_entries".into(),
        "format=duration:stream=codec_type,codec_name,width,height".into(),
        "-print_format".into(),
        "json".into(),
        args.input_path,
    ];
    let json = run_capture(&ffprobe, &a)?;
    let meta = parse_ffprobe(&json)?;
    // has_audio 用 JSON 解析而非字符串匹配（ffprobe 输出可能无空格）。
    let has_audio = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|v| {
            v.get("streams").and_then(|s| s.as_array()).map(|arr| {
                arr.iter()
                    .any(|s| s.get("codec_type").and_then(|t| t.as_str()) == Some("audio"))
            })
        })
        .unwrap_or(false);
    Ok(VideoProbeResult {
        codec: meta.codec,
        width: meta.width,
        height: meta.height,
        duration_sec: meta.duration_sec,
        format_name: meta.format_name,
        has_audio,
    })
}

/// 按档位 L 选择 H.264 编码器：优先系统硬件编码，没有则 libvpx VP9（webm），否则报错。
fn select_encoder(
    side: &sidecar::SidecarProbe,
    container: &str,
) -> Result<Option<String>, ToolError> {
    if container == "webm" {
        if side.encoders.iter().any(|e| e == "libvpx-vp9") {
            return Ok(Some("libvpx-vp9".into()));
        }
        return Err(ToolError::new(
            ErrorCode::CodecUnsupported,
            &[("codec", "VP9")],
        ));
    }
    // MP4：档位 L 不含 libx264，必须有硬件编码器。
    let order = [
        "h264_videotoolbox",
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "h264_vaapi",
    ];
    for hw in order {
        if side.encoders.iter().any(|e| e == hw) {
            return Ok(Some(hw.into()));
        }
    }
    // 若用户装了带 libx264 的构建，也可用（GPL 风险在 sidecar 探测时已标红提示）。
    if side.encoders.iter().any(|e| e == "libx264") {
        return Ok(Some("libx264".into()));
    }
    Err(
        ToolError::new(ErrorCode::CodecUnsupported, &[("codec", "H.264")])
            .with_detail("档位 L 构建无 libx264 且未检测到系统硬件编码器"),
    )
}

/// FFmpeg 转码：进度走 task://progress，取消走 TaskCancel + 进程树 kill。
#[tauri::command]
pub async fn video_transcode(
    app: AppHandle,
    args: VideoTranscodeArgs,
) -> Result<VideoTranscodeResult, ToolError> {
    let guard = TaskGuard::new(&args.task_id);
    let cancel = guard.token().clone();

    let ffmpeg = sidecar::binary_path("ffmpeg")
        .ok_or_else(|| ToolError::new(ErrorCode::BinaryMissing, &[("name", "ffmpeg")]))?;
    let side = sidecar::probe();

    // 输入元数据（用 ffprobe 拿时长，进度换算需要）
    let probe = video_probe(VideoProbeArgs {
        input_path: args.input_path.clone(),
    })?;

    let hardware = select_encoder(&side, &args.container)?;
    let container = if args.container == "webm" {
        "webm"
    } else {
        "mp4"
    };
    let bitrate_kbps = (args.bitrate_mbps * 1000.0).round() as u32;
    // 按探测宽高 × scalePercent 等比缩放并偶数化（偶数化对 H.264 必要）。
    let scale = args.scale_percent.clamp(10, 100) as f64 / 100.0;
    let (width, height) = if scale >= 1.0 {
        (None, None)
    } else {
        let w = ((probe.width as f64 * scale) / 2.0).round() as u32 * 2;
        let h = ((probe.height as f64 * scale) / 2.0).round() as u32 * 2;
        (Some(w.max(2)), Some(h.max(2)))
    };
    let params = TranscodeParams {
        rate_mode: RateMode::Bitrate,
        crf: 23,
        bitrate_kbps,
        width,
        height,
        fps: args.fps,
        audio_bitrate_kbps: if args.keep_audio { Some(128) } else { None },
        hardware_encoder: hardware,
        container: container.into(),
    };
    params.validate()?;

    // 输出路径：同目录 + taskId 命名（避免覆盖）。
    let src = std::path::Path::new(&args.input_path);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "video".into());
    let dir = src.parent().unwrap_or_else(|| std::path::Path::new("."));
    let output = dir.join(format!("{stem}-converted-{}.{}", args.task_id, container));
    let argv = build_transcode_args(&params, &args.input_path, &output.to_string_lossy())?;

    let app_for_progress = app.clone();
    let task_id = args.task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        run_with_progress(
            &ffmpeg,
            &argv,
            probe.duration_sec,
            &cancel,
            &|p: Progress| {
                let _ = app_for_progress.emit(
                    "task://progress",
                    serde_json::json!({
                        "taskId": task_id,
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
            },
        )
    })
    .await
    .map_err(|e| ToolError::internal(format!("任务崩溃: {e}")))??;

    if outcome.cancelled {
        return Err(ToolError::cancelled());
    }

    Ok(VideoTranscodeResult {
        output_path: output.to_string_lossy().into_owned(),
        out_format: container.into(),
        out_width: params.width.unwrap_or(probe.width),
        out_height: params.height.unwrap_or(probe.height),
        duration_sec: probe.duration_sec,
    })
}

/// 抽封面帧（供未来的封面帧功能；先提供 command 骨架，参数来自 core 纯函数）。
#[tauri::command]
pub fn video_extract_frame(
    input_path: String,
    output_path: String,
    at_sec: Option<f64>,
) -> Result<String, ToolError> {
    let ffmpeg = sidecar::binary_path("ffmpeg")
        .ok_or_else(|| ToolError::new(ErrorCode::BinaryMissing, &[("name", "ffmpeg")]))?;
    let argv = build_extract_frame_args(&input_path, &output_path, at_sec);
    run_capture(&ffmpeg, &argv)?;
    Ok(output_path)
}

/// 抽音频（直接复制音轨，不重编码）。
#[tauri::command]
pub fn video_extract_audio(input_path: String, output_path: String) -> Result<String, ToolError> {
    let ffmpeg = sidecar::binary_path("ffmpeg")
        .ok_or_else(|| ToolError::new(ErrorCode::BinaryMissing, &[("name", "ffmpeg")]))?;
    let argv = build_extract_audio_args(&input_path, &output_path);
    run_capture(&ffmpeg, &argv)?;
    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_encoder_lgpl_prefers_hardware() {
        let mut side = sidecar::SidecarProbe::default();
        side.encoders.push("h264_videotoolbox".into());
        assert_eq!(
            select_encoder(&side, "mp4").unwrap().as_deref(),
            Some("h264_videotoolbox")
        );
    }

    #[test]
    fn select_encoder_lgpl_no_h264_errors() {
        let side = sidecar::SidecarProbe::default();
        assert!(select_encoder(&side, "mp4").is_err());
    }

    #[test]
    fn select_encoder_webm_uses_vp9() {
        let mut side = sidecar::SidecarProbe::default();
        side.encoders.push("libvpx-vp9".into());
        assert_eq!(
            select_encoder(&side, "webm").unwrap().as_deref(),
            Some("libvpx-vp9")
        );
    }

    /// 用本机 ffprobe（PATH 兜底）真实探测 fixture；无 ffprobe 自动跳过。
    #[test]
    fn video_probe_reads_fixture_metadata() {
        if sidecar::binary_path("ffprobe").is_none() {
            eprintln!("跳过：PATH 中没有 ffprobe");
            return;
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let fixture = root.join("tests/fixtures/sample.mp4");
        if !fixture.exists() {
            return;
        }
        let r = video_probe(VideoProbeArgs {
            input_path: fixture.to_string_lossy().into_owned(),
        });
        assert!(r.is_ok(), "{:?}", r.err());
        let p = r.unwrap();
        assert_eq!(p.width, 320);
        assert_eq!(p.height, 240);
        assert!(p.duration_sec > 0.9 && p.duration_sec < 1.1);
        assert!(p.has_audio);
    }
}
