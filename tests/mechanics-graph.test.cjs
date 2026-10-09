const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat().filter(value => value !== null && value !== undefined); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } }, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' }, SKILLS: [] };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/mechanics-graph.json', 'utf8'));

test('client graph validation matches the shared Rust fixture contract', () => {
  for (const entry of fixture.cases) assert.equal(M.validate(entry.mechanics) === '', entry.valid, entry.name);
});

test('v1 reads through stable v2 IDs and v2 saves compile back without mutating stored copies', () => {
  const old = { version: 1, origin: 'legacy', programs: [{ id: 'p1', name: 'Old action', trigger: 'use', blocks: [{ id: 'b1', kind: 'manual', text: 'Do this manually', when: 'always' }] }] };
  const first = M.toGraph(old), second = M.toGraph(old);
  assert.deepEqual(plain(first), plain(second));
  assert.equal(first.version, 2);
  assert.equal(M.validate(first), '');
  assert.deepEqual(plain(M.toLegacy(first)), plain(old));
  assert.deepEqual(plain(old.programs[0].blocks), [{ id: 'b1', kind: 'manual', text: 'Do this manually', when: 'always' }]);
});

test('group ports flatten across nested reusable groups without duplicate action links', () => {
  const entry = fixture.cases.find(value => value.name === 'reusable-group-boundary');
  const mechanics = structuredClone(entry.mechanics);
  const groups = mechanics.graph.groups;
  groups.unshift({
    id: 'inner', name: 'Inner',
    inputs: [{ id: 'i', name: 'Flow in', type: 'flow' }],
    outputs: [{ id: 'o', name: 'Flow out', type: 'flow' }],
    nodes: [
      { id: 'ii', type: 'group.input', params: { socket_id: 'i' } },
      { id: 'io', type: 'group.output', params: { socket_id: 'o' } },
      { id: 'inner-action', type: 'action.manual', params: { block_id: 'nested-manual', text: 'Nested', when: 'always' } },
    ],
    links: [
      { from: { node: 'ii', socket: 'value' }, to: { node: 'inner-action', socket: 'exec' } },
      { from: { node: 'inner-action', socket: 'exec' }, to: { node: 'io', socket: 'value' } },
    ],
  });
  const outer = groups.find(value => value.id === 'g1');
  outer.nodes = outer.nodes.filter(value => value.type !== 'action.manual');
  outer.nodes.push({ id: 'nested-instance', type: 'group.instance', params: { group_id: 'inner' } });
  outer.links = [
    { from: { node: 'gi', socket: 'value' }, to: { node: 'nested-instance', socket: 'i' } },
    { from: { node: 'nested-instance', socket: 'o' }, to: { node: 'go', socket: 'value' } },
  ];
  assert.equal(M.validate(mechanics), '');
  const legacy = M.toLegacy(mechanics);
  assert.deepEqual(plain(legacy.programs[0].blocks.map(block => block.id)), ['nested-manual', 'root-roll']);
});

test('flow branches select by edition and level at runtime but remain structurally inspectable', () => {
  const mechanics = {
    version: 2,
    graph: {
      nodes: [
        { id: 'program', type: 'action.program', params: { program_id: 'branch', name: 'Branch', trigger: 'use' } },
        { id: 'level', type: 'condition.level', params: { min: 5, max: 20 } },
        { id: 'branch-node', type: 'flow.if', params: {} },
        { id: 'low', type: 'action.manual', params: { block_id: 'low', text: 'Below 5', when: 'always' } },
        { id: 'high', type: 'action.roll', params: { block_id: 'high', dice: { count: 1, sides: 8, bonus: 0 }, when: 'always' } },
      ],
      links: [
        { from: { node: 'program', socket: 'exec' }, to: { node: 'branch-node', socket: 'exec' } },
        { from: { node: 'level', socket: 'value' }, to: { node: 'branch-node', socket: 'condition' } },
        { from: { node: 'branch-node', socket: 'else' }, to: { node: 'low', socket: 'exec' } },
        { from: { node: 'branch-node', socket: 'then' }, to: { node: 'high', socket: 'exec' } },
      ],
      frames: [], groups: [],
    },
  };
  assert.equal(M.validate(mechanics), '');
  assert.deepEqual(plain(M.toLegacy(mechanics, { level: 4 }).programs[0].blocks.map(block => block.id)), ['low']);
  assert.deepEqual(plain(M.toLegacy(mechanics, { level: 5 }).programs[0].blocks.map(block => block.id)), ['high']);
  assert.deepEqual(plain(M.toLegacy(mechanics).programs[0].blocks.map(block => block.id)), ['high', 'low'], 'context-free validation retains both branches');
});

test('graph effects preview and project through typed values without accumulating on repeated builds', () => {
  const mechanics = {
    version: 2,
    graph: {
      nodes: [
        { id: 'edition', type: 'condition.edition', params: { editions: ['2024'] } },
        { id: 'speed-value', type: 'data.number', params: { value: 35 } },
        { id: 'speed', type: 'rule.speed', params: { value: 30 } },
        { id: 'bonus-value', type: 'data.number', params: { value: 2 } },
        { id: 'bonus', type: 'rule.ability_bonus', params: { ability: 'dex', amount: 1 } },
      ],
      links: [
        { from: { node: 'edition', socket: 'value' }, to: { node: 'speed', socket: 'enabled' } },
        { from: { node: 'speed-value', socket: 'value' }, to: { node: 'speed', socket: 'value' } },
        { from: { node: 'bonus-value', socket: 'value' }, to: { node: 'bonus', socket: 'amount' } },
      ],
      frames: [], groups: [],
    },
  };
  assert.equal(M.validate(mechanics), '');
  const base = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, speed: 30, hp: { max: 4, current: 4, temp: 0, hit_dice: '1d8' }, saving_throws: [], skills: [], features: [], spells: { slots: {}, known: [] }, proficiencies: '' };
  const target = structuredClone(base), rebuilt = structuredClone(base);
  M.applyGraphRules(mechanics, target, { edition: '2024', level: 1, choices: {} });
  M.applyGraphRules(mechanics, rebuilt, { edition: '2014', level: 1, choices: {} });
  assert.equal(target.speed, 35);
  assert.equal(rebuilt.speed, 30, 'an inapplicable edition-specific node leaves base speed intact');
  assert.equal(target.abilities.dex, 12);
  assert.equal(rebuilt.abilities.dex, 12);
  assert.equal(base.abilities.dex, 10, 'the source sheet is not mutated');
});
