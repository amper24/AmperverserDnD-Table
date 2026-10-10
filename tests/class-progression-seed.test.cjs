const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// SRD: таблица развития каждого класса приходит из узла rule.class_progression записи в data_seed,
// и совпадает с набором static/presets/class-progression-<редакция>.json (запасной вариант для старых снимков).
const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js',
  'static/node-registry.js', 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
const M = ctx.window.Mechanics;
const plain = v => JSON.parse(JSON.stringify(v));

for (const edition of ['2014', '2024']) {
  const classes = JSON.parse(fs.readFileSync(`data_seed/srd_${edition}.json`, 'utf8')).filter(e => e.category === 'class');
  test(`SRD ${edition}: each class has a rule.class_progression node equal to the preset table`, async () => {
    await presetsReady;
    assert.equal(classes.length, 12);
    for (const c of classes) {
      const key = c.data.name_en.toLowerCase();
      assert.equal(M.validate(c.data.mechanics), '', c.slug);
      const node = c.data.mechanics.graph.nodes.find(n => n.type === 'rule.class_progression');
      assert.ok(node, `${c.slug}: узел есть`);
      assert.deepEqual(plain(M.classProgression(c.data.mechanics, edition)), plain(ctx.window.Presets.classProgression(edition, key)), `${c.slug}: таблица совпала`);
    }
  });
  test(`SRD ${edition}: a class record without the node gives null, so callers fall back to the preset set`, async () => {
    await presetsReady;
    const c = classes[0];
    const stripped = plain(c.data.mechanics);
    stripped.graph.nodes = stripped.graph.nodes.filter(n => n.type !== 'rule.class_progression');
    assert.equal(M.classProgression(stripped, edition), null);
    assert.ok(ctx.window.Presets.classProgression(edition, c.data.name_en.toLowerCase()), 'запасная таблица есть');
  });
}
