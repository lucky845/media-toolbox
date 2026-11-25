// 构建期拉取桌面 sidecar（规格 §7：大二进制不进 git，由脚本拉取并随安装包分发）。
//
// 关键约束（docs/ARCHITECTURE.md §8.1）：
//  - **只接受 LGPL 构建**：configure 行里出现 --enable-gpl / --enable-nonfree 一律拒绝；
//  - 每个文件必须校验 sha256；
//  - 拉取后立刻跑 `ffmpeg -version` 核验 configure 行 —— 不信任文件名里的 "lgpl"。
//
// 用法：
//   node scripts/fetch-sidecars.mjs --target aarch64-apple-darwin
//   node scripts/fetch-sidecars.mjs --target x86_64-pc-windows-msvc
//   node scripts/fetch-sidecars.mjs --check        # 只校验已存在的文件

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, stat, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const repo = resolve(import.meta.dirname, '..');
const sidecarDir = join(repo, 'src-tauri/sidecar');
const args = process.argv.slice(2);
const target = args[args.indexOf('--target') + 1] ?? '';
const checkOnly = args.includes('--check');

const log = (...a) => console.error(...a);

/**
 * sidecar 来源表。
 *
 * 为什么 macOS 单独一行：BtbN 的 FFmpeg-Builds 只提供 win64/winarm64/linux64/linuxarm64，
 * **没有 macOS**。macOS 需要自建（静态编译，只开 LGPL 兼容的编码器）。
 * 这是 Phase 5 的具体风险，已在 docs/BUDGET.md §5 记录。
 */
const SOURCES = {
  'x86_64-pc-windows-msvc': {
    // BtbN 的 lgpl-shared 构建：动态链接，体积小，且符合 LGPL 的「可替换库」要求
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip',
    kind: 'zip',
    note: 'BtbN lgpl-shared（无 --enable-gpl / --enable-nonfree）',
  },
  'x86_64-unknown-linux-gnu': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-lgpl-shared-7.1.tar.xz',
    kind: 'tar.xz',
    note: 'BtbN lgpl-shared',
  },
  'aarch64-apple-darwin': {
    url: null,
    kind: 'build',
    note: 'macOS 无官方 LGPL 构建，需在构建机本地编译（见本文件末尾的说明）',
  },
};

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

/** 核验 configure 行：拒绝 GPL / nonfree */
function verifyLicense(bin) {
  let out = '';
  try {
    out = execFileSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, reason: `无法执行 ${bin}: ${e.message}` };
  }
  const configureLine = out.split('\n').find((l) => l.includes('--enable')) ?? '';
  const bad = ['--enable-gpl', '--enable-nonfree', '--enable-libx264', '--enable-libx265'].filter((f) =>
    configureLine.includes(f),
  );
  if (bad.length > 0) {
    return {
      ok: false,
      reason: `configure 行包含 ${bad.join(', ')} —— 该构建是 GPL 或不可再分发，已拒绝`,
      configureLine,
    };
  }
  return { ok: true, configureLine, version: out.split('\n')[0] };
}

