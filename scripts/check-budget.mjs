// CI 闸门：体积预算（docs/BUDGET.md §4）。
//
// 目标不是「卡死正常迭代」，而是发现「有人不小心 import 了整个包」这类事故。
// 所以阈值都留了余量，且分成 fail / warn 两级。

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');

const KB = 1024;
const MB = 1024 * 1024;

/** 阈值：超过 fail 直接失败，超过 warn 只提示 */
const LIMITS = {
  distTotal: { warn: 20 * MB, fail: 60 * MB },
  entryJs: { warn: 300 * KB, fail: 600 * KB }, // gzip 后
  anyChunkJs: { warn: 400 * KB, fail: 800 * KB }, // gzip 后
  wasmBrotli: { warn: 1.6 * MB, fail: 2.4 * MB }, // 未压缩
  css: { warn: 60 * KB, fail: 120 * KB },
};

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const files = [];
let total = 0;
for await (const f of walk(dist)) {
  const s = await stat(f);
  files.push({ path: f, size: s.size, rel: f.replace(dist + '/', '') });
  total += s.size;
}

const fails = [];
const warns = [];

function check(name, value, limit) {
  if (value > limit.fail) fails.push(`${name}: ${(value / KB).toFixed(1)} KB > 上限 ${(limit.fail / KB).toFixed(0)} KB`);
  else if (value > limit.warn) warns.push(`${name}: ${(value / KB).toFixed(1)} KB > 预警 ${(limit.warn / KB).toFixed(0)} KB`);
}

// ---- 总量 ----
check('dist 总体积', total, LIMITS.distTotal);

// ---- 每个 JS chunk（用 gzip 后的体积，因为实际传输的是压缩后）----
for (const f of files.filter((f) => extname(f.path) === '.js')) {
  const buf = await readFile(f.path);
  const gz = gzipSync(buf, { level: 9 }).length;
  if (f.rel.includes('index-') && !f.rel.includes('worker')) {
    check(`入口 JS ${f.rel}`, gz, LIMITS.entryJs);
  } else {
    check(`JS ${f.rel}`, gz, LIMITS.anyChunkJs);
  }
}

// ---- wasm ----
const wasmFiles = files.filter((f) => f.path.endsWith('.wasm'));
for (const f of wasmFiles) {
  check(`wasm ${f.rel}`, f.size, LIMITS.wasmBrotli);
}

// ---- CSS ----
for (const f of files.filter((f) => extname(f.path) === '.css')) {
  check(`CSS ${f.rel}`, f.size, LIMITS.css);
}

// ---- 关键约束：可选 ffmpeg 不得被预取或打进首屏 ----
const html = await readFile(join(dist, 'index.html'), 'utf8');
if (/ffmpeg/i.test(html)) {
  fails.push('index.html 里出现了 ffmpeg 引用 —— 它必须是用户点击才下载的懒加载分包');
}
const ffmpegChunks = files.filter((f) => /ffmpeg/i.test(f.rel));
if (ffmpegChunks.length > 0) {
  // 允许存在（作为可选分包），但要显式列出，提醒评审确认它不是首屏依赖
  console.log(`ℹ 存在 ffmpeg 相关文件 ${ffmpegChunks.length} 个（应为可选分包，不预取）：`);
  for (const f of ffmpegChunks) console.log(`    ${f.rel}  ${(f.size / KB).toFixed(1)} KB`);
}

// ---- 输出 ----
console.log('');
console.log(`dist 总计：${(total / MB).toFixed(2)} MB（${files.length} 个文件，占 1 GB 上限的 ${((total / (1024 * MB)) * 100).toFixed(2)}%）`);

const big = [...files].sort((a, b) => b.size - a.size).slice(0, 8);
console.log('最大的 8 个文件：');
for (const f of big) console.log(`  ${(f.size / KB).toFixed(1).padStart(8)} KB  ${f.rel}`);

if (warns.length > 0) {
  console.log('\n⚠ 预警：');
  for (const w of warns) console.log(`  ${w}`);
}

if (fails.length > 0) {
  console.error('\n✗ 体积预算超限：');
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}

console.log('\n✓ 体积预算检查通过');
