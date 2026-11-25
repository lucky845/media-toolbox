// 把构建好的 wasm 分包从 crates/wasm/pkg 拷进 public/wasm。
//
// 为什么单独成脚本：CI 与本地要执行完全相同的拷贝步骤，
// 硬编码 `cp` 容易漏文件（尤其是新增分包时）。

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const src = join(repo, 'crates/wasm/pkg');
const dst = join(repo, 'public/wasm');

await mkdir(dst, { recursive: true });

const files = await readdir(src);
let n = 0;
for (const f of files) {
  if (!/\.(js|wasm)$/.test(f)) continue;
  await copyFile(join(src, f), join(dst, f));
  n++;
}

console.log(`✓ 已拷贝 ${n} 个 wasm 文件到 public/wasm/`);
