// CI 闸门：features/ 里禁止按「壳」分叉（D3）。
//
// 这条检查拦住的是最常见的退化：先在 Web 上写通，再在桌面端加一个
// `if (backend.kind === 'desktop') invoke(...)`。一旦开了这个口子，
// 「一份 UI」就不成立了，后面每个功能都会复制一遍。

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const dirs = [join(repo, 'src/features'), join(repo, 'src/components')];

const FORBIDDEN = [
  { re: /from\s+['"]@tauri-apps/, why: 'features/ 不得直接依赖 Tauri API，必须经 Backend 接口' },
  { re: /\bwindow\.__TAURI__\b|\b__TAURI_INTERNALS__\b/, why: 'features/ 不得探测运行时；能力一律走 capabilities()' },
  { re: /\bkind\s*===\s*['"]desktop['"]/, why: '不得按壳分支；请改用 capabilities() 的字段' },
  { re: /\bkind\s*===\s*['"]web['"]/, why: '不得按壳分支；请改用 capabilities() 的字段' },
  { re: /\bisTauri\b|\bisDesktop\b|\bisWeb\b/, why: '不得按壳分支；请改用 capabilities() 的字段' },
];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

let violations = 0;

for (const dir of dirs) {
  for await (const file of walk(dir)) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      for (const rule of FORBIDDEN) {
        if (!rule.re.test(line)) continue;
        console.error(`✗ ${file.replace(repo + '/', '')}:${i + 1}`);
        console.error(`    ${t}`);
        console.error(`    原因：${rule.why}`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n✗ 前端分叉检查失败：${violations} 处违反`);
  process.exit(1);
}

console.log('✓ 前端分叉检查通过：features/ 与 components/ 没有按壳分支');
