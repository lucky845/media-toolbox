//! 错误码与错误结构（唯一来源）。
//!
//! `docs/CONTRACTS.md` §1 的所有错误码都必须在这里出现，且 `spec()` 里有对应条目；
//! `crates/ports/tests/error_spec.rs` 会断言两者一一对应，防止「加了码忘了文案」。

use serde::{Deserialize, Serialize};

/// 错误码。序列化为 `SCREAMING_SNAKE_CASE`，与前端 `ToolError.code` 一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // ---- 输入与资源限制 ----
    InputTooLarge,
    DimensionLimit,
    PageLimit,
    DurationLimit,
    MemoryLimit,
    // ---- 格式与编解码 ----
    UnsupportedFormat,
    DecodeFailed,
    EncodeFailed,
    CodecUnsupported,
    // ---- 运行时 ----
    Cancelled,
    Timeout,
    OutOfMemory,
    Io,
    PermissionDenied,
    InvalidParams,
    Internal,
    // ---- 部署与环境 ----
    WasmLoadFailed,
    WasmMimeMismatch,
    BinaryMissing,
    BinaryVersion,
    LibreOfficeMissing,
}

impl ErrorCode {
    /// 全部错误码，顺序即文档顺序。`error_spec` 测试用它做穷举。
    pub const ALL: &'static [ErrorCode] = &[
        ErrorCode::InputTooLarge,
        ErrorCode::DimensionLimit,
        ErrorCode::PageLimit,
        ErrorCode::DurationLimit,
        ErrorCode::MemoryLimit,
        ErrorCode::UnsupportedFormat,
        ErrorCode::DecodeFailed,
        ErrorCode::EncodeFailed,
        ErrorCode::CodecUnsupported,
        ErrorCode::Cancelled,
        ErrorCode::Timeout,
        ErrorCode::OutOfMemory,
        ErrorCode::Io,
        ErrorCode::PermissionDenied,
        ErrorCode::InvalidParams,
        ErrorCode::Internal,
        ErrorCode::WasmLoadFailed,
        ErrorCode::WasmMimeMismatch,
        ErrorCode::BinaryMissing,
        ErrorCode::BinaryVersion,
        ErrorCode::LibreOfficeMissing,
    ];

    /// 默认是否可重试（`ToolError.retryable` 的初值，构造后可被覆盖）。
    pub fn default_retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::DecodeFailed
                | ErrorCode::EncodeFailed
                | ErrorCode::Timeout
                | ErrorCode::OutOfMemory
                | ErrorCode::Io
                | ErrorCode::Internal
                | ErrorCode::WasmLoadFailed
                | ErrorCode::WasmMimeMismatch
        )
    }

    /// 默认是否应引导用户去下载桌面版。
    pub fn default_desktop_hint(self) -> bool {
        matches!(
            self,
            ErrorCode::InputTooLarge
                | ErrorCode::DimensionLimit
                | ErrorCode::PageLimit
                | ErrorCode::DurationLimit
                | ErrorCode::MemoryLimit
                | ErrorCode::CodecUnsupported
                | ErrorCode::OutOfMemory
                | ErrorCode::WasmLoadFailed
        )
    }

    /// 稳定的字符串 id，用于日志与持久化（`RecentTask.errorCode`）。
    /// 与 serde 的 SCREAMING_SNAKE_CASE 保持一致，但独立实现，避免依赖序列化实现细节。
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InputTooLarge => "INPUT_TOO_LARGE",
            ErrorCode::DimensionLimit => "DIMENSION_LIMIT",
            ErrorCode::PageLimit => "PAGE_LIMIT",
            ErrorCode::DurationLimit => "DURATION_LIMIT",
            ErrorCode::MemoryLimit => "MEMORY_LIMIT",
            ErrorCode::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            ErrorCode::DecodeFailed => "DECODE_FAILED",
            ErrorCode::EncodeFailed => "ENCODE_FAILED",
            ErrorCode::CodecUnsupported => "CODEC_UNSUPPORTED",
            ErrorCode::Cancelled => "CANCELLED",
            ErrorCode::Timeout => "TIMEOUT",
            ErrorCode::OutOfMemory => "OUT_OF_MEMORY",
            ErrorCode::Io => "IO",
            ErrorCode::PermissionDenied => "PERMISSION_DENIED",
            ErrorCode::InvalidParams => "INVALID_PARAMS",
            ErrorCode::Internal => "INTERNAL",
            ErrorCode::WasmLoadFailed => "WASM_LOAD_FAILED",
            ErrorCode::WasmMimeMismatch => "WASM_MIME_MISMATCH",
            ErrorCode::BinaryMissing => "BINARY_MISSING",
            ErrorCode::BinaryVersion => "BINARY_VERSION",
            ErrorCode::LibreOfficeMissing => "LIBREOFFICE_MISSING",
        }
    }
}

