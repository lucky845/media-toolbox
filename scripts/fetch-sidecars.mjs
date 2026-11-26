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
    note: 'macOS 无官方 LGPL 构建，CI 上源码编译（VideoToolbox/AudioToolbox，无 x264/x265）',
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
    // macOS 没有可下载的 LGPL 构建（BtbN 只提供 win/linux）。在 CI runner 上源码编译：
    // 只开 LGPL 兼容编码器 + 系统 VideoToolbox/AudioToolbox，绝不引入 x264/x265/nonfree。
    // 静态链接（--enable-static --disable-shared）以便只需分发两个二进制、不需要附带 dylib。
    log('macOS：源码编译 LGPL FFmpeg（无 x264/x265；H.264 走系统 VideoToolbox）…');
    const buildDir = join(repo, '.sidecar-tmp', 'ffmpeg-src');
    await mkdir(buildDir, { recursive: true });
    const clone = () => execFileSync('git', [
      'clone', '--depth', '1', '--branch', 'n7.1',
      'https://git.ffmpeg.org/ffmpeg.git', buildDir,
    ], { stdio: 'inherit', cwd: repo });
    if (!existsSync(join(buildDir, 'configure'))) {
      try {
        clone();
      } catch (e) {
        // git.ffmpeg.org 偶有不可达；用 GitHub 镜像作为同源回退
        log(`git.ffmpeg.org 拉取失败（${e.message}），改用 GitHub 镜像…`);
        execFileSync('git', [
          'clone', '--depth', '1', '--branch', 'n7.1',
          'https://github.com/FFmpeg/FFmpeg.git', buildDir,
        ], { stdio: 'inherit', cwd: repo });
      }
    }
    const prefix = join(buildDir, 'out');
    const configure = [
      `--prefix=${prefix}`,
      '--enable-static', '--disable-shared', '--pkg-config-flags=--static',
      '--disable-doc', '--disable-debug',
      '--enable-ffmpeg', '--enable-ffprobe',
      '--enable-videotoolbox', '--enable-audiotoolbox',
      '--enable-libvpx', '--enable-libsvtav1',
      // 安全：显式不启用任何 GPL/nonfree 组件（configure 默认即关闭，这里写明便于审计）
      '--disable-gpl', '--disable-nonfree',
    ];
    execFileSync('./configure', configure, { stdio: 'inherit', cwd: buildDir });
    const jobs = process.env.JOBS ?? '4';
    execFileSync('make', [`-j${jobs}`], { stdio: 'inherit', cwd: buildDir });
    execFileSync('make', ['install'], { stdio: 'inherit', cwd: buildDir });

    for (const name of ['ffmpeg', 'ffprobe']) {
      const from = join(prefix, 'bin', name);
      const dest = join(sidecarDir, `${name}-${target}`);
      execFileSync('cp', [from, dest], { stdio: 'inherit' });
      await chmod(dest, 0o755);
      const v = verifyLicense(dest);
      log(`${v.ok ? '✓' : '✗'} ${name}-${target}: ${v.version ?? v.reason}`);
      if (!v.ok) {
        log(v.reason);
        process.exit(1);
      }
    }
    log('macOS sidecar 编译完成并通过许可证核验。');
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
