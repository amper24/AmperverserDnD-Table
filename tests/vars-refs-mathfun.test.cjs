// Переменные (action.setvar / data.var), ссылки на узлы (data.ref) и математика (data.mathfun):
// формы параметров, предпросмотр плана, проверка self/цикл/несуществующий узел.
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
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/mechanics-graph.json', 'utf8'));

const node = (id, type, params = {}) => ({ id, type, params: { ...plain(R.NODE_DEFS[type]?.defaults || {}), ...params } });
const link = (fromNode, fromSocket, toNode, toSocket) => ({ from: { node: fromNode, socket: fromSocket }, to: { node: toNode, socket: toSocket } });
const start = node('start', 'action.program', { program_id: 'p', name: 'Тест', trigger: 'use' });
// Хелпер достраивает «Конец» действию, как редактор: иначе поток не исполняется.
const mech = (nodes, links) => {
  const graph = { nodes: [start, ...nodes], links, frames: [], groups: [] };
  M.addFlowEnds(graph);
  return { version: 2, graph };
};
const blocksOf = mechanics => plain(M.toLegacy(mechanics).programs[0].blocks);

// Граф «число/операция → action.setvar(value)»: в план попадает вычисленное значение провода.
function setvarPlan(extraNodes, links) {
  return mech([
    ...extraNodes,
    node('sv', 'action.setvar', { block_id: 'sv', name: 'x', scope: 'action' }),
  ], [link('start', 'exec', 'sv', 'exec'), ...links]);
}

function mathfunPlan(op, a, b, c) {
  const extra = [node('a', 'data.number', { value: a }), node('mf', 'data.mathfun', { op })];
  const links = [link('a', 'value', 'mf', 'a'), link('mf', 'value', 'sv', 'value')];
  if (b !== undefined) { extra.push(node('b', 'data.number', { value: b })); links.push(link('b', 'value', 'mf', 'b')); }
  if (c !== undefined) { extra.push(node('c', 'data.number', { value: c })); links.push(link('c', 'value', 'mf', 'c')); }
  const graph = setvarPlan(extra, links);
  assert.equal(M.validate(graph), '', `mathfun ${op}: граф сохраняется`);
  return blocksOf(graph)[0].value;
}

test('data.mathfun считает все восемь операций так же, как реестр', () => {
  const cases = [
    ['abs', -4, undefined, undefined, 4],
    ['round', 2.5, undefined, undefined, 3],
    ['round', -2.5, undefined, undefined, -2],
    ['floor', 2.9, undefined, undefined, 2],
    ['ceil', 2.1, undefined, undefined, 3],
    ['sign', -9, undefined, undefined, -1],
    ['sign', 0, undefined, undefined, 0],
    ['min', 5, 3, undefined, 3],
    ['max', 5, 3, undefined, 5],
    ['clamp', 10, 0, 6, 6],
  ];
  for (const [op, a, b, c, expected] of cases) {
    assert.equal(mathfunPlan(op, a, b, c), expected, `${op}(${[a, b, c].filter(value => value !== undefined).join(', ')})`);
    assert.equal(R.mathfunValue(op, a, b, c), expected, `реестр: ${op}`);
  }
  assert.equal(R.mathfunValue('div', 1, 2), undefined, 'неизвестная операция — undefined');
  assert.deepEqual(plain(R.MATHFUN_OPS), ['min', 'max', 'clamp', 'abs', 'round', 'floor', 'ceil', 'sign']);
});

test('data.var без состояния выполнения равен нулю', () => {
  const graph = mech([
    node('v', 'data.var', { name: 'bonus', scope: 'action' }),
    node('sv', 'action.setvar', { block_id: 'sv', name: 'x', scope: 'action' }),
  ], [link('start', 'exec', 'sv', 'exec'), link('v', 'value', 'sv', 'value')]);
  assert.equal(M.validate(graph), '');
  assert.equal(blocksOf(graph)[0].value, 0, 'предпросмотр без runtime: 0');
  assert.equal(R.nodeDef('data.var').compute(), 0, 'compute узла тоже 0');
  assert.equal(R.nodeDef('data.var').outputs.value, 'number');
});

test('data.ref подставляет значение статического узла, в том числе объявленного ниже', () => {
  // Цель объявлена после ссылки: проверка параметров идёт после сбора ID.
  const graph = mech([
    node('r', 'data.ref', { node: 'n' }),
    node('n', 'data.number', { value: 7 }),
    node('sv', 'action.setvar', { block_id: 'sv', name: 'x', scope: 'sheet' }),
  ], [link('start', 'exec', 'sv', 'exec'), link('r', 'value', 'sv', 'value')]);
  assert.equal(M.validate(graph), '', 'ссылка вперёд допустима');
  assert.deepEqual(plain(M.problems(graph)), []);
  assert.equal(blocksOf(graph)[0].value, 7, 'предпросмотр видит статическое число');
  // Ссылка на ссылку разворачивается до числового узла.
  const chained = mech([
    node('r1', 'data.ref', { node: 'r2' }),
    node('r2', 'data.ref', { node: 'n' }),
    node('n', 'data.number', { value: 4 }),
    node('sv', 'action.setvar', { block_id: 'sv', name: 'x', scope: 'action' }),
  ], [link('start', 'exec', 'sv', 'exec'), link('r1', 'value', 'sv', 'value')]);
  assert.equal(M.validate(chained), '');
  assert.equal(blocksOf(chained)[0].value, 4);
});

