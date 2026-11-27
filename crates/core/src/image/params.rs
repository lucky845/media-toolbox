//! 图片参数与结果结构。全部 `serde` 表示与 `docs/CONTRACTS.md` §2.2 一致。

use media_ports::codec::ImageFormat;
use serde::{Deserialize, Serialize};

/// Lanczos 的 lobe 数。3 = 经典 Lanczos3；2 = 更柔和、振铃更少。
///
/// 这个常量存在的两个理由：
/// 1. 它本来就应该是一个具名常量（而不是散落在核函数里的字面量 `3.0`）；
/// 2. 它让 `scripts/verify-single-source.mjs` 能通过「改一个常量」来演示
///    「一处改动同时影响 Web 与桌面」—— 而不必用脆弱的正则改写表达式
///    （那种做法在 `cargo fmt` 之后就会失效，我们踩过两次）。
pub const LANCZOS_LOBES: i32 = 3;

/// 缩放滤波核。**这是 Phase 1 演示「改一处两端生效」的那个枚举**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    /// 最近邻：最快，块状锯齿，仅适合像素风/二值图。
    Nearest,
    /// 三角形（线性）：速度快，质量尚可。
    Triangle,
    /// Catmull-Rom：三次卷积，比 Lanczos 锐利度略低但不振铃。
    CatmullRom,
    /// 高斯：柔和，适合缩小照片。
    Gaussian,
    /// Lanczos3：默认。锐利，可能在高对比边缘产生轻微振铃。
    #[default]
    Lanczos3,
}

impl Filter {
    /// 核半径（以输入像素为单位）。
    pub fn support(self) -> f32 {
        match self {
            Filter::Nearest => 0.5,
            Filter::Triangle => 1.0,
            Filter::CatmullRom | Filter::Gaussian => 2.0,
            Filter::Lanczos3 => LANCZOS_LOBES as f32,
        }
    }

    /// 核函数本体。`x` 已按缩放因子归一化。
    #[inline]
    pub fn kernel(self, x: f32) -> f32 {
        let x = x.abs();
        match self {
            Filter::Nearest => {
                if x < 0.5 {
                    1.0
                } else {
                    0.0
                }
            }
            Filter::Triangle => {
                if x < 1.0 {
                    1.0 - x
                } else {
                    0.0
                }
            }
            Filter::CatmullRom => {
                // Mitchell-Netravali 的 B=0, C=0.5
                if x < 1.0 {
                    1.5 * x * x * x - 2.5 * x * x + 1.0
                } else if x < 2.0 {
                    -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0
                } else {
                    0.0
                }
            }
            Filter::Gaussian => {
                // sigma = 0.5（支撑半径 2.0 截断）
                // 用确定性 exp：实测 libm 与 wasm 的 exp 有 ULP 级差异，
                // 会让双端输出的 PNG 完全不同（见 common::trig 的文档）
                if x < 2.0 {
                    crate::common::trig::exp(-2.0 * x * x)
                } else {
                    0.0
                }
            }
            Filter::Lanczos3 => {
                // 用确定性 sin：这是双端一致性失败的**根因**（实测差异 6e-8，见 docs/benchmarks.md B0）
                let l = LANCZOS_LOBES as f32;
                if x < 0.001 {
                    1.0
                } else if x < l {
                    let px = std::f32::consts::PI * x;
                    l * crate::common::trig::sin(px) * crate::common::trig::sin(px / l) / (px * px)
                } else {
                    0.0
                }
            }
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Filter::Nearest => "nearest",
            Filter::Triangle => "triangle",
            Filter::CatmullRom => "catmull_rom",
            Filter::Gaussian => "gaussian",
            Filter::Lanczos3 => "lanczos3",
        }
    }
}

/// 缩放模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ResizeMode {
    /// 保持宽高比，塞进框内（可能小于框）。
    #[default]
    Fit,
    /// 保持宽高比，填满框后裁剪多余部分。
    Fill,
    /// 拉伸到精确尺寸（破坏比例）。
    Exact,
}

/// 缩放参数。`width` / `height` 至少给一个；都给时按 `mode` 解释。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resize {
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub mode: ResizeMode,
    #[serde(default)]
    pub filter: Filter,
    #[serde(default)]
    pub allow_upscale: bool,
}

impl Resize {
    pub fn exact(w: u32, h: u32) -> Self {
        Resize {
            width: Some(w),
            height: Some(h),
            mode: ResizeMode::Exact,
            filter: Filter::default(),
            allow_upscale: false,
        }
    }

