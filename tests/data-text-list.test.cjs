// Строки и списки в палитре v3: data.text / data.textlen / data.textcheck / data.list /
// data.listget / data.listlen / data.listjoin. Проверяются формы, проверка параметров, чистое
// вычисление и попадание значений в план (предпросмотр), в том числе условие блока (condition_src).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat().filter(value => value !== null && value !== undefined); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = { window: { addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {} }, requestAnimationFrame() {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } }, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' }, SKILLS: [] };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const R = ctx.window.NodeRegistry;
const NF = ctx.window.NodeForm;
const plain = value => JSON.parse(JSON.stringify(value));
const TYPES = ['data.text', 'data.textlen', 'data.textcheck', 'data.list', 'data.listget', 'data.listlen', 'data.listjoin'];

const node = (id, type, params = {}) => ({ id, type, params: { ...plain(R.NODE_DEFS[type]?.defaults || {}), ...params } });
const link = (fromNode, fromSocket, toNode, toSocket) => ({ from: { node: fromNode, socket: fromSocket }, to: { node: toNode, socket: toSocket } });
// Граф с «Началом» и достроенным «Концом», как его собирает редактор.
function mech(nodes, links = []) {
  const graph = { nodes: [{ id: 'start', type: 'action.program', params: { program_id: 'p', name: 'Тест', trigger: 'use' } }, ...nodes], links, frames: [], groups: [] };
  M.addFlowEnds(graph);
  return { version: 2, graph };
}
const blocksOf = mechanics => plain(M.toLegacy(mechanics).programs[0].blocks);
const computeOf = (type, params, inputs = {}) => R.NODE_DEFS[type].compute(params, socket => inputs[socket]);

test('семь новых типов зарегистрированы, вычисляются и имеют порты text/list', () => {
  for (const type of TYPES) {
    const def = R.NODE_DEFS[type];
    assert.ok(def, `${type}: узел зарегистрирован`);
    assert.equal(def.group, 'Данные');
    assert.equal(R.categoryOf(type).id, 'data');
    assert.ok(R.COMPUTED.has(type), `${type}: узел вычисляется в предпросмотре`);
    assert.match(def.description, /^[^\n]{8,120}$/, `${type}: короткое описание одной строкой`);
    assert.equal(def.validate(plain(def.defaults || {})), '', `${type}: умолчания допустимы`);
  }
  assert.deepEqual(plain(R.TEXT_OPS), ['concat', 'upper', 'lower', 'trim']);
  assert.deepEqual(plain(R.TEXT_CHECK_OPS), ['contains', 'starts', 'ends', 'eq', 'ne']);
  assert.ok(R.VALUE_TYPES.includes('text') && R.VALUE_TYPES.includes('list'), 'сокеты text/list объявлены');
  assert.deepEqual(plain(R.NODE_DEFS['data.text'].inputs), { a: 'text', b: 'text' });
  assert.deepEqual(plain(R.NODE_DEFS['data.text'].outputs), { value: 'text' });
  assert.deepEqual(plain(R.NODE_DEFS['data.textlen'].inputs), { a: 'text' });
  assert.deepEqual(plain(R.NODE_DEFS['data.textlen'].outputs), { value: 'number' });
  assert.deepEqual(plain(R.NODE_DEFS['data.textcheck'].outputs), { value: 'bool' });
  assert.deepEqual(plain(R.NODE_DEFS['data.list'].inputs), {}, 'у литерала списка нет входов');
  assert.deepEqual(plain(R.NODE_DEFS['data.list'].outputs), { value: 'list' });
  assert.deepEqual(plain(R.NODE_DEFS['data.listget'].inputs), { list: 'list', index: 'number' });
  assert.deepEqual(plain(R.NODE_DEFS['data.listget'].outputs), { value: 'text' });
  assert.deepEqual(plain(R.NODE_DEFS['data.listlen'].outputs), { value: 'number' });
  assert.deepEqual(plain(R.NODE_DEFS['data.listjoin'].outputs), { value: 'text' });
});

