//! wasm 侧并行：永远是串行。这是 D2 的直接体现。

use media_ports::Parallel;

/// wasm 唯一实现：GitHub Pages 无 COOP/COEP → 无 SharedArrayBuffer → 无 threads。
///
/// 即使未来 Pages 支持了，也不该在这里改 —— 那要先在 `capabilities().image.parallel` 里
/// 把 1 改成真实值，并且通过 `scripts/check-budget.mjs` 的体积闸门。
pub struct Serial;

impl Parallel for Serial {
    fn parallelism(&self) -> usize {
        1
    }

    fn for_each_chunk_mut<T: Send>(
        &self,
        buf: &mut [T],
        chunk_len: usize,
        f: &(dyn Fn(usize, &mut [T]) + Sync),
    ) {
        media_ports::SerialParallel.for_each_chunk_mut(buf, chunk_len, f)
    }

    fn for_each_unit(&self, n: usize, f: &(dyn Fn(usize) + Sync)) {
        media_ports::SerialParallel.for_each_unit(n, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallelism_is_one() {
        assert_eq!(Serial.parallelism(), 1);
    }

    #[test]
    fn delegates_correctly() {
        let mut buf = vec![0u8; 10];
        Serial.for_each_chunk_mut(&mut buf, 3, &|_s, c| {
            for v in c.iter_mut() {
                *v = 1;
            }
        });
        assert!(buf.iter().all(|&v| v == 1));
    }
}
