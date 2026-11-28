import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/#/image`);
  // Generate a real JPEG instead of renaming a PNG fixture. Gradients exercise GIF palette quantization.
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 800, 600);
    gradient.addColorStop(0, 'red');
    gradient.addColorStop(1, 'blue');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 800, 600);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'gradient.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64'),
  });
  const format = page.getByRole('combobox', { name: '格式', exact: true });
  // Capabilities must expose supported encoders, not the wider ImageFormat union (AVIF is not built).
  await page.waitForFunction(() => document.querySelectorAll('select[aria-labelledby="image-format-label"] option').length > 0);
  const formats = await format.locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(formats.includes('gif'));
  assert.ok(!formats.includes('avif'));
  await format.selectOption('ico');
  await page.getByText(/预计输出 800 × 600 像素/).waitFor();
  assert.equal(await page.getByRole('button', { name: '开始处理', exact: true }).isDisabled(), true);
  await format.selectOption('gif');
  const start = Date.now();
  await page.getByRole('button', { name: '开始处理', exact: true }).click();
  const completed = page.locator('.task.succeeded');
  await completed.waitFor({ timeout: 60000 });
  const elapsed = Date.now() - start;
  await completed.getByText('gradient.jpg', { exact: true }).waitFor();
  const outputLabel = completed.getByText(/^输出文件：/);
  const displayedName = (await outputLabel.innerText()).replace(/^输出文件：\s*/, '');
  assert.match(displayedName, /\.gif$/);
  const downloadEvent = page.waitForEvent('download');
  await completed.getByRole('button', { name: '保存', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), displayedName);
  const bytes = await readFile(await download.path());
  assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/);
  // A subsequent invalid source must surface as a failed queue item, not remain running indefinitely.
  const previousSuccesses = await page.locator('.task.succeeded').count();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a JPEG') },
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') },
  ]);
  await page.getByRole('button', { name: '批量处理 2 张', exact: true }).click();
  const failed = page.locator('.task.failed');
  await failed.waitFor({ timeout: 60000 });
  assert.match(await failed.innerText(), /broken\.jpg/);
  await failed.locator('.notice.danger').waitFor();
  assert.ok((await failed.locator('.notice.danger').innerText()).trim().length > 0, 'queue error must be visible');
  await page.waitForFunction(() => !document.querySelector('.task.running,.task.queued'), {}, { timeout: 60000 });
  assert.equal(await page.locator('.task.succeeded').count(), previousSuccesses + 1);
  assert.deepEqual(errors, []);
  console.log(`JPEG 800×600 → GIF: ${elapsed} ms, ${bytes.length} bytes, valid filename/signature; unsupported AVIF hidden; corrupt input error visible.`);
} finally {
  await browser.close();
}
