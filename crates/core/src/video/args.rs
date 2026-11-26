//! 视频模块：argv 构造 / 进度解析 / 元数据解析（**纯函数**，两端共用）。
//!
//! 关键设计（D8）：Web 的 ffmpeg.wasm 降级与桌面的 FFmpeg sidecar 都调这里的
//! 同一份 argv 构造与进度换算，避免两端参数语义漂移。
//!
//! 安全边界：`build_*_args` 只接受强类型参数，不接受前端透传的任意 argv ——
//! 桌面端若接受任意参数，Tauri 的 Shell sidecar 就成了任意命令执行入口。

use media_ports::{Result, ToolError};

/// 视频转码参数（与 `docs/CONTRACTS.md` §2.4 对应）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeParams {
    /// 'crf' | 'bitrate'：质量控制方式
    pub rate_mode: RateMode,
    /// CRF 值 0..=51（越小质量越高）
    pub crf: u8,
    /// 目标码率（kbps），bitrate 模式下有效
    pub bitrate_kbps: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u8>,
    /// 音频码率（kbps），None = 不处理音频
    pub audio_bitrate_kbps: Option<u32>,
    /// 显式音频编码器；None 保持默认 AAC（桌面 WebM 按 sidecar 探测能力设置）
    pub audio_encoder: Option<String>,
    /// 硬件编码器名（如 'h264_videotoolbox'），None = 软件编码
    pub hardware_encoder: Option<String>,
    /// 输出容器扩展名
    pub container: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RateMode {
    Crf,
    Bitrate,
}

impl TranscodeParams {
    pub fn validate(&self) -> Result<()> {
        if self.crf > 51 {
            return Err(ToolError::invalid("CRF 必须在 0..=51"));
        }
        if self.rate_mode == RateMode::Bitrate && self.bitrate_kbps == 0 {
            return Err(ToolError::invalid("码率模式下 bitrate_kbps 必须 > 0"));
        }
        if self.width == Some(0) || self.height == Some(0) {
            return Err(ToolError::invalid("分辨率不能为 0"));
        }
        if self.fps == Some(0) {
            return Err(ToolError::invalid("帧率不能为 0"));
        }
        Ok(())
    }

    /// 默认 H.264 CRF 23。
    pub fn default_h264() -> Self {
        TranscodeParams {
            rate_mode: RateMode::Crf,
            crf: 23,
            bitrate_kbps: 2500,
            width: None,
            height: None,
            fps: None,
            audio_bitrate_kbps: Some(128),
            audio_encoder: None,
            hardware_encoder: None,
            container: "mp4".into(),
        }
    }
}

