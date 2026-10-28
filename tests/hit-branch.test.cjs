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
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const plain = value => JSON.parse(JSON.stringify(value));

const attackBlock = { id: 'atk', kind: 'attack', dice: { count: 0, sides: 20, bonus: 5, stat: '' }, dc: 3 };
const hitDamage = { id: 'dmg', kind: 'damage', when: 'hit', dice: { count: 1, sides: 6, bonus: 0, stat: '' } };
const missHeal = { id: 'heal', kind: 'heal', when: 'miss', target: 'self', apply: true, dice: { count: 0, sides: 6, bonus: 1, stat: '' } };
const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
const program = (id = 'p', name = 'Удар') => node(id, 'action.program', { program_id: id, name, trigger: 'use' });
const roll = (id, kind, params = {}) => node(id, 'action.roll', { block_id: id, roll_kind: kind, enabled: true, when: 'always', ...params });
const wire = (from, fromSocket, to, toSocket) => ({ from: { node: from, socket: fromSocket }, to: { node: to, socket: toSocket } });
// Хелпер достраивает «Конец» каждой оборванной ветви (как редактор): графы тестов остаются исполнimыми.
const vault = (nodes, links) => {
  const graph = { nodes, links, frames: [], groups: [] };
  M.addFlowEnds(graph);
  return { version: 2, graph };
};
// Атака → «Попадание атаки» → «Если» → урон по ветке «да».
const hitChain = () => vault([program(), roll('a', 'attack', { block_id: 'atk', dice: attackBlock.dice, dc: 3 }), node('h', 'condition.hit', {}), node('f', 'flow.if', {}), roll('d', 'damage', { block_id: 'dmg', dice: hitDamage.dice })],
  [wire('p', 'exec', 'a', 'exec'), wire('a', 'exec', 'f', 'exec'), wire('h', 'value', 'f', 'condition'), wire('f', 'then', 'd', 'exec')]);
// Готовый граф в конверте v2: достроить «Конец» там, где поток обрывается.
const withEnds = mechanics => { M.addFlowEnds(mechanics.graph); return mechanics; };

test('v1 не принимается: ветка попадания задаётся узлами, а не старым полем when', () => {
  const v1 = { version: 1, origin: 'legacy', programs: [{ id: 'p', name: 'Удар', trigger: 'use', blocks: [attackBlock, hitDamage] }] };
  assert.match(M.validate(v1), /Неподдерживаемая схема механик/);
  assert.equal(M.toGraph, undefined);
  const graph = hitChain();
  assert.equal(M.validate(graph), '');
  assert.equal(M.problems(graph).length, 0);
  const back = plain(M.toLegacy(graph).programs[0].blocks);
  assert.deepEqual(back.map(b => [b.kind, b.when || 'always']), [['attack', 'always'], ['damage', 'hit']]);
});

test('the then and else outputs gate hit and miss blocks separately', () => {
  const graph = withEnds({ version: 2, graph: { nodes: [
    { id: 'p', type: 'action.program', params: { program_id: 'use', name: 'Выбор', trigger: 'use' } },
    { id: 'a', type: 'action.roll', params: { block_id: 'atk', roll_kind: 'attack', enabled: true, dice: attackBlock.dice, dc: 3 } },
    { id: 'h', type: 'condition.hit', params: {} },
    { id: 'f', type: 'flow.if', params: {} },
    { id: 'd', type: 'action.roll', params: { block_id: 'dmg', roll_kind: 'damage', enabled: true, dice: hitDamage.dice } },
    { id: 'm', type: 'action.roll', params: { block_id: 'heal', roll_kind: 'heal', enabled: true, dice: missHeal.dice } },
  ], links: [
    { from: { node: 'p', socket: 'exec' }, to: { node: 'a', socket: 'exec' } },
    { from: { node: 'a', socket: 'exec' }, to: { node: 'f', socket: 'exec' } },
    { from: { node: 'h', socket: 'value' }, to: { node: 'f', socket: 'condition' } },
    { from: { node: 'f', socket: 'then' }, to: { node: 'd', socket: 'exec' } },
    { from: { node: 'f', socket: 'else' }, to: { node: 'm', socket: 'exec' } },
  ], frames: [], groups: [] } });
  assert.equal(M.validate(graph), '');
  assert.equal(M.problems(graph).length, 0);
  const blocks = plain(M.toLegacy(graph).programs[0].blocks);
  assert.deepEqual(blocks.map(b => [b.kind, b.when || 'always']), [['attack', 'always'], ['damage', 'hit'], ['heal', 'miss']]);
});

test('a branch continues with ungated nodes: only the node wired to the output is gated', () => {
  const chain = hitChain();
  const graph = vault([...chain.graph.nodes, roll('tail', 'heal', { dice: missHeal.dice })],
    [...chain.graph.links, wire('d', 'exec', 'tail', 'exec')]);
  const back = M.toLegacy(graph).programs[0].blocks;
  assert.deepEqual(plain(back).map(b => [b.id, b.when || 'always']), [['atk', 'always'], ['dmg', 'hit'], ['tail', 'always']], 'the chain after the gated block is not gated');
});

