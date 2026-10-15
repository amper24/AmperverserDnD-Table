// ---------------------------------------------------------------------------
// node-registry.js — база объектно-ориентированной системы узлов механик v2.
// Каждый узел — отдельный класс в static/nodes/<категория>/<файл>.js: он наследует
// GraphNode, объявляет метаданные (type/label/group/inputs/outputs/defaults) и своё
// поведение (validate/compute/project) и регистрирует себя через Nodes.register.
// Реестр собирает NODE_DEFS из классов и сохраняет прежний публичный API NodeRegistry
// (catalog/sameType/nodeTitle/...), который читают интерфейс, движок и мастера.
// Старые типы узлов (action.attack, logic.and, …) — псевдонимы (ALIASES), читаются без миграции.
// Загружается после mechanics.js и до файлов static/nodes/*. Даёт: window.NodeRegistry, window.Nodes.
// ---------------------------------------------------------------------------
(() => {
  const Base = window.Mechanics;
  if (!Base) throw new Error('mechanics.js должен быть загружен до node-registry.js');
  const clone = value => JSON.parse(JSON.stringify(value));
  // Виды блоков v1: их по-прежнему понимает компиляция графа в линейные программы (toLegacy).
  const ACTION_KINDS = ['consume', 'attack', 'damage', 'heal', 'temp_hp', 'roll', 'grant_item', 'condition', 'adjust', 'require', 'manual', 'passive'];
  // Все виды бросков собраны в одном настраиваемом узле «Бросок»: параметр roll_kind выбирает смысл броска.
  const ROLL_KINDS = ['roll', 'attack', 'damage', 'heal', 'temp_hp'];
  const ROLL_KIND_LABELS = { roll: 'Свободный', attack: 'Атака', damage: 'Урон', heal: 'Лечение', temp_hp: 'Временные хиты' };
  // Логические операции одного узла «Логика»: НЕ использует только вход «a».
  const LOGIC_OPS = ['and', 'or', 'not'];
  const LOGIC_OP_LABELS = { and: 'И', or: 'ИЛИ', not: 'НЕ' };
  // Эффекты без броска: у каждого свой набор параметров, поэтому они остаются отдельными узлами.
  const EFFECT_KINDS = ['consume', 'grant_item', 'condition', 'adjust', 'require', 'manual', 'passive'];
  const VALUE_TYPES = ['flow', 'bool', 'number', 'dice', 'ability', 'text', 'list', 'table', 'choice', 'effect'];
  const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  // Общие помощники вычисляемых узлов (их читают классы из static/nodes/).
  const COMPUTED = new Set(['data.stat', 'dice.combine', 'condition.compare', 'logic.op']);
  const STAT_MODES = ['bonus', 'score'];
  const COMPARE_OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };
  const isStatId = id => ABILITIES.includes(id) || (window.SKILLS || []).some(skill => skill[0] === id);
  function statDice(p) {
    const id = String(p.id || '');
    const term = ABILITIES.includes(id) ? (p.mode === 'score' ? `@${id}_score` : `@${id}`) : (p.mode === 'score' ? `10+@${id}` : `@${id}`);
    return { count: 0, sides: 6, bonus: 0, stat: '', advanced: term };
  }
  // Текст формулы кости — одна реализация на проект: Mechanics.expression (совпадает с серверной formula()).
  function diceTerm(d) {
    if (window.Mechanics?.expression) return window.Mechanics.expression(d);
    if (d?.advanced) return String(d.advanced);
    const count = Number(d?.count) || 0, sides = Number(d?.sides) || 0, bonus = Number(d?.bonus) || 0;
    let out = count > 0 && sides > 0 ? `${count}d${sides}` : '';
    if (bonus) out += out ? (bonus > 0 ? '+' : '') + bonus : String(bonus);
    if (d?.stat) out += (out ? '+' : '') + '@' + d.stat;
    return out || '0';
  }
  // Общие проверки параметров, переиспользуемые классами узлов в validate().
  const idText = (value, max = 80) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const stringList = value => Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 200);
  const tableValue = value => value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 100000;
  const equipmentItemsValue = value => Array.isArray(value) && value.length <= 100 && value.every(item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim() && item.name.length <= 120 && (item.qty === undefined || (Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 1000)));
  const equipmentChoiceValue = value => value && typeof value === 'object' && (value.id === undefined || (typeof value.id === 'string' && value.id.length <= 100)) && (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 120)) && Array.isArray(value.options) && value.options.length >= 1 && value.options.length <= 50 && value.options.every(option => option && typeof option === 'object' && typeof option.name === 'string' && option.name.trim() && option.name.length <= 120 && equipmentItemsValue(option.items) && (option.gold === undefined || (Number.isInteger(option.gold) && option.gold >= 0 && option.gold <= 1000000)));
  // ---------------------------------------------------------------------------
  // Базовый класс узла: метаданные и поведение. Каждый узел — подкласс в
  // static/nodes/<категория>/<файл>.js, регистрирующий себя через Nodes.register.
  // ---------------------------------------------------------------------------
  class GraphNode {
    static type = '';
    static label = 'Узел';
    static group = 'Прочее';
    static inputs = {};
    static outputs = {};
    static defaults = {};
    static isAction = false;
    static isComputed = false;
    static isRule = false;
    // Проверка параметров: '' — допустимо, иначе текст ошибки.
    static validate(params) { return ''; }
    // Значение вычисляемого узла: get(socket) → значение входа или undefined. undefined — неизвестно.
    static compute(params, get) { return undefined; }
    // Проекция правила на лист. env: { get, value, emit, sheet, context, clone, valuesOf, appendProficiency }.
    static project(params, env) {}
  }
  // Реестр: файлы узлов регистрируют классы, NODE_DEFS собирается из них.
  const NODE_DEFS = {};
  function register(cls) { NODE_DEFS[cls.type] = cls; }
  // Умолчания полей действия по виду (block_defaults из наборов + встроенные умолчания).
  function actionDefaults(kind) {
    // Условие «попал / не попал» не хранится в действии: его задаёт узел condition.hit через flow.if.
    const base = { enabled: true };
    const defaultDice = window.Presets?.item('block_defaults', kind)?.table?.dice;
    if (defaultDice) base.dice = Base.dice(defaultDice);
    if (kind === 'roll' && !base.dice) base.dice = Base.dice('1d20');
    if (kind === 'consume') Object.assign(base, { resource: 'quantity', source: 'self', amount: 1, trigger: 'use' });
    if (kind === 'manual') base.text = 'Опишите правило, которое мастер применяет вручную.';
    if (kind === 'passive') Object.assign(base, { field: 'speed', value: 30 });
    if (kind === 'condition') Object.assign(base, { condition: window.Presets?.item('conditions', 'poisoned')?.table?.ru || 'poisoned', operation: 'add' });
    if (kind === 'adjust') Object.assign(base, { field: 'speed', amount: 5 });
    if (kind === 'require') Object.assign(base, { field: 'hp.current', minimum: 1 });
    if (kind === 'grant_item') Object.assign(base, { amount: 1, item: { name: 'Пустой флакон', type: 'gear', qty: 1 } });
    return base;
  }
  // Псевдонимы старых специализированных узлов: тип → [абстрактный тип, параметры, которые задаёт тип].
  // Нужны, чтобы графы из базы, шаблоны и пресеты прошлых версий читались без миграции данных вручную.
  const ALIASES = {
    'action.attack': ['action.roll', { roll_kind: 'attack' }],
    'action.damage': ['action.roll', { roll_kind: 'damage' }],
    'action.heal': ['action.roll', { roll_kind: 'heal' }],
    'action.temp_hp': ['action.roll', { roll_kind: 'temp_hp' }],
    'logic.and': ['logic.op', { op: 'and' }],
    'logic.or': ['logic.op', { op: 'or' }],
    'logic.not': ['logic.op', { op: 'not' }],
  };
  const resolveType = type => (ALIASES[type] ? ALIASES[type][0] : type);
  const aliasParams = type => (ALIASES[type] ? clone(ALIASES[type][1]) : null);
  const nodeDef = type => NODE_DEFS[resolveType(type)];
  // Заголовок карточки: настраиваемые узлы показывают выбранный режим («Бросок · Атака», «Логика · И»).
  function nodeTitle(type, params = null) {
    const resolved = resolveType(type);
    const def = NODE_DEFS[resolved];
    if (!def) return type;
    const p = { ...(aliasParams(type) || {}), ...(params || {}) };
    if (resolved === 'action.roll') return `${def.label} · ${ROLL_KIND_LABELS[p.roll_kind] || ROLL_KIND_LABELS.roll}`;
    if (resolved === 'logic.op') return `${def.label} · ${LOGIC_OP_LABELS[p.op] || LOGIC_OP_LABELS.and}`;
    return def.label;
  }
  // Категории меню (порядок показа). Узел попадает в первую подходящую категорию.
  const CATEGORIES = [
    { id: 'data', title: 'Данные', match: type => type.startsWith('data.') || type === 'dice.combine' },
    { id: 'conditions', title: 'Условия', match: type => type.startsWith('condition.') },
    { id: 'logic', title: 'Логика', match: type => type.startsWith('logic.') },
    { id: 'flow', title: 'Поток управления', match: type => type.startsWith('flow.') || type === 'action.program' },
    { id: 'combat', title: 'Броски', match: type => type === 'action.roll' },
    { id: 'effects', title: 'Эффекты', match: type => ['action.condition', 'action.adjust', 'action.grant_item', 'action.passive'].includes(type) },
    { id: 'resources', title: 'Ресурсы', match: type => ['action.consume', 'action.require'].includes(type) },
    { id: 'character', title: 'Персонаж', match: type => type.startsWith('rule.') },
    { id: 'groups', title: 'Группы', match: type => type.startsWith('group.') },
    { id: 'other', title: 'Прочее', match: type => type.startsWith('action.') },
  ];
  const INTERNAL = new Set(['group.input', 'group.output']);
  const categoryOf = type => (CATEGORIES.find(c => c.id !== 'other' && c.match(resolveType(type))) || CATEGORIES[CATEGORIES.length - 1]);
  // Сокеты совместимы, только если типы совпадают: это же правило проверяет движок (validateGraph).
  const sameType = (fromType, toType) => Boolean(fromType) && fromType === toType;
  // Каталог для меню: категории с узлами, внутренние узлы групп не показываются. Псевдонимы в меню не попадают.
  function catalog(query = '') {
    const q = String(query).trim().toLocaleLowerCase();
    const items = Object.entries(NODE_DEFS)
      .filter(([type]) => !INTERNAL.has(type))
      .map(([type, def]) => ({ type, label: def.label, category: categoryOf(type).id, categoryTitle: categoryOf(type).title }))
      .filter(item => !q || `${item.type} ${item.label} ${item.categoryTitle}`.toLocaleLowerCase().includes(q));
    return CATEGORIES.map(c => ({ id: c.id, title: c.title, items: items.filter(item => item.category === c.id).sort((a, b) => a.label.localeCompare(b.label, 'ru')) }))
      .filter(section => section.items.length);
  }
  window.Nodes = { GraphNode, register, actionDefaults, clone };
  window.NodeRegistry = {
    VALUE_TYPES, ACTION_KINDS, ROLL_KINDS, ROLL_KIND_LABELS, LOGIC_OPS, LOGIC_OP_LABELS, ABILITIES,
    COMPUTED, STAT_MODES, COMPARE_OPS, isStatId, statDice, diceTerm,
    idText, stringList, tableValue, equipmentItemsValue, equipmentChoiceValue,
    NODE_DEFS, ALIASES, resolveType, aliasParams, nodeDef, nodeTitle, CATEGORIES, categoryOf, sameType, catalog, INTERNAL,
  };
})();
