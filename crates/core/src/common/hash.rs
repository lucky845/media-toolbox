//! 内容指纹（blake3）。
//!
//! 用途：
//! 1. 双端一致性测试：`blake3(web_out) == blake3(native_out)`；
//! 2. 前端缓存键与「用相同参数再跑一次」的去重；
//! 3. 输出命名的参数摘要。
//!
//! 为什么不用 SHA-256：blake3 在纯 Rust 下更快、无 C 依赖，且 wasm32 可用。
//! 为什么是内容哈希而不是时间戳：时间戳在两端不可能一致，会让一致性测试变成噪音。

use media_ports::error::Result;

/// 计算内容哈希，返回 64 位小写十六进制。
pub fn blake3_hex(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

/// 各取前 8 个十六进制字符（32 bit），用于文件名里的参数摘要。
/// 碰撞概率对「同一目录下的少量输出」足够低；如果真撞了，写文件时会被覆盖检测拦住。
pub fn short_digest(data: &[u8]) -> String {
    let full = blake3_hex(data);
    full[..8].to_string()
}

/// 计算「参数摘要」：把参数序列化后取短哈希，用于输出命名。
pub fn params_digest<T: serde::Serialize>(params: &T) -> Result<String> {
    let json = serde_json::to_vec(params)
        .map_err(|e| media_ports::ToolError::internal(format!("参数序列化失败: {e}")))?;
    Ok(short_digest(&json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_has_expected_length_and_charset() {
        let h = blake3_hex(b"hello");
        assert_eq!(h.len(), 64);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn short_digest_is_prefix() {
        let data = b"media-toolbox";
        assert_eq!(short_digest(data), &blake3_hex(data)[..8]);
    }

    #[test]
    fn different_inputs_differ() {
        assert_ne!(blake3_hex(b"a"), blake3_hex(b"b"));
    }

    #[test]
    fn same_input_stable() {
        assert_eq!(blake3_hex(b"stable"), blake3_hex(b"stable"));
    }

    #[test]
    fn params_digest_is_order_sensitive_on_struct_fields() {
        #[derive(serde::Serialize)]
        struct P {
            q: u8,
        }
        let a = params_digest(&P { q: 75 }).unwrap();
        let b = params_digest(&P { q: 76 }).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 8);
    }
}
