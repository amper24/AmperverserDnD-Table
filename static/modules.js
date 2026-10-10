// ---------------------------------------------------------------------------
// modules.js — модель записей листа: предметы, заклинания, умения как
// переносимые документы; карточки, чат и inline-броски; редакторы записей.
// Даёт: window.Modules.
// Зависимости: common.js; лениво: DiceEngine, Equipment, Mechanics и
// CharacterBuilder (редактор выборов). Загружается в обеих страницах (слой 3).
// ---------------------------------------------------------------------------
// Модули: предметы и заклинания как переносимые документы; inline-броски; макросы; редакторы.
//
// Синтаксис в тексте (как в Foundry):  [[1d20+@atk]]{Атака}  [[2к6+@str]]  — становится кнопкой броска.
// Переменные: @str @dex @con @int @wis @cha (модификаторы), @prof, @level, @atk (лучшая атака), @atk_str, @atk_dex,
//             @spell (мод. заклинаний), @dc (СЛ заклинаний), @ac, @hp, @init. Без персонажа переменные = 0.
// Просто "3к6+2" или "1d8" в тексте тоже подсвечивается как кнопка.
window.Modules = (function () {
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const ITEM_TYPES = { weapon: 'Оружие', armor: 'Доспех', gear: 'Снаряжение', consumable: 'Расходник', magic: 'Магический', tool: 'Инструмент', treasure: 'Ценность', ammo: 'Боеприпас' };
  // иконки типов — имена SVG-иконок из common.js (icon(name)); it.icon может переопределить (1–2 символа текста)
  const ITEM_ICONS = { weapon: 'sword', armor: 'shield', gear: 'bag', consumable: 'flask', magic: 'star', tool: 'tool', treasure: 'coin', ammo: 'target' };
  const RARITIES = ['Обычный', 'Необычный', 'Редкий', 'Очень редкий', 'Легендарный', 'Артефакт'];
  const RARITY_COLORS = { 'Обычный': '#9aa0ad', 'Необычный': '#46a758', 'Редкий': '#3e9bff', 'Очень редкий': '#7c5cff', 'Легендарный': '#f5a524', 'Артефакт': '#e5484d' };
  const ACTION_KINDS = { attack: 'Атака', damage: 'Урон', heal: 'Лечение', save: 'Спасбросок', check: 'Проверка', other: 'Другое' };
  const ACTION_ICONS = { attack: 'target', damage: 'zap', heal: 'heart', save: 'shield', check: 'dice', other: 'dice' };
  const DAMAGE_TYPES = ['', 'рубящий', 'колющий', 'дробящий', 'огонь', 'холод', 'электричество', 'кислота', 'яд', 'звук', 'некротический', 'излучение', 'силовое поле', 'психический'];
  const SCHOOLS = ['Воплощение', 'Вызов', 'Иллюзия', 'Некромантия', 'Ограждение', 'Очарование', 'Преобразование', 'Прорицание'];
  // Основы для создания записи (шаг «Что создаём?»). Поля — стартовые значения, всё редактируется.
  const ITEM_PRESETS = [
    { id: 'weapon', name: 'Оружие', hint: 'Клинок, лук или посох: урон и тип атаки', fields: { type: 'weapon', name: 'Оружие' } },
    { id: 'armor', name: 'Доспех или щит', hint: 'Защита и класс доспеха', fields: { type: 'armor', name: 'Доспех' } },
    { id: 'consumable', name: 'Зелье или свиток', hint: 'Одноразовый эффект, расходуется при использовании', fields: { type: 'consumable', name: 'Зелье' } },
    { id: 'magic', name: 'Магический предмет', hint: 'Требует настройки, часто с зарядами', fields: { type: 'magic', name: 'Магический предмет', attunement: true } },
    { id: 'gear', name: 'Снаряжение', hint: 'Обычная вещь без механики: верёвка, факел, инструмент', fields: { type: 'gear', name: 'Снаряжение' } },
    { id: 'blank', name: 'С нуля', hint: 'Пустая форма, все поля по умолчанию', fields: {} },
  ];
  const SPELL_PRESETS = [
    { id: 'cantrip', name: 'Заговор', hint: 'Не тратит ячейки, работает на любом уровне', fields: { level: 0, cast_cost: 'free', name: 'Заговор' } },
    { id: 'spell1', name: 'Заклинание 1 круга', hint: 'Тратит ячейку своего круга или выше', fields: { level: 1, name: 'Заклинание' } },
    { id: 'spell3', name: 'Заклинание 3 круга', hint: 'Для средних по силе эффектов', fields: { level: 3, name: 'Заклинание' } },
    { id: 'ritual', name: 'Ритуал', hint: 'Можно сотворить без ячейки за дополнительное время', fields: { level: 1, ritual: true, name: 'Ритуал' } },
    { id: 'blank', name: 'С нуля', hint: 'Пустая форма, все поля по умолчанию', fields: {} },
  ];

  const ICONS_KNOWN = (n) => ['sword', 'shield', 'bag', 'flask', 'star', 'tool', 'coin', 'target', 'box', 'scroll', 'book'].includes(n);
  // ---------- модель ----------
  // null и undefined в записи не должны затирать значения по умолчанию (иначе в интерфейсе появляется «null»)
  const defined = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined));
  function fillDefaults(kind, obj) {
    const base = ({ item: newItem, spell: newSpell, feature: newFeature })[kind]({});
    for (const [k, v] of Object.entries(base)) if (k !== 'uid' && (obj[k] === null || obj[k] === undefined) && v !== null && v !== undefined) obj[k] = v;
    if (!obj.uid) obj.uid = uid();
    return obj;
  }
  function newItem(o = {}) {
    o = defined(o);
    return { uid: uid(), name: 'Предмет', type: 'gear', rarity: 'Обычный', qty: 1, weight: 0, cost: '', desc: '', equipped: false, attuned: false, attunement: false,
      charges: null, actions: [], tags: [], icon: '', asset_id: null, token_asset_id: null, source: '', ...o };
  }
  function newSpell(o = {}) {
    o = defined(o);
    return { uid: uid(), name: 'Заклинание', level: 1, school: 'Воплощение', casting_time: '1 действие', range: '60 фт', components: 'В, С', duration: 'Мгновенная',
      concentration: false, ritual: false, desc: '', prepared: false, cast_cost: null, use_cost: 1, uses: null, actions: [], asset_id: null, token_asset_id: null, effect_size: 1, source: '', ...o };
  }
  /// Умение / черта / особенность — тоже модуль: описание с кнопками, действия, заряды, картинка.
  function newFeature(o = {}) {
    o = defined(o);
    return { uid: uid(), name: 'Умение', text: '', actions: [], uses: null, asset_id: null, source: '', ...o };
  }
  /// Предмет справочника -> модуль инвентаря (с авто-действиями для оружия).
  function itemFromCompendium(e, ctx) {
    const d = e.data || {};
    const type = d.mechanics?.item_defaults?.type === 'ammo' ? 'ammo' : d.type === 'ammo' ? 'ammo' : d.type === 'consumable' ? 'consumable' : d.type === 'weapon' ? 'weapon' : d.type === 'armor' ? 'armor' : d.type === 'magic' ? 'magic' : /зелье|свиток|рацион/i.test(e.name) ? 'consumable' : /^(боеприпасы|ammunition)$/i.test(d.category || '') ? 'ammo' : 'gear';
    const it = newItem({ name: e.name, type, qty: d.qty ?? d.mechanics?.item_defaults?.qty ?? 1, rarity: d.rarity || 'Обычный', weight: d.qty===undefined ? (d.mechanics?.item_defaults?.unit_weight ?? d.weight ?? 0) : (d.weight || 0), cost: d.cost || '', desc: d.desc || '', source: e.source || '', asset_id: d.asset_id || null, token_asset_id: d.token_asset_id || null, attunement: !!d.attunement, tags: [d.category].filter(Boolean),
      mechanics: d.mechanics ? JSON.parse(JSON.stringify(d.mechanics)) : undefined, properties: d.properties || [], mastery: d.mastery || null, handedness: d.handedness, ammo_tag: d.ammo_tag ?? d.mechanics?.item_defaults?.ammo_tag, consume: d.consume ? JSON.parse(JSON.stringify(d.consume)) : undefined, actions: Array.isArray(d.actions) ? d.actions.map(a => ({ ...a })) : [] });
    if (type === 'weapon' && d.damage && !it.actions.length) {
      const props = d.properties || [];
      const fin = props.some(p => /Фехтовальное/.test(p)), ranged = /дальнобойное/i.test(d.category || '') || props.some(p => /Метательное|Боеприпас/.test(p));
      const ab = ranged && !props.some(p => /Метательное/.test(p)) ? 'dex' : fin ? 'fin' : 'str';
      const atk = ab === 'fin' ? '@atk' : ab === 'dex' ? '@atk_dex' : '@atk_str';
      const dmgMod = ab === 'fin' ? '@best' : '@' + ab;
      const dmg = String(d.damage).replace('к', 'd');
      it.actions = [{ name: 'Атака', kind: 'attack', roll: `1d20+${atk}` }, { name: `Урон (${d.damage_type || ''})`.replace(' ()', ''), kind: 'damage', roll: `${dmg}+${dmgMod}` }];
      const vers = props.find(p => /универсальное|versatile/i.test(p));
      if (vers) { const m = vers.match(/\((\d+[кd]\d+)\)/); if (m) it.actions.push({ name: 'Урон двумя руками', kind: 'damage', roll: `${m[1].replace('к', 'd')}+${dmgMod}`, grip: 'two' }); }
      it.desc = it.desc || [d.damage && `Урон ${d.damage} ${d.damage_type || ''}`, props.length && `Свойства: ${props.join(', ')}`].filter(Boolean).join('. ');
    }
    if (type === 'armor') { it.desc = it.desc || `КД ${d.ac}${d.stealth_disadvantage ? ', помеха на Скрытность' : ''}${d.str_req ? `, требуется Сила ${d.str_req}` : ''}`; it.ac = d.ac; if (d.str_req) it.str_req = d.str_req; if (d.stealth_disadvantage) it.stealth_disadvantage = true; }
    if (d.charges) it.charges = typeof d.charges==='object'?JSON.parse(JSON.stringify(d.charges)):{ cur: d.charges, max: d.charges, recharge: d.recharge || '' };
    return Equipment.normalize(it);
  }
  function spellFromCompendium(e) {
    const d = e.data || {};
    return newSpell({ name: e.name, level: d.level ?? 1, school: d.school || '', casting_time: d.casting_time || '', range: d.range || '', components: d.components || '', duration: d.duration || '',
      mechanics: d.mechanics ? JSON.parse(JSON.stringify(d.mechanics)) : undefined, classes: d.classes || [], concentration: !!d.concentration, ritual: !!d.ritual, desc: d.desc || '', source: e.source || '', cast_cost: d.cast_cost || null, use_cost: Math.max(1, Number(d.use_cost) || 1), uses: d.uses ? JSON.parse(JSON.stringify(d.uses)) : null, asset_id: d.asset_id || null, token_asset_id: d.token_asset_id || null, effect_size: d.effect_size || 1, actions: Array.isArray(d.actions) ? d.actions.map(a => ({ ...a })) : autoSpellActions(d) });
  }
  function autoSpellActions(d) {
    const acts = [];
    const txt = d.desc || '';
    if (/атака заклинанием|Дальнобойная атака|Рукопашная атака/i.test(txt)) acts.push({ name: 'Атака заклинанием', kind: 'attack', roll: '1d20+@spell' });
    const dm = txt.match(/(\d+к\d+(?:\s*\+\s*\d+)?)\s*(?:урона|хитов)?/);
    if (dm) acts.push({ name: /Восстанавливает|лечит/i.test(txt) ? 'Лечение' : 'Урон', kind: /Восстанавливает|лечит/i.test(txt) ? 'heal' : 'damage', roll: dm[1].replace(/\s/g, '').replace('к', 'd') + (/модификатор/i.test(txt) ? '+@spell' : '') });
    return acts;
  }

  // ---------- макросы ----------
  // Производные переменные модуля — данные: формулы грамматики Formulas, вычисляются по порядку,
  // каждая видит базовые переменные и уже вычисленные выше. Новая переменная — строка здесь, код менять не нужно.
  const DERIVED_VARS = [
    ['best', 'max(@str, @dex)'], ['atk', '@best + @prof'], ['atk_str', '@str + @prof'], ['atk_dex', '@dex + @prof'],
    ['spell', '@spell_mod + @prof'], ['dc', '8 + @prof + @spell_mod'], ['spell_dc', '8 + @prof + @spell_mod'], ['init', '@dex + @init_bonus'],
  ];
  // Допустимые имена — базовые переменные и уже вычисленные выше (не более).
  function derivedVars(base) {
    const F = window.Formulas;
    if (!F) throw new Error('formulas.js должен быть загружен до modules.js');
    const out = {};
    for (const [name, formula] of DERIVED_VARS) {
      const known = { ...base, ...out }, allowed = Object.fromEntries(Object.keys(known).map(k => [k, true]));
      const value = F.evaluate(formula, known, { allowed });
      out[name] = Number.isFinite(value) ? value : 0;
    }
    return out;
  }
  function ctxFromSheet(s) {
    if (!s) return {};
    const mod = v => Math.floor(((v ?? 10) - 10) / 2);
    const a = s.abilities || {};
    const prof = s.proficiency_bonus || Math.ceil(1 + (s.level || 1) / 4);
    const ab = { str: mod(a.str), dex: mod(a.dex), con: mod(a.con), int: mod(a.int), wis: mod(a.wis), cha: mod(a.cha) };
    const spAb = s.spells?.ability || 'int';
    const asList = v => Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).filter(k => v[k]) : [];
    const skillList = asList(s.skills), expList = asList(s.expertise);
    const base = { ...ab, prof, level: s.level || 1, spell_mod: ab[spAb], init_bonus: s.initiative_bonus || 0 };
    const ctx = { ...base, ...derivedVars(base),
      ac: s.ac || 10, hp: s.hp?.current || 0, hp_max: s.hp?.max || 0, speed: s.speed || 30, passive: 10 + ab.wis + (skillList.includes('perception') ? prof : 0) * (expList.includes('perception') ? 2 : 1),
      name: s.name || '', class: s.class || '', race: s.race || '', half_level: Math.floor((s.level || 1) / 2) };
    for (const k of Object.keys(ab)) ctx['save_' + k] = ab[k] + ((s.saving_throws || []).includes(k) ? prof : 0);
    for (const [k, , a] of (window.SKILLS || [])) ctx[k] = ab[a] + (expList.includes(k) ? 2 : skillList.includes(k) ? 1 : 0) * prof;
    return ctx;
  }
  function resolve(expr, ctx = {}) {
    let out = String(expr).replace(/@([a-z_]+)/gi, (_, k) => { const v = ctx[k.toLowerCase()]; return v === undefined || typeof v !== 'number' ? '0' : String(v); });
    out = out.replace(/\+\s*-/g, '-').replace(/к/g, 'd').replace(/\s+/g, '').replace(/([+-])0(?=[+\-]|$)/g, '');
    // схлопываем константы "+5+2" оставляем — сервер посчитает
    return out;
  }
  // Извлекает целые формулы, в том числе несколько костей в одном выражении:
  // «1d6+1d4+3» — одна кнопка, а не три отдельных броска.
  const DICE_RE = /[+\-−]?\d*[dк]\d+(?:k[hl]\d+)?(?:\s*[+\-−]\s*(?:\d*[dк]\d+(?:k[hl]\d+)?|\d+|@[a-z_]+))*/gi;
  const FORMULA_WORD = /[\p{L}\p{N}_]/u;
  function diceExpressions(text) {
    const source = String(text || ''), out = [];
    DICE_RE.lastIndex = 0;
    let m;
    while ((m = DICE_RE.exec(source))) {
      const expr = m[0].replace(/\s+/g, '').replace(/−/g, '-');
      const before = source[m.index - 1] || '', after = source[m.index + m[0].length] || '';
      if ((before && FORMULA_WORD.test(before) && !expr.startsWith('-')) || (after && FORMULA_WORD.test(after))) continue;
      out.push({ expr, index: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  // ---------- броски: единый канал ----------
  /// Преимущество/помеха: первый d20, либо все кости формулы без d20, получают keep high/low.
  const withMode = (expr, mode) => DiceEngine.withMode(expr, mode);
  /// Режим броска по клавишам-модификаторам: Alt — преимущество, Ctrl — помеха, Shift — только мастеру.
  function modeFromEvent(e) { return { mode: e?.altKey && (e?.ctrlKey || e?.metaKey) ? 'normal' : e?.altKey ? 'adv' : e?.ctrlKey || e?.metaKey ? 'dis' : 'normal', gm_only: !!e?.shiftKey }; }
  function roll(expr, label, opts = {}) {
    const ctx = opts.ctx || window.SHEET_CTX || {};
    const resolved = withMode(resolve(expr, ctx), opts.mode);
    const msg = { type: 'roll', expr: resolved, label: label || expr, kind: opts.kind || 'other', gm_only: !!opts.gm_only };
    return DiceEngine.submit(msg);
  }
  /// Связка бросков (атака + урон + …) одним сообщением. Сервер удвоит кости урона при крите.
  function rollMulti(actions, label, opts = {}) {
    const ctx = opts.ctx || window.SHEET_CTX || {};
    const rolls = actions.filter(a => a.roll).map(a => ({ name: a.name || ACTION_KINDS[a.kind] || 'Бросок', kind: a.kind || 'other', dtype: a.dtype || null,
      expr: withMode(resolve(a.roll, ctx), opts.mode) }));
    if (!rolls.length) return;
    const msg = { type: 'multi', label: label || '', rolls, gm_only: !!opts.gm_only };
    return DiceEngine.submit(msg);
  }
  /// Рендер связки бросков в чате.
  function renderMulti(p) { return DiceEngine.renderResult(p); }
  function sendCard(card) {
    const msg = { type: 'card', card };
    if (window.TABLE_CTX?.ws) return window.TABLE_CTX.ws.send(msg);
    if (window.parent !== window) return window.parent.postMessage(msg, '*');
    if (window.opener && !window.opener.closed) return window.opener.postMessage(msg, '*');
    toast('Карточка отправляется в чат только на столе');
  }

  // ---------- rich text: [[expr]]{label} + авто-кубики ----------
  function rich(text, ctx, opts = {}) {
    const wrap = el('span', { class: 'rich' });
    if (!text) return wrap;
    if(opts.prose){wrap.append(textNode(String(text)));return wrap;}
    const parts = String(text).split(/(\[\[[^\]]+\]\](?:\{[^}]*\})?|\{\{[^}]+\}\})/g);
    for (const p of parts) {
      const m = p.match(/^\[\[([^\]]+)\]\](?:\{([^}]*)\})?$/);
      if (m) { wrap.append(rollBtn(m[1].trim(), m[2] || m[1].trim(), ctx, opts)); continue; }
      // {{@dc}} — подстановка значения из листа (Сл {{@dc}}, +{{@prof}}); {{текст}} — выделение
      const v = p.match(/^\{\{([^}]+)\}\}$/);
      if (v) { const inner = v[1].trim(); const isVar = /^@[a-z_]+$/i.test(inner) || /@[a-z_]+/i.test(inner) && /^[-+*\d\s@a-z_]+$/i.test(inner); wrap.append(el('b', { class: 'inline-val', title: inner }, isVar ? evalConst(inner, ctx) : inner)); continue; }
      // Автоссылки охватывают полную формулу: несколько костей и модификаторов бросаются вместе.
      let last = 0;
      for (const match of diceExpressions(p)) {
        if (match.index > last) wrap.append(textNode(p.slice(last, match.index)));
        wrap.append(rollBtn(match.expr, match.expr, ctx, { ...opts, auto: true }));
        last = match.end;
      }
      if (last < p.length) wrap.append(textNode(p.slice(last)));
    }
    return wrap;
  }
  /// Вычисляет константное выражение вида "8+@prof+@wis" (без кубиков) для показа значения в тексте.
  function evalConst(expr, ctx) {
    const r = resolve(expr, ctx || {});
    if (!/^[-+*\d\s()]+$/.test(r)) return r;
    try { return String(Function('"use strict";return (' + r + ')')()); } catch { return r; }
  }
  function textNode(t) { const f = document.createDocumentFragment(); const lines = t.split('\n'); lines.forEach((l, i) => { f.append(document.createTextNode(l)); if (i < lines.length - 1) f.append(el('br')); }); return f; }
  function rollBtn(expr, label, ctx, opts = {}) {
    const shown = ctx ? resolve(expr, ctx) : expr;
    const b = el('button', { class: 'inline-roll' + (opts.auto ? ' auto' : ''), title: `Бросить ${shown}`, onclick: (e) => { e.stopPropagation(); e.preventDefault(); roll(expr, (opts.prefix ? opts.prefix + ': ' : '') + label, { ctx, ...modeFromEvent(e) }); } }, icon('dice', 12), ' ', label === expr ? shown : label);
    return b;
  }

  /// Строка атаки в стиле листов D&D: название, кнопка попадания и кнопка урона.
  /// hit / damage: { expr, dtype, kind, index? }; index нужен, если бросок идёт через onUse (инвентарь).
  // Правый клик по кнопке броска: обычный бросок, преимущество или помеха (как в листе).
  let activeModeMenu = null, modeMenuCleanup = null;
  function closeModeMenu() {
    modeMenuCleanup?.(); modeMenuCleanup = null;
    activeModeMenu?.remove(); activeModeMenu = null;
  }
  function openModeMenu(event, label, pick) {
    event.preventDefault(); event.stopPropagation();
    closeModeMenu();
    const menu = el('div', { class: 'roll-mode-menu', role: 'menu', 'aria-label': `Режим броска: ${label}` });
    for (const [mode, text] of [['normal', 'Обычный бросок'], ['dis', 'С помехой'], ['adv', 'С преимуществом']]) menu.append(el('button', {
      type: 'button', class: 'roll-mode-option' + (mode === 'normal' ? ' normal' : ''), role: 'menuitem',
      onclick: () => { closeModeMenu(); pick({ mode, gm_only: false }); }
    }, text));
    document.body.append(menu);
    activeModeMenu = menu;
    const margin = 8, rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin))}px`;
    const onDown = e => { if (!menu.contains(e.target)) closeModeMenu(); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); closeModeMenu(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    modeMenuCleanup = () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }
  function attackRow(name, hit, damage, ctx, prefix, options = {}) {
    const row = el('div', { class: 'attack-row' });
    const label = text => (prefix ? prefix + ': ' : '') + text;
    const mk = (action, cls, caption) => {
      const shown = ctx ? resolve(action.expr, ctx) : action.expr;
      const fire = mode => {
        if (options.onUse && action.index !== undefined) return options.onUse([action.index], mode);
        roll(action.expr, label(action.name || caption), { ctx, kind: action.kind, ...mode });
      };
      return el('button', { class: 'act-btn ' + cls, disabled: options.disabled ? '' : null,
        title: [shown, action.dtype, options.note, 'Alt — преимущество, Ctrl — помеха, Shift — только мастеру, правая кнопка — выбрать режим'].filter(Boolean).join('\n'),
        onclick: e => { e.stopPropagation(); fire(modeFromEvent(e)); },
        oncontextmenu: e => openModeMenu(e, label(action.name || caption), fire) },
        icon(cls === 'attack' ? 'target' : 'zap', 13), ' ', caption, el('small', {}, ' ' + shown));
    };
    if (name) row.append(el('span', { class: 'attack-row-name' }, name));
    if (hit) row.append(mk(hit, 'attack', 'Попадание'));
    if (damage) row.append(mk(damage, 'damage', 'Урон'));
    return row;
  }

  // ---------- карточка предмета / заклинания (общая для листа, чата, справочника) ----------
  /// Иконка предмета: элемент. it.icon — короткий текст (1–2 символа) поверх стандартной иконки типа.
  function itemIcon(it) {
    if (it?.asset_id) { const w = el('span', { class: 'img-ico' }); assetURL(it.asset_id).then(u => w.append(el('img', { src: u, alt: '' }))).catch(() => w.append(icon(ITEM_ICONS[it?.type] || 'box', 18))); return w; }
    return it?.icon ? el('span', { class: 'txt-ico' }, String(it.icon).slice(0, 2)) : icon(ITEM_ICONS[it?.type] || 'box', 18);
  }
  /// Иконка любого модуля: картинка, иначе стандартная иконка по типу.
  function docIcon(doc, fallback = 'scroll', size = 18) {
    if (doc?.asset_id) { const w = el('span', { class: 'img-ico' }); assetURL(doc.asset_id).then(u => w.append(el('img', { src: u, alt: '' }))).catch(() => w.append(icon(fallback, size))); return w; }
    return icon(fallback, size);
  }
  function itemIconName(it) { return ITEM_ICONS[it?.type] || 'box'; }
  function actionButtons(doc, ctx, prefix, options = {}) {
    if (doc.mechanics && window.Mechanics) return Mechanics.buttons(doc, { ...options, context: ctx });
    const row = el('div', { class: 'actions-row' });
    const usable = options.item ? Equipment.activeActions(doc) : (doc.actions || []).map((a, index) => ({ ...a, index }));
    const rollable = usable.filter(a => a.roll), paired = new Set();
    for (let i = 0; i < rollable.length; i++) {
      if (paired.has(i)) continue;
      const a = rollable[i];
      // Атака и её урон — одна строка: две кнопки, как на листах D&D.
      const j = a.kind === 'attack' ? rollable.findIndex((b, k) => k > i && !paired.has(k) && b.kind === 'damage') : -1;
      if (j >= 0) {
        paired.add(i); paired.add(j);
        const d = rollable[j];
        const line = attackRow(a.name || d.name || doc.name,
          { expr: a.roll, dtype: a.dtype, kind: 'attack', index: a.index, name: a.name },
          { expr: d.roll, dtype: d.dtype, kind: 'damage', index: d.index, name: d.name }, ctx, prefix, options);
        const fireAll = mode => { if (options.onUse) return options.onUse([a.index, d.index], mode); rollMulti([a, d], prefix || doc.name, { ctx, ...mode }); };
        line.append(el('button', { disabled: options.disabled ? '' : null, class: 'act-btn all', title: 'Попадание и урон одной связкой: при критическом попадании кости урона удваиваются.\nAlt — преимущество, Ctrl — помеха, Shift — только мастеру, правая кнопка — выбрать режим',
          onclick: e => { e.stopPropagation(); fireAll(modeFromEvent(e)); },
          oncontextmenu: e => openModeMenu(e, prefix || doc.name, fireAll) }, icon('dice', 13), ' Всё'));
        row.append(line);
        continue;
      }
      const tip = [resolve(a.roll, ctx || {}), a.dtype, a.note].filter(Boolean).join(' · ') + '\nAlt — преимущество, Ctrl — помеха, Shift — только мастеру';
      const fireOne = mode => { if (options.onUse) return options.onUse([a.index], mode); roll(a.roll, `${prefix ? prefix + ': ' : ''}${a.name || a.kind}${a.dtype ? ' (' + a.dtype + ')' : ''}`, { ctx, kind: a.kind, ...mode }); };
      row.append(el('button', { disabled: options.disabled ? '' : null, class: 'act-btn ' + (a.kind || 'other'), title: tip.replace('Shift — только мастеру', 'Shift — только мастеру, правая кнопка — выбрать режим'), onclick: (e) => { e.stopPropagation(); fireOne(modeFromEvent(e)); },
        oncontextmenu: e => openModeMenu(e, `${prefix ? prefix + ': ' : ''}${a.name || a.kind}`, fireOne) },
        icon(ACTION_ICONS[a.kind] || 'dice', 13), ' ', a.name || ACTION_KINDS[a.kind] || 'Бросок', el('small', {}, ' ' + resolve(a.roll, ctx || {}))));
    }
    const rest = rollable.filter((a, i) => !paired.has(i));
    if (rest.length > 1) row.append(el('button', { disabled: options.disabled ? '' : null, class: 'act-btn all', title: 'Бросить всё одной связкой: ' + rest.map(a => a.name || ACTION_KINDS[a.kind]).join(' → ') + '. При крите атаки кости урона удваиваются.\nAlt — преимущество, Ctrl — помеха, Shift — только мастеру', onclick: e => { e.stopPropagation(); if (options.onUse) return options.onUse(rest.map(a => a.index), modeFromEvent(e)); rollMulti(rest, prefix || doc.name, { ctx, ...modeFromEvent(e) }); } }, icon('dice', 13), ' Всё'));
    if (doc.save_dc || doc.save_ability) row.append(el('span', { class: 'chip' }, `СЛ ${doc.save_dc || '@dc'} ${doc.save_ability || ''}`));
    return row;
  }
  function itemCardBody(it, ctx, opts = {}) {
    const meta = [ITEM_TYPES[it.type], it.rarity && it.rarity !== 'Обычный' ? it.rarity : null, it.weight ? `${it.weight} фнт` : null, it.cost || null, it.attunement ? 'настройка' : null].filter(Boolean).join(' · ');
    const body = el('div', { class: 'card-body' },
      el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, itemIcon(it)), el('div', { class: 'grow' }, el('b', { style: `color:${RARITY_COLORS[it.rarity] || 'inherit'}` }, it.name), el('div', { class: 'muted small' }, meta)), it.qty > 1 ? el('span', { class: 'badge' }, '×' + it.qty) : null),
      it.charges ? el('div', { class: 'small muted' }, `Заряды: ${it.charges.cur}/${it.charges.max}${it.charges.recharge ? ' (' + it.charges.recharge + ')' : ''}`) : null,
      it.desc ? el('div', { class: 'card-desc' }, rich(it.desc, ctx, { prose:!!it.mechanics, prefix: it.name })) : null,
      it.mechanics?Mechanics.preview(it.mechanics,ctx):null, actionButtons(it, ctx, it.name));
    return body;
  }
  function spellCardBody(sp, ctx) {
    const meta = [sp.level === 0 ? 'Заговор' : `${sp.level} круг`, sp.school, sp.casting_time, sp.range, sp.components, (sp.concentration ? 'Концентрация, ' : '') + (sp.duration || ''), sp.ritual ? 'ритуал' : null].filter(Boolean).join(' · ');
    return el('div', { class: 'card-body' },
      el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, docIcon(sp, 'star')), el('div', { class: 'grow' }, el('b', {}, sp.name), el('div', { class: 'muted small' }, meta))),
      sp.desc ? el('div', { class: 'card-desc' }, rich(sp.desc, ctx, { prose:!!sp.mechanics, prefix: sp.name })) : null,
      sp.mechanics?Mechanics.preview(sp.mechanics,ctx):null, actionButtons(sp, ctx, sp.name));
  }
  function toChatCard(doc, kind) {
    return { mechanics:doc.mechanics, name: doc.name, kind, desc: doc.desc || '', actions: (doc.actions || []).map(a => ({ name: a.name, kind: a.kind, roll: a.roll })), icon: kind === 'spell' ? 'star' : (doc.icon || itemIconName(doc)), asset_id: doc.asset_id || null,
      ...(kind === 'spell' && doc.spell_ability ? { spell_ability: doc.spell_ability } : {}),
      meta: kind === 'spell' ? [doc.level === 0 ? 'Заговор' : `${doc.level} круг`, doc.school, doc.casting_time, doc.range, doc.duration].filter(Boolean).join(' · ') : [ITEM_TYPES[doc.type], doc.rarity].filter(Boolean).join(' · ') };
  }
  function spellContext(ctx, ability) {
    if (!ability || typeof ctx?.[ability] !== 'number') return ctx || {};
    const mod = ctx[ability], prof = Number(ctx.prof) || 0, dc = 8 + prof + mod;
    return { ...ctx, spell_mod: mod, spell: mod + prof, dc, spell_dc: dc };
  }
  function renderChatCard(card, ctx) {
    const cardCtx = card.kind === 'spell' ? spellContext(ctx, card.spell_ability) : ctx;
    return el('div', { class: 'chat-card' },
      el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, card.asset_id ? docIcon(card, 'box') : card.icon && ICONS_KNOWN(card.icon) ? icon(card.icon, 18) : card.icon ? el('span', { class: 'txt-ico' }, String(card.icon).slice(0, 2)) : icon('box', 18)), el('div', { class: 'grow' }, el('b', {}, card.name), el('div', { class: 'muted small' }, card.meta || ''))),
      card.desc ? el('div', { class: 'card-desc' }, rich(card.desc, cardCtx, { prefix: card.name })) : null,
      card.item_ref ? el('a', { class: 'btn small', href: '/sheet/' + encodeURIComponent(card.item_ref.character_id), target: '_blank' }, 'Открыть лист · использовать с расходом') : actionButtons(card, cardCtx, card.name));
  }

  // ---------- выбор изображения (инвентарь) и токена (карта) для модуля ----------
  /// imagePicker(doc, 'asset_id', { kind: 'item', label: 'Изображение' }) — превью + загрузка / из библиотеки / убрать.
  function imagePicker(doc, key, o = {}) {
    const kind = o.kind || window.AssetKinds.forUsage('item'), tokenKind = window.AssetKinds.forUsage('token');
    const box = el('div', { class: 'imgpick' + (o.compact ? ' compact' : '') });
    const prev = el('div', { class: 'imgpick-prev' });
    const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    const draw = () => { prev.innerHTML = ''; if (doc[key]) assetURL(doc[key]).then(u => prev.append(el('img', { src: u }))).catch(() => prev.append(icon('image'))); else prev.append(icon(o.icon || 'image', 22)); };
    file.addEventListener('change', async () => { const f = file.files[0]; if (!f) return; try { const fd = new FormData(); fd.append('file', f); fd.append('kind', kind); fd.append('name', (doc.name || o.label || 'image') + (kind === tokenKind ? ' (токен)' : '')); if (o.campaignId) fd.append('campaign_id', o.campaignId); const a = await API.upload('/api/assets', fd); doc[key] = a.id; draw(); o.onChange && o.onChange(a.id); } catch (e) { toast('Ошибка: ' + e.message, 4000); } file.value = ''; });
    const fromLib = async () => {
      const list = await API.get('/api/assets' + (kind === tokenKind ? '?kind=' + tokenKind : ''));
      const grid = el('div', { class: 'asset-grid pick' });
      let chosen = null;
      for (const a of list) { const t = el('div', { class: 'asset', onclick: () => { grid.querySelectorAll('.asset').forEach(x => x.classList.remove('active')); t.classList.add('active'); chosen = a.id; } }, el('div', { class: 'thumb' }), el('div', { class: 'small ellipsis', title: a.name }, a.name)); assetURL(a.id).then(u => t.querySelector('.thumb').append(el('img', { src: u }))); grid.append(t); }
      const ok = await modal('Библиотека ресурсов', el('div', { style: 'max-height:60vh;overflow:auto' }, list.length ? grid : el('p', { class: 'muted' }, 'Пусто — загрузите изображение.')), [{ label: 'Выбрать', cls: 'primary', fn: () => chosen || false }], { wide: true });
      if (ok) { doc[key] = ok; draw(); o.onChange && o.onChange(ok); }
    };
    box.append(prev, el('div', { class: 'imgpick-btns' }, el('span', { class: 'muted small' }, o.label || 'Изображение'), el('div', { class: 'row', style: 'gap:4px' },
      el('button', { class: 'small', onclick: () => file.click() }, 'Загрузить'), el('button', { class: 'small', onclick: fromLib }, 'Из библиотеки'), el('button', { class: 'small', onclick: () => { doc[key] = null; draw(); o.onChange && o.onChange(null); } }, 'Убрать')), file));
    draw();
    return box;
  }
  /// Пара «картинка для инвентаря + токен для карты».
  function visualsRow(doc, o = {}) {
    return el('div', { class: 'row visuals' }, imagePicker(doc, 'asset_id', { kind: window.AssetKinds.forUsage('item'), label: o.imageLabel || 'Изображение (карточка, инвентарь)', icon: o.icon }), o.noToken ? null : imagePicker(doc, 'token_asset_id', { kind: window.AssetKinds.forUsage('token'), label: o.tokenLabel || 'Токен на карте', icon: 'map' }));
  }

  // ---------- редактор действий (кнопок бросков) ----------
  function actionsEditor(doc) { return Mechanics.editor(doc,{category:'feature'}); }
  function descEditor(doc, key='desc') {
    return el('div', {}, el('textarea', {class:'description-only', rows:6, oninput:e=>doc[key]=e.target.value}, doc[key]||''), el('p',{class:'muted small'},'Художественное описание и пояснения. Броски, расходы и эффекты задаются отдельно — блоками ниже.'));
  }
  // Раздел формы: сворачиваемый блок. Пустые разделы по умолчанию можно свернуть, чтобы не мешать.
  const section = (title, open, ...nodes) => el('details', { class: 'form-section', open: open ? '' : null }, el('summary', {}, title), el('div', { class: 'form-section-body' }, ...nodes));
  // Выбор основы для новой записи: поля заполняются, всё можно поправить в форме.
  function pickPreset(title, presets) {
    let chosen = presets[0];
    const group = 'preset-' + uid();
    const tiles = el('div', { class: 'preset-grid', role: 'radiogroup' }, ...presets.map((p, i) => el('label', { class: 'preset-tile' },
      el('input', { type: 'radio', name: group, value: p.id, checked: i === 0 ? '' : null, onchange: () => { chosen = p; } }),
      el('b', {}, p.name), el('span', { class: 'muted small' }, p.hint))));
    return modal(title, el('div', {}, el('p', { class: 'muted small' }, 'Выберите основу. Поля заполнятся сами, их можно поменять на следующем шаге.'), tiles),
      [{ label: 'Далее', cls: 'primary', fn: () => chosen }], { wide: true });
  }
  async function editItem(item, opts = {}) {
    const fresh = !item;
    if (fresh && !opts.noPresets) { const preset = await pickPreset('Что создаём?', ITEM_PRESETS); if (!preset) return null; item = newItem(preset.fields); }
    const it = Equipment.normalize(JSON.parse(JSON.stringify(item || newItem())));
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const form = el('div', { class: 'editor-form' },
      section('Основное', true,
        el('div', { class: 'row' }, f('Название', el('input', { value: it.name, oninput: e => it.name = e.target.value })), f('Метка (1–2 символа)', el('input', { value: it.icon || '', placeholder: '—', maxlength: 2, style: 'width:70px', oninput: e => it.icon = e.target.value }))),
        el('div', { class: 'row' },
          f('Тип', el('select', { onchange: e => it.type = e.target.value }, ...Object.entries(ITEM_TYPES).map(([k, v]) => el('option', { value: k, selected: it.type === k ? '' : null }, v)))),
          f('Редкость', el('select', { onchange: e => it.rarity = e.target.value }, ...RARITIES.map(r => el('option', { value: r, selected: it.rarity === r ? '' : null }, r)))),
          f('Кол-во', el('input', { type: 'number', min: 0, max: 1000000, step: 1, value: it.qty, oninput: e => it.qty = +e.target.value })),
          f('Вес (фнт)', el('input', { type: 'number', step: '0.1', value: it.weight, oninput: e => it.weight = +e.target.value })),
          f('Цена', el('input', { value: it.cost || '', placeholder: '15 зм', oninput: e => it.cost = e.target.value }))),
        el('div', { class: 'row' },
          f('Теги', el('input', { value: (it.tags || []).join(', '), placeholder: 'через запятую', oninput: e => it.tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean) })),
          el('label', { style: 'align-self:end;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: it.attunement ? '' : null, onchange: e => it.attunement = e.target.checked }), ' Требует настройки'))),
      section('Заряды', !!it.charges, el('p', { class: 'muted small' }, 'Заряды на весь стак, например 5 зарядов у жезла. Восстановление — текстом, как в книге правил.'),
        el('div', { class: 'row' },
          f('Заряды стопки (макс)', el('input', { type: 'number', value: it.charges?.max ?? '', placeholder: '—', oninput: e => { const v = +e.target.value; it.charges = v > 0 ? { cur: Math.min(it.charges?.cur ?? v, v), max: v, recharge: it.charges?.recharge || '' } : null; } })),
          f('Восстановление', el('input', { value: it.charges?.recharge || '', placeholder: 'на рассвете 1d6+1', oninput: e => { if (it.charges) it.charges.recharge = e.target.value; } })))),
      section('Описание', true, f('Описание', descEditor(it))),
      section('Внешний вид на карте', !!(it.asset_id || it.token_asset_id), visualsRow(it, { tokenLabel: 'Токен на карте (лут / предмет на столе)' })),
      section('Снаряжение', true, Equipment.editor(it, opts.inventory)),
      section('Механика', true, Mechanics.editor(it, { category: 'item', inventory: opts.inventory })));
    return modal(opts.title || (fresh ? 'Новый предмет' : 'Редактировать предмет'), form, [{ label: 'Сохранить', cls: 'primary', fn: () => { const error = Equipment.validate(it) || Mechanics.validate(it.mechanics); if (error) { toast(error); return false; } return it; } }], { wide: true });
  }
  async function editSpell(spell, opts = {}) {
    const fresh = !spell;
    if (fresh && !opts.noPresets) { const preset = await pickPreset('Что создаём?', SPELL_PRESETS); if (!preset) return null; spell = newSpell(preset.fields); }
    const sp = JSON.parse(JSON.stringify(spell || newSpell()));
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const cost = el('select', {}, ...[['slot', 'Ячейка заклинания по уровню'], ['free', 'Без расхода'], ['uses', 'Заряды заклинания']].map(([value, label]) => el('option', { value, selected: (sp.cast_cost || (Number(sp.level) === 0 ? 'free' : 'slot')) === value ? '' : null }, label)));
    const usesMax = el('input', { type: 'number', min: 1, max: 999, value: sp.uses?.max ?? '', placeholder: 'например, 1' });
    const usesCur = el('input', { type: 'number', min: 0, max: 999, value: sp.uses?.cur ?? sp.uses?.max ?? '', placeholder: 'текущий запас' });
    const useCost = el('input', { type: 'number', min: 1, max: 999, value: sp.use_cost || 1 });
    const recharge = el('select', {}, ...[['', 'не восстанавливается'], ['short', 'короткий отдых'], ['long', 'долгий отдых'], ['dawn', 'на рассвете']].map(([value, label]) => el('option', { value, selected: (sp.uses?.recharge || '') === value ? '' : null }, label)));
    const level = el('select', { onchange: e => { const old = Number(sp.level), next = +e.target.value; sp.level = next; if (next === 0 && cost.value === 'slot') cost.value = 'free'; else if (old === 0 && next > 0 && cost.value === 'free') cost.value = 'slot'; } }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(l => el('option', { value: l, selected: sp.level === l ? '' : null }, l === 0 ? 'Заговор' : l)));
    const form = el('div', { class: 'editor-form' },
      section('Основное', true,
        el('div', { class: 'row' }, f('Название', el('input', { value: sp.name, oninput: e => sp.name = e.target.value })), f('Круг', level),
          f('Школа', el('select', { onchange: e => sp.school = e.target.value }, ...SCHOOLS.map(s => el('option', { value: s, selected: sp.school === s ? '' : null }, s))))),
        el('div', { class: 'row' }, f('Время', el('input', { value: sp.casting_time, oninput: e => sp.casting_time = e.target.value })), f('Дистанция', el('input', { value: sp.range, oninput: e => sp.range = e.target.value })), f('Компоненты', el('input', { value: sp.components, oninput: e => sp.components = e.target.value })), f('Длительность', el('input', { value: sp.duration, oninput: e => sp.duration = e.target.value }))),
        el('div', { class: 'row' }, el('label', {}, el('input', { type: 'checkbox', style: 'width:auto', checked: sp.concentration ? '' : null, onchange: e => sp.concentration = e.target.checked }), ' Концентрация'), el('label', {}, el('input', { type: 'checkbox', style: 'width:auto', checked: sp.ritual ? '' : null, onchange: e => sp.ritual = e.target.checked }), ' Ритуал'),
          f('Классы', el('input', { value: (sp.classes || []).join(', '), placeholder: 'через запятую', oninput: e => sp.classes = e.target.value.split(',').map(s => s.trim()).filter(Boolean) })))),
      section('Расход', true,
        el('div', { class: 'row' }, f('Расход при сотворении', cost), f('Расход зарядов', useCost), f('Заряды макс.', usesMax), f('Текущие заряды', usesCur), f('Восстановление', recharge)),
        el('p', { class: 'muted small' }, 'Обычное заклинание тратит одну ячейку не ниже своего круга; заговоры не тратят ячейки. Заряды — для собственных исключений или особых ресурсов.')),
      section('Описание', true, f('Описание', descEditor(sp))),
      section('Внешний вид и эффект', !!(sp.asset_id || sp.token_asset_id) || sp.effect_size > 1, el('div', { class: 'row' }, visualsRow(sp, { icon: 'star', tokenLabel: 'Токен эффекта на карте (область, призыв)' }), f('Размер эффекта (клеток)', el('input', { type: 'number', min: 1, max: 20, step: 1, value: sp.effect_size || 1, style: 'width:90px', oninput: e => sp.effect_size = Math.max(1, +e.target.value || 1) })))),
      section('Механика', true, Mechanics.editor(sp, { category: 'spell', inventory: opts.inventory })));
    return modal(opts.title || (fresh ? 'Новое заклинание' : 'Редактировать заклинание'), form, [{ label: 'Сохранить', cls: 'primary', fn: () => {
      const error = Mechanics.validate(sp.mechanics); if (error) { toast(error); return false; }
      const max = Number(usesMax.value), current = usesCur.value.trim() === '' ? max : Number(usesCur.value), amount = Number(useCost.value) || 1;
      if (cost.value === 'uses' && (!Number.isInteger(max) || max < 1 || !Number.isInteger(current) || current < 0 || current > max || !Number.isInteger(amount) || amount < 1 || amount > max)) { toast('Для расхода заряда укажите корректные текущие и максимальные значения, а также стоимость применения.'); return false; }
      sp.cast_cost = cost.value; sp.use_cost = Math.max(1, amount);
      sp.uses = max > 0 ? { max, cur: Math.min(current || 0, max), recharge: recharge.value } : null;
      if (Number(sp.level) === 0 && sp.cast_cost === 'slot') sp.cast_cost = 'free';
      return sp;
    } }], { wide: true });
  }
  /// Редактор умения/черты (модуль: картинка, заряды, описание с кнопками, действия).
  function editFeature(feature, opts = {}) {
    const d = JSON.parse(JSON.stringify(feature || newFeature())); d.actions ||= [];
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const usesMax = el('input', { type: 'number', value: d.uses?.max ?? '', placeholder: '—' });
    const recharge = el('select', {}, ...[['', 'не восстанавливается'], ['short', 'короткий отдых'], ['long', 'длинный отдых'], ['dawn', 'на рассвете']].map(([k, v]) => el('option', { value: k, selected: (d.uses?.recharge || '') === k ? '' : null }, v)));
    const form = el('div', { class: 'editor-form' },
      el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:3' }, el('label', {}, 'Название'), el('input', { value: d.name, oninput: e => d.name = e.target.value })), f('Источник', el('input', { value: d.source || '', placeholder: 'Класс / раса / черта', oninput: e => d.source = e.target.value })), f('Использований', usesMax), f('Восстановление', recharge)),
      visualsRow(d, { icon: 'scroll', noToken: true }),
      f('Описание', descEditor(d, 'text')), Mechanics.editor(d, {category:'feature',inventory:opts.inventory}));
    return modal(opts.title || (feature ? 'Изменить умение' : 'Новое умение'), form, [{ label: 'Сохранить', cls: 'primary', fn: () => { const error=Mechanics.validate(d.mechanics); if(error){toast(error);return false;} const um = +usesMax.value; d.uses = um > 0 ? { cur: Math.min(d.uses?.cur ?? um, um), max: um, recharge: recharge.value } : null; return d; } }], { wide: true });
  }
  /// Универсальный редактор записи справочника для остальных категорий (черты/состояния/монстры/расы…): поля + JSON.
  function editGeneric(entry, category, gopts = {}) {
    const d = JSON.parse(JSON.stringify(entry?.data || { desc: '' }));
    if (gopts.folder && !d.folder) d.folder = gopts.folder;
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const state = { name: entry?.name || '' };
    // Класс и раса — не объекты на карте: у них только изображение карточки, токена нет.
    const NO_TOKEN = category === 'race' || category === 'class';
    if (!entry && !d.mechanics) { const starter = window.Mechanics?.starter?.(category); if (starter) d.mechanics = starter; }
    const simple = el('div', {}, f('Название', el('input', { value: state.name, oninput: e => state.name = e.target.value })),
      visualsRow(d, { noToken: NO_TOKEN, imageLabel: NO_TOKEN ? 'Изображение (карточка справочника)' : undefined, tokenLabel: category === 'monster' ? 'Токен монстра на карте' : 'Токен на карте' }));
    if (gopts.folders && gopts.folders.length) simple.append(f('Папка в наборе', el('select', { onchange: e => { if (e.target.value) d.folder = e.target.value; else delete d.folder; } }, el('option', { value: '' }, '— без папки'), ...gopts.folders.map(x => el('option', { value: x, selected: d.folder === x ? '' : null }, x)))));
    if (category === 'npc') {
      simple.append(el('div', { class: 'row' }, f('Роль', el('input', { value: d.role || '', placeholder: 'трактирщик, капитан стражи…', oninput: e => d.role = e.target.value })), f('Раса', el('input', { value: d.race || '', oninput: e => d.race = e.target.value })), f('Фракция', el('input', { value: d.faction || '', oninput: e => d.faction = e.target.value })),
        f('Отношение', el('select', { onchange: e => d.attitude = e.target.value }, ...['', 'дружелюбный', 'нейтральный', 'враждебный'].map(x => el('option', { value: x, selected: (d.attitude || '') === x ? '' : null }, x || '—'))))),
        el('div', { class: 'row' }, f('Место', el('input', { value: d.location || '', placeholder: 'где встретить', oninput: e => d.location = e.target.value })), f('Голос и манеры', el('input', { value: d.voice || '', placeholder: 'как отыгрывать', oninput: e => d.voice = e.target.value }))));
    }
    simple.append(f('Описание', descEditor(d)));
    if (category === 'npc') {
      simple.append(f('Зацепки для игроков (что может дать/попросить)', el('textarea', { style: 'min-height:60px', oninput: e => d.hooks = e.target.value }, d.hooks || '')),
        f('Секреты мастера (игроки не видят)', el('textarea', { style: 'min-height:60px', oninput: e => d.secrets = e.target.value }, d.secrets || '')),
        f('Добыча / имущество', el('input', { value: d.loot || '', oninput: e => d.loot = e.target.value })));
      const sb = el('input', { type: 'checkbox', style: 'width:auto', checked: d.abilities ? '' : null });
      const sbBox = el('div', { style: d.abilities ? '' : 'display:none' });
      sb.addEventListener('change', () => { if (sb.checked) { d.abilities ||= { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }; d.ac ||= 10; d.hp ||= '4 (1к8)'; sbBox.style.display = ''; sbBox.innerHTML = ''; sbBox.append(statBlock()); } else { delete d.abilities; delete d.ac; delete d.hp; delete d.actions; sbBox.style.display = 'none'; } });
      simple.append(el('label', {}, sb, ' Боевой статблок (КД, хиты, характеристики, атаки)'), sbBox);
      if (d.abilities) sbBox.append(statBlock());
    }
    if (category === 'lore') {
      simple.append(el('div', { class: 'row' }, f('Тип', el('select', { onchange: e => d.kind = e.target.value }, ...[['', '—'], ['rule', 'Правило'], ['place', 'Место'], ['faction', 'Фракция'], ['event', 'Событие'], ['deity', 'Божество'], ['other', 'Другое']].map(([k, v]) => el('option', { value: k, selected: (d.kind || '') === k ? '' : null }, v)))), f('Теги', el('input', { value: d.tags || '', placeholder: 'через запятую', oninput: e => d.tags = e.target.value }))),
        f('Заметки мастера (игроки не видят)', el('textarea', { style: 'min-height:60px', oninput: e => d.secrets = e.target.value }, d.secrets || '')));
    }
    function statBlock() {
      const box = el('div');
      box.append(el('div', { class: 'row' }, f('КД', el('input', { type: 'number', value: d.ac || 10, oninput: e => d.ac = +e.target.value })), f('Хиты', el('input', { value: d.hp || '', placeholder: '22 (3к8+9)', oninput: e => d.hp = e.target.value })), f('Скорость', el('input', { value: d.speed || '30 фт', oninput: e => d.speed = e.target.value })), f('Опасность', el('input', { value: d.cr || '0', oninput: e => d.cr = e.target.value }))));
      d.abilities ||= { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
      box.append(el('div', { class: 'row' }, ...Object.keys(ABIL).map(k => f(ABIL[k].slice(0, 3), el('input', { type: 'number', value: d.abilities[k], oninput: e => d.abilities[k] = +e.target.value })))));
      return box;
    }
    if (category === 'monster') {
      simple.append(el('div', { class: 'row' }, f('КД', el('input', { type: 'number', value: d.ac || 10, oninput: e => d.ac = +e.target.value })), f('Хиты', el('input', { value: d.hp || '', placeholder: '22 (3к8+9)', oninput: e => d.hp = e.target.value })), f('Скорость', el('input', { value: d.speed || '30 фт', oninput: e => d.speed = e.target.value })), f('Опасность', el('input', { value: d.cr || '1', oninput: e => d.cr = e.target.value })), f('Размер', el('input', { value: d.size || 'Средний', oninput: e => d.size = e.target.value })), f('Тип', el('input', { value: d.type || 'гуманоид', oninput: e => d.type = e.target.value }))));
      d.abilities ||= { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
      simple.append(el('div', { class: 'row' }, ...Object.keys(ABIL).map(k => f(ABIL[k].slice(0, 3), el('input', { type: 'number', value: d.abilities[k], oninput: e => d.abilities[k] = +e.target.value })))));

    }
    if (category === 'race' || category === 'class' || category === 'background') {
      d.traits ||= [];
      const tr = el('div');
      const renderTr = () => { tr.innerHTML = ''; d.traits.forEach((a, i) => tr.append(el('div', { class: 'row', style: 'margin-bottom:4px' }, el('input', { value: a.name, placeholder: 'Умение', oninput: e => a.name = e.target.value }), el('input', { value: a.text, placeholder: 'Описание', style: 'flex:2', oninput: e => a.text = e.target.value }), el('button', {class:'small',onclick:async()=>{const r=await editFeature(newFeature({name:a.name,text:a.text,mechanics:a.mechanics||Mechanics.forFeature(d.mechanics,a.name)}));if(r){a.name=r.name;a.text=r.text;a.mechanics=r.mechanics;renderTr();}}},'Блоки'), el('button', { class: 'small danger', style: 'flex:0', onclick: () => { d.traits.splice(i, 1); renderTr(); } }, icon('close'))))); tr.append(el('button', { class: 'small', onclick: () => { d.traits.push({ name: '', text: '' }); renderTr(); } }, '+ Умение')); };
      renderTr(); simple.append(f('Особенности', tr));

    }
    // Варианты выбора «либо / либо»: игрок решает при создании персонажа (CharacterBuilder).
    if (['race', 'class', 'background'].includes(category) && window.CharacterBuilder?.choiceEditor) simple.append(window.CharacterBuilder.choiceEditor(d));
    simple.append(Mechanics.editor(d, {category}));
    return modal(entry ? 'Редактировать' : 'Новая запись', simple, [{label:'Сохранить', cls:'primary', fn:()=>{
      if (NO_TOKEN) delete d.token_asset_id;
      if (!(d.choices || []).length) delete d.choices;
      const error=Mechanics.validate(d.mechanics); if(error){toast(error);return false;}
      const cerr=window.CharacterBuilder?.validateChoices?.(d.choices)||''; if(cerr){toast(cerr);return false;}
      return {name:state.name,data:d};}}], {wide:true});
  }

  // ---------- drag&drop payloads ----------
  function setDrag(ev, type, payload) { ev.dataTransfer.setData(type, JSON.stringify(payload)); ev.dataTransfer.setData('text/plain', payload.item?.name || payload.spell?.name || payload.name || ''); ev.dataTransfer.effectAllowed = 'copyMove'; }
  function getDrag(ev, type) { const raw = ev.dataTransfer.getData(type); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
  function hasType(ev, ...types) { const t = [...(ev.dataTransfer?.types || [])]; return types.some(x => t.includes(x)); }

  return { uid, fillDefaults, ITEM_TYPES, ITEM_ICONS, ACTION_ICONS, itemIconName, RARITIES, RARITY_COLORS, ACTION_KINDS, DAMAGE_TYPES, diceExpressions, rollMulti, renderMulti, withMode, modeFromEvent, newItem, newSpell, newFeature, editFeature, imagePicker, visualsRow, docIcon, evalConst, itemFromCompendium, spellFromCompendium, ctxFromSheet, resolve, roll, sendCard, rich, rollBtn, attackRow, openModeMenu, itemIcon, itemCardBody, spellCardBody, actionButtons, toChatCard, renderChatCard, editItem, editSpell, editGeneric, actionsEditor, descEditor, setDrag, getDrag, hasType };
})();
