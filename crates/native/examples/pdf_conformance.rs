//! PDF 双端一致性验证的 native 侧：读入 PDF 字节 + 操作 JSON，输出结果字节与 blake3。
//!
//! 用法：
//!   cargo run --release -p media-native --example pdf_conformance -- <input.pdf> <op.json> <out>
//! op.json: {"op":"rotate","degrees":90,"ranges":[{"from":1,"toInclusive":3}]}
//! 输出一行 JSON 供 scripts/run-pdf-conformance.mjs 解析。

use media_core::common::hash::blake3_hex;
use media_core::pdf::ops::{pdf_merge, pdf_rotate, pdf_split, PageRange, PageSelector};
use media_ports::limits::Limits;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Op {
    op: String,
    #[serde(default)]
    degrees: i32,
    #[serde(default)]
    ranges: Vec<PageRange>,
    /// merge 时的额外输入文件
    #[serde(default)]
    inputs: Vec<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("用法: pdf_conformance <input.pdf> <op.json> <out>");
        std::process::exit(2);
    }
    let input = std::fs::read(&args[1])?;
    let op: Op = serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
    let out_path = PathBuf::from(&args[3]);
    let limits = Limits::DESKTOP;

    let result = match op.op.as_str() {
        "rotate" => {
            let sel = PageSelector {
                ranges: op.ranges.clone(),
                odd_only: false,
                even_only: false,
            };
            pdf_rotate(&input, &sel, op.degrees, &limits)?
        }
        "split" => {
            let pages = pdf_split(&input, &op.ranges, &limits)?;
            pages[0].1.clone()
        }
        "merge" => {
            let mut docs = vec![input.clone()];
            for p in &op.inputs {
                docs.push(std::fs::read(p)?);
            }
            pdf_merge(&docs)?
        }
        other => return Err(format!("未知操作: {other}").into()),
    };

    std::fs::write(&out_path, &result)?;
    println!(
        "{}",
        serde_json::json!({
            "target": "native",
            "op": op.op,
            "outputBytes": result.len(),
            "hash": blake3_hex(&result),
        })
    );
    Ok(())
}
