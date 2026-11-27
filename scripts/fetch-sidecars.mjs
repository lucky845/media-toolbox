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
import { mkdir, readdir, stat, writeFile, chmod, copyFile } from 'node:fs/promises';
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
  // 用**静态** lgpl 构建（-lgpl，非 -lgpl-shared）：动态版缺 libavdevice.so 等运行库，
  // 在本机核验 configure 行时会直接失败；静态版体积大 ~20–30 MB 但零外部依赖。
  // 不用写死版本号/URL —— 用 GitHub API 在 latest 发布里按模式匹配当前资产名，
  // 否则 BtbN 升级 FFmpeg 版本后固定 URL 会 404（2026-11 实测 7.1 已失效）。
  'x86_64-pc-windows-msvc': {
    apiMatch: 'win64-lgpl-',
    apiExclude: 'lgpl-shared',
    kind: 'zip',
    note: 'BtbN 静态 lgpl（无 gpl/nonfree；版本动态解析）',
  },
  'x86_64-unknown-linux-gnu': {
    apiMatch: 'linux64-lgpl-',
    apiExclude: 'lgpl-shared',
    kind: 'tar.xz',
    note: 'BtbN 静态 lgpl（版本动态解析）',
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
  const configureLine = out.split('\n').find((line) => line.startsWith('configuration:'));
  if (!configureLine) {
    return { ok: false, reason: `无法读取 ${bin} 的 configuration 行` };
  }
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

async function prepareMacLicenseBundle(ffmpegSourceDir, vpxSourceDir) {
  const licenseDir = join(sidecarDir, 'THIRD_PARTY_LICENSES');
  await mkdir(licenseDir, { recursive: true });
  await copyFile(join(repo, 'THIRD_PARTY_NOTICES.md'), join(licenseDir, 'THIRD_PARTY_NOTICES.md'));
  await copyFile(join(ffmpegSourceDir, 'COPYING.LGPLv2.1'), join(licenseDir, 'FFmpeg-LGPL-2.1.txt'));
  for (const file of ['LICENSE', 'PATENTS']) {
    await copyFile(join(vpxSourceDir, file), join(licenseDir, `libvpx-${file}.txt`));
  }
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

  if (src.kind === 'build') {
    // macOS 没有可下载的 LGPL 构建（BtbN 只提供 win/linux）。在 CI runner 上源码编译：
    // 只开 LGPL 兼容编码器 + 系统 VideoToolbox/AudioToolbox，绝不引入 x264/x265/nonfree。
    // FFmpeg 和 libvpx 一起静态构建，避免将 runner 的 Homebrew dylib 路径写入产物。
    log('macOS：源码编译 LGPL FFmpeg（无 x264/x265；H.264 走系统 VideoToolbox）…');
    const tmp = join(repo, '.sidecar-tmp');
    const buildDir = join(tmp, 'ffmpeg-src');
    const vpxSource = join(tmp, 'libvpx-v1.17.0');
    const vpxBuild = join(tmp, 'libvpx-build-arm64');
    const vpxPrefix = join(tmp, 'libvpx-static-arm64');
    const deploymentTarget = '11.0';
    const buildEnv = { ...process.env, MACOSX_DEPLOYMENT_TARGET: deploymentTarget };
    const jobs = process.env.JOBS ?? '4';
    await mkdir(vpxBuild, { recursive: true });
    if (!existsSync(join(vpxSource, 'configure'))) {
      execFileSync('git', [
        'clone', '--depth', '1', '--branch', 'v1.17.0',
        'https://github.com/webmproject/libvpx.git', vpxSource,
      ], { stdio: 'inherit', cwd: repo });
    }
    // Homebrew 的静态库也可能要求比应用更高的 macOS 版本，因此从源码指定最低版本。
    const vpxOptions = { stdio: 'inherit', cwd: vpxBuild, env: buildEnv };
    execFileSync(join(vpxSource, 'configure'), [
      '--target=arm64-darwin20-gcc', `--prefix=${vpxPrefix}`,
      `--extra-cflags=-mmacosx-version-min=${deploymentTarget}`,
      '--enable-static', '--disable-shared',
      '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests',
    ], vpxOptions);
    execFileSync('make', [`-j${jobs}`], vpxOptions);
    execFileSync('make', ['install'], vpxOptions);
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
      // 禁止 pkg-config 自动发现 runner 上的 X11/XCB/Homebrew 动态库。
      '--disable-autodetect', '--disable-xlib', '--disable-libxcb',
      '--enable-libvpx',
      `--extra-cflags=-I${join(vpxPrefix, 'include')}`,
      `--extra-ldflags=-L${join(vpxPrefix, 'lib')}`,
      '--extra-libs=-lvpx -framework Security',
      // 不启用 libsvtav1：FFmpeg n7.1 的 libsvtav1 wrapper 与新 Homebrew SVT-AV1 API 不兼容
      // （enable_adaptive_quantization 字段已移除）；AV1 编码对档位 L 非必需，H.264 走 VideoToolbox。
      // 安全：显式不启用任何 GPL/nonfree 组件（configure 默认即关闭，这里写明便于审计）
      '--disable-gpl', '--disable-nonfree',
    ];
    execFileSync('./configure', configure, { stdio: 'inherit', cwd: buildDir, env: buildEnv });
    execFileSync('make', [`-j${jobs}`], { stdio: 'inherit', cwd: buildDir, env: buildEnv });
    execFileSync('make', ['install'], { stdio: 'inherit', cwd: buildDir, env: buildEnv });

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
      const linkage = execFileSync('otool', ['-L', dest], { encoding: 'utf8' });
      const nonSystemDeps = linkage.split('\n').slice(1).filter((line) =>
        line.trim() && !line.trim().startsWith('/System/Library/') && !line.trim().startsWith('/usr/lib/'),
      );
      if (nonSystemDeps.length > 0) {
        log(`✗ ${name}-${target} 含非系统动态依赖：\n${nonSystemDeps.join('\n')}`);
        process.exit(1);
      }
      log(`✓ ${name}-${target} 无 Homebrew/第三方动态库依赖`);
      const minVersions = execFileSync('otool', ['-l', dest], { encoding: 'utf8' })
        .split('\n').filter((line) => line.includes('minos ')).map((line) => line.trim().split(/\s+/).at(-1));
      if (minVersions.some((version) => Number.parseFloat(version) > Number.parseFloat(deploymentTarget))) {
        log(`✗ ${name}-${target} 的最低系统版本超过 ${deploymentTarget}：${minVersions.join(', ')}`);
        process.exit(1);
      }
    }
    await prepareMacLicenseBundle(buildDir, vpxSource);
    log('macOS sidecar 编译完成并通过许可证、动态依赖和最低系统版本核验。');
    process.exit(0);
  }

  // ---- 下载并解压 ----
  const tmp = join(repo, '.sidecar-tmp');
  await mkdir(tmp, { recursive: true });
  const archive = join(tmp, 'ffmpeg-download');

  // 动态解析当前 latest 发布里的资产名，避免 FFmpeg 版本升级后固定 URL 404。
  const rel = JSON.parse(execFileSync('curl', [
    '-fsSL', 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest',
  ], { encoding: 'utf8' }));
  const asset = rel.assets.find((a) =>
    a.name.includes(src.apiMatch) && !(src.apiExclude && a.name.includes(src.apiExclude)));
  if (!asset) {
    log(`✗ 在 BtbN latest 发布里找不到匹配 ${src.apiMatch} 的资产（发布 ${rel.tag_name}）`);
    process.exit(1);
  }
  const url = asset.browser_download_url;
  log(`下载 ${url}（发布 ${rel.tag_name}）`);
  execFileSync('curl', ['-fL', '--retry', '3', '-o', archive, url], { stdio: 'inherit' });

  const hash = await sha256(archive);
  if (asset.digest !== `sha256:${hash}`) {
    throw new Error(`FFmpeg 下载校验失败：${asset.name}`);
  }
  log(`✓ sha256: ${hash}`);
  await writeFile(join(sidecarDir, 'SHA256SUMS'), `${hash}  ffmpeg-download\n`);

  log('解压…');
  const extractDir = join(tmp, asset.name);
  await mkdir(extractDir, { recursive: true });
  if (src.kind === 'zip' && process.platform !== 'win32') {
    execFileSync('unzip', ['-qo', archive, '-d', extractDir], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', archive, '-C', extractDir], { stdio: 'inherit' });
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
    const p = findBinary(extractDir, name);
    if (!p) {
      log(`✗ 解压包里找不到 ${name}`);
      process.exit(1);
    }
    found[name] = p;
    // Tauri externalBin 硬规则：Windows 必须带 .exe，否则 build script 找不到资源。
    const dest = join(sidecarDir, `${name}-${target}${exeSuffix}`);
    await copyFile(p, dest);
    await chmod(dest, 0o755);
    log(`✓ ${dest}`);
  }

  // ---- 许可证核验（不信任文件名）----
  log('');
  log('核验 configure 行：');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const bin = join(sidecarDir, `${name}-${target}${exeSuffix}`);
    const expectedPlatform = target.includes('windows') ? 'win32' : 'linux';
    if (process.platform !== expectedPlatform || process.arch !== 'x64') {
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
  const licenseDir = join(sidecarDir, 'THIRD_PARTY_LICENSES');
  await mkdir(licenseDir, { recursive: true });
  await copyFile(join(repo, 'THIRD_PARTY_NOTICES.md'), join(licenseDir, 'THIRD_PARTY_NOTICES.md'));
  await copyFile(join(found.ffmpeg, '..', '..', 'LICENSE.txt'), join(licenseDir, 'FFmpeg-BtbN-LICENSE.txt'));
  await writeFile(join(licenseDir, 'FFmpeg-BtbN-source.txt'), `${url}\nhttps://github.com/BtbN/FFmpeg-Builds\n`);
  log('完成。构建带视频能力的安装包：');
  log(`  cargo tauri build --target ${target} --config src-tauri/tauri.sidecar.conf.json`);
}

void stat;
void existsSync;
await main();
