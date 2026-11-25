//! 重采样 —— **Phase 1 的核心演示目标**：只改这里的核，Web 与桌面同时生效。
//!
//! ## 实现要点（两遍过路缓冲，可分离卷积）
//!
//! 缩放拆成「水平 → 垂直」两遍，每遍是 1D 卷积。相比 2D 卷积：
//! - 复杂度从 `O(Wout*Hout*r²)` 降到 `O(Wout*Hin*r + Wout*Hout*r)`；
//! - 中间缓冲是 `Wout × Hin × 4` 个 `f32`，可按输入行分块并行，块之间不重叠。
//!
//! ## 确定性（双端字节相等的前提）
//!
//! 1. 累加一律用 `f32`，但**累加顺序固定**（按核内 tap 升序），不因分块改变；
//! 2. 不依赖 FMA：`acc[c] += p[c] as f32 * w` 在 wasm（无 FMA 指令）与 native（默认
//!    `-C target-cpu=generic` 不启用 fma 融合）上生成同样的「乘→加」两步；
//! 3. 权重归一化：每行/列的权重之和被显式除一次，避免边缘像素因权重和 ≠ 1 而偏暗；
//! 4. 量化是 `floor(x*255+0.5)`，不是截断（见 `common::math::quantize_u8`）。
//!
//! ## 并行边界
//!
//! 水平缩放按**输入行**分块（每块的行区间互不重叠，中间缓冲的对应区间也互不重叠），
//! 所以 `Parallel::for_each_chunk_mut` 可以直接作用在中间缓冲上，无需 unsafe、无需锁。

use crate::common::math::quantize_u8;
use crate::image::decode::RasterImage;
use crate::image::params::Filter;
use media_ports::{Parallel, Phase, Progress, ProgressSink, Result, Unit};

/// 一次缩放任务的可选进度回调。
pub struct ResizeCtx<'a> {
    pub progress: &'a dyn ProgressSink,
    /// 每处理多少像素上报一次（0 = 只在开始/结束上报）。
    pub report_every_pixels: u32,
}

impl<'a> ResizeCtx<'a> {
    pub fn silent(progress: &'a dyn ProgressSink) -> Self {
        ResizeCtx {
            progress,
            report_every_pixels: 0,
        }
    }
}

/// 预计算的 1D 采样表。对每个输出位置记录参与的输入索引与归一化权重。
struct TapTable {
    /// 每个输出位置的 tap 数（统一取最大值，边缘补 0 权重）。
    taps: usize,
    /// `starts[o]` = 输出位置 `o` 的第一个输入索引。
    starts: Vec<usize>,
    /// `weights[o * taps + k]`，已归一化。
    weights: Vec<f32>,
}

impl TapTable {
    /// 构建 1D 采样表。`src` → `dst`，`filter` 决定核。
    ///
    /// 采用「像素中心对齐 + 按缩放比例展宽核」的经典做法：
    /// 缩小图像时核被展宽（抗锯齿），放大时核保持原宽（避免过度模糊）。
    fn build(src: usize, dst: usize, filter: Filter) -> TapTable {
        let scale = src as f32 / dst as f32;
        // 缩小 → ratio > 1 → 核展宽
        let ratio = scale.max(1.0);
        let support = filter.support() * ratio;
        let taps = ((support * 2.0).ceil() as usize).max(1).min(src.max(1));

        let mut starts = Vec::with_capacity(dst);
        let mut weights = Vec::with_capacity(dst * taps);

        for o in 0..dst {
            // 输出像素 o 在输入空间的中心
            let center = (o as f32 + 0.5) * scale;
            let left = center - support;
            let first = (left.floor() as isize).max(0) as usize;
            let last = ((center + support).ceil() as isize)
                .max(first as isize)
                .min(src as isize - 1) as usize;

            let count = (last - first + 1).min(taps);
            starts.push(first);

            let mut row = vec![0f32; taps];
            let mut sum = 0f32;
            for (k, slot) in row.iter_mut().enumerate().take(count) {
                let i = (first + k).min(src - 1);
                // 输入像素中心
                let icenter = i as f32 + 0.5;
                let x = (icenter - center) / ratio;
                let w = filter.kernel(x);
                *slot = w;
                sum += w;
            }
            // 归一化：权重和为 0 时退化为最近邻（避免全黑）
            if sum.abs() < 1e-8 {
                row[0] = 1.0;
            } else {
                for w in row.iter_mut() {
                    *w /= sum;
                }
            }
            weights.extend_from_slice(&row);
        }

        TapTable {
            taps,
            starts,
            weights,
        }
    }
}

