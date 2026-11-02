// Редактор сигнатуры функции-группы: миграция старых имён, проверка подписи,
// переписывание params границ группы и снимок аргументов/портов data.call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
for (const file of ['static/core/dice.js', 'static/editor/mechanics.js', 'static/core/formulas.js', 'static/editor/node-params-form.js', 'static/editor/node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/editor/mechanics-graph.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}
const M = ctx.window.Mechanics;
const plain = value => JSON.parse(JSON.stringify(value));

// Группа-тождество: вход x → выход result. Внутренняя связь совпадает по типу с подписью,
// поэтому смена типа входа/выхода не создаёт посторонних проблем.
function identityGroup(type = 'number') {
  return {
    id: 'g-fn', name: 'Тождество',
    inputs: [{ id: 'x', name: 'x', type }],
    outputs: [{ id: 'out', name: 'result', type }],
    nodes: [
      { id: 'gi', type: 'group.input', params: { socket_id: 'x' } },
      { id: 'go', type: 'group.output', params: { socket_id: 'out' } },
    ],
    links: [{ from: { node: 'gi', socket: 'value' }, to: { node: 'go', socket: 'value' } }],
    frames: [],
  };
}
function mechanicsFor(group, extraNodes = [], extraLinks = []) {
  return {
    version: 2,
    graph: {
      nodes: [{ id: 'call', type: 'data.call', params: { group: group.id, result: group.outputs[0].type } }, ...extraNodes],
      links: extraLinks, frames: [], groups: [group],
    },
  };
}

test('старые имена «Вход N» и пустые мигрируют в x/y/z детерминированно', () => {
  assert.deepEqual(plain(M.migrateFunctionParamNames([{ name: 'Вход 1' }, { name: 'Вход 2' }])), ['x', 'y']);
  assert.deepEqual(plain(M.migrateFunctionParamNames([{ name: 'Вход 1' }, { name: 'Вход 2' }, { name: 'Вход 3' }])), ['x', 'y', 'z']);
  assert.deepEqual(plain(M.migrateFunctionParamNames([{ name: '' }])), ['x']);
  // Занятое действительное имя не дублируется.
  assert.deepEqual(plain(M.migrateFunctionParamNames([{ name: 'y' }, { name: 'Вход 2' }])), ['y', 'x']);
  // Незнакомое некорректное имя не переписывается молча — его покажет валидация.
  assert.deepEqual(plain(M.migrateFunctionParamNames([{ name: 'Сила' }])), ['Сила']);
});

test('подпись проверяется: пустое имя, дубль, формат, больше трёх, тип выхода', () => {
  const ok = { inputs: [], output: { type: 'number' } };
  assert.equal(M.validateFunctionSignature(ok), '', 'ноль входов допустим');
  assert.match(M.validateFunctionSignature({ inputs: [{ name: '', type: 'number' }], output: { type: 'number' } }), /не может быть пустым/);
  assert.match(M.validateFunctionSignature({ inputs: [{ name: 'x', type: 'number' }, { name: 'x', type: 'text' }], output: { type: 'number' } }), /уже используется/);
  assert.match(M.validateFunctionSignature({ inputs: [{ name: 'X', type: 'number' }], output: { type: 'number' } }), /\[a-z0-9_\]/);
  assert.match(M.validateFunctionSignature({ inputs: [{ name: 'a-b', type: 'number' }], output: { type: 'number' } }), /\[a-z0-9_\]/);
  assert.match(M.validateFunctionSignature({ inputs: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }, { name: 'c', type: 'number' }, { name: 'd', type: 'number' }], output: { type: 'number' } }), /больше 3/);
  assert.match(M.validateFunctionSignature({ inputs: [{ name: 'a', type: 'flow' }], output: { type: 'number' } }), /тип number, text, bool или list/);
  assert.match(M.validateFunctionSignature({ inputs: [], output: { type: 'flow' } }), /Тип выхода/);
});

