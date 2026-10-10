// ---------------------------------------------------------------------------
// common.js — фундамент приложения: безопасное хранилище (согласие на cookie),
// API-клиент, язык содержимого, DOM-помощники (el, modal, floatWindow, toast,
// icon), изображения-ассеты, словари (SKILLS, ABIL, EDITIONS, CAT_NAMES), тема.
// Даёт: window.LS, window.Consent, window.API, window.Lang, window.el/modal/
//       prompt2/floatWindow/toast/icon/Theme, window.SKILLS/ABIL/EDITIONS/
//       CAT_NAMES, window.defaultEdition, window.withTok/go/reloadPage.
// Зависимости: нет. Загружается первым в index.html и sheet.html (слой 1).
// ---------------------------------------------------------------------------
// Безопасное хранилище: localStorage может быть недоступен (фрейм на чужом домене, приватный режим) — тогда sessionStorage или память.
// Учитывает согласие на cookie: без согласия на «функциональные» ключи (тема, вкладки, панели) они живут только в памяти.
window.LS = (() => {
  const mem = {}; const memStore = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  let real = memStore, persistent = false;
  for (const name of ['localStorage', 'sessionStorage']) { try { const st = window[name]; st.setItem('__et_test', '1'); st.removeItem('__et_test'); real = st; persistent = true; break; } catch { } }
  const ESSENTIAL = ['dnd_token', 'et-consent'];
  const allowed = (k) => ESSENTIAL.includes(k) || (window.Consent ? Consent.get().functional : false);
  return {
    getItem: k => { const v = real.getItem(k); return v !== null ? v : memStore.getItem(k); },
    setItem: (k, v) => { if (allowed(k)) real.setItem(k, v); else memStore.setItem(k, v); },
    removeItem: k => { real.removeItem(k); memStore.removeItem(k); },
    persistent,
    purgeFunctional: () => { for (const k of ['et-theme', 'dicetray_min', 'et-edition', 'et-lang', 'dice-settings']) real.removeItem(k); try { for (let i = real.length - 1; i >= 0; i--) { const k = real.key(i); if (k && k.startsWith('sheet_tab_')) real.removeItem(k); } } catch { } },
  };
})();

// ---- Навигация ----
window.withTok = (url) => url;
window.reloadPage = () => location.reload();
window.go = (url, replace) => { if (replace) location.replace(url); else location.href = url; };

