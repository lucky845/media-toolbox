//! 字节输出目标。
//!
//! Web：写进 wasm 堆后由 wasm-bindgen 复制回 JS；桌面：写文件。
//! `core` 只往 `Sink` 里写，不关心落点。

use crate::error::Result;

/// 可写的字节目标。
pub trait Sink {
    /// 写入一段（可能被多次调用）。
    fn write(&mut self, data: &[u8]) -> Result<()>;

    /// 完成写入（flush + close）。重复调用应当是幂等的。
    fn finish(&mut self) -> Result<()>;

    /// 已写入字节数。
    fn written(&self) -> u64;
}

/// 内存 sink：返回 `Vec<u8>`，是 zero-copy 的最小实现。
#[derive(Default)]
pub struct MemorySink {
    buf: Vec<u8>,
}

impl MemorySink {
    pub fn new() -> Self {
        MemorySink::default()
    }

    pub fn with_capacity(n: usize) -> Self {
        MemorySink {
            buf: Vec::with_capacity(n),
        }
    }

    /// 取出结果（消耗 self）。
    pub fn into_inner(self) -> Vec<u8> {
        self.buf
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }
}

impl Sink for MemorySink {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.buf.extend_from_slice(data);
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        Ok(())
    }

    fn written(&self) -> u64 {
        self.buf.len() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_and_reports() {
        let mut s = MemorySink::new();
        s.write(b"hello").unwrap();
        s.write(b" world").unwrap();
        assert_eq!(s.written(), 11);
        s.finish().unwrap();
        assert_eq!(s.into_inner(), b"hello world".to_vec());
    }

    #[test]
    fn finish_is_idempotent() {
        let mut s = MemorySink::new();
        s.finish().unwrap();
        s.finish().unwrap();
        assert_eq!(s.written(), 0);
    }
}
