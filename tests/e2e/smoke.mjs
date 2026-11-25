// 端到端冒烟测试：真实浏览器里加载页面、跑一次图片处理、检查无外链请求。
//
// 为什么是 .mjs 而不是 vitest：需要在真实的 Vite 产物上跑（含 worker + wasm），
// 而 vitest 的 jsdom 环境没有 Worker 与 wasm 流式编译。

import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const fixture = process.argv[3] ?? 'tests/fixtures/gradient.png';

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
const external = [];

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
});

// ---- 1. 打开图片页 ----
await page.goto(`${base}/#/image`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 15_000 });

// 等能力探测完成（badge 出现「在线版」或「桌面版」）
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.badge')).some((b) => /在线版|桌面版/.test(b.textContent ?? '')),
  { timeout: 15_000 },
);

// ---- 2. 上传文件 ----
const fileInput = page.locator('input[type="file"]');
await fileInput.setInputFiles(fixture);
await page.waitForSelector('dl.kv', { timeout: 20_000 });

const metaText = await page.locator('dl.kv').first().innerText();

// ---- 3. 开始处理 ----
const runBtn = page.getByRole('button', { name: '开始处理' });
await runBtn.click();

// ---- 4. 等完成 ----
await page.waitForSelector('.task.succeeded', { timeout: 40_000 });
const taskText = await page.locator('.task.succeeded').first().innerText();

// ---- 5. 检查页面无外链 ----
await page.goto(`${base}/#/help`, { waitUntil: 'networkidle' });
const helpText = (await page.locator('main').innerText()).slice(0, 400);

const result = {
  meta: metaText.replace(/\n+/g, ' | '),
  task: taskText.replace(/\n+/g, ' | '),
  helpHead: helpText.replace(/\n+/g, ' | ').slice(0, 260),
  consoleErrors,
  external,
  pass: consoleErrors.length === 0 && external.length === 0 && /完成/.test(taskText),
};

console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.pass ? 0 : 1);
