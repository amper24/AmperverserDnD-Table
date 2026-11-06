const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(api) {
  const ctx = { window: { API: api, toast: () => {} }, API: api, console: { warn() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/core/character-hp.js', 'utf8'), ctx);
  return ctx.window.CharacterHp;
}

test('sheet/token HP normalization understands both data shapes and zero HP', () => {
  const hp = load({});
  assert.deepEqual(JSON.parse(JSON.stringify(hp.fromSheet({ current: 0, max: 12 }))), { cur: 0, max: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(hp.fromToken({ cur: 4, max: 12 }, { temp: 3 }))), { temp: 3, current: 4, max: 12 });
  assert.equal(hp.same({ cur: 0, max: 12 }, { current: 0, max: 12 }), true);
  assert.equal(hp.same({ cur: 1, max: 12 }, { current: 0, max: 12 }), false);
});

test('token HP is patched against the latest character revision without replacing other sheet fields', async () => {
  let character = { id: 'c1', revision: 7, sheet: { _revision: 7, hp: { current: 9, max: 12, temp: 2 }, notes: 'keep' } };
  let body;
  const api = {
    async get() { return structuredClone(character); },
    async patch(_url, value) {
      body = structuredClone(value);
      character = { ...character, revision: 8, sheet: { ...value.sheet, _revision: 8 } };
      return structuredClone(character);
    },
  };
  const hp = load(api);
  await hp.write('c1', { cur: 0, max: 10 });
  assert.deepEqual(JSON.parse(JSON.stringify(body.sheet.hp)), { current: 0, max: 10, temp: 2 });
  assert.equal(body.sheet.notes, 'keep');
  assert.equal(body.sheet._revision, 7);
  assert.equal(character.sheet.hp.current, 0);
});

test('matching HP does not issue a redundant character write', async () => {
  let patches = 0;
  const api = {
    async get() { return { id: 'c1', revision: 3, sheet: { _revision: 3, hp: { current: 5, max: 8 } } }; },
    async patch() { patches++; },
  };
  await load(api).write('c1', { cur: 5, max: 8 });
  assert.equal(patches, 0);
});

test('a revision conflict is retried from a fresh sheet revision', async () => {
  let reads = 0, patches = 0;
  let character = { id: 'c1', revision: 1, sheet: { _revision: 1, hp: { current: 8, max: 10 }, notes: 'newer' } };
  const api = {
    async get() { reads++; return structuredClone(character); },
    async patch(_url, value) {
      patches++;
      if (patches === 1) {
        character = { ...character, revision: 2, sheet: { ...character.sheet, _revision: 2, traits: { updated: true } } };
        const error = new Error('conflict'); error.status = 409; throw error;
      }
      assert.equal(value.sheet._revision, 2);
      character = { ...character, revision: 3, sheet: { ...value.sheet, _revision: 3 } };
    },
  };
  await load(api).write('c1', { cur: 6, max: 10 });
  assert.equal(reads, 2);
  assert.equal(patches, 2);
  assert.equal(character.sheet.hp.current, 6);
  assert.deepEqual(character.sheet.traits, { updated: true });
});
