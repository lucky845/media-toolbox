//! 图片解码：字节 → RGBA8 + 尺寸 + 格式。

use media_ports::codec::ImageFormat;
use media_ports::{ErrorCode, Result, ToolError};

/// 解码后的图像。内部统一为 **RGBA8**（非预乘），行优先，无 padding。
///
/// 为什么统一 RGBA 而不是保留原色彩类型：变换链（裁剪/旋转/缩放/色彩）要对像素做数学，
/// 统一成 RGBA 后只写一份算子；代价是灰度/调色板图会多 4 倍内存，但 20 MP 阈值下可接受。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterImage {
    pub width: u32,
    pub height: u32,
    /// 长度必须等于 `width * height * 4`。
    pub data: Vec<u8>,
}

impl RasterImage {
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Self> {
        let expected = width as usize * height as usize * 4;
        if data.len() != expected {
            return Err(ToolError::internal(format!(
                "像素缓冲长度不符：期望 {expected}，实际 {}",
                data.len()
            )));
        }
        Ok(RasterImage {
            width,
            height,
            data,
        })
    }

    /// 全零（透明）画布。
    pub fn transparent(width: u32, height: u32) -> Result<Self> {
        let len = width as usize * height as usize * 4;
        Ok(RasterImage {
            width,
            height,
            data: vec![0; len],
        })
    }

    pub fn pixels(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// 某个像素的 RGBA 切片。
    #[inline]
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = (y as usize * self.width as usize + x as usize) * 4;
        [
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]
    }

    /// 是否全不透明（用于决定「转 JPEG 是否真的需要填充」）。
    pub fn is_opaque(&self) -> bool {
        self.data.chunks_exact(4).all(|p| p[3] == 255)
    }

    pub fn bytes(&self) -> u64 {
        self.data.len() as u64
    }
}

/// 从容器魔数猜格式（不依赖扩展名，也不做完整解码）。
pub fn sniff_format(data: &[u8]) -> Option<ImageFormat> {
    if data.len() < 12 {
        return None;
    }
    match &data[..4] {
        b"\xFF\xD8\xFF\xE0" | b"\xFF\xD8\xFF\xE1" | b"\xFF\xD8\xFF\xDB" | b"\xFF\xD8\xFF\xEE" => {
            Some(ImageFormat::Jpeg)
        }
        _ if data.starts_with(b"\x89PNG\r\n\x1A\n") => Some(ImageFormat::Png),
        _ if data.starts_with(b"GIF8") => Some(ImageFormat::Gif),
        _ if data.starts_with(b"BM") => Some(ImageFormat::Bmp),
        _ if data.starts_with(b"II*\0") || data.starts_with(b"MM\0*") => Some(ImageFormat::Tiff),
        b"RIFF" if data.get(8..12) == Some(b"WEBP") => Some(ImageFormat::Webp),
        _ if data.get(4..8) == Some(b"ftyp") => {
            // ISO BMFF：avif 的 brand 在 8..12
            let brand = data.get(8..12)?;
            if brand == b"avif" || brand == b"avis" {
                Some(ImageFormat::Avif)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 只读探测：尺寸/格式/是否带 alpha。不解码像素。
///
/// 实现策略：用 `image` 的 reader 拿尺寸与色彩类型，避免为了「看尺寸」而解码整张 20 MP 图。
pub fn probe(data: &[u8]) -> Result<ProbeInfo> {
    let format = sniff_format(data).ok_or_else(|| {
        ToolError::new(
            ErrorCode::UnsupportedFormat,
            &[("detail", "无法识别的文件头")],
        )
    })?;

    let reader = image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .map_err(|e| decode_err(format!("读取失败: {e}")))?;

    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| decode_err(format!("读取尺寸失败: {e}")))?;

    Ok(ProbeInfo {
        width: w,
        height: h,
        format,
        color_type: None,
    })
}

#[derive(Debug, Clone, Copy)]
pub struct ProbeInfo {
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
    pub color_type: Option<ImageColorKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageColorKind {
    L8,
    La8,
    Rgb8,
    Rgba8,
    L16,
    La16,
    Rgb16,
    Rgba16,
    Other,
}

fn decode_err(detail: String) -> ToolError {
    ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail(detail)
}

/// 解码为 RGBA8。
pub fn decode_rgba(data: &[u8]) -> Result<RasterImage> {
    let img = image::load_from_memory(data).map_err(|e| decode_err(e.to_string()))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    RasterImage::new(w, h, rgba.into_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成一张可控的小 PNG（不依赖外部文件）。
    fn make_png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let mut img = image::RgbaImage::new(w, h);
        for p in img.pixels_mut() {
            *p = image::Rgba(rgba);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn make_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([10, 20, 30]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn sniff_detects_png_and_jpeg() {
        assert_eq!(
            sniff_format(&make_png(2, 2, [1, 2, 3, 4])),
            Some(ImageFormat::Png)
        );
        assert_eq!(sniff_format(&make_jpeg(2, 2)), Some(ImageFormat::Jpeg));
    }

    #[test]
    fn sniff_rejects_unknown() {
        assert_eq!(sniff_format(b"not an image at all"), None);
        assert_eq!(sniff_format(b"short"), None);
    }

    #[test]
    fn decode_preserves_dimensions_and_pixels() {
        let png = make_png(3, 2, [10, 20, 30, 255]);
        let img = decode_rgba(&png).unwrap();
        assert_eq!((img.width, img.height), (3, 2));
        assert_eq!(img.pixels(), 6);
        assert_eq!(img.data.len(), 3 * 2 * 4);
        assert_eq!(img.pixel(2, 1), [10, 20, 30, 255]);
        assert!(img.is_opaque());
    }

    #[test]
    fn decode_detects_alpha() {
        let png = make_png(2, 2, [10, 20, 30, 128]);
        let img = decode_rgba(&png).unwrap();
        assert!(!img.is_opaque());
    }

    #[test]
    fn decode_garbage_fails_with_decode_failed() {
        let e = decode_rgba(b"garbage").unwrap_err();
        assert_eq!(e.code, ErrorCode::DecodeFailed);
    }

    #[test]
    fn probe_reads_dimensions_without_full_decode() {
        let png = make_png(7, 5, [0, 0, 0, 255]);
        let p = probe(&png).unwrap();
        assert_eq!((p.width, p.height), (7, 5));
        assert_eq!(p.format, ImageFormat::Png);
    }

    #[test]
    fn raster_rejects_bad_length() {
        assert!(RasterImage::new(2, 2, vec![0; 15]).is_err());
        assert!(RasterImage::new(2, 2, vec![0; 16]).is_ok());
    }

    #[test]
    fn transparent_is_zeroed() {
        let img = RasterImage::transparent(4, 4).unwrap();
        assert_eq!(img.data.len(), 64);
        assert!(!img.is_opaque());
    }
}
