const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { crypto: require('node:crypto').webcrypto, window: {}, Modules: { newFeature: x => x, spellFromCompendium: e => ({ name: e.name }) },
  SKILLS: [['religion', 'Религия', 'int'], ['stealth', 'Скрытность', 'dex'], ['athletics', 'Атлетика', 'str']] };
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

const choiceGroup = (id, type, options, count = 1, optional = false) => ({ id, name: 'Группа ' + id, type, count, optional, options: options.map(([oid, name, value]) => ({ id: oid, name, value })) });

test('either/or ability choice applies once and never stacks on rebuild', () => {
  const d = draft();
  d.selected.race = entry('race', 'Полукровка', { choices: [choiceGroup('g1', 'ability', [['o1', 'Сила дракона', { str: 2 }], ['o2', 'Ловкость эльфа', { dex: 2 }]])] });
  d.picks = { g1: ['o1'] };
  const s = B.build(d);
  assert.equal(s.abilities.str, 12); assert.equal(s.abilities.dex, 10);
  assert.equal(s.creation.choices.map(c => c.name).join(), 'Сила дракона');
  d.picks = { g1: ['o2'] };
  const other = B.build(d);
  assert.equal(other.abilities.str, 10); assert.equal(other.abilities.dex, 12);
  assert.equal(JSON.stringify(B.build(d)), JSON.stringify(other));
});

test('feature, skill, language and proficiency choices land on the sheet once picked', () => {
  const d = draft();
  d.selected.class = entry('class', 'Следопыт', { hit_die: 'd10', saves: ['str'], choices: [
    choiceGroup('f', 'feature', [['f1', 'Лучник', { text: '+2 к попаданию из лука' }]]),
    choiceGroup('s', 'skill', [['s1', 'Скрытность', ['stealth']], ['s2', 'Атлетика', ['athletics']]]),
    choiceGroup('l', 'language', [['l1', 'Эльфийский', ['Эльфийский']]]),
    choiceGroup('p', 'proficiency', [['p1', 'Военное оружие', 'Военное оружие']]),
  ] });
  d.picks = { f: ['f1'], s: ['s1'], l: ['l1'], p: ['p1'] };
  const s = B.build(d);
  assert.ok(s.features.some(f => f.name === 'Лучник' && /лука/.test(f.text)));
  assert.ok(s.skills.includes('stealth')); assert.ok(!s.skills.includes('athletics'));
  assert.match(s.proficiencies, /Эльфийский/); assert.match(s.proficiencies, /Военное оружие/);
  assert.equal(s.creation.choices.length, 4);
  // Without a pick the module grants nothing: the choice is a player decision, not a default.
  const bare = draft(); bare.selected.class = d.selected.class;
  const s2 = B.build(bare);
  assert.ok(!s2.features.some(f => f.name === 'Лучник'));
  assert.ok(!s2.skills.includes('stealth'));
  assert.equal(s2.creation.choices.length, 0);
});

test('picks of a replaced module are ignored, optional choices may stay empty', () => {
  const d = draft();
  d.selected.background = entry('background', 'Странник', { choices: [choiceGroup('gone', 'ability', [['o', '+2', { str: 2 }]])] });
  d.picks = { other: ['x'] }; // группа от модуля, который уже не выбран
  assert.equal(B.build(d).abilities.str, 10);
  d.picks = { gone: ['o'] };
  assert.equal(B.build(d).abilities.str, 12);
  const optional = choiceGroup('opt', 'ability', [['o1', '+1', { wis: 1 }]], 1, true);
  d.selected.background = entry('background', 'Странник', { choices: [optional] });
  assert.equal(B.choiceState(optional, []).done, true);
  assert.equal(B.choiceState(optional, ['o1']).done, true);
  assert.equal(B.choiceState({ ...optional, optional: false }, []).done, false);
  d.picks = { opt: ['o1'] };
  assert.equal(B.build(d).abilities.wis, 11);
});

test('choice definitions are validated before they reach the sheet', () => {
  const ok = [choiceGroup('g', 'ability', [['o', '+2 Сила', { str: 2 }]])];
  assert.equal(B.validateChoices(undefined), '');
  assert.equal(B.validateChoices(ok), '');
  assert.match(B.validateChoices([{ ...ok[0], type: 'magic' }]), /тип/i);
  assert.match(B.validateChoices([{ ...ok[0], name: ' ' }]), /Назовите/);
  assert.match(B.validateChoices([{ ...ok[0], count: 3 }]), /вариант/i);
  assert.match(B.validateChoices([{ ...ok[0], options: [] }]), /вариант/i);
  assert.match(B.validateChoices([{ ...ok[0], options: [{ id: 'o', name: '+9', value: { str: 9 } }] }], ), /−5|\-5/i);
  assert.match(B.validateChoices([choiceGroup('f', 'feature', [['o', 'Умение', { text: ' ' }]])]), /умение/i);
  assert.match(B.validateChoices([choiceGroup('s', 'skill', [['o', 'Танцы', ['dance']]])]), /навыки/i);
  assert.match(B.validateChoices([choiceGroup('l', 'language', [['o', 'Язык', ['']]])]), /языки/i);
  assert.match(B.validateChoices([choiceGroup('p', 'proficiency', [['o', 'Владение', ' ']])]), /владение/i);
  assert.match(B.validateChoices([ok[0], ok[0]]), /код/i);
});
