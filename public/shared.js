/* Спільна логіка для воркера (бот, monobank) і веб-застосунку. */

export const MONTHS = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
export const MONTHS_GEN = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];

/* Бюджет 44 000 ₴ разом з орендою: 550 $ × 46 = 25 300, комуналка 3 000,
   продукти 11 000, кафе 3 000, транспорт 700, інше 1 000 = 44 000. */
export const DEFAULT_CFG = {
  v: 2, defaultBudget: 44000, usdRate: 46, rateAuto: true, rateDate: '',
  people: { me: { name: 'Вадим' }, gf: { name: 'Дівчина' } },
  months: {},
  cats: [
    { id: 'rent', name: 'Оренда квартири', icon: '🏠', owner: 'shared', limit: 550, cur: 'USD', reserve: true, sep: false },
    { id: 'util', name: 'Комуналка та інтернет', icon: '💡', owner: 'shared', limit: 3000, cur: 'UAH', reserve: true, sep: false },
    { id: 'food', name: 'Продукти', icon: '🛒', owner: 'shared', limit: 11000, cur: 'UAH', reserve: false, sep: false },
    { id: 'cafe', name: 'Кафе та доставка', icon: '🍣', owner: 'shared', limit: 3000, cur: 'UAH', reserve: false, sep: false },
    { id: 'transport', name: 'Транспорт і таксі', icon: '🚕', owner: 'shared', limit: 700, cur: 'UAH', reserve: false, sep: false },
    { id: 'other', name: 'Інше', icon: '📦', owner: 'shared', limit: 1000, cur: 'UAH', reserve: false, sep: false },
    { id: 'home', name: 'Дім і побут', icon: '🧺', owner: 'shared', limit: 0, cur: 'UAH', reserve: false, sep: false },
    { id: 'health', name: 'Здоровʼя та аптека', icon: '💊', owner: 'shared', limit: 0, cur: 'UAH', reserve: false, sep: false },
    { id: 'fun', name: 'Розваги', icon: '🎬', owner: 'shared', limit: 0, cur: 'UAH', reserve: false, sep: false },
    { id: 'subs', name: 'Підписки та сервіси', icon: '✨', owner: 'me', limit: 0, cur: 'UAH', reserve: false, sep: false },
    { id: 'clothes_me', name: 'Одяг', icon: '👕', owner: 'me', limit: 0, cur: 'UAH', reserve: false, sep: false },
    { id: 'beauty', name: 'Краса та догляд', icon: '💅', owner: 'gf', limit: 0, cur: 'UAH', reserve: false, sep: false },
    { id: 'clothes_gf', name: 'Одяг', icon: '👗', owner: 'gf', limit: 0, cur: 'UAH', reserve: false, sep: false }
  ]
};

export const clone = o => JSON.parse(JSON.stringify(o));
export const r2 = n => Math.round((+n || 0) * 100) / 100;

export function normCfg(d) {
  const c = Object.assign(clone(DEFAULT_CFG), d || {});
  c.people = { me: Object.assign({}, DEFAULT_CFG.people.me, d && d.people && d.people.me), gf: Object.assign({}, DEFAULT_CFG.people.gf, d && d.people && d.people.gf) };
  if (!Array.isArray(c.cats) || !c.cats.length) c.cats = clone(DEFAULT_CFG.cats);
  if (!c.cats.some(x => x.id === 'other')) c.cats.push(clone(DEFAULT_CFG.cats.find(x => x.id === 'other')));
  c.cats = c.cats.map(x => ({ id: String(x.id), name: String(x.name || 'Без назви').slice(0, 40), icon: String(x.icon || '•').slice(0, 8), owner: ['me', 'gf'].includes(x.owner) ? x.owner : 'shared', limit: Math.max(0, +x.limit || 0), cur: x.cur === 'USD' ? 'USD' : 'UAH', reserve: !!x.reserve, sep: !!x.sep }));
  c.months = c.months && typeof c.months === 'object' ? c.months : {};
  c.defaultBudget = Math.max(0, +c.defaultBudget || 0);
  c.usdRate = +c.usdRate > 0 ? +c.usdRate : 46;
  c.rateAuto = c.rateAuto !== false;
  return c;
}

