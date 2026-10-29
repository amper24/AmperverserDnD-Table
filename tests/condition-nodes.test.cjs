// Условия листа (condition.status/item/hp/slot): закрытые узлы категории «Условия», проверка
// параметров и предпросмотр без листа (false -> блок с таким условием пропускается).
// Серверный рантайм (лист в context["runtime"]["sheet"]) проверяют Rust-тесты src/mechanics_graph.rs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat(); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, console };
ctx.window.SKILLS = [['acrobatics', 'Акробатика', 'dex'], ['stealth', 'Скрытность', 'dex']];
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
const R = ctx.window.NodeRegistry;
const M = ctx.window.Mechanics;
const NF = ctx.window.NodeForm;
const plain = value => JSON.parse(JSON.stringify(value));
const node = (id, type, params = {}) => ({ id, type, params: { ...plain(R.NODE_DEFS[type]?.defaults || {}), ...params } });
const program = (id = 'p') => node(id, 'action.program', { program_id: id, name: 'Действие', trigger: 'use' });
const wire = (from, fromSocket, to, toSocket) => ({ from: { node: from, socket: fromSocket }, to: { node: to, socket: toSocket } });
const graphOf = (nodes, links) => { const graph = { nodes, links, frames: [], groups: [] }; M.addFlowEnds(graph); return { version: 2, graph }; };
// Виды условий и их допустимые/недопустимые параметры.
const KINDS = {
  'condition.status': { valid: { name: 'Отравленный', mode: 'present' }, modes: ['present', 'absent'], bad: [{ name: '', mode: 'present' }, { name: 'Отравленный', mode: 'maybe' }] },
  'condition.item': { valid: { name: 'Кинжал', mode: 'equipped' }, modes: ['owned', 'equipped'], bad: [{ name: '   ', mode: 'owned' }, { name: 'Кинжал', mode: 'worn' }] },
  'condition.hp': { valid: { op: 'le', value: 25, percent: true }, ops: ['lt', 'le', 'gt', 'ge'], bad: [{ op: 'eq', value: 10, percent: false }, { op: 'lt', value: 150, percent: true }, { op: 'lt', value: -1, percent: false }] },
  'condition.slot': { valid: { level: 2, op: 'lt', value: 1 }, ops: ['gte', 'lt'], bad: [{ level: 0, op: 'gte', value: 1 }, { level: 10, op: 'gte', value: 1 }, { level: 1, op: 'gt', value: 1 }, { level: 1, op: 'gte', value: 21 }] },
};

test('условия листа — узлы категории «Условия» с логическим выходом и без входов', () => {
  for (const type of Object.keys(KINDS)) {
    const def = R.NODE_DEFS[type];
    assert.ok(def, `${type}: узел зарегистрирован`);
    assert.equal(R.categoryOf(type).id, 'conditions', `${type}: категория «Условия»`);
    assert.match(R.nodeTitle(type, {}), /^Условие · /, `${type}: единый заголовок карточки`);
    assert.deepEqual(plain(def.outputs), { value: 'bool' }, `${type}: выход value — bool`);
    assert.deepEqual(plain(def.inputs), {}, `${type}: входов нет`);
    assert.equal(def.isComputed, true);
    assert.ok(R.COMPUTED.has(type), `${type}: вычисляется в предпросмотре`);
    assert.match(String(def.description), /^[^\n]{8,120}$/, `${type}: короткое описание одной строкой`);
  }
  assert.equal(R.nodeDef('condition.hp').label, 'Хиты');
  assert.equal(R.nodeDef('condition.slot').label, 'Ячейки заклинаний');
});

test('параметры условий проверяются: пустое имя, чужой режим, значение вне диапазона', () => {
  for (const [type, kind] of Object.entries(KINDS)) {
    const def = R.NODE_DEFS[type];
    assert.equal(def.validate(plain(def.defaults)), '', `${type}: умолчания допустимы`);
    assert.equal(def.validate(kind.valid), '', `${type}: допустимые параметры`);
    // Каждый режим/операция из закрытого списка принимается.
    for (const mode of kind.modes || []) assert.equal(def.validate({ ...kind.valid, mode }), '', `${type}: режим ${mode}`);
    for (const op of kind.ops || []) assert.equal(def.validate({ ...kind.valid, op }), '', `${type}: операция ${op}`);
    for (const bad of kind.bad) assert.notEqual(def.validate(bad), '', `${type}: ${JSON.stringify(bad)} отклоняется`);
  }
  // Закрытые списки режимов и операций — из реестра.
  assert.deepEqual(plain(R.STATUS_MODES), ['present', 'absent']);
  assert.deepEqual(plain(R.ITEM_MODES), ['owned', 'equipped']);
  assert.deepEqual(plain(R.HP_OPS), ['lt', 'le', 'gt', 'ge']);
  assert.deepEqual(plain(R.SLOT_OPS), ['gte', 'lt']);
});

