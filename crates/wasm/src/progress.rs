//! 把 core 的 `ProgressSink` 桥到 JS 回调。
//!
//! 设计：**不在这里节流**。节流由 `ThrottledProgress`（ports 里那份唯一实现）包在外面，
//! 这样 wasm 与 native 用同一套节流规则，不会出现「Web 每帧一次、桌面每 100ms 一次」的漂移。

use media_ports::progress::{Phase, Progress, ProgressSink};
use wasm_bindgen::prelude::*;

/// 把 `js_sys::Function` 包成 `ProgressSink`。
pub struct JsProgress {
    cb: Option<js_sys::Function>,
}

impl JsProgress {
    pub fn new(cb: Option<js_sys::Function>) -> Self {
        JsProgress { cb }
    }

    pub fn none() -> Self {
        JsProgress { cb: None }
    }
}

impl ProgressSink for JsProgress {
    fn report(&self, p: Progress) {
        let Some(cb) = &self.cb else { return };
        // 回调签名：(done, total, phase) — 只有三个参数，保持跨边界的数据量最小
        let this = JsValue::NULL;
        let args = js_sys::Array::new();
        args.push(&JsValue::from_f64(p.done as f64));
        args.push(&JsValue::from_f64(p.total as f64));
        args.push(&JsValue::from_str(p.phase.as_str()));
        // 忽略回调抛出的异常：进度上报失败不该打断主流程
        let _ = cb.apply(&this, &args);
    }
}

/// 阶段名 → 枚举（前端若需要反向转换）。
/// 当前未被调用：两阶段 API 里阶段由 Rust 决定，前端不需要反解。保留是因为它是契约的一部分。
#[allow(dead_code)]
pub fn phase_from_str(s: &str) -> Phase {
    match s {
        "queued" => Phase::Queued,
        "decoding" => Phase::Decoding,
        "transforming" => Phase::Transforming,
        "encoding" => Phase::Encoding,
        "writing" => Phase::Writing,
        "optimizing" => Phase::Optimizing,
        _ => Phase::Finalizing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_sink_does_nothing() {
        JsProgress::none().report(Progress::new(
            1,
            2,
            Phase::Decoding,
            media_ports::progress::Unit::Bytes,
        ));
    }

    #[test]
    fn phase_roundtrip() {
        for p in [
            Phase::Queued,
            Phase::Decoding,
            Phase::Transforming,
            Phase::Encoding,
            Phase::Writing,
            Phase::Optimizing,
            Phase::Finalizing,
        ] {
            assert_eq!(phase_from_str(p.as_str()), p);
        }
    }
}
