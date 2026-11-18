import * as SH from './shared.js';
const { money, usd, plural } = SH;

const TGW = window.Telegram && window.Telegram.WebApp;
const $ = s => document.querySelector(s);
const esc = SH.escH;
function lsGet(k) { try { return localStorage.getItem('bud4.' + k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem('bud4.' + k, v); } catch {} }
function localISO() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

const VIEWS = ['overview', 'list', 'report', 'settings'];
const S = {
  auth: null, inTg: false, noAccess: false, loading: true, err: null,
  self: 'me', cfg: SH.normCfg(null), ym: null, today: localISO(), txs: [], people: [], rulesCount: 0, bot: null,
  view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : (VIEWS.includes(lsGet('view')) ? lsGet('view') : 'overview'),
  lf: 'all', q: '', edit: null, catEdit: null, ver: 0, pendingRender: false,
  mono: { me: {}, gf: {} }, confirm: '', webLink: '', repBusy: false
};
const pn = w => SH.personName(S.cfg, w);
const catOf = id => SH.catOf(S.cfg, id);
const peopleRow = w => S.people.find(p => p.who === w) || {};
const whoOf = t => (t.who === 'gf' ? 'gf' : 'me');
/* гривні + долари за курсом */
const $u = n => '≈ ' + SH.toUsd(Math.abs(n), S.cfg.usdRate);
const U = n => `<small>${$u(n)}</small>`;
const both = n => SH.both(n, S.cfg.usdRate);

/* ---------- доступ ---------- */
function initAuth() {
  if (TGW && TGW.initData) {
    S.auth = 'tg ' + TGW.initData; S.inTg = true;
    document.documentElement.classList.add('tg');
    try {
      TGW.ready(); TGW.expand();
      const theme = () => { document.documentElement.dataset.theme = TGW.colorScheme || 'light'; };
      theme(); TGW.onEvent && TGW.onEvent('themeChanged', theme);
      if (TGW.setHeaderColor) TGW.setHeaderColor('secondary_bg_color');
      if (TGW.setBackgroundColor) TGW.setBackgroundColor('secondary_bg_color');
      TGW.BackButton && TGW.BackButton.onClick(() => closeSheet());
    } catch {}
    return;
  }
  const u = new URL(location.href); const k = u.searchParams.get('k');
  if (k) { lsSet('key', k); u.searchParams.delete('k'); history.replaceState(null, '', u.pathname + u.search); }
  const key = k || lsGet('key');
  if (key) S.auth = 'key ' + key;
}
async function api(path, body) {
  const r = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: S.auth || '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { S.noAccess = true; S.loading = false; render(); throw new Error('auth'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || 'HTTP ' + r.status);
  return j;
}
async function load(silent) {
  if (!S.auth) { S.noAccess = true; S.loading = false; render(); return; }
  const ver = S.ver, ym = S.ym;
  try {
    const d = await api('state' + (ym ? '?ym=' + ym : ''));
    if (ver !== S.ver || (S.ym && d.ym !== S.ym)) return;
    Object.assign(S, { self: d.self, ym: d.ym, today: d.today || S.today, cfg: SH.normCfg(d.cfg), txs: d.txs || [], people: d.people || [], rulesCount: d.rulesCount || 0, bot: d.bot, err: null });
  } catch (e) { if (e.message !== 'auth' && !silent) S.err = 'Немає звʼязку з сервером. Дані оновляться, щойно звʼязок зʼявиться.'; }
  S.loading = false; render();
}
const haptic = t => { try { const h = TGW && TGW.HapticFeedback; if (!h) return; t === 'tap' ? h.selectionChanged() : h.notificationOccurred(t || 'success'); } catch {} };

/* ---------- зміни ---------- */
function upsertLocal(t) { const i = S.txs.findIndex(x => x.id === t.id); if (t.ym !== S.ym) { if (i >= 0) S.txs.splice(i, 1); return; } if (i >= 0) S.txs[i] = t; else S.txs.unshift(t); }
async function putTx(body) {
  S.ver++;
  const tmp = Object.assign({}, body, { id: body.id || 'tmp' + Date.now(), ym: body.date.slice(0, 7) });
  upsertLocal(tmp); render();
  try { const { tx } = await api('tx', body); S.txs = S.txs.filter(x => x.id !== tmp.id); upsertLocal(tx); render(); }
  catch (e) { toast('Не вдалося зберегти: ' + e.message); load(true); }
}
async function delTx(id) { S.ver++; S.txs = S.txs.filter(x => x.id !== id); render(); try { await api('tx/delete', { id }); } catch { toast('Не вдалося видалити'); load(true); } }
async function bulk(ids, patch) {
  S.ver++;
  ids.forEach(id => { const t = S.txs.find(x => x.id === id); if (!t) return; Object.assign(t, patch); if ('ignored' in patch) t.reason = patch.ignored ? (t.reason || 'manual') : ''; });
  render();
  try { await api('tx/bulk', { ids, patch }); } catch { toast('Не вдалося зберегти'); load(true); }
}
async function saveCfg() { S.ver++; render(); try { const d = await api('config', { cfg: S.cfg }); S.cfg = SH.normCfg(d.cfg); render(); } catch { toast('Не вдалося зберегти налаштування'); load(true); } }
async function setMonthBudget(n) { S.ver++; if (n > 0) S.cfg.months[S.ym] = n; else delete S.cfg.months[S.ym]; render(); try { await api('month', { ym: S.ym, budget: n }); } catch { toast('Не вдалося зберегти'); load(true); } }

/* ---------- рендер ---------- */
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  overview: svg('<path d="M4 13.5a8 8 0 1 1 16 0"/><path d="M12 13.5l4-4"/><path d="M4 18.5h16"/>'),
  list: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4 6.5h.01M4 12h.01M4 17.5h.01"/>'),
  report: svg('<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 12.5h5M10 16h5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>')
};
function isTyping() { const ae = document.activeElement; return ae && ae.closest && ae.closest('#main') && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.type !== 'checkbox'; }
function render() {
  if (isTyping()) { S.pendingRender = true; return; }
  S.pendingRender = false;
  if (S.noAccess) { $('#main').innerHTML = viewNoAccess(); $('#nav').innerHTML = ''; return; }
  if (S.loading) { $('#main').innerHTML = `<div class="banner">Завантажую…</div>`; $('#nav').innerHTML = viewNav(); return; }
  const views = { overview: viewOverview, list: viewList, report: viewReport, settings: viewSettings };
  $('#main').innerHTML = viewTop() + (S.err ? `<div class="alert">${esc(S.err)}</div>` : '') + views[S.view]();
  $('#nav').innerHTML = viewNav();
}
document.addEventListener('focusout', () => { if (S.pendingRender) setTimeout(() => { if (S.pendingRender) render(); }, 0); });

