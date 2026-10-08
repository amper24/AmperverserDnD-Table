const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {}, crypto: require('node:crypto').webcrypto };
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('static/modules.js', 'utf8'), context);
const submitted = [];
context.DiceEngine = context.window.DiceEngine;
context.window.DiceEngine.submit = message => { submitted.push(JSON.parse(JSON.stringify(message))); return message; };
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

test('roll adapters apply advantage/disadvantage to every action kind and dice size', () => {
  const M = context.window.Modules;
  M.roll('d8+3', 'Урон', { kind: 'damage', mode: 'adv' });
  assert.equal(submitted.at(-1).expr, '2d8kh1+3');
  M.rollMulti([
    { kind: 'damage', roll: '2d6+1', name: 'Урон' },
    { kind: 'heal', roll: 'd4+2', name: 'Лечение' },
  ], 'Связка', { mode: 'dis' });
  assert.deepEqual(submitted.at(-1).rolls.map(r => r.expr), ['4d6kl2+1', '2d4kl1+2']);
});
