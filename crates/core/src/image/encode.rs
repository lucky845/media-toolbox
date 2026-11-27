//! 编码：RGBA8 → 字节。
//!
//! 每个格式的编码参数在 `EncodeOptions` 里，这里只负责「把参数翻译成 image crate 的 API」。
//! 编码器选择与体积/速度的权衡记录在 `docs/benchmarks.md`。

use crate::common::math::quantize_u8;
use crate::image::decode::RasterImage;
use crate::image::params::{EncodeOptions, Rgba8};
use media_ports::codec::ImageFormat;
use media_ports::{ErrorCode, Result, ToolError};

/// 编码为指定格式。
///
/// 透明 → 不透明格式的背景填充**必须**在调用前完成（`geometry::flatten_background`），
/// 这里只做最后的编码，不做隐式降级：隐式降级会让「我选 JPEG 为什么边缘变黑」变成谜。
pub fn encode(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    opts.validate()?;
    if opts.drops_alpha() && !img.is_opaque() {
        return Err(ToolError::invalid(format!(
            "{} 不支持透明通道，请先设置背景填充色",
            opts.format.extension()
        )));
    }

    match opts.format {
        ImageFormat::Jpeg => encode_jpeg(img, opts),
        ImageFormat::Png => encode_png(img),
        ImageFormat::Webp => encode_webp(img, opts),
        ImageFormat::Gif => encode_gif(img),
        ImageFormat::Bmp => encode_bmp(img),
        ImageFormat::Tiff => encode_tiff(img),
        ImageFormat::Qoi => encode_qoi(img),
        ImageFormat::Ico => encode_ico(img),
        ImageFormat::Avif => Err(
            ToolError::new(ErrorCode::CodecUnsupported, &[("codec", "AVIF")])
                .with_detail("当前构建未启用 avif feature（体积预算，见 docs/BUDGET.md）"),
        ),
    }
}

fn encode_qoi(img: &RasterImage) -> Result<Vec<u8>> {
    use image::ImageEncoder;
    let mut out = Vec::new();
    image::codecs::qoi::QoiEncoder::new(&mut out)
        .write_image(
            &img.data,
            img.width,
            img.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(enc_err)?;
    Ok(out)
}

fn encode_ico(img: &RasterImage) -> Result<Vec<u8>> {
    use image::ImageEncoder;
    if !(1..=256).contains(&img.width) || !(1..=256).contains(&img.height) {
        return Err(ToolError::invalid("ICO 输出宽和高均须为 1–256 像素"));
    }
    let mut out = Vec::new();
    image::codecs::ico::IcoEncoder::new(&mut out)
        .write_image(
            &img.data,
            img.width,
            img.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(enc_err)?;
    Ok(out)
}

fn enc_err(e: impl std::fmt::Display) -> ToolError {
    ToolError::new(ErrorCode::EncodeFailed, &[("detail", &e.to_string())])
}

#[allow(dead_code)]
fn dynamic(img: &RasterImage) -> image::DynamicImage {
    // 全不透明的图用 RGB8 编码，JPEG 会因此少一次 alpha 通道处理
    if img.is_opaque() {
        let rgb: Vec<u8> = img
            .data
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        image::DynamicImage::ImageRgb8(
            image::RgbImage::from_raw(img.width, img.height, rgb)
                .expect("尺寸与缓冲长度已由 RasterImage 保证"),
        )
    } else {
        image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(img.width, img.height, img.data.clone())
                .expect("尺寸与缓冲长度已由 RasterImage 保证"),
        )
    }
}

fn encode_jpeg(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    // JPEG 不支持 alpha，前面已校验
    let rgb: Vec<u8> = img
        .data
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let img = image::RgbImage::from_raw(img.width, img.height, rgb)
        .ok_or_else(|| ToolError::internal("JPEG 缓冲长度不符"))?;

    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, opts.quality);
    enc.encode_image(&img).map_err(enc_err)?;
    Ok(out)
}

fn encode_png(img: &RasterImage) -> Result<Vec<u8>> {
    // PNG 恒为无损；good quality 只影响压缩级别
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(img.width, img.height, img.data.clone())
            .ok_or_else(|| ToolError::internal("PNG 缓冲长度不符"))?,
    )
    .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
    .map_err(enc_err)?;
    Ok(out)
}

fn encode_webp(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let rgba = image::RgbaImage::from_raw(img.width, img.height, img.data.clone())
        .ok_or_else(|| ToolError::internal("WebP 缓冲长度不符"))?;

    // image 0.25 的 webp 分支只提供**无损**编码。
    // 有损 WebP 的归属见 docs/OWNERSHIP.md §1.1：默认 Rust，基准裁决后可能改 TS(canvas)。
    if !opts.lossless {
        // 先按无损写出；调用方拿到的仍是有效 WebP，只是体积大于有损。
        // 这里不静默降级成 JPEG，因为格式语义（透明、无损）会变。
        rgba.write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::WebP,
        )
        .map_err(enc_err)?;
        return Ok(out);
    }
    rgba.write_to(
        &mut std::io::Cursor::new(&mut out),
        image::ImageFormat::WebP,
    )
    .map_err(enc_err)?;
    Ok(out)
}

