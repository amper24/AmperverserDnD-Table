// Стиль кнопки действия: параметр style узла «Начало действия» проходит валидацию и попадает в программу v1.
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el: (t, a = {}, ...c) => ({ tag: t, attrs: a, children: c.flat() }), toast() {} };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
const G = ctx.window.Mechanics;
const startOf = g => g.graph.nodes.find(n => n.type === 'action.program');

test('button style is a validated start-node parameter that reaches the v1 program', async () => {
  await presetsReady;
  const g = JSON.parse(JSON.stringify(G.starter('race')));
  const start = startOf(g);
  assert.equal(G.validate(g), '', 'без стиля граф валиден');
  assert.ok(!('style' in G.toLegacy(g).programs.find(p => p.id === start.params.program_id)), 'стиль по умолчанию не пишется в программу');
  start.params.style = 'spell';
  assert.equal(G.validate(g), '', 'известный стиль валиден');
  const legacy = G.toLegacy(g).programs.find(p => p.id === start.params.program_id);
  assert.equal(legacy.style, 'spell');
  start.params.style = 'neon';
  assert.notEqual(G.validate(g), '', 'неизвестный стиль отклоняется');
});