    pub fn fit(w: Option<u32>, h: Option<u32>) -> Self {
        Resize {
            width: w,
            height: h,
            mode: ResizeMode::Fit,
            filter: Filter::default(),
            allow_upscale: false,
        }
    }

    /// 校验：至少一个维度，且都不为 0。
    pub fn validate(&self) -> media_ports::Result<()> {
        if self.width.is_none() && self.height.is_none() {
            return Err(media_ports::ToolError::invalid(
                "缩放需要至少指定宽度或高度",
            ));
        }
        if self.width == Some(0) || self.height == Some(0) {
            return Err(media_ports::ToolError::invalid("缩放尺寸不能为 0"));
        }
        Ok(())
    }

    /// 计算目标尺寸。返回 `(w, h)`，同样尺寸时返回 `None`（调用方可跳过缩放）。
    pub fn target_size(&self, src_w: u32, src_h: u32) -> Option<(u32, u32)> {
        let sw = src_w as f64;
        let sh = src_h as f64;
        let (tw, th) = match (self.width, self.height) {
            (Some(w), Some(h)) => match self.mode {
                ResizeMode::Exact => (w as f64, h as f64),
                ResizeMode::Fit | ResizeMode::Fill => {
                    // Fit：塞进框（取较小缩放比）；Fill：填满框（取较大缩放比）
                    let scale = if self.mode == ResizeMode::Fit {
                        (w as f64 / sw).min(h as f64 / sh)
                    } else {
                        (w as f64 / sw).max(h as f64 / sh)
                    };
                    (sw * scale, sh * scale)
                }
            },
            (Some(w), None) => {
                let scale = w as f64 / sw;
                (w as f64, sh * scale)
            }
            (None, Some(h)) => {
                let scale = h as f64 / sh;
                (sw * scale, h as f64)
            }
            (None, None) => return None,
        };

        // Fill 模式先按尺寸放大再裁剪，所以目标框就是精确尺寸
        let (tw, th) = if self.mode == ResizeMode::Fill {
            match (self.width, self.height) {
                (Some(w), Some(h)) => (w as f64, h as f64),
                _ => (tw, th),
            }
        } else {
            (tw, th)
        };

        let mut ow = tw.round().max(1.0) as u32;
        let mut oh = th.round().max(1.0) as u32;

        if !self.allow_upscale && (ow > src_w || oh > src_h) {
            // 不允许放大：等比缩到不超过原尺寸
            let k = (src_w as f64 / ow as f64).min(src_h as f64 / oh as f64);
            ow = (ow as f64 * k).round().max(1.0) as u32;
            oh = (oh as f64 * k).round().max(1.0) as u32;
        }

        if ow == src_w && oh == src_h {
            None
        } else {
            Some((ow, oh))
        }
    }
}

/// 裁剪区域（左上角 + 尺寸），坐标系为**已按 EXIF 规整后**的图像。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Crop {
    pub fn validate(&self) -> media_ports::Result<()> {
        if self.width == 0 || self.height == 0 {
            return Err(media_ports::ToolError::invalid("裁剪区域不能为 0"));
        }
        Ok(())
    }

    /// 把裁剪框夹进图像内；完全越界时返回错误。
    pub fn clamp_to(&self, w: u32, h: u32) -> media_ports::Result<Crop> {
        if self.x >= w || self.y >= h {
            return Err(media_ports::ToolError::invalid(format!(
                "裁剪起点 ({}, {}) 超出图像范围 {w}×{h}",
                self.x, self.y
            )));
        }
        Ok(Crop {
            x: self.x,
            y: self.y,
            width: self.width.min(w - self.x),
            height: self.height.min(h - self.y),
        })
    }
}

/// 旋转。以 90° 为单位，避免任意角度的插值与边界问题。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Rotation {
    #[default]
    None,
    Cw90,
    Cw180,
    Cw270,
}

/// 翻转。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Flip {
    #[default]
    None,
    H,
    V,
    Both,
}

/// 色彩调整。`1.0` 表示不变，范围 `[0, 4]`。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Adjust {
    #[serde(default = "one")]
    pub brightness: f32,
    #[serde(default = "one")]
    pub contrast: f32,
    #[serde(default = "one")]
    pub saturation: f32,
}

fn one() -> f32 {
    1.0
}

impl Default for Adjust {
    fn default() -> Self {
        Adjust {
            brightness: 1.0,
            contrast: 1.0,
            saturation: 1.0,
        }
    }
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        (self.brightness - 1.0).abs() < 1e-6
            && (self.contrast - 1.0).abs() < 1e-6
            && (self.saturation - 1.0).abs() < 1e-6
    }

    pub fn validate(&self) -> media_ports::Result<()> {
        for (name, v) in [
            ("brightness", self.brightness),
            ("contrast", self.contrast),
            ("saturation", self.saturation),
        ] {
            if !v.is_finite() || !(0.0..=4.0).contains(&v) {
                return Err(media_ports::ToolError::invalid(format!(
                    "{name} 必须在 0 到 4 之间（1.0 为不变），当前 {v}"
                )));
            }
        }
        Ok(())
    }
}

