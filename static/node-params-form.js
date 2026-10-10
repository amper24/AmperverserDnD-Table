// ---------------------------------------------------------------------------
// node-params-form.js — формы параметров узлов графа механик без ручного JSON.
// Поля строятся по самому значению: число, текст, флаг, список, вложенный объект,
// таблица (объект с ключами-уровнями) и список объектов. Чистые помощники
// (getAt/setAt/removeAt/emptyLike) не зависят от DOM и проверяются в тестах.
// Загружается до mechanics-graph.js. Произвольный код не исполняется.
// ---------------------------------------------------------------------------
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const ABILS = [['str', 'Сила'], ['dex', 'Ловкость'], ['con', 'Телосложение'], ['int', 'Интеллект'], ['wis', 'Мудрость'], ['cha', 'Харизма']]
    .map(([value, label]) => ({ value, label }));
  const SPELL_MODES = [{ value: 'known', label: 'Известные' }, { value: 'prepared', label: 'Подготовленные' }, { value: 'book', label: 'Из книги' }];
  const EDITIONS = [{ value: '2014', label: 'SRD 2014' }, { value: '2024', label: 'SRD 2024' }];
  // Ключ → закрытый список вариантов (выпадающий список).
  const ENUMS = { ability: ABILS, stat: [{ value: '', label: '—' }, ...ABILS] };
  // Ключ → список вариантов с множественным выбором.
  const ENUM_MULTI = { editions: EDITIONS };
  // Поля, которые задают узел-тип (переопределяют общие ENUMS для конкретного типа узла).
  const TYPE_ENUMS = {
    'data.ability': { value: ABILS },
    'rule.ability_bonus': { ability: ABILS },
    'rule.spell_list': { mode: SPELL_MODES },
  };
  // Служебные идентификаторы: видны, но не редактируются вручную.
  const READ_ONLY = new Set(['block_id', 'program_id']);
  // Ключи, у которых вложенный объект — это таблица «ключ → значение» (строки можно добавлять и удалять).
  const MAP_KEYS = new Set(['table', 'choices', 'by_level']);
  const LABELS = {
    value: 'Значение', amount: 'Количество', ability: 'Характеристика', count: 'Количество', sides: 'Граней',
    bonus: 'Бонус', stat: 'Модификатор', text: 'Текст', name: 'Название', min: 'Минимум', max: 'Максимум',
    editions: 'Редакции', id: 'ID', options: 'Варианты', spells: 'Заклинания', mode: 'Режим', table: 'Таблица',
    formula: 'Формула', field: 'Поле', kind: 'Тип', group_id: 'Группа', socket_id: 'Вход / выход', trigger: 'Запуск',
    resource: 'Ресурс', source: 'Источник', when: 'Когда', target: 'Цель', operation: 'Операция', condition: 'Состояние',
    feature_name: 'Имя умения', item: 'Предмет', dice: 'Кость', enabled: 'Включено', minimum: 'Минимум', choice: 'Выбор',
    subclass: 'Подкласс', level: 'Уровень', edition: 'Редакция', hp: 'Хиты', program_id: 'ID программы', block_id: 'ID блока',
    choices: 'Выборы', spell: 'Заклинание', mode_label: 'Режим', prompt: 'Подсказка', description: 'Описание',
  };
  const labelOf = key => LABELS[key] || key;

  // ---- чистые помощники -------------------------------------------------
  const getAt = (root, path) => path.reduce((node, key) => node?.[key], root);
  function setAt(root, path, value) {
    if (!path.length) return clone(value);
    const next = clone(root);
    let target = next;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path[path.length - 1]] = clone(value);
    return next;
  }
  function removeAt(root, path) {
    const next = clone(root), parent = getAt(next, path.slice(0, -1)), key = path[path.length - 1];
    if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key];
    return next;
  }
  // Пустой экземпляр той же формы: числа → 0, флаги → false, строки → '', структура сохраняется.
  function emptyLike(sample) {
    if (typeof sample === 'number') return 0;
    if (typeof sample === 'boolean') return false;
    if (Array.isArray(sample)) return [];
    if (sample && typeof sample === 'object') return Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, emptyLike(v)]));
    return '';
  }
  function isMap(obj, key, forced) {
    if (forced || MAP_KEYS.has(key)) return true;
    const keys = Object.keys(obj);
    return keys.length > 0 && keys.every(k => /^\d+$/.test(k));
  }
  const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  // ---- DOM --------------------------------------------------------------
  function mount(initial, options = {}) {
    let current = clone(initial ?? {});
    const enums = { ...ENUMS, ...(options.enums || {}) };
    if (options.groups) enums.group_id = options.groups;
    const root = el('div', { class: 'param-form', role: 'group', 'aria-label': options.ariaLabel || 'Параметры' });

    const emit = next => { current = next; options.onChange?.(clone(current)); paint(); };
    const setValue = (path, value) => emit(setAt(current, path, value));
    const removeValue = path => emit(removeAt(current, path));

    function paint() {
      const rows = isPlainObject(current) ? Object.entries(current).map(([key, value]) => field(labelOf(key), value, [key], key, false, false)) : [];
      root.replaceChildren(...rows, isPlainObject(current) && options.map ? addKeyRow([]) : null);
    }

    function addKeyRow(path) {
      const input = el('input', { placeholder: 'Ключ, например 5', 'aria-label': 'Новый ключ' });
      return el('div', { class: 'param-add-key' }, input, el('button', {
        class: 'small', type: 'button',
        onclick: () => {
          const key = String(input.value || '').trim().slice(0, 80);
          if (!key) return;
          const target = getAt(current, path);
          if (!isPlainObject(target) || Object.prototype.hasOwnProperty.call(target, key)) return;
          const sample = Object.values(target)[0];
          setValue([...path, key], emptyLike(sample ?? ''));
        },
      }, 'Добавить'));
    }

    function field(label, value, path, key, inList, forceMap) {
      if (typeof value === 'boolean') {
        return el('label', { class: 'param-row param-check' }, el('input', { type: 'checkbox', checked: value ? '' : null, onchange: e => setValue(path, e.target.checked) }), label);
      }
      if (typeof value === 'number') {
        return el('label', { class: 'node-field param-row' }, el('span', { class: 'param-label' }, label), el('input', { type: 'number', value: String(value), onchange: e => {
          const n = e.target.value === '' ? 0 : Number(e.target.value);
          if (Number.isFinite(n)) setValue(path, n);
        } }));
      }
      if (Array.isArray(value)) return arrayField(label, value, path, key, forceMap);
      if (isPlainObject(value)) return objectField(label, value, path, key, forceMap, inList);
      return textField(label, value == null ? '' : String(value), path, key);
    }

    function textField(label, value, path, key) {
      const enumList = enums[key];
      if (enumList) {
        return el('label', { class: 'node-field param-row' }, el('span', { class: 'param-label' }, label), el('select', { onchange: e => setValue(path, e.target.value) },
          ...enumList.map(option => el('option', { value: option.value, selected: option.value === value ? '' : null }, option.label))));
      }
      if (READ_ONLY.has(key)) return el('label', { class: 'node-field param-row' }, el('span', { class: 'param-label' }, label), el('input', { value, disabled: '', title: 'Служебный идентификатор' }));
      const long = key === 'text' || key === 'description' || value.length > 120;
      if (long) return el('label', { class: 'node-field param-row' }, el('span', { class: 'param-label' }, label), el('textarea', { rows: 3, onchange: e => setValue(path, String(e.target.value).slice(0, 2000)) }, value));
      return el('label', { class: 'node-field param-row' }, el('span', { class: 'param-label' }, label), el('input', { value, onchange: e => setValue(path, String(e.target.value).slice(0, 2000)) }));
    }

    function arrayField(label, value, path, key, forceMap) {
      if (ENUM_MULTI[key]) {
        const picked = new Set(Array.isArray(value) ? value : []);
        return el('div', { class: 'param-row' }, el('span', { class: 'param-label' }, label), el('div', { class: 'param-checks' }, ...ENUM_MULTI[key].map(option => el('label', { class: 'param-check' },
          el('input', { type: 'checkbox', checked: picked.has(option.value) ? '' : null, onchange: e => {
            const next = new Set(picked);
            if (e.target.checked) next.add(option.value); else next.delete(option.value);
            setValue(path, ENUM_MULTI[key].map(o => o.value).filter(v => next.has(v)));
          } }), option.label))));
      }
      if (value.every(item => item === null || typeof item !== 'object')) {
        const numeric = value.length > 0 && value.every(item => typeof item === 'number');
        return el('label', { class: 'node-field param-row' }, el('span', { class: 'param-label' }, label), el('input', { value: value.join(', '), placeholder: 'через запятую', onchange: e => {
          const items = String(e.target.value).split(',').map(item => item.trim()).filter(Boolean).slice(0, 200);
          setValue(path, numeric ? items.map(Number).filter(Number.isFinite) : items);
        } }));
      }
      const items = value.map((item, index) => el('div', { class: 'param-item' },
        el('div', { class: 'param-item-head' }, el('span', { class: 'param-label' }, `${label} ${index + 1}`),
          el('button', { class: 'small danger', type: 'button', title: 'Удалить строку', onclick: () => removeValue([...path, index]) }, '×')),
        field(`${label} ${index + 1}`, item, [...path, index], key, true, forceMap)));
      return el('div', { class: 'param-list' }, el('span', { class: 'param-label' }, label), ...items,
        el('button', { class: 'small', type: 'button', onclick: () => setValue([...path, value.length], emptyLike(value[0] ?? {})) }, '+ Добавить'));
    }

    function objectField(label, value, path, key, forceMap, inList) {
      const map = isMap(value, key, forceMap);
      const rows = Object.entries(value).map(([childKey, childValue]) => {
        const childPath = [...path, childKey];
        if (!map) return field(labelOf(childKey), childValue, childPath, childKey, false, false);
        return el('div', { class: 'param-item' }, el('div', { class: 'param-item-head' }, el('span', { class: 'param-label' }, childKey),
          el('button', { class: 'small danger', type: 'button', title: 'Удалить строку', onclick: () => removeValue(childPath) }, '×')),
          field(childKey, childValue, childPath, childKey, false, false));
      });
      if (map) {
        const input = el('input', { placeholder: 'Ключ, например 5', 'aria-label': `Новый ключ: ${label}` });
        const add = () => {
          const childKey = String(input.value || '').trim().slice(0, 80);
          if (!childKey || Object.prototype.hasOwnProperty.call(value, childKey)) return;
          setValue([...path, childKey], emptyLike(Object.values(value)[0] ?? ''));
        };
        rows.push(el('div', { class: 'param-add-key' }, input, el('button', { class: 'small', type: 'button', onclick: add }, 'Добавить')));
      }
      return el('fieldset', { class: 'param-group' + (inList ? ' in-list' : '') }, el('legend', {}, label), ...rows);
    }

    paint();
    return root;
  }

  const API = {
    getAt, setAt, removeAt, emptyLike, isMap, LABELS, ENUMS, TYPE_ENUMS,
    // Форма параметров узла графа. node.params меняется только после нажатия на поле (onchange).
    nodeParams(node, options = {}) {
      const enums = TYPE_ENUMS[node?.type] || {};
      return mount(node?.params || {}, { ...options, enums, ariaLabel: 'Параметры узла' });
    },
    // Редактор произвольного значения (например, выборы для предпросмотра).
    valueEditor(value, options = {}) {
      return mount(value || {}, { ...options, map: options.map ?? true });
    },
  };
  window.NodeForm = API;
})();
