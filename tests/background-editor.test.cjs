// Регрессия редактора предыстории (static/background-editor.js): чтение/запись записи, узлы графа
// (rule.skill_proficiency, rule.skills, rule.proficiencies, rule.languages, rule.feature) и проекция
// правок в мастера создания персонажа. Скрипт запускается в vm со стабом DOM и наборами данных.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { console, crypto: require('node:crypto').webcrypto, window: {}, localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
  matchMedia: () => ({ matches: false }), location: { host: 'test', protocol: 'http:', pathname: '/', href: '' },
  navigator: { language: 'ru' }, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL, structuredClone };
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
const FILES = ['common.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'node-params-form.js', 'node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'mechanics-graph.js', 'modules.js', 'class-rules.js', 'character-builder.js', 'background-editor.js'];
for (const f of FILES) vm.runInContext(fs.readFileSync(path.isAbsolute(f) ? f : 'static/' + f, 'utf8'), ctx, { filename: f });

const BE = ctx.window.BackgroundEditor;
const M = ctx.window.Mechanics;
const B = ctx.window.CharacterBuilder;
const plain = x => JSON.parse(JSON.stringify(x));
const nodesOfType = (d, type) => (d.mechanics?.graph?.nodes || []).filter(n => n.type === type);
const entryOf = (data, name = 'Прислужник') => ({ id: 'b1', category: 'background', name, source: 'SRD 2014', data });
const seed14 = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8')).filter(e => e.category === 'background');
const seed24 = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8')).filter(e => e.category === 'background');
const acolyte = seed14.find(e => e.slug === 'srd14-acolyte');

test('круг чтения и записи: правки доходят до узлов и не теряют данные записи', () => {
  const st = BE.readState(acolyte);
  assert.deepEqual(plain(st.skills.fixed), ['Проницательность', 'Религия'], 'навыки читаются из узла');
  assert.equal(st.feature.name, 'Умение: Приют верующих', 'умение читается из полей записи');
  assert.equal(st.languagesCount, 2, '«любые два языка» — число в записи SRD');
  assert.ok(st.character.ideals.length > 0, 'идеалы читаются из записи');

  st.skills.fixed.push('Медицина');
  st.skills.choose = 1;
  st.skills.from = ['История', 'Природа'];
  st.tools = ['Инструменты каллиграфа'];
  st.languages = ['Общий'];
  st.equipment = 'Одежда обычная ×1';
  st.feature.text = 'Новый текст умения.';
  const out = BE.writeData(st, entryOf(acolyte.data, acolyte.name));

  assert.deepEqual(plain(nodesOfType(out, 'rule.skill_proficiency')[0].params.value), ['Проницательность', 'Религия', 'Медицина']);
  assert.deepEqual(plain(out.skills), ['Проницательность', 'Религия', 'Медицина'], 'поле data.skills идёт в ногу с узлом');
  const choice = nodesOfType(out, 'rule.skills')[0];
  assert.equal(choice.params.id, 'bg_skills_choice');
  assert.equal(choice.params.count, 1);
  assert.deepEqual(plain(choice.params.options), ['История', 'Природа']);
  const tools = nodesOfType(out, 'rule.proficiencies').find(n => n.params.kind === 'Инструменты');
  assert.deepEqual(plain(tools.params.value), ['Инструменты каллиграфа']);
  assert.deepEqual(plain(nodesOfType(out, 'rule.languages')[0].params.value), ['Общий']);
  const featureNode = nodesOfType(out, 'rule.feature')[0];
  assert.equal(featureNode.params.name, 'Умение: Приют верующих');
  assert.equal(featureNode.params.text, 'Новый текст умения.');
  assert.equal(out.feature_text, 'Новый текст умения.');
  assert.equal(out.equipment, 'Одежда обычная ×1');
  assert.equal(M.validate(out.mechanics) || '', '', 'граф записи остаётся валидным');
  // Прочие поля записи (характер, описание) не пропали.
  assert.ok(out.ideals.length > 0 && out.personality_traits.length > 0);
});

test('пустая предыстория собирает валидный граф без лишних узлов', () => {
  const st = BE.readState(entryOf(BE.emptyData('2024'), 'Своя предыстория'));
  assert.equal(st.edition, '2024');
  assert.deepEqual(plain(st.skills.fixed), []);
  const out = BE.writeData(st, entryOf(BE.emptyData('2024'), 'Своя предыстория'));
  assert.equal(out.mechanics.version, 2);
  assert.deepEqual(plain(out.mechanics.graph.nodes.map(n => n.type)), [], 'узлы появляются только под данные');
  assert.equal(out.skills, undefined);
  assert.equal(out.feature, undefined);
  assert.equal(M.validate(out.mechanics) || '', '');
});

test('мастер создания видит правки предыстории: навыки, инструменты и умение', () => {
  const st = BE.readState(acolyte);
  st.skills.fixed = ['Скрытность'];
  st.tools = ['Воровские инструменты'];
  const data = BE.writeData(st, entryOf(acolyte.data, acolyte.name));
  const draft = { name: 'Тест', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])),
    selected: { background: entryOf(data, acolyte.name) }, catalog: [], spells: [], method: 'standard' };
  const sheet = B.build(draft);
  assert.ok(sheet.skills.includes('stealth'), 'навык предыстории попал на лист');
  assert.match(String(sheet.proficiencies), /Воровские инструменты/);
  assert.ok(sheet.features.some(f => /Приют верующих/.test(f.name)), 'умение предыстории попало в лист');
});

test('записи SRD 2024: черта и характеристики на выбор читаются и пишутся', () => {
  const sage = seed24.find(e => e.slug === 'srd24-sage');
  const st = BE.readState(sage);
  assert.equal(st.feat, 'Посвящённый в магию');
  assert.deepEqual(plain(st.asiOptions), ['ТЕЛ', 'ИНТ', 'МДР']);
  assert.deepEqual(plain(st.skills.fixed), ['Магия', 'История']);
  const out = BE.writeData(st, entryOf(sage.data, sage.name));
  assert.equal(out.feat, 'Посвящённый в магию', 'черта не потерялась при сохранении');
  assert.deepEqual(plain(out.asi_options), ['ТЕЛ', 'ИНТ', 'МДР']);
  assert.deepEqual(plain(out.skills), ['Магия', 'История']);
  assert.equal(out.name_en, 'Sage');
  assert.equal(M.validate(out.mechanics) || '', '');
});
