//! 阈值（唯一来源）。TS 侧只能通过 `get_limits()` / `capabilities()` 读取，禁止硬编码。
//!
//! 依据见 `docs/CAPABILITIES.md` §6 与 `docs/CONTRACTS.md` §7 的内存峰值模型。

use serde::{Deserialize, Serialize};

/// 一个形态（Web / Desktop）的完整阈值集合。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    /// 单张图片最大像素数。
    pub max_pixels: u64,
    /// 单个文件最大字节数。
    pub max_bytes: u64,
    /// 单次批量的最大文件数。
    pub max_batch: u32,
    /// 视频最大时长（秒）。
    pub max_duration_sec: u64,
    /// PDF 最大页数。
    pub max_pages: u32,
    /// 预估峰值内存上限（字节）。0 表示不限。
    pub max_memory_bytes: u64,
    /// 同时运行的重任务数。
    pub max_concurrent: u32,
    /// 是否由服务端/浏览器限制（true 时 UI 显示「在线版上限」文案）。
    pub is_restricted: bool,
}

impl Limits {
    /// Web 轻量形态：规格 §13 的默认值。
    pub const WEB: Limits = Limits {
        max_pixels: 20_000_000,
        max_bytes: 20 * 1024 * 1024,
        max_batch: 50,
        max_duration_sec: 5 * 60,
        max_pages: 100,
        max_memory_bytes: 512 * 1024 * 1024,
        max_concurrent: 2,
        is_restricted: true,
    };

    /// 桌面形态：不设人为上限（实际受磁盘/内存约束，由 IO 错误兜底）。
    pub const DESKTOP: Limits = Limits {
        max_pixels: u64::MAX / 4,
        max_bytes: u64::MAX / 4,
        max_batch: u32::MAX,
        max_duration_sec: u64::MAX / 4,
        max_pages: u32::MAX,
        max_memory_bytes: 0,
        max_concurrent: 4,
        is_restricted: false,
    };

    /// 带自定义并发度的桌面形态（用户可在设置里改）。
    pub fn desktop_with_concurrency(n: u32) -> Limits {
        Limits {
            max_concurrent: n.max(1),
            ..Limits::DESKTOP
        }
    }

    pub fn profile(&self) -> LimitsProfile {
        if self.is_restricted {
            LimitsProfile::Web
        } else {
            LimitsProfile::Desktop
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LimitsProfile {
    Web,
    Desktop,
}

impl Default for Limits {
    fn default() -> Self {
        Limits::DESKTOP
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_limits_match_spec() {
        // 规格 §13 的四个默认值，改动必须同步改 docs/CAPABILITIES.md §6
        // 用编译期断言：这些值一旦被改动，编译就失败，比等单测更早
        const {
            assert!(Limits::WEB.max_pixels == 20_000_000);
            assert!(Limits::WEB.max_bytes == 20 * 1024 * 1024);
            assert!(Limits::WEB.max_duration_sec == 300);
            assert!(Limits::WEB.max_pages == 100);
        }
    }

    #[test]
    fn desktop_is_unrestricted() {
        // 编译期断言：这些是 const，运行期断言会被 clippy 判定为「常量断言」
        const {
            assert!(!Limits::DESKTOP.is_restricted);
            assert!(Limits::DESKTOP.max_memory_bytes == 0);
        }
    }

    #[test]
    fn concurrency_is_clamped_to_at_least_one() {
        assert_eq!(Limits::desktop_with_concurrency(0).max_concurrent, 1);
    }
}
