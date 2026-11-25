//! 便利封装：把「并行 + 进度 + 取消 + 阈值」打包成 `core::image::Ctx` 需要的形态。

use crate::cancel::TaskCancel;
use crate::parallel::RayonParallel;
use media_ports::limits::Limits;
use media_ports::progress::{Phase, Progress, ProgressSink, Unit};
use std::time::Instant;

/// 进度回调：把 `Progress` 交给 Tauri（或 CLI 打印）。
///
/// `F` 必须是 `Fn + Sync`：rayon 里多线程会同时上报。
pub struct ProgressReporter<F: Fn(Progress) + Sync> {
    cb: F,
}

impl<F: Fn(Progress) + Sync> ProgressReporter<F> {
    pub fn new(cb: F) -> Self {
        ProgressReporter { cb }
    }
}

impl<F: Fn(Progress) + Sync> ProgressSink for ProgressReporter<F> {
    fn report(&self, p: Progress) {
        (self.cb)(p);
    }
}

/// 单调时钟（毫秒），供 `ThrottledProgress` 使用。
pub struct Clock {
    start: Instant,
}

impl Default for Clock {
    fn default() -> Self {
        Clock {
            start: Instant::now(),
        }
    }
}

impl Clock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// native 侧的一次调用上下文：持有并行器、阈值、取消令牌。
///
/// 生命周期设计：`RayonParallel` 与 `TaskCancel` 归调用方所有，
/// `NativeCtx` 只借用，避免在 async command 里搬所有权。
pub struct NativeCtx<'a> {
    pub parallel: &'a RayonParallel,
    pub cancel: &'a TaskCancel,
    pub limits: &'a Limits,
}

impl<'a> NativeCtx<'a> {
    pub fn new(parallel: &'a RayonParallel, cancel: &'a TaskCancel, limits: &'a Limits) -> Self {
        NativeCtx {
            parallel,
            cancel,
            limits,
        }
    }

    /// 组装成 core 需要的 `Ctx`。
    pub fn core_ctx<'b>(
        &'b self,
        progress: &'b dyn ProgressSink,
    ) -> media_core::image::pipeline::Ctx<'b, RayonParallel> {
        media_core::image::pipeline::Ctx {
            parallel: self.parallel,
            progress,
            cancel: self.cancel,
            limits: self.limits,
        }
    }
}

/// 便捷：把 `Phase/Unit` 组合成一次上报。
pub fn p(done: u64, total: u64, phase: Phase, unit: Unit) -> Progress {
    Progress::new(done, total, phase, unit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn reporter_forwards() {
        let n = AtomicUsize::new(0);
        let r = ProgressReporter::new(|_p: Progress| {
            n.fetch_add(1, Ordering::Relaxed);
        });
        r.report(p(1, 10, Phase::Decoding, Unit::Bytes));
        r.report(p(2, 10, Phase::Decoding, Unit::Bytes));
        assert_eq!(n.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn clock_is_monotonic() {
        let c = Clock::new();
        let a = c.now_ms();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = c.now_ms();
        assert!(b >= a);
    }

    #[test]
    fn native_ctx_wraps_core_ctx() {
        let parallel = RayonParallel::new_with_threads(2);
        let cancel = TaskCancel::new();
        let limits = Limits::DESKTOP;
        let ctx = NativeCtx::new(&parallel, &cancel, &limits);
        let prog = ProgressReporter::new(|_p: Progress| {});
        let core = ctx.core_ctx(&prog);
        assert_eq!(core.limits.max_pages, u32::MAX);
    }
}
