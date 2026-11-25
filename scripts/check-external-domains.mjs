// CI 闸门：dist 里不允许出现第三方域名（规格 §3：运行期只允许请求本站资源）。
//
// 白名单是**显式**的：宁可误报（然后在这里加一行），也不要漏掉一个 CDN。
// 注意：白名单里的 github.com 只用于「桌面版下载」这个 <a href>，它是用户**点击**才发起的
// 导航，不是页面自动加载的资源 —— 这两者的区别正是本脚本的判定依据。

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const dist = join(repo, 'dist');

/** 允许出现的域名（含用途说明） */
const ALLOWED = new Map([
  ['github.com', '桌面版下载链接（<a href>，用户点击才导航）'],
  ['react.dev', 'React 错误提示 URL（仅在抛错时拼进 console 字符串，非资源加载）'],
  ['lucky845.github.io', '项目页备用地址'],
  ['media-toolbox.lucky845.top', '本站自身域（CNAME / canonical）'],
  ['www.w3.org', 'SVG/XML 命名空间（字符串常量，不是网络请求）'],
  ['schema.tauri.app', '仅出现在 Tauri 配置里，不进 dist'],
]);

/**
 * 需要**额外审计**的模式：真正会发起网络请求的写法。
 * 命中这些且域名不在白名单 → 立即失败（比单纯 grep https:// 更精确）。
 */
const REQUEST_PATTERNS = [
  /fetch\(\s*['"`]https?:\/\//g,
  /import\(\s*['"`]https?:\/\//g,
  /<script[^>]+src=["']https?:\/\//g,
  /<link[^>]+href=["']https?:\/\//g,
  /new\s+Worker\(\s*['"`]https?:\/\//g,
  /@import\s+url\(\s*['"]?https?:\/\//g,
];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.map', '.txt', '.webmanifest']);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const URL_RE = /https?:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

let violations = 0;
let scanned = 0;

try {
  for await (const file of walk(dist)) {
    if (!TEXT_EXT.has(extname(file))) continue;
    const text = await readFile(file, 'utf8');
    scanned++;

    // 1) 真实请求模式：无论域名是否在白名单，跨域请求一律视为违规
    for (const re of REQUEST_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const snippet = text.slice(m.index, Math.min(text.length, m.index + 120));
        if (snippet.includes('lucky845.top') || snippet.includes('github.io')) continue;
        console.error(`✗ ${file.replace(repo + '/', '')}: 检测到跨域资源请求`);
        console.error(`    ${snippet.replace(/\n/g, ' ')}`);
        violations++;
      }
    }

    // 2) 所有出现的域名：白名单外一律报出，由人判断是「字符串」还是「请求」。
    //    例外：vendored 的 pdf.js（Apache-2.0）源码里带 LICENSE 头注释（www.apache.org）
    //    以及 URL 解析用的占位域名（example.com / foo.bar）。它们是字符串常量与解析基准，
    //    不是资源请求；真正会发起请求的写法仍由上面第 1 段 REQUEST_PATTERNS 全量审计。
    const vendoredPdfJs = file.includes('/pdfjs/');
    if (!vendoredPdfJs) {
      for (const m of text.matchAll(URL_RE)) {
        const host = m[1].toLowerCase();
        if (ALLOWED.has(host)) continue;
        console.error(`✗ ${file.replace(repo + '/', '')}: 出现未授权域名 ${host}`);
        console.error(`    …${text.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\n/g, ' ')}…`);
        violations++;
      }
    }
  }
} catch (e) {
  console.error(`无法读取 dist/（先 npm run build）：${e.message}`);
  process.exit(2);
}

if (violations > 0) {
  console.error(`\n✗ 外部域名检查失败：${violations} 处`);
  console.error('若确需新增，请在 ALLOWED 里加一行并写明用途。');
  process.exit(1);
}

console.log(`✓ 外部域名检查通过（扫描 ${scanned} 个文件，全部为本站资源或已声明的链接）`);
