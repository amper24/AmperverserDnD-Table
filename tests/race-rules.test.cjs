// Особенности рас и родословных — набор race_rules (static/presets/race-rules-*.json), а не имена в коде.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { crypto: require('node:crypto').webcrypto, window: {}, console,
  Modules: { newFeature: x => x, spellFromCompendium: e => ({ name: e.name, level: e.data?.level ?? 1, prepared: false }) },
  SKILLS: [['stealth', 'Скрытность', 'dex'], ['athletics', 'Атлетика', 'str'], ['perception', 'Восприятие', 'wis']] };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
ctx.DiceEngine = { ...ctx.window.DiceEngine, present() {} };
vm.runInContext(fs.readFileSync('static/class-rules.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/character-builder.js', 'utf8'), ctx);
const B = ctx.window.CharacterBuilder;
const abil = Object.fromEntries(B.keys.map(k => [k, 10]));
const load = ed => JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`, 'utf8')).map(e => e.id ? e : { ...e, id: `${e.category}|${e.name}` });
const recs14 = load('2014'), recs24 = load('2024');
const race = (recs, name) => recs.find(e => e.category === 'race' && e.name === name);
const build = (recs, ed, raceName, ruleChoices = {}, cls = null) => B.build({ name: 'Тест', edition: ed, abilities: abil,
  selected: { race: race(recs, raceName), class: cls, background: recs.find(e => e.category === 'background') }, catalog: recs, spells: [], ruleChoices, method: 'standard', languages: [] });
const spellNames = s => s.spells.known.map(x => x.name);

test('race_rules sets exist for both editions and cover every lineage with special rules', () => {
  const items = ed => ctx.window.Presets.items('race_rules', ed).map(i => i.table.name_en);
  assert.ok(items('2014').includes('Dwarf') && items('2014').includes('High Elf'));
  assert.ok(items('2024').includes('Elven Lineage: Wood Elf') && items('2024').includes('Fiendish Legacy: Abyssal'));
  assert.ok(items('2024').includes('Dwarf'));
});

test('wood elf 2024 gets speed 35 from its lineage record; drow lineage overrides the root cantrip', () => {
  assert.equal(build(recs24, '2024', 'Эльфийская линия: лесной эльф', { raceSpellAbility: 'wis' }).speed, 35);
  assert.equal(build(recs24, '2024', 'Эльфийская линия: дроу', { raceSpellAbility: 'cha' }).spells.known.find(s => s.name === 'Пляшущие огоньки')?.spell_ability, 'cha');
  assert.ok(!spellNames(build(recs24, '2024', 'Эльфийская линия: дроу', { raceSpellAbility: 'cha' })).includes('Искусство друидов'));
});

test('forest gnome 2024 always prepares its spell; rock gnome inherits the root cantrips', () => {
  const forest = build(recs24, '2024', 'Гномья линия: лесной гном', { raceSpellAbility: 'int' });
  assert.ok(forest.spells.known.some(s => s.name === 'Разговор с животными' && s.prepared));
  assert.ok(forest.spells.known.some(s => s.name === 'Малая иллюзия'));
  const rock = spellNames(build(recs24, '2024', 'Гномья линия: скальный гном', { raceSpellAbility: 'int' }));
  assert.ok(rock.includes('Починка') && rock.includes('Фокусы'));
});

test('dwarf 2014 weapons come from the root record and reach its subraces; dwarf 2024 gets the hit point bonus', () => {
  const hill = build(recs14, '2014', 'Холмовой дварф', { dwarfTool: 'Инструменты каменщика' });
  const text = JSON.stringify(hill.proficiencies);
  assert.ok(text.includes('Боевой топор'));
  assert.ok(text.includes('Инструменты каменщика'));
  const dwarf24 = build(recs24, '2024', 'Дварф', {});
  const human24 = build(recs24, '2024', 'Человек', {});
  // Человек 2024 не имеет бонуса хитов расы: разница с дварфом — ровно правило hp_bonus из набора.
  assert.equal(dwarf24.hp.max - human24.hp.max, 1);
});
