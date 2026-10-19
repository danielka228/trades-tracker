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

async function open(viewport, colorScheme = 'light', { binance } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  // Real prices would make results depend on the market, so Binance is either mocked or unreachable.
  await ctx.route(/binance\.com/, binance || ((route) => route.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Blocked or mocked network calls log 'Failed to load resource'; only real script errors count.
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
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
  assert.equal(await page.locator('#analytics .an-card').count(), 7);
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

const fixture = (name) => path.join(root, 'tests', 'fixtures', name);

async function importExchange(page, file) {
  await page.click('#btnData');
  await page.setInputFiles('#exFile', fixture(file));
  // The preview first says "Читаю файл…"; wait for the parsed result, not that placeholder.
  await page.waitForFunction(() => {
    const p = document.querySelector('#exPreview p');
    return p && !p.textContent.includes('Читаю');
  });
  return page.textContent('#exPreview');
}

await step('exchange import: Bybit closed P&L keeps the exchange result and skips duplicates', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnClearSample');
  assert.match(await importExchange(page, 'bybit-closed-pnl.csv'), /Bybit.*Новых сделок: 3/s);
  await page.click('#btnExAdd');
  assert.equal(await page.locator('#rows tr').count(), 3);
  const stats = await page.textContent('#stats');
  assert.match(stats, /\+16,20/, 'net P&L equals the sum of Closed P&L (9.3125 + 23.5288 - 16.6418)');
  const sides = await page.locator('#rows .pill.long, #rows .pill.short').allTextContents();
  assert.deepEqual(sides.sort(), ['Long', 'Long', 'Short']);
  assert.match(await importExchange(page, 'bybit-closed-pnl.csv'), /Новых сделок: 0.*уже есть в журнале: 3/s);
});

await step('exchange import: Binance futures fills are rebuilt into positions', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnClearSample');
  assert.match(await importExchange(page, 'binance-futures-trades.csv'), /Binance.*фьючерсы.*Новых сделок: 3.*открытых: 1/s);
  await page.click('#btnExAdd');
  const rows = (await page.locator('#rows tr').allTextContents()).map((r) => r.replace(/\s+/g, ' '));
  const btc = rows.find((r) => r.includes('BTCUSDT') && r.includes('61 000'));
  assert.ok(btc && btc.includes('60 250'), 'BTC long averages two buys at 60 250');
  assert.ok(rows.some((r) => r.includes('ETHUSDT') && r.includes('Short')), 'ETH short from sell then buy');
  assert.match(await page.textContent('#stats'), /\+7,60/, 'net = 2.806 + 4.794');
});

await step('exchange import: Binance spot skips sells without a matching buy', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnClearSample');
  const text = await importExchange(page, 'binance-spot-trades.csv');
  assert.match(text, /спот.*Новых сделок: 1.*пропущено строк: 1/s);
  await page.click('#btnExAdd');
  assert.match(await page.textContent('#stats'), /\+19,42/, 'SOL: 20 gross minus 0.28 + 0.3 fees');
});

await step('exchange import: unknown format lists the columns it found', async () => {
  const page = await open({ width: 1280, height: 900 });
  await page.click('#btnData');
  await page.setInputFiles('#exFile', { name: 'odd.csv', mimeType: 'text/csv', buffer: Buffer.from('Foo,Bar\n1,2\n') });
  await page.waitForFunction(() => /Нашлись колонки/.test(document.querySelector('#exPreview').textContent));
  assert.match(await page.textContent('#exPreview'), /Нашлись колонки: Foo, Bar/);
});

await step('tags: mistakes are tagged in the form, counted in analytics and searchable', async () => {
  const page = await open({ width: 1280, height: 900 });
  const card = page.locator('#analytics .an-card.wide');
  assert.match(await card.textContent(), /Месть рынку/, 'sample tags show in the mistakes card');
  await page.click('#btnClearSample');
  await page.click('#btnAdd');
  await page.fill('#tSymbol', 'btc');
  await page.fill('#tEntry', '100');
  await page.fill('#tQty', '1');
  await page.fill('#tExit', '90');
  await page.click('#tagChips [data-tag="FOMO"]');
  await page.fill('#tTagNew', 'Новости');
  await page.press('#tTagNew', 'Enter');
  await page.click('label[for=tRate2]');
  await page.click('#tradeForm button[type=submit]');
  assert.match(await page.textContent('#rows'), /FOMO · Новости/);
  const text = await card.textContent();
  assert.match(text, /FOMO/);
  assert.match(text, /оценка плана 2,0/);
  await page.click('#analytics [data-filter-tag="Новости"]');
  assert.equal(await page.inputValue('#fSearch'), 'Новости');
  assert.equal(await page.locator('#rows tr').count(), 1);
  // tags survive an edit round-trip
  await page.locator('#rows tr').first().locator('[data-action=edit]').click();
  assert.equal(await page.getAttribute('#tagChips [data-tag="FOMO"]', 'aria-pressed'), 'true');
  assert.ok(await page.isChecked('#tRate2'));
});

await step('live prices: open crypto positions show floating P&L, unknown tickers fall back to futures', async () => {
  const calls = [];
  const binance = (route) => {
    const url = new URL(route.request().url());
    calls.push(url.host + url.pathname + url.search);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    const symbols = url.searchParams.get('symbols');
    const symbol = url.searchParams.get('symbol');
    if (symbols) return JSON.parse(symbols).includes('FOOUSDT') ? json(400, { code: -1121 }) : json(200, JSON.parse(symbols).map((x) => ({ symbol: x, price: x === 'SOLUSDT' ? '155.5' : '1' })));
    if (symbol === 'SOLUSDT' && url.host === 'api.binance.com') return json(200, { symbol, price: '155.5' });
    if (symbol === 'FOOUSDT' && url.host === 'fapi.binance.com') return json(200, { symbol, price: '2' });
    return json(400, { code: -1121 });
  };
  const page = await open({ width: 1280, height: 900 }, 'light', { binance });
  const sol = page.locator('#rows tr', { hasText: 'SOLUSDT' }).filter({ has: page.locator('.pill.open') });
  await sol.locator('.live').first().waitFor();
  // SOL long 40 @ 151.6, fees 2.4: (155.5 - 151.6) * 40 - 2.4 = 153.6
  assert.match(await sol.textContent(), /≈ \+153,60/);
  assert.match(await sol.textContent(), /сейчас 155,50/);
  assert.match(await page.textContent('#account'), /Открытые сейчас/);
  const aapl = page.locator('#rows tr', { hasText: 'AAPL' }).filter({ has: page.locator('.pill.open') });
  assert.equal(await aapl.locator('.live').count(), 0, 'stocks get no crypto price');
  await sol.locator('[data-action=close]').click();
  assert.match(await page.textContent('#closeQuick'), /По рынку 155,50/);
  await page.keyboard.press('Escape');

  await page.click('#btnAdd');
  await page.fill('#tSymbol', 'foo');
  await page.selectOption('#tMarket', 'Крипто');
  await page.fill('#tEntry', '1');
  await page.fill('#tQty', '10');
  await page.click('#tradeForm button[type=submit]');
  const foo = page.locator('#rows tr', { hasText: 'FOO' });
  await foo.locator('.live').first().waitFor();
  assert.match(await foo.textContent(), /≈ \+10,00/, '(2 - 1) * 10 from the futures price');
  assert.ok(calls.some((c) => c.startsWith('fapi.binance.com')), 'falls back to futures');
});

await step('no script errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
process.exit(failed ? 1 : 0);
