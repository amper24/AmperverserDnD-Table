// Реестр типов ассетов: клиент и сервер согласованы, а литералы типов не возвращаются в интерфейс.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/asset-kinds.js', 'utf8'), ctx);
const AK = ctx.window.AssetKinds;
const plain = value => JSON.parse(JSON.stringify(value));

test('server list ASSET_KINDS matches the client registry', () => {
  const rust = fs.readFileSync('src/assets.rs', 'utf8');
  const match = rust.match(/const ASSET_KINDS: &\[&str\] = &\[([^\]]*)\];/);
  assert.ok(match, 'ASSET_KINDS constant exists');
  const serverIds = [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(serverIds, plain(AK.ids), 'same ids in the same order');
  assert.ok(rust.includes('ASSET_KINDS.contains(&kind.as_str())'), 'upload checks the constant, not a literal list');
});

test('the picker lists and labels come from the registry', () => {
  assert.deepEqual(plain(AK.filterOptions()), [['', 'Все типы'], ['map', 'Карты'], ['token', 'Токены'], ['prop', 'Объекты'], ['portrait', 'Портреты']]);
  assert.deepEqual(plain(AK.uploadOptions()), [['map', 'Карта'], ['token', 'Токен'], ['prop', 'Объект'], ['portrait', 'Портрет']]);
  assert.equal(AK.label('portrait'), 'Портрет');
  assert.equal(AK.label('unknown-kind'), 'Токен', 'unknown kinds behave like tokens');
});

test('table layers come from the registry, with the old routing kept', () => {
  assert.equal(AK.layerOf('map'), 'map');
  assert.equal(AK.layerOf('prop'), 'prop');
  assert.equal(AK.layerOf('token'), 'character');
  assert.equal(AK.layerOf('portrait'), 'character');
  assert.equal(AK.layerOf('item'), 'character');
  assert.equal(AK.get('prop').square, true);
  assert.equal(AK.get('map').square, false);
});

test('app.js and table.js no longer hard-code asset kind lists or routing', () => {
  const app = fs.readFileSync('static/app.js', 'utf8');
  const table = fs.readFileSync('static/table.js', 'utf8');
  for (const literal of ["['map', 'Карты']", "['token', 'Токены']", "['prop', 'Объекты']", "['portrait', 'Портреты']", "['token', 'Токен']", "{ map: 'карта'"]) {
    assert.ok(!app.includes(literal), `app.js has no literal ${literal}`);
  }
  assert.ok(!table.includes("a.kind === 'map' ? 'map'"), 'table.js does not route by literal kind');
  assert.ok(app.includes('AssetKinds.filterOptions()') && app.includes('AssetKinds.uploadOptions()'));
  assert.ok(table.includes('AssetKinds.layerOf(a.kind)'));
});

test('usage roles resolve to registry kinds, so call sites name no kind literals', () => {
  assert.equal(AK.forUsage('token'), 'token');
  assert.equal(AK.forUsage('avatar'), 'portrait');
  assert.equal(AK.forUsage('item'), 'item');
  assert.equal(AK.forUsage('unknown-usage'), AK.DEFAULT);
  assert.equal(AK.DEFAULT, 'token');
});

test('table layer maps to the kind uploaded on that layer', () => {
  assert.equal(AK.kindForLayer('map'), 'map');
  assert.equal(AK.kindForLayer('character'), 'token');
  assert.equal(AK.kindForLayer('prop'), 'prop');
  assert.equal(AK.kindForLayer('no-such-layer'), AK.DEFAULT);
});
