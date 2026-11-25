import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0,300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));

await page.goto('http://localhost:4173/#/image', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.locator('input[type="file"]').setInputFiles('tests/fixtures/gradient.png');
await page.waitForTimeout(5000);
console.log('--- body after upload ---');
console.log((await page.locator('main').innerText()).slice(0, 800));
await browser.close();
