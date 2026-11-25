//! 错误转 JsValue（wasm 侧单独一份，便于单测）。
//!
//! ## 一个必须遵守的测试约束
//!
//! `JsValue::from_str` 在**非 wasm32 目标**上会 panic（`function not implemented on
//! non-wasm32 targets`）。因此本 crate 的单元测试（`cargo test` 在主机上跑）**不能**触碰
//! 任何 `JsValue` 构造。
//!
//! 解决办法是把逻辑拆成两层：
//!  - `to_json_string(&ToolError) -> String` —— 纯逻辑，主机上可测；
//!  - `to_js(&ToolError) -> JsValue`      —— 只做 `JsValue::from_str` 包装，不测。
//!
//! 这不是为了测试而测试：它保证了「错误序列化」这个契约在 CI 的 `cargo test`
//! 阶段就能被验证，而不必等到浏览器里才发现字段少了一个。

use media_ports::ToolError;
use wasm_bindgen::JsValue;

/// 序列化成 JSON 字符串（纯逻辑，可在主机上单测）。
pub fn to_json_string(e: &ToolError) -> String {
    serde_json::to_string(e).unwrap_or_else(|_| {
        // 兜底：连序列化都失败时，给一个结构完整的最小对象，
        // 保证前端 `JSON.parse` 不会抛第二个错。
        format!(
            r#"{{"code":"INTERNAL","message":"{}","retryable":true,"desktopHint":false}}"#,
            e.message.replace('"', "'")
        )
    })
}

/// 包成 `JsValue`。**只应在 wasm32 上调用**（主机上会 panic）。
pub fn to_js(e: &ToolError) -> JsValue {
    JsValue::from_str(&to_json_string(e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_ports::ErrorCode;

    #[test]
    fn serializes_code_and_message() {
        let e = ToolError::new(ErrorCode::DimensionLimit, &[("limit", "20 MP")]);
        let s = to_json_string(&e);
        assert!(s.contains("DIMENSION_LIMIT"));
        assert!(s.contains("20 MP"));
        assert!(s.contains("desktopHint"));
        // 必须是合法 JSON —— 前端会直接 JSON.parse
        let v: serde_json::Value = serde_json::from_str(&s).expect("必须是合法 JSON");
        assert_eq!(v["code"], "DIMENSION_LIMIT");
        assert_eq!(v["desktopHint"], true);
        assert_eq!(v["retryable"], false);
    }

    #[test]
    fn cancelled_serializes_without_desktop_hint() {
        let e = ToolError::cancelled();
        let v: serde_json::Value = serde_json::from_str(&to_json_string(&e)).unwrap();
        assert_eq!(v["code"], "CANCELLED");
        assert_eq!(v["desktopHint"], false);
        assert_eq!(v["retryable"], false);
    }

    #[test]
    fn detail_and_log_id_are_optional() {
        let e = ToolError::new(ErrorCode::Internal, &[("id", "e-1234")]);
        let v: serde_json::Value = serde_json::from_str(&to_json_string(&e)).unwrap();
        assert!(v.get("detail").is_none(), "detail 为空时不应出现在 JSON 里");
        assert!(v.get("logId").is_none());
    }

    #[test]
    fn all_error_codes_serialize() {
        // 穷举：任何一个码序列化失败都会在前端变成「未知错误」，必须提前发现
        for &code in ErrorCode::ALL {
            let e = ToolError::new(code, &[]);
            let s = to_json_string(&e);
            let v: serde_json::Value =
                serde_json::from_str(&s).unwrap_or_else(|err| panic!("{code:?} 序列化失败: {err}"));
            assert!(v["code"].is_string());
            assert!(v["message"].is_string());
        }
    }
}
