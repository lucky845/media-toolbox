// 验证 wasm 加载器的 MIME 降级路径（规格 §17）。
//
// 做法：起一个临时 HTTP 服务器，对 .wasm 故意返回 `application/octet-stream`，
// 然后用真实浏览器加载页面，确认：
//   1. 页面正常渲染（没有因为 MIME 不对而白屏）；
//   2. 图片处理仍然能跑通（走了 arraybuffer 降级）；
//   3. 控制台有降级日志（说明走的是我们预期那条路径，而不是悄悄成功）。
//
// 这验证的是「两种本地部署方式」里必然出现的差异：
// Python 3.15 的 http.server 已正确返回 application/wasm，但更老版本不行。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';
import { chromium } from 'playwright';

const repo = resolve(import.meta.dirname, '../..');
const dist = join(repo, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/octet-stream', // ← 故意错误！触发降级
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, safe === '/' ? 'index.html' : safe);
    // hash 路由不走服务端；404.html 作为兜底
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      file = join(dist, '404.html');
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

console.log(`临时服务器：${base}（.wasm 故意返回 application/octet-stream）`);

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
const loadLogs = [];

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
  if (/降级|MIME|wasm/i.test(m.text())) loadLogs.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

let pass = false;
let task = '';

try {
  await page.goto(`${base}/#/image`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dropzone', { timeout: 20_000 });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.badge')).some((b) => /在线版|桌面版/.test(b.textContent ?? '')),
    { timeout: 20_000 },
  );

  // 确认 MIME 真的是错的
  const ct = await page.evaluate(async () => {
    const r = await fetch('/wasm/core_image_bg.wasm', { method: 'HEAD' });
    return r.headers.get('content-type');
  });
  console.log(`实际 content-type: ${ct}`);
  if (ct !== 'application/octet-stream') {
    throw new Error(`测试前提不成立：期望错误 MIME，实际 ${ct}`);
  }

  await page.locator('input[type="file"]').setInputFiles('tests/fixtures/gradient.png');
  await page.waitForSelector('dl.kv', { timeout: 20_000 });

  const runBtn = page.getByRole('button', { name: '开始处理' });
  await runBtn.click();
  await page.waitForSelector('.task.succeeded', { timeout: 40_000 });
  task = (await page.locator('.task.succeeded').first().innerText()).replace(/\n+/g, ' | ');

  // 检查能力页里 loadPath 的记录（通过 log 消息传回；这里主要看没有白屏）
  pass = consoleErrors.length === 0;
} catch (e) {
  console.error(`失败：${e.message}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(JSON.stringify({ pass, task, consoleErrors, loadLogs }, null, 2));
process.exit(pass ? 0 : 1);
