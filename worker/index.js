// Telegram bot for the trades journal.
// Messages become trades in the same private GitHub Gist the web app syncs with,
// so they appear in the journal on its next sync. The static site itself is served
// by Cloudflare from dist/; only /tg/* requests reach this code.
//
// Secrets (Cloudflare → the Worker → Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN  token from @BotFather
//   GITHUB_TOKEN        GitHub token with Gists: Read and write (the one the journal uses)
//   TELEGRAM_OWNER_ID   your Telegram user id; the bot tells it on /start
//   TIMEZONE            optional, e.g. Europe/Moscow; trade times are written in it

const GIST_FILE = 'trades-tracker.json';
const CURRENCY_SIGNS = { USD: '$', USDT: 'USDT', EUR: '€', RUB: '₽' };
const DEFAULT_TZ = 'Europe/Moscow';

const SIDE_WORDS = {
  long: 'long', лонг: 'long', buy: 'long', купил: 'long', купить: 'long', покупка: 'long',
  short: 'short', шорт: 'short', sell: 'short', продал: 'short', продать: 'short', продажа: 'short',
};
const CLOSE_WORDS = new Set(['close', 'exit', 'закрыть', 'закрой', 'закрыл', 'закрыла', 'выход', 'выйти', 'вышел']);
const KEYS = {
  stop: ['stop', 'sl', 'стоп', 'сл'],
  target: ['tp', 'take', 'target', 'тейк', 'тп', 'цель'],
  fees: ['fee', 'fees', 'ком', 'комиссия', 'комиссии'],
};

const HELP = [
  'Записываю сделки в журнал. Примеры:',
  '',
  'long BTC 64000 0.1 стоп 63000 тейк 66000 #FOMO',
  'шорт ETH 2600 1.5 sl 2650 tp 2500',
  'закрыть BTC 65000 — закрыть позицию целиком',
  'закрыть BTC 65000 0.05 — закрыть часть',
  '',
  'Сначала направление, тикер, цена входа и объём. Стоп, тейк и комиссия по желанию, #слова становятся метками.',
  '',
  '/open — открытые позиции',
  '/today — результат за сегодня',
  '/stats — общая статистика',
  '/undo — удалить последнюю сделку, записанную ботом',
].join('\n');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/tg/webhook' && request.method === 'POST') return handleWebhook(request, env);
    if (url.pathname === '/tg/setup') return setup(url, env);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};

// ---------- Telegram ----------

// The webhook secret is derived from the bot token, so no extra secret has to be configured.
async function webhookSecret(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`trades-tracker:${token}`));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false }));
}

const reply = (env, chatId, text) => telegram(env, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });

