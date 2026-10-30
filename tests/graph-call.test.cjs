// data.call — вызов группы-функции: типизированный результат, позиционные числовые
// аргументы a/b/c, вложенные вызовы, запрет рекурсии и действий внутри функции.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}
const M = ctx.window.Mechanics;
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/mechanics-graph.json', 'utf8'));
const entry = name => fixture.cases.find(value => value.name === name);

// Обвязка «условие → Тогда → ручное действие»: по списку блоков видно, вычислился ли вызов.
function gated(mechanics, expected) {
  const graph = structuredClone(mechanics).graph;
  graph.nodes.push({ id: 'program', type: 'action.program', params: { program_id: 'use', name: 'Тест', trigger: 'use' } });
  graph.nodes.push({ id: 'branch', type: 'flow.if', params: {} });
  graph.nodes.push({ id: 'then-action', type: 'action.manual', params: { block_id: 'then-action', text: 'Да' } });
  graph.nodes.push({ id: 'the-end', type: 'flow.end', params: {} });
  graph.links.push(
    { from: { node: 'program', socket: 'exec' }, to: { node: 'branch', socket: 'exec' } },
    { from: { node: 'branch', socket: 'then' }, to: { node: 'then-action', socket: 'exec' } },
    { from: { node: 'then-action', socket: 'exec' }, to: { node: 'the-end', socket: 'exec' } },
    { from: { node: 'branch', socket: 'else' }, to: { node: 'the-end', socket: 'exec' } },
  );
  if (expected === undefined) {
    graph.links.push({ from: { node: 'call', socket: 'value' }, to: { node: 'branch', socket: 'condition' } });
  } else {
    graph.nodes.push({ id: 'expected', type: 'data.number', params: { value: expected } });
    graph.nodes.push({ id: 'compare', type: 'data.compare', params: { op: '=' } });
    graph.links.push(
      { from: { node: 'call', socket: 'value' }, to: { node: 'compare', socket: 'a' } },
      { from: { node: 'expected', socket: 'value' }, to: { node: 'compare', socket: 'b' } },
      { from: { node: 'compare', socket: 'value' }, to: { node: 'branch', socket: 'condition' } },
    );
  }
  return { version: 2, graph };
}
const blockKinds = mechanics => {
  const result = M.evaluateGraph(mechanics, { edition: '2014', level: 1 });
  assert.equal(result.error, '');
  return plain(result.actions[0].blocks.map(block => block.kind));
};

test('data.call is registered with numeric arguments and a typed value output', () => {
  const def = R.NODE_DEFS['data.call'];
  assert.ok(def, 'узел зарегистрирован');
  assert.equal(def.isComputed, true);
  assert.ok(R.COMPUTED.has('data.call'), 'вычисляется в предпросмотре');
  assert.deepEqual(plain(def.inputs), { a: 'number', b: 'number', c: 'number' });
  assert.deepEqual(plain(def.ports({ result: 'bool' }).outputs), { value: 'bool' }, 'тип выхода берётся из result');
  assert.equal(def.validate({ group: '', result: 'number' }), '', 'пустая группа допустима на уровне формы');
  assert.match(def.validate({ group: 'g', result: 'dice' }), /тип результата/);
  assert.match(def.validate({ group: 5, result: 'number' }), /ID группы/);
});

test('a function group computes x + y from positional numeric arguments', () => {
  const mechanics = entry('data-call-simple-function').mechanics;
  assert.equal(M.validate(mechanics), '');
  assert.deepEqual(blockKinds(gated(mechanics, 5)), ['manual']);
  assert.deepEqual(blockKinds(gated(mechanics, 4)), [], 'условие ложно — ветка не выполняется');
});

test('nested function groups call each other without cycles', () => {
  const mechanics = entry('data-call-nested-function').mechanics;
  assert.equal(M.validate(mechanics), '');
  assert.deepEqual(blockKinds(gated(mechanics, 25)), ['manual']);
});

test('a function group can return bool from textcheck inside the group', () => {
  const mechanics = entry('data-call-bool-result').mechanics;
  assert.equal(M.validate(mechanics), '');
  assert.deepEqual(blockKinds(gated(mechanics)), ['manual']);
});

test('missing arguments (no runtime value) become 0 without breaking the call', () => {
  const mechanics = structuredClone(entry('data-call-simple-function').mechanics);
  mechanics.graph.links = [];
  assert.equal(M.validate(mechanics), '');
  assert.deepEqual(blockKinds(gated(mechanics, 0)), ['manual'], 'x = 0, y = 0, сумма 0');
});

test('invalid function groups are rejected: wrong group, four inputs, result type, recursion', () => {
  assert.match(M.validate(entry('data-call-wrong-group').mechanics), /выход группы-функции/);
  assert.match(M.validate(entry('data-call-four-inputs').mechanics), /больше 3 входов/);
  assert.match(M.validate(entry('data-call-result-type-mismatch').mechanics), /результат не совпадает/);
  assert.match(M.validate(entry('data-call-recursive').mechanics), /Рекурсивный вызов группы/);
});

test('a function group cannot contain action blocks', () => {
  const mechanics = structuredClone(entry('data-call-simple-function').mechanics);
  mechanics.graph.groups[0].nodes.push({ id: 'act', type: 'action.manual', params: { block_id: 'act', text: 'Шаг' } });
  assert.match(M.validate(mechanics), /Группа-функция не может содержать блоки действий/);
});
