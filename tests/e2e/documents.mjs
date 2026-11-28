// 文档结构化转换端到端：真实 Chromium 上传 docx → 结构化 → 下载中间产物。
// 走统一 Backend（getBackend().run），验证 Web 结构化路径没有因 Backend 重构而回归。
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const fixture = process.argv[3] ?? 'tests/fixtures/sample.docx';

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

// 第一次取消保存；下一次禁用 picker，以有下载事件的真实回退路径验证重试。
await page.addInitScript(() => {
  Object.defineProperty(globalThis, 'showSaveFilePicker', {
    value: async () => {
      Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true });
      throw new DOMException('Save cancelled', 'AbortError');
    },
    configurable: true,
  });
});

await page.goto(`${base}/#/documents`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 20_000 });
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.waitForSelector('.mono:has-text("sample.docx")', { timeout: 10_000 });

// 取消后显示未保存，不应出现下载或成功提示。
let downloads = 0;
page.on('download', () => downloads++);
await page.getByRole('button', { name: '开始结构化转换' }).click();
const notice = page.getByRole('status').filter({ hasText: '已取消保存' });
await notice.waitFor({ timeout: 40_000 });
const cancelled = await notice.innerText();
const cancelledOnly = downloads === 0 && cancelled.includes('文件未保存') && !cancelled.includes('已发起下载');

// 不重新转换，直接保存已生成的文件；真实 <a download> 下载中间 JSON。
const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
await page.getByRole('button', { name: '重新保存' }).click();
const download = await downloadPromise;
const name = download.suggestedFilename();
const success = page.getByRole('status').filter({ hasText: '已发起下载' });
await success.waitFor({ timeout: 10_000 });
const result = await success.innerText();

const pass = errors.length === 0 && cancelledOnly && /\.json$/.test(name) &&
  result.includes('结构化结果已生成') && !(await notice.count());
console.log(JSON.stringify({ pass, name, cancelled, result, errors }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
