import * as SH from '../public/shared.js';

const TG_API = 'https://api.telegram.org/bot';
const MONO = 'https://api.monobank.ua';
const DAILY_CRON = '0 19 * * *';
const WHO = ['me', 'gf'];
const enc = new TextEncoder();

/* ================= HTTP ================= */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/') || p.startsWith('/mono/') || p === '/tg' || p.startsWith('/r/')) await migrate(env).catch(e => console.log('migrate', e));
      if (p.startsWith('/api/')) return await api(req, env, ctx, url);
      if (p === '/tg' && req.method === 'POST') {
        if (req.headers.get('x-telegram-bot-api-secret-token') !== env.SECRET) return new Response('no', { status: 403 });
        const upd = await req.json();
        ctx.waitUntil(onUpdate(env, upd).catch(e => console.log('tg update error', e && e.stack || e)));
        return new Response('ok');
      }
      const mm = p.match(/^\/mono\/([a-f0-9]+)\/(me|gf)$/);
      if (mm) {
        if (mm[1] !== await hookKey(env)) return new Response('no', { status: 403 });
        if (req.method !== 'POST') return new Response('ok');
        const body = await req.json().catch(() => null);
        if (body && body.type === 'StatementItem' && body.data) ctx.waitUntil(onMonoItem(env, mm[2], body.data.account, body.data.statementItem).catch(e => console.log('mono hook error', e && e.stack || e)));
        return new Response('ok');
      }
      const rm = p.match(/^\/r\/(\d{4}-\d{2})\/(\d+)\/([a-f0-9]{32})$/);
      if (rm) return await reportFile(env, rm[1], +rm[2], rm[3], url.searchParams.has('dl'));
      if (p === '/setup') return await setup(env, url);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.log('fatal', e && e.stack || e);
      return json({ error: 'server', message: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    await migrate(env).catch(e => console.log('migrate', e));
    if (event.cron === DAILY_CRON) {
      await refreshRate(env).catch(e => console.log('rate', e));
      await dailySummaries(env).catch(e => console.log('daily', e));
    } else {
      await syncAll(env).catch(e => console.log('sync', e));
    }
  }
};

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);
const today = () => SH.kyivParts(Date.now()).date;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function rid() { const a = new Uint8Array(9); crypto.getRandomValues(a); return [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 14); }
function randKey(n = 24) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hookKey(env) { return (await sha(env.SECRET + ':mono')).slice(0, 24); }
async function inviteCode(env) { return (await sha(env.SECRET + ':invite')).slice(0, 16); }
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/* ================= DB ================= */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, ym TEXT NOT NULL, date TEXT NOT NULL, time TEXT DEFAULT '', amount REAL NOT NULL, orig REAL, cur TEXT DEFAULT 'UAH', who TEXT NOT NULL, cat TEXT NOT NULL, merchant TEXT DEFAULT '', note TEXT DEFAULT '', sep INTEGER DEFAULT 0, once INTEGER DEFAULT 0, ignored INTEGER DEFAULT 0, reason TEXT DEFAULT '', src TEXT DEFAULT 'manual', mcc INTEGER DEFAULT 0, account TEXT DEFAULT '', created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS tx_ym ON tx(ym)`,
  `CREATE TABLE IF NOT EXISTS people (who TEXT PRIMARY KEY, tg_id INTEGER, chat_id INTEGER, first_name TEXT, web_key TEXT, mono_token TEXT, mono_name TEXT, accounts TEXT DEFAULT '[]', last_call INTEGER DEFAULT 0, daily INTEGER DEFAULT 1)`,
  `INSERT OR IGNORE INTO people(who) VALUES ('me'),('gf')`
];
async function ensureSchema(env) { await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); migrated = false; await migrate(env); }
/* нові колонки додаються самі, один раз на запуск воркера */
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  const cols = (await env.DB.prepare('PRAGMA table_info(tx)').all()).results.map(r => r.name);
  if (cols.length && !cols.includes('info')) await env.DB.prepare("ALTER TABLE tx ADD COLUMN info TEXT DEFAULT ''").run();
  migrated = true;
}

async function kvGet(env, k) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function kvPut(env, k, v) { await env.DB.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run(); }
async function kvDel(env, k) { await env.DB.prepare('DELETE FROM kv WHERE k=?').bind(k).run(); }
const getCfg = async env => SH.normCfg(await kvGet(env, 'config'));
const putCfg = (env, c) => kvPut(env, 'config', c);
const getRules = async env => (await kvGet(env, 'rules')) || {};
async function learnRule(env, merchant, cat) {
  const k = SH.mkey(merchant); if (!k) return;
  const r = await getRules(env); if (r[k] === cat) return; r[k] = cat; await kvPut(env, 'rules', r);
}

async function person(env, who) { return await env.DB.prepare('SELECT * FROM people WHERE who=?').bind(who).first(); }
async function personByTg(env, tgId) { return await env.DB.prepare('SELECT * FROM people WHERE tg_id=?').bind(tgId).first(); }
async function allPeople(env) { return (await env.DB.prepare('SELECT * FROM people').all()).results; }
const accountsOf = p => { try { return JSON.parse(p.accounts || '[]'); } catch { return []; } };

const TX_COLS = ['id', 'ym', 'date', 'time', 'amount', 'orig', 'cur', 'who', 'cat', 'merchant', 'note', 'sep', 'once', 'ignored', 'reason', 'src', 'mcc', 'account', 'created', 'updated', 'info'];
function parseInfo(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } }
function rowToTx(r) { return r && Object.assign({}, r, { sep: !!r.sep, once: !!r.once, ignored: !!r.ignored, info: parseInfo(r.info) }); }
function txVals(t) { return TX_COLS.map(c => (c === 'sep' || c === 'once' || c === 'ignored') ? (t[c] ? 1 : 0) : c === 'info' ? (t.info && Object.keys(t.info).length ? JSON.stringify(t.info) : '') : (t[c] ?? null)); }
async function getTx(env, id) { return rowToTx(await env.DB.prepare('SELECT * FROM tx WHERE id=?').bind(id).first()); }
async function monthTxs(env, ym) { return (await env.DB.prepare('SELECT * FROM tx WHERE ym=? ORDER BY date DESC, time DESC, created DESC').bind(ym).all()).results.map(rowToTx); }
async function saveTx(env, t) {
  t.updated = Date.now(); t.ym = t.date.slice(0, 7);
  const q = `INSERT INTO tx(${TX_COLS.join(',')}) VALUES(${TX_COLS.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${TX_COLS.filter(c => c !== 'id' && c !== 'created').map(c => c + '=excluded.' + c).join(',')}`;
  await env.DB.prepare(q).bind(...txVals(t)).run();
  return t;
}
async function insertTxIfNew(env, t) {
  const q = `INSERT OR IGNORE INTO tx(${TX_COLS.join(',')}) VALUES(${TX_COLS.map(() => '?').join(',')})`;
  const r = await env.DB.prepare(q).bind(...txVals(t)).run();
  return r.meta && r.meta.changes > 0;
}

/* ================= AUTH ================= */
async function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', botToken);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (now() - (+params.get('auth_date') || 0) > 86400 * 30) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}
async function authWho(req, env) {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('tg ')) {
    const u = await verifyInitData(h.slice(3), env.BOT_TOKEN); if (!u) return null;
    const p = await personByTg(env, u.id); return p ? p.who : null;
  }
  if (h.startsWith('key ') && h.length > 20) {
    const p = await env.DB.prepare('SELECT who FROM people WHERE web_key=?').bind(h.slice(4)).first(); return p ? p.who : null;
  }
  return null;
}

/* ================= API ================= */
function cleanTx(b, who, prev) {
  const amount = SH.r2(SH.parseNum(b.amount));
  if (!(amount > 0)) throw userErr('Сума має бути більше нуля');
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw userErr('Невірна дата');
  const p = prev || {};
  return {
    id: p.id || (b.id && String(b.id).slice(0, 40)) || rid(), ym: date.slice(0, 7), date,
    time: String(b.time ?? p.time ?? '').slice(0, 8), amount, orig: SH.r2(SH.parseNum(b.orig ?? amount)), cur: b.cur === 'USD' ? 'USD' : 'UAH',
    who: b.who === 'gf' ? 'gf' : b.who === 'me' ? 'me' : who, cat: String(b.cat || 'other').slice(0, 40),
    merchant: String(b.merchant ?? '').slice(0, 120), note: String(b.note ?? '').slice(0, 200),
    sep: !!b.sep, once: !!b.once, ignored: !!b.ignored, reason: b.ignored ? (p.reason || '') : '',
    src: p.src || 'manual', mcc: p.mcc || 0, account: p.account || '', created: p.created || Date.now(), updated: Date.now(), info: p.info || {}
  };
}

async function api(req, env, ctx, url) {
  const who = await authWho(req, env);
  if (!who) return json({ error: 'auth' }, 401);
  try { return await apiRoutes(req, env, ctx, url, who); }
  catch (e) { if (e && e.user) return json({ error: e.message }, 400); throw e; }
}
const userErr = m => Object.assign(new Error(m), { user: true });

async function apiRoutes(req, env, ctx, url, who) {
  const path = url.pathname.slice(5);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (path === 'state') {
    const ym = /^\d{4}-\d{2}$/.test(url.searchParams.get('ym') || '') ? url.searchParams.get('ym') : today().slice(0, 7);
    const [cfg, txs, people, rules] = await Promise.all([getCfg(env), monthTxs(env, ym), allPeople(env), getRules(env)]);
    return json({
      self: who, ym, today: today(), cfg, txs, rulesCount: Object.keys(rules).length,
      bot: (await kvGet(env, 'bot')) || null,
      people: people.map(p => ({
        who: p.who, joined: !!p.tg_id, daily: !!p.daily, mono: p.mono_token ? { name: p.mono_name || '', lastCall: p.last_call || 0, accounts: accountsOf(p).map(a => ({ id: a.id, pan: a.pan, type: a.type, cur: a.cur, on: !!a.on, last: a.last || 0 })) } : null
      }))
    });
  }
  if (path === 'tx') {
    const prev = body.id ? await getTx(env, String(body.id)) : null;
    const t = cleanTx(body, who, prev);
    if (prev && prev.src === 'mono' && prev.cat !== t.cat) await learnRule(env, t.merchant, t.cat);
    await saveTx(env, t);
    return json({ tx: t });
  }
  if (path === 'tx/delete') { await env.DB.prepare('DELETE FROM tx WHERE id=?').bind(String(body.id || '')).run(); return json({ ok: true }); }
  if (path === 'tx/bulk') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 300).map(String);
    const patch = body.patch || {};
    for (const id of ids) {
      const t = await getTx(env, id); if (!t) continue;
      if ('once' in patch) { t.once = !!patch.once; if (!t.once) t.sep = false; }
      if ('ignored' in patch) { t.ignored = !!patch.ignored; t.reason = t.ignored ? (t.reason || 'manual') : ''; }
      if ('cat' in patch) t.cat = String(patch.cat);
      await saveTx(env, t);
    }
    return json({ ok: true, n: ids.length });
  }
  if (path === 'config') {
    const cur = await getCfg(env);
    const next = SH.normCfg(Object.assign({}, cur, body.cfg || {}, { months: cur.months }));
    await putCfg(env, next); return json({ cfg: next });
  }
  if (path === 'month') {
    const cfg = await getCfg(env); const ym = String(body.ym || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'ym' }, 400);
    const b = +body.budget || 0; if (b > 0) cfg.months[ym] = b; else delete cfg.months[ym];
    await putCfg(env, cfg); return json({ cfg });
  }
  if (path === 'rules/clear') { await kvPut(env, 'rules', {}); return json({ ok: true }); }
  if (path === 'me') {
    if ('daily' in body) await env.DB.prepare('UPDATE people SET daily=? WHERE who=?').bind(body.daily ? 1 : 0, who).run();
    return json({ ok: true });
  }
  if (path === 'weblink') {
    const key = randKey(20); await env.DB.prepare('UPDATE people SET web_key=? WHERE who=?').bind(key, who).run();
    return json({ url: (await origin(env, url)) + '/?k=' + key });
  }
  /* monobank: кожен може керувати і своїми картками, і картками партнера (поле for) */
  const forWho = WHO.includes(body.for) ? body.for : who;
  if (path === 'mono/connect') {
    const r = await connectMono(env, forWho, String(body.token || '').trim(), await origin(env, url));
    if (r.error) return json(r, 400);
    ctx.waitUntil(syncPerson(env, forWho, { report: true }).catch(e => console.log(e)));
    return json(r);
  }
  if (path === 'mono/accounts') {
    const p = await person(env, forWho); const on = new Set(body.on || []);
    const accs = accountsOf(p).map(a => Object.assign(a, { on: on.has(a.id) }));
    await env.DB.prepare('UPDATE people SET accounts=? WHERE who=?').bind(JSON.stringify(accs), forWho).run();
    return json({ ok: true });
  }
  if (path === 'mono/sync') return json(await syncPerson(env, forWho, { report: false, notify: false }));
  if (path === 'mono/disconnect') {
    await env.DB.prepare("UPDATE people SET mono_token=NULL, mono_name=NULL, accounts='[]' WHERE who=?").bind(forWho).run();
    return json({ ok: true });
  }
  if (path === 'report/link') {
    const ym = /^\d{4}-\d{2}$/.test(body.ym || '') ? body.ym : today().slice(0, 7);
    return json({ url: await reportUrl(env, url, ym), file: reportName(ym) });
  }
  if (path === 'report/send') {
    const ym = /^\d{4}-\d{2}$/.test(body.ym || '') ? body.ym : today().slice(0, 7);
    const p = await person(env, who); if (!p || !p.chat_id) throw userErr('Спершу напиши боту /start');
    const r = await sendReport(env, p.chat_id, ym);
    if (!r.ok) throw userErr('Telegram не прийняв файл: ' + (r.description || ''));
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

async function origin(env, url) {
  const o = await kvGet(env, 'origin');
  if (o) return o;
  return url ? url.origin : '';
}

/* ================= SETUP ================= */
async function setup(env, url) {
  if (!env.SECRET || url.searchParams.get('key') !== env.SECRET) return new Response('Потрібен ?key=SECRET', { status: 403 });
  await ensureSchema(env);
  const o = url.origin; await kvPut(env, 'origin', o);
  if (!(await kvGet(env, 'config'))) await putCfg(env, SH.normCfg(null));
  await refreshRate(env).catch(() => {});
  const me = await tg(env, 'getMe', {});
  const username = me.result && me.result.username;
  await kvPut(env, 'bot', { username });
  const wh = await tg(env, 'setWebhook', { url: o + '/tg', secret_token: env.SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  await tg(env, 'setMyCommands', { commands: [
    { command: 'status', description: 'Скільки лишилось' },
    { command: 'last', description: 'Останні витрати' },
    { command: 'cats', description: 'Категорії та ліміти' },
    { command: 'report', description: 'Звіт за місяць файлом' },
    { command: 'mono', description: 'Підключити monobank' },
    { command: 'sync', description: 'Підтягнути з mono зараз' },
    { command: 'budget', description: 'Бюджет на місяць' },
    { command: 'web', description: 'Посилання для браузера' },
    { command: 'help', description: 'Як користуватись' }
  ] });
  await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Бюджет', web_app: { url: o + '/' } } });
  const inv = await inviteCode(env);
  const link = username ? `https://t.me/${username}?start=${inv}` : '(бот не відповів, перевір BOT_TOKEN)';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Бюджет: налаштовано</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h2>${wh.ok ? '✅ Готово' : '⚠️ Telegram не прийняв вебхук'}</h2>
${wh.ok ? '' : `<p>${esc(wh.description || '')}</p>`}
<p>Посилання-запрошення (відкрий сам, потім перешли дівчині; працює лише для двох людей):</p>
<p><a href="${esc(link)}" style="word-break:break-all">${esc(link)}</a></p>
<p style="color:#667">Цю сторінку можна закрити. Повторно відкривати її безпечно.</p></body>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/* ================= MONOBANK ================= */
async function monoFetch(token, path, init = {}) {
  const r = await fetch(MONO + path, Object.assign({}, init, { headers: Object.assign({ 'X-Token': token, 'content-type': 'application/json' }, init.headers || {}) }));
  let data = null; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}
const ACC_TYPE = { black: 'Чорна', white: 'Біла', platinum: 'Platinum', iron: 'Iron', fop: 'ФОП', yellow: 'Дитяча', eAid: 'єПідтримка', madeInUkraine: 'Зроблено в Україні' };
export const accLabel = a => `${ACC_TYPE[a.type] || a.type || 'Картка'}${a.pan ? ' *' + a.pan : ''}${a.cur === 840 ? ' (USD)' : ''}`;

async function monoClientInfo(token) {
  if (!/^[A-Za-z0-9_\-]{30,80}$/.test(token)) return { error: 'Це не схоже на токен monobank. Скопіюй його повністю зі сторінки api.monobank.ua.' };
  const ci = await monoFetch(token, '/personal/client-info');
  if (ci.status === 429) return { error: 'monobank просить зачекати хвилину. Спробуй ще раз трохи пізніше.' };
  if (!ci.ok || !ci.data || !Array.isArray(ci.data.accounts)) return { error: 'monobank не прийняв токен. Перевір, що скопіював його повністю і що він не відкликаний.' };
  return ci;
}
async function connectMono(env, who, token, orig, ciPre) {
  const ci = ciPre || await monoClientInfo(token);
  if (ci.error) return ci;
  const p = await person(env, who); const prev = {}; accountsOf(p || {}).forEach(a => (prev[a.id] = a));
  const accounts = ci.data.accounts.filter(a => a.currencyCode === 980 || a.currencyCode === 840).map(a => ({
    id: a.id, type: a.type, cur: a.currencyCode, pan: String((a.maskedPan && a.maskedPan[0]) || '').slice(-4),
    on: prev[a.id] ? prev[a.id].on : (a.currencyCode === 980 && !['fop', 'yellow', 'eAid'].includes(a.type)), last: prev[a.id] ? prev[a.id].last || 0 : 0
  }));
  await env.DB.prepare('UPDATE people SET mono_token=?, mono_name=?, accounts=? WHERE who=?').bind(token, ci.data.name || '', JSON.stringify(accounts), who).run();
  const hook = `${orig}/mono/${await hookKey(env)}/${who}`;
  const wh = await monoFetch(token, '/personal/webhook', { method: 'POST', body: JSON.stringify({ webHookUrl: hook }) });
  return { ok: true, name: ci.data.name || '', accounts, webhook: wh.ok };
}

function kyivMonthStart(ts) {
  const k = SH.kyivParts(ts * 1000);
  return ts - ((+k.date.slice(8, 10) - 1) * 86400 + k.h * 3600 + k.mi * 60 + k.s);
}

/* Підтягує виписку одного рахунку (monobank дозволяє 1 запит на хвилину). */
async function syncPerson(env, who, opts = {}) {
  const p = await person(env, who);
  if (!p || !p.mono_token) return { error: 'nomono' };
  const accs = accountsOf(p); const on = accs.filter(a => a.on);
  if (!on.length) return { error: 'noacc' };
  const t = now();
  if (t - (p.last_call || 0) < 61) return { wait: 61 - (t - (p.last_call || 0)) };
  on.sort((a, b) => (a.last || 0) - (b.last || 0));
  const a = on[0];
  const initial = !a.last;
  const refill = !initial && !a.filled; /* разово перечитати місяць, щоб дописати деталі (валюта, кешбек, квитанція) */
  const from = initial || refill ? Math.max(kyivMonthStart(t), t - 31 * 86400 + 3600) : Math.max(a.last - 6 * 3600, t - 31 * 86400 + 3600);
  await env.DB.prepare('UPDATE people SET last_call=? WHERE who=?').bind(t, who).run();
  const r = await monoFetch(p.mono_token, `/personal/statement/${a.id}/${from}/${t}`);
  if (!r.ok || !Array.isArray(r.data)) return { error: 'mono', status: r.status };
  const [cfg, rules] = await Promise.all([getCfg(env), getRules(env)]);
  let added = 0;
  const items = r.data.slice().sort((x, y) => x.time - y.time);
  for (const it of items) {
    const notify = opts.notify !== false && !initial && it.time > t - 3 * 3600;
    added += await ingest(env, cfg, rules, who, a, it, { notify });
  }
  const fresh = accountsOf(await person(env, who));
  const me = fresh.find(x => x.id === a.id); if (me) { me.last = t; me.filled = true; }
  await env.DB.prepare('UPDATE people SET accounts=? WHERE who=?').bind(JSON.stringify(fresh), who).run();
  const left = on.filter(x => x.id !== a.id && !x.last).length;
  const rchat = opts.report && initial ? await chatFor(env, who) : null;
  if (rchat) {
    const cfg2 = await getCfg(env);
    await tg(env, 'sendMessage', { chat_id: rchat, parse_mode: 'HTML', text: `💳 ${p.chat_id ? '' : esc(SH.personName(cfg2, who)) + ' · '}${esc(accLabel(a))}: підтягнув ${added} ${SH.plural(added, 'витрату', 'витрати', 'витрат')}${initial ? ' з початку місяця' : ''}.${left ? `\nЩе ${left} ${SH.plural(left, 'картка', 'картки', 'карток')} підтягнуться протягом кількох хвилин (monobank дозволяє 1 запит на хвилину).` : ''}` });
  }
  return { added, account: accLabel(a), left };
}

async function syncAll(env) {
  const ps = (await allPeople(env)).filter(p => p.mono_token);
  for (const p of ps) await syncPerson(env, p.who, { report: true }).catch(e => console.log('sync', p.who, e));
}

async function onMonoItem(env, who, account, it) {
  if (!it || !account) return;
  const p = await person(env, who); if (!p || !p.mono_token) return;
  const a = accountsOf(p).find(x => x.id === account && x.on); if (!a) return;
  const [cfg, rules] = await Promise.all([getCfg(env), getRules(env)]);
  await ingest(env, cfg, rules, who, a, it, { notify: true });
}

async function ingest(env, cfg, rules, who, acc, it, opts) {
  if (!it || !(it.amount < 0)) return 0; /* надходження та повернення не рахуємо */
  const id = 'mono_' + it.id;
  const info = monoInfo(it, acc);
  const ex = await env.DB.prepare('SELECT info, cat, ignored, created, updated FROM tx WHERE id=?').bind(id).first();
  if (ex) {
    /* уже є: оновлюємо деталі (наприклад, «в обробці» → проведено),
       а категорію — лише якщо людина її не чіпала */
    const s = Object.keys(info).length ? JSON.stringify(info) : '';
    const untouched = !ex.ignored && Math.abs((ex.updated || 0) - (ex.created || 0)) < 5000;
    const sg2 = untouched ? SH.suggestCat(cfg, rules, String(it.description || '').replace(/\s+/g, ' ').trim(), it.mcc, who) : null;
    const newCat = sg2 && sg2.kind !== 'transfer' && sg2.cat !== ex.cat ? sg2.cat : null;
    if ((ex.info || '') !== s || newCat) await env.DB.prepare('UPDATE tx SET info=?, cat=? WHERE id=?').bind(s, newCat || ex.cat, id).run();
    return 0;
  }
  let amount = -it.amount / 100, orig = amount, cur = 'UAH';
  if (acc.cur === 840) { cur = 'USD'; amount = SH.r2(orig * cfg.usdRate); }
  const { date, time } = SH.kyivParts(it.time * 1000);
  const desc = String(it.description || '').replace(/\s+/g, ' ').trim();
  const sg = SH.suggestCat(cfg, rules, desc, it.mcc, who);
  let ignored = false, reason = '';
  if (sg.kind === 'transfer') { ignored = true; reason = 'transfer'; }
  else {
    const d0 = new Date(date + 'T12:00:00Z');
    const lo = new Date(+d0 - 864e5).toISOString().slice(0, 10), hi = new Date(+d0 + 864e5).toISOString().slice(0, 10);
    const dup = await env.DB.prepare("SELECT merchant, note, cat FROM tx WHERE who=? AND src!='mono' AND ignored=0 AND abs(amount-?)<0.01 AND date BETWEEN ? AND ? LIMIT 1").bind(who, SH.r2(amount), lo, hi).first();
    if (dup) { ignored = true; reason = 'dup:' + (dup.merchant || dup.note || SH.catOf(cfg, dup.cat).name); }
  }
  const tx = {
    id, ym: date.slice(0, 7), date, time, amount: SH.r2(amount), orig: SH.r2(orig), cur, who, cat: sg.cat,
    merchant: desc, note: String(it.comment || '').slice(0, 200), sep: !!SH.catOf(cfg, sg.cat).sep, once: false, ignored, reason,
    src: 'mono', mcc: it.mcc || 0, account: acc.pan || '', created: Date.now(), updated: Date.now(), info
  };
  if (!(await insertTxIfNew(env, tx))) return 0;
  if (opts.notify) await notifyTx(env, tx).catch(e => console.log('notify', e));
  return 1;
}

const CUR = { 980: '₴', 840: '$', 978: '€', 985: 'zł', 826: '£', 203: 'Kč', 348: 'Ft', 756: 'CHF', 949: '₺', 191: '€', 498: 'MDL', 946: 'RON' };
/* Усе корисне, що monobank дає про операцію */
function monoInfo(it, acc) {
  const i = {};
  if (it.currencyCode && it.currencyCode !== acc.cur && it.operationAmount) { i.op = Math.abs(it.operationAmount) / 100; i.opCur = CUR[it.currencyCode] || String(it.currencyCode); }
  if (it.cashbackAmount) i.cb = it.cashbackAmount / 100;
  if (it.commissionRate) i.fee = it.commissionRate / 100;
  if (it.hold) i.hold = 1;
  if (typeof it.balance === 'number') i.bal = it.balance / 100;
  if (it.receiptId) i.rcpt = String(it.receiptId).slice(0, 40);
  if (it.counterName) i.to = String(it.counterName).slice(0, 80);
  if (it.counterIban) i.iban = String(it.counterIban).slice(0, 34);
  if (it.counterEdrpou) i.edrpou = String(it.counterEdrpou).slice(0, 12);
  if (it.originalMcc && it.originalMcc !== it.mcc) i.omcc = it.originalMcc;
  if (acc.cur && acc.cur !== 980) i.accCur = CUR[acc.cur] || String(acc.cur);
  return i;
}

async function refreshRate(env) {
  const cfg = await getCfg(env); if (!cfg.rateAuto) return;
  const r = await fetch(MONO + '/bank/currency'); if (!r.ok) return;
  const list = await r.json();
  const u = list.find(x => x.currencyCodeA === 840 && x.currencyCodeB === 980);
  if (u && u.rateSell) { cfg.usdRate = SH.r2(u.rateSell); cfg.rateDate = today(); await putCfg(env, cfg); }
}

/* ================= ЗВІТ ================= */
const reportName = ym => `budget-${ym}.html`;
async function reportSig(env, ym, exp) { return hex(await hmac(env.SECRET, `r:${ym}:${exp}`)).slice(0, 32); }
async function reportUrl(env, url, ym) { const exp = now() + 3600; return `${await origin(env, url)}/r/${ym}/${exp}/${await reportSig(env, ym, exp)}`; }
function stampNow() { const k = SH.kyivParts(Date.now()); return `${k.date.split('-').reverse().join('.')}, ${k.time.slice(0, 5)}`; }
async function reportHTML(env, ym) { const { cfg, txs } = await monthState(env, ym); return SH.reportDoc(cfg, txs, ym, today(), stampNow()); }
async function reportFile(env, ym, exp, sig, dl) {
  if (exp < now() || sig !== await reportSig(env, ym, exp)) return new Response('Посилання застаріло. Сформуй звіт ще раз у застосунку.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (dl) h['content-disposition'] = `attachment; filename="${reportName(ym)}"`;
  return new Response(await reportHTML(env, ym), { headers: h });
}
async function sendReport(env, chatId, ym) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', `📄 Звіт · ${SH.ymLabel(ym)}\nВідкрий файл, щоб переглянути. Щоб зберегти PDF: «Поділитися» → «Друк» (або кнопка в самому звіті).`);
  fd.append('document', new Blob([await reportHTML(env, ym)], { type: 'text/html' }), reportName(ym));
  const r = await fetch(TG_API + env.BOT_TOKEN + '/sendDocument', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.log('tg sendDocument', j.description);
  return j;
}

/* ================= TELEGRAM ================= */
async function tg(env, method, body) {
  const r = await fetch(TG_API + env.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok && !/message is not modified/.test(j.description || '')) console.log('tg', method, j.description);
  return j;
}
const MAIN_KB = {
  keyboard: [[{ text: '📊 Залишок' }, { text: '📋 Останні' }], [{ text: '🗂 Категорії' }, { text: '💳 Mono' }]],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: '350 кафе · 1200 сільпо'
};
async function appButton(env) { return { inline_keyboard: [[{ text: '📱 Відкрити застосунок', web_app: { url: (await origin(env)) + '/' } }]] }; }

async function onUpdate(env, u) {
  if (u.callback_query) return onCallback(env, u.callback_query);
  const m = u.message; if (!m || !m.from || m.chat.type !== 'private') return;
  const text = String(m.text || '').trim();
  const p = await personByTg(env, m.from.id);
  const send = (t, extra = {}) => tg(env, 'sendMessage', Object.assign({ chat_id: m.chat.id, text: t, parse_mode: 'HTML', disable_web_page_preview: true }, extra));

  if (!p) {
    const code = (text.match(/^\/start\s+(\S+)/) || [])[1];
    if (code && code === await inviteCode(env)) {
      const free = (await allPeople(env)).filter(x => !x.tg_id);
      if (!free.length) return send('Обидва місця в цьому бюджеті вже зайняті.');
      const cfg = await getCfg(env);
      await kvPut(env, 'pending:' + m.from.id, 1);
      return send('Привіт! Це спільний бюджет на двох. Хто ти?', { reply_markup: { inline_keyboard: [free.map(x => ({ text: 'Я — ' + (x.who === 'gf' && cfg.people.gf.name === 'Дівчина' ? (m.from.first_name || 'Дівчина') + ' (вона)' : SH.personName(cfg, x.who)), callback_data: 'j:' + x.who }))] } });
    }
    return send('Це приватний бот для бюджету. Щоб приєднатися, відкрий посилання-запрошення.');
  }
  if (p.chat_id !== m.chat.id) await env.DB.prepare('UPDATE people SET chat_id=? WHERE who=?').bind(m.chat.id, p.who).run();
  const who = p.who;
  const cmd = (text.match(/^\/(\w+)/) || [])[1] || '';
  const arg = text.replace(/^\/\w+(@\w+)?\s*/, '');

  if (cmd === 'start' || cmd === 'help') return send(helpText(), { reply_markup: MAIN_KB }).then(async () => send('Повний застосунок відкривається кнопкою «Бюджет» біля поля вводу або тут:', { reply_markup: await appButton(env) }));
  if (cmd === 'status' || text === '📊 Залишок') return send(await statusText(env, who), { reply_markup: await appButton(env) });
  if (cmd === 'last' || text === '📋 Останні') return send(await lastText(env));
  if (cmd === 'cats' || text === '🗂 Категорії') return send(await catsText(env, who));
  if (cmd === 'web') {
    const key = randKey(20); await env.DB.prepare('UPDATE people SET web_key=? WHERE who=?').bind(key, who).run();
    return send(`🔗 Твоє особисте посилання для браузера на компʼютері чи телефоні:\n${esc((await origin(env)) + '/?k=' + key)}\n\nНікому його не пересилай. Нове /web вимикає старе посилання.`);
  }
  if (cmd === 'budget') {
    const cfg = await getCfg(env); const v = SH.parseNum(arg);
    if (v > 0) { cfg.defaultBudget = v; await putCfg(env, cfg); return send(`✅ Бюджет на місяць: <b>${SH.money(v)}</b>. Розплановано лімітами: ${SH.money(SH.planTotal(cfg))}.`); }
    return send(`Бюджет на місяць: <b>${SH.money(cfg.defaultBudget)}</b>.\nЗмінити: <code>/budget 44000</code>`);
  }
  if (cmd === 'rate') {
    const cfg = await getCfg(env);
    if (/^auto|авто/i.test(arg)) { cfg.rateAuto = true; await putCfg(env, cfg); await refreshRate(env); const c2 = await getCfg(env); return send(`Курс береться з monobank автоматично: ${SH.rateFmt(c2.usdRate)} ₴/$.`); }
    const v = SH.parseNum(arg); if (v > 0) { cfg.usdRate = v; cfg.rateAuto = false; await putCfg(env, cfg); return send(`Курс зафіксовано: ${SH.rateFmt(v)} ₴/$. Повернути авто: /rate auto`); }
    return send(`Курс: ${SH.rateFmt(cfg.usdRate)} ₴/$ (${cfg.rateAuto ? 'автоматично з monobank' : 'вручну'}).\n<code>/rate 41.5</code> або <code>/rate auto</code>`);
  }
  if (cmd === 'daily') {
    const on = !/off|ні|вимк/i.test(arg); await env.DB.prepare('UPDATE people SET daily=? WHERE who=?').bind(on ? 1 : 0, who).run();
    return send(on ? '🌙 Щовечора о 21:00 надсилатиму підсумок дня.' : 'Вечірні підсумки вимкнено. Увімкнути: /daily on');
  }
  if (cmd === 'report') {
    const ym = /^\d{4}-\d{2}$/.test(arg) ? arg : today().slice(0, 7);
    const r = await sendReport(env, m.chat.id, ym);
    return r.ok ? null : send('Не вдалося надіслати звіт. Спробуй ще раз.');
  }
  if (cmd === 'sync') {
    const r = await syncPerson(env, who, { report: false, notify: false });
    if (r.error === 'nomono') return send('monobank ще не підключено. Натисни «💳 Mono».');
    if (r.error === 'noacc') return send('Не вибрано жодної картки. Натисни «💳 Mono».');
    if (r.wait) return send(`monobank дозволяє 1 запит на хвилину. Спробуй через ${r.wait} с.`);
    if (r.error) return send('monobank не відповів (' + (r.status || '?') + '). Спробую сам за кілька хвилин.');
    return send(`💳 ${esc(r.account)}: нових витрат ${r.added}.${r.left ? `\nЩе ${r.left} ${SH.plural(r.left, 'картка', 'картки', 'карток')} в черзі.` : ''}`);
  }
  if (cmd === 'mono' || text === '💳 Mono' || /^[A-Za-z0-9_\-]{40,60}$/.test(text)) {
    const token = cmd === 'mono' ? arg.trim() : (text === '💳 Mono' ? '' : text);
    if (!token) return send(await monoStatusText(env, who), { reply_markup: await monoKb(env, who) });
    await tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id });
    const ci = await monoClientInfo(token);
    if (ci.error) return send('⚠️ ' + esc(ci.error));
    const mate = await person(env, other(who)); const cfg = await getCfg(env);
    const name = ci.data.name || '';
    /* чий це токен: свій чи партнера? Не перезаписуємо мовчки. */
    let target = null;
    if (name && p.mono_name && name === p.mono_name) target = who;
    else if (name && mate.mono_name && name === mate.mono_name) target = other(who);
    else if (!p.mono_token && mate.mono_token) target = who;
    if (!target) {
      await kvPut(env, 'tok:' + m.from.id, { token, ci, t: now() });
      return send(`Чий це monobank${name ? ` (<b>${esc(name)}</b>)` : ''}?`, { reply_markup: { inline_keyboard: [[{ text: 'Мій', callback_data: 'mt:' + who }, { text: SH.personName(cfg, other(who)), callback_data: 'mt:' + other(who) }]] } });
    }
    return finishMono(env, m.chat.id, target, token, ci, who);
  }
  if (cmd) return send('Не знаю такої команди. /help');

  const q = SH.parseQuick(text);
  if (!q) return send('Напиши суму і що це, наприклад:\n<code>350 кафе</code>\n<code>1200 сільпо</code>\n<code>6000 дім разова</code>\n\nАбо відкрий застосунок кнопкою «Бюджет».');
  const [cfg, rules] = await Promise.all([getCfg(env), getRules(env)]);
  const cat = SH.guessCat(cfg, rules, q.text, who) || 'other';
  const t = {
    id: rid(), date: today(), time: SH.kyivParts(Date.now()).time, amount: SH.r2(q.cur === 'USD' ? q.amount * cfg.usdRate : q.amount), orig: q.amount, cur: q.cur,
    who, cat, merchant: q.text ? q.text[0].toUpperCase() + q.text.slice(1) : '', note: '', sep: q.sep || SH.catOf(cfg, cat).sep, once: q.once, ignored: false, reason: '',
    src: 'tg', mcc: 0, account: '', created: Date.now()
  };
  await saveTx(env, t);
  return send(await txCard(env, t, cfg), { reply_markup: txKb(t, cfg) });
}

const other = w => (w === 'gf' ? 'me' : 'gf');
async function finishMono(env, chatId, target, token, ci, sender) {
  const r = await connectMono(env, target, token, await origin(env), ci);
  if (r.error) return tg(env, 'sendMessage', { chat_id: chatId, text: '⚠️ ' + esc(r.error), parse_mode: 'HTML' });
  const cfg = await getCfg(env);
  const whose = target === sender ? '' : ` для <b>${esc(SH.personName(cfg, target))}</b>`;
  await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ monobank${whose} підключено${r.name ? ' (' + esc(r.name) + ')' : ''}. Повідомлення з токеном я видалив.\n\nКартки, які рахуються в бюджет:`, reply_markup: await monoKb(env, target) });
  return syncPerson(env, target, { report: true });
}

function helpText() {
  return `<b>Як вносити</b>
Просто напиши суму і що це:
<code>350 кафе</code> · <code>1200 сільпо</code> · <code>80 таксі</code>
<code>20$ steam</code> — у доларах
<code>6000 дім разова</code> — разова покупка, не зменшує місячний залишок
<code>500 подарунок окремо</code> — не з бюджету

Покупки з картки monobank додаються самі, щойно ти платиш. Під кожною є кнопки, щоб змінити категорію.

<b>Кнопки внизу</b>
📊 Залишок · 📋 Останні · 🗂 Категорії · 💳 Mono

<b>Команди</b>
/budget 44000 — бюджет на місяць
/rate auto — курс долара з monobank
/daily off — вимкнути вечірній підсумок
/report — звіт за місяць файлом
/web — посилання для браузера`;
}

async function monthState(env, ym) {
  const [cfg, txs] = await Promise.all([getCfg(env), monthTxs(env, ym)]);
  return { cfg, txs, r: SH.compute(cfg, txs, ym, today()) };
}

async function statusText(env, who) {
  const ym = today().slice(0, 7);
  const { cfg, txs, r } = await monthState(env, ym);
  const n = w => esc(SH.personName(cfg, w));
  let s = `📊 <b>${SH.ymLabel(ym)}</b> · спільний бюджет\n\n`;
  if (!r.B) return s + 'Бюджет не задано. Напиши <code>/budget 44000</code>';
  const B2 = n => SH.both(n, cfg.usdRate);
  s += `${r.remaining < 0 ? '🔴' : '🟢'} Вільно: <b>${r.remaining < 0 ? '−' : ''}${B2(Math.abs(r.remaining))}</b> з ${B2(r.B)}\n`;
  if (r.holdTotal > 0) {
    const paid = r.holdTotal - r.holdLeft;
    s += `🏠 Квартира й комуналка: ${B2(r.holdTotal)}, ${r.holdLeft > 0 ? `сплачено ${SH.money(paid)}, ще ${SH.money(r.holdLeft)}` : 'усе сплачено ✓'}\n`;
    s += `🧾 На життя після них: <b>${B2(r.B - r.holdTotal)}</b>, уже витрачено ${B2(r.varSpent)}\n`;
  } else s += `Витрачено ${SH.money(r.spent)}\n`;
  if (r.cur) {
    s += `Можна <b>${B2(r.perDay)}</b> на день, ще ${r.daysLeft} дн.\n`;
    s += r.forecast >= 0 ? `Прогноз: наприкінці лишиться ≈ ${SH.money(r.forecast)}\n` : `Прогноз: перевитрата ≈ ${SH.money(-r.forecast)}, якщо темп не зміниться\n`;
  }
  s += `\n🔹 ${n('me')}: ${SH.money(r.tot.me)}\n🔸 ${n('gf')}: ${SH.money(r.tot.gf)}\n`;
  if (r.once + r.sep > 0) s += `➖ Поза бюджетом: ${SH.money(r.once + r.sep)}\n`;
  const fixed = cfg.cats.filter(c => c.reserve).map(c => { const p = r.per[c.id]; return `${c.icon} ${esc(c.name)}: ${p.spent >= p.limit * 0.98 && p.limit > 0 ? '✅ сплачено' : p.spent > 0 ? `частково, лишилось ${SH.money(p.holdLeft)}` : `очікує ${SH.money(p.limit)}`}`; });
  if (fixed.length) s += '\n' + fixed.join('\n') + '\n';
  const hot = cfg.cats.filter(c => !c.reserve && r.per[c.id].limit > 0 && r.per[c.id].spent >= r.per[c.id].limit * 0.85);
  if (hot.length) s += '\n' + hot.map(c => { const p = r.per[c.id]; return `${p.spent > p.limit ? '⚠️' : '🟡'} ${c.icon} ${esc(c.name)}: ${SH.money(p.spent)} з ${SH.money(p.limit)}`; }).join('\n') + '\n';
  if (r.ignored) s += `\n↪️ Не враховано ${r.ignored} ${SH.plural(r.ignored, 'операцію', 'операції', 'операцій')} (перекази, дублі) на ${SH.money(r.ignoredSum)}. Перевір у застосунку.`;
  return s;
}

async function catsText(env, who) {
  const ym = today().slice(0, 7);
  const { cfg, r } = await monthState(env, ym);
  const line = c => {
    const p = r.per[c.id];
    const bar = p.limit > 0 ? ' ' + '▰'.repeat(Math.min(8, Math.round(p.spent / p.limit * 8))) + '▱'.repeat(Math.max(0, 8 - Math.round(p.spent / p.limit * 8))) : '';
    return `${c.icon} ${esc(c.name)} — <b>${SH.money(p.spent)}</b>${p.limit > 0 ? ' з ' + SH.money(p.limit) + bar + (p.spent > p.limit ? ' ⚠️' : '') : ''}`;
  };
  let s = `🗂 <b>Категорії · ${SH.ymLabel(ym)}</b>\n`;
  for (const [g, label] of [['shared', 'Спільні'], ['me', SH.personName(cfg, 'me')], ['gf', SH.personName(cfg, 'gf')]]) {
    const cs = cfg.cats.filter(c => c.owner === g); if (!cs.length) continue;
    s += `\n<b>${esc(label)}</b>\n` + cs.map(line).join('\n') + '\n';
  }
  return s;
}

async function lastText(env) {
  const ym = today().slice(0, 7);
  const [cfg, txs] = await Promise.all([getCfg(env), monthTxs(env, ym)]);
  if (!txs.length) return 'Цього місяця ще нічого не внесено.';
  return '📋 <b>Останні витрати</b>\n\n' + txs.slice(0, 15).map(t => {
    const c = SH.catOf(cfg, t.cat);
    const d = t.date.slice(8, 10) + '.' + t.date.slice(5, 7);
    return `${t.who === 'gf' ? '🔸' : '🔹'} ${d} ${c.icon} <b>−${SH.money(t.amount, 1)}</b> ${esc(t.merchant || t.note || c.name)}${t.ignored ? ' <i>(не враховано)</i>' : t.once ? ' <i>(разова)</i>' : t.sep ? ' <i>(окремо)</i>' : ''}`;
  }).join('\n');
}

async function txCard(env, t, cfg) {
  cfg = cfg || await getCfg(env);
  const c = SH.catOf(cfg, t.cat);
  const inf = t.info || {};
  const fx = inf.op ? ` (${SH.num(inf.op, 1)} ${esc(inf.opCur)})` : t.cur === 'USD' ? ` (${SH.usd(t.orig)})` : '';
  const head = `${t.who === 'gf' ? '🔸' : '🔹'} <b>−${SH.money(t.amount, 1)}</b>${fx} · ${esc(t.merchant || c.name)}${t.time ? ' · ' + t.time.slice(0, 5) : ''}${inf.hold ? ' · <i>в обробці</i>' : ''}`;
  if (t.ignored) {
    const why = t.reason === 'transfer' ? 'Це переказ, тому я його не рахую.' : t.reason.startsWith('dup:') ? `Схоже на вже внесену «${esc(t.reason.slice(4))}», тому не рахую двічі.` : 'Не враховано в бюджеті.';
    return `${head}\n↪️ ${why}\nЯкщо це оплата (оренда, комуналка), вибери категорію нижче.`;
  }
  const { r } = await monthState(env, t.ym);
  const p = r.per[c.id];
  let s = `${head}\n${c.icon} ${esc(c.name)} · ${esc(SH.personName(cfg, t.who))}${t.src === 'mono' ? ` · mono${t.account ? ' *' + t.account : ''}` : ''}${inf.cb ? ` · кешбек ${SH.money(inf.cb, 1)}` : ''}`;
  if (t.once) s += '\n🔁 Разова покупка, не зменшує місячний залишок.';
  else if (t.sep) s += '\n➖ Окремо, не з бюджету.';
  else if (p.limit > 0) s += `\n${p.spent > p.limit ? '⚠️ Ліміт перевищено' : 'Ліміт'}: ${SH.money(p.spent)} з ${SH.money(p.limit)}`;
  if (r.B && r.cur) s += `\nВільно на місяць: <b>${SH.money(r.remaining)}</b> · ${SH.money(r.perDay)}/день`;
  return s;
}

function txKb(t, cfg) {
  const other = t.who === 'gf' ? 'me' : 'gf';
  if (t.ignored) {
    const quick = ['rent', 'util'].filter(id => cfg.cats.some(c => c.id === id)).map(id => { const c = SH.catOf(cfg, id); return { text: c.icon + ' ' + c.name.split(' ')[0], callback_data: `s:${t.id}:${id}` }; });
    return { inline_keyboard: [quick, [{ text: '✅ Врахувати, вибрати категорію', callback_data: 'c:' + t.id }]].filter(r => r.length) };
  }
  return {
    inline_keyboard: [
      [{ text: '🗂 Категорія', callback_data: 'c:' + t.id }, { text: t.once ? '↩️ В бюджет' : '🔁 Разова', callback_data: 'o:' + t.id }],
      [{ text: '👤 Це ' + SH.personName(cfg, other), callback_data: 'w:' + t.id }, t.src === 'mono' ? { text: '🙈 Не рахувати', callback_data: 'i:' + t.id } : { text: '🗑 Видалити', callback_data: 'd:' + t.id }]
    ]
  };
}
function catKb(t, cfg) {
  const cs = cfg.cats.filter(c => c.owner === 'shared' || c.owner === t.who);
  const rows = []; for (let i = 0; i < cs.length; i += 2) rows.push(cs.slice(i, i + 2).map(c => ({ text: (c.id === t.cat && !t.ignored ? '✓ ' : '') + c.icon + ' ' + c.name, callback_data: `s:${t.id}:${c.id}` })));
  rows.push([{ text: '‹ Назад', callback_data: 'b:' + t.id }]);
  return { inline_keyboard: rows };
}
async function monoKb(env, who) {
  const p = await person(env, who); const accs = accountsOf(p);
  const rows = accs.map((a, i) => [{ text: (a.on ? '✅ ' : '⬜️ ') + accLabel(a), callback_data: `a:${who}:${i}` }]);
  return { inline_keyboard: rows };
}
async function monoStatusText(env, who) {
  const p = await person(env, who);
  if (!p.mono_token) {
    return `💳 <b>Підключення monobank</b>

1. Відкрий <a href="https://api.monobank.ua/">api.monobank.ua</a> (краще з компʼютера).
2. Натисни «Отримати токен» і відскануй QR-код камерою в застосунку monobank (або перейди за посиланням, якщо відкрила сторінку з телефона), підтверди вхід.
3. Скопіюй токен, що зʼявиться на сторінці (довгий рядок).
4. Надішли його сюди одним повідомленням. Я одразу видалю повідомлення з токеном.

Токен дає лише перегляд виписки та балансу. Переказати гроші ним неможливо. Відкликати його можна там само, на api.monobank.ua.`;
  }
  const accs = accountsOf(p);
  const cfg = await getCfg(env); const mate = await person(env, other(who));
  const mateLine = `\n\n${esc(SH.personName(cfg, other(who)))}: ${mate.mono_token ? 'monobank теж підключено ✅' : 'monobank ще не підключено. Хай надішле свій токен у своєму чаті з ботом, або надішли його сюди, я спитаю, чий він.'}`;
  return `💳 <b>monobank підключено</b>${p.mono_name ? ' · ' + esc(p.mono_name) : ''}\nНові покупки зʼявляються тут одразу після оплати. Раз на 5 хвилин я ще й перевіряю виписку на випадок, якщо щось загубилось.\n\nТоркнись картки, щоб увімкнути або вимкнути її. ${accs.filter(a => a.on).length ? '' : '⚠️ Зараз жодна не вибрана.'}\n/sync підтягне зараз. Новий токен можна просто надіслати сюди.${mateLine}`;
}

async function onCallback(env, q) {
  const data = q.data || ''; const m = q.message;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: !!alert });
  const [act, id, extra] = data.split(':');

  if (act === 'j') {
    if (!(await kvGet(env, 'pending:' + q.from.id))) return ack('Відкрий посилання-запрошення ще раз', true);
    const already = await personByTg(env, q.from.id); if (already) return ack('Ти вже в бюджеті');
    const slot = await person(env, id); if (!slot || slot.tg_id) return ack('Це місце вже зайняте', true);
    await env.DB.prepare('UPDATE people SET tg_id=?, chat_id=?, first_name=? WHERE who=? AND tg_id IS NULL').bind(q.from.id, m.chat.id, q.from.first_name || '', id).run();
    await kvDel(env, 'pending:' + q.from.id);
    const cfg = await getCfg(env);
    if (id === 'gf' && cfg.people.gf.name === 'Дівчина' && q.from.first_name) { cfg.people.gf.name = q.from.first_name.slice(0, 20); await putCfg(env, cfg); }
    await ack('Готово!');
    await tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: `👋 Привіт, ${esc(SH.personName(cfg, id))}! Ти в спільному бюджеті.` , parse_mode: 'HTML' });
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: helpText(), parse_mode: 'HTML', reply_markup: MAIN_KB });
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Щоб покупки з monobank додавались самі, натисни «💳 Mono».', reply_markup: await appButton(env) });
    return;
  }
  const p = await personByTg(env, q.from.id);
  if (!p) return ack('Немає доступу', true);

  if (act === 'mt') {
    const pend = await kvGet(env, 'tok:' + q.from.id); await kvDel(env, 'tok:' + q.from.id);
    if (!pend || now() - pend.t > 900 || !WHO.includes(id)) { await ack('Надішли токен ще раз', true); return; }
    await ack('Підключаю…');
    await tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id });
    return finishMono(env, m.chat.id, id, pend.token, pend.ci, p.who);
  }
  if (act === 'a') {
    const owner = extra === undefined ? p.who : (WHO.includes(id) ? id : p.who);
    const idx = extra === undefined ? +id : +extra;
    const op = await person(env, owner); const accs = accountsOf(op); const a = accs[idx]; if (!a) return ack('Не знайшов картку');
    a.on = !a.on; await env.DB.prepare('UPDATE people SET accounts=? WHERE who=?').bind(JSON.stringify(accs), owner).run();
    await tg(env, 'editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: await monoKb(env, owner) });
    return ack(a.on ? 'Картку увімкнено' : 'Картку вимкнено');
  }

  const t = await getTx(env, id);
  if (!t) { await ack('Цієї витрати вже немає'); return tg(env, 'editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); }
  const cfg = await getCfg(env);
  const redraw = async () => tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: await txCard(env, t, cfg), parse_mode: 'HTML', reply_markup: txKb(t, cfg) });

  if (act === 'c') { await ack(); return tg(env, 'editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: catKb(t, cfg) }); }
  if (act === 'b') { await ack(); return tg(env, 'editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: txKb(t, cfg) }); }
  if (act === 's') {
    const changed = t.cat !== extra;
    t.cat = extra; t.ignored = false; t.reason = '';
    if (!t.once) t.sep = !!SH.catOf(cfg, extra).sep;
    await saveTx(env, t);
    if (changed && t.src === 'mono') await learnRule(env, t.merchant, extra);
    await ack(changed && t.src === 'mono' ? 'Запамʼятав для цього магазину' : 'Готово');
    return redraw();
  }
  if (act === 'o') { t.once = !t.once; if (t.once) t.sep = false; await saveTx(env, t); await ack(t.once ? 'Разова, поза бюджетом' : 'Повернуто в бюджет'); return redraw(); }
  if (act === 'i') { t.ignored = !t.ignored; t.reason = t.ignored ? 'manual' : ''; await saveTx(env, t); await ack(t.ignored ? 'Не рахується' : 'Враховано'); return redraw(); }
  if (act === 'w') { t.who = t.who === 'gf' ? 'me' : 'gf'; await saveTx(env, t); await ack('Записано на ' + SH.personName(cfg, t.who)); return redraw(); }
  if (act === 'd') {
    await env.DB.prepare('DELETE FROM tx WHERE id=?').bind(t.id).run(); await ack('Видалено');
    return tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: `<s>−${SH.money(t.amount, 1)} · ${esc(t.merchant || SH.catOf(cfg, t.cat).name)}</s> видалено`, parse_mode: 'HTML' });
  }
  return ack();
}

async function chatFor(env, who) {
  const p = await person(env, who); if (p && p.chat_id) return p.chat_id;
  const o = await person(env, other(who)); return o && o.chat_id;
}
async function notifyTx(env, t) {
  const chat = await chatFor(env, t.who); if (!chat) return;
  const cfg = await getCfg(env);
  await tg(env, 'sendMessage', { chat_id: chat, text: await txCard(env, t, cfg), parse_mode: 'HTML', reply_markup: txKb(t, cfg), disable_notification: !!t.ignored });
}

async function dailySummaries(env) {
  const td = today(); const ym = td.slice(0, 7);
  const { cfg, txs, r } = await monthState(env, ym);
  const day = txs.filter(t => t.date === td && !t.ignored && !t.once && !t.sep);
  const sum = w => day.filter(t => t.who === w).reduce((a, t) => a + t.amount, 0);
  const total = sum('me') + sum('gf');
  const ign = txs.filter(t => t.ignored && t.reason === 'transfer' && t.date === td).length;
  let s = `🌙 <b>Підсумок дня</b>\n`;
  s += total ? `Сьогодні: <b>${SH.money(total)}</b> (${esc(SH.personName(cfg, 'me'))} ${SH.money(sum('me'))} · ${esc(SH.personName(cfg, 'gf'))} ${SH.money(sum('gf'))})\n` : 'Сьогодні без витрат з бюджету 👏\n';
  if (r.B) {
    s += `Вільно до кінця місяця: <b>${SH.money(r.remaining)}</b>`;
    if (r.cur && r.daysLeft > 1) s += ` · завтра і далі ≈ ${SH.money(Math.max(0, r.remaining) / (r.daysLeft - 1))}/день`;
    s += '\n';
  }
  const over = cfg.cats.filter(c => r.per[c.id].limit > 0 && !c.reserve && r.per[c.id].spent > r.per[c.id].limit);
  if (over.length) s += over.map(c => `⚠️ ${c.icon} ${esc(c.name)}: +${SH.money(r.per[c.id].spent - r.per[c.id].limit)} понад ліміт`).join('\n') + '\n';
  if (ign) s += `↪️ ${ign} ${SH.plural(ign, 'переказ', 'перекази', 'переказів')} сьогодні не враховано. Якщо це оплата, познач у застосунку.\n`;
  for (const p of await allPeople(env)) {
    if (p.chat_id && p.daily) await tg(env, 'sendMessage', { chat_id: p.chat_id, text: s, parse_mode: 'HTML', disable_notification: true, reply_markup: await appButton(env) });
  }
}
