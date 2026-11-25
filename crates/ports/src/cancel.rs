//! 取消令牌。
//!
//! 两端语义不同（`docs/CONTRACTS.md` §3）：
//! - native：`Arc<AtomicBool>`，`core` 在阶段边界检查；子进程由 `crates/native` 额外 kill。
//! - wasm：单线程同步执行期间 JS 无法调用进来，所以**实际生效的是 `worker.terminate()`**；
//!   `core` 里的检查点仍然保留（多阶段调用时会用到），但 UI 不承诺「软取消」。
//!
//! 这个差异是数据（`capabilities().cancel.hard`），不是代码分支。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// `core` 只依赖这个 trait；实现方决定信号从哪来。
pub trait CancelToken: Sync {
    fn is_cancelled(&self) -> bool;

    /// 在阶段边界调用；已取消则返回 `Err(CancelError::Cancelled)`。
    fn check(&self) -> Result<(), super::progress::CancelError> {
        if self.is_cancelled() {
            Err(super::progress::CancelError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// 永不取消（单测、一次性 CLI 场景）。
pub struct NeverCancel;

impl CancelToken for NeverCancel {
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// 由外部（native 的 Tauri command、wasm 的 JS 回调）翻转的标志。
#[derive(Debug, Clone, Default)]
pub struct AtomicCancelToken {
    flag: Arc<AtomicBool>,
}

impl AtomicCancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从外部持有同一个 `Arc` 时使用（native 的任务表里存的是它）。
    pub fn from_arc(flag: Arc<AtomicBool>) -> Self {
        AtomicCancelToken { flag }
    }

    pub fn handle(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

impl CancelToken for AtomicCancelToken {
    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_cancel_never_cancels() {
        assert!(!NeverCancel.is_cancelled());
        assert!(NeverCancel.check().is_ok());
    }

    #[test]
    fn cancel_flips_and_check_fails() {
        let t = AtomicCancelToken::new();
        assert!(t.check().is_ok());
        t.cancel();
        assert!(t.is_cancelled());
        assert!(t.check().is_err());
    }

    #[test]
    fn handle_shares_state() {
        let t = AtomicCancelToken::new();
        let h = t.handle();
        h.store(true, Ordering::SeqCst);
        assert!(t.is_cancelled());
    }

    #[test]
    fn reset_clears() {
        let t = AtomicCancelToken::new();
        t.cancel();
        t.reset();
        assert!(!t.is_cancelled());
    }
}
