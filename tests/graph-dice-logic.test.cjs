// Узлы характеристик и навыков, сложение костей, условия и логика, несколько проводов в «Конец».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, crypto: require('node:crypto').webcrypto, console };
ctx.window.SKILLS = [['acrobatics', 'Акробатика', 'dex'], ['athletics', 'Атлетика', 'str']];
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
}
const M = ctx.window.Mechanics;
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));

const node = (id, type, params = {}) => ({ id, type, params: { ...plain(R.NODE_DEFS[type]?.defaults || {}), ...params } });
const actionNode = (id, kind, params = {}) => node(id, 'action.roll', { block_id: id, roll_kind: kind, ...params });
const link = (fromNode, fromSocket, toNode, toSocket) => ({ from: { node: fromNode, socket: fromSocket }, to: { node: toNode, socket: toSocket } });
const start = node('start', 'action.program', { program_id: 'p', name: 'Тест', trigger: 'use' });
const mech = (nodes, links) => ({ version: 2, graph: { nodes: [start, ...nodes], links, frames: [], groups: [] } });
const blocksOf = (mechanics, context = {}) => plain(M.toLegacy(mechanics, context).programs[0].blocks);

test('characteristic and skill nodes produce dice formulas: bonus or score', () => {
  const str = node('s', 'data.stat', { id: 'str', mode: 'score' });
  const dex = node('d', 'data.stat', { id: 'dex', mode: 'bonus' });
  const acro = node('a', 'data.stat', { id: 'acrobatics', mode: 'score' });
  const graph = mech([str, dex, acro, actionNode('x', 'damage')], [link('start', 'exec', 'x', 'exec'), link('s', 'value', 'x', 'dice')]);
  assert.equal(M.validate(graph), '');
  assert.deepEqual(plain(M.problems(graph)), []);
  assert.equal(blocksOf(graph)[0].dice.advanced, '@str_score');
  const bonusGraph = mech([dex, actionNode('x', 'damage')], [link('start', 'exec', 'x', 'exec'), link('d', 'value', 'x', 'dice')]);
  assert.equal(blocksOf(bonusGraph)[0].dice.advanced, '@dex');
  const skillScore = mech([acro, actionNode('x', 'damage')], [link('start', 'exec', 'x', 'exec'), link('a', 'value', 'x', 'dice')]);
  assert.equal(blocksOf(skillScore)[0].dice.advanced, '10+@acrobatics');
});

test('dice combine joins two dice into one formula, keeping stat variables', () => {
  const dice = node('d', 'data.dice', { value: { count: 1, sides: 6, bonus: 2, stat: '' } });
  const stat = node('s', 'data.stat', { id: 'str', mode: 'score' });
  const combine = node('c', 'dice.combine');
  const graph = mech([dice, stat, combine, actionNode('x', 'damage')], [
    link('d', 'value', 'c', 'a'), link('s', 'value', 'c', 'b'), link('c', 'value', 'x', 'dice'), link('start', 'exec', 'x', 'exec'),
  ]);
  assert.deepEqual(plain(M.problems(graph)), []);
  assert.equal(blocksOf(graph)[0].dice.advanced, '1d6+2+@str_score');
});

test('dice input without a wire keeps the block dice field', () => {
  const graph = mech([actionNode('x', 'damage', { dice: { count: 2, sides: 8, bonus: 1, stat: '' } })], [link('start', 'exec', 'x', 'exec')]);
  assert.deepEqual(blocksOf(graph)[0].dice, { count: 2, sides: 8, bonus: 1, stat: '' });
});

