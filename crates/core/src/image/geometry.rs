//! 几何变换：裁剪、旋转、翻转、背景填充。
//!
//! 全部是逐像素拷贝，但**按行拷贝**（`copy_from_slice`）而不是逐字节，
//! 让 LLVM 能向量化成 `memcpy`/`mov` 批量指令。

use crate::image::decode::RasterImage;
use crate::image::params::{Flip, Rgba8, Rotation};
use media_ports::{Result, ToolError};

/// 裁剪。`crop` 已由调用方用 `Crop::clamp_to` 夹进边界。
pub fn crop(img: &RasterImage, crop: crate::image::params::Crop) -> Result<RasterImage> {
    let c = crop.clamp_to(img.width, img.height)?;
    let src_stride = img.width as usize * 4;
    let row_bytes = c.width as usize * 4;
    let mut out = Vec::with_capacity(row_bytes * c.height as usize);

    for y in 0..c.height {
        let sy = c.y + y;
        let start = sy as usize * src_stride + c.x as usize * 4;
        out.extend_from_slice(&img.data[start..start + row_bytes]);
    }

    RasterImage::new(c.width, c.height, out)
}

/// 旋转 90° 的整数倍。
pub fn rotate(img: &RasterImage, rotation: Rotation) -> Result<RasterImage> {
    match rotation {
        Rotation::None => Ok(img.clone()),
        Rotation::Cw90 => rotate_cw90(img),
        Rotation::Cw180 => Ok(RasterImage::new(
            img.width,
            img.height,
            // 180° = 逐行倒序 + 行内像素倒序
            img.data
                .chunks_exact(4)
                .rev()
                .flat_map(|p| p.iter().copied())
                .collect(),
        )?),
        Rotation::Cw270 => rotate_cw270(img),
    }
}

fn rotate_cw90(img: &RasterImage) -> Result<RasterImage> {
    let w = img.width as usize;
    let h = img.height as usize;
    // 新图尺寸 h × w
    let mut out = vec![0u8; w * h * 4];
    let dst_stride = h * 4;
    for y in 0..h {
        for x in 0..w {
            // (x, y) → (h-1-y, x)
            let dx = h - 1 - y;
            let dy = x;
            let si = (y * w + x) * 4;
            let di = dy * dst_stride + dx * 4;
            out[di..di + 4].copy_from_slice(&img.data[si..si + 4]);
        }
    }
    RasterImage::new(h as u32, w as u32, out)
}

fn rotate_cw270(img: &RasterImage) -> Result<RasterImage> {
    let w = img.width as usize;
    let h = img.height as usize;
    let mut out = vec![0u8; w * h * 4];
    let dst_stride = h * 4;
    for y in 0..h {
        for x in 0..w {
            // (x, y) → (y, w-1-x)
            let dx = y;
            let dy = w - 1 - x;
            let si = (y * w + x) * 4;
            let di = dy * dst_stride + dx * 4;
            out[di..di + 4].copy_from_slice(&img.data[si..si + 4]);
        }
    }
    RasterImage::new(h as u32, w as u32, out)
}

/// 翻转。
pub fn flip(img: &RasterImage, mode: Flip) -> Result<RasterImage> {
    if mode == Flip::None {
        return Ok(img.clone());
    }
    let w = img.width as usize;
    let h = img.height as usize;
    let stride = w * 4;
    let mut out = vec![0u8; w * h * 4];

    let do_h = matches!(mode, Flip::H | Flip::Both);
    let do_v = matches!(mode, Flip::V | Flip::Both);

    for y in 0..h {
        let sy = if do_v { h - 1 - y } else { y };
        let src_row = &img.data[sy * stride..(sy + 1) * stride];
        let dst_row = &mut out[y * stride..(y + 1) * stride];
        if do_h {
            for x in 0..w {
                let sx = w - 1 - x;
                dst_row[x * 4..x * 4 + 4].copy_from_slice(&src_row[sx * 4..sx * 4 + 4]);
            }
        } else {
            dst_row.copy_from_slice(src_row);
        }
    }

    RasterImage::new(img.width, img.height, out)
}

