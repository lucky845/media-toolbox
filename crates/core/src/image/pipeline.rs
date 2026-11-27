//! 图片流水线：把 decode → 变换 → encode 串起来。
//!
//! 顺序固定（`docs/CONTRACTS.md` §2.2）：
//! `解码 → EXIF 规整 → 裁剪 → 旋转/翻转 → 缩放 → 色彩调整 → 背景填充 → 编码`
//!
//! **顺序不能改**：先旋转再裁剪与先裁剪再旋转会得到不同结果（裁剪坐标是规整后坐标系的）。

use crate::common::hash::blake3_hex;
use crate::common::limits_check::{
    check_bytes, check_memory_estimate, check_pixels, estimate_image_peak,
};
use crate::image::decode::{decode_rgba, probe, sniff_format, RasterImage};
use crate::image::encode::{encode, prepare_for_format};
use crate::image::geometry::{apply_orientation, crop, fill_canvas, flip, rotate};
use crate::image::params::{EncodeOptions, ImageMeta, ImageParams, ImageResult};
use crate::image::resize::{resize, ResizeCtx};
use media_ports::codec::{human_bytes, ImageFormat};
use media_ports::{
    CancelToken, ErrorCode, Limits, Parallel, Phase, Progress, ProgressSink, Result, ToolError,
    Unit,
};

/// 一次处理所需的全部外部依赖。`core` 不持有它们，只借用。
pub struct Ctx<'a, P: Parallel> {
    pub parallel: &'a P,
    pub progress: &'a dyn ProgressSink,
    pub cancel: &'a dyn CancelToken,
    pub limits: &'a Limits,
}

/// 只读探测（不解码像素），用于 UI 在用户选中文件后立即显示信息与阈值判定。
pub fn probe_image(data: &[u8], limits: &Limits) -> Result<ImageMeta> {
    check_bytes(data.len() as u64, limits)?;

    let info = probe(data)?;
    check_pixels(info.width, info.height, limits)?;

    let peak = estimate_image_peak(info.width, info.height, data.len() as u64);
    check_memory_estimate(peak, limits)?;

    #[cfg(feature = "exif")]
    let orientation = crate::image::exif::read_orientation(data);
    #[cfg(not(feature = "exif"))]
    let orientation = 1u8;

    // 是否带 alpha：只有 PNG/WebP/AVIF/TIFF/GIF 可能带；JPEG/BMP 恒不带
    let has_alpha = matches!(
        info.format,
        ImageFormat::Png
            | ImageFormat::Webp
            | ImageFormat::Avif
            | ImageFormat::Tiff
            | ImageFormat::Gif
    );

    Ok(ImageMeta {
        width: info.width,
        height: info.height,
        format: info.format.extension().to_string(),
        has_alpha,
        exif_orientation: orientation,
        bytes: data.len() as u64,
        peak_memory_estimate: peak,
    })
}

fn validate_image_params(params: &ImageParams, input_bytes: u64, limits: &Limits) -> Result<()> {
    params.validate()?;
    if let Some(canvas) = params.canvas {
        check_pixels(canvas.width, canvas.height, limits)?;
        let peak = estimate_image_peak(canvas.width, canvas.height, input_bytes);
        check_memory_estimate(peak, limits)?;
    }
    Ok(())
}

/// 完整处理：字节进，字节出。
pub fn process_image<P: Parallel>(
    input: &[u8],
    params: &ImageParams,
    opts: &EncodeOptions,
    ctx: &Ctx<'_, P>,
) -> Result<ImageResult> {
    // ---- 0. 前置校验（任何一项失败都在解码前返回）----
    let input_bytes = input.len() as u64;
    check_bytes(input_bytes, ctx.limits)?;
    validate_image_params(params, input_bytes, ctx.limits)?;
    opts.validate()?;

    // ---- 1. 探测 ----
    let info = probe(input)?;
    check_pixels(info.width, info.height, ctx.limits)?;
    let peak = estimate_image_peak(info.width, info.height, input_bytes);
    check_memory_estimate(peak, ctx.limits)?;

    ctx.progress
        .report(Progress::new(0, 1, Phase::Decoding, Unit::Percent));
    ctx.cancel.check().map_err(|_| ToolError::cancelled())?;

    // ---- 2. 解码 ----
    let mut img = decode_rgba(input)?;

    // ---- 3. EXIF 方向规整 ----
    #[cfg(feature = "exif")]
    if params.apply_exif_orientation {
        let orientation = crate::image::exif::read_orientation(input);
        if orientation != 1 {
            img = apply_orientation(&img, orientation)?;
        }
    }

    // ---- 4. 裁剪 ----
    if let Some(c) = params.crop {
        img = crop(&img, c)?;
    }

    // ---- 5. 旋转 / 翻转 ----
    img = rotate(&img, params.rotate)?;
    img = flip(&img, params.flip)?;

    // ---- 6. 缩放 ----
    if let Some(r) = &params.resize {
        if let Some((tw, th)) = r.target_size(img.width, img.height) {
            let rc = ResizeCtx::silent(ctx.progress);
            img = resize(&img, tw, th, r.filter, ctx.parallel, &rc)?;
        }
    }

    // ---- 7. 色彩调整 ----
    if let Some(a) = &params.adjust {
        img = crate::image::colorops::adjust(&img, a);
    }
    if let Some(canvas) = params.canvas {
        img = fill_canvas(&img, canvas)?;
    }

    ctx.cancel.check().map_err(|_| ToolError::cancelled())?;
    ctx.progress
        .report(Progress::new(0, 1, Phase::Encoding, Unit::Percent));

    // ---- 8. 背景填充（目标格式不支持 alpha 时）----
    img = prepare_for_format(&img, opts, params.background);

    // ---- 9. 编码 ----
    let mut out = encode(&img, opts)?;

    // ---- 10. 元数据处理 ----
    if !opts.keep_metadata {
        #[cfg(feature = "exif")]
        if sniff_format(&out) == Some(ImageFormat::Jpeg) {
            out = crate::image::exif::strip_jpeg_metadata(&out).unwrap_or(out);
        }
    }

    ctx.progress
        .report(Progress::new(1, 1, Phase::Finalizing, Unit::Percent));

    let output_bytes = out.len() as u64;
    let output_hash = blake3_hex(&out);

    Ok(ImageResult {
        output: out,
        out_format: opts.format,
        out_width: img.width,
        out_height: img.height,
        input_bytes,
        output_bytes,
        output_hash,
    })
}

