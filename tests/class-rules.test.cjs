const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/class-rules.js', 'utf8'), ctx);
const R = ctx.window.ClassRules;
const ready = require('../tools/presets/node-loader.cjs').loadPresets(ctx).then(() => R.refresh());
const srd = (name, extra = {}) => ({ name, data: { name_en: name, ...extra } });
const ids = list => list.filter(Boolean).sort();

test('SRD fallback reproduces the former slug lists', async () => {
  await ready;
  const all = Object.values(R.RU_NAMES);
  assert.deepEqual(ids(all.filter(s => R.isPicker(srd(s)))), ids(['bard', 'sorcerer', 'warlock', 'ranger']));
  assert.deepEqual(ids(all.filter(s => R.casterLevel(srd(s)) === 'full')), ids(['bard', 'cleric', 'druid', 'sorcerer', 'wizard']));
  assert.deepEqual(ids(all.filter(s => R.casterLevel(srd(s)) === 'half')), ids(['paladin', 'ranger']));
  assert.deepEqual(ids(all.filter(s => R.startMode(srd(s), '2014') === 'prepared')), ids(['cleric', 'druid']));
  assert.deepEqual(ids(all.filter(s => R.startMode(srd(s), '2024') === 'prepared')), ids(['cleric', 'druid', 'paladin', 'ranger']));
  assert.equal(R.startMode(srd('wizard'), '2014'), 'book');
  assert.equal(R.preparedFormula(srd('paladin'), '2014'), 'half');
  assert.equal(R.preparedFormula(srd('paladin'), '2024'), '', 'the 2014 counting rule does not leak into 2024');
  // Подготовленные заклинания 1 уровня: SRD 5.1 — формула «уровень + модификатор», SRD 5.2.1 — фиксированное число.
  assert.equal(R.startPrepared(srd('Cleric'), '2014'), 'level');
  assert.equal(R.startPrepared(srd('Cleric'), '2024'), 4);
  assert.equal(R.startPrepared(srd('Druid'), '2024'), 4);
  assert.equal(R.startPrepared(srd('Paladin'), '2024'), 2);
  assert.equal(R.startPrepared(srd('Ranger'), '2024'), 2);
  assert.equal(R.startPrepared(srd('Wizard'), '2024'), 4);
  // Мастерство оружия в SRD 5.2.1 дают пять классов; у монаха его нет.
  assert.deepEqual(Object.values(R.RU_NAMES).filter(s => R.rulesOf(srd(s), '2024').weapon_mastery)
    .sort(), ['barbarian', 'fighter', 'paladin', 'ranger', 'rogue']);
});

test('a class record with its own caster block overrides the SRD table', async () => {
  await ready;
  const homebrew = { name: 'Ведьмак', data: { name_en: 'Witcher', caster: { level: 'half', picker: true, start: { '2014': 'prepared' }, prepared: { '2014': 'level' } } } };
  assert.equal(R.casterLevel(homebrew), 'half');
  assert.equal(R.isPicker(homebrew), true);
  assert.equal(R.startMode(homebrew, '2014'), 'prepared');
  assert.equal(R.preparedFormula(homebrew, '2014'), 'level');
});

test('черты-умения отличаются от черт для игрока', async () => {
  await ready;
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  // Все записи, собранные из рас и классов (data_seed/feats_*.json), — черты-умения: игроку их не выбирать.
  for (const edition of ['2014', '2024']) {
    const rows = read(`data_seed/feats_${edition}.json`);
    assert.ok(rows.length > 100, `${edition}: черты собраны`);
    const missed = rows.filter(e => !R.isFeatureRecord({ category: 'feat', data: e.data }))
      .map(e => `${e.slug} (${e.data.kind})`);
    assert.deepEqual(missed, [], `${edition}: каждая собранная черта — черта-умение`);
    const kinds = [...new Set(rows.map(e => e.data.kind))].sort();
    assert.deepEqual(kinds, ['class', 'race', 'subclass'], `${edition}: виды записей`);
  }
  // Черты для выбора игроком (наборы SRD) чертами-умениями не считаются — иначе человек 2024 не увидел бы
  // ни одной черты происхождения, а список черт на повышении уровня заполонили бы умения классов.
  for (const edition of ['2014', '2024']) {
    const feats = read(`data_seed/srd_${edition}.json`).filter(e => e.category === 'feat');
    assert.ok(feats.length > 0, `${edition}: черты игрока есть`);
    assert.deepEqual(feats.filter(R.isFeatureRecord).map(e => e.slug), [], `${edition}: черты игрока не черты-умения`);
  }
  // Прочие категории и пустые записи не задеты.
  assert.equal(R.isFeatureRecord({ category: 'race', data: { kind: 'race' } }), false);
  assert.equal(R.isFeatureRecord({ category: 'feat', data: {} }), false);
  assert.equal(R.isFeatureRecord(null), false);
});

test('slug uses the English name first, then the Russian name table', async () => {
  await ready;
  assert.equal(R.slugOf({ name: 'Жрец', data: { name_en: 'Cleric' } }), 'cleric');
  assert.equal(R.slugOf({ name: 'Жрец', data: {} }), 'cleric');
  assert.equal(R.slugOf({ name: 'Неизвестный', data: {} }), '');
});