/// 把 alpha 与背景色做 source-over 合成，得到全不透明图像。
///
/// 用于「透明 PNG → JPEG」这类目标格式不支持 alpha 的场景。
/// 公式：`out = fg * a + bg * (1 - a)`，与浏览器 canvas 的 source-over 一致。
pub fn flatten_background(img: &RasterImage, bg: Rgba8) -> RasterImage {
    if img.is_opaque() {
        // 全不透明就不做任何合成，避免量化误差
        return img.clone();
    }
    let mut data = img.data.clone();
    for p in data.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a == 255 {
            continue;
        }
        let inv = 255 - a;
        // +127 是四舍五入
        p[0] = ((p[0] as u32 * a + bg.r as u32 * inv + 127) / 255) as u8;
        p[1] = ((p[1] as u32 * a + bg.g as u32 * inv + 127) / 255) as u8;
        p[2] = ((p[2] as u32 * a + bg.b as u32 * inv + 127) / 255) as u8;
        p[3] = 255;
    }
    RasterImage {
        width: img.width,
        height: img.height,
        data,
    }
}

/// EXIF 方向（1..=8）→ (旋转, 翻转)。
///
/// | 值 | 含义 | 变换 |
/// |---|---|---|
/// | 1 | 正常 | 无 |
/// | 2 | 水平镜像 | H |
/// | 3 | 旋转 180° | Cw180 |
/// | 4 | 垂直镜像 | V |
/// | 5 | 转置 | Cw90 + H |
/// | 6 | 顺时针 90° | Cw90 |
/// | 7 | 反转置 | Cw270 + H |
/// | 8 | 逆时针 90° | Cw270 |
pub fn exif_orientation_transform(orientation: u8) -> (Rotation, Flip) {
    match orientation {
        2 => (Rotation::None, Flip::H),
        3 => (Rotation::Cw180, Flip::None),
        4 => (Rotation::None, Flip::V),
        5 => (Rotation::Cw90, Flip::H),
        6 => (Rotation::Cw90, Flip::None),
        7 => (Rotation::Cw270, Flip::H),
        8 => (Rotation::Cw270, Flip::None),
        _ => (Rotation::None, Flip::None),
    }
}

/// 按参数里的旋转/翻转之外，再叠加 EXIF 方向。
pub fn apply_orientation(img: &RasterImage, orientation: u8) -> Result<RasterImage> {
    let (rot, mode) = exif_orientation_transform(orientation);
    let a = rotate(img, rot)?;
    flip(&a, mode)
}

/// 检查一个旋转/翻转组合是否改变尺寸。
pub fn changes_dimensions(rotation: Rotation) -> bool {
    matches!(rotation, Rotation::Cw90 | Rotation::Cw270)
}

