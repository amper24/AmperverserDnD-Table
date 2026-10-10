// Выборы расы — из набора race_rules: проверка обязательных выборов и кастомная раса, описанная только данными.
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
const draftFor = (recs, ed, raceEntry, ruleChoices = {}) => ({ name: 'Тест', edition: ed, abilities: abil,
  selected: { race: raceEntry, class: null, background: recs.find(e => e.category === 'background') }, catalog: recs, spells: [], ruleChoices, method: 'standard', languages: [] });

test('built-in races ask for their required choices and accept a complete answer', () => {
  const half = draftFor(recs14, '2014', race(recs14, 'Полуэльф'));
  assert.match(B.raceChoiceProblem(half), /Универсальность навыков/);
  half.ruleChoices.raceSkills = ['stealth', 'athletics'];
  assert.equal(B.raceChoiceProblem(half), '');

  const dragon = draftFor(recs14, '2014', race(recs14, 'Драконорождённый'), { dragonAncestry: 'Чёрный' });
  assert.equal(B.raceChoiceProblem(dragon), '');
  dragon.ruleChoices.dragonAncestry = 'Не из списка';
  assert.match(B.raceChoiceProblem(dragon), /Драконье наследие/);
});

test('high elf cantrip must come from the wizard cantrip list of the catalog', () => {
  const high = draftFor(recs14, '2014', race(recs14, 'Высший эльф'));
  assert.match(B.raceChoiceProblem(high), /Заговор высшего эльфа/);
  const cantrip = recs14.find(e => e.category === 'spell' && Number(e.data?.level) === 0 && (e.data?.classes || []).some(c => ['волшебник', 'wizard'].includes(String(c).toLowerCase())));
  high.ruleChoices.racialCantrip = cantrip.id;
  assert.equal(B.raceChoiceProblem(high), '');
  high.ruleChoices.racialCantrip = 'spell|Несуществующий';
  assert.match(B.raceChoiceProblem(high), /Заговор высшего эльфа/);
});

test('a custom race described only by a user race_rules set gets its choices, checks and proficiencies', () => {
  const set = { kind: 'race_rules', id: 'user.nightfolk', name: 'Ночной народ', edition: '2014', items: [{ id: 'nightfolk', table: {
    name_en: 'Nightfolk', weapons: ['Кинжал'],
    choices: [
      { key: 'raceSkills', kind: 'skills', count: 1, title: 'Ночное зрение' },
      { key: 'nfInstrument', kind: 'options', grant: 'Инструменты расы', title: 'Инструмент народа', options: [{ value: 'Флейта', name: 'Флейта' }, { value: 'Барабан', name: 'Барабан' }] },
    ] } }] };
  ctx.window.Presets.importUser(JSON.stringify(set));
  const nightfolk = { id: 'r1', category: 'race', name: 'Ночной народ', source: 'Свой набор', data: { name_en: 'Nightfolk', speed: 30 } };
  const recs = [...recs14, nightfolk];

  const draft = draftFor(recs, '2014', nightfolk);
  assert.equal(B.raceChoices(draft).length, 2);
  assert.match(B.raceChoiceProblem(draft), /Ночное зрение/);
  draft.ruleChoices = { raceSkills: ['stealth'], nfInstrument: 'Барабан' };
  assert.equal(B.raceChoiceProblem(draft), '');

  const sheet = B.build(draft);
  assert.ok(JSON.stringify(sheet.proficiencies).includes('Кинжал'), 'race weapon from the set');
  assert.ok(JSON.stringify(sheet.proficiencies).includes('Барабан'), 'chosen instrument granted from the set');
  assert.ok(sheet.skills.includes('stealth'));
});
