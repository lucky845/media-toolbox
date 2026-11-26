// Exercise PDF structure operations in a real browser and probe the downloaded merge.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const fixture = await readFile(process.argv[3] ?? 'tests/fixtures/sample.pdf');
const secondFixture = process.argv[4] ? await readFile(process.argv[4]) : fixture;
const pdf = (name, buffer = fixture) => ({ name, mimeType: 'application/pdf', buffer });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`${base}/#/pdf`, { waitUntil: 'networkidle' });
  const picker = page.locator('input[type="file"]');
  const pageCount = page.locator('dl.kv dd').first();
  async function uploadAndProbe(files) {
    await pageCount.waitFor({ state: 'hidden' });
    await picker.setInputFiles(files);
    await pageCount.waitFor({ state: 'visible', timeout: 30_000 });
    return Number(await pageCount.innerText());
  }
  const [firstPages, secondPages] = await (async () => {
    const firstPages = await uploadAndProbe(pdf('first.pdf'));
    await page.reload();
    const secondPages = await uploadAndProbe(pdf('second.pdf', secondFixture));
    return [firstPages, secondPages];
  })();
  assert.ok(firstPages > 0 && secondPages > 0);

  const execute = page.getByRole('button', { name: '执行', exact: true });
  const rotateDownload = page.waitForEvent('download', { timeout: 40_000 });
  await execute.click();
  assert.equal((await rotateDownload).suggestedFilename(), 'rotated.pdf');
  await page.getByText(/已生成 rotated\.pdf/).waitFor();

  await page.reload();
  await uploadAndProbe([pdf('first.pdf'), pdf('second.pdf', secondFixture)]);
  await page.getByRole('button', { name: '合并', exact: true }).click();
  const downloadDone = page.waitForEvent('download', { timeout: 40_000 });
  await execute.click();
  const download = await downloadDone;
  assert.equal(download.suggestedFilename(), 'merged.pdf');
  const merged = await readFile(await download.path());
  assert.equal(merged.subarray(0, 5).toString(), '%PDF-');
  await page.getByText(/已生成 merged\.pdf/).waitFor();

  await page.reload();
  const mergedPages = await uploadAndProbe(pdf('merged.pdf', merged));
  assert.equal(mergedPages, firstPages + secondPages);

  await page.reload();
  await uploadAndProbe(Array.from({ length: 51 }, (_, i) => pdf(`input-${i}.pdf`)));
  await page.getByRole('button', { name: '合并', exact: true }).click();
  await execute.click();
  await page.getByText(/合并最多支持 50 个 PDF/).waitFor();
  await page.reload();
  await uploadAndProbe(pdf('extract.pdf'));
  await page.getByRole('button', { name: '提取页面', exact: true }).click();
  const range = page.getByRole('textbox', { name: '页码范围' });
  await range.fill(String(firstPages + 1));
  await execute.click();
  await page.getByText(/页码范围无效/).first().waitFor();
  await range.fill('1');
  const extractDone = page.waitForEvent('download', { timeout: 40_000 });
  await execute.click();
  const extracted = await extractDone;
  assert.equal(extracted.suggestedFilename(), 'extracted.pdf');
  const extractedBytes = await readFile(await extracted.path());
  await page.reload();
  assert.equal(await uploadAndProbe(pdf('extracted.pdf', extractedBytes)), 1);

  if (firstPages >= 2) {
    await page.reload();
    await uploadAndProbe(pdf('split.pdf'));
    await page.getByRole('button', { name: '拆分', exact: true }).click();
    await range.fill('1,2');
    const filenames = [];
    page.on('download', (item) => filenames.push(item.suggestedFilename()));
    await execute.click();
    await page.getByText('已导出 2 / 2 个文件').waitFor();
    await page.waitForFunction(() => document.readyState === 'complete');
    await expectDownloads();
    async function expectDownloads() {
      const deadline = Date.now() + 5000;
      while (filenames.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(filenames.sort(), ['part-1.pdf', 'part-2.pdf']);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, firstPages, secondPages, mergedPages, fileCountLimit: 50 }));
} finally {
  await browser.close();
}
