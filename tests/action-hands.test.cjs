// Узел «Руки» (action.hands) и дополнительные слоты рук (extra1..extra4, sheet.extra_hands).
// Проверяются: реестр и палитра, валидация параметров, форма, проекция в план, а также клиентские
// правила слотов (Equipment.choices/migrate) — зеркало серверного src/inventory.rs.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat().filter(value => value !== null && value !== undefined); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = {
  window: { addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {} },
  console, crypto: require('node:crypto').webcrypto, el, toast() {},
  localStorage: { getItem() { return null; }, setItem() {} },
  document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } },
  ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' },
  SKILLS: [['acrobatics', 'Акробатика', 'dex'], ['stealth', 'Скрытность', 'dex']],
};
vm.createContext(ctx);
// Наборы (static/presets) нужны Equipment для разбора названий предметов.
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js', 'static/equipment.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}
const R = ctx.window.NodeRegistry;
const M = ctx.window.Mechanics;
const NF = ctx.window.NodeForm;
const E = ctx.window.Equipment;
const plain = value => JSON.parse(JSON.stringify(value));
const item = (name, props = {}) => E.normalize({ name, type: 'weapon', handedness: 'one', qty: 1, ...props });

test('action.hands объявляет порты, умолчания и живёт в категории «Действия»', () => {
  const def = R.NODE_DEFS['action.hands'];
  assert.ok(def, 'узел зарегистрирован');
  assert.deepEqual(plain(def.inputs), { exec: 'flow', enabled: 'bool', condition: 'bool' });
  assert.deepEqual(plain(def.outputs), { exec: 'flow' });
  assert.deepEqual(plain(def.defaults), { enabled: true, operation: 'add', count: 1 });
  assert.equal(def.isAction, true);
  assert.equal(R.categoryOf('action.hands').id, 'actions');
  assert.equal(R.nodeTitle('action.hands', {}), 'Действие · Руки');
  assert.ok(plain(R.catalog('руки').flatMap(section => section.items.map(entry => entry.type))).includes('action.hands'), 'узел есть в палитре по поиску «руки»');
  assert.deepEqual(plain(R.blockKindsOf('action.hands')), ['hands'], 'план получает блок hands');
  assert.equal(R.blockKindOf('action.hands', {}), 'hands');
});

test('валидация action.hands: операция add/remove/set и число рук 1–6', () => {
  const def = R.NODE_DEFS['action.hands'];
  for (const operation of ['add', 'remove', 'set']) {
    assert.equal(def.validate({ operation, count: 1 }), '', `${operation}: одна рука`);
    assert.equal(def.validate({ operation, count: 6 }), '', `${operation}: шесть рук`);
  }
  assert.match(def.validate({ operation: 'grow', count: 1 }), /add, remove или set/);
  assert.match(def.validate({ count: 1 }), /add, remove или set/);
  assert.match(def.validate({ operation: 'add', count: 0 }), /от 1 до 6/);
  assert.match(def.validate({ operation: 'add', count: 7 }), /от 1 до 6/);
  assert.match(def.validate({ operation: 'add', count: 1.5 }), /от 1 до 6/);
  assert.match(def.validate({ operation: 'add', count: '2' }), /от 1 до 6/);
  // Форма: операция — выпадающий список, число рук — числовое поле с подписью узла.
  assert.deepEqual(plain(NF.TYPE_ENUMS['action.hands'].operation.map(option => option.value)), ['add', 'remove', 'set']);
  assert.match(NF.TYPE_LABELS['action.hands'].count, /set — всего/);
  assert.doesNotThrow(() => NF.nodeParams({ id: 'n1', type: 'action.hands', params: plain(def.defaults) }));
});

function handsMechanics(operation, count) {
  return { version: 2, graph: {
    nodes: [
      { id: 'p', type: 'action.program', params: { program_id: 'use', name: 'Руки', trigger: 'use' } },
      { id: 'h', type: 'action.hands', params: { block_id: 'h', operation, count, enabled: true } },
      { id: 'e', type: 'flow.end', params: {} },
    ],
    links: [
      { from: { node: 'p', socket: 'exec' }, to: { node: 'h', socket: 'exec' } },
      { from: { node: 'h', socket: 'exec' }, to: { node: 'e', socket: 'exec' } },
    ],
    frames: [], groups: [],
  } };
}