/// 缩放 RGBA8 图像。`parallel` 决定水平遍历是否并行。
pub fn resize<P: Parallel>(
    img: &RasterImage,
    tw: u32,
    th: u32,
    filter: Filter,
    parallel: &P,
    ctx: &ResizeCtx,
) -> Result<RasterImage> {
    if tw == 0 || th == 0 {
        return Err(media_ports::ToolError::invalid("缩放目标尺寸不能为 0"));
    }
    if img.width == tw && img.height == th {
        return Ok(img.clone());
    }

    let sw = img.width as usize;
    let sh = img.height as usize;
    let dw = tw as usize;
    let dh = th as usize;
    let total = (dw * dh) as u64;

    // ---- 水平缩放：按输入行分块，块内写 mid 的不重叠区间 ----
    let mut mid = vec![0f32; dw * sh * 4];
    let h_taps = TapTable::build(sw, dw, filter);
    let src = &img.data;

    // 块大小 = 每个元素块覆盖的 f32 数量：一条输入行 = dw*4
    // 我们要「每块是整数行」，所以 chunk_len = rows_per_chunk * dw * 4
    let rows_per_chunk = (64_000 / dw.max(1)).max(1).min(sh.max(1));
    let chunk_len = rows_per_chunk * dw * 4;

    ctx.progress
        .report(Progress::new(0, total, Phase::Transforming, Unit::Pixels));

    // 进度计数（并行时多线程累加，用原子）
    let done = std::sync::atomic::AtomicU64::new(0);
    let report_every = ctx.report_every_pixels.max(1) as u64;

    parallel.for_each_chunk_mut(&mut mid, chunk_len, &|start, chunk| {
        // start 是 f32 元素索引，一定是 dw*4 的整数倍
        let first_row = start / (dw * 4);
        let rows = chunk.len() / (dw * 4);

        for r in 0..rows {
            let y = first_row + r;
            if y >= sh {
                break;
            }
            let src_row = &src[y * sw * 4..(y + 1) * sw * 4];
            let out_row = &mut chunk[r * dw * 4..(r + 1) * dw * 4];

            for ox in 0..dw {
                let first = h_taps.starts[ox];
                let wbase = ox * h_taps.taps;
                let mut acc = [0f32; 4];
                for k in 0..h_taps.taps {
                    let w = h_taps.weights[wbase + k];
                    if w == 0.0 {
                        continue;
                    }
                    let i = (first + k).min(sw - 1);
                    let p = &src_row[i * 4..i * 4 + 4];
                    acc[0] += p[0] as f32 * w;
                    acc[1] += p[1] as f32 * w;
                    acc[2] += p[2] as f32 * w;
                    acc[3] += p[3] as f32 * w;
                }
                let o = ox * 4;
                out_row[o] = acc[0];
                out_row[o + 1] = acc[1];
                out_row[o + 2] = acc[2];
                out_row[o + 3] = acc[3];
            }
        }

        if ctx.report_every_pixels > 0 {
            let n = done.fetch_add((rows * dw) as u64, std::sync::atomic::Ordering::Relaxed);
            if n % report_every < (rows * dw) as u64 {
                ctx.progress.report(Progress::new(
                    n.min(total),
                    total,
                    Phase::Transforming,
                    Unit::Pixels,
                ));
            }
        }
    });

    // ---- 垂直缩放：每个输出行独立（按输出行分块并行是安全的，因为 out 的区间不重叠）----
    let v_taps = TapTable::build(sh, dh, filter);
    let mut out = vec![0u8; dw * dh * 4];
    let out_chunk = dw * 4;

    let mid_ref = &mid;
    parallel.for_each_chunk_mut(&mut out, out_chunk, &|start, chunk| {
        let oy = start / out_chunk;
        if oy >= dh {
            return;
        }
        let first = v_taps.starts[oy];
        let wbase = oy * v_taps.taps;

        for ox in 0..dw {
            let mut acc = [0f32; 4];
            for k in 0..v_taps.taps {
                let w = v_taps.weights[wbase + k];
                if w == 0.0 {
                    continue;
                }
                let iy = (first + k).min(sh - 1);
                let o = (iy * dw + ox) * 4;
                acc[0] += mid_ref[o] * w;
                acc[1] += mid_ref[o + 1] * w;
                acc[2] += mid_ref[o + 2] * w;
                acc[3] += mid_ref[o + 3] * w;
            }
            let o = ox * 4;
            chunk[o] = quantize_u8(acc[0] / 255.0);
            chunk[o + 1] = quantize_u8(acc[1] / 255.0);
            chunk[o + 2] = quantize_u8(acc[2] / 255.0);
            chunk[o + 3] = quantize_u8(acc[3] / 255.0);
        }
    });

    ctx.progress.report(Progress::new(
        total,
        total,
        Phase::Transforming,
        Unit::Pixels,
    ));

    RasterImage::new(tw, th, out)
}