/// 背景填充色（RGBA）。透明图转不支持 alpha 的格式时使用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Default for Rgba8 {
    fn default() -> Self {
        // 默认纯白：JPEG 不支持透明，白色是绝大多数文档场景的期望
        Rgba8 {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        }
    }
}

/// 居中扩展画布，保留图片像素尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFill {
    pub width: u32,
    pub height: u32,
    pub background: Rgba8,
}

/// 图片处理参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resize: Option<Resize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    #[serde(default)]
    pub rotate: Rotation,
    #[serde(default)]
    pub flip: Flip,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjust: Option<Adjust>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas: Option<CanvasFill>,
    #[serde(default = "default_true")]
    pub apply_exif_orientation: bool,
    #[serde(default)]
    pub background: Rgba8,
}

fn default_true() -> bool {
    true
}

impl Default for ImageParams {
    fn default() -> Self {
        ImageParams {
            resize: None,
            crop: None,
            rotate: Rotation::None,
            flip: Flip::None,
            adjust: None,
            canvas: None,
            apply_exif_orientation: true,
            background: Rgba8::default(),
        }
    }
}

impl ImageParams {
    /// 全默认参数 = 仅重编码（压缩/格式转换）。
    pub fn validate(&self) -> media_ports::Result<()> {
        if let Some(r) = &self.resize {
            r.validate()?;
        }
        if let Some(c) = &self.crop {
            c.validate()?;
        }
        if let Some(a) = &self.adjust {
            a.validate()?;
        }
        if let Some(canvas) = self.canvas {
            if canvas.width == 0 || canvas.height == 0 {
                return Err(media_ports::ToolError::invalid("画布宽度和高度必须大于 0"));
            }
        }
        Ok(())
    }

    /// 是否只做重编码（可走快速路径：不转 RGBA，直接原样重编码）。
    pub fn is_passthrough(&self) -> bool {
        self.resize.is_none()
            && self.crop.is_none()
            && self.canvas.is_none()
            && self.rotate == Rotation::None
            && self.flip == Flip::None
            && self.adjust.as_ref().is_none_or(|a| a.is_identity())
    }
}

/// 编码参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncodeOptions {
    pub format: ImageFormat,
    /// 1..=100。无损格式忽略。
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// 无损开关（png 恒为无损；webp/avif 有效）。
    #[serde(default)]
    pub lossless: bool,
    /// 是否保留元数据（EXIF/GPS/ICC）。**默认 false**：默认剥掉。
    #[serde(default)]
    pub keep_metadata: bool,
    /// PNG 无损优化（需要 `png-optimize` feature）。
    #[serde(default)]
    pub png_optimize: bool,
}

fn default_quality() -> u8 {
    80
}

impl Default for EncodeOptions {
    fn default() -> Self {
        EncodeOptions {
            format: ImageFormat::Jpeg,
            quality: 80,
            lossless: false,
            keep_metadata: false,
            png_optimize: false,
        }
    }
}

impl EncodeOptions {
    pub fn validate(&self) -> media_ports::Result<()> {
        if !(1..=100).contains(&self.quality) {
            return Err(media_ports::ToolError::invalid(format!(
                "质量必须在 1 到 100 之间，当前 {}",
                self.quality
            )));
        }
        Ok(())
    }

    /// 该格式是否会丢弃 alpha（需要背景填充）。
    pub fn drops_alpha(&self) -> bool {
        !self.format.supports_alpha()
    }
}

/// 探测结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    /// 小写格式名，例如 `jpeg` / `png`。
    pub format: String,
    pub has_alpha: bool,
    /// EXIF 方向 1..=8。
    pub exif_orientation: u8,
    pub bytes: u64,
    /// 峰值内存估算（见 `common::limits_check::estimate_image_peak`）。
    pub peak_memory_estimate: u64,
}

