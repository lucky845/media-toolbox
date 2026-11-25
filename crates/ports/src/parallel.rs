//! 并行抽象（双形态最易翻车处的唯一出口）。
//!
//! 铁律：`core` 里**禁止**出现 `rayon`、`std::thread`、`cfg(target_arch)`。
//! 只能通过本 trait 拿并行；wasm 走 `SerialParallel`（并行度 1），native 走 `RayonParallel`。
//!
//! ## 为什么是泛型 trait 而不是 `&dyn Parallel`
//!
//! 重采样的中间缓冲是 `[f32]`、最终输出是 `[u8]`，两者都要按行并行写入。
//! 若 trait 方法只能吃 `&mut [u8]`，f32 缓冲就无法安全地分块（`forbid(unsafe_code)` 下没有别的办法）。
//! 泛型方法让 trait 失去对象安全性，因此 `core` 的入口用 `P: Parallel` 单态化 ——
//! 这正好也是零开销的：wasm 只会实例化 `SerialParallel`，native 只会实例化 `RayonParallel`。
//!
//! ## 确定性契约（`docs/ARCHITECTURE.md` §3.2）
//!
//! 块的划分由调用方（core）决定，实现方**不得**改动块边界；
//! 每个输出单元只能依赖输入中同索引的单元。否则并行结果会与串行不同，
//! 双端一致性测试（blake3 比对）会失败。

/// 并行执行器。
pub trait Parallel: Sync {
    /// 建议并发度。native = 线程池大小；wasm = 1。
    fn parallelism(&self) -> usize;

    /// 把 `buf` 按 `chunk_len` 个元素切块，每块恰好被处理一次。
    ///
    /// 契约：
    /// - 块顺序不保证，但**每个元素恰好被访问一次**；
    /// - `chunk_len == 0` 视为编程错误，实现方应当退化为「整块一次」（不得 panic）；
    /// - 回调 `f(块起始元素索引, 块切片)`。起始索引是**元素**索引，不是字节索引。
    fn for_each_chunk_mut<T: Send>(
        &self,
        buf: &mut [T],
        chunk_len: usize,
        f: &(dyn Fn(usize, &mut [T]) + Sync),
    );

    /// 处理 `n` 个互相独立的工作单元（PDF 页、视频帧段、批量文件的第 i 个）。
    fn for_each_unit(&self, n: usize, f: &(dyn Fn(usize) + Sync));
}

/// 单线程实现：wasm 的唯一实现，也是 native 单测里「串行 = 并行」的对照组。
pub struct SerialParallel;

impl Parallel for SerialParallel {
    fn parallelism(&self) -> usize {
        1
    }

    fn for_each_chunk_mut<T: Send>(
        &self,
        buf: &mut [T],
        chunk_len: usize,
        f: &(dyn Fn(usize, &mut [T]) + Sync),
    ) {
        if buf.is_empty() {
            return;
        }
        if chunk_len == 0 {
            // 退化：整块一次，绝不 panic
            f(0, buf);
            return;
        }
        for (i, chunk) in buf.chunks_mut(chunk_len).enumerate() {
            f(i * chunk_len, chunk);
        }
    }

    fn for_each_unit(&self, n: usize, f: &(dyn Fn(usize) + Sync)) {
        for i in 0..n {
            f(i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_covers_every_element_exactly_once() {
        let mut buf = vec![0u32; 1000];
        SerialParallel.for_each_chunk_mut(&mut buf, 7, &|_start, chunk| {
            for b in chunk.iter_mut() {
                *b += 1;
            }
        });
        assert!(buf.iter().all(|&b| b == 1));
    }

    #[test]
    fn serial_start_index_is_absolute_element_index() {
        let mut buf = vec![0u8; 10];
        let starts = std::sync::Mutex::new(Vec::new());
        SerialParallel.for_each_chunk_mut(&mut buf, 3, &|start, _chunk| {
            starts.lock().unwrap().push(start);
        });
        assert_eq!(*starts.lock().unwrap(), vec![0, 3, 6, 9]);
    }

    #[test]
    fn zero_chunk_len_does_not_hang_or_panic() {
        let mut buf = vec![1u8; 10];
        SerialParallel.for_each_chunk_mut(&mut buf, 0, &|_s, chunk| {
            for b in chunk.iter_mut() {
                *b = 2;
            }
        });
        assert!(buf.iter().all(|&b| b == 2));
    }

    #[test]
    fn empty_buffer_is_noop() {
        let mut buf: Vec<u8> = Vec::new();
        let called = std::sync::atomic::AtomicUsize::new(0);
        SerialParallel.for_each_chunk_mut(&mut buf, 4, &|_s, _c| {
            called.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        assert_eq!(called.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[test]
    fn for_each_unit_visits_all() {
        let n = 10;
        let seen = std::sync::Mutex::new(vec![false; n]);
        SerialParallel.for_each_unit(n, &|i| {
            seen.lock().unwrap()[i] = true;
        });
        assert!(seen.lock().unwrap().iter().all(|&v| v));
    }

    #[test]
    fn works_with_f32_buffers() {
        let mut buf = vec![0f32; 12];
        SerialParallel.for_each_chunk_mut(&mut buf, 4, &|_s, chunk| {
            for v in chunk.iter_mut() {
                *v = 1.5;
            }
        });
        assert!(buf.iter().all(|&v| (v - 1.5).abs() < f32::EPSILON));
    }
}
