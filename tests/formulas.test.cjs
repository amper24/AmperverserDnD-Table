const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/modules.js', 'utf8'), context);
const formulas = text => JSON.parse(JSON.stringify(context.window.Modules.diceExpressions(text)));

test('inline formula detection keeps multi-die sums and modifiers in one roll', () => {
  assert.deepEqual(formulas('Урон 1d6+1d4+3 огнём'), [{ expr: '1d6+1d4+3', index: 5, end: 14 }]);
  assert.deepEqual(formulas('Урон −1d6+@prof, затем 2к8+4'), [
    { expr: '-1d6+@prof', index: 5, end: 15 },
    { expr: '2к8+4', index: 23, end: 28 },
  ]);
});

test('inline detector does not link dice-like substrings inside words', () => {
  assert.deepEqual(formulas('damage1d6word, then 1d8.'), [{ expr: '1d8', index: 20, end: 23 }]);
});
