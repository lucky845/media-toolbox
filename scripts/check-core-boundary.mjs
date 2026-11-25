// CI 闸门：crates/core 里禁止出现平台相关的东西（docs/ARCHITECTURE.md §2.1）。
//
// 为什么这条检查必须存在：`use rayon` 或 `std::thread` 在 native 上完全「能用」，
// 编译期不报错，只有到了 wasm 构建才失败 —— 而那时已经写了几百行。
// 提前在 CI 里 grep 住，连续体都不会被写出来。

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const coreDir = join(repo, 'crates/core/src');

/** 禁止在 core 里出现的模式（每项都要说明为什么） */
const FORBIDDEN = [
  { re: /\buse\s+rayon\b|\brayon::/, why: '并行必须走 media_ports::Parallel（D2）' },
  { re: /\bstd::thread\b/, why: 'core 不允许创建线程；并行由 Parallel 注入' },
  { re: /cfg\(\s*target_(arch|os|family)\s*=/, why: '平台 cfg 不得泄漏进算法层' },
  { re: /\bstd::fs\b|\bstd::path\b/, why: 'core 只处理字节，不碰文件路径（§11）' },
  { re: /\bstd::net\b|\bstd::process\b/, why: 'core 不允许网络与子进程' },
  { re: /#\[cfg\(feature = "native"\)\]/, why: '同一算法不应按壳分叉' },
];

/** 允许的例外（带行号说明） */
const ALLOWLIST = [
  // 无例外。若将来真需要，必须在这里写明理由与审批记录。
];

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.rs')) yield p;
  }
}

let violations = 0;

for await (const file of walk(coreDir)) {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    // 跳过注释行（文档里提到 rayon 是允许的，代码里不行）
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    for (const rule of FORBIDDEN) {
      if (!rule.re.test(line)) continue;
      const key = `${file}:${i + 1}`;
      if (ALLOWLIST.some((a) => a.file === file && a.line === i + 1)) continue;
      console.error(`✗ ${file.replace(repo + '/', '')}:${i + 1}`);
      console.error(`    ${trimmed}`);
      console.error(`    原因：${rule.why}`);
      violations++;
      void key;
    }
  }
}

if (violations > 0) {
  console.error(`\n✗ core 边界检查失败：${violations} 处违反`);
  process.exit(1);
}

console.log('✓ core 边界检查通过：crates/core 里没有 rayon / fs / net / thread / 平台 cfg');