test('план-проекция: action.hands компилируется в блок hands без лишних полей', () => {
  const mechanics = handsMechanics('set', 3);
  assert.equal(M.validate(mechanics), '', 'граф сохраняется');
  const plan = plain(M.toLegacy(mechanics));
  assert.deepEqual(plan.programs.map(program => program.id), ['use']);
  assert.deepEqual(plan.programs[0].blocks, [{ operation: 'set', count: 3, enabled: true, id: 'h', kind: 'hands' }]);
  assert.equal(M.TYPES.hands[0], 'Руки', 'предпросмотр блока называет действие');
});

test('предпросмотр отклоняет недопустимое число рук и неизвестную операцию', () => {
  const tooMany = handsMechanics('add', 7);
  assert.match(M.validate(tooMany), /от 1 до 6/);
  const unknown = handsMechanics('grow', 1);
  assert.match(M.validate(unknown), /add, remove или set/);
  // Граф с ошибкой не исполняется, но запись остаётся сохранной: план не строится молча.
  assert.equal(M.validate(handsMechanics('add', 6)), '');
});

test('дополнительные руки листа добавляют слоты extra1..extraN', () => {
  const dagger = item('Кинжал');
  assert.deepEqual(plain(E.choices(dagger)), ['main', 'off'], 'без extra_hands — только две руки');
  assert.deepEqual(plain(E.choices(dagger, { extra_hands: 2 })), ['main', 'off', 'extra1', 'extra2']);
  assert.deepEqual(plain(E.handSlots({ extra_hands: 1 })), ['main', 'off', 'extra1']);
  assert.equal(E.extraHands({ extra_hands: 3 }), 3);
  assert.equal(E.extraHands({ extra_hands: 9 }), E.MAX_EXTRA_HANDS, 'значение вне 0..4 подрезается');
  assert.equal(E.extraHands({}), 0);
  assert.equal(E.slots.extra1, 'Доп. рука 1');
  assert.equal(E.slots.extra4, 'Доп. рука 4');
  assert.deepEqual(plain(E.extraSlots(2)), ['extra1', 'extra2']);
  // Предмет без слота при нормализации получает свободную дополнительную руку.
  const list = [item('Меч'), item('Щит', { type: 'armor', ac: '+2' }), item('Кинжал')];
  list[0].equipped = true; list[0].hand_slot = 'main';
  list[1].equipped = true; list[1].hand_slot = 'off';
  list[2].equipped = true;
  E.migrate(list, 1);
  assert.equal(list[2].hand_slot, 'extra1');
});

test('двуручное не берётся в дополнительную руку, а снятая рука освобождает слот', () => {
  const bow = item('Длинный лук', { handedness: 'two' });
  assert.deepEqual(plain(E.choices(bow, { extra_hands: 2 })), ['main', 'off', 'both'], 'двуручному дополнительные руки не предлагаются');
  // Двуручное в extra1 — недопустимый слот: migrate возвращает предмет в рюкзак.
  bow.equipped = true; bow.hand_slot = 'extra1';
  E.migrate([bow], 2);
  assert.equal(bow.equipped, false);
  assert.equal(bow.hand_slot, null);
  // Кинжал в extra1 при двух руках остаётся, а при extra_hands = 0 — снимается с сохранением qty.
  const dagger = item('Кинжал');
  dagger.equipped = true; dagger.hand_slot = 'extra1';
  E.migrate([dagger], 2);
  assert.equal(dagger.hand_slot, 'extra1');
  E.migrate([dagger], 0);
  assert.equal(dagger.equipped, false);
  assert.equal(dagger.hand_slot, null);
  assert.equal(dagger.qty, 1);
});

test('слоты по правилам показывают дополнительные руки только при extra_hands', () => {
  const plainAudit = E.slotsAudit({ inventory: [] });
  assert.equal(plainAudit.rows.length, 12, 'без дополнительных рук строк столько же, сколько раньше');
  assert.ok(!plainAudit.rows.some(row => row.key === 'extra1'));
  const audit = E.slotsAudit({ extra_hands: 2, inventory: [] });
  assert.deepEqual(plain(audit.rows.slice(0, 4).map(row => row.key)), ['main', 'off', 'extra1', 'extra2']);
  assert.equal(audit.rows.find(row => row.key === 'extra2').label, 'Доп. рука 2');
});
