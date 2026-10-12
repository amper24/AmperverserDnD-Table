// Словари правил из наборов: состояния, школы магии, языки, типы врагов.
// Списки, которые читают модули при загрузке скриптов, обновляются после загрузки и импорта наборов.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto };
vm.createContext(ctx);
const ready = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => ready);
const P = () => ctx.window.Presets;
const plain = x => JSON.parse(JSON.stringify(x));

test('состояния: 16 записей с русским, английским и коротким названием и значком', () => {
  const items = plain(P().items('conditions'));
  assert.equal(items.length, 16);
  const poisoned = items.find(i => i.id === 'poisoned');
  assert.deepEqual(poisoned.table, { ru: 'Отравленный', en: 'Poisoned', short: 'Отравлен', icon: 'ОТ' });
  assert.equal(P().item('conditions', 'frightened').table.ru, 'Испуганный');
});

test('школы магии: восемь школ в порядке набора, у каждой цвет', () => {
  const schools = plain(P().items('spell_schools'));
  assert.equal(schools.length, 8);
  assert.equal(schools[0].table.ru, 'Воплощение');
  assert.ok(schools.every(s => /^#[0-9a-f]{6}$/i.test(s.table.color)), 'цвет в формате #rrggbb');
});

test('языки: 17 языков, стандартных для 2024 — девять', () => {
  assert.equal(P().items('languages').length, 17);
  assert.equal(P().items('languages').filter(l => l.table.standard_2024).length, 9);
});

test('типы врагов: четырнадцать, последний — гуманоиды', () => {
  const types = plain(P().items('enemy_types'));
  assert.equal(types.length, 14);
  assert.equal(types.at(-1).table.ru, 'Гуманоиды (две расы)');
});

test('liveList сохраняет ссылку и обновляется после импорта набора', () => {
  const list = P().liveList('enemy_types');
  assert.equal(list.length, 14);
  const before = list;
  P().importUser({ kind: 'enemy_types', id: 'test-enemies', name: 'Тест', items: [{ id: 'swamp', table: { ru: 'Болотные', en: 'Swamp' } }] });
  assert.equal(list, before, 'та же ссылка');
  assert.equal(list.length, 15, 'добавлен элемент пользовательского набора');
  assert.equal(list.at(-1), 'Болотные');
  P().removeUser('test-enemies');
  assert.equal(list.length, 14, 'после удаления набора список снова полный');
});

test('liveList с фильтром: языки для 2024', () => {
  const list = P().liveList('languages', i => i.table.ru, i => i.table.standard_2024);
  assert.equal(list.length, 9);
  assert.ok(list.includes('Драконий'));
  assert.ok(!list.includes('Общий'));
});

test('термины английского вида: состояния переводятся из набора conditions', () => {
  const src = fs.readFileSync('static/common.js', 'utf8');
  assert.ok(!/'Отравленный'\s*:/.test(src), 'в common.js нет словаря состояний');
  assert.ok(!/'Испуганный'\s*:/.test(src));
});
