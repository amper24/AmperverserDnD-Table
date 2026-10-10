// Классификация особенностей классов: набор feature_rules по редакции.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ctx = { window: {} }; vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(async () => { await presetsReady; });

test('наборы feature_rules есть для обеих редакций и читаются по редакции', () => {
  const P = ctx.window.Presets;
  assert.equal(P.items('feature_rules', '2014').length, 11);
  assert.equal(P.items('feature_rules', '2024').length, 11);
  const kinds = P.items('feature_rules', '2014').map(i => i.table.kind).sort();
  assert.ok(kinds.includes('invocation') && kinds.includes('enemy') && kinds.includes('terrain'));
});

test('levelup.js не содержит регулярок классификации особенностей', () => {
  const src = require('node:fs').readFileSync('static/levelup.js', 'utf8');
  for (const name of ['RE_ASI', 'RE_EPIC', 'RE_EXPERT', 'RE_SECRETS', 'RE_MANUAL']) assert.ok(!src.includes(name), name);
  assert.ok(!src.includes("'Таинственные воззвания '"));
});
