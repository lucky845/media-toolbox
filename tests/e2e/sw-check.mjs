import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4173/#/help', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const reg = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const r = await navigator.serviceWorker.getRegistration();
  return { supported: true, hasReg: !!r, state: r?.active?.state ?? null, controller: !!navigator.serviceWorker.controller };
});
console.log(JSON.stringify(reg));
const offlineText = await page.locator('main').innerText();
const m = offlineText.match(/离线\s*\n?\s*(\S[^\n]*)/);
console.log('UI 显示的离线描述:', m ? m[1] : '(未找到)');
await browser.close();
