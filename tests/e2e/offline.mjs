// 验证离线能力（规格 §18）：
// 1. 首次在线访问 → SW 激活并缓存外壳；
// 2. 切 offline → 刷新页面仍能打开（外壳来自 SW 缓存）；
// 3. 进入图片页 → 处理图片仍可用（wasm 在运行时被缓存）；
// 4. SW 不得缓存任何 ffmpeg 资源（GPL 可选分包不能变成默认分发）。

import { chromium } from 'playwright';

const base = 'http://localhost:4173';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// ---- 1. 首次在线访问 ----
await page.goto(`${base}/#/image`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 20_000 });
await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null,
  { timeout: 15_000 },
);
// 等 wasm 被 SW 缓存（跑一次图片处理）
await page.locator('input[type="file"]').setInputFiles('tests/fixtures/gradient.png');
await page.waitForSelector('dl.kv', { timeout: 20_000 });
await page.getByRole('button', { name: '开始处理' }).click();
await page.waitForSelector('.task.succeeded', { timeout: 40_000 });

// 检查缓存里没有 ffmpeg
const cacheUrls = await page.evaluate(async () => {
  const keys = await caches.keys();
  const all = [];
  for (const k of keys) {
    const c = await caches.open(k);
    for (const r of await c.keys()) all.push(r.url);
  }
  return all;
});
const ffmpegCached = cacheUrls.filter((u) => /ffmpeg/i.test(u));

// ---- 2. 切 offline 刷新 ----
await context.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dropzone', { timeout: 15_000 });
// 检查稳定元素而不是截取文本：新皮肤里 main 前 120 字符可能还没到模块标题
const offlineShell = (await page.locator('.dropzone').count()) > 0;
const offlineText = (await page.locator('main').innerText()).replace(/\n+/g, ' | ').slice(0, 200);

// ---- 3. 离线再处理一张图 ----
await page.locator('input[type="file"]').setInputFiles('tests/fixtures/solid.png');
await page.waitForSelector('dl.kv', { timeout: 15_000 });
await page.getByRole('button', { name: '开始处理' }).click();
await page.waitForSelector('.task.succeeded', { timeout: 40_000 });
const offlineTask = (await page.locator('.task.succeeded').first().innerText()).replace(/\n+/g, ' | ');

const result = {
  swController: true,
  cacheEntries: cacheUrls.length,
  ffmpegCached,
  offlineShell,
  offlineTask,
  errors,
  pass: ffmpegCached.length === 0 && errors.length === 0 && offlineShell,
};

console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.pass ? 0 : 1);