/// 构造转码 argv。
///
/// 固定包含 `-hide_banner -nostdin -y`，进度由 `-progress pipe:1 -nostats` 驱动。
/// 参数全部来自强类型字段，杜绝注入。
pub fn build_transcode_args(p: &TranscodeParams, input: &str, output: &str) -> Result<Vec<String>> {
    p.validate()?;
    let mut a: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        input.to_string(),
    ];

    // 视频滤镜链：scale + fps
    let mut filters = Vec::new();
    if let (Some(w), Some(h)) = (p.width, p.height) {
        filters.push(format!("scale={w}:{h}:flags=lanczos"));
    } else if let Some(w) = p.width {
        filters.push(format!("scale={w}:-2"));
    } else if let Some(h) = p.height {
        filters.push(format!("scale=-2:{h}"));
    }
    if let Some(fps) = p.fps {
        filters.push(format!("fps={fps}"));
    }
    if !filters.is_empty() {
        a.push("-vf".into());
        a.push(filters.join(","));
    }

    // 编码器：硬件优先，否则 H.264 软件编码（桌面 LGPL 构建下用系统硬件编码）
    match &p.hardware_encoder {
        Some(hw) if !hw.is_empty() => {
            // 白名单校验：只允许识别过的软件/硬件编码器名，防止任意字符串注入。
            const ALLOWED_HW: &[&str] = &[
                "libx264",
                "h264_videotoolbox",
                "hevc_videotoolbox",
                "h264_nvenc",
                "hevc_nvenc",
                "h264_qsv",
                "hevc_qsv",
                "h264_amf",
                "hevc_amf",
                "h264_vaapi",
                "hevc_vaapi",
                "libvpx-vp9",
                "libsvtav1",
            ];
            if !ALLOWED_HW.contains(&hw.as_str()) {
                return Err(ToolError::invalid(format!("不允许的编码器: {hw}")));
            }
            a.push("-c:v".into());
            a.push(hw.clone());
        }
        _ => {
            a.push("-c:v".into());
            a.push("libx264".into()); // 注意：桌面 LGPL 构建下不会走到这里（探测后选硬件）
        }
    }

    match p.rate_mode {
        RateMode::Crf => {
            a.push("-crf".into());
            a.push(p.crf.to_string());
        }
        RateMode::Bitrate => {
            a.push("-b:v".into());
            a.push(format!("{}k", p.bitrate_kbps));
        }
    }

    if let Some(ab) = p.audio_bitrate_kbps {
        let audio_encoder = p.audio_encoder.as_deref().unwrap_or("aac");
        const ALLOWED_AUDIO: &[&str] = &["aac", "libopus", "libvorbis", "opus"];
        if !ALLOWED_AUDIO.contains(&audio_encoder) {
            return Err(ToolError::invalid(format!(
                "不允许的音频编码器: {audio_encoder}"
            )));
        }
        a.push("-c:a".into());
        a.push(audio_encoder.into());
        if audio_encoder == "opus" {
            a.extend(["-strict:a".into(), "experimental".into()]);
        }
        a.push("-b:a".into());
        a.push(format!("{ab}k"));
    } else {
        a.push("-an".into());
    }

    // 进度协议：逐行键值，可被 ProgressParser 增量解析
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-nostats".into());
    a.push(output.to_string());
    Ok(a)
}

/// 抽封面帧参数。
pub fn build_extract_frame_args(input: &str, output: &str, at_sec: Option<f64>) -> Vec<String> {
    let mut a = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];
    if let Some(t) = at_sec {
        a.push("-ss".into());
        a.push(t.to_string());
    }
    a.extend([
        "-i".into(),
        input.to_string(),
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        "2".into(),
        output.to_string(),
    ]);
    a
}

/// 抽音频（不重编码，直接复制音轨）。
pub fn build_extract_audio_args(input: &str, output: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        input.to_string(),
        "-vn".into(),
        "-acodec".into(),
        "copy".into(),
        output.to_string(),
    ]
}

/// ffmpeg `-progress pipe:1` 的增量解析器。
///
/// 每行形如 `out_time_us=1234567` / `frame=42` / `speed=1.5x`。
/// 不支持的键忽略；`progress=end` 标记完成。
#[derive(Debug)]
pub struct ProgressParser {
    total_us: u64,
    pub out_time_us: u64,
    pub frame: u64,
    pub speed: f64,
    pub finished: bool,
}

impl ProgressParser {
    pub fn new(total_duration_sec: f64) -> Self {
        ProgressParser {
            total_us: (total_duration_sec.max(0.0) * 1_000_000.0) as u64,
            out_time_us: 0,
            frame: 0,
            speed: 0.0,
            finished: false,
        }
    }

