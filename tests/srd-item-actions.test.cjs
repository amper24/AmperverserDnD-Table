const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// SRD-оружие: «Атака» и «Урон» — две отдельные кнопки (программы) со своими стилями, без «Атака и урон».
function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, append(...more) { this.children.push(...more.flat()); } };
}
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } }, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' } };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;

for (const edition of ['2014', '2024']) {
  test(`SRD ${edition}: weapons have separate «Атака» and «Урон» programs, no combined one`, () => {
    const rows = JSON.parse(fs.readFileSync(`data_seed/srd_${edition}.json`, 'utf8'));
    const weapons = rows.filter(r => r.category === 'item' && r.data?.mechanics?.version === 2 && r.data.mechanics.graph.nodes.some(n => n.type === 'action.program' && n.params?.name === 'Атака'));
    assert.ok(weapons.length >= 30, `found ${weapons.length} weapons`);
    for (const row of weapons) {
      const g = row.data.mechanics.graph;
      const programs = g.nodes.filter(n => n.type === 'action.program');
      assert.ok(!programs.some(n => n.params.name === 'Атака и урон'), `${row.slug}: combined program left`);
      const attack = programs.find(n => n.params.name === 'Атака');
      const damage = programs.find(n => n.params.name === 'Урон');
      assert.equal(attack?.params.style, 'attack', `${row.slug}: attack style`);
      assert.equal(damage?.params.style, 'damage', `${row.slug}: damage style`);
      const first = id => g.links.find(l => l.from.node === id && l.from.socket === 'exec')?.to.node;
      const typeOf = id => g.nodes.find(n => n.id === id).type;
      // Все броски — один настраиваемый узел action.roll; смысл задаёт параметр roll_kind.
      const kindOf = id => { const n = g.nodes.find(x => x.id === id); return n.type === 'action.roll' ? `roll:${n.params.roll_kind || 'roll'}` : n.type; };
      const attackChain = [];
      for (let id = first(attack.id); id; id = first(id)) attackChain.push(kindOf(id));
      const damageChain = [];
      for (let id = first(damage.id); id; id = first(id)) damageChain.push(kindOf(id));
      assert.ok(attackChain.includes('roll:attack') && !attackChain.includes('roll:damage'), `${row.slug}: attack chain ${attackChain}`);
      assert.ok(damageChain.length && damageChain.every(t => t === 'roll:damage' || t === 'action.manual'), `${row.slug}: damage chain ${damageChain}`);
      assert.equal(M.problems(row.data.mechanics).length, 0, `${row.slug}: graph is valid`);
    }
  });
}
