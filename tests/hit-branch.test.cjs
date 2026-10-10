const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Ветвление «попадание / промах» (узел condition.hit → flow.if), перенос поля when в узлы и данные пресетов.
function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, append(...more) { this.children.push(...more.flat()); } };
}
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } }, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' } };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const plain = value => JSON.parse(JSON.stringify(value));

const attackBlock = { id: 'atk', kind: 'attack', dice: { count: 0, sides: 20, bonus: 5, stat: '' }, dc: 3 };
const hitDamage = { id: 'dmg', kind: 'damage', when: 'hit', dice: { count: 1, sides: 6, bonus: 0, stat: '' } };
const missHeal = { id: 'heal', kind: 'heal', when: 'miss', target: 'self', apply: true, dice: { count: 0, sides: 6, bonus: 1, stat: '' } };

test('a v1 gated block becomes a condition node and compiles back to the same when', () => {
  const v1 = { version: 1, origin: 'legacy', programs: [{ id: 'p', name: 'Удар', trigger: 'use', blocks: [attackBlock, hitDamage] }] };
  const graph = M.toGraph(v1);
  const types = graph.graph.nodes.map(n => n.type);
  assert.ok(types.includes('condition.hit'), 'condition.hit node is created');
  assert.ok(types.includes('flow.if'), 'flow.if node is created');
  assert.equal(graph.graph.nodes.find(n => n.type === 'action.damage').params.when, 'always', 'the gate lives in the branch, not in the block');
  assert.equal(M.validate(graph), '', 'the converted graph saves');
  assert.equal(M.problems(graph).length, 0, 'and executes');
  const back = M.toLegacy(graph).programs[0].blocks;
  assert.deepEqual(plain(back).map(b => [b.kind, b.when || 'always']), [['attack', 'always'], ['damage', 'hit']]);
});

test('the then and else outputs gate hit and miss blocks separately', () => {
  const graph = { version: 2, graph: { nodes: [
    { id: 'p', type: 'action.program', params: { program_id: 'use', name: 'Выбор', trigger: 'use' } },
    { id: 'a', type: 'action.attack', params: { block_id: 'atk', ...attackBlock, enabled: true } },
    { id: 'h', type: 'condition.hit', params: {} },
    { id: 'f', type: 'flow.if', params: {} },
    { id: 'd', type: 'action.damage', params: { block_id: 'dmg', enabled: true, dice: hitDamage.dice } },
    { id: 'm', type: 'action.heal', params: { block_id: 'heal', enabled: true, dice: missHeal.dice, target: 'self', apply: true } },
  ], links: [
    { from: { node: 'p', socket: 'exec' }, to: { node: 'a', socket: 'exec' } },
    { from: { node: 'a', socket: 'exec' }, to: { node: 'f', socket: 'exec' } },
    { from: { node: 'h', socket: 'value' }, to: { node: 'f', socket: 'condition' } },
    { from: { node: 'f', socket: 'then' }, to: { node: 'd', socket: 'exec' } },
    { from: { node: 'f', socket: 'else' }, to: { node: 'm', socket: 'exec' } },
  ], frames: [], groups: [] } };
  assert.equal(M.validate(graph), '');
  assert.equal(M.problems(graph).length, 0);
  const blocks = plain(M.toLegacy(graph).programs[0].blocks);
  assert.deepEqual(blocks.map(b => [b.kind, b.when || 'always']), [['attack', 'always'], ['damage', 'hit'], ['heal', 'miss']]);
});

test('a branch continues with ungated nodes: only the node wired to the output is gated', () => {
  const v1 = { version: 1, programs: [{ id: 'p', name: 'Цепочка', trigger: 'use', blocks: [attackBlock, hitDamage, { id: 'tail', kind: 'heal', target: 'self', apply: true, dice: { count: 0, sides: 6, bonus: 1, stat: '' } }] }] };
  const back = M.toLegacy(M.toGraph(v1)).programs[0].blocks;
  assert.deepEqual(plain(back).map(b => [b.id, b.when || 'always']), [['atk', 'always'], ['dmg', 'hit'], ['tail', 'always']], 'the chain after the gated block is not gated');
});

test('a hit condition wired to anything but a branch is saved but not executed', () => {
  const graph = { version: 2, graph: { nodes: [
    { id: 'p', type: 'action.program', params: { program_id: 'use', name: 'Удар', trigger: 'use' } },
    { id: 'h', type: 'condition.hit', params: {} },
    { id: 'd', type: 'action.damage', params: { block_id: 'dmg', enabled: true, dice: hitDamage.dice } },
  ], links: [
    { from: { node: 'p', socket: 'exec' }, to: { node: 'd', socket: 'exec' } },
    { from: { node: 'h', socket: 'value' }, to: { node: 'd', socket: 'enabled' } },
  ], frames: [], groups: [] } };
  assert.equal(M.validate(graph), '', 'structure is fine, so the record can be saved');
  assert.ok(M.problems(graph).some(text => text.includes('только ко входу «Если»')));
  assert.match(M.evaluateGraph(graph).error, /Граф не исполняется/);
});

