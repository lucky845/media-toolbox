// PDF 结构操作的端到端测试：在真实浏览器里上传 PDF → 探测 → 旋转 → 下载。
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const fixture = process.argv[3] ?? 'tests/fixtures/sample.pdf';

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(`${base}/#/pdf`, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone', { timeout: 20_000 });

// 上传 PDF
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.waitForSelector('dl.kv', { timeout: 30_000 });
const meta = (await page.locator('dl.kv').innerText()).replace(/\n+/g, ' | ');

// 执行默认操作（旋转）
const runBtn = page.getByRole('button', { name: '执行' });
await runBtn.click();

await page.waitForSelector('.notice.info', { timeout: 40_000 });
const result = (await page.locator('.notice.info').innerText()).replace(/\n+/g, ' | ');

const pass = errors.length === 0 && meta.includes('3') && result.includes('rotated.pdf');
console.log(JSON.stringify({ pass, meta, result, errors }, null, 2));
await browser.close();
process.exit(pass ? 0 : 1);