// ---- Согласие на cookie и хранилище ----
// Категории: necessary (сессия dnd_session/dnd_session_x, токен dnd_token, само согласие) — всегда; functional (тема, вкладки листа, панель кубиков) — по согласию.
// Аналитики и рекламных cookie в приложении нет.
window.Consent = (() => {
  const KEY = 'et-consent';
  const read = () => { try { const raw = LS.getItem(KEY) || (document.cookie.match(/(?:^|; )et-consent=([^;]*)/) || [])[1]; return raw ? JSON.parse(decodeURIComponent(raw)) : null; } catch { return null; } };
  const api = {
    get() { return read() || { decided: false, necessary: true, functional: false }; },
    set(functional) {
      const v = { decided: true, necessary: true, functional: !!functional, at: new Date().toISOString() };
      const enc = encodeURIComponent(JSON.stringify(v));
      LS.setItem(KEY, JSON.stringify(v));
      try { document.cookie = `${KEY}=${enc}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`; } catch { }
      if (!functional) LS.purgeFunctional(); else { try { LS.setItem('et-theme', document.documentElement.dataset.theme || 'dark'); } catch { } }
      document.querySelector('.cookie-banner')?.remove();
    },
    banner() {
      if (api.get().decided || document.querySelector('.cookie-banner') || new URLSearchParams(location.search).get('embed')) return;
      const b = el('div', { class: 'cookie-banner', role: 'dialog', 'aria-label': 'Cookie' },
        el('div', { class: 'cookie-text' }, el('b', {}, 'Cookie и хранилище'), el('p', {}, 'Для входа в аккаунт нужны обязательные cookie сессии. Функциональные (тема оформления, открытые вкладки) — по вашему выбору. Аналитики и рекламы нет. ', el('a', { href: '/privacy' }, 'Подробнее'))),
        el('div', { class: 'cookie-actions' },
          el('button', { class: 'small', onclick: () => api.settings() }, 'Настроить'),
          el('button', { class: 'small', onclick: () => api.set(false) }, 'Только обязательные'),
          el('button', { class: 'small primary', onclick: () => api.set(true) }, 'Принять все')));
      document.body.append(b);
    },
    async settings() {
      const cur = api.get();
      const fn = el('input', { type: 'checkbox', style: 'width:auto', checked: cur.functional ? '' : null });
      const row = (title, desc, ctrl) => el('div', { class: 'consent-row' }, el('div', { class: 'grow' }, el('b', {}, title), el('div', { class: 'muted small' }, desc)), ctrl);
      const body = el('div', {},
        row('Обязательные', 'Cookie сессии dnd_session / dnd_session_x, токен входа dnd_token, запись о согласии et-consent. Без них вход невозможен. Срок — 30 дней, согласие — 1 год.', el('span', { class: 'badge' }, 'всегда')),
        row('Функциональные', 'Тема оформления (et-theme), язык справочника (et-lang), последняя вкладка листа персонажа (sheet_tab_*), свёрнутая панель кубиков (dicetray_min), настройки анимации (dice-settings). Хранятся в localStorage браузера, на сервер не передаются.', fn),
        row('Аналитика и реклама', 'Не используются. Сторонних скриптов и трекеров на сайте нет.', el('span', { class: 'badge' }, 'нет')),
        el('p', { class: 'muted small', style: 'margin-top:10px' }, 'Изменить выбор можно в любой момент: ссылка «Cookie» внизу главной страницы или в профиле. ', el('a', { href: '/privacy' }, 'Политика конфиденциальности')));
      const ok = await modal('Настройки cookie', body, [{ label: 'Сохранить', cls: 'primary', fn: () => ({ functional: fn.checked }) }, { label: 'Принять все', fn: () => ({ functional: true }) }]);
      if (ok) api.set(ok.functional);
    },
  };
  return api;
})();
// Общие утилиты: API, распаковка изображений, кубики, окна
window.API = {
  async req(method, url, body, isForm) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    // Токен дублируем в localStorage: cookie не работает, когда приложение открыто во фрейме на чужом домене (превью)
    const tok = LS.getItem('dnd_token'); if (tok) opt.headers['Authorization'] = 'Bearer ' + tok;
    if (body !== undefined) {
      if (isForm) opt.body = body; else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    }
    const r = await fetch(url, opt);
    if (r.status === 401) { LS.removeItem('dnd_token'); if (!location.pathname.startsWith('/sheet/') && !location.pathname.startsWith('/login') && url !== '/api/auth/me') { go('/login?next=' + encodeURIComponent(location.pathname + location.search)); } throw new Error('unauthorized'); }
    window.wsToken = () => LS.getItem('dnd_token') || '';
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const error = new Error(data.detail || r.statusText); error.status = r.status; throw error; }
    if (data.token && ['/api/auth/verify', '/api/auth/login', '/api/auth/reset-password', '/api/auth/google'].includes(url)) LS.setItem('dnd_token', data.token);
    if (url === '/api/auth/logout') LS.removeItem('dnd_token');
    return data;
  },
  get: (u) => API.req('GET', Lang.url(u)), post: (u, b) => API.req('POST', u, u.endsWith('/transfer') ? { request_id: crypto.randomUUID(), ...b } : b), patch: (u, b) => API.req('PATCH', u, b), del: (u) => API.req('DELETE', u),
  upload: (u, form) => API.req('POST', u, form, true),
  // Запись справочника в «сыром» виде (базовый язык + слои перевода в data.i18n) — то, что можно править и сохранять.
  // Записи из списков приходят уже на языке просмотра (data.i18n_view) и сохранять их нельзя: сервер такие данные отклонит.
  async rawEntry(e) { return e?.id && e.data?.i18n_view ? API.get('/api/compendium/' + e.id + '?raw=1') : e; },
};