function viewNoAccess() {
  const bot = S.bot && S.bot.username;
  return `<div class="card" style="margin-top:18vh"><h3>Відкрий бюджет через Telegram</h3>
    <p>У чаті з ботом натисни кнопку «Бюджет» біля поля вводу. Для браузера надішли боту /web і перейди за посиланням.</p>
    ${bot ? `<a class="btn" href="https://t.me/${esc(bot)}">Відкрити бота</a>` : ''}</div>`;
}
function viewTop() {
  if (S.view === 'settings') return `<header class="top"><div class="tt"><b>Налаштування</b></div></header>`;
  const [y, m] = S.ym.split('-');
  return `<header class="top">
    <button class="ib" data-act="month" data-k="-1" aria-label="Попередній місяць">${ICON.left}</button>
    <div class="tt"><b>${SH.MONTHS[+m - 1]}</b><span>${y}</span></div>
    <button class="ib" data-act="month" data-k="1" aria-label="Наступний місяць">${ICON.right}</button>
  </header>`;
}
function viewNav() {
  const t = (v, label) => `<button class="tab" data-act="view" data-v="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${ICON[v]}<span>${label}</span></button>`;
  return `<div class="nav-in">${t('overview', 'Огляд')}${t('list', 'Витрати')}<button class="fab" data-act="add" aria-label="Додати витрату">${ICON.plus}</button>${t('report', 'Звіт')}${t('settings', 'Параметри')}</div>`;
}

/* ---------- огляд ---------- */
function viewOverview() {
  const r = SH.compute(S.cfg, S.txs, S.ym, S.today);
  if (!r.B) return `<div class="card"><h3>Скільки виділяєте на ${esc(SH.ymGen(S.ym))}?</h3>
    <div class="row"><input class="inp" id="bInit" inputmode="numeric" placeholder="44 000" aria-label="Бюджет на місяць"><button class="btn sm" style="width:auto" data-act="initBudget">Зберегти</button></div></div>`;
  const v = SH.verdict(r, S.cfg.usdRate), over = r.remaining < 0;
  /* смуга: квартира й комуналка (сплачено + ще треба) | інші витрати | вільно */
  const fixedCats = S.cfg.cats.filter(c => c.reserve);
  const fixPaid = fixedCats.reduce((a, c) => a + r.per[c.id].spent, 0);
  const fixLabel = fixedCats.length && fixedCats.every(c => ['rent', 'util'].includes(c.id)) ? 'Квартира й комуналка' : 'Обовʼязкові платежі';
  const den = Math.max(r.B, r.holdTotal + r.varSpent);
  const pc = x => (Math.max(0, x) / den * 100).toFixed(2) + '%';
  const life = r.B - r.holdTotal;
  let h = `<section class="hero">
    <div class="lbl">${over ? 'Перевитрата' : 'Вільно до кінця місяця'}</div>
    <div class="big ${over ? 'neg' : ''}">${money(Math.abs(r.remaining))}<span class="bigu">${$u(r.remaining)}</span></div>
    <div class="sub">з ${both(r.B)} бюджету</div>
    <div class="prog ${over ? 'over' : ''}" role="img" aria-label="${esc(fixLabel)} ${money(r.holdTotal)}, інші витрати ${money(r.varSpent)}, вільно ${money(Math.max(0, r.remaining))}">
      <i class="fix" style="width:${pc(fixPaid)}"></i><i class="fix pend" style="width:${pc(r.holdLeft)}"></i><i class="var" style="width:${pc(r.varSpent)}"></i></div>
    <div class="legend">
      ${r.holdTotal > 0 ? `<div class="lg"><i class="k fix"></i><div class="g"><div class="t">${fixLabel}</div><div class="s">${r.holdLeft > 0 ? `сплачено ${money(fixPaid)} · ще ${money(r.holdLeft)}` : 'усе сплачено ✓'}</div></div><b>${money(r.holdTotal)}${U(r.holdTotal)}</b></div>` : ''}
      <div class="lg"><i class="k var"></i><div class="g"><div class="t">Уже витрачено на життя</div><div class="s">продукти, кафе, транспорт, підписки…</div></div><b>${money(r.varSpent)}${U(r.varSpent)}</b></div>
      <div class="lg"><i class="k free"></i><div class="g"><div class="t">${over ? 'Перевитрата' : 'Ще вільно'}</div></div><b class="${over ? 'no' : ''}">${money(Math.abs(r.remaining))}${U(r.remaining)}</b></div>
    </div>
    ${r.holdTotal > 0 ? `<div class="after">Після ${fixLabel === 'Квартира й комуналка' ? 'квартири й комуналки' : 'обовʼязкових платежів'} на життя лишається <b>${both(life)}</b>${r.varSpent > 0 ? `, з них уже витрачено ${both(r.varSpent)}` : ''}.</div>` : ''}
  </section>`;
  if (r.cur) h += `<div class="stats">
      <div class="stat"><span>Середнє/день</span><b>${money(r.avgDay)}</b>${U(r.avgDay)}</div>
      <div class="stat"><span>Можна/день</span><b>${money(r.perDay)}</b>${U(r.perDay)}</div>
      <div class="stat"><span>Лишилось днів</span><b>${r.daysLeft}</b></div></div>`;
  else if (r.past) h += `<div class="stats">
      <div class="stat"><span>Середнє/день</span><b>${money(r.avgDay)}</b>${U(r.avgDay)}</div>
      <div class="stat"><span>${esc(pn('me'))}</span><b>${money(r.tot.me)}</b>${U(r.tot.me)}</div>
      <div class="stat"><span>${esc(pn('gf'))}</span><b>${money(r.tot.gf)}</b>${U(r.tot.gf)}</div></div>`;
  if (v) h += `<div class="verdict ${v.tone}"><b>${esc(v.title)}</b> ${esc(v.text)}</div>`;

  const fixed = S.cfg.cats.filter(c => c.reserve);
  if (fixed.length) {
    h += `<section class="sec"><div class="sec-h"><h2>Обовʼязкові</h2></div><div class="list">` + fixed.map(c => {
      const p = r.per[c.id], paid = p.limit > 0 && p.spent >= p.limit * 0.98;
      const plan = c.cur === 'USD' ? `${usd(c.limit)} ≈ ${money(p.limit)}` : both(p.limit);
      const right = paid ? `<span class="ok">✓ сплачено</span>` : `<button class="lnk" data-act="payFixed" data-c="${esc(c.id)}">${p.spent > 0 ? 'Доплатити' : 'Внести'}</button>`;
      return `<div class="li"><span class="emo">${esc(c.icon)}</span><div class="g"><div class="t">${esc(c.name)}</div><div class="s">${paid ? 'сплачено ' + money(p.spent) : p.spent > 0 ? `сплачено ${money(p.spent)} з ${plan}` : plan}</div></div><div class="r">${right}</div></div>`;
    }).join('') + `</div></section>`;
  }

  const cats = S.cfg.cats.filter(c => !c.reserve && (r.per[c.id].spent > 0 || r.per[c.id].limit > 0));
  h += `<section class="sec"><div class="sec-h"><h2>Категорії</h2><button class="lnk" data-act="view" data-v="settings">Ліміти</button></div><div class="list">`;
  h += cats.length ? cats.map(c => {
    const p = r.per[c.id], L = p.limit, overL = L > 0 && p.spent > L, base = Math.max(L, p.spent, 1);
    const sub = L > 0 ? (overL ? `<span class="no">+${money(p.spent - L)} понад ліміт</span>` : `лишилось ${money(L - p.spent)}`) : 'без ліміту';
    return `<button class="li" data-act="openCat" data-c="${esc(c.id)}"><span class="emo">${esc(c.icon)}</span><div class="g">
      <div class="row" style="justify-content:space-between"><span class="t">${esc(c.name)}</span><span class="r">${money(p.spent)}${L > 0 ? `<span class="mut"> / ${SH.num(L)}</span>` : ''}${U(p.spent)}</span></div>
      <div class="s">${sub}${c.owner !== 'shared' ? ' · ' + esc(pn(c.owner)) : ''}</div>
      ${L > 0 ? `<div class="bar ${overL ? 'over' : ''}"><i style="width:${(p.spent / base * 100).toFixed(1)}%"></i></div>` : ''}
    </div></button>`;
  }).join('') : `<div class="empty">Ще немає витрат.</div>`;
  h += `</div></section>`;

  const tt = r.tot.me + r.tot.gf;
  if (r.cur && tt > 0) {
    h += `<section class="sec"><div class="sec-h"><h2>Хто скільки</h2></div><div class="list">` + ['me', 'gf'].map(w => `<button class="li" data-act="lf" data-f="${w}"><div class="g">
      <div class="row" style="justify-content:space-between"><span class="t"><span class="dot ${w}"></span>${esc(pn(w))}</span><span class="r">${money(r.tot[w])}${U(r.tot[w])}</span></div>
      <div class="bar"><i class="${w}" style="width:${(r.tot[w] / tt * 100).toFixed(1)}%"></i></div></div></button>`).join('') + `</div></section>`;
  }
  if (r.ignored || r.once + r.sep > 0) {
    h += `<section class="sec"><div class="list">`;
    if (r.once + r.sep > 0) h += `<button class="li" data-act="lf" data-f="out"><div class="g"><div class="t">Поза бюджетом</div><div class="s">разові та «окремо», не зменшують залишок</div></div><div class="r">${money(r.once + r.sep)}${U(r.once + r.sep)}</div><span class="chev">›</span></button>`;
    if (r.ignored) h += `<button class="li" data-act="lf" data-f="ign"><div class="g"><div class="t">Не враховано · ${r.ignored}</div><div class="s">перекази, дублі та зняті галочки</div></div><div class="r mut">${money(r.ignoredSum)}${U(r.ignoredSum)}</div><span class="chev">›</span></button>`;
    h += `</div></section>`;
  }
  return h;
}

