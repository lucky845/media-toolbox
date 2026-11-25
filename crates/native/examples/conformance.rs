//! 双端一致性验证的 native 侧：读入输入 + 参数，输出结果字节与哈希。
//!
//! 用法：
//!   cargo run --release -p media-native --example conformance -- <input> <params.json> <encode.json> <out>
//!
//! 输出到 stdout 的一行 JSON 供 `scripts/run-conformance.mjs` 解析。

use media_native::{NativeCtx, RayonParallel, TaskCancel};
use media_ports::limits::Limits;
use media_ports::progress::{Phase, Progress, ProgressSink};

struct Silent;
impl ProgressSink for Silent {
    fn report(&self, _p: Progress) {}
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("用法: conformance <input> <params.json> <encode.json> <out> [threads]");
        std::process::exit(2);
    }
    let input = std::fs::read(&args[1])?;
    let params: media_core::image::ImageParams =
        serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
    let encode: media_core::image::EncodeOptions =
        serde_json::from_str(&std::fs::read_to_string(&args[3])?)?;
    let out_path = &args[4];
    let threads: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(4);

    let parallel = RayonParallel::new_with_threads(threads);
    let cancel = TaskCancel::new();
    let limits = Limits::DESKTOP;
    let ctx = NativeCtx::new(&parallel, &cancel, &limits);
    let quiet = Silent;
    let core_ctx = ctx.core_ctx(&quiet);

    let t0 = std::time::Instant::now();
    let r = media_core::image::pipeline::process_image(&input, &params, &encode, &core_ctx)?;
    let elapsed = t0.elapsed();

    std::fs::write(out_path, &r.output)?;

    let hash = media_core::common::hash::blake3_hex(&r.output);
    let peak = media_core::common::limits_check::estimate_image_peak(
        r.out_width,
        r.out_height,
        input.len() as u64,
    );

    println!(
        "{}",
        serde_json::json!({
            "target": "native",
            "threads": threads,
            "inputBytes": r.input_bytes,
            "outputBytes": r.output_bytes,
            "width": r.out_width,
            "height": r.out_height,
            "hash": hash,
            "elapsedMs": elapsed.as_millis() as u64,
            "peakEstimate": peak,
        })
    );
    let _ = Phase::Finalizing;
    Ok(())
}
