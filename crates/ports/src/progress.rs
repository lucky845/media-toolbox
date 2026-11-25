//! 进度模型。
//!
//! 契约（`docs/CONTRACTS.md` §2.5）：实现方必须节流 —— 同一 phase 下间隔 >= 100ms 才跨边界发送，
//! phase 变化立即发送，`done == total` 的那一次必须发送。节流逻辑放在 `ThrottledProgress`，
//! 这样 wasm 与 native 的包装都复用同一份，不会各写一套。
//!
//! 为什么用原子而不是 `Cell`：rayon 并行时多个工作线程会同时上报进度，
//! `ProgressSink` 要求 `Sync`，所以节流状态必须是线程安全的。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Queued,
    Decoding,
    Transforming,
    Encoding,
    Writing,
    Optimizing,
    Finalizing,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Queued => "queued",
            Phase::Decoding => "decoding",
            Phase::Transforming => "transforming",
            Phase::Encoding => "encoding",
            Phase::Writing => "writing",
            Phase::Optimizing => "optimizing",
            Phase::Finalizing => "finalizing",
        }
    }

    /// 用于原子存储的稳定编码。
    pub fn code(self) -> u8 {
        match self {
            Phase::Queued => 0,
            Phase::Decoding => 1,
            Phase::Transforming => 2,
            Phase::Encoding => 3,
            Phase::Writing => 4,
            Phase::Optimizing => 5,
            Phase::Finalizing => 6,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Bytes,
    Pixels,
    Pages,
    Frames,
    Percent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    /// 0 表示总量未知（例如未拿到时长的视频转码）。
    pub total: u64,
    pub phase: Phase,
    pub unit: Unit,
}

impl Progress {
    pub fn new(done: u64, total: u64, phase: Phase, unit: Unit) -> Self {
        Progress {
            done,
            total,
            phase,
            unit,
        }
    }

    /// 0.0..=1.0；total 未知时返回 None。
    pub fn fraction(&self) -> Option<f64> {
        if self.total == 0 {
            None
        } else {
            Some((self.done as f64 / self.total as f64).clamp(0.0, 1.0))
        }
    }

    /// 是否到达终点（total 未知时永远不算完）。
    pub fn is_complete(&self) -> bool {
        self.total > 0 && self.done >= self.total
    }
}

/// 进度接收器。`core` 只认这个 trait，不知道是 Tauri event 还是 `js_sys::Function`。
pub trait ProgressSink: Sync {
    fn report(&self, p: Progress);
}

/// 什么都不做的实现，用于单测与「不需要进度」的调用。
pub struct NoopProgress;

impl ProgressSink for NoopProgress {
    fn report(&self, _p: Progress) {}
}

/// 节流包装：把高频上报压到契约要求的频率。
///
/// 时间源由外部注入（返回毫秒的单调时钟），因为 `core` 不允许直接读时钟 ——
/// wasm 里是 `js_sys::Date::now()`，native 是 `Instant`，单测需要可控时钟。
pub struct ThrottledProgress<'a, S: ProgressSink + ?Sized> {
    inner: &'a S,
    now_ms: &'a (dyn Fn() -> u64 + Sync),
    last_emit_ms: AtomicU64,
    last_phase: AtomicU8,
    interval_ms: u64,
}

impl<'a, S: ProgressSink + ?Sized> ThrottledProgress<'a, S> {
    pub fn new(inner: &'a S, now_ms: &'a (dyn Fn() -> u64 + Sync)) -> Self {
        ThrottledProgress {
            inner,
            now_ms,
            last_emit_ms: AtomicU64::new(0),
            last_phase: AtomicU8::new(u8::MAX),
            interval_ms: 100,
        }
    }

    pub fn with_interval(mut self, ms: u64) -> Self {
        self.interval_ms = ms.max(1);
        self
    }

    /// 按契约决定是否真正下发，并返回是否下发。
    pub fn report(&self, p: Progress) -> bool {
        let now = (self.now_ms)();
        let phase_changed = {
            let prev = self.last_phase.load(Ordering::Relaxed);
            if prev != p.phase.code() {
                self.last_phase.store(p.phase.code(), Ordering::Relaxed);
                true
            } else {
                false
            }
        };
        let elapsed = now.saturating_sub(self.last_emit_ms.load(Ordering::Relaxed));

        if phase_changed || p.is_complete() || elapsed >= self.interval_ms {
            self.last_emit_ms.store(now, Ordering::Relaxed);
            self.inner.report(p);
            true
        } else {
            false
        }
    }
}

/// `ThrottledProgress` 本身也是一个 `ProgressSink`：
/// 包装链是 `core → ThrottledProgress → 具体实现（JsProgress / Tauri event）`，
/// 这样节流只写一次，两端共用。
impl<S: ProgressSink + ?Sized> ProgressSink for ThrottledProgress<'_, S> {
    fn report(&self, p: Progress) {
        ThrottledProgress::report(self, p);
    }
}

/// 取消错误（`core` 在阶段边界把它转成 `ToolError::cancelled()`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelError {
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        seen: Mutex<Vec<Progress>>,
    }
    impl ProgressSink for Recorder {
        fn report(&self, p: Progress) {
            self.seen.lock().unwrap().push(p);
        }
    }

    fn clock(start: u64) -> (std::sync::Arc<AtomicU64>, impl Fn() -> u64 + Sync) {
        let c = std::sync::Arc::new(AtomicU64::new(start));
        let c2 = c.clone();
        (c, move || c2.load(Ordering::Relaxed))
    }

    #[test]
    fn complete_always_passes_through() {
        let rec = Recorder::default();
        let (_c, now) = clock(0);
        let th = ThrottledProgress::new(&rec, &now);
        assert!(th.report(Progress::new(1, 10, Phase::Decoding, Unit::Pixels)));
        assert!(th.report(Progress::new(10, 10, Phase::Decoding, Unit::Pixels)));
        assert_eq!(rec.seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn same_phase_within_interval_is_dropped() {
        let rec = Recorder::default();
        let (c, now) = clock(0);
        let th = ThrottledProgress::new(&rec, &now);
        th.report(Progress::new(1, 100, Phase::Decoding, Unit::Pixels));
        c.store(50, Ordering::Relaxed);
        assert!(!th.report(Progress::new(2, 100, Phase::Decoding, Unit::Pixels)));
        c.store(100, Ordering::Relaxed);
        assert!(th.report(Progress::new(3, 100, Phase::Decoding, Unit::Pixels)));
    }

    #[test]
    fn phase_change_bypasses_interval() {
        let rec = Recorder::default();
        let (c, now) = clock(0);
        let th = ThrottledProgress::new(&rec, &now);
        th.report(Progress::new(1, 100, Phase::Decoding, Unit::Pixels));
        c.store(1, Ordering::Relaxed);
        assert!(th.report(Progress::new(2, 100, Phase::Encoding, Unit::Pixels)));
    }

    #[test]
    fn unknown_total_never_completes() {
        assert_eq!(
            Progress::new(5, 0, Phase::Decoding, Unit::Bytes).fraction(),
            None
        );
        assert!(!Progress::new(5, 0, Phase::Decoding, Unit::Bytes).is_complete());
    }

    #[test]
    fn throttled_progress_is_sync() {
        fn assert_sync<T: Sync>() {}
        assert_sync::<ThrottledProgress<'static, Recorder>>();
    }
}