/* ---------- витрати ---------- */
function filterTx(f) {
  if (f === 'me' || f === 'gf') return t => whoOf(t) === f;
  if (f === 'ign') return t => t.ignored;
  if (f === 'out') return t => !t.ignored && (t.once || t.sep);
  if (f.startsWith('cat:')) return t => catOf(t.cat).id === f.slice(4);
  return () => true;
}
function txRow(t) {
  const c = catOf(t.cat), on = !t.ignored;
  const tag = t.ignored ? (t.reason === 'transfer' ? ' · переказ' : t.reason && t.reason.startsWith('dup') ? ' · схоже на дубль' : '') : t.once ? ' · разова' : t.sep ? ' · окремо' : '';
  return `<div class="tx ${on ? '' : 'off'}">
    <button class="chk ${on ? 'on' : ''}" data-act="tog" data-id="${esc(t.id)}" role="checkbox" aria-checked="${on}" aria-label="Рахувати: ${esc(t.merchant || c.name)}"></button>
    <button class="txb" data-act="editTx" data-id="${esc(t.id)}"><div class="g"><div class="t">${esc(t.merchant || t.note || c.name)}</div>
      <div class="s">${esc(c.icon)} ${esc(c.name)} · ${esc(pn(whoOf(t)))}${tag}</div></div>
      <div class="r">−${money(t.amount, 1)}<small>${[t.time ? t.time.slice(0, 5) : '', t.info && t.info.op ? SH.num(t.info.op, 1) + ' ' + t.info.opCur : t.cur === 'USD' ? usd(t.orig) : $u(t.amount), t.info && t.info.hold ? 'в обробці' : ''].filter(Boolean).map(esc).join(' · ')}</small></div></button>
  </div>`;
}
function dayLabel(ds) {
  if (ds === S.today) return 'Сьогодні';
  const y = new Date(S.today + 'T12:00:00'); y.setDate(y.getDate() - 1);
  if (ds === y.toISOString().slice(0, 10)) return 'Вчора';
  const [Y, M, D] = ds.split('-').map(Number);
  return D + ' ' + SH.MONTHS_GEN[M - 1] + ', ' + ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'][new Date(Y, M - 1, D).getDay()];
}
const inBudget = t => !t.ignored && !t.once && !t.sep;
const sumOf = (list, f) => list.filter(f).reduce((a, t) => a + (+t.amount || 0), 0);
function viewList() {
  const usedCats = [...new Set(S.txs.map(t => catOf(t.cat).id))].map(id => catOf(id));
  const chips = [['all', 'Усі'], ['me', pn('me')], ['gf', pn('gf')], ['ign', 'Не враховані'], ['out', 'Поза бюджетом'], ...usedCats.map(c => ['cat:' + c.id, c.icon + ' ' + c.name])];
  if (!chips.some(([k]) => k === S.lf)) S.lf = 'all';
  let list = S.txs.filter(filterTx(S.lf));
  if (S.q) { const q = S.q.toLowerCase(); list = list.filter(t => ((t.merchant || '') + ' ' + (t.note || '') + ' ' + catOf(t.cat).name).toLowerCase().includes(q)); }
  const inB = sumOf(list, inBudget), off = sumOf(list, t => t.ignored), out = sumOf(list, t => !t.ignored && (t.once || t.sep));
  let h = `<input class="search" id="q" type="search" placeholder="Пошук" value="${esc(S.q)}" aria-label="Пошук витрат">
    <div class="chips" role="group" aria-label="Фільтр">${chips.map(([k, l]) => `<button class="chip" data-act="lf" data-f="${esc(k)}" aria-pressed="${S.lf === k}">${esc(l)}</button>`).join('')}</div>
    <div class="sum"><span>${list.length} ${plural(list.length, 'операція', 'операції', 'операцій')}</span><span>у бюджеті <b>${both(inB)}</b></span>${out ? `<span>поза бюджетом ${money(out)}</span>` : ''}${off ? `<span>не враховано ${money(off)}</span>` : ''}</div>`;
  if (!lsGet('tipList') && list.length) h += `<div class="tip"><span>Зніми галочку, і витрата перестане рахуватись у бюджеті. Торкнись рядка, щоб змінити категорію чи зробити її разовою.</span><button class="x" data-act="hideTip" aria-label="Сховати підказку">×</button></div>`;
  if (!list.length) return h + `<div class="list" style="margin-top:14px"><div class="empty">${S.txs.length ? 'Нічого не знайдено.' : 'Ще немає витрат. Натисни «+» або напиши боту «350 кафе».'}</div></div>`;
  const byDay = {}; list.forEach(t => (byDay[t.date] = byDay[t.date] || []).push(t));
  for (const d of Object.keys(byDay).sort().reverse()) {
    const s = sumOf(byDay[d], inBudget);
    h += `<div class="day"><span>${esc(dayLabel(d))}</span><span>${s ? '−' + money(s) + ' · ' + $u(s) : ''}</span></div><div class="list">${byDay[d].map(txRow).join('')}</div>`;
  }
  return h;
}

