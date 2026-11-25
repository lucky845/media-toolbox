// 双端一致性测试（`docs/CONTRACTS.md` §10）。
//
// 判定标准：**同一输入 + 同一参数 → Web(wasm) 与 Desktop(native) 的输出逐字节相等**。
// 做不到的必须进白名单并写明原因，不允许「允许有差异」这种模糊说法。
//
// 用法：
//   node scripts/run-conformance.mjs                    # 跑 tests/fixtures 下全部用例
//   node scripts/run-conformance.mjs --update           # 更新白名单基线
//   node scripts/run-conformance.mjs --verbose          # 打印每条用例的耗时

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const work = await mkdtemp(join(tmpdir(), 'mt-conformance-'));
const verbose = process.argv.includes('--verbose');
const update = process.argv.includes('--update');

const log = (...a) => console.error(...a);

/** 一致性白名单：每条都必须有**具体原因**，不接受「环境差异」这种解释 */
const ALLOWLIST = new Map([
  // 例：['avif-q80.jpg', 'rav1e 多线程编码非确定；桌面用 4 线程、wasm 单线程，码流不同但 PSNR 相同'],
]);

/** 用例矩阵：同一张图 × 不同参数 */
const CASES = [
  {
    name: 'reencode-jpeg-q82',
    params: defaultParams(),
    encode: { format: 'jpeg', quality: 82, lossless: false, keepMetadata: false, pngOptimize: false },
  },
  {
    name: 'resize-lanczos-fit',
    params: {
      ...defaultParams(),
      resize: { width: 160, height: null, mode: 'fit', filter: 'lanczos3', allowUpscale: false },
    },
    encode: { format: 'png', quality: 80, lossless: true, keepMetadata: false, pngOptimize: false },
  },
  {
    name: 'resize-nearest-exact',
    params: {
      ...defaultParams(),
      resize: { width: 100, height: 70, mode: 'exact', filter: 'nearest', allowUpscale: true },
    },
    encode: { format: 'png', quality: 80, lossless: true, keepMetadata: false, pngOptimize: false },
  },
  {
    name: 'rotate-flip',
    params: { ...defaultParams(), rotate: 'cw90', flip: 'h' },
    encode: { format: 'png', quality: 80, lossless: true, keepMetadata: false, pngOptimize: false },
  },
  {
    name: 'crop-adjust',
    params: {
      ...defaultParams(),
      crop: { x: 12, y: 8, width: 200, height: 150 },
      adjust: { brightness: 1.12, contrast: 1.18, saturation: 1.25 },
    },
    encode: { format: 'jpeg', quality: 75, lossless: false, keepMetadata: false, pngOptimize: false },
  },
  {
    name: 'fill-catmullrom',
    params: {
      ...defaultParams(),
      resize: { width: 128, height: 128, mode: 'fill', filter: 'catmull_rom', allowUpscale: true },
      background: { r: 17, g: 20, b: 24, a: 255 },
    },
    encode: { format: 'jpeg', quality: 88, lossless: false, keepMetadata: false, pngOptimize: false },
  },
  {
    name: 'gaussian-downscale',
    params: {
      ...defaultParams(),
      resize: { width: 64, height: null, mode: 'fit', filter: 'gaussian', allowUpscale: false },
    },
    encode: { format: 'webp', quality: 80, lossless: true, keepMetadata: false, pngOptimize: false },
  },
];

function defaultParams() {
  return {
    resize: null,
    crop: null,
    rotate: 'none',
    flip: 'none',
    adjust: null,
    applyExifOrientation: true,
    background: { r: 255, g: 255, b: 255, a: 255 },
  };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---- 前置检查 ----
const pkgWasm = join(repo, 'crates/wasm/pkg/core_image_bg.wasm');
const nativeBin = join(repo, 'target/release/examples/conformance');

if (!existsSync(pkgWasm)) {
  log('缺少 wasm 产物。先执行：node scripts/build-wasm.mjs');
  process.exit(2);
}
if (!existsSync(nativeBin)) {
  log('缺少 native 一致性程序。先执行：cargo build --release -p media-native --example conformance');
  process.exit(2);
}

// ---- 收集 fixture ----
const fixtureDir = join(repo, 'tests/fixtures');
const fixtures = (await readdir(fixtureDir)).filter((f) => /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f));

