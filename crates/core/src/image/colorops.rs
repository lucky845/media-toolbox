//! 色彩调整：亮度 / 对比度 / 饱和度。
//!
//! 全部走 **LUT（查找表）**：亮度与对比度是单通道映射，20 MP 图用 LUT 比逐像素算 `powf` 快一个数量级。
//! 饱和度需要跨通道，但可以先用 luma LUT 化 —— 这里保持逐像素，因为它不是热点（只有一步）。
//!
//! 确定性：所有运算在 `f32` 上，且公式固定，不使用 `pow` 之外的平台相关函数。

use crate::common::math::{clamp01, luma, quantize_u8};
use crate::image::decode::RasterImage;
use crate::image::params::Adjust;

/// 亮度/对比度的 256 项 LUT。
///
/// - 亮度：`v' = v * brightness`（`1.0` 不变；>1 变亮）
/// - 对比度：绕 0.5 旋转 `v' = (v - 0.5) * contrast + 0.5`
///
/// 顺序固定为 **先亮度后对比度**，与 UI 上的视觉直觉一致（调亮度不该改变对比度感受）。
pub fn build_bc_lut(brightness: f32, contrast: f32) -> [u8; 256] {
    let mut lut = [0u8; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        let v = i as f32 / 255.0;
        let b = clamp01(v * brightness);
        let c = clamp01((b - 0.5) * contrast + 0.5);
        *slot = quantize_u8(c);
    }
    lut
}

/// 应用亮度/对比度/饱和度。
pub fn adjust(img: &RasterImage, a: &Adjust) -> RasterImage {
    if a.is_identity() {
        return img.clone();
    }

    let lut = build_bc_lut(a.brightness, a.contrast);
    let mut data = img.data.clone();

    // 先做亮度+对比度（LUT，逐通道）
    if (a.brightness - 1.0).abs() > 1e-6 || (a.contrast - 1.0).abs() > 1e-6 {
        for p in data.chunks_exact_mut(4) {
            p[0] = lut[p[0] as usize];
            p[1] = lut[p[1] as usize];
            p[2] = lut[p[2] as usize];
            // alpha 不参与亮度/对比度调整
        }
    }

    // 再做饱和度：v = luma + (v - luma) * saturation
    if (a.saturation - 1.0).abs() > 1e-6 {
        for p in data.chunks_exact_mut(4) {
            let l = luma(p[0], p[1], p[2]);
            let f = |c: u8| -> u8 {
                let v = c as f32 / 255.0;
                quantize_u8(l + (v - l) * a.saturation)
            };
            p[0] = f(p[0]);
            p[1] = f(p[1]);
            p[2] = f(p[2]);
        }
    }

    RasterImage {
        width: img.width,
        height: img.height,
        data,
    }
}

/// 转灰度（饱和度 = 0 的等价实现，但保留 alpha）。
pub fn grayscale(img: &RasterImage) -> RasterImage {
    let mut data = img.data.clone();
    for p in data.chunks_exact_mut(4) {
        let v = quantize_u8(luma(p[0], p[1], p[2]));
        p[0] = v;
        p[1] = v;
        p[2] = v;
    }
    RasterImage {
        width: img.width,
        height: img.height,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RasterImage {
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            data.extend_from_slice(&rgba);
        }
        RasterImage::new(w, h, data).unwrap()
    }

    #[test]
    fn identity_adjust_is_noop() {
        let img = solid(4, 4, [10, 20, 30, 255]);
        let out = adjust(&img, &Adjust::default());
        assert_eq!(out.data, img.data);
    }

    #[test]
    fn lut_identity_is_linear() {
        let lut = build_bc_lut(1.0, 1.0);
        for (i, &v) in lut.iter().enumerate() {
            assert_eq!(v, i as u8, "lut[{i}]");
        }
    }

    #[test]
    fn brightness_up_increases_all_channels() {
        let img = solid(2, 2, [100, 100, 100, 255]);
        let out = adjust(
            &img,
            &Adjust {
                brightness: 1.5,
                contrast: 1.0,
                saturation: 1.0,
            },
        );
        assert!(out.data[0] > 100);
        assert_eq!(out.data[3], 255, "alpha 不应被改");
    }

    #[test]
    fn brightness_clamps_at_255() {
        let img = solid(1, 1, [200, 200, 200, 255]);
        let out = adjust(
            &img,
            &Adjust {
                brightness: 4.0,
                contrast: 1.0,
                saturation: 1.0,
            },
        );
        assert_eq!(out.data[0], 255);
    }

    #[test]
    fn zero_brightness_is_black() {
        let img = solid(1, 1, [200, 100, 50, 255]);
        let out = adjust(
            &img,
            &Adjust {
                brightness: 0.0,
                contrast: 1.0,
                saturation: 1.0,
            },
        );
        assert_eq!(&out.data[..3], &[0, 0, 0]);
    }

    #[test]
    fn contrast_pivots_around_mid() {
        let img = solid(1, 1, [96, 96, 96, 255]);
        // 对比度 2.0：0.376 → (0.376-0.5)*2+0.5 = 0.253 → 64
        let out = adjust(
            &img,
            &Adjust {
                brightness: 1.0,
                contrast: 2.0,
                saturation: 1.0,
            },
        );
        assert!(out.data[0].abs_diff(64) <= 2, "实际 {}", out.data[0]);
    }

    #[test]
    fn contrast_mid_gray_is_stable() {
        let img = solid(1, 1, [128, 128, 128, 255]);
        let out = adjust(
            &img,
            &Adjust {
                brightness: 1.0,
                contrast: 3.0,
                saturation: 1.0,
            },
        );
        assert!(
            out.data[0].abs_diff(128) <= 2,
            "中灰不应被对比度改变: {}",
            out.data[0]
        );
    }

    #[test]
    fn saturation_zero_gives_gray() {
        let img = solid(1, 1, [200, 50, 25, 255]);
        let out = adjust(
            &img,
            &Adjust {
                brightness: 1.0,
                contrast: 1.0,
                saturation: 0.0,
            },
        );
        assert_eq!(out.data[0], out.data[1]);
        assert_eq!(out.data[1], out.data[2]);
    }

    #[test]
    fn saturation_above_one_amplifies() {
        let img = solid(1, 1, [200, 100, 50, 255]);
        let out = adjust(
            &img,
            &Adjust {
                brightness: 1.0,
                contrast: 1.0,
                saturation: 2.0,
            },
        );
        // 红色通道应更红（远离 luma）
        assert!(out.data[0] >= 200);
        // 蓝色通道更蓝（更远离 luma）
        assert!(out.data[2] <= 50);
    }

    #[test]
    fn grayscale_ignores_color() {
        let img = solid(1, 1, [200, 50, 25, 128]);
        let out = grayscale(&img);
        assert_eq!(out.data[0], out.data[1]);
        assert_eq!(out.data[1], out.data[2]);
        assert_eq!(out.data[3], 128, "alpha 保留");
    }

    #[test]
    fn adjust_is_deterministic() {
        let img = solid(8, 8, [33, 77, 121, 200]);
        let p = Adjust {
            brightness: 1.13,
            contrast: 0.87,
            saturation: 1.31,
        };
        let a = adjust(&img, &p);
        let b = adjust(&img, &p);
        assert_eq!(a.data, b.data);
    }
}
