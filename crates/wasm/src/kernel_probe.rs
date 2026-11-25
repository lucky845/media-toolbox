//! 诊断导出：把 Filter 核函数的值暴露给 JS，用于比对 wasm 与 native 的浮点实现。
//!
//! 为什么这个函数要留在生产代码里：双端一致性一旦失败，「差异在哪」是最难定位的一步。
//! 有它之后，问题可以缩到「核函数值不同」还是「累加/量化不同」，而不必二分整个流水线。
//! 代价约 200 字节 wasm，值得。

use media_core::image::params::Filter;
use wasm_bindgen::prelude::*;

/// 返回 `[x, kernel(x)]` 的扁平数组（x 从 0 到 max，步长 step）。
#[wasm_bindgen]
pub fn kernel_samples(filter_name: &str, max: f32, step: f32) -> Vec<f32> {
    let f = match filter_name {
        "nearest" => Filter::Nearest,
        "triangle" => Filter::Triangle,
        "catmull_rom" => Filter::CatmullRom,
        "gaussian" => Filter::Gaussian,
        _ => Filter::Lanczos3,
    };
    let mut out = Vec::new();
    let mut x = 0.0f32;
    while x <= max {
        out.push(x);
        out.push(f.kernel(x));
        x += step;
    }
    out
}

/// 归一化后的采样表（与 resize 内部用的完全同一份逻辑），用于定位「权重归一化」差异。
#[wasm_bindgen]
pub fn tap_samples(filter_name: &str, src: u32, dst: u32) -> Vec<f32> {
    let f = match filter_name {
        "nearest" => Filter::Nearest,
        "triangle" => Filter::Triangle,
        "catmull_rom" => Filter::CatmullRom,
        "gaussian" => Filter::Gaussian,
        _ => Filter::Lanczos3,
    };
    media_core::image::resize::debug_tap_table(f, src as usize, dst as usize)
}
