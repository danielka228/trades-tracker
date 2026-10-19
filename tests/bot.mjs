// Tests for the Telegram bot Worker: Telegram and GitHub are replaced with in-memory fakes.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

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

const OWNER = 111;
const env = { TELEGRAM_BOT_TOKEN: '123:abc', GITHUB_TOKEN: 'gh-token', TELEGRAM_OWNER_ID: String(OWNER), TIMEZONE: 'UTC' };
const sent = [];
const gist = { id: 'g1', doc: { app: 'trades-tracker', version: 1, currency: 'USD', trades: [], deleted: {} } };

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.host === 'api.telegram.org') {
    const method = url.pathname.split('/').pop();
    if (method === 'sendMessage') sent.push(body);
    if (method === 'getMe') return json(200, { ok: true, result: { username: 'journal_bot' } });
    return json(200, { ok: true, result: true });
  }
  if (url.host === 'api.github.com') {
    if (init.headers.Authorization !== `Bearer ${env.GITHUB_TOKEN}`) return json(401, {});
    if (url.pathname === '/gists') return json(200, [{ id: gist.id, files: { 'trades-tracker.json': {} } }]);
    if (url.pathname === `/gists/${gist.id}` && (init.method || 'GET') === 'GET') {
      return json(200, { id: gist.id, files: { 'trades-tracker.json': { content: JSON.stringify(gist.doc), truncated: false } } });
    }
    if (url.pathname === `/gists/${gist.id}` && init.method === 'PATCH') {
      gist.doc = JSON.parse(body.files['trades-tracker.json'].content);
      return json(200, { id: gist.id });
    }
  }
  return json(404, {});
};

async function secret() {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`trades-tracker:${env.TELEGRAM_BOT_TOKEN}`));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function say(text, { from = OWNER, envOverride = env, withSecret = true } = {}) {
  sent.length = 0;
  const headers = { 'Content-Type': 'application/json' };
  if (withSecret) headers['X-Telegram-Bot-Api-Secret-Token'] = await secret();
  const res = await worker.fetch(new Request('https://trades.example.dev/tg/webhook', {
    method: 'POST', headers, body: JSON.stringify({ message: { text, from: { id: from }, chat: { id: from } } }),
  }), envOverride);
  return { status: res.status, text: sent.map((m) => m.text).join('\n') };
}

await step('setup registers the webhook and reports the bot name', async () => {
  const res = await worker.fetch(new Request('https://trades.example.dev/tg/setup'), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Бот подключён: @journal_bot/);
  const bare = await worker.fetch(new Request('https://trades.example.dev/tg/setup'), {});
  assert.equal(bare.status, 500, 'missing secrets are reported');
});

await step('webhook rejects requests without the Telegram secret header', async () => {
  const r = await say('/start', { withSecret: false });
  assert.equal(r.status, 403);
  assert.equal(r.text, '');
});

await step('without an owner the bot only tells the sender their id', async () => {
  const r = await say('long BTC 64000 0.1', { envOverride: { ...env, TELEGRAM_OWNER_ID: '' } });
  assert.match(r.text, /Ваш Telegram ID: 111/);
  assert.equal(gist.doc.trades.length, 0);
});

await step('strangers get no access', async () => {
  const r = await say('long BTC 64000 0.1', { from: 999 });
  assert.match(r.text, /личный бот/);
  assert.equal(gist.doc.trades.length, 0);
});

await step('open: a long with stop, target, tag and note lands in the gist', async () => {
  const r = await say('long BTC 64000 0,1 стоп 63000 тейк 66000 #FOMO после новостей');
  assert.match(r.text, /Записал: Long BTC 0,1 по 64\s000/);
  assert.match(r.text, /риск −100,00 \$/);
  const t = gist.doc.trades[0];
  assert.equal(t.side, 'long');
  assert.equal(t.entry, 64000);
  assert.equal(t.qty, 0.1);
  assert.equal(t.stop, 63000);
  assert.equal(t.target, 66000);
  assert.deepEqual(t.tags, ['FOMO']);
  assert.equal(t.notes, 'после новостей');
  assert.match(t.id, /^tg_/);
  assert.match(t.openedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

await step('open: a stop on the wrong side is refused', async () => {
  const r = await say('шорт ETH 2600 1 стоп 2500');
  assert.match(r.text, /стоп должен быть выше/);
  assert.equal(gist.doc.trades.length, 1);
});

await step('close: part, then the rest, at an average price with R', async () => {
  let r = await say('закрыть btc 65000 0.04');
  assert.match(r.text, /Закрыл часть BTC: 0,04 по 65\s000, зафиксировано \+40,00 \$/);
  assert.match(r.text, /Осталось 0,06/);
  r = await say('закрыть btc 66000');
  // avg exit (65000*0.04 + 66000*0.06) / 0.1 = 65600 -> +160, R = 160 / 100 = 1.6
  assert.match(r.text, /Закрыл BTC по 65\s600: \+160,00 \$ \(\+1,6R\)/);
  const t = gist.doc.trades[0];
  assert.equal(t.exit, 65600);
  assert.equal(t.exits.length, 2);
});

await step('reports: /open, /today and /stats', async () => {
  await say('short ETH 2600 1.5 sl 2650');
  assert.match((await say('/open')).text, /Short ETH 1,5 по 2\s600 · стоп 2\s650/);
  assert.match((await say('/today')).text, /Сегодня: \+160,00 \$ за 1/);
  assert.match((await say('/stats')).text, /Чистый P&L: \+160,00 \$\nВинрейт: 100%/);
});

await step('undo removes the latest bot trade and leaves a tombstone for sync', async () => {
  const r = await say('/undo');
  assert.match(r.text, /Удалил Short ETH/);
  assert.equal(gist.doc.trades.length, 1);
  assert.ok(Object.keys(gist.doc.deleted).some((id) => id.startsWith('tg_')));
});

await step('unknown text gets a hint, other fields of the journal are kept', async () => {
  gist.doc.account = { balance: 10000, riskPct: 1, dailyLossPct: 3 };
  assert.match((await say('привет')).text, /Не понял сообщение/);
  await say('long SOL 150 2');
  assert.deepEqual(gist.doc.account, { balance: 10000, riskPct: 1, dailyLossPct: 3 });
  assert.equal(gist.doc.currency, 'USD');
});

await step('other paths fall through to the static site', async () => {
  const res = await worker.fetch(new Request('https://trades.example.dev/anything'), { ASSETS: { fetch: () => new Response('site') } });
  assert.equal(await res.text(), 'site');
});

process.exit(failed ? 1 : 0);
