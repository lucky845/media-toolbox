//! 色彩空间定义（Phase 3 扩展：ICC profile、Display P3、线性光）。

pub use crate::common::math::{linear_to_srgb, srgb_to_linear};

/// 常见像素布局。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// 8 位 RGBA，非预乘。
    Rgba8,
    /// 8 位 RGB。
    Rgb8,
    /// 8 位灰度。
    L8,
    /// 8 位灰度 + alpha。
    La8,
}

impl Layout {
    pub fn channels(self) -> usize {
        match self {
            Layout::Rgba8 => 4,
            Layout::Rgb8 => 3,
            Layout::L8 => 1,
            Layout::La8 => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_match_layout() {
        assert_eq!(Layout::Rgba8.channels(), 4);
        assert_eq!(Layout::L8.channels(), 1);
    }
}