test('flow condition built from logic AND follows the edition and level context', () => {
  const level = node('lv', 'condition.level', { min: 3, max: 10 });
  const edition = node('ed', 'condition.edition', { editions: ['2014'] });
  const and = node('and', 'logic.op', { op: 'and' });
  const branch = node('if', 'flow.if');
  const yes = actionNode('yes', 'damage'), no = actionNode('no', 'heal');
  const graph = mech([level, edition, and, branch, yes, no], [
    link('lv', 'value', 'and', 'a'), link('ed', 'value', 'and', 'b'), link('and', 'value', 'if', 'condition'),
    link('start', 'exec', 'if', 'exec'), link('if', 'then', 'yes', 'exec'), link('if', 'else', 'no', 'exec'),
  ]);
  assert.deepEqual(plain(M.problems(graph)), []);
  assert.deepEqual(blocksOf(graph, { edition: '2014', level: 5 }).map(b => b.id), ['yes']);
  assert.deepEqual(blocksOf(graph, { edition: '2014', level: 1 }).map(b => b.id), ['no']);
  assert.deepEqual(blocksOf(graph, { edition: '2024', level: 5 }).map(b => b.id), ['no']);
  assert.deepEqual(blocksOf(graph).map(b => b.id).sort(), ['no', 'yes'], 'without context both branches stay');
});

test('comparison of numbers negated with NOT chooses the else branch', () => {
  const five = node('n5', 'data.number', { value: 5 }), three = node('n3', 'data.number', { value: 3 });
  const cmp = node('cmp', 'condition.compare', { op: '>' });
  const not = node('not', 'logic.op', { op: 'not' });
  const branch = node('if', 'flow.if');
  const graph = mech([five, three, cmp, not, branch, actionNode('yes', 'damage'), actionNode('no', 'heal')], [
    link('n5', 'value', 'cmp', 'a'), link('n3', 'value', 'cmp', 'b'), link('cmp', 'value', 'not', 'a'), link('not', 'value', 'if', 'condition'),
    link('start', 'exec', 'if', 'exec'), link('if', 'then', 'yes', 'exec'), link('if', 'else', 'no', 'exec'),
  ]);
  assert.deepEqual(plain(M.problems(graph)), []);
  assert.deepEqual(blocksOf(graph).map(b => b.id), ['no']);
});

test('the end node accepts several incoming wires, other inputs still take one', () => {
  const a = actionNode('a', 'damage'), b = actionNode('b', 'heal'), c = actionNode('c', 'attack'), end = node('end', 'flow.end');
  const graph = mech([a, b, c, end], [
    link('start', 'exec', 'a', 'exec'), link('start', 'exec', 'b', 'exec'),
    link('a', 'exec', 'end', 'exec'), link('b', 'exec', 'end', 'exec'),
  ]);
  assert.deepEqual(plain(M.problems(graph)), []);
  const twice = mech([a, b], [link('start', 'exec', 'a', 'exec'), link('b', 'exec', 'a', 'exec')]);
  assert.ok(M.problems(twice).some(p => p.includes('один провод')));
  const third = { from: { node: 'c', socket: 'exec' }, to: { node: 'end', socket: 'exec' } };
  assert.equal(M.connectionError(graph.graph, third), '', 'a third wire into the end is allowed');
  // Обычный вход принимает один провод: новый провод на тот же вход заменяет старый (applyLink), ошибки нет.
  assert.equal(M.connectionError(graph.graph, { from: { node: 'c', socket: 'exec' }, to: { node: 'a', socket: 'exec' } }), '', 'a new wire replaces the single wire of an action');
});

test('invalid stat, comparison and dice types are refused', () => {
  const badStat = mech([node('s', 'data.stat', { id: 'luck', mode: 'bonus' })], []);
  assert.notEqual(M.validate(badStat), '');
  const badOp = mech([node('c', 'condition.compare', { op: '~' })], []);
  assert.notEqual(M.validate(badOp), '');
  const wrongType = mech([node('n', 'data.number', { value: 3 }), actionNode('x', 'damage')], [link('n', 'value', 'x', 'dice')]);
  assert.ok(M.problems(wrongType).some(p => p.includes('Типы сокетов')));
});

test('logic nodes never take the hit condition; only the if node does', () => {
  const hit = node('h', 'condition.hit'), and = node('and', 'logic.op', { op: 'and' });
  const graph = mech([hit, and], [link('h', 'value', 'and', 'a')]);
  assert.ok(M.problems(graph).length > 0);
});
