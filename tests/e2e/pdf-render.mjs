// PDF→图片渲染端到端测试（真实 Chromium）：
// 上传 PDF → 切到「渲染图片」→ 验证按页预览画布有真实像素 → 导出 PNG → 校验下载。
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const fixture = process.argv[3] ?? 'tests/fixtures/sample.pdf';

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(`${base}/#/pdf`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 20_000 });
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.waitForSelector('dl.kv', { timeout: 30_000 });

// 切到渲染页
await page.getByRole('button', { name: '渲染图片' }).click();
await page.waitForSelector('h2:has-text("页面预览与图片导出")', { timeout: 20_000 });

// 等待第一页画布画出真实像素（width>0 + canvas 非全白）
await page.waitForFunction(() => {
  const canvas = document.querySelector('canvas[data-page], [data-page] canvas');
  // 默认空 canvas 是 300×150，必须大于它才算真正渲染过
  if (!canvas || canvas.width <= 300 || canvas.height <= 150) return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) return true;
  }
  return false;
}, null, { timeout: 60_000 });

const canvasInfo = await page.evaluate(() => {
  const canvas = document.querySelector('[data-page] canvas');
  return canvas ? { width: canvas.width, height: canvas.height } : { width: 0, height: 0 };
});

// 导出 PNG（默认范围 1-3，默认 longImage=false → 逐页输出多个文件）
const dlPromise = page.waitForEvent('download', { timeout: 60_000 });
await page.getByRole('button', { name: /导出为图片/ }).click();
const download = await dlPromise;
const downloadName = download.suggestedFilename();

const pass =
  errors.length === 0 &&
  canvasInfo.width > 0 &&
  canvasInfo.height > 0 &&
  /page-\d+\.png$/.test(downloadName);

console.log(JSON.stringify({ pass, canvasInfo, downloadName, errors }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
