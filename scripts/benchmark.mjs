// Phase 6 基准脚本：同一输入 × 同一参数，native(Rust) 与 wasm(Web) 各跑 3 次取中位数。
// 复用双端一致性测试的同一套执行器（native conformance 二进制 + wasm harness），
// 保证「基准跑的就是真实交付的代码路径」，而不是另写一份测量代码。
//
// 用法：
//   node scripts/benchmark.mjs              # 跑 B1（12 MP lanczos 缩放）
//   node scripts/benchmark.mjs --verbose    # 打印每次迭代
//
// 前置：
//   cargo build --release -p media-native --example conformance
//   crates/wasm/pkg/core_image_bg.wasm 存在（npm run wasm）
//
// 结果写入 docs/benchmark-results.json，由 docs/benchmarks.md 引用。

import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const verbose = process.argv.includes('--verbose');
const log = (...a) => console.error(...a);
const work = await mkdtemp(join(tmpdir(), 'mt-bench-'));

const nativeBin = join(repo, 'target/release/examples/conformance');
const wasmPkg = join(repo, 'crates/wasm/pkg');
const wasmWasm = join(wasmPkg, 'core_image_bg.wasm');
const wasmGlue = join(wasmPkg, 'core_image.js');
// 优先用环境变量；否则用 PATH 里的 ffmpeg（CI 的 ubuntu runner 有 apt 版）。
async function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  for (const c of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    try {
      await access(c);
      return c;
    } catch {}
  }
  return 'ffmpeg'; // 交给 PATH 解析，失败时下方会给出明确提示
}
const ffmpeg = await findFfmpeg();

for (const f of [nativeBin, wasmWasm, wasmGlue]) {
  if (!existsSync(f)) {
    log(`缺少 ${f}`);
    log('先执行：cargo build --release -p media-native --example conformance && npm run wasm');
    process.exit(2);
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---- 生成 12 MP 测试图（4000×3000 渐变，接近图片页 20 MP 上限的 60%）----
const bigPng = join(work, 'big12mp.png');
try {
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=4000x3000:rate=1',
    '-frames:v', '1', bigPng,
  ]);
} catch (e) {
  // 基准是「有工具才测」的诊断项，不该因为环境缺 ffmpeg 卡住 CI。
  log(`跳过 B1：无法用 ffmpeg 生成测试图（${ffmpeg}）；本机跑请安装 ffmpeg 或设 FFMPEG 环境变量。`);
  console.log(JSON.stringify({ skipped: true, reason: 'ffmpeg unavailable', case: 'b1-lanczos-12mp' }));
  process.exit(0);
}

// B1 参数：4000×3000 → 1600×1200，lanczos3，PNG 输出
const params = {
  crop: null, rotate: 'none', flip: 'none',
  resize: { width: 1600, height: null, mode: 'fit', filter: 'lanczos3', allowUpscale: false },
  adjust: { brightness: 0, contrast: 1, saturation: 1 },
  applyExifOrientation: true,
};
const encode = { format: 'png', quality: 80, lossless: true, keepMetadata: false, pngOptimize: false };
const paramsPath = join(work, 'params.json');
const encodePath = join(work, 'encode.json');
await writeFile(paramsPath, JSON.stringify(params));
await writeFile(encodePath, JSON.stringify(encode));

const ITER = 3;
const results = { environment: {}, cases: {} };
results.environment = {
  date: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  input: '12 MP (4000x3000 testsrc2)',
  iterations: ITER,
  note: 'median of 3; native=4 threads; wasm=single thread in Node V8 (same engine as browser)',
};

async function bench(name, nativeArgs, wasmArgs) {
  const native = [];
  const wasm = [];
  let nativeMeta = null;
  let wasmMeta = null;
  for (let i = 0; i < ITER; i += 1) {
    const nOut = join(work, `${name}-native-${i}.png`);
    const wOut = join(work, `${name}-wasm-${i}.png`);
    const nRaw = run(nativeBin, [...nativeArgs, nOut]).trim().split('\n').pop();
    const wRaw = run('node', ['scripts/wasm-harness.mjs', 'crates/wasm/pkg', bigPng, paramsPath, encodePath, wOut]).trim().split('\n').pop();
    const nj = JSON.parse(nRaw);
    const wj = JSON.parse(wRaw);
    native.push(nj.elapsedMs);
    wasm.push(wj.elapsedMs);
    nativeMeta = nj;
    wasmMeta = wj;
    if (verbose) log(`  ${name} iter${i}: native=${nj.elapsedMs}ms wasm=${wj.elapsedMs}ms`);
  }
  results.cases[name] = {
    native: { medianMs: median(native), samples: native, ...nativeMeta },
    wasm: { medianMs: median(wasm), samples: wasm, ...wasmMeta },
    byteIdentical: nativeMeta.outputBytes === wasmMeta.outputBytes && nativeMeta.hash === wasmMeta.hash,
    ratioWasmToNative: +(median(wasm) / median(native)).toFixed(2),
  };
}

log('B1: 12MP lanczos3 缩放 → PNG');
await bench('b1-lanczos-12mp', [bigPng, paramsPath, encodePath], [bigPng, paramsPath, encodePath]);

const outPath = join(repo, 'docs/benchmark-results.json');
await writeFile(outPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({
  case: 'b1-lanczos-12mp',
  nativeMs: results.cases['b1-lanczos-12mp'].native.medianMs,
  wasmMs: results.cases['b1-lanczos-12mp'].wasm.medianMs,
  ratio: results.cases['b1-lanczos-12mp'].ratioWasmToNative,
  byteIdentical: results.cases['b1-lanczos-12mp'].byteIdentical,
  saved: 'docs/benchmark-results.json',
}, null, 2));
