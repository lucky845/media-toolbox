//! wasm-bindgen 薄包装：把 core 暴露给浏览器 Worker。
//!
//! ## 设计约束
//!
//! 1. **单线程**：`SerialParallel` 是这里唯一的并行实现（Pages 无 COOP/COEP → 无 SharedArrayBuffer）。
//! 2. **输入是 `Uint8Array`**：跨边界的东西只有字节与 JSON 字符串，不传结构体。
//! 3. **错误转字符串**：`JsValue` 里放 `ToolError` 的 JSON，前端 `JSON.parse` 后按 `code` 分支。
//! 4. **进度用 `js_sys::Function`**：由 worker 侧传入，内部用 `ThrottledProgress` 节流。
//!
//! ## 为什么不在 wasm 里做取消的「软中断」
//!
//! wasm 单线程同步执行期间，JS 事件循环被阻塞，`cancel()` 永远进不来。
//! 所以包装层提供 `process_image_stages`（分两阶段调用），让 worker 在两次调用之间检查取消标志；
//! 真正的即时取消靠 `worker.terminate()`。这是数据（`capabilities().cancel.hard == false`）。

use media_core::image::encode::encode;
use media_core::image::params::{EncodeOptions, ImageParams, Rgba8};
use media_core::image::pipeline::{probe_image, Ctx};
use media_ports::codec::CodecProvider;
use media_ports::codec::{human_bytes, human_duration, ImageFormat};
use media_ports::limits::Limits;
use media_ports::progress::ThrottledProgress;
use media_ports::{CancelToken, ErrorCode, ToolError};
use wasm_bindgen::prelude::*;

mod errors;
mod kernel_probe;
mod parallel;
mod progress;
mod types;

pub use kernel_probe::{kernel_samples, tap_samples};
pub use parallel::Serial;
pub use progress::JsProgress;
pub use types::{Capabilities, LimitsDto};

/// 契约版本，前端启动时自检。
#[wasm_bindgen]
pub fn contract_version() -> u32 {
    media_ports::CONTRACT_VERSION
}

/// core 版本（含 git 短哈希，构建时注入）。
#[wasm_bindgen]
pub fn version() -> String {
    format!("{} ({})", env!("CARGO_PKG_VERSION"), "dev")
}

