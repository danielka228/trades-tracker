// Smoke test: opens index.html in headless Chromium and walks through the main flows.
// Run with `npm test`. Set CHROMIUM_PATH to use an already installed Chromium.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = pathToFileURL(path.join(root, 'index.html')).href;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
let failed = false;

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`);
  }
}

async function open(viewport, colorScheme = 'light') {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(PAGE);
  return page;
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

await step('desktop: sample journal renders without horizontal scroll', async () => {
  const page = await open({ width: 1280, height: 900 });
  assert.equal(await page.locator('#rows tr').count(), 12);
  assert.ok(await page.locator('#equity').isVisible(), 'equity chart is visible');
  assert.ok((await page.locator('#calendar button[data-day]').count()) > 0, 'calendar has trading days');
  assert.equal(await noOverflow(page), 0);
});

await step('phone: layout fits 400px in dark theme', async () => {
  const page = await open({ width: 400, height: 850 }, 'dark');
  assert.equal(await noOverflow(page), 0);
});

await step('trade form: short with stop computes P&L, % and R', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnAdd');
  await page.fill('#tSymbol', 'btcusdt');
  await page.click('label[for=tSideShort]');
  await page.fill('#tEntry', '100');
  await page.fill('#tQty', '2');
  await page.fill('#tStop', '110');
  await page.fill('#tExit', '90');
  await page.fill('#tFees', '1');
  const preview = await page.textContent('#tradePreview');
  assert.match(preview, /\+19,00/);
  assert.match(preview, /\+9,50%/);
  assert.match(preview, /\+0,95R/);
  await page.click('#tradeForm button[type=submit]');
  assert.equal(await page.locator('#rows tr').count(), 1, 'first real trade replaces the examples');
  await page.reload();
  assert.equal(await page.locator('#rows tr').count(), 1, 'trade persists after reload');
});

await step('calendar: clicking a day filters the table', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.locator('#calendar button[data-day]').first().click();
  assert.ok(await page.locator('#dayChip').isVisible());
  const rows = await page.locator('#rows tr').count();
  assert.ok(rows >= 1 && rows < 12, `expected a day subset, got ${rows}`);
  await page.click('#dayChip');
  assert.equal(await page.locator('#rows tr').count(), 12);
});

await step('import: CSV with semicolons adds trades', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnClearSample');
  await page.click('#btnData');
  await page.fill('#dataText', 'symbol;side;openedAt;closedAt;entry;exit;qty\nAAPL;long;2026-10-01T10:00;2026-10-02T10:00;100;110;10\nTSLA;short;2026-10-03T10:00;;250;;2');
  await page.click('#btnImportAdd');
  assert.equal(await page.locator('#rows tr').count(), 2);
  assert.match(await page.textContent('#stats'), /\+100,00/);
});

await step('delete: in-page confirmation removes the trade', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.locator('#rows tr').first().locator('[data-action=delete]').click();
  await page.click('#confirmOk');
  assert.equal(await page.locator('#rows tr').count(), 11);
});

await step('quick close: open position closes by take-profit chip', async () => {
  const page = await open({ width: 1280, height: 900 });
  const openRows = page.locator('#rows tr', { has: page.locator('[data-action=close]') });
  const before = await openRows.count();
  assert.ok(before > 0, 'sample journal has open positions');
  await openRows.first().locator('[data-action=close]').click();
  await page.locator('#closeQuick .chip', { hasText: 'По тейку' }).click();
  assert.match(await page.textContent('#closePreview'), /\+/);
  await page.click('#closeForm button[type=submit]');
  assert.equal(await openRows.count(), before - 1);
  assert.match(await page.textContent('#toast'), /Позиция закрыта/);
});

await step('app manifest and icons are in place', async () => {
  const fs = await import('node:fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(root, icon.src)), `${icon.src} exists`);
  assert.ok(fs.existsSync(path.join(root, 'sw.js')));
});

await step('analytics: sides, streaks, weekday, hours and R charts render', async () => {
  const page = await open({ width: 1280, height: 900 });
  assert.equal(await page.locator('#analytics .an-card').count(), 6);
  const text = await page.textContent('#analytics');
  for (const part of ['Long', 'Short', 'Лучшая серия побед', 'В среднем', 'Медиана']) assert.ok(text.includes(part), `has ${part}`);
  assert.equal(await page.locator('#analytics .cols').nth(0).locator('.col').count(), 7);
  assert.equal(await page.locator('#analytics .cols').nth(1).locator('.col').count(), 24);
  await page.selectOption('#fSide', 'short');
  assert.match(await page.textContent('#analytics .breakdown li:nth-child(1) .meta'), /нет сделок/);
});

await step('risk: balance, position size by stop and daily loss limit', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnClearSample');
  await page.click('#account [data-account]');
  await page.fill('#aBalance', '10000');
  await page.fill('#aRisk', '1');
  await page.fill('#aDaily', '2');
  await page.click('#accountForm button[type=submit]');
  assert.match(await page.textContent('#account'), /10\s000,00/);

  // 1% of 10 000 = 100; stop 5 below entry -> 20 units
  await page.click('#btnAdd');
  await page.fill('#tSymbol', 'eth');
  await page.fill('#tEntry', '100');
  await page.fill('#tStop', '95');
  assert.match(await page.textContent('#tradeSizer'), /20/);
  await page.click('#tradeSizer [data-qty]');
  assert.equal(await page.inputValue('#tQty'), '20');
  // close today at a 250 loss: beyond the 2% (200) daily limit
  await page.fill('#tExit', '87.5');
  await page.click('#tradeForm button[type=submit]');
  assert.ok(await page.locator('#riskNotice.danger').isVisible(), 'daily limit notice shows');
  assert.match(await page.textContent('#account'), /9\s750,00/);
});

await step('no script errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
process.exit(failed ? 1 : 0);