if (fixtures.length === 0) {
  log('tests/fixtures 里没有图片');
  process.exit(2);
}

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

for (const fixture of fixtures) {
  for (const c of CASES) {
    const tag = `${basename(fixture, '.png')}.${c.name}`;
    const paramsPath = join(work, `${tag}.params.json`);
    const encodePath = join(work, `${tag}.encode.json`);
    await writeFile(paramsPath, JSON.stringify(c.params));
    await writeFile(encodePath, JSON.stringify(c.encode));

    const wasmOut = join(work, `${tag}.wasm.bin`);
    const nativeOut = join(work, `${tag}.native.bin`);
    const fixturePath = join(fixtureDir, fixture);

    let wasmRes, nativeRes;
    try {
      wasmRes = JSON.parse(
        run('node', ['scripts/wasm-harness.mjs', 'crates/wasm/pkg', fixturePath, paramsPath, encodePath, wasmOut]),
      );
      nativeRes = JSON.parse(run(nativeBin, [fixturePath, paramsPath, encodePath, nativeOut]));
    } catch (e) {
      fail++;
      failures.push({ tag, reason: `执行失败: ${String(e.message).split('\n')[0]}` });
      continue;
    }

    if (wasmRes.hash === nativeRes.hash) {
      pass++;
      if (verbose) {
        log(`✓ ${tag}  ${wasmRes.hash.slice(0, 12)}  ${wasmRes.elapsedMs}ms vs ${nativeRes.elapsedMs}ms`);
      }
    } else if (ALLOWLIST.has(tag)) {
      skipped++;
      log(`○ ${tag} 在白名单中（${ALLOWLIST.get(tag)}）`);
    } else {
      fail++;
      failures.push({
        tag,
        reason: `哈希不同：wasm=${wasmRes.hash.slice(0, 16)} native=${nativeRes.hash.slice(0, 16)}`,
        wasmBytes: wasmRes.outputBytes,
        nativeBytes: nativeRes.outputBytes,
      });
    }
  }
}

console.log('');
console.log('=== 双端一致性测试 ===');
console.log(`通过 ${pass} | 白名单 ${skipped} | 失败 ${fail}`);
console.log(`用例总数：${fixtures.length} 个 fixture × ${CASES.length} 组参数 = ${fixtures.length * CASES.length}`);

if (failures.length > 0) {
  console.log('');
  console.error('失败详情：');
  for (const f of failures) {
    console.error(`  ✗ ${f.tag}`);
    console.error(`      ${f.reason}`);
    if (f.wasmBytes !== undefined) {
      console.error(`      输出字节：wasm=${f.wasmBytes} native=${f.nativeBytes}`);
    }
  }
  console.log('');
  console.error('若确认差异来自「非确定性编码器」，必须：');
  console.error('  1. 在 scripts/run-conformance.mjs 的 ALLOWLIST 里加一行，写明**具体原因**；');
  console.error('  2. 在 docs/benchmarks.md 里记录实测数据；');
  console.error('  3. 不允许只写「环境差异」。');
  process.exit(1);
}

console.log('');
console.log('✓ 所有用例两端逐字节一致');

if (update) {
  const baseline = join(repo, 'tests/conformance-baseline.json');
  await writeFile(
    baseline,
    JSON.stringify({ generatedAt: new Date().toISOString(), fixtures, cases: CASES.map((c) => c.name) }, null, 2) + '\n',
  );
  console.log(`已更新基线：${baseline}`);
}

void readFile;