export const personName = (cfg, w) => (cfg.people && cfg.people[w] && cfg.people[w].name) || (w === 'gf' ? 'Вона' : 'Я');
export function catMap(cfg) { const m = {}; cfg.cats.forEach(c => (m[c.id] = c)); return m; }
export function catOf(cfg, id) { const m = catMap(cfg); return m[id] || m.other || cfg.cats[0]; }
export function limUAH(cfg, c) { const l = +c.limit || 0; return c.cur === 'USD' ? l * cfg.usdRate : l; }
export function monthBudget(cfg, ym) { const b = cfg.months && cfg.months[ym]; return typeof b === 'number' && b > 0 ? b : cfg.defaultBudget || 0; }
export function planTotal(cfg) { return cfg.cats.filter(c => !c.sep).reduce((a, c) => a + limUAH(cfg, c), 0); }

/* ---------- дати ---------- */
export function daysIn(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
export function ymAdd(ym, k) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + k, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
export function kyivParts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}:${o.second}`, h: +o.hour, mi: +o.minute, s: +o.second };
}
export function ymLabel(ym) { const [y, m] = ym.split('-').map(Number); return MONTHS[m - 1] + ' ' + y; }
export function ymGen(ym) { return MONTHS_GEN[+ym.slice(5, 7) - 1]; }

/* ---------- гроші ---------- */
const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function num(n, dec) { n = +n || 0; return (dec && Math.abs(Math.round(n * 100)) % 100) ? nf2.format(n) : nf0.format(Math.round(n)); }
export const money = (n, dec) => num(n, dec) + ' ₴';
export const usd = n => nf0.format(+n || 0) + ' $';
/* еквівалент у доларах за курсом із налаштувань */
export const toUsd = (n, rate) => usd(Math.round((+n || 0) / (+rate || 1)));
export const both = (n, rate) => rate ? `${money(n)} (≈ ${toUsd(n, rate)})` : money(n);
export const rateFmt = n => nf2.format(+n || 0);
export function plural(n, a, b, c) { n = Math.abs(Math.round(n)); const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b; return c; }
export function parseNum(v) { if (typeof v === 'number') return v; const s = String(v || '').replace(/[\s  ]/g, '').replace('−', '-').replace(',', '.').replace(/[^0-9.\-]/g, ''); const n = parseFloat(s); return isNaN(n) ? NaN : n; }

/* ---------- розрахунок місяця ----------
   ignored: не рахується взагалі (перекази, дублі)
   once: разова покупка, поза бюджетом
   sep: окремо, поза бюджетом */
export function compute(cfg, txs, ym, todayISO) {
  const cats = cfg.cats, cm = catMap(cfg), B = monthBudget(cfg, ym);
  const per = {}; cats.forEach(c => (per[c.id] = { c, spent: 0, me: 0, gf: 0, sep: 0, once: 0, n: 0, limit: 0, holdLeft: 0 }));
  const tot = { me: 0, gf: 0, sepMe: 0, sepGf: 0, onceMe: 0, onceGf: 0 };
  let ignored = 0, ignoredSum = 0;
  for (const t of txs) {
    if (t.ignored) { ignored++; ignoredSum += +t.amount || 0; continue; }
    const id = cm[t.cat] ? t.cat : (cm.other ? 'other' : cats[0].id);
    const p = per[id]; if (!p) continue;
    const a = +t.amount || 0, w = t.who === 'gf' ? 'gf' : 'me';
    if (t.once) { p.once += a; tot[w === 'gf' ? 'onceGf' : 'onceMe'] += a; continue; }
    if (t.sep) { p.sep += a; tot[w === 'gf' ? 'sepGf' : 'sepMe'] += a; continue; }
    p.spent += a; p[w] += a; p.n++; tot[w] += a;
  }
  let spent = 0, holdLeft = 0, holdTotal = 0, varSpent = 0;
  for (const c of cats) {
    const p = per[c.id], L = limUAH(cfg, c); p.limit = L; spent += p.spent;
    if (c.reserve) { p.holdLeft = Math.max(0, L - p.spent); holdLeft += p.holdLeft; holdTotal += Math.max(L, p.spent); }
    else varSpent += p.spent;
  }
  const remaining = B - spent - holdLeft;
  const cur = todayISO && todayISO.slice(0, 7) === ym, dim = daysIn(ym);
  let daysLeft = null, perDay = null, forecast = null, day = null;
  const past = !!todayISO && ym < todayISO.slice(0, 7);
  if (cur) {
    day = +todayISO.slice(8, 10); daysLeft = dim - day + 1;
    perDay = Math.max(0, remaining) / daysLeft;
    forecast = B - holdTotal - (varSpent / day) * dim;
  }
  /* середнє за день: лише змінні витрати, без оренди й комуналки */
  const avgDay = cur ? varSpent / day : past ? varSpent / dim : 0;
  return { B, per, tot, spent, holdLeft, holdTotal, varSpent, remaining, cur, past, dim, daysLeft, perDay, forecast, day, avgDay, sep: tot.sepMe + tot.sepGf, once: tot.onceMe + tot.onceGf, ignored, ignoredSum };
}

/* Висновок «чи вистачить» простими словами */
export function verdict(r, rate) {
  if (!r.B) return null;
  const money = n => both(n, rate);
  if (r.cur) {
    if (r.remaining < 0) return { tone: 'bad', title: 'Бюджет вичерпано.', text: `Перевитрата ${money(-r.remaining)}.` };
    if (r.forecast >= 0) return { tone: 'good', title: 'Вистачить.', text: `Якщо витрачати як зараз (≈ ${money(r.avgDay)} на день), наприкінці місяця лишиться ≈ ${money(r.forecast)}.` };
    return { tone: 'bad', title: 'Може не вистачити.', text: `За цього темпу перевитрата ≈ ${money(-r.forecast)}. Щоб вкластись, тратьте до ${money(r.perDay)} на день.` };
  }
  if (r.past) return r.remaining >= 0 ? { tone: 'good', title: 'Вклались.', text: `Лишилось ${money(r.remaining)}.` } : { tone: 'bad', title: 'Перевитрата.', text: `${money(-r.remaining)} понад бюджет.` };
  return { tone: '', title: 'Місяць ще не почався.', text: `Бюджет ${money(r.B)}.` };
}

/* ---------- автокатегорії ---------- */
export function mkey(desc) { return String(desc || '').toLowerCase().replace(/[0-9*#№]+/g, ' ').replace(/[^a-zа-яіїєґ'ʼ\s]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 32); }

const MCC_KIND = {};
function addM(kind, list) { list.forEach(x => { if (Array.isArray(x)) { for (let i = x[0]; i <= x[1]; i++) MCC_KIND[i] = kind; } else MCC_KIND[x] = kind; }); }
addM('food', [5411, 5412, 5422, 5441, 5451, 5462, 5499, 5921, 5300]);
addM('cafe', [5811, 5812, 5813, 5814]);
addM('transport', [4111, 4112, 4121, 4131, 4784, 4789, 5541, 5542, 5172, 7523, 7512, 7538, 5532, 5533, 7542]);
addM('util', [4900, 4812, 4814, 4899, 4816]);
addM('clothes', [5611, 5621, 5631, 5641, 5651, 5655, 5661, 5681, 5691, 5697, 5698, 5699, 5137, 5139, 5948, 5944]);
addM('health', [5912, 5122, 8011, 8021, 8031, 8041, 8042, 8043, 8049, 8050, 8062, 8071, 8099, 5975, 5976]);
addM('home', [5200, 5211, 5231, 5251, 5261, 5712, 5713, 5714, 5718, 5719, 5722, 5950, 5039, 1520, 1711, 1731, 1740, 1750, 1799, 7623, 7629, 7641, 7692, 7699, 5331, 5310, 5311, 5399, 5309]);
addM('fun', [7832, 7841, 7922, 7929, 7932, 7933, 7941, 7991, 7992, 7993, 7994, 7996, 7997, 7998, 7999, 5945, 5942, 5735, 5815, 5816, 4722, 7011, 7012, 4411, 4511, [3000, 3999]]);
addM('subs', [5817, 5818, 7372, 5734, 5968, 4815]);
addM('beauty', [7230, 7297, 7298, 5977]);
addM('transfer', [4829, 6012, 6050, 6051, 6538, 6540, 6536, 6537, 6211]);
addM('cash', [6010, 6011]);
addM('home', [5732, 5733, 5045, 5065, 5021, 5046, 7210, 7211, 7216, 7217]);
/* «загальні» магазини: тут назва магазину важливіша за код (Копійочка, Аврора, «Магазин») */
const WEAK_MCC = new Set([5300, 5310, 5311, 5331, 5399, 5999, 7399, 5964, 5965, 5966, 5967, 5969]);
export const mccKind = mcc => MCC_KIND[mcc] || '';

function pickKind(cfg, kind, who) {
  const cm = catMap(cfg); const pick = (...ids) => ids.find(id => cm[id]);
  if (kind === 'clothes') return who === 'gf' ? pick('clothes_gf', 'clothes_me') : pick('clothes_me', 'clothes_gf');
  if (kind === 'cash') return pick('other');
  if (kind && kind !== 'transfer') return pick(kind);
  return null;
}
export function suggestCat(cfg, rules, desc, mcc, who) {
  const cm = catMap(cfg); const rk = mkey(desc);
  if (rk && rules && rules[rk] && cm[rules[rk]]) return { cat: rules[rk], kind: 'rule' };
  let kind = MCC_KIND[mcc] || '';
  if (WEAK_MCC.has(+mcc)) { const g = keywordKind(desc); if (g && g !== 'other') kind = g; }
  let cat = pickKind(cfg, kind, who);
  if (!cat) { const g = keywordKind(desc); if (g) { const c2 = pickKind(cfg, g, who); if (c2) { cat = c2; if (kind !== 'transfer') kind = g; } } }
  if (!cat) cat = cm.other ? 'other' : cfg.cats[0].id;
  return { cat, kind };
}

/* ключові слова для швидкого вводу в боті: «350 кафе», «1200 сільпо» */
const KW = [
  ['rent', ['оренд', 'квартир']],
  ['util', ['комунал', 'світло', 'електро', 'газ', 'вода', 'води', 'інтернет', 'київстар', 'kyivstar', 'vodafone', 'водафон', 'lifecell', 'лайфсел', 'мобільн', 'телефон', 'тріолан', 'воля', 'опалення']],
  ['beauty', ['манікюр', 'педикюр', 'нігт', 'перукар', 'стрижк', 'космет', 'краса', 'брови', 'вії', 'watsons', 'prostor', 'простор', 'makeup', 'мейкап', 'барбер']],
  ['food', ['продукт', 'їжа', 'їжу', 'сільпо', 'silpo', 'атб', 'atb', 'novus', 'новус', 'варус', 'varus', 'фора', 'fora', 'metro', 'ашан', 'auchan', 'маркет', 'супермаркет', 'рукавичка', 'копійочка', 'kopiyochka', 'вопак', 'наш край', 'велмарт', 'velmart', 'близенько', 'blyzenko', 'spar', 'фуршет', 'таврія', 'сім23', 'еко маркет', 'магазин', 'mahazyn', 'magazyn', 'lotok', 'лоток', 'ринок', 'базар', 'хліб', 'мʼясо', "м'ясо", 'овоч', 'фрукт']],
  ['cafe', ['кафе', 'ресторан', 'кава', 'каву', 'кав\'ярн', 'кавʼярн', 'coffee', 'суші', 'sushi', 'піца', 'піцу', 'pizza', 'бар', 'паб', 'макдон', 'mcdonald', 'kfc', 'бургер', 'burger', 'доставка', 'glovo', 'глово', 'bolt food', 'обід', 'вечеря', 'сніданок', 'шаурм', 'донер', 'döner', 'kebab', 'кебаб', 'teddy', 'eatme']],
  ['transport', ['таксі', 'taxi', 'bolt', 'uklon', 'уклон', 'uber', 'бензин', 'пальне', 'wog', 'окко', 'okko', 'socar', 'автобус', 'маршрутк', 'проїзд', 'квиток', 'квитки', 'потяг', 'укрзалізниц', 'паркув']],
  ['home', ['дім', 'дому', 'епіцентр', 'epicentr', 'побут', 'jysk', 'ікеа', 'ikea', 'посуд', 'каструл', 'ремонт', 'хімія', 'аврора', 'eva', 'ева', 'нова лінія', 'leroy']],
  ['health', ['аптек', 'ліки', 'ліків', 'лікар', 'стомат', 'аналіз', 'здоровʼя', "здоров'я", 'клінік']],
  ['fun', ['кіно', 'розваг', 'концерт', 'театр', 'ігри', 'steam', 'playstation', 'боулінг', 'квест', 'подорож', 'готель', 'hotel', 'booking']],
  ['subs', ['підписк', 'claude', 'anthropic', 'chatgpt', 'openai', 'netflix', 'spotify', 'youtube', 'apple', 'icloud', 'google', 'megogo', 'мегого', 'sweet tv']],
  ['clothes', ['одяг', 'взуття', 'кросівк', 'sinsay', 'zara', 'h&m', 'reserved', 'waikiki', 'colin', 'puma', 'nike', 'adidas', 'answear', 'intertop']],
  ['other', ['інше', 'різне', 'подарун']]
];
const KW_RE = KW.map(([k, list]) => [k, list.map(w => new RegExp('(^|[^\\p{L}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'))]);
export function keywordKind(text) {
  const t = String(text || '').toLowerCase();
  for (const [k, res] of KW_RE) if (res.some(re => re.test(t))) return k;
  return '';
}
export function guessCat(cfg, rules, text, who) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  const rk = mkey(t); const cm = catMap(cfg);
  if (rk && rules && rules[rk] && cm[rules[rk]]) return rules[rk];
  /* власні категорії: перші 4 літери назви */
  for (const c of cfg.cats) {
    const words = c.name.toLowerCase().split(/[^\p{L}]+/u).filter(w => w.length >= 4);
    if (words.some(w => new RegExp('(^|[^\\p{L}])' + w.slice(0, 5), 'iu').test(t))) {
      if (c.owner === 'shared' || c.owner === who) return c.id;
    }
  }
  const k = keywordKind(t);
  return k ? pickKind(cfg, k, who) : null;
}

/* «350 кафе», «1 200,50 сільпо разова», «20$ steam», «6000 дім окремо» */
export function parseQuick(text) {
  let m = String(text || '').match(/^\s*(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(\$|usd|дол\S*|₴|грн|uah)?(?:\s+|$)(.*)$/i);
  if (!m) { const t = String(text || '').match(/^\s*(\D.*?)\s+(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(\$|usd|дол\S*|₴|грн|uah)?\s*$/i); if (t) m = [t[0], t[2], t[3], t[1]]; }
  if (!m) return null;
  const amount = parseNum(m[1]); if (!(amount > 0)) return null;
  let rest = m[3] || '';
  const cur = m[2] && /^(\$|usd|дол)/i.test(m[2]) ? 'USD' : 'UAH';
  const flag = re => { const had = re.test(rest); rest = rest.replace(re, ' '); return had; };
  const once = flag(/(^|\s)разов\S*/giu);
  const sep = flag(/(^|\s)окремо(?=\s|$)/giu);
  rest = rest.replace(/\s+/g, ' ').trim();
  return { amount, cur, text: rest, once, sep };
}

/* ---------- звіт («брошурка») ---------- */
export const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const REPORT_CSS = `
.rp{--rp-bg:#fff;--rp-text:#16161a;--rp-muted:#6e6e76;--rp-line:#e7e7ec;--rp-soft:#f2f2f5;--rp-acc:#2f6fed;--rp-good:#1f9d55;--rp-bad:#d93a3a;--rp-gf:#c2549b;
  color:var(--rp-text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-variant-numeric:tabular-nums}
.rp *{box-sizing:border-box}
.rp-kicker{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--rp-muted)}
.rp h1{font-size:26px;line-height:1.15;margin:4px 0 2px;font-weight:700;letter-spacing:-.01em}
.rp-sub{color:var(--rp-muted);font-size:13px}
.rp-kpis{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--rp-line);border:1px solid var(--rp-line);border-radius:12px;overflow:hidden;margin:18px 0 12px}
@media (min-width:560px){.rp-kpis{grid-template-columns:repeat(4,1fr)}}
@media print{.rp-kpis{grid-template-columns:repeat(4,1fr)}}
.rp-kpi{background:var(--rp-bg);padding:11px 13px}
.rp-kpi span{display:block;font-size:12px;color:var(--rp-muted)}
.rp-kpi b{display:block;font-size:18px;font-weight:650;margin-top:1px;white-space:nowrap}
.rp-kpi b.bad{color:var(--rp-bad)}
.rp-kpi small{display:block;font-size:12px;color:var(--rp-muted)}
.rp-verdict{padding:11px 13px;border-radius:12px;background:var(--rp-soft)}
.rp-verdict.good b{color:var(--rp-good)}.rp-verdict.bad b{color:var(--rp-bad)}
.rp h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--rp-muted);font-weight:600;margin:22px 0 4px}
.rp table{width:100%;border-collapse:collapse}
.rp td{padding:8px 0;border-bottom:1px solid var(--rp-line);vertical-align:top}
.rp tr:last-child td{border-bottom:0}
.rp td.n{text-align:right;white-space:nowrap;padding-left:12px}
.rp td.m,.rp .m{color:var(--rp-muted)}
.rp td.d{white-space:nowrap;color:var(--rp-muted);width:44px}
.rp-bar{height:4px;background:var(--rp-soft);border-radius:2px;margin-top:6px;overflow:hidden;display:flex}
.rp-bar i{display:block;height:100%;background:var(--rp-acc)}
.rp-bar i.gf{background:var(--rp-gf)}
.rp-bar.over i{background:var(--rp-bad)}
.rp span.good{color:var(--rp-good)}.rp span.bad{color:var(--rp-bad)}
.rp-foot{margin-top:22px;color:var(--rp-muted);font-size:11px}
`;

export function reportBody(cfg, txs, ym, todayISO, stamp) {
  const e = escH, r = compute(cfg, txs, ym, todayISO), v = verdict(r, cfg.usdRate), cm = catMap(cfg);
  const pn = w => e(personName(cfg, w));
  const status = r.cur ? `Станом на ${+todayISO.slice(8, 10)} ${ymGen(ym)} · ${r.day}-й день з ${r.dim}` : r.past ? 'Підсумок місяця' : 'Місяць ще не почався';
  const pct = r.B ? Math.round((r.spent + r.holdLeft) / r.B * 100) : 0;
  const U = n => `<small>≈ ${toUsd(Math.abs(n), cfg.usdRate)}</small>`;
  let h = `<div class="rp"><div class="rp-kicker">Бюджет на двох · звіт</div><h1>${e(ymLabel(ym))}</h1><div class="rp-sub">${status}</div>`;
  h += `<div class="rp-kpis">
    <div class="rp-kpi"><span>Бюджет</span><b>${r.B ? money(r.B) : '—'}</b>${r.B ? U(r.B) : ''}</div>
    <div class="rp-kpi"><span>Витрачено</span><b>${money(r.spent)}</b>${U(r.spent)}</div>
    <div class="rp-kpi"><span>${r.remaining < 0 ? 'Перевитрата' : 'Вільно'}${r.holdLeft > 0 ? '*' : ''}</span><b class="${r.remaining < 0 ? 'bad' : ''}">${money(Math.abs(r.remaining))}</b>${U(r.remaining)}</div>
    <div class="rp-kpi"><span>Середнє за день</span><b>${money(r.avgDay)}</b>${U(r.avgDay)}</div></div>`;
  if (r.holdTotal > 0) h += `<div class="rp-verdict" style="margin-bottom:8px">🏠 Квартира й комуналка: <b>${both(r.holdTotal, cfg.usdRate)}</b>${r.holdLeft > 0 ? `, ще не сплачено ${money(r.holdLeft)}` : ', усе сплачено'}. Після них на життя: <b>${both(r.B - r.holdTotal, cfg.usdRate)}</b>, витрачено ${both(r.varSpent, cfg.usdRate)}.</div>`;
  if (v) h += `<div class="rp-verdict ${v.tone}"><b>${e(v.title)}</b> ${e(v.text)}${r.holdLeft > 0 ? `<div class="m" style="font-size:12px;margin-top:4px">* Уже без ${money(r.holdLeft)} на ще не сплачені обовʼязкові платежі. Середнє за день рахується без них.</div>` : ''}</div>`;

  const fixed = cfg.cats.filter(c => c.reserve);
  if (fixed.length) {
    h += `<h2>Обовʼязкові платежі</h2><table>` + fixed.map(c => {
      const p = r.per[c.id], paid = p.limit > 0 && p.spent >= p.limit * 0.98;
      const st = paid ? `<span class="good">сплачено ${money(p.spent)}</span>` : p.spent > 0 ? `сплачено ${money(p.spent)}, лишилось ${money(p.holdLeft)}` : `<span class="m">очікує ${money(p.limit)}</span>`;
      return `<tr><td>${e(c.icon)} ${e(c.name)}${c.cur === 'USD' ? `<div class="m" style="font-size:12px">${usd(c.limit)} на місяць</div>` : ''}</td><td class="n">${st}</td></tr>`;
    }).join('') + `</table>`;
  }

  const cats = cfg.cats.filter(c => !c.reserve && (r.per[c.id].spent > 0 || r.per[c.id].limit > 0)).sort((a, b) => r.per[b.id].spent - r.per[a.id].spent);
  if (cats.length) {
    h += `<h2>Категорії</h2><table>` + cats.map(c => {
      const p = r.per[c.id], L = p.limit, over = L > 0 && p.spent > L, base = Math.max(L, p.spent, 1);
      return `<tr><td>${e(c.icon)} ${e(c.name)}${c.owner !== 'shared' ? ` <span class="m">· ${pn(c.owner)}</span>` : ''}<div class="rp-bar ${over ? 'over' : ''}"><i style="width:${(p.spent / base * 100).toFixed(1)}%"></i></div></td>
        <td class="n"><b>${money(p.spent)}</b><div class="m" style="font-size:12px">≈ ${toUsd(p.spent, cfg.usdRate)}</div>${L > 0 ? `<div class="m" style="font-size:12px">${over ? `<span class="bad">+${money(p.spent - L)}</span>` : 'з ' + money(L)}</div>` : ''}</td></tr>`;
    }).join('') + `</table>`;
  }

  const tt = r.tot.me + r.tot.gf;
  if (tt > 0) {
    h += `<h2>Хто скільки витратив</h2><table>` + ['me', 'gf'].map(w => `<tr><td>${pn(w)}<div class="rp-bar"><i class="${w}" style="width:${(r.tot[w] / tt * 100).toFixed(1)}%"></i></div></td><td class="n"><b>${money(r.tot[w])}</b><div class="m" style="font-size:12px">≈ ${toUsd(r.tot[w], cfg.usdRate)} · ${Math.round(r.tot[w] / tt * 100)}%</div></td></tr>`).join('') + `</table>`;
  }

  const counted = txs.filter(t => !t.ignored && !t.once && !t.sep && !(cm[t.cat] && cm[t.cat].reserve));
  const top = counted.slice().sort((a, b) => b.amount - a.amount).slice(0, 5);
  const dd = d => d.slice(8, 10) + '.' + d.slice(5, 7);
  if (top.length) {
    h += `<h2>Найбільші покупки</h2><table>` + top.map(t => { const c = catOf(cfg, t.cat); return `<tr><td class="d">${dd(t.date)}</td><td>${e(t.merchant || t.note || c.name)}<div class="m" style="font-size:12px">${e(c.name)} · ${pn(t.who === 'gf' ? 'gf' : 'me')}</div></td><td class="n">${money(t.amount, 1)}</td></tr>`; }).join('') + `</table>`;
  }

  const outs = txs.filter(t => !t.ignored && (t.once || t.sep));
  if (outs.length || r.ignored) {
    h += `<h2>Поза бюджетом</h2><table>`;
    if (r.once) h += `<tr><td>Разові покупки</td><td class="n">${money(r.once, 1)}</td></tr>`;
    if (r.sep) h += `<tr><td>Окремо, зі своїх</td><td class="n">${money(r.sep, 1)}</td></tr>`;
    if (r.ignored) h += `<tr><td>Не враховано <span class="m">(перекази, дублі): ${r.ignored} ${plural(r.ignored, 'операція', 'операції', 'операцій')}</span></td><td class="n m">${money(r.ignoredSum, 1)}</td></tr>`;
    h += `</table>`;
  }
  h += `<div class="rp-foot">Сформовано ${e(stamp || '')}</div></div>`;
  return h;
}

export function reportDoc(cfg, txs, ym, todayISO, stamp) {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Бюджет · ${escH(ymLabel(ym))}</title><style>${REPORT_CSS}
html{background:#eef0f3}body{margin:0;padding:24px 12px 40px}
.page{max-width:720px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 22px}
.pbtn{display:block;margin:16px auto 0;border:0;border-radius:12px;background:#2f6fed;color:#fff;font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px 20px;cursor:pointer}
@page{size:A4;margin:14mm}
@media print{html{background:#fff}body{padding:0}.page{border-radius:0;padding:0;max-width:none}.pbtn{display:none}}
</style></head><body><div class="page">${reportBody(cfg, txs, ym, todayISO, stamp)}</div><button class="pbtn" onclick="print()">Зберегти як PDF / друк</button></body></html>`;
}
