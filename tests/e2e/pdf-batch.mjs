// Export separate PDFs without sharing preview document/bitmap lifetime.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4173';
const bytes = await readFile('tests/fixtures/sample.pdf');
const browser = await chromium.launch();
try {
  for (const concurrency of [1, 2]) {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.addInitScript((count) => {
      delete window.showSaveFilePicker;
      localStorage.setItem('media-toolbox-queue-concurrency', String(count));
    }, concurrency);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const names = [];
    page.on('download', (download) => names.push(download.suggestedFilename()));
    await page.goto(`${base}/#/pdf`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: '渲染图片', exact: true }).click();
    const input = page.locator('input[type=file][multiple]');
    await input.waitFor({ state: 'attached' });
    await input.setInputFiles(['one', 'two', 'broken'].map((name) => ({
      name: `${name}.pdf`, mimeType: 'application/pdf',
      buffer: name === 'broken' ? Buffer.from('broken PDF') : bytes,
    })));
    await page.getByRole('button', { name: '批量导出 3 份 PDF', exact: true }).click();
    try {
      await page.getByText(/已导出 6 \/ 6 张图片/).waitFor({ timeout: 15000 });
    } catch (error) {
      console.log(await page.locator('body').innerText(), errors, names);
      throw error;
    }
    await page.waitForFunction(() => document.readyState === 'complete');
    assert.equal(names.length, 6);
    assert.equal(new Set(names).size, 6);
    assert.ok(names.some((name) => name.startsWith('one-1-')));
    assert.ok(names.some((name) => name.startsWith('two-2-')));
    assert.ok((await page.locator('body').innerText()).includes('broken.pdf：'));
    assert.deepEqual(errors, []);
    console.log(`PDF batch concurrency ${concurrency}: 6 unique PNG downloads; corrupt file isolated.`);
    await page.close();
  }
} finally {
  await browser.close();
}
