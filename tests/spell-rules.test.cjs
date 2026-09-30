const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/spell-rules.js', 'utf8'), ctx);
const R = ctx.window.SpellRules;
const plain = value => JSON.parse(JSON.stringify(value));
const modulesCtx = { window: {} }; vm.createContext(modulesCtx);
vm.runInContext(fs.readFileSync('static/modules.js', 'utf8'), modulesCtx);
const Modules = modulesCtx.window.Modules;

test('модуль заклинания задаёт обычный расход по умолчанию и сохраняет индивидуальную стоимость/заряды из справочника', () => {
  const fresh = Modules.newSpell(); assert.equal(fresh.cast_cost, null); assert.equal(fresh.use_cost, 1); assert.equal(fresh.uses, null);
  const imported = Modules.spellFromCompendium({ name: 'Особое заклинание', data: { level: 2, cast_cost: 'uses', use_cost: 2, uses: { cur: 3, max: 4, recharge: 'long' } } });
  assert.equal(imported.cast_cost, 'uses'); assert.equal(imported.use_cost, 2); assert.deepEqual(plain(imported.uses), { cur: 3, max: 4, recharge: 'long' });
});

test('обычные заклинания расходуют ровно одну ячейку подходящего круга; upcast и отсутствующий ресурс', () => {
  const spells = { slots: { 1: { max: 2, used: 2 }, 2: { max: 1, used: 0 } } };
  assert.deepEqual(plain(R.slotPool(spells, { level: 1 })), [{ pool: 'slots', level: 2, remaining: 1 }]);
  assert.deepEqual(plain(R.spend(spells, { level: 1 }, { pool: 'slots', level: 2 })), { ok: true, cost: 'slots', level: 2 });
  assert.equal(spells.slots[2].used, 1);
  assert.equal(R.spend(spells, { level: 1 }, { pool: 'slots', level: 2 }).ok, false);
  assert.equal(R.spend(spells, { level: 3 }, { pool: 'slots', level: 2 }).ok, false);
});

test('заговор бесплатный, ритуал может не тратить ячейку, если заклинание помечено ритуальным', () => {
  const spells = { slots: {} };
  assert.equal(R.castCost({ level: 0, cast_cost: 'slot' }), 'free', 'заговор не расходует ячейку даже при некорректном старом значении');
  assert.deepEqual(plain(R.spend(spells, { level: 0 })), { ok: true, cost: 'free', level: 0 });
  assert.deepEqual(plain(R.spend(spells, { level: 1, ritual: true }, { ritual: true })), { ok: true, cost: 'ritual', level: 1 });
  assert.equal(R.spend(spells, { level: 1, ritual: false }, { ritual: true }).ok, false);
});

test('ячейки Договора независимы от обычных, а заданный расход зарядов проверяется и списывается', () => {
  const spells = { slots: { 2: { max: 1, used: 0 } }, pact_slots: { level: 2, max: 2, used: 0 } };
  assert.deepEqual(plain(R.slotPool(spells, { level: 1 })), [
    { pool: 'slots', level: 2, remaining: 1 }, { pool: 'pact_slots', level: 2, remaining: 2 }
  ]);
  assert.deepEqual(plain(R.spend(spells, { level: 1 }, { pool: 'pact_slots', level: 2 })), { ok: true, cost: 'pact_slots', level: 2 });
  const chargeSpell = { level: 1, cast_cost: 'uses', use_cost: 2, uses: { cur: 3, max: 3, recharge: 'short' } };
  assert.deepEqual(plain(R.spend(spells, chargeSpell)), { ok: true, cost: 'uses', amount: 2 });
  assert.equal(chargeSpell.uses.cur, 1);
  assert.equal(R.spend(spells, chargeSpell).ok, false);
});

test('короткий отдых восстанавливает ячейки Договора, но не обычные ячейки; долгий отдых — обе группы', () => {
  const sheet = { slots: { 1: { max: 2, used: 1 } }, pact_slots: { level: 2, max: 2, used: 2 }, known: [] };
  const features = [{ uses: { cur: 0, max: 1, recharge: 'short' } }, { uses: { cur: 0, max: 2, recharge: 'long' } }];
  const short = R.restore(sheet, features, 'short');
  assert.deepEqual(plain(short), { slots: 0, pactSlots: 2, features: 1, spellUses: 0 });
  assert.equal(sheet.slots[1].used, 1); assert.equal(sheet.pact_slots.used, 0); assert.equal(features[1].uses.cur, 0);
  const long = R.restore(sheet, features, 'long');
  assert.deepEqual(plain(long), { slots: 1, pactSlots: 0, features: 1, spellUses: 0 });
  assert.equal(sheet.slots[1].used, 0); assert.equal(features[0].uses.cur, 1); assert.equal(features[1].uses.cur, 2);
});

test('кости хитов списываются только в доступном количестве, долгий отдых возвращает до половины общего запаса', () => {
  const counts = { 8: 2, 10: 2 }, used = { 8: 1, 10: 2 };
  const spend = R.spendHitDice(used, counts, 8, 1);
  assert.deepEqual(plain(spend), { ok: true, used: { 8: 2, 10: 2 }, spent: 1 });
  assert.equal(R.spendHitDice(spend.used, counts, 8, 1).ok, false);
  const recovered = R.recoverHitDice(used, counts);
  assert.deepEqual(plain(recovered), { used: { 8: 1, 10: 0 }, recovered: 2 });
  assert.deepEqual(plain(R.recoverHitDice({}, counts)), { used: { 8: 0, 10: 0 }, recovered: 0 });
});

test('заряды заклинаний восстанавливаются по типу отдыха', () => {
  const spells = { slots: {}, known: [
    { uses: { cur: 0, max: 1, recharge: 'short' } },
    { uses: { cur: 0, max: 2, recharge: 'long' } },
    { uses: { cur: 0, max: 3, recharge: 'dawn' } }
  ] };
  R.restore(spells, [], 'short'); assert.deepEqual(plain(spells.known.map(s => s.uses.cur)), [1, 0, 0]);
  R.restore(spells, [], 'long'); assert.deepEqual(plain(spells.known.map(s => s.uses.cur)), [1, 2, 0]);
});
