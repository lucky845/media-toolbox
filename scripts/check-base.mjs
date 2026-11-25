// 验证 `base` 注入在两种形态下都正确（规格 §16）。
//
// 两种目标：
//   1. 自定义域：VITE_BASE=/          → index.html 引用 /assets/...
//   2. 项目页：  VITE_BASE=/repo/     → index.html 引用 /repo/assets/...
//
// 用户选的是形态 1，但形态 2 必须在构建期仍可用（只是改一个环境变量）。
// 本脚本只做静态检查，不写文件：读 vite.config.ts 与源码，确认没有硬编码绝对路径。

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const fails = [];

// ---- 1. vite.config.ts 的 base 必须由环境变量提供 ----
const vite = await readFile(join(repo, 'vite.config.ts'), 'utf8');
if (!/base:\s*process\.env\.VITE_BASE\s*\?\?\s*'\/'/.test(vite)) {
  fails.push('vite.config.ts 的 base 未由 VITE_BASE 注入（或默认值不是 /）');
}

// ---- 2. 前端代码里不得出现硬编码的绝对路径 wasm URL ----
const toCheck = [
  'src/lib/backend/web/webBackend.ts',
  'src/lib/backend/web/wasmLoader.ts',
  'src/workers/image.worker.ts',
  'src/features/image/ImagePage.tsx',
];
for (const rel of toCheck) {
  const text = await readFile(join(repo, rel), 'utf8');
  if (/['"`]\/wasm\//.test(text)) {
    fails.push(`${rel}: 出现硬编码的 /wasm/... URL，应走 BASE_URL 拼接`);
  }
  if (/['"`]\/assets\//.test(text)) {
    fails.push(`${rel}: 出现硬编码的 /assets/... URL，应走 BASE_URL 拼接`);
  }
}

// ---- 3. 404.html 必须用相对路径（否则项目页 base 下会跳到域名根）----
const notFound = await readFile(join(repo, 'public/404.html'), 'utf8');
if (/href="\/(?!\/)/.test(notFound)) {
  fails.push('public/404.html 里仍有以 / 开头的绝对路径链接（应用相对路径 ./）');
}

// ---- 4. 自定义域 기반 index.html 的 icon 必须是相对路径 ----
const html = await readFile(join(repo, 'index.html'), 'utf8');
if (!/href="\.\/icons\//.test(html)) {
  fails.push('index.html 的 favicon 不是相对路径（应为 ./icons/... 或 BASE_URL 拼接）');
}

// ---- 5. Vite 脚本入口会被构建期重写，允许 /src/main.tsx ----
// （这里只确认它确实是 Vite 的入口，而不是某个运行时 fetch）
if (!/src="\/src\/main\.tsx"/.test(html)) {
  fails.push('index.html 缺少 Vite 入口 /src/main.tsx');
}

if (fails.length > 0) {
  console.error('✗ base / 路径检查失败：');
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('✓ base 检查通过：base 由 VITE_BASE 注入，前端与 404.html 无硬编码绝对路径');
console.log('  自定义域：VITE_BASE=/         → https://media-toolbox.lucky845.top/');
console.log('  项目页：  VITE_BASE=/<repo>/  → https://lucky845.github.io/<repo>/');
console.log('  切回项目页时只需改 workflow 里的 VITE_BASE，并在 Settings → Pages 里删掉自定义域');
