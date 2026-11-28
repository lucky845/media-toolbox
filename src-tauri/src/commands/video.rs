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
    pub input_bytes: u64,
    pub output_bytes: u64,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebmAudioEncoder {
    LibOpus,
    LibVorbis,
    NativeOpus,
}

impl WebmAudioEncoder {
    fn as_str(self) -> &'static str {
        match self {
            Self::LibOpus => "libopus",
            Self::LibVorbis => "libvorbis",
            Self::NativeOpus => "opus",
        }
    }
}

/// Select a codec the packaged FFmpeg actually advertises, preferring standard WebM audio.
fn select_webm_audio(side: &sidecar::SidecarProbe) -> Result<WebmAudioEncoder, ToolError> {
    if side.encoders.iter().any(|e| e == "libopus") {
        return Ok(WebmAudioEncoder::LibOpus);
    }
    if side.encoders.iter().any(|e| e == "libvorbis") {
        return Ok(WebmAudioEncoder::LibVorbis);
    }
    // FFmpeg's native Opus encoder is experimental in n7.1, but WebM-compatible.
    if side.encoders.iter().any(|e| e == "opus") {
        return Ok(WebmAudioEncoder::NativeOpus);
    }
    Err(ToolError::new(
        ErrorCode::CodecUnsupported,
        &[("codec", "Opus/Vorbis")],
    ))
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
    let keep_audio = args.keep_audio && probe.has_audio;
    let audio_encoder = if keep_audio && container == "webm" {
        Some(select_webm_audio(&side)?.as_str().to_string())
    } else {
        None
    };
    let params = TranscodeParams {
        rate_mode: RateMode::Bitrate,
        crf: 23,
        bitrate_kbps,
        width,
        height,
        fps: args.fps,
        audio_bitrate_kbps: keep_audio.then_some(128),
        audio_encoder,
        hardware_encoder: hardware,
        container: container.into(),
    };
    params.validate()?;

    // 输出路径：同目录 + taskId 命名（避免覆盖）。
    let src = std::path::Path::new(&args.input_path);
    let input_bytes = std::fs::metadata(src)
        .map_err(|e| ToolError::io(format!("读取输入大小失败: {}", e.kind())))?
        .len();
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "video".into());
    let dir = src.parent().unwrap_or_else(|| std::path::Path::new("."));
    let output = dir.join(format!("{stem}-converted-{}.{}", args.task_id, container));

    let app_for_progress = app.clone();
    let task_id = args.task_id.clone();
    let staged_output = output.clone();
    let ffmpeg_params = params.clone();
    tokio::task::spawn_blocking(move || {
        publish_video_output(&staged_output, |staged| {
            if cancel.is_cancelled() {
                return Err(ToolError::cancelled());
            }
            let argv =
                build_transcode_args(&ffmpeg_params, &args.input_path, &staged.to_string_lossy())?;
            let outcome = run_with_progress(
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
            )?;
            if outcome.cancelled || cancel.is_cancelled() {
                return Err(ToolError::cancelled());
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| ToolError::internal(format!("任务崩溃: {e}")))??;

    let output_bytes = std::fs::metadata(&output)
        .map_err(|e| ToolError::io(format!("读取输出大小失败: {}", e.kind())))?
        .len();
    Ok(VideoTranscodeResult {
        output_path: output.to_string_lossy().into_owned(),
        out_format: container.into(),
        input_bytes,
        output_bytes,
        out_width: params.width.unwrap_or(probe.width),
        out_height: params.height.unwrap_or(probe.height),
        duration_sec: probe.duration_sec,
    })
}

/// 仅在 FFmpeg 成功后发布文件。临时目录和输出在同一文件系统，且保留扩展名供 FFmpeg 推断格式。
fn publish_video_output(
    output: &std::path::Path,
    run: impl FnOnce(&std::path::Path) -> Result<(), ToolError>,
) -> Result<(), ToolError> {
    let dir = output
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let filename = output
        .file_name()
        .ok_or_else(|| ToolError::io("无效的视频输出文件名"))?;
    let staging = tempfile::Builder::new()
        .prefix(".media-toolbox-video-")
        .tempdir_in(dir)
        .map_err(|e| ToolError::io(format!("创建视频临时目录失败: {e}")))?;
    let staged = staging.path().join(filename);
    run(&staged)?;
    std::fs::rename(&staged, output)
        .map_err(|e| ToolError::io(format!("发布视频输出失败: {e}")))?;
    Ok(())
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
    publish_video_output(std::path::Path::new(&output_path), |staged| {
        let argv = build_extract_frame_args(&input_path, &staged.to_string_lossy(), at_sec);
        run_capture(&ffmpeg, &argv)?;
        Ok(())
    })?;
    Ok(output_path)
}

/// 抽音频（直接复制音轨，不重编码）。
#[tauri::command]
pub fn video_extract_audio(input_path: String, output_path: String) -> Result<String, ToolError> {
    let ffmpeg = sidecar::binary_path("ffmpeg")
        .ok_or_else(|| ToolError::new(ErrorCode::BinaryMissing, &[("name", "ffmpeg")]))?;
    publish_video_output(std::path::Path::new(&output_path), |staged| {
        let argv = build_extract_audio_args(&input_path, &staged.to_string_lossy());
        run_capture(&ffmpeg, &argv)?;
        Ok(())
    })?;
    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_publish_video_output_failure_and_cancel_leave_no_partial_file() {
        let dir =
            std::env::temp_dir().join(format!("mt-video-stage-failure-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let output = dir.join("converted.mp4");
        for error in [
            ToolError::new(ErrorCode::EncodeFailed, &[]),
            ToolError::cancelled(),
        ] {
            let code = error.code;
            let result = publish_video_output(&output, |staged| {
                assert_eq!(staged.extension(), output.extension());
                std::fs::write(staged, b"partial").unwrap();
                assert!(!output.exists());
                Err(error)
            });
            assert_eq!(result.unwrap_err().code, code);
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        }
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn test_publish_video_output_only_replaces_existing_output_on_success() {
        let dir =
            std::env::temp_dir().join(format!("mt-video-stage-success-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let output = dir.join("converted.webm");
        std::fs::write(&output, b"original").unwrap();
        let result = publish_video_output(&output, |staged| {
            std::fs::write(staged, b"partial").unwrap();
            Err(ToolError::cancelled())
        });
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(std::fs::read(&output).unwrap(), b"original");
        publish_video_output(&output, |staged| {
            std::fs::write(staged, b"finished").unwrap();
            assert_eq!(std::fs::read(&output).unwrap(), b"original");
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"finished");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_file(&output).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

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

    #[test]
    fn select_webm_audio_uses_available_encoder_in_preference_order() {
        let mut side = sidecar::SidecarProbe::default();
        assert_eq!(
            select_webm_audio(&side).unwrap_err().code,
            ErrorCode::CodecUnsupported
        );
        side.encoders.push("opus".into());
        assert_eq!(
            select_webm_audio(&side).unwrap(),
            WebmAudioEncoder::NativeOpus
        );
        side.encoders.push("libvorbis".into());
        assert_eq!(
            select_webm_audio(&side).unwrap(),
            WebmAudioEncoder::LibVorbis
        );
        side.encoders.push("libopus".into());
        assert_eq!(select_webm_audio(&side).unwrap(), WebmAudioEncoder::LibOpus);
    }

    #[test]
    fn webm_transcode_preserves_audio_with_available_sidecar_encoders() {
        use std::process::Command;

        let (Some(ffmpeg), Some(ffprobe)) = (
            sidecar::binary_path("ffmpeg"),
            sidecar::binary_path("ffprobe"),
        ) else {
            eprintln!("Skipping: FFmpeg and ffprobe are required");
            return;
        };
        let side = sidecar::probe();
        let Ok(video_encoder) = select_encoder(&side, "webm") else {
            eprintln!("Skipping: FFmpeg has no VP9 encoder");
            return;
        };
        if select_webm_audio(&side).is_err() {
            eprintln!("Skipping: FFmpeg has no WebM audio encoder");
            return;
        }
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sample.mp4");
        let dst = std::env::temp_dir().join(format!("mt-webm-audio-{}.webm", std::process::id()));

        // Exercise every compatible encoder this exact FFmpeg build advertises.
        // This covers BtbN libopus/libvorbis builds and macOS native Opus fallback.
        for (encoder, expected) in [
            (WebmAudioEncoder::LibOpus, "opus"),
            (WebmAudioEncoder::LibVorbis, "vorbis"),
            (WebmAudioEncoder::NativeOpus, "opus"),
        ] {
            if !side.encoders.iter().any(|e| e == encoder.as_str()) {
                continue;
            }
            let params = TranscodeParams {
                rate_mode: RateMode::Bitrate,
                hardware_encoder: video_encoder.clone(),
                audio_encoder: Some(encoder.as_str().into()),
                container: "webm".into(),
                ..TranscodeParams::default_h264()
            };
            let argv =
                build_transcode_args(&params, &fixture.to_string_lossy(), &dst.to_string_lossy())
                    .unwrap();
            let render = Command::new(&ffmpeg).args(argv).output().unwrap();
            let probe = Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=codec_name",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                ])
                .arg(&dst)
                .output()
                .unwrap();
            let _ = std::fs::remove_file(&dst);

            assert!(
                render.status.success(),
                "{encoder:?}: {}",
                String::from_utf8_lossy(&render.stderr)
            );
            assert!(
                probe.status.success(),
                "{}",
                String::from_utf8_lossy(&probe.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), expected);
        }
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
