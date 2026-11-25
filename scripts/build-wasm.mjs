// wasm 构建：cargo → wasm-bindgen → wasm-opt → 体积报告。
//
// 为什么不用 wasm-pack（D4）：
//  - 它会在运行时下载 binaryen/geckodriver，CI 不可复现、离线不可用；
//  - 我们需要「按 feature 出多个包」（image / doc / video），wasm-pack 的
//    `--features` 支持会把所有 feature 编进同一个包，与分包懒加载冲突。
//
// 用法：
//   node scripts/build-wasm.mjs --target web            # 出 image 包（默认）
//   node scripts/build-wasm.mjs --target web --all      # 出 image + doc + video
//   node scripts/build-wasm.mjs --target web --opt      # 额外跑 wasm-opt -Oz
//   node scripts/build-wasm.mjs --check-bindgen         # 只校验版本一致性

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const repo = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = flag('--opt');
const all = flag('--all');
const checkOnly = flag('--check-bindgen');

const log = (...a) => console.error(...a);

/** 包定义：feature → (crate 名, 输出名, 说明) */
const PACKAGES = [
  { feature: 'image', outName: 'core_image', desc: '图片编解码与变换' },
  // doc / video / office 合成一个「文档与视频参数」分包：
  // 这三个 feature 的 wasm 都很小（lopdf 是纯逻辑），单独拆包反而多 3 次网络往返。
  { feature: 'doc,video,office', outName: 'core_doc', desc: 'PDF 结构操作 + 视频参数 + 文档结构化' },
];

const selected = all ? PACKAGES : PACKAGES.filter((p) => p.feature === 'image');

function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ---- 1. 版本一致性检查（最常见的坑：wasm-bindgen crate 与 CLI 版本不一致）----
function checkBindgenVersion() {
  // crate 侧版本从 Cargo.lock 读（比读 Cargo.toml 的 range 更准）
  const lockPath = join(repo, 'Cargo.lock');
  if (!existsSync(lockPath)) {
    log('Cargo.lock 不存在，请先 cargo build 一次');
    process.exit(2);
  }
  const lock = execFileSync('cat', [lockPath], { encoding: 'utf8' });
  const m = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/);
  if (!m) {
    log('Cargo.lock 里找不到 wasm-bindgen');
    process.exit(2);
  }
  const crateVersion = m[1];

  let cliVersion = '';
  try {
    cliVersion = run('wasm-bindgen', ['--version']).trim().split(' ').pop();
  } catch {
    log('找不到 wasm-bindgen CLI。请执行：');
    log('  cargo install wasm-bindgen-cli --version <与 crate 相同的版本> --locked');
    process.exit(2);
  }

  const ok = crateVersion === cliVersion;
  log(`wasm-bindgen: crate=${crateVersion} cli=${cliVersion} ${ok ? '✓' : '✗'}`);
  if (!ok) {
    log('');
    log('版本不一致会在**运行期**报：');
    log('  "it looks like the Rust project used to create this wasm file was linked against');
    log('   version of wasm-bindgen that is not compatible with this version"');
    log(`修复： cargo install wasm-bindgen-cli --version ${crateVersion} --locked`);
    process.exit(1);
  }
  return crateVersion;
}

// ---- 2. wasm-opt（可选）----
function runWasmOpt(wasmPath) {
  // 用 npm 的 binaryen 二进制，避免联网下载；没装就跳过并警告
  const local = join(repo, 'node_modules/.bin/wasm-opt');
  const bin = existsSync(local) ? local : 'wasm-opt';
  try {
    // -Oz 体积优先；--enable-bulk-memory 与 .cargo/config.toml 的 target-feature 对齐
    run(bin, [
      wasmPath,
      '-Oz',
      '--enable-bulk-memory',
      '--enable-mutable-globals',
      '--strip-debug',
      '--strip-producers',
      '-o',
      wasmPath,
    ]);
    return true;
  } catch (e) {
    log(`wasm-opt 失败（可能是未安装 binaryen），跳过：${String(e.message).split('\n')[0]}`);
    return false;
  }
}

// ---- 3. 体积报告 ----
async function report(file) {
  const buf = await readFileBuf(file);
  const gz = gzipSync(buf, { level: 9 });
  const br = brotliCompressSync(buf, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
  });
  return { raw: buf.length, gzip: gz.length, brotli: br.length };
}

async function readFileBuf(p) {
  const { readFile } = await import('node:fs/promises');
  return readFile(p);
}

const fmt = (n) => (n / 1024).toFixed(1) + ' KB';
const pct = (a, b) => ((a / b) * 100).toFixed(1) + '%';

// ---- main ----
checkBindgenVersion();
if (checkOnly) process.exit(0);

const report_ = [];

for (const pkg of selected) {
  log(`\n=== ${pkg.outName} (feature: ${pkg.feature}) — ${pkg.desc} ===`);
  const env = {
    ...process.env,
    // 让 rustflags 按 feature 生效（.cargo/config.toml 里已有 wasm32 的 rustflags）
  };

  log('[1/4] cargo build --release --target wasm32-unknown-unknown');
  run(
    'cargo',
    [
      'build',
      '--release',
      '-p',
      'media-wasm',
      '--target',
      'wasm32-unknown-unknown',
      '--no-default-features',
      '--features',
      pkg.feature,
    ],
    { env },
  );

  log('[2/4] wasm-bindgen --target web');
  const outDir = join(repo, 'crates/wasm/pkg');
  await mkdir(outDir, { recursive: true });
  run('wasm-bindgen', [
    '--target',
    'web',
    '--out-dir',
    outDir,
    '--out-name',
    pkg.outName,
    '--no-typescript',
    'target/wasm32-unknown-unknown/release/media_wasm.wasm',
  ]);

  const wasmPath = join(outDir, `${pkg.outName}_bg.wasm`);
  const before = await report(wasmPath);

  let optApplied = false;
  if (opt) {
    log('[3/4] wasm-opt -Oz');
    optApplied = runWasmOpt(wasmPath);
  } else {
    log('[3/4] 跳过 wasm-opt（加 --opt 启用）');
  }

  const after = optApplied ? await report(wasmPath) : before;

  log('[4/4] 体积报告');
  log(`  raw    : ${fmt(after.raw)} (${after.raw} B)`);
  log(`  gzip   : ${fmt(after.gzip)}  (${pct(after.gzip, after.raw)} of raw)`);
  log(`  brotli : ${fmt(after.brotli)}  (${pct(after.brotli, after.raw)} of raw)`);
  if (optApplied && after.raw < before.raw) {
    log(`  wasm-opt 省下 ${fmt(before.raw - after.raw)} (${pct(before.raw - after.raw, before.raw)})`);
  }

  report_.push({ pkg: pkg.outName, feature: pkg.feature, ...after, optApplied });
}

// 写进 docs/wasm-size.json，供 check-budget.mjs 与文档引用（真实数字，不靠手写）
const sizeFile = join(repo, 'docs/wasm-size.json');
await writeFile(
  sizeFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: '由 scripts/build-wasm.mjs 生成；docs/BUDGET.md 的 [待测] 项以此为准',
      packages: report_,
    },
    null,
    2,
  ) + '\n',
);

log(`\n已写入 ${sizeFile}`);
log('提示：--opt 需要 binaryen（npm i -D binaryen）。CI 里必装，本地可跳过。');