// ---- Язык содержимого (справочник, наборы): ru | en ----
// Язык интерфейса остаётся русским; переключатель влияет на записи справочника и названия/описания наборов.
window.Lang = (() => {
  const KEY = 'et-lang', LANGS = { ru: 'Русский', en: 'English' };
  const api = {
    LANGS,
    get() { const v = LS.getItem(KEY); return LANGS[v] ? v : 'ru'; },
    set(l) { if (LANGS[l]) LS.setItem(KEY, l); },
    // Добавляет ?lang= к запросам справочника (кроме raw=1 и явно заданного языка).
    url(u) {
      if (typeof u !== 'string' || !/^\/api\/compendium(\/|\?|$)/.test(u) || /[?&](lang|raw)=/.test(u)) return u;
      return u + (u.includes('?') ? '&' : '?') + 'lang=' + api.get();
    },
    // Служебные значения, на которых работают механики (типы урона, характеристики, состояния), в данных хранятся по-русски;
    // для показа на английском переводим их таблицей.
    TERMS_EN: {
      'рубящий': 'Slashing', 'колющий': 'Piercing', 'дробящий': 'Bludgeoning', 'кислота': 'Acid', 'холод': 'Cold', 'огонь': 'Fire', 'силовое поле': 'Force',
      'электричество': 'Lightning', 'некротический': 'Necrotic', 'яд': 'Poison', 'психический': 'Psychic', 'излучение': 'Radiant', 'звук': 'Thunder',
      'СИЛ': 'STR', 'ЛОВ': 'DEX', 'ТЕЛ': 'CON', 'ИНТ': 'INT', 'МДР': 'WIS', 'ХАР': 'CHA',
    },
    // Состояния переводятся из набора conditions (поле en); остальные термины — таблица выше.
    term(v) { return api.get() === 'en' ? (api.TERMS_EN[v] || window.Presets?.items('conditions').find(c => c.table.ru === v)?.table.en || v) : v; },
    // Перевод набора: у набора есть базовый язык (locale) и переводы i18n = { en: { name, description } }.
    pack(p, field) {
      const l = api.get(), base = p?.locale || 'ru';
      const t = l !== base ? p?.i18n?.[l]?.[field] : '';
      return t || p?.[field] || '';
    },
    packName(p) { return api.pack(p, 'name'); },
    packDesc(p) { return api.pack(p, 'description'); },
    // Переключатель языка: по умолчанию перезагружает страницу, чтобы всё перерисовалось на новом языке.
    select(onChange) {
      const sel = el('select', { class: 'lang-select', title: 'Язык справочника и наборов', 'aria-label': 'Язык справочника и наборов' },
        ...Object.entries(LANGS).map(([k, v]) => el('option', { value: k, selected: api.get() === k ? '' : null }, v)));
      sel.addEventListener('change', () => { api.set(sel.value); onChange ? onChange(sel.value) : reloadPage(); });
      return sel;
    },
  };
  return api;
})();

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
    for (const b of buttons) btns.append(el('button', { class: b.cls || '', title: b.title || null, onclick: () => { const r = b.fn ? b.fn() : b.value; if (r !== false) { bg.remove(); resolve(r); } } }, b.label));
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
window.EDITIONS = { '2014': 'D&D 5e (2014)', '2024': 'D&D 5e (2024)' };
/// Редакция по умолчанию для новых персонажей и фильтра справочника (запоминается).
window.defaultEdition = () => LS.getItem('et-edition') || '2014';
window.CAT_NAMES = { race: 'Расы', class: 'Классы', background: 'Предыстории', item: 'Предметы', spell: 'Заклинания', monster: 'Бестиарий', npc: 'NPC', feat: 'Черты', condition: 'Состояния', lore: 'Лор и правила' };