/* ---------- звіт ---------- */
let reportCssDone = false;
function viewReport() {
  if (!reportCssDone) { const st = document.createElement('style'); st.textContent = SH.REPORT_CSS; document.head.appendChild(st); reportCssDone = true; }
  const canDl = S.inTg && TGW.downloadFile && TGW.isVersionAtLeast && TGW.isVersionAtLeast('8.0');
  const now = new Date(); const stamp = now.toLocaleDateString('uk-UA') + ', ' + now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const b = S.repBusy ? 'disabled' : '';
  const act = S.inTg
    ? `<button class="btn" data-act="repSend" ${b}>${S.repBusy ? 'Надсилаю…' : 'Надіслати файлом у чат'}</button>
       <div class="row2"><button class="btn alt sm" data-act="repOpen" ${b}>Відкрити / PDF</button>${canDl ? `<button class="btn alt sm" data-act="repDl" ${b}>Завантажити</button>` : `<span></span>`}</div>`
    : `<div class="row2"><button class="btn sm" data-act="repDl" ${b}>Завантажити</button><button class="btn alt sm" data-act="repOpen" ${b}>Друк / PDF</button></div>`;
  return `<div class="rep-act">${act}</div><div class="paper">${SH.reportBody(S.cfg, S.txs, S.ym, S.today, stamp)}</div>`;
}

/* ---------- налаштування ---------- */
const ACC_TYPE = { black: 'Чорна', white: 'Біла', platinum: 'Platinum', iron: 'Iron', fop: 'ФОП', yellow: 'Дитяча', eAid: 'єПідтримка', madeInUkraine: 'Зроблено в Україні' };
const accLabel = a => `${ACC_TYPE[a.type] || a.type || 'Картка'}${a.pan ? ' *' + a.pan : ''}${a.cur === 840 ? ' · USD' : ''}`;
function ago(ts) {
  if (!ts) return 'ще не синхронізовано';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return 'щойно'; if (s < 3600) return Math.round(s / 60) + ' хв тому'; if (s < 86400) return Math.round(s / 3600) + ' год тому';
  return Math.round(s / 86400) + ' дн. тому';
}
const TOKEN_HOW = `<details><summary>Як отримати токен</summary><ol>
  <li>Відкрий <a href="https://api.monobank.ua/" target="_blank" rel="noopener">api.monobank.ua</a>, краще з компʼютера.</li>
  <li>«Отримати токен» → відскануй QR у застосунку monobank і підтвердь.</li>
  <li>Скопіюй довгий рядок і встав сюди.</li></ol>
  Токен дає лише перегляд виписки. Переказати гроші ним неможливо.</details>`;
