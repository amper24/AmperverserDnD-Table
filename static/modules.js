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
  const SCHOOLS = ['Воплощение', 'Вызов', 'Иллюзия', 'Некромантия', 'Ограждение', 'Очарование', 'Преобразование', 'Прорицание'];

  const ICONS_KNOWN = (n) => ['sword', 'shield', 'bag', 'flask', 'star', 'tool', 'coin', 'target', 'box', 'scroll', 'book'].includes(n);
  // ---------- модель ----------
  function newItem(o = {}) {
    return { uid: uid(), name: 'Предмет', type: 'gear', rarity: 'Обычный', qty: 1, weight: 0, cost: '', desc: '', equipped: false, attuned: false, attunement: false,
      charges: null, actions: [], tags: [], icon: '', asset_id: null, source: '', ...o };
  }
  function newSpell(o = {}) {
    return { uid: uid(), name: 'Заклинание', level: 1, school: 'Воплощение', casting_time: '1 действие', range: '60 фт', components: 'В, С', duration: 'Мгновенная',
      concentration: false, ritual: false, desc: '', prepared: false, actions: [], source: '', ...o };
  }
  /// Предмет справочника -> модуль инвентаря (с авто-действиями для оружия).
  function itemFromCompendium(e, ctx) {
    const d = e.data || {};
    const type = d.type === 'weapon' ? 'weapon' : d.type === 'armor' ? 'armor' : d.type === 'magic' ? 'magic' : /зелье|свиток|рацион/i.test(e.name) ? 'consumable' : /стрел|болт/i.test(e.name) ? 'ammo' : 'gear';
    const it = newItem({ name: e.name, type, rarity: d.rarity || 'Обычный', weight: d.weight || 0, cost: d.cost || '', desc: d.desc || '', source: e.source || '', attunement: !!d.attunement, tags: [d.category].filter(Boolean),
      actions: Array.isArray(d.actions) ? d.actions.map(a => ({ ...a })) : [] });
    if (type === 'weapon' && d.damage && !it.actions.length) {
      const props = d.properties || [];
      const fin = props.some(p => /Фехтовальное/.test(p)), ranged = /дальнобойное/i.test(d.category || '') || props.some(p => /Метательное|Боеприпас/.test(p));
      const ab = ranged && !props.some(p => /Метательное/.test(p)) ? 'dex' : fin ? 'fin' : 'str';
      const atk = ab === 'fin' ? '@atk' : ab === 'dex' ? '@atk_dex' : '@atk_str';
      const dmgMod = ab === 'fin' ? '@best' : '@' + ab;
      const dmg = String(d.damage).replace('к', 'd');
      it.actions = [{ name: 'Атака', kind: 'attack', roll: `1d20+${atk}` }, { name: `Урон (${d.damage_type || ''})`.replace(' ()', ''), kind: 'damage', roll: `${dmg}+${dmgMod}` }];
      const vers = props.find(p => /Универсальное/.test(p));
      if (vers) { const m = vers.match(/\((\d+к\d+)\)/); if (m) it.actions.push({ name: 'Урон двумя руками', kind: 'damage', roll: `${m[1].replace('к', 'd')}+${dmgMod}` }); }
      it.desc = it.desc || [d.damage && `Урон ${d.damage} ${d.damage_type || ''}`, props.length && `Свойства: ${props.join(', ')}`].filter(Boolean).join('. ');
    }
    if (type === 'armor') { it.desc = it.desc || `КД ${d.ac}${d.stealth_disadvantage ? ', помеха на Скрытность' : ''}${d.str_req ? `, требуется Сила ${d.str_req}` : ''}`; it.ac = d.ac; }
    if (d.charges) it.charges = { cur: d.charges, max: d.charges, recharge: d.recharge || '' };
    return it;
  }
  function spellFromCompendium(e) {
    const d = e.data || {};
    return newSpell({ name: e.name, level: d.level ?? 1, school: d.school || '', casting_time: d.casting_time || '', range: d.range || '', components: d.components || '', duration: d.duration || '',
      concentration: !!d.concentration, ritual: !!d.ritual, desc: d.desc || '', source: e.source || '', actions: Array.isArray(d.actions) ? d.actions.map(a => ({ ...a })) : autoSpellActions(d) });
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
  function ctxFromSheet(s) {
    if (!s) return {};
    const mod = v => Math.floor(((v ?? 10) - 10) / 2);
    const a = s.abilities || {};
    const prof = s.proficiency_bonus || Math.ceil(1 + (s.level || 1) / 4);
    const ab = { str: mod(a.str), dex: mod(a.dex), con: mod(a.con), int: mod(a.int), wis: mod(a.wis), cha: mod(a.cha) };
    const spAb = s.spells?.ability || 'int';
    const best = Math.max(ab.str, ab.dex);
    return { ...ab, prof, level: s.level || 1, best, atk: best + prof, atk_str: ab.str + prof, atk_dex: ab.dex + prof, spell: ab[spAb] + prof, dc: 8 + prof + ab[spAb], ac: s.ac || 10, hp: s.hp?.current || 0, init: ab.dex + (s.initiative_bonus || 0) };
  }
  function resolve(expr, ctx = {}) {
    let out = String(expr).replace(/@([a-z_]+)/gi, (_, k) => { const v = ctx[k.toLowerCase()]; return v === undefined ? '0' : String(v); });
    out = out.replace(/\+\s*-/g, '-').replace(/к/g, 'd').replace(/\s+/g, '').replace(/([+-])0(?=[+\-]|$)/g, '');
    // схлопываем константы "+5+2" оставляем — сервер посчитает
    return out;
  }
  const DICE_RE = /(\d*[dк]\d+(?:k[hl]\d+)?(?:\s*[+\-]\s*(?:\d+|@[a-z_]+))*)/gi;

  // ---------- броски: единый канал ----------
  function roll(expr, label, opts = {}) {
    const ctx = opts.ctx || window.SHEET_CTX || {};
    const resolved = resolve(expr, ctx);
    const msg = { type: 'roll', expr: resolved, label: label || expr, gm_only: !!opts.gm_only };
    if (window.TABLE_CTX?.roll) return window.TABLE_CTX.roll(resolved, msg.label, msg.gm_only);
    if (window.parent !== window) return window.parent.postMessage(msg, '*');
    if (window.opener && !window.opener.closed) return window.opener.postMessage(msg, '*');
    const r = rollDice(resolved);
    toast(`${msg.label}: ${r.total}  (${r.parts.map(p => p.rolls ? '[' + p.rolls.join(',') + ']' : p.term).join(' ')})`, 4000);
  }
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
    const parts = String(text).split(/(\[\[[^\]]+\]\](?:\{[^}]*\})?)/g);
    for (const p of parts) {
      const m = p.match(/^\[\[([^\]]+)\]\](?:\{([^}]*)\})?$/);
      if (m) { wrap.append(rollBtn(m[1].trim(), m[2] || m[1].trim(), ctx, opts)); continue; }
      // авто-обнаружение кубиков в обычном тексте
      let last = 0; const re = new RegExp(DICE_RE.source, 'gi'); let mm;
      while ((mm = re.exec(p))) {
        if (mm.index > last) wrap.append(textNode(p.slice(last, mm.index)));
        wrap.append(rollBtn(mm[1].trim(), mm[1].trim(), ctx, { ...opts, auto: true }));
        last = mm.index + mm[0].length;
      }
      if (last < p.length) wrap.append(textNode(p.slice(last)));
    }
    return wrap;
  }
  function textNode(t) { const f = document.createDocumentFragment(); const lines = t.split('\n'); lines.forEach((l, i) => { f.append(document.createTextNode(l)); if (i < lines.length - 1) f.append(el('br')); }); return f; }
  function rollBtn(expr, label, ctx, opts = {}) {
    const shown = ctx ? resolve(expr, ctx) : expr;
    const b = el('button', { class: 'inline-roll' + (opts.auto ? ' auto' : ''), title: `Бросить ${shown}`, onclick: (e) => { e.stopPropagation(); e.preventDefault(); roll(expr, (opts.prefix ? opts.prefix + ': ' : '') + label, { ctx, gm_only: e.shiftKey }); } }, icon('dice', 12), ' ', label === expr ? shown : label);
    return b;
  }

  // ---------- карточка предмета / заклинания (общая для листа, чата, справочника) ----------
  /// Иконка предмета: элемент. it.icon — короткий текст (1–2 символа) поверх стандартной иконки типа.
  function itemIcon(it) { return it?.icon ? el('span', { class: 'txt-ico' }, String(it.icon).slice(0, 2)) : icon(ITEM_ICONS[it?.type] || 'box', 18); }
  function itemIconName(it) { return ITEM_ICONS[it?.type] || 'box'; }
  function actionButtons(doc, ctx, prefix) {
    const row = el('div', { class: 'actions-row' });
    for (const a of doc.actions || []) {
      if (!a.roll) continue;
      row.append(el('button', { class: 'act-btn ' + (a.kind || 'other'), title: resolve(a.roll, ctx || {}), onclick: (e) => { e.stopPropagation(); roll(a.roll, `${prefix ? prefix + ': ' : ''}${a.name || a.kind}`, { ctx, gm_only: e.shiftKey }); } },
        (ACTION_KINDS[a.kind] || '•').split(' ')[0], ' ', a.name || ACTION_KINDS[a.kind]?.slice(2) || 'Бросок', el('small', {}, ' ' + resolve(a.roll, ctx || {}))));
    }
    if (doc.save_dc || doc.save_ability) row.append(el('span', { class: 'chip' }, `СЛ ${doc.save_dc || '@dc'} ${doc.save_ability || ''}`));
    return row;
  }
  function itemCardBody(it, ctx, opts = {}) {
    const meta = [ITEM_TYPES[it.type], it.rarity && it.rarity !== 'Обычный' ? it.rarity : null, it.weight ? `${it.weight} фнт` : null, it.cost || null, it.attunement ? 'настройка' : null].filter(Boolean).join(' · ');
    const body = el('div', { class: 'card-body' },
      el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, itemIcon(it)), el('div', { class: 'grow' }, el('b', { style: `color:${RARITY_COLORS[it.rarity] || 'inherit'}` }, it.name), el('div', { class: 'muted small' }, meta)), it.qty > 1 ? el('span', { class: 'badge' }, '×' + it.qty) : null),
      it.charges ? el('div', { class: 'small muted' }, `Заряды: ${it.charges.cur}/${it.charges.max}${it.charges.recharge ? ' (' + it.charges.recharge + ')' : ''}`) : null,
      it.desc ? el('div', { class: 'card-desc' }, rich(it.desc, ctx, { prefix: it.name })) : null,
      actionButtons(it, ctx, it.name));
    return body;
  }
  function spellCardBody(sp, ctx) {
    const meta = [sp.level === 0 ? 'Заговор' : `${sp.level} круг`, sp.school, sp.casting_time, sp.range, sp.components, (sp.concentration ? 'Концентрация, ' : '') + (sp.duration || ''), sp.ritual ? 'ритуал' : null].filter(Boolean).join(' · ');
    return el('div', { class: 'card-body' },
      el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon('star', 18)), el('div', { class: 'grow' }, el('b', {}, sp.name), el('div', { class: 'muted small' }, meta))),
      sp.desc ? el('div', { class: 'card-desc' }, rich(sp.desc, ctx, { prefix: sp.name })) : null,
      actionButtons(sp, ctx, sp.name));
  }
  function toChatCard(doc, kind) {
    return { name: doc.name, kind, desc: doc.desc || '', actions: (doc.actions || []).map(a => ({ name: a.name, kind: a.kind, roll: a.roll })), icon: kind === 'spell' ? 'star' : (doc.icon || itemIconName(doc)),
      meta: kind === 'spell' ? [doc.level === 0 ? 'Заговор' : `${doc.level} круг`, doc.school, doc.casting_time, doc.range, doc.duration].filter(Boolean).join(' · ') : [ITEM_TYPES[doc.type], doc.rarity].filter(Boolean).join(' · ') };
  }
  function renderChatCard(card, ctx) {
    return el('div', { class: 'chat-card' },
      el('div', { class: 'card-head' }, el('span', { class: 'card-icon' }, card.icon && ICONS_KNOWN(card.icon) ? icon(card.icon, 18) : card.icon ? el('span', { class: 'txt-ico' }, String(card.icon).slice(0, 2)) : icon('box', 18)), el('div', { class: 'grow' }, el('b', {}, card.name), el('div', { class: 'muted small' }, card.meta || ''))),
      card.desc ? el('div', { class: 'card-desc' }, rich(card.desc, ctx, { prefix: card.name })) : null,
      actionButtons(card, ctx, card.name));
  }

  // ---------- редактор действий (кнопок бросков) ----------
  function actionsEditor(doc) {
    const box = el('div', { class: 'actions-editor' });
    const render = () => {
      box.innerHTML = '';
      box.append(el('div', { class: 'muted small', style: 'margin-bottom:4px' }, 'Кнопки бросков. В формуле можно использовать @str @dex @con @int @wis @cha @prof @atk @spell @dc, кубики: 1d8, 2к6kh1'));
      (doc.actions || []).forEach((a, i) => box.append(el('div', { class: 'action-row' },
        el('select', { onchange: e => a.kind = e.target.value }, ...Object.entries(ACTION_KINDS).map(([k, v]) => el('option', { value: k, selected: (a.kind || 'other') === k ? '' : null }, v))),
        el('input', { placeholder: 'Название', value: a.name || '', oninput: e => a.name = e.target.value }),
        el('input', { placeholder: 'Формула: 1d20+@atk', value: a.roll || '', oninput: e => a.roll = e.target.value }),
        el('button', { class: 'small', title: 'Проверить', onclick: () => roll(a.roll, a.name || 'тест') }, icon('dice')),
        el('button', { class: 'small danger', onclick: () => { doc.actions.splice(i, 1); render(); } }, icon('close')))));
      const presets = el('div', { class: 'row', style: 'margin-top:4px;flex-wrap:wrap;gap:4px' },
        el('button', { class: 'small', onclick: () => { (doc.actions ||= []).push({ name: 'Атака', kind: 'attack', roll: '1d20+@atk' }); render(); } }, '+ Атака'),
        el('button', { class: 'small', onclick: () => { (doc.actions ||= []).push({ name: 'Урон', kind: 'damage', roll: '1d8+@str' }); render(); } }, '+ Урон'),
        el('button', { class: 'small', onclick: () => { (doc.actions ||= []).push({ name: 'Лечение', kind: 'heal', roll: '2d4+2' }); render(); } }, '+ Лечение'),
        el('button', { class: 'small', onclick: () => { (doc.actions ||= []).push({ name: 'Атака заклинанием', kind: 'attack', roll: '1d20+@spell' }); render(); } }, '+ Закл. атака'),
        el('button', { class: 'small', onclick: () => { (doc.actions ||= []).push({ name: '', kind: 'other', roll: '' }); render(); } }, '+ Своя'));
      box.append(presets);
    };
    render();
    return box;
  }
  function descEditor(doc, key = 'desc') {
    const ta = el('textarea', { style: 'min-height:90px', placeholder: 'Описание. Кнопки бросков прямо в тексте: [[1d20+@atk]]{Атака} или [[2к6+3]]. Просто "3к6" тоже станет кнопкой.', oninput: e => { doc[key] = e.target.value; prev.replaceChildren(rich(doc[key])); } }, doc[key] || '');
    const prev = el('div', { class: 'card-desc preview' }, rich(doc[key] || ''));
    const tools = el('div', { class: 'row', style: 'gap:4px;margin:4px 0' },
      el('button', { class: 'small', onclick: () => insert('[[1d20+@atk]]{Атака}') }, '+[[атака]]'),
      el('button', { class: 'small', onclick: () => insert('[[1d8+@str]]{Урон}') }, '+[[урон]]'),
      el('button', { class: 'small', onclick: () => insert('[[1d20+@spell]]{Атака заклинанием}') }, '+[[закл]]'),
      el('span', { class: 'muted small', style: 'flex:1' }, 'Предпросмотр ниже'));
    function insert(t) { const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + t + ta.value.slice(ta.selectionEnd); doc[key] = ta.value; prev.replaceChildren(rich(doc[key])); ta.focus(); }
    return el('div', {}, ta, tools, prev);
  }

  /// Визуальный редактор предмета. Возвращает Promise<item|null>.
  function editItem(item, opts = {}) {
    const it = JSON.parse(JSON.stringify(item || newItem()));
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const form = el('div', { class: 'editor-form' },
      el('div', { class: 'row' }, f('Название', el('input', { value: it.name, oninput: e => it.name = e.target.value })), f('Метка (1–2 символа)', el('input', { value: it.icon || '', placeholder: '—', maxlength: 2, style: 'width:70px', oninput: e => it.icon = e.target.value }))),
      el('div', { class: 'row' },
        f('Тип', el('select', { onchange: e => it.type = e.target.value }, ...Object.entries(ITEM_TYPES).map(([k, v]) => el('option', { value: k, selected: it.type === k ? '' : null }, v)))),
        f('Редкость', el('select', { onchange: e => it.rarity = e.target.value }, ...RARITIES.map(r => el('option', { value: r, selected: it.rarity === r ? '' : null }, r)))),
        f('Кол-во', el('input', { type: 'number', value: it.qty, oninput: e => it.qty = +e.target.value })),
        f('Вес (фнт)', el('input', { type: 'number', step: '0.1', value: it.weight, oninput: e => it.weight = +e.target.value })),
        f('Цена', el('input', { value: it.cost || '', placeholder: '15 зм', oninput: e => it.cost = e.target.value }))),
      el('div', { class: 'row' },
        f('Заряды (макс)', el('input', { type: 'number', value: it.charges?.max ?? '', placeholder: '—', oninput: e => { const v = +e.target.value; it.charges = v > 0 ? { cur: Math.min(it.charges?.cur ?? v, v), max: v, recharge: it.charges?.recharge || '' } : null; } })),
        f('Восстановление', el('input', { value: it.charges?.recharge || '', placeholder: 'на рассвете 1d6+1', oninput: e => { if (it.charges) it.charges.recharge = e.target.value; } })),
        f('Теги', el('input', { value: (it.tags || []).join(', '), oninput: e => it.tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean) })),
        el('label', { style: 'align-self:end;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: it.attunement ? '' : null, onchange: e => it.attunement = e.target.checked }), ' Требует настройки')),
      f('Описание', descEditor(it)),
      f('Действия', actionsEditor(it)));
    return modal(opts.title || (item ? 'Редактировать предмет' : 'Новый предмет'), form, [{ label: 'Сохранить', cls: 'primary', fn: () => it }], { wide: true });
  }
  function editSpell(spell, opts = {}) {
    const sp = JSON.parse(JSON.stringify(spell || newSpell()));
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const form = el('div', { class: 'editor-form' },
      el('div', { class: 'row' }, f('Название', el('input', { value: sp.name, oninput: e => sp.name = e.target.value })), f('Круг', el('select', { onchange: e => sp.level = +e.target.value }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(l => el('option', { value: l, selected: sp.level === l ? '' : null }, l === 0 ? 'Заговор' : l)))),
        f('Школа', el('select', { onchange: e => sp.school = e.target.value }, ...SCHOOLS.map(s => el('option', { value: s, selected: sp.school === s ? '' : null }, s))))),
      el('div', { class: 'row' }, f('Время', el('input', { value: sp.casting_time, oninput: e => sp.casting_time = e.target.value })), f('Дистанция', el('input', { value: sp.range, oninput: e => sp.range = e.target.value })), f('Компоненты', el('input', { value: sp.components, oninput: e => sp.components = e.target.value })), f('Длительность', el('input', { value: sp.duration, oninput: e => sp.duration = e.target.value }))),
      el('div', { class: 'row' }, el('label', {}, el('input', { type: 'checkbox', style: 'width:auto', checked: sp.concentration ? '' : null, onchange: e => sp.concentration = e.target.checked }), ' Концентрация'), el('label', {}, el('input', { type: 'checkbox', style: 'width:auto', checked: sp.ritual ? '' : null, onchange: e => sp.ritual = e.target.checked }), ' Ритуал'),
        f('Классы', el('input', { value: (sp.classes || []).join(', '), oninput: e => sp.classes = e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))),
      f('Описание', descEditor(sp)),
      f('Действия', actionsEditor(sp)));
    return modal(opts.title || (spell ? 'Редактировать заклинание' : 'Новое заклинание'), form, [{ label: 'Сохранить', cls: 'primary', fn: () => sp }], { wide: true });
  }
  /// Универсальный редактор записи справочника для остальных категорий (черты/состояния/монстры/расы…): поля + JSON.
  function editGeneric(entry, category) {
    const d = JSON.parse(JSON.stringify(entry?.data || { desc: '' }));
    const f = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
    const state = { name: entry?.name || '' };
    const json = el('textarea', { style: 'min-height:160px;font-family:monospace;font-size:12px' }, JSON.stringify(d, null, 2));
    const simple = el('div', {}, f('Название', el('input', { value: state.name, oninput: e => state.name = e.target.value })), f('Описание', descEditor(d)));
    if (category === 'monster') {
      simple.append(el('div', { class: 'row' }, f('КД', el('input', { type: 'number', value: d.ac || 10, oninput: e => d.ac = +e.target.value })), f('Хиты', el('input', { value: d.hp || '', placeholder: '22 (3к8+9)', oninput: e => d.hp = e.target.value })), f('Скорость', el('input', { value: d.speed || '30 фт', oninput: e => d.speed = e.target.value })), f('Опасность', el('input', { value: d.cr || '1', oninput: e => d.cr = e.target.value })), f('Размер', el('input', { value: d.size || 'Средний', oninput: e => d.size = e.target.value })), f('Тип', el('input', { value: d.type || 'гуманоид', oninput: e => d.type = e.target.value }))));
      d.abilities ||= { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
      simple.append(el('div', { class: 'row' }, ...Object.keys(ABIL).map(k => f(ABIL[k].slice(0, 3), el('input', { type: 'number', value: d.abilities[k], oninput: e => d.abilities[k] = +e.target.value })))));
      d.actions ||= [];
      const acts = el('div');
      const renderActs = () => { acts.innerHTML = ''; d.actions.forEach((a, i) => acts.append(el('div', { class: 'row', style: 'margin-bottom:4px' }, el('input', { value: a.name, placeholder: 'Название', oninput: e => a.name = e.target.value }), el('input', { value: a.text, placeholder: 'Текст: +4 к попаданию, 1к6+2 колющий', style: 'flex:2', oninput: e => a.text = e.target.value }), el('button', { class: 'small danger', style: 'flex:0', onclick: () => { d.actions.splice(i, 1); renderActs(); } }, icon('close'))))); acts.append(el('button', { class: 'small', onclick: () => { d.actions.push({ name: '', text: '' }); renderActs(); } }, '+ Действие')); };
      renderActs(); simple.append(f('Действия (кубики в тексте станут кнопками)', acts));
    }
    if (category === 'race' || category === 'class' || category === 'background') {
      d.traits ||= [];
      const tr = el('div');
      const renderTr = () => { tr.innerHTML = ''; d.traits.forEach((a, i) => tr.append(el('div', { class: 'row', style: 'margin-bottom:4px' }, el('input', { value: a.name, placeholder: 'Умение', oninput: e => a.name = e.target.value }), el('input', { value: a.text, placeholder: 'Описание', style: 'flex:2', oninput: e => a.text = e.target.value }), el('button', { class: 'small danger', style: 'flex:0', onclick: () => { d.traits.splice(i, 1); renderTr(); } }, icon('close'))))); tr.append(el('button', { class: 'small', onclick: () => { d.traits.push({ name: '', text: '' }); renderTr(); } }, '+ Умение')); };
      renderTr(); simple.append(f('Особенности', tr));
      if (category === 'race') { d.asi ||= {}; simple.append(el('div', { class: 'row' }, ...Object.keys(ABIL).map(k => f('+' + ABIL[k].slice(0, 3), el('input', { type: 'number', value: d.asi[k] || 0, oninput: e => { const v = +e.target.value; if (v) d.asi[k] = v; else delete d.asi[k]; } }))), f('Скорость', el('input', { type: 'number', value: d.speed || 30, oninput: e => d.speed = +e.target.value })))); }
      if (category === 'class') simple.append(el('div', { class: 'row' }, f('Кость хитов', el('input', { value: d.hit_die || 'd8', oninput: e => d.hit_die = e.target.value })), f('Хар-ка заклинаний', el('select', { onchange: e => d.spellcasting = e.target.value || undefined }, el('option', { value: '' }, '—'), ...['int', 'wis', 'cha'].map(k => el('option', { value: k, selected: d.spellcasting === k ? '' : null }, ABIL[k]))))));
    }
    const tabs = el('div', { class: 'tabs' }, el('button', { class: 'active', onclick: e => { swap(0, e.target); } }, 'Визуально'), el('button', { onclick: e => { swap(1, e.target); } }, 'JSON (продвинуто)'));
    const panes = [simple, el('div', {}, json)];
    const holder = el('div', {}, tabs, panes[0]);
    function swap(i, btn) { tabs.querySelectorAll('button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); if (i === 1) json.value = JSON.stringify(d, null, 2); else { try { Object.assign(d, JSON.parse(json.value)); } catch { } } holder.replaceChild(panes[i], holder.children[1]); }
    return modal(entry ? 'Редактировать' : 'Новая запись', holder, [{ label: 'Сохранить', cls: 'primary', fn: () => { if (holder.children[1] === panes[1]) { try { const j = JSON.parse(json.value); for (const k of Object.keys(d)) delete d[k]; Object.assign(d, j); } catch { alert('Неверный JSON'); return false; } } return { name: state.name, data: d }; } }], { wide: true });
  }

  // ---------- drag&drop payloads ----------
  function setDrag(ev, type, payload) { ev.dataTransfer.setData(type, JSON.stringify(payload)); ev.dataTransfer.setData('text/plain', payload.item?.name || payload.spell?.name || payload.name || ''); ev.dataTransfer.effectAllowed = 'copyMove'; }
  function getDrag(ev, type) { const raw = ev.dataTransfer.getData(type); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
  function hasType(ev, ...types) { const t = [...(ev.dataTransfer?.types || [])]; return types.some(x => t.includes(x)); }

  return { uid, ITEM_TYPES, ITEM_ICONS, ACTION_ICONS, itemIconName, RARITIES, RARITY_COLORS, ACTION_KINDS, newItem, newSpell, itemFromCompendium, spellFromCompendium, ctxFromSheet, resolve, roll, sendCard, rich, rollBtn, itemIcon, itemCardBody, spellCardBody, actionButtons, toChatCard, renderChatCard, editItem, editSpell, editGeneric, actionsEditor, descEditor, setDrag, getDrag, hasType };
})();