/// 处理结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub output: Vec<u8>,
    pub out_format: ImageFormat,
    pub out_width: u32,
    pub out_height: u32,
    pub input_bytes: u64,
    pub output_bytes: u64,
    /// 内容哈希（blake3 hex），用于双端一致性比对。
    pub output_hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect() {
        let r = Resize::fit(Some(800), None);
        assert_eq!(r.target_size(4000, 3000), Some((800, 600)));
    }

    #[test]
    fn fit_uses_min_scale() {
        let r = Resize {
            width: Some(800),
            height: Some(800),
            mode: ResizeMode::Fit,
            filter: Filter::Lanczos3,
            allow_upscale: false,
        };
        assert_eq!(r.target_size(4000, 2000), Some((800, 400)));
    }

    #[test]
    fn fill_uses_frame_exactly() {
        let r = Resize {
            width: Some(800),
            height: Some(800),
            mode: ResizeMode::Fill,
            filter: Filter::Lanczos3,
            allow_upscale: true,
        };
        assert_eq!(r.target_size(4000, 2000), Some((800, 800)));
    }

    #[test]
    fn exact_stretches() {
        // 1000×100 → 100×500 是放大，默认不允许；开启后按 Exact 拉伸
        let up = Resize {
            allow_upscale: true,
            ..Resize::exact(100, 500)
        };
        assert_eq!(up.target_size(1000, 100), Some((100, 500)));
        // 未开启放大时退化为等比缩小
        assert_eq!(
            Resize::exact(100, 500).target_size(1000, 100),
            Some((20, 100))
        );
    }

    #[test]
    fn no_upscale_by_default() {
        let r = Resize::fit(Some(8000), None);
        assert_eq!(r.target_size(400, 300), None);
    }

    #[test]
    fn same_size_returns_none() {
        assert_eq!(Resize::exact(400, 300).target_size(400, 300), None);
    }

    #[test]
    fn validate_rejects_zero_dimensions() {
        assert!(Resize::exact(0, 10).validate().is_err());
        assert!(Resize::fit(None, None).validate().is_err());
    }

    #[test]
    fn adjust_identity_detection() {
        assert!(Adjust::default().is_identity());
        assert!(!Adjust {
            brightness: 1.1,
            ..Default::default()
        }
        .is_identity());
    }

    #[test]
    fn adjust_validation_range() {
        assert!(Adjust {
            brightness: 5.0,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Adjust {
            brightness: -0.1,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Adjust {
            saturation: 2.0,
            ..Default::default()
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn passthrough_detection() {
        assert!(ImageParams::default().is_passthrough());
        assert!(!ImageParams {
            rotate: Rotation::Cw90,
            ..Default::default()
        }
        .is_passthrough());
        assert!(!ImageParams {
            adjust: Some(Adjust {
                contrast: 1.2,
                ..Default::default()
            }),
            ..Default::default()
        }
        .is_passthrough());
    }

    #[test]
    fn jpeg_drops_alpha() {
        assert!(EncodeOptions {
            format: ImageFormat::Jpeg,
            ..Default::default()
        }
        .drops_alpha());
        assert!(!EncodeOptions {
            format: ImageFormat::Png,
            ..Default::default()
        }
        .drops_alpha());
    }

    #[test]
    fn crop_clamps_into_bounds() {
        let c = Crop {
            x: 10,
            y: 10,
            width: 1000,
            height: 1000,
        };
        let c2 = c.clamp_to(100, 100).unwrap();
        assert_eq!((c2.width, c2.height), (90, 90));
    }

    #[test]
    fn crop_outside_fails() {
        let c = Crop {
            x: 200,
            y: 0,
            width: 10,
            height: 10,
        };
        assert!(c.clamp_to(100, 100).is_err());
    }

    #[test]
    fn filter_kernels_are_normalized_at_zero() {
        for f in [
            Filter::Nearest,
            Filter::Triangle,
            Filter::CatmullRom,
            Filter::Gaussian,
            Filter::Lanczos3,
        ] {
            assert!((f.kernel(0.0) - 1.0).abs() < 1e-5, "{:?}", f);
        }
    }

    #[test]
    fn filters_fall_to_zero_beyond_support() {
        for f in [
            Filter::Nearest,
            Filter::Triangle,
            Filter::CatmullRom,
            Filter::Gaussian,
            Filter::Lanczos3,
        ] {
            assert_eq!(f.kernel(f.support() + 0.5), 0.0, "{:?}", f);
        }
    }

    #[test]
    fn params_roundtrip_json() {
        let p = ImageParams {
            resize: Some(Resize::fit(Some(800), None)),
            rotate: Rotation::Cw90,
            adjust: Some(Adjust {
                saturation: 1.2,
                ..Default::default()
            }),
            ..Default::default()
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: ImageParams = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn unknown_field_is_rejected() {
        let bad = r#"{"resize":null,"nonsense":1}"#;
        assert!(serde_json::from_str::<ImageParams>(bad).is_err());
    }
}
