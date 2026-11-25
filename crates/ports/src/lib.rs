//! 平台无关 trait 层。
//!
//! 依赖方向：`core -> ports`，`wasm -> core`，`native -> core`。
//! 本 crate **不认识** `image`、`rayon`、`std::fs`、`std::net`、`std::thread`。
//! 所有平台差异（IO / 并行 / 进程 / 取消）都以 trait 的形式在这里声明，由两个叶子 crate 实现。

pub mod cancel;
pub mod codec;
pub mod error;
pub mod limits;
pub mod parallel;
pub mod progress;
pub mod sink;
pub mod source;

pub use cancel::{CancelToken, NeverCancel};
pub use codec::{CodecFormats, CodecProvider};
pub use error::{spec, ErrorCode, ErrorSpec, Result, ToolError};
pub use limits::{Limits, LimitsProfile};
pub use parallel::{Parallel, SerialParallel};
pub use progress::{CancelError, Phase, Progress, ProgressSink, Unit};
pub use sink::{MemorySink, Sink};
pub use source::{MemorySource, Source};

/// 契约版本。与 `docs/CONTRACTS.md` 的 `contract/v1` 对应。
/// 跨语言边界（wasm 导出、Tauri capability）都要带上它，用于前端快速判定不兼容。
pub const CONTRACT_VERSION: u32 = 1;
