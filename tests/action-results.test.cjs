// Результаты действий (data.result) и поле листа (data.sheet): закрытые узлы палитры,
// проверка параметров и предпросмотр без состояния выполнения. Серверный рантайм
// (condition_src, action_results) проверяют Rust-тесты src/mechanics.rs.
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
const plain = value => JSON.parse(JSON.stringify(value));
const node = (id, type, params = {}) => ({ id, type, params: { ...plain(R.NODE_DEFS[type]?.defaults || {}), ...params } });
const program = (id = 'p') => node(id, 'action.program', { program_id: id, name: 'Действие', trigger: 'use' });
const wire = (from, fromSocket, to, toSocket) => ({ from: { node: from, socket: fromSocket }, to: { node: to, socket: toSocket } });
const graphOf = (nodes, links) => { const graph = { nodes, links, frames: [], groups: [] }; M.addFlowEnds(graph); return { version: 2, graph }; };

test('data.result и data.sheet — узлы «Данные» с числовым выходом', () => {
  for (const [type, label] of [['data.result', 'Результат действия'], ['data.sheet', 'Поле листа']]) {
    const def = R.NODE_DEFS[type];
    assert.ok(def, `${type}: узел зарегистрирован`);
    assert.equal(def.label, label);
    assert.equal(R.categoryOf(type).id, 'data', `${type}: категория «Данные»`);
    assert.deepEqual(plain(def.outputs), { value: 'number' }, `${type}: выход value — число`);
    assert.deepEqual(plain(def.inputs), {}, `${type}: входов нет`);
    assert.equal(def.isComputed, true);
  }
  assert.equal(R.NODE_DEFS['data.result'].defaults.source, 'last');
  assert.equal(R.NODE_DEFS['data.result'].defaults.field, 'total');
  assert.equal(R.NODE_DEFS['data.sheet'].defaults.field, 'hp.current');
});

test('параметры: источник результата из last/программ, путь поля листа из [a-z0-9_.]', () => {
  const result = R.NODE_DEFS['data.result'], sheet = R.NODE_DEFS['data.sheet'];
  assert.equal(result.validate({ source: 'last', field: 'total' }), '');
  assert.equal(result.validate({ source: 'use', field: 'hit' }), '');
  assert.equal(result.validate(plain(result.defaults)), '', 'умолчания допустимы');
  assert.notEqual(result.validate({ source: '', field: 'total' }), '', 'пустой источник отклоняется');
  assert.match(result.validate({ source: 'last', field: 'nat20' }), /total, hit, applied или spent/, 'поля nat20 нет: схема — total/hit/applied/spent');
  assert.equal(sheet.validate({ field: 'hp.current' }), '');
  assert.equal(sheet.validate({ field: 'abilities.str' }), '');
  assert.equal(sheet.validate({ field: 'level' }), '');
  assert.equal(sheet.validate(plain(sheet.defaults)), '', 'умолчания допустимы');
  assert.notEqual(sheet.validate({ field: '' }), '', 'пустой путь отклоняется');
  assert.notEqual(sheet.validate({ field: 'HP.current' }), '', 'заглавные буквы вне пути');
  assert.notEqual(sheet.validate({ field: 'hp..current' }), '', 'пустой сегмент пути отклоняется');
});

test('предпросмотр без результатов: оба узла дают 0 и условие не падает', () => {
  assert.equal(R.NODE_DEFS['data.result'].compute({ source: 'last', field: 'total' }), 0);
  assert.equal(R.NODE_DEFS['data.sheet'].compute({ field: 'hp.current' }), 0);
  const gated = (sensor, op, value = 5) => graphOf([
    program('p'), sensor, node('five', 'data.number', { value }), node('cmp', 'data.compare', { op }),
    node('f', 'action.field', { block_id: 'f', kind: 'value', field: 'speed', amount: 1 }),
  ], [wire('p', 'exec', 'f', 'exec'), wire('src', 'value', 'cmp', 'a'), wire('five', 'value', 'cmp', 'b'), wire('cmp', 'value', 'f', 'condition')]);
  const result = gated(node('src', 'data.result', { source: 'last', field: 'total' }), '>');
  assert.equal(M.validate(result), '');
  assert.deepEqual(plain(M.toLegacy(result).programs[0].blocks), [], '0 > 5 — блок пропущен');
  assert.deepEqual(plain(M.toLegacy(gated(node('src', 'data.result', { source: 'last', field: 'total' }), '<')).programs[0].blocks.map(block => block.kind)), ['adjust'], '0 < 5 — блок выполняется');
  const sheet = gated(node('src', 'data.sheet', { field: 'hp.current' }), '=', 0);
  assert.deepEqual(plain(M.toLegacy(sheet).programs[0].blocks.map(block => block.kind)), ['adjust'], '0 = 0 — блок выполняется');
});

test('flow.if статичен: результат в его условии даёт 0 и ветка «да» отбрасывается', () => {
  // Задокументированное ограничение: динамические условия работают у блоков (condition_src),
  // а не у flow.if. Тест фиксирует поведение, чтобы его не приняли за ошибку компилятора.
  const graph = graphOf([
    program('p'),
    node('src', 'data.result', { source: 'last', field: 'total' }),
    node('five', 'data.number', { value: 5 }),
    node('cmp', 'data.compare', { op: '>' }),
    node('if', 'flow.if', {}),
    node('then', 'action.manual', { block_id: 'then', text: 'попал' }),
    node('else', 'action.manual', { block_id: 'else', text: 'промах' }),
    node('end', 'flow.end', {}),
  ], [
    wire('p', 'exec', 'if', 'exec'), wire('src', 'value', 'cmp', 'a'), wire('five', 'value', 'cmp', 'b'),
    wire('cmp', 'value', 'if', 'condition'), wire('if', 'then', 'then', 'exec'), wire('if', 'else', 'else', 'exec'),
    wire('then', 'exec', 'end', 'exec'), wire('else', 'exec', 'end', 'exec'),
  ]);
  assert.equal(M.validate(graph), '');
  assert.deepEqual(plain(M.problems(graph)), []);
  const blocks = plain(M.toLegacy(graph).programs[0].blocks);
  assert.deepEqual(blocks.map(block => block.id), ['else'], 'условие без рантайма — 0 > 5 ложно, остаётся ветка «нет»');
});

test('паритет типов и портов с сервером (integrity)', () => {
  const { checkRuntime, rustConstants } = require('../tools/srd/integrity.cjs');
  const report = checkRuntime();
  assert.deepEqual(report.errors.map(issue => `${issue.check}: ${issue.entity}: ${issue.message}`), []);
  const rust = rustConstants();
  for (const type of ['data.result', 'data.sheet']) assert.ok(rust.NODE_TYPES.includes(type), `${type} принимается сервером`);
});
