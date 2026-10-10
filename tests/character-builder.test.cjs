const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { crypto: require('node:crypto').webcrypto, window: {}, Modules: { newFeature: x => x, spellFromCompendium: e => ({ name: e.name, level: e.data?.level ?? 1, prepared: false }) },
  SKILLS: [['acrobatics', 'Акробатика', 'dex'], ['animal', 'Уход за животными', 'wis'], ['arcana', 'Магия', 'int'], ['athletics', 'Атлетика', 'str'], ['deception', 'Обман', 'cha'],
    ['history', 'История', 'int'], ['insight', 'Проницательность', 'wis'], ['intimidation', 'Запугивание', 'cha'], ['investigation', 'Расследование', 'int'], ['medicine', 'Медицина', 'wis'],
    ['nature', 'Природа', 'int'], ['perception', 'Восприятие', 'wis'], ['performance', 'Выступление', 'cha'], ['persuasion', 'Убеждение', 'cha'], ['religion', 'Религия', 'int'],
    ['sleight', 'Ловкость рук', 'dex'], ['stealth', 'Скрытность', 'dex'], ['survival', 'Выживание', 'wis']] };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), ctx);
// Наборы данных (таблицы развития) — реестр Presets, читается с диска.
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
ctx.DiceEngine = { ...ctx.window.DiceEngine, present() {} };
vm.runInContext(fs.readFileSync('static/class-rules.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/character-builder.js', 'utf8'), ctx);
const B = ctx.window.CharacterBuilder;
const entry = (category, name, data) => ({ id: name, category, name, source: 'Test pack', data });
const draft = () => ({ name: ' Герой ', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: {
  race: entry('race', 'Дварф', { asi: { con: 2 }, speed: 25, traits: [{ name: 'Зрение', text: '60 фт.' }] }),
  class: entry('class', 'Воин', { hit_die: 'd10', saves: ['str', 'con'], features: { 1: ['Стиль боя'], 2: ['Всплеск'] } }),
  background: entry('background', 'Послушник', { skills: ['Религия'] })
}, spells: [entry('spell', 'Свет', { level: 0 })], method: 'standard' });
test('2024 creation grants Common and requires the two additional standard language choices on the sheet', () => {
  const records = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8'));
  const dwarf = records.find(e => e.category === 'race' && e.name === 'Дварф');
  const acolyte = records.find(e => e.category === 'background' && e.name === 'Прислужник');
  const cleric = records.find(e => e.category === 'class' && e.name === 'Жрец');
  const d = { name: 'Языковой тест', edition: '2024', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: dwarf, class: cleric, background: acolyte }, languages: ['Драконий', 'Эльфийский'], spells: [], method: 'standard' };
  const sheet = B.build(d);
  assert.match(sheet.proficiencies, /Языки: Общий, Драконий, Эльфийский/);
  assert.equal(sheet.hp.max, 9, '2024 dwarven toughness adds 1 hit point at level 1');
  assert.deepEqual(Array.from(B.LANGUAGES_2024_STANDARD), ['Общий жестовый язык', 'Дварфийский', 'Эльфийский', 'Великаний', 'Гномий', 'Гоблинский', 'Полуросличий', 'Орочий', 'Драконий']);
});

test('origin selections project into starting proficiencies and 2024 lineage spells', () => {
  const records14 = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
  const halfElf = records14.find(e => e.category === 'race' && e.name === 'Полуэльф');
  const halfElfSheet = B.build({ name: 'Полуэльф', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: halfElf },
    ruleChoices: { raceSkills: ['stealth', 'athletics'] }, spells: [], method: 'standard' });
  assert.ok(halfElfSheet.skills.includes('stealth') && halfElfSheet.skills.includes('athletics'));

  const records24 = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8'));
  const woodElf = records24.find(e => e.category === 'race' && e.name === 'Эльфийская линия: лесной эльф');
  const lineageCatalog = records24.filter(e => e.category === 'spell' || (e.category === 'race' && (e.name === 'Эльф' || e.id === woodElf.id)));
  const elfSheet = B.build({ name: 'Эльф', edition: '2024', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: woodElf },
    ruleChoices: { raceSkills: ['stealth'], raceSpellAbility: 'wis' }, spells: [], catalog: lineageCatalog, method: 'standard' });
  assert.equal(elfSheet.speed, 35);
  assert.ok(elfSheet.skills.includes('stealth'));
  assert.ok(elfSheet.spells.known.some(s => s.name === 'Искусство друидов' && s.spell_ability === 'wis'));
});