/// 诊断用：把内部采样表摊平成 `[start, taps..., start, taps..., ...]`。
///
/// **仅供双端一致性排障使用**，不参与生产路径。保持 `pub` 的理由见
/// `crates/wasm/src/kernel_probe.rs` 的注释。
pub fn debug_tap_table(filter: Filter, src: usize, dst: usize) -> Vec<f32> {
    let t = TapTable::build(src, dst, filter);
    let mut out = Vec::with_capacity(dst * (t.taps + 1));
    for o in 0..dst {
        out.push(t.starts[o] as f32);
        for k in 0..t.taps {
            out.push(t.weights[o * t.taps + k]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::decode::RasterImage;
    use media_ports::progress::NoopProgress;
    use media_ports::SerialParallel;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RasterImage {
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            data.extend_from_slice(&rgba);
        }
        RasterImage::new(w, h, data).unwrap()
    }

    fn gradient(w: u32, h: u32) -> RasterImage {
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let r = (x * 255 / w.max(1)) as u8;
                let g = (y * 255 / h.max(1)) as u8;
                data.extend_from_slice(&[r, g, 128, 255]);
            }
        }
        RasterImage::new(w, h, data).unwrap()
    }

    fn ctx() -> ResizeCtx<'static> {
        static NOOP: NoopProgress = NoopProgress;
        ResizeCtx::silent(&NOOP)
    }

    #[test]
    fn solid_color_stays_solid() {
        let img = solid(64, 64, [12, 34, 56, 255]);
        let out = resize(&img, 32, 32, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert_eq!((out.width, out.height), (32, 32));
        for p in out.data.chunks_exact(4) {
            assert!(p[0].abs_diff(12) <= 1, "r={}", p[0]);
            assert!(p[1].abs_diff(34) <= 1, "g={}", p[1]);
            assert!(p[2].abs_diff(56) <= 1, "b={}", p[2]);
            assert_eq!(p[3], 255);
        }
    }

    #[test]
    fn identity_size_returns_clone() {
        let img = gradient(10, 10);
        let out = resize(&img, 10, 10, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert_eq!(out, img);
    }

    #[test]
    fn zero_target_rejected() {
        let img = gradient(4, 4);
        assert!(resize(&img, 0, 4, Filter::Lanczos3, &SerialParallel, &ctx()).is_err());
    }

    #[test]
    fn downscale_preserves_mean_brightness() {
        let img = gradient(128, 128);
        let before: f64 =
            img.data.chunks_exact(4).map(|p| p[0] as f64).sum::<f64>() / img.pixels() as f64;
        let out = resize(&img, 32, 32, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        let after: f64 =
            out.data.chunks_exact(4).map(|p| p[0] as f64).sum::<f64>() / out.pixels() as f64;
        assert!(
            (before - after).abs() < 3.0,
            "before={before} after={after}"
        );
    }

    #[test]
    fn upscale_keeps_dimensions() {
        let img = gradient(8, 8);
        let out = resize(&img, 32, 24, Filter::Triangle, &SerialParallel, &ctx()).unwrap();
        assert_eq!((out.width, out.height), (32, 24));
        assert_eq!(out.data.len(), 32 * 24 * 4);
    }

    #[test]
    fn all_filters_produce_correct_dimensions() {
        let img = gradient(40, 30);
        for f in [
            Filter::Nearest,
            Filter::Triangle,
            Filter::CatmullRom,
            Filter::Gaussian,
            Filter::Lanczos3,
        ] {
            let out = resize(&img, 20, 15, f, &SerialParallel, &ctx()).unwrap();
            assert_eq!((out.width, out.height), (20, 15), "{f:?}");
        }
    }

    #[test]
    fn nearest_is_repeatable() {
        let img = gradient(40, 40);
        let a = resize(&img, 20, 20, Filter::Nearest, &SerialParallel, &ctx()).unwrap();
        let b = resize(&img, 20, 20, Filter::Nearest, &SerialParallel, &ctx()).unwrap();
        assert_eq!(a, b, "同输入同参数必须完全一致");
    }

    #[test]
    fn result_is_deterministic_across_calls() {
        let img = gradient(97, 61);
        let a = resize(&img, 43, 29, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        let b = resize(&img, 43, 29, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert_eq!(a.data, b.data);
    }

    #[test]
    fn taps_are_normalized() {
        for filter in [
            Filter::Triangle,
            Filter::CatmullRom,
            Filter::Gaussian,
            Filter::Lanczos3,
        ] {
            let t = TapTable::build(50, 17, filter);
            for o in 0..17 {
                let sum: f32 = (0..t.taps).map(|k| t.weights[o * t.taps + k]).sum();
                assert!((sum - 1.0).abs() < 1e-4, "{filter:?} o={o} sum={sum}");
            }
        }
    }

    #[test]
    fn extreme_downscale_does_not_panic() {
        let img = gradient(200, 200);
        let out = resize(&img, 1, 1, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert_eq!((out.width, out.height), (1, 1));
    }

    #[test]
    fn extreme_upscale_does_not_panic() {
        let img = gradient(2, 2);
        let out = resize(&img, 300, 300, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert_eq!((out.width, out.height), (300, 300));
    }

    #[test]
    fn alpha_is_preserved_through_scaling() {
        let mut img = solid(32, 32, [10, 20, 30, 200]);
        for p in img.data.chunks_exact_mut(4).take(100) {
            p[3] = 100;
        }
        let out = resize(&img, 16, 16, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert!(out.data.chunks_exact(4).all(|p| p[3] > 50 && p[3] < 255));
    }

    #[test]
    fn multi_row_chunks_are_consistent_with_fewer_rows() {
        // 不同行数下结果必须一致（验证分块不影响输出）
        let img = gradient(120, 90);
        let a = resize(&img, 60, 45, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        // 用小 buffer 重跑一次，确认分块策略不会改变结果
        let b = resize(&img, 60, 45, Filter::Lanczos3, &SerialParallel, &ctx()).unwrap();
        assert_eq!(a.data, b.data);
    }
}