test('проверка параметров: операция, case, items и разделитель', () => {
  const text = R.NODE_DEFS['data.text'];
  assert.equal(text.validate({ op: 'concat' }), '');
  assert.match(text.validate({ op: 'reverse' }), /concat, upper, lower и trim/);
  const check = R.NODE_DEFS['data.textcheck'];
  assert.equal(check.validate({ op: 'contains', case: false }), '');
  assert.equal(check.validate({ op: 'ne', case: true }), '');
  assert.match(check.validate({ op: 'match', case: false }), /contains, starts, ends, eq и ne/);
  assert.match(check.validate({ op: 'eq', case: 'no' }), /case/);
  const list = R.NODE_DEFS['data.list'];
  assert.equal(list.validate({ items: [] }), '', 'пустой список допустим');
  assert.equal(list.validate({ items: ['Огонь', 'Лёд'] }), '');
  assert.match(list.validate({ items: 'Огонь' }), /массив/, 'items — массив');
  assert.match(list.validate({ items: ['x'.repeat(201)] }), /200/, 'строка списка до 200 символов');
  assert.match(list.validate({ items: Array.from({ length: 101 }, () => 'x') }), /100/, 'до 100 элементов');
  const join = R.NODE_DEFS['data.listjoin'];
  assert.equal(join.validate({ separator: ', ' }), '');
  assert.equal(join.validate({}), '', 'разделитель необязателен');
  assert.match(join.validate({ separator: 'x'.repeat(11) }), /10/);
  assert.match(join.validate({ separator: 5 }), /строка/);
  // Проверка узла доходит до сохранения графа: неизвестная операция — ошибка.
  const broken = mech([node('t', 'data.text', { op: 'reverse' })]);
  assert.match(M.validate(broken), /concat, upper, lower и trim/);
  const ok = mech([node('l', 'data.list', { items: ['Огонь'] }), node('j', 'data.listjoin', { separator: ' и ' })], [link('l', 'value', 'j', 'list')]);
  assert.equal(M.validate(ok), '');
  assert.deepEqual(plain(M.problems(ok)), []);
});

test('data.text: склейка, регистр и trim считаются на входах', () => {
  assert.equal(computeOf('data.text', { op: 'concat' }, { a: 'Огонь', b: ' и лёд' }), 'Огонь и лёд');
  assert.equal(computeOf('data.text', { op: 'concat' }, { a: 'Огонь' }), 'Огонь', 'b необязателен');
  assert.equal(computeOf('data.text', { op: 'concat' }, {}), '', 'без проводов — пустая строка');
  assert.equal(computeOf('data.text', { op: 'upper' }, { a: 'огонь' }), 'ОГОНЬ');
  assert.equal(computeOf('data.text', { op: 'lower' }, { a: 'ОГОНЬ' }), 'огонь');
  assert.equal(computeOf('data.text', { op: 'trim' }, { a: '  огонь  ' }), 'огонь');
  assert.equal(computeOf('data.text', { op: 'upper' }, { a: 'огонь', b: 'лёд' }), 'ОГОНЬ', 'остальные операции читают только a');
  assert.equal(computeOf('data.text', { op: 'reverse' }, { a: 'огонь' }), undefined, 'неизвестная операция — неизвестное значение');
  assert.equal(R.textValue('upper', '𝄞'), '𝄞');
});

test('data.textlen считает символы Unicode, а не единицы UTF-16', () => {
  assert.equal(computeOf('data.textlen', {}, { a: 'огонь' }), 5);
  assert.equal(computeOf('data.textlen', {}, { a: '' }), 0);
  assert.equal(computeOf('data.textlen', {}, {}), 0, 'без провода — 0');
  assert.equal(computeOf('data.textlen', {}, { a: '𝄞' }), 1, 'астральный символ — один символ');
  assert.equal('𝄞'.length, 2, 'при этом в UTF-16 их два');
  assert.equal(R.textLength('𝄞𝄞'), 2);
});

test('data.textcheck сравнивает строки, case=false — без учёта регистра', () => {
  const check = (op, a, b, kase) => computeOf('data.textcheck', { op, case: kase }, { a, b });
  assert.equal(check('eq', 'Огонь', 'огонь', false), true);
  assert.equal(check('eq', 'Огонь', 'огонь', true), false);
  assert.equal(check('ne', 'Огонь', 'огонь', true), true);
  assert.equal(check('ne', 'Огонь', 'Огонь', false), false);
  assert.equal(check('starts', 'Огонь', 'ог', false), true);
  assert.equal(check('starts', 'Огонь', 'гонь', false), false);
  assert.equal(check('ends', 'Огонь', 'ОНЬ', false), true);
  assert.equal(check('ends', 'Огонь', 'ОГО', false), false);
  assert.equal(check('contains', 'Огонь и лёд', 'и', false), true);
  assert.equal(check('contains', 'Огонь', 'ЛЁД', false), false);
  assert.equal(check('contains', 'Огонь', '', false), true, 'пустая строка содержится в любой');
  assert.equal(check('eq', 'Огонь', 'огонь', undefined), true, 'по умолчанию регистр не важен');
  assert.equal(check('match', 'a', 'b', false), undefined, 'неизвестная операция — неизвестное значение');
});

