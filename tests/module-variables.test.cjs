const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Переменные модулей (@atk, @dc …) считаются формулами из реестра DERIVED_VARS через Formulas.
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/formulas.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/modules.js', 'utf8'), ctx);
const Modules = ctx.window.Modules;
const F = ctx.window.Formulas;

test('module derived variables follow the data formulas', () => {
  const c = Modules.ctxFromSheet({ level: 5, proficiency_bonus: 3, abilities: { str: 15, dex: 8 }, spells: { ability: 'cha' }, initiative_bonus: 2 });
  assert.equal(c.best, Math.max(c.str, c.dex));
  assert.equal(c.atk, c.best + 3);
  assert.equal(c.atk_str, c.str + 3);
  assert.equal(c.dc, 8 + 3 + c.spell_mod);
  assert.equal(c.init, c.dex + 2);
});

test('formulas accept a caller-supplied name set and reject names outside it', () => {
  assert.equal(F.evaluate('@atk + 1', { atk: 4 }, { allowed: { atk: true } }), 5);
  assert.equal(F.evaluate('@atk + 1', { atk: 4 }, { allowed: { dc: true } }), null);
  assert.equal(F.evaluate('@str + 1', { str: 2 }), 3, 'sheet variables still work by default');
});
