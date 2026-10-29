const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/node-menu.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));

test('every node definition has a category and the menu lists only registry nodes', () => {
  const types = Object.keys(R.NODE_DEFS).filter(type => !R.INTERNAL.has(type));
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => item.type)));
  assert.deepEqual(listed.slice().sort(), types.slice().sort());
  for (const type of types) assert.ok(R.categoryOf(type).id, type);
});

test('menu categories follow the working order and every node has a one-line description', () => {
  const order = plain(R.catalog('').map(section => section.id));
  assert.deepEqual(order, ['start', 'actions', 'data', 'conditions', 'rules', 'groups']);
  const titles = plain(R.catalog('').map(section => section.title));
  assert.deepEqual(titles, ['Начало', 'Действия', 'Данные', 'Условия', 'Правила', 'Группы']);
  for (const [type, def] of Object.entries(R.NODE_DEFS)) {
    assert.match(String(def.description || ''), /^[^\n]{8,120}$/, `${type}: короткое описание одной строкой`);
  }
  const described = plain(R.catalog('').flatMap(section => section.items.map(item => item.description)));
  assert.ok(described.every(text => text.length > 0), 'описание попадает в каталог меню');
});

test('search matches labels, categories and descriptions case-insensitively and returns nothing for nonsense', () => {
  const found = plain(R.catalog('УСЛОВИ').flatMap(section => section.items.map(item => item.type)));
  assert.ok(found.length > 0);
  assert.ok(found.every(type => R.categoryOf(type).id === 'conditions' || /услов/i.test(R.NODE_DEFS[type].description || '') || /услов/i.test(R.NODE_DEFS[type].label)), found.join(','));
  assert.ok(found.includes('condition.context') && found.includes('condition.hit'), 'условия находятся');
  assert.ok(plain(R.catalog('кость').flatMap(section => section.items.map(item => item.type))).includes('data.dice'), 'поиск идёт и по описанию');
  assert.deepEqual(plain(R.catalog('zzz-no-such-node-zzz')), []);
});

test('node titles are uniform by category', () => {
  assert.equal(R.nodeTitle('action.roll', { kind: 'attack' }), 'Действие · Бросок · Атака');
  assert.equal(R.nodeTitle('action.spend', {}), 'Действие · Расход ресурса');
  assert.equal(R.nodeTitle('action.grant_item', {}), 'Действие · Выдать предмет');
  assert.equal(R.nodeTitle('action.manual', {}), 'Действие · Ручное правило');
  assert.equal(R.nodeTitle('data.number', {}), 'Данные · Число');
  assert.equal(R.nodeTitle('data.dice', {}), 'Данные · Кость');
  assert.equal(R.nodeTitle('logic.op', { op: 'and' }), 'Данные · Логика · И');
  assert.equal(R.nodeTitle('rule.value', { kind: 'speed' }), 'Правило · Скорость');
  assert.equal(R.nodeTitle('rule.list', { kind: 'spell_list' }), 'Правило · Список · Список заклинаний');
  assert.equal(R.nodeTitle('rule.list', {}), 'Правило · Список · Языки');
  assert.equal(R.nodeTitle('rule.class', { kind: 'spellcasting' }), 'Правило · Класс · Заклинательная характеристика');
  assert.equal(R.nodeTitle('rule.class', {}), 'Правило · Класс · Прогрессия класса');
  assert.equal(R.nodeTitle('condition.context', { kind: 'edition' }), 'Условие · Редакция');
  assert.equal(R.nodeTitle('condition.context', { kind: 'choice' }), 'Условие · Выбранный вариант');
  assert.equal(R.nodeTitle('condition.context', {}), 'Условие · Уровень');
  assert.equal(R.nodeTitle('condition.hit', {}), 'Условие · Попадание атаки');
  assert.equal(R.nodeTitle('action.program', {}), 'Начало действия');
  assert.equal(R.nodeTitle('flow.end', {}), 'Конец');
});

test('every action has enabled and condition, the program starts the flow, the end receives exec', () => {
  for (const kind of R.ACTION_KINDS) {
    const def = R.nodeDef(`action.${kind}`);
    assert.ok(def, kind);
    assert.equal(def.inputs.exec, 'flow', `${kind}: exec`);
    assert.equal(def.inputs.enabled, 'bool', `${kind}: enabled`);
    assert.equal(def.inputs.condition, 'bool', `${kind}: condition`);
    assert.equal(def.outputs.exec, 'flow', `${kind}: выход exec`);
  }
  const program = R.nodeDef('action.program');
  assert.equal(program.outputs.exec, 'flow', 'program: exec');
  assert.ok(['use', 'passive'].includes(program.defaults.trigger), 'program: trigger');
  assert.equal(R.nodeDef('flow.end').inputs.exec, 'flow', 'flow.end: exec');
});

test('sockets are compatible only with identical types', () => {
  assert.equal(R.sameType('number', 'number'), true);
  assert.equal(R.sameType('number', 'text'), false);
  assert.equal(R.sameType(undefined, undefined), false);
});

