const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { crypto: require('node:crypto').webcrypto, window: {}, Modules: { newFeature: x => x, spellFromCompendium: e => ({ name: e.name }) }, SKILLS: [['religion', 'Религия', 'int']] };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), ctx);
ctx.DiceEngine = { ...ctx.window.DiceEngine, present() {} };
vm.runInContext(fs.readFileSync('static/character-builder.js', 'utf8'), ctx);
const B = ctx.window.CharacterBuilder;
const entry = (category, name, data) => ({ id: name, category, name, source: 'Test pack', data });
const draft = () => ({ name: ' Герой ', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: {
  race: entry('race', 'Дварф', { asi: { con: 2 }, speed: 25, traits: [{ name: 'Зрение', text: '60 фт.' }] }),
  class: entry('class', 'Воин', { hit_die: 'd10', saves: ['str', 'con'], features: { 1: ['Стиль боя'], 2: ['Всплеск'] } }),
  background: entry('background', 'Послушник', { skills: ['Религия'] })
}, spells: [entry('spell', 'Свет', { level: 0 })], method: 'standard' });
test('4d6 drops exactly one minimum, totals stay within 3..18', () => {
  for (const r of B.rollStats(() => 0)) { assert.equal(r.total, 3); assert.equal(r.dropped, 3); }
  for (const r of B.rollStats(() => .999)) assert.equal(r.total, 18);
  for (const r of B.rollStats()) assert.equal(r.total, r.dice.reduce((a,b) => a+b,0) - Math.min(...r.dice));
});
test('build applies modules and derives first-level values without mutating draft', () => {
  const d = draft(), before = JSON.stringify(d), s = B.build(d);
  assert.equal(s.name, 'Герой'); assert.equal(s.abilities.con, 12); assert.equal(s.hp.max, 11);
  assert.equal(s.speed, 25); assert.equal(s.ac, 10); assert.equal(s.features.length, 2);
  assert.equal(s.spells.known.length, 1); assert.equal(s.skills[0], 'religion');
  assert.equal(JSON.stringify(d), before); assert.equal(JSON.stringify(B.build(d)), JSON.stringify(s));
  s.modules[0].snapshot.data.asi.con = 99; assert.equal(d.selected.race.data.asi.con, 2);
});
test('changing race never stacks previous bonuses', () => {
  const d = draft(); B.build(d); d.selected.race = entry('race', 'Эльф', { asi: { dex: 2 } });
  const s = B.build(d); assert.equal(s.abilities.con, 10); assert.equal(s.abilities.dex, 12); assert.equal(s.hp.max, 10);
});
test('2024 uses background allocation, not race ASI', () => {
  const d = draft(); d.edition = '2024'; d.bonuses = { wis: 2, con: 1 };
  const s = B.build(d); assert.equal(s.abilities.con, 11); assert.equal(s.abilities.wis, 12);
});
test('registry accepts a custom category handler', () => {
  B.register('feat', (s, e) => s.notes += e.name);
  const d = draft(); d.spells = [entry('feat', 'Модуль', {})]; assert.equal(B.build(d).notes, 'Модуль');
});
test('subrace includes parent speed, ASI, traits and module provenance', () => {
  const d = draft(); d.catalog = [d.selected.race];
  d.selected.race = entry('race', 'Холмовой дварф', { parent: 'Дварф', subrace: true, asi: { wis: 1 } });
  const s = B.build(d); assert.equal(s.abilities.con, 12); assert.equal(s.abilities.wis, 11);
  assert.equal(s.speed, 25); assert.equal(s.modules.length, 5); assert.equal(s.features[0].name, 'Зрение');
});
