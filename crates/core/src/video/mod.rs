//! 视频参数与进度（纯函数，两端共用；Web WebCodecs 与桌面 FFmpeg sidecar）。

#[cfg(feature = "video")]
pub mod args;

#[cfg(feature = "video")]
pub use args::{
    build_extract_audio_args, build_extract_frame_args, build_transcode_args, parse_ffprobe,
    ProgressParser, RateMode, TranscodeParams, VideoMeta,
};