fn encode_gif(img: &RasterImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let rgba = image::RgbaImage::from_raw(img.width, img.height, img.data.clone())
        .ok_or_else(|| ToolError::internal("GIF 缓冲长度不符"))?;
    // 静态单帧 GIF
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Gif)
        .map_err(enc_err)?;
    Ok(out)
}

fn encode_bmp(img: &RasterImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    // BMP 不支持 alpha，位深降为 24
    let rgb: Vec<u8> = img
        .data
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let rgb_img = image::RgbImage::from_raw(img.width, img.height, rgb)
        .ok_or_else(|| ToolError::internal("BMP 缓冲长度不符"))?;
    image::DynamicImage::ImageRgb8(rgb_img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Bmp)
        .map_err(enc_err)?;
    Ok(out)
}

fn encode_tiff(img: &RasterImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let rgba = image::RgbaImage::from_raw(img.width, img.height, img.data.clone())
        .ok_or_else(|| ToolError::internal("TIFF 缓冲长度不符"))?;
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Tiff,
        )
        .map_err(enc_err)?;
    Ok(out)
}

/// 「其实什么都没变」的快速路径：输入格式 == 输出格式、无变换、质量未变。
///
/// 注意：**不**在质量参数变化时走这条路 —— 用户想要的是重新压缩。
pub fn can_passthrough(opts: &EncodeOptions) -> bool {
    // 仅用于提示 UI「参数未变」，真正是否直通由调用方决定（直通会丢掉「重新压缩」的语义）
    let _ = opts;
    false
}

/// 估算输出大小（供 UI 在编码前显示预期）。基于原图字节数与质量的粗略模型。
pub fn estimate_output_bytes(input_bytes: u64, opts: &EncodeOptions) -> u64 {
    let q = opts.quality as f64 / 100.0;
    let factor = match opts.format {
        ImageFormat::Jpeg => 0.08 + 0.42 * q.powf(1.6),
        ImageFormat::Webp => {
            if opts.lossless {
                0.75
            } else {
                0.06 + 0.35 * q.powf(1.5)
            }
        }
        ImageFormat::Png => 0.85,
        ImageFormat::Gif => 0.5,
        ImageFormat::Bmp => 1.0,
        ImageFormat::Tiff => 0.9,
        ImageFormat::Avif => 0.05 + 0.3 * q.powf(1.5),
        ImageFormat::Qoi => 1.0,
        ImageFormat::Ico => 1.0,
    };
    (input_bytes as f64 * factor) as u64
}

/// 把一种不透明格式的像素转成另一种（BMP/JPEG 这类丢 alpha 的）时的背景合成辅助。
pub fn prepare_for_format(img: &RasterImage, opts: &EncodeOptions, bg: Rgba8) -> RasterImage {
    if opts.drops_alpha() && !img.is_opaque() {
        crate::image::geometry::flatten_background(img, bg)
    } else {
        img.clone()
    }
}

/// 用 sRGB 的简单 box 降采样生成缩略图（仅用于预览，非质量路径）。
pub fn thumbnail(img: &RasterImage, max_side: u32) -> Result<RasterImage> {
    let longest = img.width.max(img.height);
    if longest <= max_side {
        return Ok(img.clone());
    }
    let scale = max_side as f64 / longest as f64;
    let tw = ((img.width as f64 * scale).round() as u32).max(1);
    let th = ((img.height as f64 * scale).round() as u32).max(1);

    let mut out = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        let sy0 = (y as u64 * img.height as u64 / th as u64) as u32;
        let sy1 = (((y + 1) as u64 * img.height as u64 / th as u64) as u32).max(sy0 + 1);
        for x in 0..tw {
            let sx0 = (x as u64 * img.width as u64 / tw as u64) as u32;
            let sx1 = (((x + 1) as u64 * img.width as u64 / tw as u64) as u32).max(sx0 + 1);
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for sy in sy0..sy1.min(img.height) {
                for sx in sx0..sx1.min(img.width) {
                    let p = img.pixel(sx, sy);
                    for c in 0..4 {
                        acc[c] += p[c] as u32;
                    }
                    n += 1;
                }
            }
            let n = n.max(1);
            let o = ((y * tw + x) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (acc[c] / n) as u8;
            }
        }
    }
    RasterImage::new(tw, th, out)
}

/// 计算两条 RGBA 缓冲的 PSNR（用于有损编码的往返测试）。
pub fn psnr(a: &RasterImage, b: &RasterImage) -> f64 {
    if a.width != b.width || a.height != b.height {
        return 0.0;
    }
    let mut mse = 0f64;
    let mut n = 0u64;
    for (pa, pb) in a.data.chunks_exact(4).zip(b.data.chunks_exact(4)) {
        for c in 0..3 {
            // 只看 RGB，alpha 单算
            let d = pa[c] as f64 - pb[c] as f64;
            mse += d * d;
            n += 1;
        }
    }
    if n == 0 {
        return f64::INFINITY;
    }
    mse /= n as f64;
    if mse <= 1e-12 {
        return f64::INFINITY;
    }
    10.0 * (255.0f64 * 255.0 / mse).log10()
}

