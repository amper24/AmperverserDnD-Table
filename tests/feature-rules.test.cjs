// Классификация особенностей классов: набор feature_rules по редакции.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ctx = { window: {} }; vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(async () => { await presetsReady; });

test('наборы feature_rules есть для обеих редакций и читаются по редакции', () => {
  const P = ctx.window.Presets;
  assert.equal(P.items('feature_rules', '2014').length, 9);
  assert.equal(P.items('feature_rules', '2024').length, 9);
  const kinds = P.items('feature_rules', '2014').map(i => i.table.kind).sort();
  assert.ok(kinds.includes('invocation') && kinds.includes('enemy') && kinds.includes('terrain'));
});
