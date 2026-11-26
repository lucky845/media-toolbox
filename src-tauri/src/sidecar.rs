//! sidecar 探测：ffmpeg/ffprobe 是否存在、版本、configure 行是否含 GPL/nonfree。
//!
//! 这一段是许可证合规的**运行期**防线（`docs/ARCHITECTURE.md` §8）：
//! 如果打包脚本拉错了 FFmpeg 构建（含 `--enable-gpl` 或 `--enable-nonfree`），
//! 应用启动时就会在「关于」里标红，而不是等发布之后才被发现。

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarProbe {
    pub ffmpeg_ok: bool,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_ok: bool,
    pub libreoffice_ok: bool,
    /// configure 行里是否出现 --enable-gpl / --enable-nonfree（出现即合规风险）
    pub gpl_risk: bool,
    pub decoders: Vec<String>,
    pub encoders: Vec<String>,
    pub hardware_encoder: bool,
}

/// sidecar 二进制的查找目录：优先安装包内的资源目录，其次 PATH。
fn sidecar_path(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Tauri 把 externalBin 放在可执行文件同级（macOS 在 .app/Contents/MacOS/）
    for cand in [
        dir.join(name),
        dir.join(format!("{name}-aarch64-apple-darwin")),
        dir.join(format!("{name}-x86_64-apple-darwin")),
        dir.join(format!("{name}-x86_64-pc-windows-msvc.exe")),
        dir.join(format!("{name}-x86_64-unknown-linux-gnu")),
        dir.join("..").join("Resources").join(name),
    ] {
        if cand.exists() {
            return Some(cand);
        }
    }
    // PATH 兜底（开发期）
    which(name)
}

/// 供 video command 取 sidecar 绝对路径（与 probe 共用同一查找逻辑）。
pub fn binary_path(name: &str) -> Option<PathBuf> {
    sidecar_path(name)
}

/// LibreOffice 可执行文件：安装包内优先，其次系统安装/PATH。
pub fn libreoffice_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates = [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "LibreOffice.app/Contents/MacOS/soffice",
    ];
    #[cfg(target_os = "windows")]
    let candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        "LibreOffice/program/soffice.exe",
    ];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates = ["/usr/bin/soffice", "soffice"];

    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    which("soffice")
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 跑 `ffmpeg -hide_banner -version`，解析版本行与 configure 行。
pub fn probe() -> SidecarProbe {
    let mut p = SidecarProbe::default();

    if let Some(ffmpeg) = sidecar_path("ffmpeg") {
        if let Ok(out) = Command::new(&ffmpeg)
            .args(["-hide_banner", "-version"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            p.ffmpeg_ok = out.status.success();
            p.ffmpeg_version = text.lines().next().map(|s| s.trim().to_string());
            p.gpl_risk = text.contains("--enable-gpl") || text.contains("--enable-nonfree");
        }
        // 探测可用编码器（档位 L 据此决定 H.264 走系统硬件编码还是报错引导）。
        if let Ok(out) = Command::new(&ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            let hw = [
                "h264_videotoolbox",
                "h264_nvenc",
                "h264_qsv",
                "h264_amf",
                "h264_vaapi",
                "libx264",
                "libvpx-vp9",
                "libsvtav1",
            ];
            for name in hw {
                if text.contains(name) {
                    p.encoders.push(name.to_string());
                }
            }
            p.hardware_encoder = p.encoders.iter().any(|e| e.starts_with("h264_"));
        }
        // 探测可用解码器（H.264/HEVC/VP9/AV1）。
        if let Ok(out) = Command::new(&ffmpeg)
            .args(["-hide_banner", "-decoders"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for name in ["h264", "hevc", "vp9", "av1"] {
                if text.contains(name) {
                    p.decoders.push(name.to_string());
                }
            }
        }
    }

    if let Some(ffprobe) = sidecar_path("ffprobe") {
        if let Ok(out) = Command::new(&ffprobe)
            .args(["-hide_banner", "-version"])
            .output()
        {
            p.ffprobe_ok = out.status.success();
        }
    }

    p.libreoffice_ok = libreoffice_path().is_some();

    p
}

/// 给前端的精简版（不暴露完整 configure 行，避免泄漏构建环境细节）
pub fn info() -> serde_json::Value {
    let p = probe();
    serde_json::json!({
        "ffmpeg": p.ffmpeg_ok,
        "ffmpegVersion": p.ffmpeg_version,
        "ffprobe": p.ffprobe_ok,
        "libreoffice": p.libreoffice_ok,
        "licenseRisk": p.gpl_risk,
    })
}
