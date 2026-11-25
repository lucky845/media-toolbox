//! native 薄包装：rayon 并行、文件 IO、子进程。
//!
//! 这一层是 `docs/ARCHITECTURE.md` §2.1 里唯一允许出现 `rayon` / `std::fs` 的地方之一
//! （另一个是 `src-tauri`）。算法一律来自 `media-core`，本 crate 不含任何像素循环。
//!
//! 被 `src-tauri` 的 command 直接调用；也可作为 CLI/测试的库使用。

pub mod cancel;
pub mod parallel;
pub mod sink;
pub mod util;

pub use cancel::TaskCancel;
pub use parallel::RayonParallel;
pub use sink::{read_limited, unique_path, write_atomic, FileSink, FileSource};
pub use util::{NativeCtx, ProgressReporter};

/// 重新导出 ports 的进度类型，方便 src-tauri 少写一层路径
pub use media_ports::progress::{Phase, Progress, ProgressSink, Unit};

/// 把 core 的错误转成可跨 Tauri IPC 的结构（core 的 `ToolError` 已实现 Serialize）。
pub use media_ports::ToolError;
