// 演示「只改 crates/core 一处，Web 与桌面同时生效」（规格 §14 的硬验收）。
//
// ## 为什么不用「正则改写源码」
//
// 最初的版本是用正则替换 `Filter::Lanczos3` 的实现。它失败了两次：
//   1. `cargo fmt` 重排了缩进，正则不再匹配；
//   2. 把 `sin` 换成确定性实现后，表达式形态变了，正则再次失效。
//
// 这是典型的「测试代码比被测代码更脆」。现在的做法是**改一个常量**：
// 在 `crates/core/src/image/params.rs` 里有一个 `LANCZOS_LOBES` 常量，
// 它决定 Lanczos 的 lobe 数（3 → 2 会真实改变输出），且改写只需替换 `= 3` 为 `= 2`。
//
// 这同时暴露了一个设计点：**为了让「一处改动」可自动化验证，实现里必须有一个
// 语义明确的常量做锚点**。这不是为测试而加的抽象 —— 它本来就应该是个常量。
//
// 用法：node scripts/verify-single-source.mjs

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(import.meta.dirname, '..');
const paramsPath = join(repo, 'crates/core/src/image/params.rs');
const work = await mkdtemp(join(tmpdir(), 'mt-single-source-'));

const log = (...a) => console.error(...a);
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---- 前置检查 ----
const fixture = join(repo, 'tests/fixtures/gradient.png');
if (!existsSync(fixture)) {
  log(`缺少 fixture: ${fixture}`);
  process.exit(2);
}

const paramsJson = join(work, 'params.json');
const encodeJson = join(work, 'encode.json');

await writeFile(
  paramsJson,
  JSON.stringify({
    resize: { width: 160, height: null, mode: 'fit', filter: 'lanczos3', allowUpscale: false },
    applyExifOrientation: true,
    background: { r: 255, g: 255, b: 255, a: 255 },
  }),
);
await writeFile(
  encodeJson,
  JSON.stringify({
    format: 'png',
    quality: 80,
    lossless: true,
    keepMetadata: false,
    pngOptimize: false,
  }),
);

// ---- 一次「构建 + 跑两端」 ----
function buildAndRun(tag) {
  log(`[${tag}] 构建 wasm ...`);
  run('cargo', ['build', '--release', '-p', 'media-wasm', '--target', 'wasm32-unknown-unknown']);

  log(`[${tag}] wasm-bindgen ...`);
  run('wasm-bindgen', [
    '--target', 'web',
    '--out-dir', 'crates/wasm/pkg',
    '--out-name', 'core_image',
    '--no-typescript',
    'target/wasm32-unknown-unknown/release/media_wasm.wasm',
  ]);

  log(`[${tag}] 构建 native ...`);
  run('cargo', ['build', '--release', '-p', 'media-native', '--example', 'conformance']);

  const wasmOut = join(work, `out-${tag}-wasm.png`);
  const nativeOut = join(work, `out-${tag}-native.png`);

  const wasm = JSON.parse(
    run('node', ['scripts/wasm-harness.mjs', 'crates/wasm/pkg', fixture, paramsJson, encodeJson, wasmOut]),
  );
  const native = JSON.parse(
    run('target/release/examples/conformance', [fixture, paramsJson, encodeJson, nativeOut]),
  );

  return { wasm, native };
}

// ---- 备份 → 改常量 → 跑 → 恢复 ----
const original = await readFile(paramsPath, 'utf8');
await copyFile(paramsPath, join(work, 'params.rs.bak'));

// 锚点：`const LANCZOS_LOBES: i32 = 3;`
const ANCHOR = /const LANCZOS_LOBES: i32 = (\d+);/;
const m = original.match(ANCHOR);
if (!m) {
  log('✗ 找不到锚点常量 `LANCZOS_LOBES`。');
  log('  它必须在 crates/core/src/image/params.rs 里，形如：const LANCZOS_LOBES: i32 = 3;');
  log('  若你删掉了它，请恢复 —— 这是「一处改动可自动验证」的锚点。');
  process.exit(2);
}
const originalLobes = Number(m[1]);
const patchedLobes = originalLobes === 3 ? 2 : 3;
const patched = original.replace(ANCHOR, `const LANCZOS_LOBES: i32 = ${patchedLobes};`);

let failed = false;

try {
  log(`--- 原始版本（LANCZOS_LOBES = ${originalLobes}）---`);
  const before = buildAndRun('before');
  log(`  wasm  : ${before.wasm.hash}`);
  log(`  native: ${before.native.hash}`);

  if (before.wasm.hash !== before.native.hash) {
    log('  ✗ 原始版本两端就不一致，无法进行对比（先修一致性）');
    failed = true;
  }

  log(`--- 改写常量：LANCZOS_LOBES ${originalLobes} → ${patchedLobes} ---`);
  await writeFile(paramsPath, patched);

  log('--- 改写后 ---');
  const after = buildAndRun('after');
  log(`  wasm  : ${after.wasm.hash}`);
  log(`  native: ${after.native.hash}`);

  const sameAcrossTargets = after.wasm.hash === after.native.hash;
  const wasmChanged = after.wasm.hash !== before.wasm.hash;
  const nativeChanged = after.native.hash !== before.native.hash;

  console.log('');
  console.log('=== 验收结果 ===');
  console.log(`两端输出仍然字节一致     : ${sameAcrossTargets ? '✓' : '✗'}`);
  console.log(`Web (wasm) 输出发生变化   : ${wasmChanged ? '✓' : '✗'}`);
  console.log(`桌面 (native) 输出发生变化: ${nativeChanged ? '✓' : '✗'}`);
  console.log(`native 并行度             : ${after.native.threads} 线程`);
  console.log(`输出字节（before → after）: ${before.wasm.outputBytes} → ${after.wasm.outputBytes}`);
  console.log('');

  if (!(sameAcrossTargets && wasmChanged && nativeChanged)) {
    failed = true;
    console.log('✗ 未通过：改动没有同时影响两端，或两端出现了差异');
  } else {
    console.log('✓ 通过：一处改动（crates/core/src/image/params.rs 的一个常量）');
    console.log('  同时改变了 Web 与桌面的输出，且两端仍然逐字节一致。');
    console.log('  这就是「核心算法只写一份」的机器验证。');
  }
} finally {
  await writeFile(paramsPath, original);
  log('已恢复 params.rs');

  // 恢复后必须重建 **两端**，否则会留下「已打补丁」的产物。
  //
  // 这里踩过一个真实的坑：最初只重建了 wasm，漏了 native 的 conformance 二进制。
  // 结果下一次跑 run-conformance.mjs 时，wasm 是原始版、native 是补丁版，
  // 21 个用例里恰好只有 lanczos 那条失败（其他用例不用 lanczos3，所以「看起来还好」）——
  // 这种假阴性比直接崩掉更难查。
  try {
    run('cargo', ['build', '--release', '-p', 'media-wasm', '--target', 'wasm32-unknown-unknown']);
    run('wasm-bindgen', [
      '--target', 'web',
      '--out-dir', 'crates/wasm/pkg',
      '--out-name', 'core_image',
      '--no-typescript',
      'target/wasm32-unknown-unknown/release/media_wasm.wasm',
    ]);
    run('cargo', ['build', '--release', '-p', 'media-native', '--example', 'conformance']);
    log('已重建两端产物（wasm + native conformance）');
  } catch (e) {
    log(`重建失败（产物可能是补丁版！）：${e.message}`);
    log('请手动执行：');
    log('  node scripts/build-wasm.mjs');
    log('  cargo build --release -p media-native --example conformance');
    // 重建失败时不要让调用方以为一切正常
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
