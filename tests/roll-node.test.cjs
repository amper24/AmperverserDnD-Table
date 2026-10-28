// Один настраиваемый узел «Бросок» (action.roll + roll_kind) и один узел «Логика» (logic.op + op):
// реестр отдаёт только абстрактные узлы, механики принимаются только графом v2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, crypto: require('node:crypto').webcrypto, console };
ctx.window.SKILLS = [['acrobatics', 'Акробатика', 'dex']];
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
}
const M = ctx.window.Mechanics;
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));

const link = (fromNode, fromSocket, toNode, toSocket) => ({ from: { node: fromNode, socket: fromSocket }, to: { node: toNode, socket: toSocket } });
const program = { id: 'start', type: 'action.program', params: { program_id: 'p', name: 'Тест', trigger: 'use' } };
// Хелпер достраивает «Конец» действию (как редактор), чтобы поток был исполним.
const mech = (nodes, links) => {
  const graph = { nodes: [program, ...nodes], links, frames: [], groups: [] };
  M.addFlowEnds(graph);
  return { version: 2, graph };
};

test('реестр палитры отдаёт только абстрактные узлы: без отдельных атак, уронов и И/ИЛИ/НЕ', () => {
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => item.type)));
  assert.ok(listed.includes('action.roll'));
  assert.ok(listed.includes('logic.op'));
  assert.ok(!('action.attack' in R.NODE_DEFS) && !('logic.and' in R.NODE_DEFS));
});

test('v1 не принимается, а v2-броски компилируются в те же виды плана', () => {
  assert.equal(M.validate({ version: 1, programs: [] }), 'Неподдерживаемая схема механик.');
  const kinds = ['roll', 'attack', 'damage', 'heal', 'temp_hp'];
  const nodes = [program];
  kinds.forEach((kind, i) => nodes.push({ id: `r${i}`, type: 'action.roll', params: { block_id: `b${i}`, roll_kind: kind, dice: { count: 1, sides: 6, bonus: 0, stat: '' } }, position: { x: i, y: 0 } }));
  const links = kinds.map((_, i) => link(i ? `r${i - 1}` : 'start', 'exec', `r${i}`, 'exec'));
  const graph = mech(nodes.slice(1), links);
  assert.equal(M.validate(graph), '');
  const blocks = plain(M.toLegacy(graph).programs[0].blocks);
  assert.deepEqual(blocks.map(b => b.kind), kinds);
  assert.ok(blocks.every(b => b.roll_kind === undefined));
});

test('roll_kind настраивается: один и тот же узел компилируется в разные блоки', () => {
  const node = kind => mech([{ id: 'x', type: 'action.roll', params: { block_id: 'x', roll_kind: kind, dice: { count: 1, sides: 8, bonus: 0, stat: '' } } }], [link('start', 'exec', 'x', 'exec')]);
  for (const kind of R.ROLL_KINDS) {
    const graph = node(kind);
    assert.equal(M.validate(graph), '', kind);
    assert.deepEqual(plain(M.problems(graph)), [], kind);
    assert.equal(plain(M.toLegacy(graph).programs[0].blocks)[0].kind, kind);
  }
  assert.notEqual(M.validate(node('save')), '', 'неизвестный вид броска отклоняется');
});

test('logic.op исполняет И, ИЛИ и НЕ; неизвестная операция отклоняется', () => {
  const boolGraph = (op, aTrue, bTrue) => mech([
    { id: 'a', type: 'condition.context', params: { kind: 'level', min: aTrue ? 1 : 10, max: 20 } },
    { id: 'b', type: 'condition.context', params: { kind: 'level', min: bTrue ? 1 : 10, max: 20 } },
    { id: 'op', type: 'logic.op', params: { op } },
    { id: 'if', type: 'flow.if', params: {} },
    { id: 'yes', type: 'action.manual', params: { block_id: 'yes', text: 'да', when: 'always' } },
  ], [
    link('a', 'value', 'op', 'a'), link('b', 'value', 'op', 'b'), link('op', 'value', 'if', 'condition'),
    link('start', 'exec', 'if', 'exec'), link('if', 'then', 'yes', 'exec'),
  ]);
  const taken = (op, aTrue, bTrue) => plain(M.toLegacy(boolGraph(op, aTrue, bTrue), { level: 5 }).programs[0].blocks).length === 1;
  assert.equal(taken('and', true, true), true);
  assert.equal(taken('and', true, false), false);
  assert.equal(taken('or', false, true), true);
  assert.equal(taken('or', false, false), false);
  assert.equal(taken('not', false, true), true, 'НЕ смотрит только на вход «a»');
  assert.equal(taken('not', true, false), false);
  assert.notEqual(M.validate(boolGraph('xor', true, true)), '');
});

test('заголовок карточки показывает выбранный режим настраиваемого узла', () => {
  assert.equal(R.nodeTitle('action.roll', { roll_kind: 'attack' }), 'Бросок · Атака');
  assert.equal(R.nodeTitle('action.roll', {}), 'Бросок · Свободный');
  assert.equal(R.nodeTitle('logic.op', { op: 'not' }), 'Логика · НЕ');
  assert.equal(R.nodeTitle('logic.op', { op: 'or' }), 'Логика · ИЛИ');
});
