const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const window = {};
vm.runInNewContext(fs.readFileSync('static/core/pack-dependencies.js', 'utf8'), { window });
const Packs = window.PackDependencies;

test('character pack dependencies include modules, items, spells, and snapshots without duplicates', () => {
  const deps = Array.from(Packs.fromSheet({
    modules: [
      { pack_id: 'pack-a', source: 'Amber Rules', snapshot: { pack_id: 'pack-a' } },
      { snapshot: { pack_id: 'pack-b', source: 'Blue Bestiary' } },
      { pack_id: 'pack-a', pack_name: 'Amber Rules' },
    ],
    inventory: [{ pack_id: 'pack-c', source: 'Copper Gear' }],
    spells: { known: [{ pack_id: 'pack-d', pack_name: 'Dusk Spells' }] },
    features: [{ pack_id: null }],
  }), ({ id, name }) => `${id}:${name}`);
  assert.deepEqual(deps, [
    'pack-a:Amber Rules',
    'pack-b:Blue Bestiary',
    'pack-c:Copper Gear',
    'pack-d:Dusk Spells',
  ]);
});

test('missing dependencies are computed against campaign-enabled packs', () => {
  const missing = Packs.missing({ modules: [{ pack_id: 'disabled', source: 'Extra Rules' }] }, [{ id: 'enabled' }]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'disabled');
  assert.equal(Packs.label(missing[0]), 'Extra Rules');
});
