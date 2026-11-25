// 把 pdf.js 6.x 的运行文件从 node_modules 拷进 public/pdfjs。
//
// 为什么不 import 进 Vite 模块图：
//   - pdf.min.mjs 是 ESM，内部用 `new Worker(getWorkerSrc(...), {type:'module'})`
//     解析同源的 pdf.worker.min.mjs；Vite 打包会改写文件名并把它塞进 assets，
//     运行时 workerSrc 指向的路径就不再可控。
//   - 规格 §7：大二进制不进 git。这些文件只在构建期从 npm 依赖拷贝，
//     与 wasm 分包走完全相同的「npm 依赖 + 构建期拷贝」路径。
//
// 只拷最小可用集：
//   pdf.min.mjs            主线程 API（动态 import 懒加载）
//   pdf.worker.min.mjs     pdf.js 自己的解析 Worker（解析不阻塞主线程）
//   standard_fonts/        PDF 标准字体数据；不拷则部分 PDF 的文字渲染为空白
// 不拷 pdf.renderer.min.mjs：worker 侧渲染需要 document.fonts，在线版走主线程渲染。

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const src = join(repo, 'node_modules/pdfjs-dist');
const dst = join(repo, 'public/pdfjs');

await mkdir(join(dst, 'standard_fonts'), { recursive: true });

const files = ['pdf.min.mjs', 'pdf.worker.min.mjs'];
for (const f of files) {
  await copyFile(join(src, 'build', f), join(dst, f));
}

const fonts = await readdir(join(src, 'standard_fonts'));
for (const f of fonts) {
  if (!f.endsWith('.pfb')) continue;
  await copyFile(join(src, 'standard_fonts', f), join(dst, 'standard_fonts', f));
}

console.log(`✓ 已拷贝 pdf.js ${files.length} 个文件 + ${fonts.filter((f) => f.endsWith('.pfb')).length} 个标准字体到 public/pdfjs/`);