/// 便捷函数：只做「压缩」（无几何/色彩变换），是最常用的路径。
pub fn compress<P: Parallel>(
    input: &[u8],
    opts: &EncodeOptions,
    ctx: &Ctx<'_, P>,
) -> Result<ImageResult> {
    process_image(input, &ImageParams::default(), opts, ctx)
}

/// 输出文件名生成：`{原名}-{摘要}.{ext}`，重名由调用方加序号。
pub fn output_name(
    original_stem: &str,
    params: &ImageParams,
    opts: &EncodeOptions,
) -> Result<String> {
    let digest = crate::common::hash::params_digest(&(params, opts))?;
    Ok(format!(
        "{original_stem}-{digest}.{}",
        opts.format.extension()
    ))
}

/// 体积节省比例（0.0..=1.0；变大时为负）。
pub fn savings_ratio(input_bytes: u64, output_bytes: u64) -> f64 {
    if input_bytes == 0 {
        return 0.0;
    }
    (input_bytes as f64 - output_bytes as f64) / input_bytes as f64
}

/// 人类可读的「体积变化」文案，用于 UI 常驻显示。
pub fn savings_text(input_bytes: u64, output_bytes: u64) -> String {
    let r = savings_ratio(input_bytes, output_bytes);
    if r.abs() < 0.005 {
        format!("体积基本不变（{}）", human_bytes(output_bytes))
    } else if r > 0.0 {
        format!(
            "节省 {:.0}%：{} → {}",
            r * 100.0,
            human_bytes(input_bytes),
            human_bytes(output_bytes)
        )
    } else {
        format!(
            "增大 {:.0}%：{} → {}",
            -r * 100.0,
            human_bytes(input_bytes),
            human_bytes(output_bytes)
        )
    }
}

/// 检查输入是否可被本构解码（用于批量队列的前置过滤，避免入队后才发现不支持）。
pub fn is_supported_input(data: &[u8]) -> bool {
    matches!(
        sniff_format(data),
        Some(
            ImageFormat::Jpeg
                | ImageFormat::Png
                | ImageFormat::Webp
                | ImageFormat::Gif
                | ImageFormat::Bmp
                | ImageFormat::Tiff
        )
    )
}

/// 把明确的「不支持」情况转成带格式名的错误。
pub fn require_supported_input(data: &[u8]) -> Result<ImageFormat> {
    sniff_format(data).ok_or_else(|| {
        ToolError::new(
            ErrorCode::UnsupportedFormat,
            &[("detail", "无法识别的文件头")],
        )
    })
}

/// 两阶段调用（wasm 侧取消粒度需要）：阶段 0 = 解码+变换，阶段 1 = 编码。
/// 单线程 wasm 里 JS 无法在同步调用中打断，所以拆成两次调用，中间有机会检查取消标志。
pub fn process_stage_decode<P: Parallel>(
    input: &[u8],
    params: &ImageParams,
    ctx: &Ctx<'_, P>,
) -> Result<RasterImage> {
    check_bytes(input.len() as u64, ctx.limits)?;
    validate_image_params(params, input.len() as u64, ctx.limits)?;
    let info = probe(input)?;
    check_pixels(info.width, info.height, ctx.limits)?;

    let mut img = decode_rgba(input)?;
    #[cfg(feature = "exif")]
    if params.apply_exif_orientation {
        let o = crate::image::exif::read_orientation(input);
        if o != 1 {
            img = apply_orientation(&img, o)?;
        }
    }
    if let Some(c) = params.crop {
        img = crop(&img, c)?;
    }
    img = rotate(&img, params.rotate)?;
    img = flip(&img, params.flip)?;
    if let Some(r) = &params.resize {
        if let Some((tw, th)) = r.target_size(img.width, img.height) {
            img = resize(
                &img,
                tw,
                th,
                r.filter,
                ctx.parallel,
                &ResizeCtx::silent(ctx.progress),
            )?;
        }
    }
    if let Some(a) = &params.adjust {
        img = crate::image::colorops::adjust(&img, a);
    }
    if let Some(canvas) = params.canvas {
        img = fill_canvas(&img, canvas)?;
    }
    Ok(img)
}
