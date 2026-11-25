// Project 4 的 wasm 导出：PDF 结构操作、视频参数、文档结构化。
// 每个函数只在对应 feature 打开时编译（分包）。
// 输入是 Uint8Array / JSON 字符串，输出是 Vec<u8> / JSON（与 crates/wasm/src/lib.rs 的约定一致）。

#[cfg(feature = "doc")]
#[wasm_bindgen]
pub fn pdf_probe(input: &[u8]) -> Result<String, JsValue> {
    let limits = media_ports::Limits::WEB;
    let meta = media_core::pdf::probe_pdf(input).map_err(err_to_js)?;
    // 前置页数校验（超限直接中止，规格 §13）
    media_core::common::limits_check::check_pages(meta.pages, &limits).map_err(err_to_js)?;
    serde_json::to_string(&meta).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

#[cfg(feature = "doc")]
#[wasm_bindgen]
pub fn pdf_merge(inputs: Vec<JsValue>) -> Result<Vec<u8>, JsValue> {
    let chunks: Vec<Vec<u8>> = inputs
        .iter()
        .map(|v| v.clone().dyn_into::<js_sys::Uint8Array>())
        .map(|r| {
            r.map(|a| a.to_vec())
                .map_err(|_| JsValue::from_str("输入必须是 Uint8Array"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    media_core::pdf::pdf_merge(&chunks).map_err(err_to_js)
}

#[cfg(feature = "doc")]
#[wasm_bindgen]
pub fn pdf_split(
    input: &[u8],
    ranges_json: &str,
    page_selector_json: &str,
) -> Result<String, JsValue> {
    let ranges: Vec<media_core::pdf::PageRange> = serde_json::from_str(ranges_json)
        .map_err(|e| JsValue::from_str(&format!("页码范围解析失败: {e}")))?;
    let _selector: serde_json::Value = serde_json::from_str(page_selector_json)
        .map_err(|e| JsValue::from_str(&format!("页面选择器解析失败: {e}")))?;
    let parts =
        media_core::pdf::pdf_split(input, &ranges, &media_ports::Limits::WEB).map_err(err_to_js)?;

    // 返回 [{name, bytes: base64}]，避免二进制跨域边界
    let out: Vec<serde_json::Value> = parts
        .into_iter()
        .map(|(name, bytes)| serde_json::json!({ "name": name, "bytes": base64_encode(&bytes) }))
        .collect();
    serde_json::to_string(&out).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

#[cfg(feature = "doc")]
#[wasm_bindgen]
pub fn pdf_rotate(input: &[u8], selector_json: &str, degrees: i32) -> Result<Vec<u8>, JsValue> {
    let selector: media_core::pdf::PageSelector = serde_json::from_str(selector_json)
        .map_err(|e| JsValue::from_str(&format!("页面选择器解析失败: {e}")))?;
    media_core::pdf::pdf_rotate(input, &selector, degrees, &media_ports::Limits::WEB)
        .map_err(err_to_js)
}

#[cfg(feature = "doc")]
#[wasm_bindgen]
pub fn pdf_extract(
    input: &[u8],
    selector_json: &str,
    what: &str, // "text" | "images" | "pages"
) -> Result<String, JsValue> {
    let selector: media_core::pdf::PageSelector = serde_json::from_str(selector_json)
        .map_err(|e| JsValue::from_str(&format!("页面选择器解析失败: {e}")))?;
    let limits = media_ports::Limits::WEB;
    match what {
        "text" => {
            let text =
                media_core::pdf::pdf_extract_text(input, &selector, &limits).map_err(err_to_js)?;
            serde_json::to_string(&serde_json::json!({ "text": text }))
                .map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
        }
        "images" => {
            let images = media_core::pdf::pdf_extract_images(input, &selector, &limits)
                .map_err(err_to_js)?;
            let out: Vec<serde_json::Value> = images
                .into_iter()
                .map(|(name, bytes)| serde_json::json!({ "name": name, "bytes": base64_encode(&bytes) }))
                .collect();
            serde_json::to_string(&out).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
        }
        "pages" => {
            let out =
                media_core::pdf::pdf_extract_pages(input, &selector, &limits).map_err(err_to_js)?;
            Ok(base64_encode(&out))
        }
        _ => Err(JsValue::from_str("what 必须是 text / images / pages")),
    }
}

// ---- 视频（纯函数：argv 构造与进度解析）----

#[cfg(feature = "video")]
#[wasm_bindgen]
pub fn video_build_args(params_json: &str, input: &str, output: &str) -> Result<String, JsValue> {
    let params: media_core::video::TranscodeParams = serde_json::from_str(params_json)
        .map_err(|e| JsValue::from_str(&format!("参数解析失败: {e}")))?;
    let args =
        media_core::video::build_transcode_args(&params, input, output).map_err(err_to_js)?;
    serde_json::to_string(&args).map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

#[cfg(feature = "video")]
#[wasm_bindgen]
pub fn video_parse_progress(total_sec: f64, line: &str) -> Result<String, JsValue> {
    // 静态解析器：协议要求每次调用新建（无状态跨调用）
    let mut p = media_core::video::ProgressParser::new(total_sec);
    let fraction = p.feed_line(line);
    serde_json::to_string(&serde_json::json!({
        "fraction": fraction,
        "finished": p.finished,
    }))
    .map_err(|e| JsValue::from_str(&format!("序列化失败: {e}")))
}

// ---- 文档结构化辅助 ----

#[cfg(feature = "office")]
#[wasm_bindgen]
pub fn office_structure_text(raw: &str) -> Result<String, JsValue> {
    let paras = media_core::office::structure_text(raw);
    media_core::office::paragraphs_to_json(&paras).map_err(err_to_js)
}

#[cfg(feature = "office")]
#[wasm_bindgen]
pub fn office_fidelity_note(direction: &str) -> Result<String, JsValue> {
    use media_core::office::FidelityDirection;
    let d = match direction {
        "docx2pdf" => FidelityDirection::DocxToPdf,
        "pdf2docx" => FidelityDirection::PdfToDocx,
        _ => return Err(JsValue::from_str("direction 必须是 docx2pdf / pdf2docx")),
    };
    Ok(media_core::office::fidelity_note(d).to_string())
}

// ---- 内部：base64（纯 Rust，无额外依赖）----
#[cfg(feature = "doc")]
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

use wasm_bindgen::prelude::*;
fn err_to_js(e: media_ports::ToolError) -> JsValue {
    JsValue::from_str(&crate::errors::to_json_string(&e))
}
