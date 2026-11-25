//! 数学工具：色彩调整用的曲线、定点数、clamp。

/// `f32` 的 clamp 到 `[0, 1]`，**NaN 归零**。
///
/// 为什么不用 `v.clamp(0.0, 1.0)`：
/// `f32::clamp` 对 NaN 会**返回 NaN 并传播**，而我们需要「NaN 视为 0」——
/// 因为色彩调整里出现 NaN（例如 0/0）时，输出黑色比输出 NaN 更安全
/// （NaN 转 u8 是未定义行为，会在不同平台上给出不同结果，直接破坏双端一致性）。
/// 这个语义差异是刻意的，不是笔误。
#[inline]
#[allow(clippy::manual_clamp, clippy::if_same_then_else)]
pub fn clamp01(v: f32) -> f32 {
    // NaN < 0.0 为 false，所以要单独判断，与 v < 0.0 落到同一个分支体是**故意的**
    if v.is_nan() || v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

/// 把 `f32(0..=1)` 量化到 `u8`，四舍五入。
///
/// 为什么不用 `(v * 255.0) as u8`：截断会让 1.0 → 255 之外的值偏暗，
/// 且两端在舍入上必须一致（一致性测试要求字节相等）。
#[inline]
pub fn quantize_u8(v: f32) -> u8 {
    let x = clamp01(v) * 255.0;
    // +0.5 后取整 = 四舍五入，且对 0.5 的行为固定（不会出现 banker's rounding 的差异）
    (x + 0.5).floor().clamp(0.0, 255.0) as u8
}

/// sRGB 编码值（0..=255）→ 线性光（0..=1）。
#[inline]
pub fn srgb_to_linear(c: u8) -> f32 {
    let s = c as f32 / 255.0;
    if s <= 0.04045 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

/// 线性光（0..=1）→ sRGB 编码值（0..=255）。
#[inline]
pub fn linear_to_srgb(v: f32) -> u8 {
    let v = clamp01(v);
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    quantize_u8(s)
}

/// Rec.709 亮度系数（sRGB 的非线性域近似，用于饱和度/灰度）。
pub const LUMA_R: f32 = 0.2126;
pub const LUMA_G: f32 = 0.7152;
pub const LUMA_B: f32 = 0.0722;

#[inline]
pub fn luma(r: u8, g: u8, b: u8) -> f32 {
    (LUMA_R * r as f32 + LUMA_G * g as f32 + LUMA_B * b as f32) / 255.0
}

/// 线性插值。
#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_rounds_not_truncates() {
        assert_eq!(quantize_u8(0.0), 0);
        assert_eq!(quantize_u8(1.0), 255);
        // 0.5/255 落在 0.5 上，必须进位到 1（固定行为，两端一致）
        assert_eq!(quantize_u8(0.5 / 255.0), 1);
        assert_eq!(quantize_u8(0.4 / 255.0), 0);
    }

    #[test]
    fn quantize_clamps_out_of_range() {
        assert_eq!(quantize_u8(-1.0), 0);
        assert_eq!(quantize_u8(2.0), 255);
        assert_eq!(quantize_u8(f32::NAN), 0);
    }

    #[test]
    fn srgb_roundtrip_is_stable() {
        for c in [0u8, 1, 32, 64, 128, 200, 254, 255] {
            let back = linear_to_srgb(srgb_to_linear(c));
            assert!(back.abs_diff(c) <= 1, "c={c} back={back}");
        }
    }

    #[test]
    fn linear_endpoints_exact() {
        assert_eq!(linear_to_srgb(0.0), 0);
        assert_eq!(linear_to_srgb(1.0), 255);
    }

    #[test]
    fn luma_of_white_is_one() {
        assert!((luma(255, 255, 255) - 1.0).abs() < 1e-6);
        assert_eq!(luma(0, 0, 0), 0.0);
    }
}
