// Подбор узлов для контекстного меню редактора: «Подключить к этой ноде» / «Подключить от этой ноды».
// Чистая функция Mechanics.connectionCandidates не трогает DOM: проверяем типы сокетов, динамические
// порты (def.ports), свободный вход, приоритет exec и сортировку по категориям палитры.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat(); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = {
  window: {}, crypto: require('node:crypto').webcrypto, el, toast() {},
  document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } },
  ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' },
  SKILLS: [['acrobatics', 'Акробатика', 'dex'], ['stealth', 'Скрытность', 'dex']],
};
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
for (const file of ['static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
const M = ctx.window.Mechanics, R = ctx.window.NodeRegistry;
const clone = value => JSON.parse(JSON.stringify(value));
const defaults = type => clone(R.NODE_DEFS[type].defaults || {});
const node = (id, type, params = null, position = { x: 0, y: 0 }) => ({ id, type, params: params || (type.startsWith('action.') ? { ...defaults(type), block_id: id } : defaults(type)), position });
// Готовый граф: действие «Начало → Бросок», число, математика, логика, кость и «Если».
function graph() {
  return {
    version: 2,
    graph: {
      nodes: [
        node('start', 'action.program', { program_id: 'use', name: 'Действие', trigger: 'use' }),
        node('roll', 'action.roll', { ...defaults('action.roll'), block_id: 'atk', kind: 'attack' }, { x: 300, y: 0 }),
        node('branch', 'flow.if', {}, { x: 620, y: 0 }),
        node('end', 'flow.end', {}, { x: 900, y: 0 }),
        node('number', 'data.number', { value: 5 }, { x: 0, y: 220 }),
        node('number2', 'data.number', { value: 7 }, { x: 0, y: 340 }),
        node('math', 'data.math', { op: 'add' }, { x: 300, y: 220 }),
        node('logic', 'logic.op', { op: 'not' }, { x: 620, y: 220 }),
        node('dice', 'data.dice', { value: { count: 1, sides: 6, bonus: 0, stat: '' } }, { x: 300, y: 420 }),
        node('compare', 'data.compare', { op: '>=' }, { x: 900, y: 220 }),
      ],
      links: [], frames: [], groups: [],
    },
  };
}
const candidates = (g, id, mode) => M.connectionCandidates(g.graph, id, mode).map(item => clone(item));
const byType = list => Object.fromEntries(list.map(item => [item.type, item]));
const categoryIndex = type => R.CATEGORIES.findIndex(category => category.id === R.categoryOf(type).id);

test('совместимость по типам сокетов: exec→exec, число→number, bool→condition', () => {
  const to = byType(candidates(graph(), 'roll', M.CONNECT_TO));
  assert.equal(to['action.field'].pair.out, 'exec');
  assert.equal(to['action.field'].pair.in, 'exec');
  assert.equal(to['action.field'].socketLabel, 'exec → exec');
  // bool-условие подключается ко входу condition, а не к enabled: так блок проверяет его в рантайме.
  assert.equal(to['condition.context'].pair.out, 'value');
  assert.equal(to['condition.context'].pair.in, 'condition');
  assert.equal(to['condition.context'].socketLabel, 'value → condition');
  // Обратное направление: выход текущего узла совпадает со входом кандидата.
  const fromNumber = byType(candidates(graph(), 'number', M.CONNECT_FROM));
  assert.equal(fromNumber['data.math'].pair.out, 'value');
  assert.equal(fromNumber['data.math'].pair.in, 'a');
  const fromDice = byType(candidates(graph(), 'dice', M.CONNECT_FROM));
  assert.equal(fromDice['action.roll'].pair.out, 'value');
  assert.equal(fromDice['action.roll'].pair.in, 'dice');
  assert.equal(fromDice['action.roll'].socketLabel, 'value → dice');
});

test('сам тип, группы и служебные узлы не предлагаются, дублей нет', () => {
  for (const mode of [M.CONNECT_TO, M.CONNECT_FROM]) {
    const list = candidates(graph(), 'roll', mode), types = list.map(item => item.type);
    assert.ok(!types.includes('action.roll'), `${mode}: сам тип не предлагается`);
    assert.ok(!types.some(type => type.startsWith('group.')), `${mode}: узлы групп скрыты`);
    assert.ok(!types.includes('action.program') && !types.includes('flow.end'), `${mode}: «Начало»/«Конец» создаются своими командами`);
    assert.equal(new Set(types).size, types.length, `${mode}: типы уникальны`);
    for (const item of list) assert.ok(R.NODE_DEFS[item.type], `${mode}: ${item.type} из реестра`);
  }
  assert.equal(M.connectionCandidates(graph().graph, 'missing', M.CONNECT_TO).length, 0, 'неизвестный узел — пустой список');
  assert.equal(M.connectionCandidates(graph().graph, 'roll', 'sideways').length, 0, 'неизвестный режим — пустой список');
  // У узла без входов секции «к этой ноде» нет — меню её не показывает.
  assert.equal(candidates(graph(), 'dice', M.CONNECT_TO).length, 0, 'нет входов — нет секции «к этой ноде»');
  assert.ok(candidates(graph(), 'dice', M.CONNECT_FROM).length > 0, 'но секция «от этой ноды» есть');
});

test('секция ограничена и непустые пункты идут по категориям палитры', () => {
  assert.ok(M.CONNECT_LIMIT >= 8 && M.CONNECT_LIMIT <= 10, 'в секции 8–10 пунктов');
  const to = candidates(graph(), 'roll', M.CONNECT_TO);
  assert.equal(to.length, M.CONNECT_LIMIT, 'длинная секция обрезана лимитом');
  assert.ok(to.every(item => item.title && item.socketLabel), 'у пункта есть заголовок и пара сокетов');
  // Без условия-входа сортировка идёт по категориям палитры (Данные раньше Правил).
  const fromNumber = candidates(graph(), 'number', M.CONNECT_FROM);
  const order = Array.from(fromNumber, item => categoryIndex(item.type));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'категории не перемешиваются');
  assert.ok(fromNumber.some(item => item.type === 'rule.value'), 'правила тоже попадают в кандидаты');
});

test('у блока действия условия идут первыми, включая condition.hit', () => {
  const to = candidates(graph(), 'roll', M.CONNECT_TO);
  const leading = Array.from(to, item => item.type).filter(type => type.startsWith('condition.'));
  assert.ok(leading.length >= 3, 'у блока есть не меньше трёх совместимых условий');
  assert.ok(Array.from(to.slice(0, leading.length), item => item.type).every(type => type.startsWith('condition.')), 'условия — в начале секции');
  const types = Array.from(to, item => item.type);
  assert.ok(types.includes('condition.hit') && types.includes('condition.context'), 'все bool-условия совместимы');
  // У узла без входа condition такого сдвига нет.
  const fromDice = candidates(graph(), 'dice', M.CONNECT_FROM);
  assert.ok(!fromDice.slice(0, 1).every(item => item.type.startsWith('condition.')), 'у не-блока условия не выносятся вперёд');
});

test('занятый вход проигрывает свободному и не создаёт второй провод', () => {
  const g = graph();
  g.graph.links.push({ from: { node: 'number', socket: 'value' }, to: { node: 'math', socket: 'a' } });
  const freeB = byType(candidates(g, 'math', M.CONNECT_TO));
  assert.equal(freeB['data.number'].pair.in, 'b', 'свободный вход b выбран вместо занятого a');
  assert.equal(freeB['data.number'].free, true);
  g.graph.links.push({ from: { node: 'number2', socket: 'value' }, to: { node: 'math', socket: 'b' } });
  const busy = byType(candidates(g, 'math', M.CONNECT_TO));
  assert.equal(busy['data.number'].free, false, 'занятые входы помечены: провод не заменяется');
});

test('динамические порты def.ports: у «НЕ» нет входа b', () => {
  assert.deepEqual(clone(M.connectionPorts('logic.op', { op: 'not' })), { inputs: { a: 'bool' }, outputs: { value: 'bool' } });
  assert.deepEqual(Object.keys(M.connectionPorts('logic.op', { op: 'and' }).inputs), ['a', 'b']);
  assert.deepEqual(Object.keys(M.connectionPorts('logic.op').inputs), ['a', 'b'], 'порты по умолчанию');
  const to = candidates(graph(), 'logic', M.CONNECT_TO);
  assert.ok(to.length, 'к логике есть кандидаты');
  assert.ok(to.every(item => item.pair.in === 'a'), 'у «НЕ» единственный bool-вход a');
  const from = byType(candidates(graph(), 'logic', M.CONNECT_FROM));
  assert.ok(from['action.field'], 'bool-выход подключается к bool-входам блока действия');
  assert.equal(from['action.field'].pair.out, 'value');
  assert.match(from['action.field'].pair.in, /^(condition|enabled)$/);
});