    /// 喂一行，返回归一化进度 0.0..=1.0（total 未知时返回 None）。
    pub fn feed_line(&mut self, line: &str) -> Option<f64> {
        let line = line.trim();
        if let Some((k, v)) = line.split_once('=') {
            match k {
                "out_time_us" => {
                    if let Ok(n) = v.parse::<u64>() {
                        self.out_time_us = n;
                    }
                }
                "frame" => {
                    if let Ok(n) = v.parse::<u64>() {
                        self.frame = n;
                    }
                }
                "speed" => {
                    if let Ok(s) = v.trim_end_matches('x').parse::<f64>() {
                        self.speed = s;
                    }
                }
                "progress" if v == "end" => {
                    self.finished = true;
                    self.out_time_us = self.out_time_us.max(self.total_us);
                }
                _ => {}
            }
        }
        if self.total_us == 0 {
            None
        } else {
            Some((self.out_time_us as f64 / self.total_us as f64).clamp(0.0, 1.0))
        }
    }

    pub fn eta_sec(&self) -> Option<f64> {
        if self.speed <= 0.0 || self.out_time_us >= self.total_us {
            return None;
        }
        let remain = (self.total_us - self.out_time_us) as f64 / 1_000_000.0;
        Some(remain / self.speed)
    }
}

