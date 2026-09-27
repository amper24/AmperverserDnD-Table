// Общие утилиты: API, распаковка изображений, кубики, окна
window.API = {
  async req(method, url, body, isForm) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    // Токен дублируем в localStorage: cookie не работает, когда приложение открыто во фрейме на чужом домене (превью)
    const tok = localStorage.getItem('dnd_token'); if (tok) opt.headers['Authorization'] = 'Bearer ' + tok;
    if (body !== undefined) {
      if (isForm) opt.body = body; else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    }
    const r = await fetch(url, opt);
    if (r.status === 401) { localStorage.removeItem('dnd_token'); if (!location.pathname.startsWith('/sheet/') && url !== '/api/auth/me') { location.href = '/'; } throw new Error('unauthorized'); }
    window.wsToken = () => localStorage.getItem('dnd_token') || '';
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || r.statusText);
    if (url === '/api/auth/verify' && data.token) localStorage.setItem('dnd_token', data.token);
    if (url === '/api/auth/logout') localStorage.removeItem('dnd_token');
    return data;
  },
  get: (u) => API.req('GET', u), post: (u, b) => API.req('POST', u, b), patch: (u, b) => API.req('PATCH', u, b), del: (u) => API.req('DELETE', u),
  upload: (u, form) => API.req('POST', u, form, true),
};

// ---- Изображения: base64(zlib(webp)) -> ObjectURL. Распаковка на клиенте. ----
const _imgCache = new Map();
const _imgPending = new Map();
async function inflate(bytes) {
  if ('DecompressionStream' in window) {
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer();
  }
  if (window.pako) return pako.inflate(bytes).buffer; // запасной вариант для старых браузеров
  throw new Error('Браузер не поддерживает распаковку');
}
window.assetURL = async function (id) {
  if (_imgCache.has(id)) return _imgCache.get(id);
  if (_imgPending.has(id)) return _imgPending.get(id);
  const p = (async () => {
    const a = await API.get('/api/assets/' + id);
    const bin = Uint8Array.from(atob(a.data_b64), c => c.charCodeAt(0));
    const buf = a.encoding === 'deflate' ? await inflate(bin) : bin.buffer;
    const url = URL.createObjectURL(new Blob([buf], { type: a.mime }));
    _imgCache.set(id, url); _imgPending.delete(id);
    return url;
  })();
  _imgPending.set(id, p);
  return p;
};
const _elCache = new Map();
window.assetImage = function (id, onload) {
  if (_elCache.has(id)) { const im = _elCache.get(id); if (im.complete && onload) onload(im); return im; }
  const im = new Image();
  _elCache.set(id, im);
  assetURL(id).then(u => { im.onload = () => onload && onload(im); im.src = u; }).catch(() => {});
  return im;
};

// ---- Кубики ----
window.rollDice = function (expr) {
  expr = expr.replace(/\s+/g, '').toLowerCase().replace(/к/g, 'd');
  let total = 0; const parts = [];
  for (const m of expr.matchAll(/([+-]?)([^+-]+)/g)) {
    const sign = m[1] === '-' ? -1 : 1, term = m[2];
    const d = term.match(/^(\d*)d(\d+)(k[hl]\d+)?$/);
    if (d) {
      const n = +(d[1] || 1), s = +d[2];
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * s));
      let kept = rolls;
      if (d[3]) { const k = +d[3].slice(2); kept = [...rolls].sort((a, b) => d[3][1] === 'h' ? b - a : a - b).slice(0, k); }
      total += sign * kept.reduce((a, b) => a + b, 0);
      parts.push({ term: m[1] + term, rolls, kept });
    } else if (/^\d+$/.test(term)) { total += sign * +term; parts.push({ term: m[1] + term, value: sign * +term }); }
  }
  return { expr, parts, total };
};
window.mod = (v) => Math.floor((v - 10) / 2);
window.fmtMod = (v) => (v >= 0 ? '+' : '') + v;

