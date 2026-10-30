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
  // Стили кнопок действия: параметр style у узла «Начало действия». Иконка — из набора ICONS (common.js).
  const BUTTON_STYLES = {
    default: { label: 'Обычная', icon: 'd20' },
    attack: { label: 'Атака', icon: 'sword' },
    spell: { label: 'Заклинание', icon: 'star' },
    heal: { label: 'Лечение', icon: 'heart' },
    damage: { label: 'Урон', icon: 'zap' },
    item: { label: 'Предмет', icon: 'flask' },
    defense: { label: 'Защита', icon: 'shield' },
  };
  const BUTTON_STYLE_OPTIONS = Object.entries(BUTTON_STYLES).map(([value, s]) => ({ value, label: s.label }));
  // Поля, которые задают узел-тип (переопределяют общие ENUMS для конкретного типа узла).
  const TYPE_ENUMS = {
    'rule.list': { kind: [{ value: 'languages', label: 'Языки' }, { value: 'proficiencies', label: 'Владения' }, { value: 'skill_proficiency', label: 'Владение навыком' }, { value: 'saving_throws', label: 'Спасброски' }, { value: 'skills', label: 'Выбор навыков' }, { value: 'spell_list', label: 'Список заклинаний' }, { value: 'feature', label: 'Умение' }, { value: 'class_features', label: 'Умения класса' }, { value: 'equipment', label: 'Снаряжение' }, { value: 'equipment_choice', label: 'Выбор снаряжения' }], mode: SPELL_MODES },
    'rule.class': { kind: [{ value: 'class_progression', label: 'Прогрессия класса' }, { value: 'class_rules', label: 'Правила класса' }, { value: 'spell_slots', label: 'Ячейки заклинаний' }, { value: 'spellcasting', label: 'Заклинательная характеристика' }], ability: ABILS },
    // Одно условие контекста: вид выбирается выпадающим списком, редакции — множественным выбором.
    'condition.context': { kind: [{ value: 'edition', label: 'Редакция' }, { value: 'level', label: 'Уровень' }, { value: 'subclass', label: 'Подкласс' }, { value: 'choice', label: 'Выбранный вариант' }], editions: EDITIONS },
    // Условия листа: закрытые списки режимов и операций сравнения.
    'condition.status': { mode: [{ value: 'present', label: 'Наложено' }, { value: 'absent', label: 'Не наложено' }] },
    'condition.item': { mode: [{ value: 'owned', label: 'Есть в снаряжении' }, { value: 'equipped', label: 'Надето или в руках' }] },
    'condition.hp': { op: [{ value: 'lt', label: '< меньше' }, { value: 'le', label: '≤ меньше или равно' }, { value: 'gt', label: '> больше' }, { value: 'ge', label: '≥ больше или равно' }] },
    'condition.slot': { op: [{ value: 'gte', label: '≥ не меньше' }, { value: 'lt', label: '< меньше' }] },
    'action.program': { style: BUTTON_STYLE_OPTIONS },
    'data.compare': { op: [{ value: '>=', label: '≥ больше или равно' }, { value: '<=', label: '≤ меньше или равно' }, { value: '>', label: '> больше' }, { value: '<', label: '< меньше' }, { value: '=', label: '= равно' }, { value: '!=', label: '≠ не равно' }] },
    // Результат действия: поле — из закрытого списка, источник — программы текущего графа (динамически).
    'data.result': { field: [{ value: 'total', label: 'Итог броска' }, { value: 'hit', label: 'Попадание (0/1)' }, { value: 'applied', label: 'Применено (лечение, хиты)' }, { value: 'spent', label: 'Израсходовано' }] },
    // Один узел «Изменить поле»: вид задаёт, какие параметры показывать (см. FIELD_HIDDEN).
    'action.field': {
      kind: [{ value: 'status', label: 'Состояние — наложить или снять' }, { value: 'value', label: 'Показатель — изменить число' }, { value: 'formula', label: 'Формула — параметр при создании' }],
      operation: [{ value: 'add', label: 'Наложить' }, { value: 'remove', label: 'Снять' }, { value: 'concentration', label: 'Концентрация (имя заклинания)' }],
    },
    // Ресурсы предмета и умения; ячейка заклинания — отдельный узел «Расход ячейки».
    'action.spend': {
      resource: [{ value: 'quantity', label: 'Количество' }, { value: 'charges', label: 'Заряды' }, { value: 'uses', label: 'Использования' }],
      source: [{ value: 'self', label: 'Сам предмет / умение' }, { value: 'item', label: 'Предмет' }, { value: 'tag', label: 'Метка' }],
      trigger: [{ value: 'use', label: 'При использовании' }, { value: 'attack', label: 'За атаку' }],
    },
    'data.cast': {
      field: [{ value: 'level', label: 'Круг выбранной ячейки' }, { value: 'base', label: 'Базовый круг заклинания' }, { value: 'extra', label: 'Круги выше базового' }],
    },
    // Вызов группы-функции: группа выбирается динамически (список передаёт редактор),
    // тип результата — закрытый список value-типов.
    'data.call': { result: [
      { value: 'number', label: 'Число' }, { value: 'text', label: 'Текст' },
      { value: 'bool', label: 'Логическое значение' }, { value: 'list', label: 'Список' },
    ] },
    'rule.value': { kind: [{ value: 'ability', label: 'Характеристика (+ к значению)' }, { value: 'speed', label: 'Скорость' }, { value: 'hp', label: 'Хиты' }, { value: 'hit_die', label: 'Кость хитов' }, { value: 'asi', label: 'Повышение характеристик' }, { value: 'armor_formula', label: 'Защита без доспехов' }], ability: ABILS },
    'data.math': { op: [{ value: 'add', label: 'Сложить (a + b)' }, { value: 'sub', label: 'Вычесть (a − b)' }, { value: 'mul', label: 'Умножить (a × b)' }, { value: 'div', label: 'Разделить (a ÷ b)' }, { value: 'min', label: 'Минимум' }, { value: 'max', label: 'Максимум' }] },
    // Математика одного числа: операция выбирается списком (таблица та же, что mathfunValue в реестре).
    'data.mathfun': { op: [
      { value: 'min', label: 'Минимум из a и b' }, { value: 'max', label: 'Максимум из a и b' },
      { value: 'clamp', label: 'Ограничить диапазоном b…c' }, { value: 'abs', label: 'Модуль' },
      { value: 'round', label: 'Округлить (от 0,5 вверх)' }, { value: 'floor', label: 'Округлить вниз' },
      { value: 'ceil', label: 'Округлить вверх' }, { value: 'sign', label: 'Знак: −1, 0 или 1' },
    ] },
    // Строки: операция одного узла выбирается списком, сравнение — операцией и флагом регистра.
    'data.text': { op: [
      { value: 'concat', label: 'Склеить a и b' }, { value: 'upper', label: 'Верхний регистр' },
      { value: 'lower', label: 'Нижний регистр' }, { value: 'trim', label: 'Убрать пробелы по краям' },
    ] },
    'data.textcheck': { op: [
      { value: 'contains', label: 'Содержит' }, { value: 'starts', label: 'Начинается с' },
      { value: 'ends', label: 'Заканчивается на' }, { value: 'eq', label: 'Равно' }, { value: 'ne', label: 'Не равно' },
    ] },
    // Переменная действия или листа: область задаётся списком.
    'action.setvar': { scope: [{ value: 'action', label: 'Действие — до конца выполнения' }, { value: 'sheet', label: 'Лист — сохранить в sheet.vars' }] },
    'data.var': { scope: [{ value: 'action', label: 'Действие — до конца выполнения' }, { value: 'sheet', label: 'Лист — из sheet.vars' }] },
    'data.stat': { mode: [{ value: 'bonus', label: 'Бонус (модификатор)' }, { value: 'score', label: 'Значение (навык — пассивное)' }] },
    // Один настраиваемый узел всех бросков: тип броска выбирается выпадающим списком прямо на карточке.
    'action.roll': { kind: [
      { value: 'roll', label: 'Свободный бросок' }, { value: 'attack', label: 'Бросок атаки' }, { value: 'damage', label: 'Урон' },
      { value: 'heal', label: 'Лечение' }, { value: 'temp_hp', label: 'Временные хиты' },
    ] },
    // Один логический узел: операция И / ИЛИ / НЕ / исключающее ИЛИ / И-НЕ / ИЛИ-НЕ / равнозначность /
    // импликация («НЕ» использует только вход «a»).
    'logic.op': { op: [
      { value: 'and', label: 'И — оба условия' }, { value: 'or', label: 'ИЛИ — хотя бы одно' }, { value: 'not', label: 'НЕ — обратное значение' },
      { value: 'xor', label: 'Исключающее ИЛИ — только одно из двух' }, { value: 'nand', label: 'И-НЕ — не оба сразу' },
      { value: 'nor', label: 'ИЛИ-НЕ — ни одного' }, { value: 'xnor', label: 'Равнозначность — одинаковые' },
      { value: 'implies', label: 'Импликация — из «a» следует «b»' },
    ] },
  };
  // Список характеристик и навыков для узла «Характеристика / навык»: навыки берутся из набора SKILLS (common.js).
  const statIdOptions = () => [...ABILS, ...(window.SKILLS || []).map(([value, label]) => ({ value, label: `${label} (навык)` }))];
  // Служебные идентификаторы: видны, но не редактируются вручную.
  const READ_ONLY = new Set(['block_id', 'program_id']);
  // Поле «Когда» у действий больше не редактируется: условие задаёт узел condition.hit через «Если».
  const HIDDEN = new Set(['when']);
  // У «Изменить поле» лишние для выбранного вида параметры не показываются (в узле они сохраняются:
  // переключение вида не теряет значения). Компиляция всё равно берёт только поля своего вида.
  const FIELD_HIDDEN = {
    status: new Set(['field', 'amount', 'value']),
    value: new Set(['condition', 'operation', 'value']),
    formula: new Set(['condition', 'operation', 'amount']),
  };
  const fieldKindHidden = params => FIELD_HIDDEN[params?.kind] || FIELD_HIDDEN.value;
  // Варианты поля листа для вида узла «Изменить поле»: подписи — из реестра (FIELD_VALUE_FIELDS / FIELD_FORMULA_FIELDS).
  function fieldOptions(params) {
    const registry = window.NodeRegistry || {};
    const source = params?.kind === 'formula' ? registry.FIELD_FORMULA_FIELDS : params?.kind === 'value' ? registry.FIELD_VALUE_FIELDS : null;
    return source ? Object.entries(source).map(([value, label]) => ({ value, label: `${label} (${value})` })) : null;
  }
  // Режим карточки на холсте: только короткие скалярные поля (число, флаг, строка, список чисел/строк, кость).
  // Таблицы, списки объектов, длинный текст и служебные ID остаются в боковой панели.
  function shownField(key, value, inline) {
    if (HIDDEN.has(key)) return false;
    if (!inline) return true;
    if (READ_ONLY.has(key)) return false;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 120 && key !== 'text' && key !== 'description';
    if (Array.isArray(value)) return value.every(item => item === null || typeof item !== 'object');
    if (value && typeof value === 'object' && !Array.isArray(value)) return key === 'dice';
    return false;
  }
  // Ключи, у которых вложенный объект — это таблица «ключ → значение» (строки можно добавлять и удалять).
  const MAP_KEYS = new Set(['table', 'choices', 'by_level']);
  const LABELS = {
    value: 'Значение', style: 'Стиль кнопки', amount: 'Количество', ability: 'Характеристика', count: 'Количество', sides: 'Граней',
    bonus: 'Бонус', stat: 'Модификатор', text: 'Текст', name: 'Название', min: 'Минимум', max: 'Максимум',
    editions: 'Редакции', id: 'ID', options: 'Варианты', spells: 'Заклинания', mode: 'Режим', table: 'Таблица',
    formula: 'Формула', field: 'Поле', kind: 'Тип', group_id: 'Группа', socket_id: 'Вход / выход', trigger: 'Запуск',
    resource: 'Ресурс', source: 'Источник', when: 'Когда', target: 'Цель', operation: 'Операция', condition: 'Состояние',
    feature_name: 'Имя умения', item: 'Предмет', dice: 'Кость', enabled: 'Включено', minimum: 'Минимум', choice: 'Выбор',
    subclass: 'Подкласс', level: 'Уровень / круг (0 — круг каста)', edition: 'Редакция', hp: 'Хиты', program_id: 'ID программы', block_id: 'ID блока',
    upcast: 'Повышение круга (кости)', base: 'Базовый круг', extra: 'Лишние круги',
    choices: 'Выборы', spell: 'Заклинание', mode_label: 'Режим', prompt: 'Подсказка', description: 'Описание',
    kind: 'Тип', op: 'Операция', damage_type: 'Тип урона', grip: 'Хват', apply: 'Применить к листу',
    // Параметры узлов правил и таблиц (чтобы не показывать сырые английские ключи).
    items: 'Предметы', title: 'Название', gold: 'Золото', qty: 'Количество', type: 'Тип',
    levels: 'Уровни', slots: 'Ячейки', columns: 'Колонки', pb: 'Бонус мастерства', requirements: 'Требования',
    caster: 'Заклинатель', multiclass: 'Мультикласс', no_shield: 'Запрет щита', label: 'Метка вида',
    percent: 'Процент от максимума', scope: 'Область', node: 'Узел',
    separator: 'Разделитель', case: 'Учитывать регистр', group: 'Группа-функция',
  };
  // Подписи полей, которые зависят от типа узла: у data.list items — строки списка, а не «Предметы».
  const TYPE_LABELS = { 'data.list': { items: 'Строки списка' } };
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
    // Подписи полей: общие (LABELS) и уточнённые типом узла (options.labels).
    const labels = options.labels || {};
    const labelFor = key => labels[key] || labelOf(key);
    if (options.groups) enums.group_id = options.groups;
    const root = el('div', { class: 'param-form', role: 'group', 'aria-label': options.ariaLabel || 'Параметры' });

    const emit = next => { current = next; options.onChange?.(clone(current)); paint(); };
    const setValue = (path, value) => emit(setAt(current, path, value));
    const removeValue = path => emit(removeAt(current, path));

    function paint() {
      const rows = isPlainObject(current) ? Object.entries(current)
        .filter(([key, value]) => !(options.hide && options.hide.has(key)) && shownField(key, value, !!options.inline))
        .map(([key, value]) => field(labelFor(key), value, [key], key, false, false)) : [];
      // Строка «новый ключ» только для таблиц; null в replaceChildren стал бы текстом «null» на карточке.
      root.replaceChildren(...rows, ...(isPlainObject(current) && options.map ? [addKeyRow([])] : []));
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
        if (!map) return field(labelFor(childKey), childValue, childPath, childKey, false, false);
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
    getAt, setAt, removeAt, emptyLike, isMap, LABELS, ENUMS, TYPE_ENUMS, TYPE_LABELS,
    // Форма параметров узла графа. node.params меняется только после нажатия на поле (onchange).
    nodeParams(node, options = {}) {
      const enums = { ...(TYPE_ENUMS[node?.type] || {}), ...(node?.type === 'data.stat' ? { id: statIdOptions() } : {}) };
      // data.result читает результат конкретной программы или последнего действия графа.
      if (node?.type === 'data.result') enums.source = [{ value: 'last', label: 'Последнее действие' }, ...(options.programs || [])];
      // data.ref выбирает числовой узел текущего графа (существование и циклы проверяет граф).
      if (node?.type === 'data.ref') enums.node = [{ value: '', label: '— выберите узел —' }, ...(options.refNodes || [])];
      // data.call выбирает группу-функцию: редактор передаёт только value-only группы с одним выходом.
      if (node?.type === 'data.call') enums.group = [{ value: '', label: '— выберите группу —' }, ...(options.callGroups || options.groups || [])];
      // У «Изменить поле» список полей зависит от вида: value и formula принимают разные поля листа.
      const fields = node?.type === 'action.field' ? fieldOptions(node?.params) : null;
      if (fields) enums.field = fields;
      const hide = node?.type === 'action.field' ? fieldKindHidden(node?.params) : null;
      const labels = TYPE_LABELS[node?.type] || null;
      return mount(node?.params || {}, { ...options, enums, hide, labels, ariaLabel: options.inline ? 'Параметры на карточке' : 'Параметры узла' });
    },
    // Редактор произвольного значения (например, выборы для предпросмотра).
    valueEditor(value, options = {}) {
      return mount(value || {}, { ...options, map: options.map ?? true });
    },
  };
  window.NodeForm = API;
  window.BUTTON_STYLES = BUTTON_STYLES;
})();