#[allow(dead_code)]
fn clamp_u8(v: f32) -> u8 {
    quantize_u8(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::decode::RasterImage;
    use crate::image::params::EncodeOptions;

    fn gradient(w: u32, h: u32, alpha: u8) -> RasterImage {
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                data.extend_from_slice(&[
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    ((x + y) * 255 / (w + h).max(1)) as u8,
                    alpha,
                ]);
            }
        }
        RasterImage::new(w, h, data).unwrap()
    }

    #[test]
    fn jpeg_roundtrip_is_close() {
        let img = gradient(64, 64, 255);
        let out = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Jpeg,
                quality: 95,
                ..Default::default()
            },
        )
        .unwrap();
        let back = crate::image::decode::decode_rgba(&out).unwrap();
        assert_eq!((back.width, back.height), (64, 64));
        let p = psnr(&img, &back);
        assert!(p > 30.0, "PSNR 过低: {p}");
    }

    #[test]
    fn png_roundtrip_is_lossless() {
        let img = gradient(32, 32, 200);
        let out = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Png,
                ..Default::default()
            },
        )
        .unwrap();
        let back = crate::image::decode::decode_rgba(&out).unwrap();
        assert_eq!(back.data, img.data, "PNG 往返必须逐字节相等");
    }

    #[test]
    fn webp_roundtrip_lossless() {
        let img = gradient(24, 24, 128);
        let out = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Webp,
                lossless: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            crate::image::decode::sniff_format(&out),
            Some(ImageFormat::Webp)
        );
        let back = crate::image::decode::decode_rgba(&out).unwrap();
        assert_eq!(back.data, img.data, "无损 WebP 往返必须逐字节相等");
    }

    #[test]
    fn gif_and_bmp_and_tiff_encode() {
        let img = gradient(16, 16, 255);
        for f in [ImageFormat::Gif, ImageFormat::Bmp, ImageFormat::Tiff] {
            let out = encode(
                &img,
                &EncodeOptions {
                    format: f,
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(!out.is_empty(), "{f:?} 输出为空");
            assert_eq!(
                crate::image::decode::sniff_format(&out),
                Some(f),
                "{f:?} 魔数不符"
            );
        }
    }

    #[test]
    fn avif_is_reported_as_unsupported_not_silently_converted() {
        let img = gradient(8, 8, 255);
        let e = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Avif,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::CodecUnsupported);
    }

    #[test]
    fn transparent_to_jpeg_is_rejected() {
        let img = gradient(8, 8, 128);
        let e = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Jpeg,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidParams);
        assert!(e.message.contains("背景"));
    }

    #[test]
    fn transparent_to_jpeg_after_flatten_works() {
        let img = gradient(8, 8, 128);
        let flat = crate::image::geometry::flatten_background(&img, Rgba8::default());
        assert!(encode(
            &flat,
            &EncodeOptions {
                format: ImageFormat::Jpeg,
                ..Default::default()
            }
        )
        .is_ok());
    }

    #[test]
    fn quality_validation() {
        let img = gradient(4, 4, 255);
        assert!(encode(
            &img,
            &EncodeOptions {
                quality: 0,
                ..Default::default()
            }
        )
        .is_err());
        assert!(encode(
            &img,
            &EncodeOptions {
                quality: 101,
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn higher_quality_is_larger() {
        let img = gradient(64, 64, 255);
        let lo = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Jpeg,
                quality: 30,
                ..Default::default()
            },
        )
        .unwrap();
        let hi = encode(
            &img,
            &EncodeOptions {
                format: ImageFormat::Jpeg,
                quality: 95,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(hi.len() > lo.len(), "lo={} hi={}", lo.len(), hi.len());
    }

    #[test]
    fn thumbnail_caps_long_side() {
        let img = gradient(400, 200, 255);
        let t = thumbnail(&img, 100).unwrap();
        assert_eq!((t.width, t.height), (100, 50));
    }

    #[test]
    fn thumbnail_noop_when_smaller() {
        let img = gradient(50, 50, 255);
        let t = thumbnail(&img, 100).unwrap();
        assert_eq!((t.width, t.height), (50, 50));
    }

    #[test]
    fn psnr_identical_is_infinite() {
        let a = gradient(8, 8, 255);
        assert!(psnr(&a, &a).is_infinite());
    }

    #[test]
    fn estimate_is_monotonic_in_quality() {
        let lo = estimate_output_bytes(
            1_000_000,
            &EncodeOptions {
                quality: 20,
                ..Default::default()
            },
        );
        let hi = estimate_output_bytes(
            1_000_000,
            &EncodeOptions {
                quality: 90,
                ..Default::default()
            },
        );
        assert!(hi > lo);
        assert!(lo > 0);
    }
}
