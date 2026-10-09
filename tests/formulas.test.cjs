// Движок формул (static/formulas.js): арифметика, переменные из реестра, ошибки и безопасность.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/formulas.js', 'utf8'), ctx);
const F = ctx.window.Formulas;

const sheet = { abilities: { str: 8, dex: 14, con: 16, int: 10, wis: 16, cha: 12 }, proficiency_bonus: 2, level: 5 };
const vars = F.sheetVars(sheet);

test('arithmetic follows D&D precedence and rounds division down', () => {
  assert.equal(F.evaluate('10 + 2 * 3', vars), 16);
  assert.equal(F.evaluate('(10 + 2) * 3', vars), 36);
  assert.equal(F.evaluate('-2 + 5', vars), 3);
  assert.equal(F.evaluate('7 / 2', vars), 3);
  assert.equal(F.evaluate('-7 / 2', vars), -4, 'floor, not truncation');
});

test('ability variables are modifiers and sheet variables are plain numbers', () => {
  assert.deepEqual({ dex: vars.dex, con: vars.con, wis: vars.wis, str: vars.str, prof: vars.prof, level: vars.level },
    { dex: 2, con: 3, wis: 3, str: -1, prof: 2, level: 5 });
  assert.equal(F.evaluate('10 + @dex + @con', vars), 15, 'Barbarian Unarmored Defense');
  assert.equal(F.evaluate('10 + dex + wis', vars), 15, 'bare names work too');
});

test('min and max are functions with any number of arguments', () => {
  assert.equal(F.evaluate('min(@dex, 1)', vars), 1);
  assert.equal(F.evaluate('max(1, 2, @con)', vars), 3);
  assert.equal(F.evaluate('10 + min(@dex,2)', vars), 12);
});

test('unknown names, unknown functions and bad syntax are reported, not executed', () => {
  const cases = [
    ['10 + foo', 'Неизвестная переменная «foo».'],
    ['process.exit()', 'Неизвестный символ «.» в формуле.'],
    ['constructor', 'Неизвестная переменная «constructor».'],
    ['eval(1)', 'Неизвестная функция «eval»'],
    ['2d6', 'Лишний фрагмент в конце формулы.'],
    ['(1 + 2', 'Не хватает закрывающей скобки.'],
    ['1 + 2)', 'Лишний фрагмент в конце формулы.'],
    ['1 +', 'Формула обрывается.'],
    ['', 'Формула пустая.'],
  ];
  for (const [text, message] of cases) {
    assert.notEqual(F.validate(text), '', `${text} must be rejected`);
    assert.throws(() => F.evaluate(text, vars, { throwOnError: true }), undefined, `${text} must throw when asked`);
  }
  assert.equal(F.validate('10 + foo'), 'Неизвестная переменная «foo».');
  assert.equal(F.validate('2d6'), 'Лишний фрагмент в конце формулы.');
  assert.equal(F.evaluate('10 + foo', vars), null, 'default evaluation returns null on error');
  assert.equal(F.evaluate('1 / 0', vars), null, 'division by zero is a runtime error');
  assert.equal(F.validate('1 / 0'), '', 'syntax is valid; the error happens when evaluated');
});

test('length and nesting are limited', () => {
  assert.notEqual(F.validate('1+'.repeat(120) + '1'), '', 'longer than 200 characters');
  assert.notEqual(F.validate('('.repeat(30) + '1' + ')'.repeat(30)), '', 'too deep');
  assert.equal(F.validate('(' .repeat(5) + '1' + ')'.repeat(5)), '');
});

test('the variable registry is data: a new variable needs one entry, not new code', () => {
  F.VARIABLES.ac_bonus = { sheet: 'ac_bonus' };
  try {
    assert.equal(F.evaluate('10 + @ac_bonus', F.sheetVars({ ac_bonus: 3 })), 13);
  } finally {
    delete F.VARIABLES.ac_bonus;
  }
  assert.equal(F.validate('10 + @ac_bonus'), 'Неизвестная переменная «ac_bonus».', 'removed again');
});

test('legacy item formulas are translated to the same meaning', () => {
  assert.equal(F.normalizeLegacy('14 + dex max 2'), '14+min(dex,2)');
  assert.equal(F.evaluate(F.normalizeLegacy('14 + dex max 2'), vars), 16);
  assert.equal(F.evaluate(F.normalizeLegacy('12 + Dex'), vars), 14);
});

test('unarmored rule is read from data first and from legacy strings second', () => {
  const data = { formula: '10 + @dex + @wis', no_shield: true };
  assert.deepEqual(F.unarmoredRule({ unarmored_defense: data }), data);
  assert.deepEqual(F.unarmoredRule({ unarmored_defense: 'monk' }), F.LEGACY_UNARMORED.monk);
  assert.equal(F.unarmoredRule({ unarmored_defense: 'unknown-class' }), null, 'unknown class names give no rule');
  assert.equal(F.unarmoredRule({}), null);
});

test('SRD data: barbarian and monk in both editions carry the rule as data', () => {
  const abilities = { str: 10, dex: 14, con: 16, int: 10, wis: 16, cha: 10 };
  const expect = { 'srd14-barbarian': [15, false], 'srd14-monk': [15, true], 'srd24-barbarian': [15, false], 'srd24-monk': [15, true] };
  const seen = new Set();
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (!expect[entry.slug]) continue;
      seen.add(entry.slug);
      const block = (entry.data.mechanics.programs || []).find(p => p.trigger === 'passive')?.blocks.find(b => b.field === 'unarmored_defense');
      assert.ok(block, `${entry.slug} has an unarmored_defense block`);
      assert.equal(F.validate(block.value.formula), '', `${entry.slug} formula is valid`);
      const [ac, noShield] = expect[entry.slug];
      assert.equal(F.evaluate(block.value.formula, F.sheetVars({ abilities })), ac, `${entry.slug} value`);
      assert.equal(block.value.no_shield, noShield, `${entry.slug} shield rule`);
      assert.equal(block.value.name, undefined, `${entry.slug}: no Russian labels inside seed mechanics`);
    }
  }
  assert.equal(seen.size, 4);
});
