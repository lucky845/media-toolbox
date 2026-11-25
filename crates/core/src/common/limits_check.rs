//! 阈值前置校验（在开始解码/编码**之前**执行）。
//!
//! 规格 §13 的硬要求：「超限直接中止并给出桌面版引导，不要假装能处理」。
//! 所以每个入口的第一步都是这里，而不是「先试试看，OOM 了再说」。

use media_ports::codec::{human_bytes, human_duration};
use media_ports::{ErrorCode, Limits, Result, ToolError};

/// 校验输入字节数。
pub fn check_bytes(bytes: u64, limits: &Limits) -> Result<()> {
    if bytes > limits.max_bytes {
        let limit = format!("{} 文件", human_bytes(limits.max_bytes));
        let detail = format!(
            "当前 {}，上限 {}",
            human_bytes(bytes),
            human_bytes(limits.max_bytes)
        );
        return Err(
            ToolError::new(ErrorCode::InputTooLarge, &[("limit", &limit)]).with_detail(detail),
        );
    }
    Ok(())
}

/// 校验图片像素数。
pub fn check_pixels(width: u32, height: u32, limits: &Limits) -> Result<()> {
    let px = width as u64 * height as u64;
    if px > limits.max_pixels {
        let limit = format!("{} MP", limits.max_pixels / 1_000_000);
        let detail = format!("当前 {width}×{height} = {:.1} MP", px as f64 / 1_000_000.0);
        return Err(
            ToolError::new(ErrorCode::DimensionLimit, &[("limit", &limit)]).with_detail(detail),
        );
    }
    Ok(())
}

/// 校验 PDF 页数。
pub fn check_pages(pages: u32, limits: &Limits) -> Result<()> {
    if pages > limits.max_pages {
        let limit = limits.max_pages.to_string();
        let detail = format!("当前 {pages} 页，上限 {} 页", limits.max_pages);
        return Err(ToolError::new(ErrorCode::PageLimit, &[("limit", &limit)]).with_detail(detail));
    }
    Ok(())
}

/// 校验视频时长。
pub fn check_duration(secs: u64, limits: &Limits) -> Result<()> {
    if secs > limits.max_duration_sec {
        let limit = human_duration(limits.max_duration_sec);
        let detail = format!("当前 {}，上限 {}", human_duration(secs), limit);
        return Err(
            ToolError::new(ErrorCode::DurationLimit, &[("limit", &limit)]).with_detail(detail),
        );
    }
    Ok(())
}

/// 预估峰值内存校验。
///
/// 公式（`docs/CONTRACTS.md` §7）：
/// `decode(W*H*4) + transform(W*H*4) + encode_ws(1.5*W*H*4) + wasm_copy(2*in) + out`
/// 合并为 `3.5 * W * H * 4 + 2*in + out_estimate`。这里用 `out ≈ in` 做保守估计。
pub fn check_memory_estimate(peak_bytes: u64, limits: &Limits) -> Result<()> {
    if limits.max_memory_bytes == 0 {
        return Ok(()); // 桌面不限
    }
    if peak_bytes > limits.max_memory_bytes {
        return Err(ToolError::new(
            ErrorCode::MemoryLimit,
            &[
                ("need", &human_bytes(peak_bytes)),
                ("cap", &human_bytes(limits.max_memory_bytes)),
            ],
        ));
    }
    Ok(())
}

/// 图片的峰值内存估算，随 `check_pixels` 一起提供，避免两处各写一遍公式。
pub fn estimate_image_peak(width: u32, height: u32, input_bytes: u64) -> u64 {
    let rgba = width as u64 * height as u64 * 4;
    // decode + transform + encoder workspace(1.5) = 3.5 * rgba
    let work = rgba.saturating_mul(7) / 2;
    work.saturating_add(input_bytes.saturating_mul(2))
        .saturating_add(input_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_within_limit_ok() {
        assert!(check_bytes(1000, &Limits::WEB).is_ok());
    }

    #[test]
    fn bytes_over_limit_fails_with_desktop_hint() {
        let e = check_bytes(25 * 1024 * 1024, &Limits::WEB).unwrap_err();
        assert_eq!(e.code, ErrorCode::InputTooLarge);
        assert!(e.desktop_hint);
        assert!(e.message.contains("20.0 MB"), "{}", e.message);
    }

    #[test]
    fn pixels_boundary_is_inclusive() {
        // 20 MP 正好等于上限 -> ok（> 才失败）
        assert!(check_pixels(5000, 4000, &Limits::WEB).is_ok());
        assert!(check_pixels(5001, 4000, &Limits::WEB).is_err());
    }

    #[test]
    fn pixels_failure_mentions_dimensions() {
        let e = check_pixels(8000, 6000, &Limits::WEB).unwrap_err();
        assert_eq!(e.code, ErrorCode::DimensionLimit);
        assert!(e.detail.unwrap().contains("8000×6000"));
    }

    #[test]
    fn pages_and_duration_limits() {
        assert!(check_pages(100, &Limits::WEB).is_ok());
        assert!(check_pages(101, &Limits::WEB).is_err());
        assert!(check_duration(300, &Limits::WEB).is_ok());
        assert!(check_duration(301, &Limits::WEB).is_err());
    }

    #[test]
    fn desktop_never_limits_bytes() {
        assert!(check_bytes(u64::MAX / 8, &Limits::DESKTOP).is_ok());
    }

    #[test]
    fn memory_estimate_matches_documented_model() {
        // 20 MP + 20 MB 输入 ≈ 3.5*80MB + 3*20MB = 280 + 60 = 340 MB
        let input = 20 * 1024 * 1024u64;
        let peak = estimate_image_peak(5000, 4000, input);
        // rgba = 20 MP * 4 = 80,000,000；3.5*rgba = 280,000,000；再加 3 份输入
        let expected = 280_000_000u64 + input * 3;
        assert_eq!(peak, expected);
        // 340 MB < 512 MB 上限 -> 放行
        assert!(check_memory_estimate(peak, &Limits::WEB).is_ok());
    }

    #[test]
    fn oversized_image_trips_memory_limit() {
        let peak = estimate_image_peak(10000, 8000, 40 * 1024 * 1024);
        assert!(check_memory_estimate(peak, &Limits::WEB).is_err());
    }
}
