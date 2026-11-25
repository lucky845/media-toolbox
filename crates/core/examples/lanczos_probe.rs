// 诊断用：打印 Lanczos3 核在若干点上的值，用于比对 wasm 与 native 的浮点实现差异。

fn main() {
    use media_core::image::params::Filter;
    println!("point\tlanczos3");
    for i in 0..=30 {
        let x = i as f32 * 0.1;
        let v = Filter::Lanczos3.kernel(x);
        println!("{x:.2}\t{v:.10}");
    }
    // 再打印几个「翼」上的值（sin 差异最容易在这里暴露）
    for x in [1.5f32, 2.25, 2.5, 2.75, 2.999] {
        println!("{x:.3}\t{:.10}", Filter::Lanczos3.kernel(x));
    }
}
