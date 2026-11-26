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

// 无头环境强制降级 <a download>
await page.addInitScript(() => {
  Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true });
});

await page.goto(`${base}/#/documents`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 20_000 });
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.waitForSelector('.mono:has-text("sample.docx")', { timeout: 10_000 });

// 在线版走结构化路径（按钮文案「开始结构化转换」）；点击后应下载中间 JSON
const downloadPromise = page.waitForEvent('download', { timeout: 40_000 });
const runBtn = page.getByRole('button', { name: '开始结构化转换' });
await runBtn.click();
const download = await downloadPromise;
const name = download.suggestedFilename();

// 成功提示里有「结构化结果已生成」
await page.waitForSelector('.notice.info:has-text("结构化结果已生成")', { timeout: 10_000 }).catch(() => {});
const result = (await page.locator('.notice.info').allInnerTexts()).join(' | ');

const pass = errors.length === 0 && /converted\.json$|\.json$/.test(name) && result.includes('结构化结果已生成');
console.log(JSON.stringify({ pass, name, result, errors }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
