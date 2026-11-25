//! 纯算法层。
//!
//! 铁律（CI 强制，见 `scripts/check-core-boundary.mjs`）：
//! - 不碰文件路径、不碰网络、不碰线程实现、不直接读时钟；
//! - 不出现 `rayon`、`std::fs`、`std::net`、`std::thread`、`cfg(target_arch)`；
//! - 并行只能来自 `media_ports::Parallel`，进度只能来自 `media_ports::ProgressSink`；
//! - 只处理 `&[u8]` / `Vec<u8>` 与参数结构。

#![forbid(unsafe_code)]
#![deny(clippy::all)]

pub mod color;
pub mod common;
pub mod image;
pub mod pdf;
pub mod video;

pub use common::hash::blake3_hex;
pub use common::limits_check::{check_bytes, check_pixels};

/// core 的编译期能力声明，供两端在启动时自检。
pub const CORE_CONTRACT_VERSION: u32 = media_ports::CONTRACT_VERSION;