test('2014 dwarf/elf weapon proficiencies and tiefling cantrip, plus exact 2024 lineage cantrips', () => {
  const records14 = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
  const dwarf = records14.find(e => e.category === 'race' && e.name === 'Дварф');
  const elf = records14.find(e => e.category === 'race' && e.name === 'Эльф');
  const tiefling = records14.find(e => e.category === 'race' && e.name === 'Тифлинг');
  const spells14 = records14.filter(e => e.category === 'spell');
  const dwarfSheet = B.build({ name: 'Дварф', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: dwarf }, catalog: records14, spells: [] });
  assert.match(dwarfSheet.proficiencies, /Боевой топор, Ручной топор, Лёгкий молот, Боевой молот/);
  const elfSheet = B.build({ name: 'Эльф', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: elf }, catalog: records14, spells: [] });
  assert.match(elfSheet.proficiencies, /Длинный меч, Короткий меч, Короткий лук, Длинный лук/);
  const tieflingSheet = B.build({ name: 'Тифлинг', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: tiefling }, catalog: spells14, spells: [] });
  assert.ok(tieflingSheet.spells.known.some(spell => spell.name === 'Чудотворство' && spell.spell_ability === 'cha'));

  const records24 = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8'));
  const drow = records24.find(e => e.category === 'race' && /дроу/i.test(e.name));
  const abyssal = records24.find(e => e.category === 'race' && /наследие исчадий: бездна/i.test(e.name));
  const drowSheet = B.build({ name: 'Дроу', edition: '2024', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: drow }, catalog: records24,
    ruleChoices: { raceSpellAbility: 'wis' }, spells: [] });
  assert.ok(drowSheet.spells.known.some(spell => spell.name === 'Пляшущие огоньки' && spell.spell_ability === 'wis'));
  const abyssalSheet = B.build({ name: 'Тифлинг', edition: '2024', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { race: abyssal }, catalog: records24,
    ruleChoices: { raceSpellAbility: 'wis' }, spells: [] });
  assert.ok(abyssalSheet.spells.known.some(spell => spell.name === 'Чудотворство' && spell.spell_ability === 'wis'));
  assert.ok(abyssalSheet.spells.known.some(spell => spell.name === 'Ядовитые брызги' && spell.spell_ability === 'wis'));
  assert.ok(abyssalSheet.spells.known.every(spell => spell.level === 0), 'later-level lineage spells are not added at character level 1');
});

test('2014 fighter receives only the one selected Fighting Style, never every style', () => {
  const records = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
  const fighter = records.find(e => e.category === 'class' && e.name === 'Воин');
  const d = { name: 'Воин', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { class: fighter }, ruleChoices: { fightingStyle: 'Боевой стиль: Оборона' }, spells: [], method: 'standard' };
  const styles = Array.from(B.build(d).features.filter(f => /Боевой стиль/.test(f.name)), f => f.name);
  assert.deepEqual(styles, ['Боевой стиль: Оборона']);
});

test('wizard creation separates the six-spell book from the prepared spell list', () => {
  const records = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
  const wizard = records.find(e => e.category === 'class' && e.name === 'Волшебник');
  const book = records.filter(e => e.category === 'spell' && Number(e.data.level) === 1 && e.data.classes?.includes('Волшебник')).slice(0, 6);
  assert.equal(book.length, 6);
  const wizardNoGear = { ...wizard, data: { ...wizard.data, starting_equipment: '' } };
  const d = { name: 'Волшебник', edition: '2014', abilities: { str: 8, dex: 10, con: 10, int: 16, wis: 10, cha: 10 }, selected: { class: wizardNoGear },
    spells: book, preparedSpells: book.slice(0, 4).map(e => e.name), catalog: records, method: 'standard' };
  const sheet = B.build(d);
  assert.equal(B.spellLimits(wizard, '2014', d.abilities).preparedCount, 4);
  assert.equal(sheet.spells.known.filter(s => s.prepared).length, 4);
  assert.equal(sheet.spells.known.length, 6);
});

