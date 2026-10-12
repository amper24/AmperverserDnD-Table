// ---------------------------------------------------------------------------
// presets-editor.js — связывание записей справочника с наборами и редактор своих элементов наборов.
//
// Связь идёт по ключу, который пользователь видит и может выбрать из списка:
//   раса (race_rules) и черта (feat_rules) — поле data.name_en; id элемента набора — то же в нижнем регистре;
//   класс (class_rules) — поле data.name_en; id элемента — slug класса;
//   состояние (conditions) — поле data.condition_key; id элемента — ключ состояния.
// Свои элементы сохраняются в пользовательский набор (см. Presets.upsertUserItem), встроенные не меняются;
// элемент с тем же id перекрывает встроенный.
// Даёт: window.PresetsEditor { linkPicker, editElement, elementsPanel, findRule, LINKS }.
// ---------------------------------------------------------------------------
(function () {
  const LINKS = {
    race: { kind: 'race_rules', title: 'Правила расы', field: 'name_en', edition: true },
    class: { kind: 'class_rules', title: 'Правила класса', field: 'name_en', edition: true },
    feat: { kind: 'feat_rules', title: 'Правила черты', field: 'name_en', edition: true },
    condition: { kind: 'conditions', title: 'Состояние в словаре', field: 'condition_key', edition: false },
  };
  const KIND_TITLES = {
    race_rules: 'Раса', class_rules: 'Класс', class_progression: 'Таблица развития класса', multiclass_slots: 'Ячейки мультикласса',
    feat_rules: 'Черта', feature_rules: 'Особенность класса', conditions: 'Состояние', spell_schools: 'Школа заклинаний',
    languages: 'Язык', enemy_types: 'Тип врага', mechanic_templates: 'Шаблон блока', mechanic_starters: 'Стартовая программа',
    equipment_text_rules: 'Правило текста снаряжения', equipment_pick_rules: 'Правило выбора снаряжения', block_defaults: 'Умолчания блока',
    item_preset: 'Основа предмета', spell_preset: 'Основа заклинания', graph_starter: 'Стартовый граф', graph_group: 'Группа графа',
  };
  const EDITIONS = ['2014', '2024'];
  const P = () => window.Presets;
  const kindNeedsEdition = kind => Boolean(P()?.KINDS?.includes(kind) && ['race_rules', 'class_rules', 'feat_rules', 'feature_rules', 'class_progression', 'multiclass_slots'].includes(kind));
  const labelOf = item => String(item?.table?.ru || item?.table?.name_en || item?.name || item?.id || '');
  const keyFromId = item => item?.id || '';
  // Ключ, который записывается в запись справочника, и сравнение с id элемента набора.
  const normKey = v => String(v || '').trim().toLowerCase();
  // Раса и черта связываются по английскому названию (name_en), класс и состояние — по id.
  const isNameKind = L => L.kind === 'race_rules' || L.kind === 'feat_rules';

  // Найти элемент набора по значению поля записи: без учёта регистра.
  function findRule(category, data, edition) {
    const L = LINKS[category];
    if (!L || !P()) return null;
    const want = normKey(data?.[L.field]);
    if (!want) return null;
    return P().itemsOfKind(L.kind, edition).find(i => normKey(keyFromId(i)) === want) || null;
  }

  // Ключ, который подставляется по умолчанию из названия записи.
  const suggestKey = name => normKey(String(name || '').replace(/[^A-Za-zА-Яа-яЁё0-9]+/g, '-')).replace(/^-+|-+$/g, '');

  // Значение строки редактора: JSON, если разбирается (числа, массивы, объекты, true/false/null), иначе — текст.
  function parseValue(text) {
    const t = String(text ?? '').trim();
    if (t === '') return '';
    try { return JSON.parse(t); } catch { return t; }
  }
  const showValue = v => (typeof v === 'string' ? v : JSON.stringify(v, null, 0));

  // Редактор элемента набора: ключ, название, редакция, основа (копия встроенного) и поля table.
  // Возвращает { id, edition } или null при отмене.
  function editElement(kind, existing, opts = {}) {
    const { el, toast } = window;
    const edition = existing?.edition || opts.edition || '2014';
    const nameKind = kind === 'race_rules' || kind === 'feat_rules';
    const keyInput = el('input', { value: existing ? (nameKind ? (existing.table?.name_en || existing.id) : existing.id) : (opts.key || ''), placeholder: nameKind ? 'Dwarf' : 'barbarian' });
    const ruInput = el('input', { value: existing?.table?.ru || opts.name || '', placeholder: 'Название на русском' });
    const editionSel = el('select', {}, ...EDITIONS.map(x => el('option', { value: x, selected: x === edition ? '' : null }, x)));
    const rows = [];
    const rowsBox = el('div', { class: 'elem-rows' });
    const addRow = (k = '', v = '') => {
      const row = { k: el('input', { value: k, placeholder: 'поле' }), v: el('textarea', { rows: 1, style: 'min-height:28px;font-family:monospace' }, showValue(v)) };
      row.box = el('div', { class: 'row', style: 'gap:6px;align-items:flex-start' }, row.k, row.v,
        el('button', { type: 'button', class: 'small ghost', title: 'Убрать поле', onclick: () => { rows.splice(rows.indexOf(row), 1); row.box.remove(); } }, '×'));
      rows.push(row); rowsBox.append(row.box);
    };
    const setRows = table => { rows.length = 0; rowsBox.replaceChildren(); for (const [k, v] of Object.entries(table || {})) if (!['ru', 'name_en'].includes(k)) addRow(k, v); };
    setRows(existing?.table);
    const baseSel = el('select', { onchange: e => { const base = P()?.itemsOfKind(kind, editionSel.value).find(i => i.id === e.target.value && i.source === 'встроенный'); if (base) setRows(JSON.parse(JSON.stringify(base.table))); } },
      el('option', { value: '' }, '— пусто —'),
      ...(P()?.itemsOfKind(kind).filter(i => i.source === 'встроенный').map(i => el('option', { value: i.id }, `${labelOf(i)} · ${i.setId}`)) || []));
    const body = el('div', {},
      el('p', { class: 'muted small' }, `${KIND_TITLES[kind] || kind}. ${existing ? 'Изменение своего элемента.' : 'Новый элемент набора.'} Свой элемент перекрывает встроенный с тем же ключом.`),
      el('div', { class: 'field' }, el('label', {}, nameKind ? 'Английское название (ключ связи с записью)' : 'Ключ (id)'), keyInput),
      el('div', { class: 'field' }, el('label', {}, 'Название для показа'), ruInput),
      kindNeedsEdition(kind) ? el('div', { class: 'field' }, el('label', {}, 'Редакция'), editionSel) : null,
      el('div', { class: 'field' }, el('label', {}, 'Взять за основу'), baseSel, el('small', { class: 'muted' }, 'Копирует поля встроенного элемента; ключ и название не меняются.')),
      el('div', { class: 'field' }, el('label', {}, 'Поля'), rowsBox,
        el('button', { type: 'button', class: 'small', onclick: () => addRow() }, '+ Поле'),
        el('small', { class: 'muted' }, 'Значение — текст или JSON (числа, true/false, [списки], {объекты}).')));
    return window.modal(existing ? 'Изменить элемент' : 'Новый элемент', body, [{ label: 'Сохранить', cls: 'primary', fn: () => {
      const key = normKey(keyInput.value);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) { toast?.('Ключ: латиница, цифры, «-» и «_», с буквы или цифры'); return false; }
      const table = {};
      for (const row of rows) {
        const k = row.k.value.trim();
        if (!k) continue;
        try { table[k] = parseValue(row.v.value); } catch { toast?.(`Поле «${k}»: некорректное значение`); return false; }
      }
      if (nameKind) table.name_en = keyInput.value.trim();
      if (ruInput.value.trim()) table.ru = ruInput.value.trim();
      const ed = kindNeedsEdition(kind) ? editionSel.value : '';
      try {
        P().upsertUserItem(kind, { id: key, table }, ed);
        toast?.('Сохранено');
        return { id: key, key: keyInput.value.trim(), edition: ed };
      } catch (err) { toast?.('Не сохранено: ' + err.message, 4000); return false; }
    } }], { wide: true });
  }

  // Поле связи для записи справочника: выбор правил из наборов, ключ, создание и правка правил.
  // data — объект данных записи (меняется на месте), getName — текущее название записи.
  function linkPicker(category, data, opts = {}) {
    const L = LINKS[category];
    const { el } = window;
    if (!L || !P()) return null;
    const edition = opts.edition || data.edition || '2014';
    const keyInput = el('input', { value: data[L.field] || '', placeholder: 'ключ (латиница)', style: 'max-width:240px' });
    const status = el('div', { class: 'muted small', style: 'margin-top:4px' });
    const picker = el('select', { style: 'max-width:360px' });
    const actions = el('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' });
    function fillPicker() {
      const all = P().itemsOfKind(L.kind).sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'ru'));
      picker.replaceChildren(el('option', { value: '' }, '— выбрать из наборов —'),
        ...all.map(i => el('option', { value: i.id, selected: normKey(data[L.field]) === normKey(i.id) ? '' : null }, `${labelOf(i)} · ${i.source}${i.edition ? ' · ' + i.edition : ''}`)));
    }
    function refresh() {
      const found = findRule(category, data, edition);
      const key = String(data[L.field] || '').trim();
      if (!key) status.replaceChildren('Не связано: запись работает без правил набора. Выберите правила или создайте новые.');
      else if (found) status.replaceChildren(`Связано: «${labelOf(found)}» (${found.source}${found.edition ? ', ' + found.edition : ''}).`);
      else status.replaceChildren(`Правил с ключом «${key}» нет. Создайте их или поправьте ключ.`);
      actions.replaceChildren(
        el('button', { type: 'button', class: 'small', onclick: async () => {
          const r = await editElement(L.kind, null, { key: suggestKey(opts.getName?.() || key), name: opts.getName?.() || '', edition });
          if (r) { data[L.field] = isNameKind(L) ? r.key : r.id; keyInput.value = data[L.field]; fillPicker(); refresh(); }
        } }, '+ Создать правила'),
        found && found.source === 'ваш' ? el('button', { type: 'button', class: 'small ghost', onclick: async () => {
          const own = P().ownItemOf(L.kind, found.id, found.edition || edition);
          const r = await editElement(L.kind, { ...own, edition: found.edition || edition }, {});
          if (r) { fillPicker(); refresh(); }
        } }, 'Изменить правила') : null,
        el('button', { type: 'button', class: 'small ghost', onclick: () => window.PresetsEditor?.openSets?.() }, 'Все наборы данных'));
    }
    keyInput.addEventListener('input', () => { data[L.field] = keyInput.value.trim(); fillPicker(); refresh(); });
    picker.addEventListener('change', () => {
      const item = P().itemsOfKind(L.kind).find(i => i.id === picker.value);
      if (!item) return;
      data[L.field] = isNameKind(L) ? (item.table?.name_en || item.id) : item.id;
      keyInput.value = data[L.field];
      refresh();
    });
    fillPicker();
    refresh();
    window.addEventListener?.('presets:changed', () => { fillPicker(); refresh(); });
    return el('div', { class: 'field link-picker' },
      el('label', {}, L.title),
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, keyInput, picker),
      status, actions);
  }

  // Панель элементов всех наборов: выбор вида, список своих и встроенных элементов, добавление и правка.
  function elementsPanel(initialKind) {
    const { el } = window;
    const kinds = P()?.KINDS || [];
    const kindSel = el('select', {}, ...kinds.map(k => el('option', { value: k, selected: k === (initialKind || 'race_rules') ? '' : null }, `${KIND_TITLES[k] || k} (${k})`)));
    const editionSel = el('select', {}, el('option', { value: '' }, 'все редакции'), ...EDITIONS.map(x => el('option', { value: x }, x)));
    const list = el('div', { class: 'elem-list' });
    const hint = el('p', { class: 'muted small' }, 'Встроенные элементы только читаются: «Изменить» сохраняет копию в ваш набор и перекрывает встроенный.');
    function render() {
      const kind = kindSel.value;
      const ed = kindNeedsEdition(kind) ? editionSel.value : '';
      const items = P().itemsOfKind(kind, ed || undefined).sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'ru'));
      const rows = items.map(item => el('div', { class: 'preset-set-row', 'data-item': item.id },
        el('b', {}, labelOf(item)), ' ',
        el('span', { class: 'muted small' }, `ключ ${item.id} · ${item.source}${item.edition ? ' · ' + item.edition : ''}`), ' ',
        el('button', { type: 'button', class: 'small ghost', onclick: async () => { const own = item.source === 'ваш' ? P().ownItemOf(kind, item.id, item.edition) : null; const r = await editElement(kind, own ? { ...own, edition: item.edition } : { ...item, table: JSON.parse(JSON.stringify(item.table)), edition: item.edition }, {}); if (r) render(); } }, item.source === 'ваш' ? 'Изменить' : 'Переопределить'),
        item.source === 'ваш' ? el('button', { type: 'button', class: 'small danger', onclick: () => { if (confirm(`Удалить «${labelOf(item)}» из своих элементов?`)) { P().removeUserItem(kind, item.id, item.edition); render(); } } }, 'Удалить') : null));
      list.replaceChildren(...(rows.length ? rows : [el('p', { class: 'muted small' }, 'Элементов нет.')]));
      addBtn.onclick = async () => { const r = await editElement(kind, null, { edition: ed || '2014' }); if (r) render(); };
    }
    const addBtn = el('button', { type: 'button', class: 'primary small' }, '+ Добавить элемент');
    kindSel.addEventListener('change', render);
    editionSel.addEventListener('change', render);
    render();
    return el('div', { class: 'elements-panel' }, el('h3', {}, 'Элементы наборов'), hint,
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, kindSel, editionSel, addBtn), list);
  }

  // Окно «Наборы данных» со списком элементов (открывается из справочника и редактора графов).
  function openSets() { return window.Presets?.openManager(); }

  window.PresetsEditor = { LINKS, KIND_TITLES, findRule, suggestKey, parseValue, linkPicker, editElement, elementsPanel, openSets };
  if (typeof module !== 'undefined' && module.exports) module.exports = window.PresetsEditor;
})();
