// Один настраиваемый узел «Бросок» (action.roll + roll_kind) и один узел «Логика» (logic.op + op):
// реестр отдаёт только абстрактные узлы, старые типы читаются как псевдонимы и переводятся при открытии.
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
const mech = (nodes, links) => ({ version: 2, graph: { nodes: [program, ...nodes], links, frames: [], groups: [] } });

test('реестр палитры отдаёт только абстрактные узлы: без отдельных атак, уронов и И/ИЛИ/НЕ', () => {
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => item.type)));
  for (const legacy of Object.keys(R.ALIASES)) assert.ok(!listed.includes(legacy), legacy);
  assert.ok(listed.includes('action.roll'));
  assert.ok(listed.includes('logic.op'));
  assert.ok(!('action.attack' in R.NODE_DEFS) && !('logic.and' in R.NODE_DEFS));
});

test('v1 → v2: все виды бросков становятся одним узлом action.roll с параметром roll_kind', () => {
  const kinds = ['roll', 'attack', 'damage', 'heal', 'temp_hp'];
  const v1 = { version: 1, programs: [{ id: 'p', name: 'Броски', trigger: 'use', blocks: kinds.map((kind, i) => ({ id: `b${i}`, kind, dice: { count: 1, sides: 6, bonus: 0, stat: '' } })) }] };
  const graph = M.toGraph(v1);
  const rolls = graph.graph.nodes.filter(n => n.type !== 'action.program');
  assert.deepEqual(plain(rolls.map(n => n.type)), kinds.map(() => 'action.roll'));
  assert.deepEqual(plain(rolls.map(n => n.params.roll_kind)), kinds);
  // Обратная компиляция восстанавливает виды блоков v1, без следов roll_kind.
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
    { id: 'a', type: 'condition.level', params: { min: aTrue ? 1 : 10, max: 20 } },
    { id: 'b', type: 'condition.level', params: { min: bTrue ? 1 : 10, max: 20 } },
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

test('старые типы узлов — псевдонимы: граф читается, а upgradeGraph переводит его на абстрактные узлы', () => {
  const legacy = mech([
    { id: 'a', type: 'condition.level', params: { min: 1, max: 20 } },
    { id: 'b', type: 'condition.level', params: { min: 1, max: 20 } },
    { id: 'and', type: 'logic.and', params: {} },
    { id: 'if', type: 'flow.if', params: {} },
    { id: 'dmg', type: 'action.damage', params: { block_id: 'dmg', dice: { count: 2, sides: 6, bonus: 0, stat: '' } } },
  ], [
    link('a', 'value', 'and', 'a'), link('b', 'value', 'and', 'b'), link('and', 'value', 'if', 'condition'),
    link('start', 'exec', 'if', 'exec'), link('if', 'then', 'dmg', 'exec'),
  ]);
  assert.equal(M.validate(legacy), '', 'старый граф сохраняется без миграции вручную');
  assert.deepEqual(plain(M.problems(legacy)), []);
  assert.deepEqual(plain(M.toLegacy(legacy, { level: 5 }).programs[0].blocks.map(x => x.kind)), ['damage']);
  const changed = M.upgradeGraph(legacy.graph);
  assert.equal(changed, true);
  const types = Object.fromEntries(legacy.graph.nodes.map(n => [n.id, n.type]));
  assert.equal(types.and, 'logic.op');
  assert.equal(types.dmg, 'action.roll');
  assert.equal(legacy.graph.nodes.find(n => n.id === 'and').params.op, 'and');
  assert.equal(legacy.graph.nodes.find(n => n.id === 'dmg').params.roll_kind, 'damage');
  assert.equal(M.upgradeGraph(legacy.graph), false, 'повторный перевод ничего не меняет');
});

test('заголовок карточки показывает выбранный режим настраиваемого узла', () => {
  assert.equal(R.nodeTitle('action.roll', { roll_kind: 'attack' }), 'Бросок · Атака');
  assert.equal(R.nodeTitle('action.roll', {}), 'Бросок · Свободный');
  assert.equal(R.nodeTitle('action.damage', {}), 'Бросок · Урон', 'псевдоним наследует режим своего типа');
  assert.equal(R.nodeTitle('logic.op', { op: 'not' }), 'Логика · НЕ');
  assert.equal(R.nodeTitle('logic.or', {}), 'Логика · ИЛИ');
});
