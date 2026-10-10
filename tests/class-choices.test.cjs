// Выборы класса из набора class_rules: варианты, проверки и применение к листу.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const seed = ed => JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`, 'utf8'));
const ctx = { crypto: require('node:crypto').webcrypto, window: {}, console: { log() {}, warn() {}, error() {} }, localStorage: { getItem() { return null; }, setItem() {} } };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
for (const f of ['static/dice.js', 'static/formulas.js', 'static/equipment.js', 'static/modules.js', 'static/class-rules.js', 'static/character-builder.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
ctx.window.SKILLS = [['acrobatics', 'Акробатика', 'dex'], ['arcana', 'Магия', 'int'], ['religion', 'Религия', 'int'], ['nature', 'Природа', 'int'], ['athletics', 'Атлетика', 'str']];
ctx.SKILLS = ctx.window.SKILLS;
ctx.Modules = ctx.window.Modules;
ctx.Equipment = ctx.window.Equipment;
before(() => presetsReady);
const B = ctx.window.CharacterBuilder || ctx.window.B;
const catalog = ed => seed(ed).map((e, i) => ({ ...e, id: e.id || `c${ed}-${i}`, source: 'srd' }));
const draft = (ed, slug, ruleChoices = {}) => {
  const cat = catalog(ed), cls = cat.find(e => e.category === 'class' && e.slug === `srd${ed.slice(2)}-${slug}`);
  return { name: 'T', edition: ed, level: 1, abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, catalog: cat, ruleChoices, skills: [], freeSkills: [], languages: [], selected: { class: cls, race: null, background: null, feat: null, subclass: null } };
};

test('боевой стиль воина 2014: варианты из набора, проверка и черта на листе', () => {
  const none = draft('2014', 'fighter');
  assert.equal(B.classChoices(none)[0].options.length, 6);
  assert.match(B.classChoiceProblem(none), /одного? боевого стиля|Выберите/);
  const ok = draft('2014', 'fighter', { fightingStyle: 'Боевой стиль: Защита' });
  assert.equal(B.classChoiceProblem(ok), null);
  assert.ok(B.build(ok).features.some(f => f.name === 'Боевой стиль: Защита'));
});

test('ордена жреца и друида 2024: владения, особенность и бонусный заговор', () => {
  const pro = draft('2024', 'cleric', { clericOrder: 'protector' });
  assert.equal(B.classChoiceProblem(draft('2024', 'cleric')), 'Выберите Божественный орден жреца.');
  assert.ok(B.build(pro).features.some(f => f.name === 'Божественный орден: Защитник'));
  assert.match(B.build(pro).proficiencies, /Воинское оружие/);
  const magic = draft('2024', 'druid', { druidOrder: 'magician' });
  assert.ok(B.build(magic).features.some(f => f.name === 'Первобытный орден: Маг'));
  assert.equal(B.classChoiceProblem(magic), null);
});

test('черта стиля воина 2024 берётся из наборов черт (группа style)', () => {
  const options = B.classChoices(draft('2024', 'fighter'))[0].options;
  assert.equal(options.length, 4, JSON.stringify(options.map(o => o.name)));
});

test('в коде сборщика больше нет жёстких ключей выборов класса', () => {
  const src = fs.readFileSync('static/character-builder.js', 'utf8');
  for (const token of ["ruleChoices.clericOrder === 'thaumaturge'", "classSlug === 'fighter') {\n      const style", "ruleChoices.druidOrder === 'magician'"]) assert.ok(!src.includes(token), token);
});

test('рейнджер 2014: гуманоиды требуют два разных вида, язык только при избранном враге', () => {
  const base = { favoredEnemy: 'Гуманоиды', favoredTerrain: 'Лес' };
  assert.match(B.classChoiceProblem(draft('2014', 'ranger', base)), /Заполните поля варианта «Гуманоиды»/);
  assert.match(B.classChoiceProblem(draft('2014', 'ranger', { ...base, favoredHumanoidOne: 'Орки', favoredHumanoidTwo: 'орки' })), /разные/);
  const ok = draft('2014', 'ranger', { ...base, favoredHumanoidOne: 'Орки', favoredHumanoidTwo: 'Гоблины', favoredLanguage: 'Драконий' });
  assert.equal(B.classChoiceProblem(ok), null);
  const sheet = B.build(ok);
  assert.ok(sheet.features.some(f => f.name === 'Избранный враг: Гуманоиды' && f.text.includes('Орки, Гоблины')));
  assert.ok(sheet.features.some(f => f.name === 'Природный исследователь: Лес'));
  assert.match(sheet.proficiencies, /Язык класса: Драконий/);
  const noEnemy = draft('2014', 'ranger', { favoredLanguage: 'Драконий', favoredTerrain: 'Лес' });
  assert.match(B.classChoiceProblem(noEnemy), /избранного врага|Выберите/);
  assert.ok(!B.build(noEnemy).proficiencies.includes('Драконий'));
});

test('бард: три разных инструмента из справочника', () => {
  const names = seed('2014').filter(e => e.category === 'item' && e.data?.category === 'Музыкальные инструменты').map(e => e.name);
  assert.ok(names.length >= 3);
  assert.match(B.classChoiceProblem(draft('2014', 'bard', { bardInstruments: names.slice(0, 2) })), /разных|Бард/);
  const ok = draft('2014', 'bard', { bardInstruments: names.slice(0, 3) });
  assert.equal(B.classChoiceProblem(ok), null);
  assert.match(B.build(ok).proficiencies, /Музыкальные инструменты/);
});

test('мастерство оружия 2024 и экспертиза плута 2014: правила из наборов', () => {
  const mastery = draft('2024', 'barbarian');
  const opts = B.classChoices(mastery).find(c => c.key === 'weaponMasteries');
  assert.ok(opts && opts.options.length > 2, 'варианты мастерства');
  assert.match(B.classChoiceProblem(mastery), /мастерств|Выберите/i);
  const ids = opts.options.slice(0, 2).map(o => o.value);
  const ok = draft('2024', 'barbarian', { weaponMasteries: ids });
  assert.equal(B.classChoiceProblem(ok), null);
  assert.ok(B.build(ok).features.some(f => /мастерств/i.test(f.name)));
  const rogue = { ...draft('2014', 'rogue', { expertise: ['acrobatics', 'arcana'] }), skills: ['acrobatics', 'arcana'] };
  const avail = ['acrobatics', 'arcana'];
  assert.equal(B.classChoiceProblem(rogue, avail), null);
  assert.match(B.classChoiceProblem({ ...rogue, ruleChoices: { expertise: ['acrobatics'] } }, avail), /экспертиз/i);
});

test('домен жизни 2014: тяжёлые доспехи из subclass_grants набора, другой домен — нет', () => {
  const cleric = seed('2014').find(e => e.category === 'class' && e.slug === 'srd14-cleric');
  const life = cleric.data.subclasses.find(s => s.name_en === 'Life');
  const war = { name: 'Домен Обмана', name_en: 'Trickery' };
  assert.ok(life, 'домен жизни есть в сиде');
  const build = sub => {
    const d = draft('2014', 'cleric');
    d.selected.subclass = { name: sub.name, data: sub };
    return B.build(d);
  };
  assert.match(build(life).proficiencies, /Тяжёлые доспехи/);
  assert.doesNotMatch(build(war).proficiencies, /Тяжёлые доспехи/);
});

test('Посвящённый в магию: правило выбора заклинаний из набора feat_rules (2024)', () => {
  const feat = { name: 'Посвящённый в магию', data: { name_en: 'Magic Initiate' } };
  const rule = B.spellChoiceOf(feat, '2024');
  assert.equal(rule.cantrips, 2);
  assert.equal(rule.first_level, 1);
  assert.deepEqual(rule.abilities, ['int', 'wis', 'cha']);
  assert.deepEqual(rule.lists.map(l => l.id), ['cleric', 'druid', 'wizard']);
  assert.equal(B.spellChoiceOf({ name: 'Бдительность', data: { name_en: 'Alert' } }, '2024'), null);
  assert.equal(B.spellChoiceOf(feat, '2014'), null);
});

test('пользовательский класс из своего набора class_rules: выбор, проверка и особенность на листе', async () => {
  await presetsReady;
  ctx.window.Presets.importUser({ kind: 'class_rules', id: 'user.homebrew-class', name: 'Свой класс', edition: '2014',
    items: [{ id: 'homebrew', table: { ru: 'Свой класс', choices: [{ key: 'school', kind: 'options', title: 'Школа', feature_name: 'Школа',
      options: [{ value: 'fire', name: 'Огонь', feature_text: 'Огненный удар.' }, { value: 'ice', name: 'Лёд', feature_text: 'Ледяной удар.' }] }] } }] });
  const cls = { id: 'user-homebrew', category: 'class', name: 'Свой класс', slug: 'homebrew', source: 'user', data: { name_en: 'homebrew', edition: '2014' } };
  const d = { name: 'T', edition: '2014', level: 1, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, catalog: [], ruleChoices: {}, skills: [], freeSkills: [], languages: [],
    selected: { class: cls, race: null, background: null, feat: null, subclass: null } };
  assert.equal(B.classChoices(d).length, 1, 'выбор из пользовательского набора виден мастеру');
  assert.match(B.classChoiceProblem(d), /Школа|Выберите/);
  const ok = { ...d, ruleChoices: { school: 'ice' } };
  assert.equal(B.classChoiceProblem(ok), null);
  const sheet = B.build(ok);
  assert.ok(sheet.features.some(f => f.name === 'Школа: Лёд' && f.text === 'Ледяной удар.'), JSON.stringify(sheet.features.map(f => f.name)));
  assert.equal(B.classChoices({ ...d, edition: '2024' }).length, 0, 'редакция 2024 пользовательским набором не затронута');
});

test('заклинания класса на листе: домен жизни 2014 и всегда подготовленные из наборов', () => {
  const cleric = seed('2014').find(e => e.category === 'class' && e.slug === 'srd14-cleric');
  const life = cleric.data.subclasses.find(s => s.name_en === 'Life');
  const lifeDraft = draft('2014', 'cleric');
  lifeDraft.selected.subclass = { name: life.name, data: life };
  const known = B.build(lifeDraft).spells.known;
  for (const name of ['Благословение', 'Лечение ран']) {
    const spell = known.find(s => s.name === name);
    assert.ok(spell && spell.prepared, `домен жизни: ${name} подготовлено`);
  }
  const druid = B.build(draft('2024', 'druid')).spells.known.find(s => s.name === 'Разговор с животными');
  assert.ok(druid && druid.prepared, 'друид 2024: «Разговор с животными» всегда подготовлено');
  assert.equal(B.build(draft('2014', 'cleric')).spells.known.some(s => s.name === 'Благословение'), false, 'без домена заклинаний домена нет');
  assert.ok(B.build(draft('2024', 'druid')).proficiencies.includes('Друидический'), 'язык класса друида из набора');
});