function monoBlock(w) {
  const row = peopleRow(w), mo = row.mono, U = S.mono[w], mine = w === S.self;
  const head = `<div class="sheet-h"><h3><span class="dot ${w}"></span>${esc(pn(w))}${mine ? ' <span class="mut" style="font-weight:400">· ти</span>' : ''}</h3><span class="${mo ? 'ok' : 'mut'}" style="font-size:13px">${mo ? 'підключено' : 'не підключено'}</span></div>`;
  if (!mo || U.input) {
    if (!mine && !mo && !U.input) return `<div class="card">${head}<p style="margin-top:6px">${row.joined ? `Хай ${esc(pn(w))} надішле свій токен боту у своєму чаті.` : `${esc(pn(w))} ще не в боті.`} Або встав її токен тут, він підключиться саме до ${esc(pn(w))}, твій не зміниться.</p><button class="btn alt sm" data-act="monoInput" data-w="${w}">Ввести токен ${esc(pn(w))}</button></div>`;
    return `<div class="card">${head}${TOKEN_HOW}
      <div class="row" style="margin-top:8px"><input class="inp" id="monoTok_${w}" autocomplete="off" spellcheck="false" placeholder="Токен monobank"><button class="btn sm" style="width:auto" data-act="monoConnect" data-w="${w}" ${U.busy ? 'disabled' : ''}>${U.busy ? '…' : 'Підключити'}</button></div>
      ${mo || !mine ? `<button class="lnk" style="margin-top:10px" data-act="monoInputCancel" data-w="${w}">Скасувати</button>` : ''}
      ${U.err ? `<div class="err">${esc(U.err)}</div>` : ''}</div>`;
  }
  return `<div class="card">${head}${mo.name ? `<p style="margin:2px 0 8px">${esc(mo.name)}</p>` : ''}
    <div class="list" style="background:var(--soft);margin:6px 0 10px">${mo.accounts.length ? mo.accounts.map(a => `<label class="li"><div class="g"><div class="t">${esc(accLabel(a))}</div><div class="s">${a.on ? 'рахується · ' + ago(a.last) : 'не рахується'}</div></div><input type="checkbox" class="sw" data-ch="acc" data-w="${w}" value="${esc(a.id)}" ${a.on ? 'checked' : ''} aria-label="Рахувати ${esc(accLabel(a))}"></label>`).join('') : '<div class="empty">Карток у гривні не знайдено.</div>'}</div>
    <div class="row" style="flex-wrap:wrap"><button class="btn alt sm" style="width:auto" data-act="monoSync" data-w="${w}" ${U.busy ? 'disabled' : ''}>${U.busy ? 'Синхронізую…' : 'Підтягнути зараз'}</button>
      <button class="lnk" data-act="monoInput" data-w="${w}">Новий токен</button>
      <button class="lnk" style="color:var(--bad)" data-act="monoOff" data-w="${w}">${S.confirm === 'off' + w ? 'Точно?' : 'Відключити'}</button></div></div>`;
}
function viewSettings() {
  const m = S.cfg.months[S.ym], plan = SH.planTotal(S.cfg), B = SH.monthBudget(S.cfg, S.ym), meRow = peopleRow(S.self);
  let h = `<section class="sec" style="margin-top:4px"><div class="sec-h"><h2>Бюджет</h2></div><div class="card">
    <div class="field" style="margin-top:0"><label for="sBud">На місяць, ₴</label><input class="inp" id="sBud" data-ch="defBudget" inputmode="numeric" value="${S.cfg.defaultBudget || ''}" placeholder="44 000"></div>
    <p style="margin:8px 0 0">${plan > B ? `<span class="no">Ліміти більші за бюджет на ${money(plan - B)}.</span>` : `Розплановано лімітами ${money(plan)} з ${money(B)}.`}</p>
    <div class="field"><label for="sBudM">Лише на ${esc(SH.ymGen(S.ym))}, ₴</label><input class="inp" id="sBudM" data-ch="monthBudget" inputmode="numeric" value="${m || ''}" placeholder="як зазвичай"></div>
    <div class="field"><label for="sRate">Курс долара, ₴</label><div class="row"><input class="inp" id="sRate" data-ch="rate" inputmode="decimal" value="${esc(SH.rateFmt(S.cfg.usdRate))}" ${S.cfg.rateAuto ? 'disabled' : ''}>
      <div class="seg" role="group" aria-label="Курс"><button data-act="rateAuto" data-v="1" aria-pressed="${S.cfg.rateAuto}">Авто</button><button data-act="rateAuto" data-v="0" aria-pressed="${!S.cfg.rateAuto}">Вручну</button></div></div></div>
  </div></section>
  <section class="sec"><div class="sec-h"><h2>Категорії та ліміти</h2><button class="lnk" data-act="newCat">Додати</button></div><div class="list">`;
  for (const [g, label] of [['shared', ''], ['me', pn('me')], ['gf', pn('gf')]]) {
    h += S.cfg.cats.filter(c => c.owner === g).map(c => `<button class="li" data-act="editCat" data-c="${esc(c.id)}"><span class="emo">${esc(c.icon)}</span><div class="g"><div class="t">${esc(c.name)}</div><div class="s">${label ? esc(label) + ' · ' : ''}${c.reserve ? 'обовʼязковий · ' : ''}${c.sep ? 'окремо · ' : ''}${+c.limit ? (c.cur === 'USD' ? usd(c.limit) + ' ≈ ' + money(SH.limUAH(S.cfg, c)) : money(c.limit)) : 'без ліміту'}</div></div><span class="chev">›</span></button>`).join('');
  }
  h += `</div></section>
  <section class="sec"><div class="sec-h"><h2>monobank</h2></div>${monoBlock(S.self)}${monoBlock(S.self === 'me' ? 'gf' : 'me')}
    <p class="note">Кожен токен підключається до конкретної людини, тому два токени не перезаписують один одного. Перекази на картки не рахуються, поки ти не поставиш їм галочку.</p></section>
  <section class="sec"><div class="sec-h"><h2>Імена</h2></div><div class="card">
    ${['me', 'gf'].map((w, i) => `<div class="field" ${i ? '' : 'style="margin-top:0"'}><label for="pn_${w}">${w === S.self ? 'Ти' : 'Партнер'}</label><input class="inp" id="pn_${w}" data-ch="pname" data-w="${w}" value="${esc(pn(w))}"></div>`).join('')}
  </div></section>
  <section class="sec"><div class="sec-h"><h2>Інше</h2></div><div class="list">
    <label class="li"><div class="g"><div class="t">Вечірній підсумок о 21:00</div><div class="s">повідомлення від бота</div></div><input type="checkbox" class="sw" data-ch="daily" ${meRow.daily ? 'checked' : ''}></label>
    <button class="li" data-act="webLink"><div class="g"><div class="t">${S.webLink ? 'Скопіювати посилання' : 'Посилання для браузера'}</div><div class="s">${S.webLink ? esc(S.webLink) : 'відкрити бюджет на компʼютері'}</div></div><span class="chev">›</span></button>
    ${S.rulesCount ? `<button class="li" data-act="clearRules"><div class="g"><div class="t">${S.confirm === 'rules' ? 'Точно очистити?' : 'Забути запамʼятовані магазини'}</div><div class="s">${S.rulesCount} ${plural(S.rulesCount, 'правило', 'правила', 'правил')}</div></div></button>` : ''}
  </div></section>`;
  return h;
}

