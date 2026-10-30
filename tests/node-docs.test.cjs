// Таблица палитры в docs/node-system-v3.md — третья сторона паритета «клиент ↔ сервер ↔ доки».
// Проверяются: полный набор типов, порядок категорий, имена входов/выходов и список серверных NODE_TYPES.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles()]) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}
const R = ctx.window.NodeRegistry;
const { rustConstants } = require('../tools/srd/integrity.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const DOC = 'docs/node-system-v3.md';

// Строка таблицы палитры: | `тип` | назначение | входы → выходы | параметры |
function rowsOf(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([a-z_.]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/);
    if (match) rows.push({ type: match[1], purpose: match[2].trim(), io: match[3], params: match[4] });
  }
  return rows;
}
const backticked = text => [...String(text).matchAll(/`([a-z_.]+)`/g)].map(match => match[1]);

test('таблица палитры перечисляет все 45 типов ровно один раз', () => {
  const rows = rowsOf(fs.readFileSync(DOC, 'utf8'));
  const documented = rows.map(row => row.type);
  assert.equal(new Set(documented).size, documented.length, 'типы в таблице не повторяются');
  assert.deepEqual(documented.slice().sort(), Object.keys(R.NODE_DEFS).slice().sort(), 'таблица и реестр клиента совпадают');
  assert.equal(documented.length, 45, 'в палитре 45 типов (43 видимых и два внутренних узла групп)');
  for (const row of rows) assert.ok(row.purpose.length > 0, `${row.type}: назначение не пустое`);
});

test('порядок строк таблицы совпадает с порядком категорий меню', () => {
  const order = plain(R.CATEGORIES.map(category => category.id));
  const indexes = rowsOf(fs.readFileSync(DOC, 'utf8')).map(row => order.indexOf(R.categoryOf(row.type).id));
  for (let i = 1; i < indexes.length; i += 1) assert.ok(indexes[i - 1] <= indexes[i], 'категории идут рабочим порядком без возвратов назад');
});

test('входы и выходы в таблице совпадают с реестром', () => {
  for (const row of rowsOf(fs.readFileSync(DOC, 'utf8'))) {
    const def = R.NODE_DEFS[row.type];
    assert.ok(def, `${row.type}: узел зарегистрирован`);
    const [inputs, ...rest] = row.io.split('→');
    const outputs = rest.join('→');
    assert.deepEqual(backticked(inputs).slice().sort(), Object.keys(def.inputs || {}).sort(), `${row.type}: входы`);
    assert.deepEqual(backticked(outputs).slice().sort(), Object.keys(def.outputs || {}).sort(), `${row.type}: выходы`);
  }
});

test('список NODE_TYPES сервера совпадает с таблицей и реестром', () => {
  const server = rustConstants().NODE_TYPES.slice().sort();
  const documented = rowsOf(fs.readFileSync(DOC, 'utf8')).map(row => row.type).sort();
  assert.deepEqual(server, documented, 'src/mechanics_graph.rs NODE_TYPES = docs/node-system-v3.md');
  assert.deepEqual(server, Object.keys(R.NODE_DEFS).sort(), 'src/mechanics_graph.rs NODE_TYPES = static/node-registry.js');
});