async function setup(url, env) {
  const lines = [];
  const missing = ['TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN'].filter((k) => !env[k]);
  if (missing.length) {
    lines.push(`Не заданы секреты: ${missing.join(', ')}.`, 'Добавьте их в Cloudflare: Workers & Pages → trades-tracker → Settings → Variables and Secrets, затем откройте эту страницу снова.');
    return page(lines, 500);
  }
  const hook = `${url.origin}/tg/webhook`;
  const set = await telegram(env, 'setWebhook', {
    url: hook,
    secret_token: await webhookSecret(env.TELEGRAM_BOT_TOKEN),
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  if (!set.ok) {
    lines.push(`Telegram не принял настройку: ${set.description || 'неизвестная ошибка'}.`, 'Проверьте, что в TELEGRAM_BOT_TOKEN лежит токен от @BotFather целиком.');
    return page(lines, 502);
  }
  await telegram(env, 'setMyCommands', {
    commands: [
      { command: 'open', description: 'Открытые позиции' },
      { command: 'today', description: 'Результат за сегодня' },
      { command: 'stats', description: 'Общая статистика' },
      { command: 'undo', description: 'Удалить последнюю сделку бота' },
      { command: 'help', description: 'Как записывать сделки' },
    ],
  });
  const me = await telegram(env, 'getMe', {});
  lines.push(`Бот подключён${me.ok ? `: @${me.result.username}` : ''}.`);
  lines.push(env.TELEGRAM_OWNER_ID
    ? 'Владелец задан, можно писать сделки боту.'
    : 'Осталось указать владельца: напишите боту /start, он пришлёт ваш ID. Добавьте его в секрет TELEGRAM_OWNER_ID.');
  return page(lines, 200);
}

function page(lines, status) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram-бот журнала</title><body style="font:16px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h1 style="font-size:20px">Telegram-бот журнала</h1>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}</body>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handleWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env.TELEGRAM_BOT_TOKEN)) {
    return new Response('Forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.text || !msg.from) return new Response('ok');
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  try {
    if (!env.TELEGRAM_OWNER_ID) {
      await reply(env, chatId, `Ваш Telegram ID: ${msg.from.id}\n\nДобавьте его в Cloudflare как секрет TELEGRAM_OWNER_ID, и бот начнёт записывать ваши сделки. До этого он никому ничего не записывает.`);
    } else if (String(msg.from.id) !== String(env.TELEGRAM_OWNER_ID).trim()) {
      await reply(env, chatId, 'Это личный бот журнала сделок.');
    } else {
      await reply(env, chatId, await answer(env, text));
    }
  } catch (e) {
    await reply(env, chatId, e instanceof BotError ? e.message : 'Что-то пошло не так. Попробуйте ещё раз чуть позже.');
  }
  // Telegram retries on errors, so the webhook always answers 200.
  return new Response('ok');
}

class BotError extends Error {}

async function answer(env, text) {
  const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  if (command === '/start' || command === '/help' || command === 'помощь') return HELP;
  if (command === '/open') return openPositions(await loadJournal(env));
  if (command === '/today') return todayReport(env, await loadJournal(env));
  if (command === '/stats') return statsReport(await loadJournal(env));
  if (command === '/undo' || command === 'отмена') return undoLast(env);

  const close = parseClose(text);
  if (close) return closeTrade(env, close);
  const open = parseOpen(text);
  if (open) return openTrade(env, open);
  return 'Не понял сообщение. Пример: long BTC 64000 0.1 стоп 63000\n\n/help — все команды';
}

// ---------- Parsing ----------

function num(word) {
  if (word === undefined) return null;
  const s = String(word).replace(/\s/g, '').replace(/^[@x×]/i, '');
  const normalized = s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanSymbol(word) {
  return String(word || '').toUpperCase().replace(/[^A-Z0-9./_-]/g, '');
}

// "long BTC 64000 0.1 стоп 63000 тейк 66000 #FOMO заметка"
export function parseOpen(text) {
  const words = text.trim().split(/\s+/);
  const side = SIDE_WORDS[(words[0] || '').toLowerCase()];
  if (!side) return null;
  const symbol = cleanSymbol(words[1]);
  const entry = num(words[2]);
  const qty = num(words[3]);
  if (!symbol || entry === null || qty === null) {
    throw new BotError('Нужны тикер, цена входа и объём. Пример: long BTC 64000 0.1 стоп 63000');
  }
  const trade = { side, symbol, entry, qty, stop: null, target: null, fees: 0, tags: [], notes: [] };
  for (let i = 4; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase().replace(/[:=]$/, '');
    const key = Object.keys(KEYS).find((k) => KEYS[k].includes(lower));
    if (key && num(words[i + 1]) !== null) {
      trade[key] = num(words[i + 1]);
      i++;
    } else if (w.startsWith('#') && w.length > 1) {
      trade.tags.push(w.slice(1).replace(/_/g, ' '));
    } else {
      trade.notes.push(w);
    }
  }
  if (trade.stop !== null) {
    const wrong = side === 'long' ? trade.stop >= entry : trade.stop <= entry;
    if (wrong) throw new BotError(side === 'long' ? 'Для long стоп должен быть ниже цены входа.' : 'Для short стоп должен быть выше цены входа.');
  }
  return trade;
}

// "закрыть BTC 65000" or "закрыть BTC 65000 0.05"
export function parseClose(text) {
  const words = text.trim().split(/\s+/);
  if (!CLOSE_WORDS.has((words[0] || '').toLowerCase())) return null;
  const symbol = cleanSymbol(words[1]);
  const price = num(words[2]);
  if (!symbol || price === null) throw new BotError('Нужны тикер и цена выхода. Пример: закрыть BTC 65000');
  return { symbol, price, qty: num(words[3]) };
}

// ---------- Journal in the gist ----------

async function gh(env, path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trades-tracker-bot',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new BotError('GitHub не принял GITHUB_TOKEN: он неверный или истёк. Обновите секрет в Cloudflare.');
  if (!res.ok) throw new BotError(`GitHub ответил ошибкой ${res.status}. Проверьте, что у токена есть право Gists: Read and write.`);
  return res.json();
}

async function findGist(env) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(env, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[GIST_FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  throw new BotError('Не нашёл журнал в GitHub. Откройте журнал на сайте и подключите синхронизацию с тем же токеном, что и в GITHUB_TOKEN.');
}

export async function loadJournal(env) {
  const id = await findGist(env);
  const gist = await gh(env, `/gists/${id}`);
  const file = gist.files[GIST_FILE];
  let text = file.content;
  if (file.truncated) text = await (await fetch(file.raw_url)).text();
  const doc = JSON.parse(text);
  doc.trades = Array.isArray(doc.trades) ? doc.trades : [];
  doc.deleted = doc.deleted && typeof doc.deleted === 'object' ? doc.deleted : {};
  return { id, doc };
}

async function saveJournal(env, { id, doc }) {
  await gh(env, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(doc) } } }) });
}