/// ffprobe `-print_format json` 的最小解析（只取需要的字段，不引完整 JSON 模型）。
pub fn parse_ffprobe(json: &str) -> Result<VideoMeta> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail(e.to_string()))?;
    let format = v.get("format");
    let duration = format
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let stream = v.get("streams").and_then(|s| s.as_array()).and_then(|a| {
        a.iter()
            .find(|s| s.get("codec_type").and_then(|t| t.as_str()) == Some("video"))
    });

    Ok(VideoMeta {
        duration_sec: duration,
        width: stream
            .and_then(|s| s.get("width"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32,
        height: stream
            .and_then(|s| s.get("height"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32,
        codec: stream
            .and_then(|s| s.get("codec_name"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        format_name: format
            .and_then(|f| f.get("format_name"))
            .and_then(|f| f.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoMeta {
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub format_name: String,
}

use media_ports::ErrorCode;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_args_are_deterministic() {
        let p = TranscodeParams::default_h264();
        let a = build_transcode_args(&p, "in.mp4", "out.mp4").unwrap();
        assert_eq!(a[0], "-hide_banner");
        assert!(a.contains(&"-y".to_string()));
        assert!(a.contains(&"-progress".to_string()));
        assert!(a.contains(&"pipe:1".to_string()));
        assert_eq!(a.last().unwrap(), "out.mp4");
        // 同样输入必须完全一致（两端共用的前提）
        assert_eq!(a, build_transcode_args(&p, "in.mp4", "out.mp4").unwrap());
    }

    #[test]
    fn scale_and_fps_filters() {
        let p = TranscodeParams {
            width: Some(1280),
            height: Some(720),
            fps: Some(30),
            ..TranscodeParams::default_h264()
        };
        let a = build_transcode_args(&p, "in.mkv", "out.mp4").unwrap();
        let vf = a.iter().position(|x| x == "-vf").unwrap();
        assert_eq!(a[vf + 1], "scale=1280:720:flags=lanczos,fps=30");
    }

    #[test]
    fn crf_and_bitrate_modes() {
        let mut p = TranscodeParams::default_h264();
        let a = build_transcode_args(&p, "i", "o").unwrap();
        let crf = a.iter().position(|x| x == "-crf").unwrap();
        assert_eq!(a[crf + 1], "23");

        p.rate_mode = RateMode::Bitrate;
        p.bitrate_kbps = 4000;
        let a = build_transcode_args(&p, "i", "o").unwrap();
        let b = a.iter().position(|x| x == "-b:v").unwrap();
        assert_eq!(a[b + 1], "4000k");
    }

    #[test]
    fn hardware_encoder_whitelist() {
        let mut p = TranscodeParams::default_h264();
        p.hardware_encoder = Some("h264_videotoolbox".into());
        assert!(build_transcode_args(&p, "i", "o").is_ok());
        p.hardware_encoder = Some("; rm -rf /".into());
        assert_eq!(
            build_transcode_args(&p, "i", "o").unwrap_err().code,
            ErrorCode::InvalidParams
        );
    }

    #[test]
    fn transcode_args_use_container_compatible_audio() {
        let mut p = TranscodeParams::default_h264();
        let args = build_transcode_args(&p, "in.mp4", "out.mp4").unwrap();
        assert!(args.windows(2).any(|v| v == ["-c:a", "aac"]));

        p.container = "webm".into();
        p.audio_encoder = Some("libopus".into());
        p.hardware_encoder = Some("libvpx-vp9".into());
        let args = build_transcode_args(&p, "in.mp4", "out.webm").unwrap();
        assert!(args.windows(2).any(|v| v == ["-c:a", "libopus"]));
        assert!(args.windows(2).any(|v| v == ["-b:a", "128k"]));
        assert!(!args.contains(&"-strict:a".into()));

        p.audio_encoder = Some("opus".into());
        let args = build_transcode_args(&p, "in.mp4", "out.webm").unwrap();
        assert!(args.windows(2).any(|v| v == ["-c:a", "opus"]));
        assert!(args.windows(2).any(|v| v == ["-strict:a", "experimental"]));
    }

    #[test]
    fn transcode_args_accept_detected_libx264() {
        let mut p = TranscodeParams::default_h264();
        p.hardware_encoder = Some("libx264".into());
        let args = build_transcode_args(&p, "in.mp4", "out.mp4").unwrap();
        assert!(args.windows(2).any(|v| v == ["-c:v", "libx264"]));
    }

    #[test]
    fn no_audio_adds_an() {
        let mut p = TranscodeParams::default_h264();
        p.audio_bitrate_kbps = None;
        let a = build_transcode_args(&p, "i", "o").unwrap();
        assert!(a.contains(&"-an".to_string()));
    }

    #[test]
    fn progress_parser_incremental() {
        let mut p = ProgressParser::new(10.0);
        assert!(p.feed_line("out_time_us=2500000").unwrap() > 0.24);
        assert!(p.feed_line("frame=42").is_some());
        assert!(p.feed_line("speed=1.5x").is_some());
        assert_eq!(p.speed, 1.5);
        assert!(p.eta_sec().is_some());
        p.feed_line("progress=end");
        assert!(p.finished);
    }

    #[test]
    fn progress_unknown_total() {
        let mut p = ProgressParser::new(0.0);
        assert_eq!(p.feed_line("out_time_us=1000"), None);
        assert_eq!(p.eta_sec(), None);
    }

    #[test]
    fn parse_ffprobe_minimal() {
        let json = r#"{"format":{"duration":"12.5","format_name":"mov,mp4"},"streams":[{"codec_type":"video","width":1920,"height":1080,"codec_name":"h264"}]}"#;
        let m = parse_ffprobe(json).unwrap();
        assert_eq!(m.duration_sec, 12.5);
        assert_eq!((m.width, m.height), (1920, 1080));
        assert_eq!(m.codec, "h264");
    }

    #[test]
    fn parse_ffprobe_rejects_garbage() {
        assert_eq!(
            parse_ffprobe("not json").unwrap_err().code,
            ErrorCode::DecodeFailed
        );
    }

    #[test]
    fn extract_frame_and_audio_args() {
        let f = build_extract_frame_args("in.mp4", "cover.jpg", Some(5.0));
        assert!(f.contains(&"-ss".to_string()));
        assert!(f.contains(&"5".to_string()));
        let a = build_extract_audio_args("in.mp4", "out.aac");
        assert!(a.contains(&"-vn".to_string()));
        assert!(a.contains(&"copy".to_string()));
    }

    #[test]
    fn validation_rejects_bad_params() {
        let mut p = TranscodeParams::default_h264();
        p.crf = 99;
        assert!(build_transcode_args(&p, "i", "o").is_err());
        p = TranscodeParams::default_h264();
        p.fps = Some(0);
        assert!(build_transcode_args(&p, "i", "o").is_err());
    }
}