/* ---------- аркуші ---------- */
function openSheet(html) {
  const ex = $('#sheetRoot .sheet');
  if (ex) { const st = ex.scrollTop; ex.innerHTML = '<div class="grab"></div>' + html; ex.scrollTop = st; return; }
  $('#sheetRoot').innerHTML = `<div class="backdrop" data-act="closeSheetBg"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  document.body.classList.add('locked');
  try { TGW && TGW.BackButton && TGW.BackButton.show(); } catch {}
  const f = $('#sheetRoot [autofocus]'); if (f) setTimeout(() => f.focus(), 60);
}
function closeSheet() {
  $('#sheetRoot').innerHTML = ''; S.edit = null; S.catEdit = null; document.body.classList.remove('locked');
  try { TGW && TGW.BackButton && TGW.BackButton.hide(); } catch {}
  render();
}
const KINDS = [['bud', 'У бюджеті', 'Звичайна витрата, зменшує залишок.'], ['once', 'Разова', 'Велика покупка (техніка, речі для дому). Не зменшує місячний залишок і не псує прогноз.'], ['sep', 'Окремо', 'Платиш зі своїх, не зі спільних грошей.'], ['ign', 'Не рахувати', 'Переказ одне одному, повернення тощо.']];
const kindOf = E => (E.ignored ? 'ign' : E.once ? 'once' : E.sep ? 'sep' : 'bud');
function openAdd(pre) {
  S.edit = Object.assign({ id: null, amount: '', cur: 'UAH', who: S.self, cat: '', date: S.today.slice(0, 7) === S.ym ? S.today : S.ym + '-01', merchant: '', note: '', sep: false, once: false, ignored: false, src: 'manual', confirmDel: false, err: '' }, pre || {});
  if (!S.edit.cat) S.edit.cat = SH.catMap(S.cfg).food ? 'food' : 'other';
  renderTxSheet(true);
}
function openEdit(id) {
  const t = S.txs.find(x => x.id === id); if (!t) return;
  S.edit = Object.assign({}, t, { amount: String(t.cur === 'USD' ? t.orig : t.amount), cat: catOf(t.cat).id, confirmDel: false, err: '' });
  renderTxSheet(false);
}
function syncEdit() {
  const E = S.edit; if (!E) return; const g = id => document.getElementById(id);
  if (g('eAmt')) E.amount = g('eAmt').value; if (g('eDate') && g('eDate').value) E.date = g('eDate').value;
  if (g('eMer')) E.merchant = g('eMer').value;
}
function renderTxSheet(focus) {
  const E = S.edit, k = kindOf(E), amt = SH.parseNum(E.amount);
  const cs = S.cfg.cats.filter(c => c.owner === 'shared' || c.owner === E.who || c.id === E.cat);
  const info = E.src === 'mono' ? monoDetails(E) : '';
  openSheet(`<div class="sheet-h"><h3>${E.id ? 'Витрата' : 'Нова витрата'}</h3><button class="ib" data-act="closeSheet" aria-label="Закрити">${ICON.close}</button></div>${info}
    <div class="amount"><input id="eAmt" inputmode="decimal" placeholder="0" value="${esc(E.amount)}" aria-label="Сума" ${focus ? 'autofocus' : ''}>
      <div class="seg" role="group" aria-label="Валюта"><button data-act="eCur" data-v="UAH" aria-pressed="${E.cur !== 'USD'}">₴</button><button data-act="eCur" data-v="USD" aria-pressed="${E.cur === 'USD'}">$</button></div></div>
    <div class="meta" id="usdHint">${E.cur === 'USD' && amt > 0 ? `≈ ${money(amt * S.cfg.usdRate, 1)} за курсом ${SH.rateFmt(S.cfg.usdRate)}` : ''}</div>
    <div class="field"><label for="eMer">Що це</label><input class="inp" id="eMer" value="${esc(E.merchant)}" placeholder="Сільпо, таксі, подарунок…"></div>
    <div class="field"><span class="lb">Категорія</span><div class="cats">${cs.map(c => `<button data-act="eCat" data-c="${esc(c.id)}" aria-pressed="${E.cat === c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div></div>
    <div class="field"><span class="lb">Як рахувати</span><div class="opts">${KINDS.map(([kk, l]) => `<button data-act="eKind" data-v="${kk}" aria-pressed="${k === kk}">${l}</button>`).join('')}</div><div class="meta">${KINDS.find(x => x[0] === k)[2]}</div></div>
    <div class="row" style="margin-top:14px;align-items:flex-end"><div class="field" style="margin:0;flex:1;min-width:0"><span class="lb">Хто</span><div class="seg">${['me', 'gf'].map(w => `<button data-act="eWho" data-w="${w}" aria-pressed="${E.who === w}">${esc(pn(w))}</button>`).join('')}</div></div>
      ${E.src === 'mono' ? '' : `<div class="field" style="margin:0;flex:1;min-width:0"><label for="eDate">Дата</label><input class="inp" type="date" id="eDate" value="${esc(E.date)}"></div>`}</div>
    ${E.err ? `<div class="err">${esc(E.err)}</div>` : ''}
    <div class="sheet-act"><button class="btn" data-act="eSave">Зберегти</button>${E.id && E.src !== 'mono' ? `<button class="btn danger" data-act="eDel">${E.confirmDel ? 'Точно видалити?' : 'Видалити'}</button>` : ''}</div>`);
}
/* все, що monobank дав про операцію */
function monoDetails(E) {
  const i = E.info || {}, rows = [];
  rows.push(['Коли', E.date.split('-').reverse().join('.') + (E.time ? ', ' + E.time.slice(0, 5) : '') + (i.hold ? ' · в обробці' : '')]);
  rows.push(['Картка', 'monobank' + (E.account ? ' *' + E.account : '')]);
  if (i.op) rows.push(['У валюті', SH.num(i.op, 1) + ' ' + i.opCur]);
  if (i.to) rows.push(['Отримувач', i.to]);
  if (i.iban) rows.push(['IBAN', i.iban]);
  if (i.edrpou) rows.push(['ЄДРПОУ', i.edrpou]);
  if (i.cb) rows.push(['Кешбек', money(i.cb, 1)]);
  if (i.fee) rows.push(['Комісія', money(i.fee, 1)]);
  if (typeof i.bal === 'number') rows.push(['Залишок після', SH.num(i.bal, 1) + ' ' + (i.accCur || '₴')]);
  if (E.mcc) rows.push(['Код MCC', String(E.mcc) + (i.omcc ? ' (ориг. ' + i.omcc + ')' : '')]);
  if (E.note) rows.push(['Коментар', E.note]);
  if (E.reason === 'transfer') rows.push(['Тип', 'переказ']);
  return `<div class="dl">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}${i.rcpt ? `<div><span>Квитанція</span><b><a href="https://check.gov.ua/${encodeURIComponent(i.rcpt)}" target="_blank" rel="noopener" data-act="ext">check.gov.ua</a></b></div>` : ''}</div>`;
}
function saveEdit() {
  syncEdit(); const E = S.edit; const a = SH.parseNum(E.amount);
  if (!(a > 0)) { E.err = 'Вкажи суму більше нуля.'; renderTxSheet(false); return; }
  const body = { id: E.id || undefined, date: E.date, time: E.time || '', amount: SH.r2(E.cur === 'USD' ? a * S.cfg.usdRate : a), orig: SH.r2(a), cur: E.cur, who: E.who, cat: E.cat, merchant: E.merchant.trim(), note: E.note || '', sep: !!E.sep, once: !!E.once, ignored: !!E.ignored };
  putTx(body); closeSheet(); haptic();
  toast(E.date.slice(0, 7) === S.ym ? 'Збережено' : 'Збережено в ' + SH.ymLabel(E.date.slice(0, 7)).toLowerCase());
}
function renderCatSheet() {
  const C = S.catEdit, canDel = !C.isNew && C.id !== 'other';
  openSheet(`<div class="sheet-h"><h3>${C.isNew ? 'Нова категорія' : 'Категорія'}</h3><button class="ib" data-act="closeSheet" aria-label="Закрити">${ICON.close}</button></div>
    <div class="row" style="margin-top:10px"><input class="inp" id="cIcon" maxlength="4" value="${esc(C.icon)}" style="width:58px;flex:none;text-align:center;font-size:20px" aria-label="Значок"><input class="inp" id="cName" value="${esc(C.name)}" placeholder="Назва" aria-label="Назва" ${C.isNew ? 'autofocus' : ''}></div>
    <div class="field"><label for="cLim">Ліміт на місяць (0 — без ліміту)</label><div class="row"><input class="inp" id="cLim" inputmode="decimal" value="${esc(C.limit || '')}" placeholder="0">
      <div class="seg" role="group" aria-label="Валюта"><button data-act="cCur" data-v="UAH" aria-pressed="${C.cur !== 'USD'}">₴</button><button data-act="cCur" data-v="USD" aria-pressed="${C.cur === 'USD'}">$</button></div></div></div>
    <div class="field"><span class="lb">Чия</span><div class="seg">${[['shared', 'Спільна'], ['me', pn('me')], ['gf', pn('gf')]].map(([k, l]) => `<button data-act="cOwner" data-v="${k}" aria-pressed="${C.owner === k}">${esc(l)}</button>`).join('')}</div></div>
    <div class="list" style="background:var(--soft);margin-top:14px">
      <label class="li"><div class="g"><div class="t">Обовʼязковий платіж</div><div class="s">резервується з бюджету, поки не сплачено</div></div><input type="checkbox" class="sw" id="cRes" ${C.reserve ? 'checked' : ''}></label>
      <label class="li"><div class="g"><div class="t">Окремо, не з бюджету</div><div class="s">не зменшує спільний залишок</div></div><input type="checkbox" class="sw" id="cSep" ${C.sep ? 'checked' : ''}></label></div>
    <div class="sheet-act"><button class="btn" data-act="cSave">Зберегти</button>${canDel ? `<button class="btn danger" data-act="cDel">${C.confirmDel ? 'Точно видалити? Витрати перейдуть в «Інше»' : 'Видалити категорію'}</button>` : ''}</div>`);
}
function syncCat() {
  const C = S.catEdit; if (!C) return; const g = id => document.getElementById(id);
  if (g('cIcon')) C.icon = g('cIcon').value.trim() || '•'; if (g('cName')) C.name = g('cName').value; if (g('cLim')) C.limit = SH.parseNum(g('cLim').value) || 0;
  if (g('cRes')) C.reserve = g('cRes').checked; if (g('cSep')) C.sep = g('cSep').checked;
}

/* ---------- події ---------- */
let toastT;
function toast(msg) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; $('#toastRoot').innerHTML = ''; $('#toastRoot').appendChild(el); clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 3200); }
function go(view) { S.view = view; lsSet('view', view); S.confirm = ''; render(); window.scrollTo(0, 0); }
async function reportLink() { return api('report/link', { ym: S.ym }); }
const ACT = {
  view(el) { go(el.dataset.v); },
  month(el) { S.ym = SH.ymAdd(S.ym, +el.dataset.k); S.ver++; S.txs = []; render(); load(); },
  lf(el) { S.lf = el.dataset.f; if (S.view !== 'list') { S.q = ''; go('list'); } else render(); },
  openCat(el) { S.lf = 'cat:' + el.dataset.c; S.q = ''; go('list'); },
  hideTip() { lsSet('tipList', '1'); render(); },
  tog(el) {
    const t = S.txs.find(x => x.id === el.dataset.id); if (!t) return;
    const ig = !t.ignored; bulk([t.id], { ignored: ig }); haptic('tap');
    if (!ig && t.reason === 'transfer') toast(`Враховано в «${catOf(t.cat).name}». Торкнись рядка, щоб змінити категорію.`);
  },
  add() { openAdd(); },
  editTx(el) { openEdit(el.dataset.id); },
  payFixed(el) { const c = catOf(el.dataset.c); const r = SH.compute(S.cfg, S.txs, S.ym, S.today); const left = r.per[c.id].holdLeft; const amt = c.cur === 'USD' ? SH.r2(left / S.cfg.usdRate) : SH.r2(left); openAdd({ cat: c.id, cur: c.cur, amount: amt ? String(amt) : '', merchant: c.name }); },
  initBudget() { const v = SH.parseNum(($('#bInit') || {}).value); if (v > 0) { S.cfg.defaultBudget = v; saveCfg(); } else toast('Вкажи суму бюджету'); },
  rateAuto(el) { S.cfg.rateAuto = el.dataset.v === '1'; saveCfg().then(() => S.cfg.rateAuto && load(true)); },
  webLink() {
    if (S.webLink) { navigator.clipboard && navigator.clipboard.writeText(S.webLink).then(() => toast('Скопійовано'), () => toast('Не вдалося скопіювати')); return; }
    api('weblink', {}).then(d => { S.webLink = d.url; render(); }, () => toast('Не вдалося'));
  },
  clearRules() { if (S.confirm !== 'rules') { S.confirm = 'rules'; render(); return; } S.confirm = ''; S.rulesCount = 0; api('rules/clear', {}).then(() => toast('Очищено')); render(); },
  monoInput(el) { const U = S.mono[el.dataset.w]; U.input = true; U.err = ''; render(); const i = $('#monoTok_' + el.dataset.w); i && i.focus(); },
  monoInputCancel(el) { S.mono[el.dataset.w].input = false; render(); },
  async monoConnect(el) {
    const w = el.dataset.w, U = S.mono[w], tok = (($('#monoTok_' + w) || {}).value || '').trim();
    if (!tok) { U.err = 'Встав токен.'; render(); return; }
    U.busy = true; U.err = ''; document.activeElement && document.activeElement.blur(); render();
    try { await api('mono/connect', { token: tok, for: w }); U.input = false; toast(`monobank ${pn(w)} підключено. Підтягую витрати…`); haptic(); await load(true); setTimeout(() => load(true), 8000); }
    catch (e) { U.err = e.message; }
    U.busy = false; render();
  },
  async monoSync(el) {
    const w = el.dataset.w, U = S.mono[w]; U.busy = true; render();
    try {
      const r = await api('mono/sync', { for: w });
      if (r.wait) toast(`monobank дозволяє 1 запит на хвилину. Спробуй через ${r.wait} с.`);
      else if (r.error === 'noacc') toast('Увімкни хоча б одну картку');
      else if (r.error) toast('monobank не відповів, бот спробує сам за кілька хвилин');
      else toast(`${r.account}: нових ${r.added}${r.left ? ` · ще ${r.left} в черзі` : ''}`);
      await load(true);
    } catch (e) { toast('Помилка: ' + e.message); }
    U.busy = false; render();
  },
  async monoOff(el) { const w = el.dataset.w; if (S.confirm !== 'off' + w) { S.confirm = 'off' + w; render(); return; } S.confirm = ''; await api('mono/disconnect', { for: w }); await load(true); },
  async repSend() {
    S.repBusy = true; render();
    try { await api('report/send', { ym: S.ym }); haptic(); toast('Звіт надіслано в чат з ботом'); } catch (e) { toast('Не вдалося: ' + e.message); }
    S.repBusy = false; render();
  },
  async repOpen() {
    const win = S.inTg ? null : window.open('', '_blank');
    try { const d = await reportLink(); if (S.inTg) TGW.openLink(d.url); else if (win) win.location = d.url; else location.href = d.url; }
    catch (e) { win && win.close(); toast('Не вдалося: ' + e.message); }
  },
  async repDl() {
    try {
      const d = await reportLink(); const url = d.url + '?dl=1';
      if (S.inTg && TGW.downloadFile) TGW.downloadFile({ url, file_name: d.file });
      else { const a = document.createElement('a'); a.href = url; a.download = d.file; document.body.appendChild(a); a.click(); a.remove(); }
    } catch (e) { toast('Не вдалося: ' + e.message); }
  },
  newCat() { S.catEdit = { isNew: true, id: 'c' + Date.now().toString(36), name: '', icon: '🏷️', owner: 'shared', limit: 0, cur: 'UAH', reserve: false, sep: false }; renderCatSheet(); },
  editCat(el) { const c = S.cfg.cats.find(x => x.id === el.dataset.c); if (!c) return; S.catEdit = Object.assign({}, c, { isNew: false }); renderCatSheet(); },
  closeSheet() { closeSheet(); },
  ext(el, e) { if (S.inTg) { e.preventDefault(); TGW.openLink(el.href); } },
  closeSheetBg(el, e) { if (e.target === el) closeSheet(); },
  eCur(el) { syncEdit(); S.edit.cur = el.dataset.v; renderTxSheet(false); },
  eWho(el) { syncEdit(); S.edit.who = el.dataset.w; const c = catOf(S.edit.cat); if (c.owner !== 'shared' && c.owner !== S.edit.who) { const twin = S.cfg.cats.find(x => x.owner === S.edit.who && x.name === c.name); S.edit.cat = twin ? twin.id : 'other'; } renderTxSheet(false); },
  eCat(el) { syncEdit(); S.edit.cat = el.dataset.c; if (!S.edit.id && !S.edit.once && !S.edit.ignored) S.edit.sep = !!catOf(el.dataset.c).sep; if (S.edit.ignored && S.edit.reason === 'transfer') S.edit.ignored = false; renderTxSheet(false); },
  eKind(el) { syncEdit(); const k = el.dataset.v, E = S.edit; E.ignored = k === 'ign'; E.once = k === 'once'; E.sep = k === 'sep'; renderTxSheet(false); },
  eSave() { saveEdit(); },
  eDel() { const E = S.edit; if (!E.confirmDel) { syncEdit(); E.confirmDel = true; renderTxSheet(false); return; } const id = E.id; closeSheet(); delTx(id); toast('Видалено'); },
  cOwner(el) { syncCat(); S.catEdit.owner = el.dataset.v; renderCatSheet(); },
  cCur(el) { syncCat(); S.catEdit.cur = el.dataset.v; renderCatSheet(); },
  cSave() {
    syncCat(); const C = S.catEdit; if (!C.name.trim()) { toast('Вкажи назву'); return; }
    const rec = { id: C.id, name: C.name.trim(), icon: C.icon, owner: C.owner, limit: +C.limit || 0, cur: C.cur === 'USD' ? 'USD' : 'UAH', reserve: !!C.reserve, sep: !!C.sep };
    const i = S.cfg.cats.findIndex(x => x.id === C.id); if (i >= 0) S.cfg.cats[i] = rec; else S.cfg.cats.push(rec);
    closeSheet(); saveCfg();
  },
  cDel() { const C = S.catEdit; if (!C.confirmDel) { syncCat(); C.confirmDel = true; renderCatSheet(); return; } S.cfg.cats = S.cfg.cats.filter(x => x.id !== C.id); closeSheet(); saveCfg(); }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  const f = ACT[el.dataset.act]; if (!f) return;
  if (el.tagName === 'BUTTON') e.preventDefault();
  f(el, e);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#sheetRoot').innerHTML) closeSheet();
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  if (e.target.closest('.sheet')) { e.preventDefault(); if (S.edit) saveEdit(); else if (S.catEdit) ACT.cSave(); }
  else if (e.target.id === 'bInit') ACT.initBudget();
  else if (e.target.id.startsWith('monoTok_')) ACT.monoConnect({ dataset: { w: e.target.id.slice(8) } });
  else e.target.blur();
});
let qT;
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'q') {
    S.q = t.value; clearTimeout(qT);
    qT = setTimeout(() => { const pos = t.selectionStart; S.pendingRender = false; $('#main').innerHTML = viewTop() + viewList(); const n = $('#q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} } }, 250);
  }
  if (t.id === 'eAmt' && S.edit) { S.edit.amount = t.value; const h = $('#usdHint'); const a = SH.parseNum(t.value); if (h) h.textContent = S.edit.cur === 'USD' && a > 0 ? `≈ ${money(a * S.cfg.usdRate, 1)} за курсом ${SH.rateFmt(S.cfg.usdRate)}` : ''; }
});
document.addEventListener('change', e => {
  const t = e.target; const ch = t.dataset && t.dataset.ch; if (!ch) return;
  if (ch === 'defBudget') { const v = SH.parseNum(t.value); S.cfg.defaultBudget = v > 0 ? v : 0; saveCfg(); }
  else if (ch === 'monthBudget') { const v = SH.parseNum(t.value); setMonthBudget(v > 0 ? v : 0); }
  else if (ch === 'rate') { const v = SH.parseNum(t.value); if (v > 0) { S.cfg.usdRate = v; saveCfg(); } else toast('Курс має бути більше нуля'); }
  else if (ch === 'pname') { const v = t.value.trim(); if (v) { S.cfg.people[t.dataset.w].name = v.slice(0, 20); saveCfg(); } }
  else if (ch === 'daily') { peopleRow(S.self).daily = t.checked; api('me', { daily: t.checked }).catch(() => toast('Не вдалося зберегти')); }
  else if (ch === 'acc') {
    const w = t.dataset.w;
    const on = [...document.querySelectorAll(`input[data-ch="acc"][data-w="${w}"]`)].filter(x => x.checked).map(x => x.value);
    const mo = peopleRow(w).mono; if (mo) mo.accounts.forEach(a => (a.on = on.includes(a.id)));
    render(); api('mono/accounts', { on, for: w }).catch(() => toast('Не вдалося зберегти'));
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.auth && !S.noAccess) load(true); });
setInterval(() => { if (!document.hidden && S.auth && !S.noAccess && !S.edit && !S.catEdit && !isTyping()) load(true); }, 20000);

initAuth();
render();
load();
