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
});

test('a class record with its own caster block overrides the SRD table', async () => {
  await ready;
  const homebrew = { name: 'Ведьмак', data: { name_en: 'Witcher', caster: { level: 'half', picker: true, start: { '2014': 'prepared' }, prepared: { '2014': 'level' } } } };
  assert.equal(R.casterLevel(homebrew), 'half');
  assert.equal(R.isPicker(homebrew), true);
  assert.equal(R.startMode(homebrew, '2014'), 'prepared');
  assert.equal(R.preparedFormula(homebrew, '2014'), 'level');
});

test('slug uses the English name first, then the Russian name table', async () => {
  await ready;
  assert.equal(R.slugOf({ name: 'Жрец', data: { name_en: 'Cleric' } }), 'cleric');
  assert.equal(R.slugOf({ name: 'Жрец', data: {} }), 'cleric');
  assert.equal(R.slugOf({ name: 'Неизвестный', data: {} }), '');
});