test('bard tool proficiencies require and project three different instruments in either edition', () => {
  for (const edition of ['2014', '2024']) {
    const records = JSON.parse(fs.readFileSync(`data_seed/srd_${edition}.json`, 'utf8'));
    const bard = records.find(e => e.category === 'class' && e.name === 'Бард');
    const instruments = records.filter(e => e.category === 'item' && e.data?.category === 'Музыкальные инструменты').slice(0, 3).map(e => e.name);
    assert.equal(instruments.length, 3, `${edition} SRD includes the Bard instrument choices`);
    const sheet = B.build({ name: 'Бард', edition, abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { class: bard },
      ruleChoices: { bardInstruments: instruments }, catalog: records, spells: [] });
    assert.ok(sheet.proficiencies.includes(`Музыкальные инструменты: ${instruments.join(', ')}`));
  }
});

test('class creation applies order bonuses, selected expertise and always-prepared class spells', () => {
  const records24 = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8'));
  const druid = records24.find(e => e.category === 'class' && e.name === 'Друид');
  const speakWithAnimals = records24.find(e => e.category === 'spell' && e.name === 'Разговор с животными');
  const d = { name: 'Друид', edition: '2024', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { class: druid },
    ruleChoices: { druidOrder: 'magician' }, spells: [], catalog: records24, method: 'standard' };
  const sheet = B.build(d);
  assert.equal(B.spellLimits(druid, '2024', d.abilities, d.ruleChoices).cantrips, 3);
  assert.ok(sheet.proficiencies.includes('Друидический'));
  assert.ok(sheet.spells.known.some(s => s.name === speakWithAnimals.name && s.prepared), 'Speak with Animals is always prepared at level 1');

  const records14 = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
  const rogue = records14.find(e => e.category === 'class' && e.name === 'Плут');
  const rogueSheet = B.build({ name: 'Плут', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])), selected: { class: rogue },
    skills: ['stealth', 'athletics'], ruleChoices: { expertise: ['stealth', 'thieves_tools'] }, spells: [], method: 'standard' });
  assert.deepEqual(Array.from(rogueSheet.expertise), ['stealth', 'thieves_tools']);
  assert.match(rogueSheet.proficiencies, /Воровские инструменты/);
  assert.match(rogueSheet.proficiencies, /Воровской жаргон/);
});

test('every SRD class offers its complete, correctly sized skill-choice pool in both editions', () => {
  const expected = { barbarian: 2, bard: 3, cleric: 2, druid: 2, fighter: 2, monk: 2, paladin: 2, ranger: 3, rogue: 4, sorcerer: 2, warlock: 2, wizard: 2 };
  for (const edition of ['2014', '2024']) {
    const records = JSON.parse(fs.readFileSync(`data_seed/srd_${edition}.json`, 'utf8')).filter(e => e.category === 'class');
    assert.equal(records.length, 12);
    for (const klass of records) {
      const state = B.skillsState({ edition, selected: { class: klass }, skills: [], freeSkills: [] });
      const slug = klass.data.name_en.toLowerCase();
      assert.equal(klass.data.skills.choose, expected[slug], `${edition} ${klass.name} skill-choice count`);
      assert.equal(state.klass.choose, expected[slug], `${edition} ${klass.name} UI choice count`);
      assert.equal(state.klass.options.length, klass.data.skills.from.length, `${edition} ${klass.name} option pool size`);
      assert.ok(state.klass.options.every(option => ctx.SKILLS.some(skill => skill[0] === option.key)), `${edition} ${klass.name} options map to known skills`);
      assert.equal(new Set(state.klass.options.map(option => option.key)).size, state.klass.options.length, `${edition} ${klass.name} options are distinct`);
    }
  }
});

