const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console };
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/node-registry.js', 'static/node-menu.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));

test('every node definition has a category and the menu lists only registry nodes', () => {
  const types = Object.keys(R.NODE_DEFS).filter(type => !R.INTERNAL.has(type));
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => item.type)));
  assert.deepEqual(listed.slice().sort(), types.slice().sort());
  for (const type of types) assert.ok(R.categoryOf(type).id, type);
});

test('menu categories cover the agreed groups in order', () => {
  const titles = plain(R.catalog('').map(section => section.title));
  for (const title of ['Данные', 'Условия', 'Поток управления', 'Бой', 'Эффекты', 'Ресурсы', 'Персонаж']) assert.ok(titles.includes(title), title);
  const order = plain(R.catalog('').map(section => section.id));
  assert.ok(order.indexOf('data') < order.indexOf('conditions'));
});

test('search matches labels and categories case-insensitively and returns nothing for nonsense', () => {
  const found = plain(R.catalog('УСЛОВИ').flatMap(section => section.items.map(item => item.type)));
  assert.ok(found.length > 0);
  assert.ok(found.every(type => R.categoryOf(type).id === 'conditions' || R.categoryOf(type).id === 'resources'), found.join(','));
  assert.deepEqual(plain(R.catalog('zzz-no-such-node-zzz')), []);
});

test('sockets are compatible only with identical types', () => {
  assert.equal(R.sameType('number', 'number'), true);
  assert.equal(R.sameType('number', 'text'), false);
  assert.equal(R.sameType(undefined, undefined), false);
});

test('registry does not expose internal group sockets in the menu', () => {
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => item.type)));
  for (const type of R.INTERNAL) assert.ok(!listed.includes(type), type);
});

test('context menu add sections come from the registry and return the chosen node type', () => {
  const sections = plain(ctx.window.NodeMenu.addSections('число'));
  assert.ok(sections.length > 0);
  const item = ctx.window.NodeMenu.addSections('число')[0].items[0];
  assert.deepEqual(plain(item.run()), { type: item.hint });
  assert.ok(R.NODE_DEFS[item.hint], item.hint);
});
