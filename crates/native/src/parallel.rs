//! rayon 并行实现。这是 native 侧唯一出现 `rayon` 的地方。

use media_ports::Parallel;
use rayon::prelude::*;

/// 基于 rayon 全局线程池的并行执行器。
///
/// `parallelism()` 返回线程池大小；用户可在设置里用 `new_with_threads` 指定更小的值
/// （通过局部线程池实现，避免影响全局池）。
pub struct RayonParallel {
    threads: usize,
}

impl Default for RayonParallel {
    fn default() -> Self {
        RayonParallel {
            threads: rayon::current_num_threads(),
        }
    }
}

impl RayonParallel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn new_with_threads(n: usize) -> Self {
        RayonParallel { threads: n.max(1) }
    }

    pub fn threads(&self) -> usize {
        self.threads
    }
}

impl Parallel for RayonParallel {
    fn parallelism(&self) -> usize {
        self.threads
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
            // 与 SerialParallel 的退化行为保持一致
            f(0, buf);
            return;
        }
        // `par_chunks_mut` 保证每个元素恰好被一个线程访问，且不重叠 —— 这正是契约要求的。
        buf.par_chunks_mut(chunk_len)
            .enumerate()
            .for_each(|(i, chunk)| f(i * chunk_len, chunk));
    }

    fn for_each_unit(&self, n: usize, f: &(dyn Fn(usize) + Sync)) {
        (0..n).into_par_iter().for_each(f);
    }
}

/// 在指定线程数的临时池里执行（不影响全局池）。
///
/// 为什么需要：批处理时用户可能想把并发压到 1（省电/省内存），
/// 但 `rayon::current_num_threads()` 是全局的，用临时池才不会污染其他调用。
pub fn with_threads<R: Send>(n: usize, f: impl FnOnce(&RayonParallel) -> R + Send) -> R {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(n.max(1))
        .build()
        .expect("创建临时 rayon 线程池失败");
    let p = RayonParallel::new_with_threads(n.max(1));
    pool.install(|| f(&p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[test]
    fn parallel_covers_every_element_exactly_once() {
        let p = RayonParallel::new_with_threads(4);
        let mut buf = vec![0u32; 10_000];
        p.for_each_chunk_mut(&mut buf, 37, &|_s, chunk| {
            for v in chunk.iter_mut() {
                *v += 1;
            }
        });
        assert!(buf.iter().all(|&v| v == 1));
    }

    #[test]
    fn start_index_is_absolute() {
        let p = RayonParallel::new_with_threads(4);
        let mut buf = vec![0u8; 100];
        let seen = Mutex::new(Vec::new());
        p.for_each_chunk_mut(&mut buf, 10, &|start, chunk| {
            // 起始索引必须与块内容对得上
            assert_eq!(chunk.len(), 10);
            seen.lock().unwrap().push(start);
        });
        let mut v = seen.into_inner().unwrap();
        v.sort_unstable();
        assert_eq!(v, (0..100).step_by(10).collect::<Vec<_>>());
    }

    #[test]
    fn results_match_serial() {
        // 同一组输入，串行与并行的输出必须逐元素相等（这是双端一致性的本地代理）
        use media_ports::SerialParallel;
        let mut a: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        let mut b = a.clone();
        let f = |_s: usize, c: &mut [u8]| {
            for v in c.iter_mut() {
                *v = v.wrapping_mul(3).wrapping_add(7);
            }
        };
        SerialParallel.for_each_chunk_mut(&mut a, 64, &f);
        RayonParallel::new_with_threads(4).for_each_chunk_mut(&mut b, 64, &f);
        assert_eq!(a, b);
    }

    #[test]
    fn for_each_unit_visits_all() {
        let p = RayonParallel::new_with_threads(4);
        let n = 500;
        let count = AtomicUsize::new(0);
        p.for_each_unit(n, &|_i| {
            count.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(count.load(Ordering::Relaxed), n);
    }

    #[test]
    fn zero_chunk_len_does_not_panic() {
        let p = RayonParallel::new_with_threads(2);
        let mut buf = vec![1u8; 10];
        p.for_each_chunk_mut(&mut buf, 0, &|_s, c| {
            for v in c.iter_mut() {
                *v = 9;
            }
        });
        assert!(buf.iter().all(|&v| v == 9));
    }

    #[test]
    fn with_threads_does_not_leak_pool() {
        let global_before = rayon::current_num_threads();
        let got = with_threads(1, |p| p.parallelism());
        assert_eq!(got, 1);
        assert_eq!(rayon::current_num_threads(), global_before);
    }
}
