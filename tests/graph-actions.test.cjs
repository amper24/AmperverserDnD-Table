// Действия в графе механик: «Начало» → «Конец», отдельная цепочка на каждое действие, связи не пересекают действия.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat().filter(value => value !== null && value !== undefined); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } }, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' }, SKILLS: [] };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const plain = value => JSON.parse(JSON.stringify(value));

function twoActions() {
  const graph = { nodes: [
    { id: 'startA', type: 'action.program', params: { program_id: 'a', name: 'Удар', trigger: 'use' }, position: { x: 0, y: 0 }, action: 'startA' },
    { id: 'endA', type: 'flow.end', params: {}, position: { x: 300, y: 0 }, action: 'startA' },
    { id: 'dmgA', type: 'action.damage', params: { block_id: 'bA', damage: '1d6' }, position: { x: 150, y: 0 }, action: 'startA' },
    { id: 'startB', type: 'action.program', params: { program_id: 'b', name: 'Лечение', trigger: 'use' }, position: { x: 0, y: 200 }, action: 'startB' },
    { id: 'healB', type: 'action.heal', params: { block_id: 'bB', amount: '1d4' }, position: { x: 150, y: 200 } },
  ], links: [
    { from: { node: 'startA', socket: 'exec' }, to: { node: 'dmgA', socket: 'exec' } },
    { from: { node: 'dmgA', socket: 'exec' }, to: { node: 'endA', socket: 'exec' } },
    { from: { node: 'startB', socket: 'exec' }, to: { node: 'healB', socket: 'exec' } },
  ], frames: [], groups: [] };
  return { version: 2, graph };
}

test('флаг action закрепляет узел за действием; без поля узел идёт по проводам', () => {
  const owners = M.actionOwners(twoActions().graph);
  assert.equal(owners.get('dmgA'), 'startA');
  assert.equal(owners.get('endA'), 'startA');
  assert.equal(owners.get('healB'), 'startB', 'узел без поля привязан к цепочке startB по проводам');
  assert.equal(owners.get('startB'), 'startB');
});

test('узлы без связей и без поля относятся к первому действию', () => {
  const doc = twoActions();
  doc.graph.nodes.push({ id: 'loose', type: 'data.number', params: { value: 3 }, position: { x: 0, y: 400 } });
  assert.equal(M.actionOwners(doc.graph).get('loose'), 'startA');
});

test('граф с двумя действиями и «Концом» проходит проверку и компилируется в две программы', () => {
  const doc = twoActions();
  assert.equal(M.validate(doc), '', 'схема сохраняется');
  assert.deepEqual(plain(M.problems(doc)), [], 'граф исполняем');
  const legacy = M.toLegacy(doc);
  assert.deepEqual(plain(legacy.programs.map(p => p.id)), ['a', 'b']);
  assert.deepEqual(plain(legacy.programs[0].blocks.map(b => b.kind)), ['damage'], 'конец не даёт блока');
});

test('провод между узлами разных действий отклоняется, внутри одного действия — разрешён', () => {
  const { graph } = twoActions();
  const across = { from: { node: 'dmgA', socket: 'exec' }, to: { node: 'healB', socket: 'exec' } };
  assert.equal(M.connectionError(graph, across), 'Соединять можно только узлы одного действия.');
  const within = { from: { node: 'startB', socket: 'exec' }, to: { node: 'healB', socket: 'exec' } };
  assert.equal(M.connectionError(graph, within), '');
});
