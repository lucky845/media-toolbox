// PDF 双端一致性验证的 wasm 侧：加载 core_doc wasm，跑与 native 相同的 PDF 操作。
// 用法：node scripts/wasm-pdf-harness.mjs <input.pdf> <op.json> <out>

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [inputPath, opPath, outPath] = process.argv.slice(2);
const gluePath = join(import.meta.dirname, '../crates/wasm/pkg/core_doc.js');
const wasmPath = join(import.meta.dirname, '../crates/wasm/pkg/core_doc_bg.wasm');

// 用 initSync(module) 实例化，与 src/workers/doc.worker.ts 的加载路径一致。
const glue = await import(gluePath);
const wasmBytes = await readFile(wasmPath);
const module = await WebAssembly.compile(wasmBytes);
glue.initSync({ module });
const mod = glue;

const input = new Uint8Array(await readFile(inputPath));
const op = JSON.parse(await readFile(opPath, 'utf8'));

let bytes;
if (op.op === 'rotate') {
  const selector = JSON.stringify({ ranges: op.ranges, oddOnly: false, evenOnly: false });
  bytes = new Uint8Array(mod.pdf_rotate(input, selector, op.degrees));
} else if (op.op === 'split') {
  const parts = JSON.parse(mod.pdf_split(input, JSON.stringify(op.ranges), '{}'));
  bytes = Buffer.from(parts[0].bytes, 'base64');
} else if (op.op === 'merge') {
  const inputs = [input];
  for (const p of op.inputs ?? []) inputs.push(new Uint8Array(await readFile(p)));
  bytes = new Uint8Array(mod.pdf_merge(inputs));
} else {
  throw new Error(`未知操作: ${op.op}`);
}

if (outPath) await writeFile(outPath, bytes);
console.log(JSON.stringify({
  target: 'wasm',
  op: op.op,
  outputBytes: bytes.length,
  hash: mod.hash_bytes(bytes),
}));
