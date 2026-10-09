const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Проверка связей редактора: тип сокетов, петли, циклы и общая схема (движок, не UI).
const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;

const defaults = type => JSON.parse(JSON.stringify(ctx.window.NodeRegistry.NODE_DEFS[type].defaults));
const graph = () => ({
  nodes: [
    { id: 'lvl', type: 'condition.level', params: defaults('condition.level'), position: { x: 0, y: 0 } },
    { id: 'num', type: 'data.number', params: defaults('data.number'), position: { x: 0, y: 100 } },
    { id: 'if1', type: 'flow.if', params: defaults('flow.if'), position: { x: 300, y: 0 } },
    { id: 'if2', type: 'flow.if', params: defaults('flow.if'), position: { x: 600, y: 0 } },
    { id: 'roll', type: 'action.roll', params: { ...defaults('action.roll'), block_id: 'roll-1' }, position: { x: 900, y: 0 } },
  ],
  links: [],
  frames: [],
  groups: [],
});

test('a link between sockets of the same type is accepted', () => {
  const g = graph();
  assert.equal(M.connectionError(g, { from: { node: 'lvl', socket: 'value' }, to: { node: 'if1', socket: 'condition' } }), '');
});

test('a link between different socket types is rejected by the engine check', () => {
  const g = graph();
  const error = M.connectionError(g, { from: { node: 'num', socket: 'value' }, to: { node: 'roll', socket: 'enabled' } });
  assert.match(error, /Типы не совпадают/);
});

test('a node cannot be linked to itself', () => {
  const g = graph();
  assert.match(M.connectionError(g, { from: { node: 'if1', socket: 'then' }, to: { node: 'if1', socket: 'exec' } }), /самим собой/);
});

test('wouldCycle detects a loop through existing links and ignores acyclic chains', () => {
  const links = [{ from: { node: 'if1', socket: 'then' }, to: { node: 'if2', socket: 'exec' } }];
  assert.equal(M.wouldCycle(links, 'if2', 'if1'), true);
  assert.equal(M.wouldCycle(links, 'if1', 'if2'), false);
});

test('a link that closes a flow cycle is rejected before it reaches the document', () => {
  const g = graph();
  g.links.push({ from: { node: 'if1', socket: 'then' }, to: { node: 'if2', socket: 'exec' } });
  assert.match(M.connectionError(g, { from: { node: 'if2', socket: 'then' }, to: { node: 'if1', socket: 'exec' } }), /цикл/);
});

test('replacing the source of an input is allowed and does not count as a cycle', () => {
  const g = graph();
  g.links.push({ from: { node: 'lvl', socket: 'value' }, to: { node: 'if1', socket: 'condition' } });
  assert.equal(M.connectionError(g, { from: { node: 'lvl', socket: 'value' }, to: { node: 'if1', socket: 'condition' } }), '');
});

test('an unknown socket is rejected', () => {
  const g = graph();
  assert.match(M.connectionError(g, { from: { node: 'lvl', socket: 'nope' }, to: { node: 'if1', socket: 'condition' } }), /Сокет не найден/);
});
