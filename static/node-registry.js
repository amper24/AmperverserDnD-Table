// ---------------------------------------------------------------------------
// node-registry.js — база объектно-ориентированной системы узлов механик v3.
// Формат хранения остаётся version: 2 (граф узлов и связей), палитра — v3.
// Каждый узел — отдельный класс в static/nodes/<категория>/<файл>.js: он наследует
// GraphNode, объявляет метаданные (type/label/group/inputs/outputs/defaults) и своё
// поведение (validate/compute/project) и регистрирует себя через Nodes.register.
// Реестр собирает NODE_DEFS из классов и сохраняет прежний публичный API NodeRegistry
// (catalog/sameType/nodeTitle/...), который читают интерфейс, движок и мастера.
// Тип узла — закрытое имя из реестра: незнакомый тип не имеет определения и в меню не попадает.
// Загружается после mechanics.js и до файлов static/nodes/*. Даёт: window.NodeRegistry, window.Nodes.
// ---------------------------------------------------------------------------
(() => {
  const Base = window.Mechanics;
  if (!Base) throw new Error('mechanics.js должен быть загружен до node-registry.js');
  const clone = value => JSON.parse(JSON.stringify(value));
  // Виды узлов действия (action.*, кроме action.program): один узел — один глагол.
  const ACTION_KINDS = ['roll', 'field', 'spend', 'slot', 'grant_item', 'manual'];
  // Все виды бросков собраны в одном настраиваемом узле «Бросок»: параметр kind выбирает смысл броска.
  const ROLL_KINDS = ['roll', 'attack', 'damage', 'heal', 'temp_hp'];
  const ROLL_KIND_LABELS = { roll: 'Свободный', attack: 'Атака', damage: 'Урон', heal: 'Лечение', temp_hp: 'Временные хиты' };
  // Виды узла «Изменить поле»: состояние, показатель и параметр при создании (три бывших узла).
  const FIELD_KINDS = ['status', 'value', 'formula'];
  const FIELD_KIND_LABELS = { status: 'Состояние', value: 'Показатель', formula: 'Формула' };
  // Вид блока плана (внутренний IR) для вида узла: план и исполнение остаются прежними.
  const FIELD_BLOCKS = { status: 'condition', value: 'adjust', formula: 'passive' };
  // Допустимые поля листа: те же списки, что проверяет сервер (src/mechanics.rs).
  const FIELD_VALUE_FIELDS = {
    speed: 'Скорость', initiative_bonus: 'Инициатива', 'currency.gp': 'Золото', 'currency.sp': 'Серебро',
    'hp.max': 'Максимум хитов', 'abilities.str': 'Сила', 'abilities.dex': 'Ловкость', 'abilities.con': 'Телосложение',
    'abilities.int': 'Интеллект', 'abilities.wis': 'Мудрость', 'abilities.cha': 'Харизма',
  };
  // Поля пассивных параметров при создании: скорость, кость хитов, заклинания, владения и защита без доспехов.
  const FIELD_FORMULA_FIELDS = {
    speed: 'Скорость', hit_die: 'Кость хитов', spellcasting: 'Заклинательная характеристика', saves: 'Спасброски',
    skills: 'Навыки', languages: 'Языки', armor: 'Доспехи', weapons: 'Оружие', unarmored_defense: 'Защита без доспехов',
    'asi.str': 'Повышение Силы', 'asi.dex': 'Повышение Ловкости', 'asi.con': 'Повышение Телосложения',
    'asi.int': 'Повышение Интеллекта', 'asi.wis': 'Повышение Мудрости', 'asi.cha': 'Повышение Харизмы',
  };
  // Логические операции одного узла «Логика»: НЕ использует только вход «a», остальные — «a» и «b».
  // Таблица истинности всех операций одна и та же в клиенте (static/nodes/logic/op.js) и на сервере
  // (src/mechanics_graph.rs graph_output_value).
  const LOGIC_OPS = ['and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor', 'implies'];
  const LOGIC_OP_LABELS = {
    and: 'И', or: 'ИЛИ', not: 'НЕ', xor: 'Исключающее ИЛИ',
    nand: 'И-НЕ', nor: 'ИЛИ-НЕ', xnor: 'Равнозначность', implies: 'Импликация',
  };
  // Закрытые списки параметров условий листа (condition.status/item/hp/slot).
  // Сервер проверяет те же наборы: src/mechanics_graph.rs STATUS_MODES / ITEM_MODES / HP_OPS / SLOT_OPS.
  const STATUS_MODES = ['present', 'absent'];
  const ITEM_MODES = ['owned', 'equipped'];
  const HP_OPS = ['lt', 'le', 'gt', 'ge'];
  const SLOT_OPS = ['gte', 'lt'];
  // Условия листа читаются только в рантайме, поэтому подключаются только ко входу «condition»
  // блока действия (там появляется condition_src). Статические входы enabled и flow.if их не считают.
  const SHEET_CONDITIONS = ['condition.status', 'condition.item', 'condition.hp', 'condition.slot'];
  const VALUE_TYPES = ['flow', 'bool', 'number', 'dice', 'ability', 'text', 'list', 'table', 'choice', 'effect'];
  const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  // Общие помощники вычисляемых узлов (их читают классы из static/nodes/).
  // Узлы, которые сами вычисляют значение из входов (свой compute у класса): предпросмотр и
  // condition-значения читают их через def.compute. condition.context считается отдельно (evaluate).
  // Список обязан совпадать с классами, объявившими compute; это проверяет tests/node-registry.test.cjs.
  // Условия листа (condition.status/item/hp/slot) без листа дают false.
  const COMPUTED = new Set(['data.stat', 'dice.combine', 'data.compare', 'logic.op', 'data.math', 'data.boolean', 'data.result', 'data.sheet', 'data.cast',
    'condition.status', 'condition.item', 'condition.hp', 'condition.slot']);
  const STAT_MODES = ['bonus', 'score'];
  const RULE_VALUE_KINDS = { ability: 'Характеристика', speed: 'Скорость', hp: 'Хиты', hit_die: 'Кость хитов', asi: 'Повышение характеристик', armor_formula: 'Защита без доспехов' };
  const RULE_LIST_KINDS = { languages: 'Языки', proficiencies: 'Владения', skill_proficiency: 'Владение навыком', saving_throws: 'Спасброски', skills: 'Выбор навыков', spell_list: 'Список заклинаний', feature: 'Умение', class_features: 'Умения класса', equipment: 'Снаряжение', equipment_choice: 'Выбор снаряжения' };
  // Виды правила класса: таблица развития, правила кастера, ячейки заклинаний и заклинательная характеристика.
  const RULE_CLASS_KINDS = { class_progression: 'Прогрессия класса', class_rules: 'Правила класса', spell_slots: 'Ячейки заклинаний', spellcasting: 'Заклинательная характеристика' };
  // Виды условия контекста: редакция, уровень, подкласс и выбранный вариант.
  const CONTEXT_KINDS = { edition: 'Редакция', level: 'Уровень', subclass: 'Подкласс', choice: 'Выбранный вариант' };
  const MATH_OPS = ['add', 'sub', 'mul', 'div', 'min', 'max'];
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
    // Проекция параметров узла в блок плана (лишние для вида поля отбрасываются).
    static blockParams(params) { return { ...(params || {}) }; }
    // Проекция правила на лист. env: { get, value, emit, sheet, context, clone, valuesOf, appendProficiency }.
    static project(params, env) {}
  }
  // Реестр: файлы узлов регистрируют классы, NODE_DEFS собирается из них.
  const NODE_DEFS = {};
  function register(cls) { NODE_DEFS[cls.type] = cls; }
  // Умолчания полей действия по виду (block_defaults из наборов + встроенные умолчания).
  function actionDefaults(kind) {
    // Условие «попал / не попал» не хранится в действии: его задаёт узел condition.hit через flow.if.
    // Вход condition (динамическое условие) — отдельный сокет, в умолчаниях его нет.
    const base = { enabled: true };
    const defaultDice = window.Presets?.item('block_defaults', kind)?.table?.dice;
    if (defaultDice) base.dice = Base.dice(defaultDice);
    if (kind === 'roll' && !base.dice) base.dice = Base.dice('1d20');
    // Повышение круга: число костей за каждый круг выше базового (сервер добавляет их к урону/лечению).
    if (kind === 'roll') base.upcast = { count: 1, sides: 6 };
    if (kind === 'spend') Object.assign(base, { resource: 'quantity', source: 'self', amount: 1, trigger: 'use' });
    // Отдельный узел «Расход ячейки»: 0 — круг, выбранный при касте; 1–9 — фиксированный.
    if (kind === 'slot') Object.assign(base, { level: 0, amount: 1 });
    if (kind === 'manual') base.text = 'Опишите правило, которое мастер применяет вручную.';
    // Один узел «Изменить поле»: умолчания всех трёх видов лежат рядом, поэтому переключение вида
    // в форме сразу даёт допустимые параметры (лишние поля не попадают в блок плана).
    if (kind === 'field') Object.assign(base, {
      kind: 'value', field: 'speed', amount: 5,
      condition: window.Presets?.item('conditions', 'poisoned')?.table?.ru || 'poisoned', operation: 'add', value: 30,
    });
    if (kind === 'grant_item') Object.assign(base, { amount: 1, item: { name: 'Пустой флакон', type: 'gear', qty: 1 } });
    return base;
  }
  // Вид блока плана для узла действия: у «Броска» и «Изменить поле» его задаёт параметр kind,
  // «Расход ресурса» компилируется в прежний блок consume. Пустая строка — вид неизвестен.
  function blockKindOf(type, params) {
    const p = params || {};
    if (type === 'action.roll') return ROLL_KINDS.includes(p.kind) ? p.kind : 'roll';
    if (type === 'action.field') return FIELD_BLOCKS[p.kind] || '';
    if (type === 'action.spend') return 'consume';
    if (type === 'action.slot') return 'consume';
    return type.startsWith('action.') ? type.slice(7) : '';
  }
  // Все виды блоков плана, которые даёт узел: для паритета клиента и сервера (tools/srd/integrity.cjs).
  function blockKindsOf(type) {
    if (type === 'action.roll') return [...ROLL_KINDS];
    if (type === 'action.field') return Object.values(FIELD_BLOCKS);
    if (type === 'action.spend') return ['consume'];
    if (type === 'action.slot') return ['consume'];
    if (type === 'action.grant_item') return ['grant_item'];
    if (type === 'action.manual') return ['manual'];
    return [];
  }
  // Параметры блока плана для узла действия: класс узла может отбросить лишние для вида поля.
  function blockParamsOf(type, params) {
    const def = NODE_DEFS[type];
    return def && typeof def.blockParams === 'function' ? def.blockParams(params || {}) : { ...(params || {}) };
  }
  const nodeDef = type => NODE_DEFS[type];
  // Единый префикс заголовка по категории: «Действие · …», «Данные · …», «Условие · …», «Правило · …».
  // «Начало» и «Конец» остаются короткими: их роль понятна по категории.
  const TITLE_PREFIX = { actions: 'Действие', data: 'Данные', conditions: 'Условие', rules: 'Правило' };
  // Заголовок карточки: категория и выбранный режим («Действие · Бросок · Атака», «Правило · Список · Языки»).
  function nodeTitle(type, params = null) {
    const def = NODE_DEFS[type];
    if (!def) return type;
    const p = params || {};
    let title = def.label;
    if (type === 'action.roll') title = `${def.label} · ${ROLL_KIND_LABELS[p.kind] || ROLL_KIND_LABELS.roll}`;
    else if (type === 'action.field') title = `${def.label} · ${FIELD_KIND_LABELS[p.kind] || FIELD_KIND_LABELS.value}`;
    else if (type === 'rule.value') title = `${def.label} · ${RULE_VALUE_KINDS[p.kind] || RULE_VALUE_KINDS.speed}`;
    else if (type === 'rule.list') title = `${def.label} · ${RULE_LIST_KINDS[p.kind] || RULE_LIST_KINDS.languages}`;
    else if (type === 'rule.class') title = `${def.label} · ${RULE_CLASS_KINDS[p.kind] || RULE_CLASS_KINDS.class_progression}`;
    else if (type === 'condition.context') title = `${def.label} · ${CONTEXT_KINDS[p.kind] || CONTEXT_KINDS.level}`;
    else if (type === 'logic.op') title = `${def.label} · ${LOGIC_OP_LABELS[p.op] || LOGIC_OP_LABELS.and}`;
    // «Если» и «Конец» — элементы потока, а не действия: их короткие имена понятны без префикса.
    if (type === 'flow.if' || type === 'flow.end') return title;
    const prefix = TITLE_PREFIX[categoryOf(type).id];
    return prefix && !title.startsWith(prefix) ? `${prefix} · ${title}` : title;
  }
  // Категории меню (порядок показа = рабочий процесс: начало → действия → данные → условия → правила → группы).
  // Узел попадает в первую подходящую категорию.
  const CATEGORIES = [
    { id: 'start', title: 'Начало', match: type => type === 'action.program' },
    { id: 'actions', title: 'Действия', match: type => type.startsWith('action.') || type === 'flow.if' || type === 'flow.end' },
    { id: 'data', title: 'Данные', match: type => type.startsWith('data.') || type === 'dice.combine' || type === 'logic.op' },
    { id: 'conditions', title: 'Условия', match: type => type.startsWith('condition.') },
    { id: 'rules', title: 'Правила', match: type => type.startsWith('rule.') },
    { id: 'groups', title: 'Группы', match: type => type.startsWith('group.') },
  ];
  const INTERNAL = new Set(['group.input', 'group.output']);
  const categoryOf = type => CATEGORIES.find(c => c.match(type)) || CATEGORIES[2];
  // Сокеты совместимы, только если типы совпадают: это же правило проверяет движок (validateGraph).
  const sameType = (fromType, toType) => Boolean(fromType) && fromType === toType;
  // Каталог для меню: категории с узлами, внутренние узлы групп не показываются. Псевдонимы в меню не попадают.
  // description — короткая подсказка для меню (одна строка).
  function catalog(query = '') {
    const q = String(query).trim().toLocaleLowerCase();
    const items = Object.entries(NODE_DEFS)
      .filter(([type]) => !INTERNAL.has(type))
      .map(([type, def]) => ({ type, label: def.label, description: def.description || '', category: categoryOf(type).id, categoryTitle: categoryOf(type).title }))
      .filter(item => !q || `${item.type} ${item.label} ${item.description} ${item.categoryTitle}`.toLocaleLowerCase().includes(q));
    return CATEGORIES.map(c => ({ id: c.id, title: c.title, items: items.filter(item => item.category === c.id).sort((a, b) => a.label.localeCompare(b.label, 'ru')) }))
      .filter(section => section.items.length);
  }
  window.Nodes = { GraphNode, register, actionDefaults, clone };
  window.NodeRegistry = {
    VALUE_TYPES, ACTION_KINDS, ROLL_KINDS, ROLL_KIND_LABELS, LOGIC_OPS, LOGIC_OP_LABELS, ABILITIES,
    STATUS_MODES, ITEM_MODES, HP_OPS, SLOT_OPS, SHEET_CONDITIONS,
    FIELD_KINDS, FIELD_KIND_LABELS, FIELD_BLOCKS, FIELD_VALUE_FIELDS, FIELD_FORMULA_FIELDS, blockKindOf, blockKindsOf, blockParamsOf,
    COMPUTED, STAT_MODES, COMPARE_OPS, MATH_OPS, RULE_VALUE_KINDS, RULE_LIST_KINDS, RULE_CLASS_KINDS, CONTEXT_KINDS, isStatId, statDice, diceTerm,
    idText, stringList, tableValue, equipmentItemsValue, equipmentChoiceValue,
    NODE_DEFS, nodeDef, nodeTitle, CATEGORIES, categoryOf, sameType, catalog, INTERNAL,
  };
})();
