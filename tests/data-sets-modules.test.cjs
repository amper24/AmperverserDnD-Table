// Умолчания блоков механик и выбор стартового снаряжения берутся из наборов block_defaults и equipment_pick_rules.
// Пользовательский набор с тем же видом меняет поведение мастеров без правки кода.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, crypto: globalThis.crypto, localStorage: { getItem() { return null; }, setItem() {} } };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
for (const f of ['static/dice.js', 'static/formulas.js', 'static/equipment.js', 'static/modules.js', 'static/class-rules.js', 'static/mechanics.js', 'static/character-builder.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
}
const Mech = ctx.window.Mechanics;
const CB = Object.values(ctx.window).find(v => v && typeof v === 'object' && v.parseItemToken);
const plain = x => JSON.parse(JSON.stringify(x));

test('умолчания блока берутся из набора block_defaults', () => {
  const attack = Mech.block('attack');
  assert.deepEqual(plain({ dice: attack.dice, kind: attack.kind, enabled: attack.enabled, when: attack.when }), { dice: { count: 1, sides: 20, bonus: 0, stat: 'atk' }, kind: 'attack', enabled: true, when: 'always' });
  assert.equal(Mech.block('condition').condition, 'Отравленный');
  assert.equal(Mech.block('heal').target, 'self');
});

test('пользовательский набор block_defaults меняет умолчания вида', () => {
  ctx.window.Presets.importUser({ kind: 'block_defaults', id: 'user.blocks', name: 'Мои блоки', items: [
    { id: 'adjust', table: { target: 'self', field: 'speed', amount: 10 } },
  ] });
  assert.equal(Mech.block('adjust').amount, 10);
});

test('выбор снаряжения: шаблоны и фильтры из набора equipment_pick_rules', () => {
  const pick = CB.parseItemToken('любое воинское рукопашное оружие');
  assert.equal(pick[0].kind, 'pick');
  assert.equal(pick[0].filter, 'martial-melee');
  assert.equal(CB.PICK_FILTERS['martial-melee'].label, 'воинское рукопашное оружие');
});

test('пользовательский набор equipment_pick_rules добавляет новый выбор', () => {
  ctx.window.Presets.importUser({ kind: 'equipment_pick_rules', id: 'user.picks', name: 'Мои выборы', items: [
    { id: 'bows', table: { role: 'filter', label: 'любой лук', weapon: false, category: 'Луки', name: '' } },
    { id: 'pattern_bows', table: { role: 'pattern', pattern: 'любой лук', flags: 'i', filter: 'bows' } },
  ] });
  const pick = CB.parseItemToken('любой лук');
  assert.equal(pick[0].filter, 'bows');
  assert.equal(pick[0].label, 'любой лук');
  assert.equal(CB.PICK_FILTERS.bows.test({ name: 'Длинный лук', data: { category: 'Луки' } }), true);
});
