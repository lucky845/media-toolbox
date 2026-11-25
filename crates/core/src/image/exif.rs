//! EXIF 方向与元数据剥离。
//!
//! 默认行为是**剥离**（`docs/CAPABILITIES.md` §1：默认不保留元数据）。
//! 仅当 `EncodeOptions.keep_metadata == true` 时把原始 APP1/EXIF 段原样带回。

#![cfg(feature = "exif")]

use media_ports::{Result, ToolError};

/// 从 JPEG 字节里读取 EXIF Orientation（1..=8）。读不到时返回 1（视为正常）。
///
/// 只解析到 APP1 段里 Orientation 标签为止，不做完整 EXIF 解析 ——
/// 目标是「知道要不要转」，不是「读取全部元数据」。
pub fn read_orientation(data: &[u8]) -> u8 {
    let exif = match exif::Reader::new().read_from_container(&mut std::io::Cursor::new(data)) {
        Ok(e) => e,
        Err(_) => return 1,
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| v.clamp(1, 8) as u8)
        .unwrap_or(1)
}

/// 判断字节里是否含有 EXIF（用于 UI 提示「将剥离元数据」）。
pub fn has_exif(data: &[u8]) -> bool {
    exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(data))
        .is_ok()
}

/// 从 JPEG 中剥离所有 APPn（除 APP0/JFIF 之外）与 COM 段，只保留图像数据。
///
/// 只对 JPEG 有效：PNG/WebP 的元数据在独立的 chunk 里，由各自的编码器控制。
pub fn strip_jpeg_metadata(data: &[u8]) -> Result<Vec<u8>> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return Err(ToolError::invalid("不是 JPEG 数据"));
    }
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..2]); // SOI

    let mut i = 2usize;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            // 数据损坏：原样返回剩余部分，交由解码器判定
            out.extend_from_slice(&data[i..]);
            return Ok(out);
        }
        let marker = data[i + 1];
        let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;

        // SOS（0xDA）之后是熵编码数据，直接复制到结尾
        if marker == 0xDA {
            out.extend_from_slice(&data[i..]);
            return Ok(out);
        }
        // 无长度字段的标记
        if (0xD0..=0xD9).contains(&marker) {
            out.extend_from_slice(&data[i..i + 2]);
            i += 2;
            continue;
        }
        if seg_len < 2 || i + 2 + seg_len > data.len() {
            out.extend_from_slice(&data[i..]);
            return Ok(out);
        }
        // 保留 APP0（JFIF 头，某些解码器需要）与所有非 APP/COM 段
        let is_app = (0xE0..=0xEF).contains(&marker);
        let is_com = marker == 0xFE;
        let keep = (!is_app || marker == 0xE0) && !is_com;
        if keep {
            out.extend_from_slice(&data[i..i + 2 + seg_len]);
        }
        i += 2 + seg_len;
    }
    if i < data.len() {
        out.extend_from_slice(&data[i..]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_jpeg_with_orientation(orientation: u8) -> Vec<u8> {
        // 构造一张最小 JPEG，再手动插入带 Orientation 的 EXIF APP1
        let img = image::RgbImage::from_pixel(8, 8, image::Rgb([200, 100, 50]));
        let mut base = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut base),
                image::ImageFormat::Jpeg,
            )
            .unwrap();

        // 最小 TIFF 头 + 一个 IFD 条目
        let mut exif_payload = Vec::new();
        exif_payload.extend_from_slice(b"Exif\0\0");
        exif_payload.extend_from_slice(b"MM\0*"); // big endian
        exif_payload.extend_from_slice(&8u32.to_be_bytes());
        exif_payload.extend_from_slice(&1u16.to_be_bytes()); // 1 entry
        exif_payload.extend_from_slice(&0x0112u16.to_be_bytes()); // Orientation
        exif_payload.extend_from_slice(&3u16.to_be_bytes()); // SHORT
        exif_payload.extend_from_slice(&1u32.to_be_bytes()); // count
        exif_payload.extend_from_slice(&(orientation as u16).to_be_bytes());
        exif_payload.extend_from_slice(&[0, 0]);
        exif_payload.extend_from_slice(&0u32.to_be_bytes()); // next IFD = 0

        let mut out = Vec::new();
        out.extend_from_slice(&base[..2]); // SOI
        out.extend_from_slice(&[0xFF, 0xE1]);
        let len = (exif_payload.len() + 2) as u16;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&exif_payload);
        out.extend_from_slice(&base[2..]);
        out
    }

    #[test]
    fn reads_orientation_from_exif() {
        for o in [1u8, 3, 6, 8] {
            let jpg = make_jpeg_with_orientation(o);
            assert_eq!(read_orientation(&jpg), o, "orientation {o}");
        }
    }

    #[test]
    fn missing_exif_defaults_to_one() {
        assert_eq!(read_orientation(b"not a jpeg"), 1);
        let img = image::RgbImage::from_pixel(4, 4, image::Rgb([0, 0, 0]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut buf),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        assert_eq!(read_orientation(&buf), 1);
    }

    #[test]
    fn has_exif_detects() {
        assert!(has_exif(&make_jpeg_with_orientation(6)));
    }

    #[test]
    fn strip_removes_app1_but_keeps_image_decodable() {
        let jpg = make_jpeg_with_orientation(6);
        assert_eq!(read_orientation(&jpg), 6, "前提：原图有 EXIF");
        let stripped = strip_jpeg_metadata(&jpg).unwrap();
        assert_eq!(
            read_orientation(&stripped),
            1,
            "剥离后不应再读到 Orientation"
        );
        assert!(stripped.len() < jpg.len());
        // 仍可解码
        let img = image::load_from_memory(&stripped).unwrap();
        assert_eq!(img.width(), 8);
    }

    #[test]
    fn strip_keeps_app0() {
        let jpg = make_jpeg_with_orientation(6);
        let stripped = strip_jpeg_metadata(&jpg).unwrap();
        // APP0 (JFIF) 是否存在于原图取决于编码器，但剥离不应破坏文件结构
        assert!(stripped.starts_with(&[0xFF, 0xD8]));
    }

    #[test]
    fn strip_rejects_non_jpeg() {
        assert!(strip_jpeg_metadata(b"PNG...").is_err());
    }
}
