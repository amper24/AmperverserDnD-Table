// ---------------------------------------------------------------------------
// node-registry.js — единый реестр узлов механик v2: типы данных, входы/выходы, настройки по умолчанию,
// категории для меню и проверка совместимости сокетов. Интерфейс и движок читают только этот реестр.
// Чтобы добавить узел, достаточно строки в NODE_DEFS (вход/выход/тип/категория/настройки) и обработчика
// исполнения в движке. Загружается после mechanics.js и до mechanics-graph.js. Даёт: window.NodeRegistry.
// ---------------------------------------------------------------------------
(() => {
  const Base = window.Mechanics;
  if (!Base) throw new Error('mechanics.js должен быть загружен до node-registry.js');
  const clone = value => JSON.parse(JSON.stringify(value));
  const ACTION_KINDS = ['consume', 'attack', 'damage', 'heal', 'temp_hp', 'roll', 'grant_item', 'condition', 'adjust', 'require', 'manual', 'passive'];
  const VALUE_TYPES = ['flow', 'bool', 'number', 'dice', 'ability', 'text', 'list', 'table', 'choice', 'effect'];
  const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const NODE_DEFS = {
    'data.number': { label: 'Число', group: 'Данные', inputs: {}, outputs: { value: 'number' }, defaults: { value: 1 } },
    'data.dice': { label: 'Кость', group: 'Данные', inputs: {}, outputs: { value: 'dice' }, defaults: { value: { count: 1, sides: 6, bonus: 0, stat: '' } } },
    'data.ability': { label: 'Характеристика', group: 'Данные', inputs: {}, outputs: { value: 'ability' }, defaults: { value: 'str' } },
    'data.table': { label: 'Таблица по уровню', group: 'Данные', inputs: {}, outputs: { value: 'table' }, defaults: { value: {} } },
    'data.choice': { label: 'Выбор', group: 'Данные', inputs: {}, outputs: { value: 'choice' }, defaults: { value: { id: '', count: 1, options: [] } } },
    'data.text': { label: 'Текст', group: 'Данные', inputs: {}, outputs: { value: 'text' }, defaults: { value: '' } },
    'condition.edition': { label: 'Если редакция', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { editions: ['2014'] } },
    'condition.level': { label: 'Если уровень', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { min: 1, max: 20 } },
    'condition.subclass': { label: 'Если подкласс', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { id: '' } },
    'condition.choice': { label: 'Если выбран вариант', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { id: '', value: '' } },
    // Попадание последней атаки в цепочке. Подключается только ко входу «condition» узла «Если»: ветви «да»/«нет» задают гейт действий.
    'condition.hit': { label: 'Попадание атаки', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: {} },
    'flow.if': { label: 'Если', group: 'Поток', inputs: { exec: 'flow', condition: 'bool' }, outputs: { then: 'flow', else: 'flow' }, defaults: {} },
    'rule.ability_bonus': { label: 'Бонус характеристики', group: 'Правила персонажа', inputs: { enabled: 'bool', amount: 'number' }, outputs: { effect: 'effect' }, defaults: { ability: 'str', amount: 1 } },
    'rule.speed': { label: 'Скорость', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'number' }, outputs: { effect: 'effect' }, defaults: { value: 30 } },
    'rule.languages': { label: 'Языки', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'list' }, outputs: { effect: 'effect' }, defaults: { value: [] } },
    'rule.proficiencies': { label: 'Владения', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'list' }, outputs: { effect: 'effect' }, defaults: { kind: 'general', value: [] } },
    'rule.hit_die': { label: 'Кость хитов', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'text' }, outputs: { effect: 'effect' }, defaults: { value: 'd8' } },
    'rule.saving_throws': { label: 'Спасброски', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'list' }, outputs: { effect: 'effect' }, defaults: { value: [] } },
    'rule.feature': { label: 'Умение', group: 'Правила персонажа', inputs: { enabled: 'bool' }, outputs: { effect: 'effect' }, defaults: { name: 'Новое умение', text: '', feature_name: '' } },
    'rule.skills': { label: 'Выбор навыков', group: 'Правила персонажа', inputs: { enabled: 'bool', options: 'list', count: 'number' }, outputs: { effect: 'effect' }, defaults: { id: '', count: 1, options: [] } },
    'rule.spell_list': { label: 'Список заклинаний', group: 'Правила персонажа', inputs: { enabled: 'bool', spells: 'list' }, outputs: { effect: 'effect' }, defaults: { mode: 'known', ability: 'int', spells: [] } },
    'rule.spell_slots': { label: 'Ячейки заклинаний', group: 'Правила персонажа', inputs: { enabled: 'bool', table: 'table' }, outputs: { effect: 'effect' }, defaults: { table: {} } },
    'rule.asi': { label: 'Улучшение характеристик', group: 'Правила персонажа', inputs: { enabled: 'bool', table: 'table' }, outputs: { effect: 'effect' }, defaults: { table: {} } },
    'rule.class_progression': { label: 'Прогрессия класса', group: 'Правила персонажа', inputs: { enabled: 'bool', table: 'table' }, outputs: { effect: 'effect' }, defaults: { table: {} } },
    'rule.armor_formula': { label: 'Защита без доспехов', group: 'Правила персонажа', inputs: { enabled: 'bool', formula: 'text' }, outputs: { effect: 'effect' }, defaults: { formula: '10 + @dex + @con', name: 'Защита без доспехов', no_shield: false } },
    'rule.hp_bonus': { label: 'Бонус хитов', group: 'Правила персонажа', inputs: { enabled: 'bool', amount: 'number' }, outputs: { effect: 'effect' }, defaults: { amount: 1 } },
    'rule.manual': { label: 'Ручное правило', group: 'Правила персонажа', inputs: { enabled: 'bool', text: 'text' }, outputs: { effect: 'effect' }, defaults: { text: 'Опишите правило, которое применяется вручную.' } },
    'action.program': { label: 'Действие / программа', group: 'Действия', inputs: {}, outputs: { exec: 'flow' }, defaults: { program_id: '', name: 'Новое действие', trigger: 'use' } },
    'group.instance': { label: 'Группа', group: 'Группы', inputs: {}, outputs: {}, defaults: { group_id: '' } },
    'group.input': { label: 'Вход группы', group: 'Группы', inputs: {}, outputs: { value: 'text' }, defaults: { socket_id: '' } },
    'group.output': { label: 'Выход группы', group: 'Группы', inputs: { value: 'text' }, outputs: {}, defaults: { socket_id: '' } },
  };
  for (const kind of ACTION_KINDS) {
    NODE_DEFS[`action.${kind}`] = {
      label: Base.TYPES[kind]?.[0] || kind, group: 'Действия',
      inputs: { exec: 'flow', enabled: 'bool' }, outputs: { exec: 'flow' }, defaults: actionDefaults(kind),
    };
  }
  function actionDefaults(kind) {
    // Условие «попал / не попал» не хранится в действии: его задаёт узел condition.hit через flow.if.
    const base = { enabled: true };
    if (['attack', 'damage', 'heal', 'temp_hp', 'roll'].includes(kind)) base.dice = Base.dice(kind === 'attack' ? '1d20+@atk' : '1d6');
    if (kind === 'consume') Object.assign(base, { resource: 'quantity', source: 'self', amount: 1, trigger: 'use' });
    if (kind === 'manual') base.text = 'Опишите правило, которое мастер применяет вручную.';
    if (kind === 'passive') Object.assign(base, { field: 'speed', value: 30 });
    if (kind === 'condition') Object.assign(base, { condition: 'Отравленный', operation: 'add' });
    if (kind === 'adjust') Object.assign(base, { field: 'speed', amount: 5 });
    if (kind === 'require') Object.assign(base, { field: 'hp.current', minimum: 1 });
    if (kind === 'grant_item') Object.assign(base, { amount: 1, item: { name: 'Пустой флакон', type: 'gear', qty: 1 } });
    return base;
  }
  // Категории меню (порядок показа). Узел попадает в первую подходящую категорию.
  const CATEGORIES = [
    { id: 'data', title: 'Данные', match: type => type.startsWith('data.') },
    { id: 'conditions', title: 'Условия', match: type => type.startsWith('condition.') },
    { id: 'flow', title: 'Поток управления', match: type => type.startsWith('flow.') || type === 'action.program' },
    { id: 'combat', title: 'Бой', match: type => ['action.attack', 'action.damage', 'action.heal', 'action.temp_hp', 'action.roll'].includes(type) },
    { id: 'effects', title: 'Эффекты', match: type => ['action.condition', 'action.adjust', 'action.grant_item', 'action.passive'].includes(type) },
    { id: 'resources', title: 'Ресурсы', match: type => ['action.consume', 'action.require'].includes(type) },
    { id: 'character', title: 'Персонаж', match: type => type.startsWith('rule.') },
    { id: 'groups', title: 'Группы', match: type => type.startsWith('group.') },
    { id: 'other', title: 'Прочее', match: type => type.startsWith('action.') },
  ];
  const INTERNAL = new Set(['group.input', 'group.output']);
  const categoryOf = type => (CATEGORIES.find(c => c.id !== 'other' && c.match(type)) || CATEGORIES[CATEGORIES.length - 1]);
  // Сокеты совместимы, только если типы совпадают: это же правило проверяет движок (validateGraph).
  const sameType = (fromType, toType) => Boolean(fromType) && fromType === toType;
  // Каталог для меню: категории с узлами, внутренние узлы групп не показываются.
  function catalog(query = '') {
    const q = String(query).trim().toLocaleLowerCase();
    const items = Object.entries(NODE_DEFS)
      .filter(([type]) => !INTERNAL.has(type))
      .map(([type, def]) => ({ type, label: def.label, category: categoryOf(type).id, categoryTitle: categoryOf(type).title }))
      .filter(item => !q || `${item.type} ${item.label} ${item.categoryTitle}`.toLocaleLowerCase().includes(q));
    return CATEGORIES.map(c => ({ id: c.id, title: c.title, items: items.filter(item => item.category === c.id).sort((a, b) => a.label.localeCompare(b.label, 'ru')) }))
      .filter(section => section.items.length);
  }
  window.NodeRegistry = { VALUE_TYPES, ACTION_KINDS, ABILITIES, NODE_DEFS, CATEGORIES, categoryOf, sameType, catalog, INTERNAL };
})();