test('nested hit branches are reported as a problem', () => {
  const chain = M.toGraph({ version: 1, programs: [{ id: 'p', name: 'Удар', trigger: 'use', blocks: [attackBlock, hitDamage] }] });
  const nodes = chain.graph.nodes, links = chain.graph.links;
  const branch = nodes.find(n => n.type === 'flow.if');
  const hit2 = { id: 'h2', type: 'condition.hit', params: {} }, if2 = { id: 'f2', type: 'flow.if', params: {} };
  nodes.push(hit2, if2);
  links.push({ from: { node: 'h2', socket: 'value' }, to: { node: 'f2', socket: 'condition' } });
  links.push({ from: { node: branch.id, socket: 'then' }, to: { node: 'f2', socket: 'exec' } });
  assert.ok(M.problems(chain).some(text => text.includes('вкладывать')));
});

test('sequential hit branches (after a gated block) are allowed', () => {
  const chain = M.toGraph({ version: 1, programs: [{ id: 'p', name: 'Удар', trigger: 'use', blocks: [attackBlock, hitDamage, { id: 'h', kind: 'heal', when: 'hit', target: 'self', apply: true, dice: { count: 0, sides: 6, bonus: 1, stat: '' } }] }] });
  assert.equal(M.problems(chain).length, 0, 'each block has its own branch after the attack');
});

test('starter presets are data: every starter saves, the attached ones execute', () => {
  const starters = ctx.window.Presets.items('graph_starter');
  assert.ok(starters.length >= 4, 'starters are present in the data file');
  const ids = starters.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'starter ids are unique');
  for (const starter of starters) {
    const keys = starter.nodes.map(n => n.key);
    assert.equal(new Set(keys).size, keys.length, `${starter.id}: node keys are unique`);
    for (const node of starter.nodes) assert.ok(M.NODE_DEFS[node.type], `${starter.id}: known node type ${node.type}`);
    // Так же, как вставка в редакторе: умолчания реестра + отличия пресета, связь с программой для варианта «с подключением».
    const nodes = [{ id: 'program', type: 'action.program', params: { program_id: 'use', name: 'Использовать', trigger: 'use' } }], links = [];
    const ids2 = new Map();
    for (const node of starter.nodes) {
      const id = `n-${node.key}`; ids2.set(node.key, id);
      const params = { ...plain(M.NODE_DEFS[node.type].defaults), ...plain(node.params) };
      if (node.type.startsWith('action.')) params.block_id = `b-${node.key}`;
      nodes.push({ id, type: node.type, params, position: { x: node.x, y: node.y } });
    }
    for (const [from, out, to, into] of starter.links) links.push({ from: { node: ids2.get(from), socket: out }, to: { node: ids2.get(to), socket: into } });
    const head = starter.nodes.find(n => !starter.links.some(([, , to]) => to === n.key));
    if (starter.attach && head) links.push({ from: { node: 'program', socket: 'exec' }, to: { node: ids2.get(head.key), socket: 'exec' } });
    const graph = { version: 2, graph: { nodes, links, frames: [], groups: [] } };
    assert.equal(M.validate(graph), '', `${starter.id}: saves`);
    if (starter.attach) assert.equal(M.problems(graph).length, 0, `${starter.id}: executes`);
  }
});

test('the attack-hit-damage starter compiles to an attack, then damage only on a hit', () => {
  const starter = ctx.window.Presets.item('graph_starter', 'attack-hit-damage');
  assert.ok(starter, 'the starter exists');
  assert.ok(starter.nodes.some(n => n.type === 'condition.hit') && starter.nodes.some(n => n.type === 'flow.if'));
});

test('preset lists for items and spells are data with the same shape as before', () => {
  const P = ctx.window.Presets;
  assert.deepEqual(plain(P.items('item_preset').map(p => p.id)), ['weapon', 'armor', 'consumable', 'magic', 'gear', 'blank']);
  assert.deepEqual(plain(P.items('spell_preset').map(p => p.id)), ['cantrip', 'spell1', 'spell3', 'ritual', 'blank']);
  assert.deepEqual(plain(P.item('spell_preset', 'cantrip').fields), { level: 0, cast_cost: 'free', name: 'Заговор' });
});