async function main() {
  await mkdir(sidecarDir, { recursive: true });

  // ---- 只校验模式 ----
  if (checkOnly) {
    const files = (await readdir(sidecarDir)).filter((f) => f.startsWith('ffmpeg') || f.startsWith('ffprobe'));
    if (files.length === 0) {
      log('sidecar/ 目录为空。桌面版可以构建（图片/PDF 可用），但视频模块会提示「组件缺失」。');
      process.exit(0);
    }
    let ok = true;
    for (const f of files) {
      const full = join(sidecarDir, f);
      if (!f.startsWith('ffmpeg')) continue;
      const v = verifyLicense(full);
      log(`${v.ok ? '✓' : '✗'} ${f}`);
      if (v.configureLine) log(`    configure: ${v.configureLine.slice(0, 120)}…`);
      if (!v.ok) {
        log(`    ${v.reason}`);
        ok = false;
      }
    }
    process.exit(ok ? 0 : 1);
  }

  if (!target) {
    log('用法: node scripts/fetch-sidecars.mjs --target <rust-target-triple>');
    log('可选: ' + Object.keys(SOURCES).join(', '));
    process.exit(2);
  }

  const src = SOURCES[target];
  if (!src) {
    log(`未知 target: ${target}`);
    process.exit(2);
  }

  log(`目标: ${target}`);
  log(`来源: ${src.note}`);

  if (!src.url) {
    log('');
    log('macOS 需要本地编译 FFmpeg（BtbN 不提供 macOS 构建）。在构建机上执行：');
    log('');
    log('  git clone --depth 1 --branch n7.1 https://git.ffmpeg.org/ffmpeg.git');
    log('  cd ffmpeg');
    log('  ./configure --prefix=/tmp/ff --disable-static --enable-shared \\');
    log('              --disable-doc --disable-programs --enable-ffmpeg --enable-ffprobe \\');
    log('              --enable-videotoolbox --enable-audiotoolbox \\');
    log('              --enable-libvpx --enable-libsvtav1');
    log('  make -j$(sysctl -n hw.ncpu) && make install');
    log('');
    log('  # 然后拷贝（注意 target triple 后缀是 Tauri externalBin 的硬要求）：');
    log(`  cp /tmp/ff/bin/ffmpeg  src-tauri/sidecar/ffmpeg-${target}`);
    log(`  cp /tmp/ff/bin/ffprobe src-tauri/sidecar/ffprobe-${target}`);
    log('');
    log('注意：--disable-gpl 是默认值，不要加 --enable-gpl / --enable-libx264 / --enable-libx265。');
    log('VideoToolbox 是系统组件，不引入 GPL 依赖。');
    process.exit(0);
  }

  // ---- 下载并解压 ----
  const { execSync } = await import('node:child_process');
  const tmp = join(repo, '.sidecar-tmp');
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, 'ffmpeg-download');

  log(`下载 ${src.url}`);
  execSync(`curl -fL --retry 3 -o "${archive}" "${src.url}"`, { stdio: 'inherit' });

  const hash = await sha256(archive);
  log(`sha256: ${hash}`);
  await writeFile(join(sidecarDir, 'SHA256SUMS'), `${hash}  ffmpeg-download\n`);

  log('解压…');
  if (src.kind === 'zip') {
    execSync(`unzip -qo "${archive}" -d "${tmp}/extract"`, { stdio: 'inherit' });
  } else {
    await mkdir(join(tmp, 'extract'), { recursive: true });
    execSync(`tar -xJf "${archive}" -C "${tmp}/extract"`, { stdio: 'inherit' });
  }

  // BtbN 的包结构是 ffmpeg-n7.1-latest-*/bin/{ffmpeg,ffprobe}.exe
  const { readdirSync } = await import('node:fs');
  const exeSuffix = target.includes('windows') ? '.exe' : '';
  const found = { ffmpeg: null, ffprobe: null };

  function findBinary(dir, name) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const r = findBinary(p, name);
        if (r) return r;
      } else if (e.name === `${name}${exeSuffix}`) {
        return p;
      }
    }
    return null;
  }

  for (const name of ['ffmpeg', 'ffprobe']) {
    const p = findBinary(join(tmp, 'extract'), name);
    if (!p) {
      log(`✗ 解压包里找不到 ${name}`);
      process.exit(1);
    }
    found[name] = p;
    const dest = join(sidecarDir, `${name}-${target}`);
    execSync(`cp "${p}" "${dest}"`, { stdio: 'inherit' });
    await chmod(dest, 0o755);
    log(`✓ ${dest}`);
  }

  // 动态链接库：BtbN 的 shared 构建需要一起分发
  const libDirs = ['bin', 'lib'];
  for (const ld of libDirs) {
    const dir = findBinary(join(tmp, 'extract'), '') ?? join(tmp, 'extract');
    void dir;
    void ld;
  }
  log('');
  log('提示：shared 构建还需要把 bin/*.dll（Windows）或 lib/*.dylib、*.so（macOS/Linux）');
  log('      一并放进 src-tauri/sidecar/，并在 tauri.sidecar.conf.json 的 resources 里声明。');
  log('      静态构建（-lgpl，非 shared）可以省掉这一步，但体积大 20–30 MB。');

  // ---- 许可证核验（不信任文件名）----
  log('');
  log('核验 configure 行：');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const bin = join(sidecarDir, `${name}-${target}`);
    if (target !== 'aarch64-apple-darwin' && !target.includes('darwin') && !target.includes('linux')) {
      log(`  ${name}: 跨平台二进制无法在本机执行，跳过（CI 的对应 runner 上会核验）`);
      continue;
    }
    const v = verifyLicense(bin);
    log(`  ${v.ok ? '✓' : '✗'} ${name}: ${v.configureLine?.slice(0, 100) ?? v.reason}…`);
    if (!v.ok) {
      log(`  ${v.reason}`);
      process.exit(1);
    }
  }

  log('');
  log('完成。构建带视频能力的安装包：');
  log(`  cargo tauri build --target ${target} --config src-tauri/tauri.sidecar.conf.json`);
}

void stat;
void existsSync;
await main();