/// 校验裁剪是否在范围内（不夹取，只报错），用于严格模式。
pub fn validate_crop(img: &RasterImage, c: crate::image::params::Crop) -> Result<()> {
    if c.x + c.width > img.width || c.y + c.height > img.height {
        return Err(ToolError::invalid(format!(
            "裁剪区域 ({}, {}, {}×{}) 超出图像 {}×{}",
            c.x, c.y, c.width, c.height, img.width, img.height
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px_image(w: u32, h: u32) -> RasterImage {
        // 每个像素编码自己的坐标，便于断言变换正确性
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                data.extend_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        RasterImage::new(w, h, data).unwrap()
    }

    #[test]
    fn crop_takes_requested_region() {
        let img = px_image(10, 10);
        let out = crop(
            &img,
            crate::image::params::Crop {
                x: 2,
                y: 3,
                width: 4,
                height: 5,
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (4, 5));
        // 左上角对应原图 (2,3)
        assert_eq!(out.pixel(0, 0), [2, 3, 0, 255]);
        // 右下角对应原图 (5,7)
        assert_eq!(out.pixel(3, 4), [5, 7, 0, 255]);
    }

    #[test]
    fn crop_beyond_bounds_is_clamped() {
        let img = px_image(10, 10);
        let out = crop(
            &img,
            crate::image::params::Crop {
                x: 8,
                y: 8,
                width: 100,
                height: 100,
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (2, 2));
    }

    #[test]
    fn rotate_90_swaps_dimensions() {
        let img = px_image(4, 2);
        let out = rotate(&img, Rotation::Cw90).unwrap();
        assert_eq!((out.width, out.height), (2, 4));
        // 原图左上 (0,0) 旋转后到右上
        assert_eq!(out.pixel(1, 0), [0, 0, 0, 255]);
        // 原图左下 (0,1) 旋转后到左上
        assert_eq!(out.pixel(0, 0), [0, 1, 0, 255]);
    }

    #[test]
    fn rotate_270_is_inverse_of_90() {
        let img = px_image(5, 3);
        let a = rotate(&img, Rotation::Cw90).unwrap();
        let b = rotate(&a, Rotation::Cw270).unwrap();
        assert_eq!((b.width, b.height), (img.width, img.height));
        assert_eq!(b.data, img.data);
    }

    #[test]
    fn rotate_180_twice_is_identity() {
        let img = px_image(5, 3);
        let a = rotate(&img, Rotation::Cw180).unwrap();
        let b = rotate(&a, Rotation::Cw180).unwrap();
        assert_eq!(b.data, img.data);
    }

    #[test]
    fn rotate_360_via_four_90s_is_identity() {
        let img = px_image(7, 4);
        let mut cur = img.clone();
        for _ in 0..4 {
            cur = rotate(&cur, Rotation::Cw90).unwrap();
        }
        assert_eq!((cur.width, cur.height), (img.width, img.height));
        assert_eq!(cur.data, img.data);
    }

    #[test]
    fn flip_h_mirrors_rows() {
        let img = px_image(4, 1);
        let out = flip(&img, Flip::H).unwrap();
        assert_eq!(out.pixel(0, 0), [3, 0, 0, 255]);
        assert_eq!(out.pixel(3, 0), [0, 0, 0, 255]);
    }

    #[test]
    fn flip_v_mirrors_columns() {
        let img = px_image(1, 4);
        let out = flip(&img, Flip::V).unwrap();
        assert_eq!(out.pixel(0, 0), [0, 3, 0, 255]);
    }

    #[test]
    fn flip_both_is_180_rotation() {
        let img = px_image(4, 3);
        let a = flip(&img, Flip::Both).unwrap();
        let b = rotate(&img, Rotation::Cw180).unwrap();
        assert_eq!(a.data, b.data);
    }

    #[test]
    fn exif_orientation_mapping_is_complete() {
        // 1..=8 都必须有映射，且 1 是恒等
        for o in 1..=8u8 {
            let (r, f) = exif_orientation_transform(o);
            if o == 1 {
                assert_eq!(r, Rotation::None);
                assert_eq!(f, Flip::None);
            }
        }
        // 6 = 顺时针 90，8 = 逆时针 90
        assert_eq!(exif_orientation_transform(6), (Rotation::Cw90, Flip::None));
        assert_eq!(exif_orientation_transform(8), (Rotation::Cw270, Flip::None));
        // 3 = 180
        assert_eq!(exif_orientation_transform(3), (Rotation::Cw180, Flip::None));
    }

    #[test]
    fn apply_orientation_6_rotates() {
        let img = px_image(4, 2);
        let out = apply_orientation(&img, 6).unwrap();
        assert_eq!((out.width, out.height), (2, 4));
    }

    #[test]
    fn apply_orientation_1_is_identity() {
        let img = px_image(4, 2);
        let out = apply_orientation(&img, 1).unwrap();
        assert_eq!(out.data, img.data);
    }

    #[test]
    fn flatten_opaque_is_noop() {
        let img = px_image(2, 2);
        let out = flatten_background(&img, Rgba8::default());
        assert_eq!(out.data, img.data);
    }

    #[test]
    fn flatten_composites_transparent_to_white() {
        let mut img = px_image(1, 1);
        img.data[0] = 0;
        img.data[1] = 0;
        img.data[2] = 0;
        img.data[3] = 0; // 全透明
        let out = flatten_background(
            &img,
            Rgba8 {
                r: 255,
                g: 255,
                b: 255,
                a: 255,
            },
        );
        assert_eq!(out.pixel(0, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn flatten_half_alpha_blends() {
        let mut img = px_image(1, 1);
        img.data[0] = 0;
        img.data[1] = 0;
        img.data[2] = 0;
        img.data[3] = 128;
        let out = flatten_background(
            &img,
            Rgba8 {
                r: 255,
                g: 255,
                b: 255,
                a: 255,
            },
        );
        let p = out.pixel(0, 0);
        assert_eq!(p[3], 255);
        // 0*0.5 + 255*0.5 ≈ 128
        assert!(p[0].abs_diff(127) <= 1, "实际 {}", p[0]);
    }

    #[test]
    fn validate_crop_rejects_overflow() {
        let img = px_image(10, 10);
        assert!(validate_crop(
            &img,
            crate::image::params::Crop {
                x: 5,
                y: 5,
                width: 10,
                height: 10
            }
        )
        .is_err());
        assert!(validate_crop(
            &img,
            crate::image::params::Crop {
                x: 5,
                y: 5,
                width: 5,
                height: 5
            }
        )
        .is_ok());
    }

    #[test]
    fn changes_dimensions_flag() {
        assert!(changes_dimensions(Rotation::Cw90));
        assert!(changes_dimensions(Rotation::Cw270));
        assert!(!changes_dimensions(Rotation::Cw180));
        assert!(!changes_dimensions(Rotation::None));
    }
}