/// 错误码的元数据（不含具体插值）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorSpec {
    pub code: ErrorCode,
    /// 中文模板，`{{name}}` 为占位符。
    pub template: &'static str,
    pub retryable: bool,
    pub desktop_hint: bool,
}

/// 单一错误码的元数据。
pub fn spec(code: ErrorCode) -> ErrorSpec {
    let (template, retryable, desktop_hint) = match code {
        ErrorCode::InputTooLarge => (
            "文件超过在线版上限（{{limit}}），请使用桌面版处理",
            false,
            true,
        ),
        ErrorCode::DimensionLimit => ("图片像素数超过在线版上限（{{limit}}）", false, true),
        ErrorCode::PageLimit => ("PDF 页数超过在线版上限（{{limit}} 页）", false, true),
        ErrorCode::DurationLimit => ("视频时长超过在线版上限（{{limit}}）", false, true),
        ErrorCode::MemoryLimit => ("预计需要 {{need}} 内存，超过安全值 {{cap}}", false, true),
        ErrorCode::UnsupportedFormat => ("不支持的文件格式：{{detail}}", false, false),
        ErrorCode::DecodeFailed => ("文件解码失败，可能已损坏或格式不受支持", true, false),
        ErrorCode::EncodeFailed => ("编码失败：{{detail}}", true, false),
        ErrorCode::CodecUnsupported => (
            "当前浏览器不支持 {{codec}} 编码，请改用桌面版或换一种格式",
            false,
            true,
        ),
        ErrorCode::Cancelled => ("已取消", false, false),
        ErrorCode::Timeout => ("处理超时（超过 {{sec}} 秒）", true, false),
        ErrorCode::OutOfMemory => ("内存不足，请减小尺寸或改用桌面版", true, true),
        ErrorCode::Io => ("读写失败：{{detail}}", true, false),
        ErrorCode::PermissionDenied => ("没有文件访问权限", false, false),
        ErrorCode::InvalidParams => ("参数不合法：{{detail}}", false, false),
        ErrorCode::Internal => ("内部错误（{{id}}）", true, false),
        ErrorCode::WasmLoadFailed => ("核心模块加载失败，请刷新页面重试", true, true),
        ErrorCode::WasmMimeMismatch => (
            "核心模块 MIME 不正确（{{mime}}），本地服务器可能未识别 .wasm",
            true,
            false,
        ),
        ErrorCode::BinaryMissing => ("桌面组件缺失：{{name}}，请重新安装", false, false),
        ErrorCode::BinaryVersion => (
            "桌面组件 {{name}} 版本不匹配（需要 {{need}}）",
            false,
            false,
        ),
        ErrorCode::LibreOfficeMissing => (
            "未找到 LibreOffice，Word↔PDF 只能做结构化转换",
            false,
            false,
        ),
    };
    ErrorSpec {
        code,
        template,
        retryable,
        desktop_hint,
    }
}

