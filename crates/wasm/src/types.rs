//! 跨边界的数据结构（与 `docs/CONTRACTS.md` §5.1 的 `Capabilities` 一致）。

use media_ports::codec::{CodecFormats, ImageFormat};
use media_ports::limits::Limits;
use serde::Serialize;

/// 能力描述。前端只认这个，不认「是否打包成桌面」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub kind: &'static str,
    pub contract_version: u32,
    pub image: ImageCaps,
    pub video: VideoCaps,
    pub pdf: PdfCaps,
    pub office: OfficeCaps,
    pub cancel: CancelCaps,
    pub file_system: FileSystemCaps,
    pub offline: OfflineCaps,
    pub env: EnvCaps,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCaps {
    pub formats: Vec<&'static str>,
    pub avif: bool,
    pub max_pixels: u64,
    pub parallel: usize,
    pub png_optimize: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCaps {
    pub available: bool,
    pub engines: Vec<&'static str>,
    pub decoders: Vec<String>,
    pub encoders: Vec<String>,
    pub hardware_encoder: bool,
    pub max_bytes: u64,
    pub max_duration_sec: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfCaps {
    pub render: bool,
    pub edit: bool,
    pub max_pages: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCaps {
    /// "native" | "structured" | "none"
    pub word_to_pdf: &'static str,
    pub pdf_to_word: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelCaps {
    /// false = 只能 terminate 级取消（wasm 同步执行无法软中断）
    pub hard: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemCaps {
    pub directory_picker: bool,
    pub save_picker: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineCaps {
    pub service_worker: bool,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCaps {
    pub user_agent_major: String,
    pub cross_origin_isolated: bool,
}

/// 阈值 DTO（camelCase，与 TS 类型一一对应）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsDto {
    pub max_pixels: f64,
    pub max_bytes: f64,
    pub max_batch: u32,
    pub max_duration_sec: f64,
    pub max_pages: u32,
    pub max_memory_bytes: f64,
    pub max_concurrent: u32,
    pub is_restricted: bool,
}

impl LimitsDto {
    /// 注意：`u64::MAX` 会让 JS 的 Number 精度丢失，桌面端用 `-1` 表示「不限」。
    pub fn from_limits(l: &Limits, parallel: usize) -> Self {
        let _ = parallel;
        let enc = |v: u64| if v >= u64::MAX / 8 { -1.0 } else { v as f64 };
        LimitsDto {
            max_pixels: enc(l.max_pixels),
            max_bytes: enc(l.max_bytes),
            max_batch: l.max_batch,
            max_duration_sec: enc(l.max_duration_sec),
            max_pages: l.max_pages,
            max_memory_bytes: if l.max_memory_bytes == 0 {
                0.0
            } else {
                l.max_memory_bytes as f64
            },
            max_concurrent: l.max_concurrent,
            is_restricted: l.is_restricted,
        }
    }
}

impl Capabilities {
    /// Web 形态：由探测结果（浏览器能力）与编译进包的 codec 集合共同决定。
    pub fn web(fmt: &CodecFormats, parallel: usize) -> Self {
        Capabilities {
            kind: "web",
            contract_version: media_ports::CONTRACT_VERSION,
            image: ImageCaps {
                formats: fmt
                    .image_encode
                    .iter()
                    .map(|f: &ImageFormat| f.extension())
                    .collect(),
                avif: fmt.avif_enabled,
                max_pixels: Limits::WEB.max_pixels,
                parallel,
                png_optimize: fmt.png_optimize,
            },
            video: VideoCaps {
                // Web 端视频走 WebCodecs，是否可用由前端探测后覆盖（这里给保守默认）
                available: false,
                engines: vec!["webcodecs", "ffmpeg-wasm"],
                decoders: vec![],
                encoders: vec![],
                hardware_encoder: false,
                max_bytes: Limits::WEB.max_bytes,
                max_duration_sec: Limits::WEB.max_duration_sec,
            },
            pdf: PdfCaps {
                render: true,
                edit: true,
                max_pages: Limits::WEB.max_pages,
            },
            office: OfficeCaps {
                word_to_pdf: "structured",
                pdf_to_word: "structured",
            },
            cancel: CancelCaps { hard: false },
            file_system: FileSystemCaps {
                directory_picker: false,
                save_picker: false,
            },
            offline: OfflineCaps {
                service_worker: false,
                installed: false,
            },
            env: EnvCaps {
                user_agent_major: String::new(),
                cross_origin_isolated: false,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_ports::codec::CodecProvider;

    #[test]
    fn web_caps_mark_cancel_as_soft() {
        let c = Capabilities::web(&media_ports::codec::WebCodecs.formats(), 1);
        assert_eq!(c.kind, "web");
        assert!(!c.cancel.hard, "wasm 侧取消不是硬取消");
        assert_eq!(c.image.parallel, 1, "Pages 无 SharedArrayBuffer");
        assert!(!c.image.avif, "Phase 1 未启用 avif");
    }

    #[test]
    fn limits_dto_uses_negative_one_for_unlimited() {
        let d = LimitsDto::from_limits(&Limits::DESKTOP, 8);
        assert_eq!(d.max_bytes, -1.0);
        assert_eq!(d.max_pixels, -1.0);
        assert!(!d.is_restricted);
    }

    #[test]
    fn web_limits_are_concrete() {
        let d = LimitsDto::from_limits(&Limits::WEB, 1);
        assert_eq!(d.max_pixels, 20_000_000.0);
        assert_eq!(d.max_bytes, 20.0 * 1024.0 * 1024.0);
        assert_eq!(d.max_pages, 100);
        assert!(d.is_restricted);
    }

    #[test]
    fn office_is_structured_on_web() {
        let c = Capabilities::web(&media_ports::codec::WebCodecs.formats(), 1);
        assert_eq!(c.office.word_to_pdf, "structured");
    }
}