/// 阈值（JSON）。
#[wasm_bindgen]
pub fn get_limits() -> Result<String, JsValue> {
    serde_json::to_string(&LimitsDto::from_limits(&Limits::WEB, 1))
        .map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

/// 能力（JSON）。Web 侧固定为「受限」形态。
#[wasm_bindgen]
pub fn get_capabilities() -> Result<String, JsValue> {
    let fmt = media_ports::codec::WebCodecs.formats();
    let caps = Capabilities::web(&fmt, 1);
    serde_json::to_string(&caps).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

/// 错误码表（JSON），前端用它渲染中文文案，不在 TS 里复制一份。
#[wasm_bindgen]
pub fn get_error_spec() -> Result<String, JsValue> {
    let specs: Vec<_> = ErrorCode::ALL
        .iter()
        .map(|&c| media_ports::spec(c))
        .collect();
    serde_json::to_string(&specs).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

/// 只读探测。
#[wasm_bindgen]
pub fn probe_image_meta(input: &[u8]) -> Result<String, JsValue> {
    let meta = probe_image(input, &Limits::WEB).map_err(err_to_js)?;
    serde_json::to_string(&meta).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

/// 完整处理（一步到位）。进度回调签名：`(done: number, total: number, phase: string) => void`。
#[wasm_bindgen]
pub fn process_image(
    input: &[u8],
    params_json: &str,
    encode_json: &str,
    on_progress: Option<js_sys::Function>,
) -> Result<Vec<u8>, JsValue> {
    let params: ImageParams = parse(params_json)?;
    let opts: EncodeOptions = parse(encode_json)?;

    let prog = JsProgress::new(on_progress);
    let throttled = ThrottledProgress::new(&prog, &now_ms).with_interval(100);
    let cancel = NeverCancelLocal;
    let ctx = Ctx {
        parallel: &Serial,
        progress: &throttled,
        cancel: &cancel,
        limits: &Limits::WEB,
    };

    let result = media_core::image::pipeline::process_image(input, &params, &opts, &ctx)
        .map_err(err_to_js)?;
    Ok(result.output)
}

/// 处理并返回完整结果 JSON（含尺寸、体积、哈希），供 UI 展示「体积节省」。
#[wasm_bindgen]
pub fn process_image_with_meta(
    input: &[u8],
    params_json: &str,
    encode_json: &str,
    on_progress: Option<js_sys::Function>,
) -> Result<String, JsValue> {
    let params: ImageParams = parse(params_json)?;
    let opts: EncodeOptions = parse(encode_json)?;

    let prog = JsProgress::new(on_progress);
    let throttled = ThrottledProgress::new(&prog, &now_ms).with_interval(100);
    let cancel = NeverCancelLocal;
    let ctx = Ctx {
        parallel: &Serial,
        progress: &throttled,
        cancel: &cancel,
        limits: &Limits::WEB,
    };

    let r = media_core::image::pipeline::process_image(input, &params, &opts, &ctx)
        .map_err(err_to_js)?;

    // 输出字节单独取（避免 base64 膨胀），这里只返回元数据
    let meta = serde_json::json!({
        "outFormat": r.out_format,
        "outWidth": r.out_width,
        "outHeight": r.out_height,
        "inputBytes": r.input_bytes,
        "outputBytes": r.output_bytes,
        "outputHash": r.output_hash,
        "savingsRatio": media_core::image::pipeline::savings_ratio(r.input_bytes, r.output_bytes),
        "savingsText": media_core::image::pipeline::savings_text(r.input_bytes, r.output_bytes),
    });
    Ok(meta.to_string())
}

/// 两阶段处理的第 1 阶段：解码 + 全部变换，返回 PNG 编码的中间结果。
///
/// 为什么中间结果用 PNG：无损、能保留 alpha，且浏览器能直接 `createImageBitmap` 用于预览。
/// 代价是一次额外编码（10-20 MP 约 200–600ms），但换来「可取消」与「可预览」。
#[wasm_bindgen]
pub fn process_stage_transform(
    input: &[u8],
    params_json: &str,
    on_progress: Option<js_sys::Function>,
) -> Result<Vec<u8>, JsValue> {
    let params: ImageParams = parse(params_json)?;
    let prog = JsProgress::new(on_progress);
    let throttled = ThrottledProgress::new(&prog, &now_ms).with_interval(100);
    let ctx = Ctx {
        parallel: &Serial,
        progress: &throttled,
        cancel: &NeverCancelLocal,
        limits: &Limits::WEB,
    };

    let img = media_core::image::pipeline::process_stage_decode(input, &params, &ctx)
        .map_err(err_to_js)?;

    let png = EncodeOptions {
        format: ImageFormat::Png,
        ..Default::default()
    };
    encode(&img, &png).map_err(err_to_js)
}

/// 两阶段处理的第 2 阶段：把上一步的中间图重编码为目标格式。
#[wasm_bindgen]
pub fn process_stage_encode(
    intermediate: &[u8],
    encode_json: &str,
    background_json: Option<String>,
) -> Result<Vec<u8>, JsValue> {
    let opts: EncodeOptions = parse(encode_json)?;
    let bg: Rgba8 = match background_json {
        Some(s) => parse(&s)?,
        None => Rgba8::default(),
    };

    let mut img = media_core::image::decode::decode_rgba(intermediate).map_err(err_to_js)?;
    if opts.drops_alpha() && !img.is_opaque() {
        img = media_core::image::geometry::flatten_background(&img, bg);
    }
    encode(&img, &opts).map_err(err_to_js)
}

/// 生成缩略图（预览用，返回 PNG）。
#[wasm_bindgen]
pub fn make_thumbnail(input: &[u8], max_side: u32) -> Result<Vec<u8>, JsValue> {
    let img = media_core::image::decode::decode_rgba(input).map_err(err_to_js)?;
    let thumb = media_core::image::encode::thumbnail(&img, max_side).map_err(err_to_js)?;
    encode(
        &thumb,
        &EncodeOptions {
            format: ImageFormat::Png,
            ..Default::default()
        },
    )
    .map_err(err_to_js)
}

/// 内容哈希（blake3 hex）。用于双端一致性比对与缓存键。
#[wasm_bindgen]
pub fn hash_bytes(input: &[u8]) -> String {
    media_core::common::hash::blake3_hex(input)
}

/// 输出文件名。
#[wasm_bindgen]
pub fn make_output_name(
    stem: &str,
    params_json: &str,
    encode_json: &str,
) -> Result<String, JsValue> {
    let params: ImageParams = parse(params_json)?;
    let opts: EncodeOptions = parse(encode_json)?;
    media_core::image::pipeline::output_name(stem, &params, &opts).map_err(err_to_js)
}

/// 人类可读体积/时长（前端不重复实现），便于 UI 与错误文案完全一致。
#[wasm_bindgen]
pub fn format_bytes(n: f64) -> String {
    human_bytes(n.max(0.0) as u64)
}

#[wasm_bindgen]
pub fn format_duration(secs: f64) -> String {
    human_duration(secs.max(0.0) as u64)
}

// ---------- 内部 ----------

/// 单调时钟：`performance.now()`（ms，浮点）。节流只需要相对时间，浮点转 u64 足够。
fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

/// wasm 侧永远不可取消（即时取消靠 worker.terminate）。
struct NeverCancelLocal;

impl CancelToken for NeverCancelLocal {
    fn is_cancelled(&self) -> bool {
        false
    }
}

fn parse<T: for<'de> serde::Deserialize<'de>>(s: &str) -> Result<T, JsValue> {
    serde_json::from_str(s)
        .map_err(|e| err_to_js(ToolError::invalid(format!("JSON 解析失败: {e}"))))
}

fn err_to_js(e: ToolError) -> JsValue {
    errors::to_js(&e)
}
