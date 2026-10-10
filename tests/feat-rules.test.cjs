// Правила черт из наборов feat_rules: группы, прибавка характеристики, требования.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {}, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' } };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
vm.runInContext(fs.readFileSync('static/levelup.js', 'utf8'), ctx);
before(async () => { await presetsReady; });
const L = ctx.window.LevelUp;
const seed = ed => JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`, 'utf8')).filter(e => e.category === 'feat');
const feats = { 2014: seed(2014), 2024: seed(2024) };
const byEn = (ed, en) => feats[ed].find(f => f.data.name_en === en);
const sheet = (o = {}) => ({ abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, features: [], ...o });
const at = (to, features = []) => ({ total: { to }, features });

test('наборы черт есть для обеих редакций, правила читаются по редакции записи', () => {
  assert.equal(ctx.window.Presets.items('feat_rules', '2014').length, 1);
  assert.equal(ctx.window.Presets.items('feat_rules', '2024').length, 14);
});

test('группы стилей боя и эпических даров совпадают с набором', () => {
  const style = feats[2024].filter(f => L.isStyleFeat(f)).map(f => f.data.name_en.toLowerCase()).sort();
  assert.deepEqual(style.map(s => s.replace(/[- ]/g, '')), ['archery', 'defense', 'greatweaponfighting', 'twoweaponfighting']);
  // Эпические дары: записи набора с группой epic — это бусты с минимальным уровнем 19.
  const epic = feats[2024].filter(f => (L.featRuleOf(f).groups || []).includes('epic'));
  assert.equal(epic.length, 7);
  for (const f of epic) assert.equal(L.featRuleOf(f).requires.level, 19, f.name);
  // Служебная черта «Увеличение характеристик» — группа asi, скрыта из списка черт.
  assert.ok((L.featRuleOf(byEn(2024, 'Ability Score Improvement')).groups || []).includes('asi'));
});

test('прибавка характеристики берётся из набора', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(L.featAbilityRule(byEn(2024, 'Grappler')))), { amount: 1, max: 20, allowed: ['str', 'dex'] });
  assert.equal(L.featAbilityRule(byEn(2024, 'Archery')), null);
  assert.equal(L.featAbilityRule(byEn(2014, 'Grappler')), null);
});

test('требования: уровень, боевой стиль и сила', () => {
  const boon = byEn(2024, 'Boon of the Night Spirit');
  assert.equal(L.featPrerequisitesMet(boon, at(18), sheet()), false);
  assert.equal(L.featPrerequisitesMet(boon, at(19), sheet()), true);

  const archery = byEn(2024, 'Archery');
  assert.equal(L.featPrerequisitesMet(archery, at(4), sheet()), false);
  assert.equal(L.featPrerequisitesMet(archery, at(4, [{ name: 'Боевой стиль: Защита' }]), sheet()), true);
  assert.equal(L.featPrerequisitesMet(archery, at(4), sheet({ features: [{ name: 'Fighting Style: Archery' }] })), true);

  const grappler14 = byEn(2014, 'Grappler');
  assert.equal(L.featPrerequisitesMet(grappler14, at(1), sheet({ abilities: { str: 12 } })), false);
  assert.equal(L.featPrerequisitesMet(grappler14, at(1), sheet({ abilities: { str: 13 } })), true);
});

test('черта без правила в наборе ничем не ограничена; в коде нет жёсткого списка стилей', () => {
  assert.equal(L.isStyleFeat({ name: 'Своя', data: { name_en: 'Custom', edition: '2024' } }), false);
  assert.equal(L.featPrerequisitesMet({ name: 'Своя', data: { name_en: 'Custom', edition: '2024' } }, at(1), sheet()), true);
  const src = fs.readFileSync('static/levelup.js', 'utf8');
  assert.ok(!src.includes('STYLE_FEATS_EN'));
  assert.ok(!src.includes("'archery', 'defense'"));
});
