// Связывание записей справочника с наборами и свои элементы наборов (presets-editor.js).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, localStorage: { getItem() { return null; }, setItem() {} } };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
vm.runInContext(fs.readFileSync('static/presets-editor.js', 'utf8'), ctx);
const PE = ctx.window.PresetsEditor;
const P = ctx.window.Presets;
const plain = x => JSON.parse(JSON.stringify(x));

test('запись находит правила набора по ключу: раса, класс, черта, состояние', () => {
  assert.equal(PE.findRule('race', { name_en: 'Dwarf' }, '2014').id, 'dwarf');
  assert.equal(PE.findRule('race', { name_en: 'dwarf' }, '2014').id, 'dwarf');
  assert.equal(PE.findRule('class', { name_en: 'barbarian' }, '2014').id, 'barbarian');
  assert.equal(PE.findRule('feat', { name_en: 'Grappler' }, '2014').id, 'grappler');
  assert.equal(PE.findRule('condition', { condition_key: 'blinded' }).id, 'blinded');
  assert.equal(PE.findRule('race', { name_en: 'Нет такой' }, '2014'), null);
  assert.equal(PE.findRule('race', {}, '2014'), null);
});

test('ключ из названия: латиница, дефисы, без лишнего', () => {
  assert.equal(PE.suggestKey('Ночной Эльф'), 'ночной-эльф');
  assert.equal(PE.suggestKey('  Dark  Elf!  '), 'dark-elf');
});

test('значения полей: JSON, если разбирается, иначе текст', () => {
  assert.equal(PE.parseValue('5'), 5);
  assert.deepEqual(plain(PE.parseValue('["str","dex"]')), ['str', 'dex']);
  assert.equal(PE.parseValue('true'), true);
  assert.equal(PE.parseValue('Просто текст'), 'Просто текст');
  assert.equal(PE.parseValue(''), '');
});

test('свой элемент сохраняется в пользовательский набор и перекрывает встроенный', () => {
  const before = P.itemsOfKind('race_rules', '2014').find(i => i.id === 'dwarf');
  assert.equal(before.source, 'встроенный');
  P.upsertUserItem('race_rules', { id: 'dwarf', table: { name_en: 'Dwarf', ru: 'Дварф (своя версия)', weapons: ['Кинжал'] } }, '2014');
  const after = P.itemsOfKind('race_rules', '2014').find(i => i.id === 'dwarf');
  assert.equal(after.source, 'ваш');
  assert.deepEqual(plain(after.table.weapons), ['Кинжал']);
  assert.equal(P.ownItemOf('race_rules', 'dwarf', '2014').table.ru, 'Дварф (своя версия)');
  P.removeUserItem('race_rules', 'dwarf', '2014');
  assert.equal(P.itemsOfKind('race_rules', '2014').find(i => i.id === 'dwarf').source, 'встроенный');
});

test('свой элемент с некорректной структурой не сохраняется', () => {
  assert.throws(() => P.upsertUserItem('feat_rules', { table: {} }, '2014'), /id/);
  assert.throws(() => P.upsertUserItem('no_such_kind', { id: 'x', table: {} }, '2014'), /неизвестный/);
  assert.throws(() => P.upsertUserItem('class_rules', { id: 'homebrew', table: {} }, '2030'), /редакцию/);
});

test('свой элемент состояния появляется в словаре', () => {
  P.upsertUserItem('conditions', { id: 'stunned-x', table: { ru: 'Оглушён (свой)', en: 'Stunned' } }, '');
  assert.equal(PE.findRule('condition', { condition_key: 'stunned-x' }).table.ru, 'Оглушён (свой)');
  P.removeUserItem('conditions', 'stunned-x', '');
});

// Smoke-тест интерфейса: минимальная заглушка DOM, без браузера. Проверяет, что блоки строятся на реальных наборах.
function stubEl(tag, attrs = {}, ...kids) {
  const node = { tag, attrs, children: [], value: attrs.value ?? '', listeners: {} };
  const add = list => { for (const k of list.flat()) if (k !== null && k !== undefined) node.children.push(k); };
  node.append = (...k) => add(k);
  node.replaceChildren = (...k) => { node.children = []; add(k); };
  node.addEventListener = (ev, fn) => { node.listeners[ev] = fn; };
  node.remove = () => {};
  add(kids);
  return node;
}
ctx.window.el = stubEl;
ctx.window.toast = () => {};
ctx.window.modal = () => Promise.resolve(null);
test('интерфейс: блок связи для расы, класса, черты и состояния строится на реальных наборах', () => {
  for (const category of ['race', 'class', 'feat', 'condition']) {
    const block = PE.linkPicker(category, { name_en: category === 'condition' ? 'blinded' : 'Dwarf', condition_key: 'blinded' }, { getName: () => 'Тест' });
    assert.ok(block, category);
    assert.ok(block.children.length >= 3, category);
  }
  assert.equal(PE.linkPicker('item', {}), null);
});
test('интерфейс: панель элементов и редактор элемента строятся без ошибок', () => {
  const panel = PE.elementsPanel('race_rules');
  assert.ok(panel.children.length >= 3);
  assert.ok(PE.editElement('race_rules', null, { key: 'elf-x' }));
});