test('point buy uses the D&D 27-point cost table and requires spending the exact budget', () => {
  const legal = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
  assert.equal(B.pointBuyTotal(legal), 27);
  assert.equal(B.pointBuyValid(legal), true);
  assert.equal(B.pointBuyTotal({ str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }), 0);
  assert.equal(B.pointBuyValid({ str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }), false, 'unused points are not a valid point-buy array');
  assert.ok(B.pointBuyTotal({ str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 }) > 27);
  assert.equal(B.pointBuyValid({ str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 }), false);
});
test('creation initializes class-specific level-one spell limits and spell slots', () => {
  const bard = entry('class', 'Бард', { name_en: 'bard', hit_die: 'd8', spellcasting: 'cha' });
  const bardRule = B.spellLimits(bard, '2014', { cha: 14 });
  assert.deepEqual(JSON.parse(JSON.stringify(bardRule)), { cantrips: 2, spells: 4, mode: 'known', preparedCount: null, slots: { 1: { max: 2, used: 0 } }, maxLevel: 1 });
  const warlock = entry('class', 'Колдун', { name_en: 'warlock', hit_die: 'd8', spellcasting: 'cha' });
  assert.equal(B.spellLimits(warlock, '2014', { cha: 14 }).slots[1].max, 1, 'pact slots exist at level one');
  const wizard = entry('class', 'Волшебник', { name_en: 'wizard', hit_die: 'd6', spellcasting: 'int' });
  assert.equal(B.spellLimits(wizard, '2024', { int: 16 }).spells, 6, 'wizard starts with six spells in the spellbook');
  const d = draft(); d.selected.class = bard;
  d.spells = [entry('spell', 'Огненный снаряд', { level: 0 }), entry('spell', 'Лечащее слово', { level: 1 })];
  const s = B.build(d);
  assert.equal(s.spells.slots[1].max, 2);
  assert.ok(s.spells.known.every(x => x.prepared), 'known spells are usable without a preparation step');
});
test('spell limits resolve from every SRD class table in both editions', () => {
  for (const edition of ['2014', '2024']) {
    const records = JSON.parse(fs.readFileSync(`data_seed/srd_${edition}.json`, 'utf8')).filter(e => e.category === 'class');
    assert.equal(records.length, 12);
    for (const klass of records) {
      const limits = B.spellLimits(klass, edition, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
      assert.ok(limits, `${edition} ${klass.name} has level-one progression`);
      assert.ok(Number.isInteger(limits.cantrips) && Number.isInteger(limits.spells));
      assert.ok(Object.values(limits.slots).every(slot => slot.max > 0 && slot.used === 0));
    }
  }
});
test('4d6 drops exactly one minimum, totals stay within 3..18', () => {
  for (const r of B.rollStats(() => 0)) { assert.equal(r.total, 3); assert.equal(r.dropped, 3); }
  for (const r of B.rollStats(() => .999)) assert.equal(r.total, 18);
  for (const r of B.rollStats()) assert.equal(r.total, r.dice.reduce((a,b) => a+b,0) - Math.min(...r.dice));
});
test('6d20 rolls six independent d20 results, each usable as an ability score from 1 to 20', () => {
  const low = B.rollD20Stats(() => 0), high = B.rollD20Stats(() => .999);
  assert.equal(low.length, 6); assert.equal(high.length, 6);
  for (const result of low) { assert.deepEqual(Array.from(result.dice), [1]); assert.equal(result.total, 1); assert.equal(result.dropped, -1); }
  for (const result of high) { assert.deepEqual(Array.from(result.dice), [20]); assert.equal(result.total, 20); }
});
test('build applies modules and derives first-level values without mutating draft', () => {
  const d = draft(), before = JSON.stringify(d), s = B.build(d);
  assert.equal(s.name, 'Герой'); assert.equal(s.abilities.con, 12); assert.equal(s.hp.max, 11);
  assert.equal(s.speed, 25); assert.equal(s.ac, 10); assert.equal(s.features.length, 2);
  assert.equal(s.spells.known.length, 1); assert.equal(s.skills[0], 'religion');
  assert.equal(JSON.stringify(d), before); assert.equal(JSON.stringify(B.build(d)), JSON.stringify(s));
  s.modules[0].snapshot.data.asi.con = 99; assert.equal(d.selected.race.data.asi.con, 2);
});
test('creation keeps alignment, roleplay details, languages and forgotten tool proficiencies', () => {
  const d = draft();
  d.alignment = 'Нейтрально-доброе';
  d.traits = { player_name: 'Игрок', faith: 'Селунэ', age: '120 лет', personality: 'Любит задавать вопросы.', ideals: 'Свобода.', bonds: 'Старый компас.', flaws: 'Слишком доверчив.', appearance: 'Шрам на щеке.', backstory: 'Покинул родной город.' };
  d.languages = ['Эльфийский', 'Гномий'];
  d.selected.class.data.tools = ['Набор игрового кубика'];
  d.selected.background.data.tools = ['Набор травника'];
  d.selected.background.data.languages = 2;
  const s = B.build(d);
  assert.equal(s.alignment, 'Нейтрально-доброе');
  assert.equal(s.traits.personality, 'Любит задавать вопросы.');
  assert.equal(s.traits.appearance, 'Шрам на щеке.');
  assert.equal(s.traits.player_name, 'Игрок');
  assert.equal(s.traits.faith, 'Селунэ');
  assert.equal(s.traits.age, '120 лет');
  assert.match(s.proficiencies, /Набор игрового кубика/);
  assert.match(s.proficiencies, /Набор травника/);
  assert.match(s.proficiencies, /Эльфийский, Гномий/);
  assert.ok(s.proficiencies.includes('\n'), 'proficiency groups should be separated by real line breaks');
  assert.equal(B.ALIGNMENTS.length, 11);
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
  B.register('custom-test', (s, e) => s.notes += e.name);
  const d = draft(); d.spells = [entry('custom-test', 'Модуль', {})]; assert.equal(B.build(d).notes, 'Модуль');
});
test('dragon sorcerer chooses exactly one ancestry feature at character creation', () => {
  const records = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
  const sorcerer = records.find(e => e.category === 'class' && e.name === 'Чародей');
  const raw = sorcerer.data.subclasses.find(sub => /родослов/i.test(sub.name));
  const module = B.subclassModule(sorcerer, raw), variants = raw.features['1'].filter(name => name.startsWith('Предок-дракон:'));
  const chosen = variants.find(name => /Зелёный/i.test(name));
  const d = draft(); d.selected.class = sorcerer; d.selected.subclass = module; d.catalog = records;
  d.ruleChoices = { subclassVariants: { 'Предок-дракон': chosen } };
  const sheet = B.build(d);
  assert.ok(sheet.features.some(feature => feature.name === chosen));
  assert.equal(sheet.features.some(feature => variants.some(name => name !== chosen && feature.name === name)), false);
  assert.equal(sheet.classes[0].subclass_choices['Предок-дракон'], chosen);
});
test('first-level subclass is projected as its own compendium module and stored for level-up', () => {
  const klass = entry('class', 'Жрец', { hit_die: 'd8', saves: ['wis', 'cha'], features: { 1: ['Божественный домен'] },
    subclasses: [{ name: 'Домен жизни', desc: 'Исцеляющий домен.', features: { 1: ['Ученик жизни'] }, feature_texts: { 'Ученик жизни': 'Усиленное лечение.' } }] });
  const d = draft(); d.selected.class = klass; d.selected.subclass = B.subclassModule(klass, klass.data.subclasses[0]);
  assert.equal(B.subclassLevel(klass), 1);
  const s = B.build(d);
  assert.equal(s.subclass, 'Домен жизни');
  assert.equal(s.classes[0].subclass, 'Домен жизни');
  assert.equal(s.classes[0].level, 1);
  assert.ok(s.features.some(f => f.name === 'Ученик жизни' && f.source === 'Домен жизни'));
  assert.ok(s.modules.some(m => m.category === 'subclass' && m.snapshot.data.parent_class === 'Жрец'));
});
test('2024 background feat resolves to the compendium module instead of a placeholder', () => {
  const background = entry('background', 'Преступник', { feat: 'Бдительный' });
  const feat = entry('feat', 'Бдительный', { desc: 'Бонус к инициативе.', mechanics: { version: 1, programs: [] } });
  const module = B.backgroundFeatModule(background, [feat]);
  assert.equal(module.category, 'feat');
  assert.equal(module.data.parent_background, 'Преступник');
  const d = draft(); d.selected.background = background; d.selected.feat = module; d.catalog = [feat];
  const s = B.build(d);
  const applied = s.features.filter(f => f.name === 'Бдительный');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].text, 'Бонус к инициативе.');
  assert.ok(s.modules.some(m => m.category === 'feat' && m.snapshot.data.parent_background === 'Преступник'));
});
test('Magic Initiate grants its selected cantrips and first-level spell with the feat ability', () => {
  const feat = entry('feat', 'Посвящённый в магию', { desc: 'Заклинания черты.' });
  const cantripOne = entry('spell', 'Огненный снаряд', { level: 0, classes: ['Волшебник'] });
  const cantripTwo = entry('spell', 'Свет', { level: 0, classes: ['Волшебник'] });
  const firstLevel = entry('spell', 'Щит', { level: 1, classes: ['Волшебник'] });
  const d = draft(); d.spells = []; d.selected.feat = feat; d.catalog = [cantripOne, cantripTwo, firstLevel];
  d.ruleChoices = { magicInitiate: { list: 'wizard', ability: 'int', cantrips: [cantripOne.id, cantripTwo.id], firstLevel: firstLevel.id } };
  const sheet = B.build(d);
  assert.deepEqual(Array.from(sheet.spells.known, spell => [spell.name, spell.level, spell.prepared, spell.spell_ability]), [
    ['Огненный снаряд', 0, true, 'int'], ['Свет', 0, true, 'int'], ['Щит', 1, true, 'int']
  ]);
  assert.equal(sheet.spells.slots[1]?.max || 0, 0, 'feat spells are granted independently of class spell slots');
  assert.ok(sheet.creation.rule_choices.magicInitiate);

  const human = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8')).find(e => e.category === 'race' && e.name === 'Человек');
  const unrelatedFeat = entry('feat', 'Бдительный', { desc: 'Умение.' });
  const humanD = { ...d, edition: '2024', selected: { race: human, feat: unrelatedFeat }, catalog: [human, feat, cantripOne, cantripTwo, firstLevel],
    ruleChoices: { humanOriginFeat: feat.id, magicInitiate: d.ruleChoices.magicInitiate } };
  const humanSheet = B.build(humanD);
  assert.ok(humanSheet.features.some(feature => feature.name === feat.name), 'human origin feat is stored as a feat module');
  assert.ok(humanSheet.spells.known.some(spell => spell.name === 'Щит' && spell.spell_ability === 'int'), 'Magic Initiate choices work when selected as the human bonus feat');
});