test('data.list / listget / listlen / listjoin: литерал, элемент, длина и склейка', () => {
  assert.deepEqual(plain(computeOf('data.list', { items: ['Огонь', 'Лёд'] })), ['Огонь', 'Лёд']);
  assert.deepEqual(plain(computeOf('data.list', { items: [] })), [], 'пустой список допустим');
  assert.deepEqual(plain(computeOf('data.list', { items: 'Огонь' })), [], 'не-массив — пустой список');
  assert.equal(computeOf('data.listget', {}, { list: ['Огонь', 'Лёд'], index: 0 }), 'Огонь');
  assert.equal(computeOf('data.listget', {}, { list: ['Огонь', 'Лёд'], index: 1 }), 'Лёд');
  assert.equal(computeOf('data.listget', {}, { list: ['Огонь'], index: 9 }), '', 'индекс вне диапазона — пустая строка');
  assert.equal(computeOf('data.listget', {}, { list: ['Огонь'], index: -1 }), '', 'отрицательный индекс');
  assert.equal(computeOf('data.listget', {}, { list: ['Огонь'], index: 0.7 }), 'Огонь', 'дробный индекс усекается');
  assert.equal(computeOf('data.listget', {}, { list: [], index: 0 }), '', 'пустой список');
  assert.equal(computeOf('data.listget', {}, {}), '', 'без проводов — пустая строка');
  assert.equal(computeOf('data.listlen', {}, { list: ['Огонь', 'Лёд'] }), 2);
  assert.equal(computeOf('data.listlen', {}, { list: [] }), 0, 'пустой список — 0');
  assert.equal(computeOf('data.listlen', {}, {}), 0, 'без провода — 0');
  assert.equal(computeOf('data.listjoin', { separator: ' и ' }, { list: ['Огонь', 'Лёд'] }), 'Огонь и Лёд');
  assert.equal(computeOf('data.listjoin', {}, { list: ['Огонь', 'Лёд'] }), 'Огонь, Лёд', 'разделитель по умолчанию — «, »');
  assert.equal(computeOf('data.listjoin', { separator: '' }, { list: ['а', 'б'] }), 'аб');
  assert.equal(computeOf('data.listjoin', {}, { list: [] }), '', 'пустой список — пустая строка');
  assert.equal(computeOf('data.listjoin', {}, {}), '', 'без провода — пустая строка');
});

test('предпросмотр плана: list → listjoin → textlen попадает в setvar числом', () => {
  const graph = mech([
    node('l', 'data.list', { items: ['Огонь'] }),
    node('join', 'data.listjoin', { separator: ' и ' }),
    node('len', 'data.textlen', {}),
    node('sv', 'action.setvar', { block_id: 'sv', name: 'x', scope: 'action' }),
  ], [link('start', 'exec', 'sv', 'exec'), link('l', 'value', 'join', 'list'), link('join', 'value', 'len', 'a'), link('len', 'value', 'sv', 'value')]);
  assert.equal(M.validate(graph), '');
  assert.equal(blocksOf(graph)[0].value, 5, '«Огонь» — пять символов');
  // Список из двух строк склеивается разделителем до подсчёта длины: 5 + 3 + 3 = 11.
  const pair = mech([
    node('l', 'data.list', { items: ['Огонь', 'Лёд'] }),
    node('join', 'data.listjoin', { separator: ' и ' }),
    node('len', 'data.textlen', {}),
    node('sv', 'action.setvar', { block_id: 'sv', name: 'x', scope: 'action' }),
  ], [link('start', 'exec', 'sv', 'exec'), link('l', 'value', 'join', 'list'), link('join', 'value', 'len', 'a'), link('len', 'value', 'sv', 'value')]);
  assert.equal(blocksOf(pair)[0].value, 11);
  // Узел без проводов не ломает граф: значение остаётся допустимым числом.
  const bare = mech([node('len', 'data.textlen', {})]);
  assert.equal(M.validate(bare), '');
});