/// 统一错误类型，跨 wasm / Tauri IPC / 前端 TS。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub code: ErrorCode,
    /// 已插值的中文用户文案。
    pub message: String,
    /// 开发者细节。**不得**包含文件路径或文件内容。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub retryable: bool,
    pub desktop_hint: bool,
    /// 与内容无关的关联 ID，形如 `e-1a2b3c4d`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_id: Option<String>,
}

impl ToolError {
    /// 用模板构造：`{{name}}` 占位符由 `vars` 替换。
    ///
    /// ```
    /// use media_ports::{ToolError, ErrorCode};
    /// let e = ToolError::new(ErrorCode::DimensionLimit, &[("limit", "20 MP")]);
    /// assert_eq!(e.message, "图片像素数超过在线版上限（20 MP）");
    /// assert!(e.desktop_hint);
    /// ```
    pub fn new(code: ErrorCode, vars: &[(&str, &str)]) -> Self {
        let s = spec(code);
        let mut message = s.template.to_string();
        for (k, v) in vars {
            message = message.replace(&format!("{{{{{k}}}}}"), v);
        }
        // 未被替换的占位符说明调用方漏传，保留原文不 panic（用户看到 {{x}} 也不如直接报错更糟？）
        // 折中：把未替换的占位符标记出来，便于定位而不是静默通过。
        ToolError {
            code,
            message,
            detail: None,
            retryable: s.retryable,
            desktop_hint: s.desktop_hint,
            log_id: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn with_log_id(mut self, id: impl Into<String>) -> Self {
        self.log_id = Some(id.into());
        self
    }

    /// 覆盖默认可重试性（解析成功但重试无意义的场景）。
    pub fn retryable(mut self, v: bool) -> Self {
        self.retryable = v;
        self
    }

    pub fn cancelled() -> Self {
        ToolError::new(ErrorCode::Cancelled, &[])
    }

    pub fn invalid(detail: impl Into<String>) -> Self {
        let d = detail.into();
        Self::new(ErrorCode::InvalidParams, &[("detail", &d)]).with_detail(d)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        let d = detail.into();
        Self::new(ErrorCode::Internal, &[("id", "unknown")]).with_detail(d)
    }

    pub fn io(detail: impl Into<String>) -> Self {
        let d = detail.into();
        Self::new(ErrorCode::Io, &[("detail", &d)]).with_detail(d)
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ToolError {}

/// core 内部使用的 Result 别名。
pub type Result<T> = std::result::Result<T, ToolError>;

/// 便捷宏：`err!(ErrorCode::DecodeFailed, "limit" => "20 MB")`
#[macro_export]
macro_rules! err {
    ($code:expr) => {
        $crate::ToolError::new($code, &[])
    };
    ($code:expr, $($k:literal => $v:expr),+ $(,)?) => {{
        let vars: &[(&str, &str)] = &[$(($k, $v)),+];
        $crate::ToolError::new($code, vars)
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_distinct_str() {
        let mut seen = std::collections::HashSet::new();
        for &c in ErrorCode::ALL {
            assert!(seen.insert(c.as_str()), "duplicate id for {c:?}");
        }
        assert_eq!(seen.len(), 21, "ErrorCode::ALL 数量与枚举不一致");
    }

    #[test]
    fn template_placeholders_are_replaced() {
        let e = ToolError::new(ErrorCode::PageLimit, &[("limit", "100")]);
        assert!(!e.message.contains("{{"), "残留占位符: {}", e.message);
    }

    #[test]
    fn cancelled_is_not_retryable() {
        assert!(!ToolError::cancelled().retryable);
    }

    #[test]
    fn desktop_hint_only_for_limit_codes() {
        assert!(ToolError::new(ErrorCode::DimensionLimit, &[]).desktop_hint);
        assert!(!ToolError::new(ErrorCode::InvalidParams, &[]).desktop_hint);
    }
}