test('сохранение переписывает params границ, подпись и порты data.call', () => {
  const group = identityGroup('number');
  const mechanics = mechanicsFor(group);
  assert.equal(M.validate(mechanics), '');
  const result = M.applyFunctionSignature(mechanics, 'g-fn', {
    inputs: [{ id: 'x', name: 'value', type: 'text' }], output: { type: 'text' },
  });
  assert.equal(result.error, '');
  assert.equal(result.updatedCalls, 1);
  assert.deepEqual(plain(group.inputs), [{ id: 'x', name: 'value', type: 'text' }]);
  assert.equal(group.outputs[0].type, 'text');
  const inputBoundary = group.nodes.find(node => node.id === 'gi'), outputBoundary = group.nodes.find(node => node.id === 'go');
  assert.equal(inputBoundary.params.name, 'value');
  assert.equal(inputBoundary.params.type, 'text');
  assert.equal(outputBoundary.params.name, 'result');
  assert.equal(outputBoundary.params.type, 'text');
  const call = mechanics.graph.nodes.find(node => node.id === 'call');
  assert.equal(call.params.result, 'text');
  assert.deepEqual(plain(call.params.args), ['text']);
  assert.deepEqual(plain(M.callPorts(call.params)), { inputs: { a: 'text' }, outputs: { value: 'text' } });
  assert.equal(M.validate(mechanics), '', 'граф остаётся валидным');
});

test('добавление и удаление входа меняет число портов и снимает лишний провод', () => {
  const group = identityGroup('number');
  const mechanics = mechanicsFor(group);
  const added = M.applyFunctionSignature(mechanics, 'g-fn', {
    inputs: [{ id: 'x', name: 'x', type: 'number' }, { name: 'flag', type: 'bool' }], output: { type: 'number' },
  });
  assert.equal(added.error, '');
  assert.equal(group.inputs.length, 2);
  assert.equal(group.inputs[1].name, 'flag');
  assert.equal(group.nodes.filter(node => node.type === 'group.input').length, 2);
  const call = mechanics.graph.nodes.find(node => node.id === 'call');
  assert.deepEqual(plain(call.params.args), ['number', 'bool']);
  assert.deepEqual(plain(M.callPorts(call.params).inputs), { a: 'number', b: 'bool' });
  // Второй аргумент — bool; провод от data.boolean корректен.
  mechanics.graph.nodes.push({ id: 'flag', type: 'data.boolean', params: { value: true } });
  mechanics.graph.links.push({ from: { node: 'flag', socket: 'value' }, to: { node: 'call', socket: 'b' } });
  assert.equal(M.validate(mechanics), '');
  const reduced = M.applyFunctionSignature(mechanics, 'g-fn', {
    inputs: [{ id: 'x', name: 'x', type: 'number' }], output: { type: 'number' },
  });
  assert.equal(reduced.error, '');
  assert.equal(reduced.removedLinks, 1, 'провод в исчезнувший порт b снят');
  assert.equal(mechanics.graph.links.length, 0);
  assert.deepEqual(plain(M.callPorts(call.params).inputs), { a: 'number' });
  assert.equal(M.validate(mechanics), '');
});

test('смена типа выхода снимает несовместимый исходящий провод', () => {
  const group = identityGroup('text');
  const mechanics = mechanicsFor(group, [{ id: 'len', type: 'data.textlen', params: {} }],
    [{ from: { node: 'call', socket: 'value' }, to: { node: 'len', socket: 'a' } }]);
  assert.equal(M.validate(mechanics), '');
  const result = M.applyFunctionSignature(mechanics, 'g-fn', {
    inputs: [{ id: 'x', name: 'x', type: 'bool' }], output: { type: 'bool' },
  });
  assert.equal(result.error, '');
  assert.equal(result.removedLinks, 1, 'bool → text больше не совпадает');
  const call = mechanics.graph.nodes.find(node => node.id === 'call');
  assert.deepEqual(plain(M.callPorts(call.params)), { inputs: { a: 'bool' }, outputs: { value: 'bool' } });
  assert.equal(M.validate(mechanics), '');
});

test('устаревший снимок аргументов даёт проблему валидации, а не молчаливое расхождение', () => {
  const group = identityGroup('number');
  const mechanics = mechanicsFor(group);
  const call = mechanics.graph.nodes.find(node => node.id === 'call');
  call.params.args = ['number', 'number'];
  assert.match(M.validate(mechanics), /подпись группы изменилась/);
});

test('ноль входов применяется и даёт вызов без портов', () => {
  const group = identityGroup('number');
  const mechanics = mechanicsFor(group);
  const result = M.applyFunctionSignature(mechanics, 'g-fn', { inputs: [], output: { type: 'number' } });
  assert.equal(result.error, '');
  assert.deepEqual(plain(group.inputs), []);
  assert.equal(group.nodes.some(node => node.type === 'group.input'), false);
  const call = mechanics.graph.nodes.find(node => node.id === 'call');
  assert.deepEqual(plain(call.params.args), []);
  assert.deepEqual(plain(M.callPorts(call.params).inputs), {});
  assert.equal(M.validate(mechanics), '');
});