test('условие блока: textcheck (bool) и textlen + data.compare (число → bool)', () => {
  // Клиентский предпросмотр решает статическое условие: true — блок остаётся в плане,
  // false — блок выпадает. Сервер откладывает условие в condition_src (см. Rust-тесты).
  const stringGate = mech([
    node('l', 'data.list', { items: ['Огонь'] }),
    node('join', 'data.listjoin', {}),
    node('tc', 'data.textcheck', { op: 'starts', case: false }),
    node('m', 'action.manual', { block_id: 'm', text: 'Правило', when: 'always' }),
  ], [link('start', 'exec', 'm', 'exec'), link('l', 'value', 'join', 'list'), link('join', 'value', 'tc', 'a'), link('join', 'value', 'tc', 'b'), link('tc', 'value', 'm', 'condition')]);
  assert.equal(M.validate(stringGate), '');
  assert.deepEqual(blocksOf(stringGate).map(block => block.id), ['m'], 'true оставляет блок в плане');
  // Сравнение разных строк даёт false: блок не попадает в план предпросмотра.
  const disarmed = mech([
    node('l1', 'data.list', { items: ['Огонь'] }),
    node('l2', 'data.list', { items: ['Лёд'] }),
    node('j1', 'data.listjoin', {}),
    node('j2', 'data.listjoin', {}),
    node('tc', 'data.textcheck', { op: 'eq', case: false }),
    node('m', 'action.manual', { block_id: 'm', text: 'Правило', when: 'always' }),
  ], [link('start', 'exec', 'm', 'exec'), link('l1', 'value', 'j1', 'list'), link('l2', 'value', 'j2', 'list'),
    link('j1', 'value', 'tc', 'a'), link('j2', 'value', 'tc', 'b'), link('tc', 'value', 'm', 'condition')]);
  assert.deepEqual(blocksOf(disarmed), [], 'false убирает блок из плана предпросмотра');
  // Длина строки + сравнение чисел: число переводится в bool узлом data.compare.
  const lengthGate = mech([
    node('l', 'data.list', { items: ['Огонь'] }),
    node('join', 'data.listjoin', {}),
    node('len', 'data.textlen', {}),
    node('four', 'data.number', { value: 4 }),
    node('cmp', 'data.compare', { op: '>' }),
    node('m', 'action.manual', { block_id: 'm', text: 'Правило', when: 'always' }),
  ], [link('start', 'exec', 'm', 'exec'), link('l', 'value', 'join', 'list'), link('join', 'value', 'len', 'a'),
    link('len', 'value', 'cmp', 'a'), link('four', 'value', 'cmp', 'b'), link('cmp', 'value', 'm', 'condition')]);
  assert.equal(M.validate(lengthGate), '');
  assert.deepEqual(blocksOf(lengthGate).map(block => block.id), ['m'], '5 > 4 — блок остаётся');
});

// Обход дерева формы: минимальный DOM-стаб отдаёт children/attrs.
function findAll(root, predicate) {
  const out = [];
  const walk = item => {
    if (!item || typeof item !== 'object') return;
    if (predicate(item)) out.push(item);
    for (const child of item.children || []) walk(child);
  };
  walk(root);
  return out;
}
const selects = root => findAll(root, item => item.tag === 'select');
const options = select => select.children.map(option => option.attrs.value);
const labelTexts = root => findAll(root, item => (item.attrs?.class || '').split(' ').includes('param-label')).map(item => item.children.join(''));

test('формы: списки операций строк и полей списка', () => {
  const text = NF.nodeParams({ id: 't', type: 'data.text', params: { op: 'upper' } });
  assert.deepEqual(options(selects(text)[0]), plain(R.TEXT_OPS), 'операции строки — закрытый список');
  const check = NF.nodeParams({ id: 'c', type: 'data.textcheck', params: { op: 'eq', case: false } });
  assert.deepEqual(options(selects(check)[0]), plain(R.TEXT_CHECK_OPS), 'операции сравнения строк');
  assert.ok(findAll(check, item => item.attrs?.type === 'checkbox').length, 'флаг case — флажок');
  const join = NF.nodeParams({ id: 'j', type: 'data.listjoin', params: { separator: ' и ' } });
  assert.ok(findAll(join, item => item.tag === 'input' && item.attrs?.value === ' и ').length, 'разделитель правится полем');
  const list = NF.nodeParams({ id: 'l', type: 'data.list', params: { items: ['Огонь'] } });
  assert.ok(labelTexts(list).includes('Строки списка'), 'подпись поля items у data.list — «Строки списка»');
  for (const type of TYPES) assert.doesNotThrow(() => NF.nodeParams({ id: 'n1', type, params: plain(R.NODE_DEFS[type].defaults || {}) }), `${type}: форма строится`);
});
