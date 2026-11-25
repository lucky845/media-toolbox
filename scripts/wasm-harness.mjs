// 在 Node 里加载 `--target web` 的 wasm-bindgen 产物，跑同一组用例。
//
// 为什么能这么跑：`--target web` 的胶水只依赖 `fetch` 与 `WebAssembly`，
// Node 18+ 两者都有。这样双端一致性可以在 CI 里跑，不必起浏览器。
//
// ## 这里刻意不调用胶水自带的 `__wbg_init(url)`
//
// 因为那会走 `fetch(file://...)`，Node 拒绝 file: 协议；更重要的原因是：
// 我们要验证的是**我们自己的加载器**（`src/lib/backend/web/wasmLoader.ts`）的三段降级，
// 而不是胶水的隐式行为。所以这里显式复刻同一套逻辑：
//   1) instantiateStreaming(bytes)  → 失败（MIME 不对或运行时不支持）
//   2) fetch → arrayBuffer → WebAssembly.instantiate
//   3) 仍失败 → 抛带 MIME 的诊断信息
//
// 局限（必须在报告里写清）：Node 的 wasm 运行时与浏览器的 V8 是同一份引擎，
// 但「浏览器里 Uint8Array 的拷贝时机」可能不同；所以这里验证的是**算法字节一致**，
// 不验证「浏览器调用路径」——后者由 Phase 2 的端到端测试覆盖。

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, basename, extname } from 'node:path';
import { pathToFileURL as toUrl } from 'node:url';

const [pkgDir, inputPath, paramsPath, encodePath, outPath, ...rest] = process.argv.slice(2);

if (!pkgDir || !inputPath) {
  console.error('用法: wasm-harness.mjs <pkgDir> <input> [params.json] [encode.json] [out]');
  process.exit(2);
}

const verbose = rest.includes('--verbose');

const gluePath = resolve(pkgDir, 'core_image.js');
const wasmPath = resolve(pkgDir, 'core_image_bg.wasm');

const mod = await import(pathToFileURL(gluePath).href);

// ---- 三段降级加载器（与 wasmLoader.ts 语义一致）----
//
// 注意：胶水的 `init(url)` 内部已经实现了 instantiateStreaming → arrayBuffer 的降级，
// 但我们要**验证自己的加载器**，所以这里用 `initSync(module)` 接收已编译的模块，
// 三段加载逻辑由本脚本负责，与浏览器侧的 wasmLoader.ts 一一对应。
const wasmBytes = await readFile(wasmPath);
let module;
let loadPath = '';

try {
  // 第一段：流式编译（浏览器里是 instantiateStreaming(fetch(url))）
  const resp = new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } });
  module = await WebAssembly.compileStreaming(resp);
  loadPath = 'compileStreaming';
} catch (e1) {
  try {
    // 第二段：arrayBuffer → compile（MIME 不对或运行时不支持流式）
    module = await WebAssembly.compile(wasmBytes);
    loadPath = 'compile+fallback';
    if (verbose) console.error(`[loader] compileStreaming 失败，已降级：${e1.message}`);
  } catch (e2) {
    const err = new Error(
      `wasm 加载失败：streaming=${e1.message}; fallback=${e2.message}; ` +
        `file=${basename(wasmPath)} size=${wasmBytes.length}`,
    );
    err.code = 'WASM_LOAD_FAILED';
    throw err;
  }
}

mod.initSync(module);

// ---- 运行用例 ----
const input = new Uint8Array(await readFile(inputPath));
const paramsJson = paramsPath ? await readFile(paramsPath, 'utf8') : '{}';
const encodeJson = encodePath ? await readFile(encodePath, 'utf8') : '{"format":"jpeg","quality":80}';

const t0 = performance.now();
const out = mod.process_image(input, paramsJson, encodeJson, undefined);
const elapsed = performance.now() - t0;

const bytes = new Uint8Array(out);
if (outPath) await writeFile(outPath, bytes);

const meta = JSON.parse(mod.process_image_with_meta(input, paramsJson, encodeJson, undefined));
const hash = mod.hash_bytes(bytes);

console.log(
  JSON.stringify({
    target: 'wasm',
    loadPath,
    inputBytes: input.length,
    outputBytes: bytes.length,
    width: meta.outWidth,
    height: meta.outHeight,
    hash,
    elapsedMs: Math.round(elapsed),
  }),
);