test('a hit condition wired to anything but a branch is saved but not executed', () => {
  const graph = withEnds({ version: 2, graph: { nodes: [
    { id: 'p', type: 'action.program', params: { program_id: 'use', name: 'Удар', trigger: 'use' } },
    { id: 'h', type: 'condition.hit', params: {} },
    { id: 'd', type: 'action.roll', params: { block_id: 'dmg', roll_kind: 'damage', enabled: true, dice: hitDamage.dice } },
  ], links: [
    { from: { node: 'p', socket: 'exec' }, to: { node: 'd', socket: 'exec' } },
    { from: { node: 'h', socket: 'value' }, to: { node: 'd', socket: 'enabled' } },
  ], frames: [], groups: [] } });
  assert.equal(M.validate(graph), '', 'structure is fine, so the record can be saved');
  assert.ok(M.problems(graph).some(text => text.includes('только ко входу «Если»')));
  assert.match(M.evaluateGraph(graph).error, /Граф не исполняется/);
});

test('nested hit branches are reported as a problem', () => {
  const chain = hitChain();
  const nodes = chain.graph.nodes, links = chain.graph.links;
  const branch = nodes.find(n => n.type === 'flow.if');
  nodes.push(node('h2', 'condition.hit', {}), node('f2', 'flow.if', {}));
  links.push(wire('h2', 'value', 'f2', 'condition'));
  links.push(wire(branch.id, 'then', 'f2', 'exec'));
  assert.ok(M.problems(chain).some(text => text.includes('вкладывать')));
});

test('sequential hit branches (after a gated block) are allowed', () => {
  const chain = hitChain();
  const graph = vault([...chain.graph.nodes, node('h2', 'condition.hit', {}), node('f2', 'flow.if', {}), roll('he', 'heal', { dice: missHeal.dice })],
    [...chain.graph.links, wire('d', 'exec', 'f2', 'exec'), wire('h2', 'value', 'f2', 'condition'), wire('f2', 'then', 'he', 'exec')]);
  assert.deepEqual(plain(M.problems(graph)), [], 'each block has its own branch after the attack');
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
    const graph = withEnds({ version: 2, graph: { nodes, links, frames: [], groups: [] } });
    assert.equal(M.validate(graph), '', `${starter.id}: saves`);
    if (starter.attach) assert.equal(M.problems(graph).length, 0, `${starter.id}: executes`);
  }
});

test('attack and damage are two separate starters with their own button styles', () => {
  const P = ctx.window.Presets;
  const attack = P.item('graph_starter', 'attack-only');
  const damage = P.item('graph_starter', 'damage-only');
  assert.ok(attack && damage, 'both starters exist');
  assert.ok(!P.item('graph_starter', 'attack-hit-damage'), 'the combined starter is gone');
  assert.equal(attack.style, 'attack');
  assert.equal(damage.style, 'damage');
  assert.deepEqual(plain(attack.nodes.map(n => [n.type, n.params.roll_kind])), [['action.roll', 'attack']]);
  assert.deepEqual(plain(damage.nodes.map(n => [n.type, n.params.roll_kind])), [['action.roll', 'damage']]);
});

test('weapon and spell templates split attack and damage into separate actions', () => {
  const P = ctx.window.Presets;
  const expect = { weapon: ['attack', 'attack'], weapon_damage: ['damage', 'damage'], spell_attack: ['attack', 'spell'], spell_damage: ['damage', 'damage'] };
  for (const [id, [type, style]] of Object.entries(expect)) {
    const item = P.item('mechanic_templates', id);
    assert.ok(item, `${id} exists`);
    // Узел «Конец» в шаблон входит (поток действия обязан завершаться), но блоком не является.
    const graphNodes = item.table.graph.nodes;
    assert.ok(graphNodes.some(node => node.type === 'flow.end'), `${id}: «Конец» есть`);
    const nodes = graphNodes.filter(node => node.type !== 'flow.end');
    assert.equal(nodes.length, 2, `${id}: program + one block`);
    assert.equal(nodes[1].type, 'action.roll', `${id}: single configurable roll node`);
    assert.equal(nodes[1].params.roll_kind, type, `${id}: roll kind`);
    assert.equal(nodes[0].params.style, style, `${id}: button style`);
  }
});

test('preset lists for items and spells are data with the same shape as before', () => {
  const P = ctx.window.Presets;
  assert.deepEqual(plain(P.items('item_preset').map(p => p.id)), ['weapon', 'armor', 'consumable', 'magic', 'gear', 'blank']);
  assert.deepEqual(plain(P.items('spell_preset').map(p => p.id)), ['cantrip', 'spell1', 'spell3', 'ritual', 'blank']);
  assert.deepEqual(plain(P.item('spell_preset', 'cantrip').fields), { level: 0, cast_cost: 'free', name: 'Заговор' });
});