test('форма параметров: режимы и операции — выпадающие списки из реестра', () => {
  assert.deepEqual(plain(NF.TYPE_ENUMS['condition.status'].mode.map(option => option.value)), plain(R.STATUS_MODES));
  assert.deepEqual(plain(NF.TYPE_ENUMS['condition.item'].mode.map(option => option.value)), plain(R.ITEM_MODES));
  assert.deepEqual(plain(NF.TYPE_ENUMS['condition.hp'].op.map(option => option.value)), plain(R.HP_OPS));
  assert.deepEqual(plain(NF.TYPE_ENUMS['condition.slot'].op.map(option => option.value)), plain(R.SLOT_OPS));
  assert.deepEqual(plain(NF.TYPE_ENUMS['logic.op'].op.map(option => option.value)), plain(R.LOGIC_OPS), 'у логики все восемь операций');
  for (const type of Object.keys(KINDS)) assert.doesNotThrow(() => NF.nodeParams({ id: 'n1', type, params: plain(R.NODE_DEFS[type].defaults) }), `${type}: форма строится`);
});

test('предпросмотр без листа: условие даёт false, блок с таким условием пропускается', () => {
  for (const type of Object.keys(KINDS)) {
    assert.equal(R.NODE_DEFS[type].compute(plain(R.NODE_DEFS[type].defaults), () => undefined), false, `${type}: без листа — false`);
  }
  // Блок с условием листа без состояния выполнения не выполняется (в рантайме его включит сервер).
  const gated = graphOf([
    program('p'), node('c', 'condition.hp', { op: 'lt', value: 50, percent: true }),
    node('f', 'action.field', { block_id: 'f', kind: 'value', field: 'speed', amount: 1 }),
  ], [wire('p', 'exec', 'f', 'exec'), wire('c', 'value', 'f', 'condition')]);
  assert.equal(M.validate(gated), '');
  assert.deepEqual(plain(M.problems(gated)), []);
  assert.deepEqual(plain(M.toLegacy(gated).programs[0].blocks), [], 'false пропускает блок');
});

test('условие листа подключается только ко входу condition блока действия', () => {
  const condition = node('c', 'condition.slot', { level: 1, op: 'gte', value: 1 });
  const manual = node('m', 'action.manual', { block_id: 'm', text: 'Правило' });
  const graph = graphOf([program('p'), condition, manual], [wire('p', 'exec', 'm', 'exec'), wire('c', 'value', 'm', 'condition')]);
  assert.equal(M.validate(graph), '');
  assert.deepEqual(plain(M.problems(graph)), []);
  // Статические входы «enabled» и «flow.if» условие листа не считают — провод отклоняется.
  assert.match(M.connectionError(graph.graph, wire('c', 'value', 'm', 'enabled')), /только ко входу «condition»/);
  const branch = graphOf([program('p'), condition, node('if', 'flow.if'), node('then', 'action.manual', { block_id: 'then', text: 'да' }), node('else', 'action.manual', { block_id: 'else', text: 'нет' })], [
    wire('p', 'exec', 'if', 'exec'), wire('if', 'then', 'then', 'exec'), wire('if', 'else', 'else', 'exec'),
  ]);
  assert.match(M.connectionError(branch.graph, wire('c', 'value', 'if', 'condition')), /только ко входу «condition»/);
});

test('паритет типов и портов с сервером (integrity)', () => {
  const { checkRuntime, rustConstants } = require('../tools/srd/integrity.cjs');
  const report = checkRuntime();
  assert.deepEqual(report.errors.map(issue => `${issue.check}: ${issue.entity}: ${issue.message}`), []);
  const rust = rustConstants();
  for (const type of Object.keys(KINDS)) assert.ok(rust.NODE_TYPES.includes(type), `${type} принимается сервером`);
  for (const [name, client, server] of [
    ['STATUS_MODES', R.STATUS_MODES, rust.STATUS_MODES],
    ['ITEM_MODES', R.ITEM_MODES, rust.ITEM_MODES],
    ['HP_OPS', R.HP_OPS, rust.HP_OPS],
    ['SLOT_OPS', R.SLOT_OPS, rust.SLOT_OPS],
    ['SHEET_CONDITIONS', R.SHEET_CONDITIONS, rust.SHEET_CONDITIONS],
    ['LOGIC_OPS', R.LOGIC_OPS, rust.LOGIC_OPS],
  ]) assert.deepEqual(plain(client).slice().sort(), server.slice().sort(), `${name}: списки клиента и сервера совпадают`);
});
