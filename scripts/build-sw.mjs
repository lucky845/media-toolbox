// 构建 Service Worker：
// Vite 的入口是 main.tsx，sw.ts 不在模块图里，需要单独编译。
// Vite 8 自带 rolldown（不是 esbuild），用它的 build API 编译。
//
// 额外职责：把 Vite 产出的 JS chunk 全部注入到 SW 的预缓存清单。
// 为什么：Worker 脚本（image.worker-*.js）不在 index.html 的 <script> 标签里，
// 只靠解析 HTML 拿不到它 —— 离线时 worker 创建失败，能力探测永远停在 detecting…（实测）。

import { rolldown } from 'rolldown';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';

const repo = resolve(import.meta.dirname, '..');
const outdir = join(repo, 'dist');

await mkdir(outdir, { recursive: true });

const bundle = await rolldown({
  input: join(repo, 'src/sw.ts'),
  logLevel: 'silent',
});
const { output } = await bundle.generate({ format: 'iife' });

let code = output
  .filter((o) => o.type === 'chunk')
  .map((o) => o.code)
  .join('\n');

// 收集 dist/assets 下全部 JS/CSS（含 worker chunk）
const assetsDir = join(outdir, 'assets');
const files = await readdir(assetsDir);
const extraAssets = files
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => `assets/${f}`);

// wasm 与胶水也在 install 时预缓存：
// 运行时 fetch 缓存实测会出现 bodyLen=0 的空壳（请求体只能消费一次），
// 且 worker 内的 fetch 不一定被页面 SW 拦截。预缓存是最可靠的方式。
// 代价：新访客多下约 307 KB —— 但进入图片页本来就要下，净增为 0。
const wasmDir = join(outdir, 'wasm');
const { readdir: readDir2 } = await import('node:fs/promises');
const wasmFiles = (await readDir2(wasmDir)).filter((f) => /core_image.*\.(js|wasm)$/.test(f));
for (const f of wasmFiles) extraAssets.push(`wasm/${f}`);

// 注入全局常量（base 相对路径）
const injection = `self.__MT_EXTRA_ASSETS__=${JSON.stringify(extraAssets)};\n`;
code = injection + code;

await writeFile(join(outdir, 'sw.js'), code, 'utf8');
console.log(`✓ dist/sw.js 已生成（预缓存 ${extraAssets.length} 个 assets，含 worker chunk）`);