test('ссылка отклоняет себя, цикл, отсутствующий и нечисловой узел', () => {
  const graphOf = nodes => mech(nodes, []);
  assert.match(M.validate(graphOf([node('r', 'data.ref', { node: 'r' })])), /не может ссылаться на себя/);
  assert.match(M.validate(graphOf([node('r1', 'data.ref', { node: 'r2' }), node('r2', 'data.ref', { node: 'r1' })])), /Циклическая ссылка/);
  assert.match(M.validate(graphOf([node('r', 'data.ref', { node: 'ghost' })])), /не найден/);
  assert.match(M.validate(graphOf([node('r', 'data.ref', { node: 'cmp' }), node('cmp', 'data.compare', { op: '>' })])), /числовой узел/);
  assert.match(M.validate(graphOf([node('r', 'data.ref', { node: 'm' }), node('m', 'action.manual', { block_id: 'm', text: 'Правило' })])), /числовой узел/);
  // Пустая цель — ошибка формы, а не «любой узел».
  assert.match(M.validate(graphOf([node('r', 'data.ref', { node: '' })])), /выберите узел/);
});

test('data.ref внутри группы получает префикс экземпляра', () => {
  const entry = fixture.cases.find(value => value.name === 'data-ref-inside-a-group');
  assert.ok(entry, 'кейс фикстуры есть');
  assert.equal(M.validate(entry.mechanics), '');
  assert.deepEqual(plain(M.problems(entry.mechanics)), []);
  assert.equal(plain(M.toLegacy(entry.mechanics).programs[0].blocks)[0].value, 9, 'цель ссылки найдена в развёрнутой группе');
});

test('action.setvar проверяет имя, область и значение', () => {
  assert.equal(R.varName('bonus_1'), true);
  assert.equal(R.varName('Бонус'), false);
  assert.equal(R.varName(''), false);
  assert.equal(R.varName('a'.repeat(33)), false);
  const def = R.nodeDef('action.setvar');
  assert.equal(def.validate({ name: 'bonus', scope: 'action' }), '');
  assert.equal(def.validate({ name: 'bonus', scope: 'sheet' }), '');
  assert.match(def.validate({ name: 'Бонус', scope: 'action' }), /имя/);
  assert.match(def.validate({ name: 'bonus', scope: 'global' }), /область/);
  assert.deepEqual(plain(R.VAR_SCOPES), ['action', 'sheet']);
  assert.ok(R.ACTION_KINDS.includes('setvar'), 'вид действия в списке реестра');
  assert.deepEqual(plain(R.blockKindsOf('action.setvar')), ['setvar']);
  assert.equal(R.blockKindOf('action.setvar', {}), 'setvar');
  const graph = mech([
    node('sv', 'action.setvar', { block_id: 'sv', name: 'bonus', scope: 'global' }),
  ], [link('start', 'exec', 'sv', 'exec')]);
  assert.match(M.validate(graph), /область/);
});

test('clamp без проводов b и c сохраняется, но граф не исполняется', () => {
  const graph = mech([
    node('a', 'data.number', { value: 10 }),
    node('mf', 'data.mathfun', { op: 'clamp' }),
    node('m', 'action.manual', { block_id: 'm', text: 'Правило', when: 'always' }),
  ], [link('start', 'exec', 'm', 'exec'), link('a', 'value', 'mf', 'a')]);
  assert.equal(M.validate(graph), '', 'смысловая проблема не блокирует сохранение');
  assert.ok(plain(M.problems(graph)).some(message => message.includes('clamp')), 'подсказка о проводах b и c');
});

// Обход дерева формы: минимальный DOM-стаб отдаёт children/attrs.
function findAll(root, predicate) {
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) out.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}
const selects = root => findAll(root, node => node.tag === 'select');
const options = select => select.children.map(option => option.attrs.value);

test('формы новых узлов: операции математики, области переменных и выбор узла ссылки', () => {
  const math = NF.nodeParams({ id: 'mf', type: 'data.mathfun', params: { op: 'clamp' } });
  assert.deepEqual(options(selects(math)[0]), plain(R.MATHFUN_OPS), 'операция — закрытый список из восьми');
  const variable = NF.nodeParams({ id: 'v', type: 'data.var', params: { name: 'bonus', scope: 'sheet' } });
  assert.deepEqual(options(selects(variable)[0]), ['action', 'sheet'], 'область переменной');
  const setvar = NF.nodeParams({ id: 's', type: 'action.setvar', params: { block_id: 's', name: 'bonus', scope: 'action' } });
  const scope = selects(setvar).find(select => options(select).includes('sheet'));
  assert.deepEqual(options(scope), ['action', 'sheet'], 'область записи переменной');
  const ref = NF.nodeParams({ id: 'r', type: 'data.ref', params: { node: 'n1' } }, { refNodes: [{ value: 'n1', label: 'Число · n1' }] });
  assert.deepEqual(options(selects(ref)[0]), ['', 'n1'], 'ссылка выбирает узел из списка графа');
  assert.equal(selects(ref)[0].children.find(option => option.attrs.value === 'n1').attrs.selected, '');
});
