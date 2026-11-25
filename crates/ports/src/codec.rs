//! 编解码能力与单位格式化。
//!
//! `CodecProvider` 让「这台机器/这个浏览器支持什么」成为数据，而不是 `cfg` 分支。
//! `human_bytes` 放在这里是因为 core 的错误文案需要它，而格式化逻辑不该在 `error.rs` 里。

use serde::{Deserialize, Serialize};

/// 图片输出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
    Png,
    Webp,
    Avif,
    Gif,
    Bmp,
    Tiff,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Png => "png",
            ImageFormat::Webp => "webp",
            ImageFormat::Avif => "avif",
            ImageFormat::Gif => "gif",
            ImageFormat::Bmp => "bmp",
            ImageFormat::Tiff => "tiff",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Png => "image/png",
            ImageFormat::Webp => "image/webp",
            ImageFormat::Avif => "image/avif",
            ImageFormat::Gif => "image/gif",
            ImageFormat::Bmp => "image/bmp",
            ImageFormat::Tiff => "image/tiff",
        }
    }

    /// 该格式是否支持 alpha 通道。透明图转不支持的格式时必须填充背景。
    pub fn supports_alpha(self) -> bool {
        matches!(
            self,
            ImageFormat::Png
                | ImageFormat::Webp
                | ImageFormat::Avif
                | ImageFormat::Gif
                | ImageFormat::Tiff
        )
    }

    /// 该格式是否有损（无损格式忽略 quality 参数）。
    pub fn is_lossy(self) -> bool {
        matches!(
            self,
            ImageFormat::Jpeg | ImageFormat::Webp | ImageFormat::Avif
        )
    }
}

/// 某个形态的编解码能力集合。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecFormats {
    pub image_decode: Vec<ImageFormat>,
    pub image_encode: Vec<ImageFormat>,
    /// wasm 端 avif 是否编进包（受体积预算影响）。
    pub avif_enabled: bool,
    /// png 无损优化是否可用。
    pub png_optimize: bool,
}

impl CodecFormats {
    pub fn can_encode(&self, f: ImageFormat) -> bool {
        self.image_encode.contains(&f)
    }

    pub fn can_decode(&self, f: ImageFormat) -> bool {
        self.image_decode.contains(&f)
    }
}

/// 编解码能力提供者。两壳各自返回自己的真实能力。
pub trait CodecProvider: Sync {
    fn formats(&self) -> CodecFormats;
}

/// Web 轻量形态的默认能力（avif 编码与 oxipng 默认关闭，Phase 1 实测后再开）。
pub struct WebCodecs;

impl CodecProvider for WebCodecs {
    fn formats(&self) -> CodecFormats {
        CodecFormats {
            image_decode: vec![
                ImageFormat::Jpeg,
                ImageFormat::Png,
                ImageFormat::Webp,
                ImageFormat::Gif,
                ImageFormat::Bmp,
                ImageFormat::Tiff,
            ],
            image_encode: vec![
                ImageFormat::Jpeg,
                ImageFormat::Png,
                ImageFormat::Webp,
                ImageFormat::Gif,
                ImageFormat::Bmp,
                ImageFormat::Tiff,
            ],
            avif_enabled: false,
            png_optimize: false,
        }
    }
}

/// 桌面形态的默认能力。
pub struct DesktopCodecs;

impl CodecProvider for DesktopCodecs {
    fn formats(&self) -> CodecFormats {
        CodecFormats {
            image_decode: vec![
                ImageFormat::Jpeg,
                ImageFormat::Png,
                ImageFormat::Webp,
                ImageFormat::Avif,
                ImageFormat::Gif,
                ImageFormat::Bmp,
                ImageFormat::Tiff,
            ],
            image_encode: vec![
                ImageFormat::Jpeg,
                ImageFormat::Png,
                ImageFormat::Webp,
                ImageFormat::Avif,
                ImageFormat::Gif,
                ImageFormat::Bmp,
                ImageFormat::Tiff,
            ],
            avif_enabled: true,
            png_optimize: true,
        }
    }
}

/// 人类可读的字节数。用于错误文案与 UI 展示（UI 侧另有 TS 实现，但错误文案必须由 Rust 生成）。
///
/// ```
/// use media_ports::codec::human_bytes;
/// assert_eq!(human_bytes(0), "0 B");
/// assert_eq!(human_bytes(1024), "1.0 KB");
/// assert_eq!(human_bytes(20 * 1024 * 1024), "20.0 MB");
/// ```
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut v = n as f64;
    let mut i = 0usize;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{:.1} {}", v, UNITS[i])
}

/// 人类可读的时长（秒 → 5 分钟 / 1 小时 30 分）。
pub fn human_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs} 秒")
    } else if secs < 3600 {
        let m = secs / 60;
        let s = secs % 60;
        if s == 0 {
            format!("{m} 分钟")
        } else {
            format!("{m} 分 {s} 秒")
        }
    } else {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        format!("{h} 小时 {m} 分")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_support_matrix() {
        assert!(ImageFormat::Png.supports_alpha());
        assert!(!ImageFormat::Jpeg.supports_alpha());
        assert!(!ImageFormat::Bmp.supports_alpha());
    }

    #[test]
    fn lossy_matrix() {
        assert!(ImageFormat::Jpeg.is_lossy());
        assert!(ImageFormat::Webp.is_lossy());
        assert!(!ImageFormat::Png.is_lossy());
    }

    #[test]
    fn format_lookup_is_consistent() {
        assert!(WebCodecs.formats().can_encode(ImageFormat::Jpeg));
        assert!(!WebCodecs.formats().can_encode(ImageFormat::Avif));
        assert!(DesktopCodecs.formats().can_encode(ImageFormat::Avif));
    }

    #[test]
    fn human_bytes_boundaries() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(20 * 1024 * 1024), "20.0 MB");
        assert_eq!(human_bytes(1024 * 1024 * 1024), "1.0 GB");
    }

    #[test]
    fn human_duration_boundaries() {
        assert_eq!(human_duration(45), "45 秒");
        assert_eq!(human_duration(300), "5 分钟");
        assert_eq!(human_duration(90), "1 分 30 秒");
        assert_eq!(human_duration(5400), "1 小时 30 分");
    }
}