test('subclass is not a creation-time choice when its first feature is at a later level', () => {
  const klass = entry('class', 'Воин', { subclasses: [{ name: 'Чемпион', features: { 3: ['Критический удар'] } }] });
  assert.equal(B.subclassLevel(klass), 3);
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

test('правило взаимозамены: навык из двух источников заменяется любым другим', () => {
  const d = draft();
  d.selected.class.data.skills = { choose: 2, from: ['Религия', 'Скрытность', 'Атлетика'] };
  d.selected.background.data.skills = ['Религия'];               // Религия уже есть от предыстории
  const st = B.skillsState(d);
  assert.equal(st.klass.choose, 2);
  assert.equal(st.klass.overlap.length, 1, 'Религия приходит и от класса, и от предыстории');
  assert.equal(st.free.need, 1, 'вместо совпавшего навыка — любое другое владение');
  assert.equal(st.free.options.some(o => o.key === 'religion'), false, 'уже известный навык в заменах не предлагается');
  d.skills = ['Скрытность', 'Атлетика'];
  d.freeSkills = ['religion'];
  assert.equal(B.build(d).skills.filter(k => k === 'religion').length, 1, 'навык не удваивается');
});

test('взаимозамена не появляется, когда пересечений нет', () => {
  const d = draft();
  d.selected.class.data.skills = { choose: 1, from: ['Скрытность', 'Атлетика'] };
  d.selected.background.data.skills = ['Религия'];
  const st = B.skillsState(d);
  assert.equal(st.free, null);
  assert.equal(st.klass.overlap.length, 0);
});

test('замены фильтруются: занятые и чужие навыки в зачёт не идут', () => {
  const d = draft();
  d.selected.class.data.skills = { choose: 1, from: ['Религия', 'Скрытность'] };
  d.selected.background.data.skills = ['Религия'];
  d.skills = ['Скрытность'];
  d.freeSkills = ['Скрытность', 'religion', 'НетТакого'];
  const st = B.skillsState(d);
  assert.deepEqual(JSON.parse(JSON.stringify(st.free.picked)), [], 'Скрытность выбрана классом, Религия занята предысторией, остального нет в списке');
});

test('навыки из замен попадают на лист один раз', () => {
  const d = draft();
  d.selected.class.data.skills = { choose: 1, from: ['Религия', 'Скрытность', 'Атлетика'] };
  d.selected.background.data.skills = ['Религия'];
  d.skills = ['stealth'];
  d.freeSkills = ['athletics'];                                   // замена за совпавшую Религию
  const s = B.build(d);
  assert.deepEqual([...s.skills].sort(), ['athletics', 'religion', 'stealth']);
});
