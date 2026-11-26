// Web 视频转码端到端测试：真实 Chromium 上传 MP4 → 探测 → WebCodecs 转码 → 下载。
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const fixture = process.argv[3] ?? 'tests/fixtures/sample.mp4';

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

// 无头浏览器里 FSA 选择器无法交互；强制走 <a download> 以便断言下载事件。
await page.addInitScript(() => {
  Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true });
});

await page.goto(`${base}/#/video`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 20_000 });

// 上传 MP4
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.waitForSelector('dl.kv', { timeout: 30_000 });
const meta = (await page.locator('dl.kv').first().innerText()).replace(/\n+/g, ' | ');

// 开始转码，等待下载
const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
const runBtn = page.getByRole('button', { name: '开始转码' });
await runBtn.click();
const download = await downloadPromise;
const downloadName = download.suggestedFilename();

// 等结果提示（成功文案）
await page.waitForSelector('.hint:has-text("已生成")', { timeout: 20_000 }).catch(() => {});
const result = await page.locator('.hint').allInnerTexts();
const resultText = result.filter((t) => t.includes('已生成')).join(' | ');

const pass =
  errors.length === 0 &&
  /avc|h\.264|avc1/i.test(meta) &&
  /^video-\d+\.mp4$/.test(downloadName) &&
  resultText.includes('已生成');

console.log(JSON.stringify({ pass, meta, downloadName, resultText, errors }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
