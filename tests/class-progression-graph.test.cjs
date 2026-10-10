const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Прогрессия класса задаётся узлом rule.class_progression; таблица зависит от редакции через condition.edition.
const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const plain = value => JSON.parse(JSON.stringify(value));

const t2014 = { columns: [], levels: { 1: { pb: 2 } } }, t2024 = { columns: [], levels: { 1: { pb: 3 } } };
const homebrew = () => ({ version: 2, graph: { nodes: [
  { id: 'e14', type: 'condition.edition', params: { editions: ['2014'] }, position: { x: 0, y: 0 } },
  { id: 'p14', type: 'rule.class_progression', params: { table: t2014 }, position: { x: 300, y: 0 } },
  { id: 'e24', type: 'condition.edition', params: { editions: ['2024'] }, position: { x: 0, y: 200 } },
  { id: 'p24', type: 'rule.class_progression', params: { table: t2024 }, position: { x: 300, y: 200 } },
], links: [
  { from: { node: 'e14', socket: 'value' }, to: { node: 'p14', socket: 'enabled' } },
  { from: { node: 'e24', socket: 'value' }, to: { node: 'p24', socket: 'enabled' } },
], frames: [], groups: [] } });

test('class progression comes from the graph per edition', () => {
  const g = homebrew();
  assert.equal(M.validate(g), '');
  assert.deepEqual(plain(M.classProgression(g, '2014')), plain(t2014));
  assert.deepEqual(plain(M.classProgression(g, '2024')), plain(t2024));
});

test('a graph without a progression node gives no table, so callers fall back to data', () => {
  const g = homebrew();
  g.graph.nodes = g.graph.nodes.filter(n => !n.type.startsWith('rule.'));
  g.graph.links = [];
  assert.equal(M.classProgression(g, '2014'), null);
});

test('version 1 records have no graph progression', () => {
  assert.equal(M.classProgression({ version: 1, programs: [] }, '2014'), null);
  assert.equal(M.classProgression(undefined, '2014'), null);
});