// ---------- Trade math (same rules as the web app) ----------

const exitsOf = (t) => (Array.isArray(t.exits) ? t.exits : []);
const isClosed = (t) => t.exit !== null && t.exit !== undefined;

function pnlOf(t) {
  const dir = t.side === 'short' ? -1 : 1;
  return (t.exit - t.entry) * t.qty * dir - (t.fees || 0);
}

function rOf(t) {
  const stop = t.initialStop ?? t.stop;
  return stop ? pnlOf(t) / (Math.abs(t.entry - stop) * t.qty) : null;
}

function applyExits(t) {
  const parts = exitsOf(t);
  const q = parts.reduce((a, x) => a + x.qty, 0);
  if (q >= t.qty * (1 - 1e-9)) {
    t.exit = +(parts.reduce((a, x) => a + x.price * x.qty, 0) / q).toPrecision(12);
    t.closedAt = parts.map((x) => x.at).sort().pop();
  }
  return t;
}

function localNow(env) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const nf = (v, max = 8) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: max }).format(v);
function money(doc, v) {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v))} ${CURRENCY_SIGNS[doc.currency] || '$'}`;
}

function matches(t, symbol) {
  const s = t.symbol.toUpperCase();
  return s === symbol || s.replace(/[^A-Z0-9]/g, '') === symbol.replace(/[^A-Z0-9]/g, '') || s.startsWith(symbol);
}

// ---------- Actions ----------

async function openTrade(env, p) {
  const journal = await loadJournal(env);
  const now = Date.now();
  const trade = {
    id: `tg_${now.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`,
    symbol: p.symbol,
    market: 'Крипто',
    side: p.side,
    openedAt: localNow(env),
    closedAt: '',
    entry: p.entry,
    exit: null,
    qty: p.qty,
    fees: p.fees,
    stop: p.stop,
    target: p.target,
    setup: '',
    notes: p.notes.join(' '),
    images: [],
    tags: p.tags,
    rating: null,
    exits: [],
    initialStop: null,
    updatedAt: now,
  };
  journal.doc.trades.push(trade);
  await saveJournal(env, journal);
  const risk = p.stop ? Math.abs(p.entry - p.stop) * p.qty : null;
  return [
    `Записал: ${p.side === 'long' ? 'Long' : 'Short'} ${p.symbol} ${nf(p.qty)} по ${nf(p.entry)}`,
    p.stop ? `Стоп ${nf(p.stop)} · риск ${money(journal.doc, -risk)}` : 'Без стопа',
    p.target ? `Тейк ${nf(p.target)}` : '',
    p.tags.length ? `Метки: ${p.tags.join(', ')}` : '',
    'В журнале появится после синхронизации.',
  ].filter(Boolean).join('\n');
}

async function closeTrade(env, p) {
  const journal = await loadJournal(env);
  const open = journal.doc.trades.filter((t) => !isClosed(t) && matches(t, p.symbol))
    .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
  if (!open.length) throw new BotError(`Нет открытой позиции по ${p.symbol}. /open — список открытых.`);
  const t = open[0];
  const remaining = t.qty - exitsOf(t).reduce((a, x) => a + x.qty, 0);
  const qty = p.qty ?? remaining;
  if (qty > remaining * (1 + 1e-9)) throw new BotError(`Закрыть можно не больше ${nf(remaining)}.`);
  const at = localNow(env);
  const full = qty >= remaining * (1 - 1e-9);
  if (full && !exitsOf(t).length) {
    t.exit = p.price;
    t.closedAt = at;
  } else {
    t.exits = [...exitsOf(t), { price: p.price, qty: full ? remaining : qty, at }];
    applyExits(t);
  }
  t.updatedAt = Date.now();
  await saveJournal(env, journal);
  const dir = t.side === 'short' ? -1 : 1;
  if (!full) {
    return `Закрыл часть ${t.symbol}: ${nf(qty)} по ${nf(p.price)}, зафиксировано ${money(journal.doc, (p.price - t.entry) * qty * dir)}.\nОсталось ${nf(remaining - qty)}.`;
  }
  const r = rOf(t);
  return `Закрыл ${t.symbol} по ${nf(t.exit)}: ${money(journal.doc, pnlOf(t))}${r !== null ? ` (${r > 0 ? '+' : ''}${nf(r, 2)}R)` : ''}.`;
}

function openPositions({ doc }) {
  const open = doc.trades.filter((t) => !isClosed(t));
  if (!open.length) return 'Открытых позиций нет.';
  return ['Открытые позиции:', ...open.map((t) => {
    const closedPart = exitsOf(t).reduce((a, x) => a + x.qty, 0);
    return `• ${t.side === 'long' ? 'Long' : 'Short'} ${t.symbol} ${nf(t.qty - closedPart)} по ${nf(t.entry)}${t.stop ? ` · стоп ${nf(t.stop)}` : ''}${t.target ? ` · тейк ${nf(t.target)}` : ''}`;
  })].join('\n');
}

function todayReport(env, { doc }) {
  const today = localNow(env).slice(0, 10);
  const closed = doc.trades.filter((t) => isClosed(t) && String(t.closedAt).slice(0, 10) === today);
  if (!closed.length) return 'Сегодня закрытых сделок нет.';
  const total = closed.reduce((a, t) => a + pnlOf(t), 0);
  return [`Сегодня: ${money(doc, total)} за ${closed.length} сд.`, ...closed.map((t) => `• ${t.symbol}: ${money(doc, pnlOf(t))}`)].join('\n');
}

function statsReport({ doc }) {
  const closed = doc.trades.filter(isClosed);
  if (!closed.length) return 'Закрытых сделок пока нет.';
  const pnls = closed.map(pnlOf);
  const wins = pnls.filter((v) => v > 0).length;
  const total = pnls.reduce((a, b) => a + b, 0);
  const open = doc.trades.length - closed.length;
  return `Сделок закрыто: ${closed.length}, открыто: ${open}\nЧистый P&L: ${money(doc, total)}\nВинрейт: ${nf((wins / closed.length) * 100, 1)}%`;
}

async function undoLast(env) {
  const journal = await loadJournal(env);
  // Bot trades carry a tg_ id, which survives the web app's sync (unknown fields would not).
  // The id also holds the creation time in ms, which tells apart trades opened within the same minute.
  const created = (t) => parseInt(String(t.id).slice(3, -4), 36) || 0;
  const mine = journal.doc.trades.filter((t) => String(t.id).startsWith('tg_')).sort((a, b) => created(b) - created(a));
  if (!mine.length) return 'Нет сделок, записанных ботом.';
  const t = mine[0];
  journal.doc.trades = journal.doc.trades.filter((x) => x.id !== t.id);
  journal.doc.deleted[t.id] = Date.now();
  await saveJournal(env, journal);
  return `Удалил ${t.side === 'long' ? 'Long' : 'Short'} ${t.symbol} ${nf(t.qty)} по ${nf(t.entry)}.`;
}
