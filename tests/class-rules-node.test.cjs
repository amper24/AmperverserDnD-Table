// Правила класса из узла rule.class_rules графа записи: узел перекрывает набор, без узла работает набор.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js', 'static/class-rules.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
}
const R = ctx.window.ClassRules, M = ctx.window.Mechanics;
before(async () => { await presetsReady; R.refresh(); });

const wizard = () => JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8')).find(r => r.category === 'class' && r.data?.name_en === 'Wizard');

test('SRD-запись класса несёт узел rule.class_rules с кастерами и мультиклассом', () => {
  const rec = wizard();
  const node = rec.data.mechanics.graph.nodes.find(n => n.type === 'rule.class_rules');
  assert.ok(node, 'узел есть');
  assert.equal(node.params.table.caster.level, 'full');
  assert.equal(node.params.table.multiclass.requirements[0][0], 'int');
  assert.equal(node.params.table.ru, undefined, 'русское название не уходит в узел');
  assert.equal(node.params.table.legacy_unarmored, undefined);
});

test('узел перекрывает набор: кастер из графа записи, а не из набора', () => {
  const rec = wizard();
  const copy = JSON.parse(JSON.stringify(rec));
  copy.data.mechanics.graph.nodes.find(n => n.type === 'rule.class_rules').params.table.caster = { level: 'half', picker: true };
  assert.equal(R.casterLevel(copy, '2014'), 'half');
  assert.equal(R.isPicker(copy, '2014'), true);
  assert.equal(R.casterLevel(rec, '2014'), 'full', 'исходная запись не изменилась');
});

test('запись без узла берёт правила из набора по slug и редакции', () => {
  const entry = { name: 'Волшебник', data: { name_en: 'Wizard', edition: '2014' } };
  assert.equal(R.casterLevel(entry, '2014'), 'full');
  assert.equal(R.startMode(entry, '2014'), 'book');
  assert.equal(R.startMode(entry, '2024'), 'book');
});

test('правила по редакции: паладин 2014 считает подготовку, 2024 не получает правило 2014', () => {
  const paladin = { name: 'Паладин', data: { name_en: 'Paladin' } };
  assert.equal(R.preparedFormula(paladin, '2014'), 'half');
  assert.equal(R.preparedFormula(paladin, '2024'), '');
  assert.equal(R.startMode(paladin, '2024'), 'prepared');
});

test('граф с узлом rule.class_rules проходит валидацию и отдаёт таблицу', () => {
  const rec = wizard();
  assert.ok(!M.validate(rec.data.mechanics), M.validate(rec.data.mechanics));
  const table = M.classRules(rec.data.mechanics, '2014');
  assert.equal(table.caster.level, 'full');
});
