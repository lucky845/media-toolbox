//! 字节输入源。
//!
//! `core` 只接受 `&[u8]`（规格 §11：core 不碰文件路径），所以这里定义的是
//! 「如何把一份输入安全地取进内存」的抽象。native 实现是分块读文件 + 传进 core；
//! wasm 实现是从 JS `Uint8Array` 取一份。
//!
//! 注意：本 trait 只负责「取一次完整输入」，不做流式 —— 需要流式的大文件在
//! `crates/native` 里先用临时文件 + 子进程处理，根本不进 core。

use crate::error::{ErrorCode, Result, ToolError};

/// 一份可读的字节源。
pub trait Source {
    /// 逻辑名称（文件名），用于日志与输出命名。**不得**包含完整路径。
    fn name(&self) -> &str;

    /// 声明的字节数；未知时返回 None（例如某些流）。
    fn len(&self) -> Option<u64>;

    /// 读取全部字节。
    fn read_all(&mut self) -> Result<Vec<u8>>;

    fn is_empty(&self) -> bool {
        matches!(self.len(), Some(0))
    }

    /// 按 `Limits.max_bytes` 做前置校验，避免读到一半才发现超限。
    fn check_limit(&self, max_bytes: u64) -> Result<()> {
        if let Some(n) = self.len() {
            if n > max_bytes {
                let human = crate::codec::human_bytes(n);
                let limit = crate::codec::human_bytes(max_bytes);
                return Err(ToolError::new(
                    ErrorCode::InputTooLarge,
                    &[("limit", &format!("{limit}，当前 {human}"))],
                ));
            }
        }
        Ok(())
    }
}

/// 内存源：wasm 侧唯一实现，也是 native 侧的「已读入」形态。
pub struct MemorySource {
    name: String,
    data: Vec<u8>,
}

impl MemorySource {
    pub fn new(name: impl Into<String>, data: Vec<u8>) -> Self {
        MemorySource {
            name: name.into(),
            data,
        }
    }

    /// 从静态切片构造（测试用）。
    pub fn from_slice(name: impl Into<String>, data: &[u8]) -> Self {
        MemorySource {
            name: name.into(),
            data: data.to_vec(),
        }
    }
}

impl Source for MemorySource {
    fn name(&self) -> &str {
        &self.name
    }

    fn len(&self) -> Option<u64> {
        Some(self.data.len() as u64)
    }

    fn read_all(&mut self) -> Result<Vec<u8>> {
        // 用 mem::take 避免复制：调用方拿走所有权
        Ok(std::mem::take(&mut self.data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_all_moves_data() {
        let mut s = MemorySource::from_slice("a.png", &[1, 2, 3]);
        assert_eq!(s.len(), Some(3));
        assert_eq!(s.read_all().unwrap(), vec![1, 2, 3]);
        // 取走后为空
        assert!(s.read_all().unwrap().is_empty());
    }

    #[test]
    fn limit_check_reports_both_numbers() {
        let s = MemorySource::from_slice("a.png", &vec![0u8; 2048]);
        let e = s.check_limit(1024).unwrap_err();
        assert_eq!(e.code, ErrorCode::InputTooLarge);
        assert!(e.message.contains("1.0 KB"), "实际: {}", e.message);
    }
}
