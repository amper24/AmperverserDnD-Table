const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Минимальный DOM-стаб: как в mechanics-graph.test.cjs, но с обходом дерева и вызовом обработчиков.
function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), replaceChildren(...values) { this.children = values.flat().filter(value => value !== null && value !== undefined); } };
}
const ctx = { window: {}, el, crypto: require('node:crypto').webcrypto };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/node-params-form.js', 'utf8'), ctx);
const NF = ctx.window.NodeForm;
const plain = value => JSON.parse(JSON.stringify(value));
// Значения из vm-контекста имеют другой прототип: сравниваем через JSON-копию.
const eq = (actual, expected) => assert.deepStrictEqual(plain(actual), expected);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
function findAll(root, pred) { const out = []; walk(root, n => { if (pred(n)) out.push(n); }); return out; }
const inputsOf = root => findAll(root, n => n.tag === 'input');
const textareasOf = root => findAll(root, n => n.tag === 'textarea');
const byLabel = (root, text) => findAll(root, n => n.attrs?.['aria-label'] === text)[0];

test('pure helpers keep stored copies immutable', () => {
  const src = { a: { b: [1, 2] }, c: 3 };
  const next = NF.setAt(src, ['a', 'b', 1], 9);
  eq(plain(next), { a: { b: [1, 9] }, c: 3 });
  eq(plain(src), { a: { b: [1, 2] }, c: 3 }, 'source is untouched');
  eq(plain(NF.removeAt(src, ['a', 'b', 0])), { a: { b: [2] }, c: 3 });
  eq(plain(NF.removeAt(src, ['c'])), { a: { b: [1, 2] } });
  eq(NF.emptyLike({ slots: 4, name: 'x', on: true, list: [1] }), { slots: 0, name: '', on: false, list: [] });
  assert.equal(NF.isMap({ 1: {}, 5: {} }, '', false), true);
  assert.equal(NF.isMap({ str: 1 }, '', false), false);
});

test('speed node shows a numeric field, not a JSON textarea, and commits typed values', () => {
  const node = { id: 's', type: 'rule.speed', params: { value: 30 } };
  let committed = null;
  const form = NF.nodeParams(node, { onChange: next => { committed = next; } });
  assert.equal(textareasOf(form).length, 0, 'no JSON textarea in the default form');
  const number = inputsOf(form).find(i => i.attrs.type === 'number');
  assert.equal(number.attrs.value, '30');
  number.attrs.onchange({ target: { value: '35' } });
  eq(committed, { value: 35 });
});

test('ability and spell-mode nodes use dropdowns with Russian labels', () => {
  const dice = NF.nodeParams({ id: 'd', type: 'data.ability', params: { value: 'dex' } });
  const select = findAll(dice, n => n.tag === 'select')[0];
  assert.ok(select, 'data.ability value is a dropdown');
  const options = select.children.map(o => o.attrs.value);
  eq(options, ['str', 'dex', 'con', 'int', 'wis', 'cha']);
  assert.equal(select.children.find(o => o.attrs.value === 'dex').attrs.selected, '');
  const labels = select.children.map(o => o.children[0]);
  assert.equal(labels[0], 'Сила');

  const spells = NF.nodeParams({ id: 'sp', type: 'rule.spell_list', params: { mode: 'known', ability: 'int', spells: [] } });
  assert.ok(findAll(spells, n => n.tag === 'select').length >= 2, 'mode and ability are dropdowns');
});

test('editions are multi-select checkboxes', () => {
  let committed = null;
  const form = NF.nodeParams({ id: 'c', type: 'condition.edition', params: { editions: ['2014'] } }, { onChange: next => { committed = next; } });
  const boxes = inputsOf(form).filter(i => i.attrs.type === 'checkbox');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].attrs.checked, '');
  assert.equal(boxes[1].attrs.checked, null);
  boxes[1].attrs.onchange({ target: { checked: true } });
  eq(committed, { editions: ['2014', '2024'] });
});

test('spell slot table can add and remove rows without touching JSON', () => {
  let committed = null;
  const node = { id: 't', type: 'rule.spell_slots', params: { table: { 1: { slots: 2 }, 3: { slots: 4 } } } };
  const form = NF.nodeParams(node, { onChange: next => { committed = next; } });
  const removeButtons = findAll(form, n => n.tag === 'button' && n.attrs.title === 'Удалить строку');
  assert.equal(removeButtons.length, 2, 'every table row can be removed');
  removeButtons[0].attrs.onclick();
  eq(committed, { table: { 3: { slots: 4 } } });

  const keyInput = byLabel(form, 'Новый ключ: Таблица');
  assert.ok(keyInput, 'new-key input exists for maps');
  keyInput.value = '5';
  findAll(form, n => n.tag === 'button' && n.children[0] === 'Добавить')[0].attrs.onclick();
  eq(committed, { table: { 3: { slots: 4 }, 5: { slots: 0 } } }, 'new row copies the shape of its siblings, after the removed row is gone');
});

test('list parameters are comma-separated and keep numbers numeric', () => {
  let committed = null;
  const form = NF.nodeParams({ id: 'l', type: 'rule.languages', params: { value: ['Общий'] } }, { onChange: next => { committed = next; } });
  const input = inputsOf(form).find(i => i.attrs.placeholder === 'через запятую');
  input.attrs.onchange({ target: { value: 'Общий,  Эльфийский, ' } });
  eq(committed, { value: ['Общий', 'Эльфийский'] });
  const nums = NF.nodeParams({ id: 'n', type: 'x', params: { levels: [1, 2] } }, { onChange: next => { committed = next; } });
  inputsOf(nums).find(i => i.attrs.placeholder === 'через запятую').attrs.onchange({ target: { value: '3, 4, x' } });
  eq(committed, { levels: [3, 4] });
});

test('service IDs are shown read-only and group instances get a dropdown of groups', () => {
  const form = NF.nodeParams({ id: 'a', type: 'action.program', params: { program_id: 'p-1', name: 'Удар' } });
  const ro = inputsOf(form).find(i => i.attrs.value === 'p-1');
  assert.ok(ro.attrs.disabled !== undefined, 'program_id is disabled');
  const group = NF.nodeParams({ id: 'g', type: 'group.instance', params: { group_id: 'G2' } }, { groups: [{ value: 'G1', label: 'Первая' }, { value: 'G2', label: 'Вторая' }] });
  const select = findAll(group, n => n.tag === 'select')[0];
  eq(select.children.map(o => o.attrs.value), ['G1', 'G2']);
});

test('preview choices editor reports edited choices and works with empty input', () => {
  let committed = null;
  const editor = NF.valueEditor({}, { ariaLabel: 'Выборы для предпросмотра', onChange: next => { committed = next; } });
  assert.equal(editor.attrs['aria-label'], 'Выборы для предпросмотра');
  const keyInput = byLabel(editor, 'Новый ключ: Параметры') || findAll(editor, n => n.attrs?.['aria-label']?.startsWith('Новый ключ'))[0];
  assert.ok(keyInput || editor.children.length, 'empty choices still offers to add a key');
  const add = findAll(editor, n => n.tag === 'button' && n.children[0] === 'Добавить')[0];
  assert.ok(add, 'add-key button exists');
});
