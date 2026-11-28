import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // Exercise the download fallback without opening a native save dialog.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/#/image`);
  const source = await readFile(new URL('../fixtures/gradient.png', import.meta.url));
  const input = page.locator('input[type=file]');
  await input.setInputFiles([
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') },
    { name: 'second.png', mimeType: 'image/png', buffer: source },
    { name: 'third.png', mimeType: 'image/png', buffer: source },
  ]);
  const run = page.getByRole('button', { name: '批量处理 3 张' });
  await run.waitFor();
  assert.equal(await page.locator('.task').count(), 0);
  await page.getByLabel(/滤镜预设/).selectOption('grayscale');
  await page.getByRole('combobox', { name: /^旋转/ }).selectOption('cw90');
  const crop = page.getByRole('checkbox', { name: /启用裁剪/ });
  await crop.check();
  await page.getByRole('slider', { name: /^w\b/ }).fill('80');
  const format = page.getByRole('combobox', { name: '格式', exact: true });
  await format.selectOption('qoi');
  await run.click();
  await page.waitForFunction(() => document.querySelectorAll('.task.succeeded').length === 2 && document.querySelectorAll('.task.failed').length === 1);

  async function download(task, extension) {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      task.getByRole('button', { name: '保存', exact: true }).click(),
    ]);
    assert.equal(file.suggestedFilename().split('.').pop(), extension);
    return readFile(await file.path());
  }

  const qoi = await download(page.locator('.task.succeeded').first(), 'qoi');
  assert.equal(qoi.toString('ascii', 0, 4), 'qoif');
  assert.equal(qoi.readUInt32BE(4), 300);
  assert.equal(qoi.readUInt32BE(8), 320); // 400px × 80% crop width
  await input.setInputFiles({ name: 'converted.qoi', mimeType: 'image/qoi', buffer: qoi });
  await page.locator('.source-details').getByText('QOI', { exact: true }).waitFor();
  await format.selectOption('ico');
  await page.getByLabel(/缩放/).fill('50');
  await page.getByRole('button', { name: '开始处理' }).click();
  const ico = await download(page.locator('.task.succeeded').filter({ hasText: 'converted.qoi' }), 'ico');
  assert.deepEqual([...ico.subarray(0, 8)], [0, 0, 1, 0, 1, 0, 160, 120]); // crop 80% then scale 50%
  await format.selectOption('jpeg');
  await page.getByLabel(/^预设/).selectOption('compact');
  assert.equal(await page.getByRole('slider', { name: /质量/ }).inputValue(), '68');
  assert.deepEqual(errors, []);
  console.log('Batch: 2 successes, 1 failure. QOI 300×320 reimported to ICO 160×120. JPEG preset 68.');
} finally {
  await browser.close();
}