// ---- Минималистичные SVG-иконки (line icons), без эмодзи ----
const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18', close: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14', send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z', trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  window: 'M3 5h18v14H3z M3 9h18', sheet: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M8 13h8M8 17h8', chat: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  dice: 'M4 4h16v16H4z M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01', eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 100-6 3 3 0 000 6z', eyeoff: 'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24 M1 1l22 22',
  copy: 'M9 9h11v11H9z M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1', lock: 'M5 11h14v10H5z M8 11V7a4 4 0 018 0v4', unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 017.5-2',
  select: 'M4 4l7 16 2-7 7-2z', hand: 'M18 11V6a2 2 0 00-4 0v1 M14 10V4a2 2 0 00-4 0v2 M10 10.5V6a2 2 0 00-4 0v8 M18 8a2 2 0 014 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 012.83-2.82L7 15',
  ruler: 'M2 17l15-15 5 5L7 22z M7 12l2 2M10 9l2 2M13 6l2 2', pen: 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586 M11 11a2 2 0 100-4 2 2 0 000 4z',
  text: 'M4 7V4h16v3 M9 20h6 M12 4v16', pin: 'M12 22s-8-4.5-8-11.8A8 8 0 0112 2a8 8 0 018 8.2c0 7.3-8 11.8-8 11.8z M12 13a3 3 0 100-6 3 3 0 000 6z', fog: 'M3 15h13a4 4 0 100-8 6 6 0 00-11.5 2H3a3 3 0 000 6z M4 19h16M6 22h12',
  rect: 'M3 5h18v14H3z', circle: 'M12 21a9 9 0 100-18 9 9 0 000 18z', poly: 'M12 2l9 7-3.5 11h-11L3 9z', line: 'M4 20L20 4', path: 'M3 17c3-8 6-8 9 0s6 8 9 0',
  grid: 'M3 3h18v18H3z M3 9h18M3 15h18M9 3v18M15 3v18', fit: 'M8 3H5a2 2 0 00-2 2v3 M21 8V5a2 2 0 00-2-2h-3 M3 16v3a2 2 0 002 2h3 M16 21h3a2 2 0 002-2v-3', download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3', upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75', user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z', map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4z M8 2v16 M16 6v16',
  book: 'M4 19.5A2.5 2.5 0 016.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z', image: 'M3 5h18v14H3z M8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M21 15l-5-5L5 21', box: 'M21 8l-9-5-9 5v8l9 5 9-5z M3.3 7.9L12 13l8.7-5.1 M12 22V13',
  sword: 'M14.5 17.5L3 6V3h3l11.5 11.5 M13 19l6-6 M16 16l4 4 M19 21l2-2', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', bag: 'M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z M3 6h18 M16 10a4 4 0 01-8 0',
  flask: 'M9 3h6 M10 3v6l-5.5 9A2 2 0 006.2 21h11.6a2 2 0 001.7-3L14 9V3', star: 'M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z', tool: 'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z',
  coin: 'M12 22a10 10 0 100-20 10 10 0 000 20z M12 6v12 M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1.1-3 2.5 1.3 2.5 3 2.5 3 1.1 3 2.5-1.3 2.5-3 2.5-3-1.1-3-2.5', arrow: 'M5 12h14 M12 5l7 7-7 7', target: 'M12 22a10 10 0 100-20 10 10 0 000 20z M12 18a6 6 0 100-12 6 6 0 000 12z M12 14a2 2 0 100-4 2 2 0 000 4z',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z', heart: 'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z', check: 'M20 6L9 17l-5-5', search: 'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.35-4.35',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42', moon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z', wand: 'M15 4V2 M15 16v-2 M8 9h2 M20 9h2 M17.8 11.8L19 13 M17.8 6.2L19 5 M12.2 6.2L11 5 M3 21l9-9', scroll: 'M8 21h12a2 2 0 002-2v-2H10v2a2 2 0 11-4 0V5a2 2 0 10-4 0v3h4 M19 17V5a2 2 0 00-2-2H4', link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71 M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9', rotate: 'M23 4v6h-6 M20.49 15a9 9 0 11-2.12-9.36L23 10', up: 'M18 15l-6-6-6 6', down: 'M6 9l6 6 6-6', left: 'M15 18l-6-6 6-6', skull: 'M12 2a8 8 0 00-8 8c0 3 1.5 5 3 6v3h10v-3c1.5-1 3-3 3-6a8 8 0 00-8-8z M9 11h.01M15 11h.01 M10 16v3M14 16v3',
  hidden: 'M2 2l20 20 M12 5c7 0 10 7 10 7a15 15 0 01-3 4 M9.9 4.6A9 9 0 0112 4 M6.6 6.6C3.4 8.6 2 12 2 12s3 7 10 7c1.8 0 3.3-.4 4.6-1', clock: 'M12 22a10 10 0 100-20 10 10 0 000 20z M12 6v6l4 2', split: 'M16 3h5v5 M8 3H3v5 M21 3l-7 7 M3 3l7 7 M12 10v11', hands: 'M12 3l4 4-4 4-4-4z M4 13h16v8H4z',
};
window.icon = function (name, size = 16) {
  const p = ICONS[name] || ICONS.box;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.classList.add('ico');
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', p); svg.append(path);
  return svg;
};

// ---- Тема (светлая / тёмная) ----
window.Theme = {
  get() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; },
  set(t) { document.documentElement.dataset.theme = t; try { LS.setItem('et-theme', t); } catch { } document.querySelectorAll('.theme-btn').forEach(b => { b.innerHTML = ''; b.append(icon(t === 'light' ? 'moon' : 'sun')); b.title = t === 'light' ? 'Тёмная тема' : 'Светлая тема'; }); },
  toggle() { Theme.set(Theme.get() === 'light' ? 'dark' : 'light'); },
  button() { const t = Theme.get(); return el('button', { class: 'theme-btn', title: t === 'light' ? 'Тёмная тема' : 'Светлая тема', onclick: Theme.toggle }, icon(t === 'light' ? 'moon' : 'sun')); },
};
