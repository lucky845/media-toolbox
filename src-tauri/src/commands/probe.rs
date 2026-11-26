//! 能力探测：把「这台机器能做什么」变成数据交给前端（规格 §12）。

use media_core::common::limits_check::estimate_image_peak;
use media_native::RayonParallel;
use media_ports::codec::CodecProvider;
use media_ports::{Limits, ToolError};
use serde::Serialize;

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCaps {
    pub formats: Vec<&'static str>,
    pub avif: bool,
    /// 桌面端「不限」用 -1 表示（JS Number 安全）
    pub max_pixels: i64,
    pub parallel: usize,
    pub png_optimize: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCaps {
    pub available: bool,
    pub engines: Vec<&'static str>,
    pub decoders: Vec<String>,
    pub encoders: Vec<String>,
    pub hardware_encoder: bool,
    pub max_bytes: i64,
    pub max_duration_sec: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfCaps {
    pub render: bool,
    pub edit: bool,
    pub max_pages: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCaps {
    pub word_to_pdf: &'static str,
    pub pdf_to_word: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelCaps {
    pub hard: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemCaps {
    pub directory_picker: bool,
    pub save_picker: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineCaps {
    pub service_worker: bool,
    pub installed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCaps {
    pub user_agent_major: String,
    pub cross_origin_isolated: bool,
}

#[tauri::command]
pub fn probe_capabilities() -> Result<Capabilities, ToolError> {
    let formats = media_ports::codec::DesktopCodecs.formats();
    let parallel = media_ports::Parallel::parallelism(&RayonParallel::new());
    let side = crate::sidecar::probe();

    Ok(Capabilities {
        kind: "desktop",
        contract_version: media_ports::CONTRACT_VERSION,
        image: ImageCaps {
            formats: formats.image_encode.iter().map(|f| f.extension()).collect(),
            avif: formats.avif_enabled,
            max_pixels: -1,
            parallel,
            png_optimize: formats.png_optimize,
        },
        video: VideoCaps {
            available: side.ffmpeg_ok,
            engines: if side.ffmpeg_ok {
                vec!["ffmpeg-sidecar"]
            } else {
                vec![]
            },
            decoders: side.decoders,
            encoders: side.encoders,
            hardware_encoder: side.hardware_encoder,
            max_bytes: -1,
            max_duration_sec: -1,
        },
        pdf: PdfCaps {
            render: true,
            edit: true,
            max_pages: -1,
        },
        office: OfficeCaps {
            // LibreOffice 存在 → native；否则结构化（与 Web 同档，但 UI 会常驻提示）
            word_to_pdf: if side.libreoffice_ok {
                "native"
            } else {
                "structured"
            },
            pdf_to_word: if side.libreoffice_ok {
                "native"
            } else {
                "structured"
            },
        },
        cancel: CancelCaps { hard: true },
        file_system: FileSystemCaps {
            directory_picker: true,
            save_picker: true,
        },
        offline: OfflineCaps {
            service_worker: false,
            installed: true,
        },
        env: EnvCaps {
            user_agent_major: String::new(),
            cross_origin_isolated: true,
        },
    })
}

/// 供 image command 复用的阈值（桌面端不限制，但仍走同一份校验逻辑）
pub fn desktop_limits() -> Limits {
    Limits::desktop_with_concurrency(
        media_ports::Parallel::parallelism(&RayonParallel::new()).clamp(1, 16) as u32,
    )
}

// 让 estimate_image_peak 被用上（Phase 3 的流式路径会用到）
#[allow(dead_code)]
fn _peak(w: u32, h: u32, bytes: u64) -> u64 {
    estimate_image_peak(w, h, bytes)
}
