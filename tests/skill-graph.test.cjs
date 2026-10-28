// Навыки работают на графах, как остальные объекты справочника: запись навыка несёт граф
// с узлом rule.list (kind: skill_proficiency), и владение приходит из проекции графа, а не из отдельного поля.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ctx = { window: {}, crypto: require('node:crypto').webcrypto, console };
vm.createContext(ctx);
for (const file of ['static/common.js', 'static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js',
  'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
}
const M = ctx.window.Mechanics;
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));
const SKILLS = plain(ctx.window.SKILLS);
const ENTRIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data_seed', 'skills.json'), 'utf8'));

test('запись навыка: граф с узлом rule.list (kind: skill_proficiency), который понимает и клиент, и сервер', () => {
  assert.equal(ENTRIES.length, SKILLS.length, 'по записи на каждый навык листа');
  assert.ok(R.NODE_DEFS['rule.list'], 'узел есть в реестре клиента');
  assert.equal(R.NODE_DEFS['rule.list'].label, 'Список');
  assert.equal(R.RULE_LIST_KINDS.skill_proficiency, 'Владение навыком');
  for (const e of ENTRIES) {
    const nodes = e.data?.mechanics?.graph?.nodes || [];
    assert.equal(e.data.mechanics.version, 2, `${e.name}: граф v2`);
    const grant = nodes.filter(n => n.type === 'rule.list' && n.params?.kind === 'skill_proficiency');
    assert.equal(grant.length, 1, `${e.name}: один узел владения`);
    assert.deepEqual(plain(grant[0].params.value), [e.name], `${e.name}: владение своим названием`);
    assert.equal(M.validate(e.data.mechanics) || '', '', `${e.name}: граф без ошибок`);
  }
});

test('проекция графа навыка даёт владение ключом листа', () => {
  const perception = ENTRIES.find(e => e.data.key === 'perception');
  const sheet = { edition: '2014', level: 1, skills: [], proficiencies: '', languages: [], features: [], saving_throws: [], abilities: {}, hp: { max: 0, current: 0, temp: 0 } };
  const applied = M.applyGraphRules(perception.data.mechanics, sheet, { edition: '2014', level: 1, source: perception.name });
  assert.equal(applied.error, '');
  assert.deepEqual(plain(sheet.skills), ['perception'], 'владение пришло ключом, как его хранит лист');
  assert.ok(applied.effects.some(x => x.kind === 'skill_proficiency'), 'эффект графа помечен');
});

test('узел принимает и ключ, и русское название, а лишнее отвергает', () => {
  const def = R.NODE_DEFS['rule.list'];
  assert.equal(def.validate({ kind: 'skill_proficiency', value: ['Восприятие', 'stealth'] }), '');
  assert.match(def.validate({ kind: 'skill_proficiency', value: 'Восприятие' }) || '', /./, 'список, а не строка');
  assert.match(def.validate({ kind: 'skill_proficiency', value: Array.from({ length: 19 }, (_, i) => `н${i}`) }) || '', /18/);
  const sheet = { edition: '2014', level: 1, skills: [], proficiencies: '', languages: [], features: [], saving_throws: [], abilities: {}, hp: { max: 0, current: 0, temp: 0 } };
  M.applyGraphRules({ version: 2, graph: { nodes: [{ id: 'n1', type: 'rule.list', params: { kind: 'skill_proficiency', value: ['Восприятие', 'stealth'] } }], links: [], frames: [], groups: [] } }, sheet, { edition: '2014', level: 1 });
  assert.deepEqual(plain(sheet.skills), ['perception', 'stealth']);
});

test('узел виден в палитре правил персонажа', () => {
  const listed = plain(R.catalog('').flatMap(section => section.items.map(item => ({ type: item.type, label: item.label, group: section.title }))));
  const node = listed.find(x => x.type === 'rule.list');
  assert.ok(node, 'узел есть в палитре');
  assert.equal(node.label, 'Список');
  assert.equal(node.group, R.CATEGORIES.find(c => c.id === R.categoryOf('rule.list').id).title);
  assert.ok(R.NODE_DEFS['rule.list'].isRule, 'узел — правило персонажа');
});