// ---- Мелочи UI ----
window.toast = function (t, ms = 2500) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d);
  setTimeout(() => d.remove(), ms);
};
window.el = function (tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
window.modal = function (title, content, buttons = [], opts = {}) {
  return new Promise(resolve => {
    const bg = el('div', { class: 'modal-bg' });
    const m = el('div', { class: 'modal' + (opts.wide ? ' wide' : '') }, el('h2', {}, title), content);
    const btns = el('div', { class: 'row', style: 'margin-top:14px;justify-content:flex-end' });
    for (const b of buttons) btns.append(el('button', { class: b.cls || '', onclick: () => { const r = b.fn ? b.fn() : b.value; if (r !== false) { bg.remove(); resolve(r); } } }, b.label));
    btns.append(el('button', { onclick: () => { bg.remove(); resolve(null); } }, 'Отмена'));
    m.append(btns); bg.append(m); document.body.append(bg);
    bg.addEventListener('pointerdown', e => { if (e.target === bg && !opts.wide) { bg.remove(); resolve(null); } });
  });
};
window.prompt2 = async function (title, placeholder = '', value = '') {
  const inp = el('input', { placeholder, value });
  setTimeout(() => inp.focus(), 50);
  return modal(title, inp, [{ label: 'OK', cls: 'primary', fn: () => inp.value.trim() || false }]);
};
// Плавающее окно (для листа персонажа поверх стола)
window.floatWindow = function (title, body, opts = {}) {
  const w = el('div', { class: 'float', style: `left:${opts.x ?? 80}px;top:${opts.y ?? 70}px;${opts.w ? 'width:' + opts.w + 'px;' : ''}${opts.h ? 'height:' + opts.h + 'px;' : ''}` });
  const head = el('div', { class: 'head' }, el('span', { class: 'grow' }, title));
  if (opts.popout) head.append(el('button', { class: 'small', title: 'В отдельное окно', onclick: () => { opts.popout(); w.remove(); } }, '⧉'));
  head.append(el('button', { class: 'small', onclick: () => w.remove() }, '✕'));
  w.append(head, el('div', { class: 'body' }, body));
  document.body.append(w);
  let drag = null;
  head.addEventListener('pointerdown', e => { if (e.target.tagName === 'BUTTON') return; drag = { dx: e.clientX - w.offsetLeft, dy: e.clientY - w.offsetTop }; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', e => { if (drag) { w.style.left = (e.clientX - drag.dx) + 'px'; w.style.top = (e.clientY - drag.dy) + 'px'; } });
  head.addEventListener('pointerup', () => drag = null);
  w.addEventListener('pointerdown', () => { document.querySelectorAll('.float').forEach(f => f.style.zIndex = 50); w.style.zIndex = 51; });
  return w;
};
window.SKILLS = [
  ['acrobatics', 'Акробатика', 'dex'], ['animal', 'Уход за животными', 'wis'], ['arcana', 'Магия', 'int'], ['athletics', 'Атлетика', 'str'], ['deception', 'Обман', 'cha'],
  ['history', 'История', 'int'], ['insight', 'Проницательность', 'wis'], ['intimidation', 'Запугивание', 'cha'], ['investigation', 'Расследование', 'int'], ['medicine', 'Медицина', 'wis'],
  ['nature', 'Природа', 'int'], ['perception', 'Восприятие', 'wis'], ['performance', 'Выступление', 'cha'], ['persuasion', 'Убеждение', 'cha'], ['religion', 'Религия', 'int'],
  ['sleight', 'Ловкость рук', 'dex'], ['stealth', 'Скрытность', 'dex'], ['survival', 'Выживание', 'wis'],
];
window.ABIL = { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' };
window.CAT_NAMES = { race: 'Расы', class: 'Классы', background: 'Предыстории', item: 'Предметы', spell: 'Заклинания', monster: 'Бестиарий', feat: 'Черты', condition: 'Состояния' };