test('registry does not expose internal group sockets in the menu', () => {
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => item.type)));
  for (const type of R.INTERNAL) assert.ok(!listed.includes(type), type);
});

test('context menu add sections come from the registry and return the chosen node type', () => {
  const sections = plain(ctx.window.NodeMenu.addSections('число'));
  assert.ok(sections.length > 0);
  const item = ctx.window.NodeMenu.addSections('число')[0].items[0];
  assert.deepEqual(plain(item.run()), { type: item.hint });
  assert.ok(item.title.length > 0, 'у пункта меню есть подсказка');
  assert.ok(R.NODE_DEFS[item.hint], item.hint);
});

test('v3 action nodes show their kind and live in the palette categories', () => {
  assert.equal(R.nodeTitle('action.field', { kind: 'status' }), 'Действие · Изменить поле · Состояние');
  assert.equal(R.nodeTitle('action.field', { kind: 'formula' }), 'Действие · Изменить поле · Формула');
  assert.equal(R.nodeTitle('action.field', {}), 'Действие · Изменить поле · Показатель');
  assert.equal(R.categoryOf('action.field').id, 'actions');
  assert.equal(R.categoryOf('action.spend').id, 'actions');
  assert.equal(R.categoryOf('action.slot').id, 'actions');
  assert.equal(R.categoryOf('action.roll').id, 'actions');
  assert.equal(R.categoryOf('action.program').id, 'start');
  assert.equal(R.categoryOf('flow.end').id, 'actions');
  assert.equal(R.categoryOf('data.compare').id, 'data');
  assert.equal(R.categoryOf('data.cast').id, 'data');
  assert.equal(R.categoryOf('logic.op').id, 'data');
  assert.equal(R.categoryOf('rule.list').id, 'rules');
  assert.deepEqual(plain(R.blockKindsOf('action.field')), ['condition', 'adjust', 'passive']);
  assert.deepEqual(plain(R.blockKindsOf('action.spend')), ['consume']);
  assert.deepEqual(plain(R.blockKindsOf('action.slot')), ['consume']);
  assert.equal(R.blockKindOf('action.field', { kind: 'formula' }), 'passive');
  assert.equal(R.blockKindOf('action.field', { kind: 'unknown' }), '');
  assert.equal(R.blockKindOf('action.spend', {}), 'consume');
  assert.equal(R.blockKindOf('action.slot', {}), 'consume');
  assert.equal(R.blockKindOf('action.roll', { kind: 'attack' }), 'attack');
  assert.equal(R.blockKindOf('action.roll', {}), 'roll');
  assert.equal(R.blockKindOf('action.roll', { kind: 'save' }), 'roll', 'неизвестный вид — свободный бросок');
});

test('action.slot compiles to a consume block with the chosen or fixed circle', () => {
  assert.equal(R.nodeTitle('action.slot', {}), 'Действие · Расход ячейки');
  assert.match(R.nodeDef('action.slot').description, /выбранного или фиксированного круга/);
  assert.equal(R.nodeDef('action.slot').validate({ level: 0, amount: 1 }), '');
  assert.equal(R.nodeDef('action.slot').validate({ level: 9, amount: 2 }), '');
  assert.match(R.nodeDef('action.slot').validate({ level: 10, amount: 1 }), /0 до 9/);
  assert.match(R.nodeDef('action.slot').validate({ level: 1, amount: 0 }), /1 до 10000/);
  assert.deepEqual(plain(R.blockParamsOf('action.slot', { level: 0, amount: 1, block_id: 's' })),
    { amount: 1, block_id: 's', resource: 'slot', source: 'self', trigger: 'use', slot_level: 0 });
  assert.equal(R.blockParamsOf('action.slot', { level: 3, amount: 2, block_id: 's' }).slot_level, 3);
  assert.equal(R.nodeDef('action.spend').validate({ resource: 'slot', source: 'self', amount: 1, trigger: 'use' }), 'Расход: ресурс quantity, charges или uses.');
  assert.equal(R.nodeDef('action.slot').defaults.level, 0, 'по умолчанию круг выбирается при касте');
});

test('action.roll validates upcast and data.cast exposes the cast circle', () => {
  const roll = R.nodeDef('action.roll');
  assert.deepEqual(plain(roll.defaults.upcast), { count: 1, sides: 6 });
  assert.equal(roll.validate({ upcast: { count: 1, sides: 6 } }), '');
  assert.match(roll.validate({ upcast: { count: 0, sides: 0 } }), /грани 1–1000/);
  assert.match(roll.validate({ upcast: { count: 101, sides: 6 } }), /0–100/);
  const cast = R.nodeDef('data.cast');
  assert.equal(R.nodeTitle('data.cast', {}), 'Данные · Круг каста');
  assert.equal(cast.outputs.value, 'number');
  assert.equal(cast.validate({ field: 'level' }), '');
  assert.equal(cast.validate({ field: 'extra' }), '');
  assert.match(cast.validate({ field: 'slot' }), /level, base или extra/);
  assert.equal(cast.compute(), 0, 'без каста в редакторе — 0');
  assert.ok(R.COMPUTED.has('data.cast'), 'узел вычисляется в предпросмотре');
});
