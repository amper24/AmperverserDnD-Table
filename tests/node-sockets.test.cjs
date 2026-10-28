// Система узлов механик v2: согласованность портов и работоспособность каждого узла меню.
// Проверяем то, что видит мастер в редакторе: любой вход можно подключить, любой выход — использовать,
// у каждого правила есть проекция, у каждого вычисляемого узла — вычисление, а форма параметров строится.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat(); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = {
  window: {}, crypto: require('node:crypto').webcrypto, el, toast() {},
  document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } },
  ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' },
  SKILLS: [['acrobatics', 'Акробатика', 'dex'], ['stealth', 'Скрытность', 'dex']],
};
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
const R = ctx.window.NodeRegistry;
const NF = ctx.window.NodeForm;
const clone = value => JSON.parse(JSON.stringify(value));
const listed = () => clone(R.catalog('').flatMap(section => section.items.map(item => item.type)));
// Параметры, которые мастер заполняет сам: пустой узел из меню сразу показывает, чего не хватает.
const REQUIRED = {
  'condition.choice': { id: 'styleChoice', value: 'duelist' },
  'condition.subclass': { id: 'champion' },
  'action.program': { program_id: 'p1', name: 'Действие', trigger: 'use' },
  'group.input': { socket_id: 'in' },
  'group.output': { socket_id: 'out' },
};
const paramsOf = type => ({ ...clone(R.NODE_DEFS[type].defaults || {}), ...(REQUIRED[type] || {}) });
const sheetFixture = () => ({ edition: '2014', level: 1, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, race: '', class: '', subclass: '', speed: 30,
  hp: { max: 0, current: 0, temp: 0, hit_dice: '' }, features: [], saving_throws: [], skills: [], skill_choices: [], languages: [], proficiencies: '',
  spells: { ability: '', slots: {}, known: [] }, spell_rules: [], spell_progression: { slots: {} }, asi_rules: [], class_progression: null, class_rules: null, armor_formula: '', manual_rules: [] });

test('меню добавления совпадает с реестром, внутренние узлы групп скрыты', () => {
  const exposed = Object.keys(R.NODE_DEFS).filter(type => !R.INTERNAL.has(type));
  assert.deepEqual(listed().slice().sort(), exposed.slice().sort(), 'в меню ровно по одному пункту на каждый узел');
  for (const type of R.INTERNAL) assert.ok(!listed().includes(type), `${type} — служебный узел границы группы`);
  for (const type of listed()) assert.ok(R.NODE_DEFS[type].label, `${type}: подпись узла есть`);
});

test('характеристику и навык задаёт один узел — дублей значений нет', () => {
  assert.ok(R.NODE_DEFS['data.stat']);
  assert.equal(R.NODE_DEFS['data.ability'], undefined, 'узел «Характеристика» удалён: значение характеристики берёт data.stat');
  assert.equal(R.NODE_DEFS['data.choice'], undefined, 'узел «Выбор» удалён: выборы при создании задаёт data.choices записи, выбор навыков — rule.list (kind: skills)');
  assert.equal(listed().filter(type => type === 'data.stat').length, 1);
});

test('каждый вход кто-то производит, каждый выход кто-то принимает', () => {
  const produced = new Map(), consumed = new Map();
  for (const [type, def] of Object.entries(R.NODE_DEFS)) {
    for (const kind of Object.values(def.outputs || {})) produced.set(kind, [...(produced.get(kind) || []), type]);
    for (const kind of Object.values(def.inputs || {})) consumed.set(kind, [...(consumed.get(kind) || []), type]);
  }
  for (const [kind, types] of consumed) assert.ok(produced.has(kind), `вход «${kind}» (${types.join(', ')}) невозможно подключить: значения этого типа никто не выдаёт`);
  for (const [kind, types] of produced) {
    if (kind === 'effect') continue; // эффект правила — конечный результат, его читает проекция листа
    assert.ok(consumed.has(kind), `выход «${kind}» (${types.join(', ')}) некуда подключить: такого входа нет ни у одного узла`);
  }
  for (const [kind, types] of consumed) assert.ok(R.VALUE_TYPES.includes(kind), `тип сокета «${kind}» (${types.join(', ')}) есть в списке VALUE_TYPES`);
});

test('умолчания узлов проходят проверку, правила и вычисления работают', () => {
  for (const [type, def] of Object.entries(R.NODE_DEFS)) {
    const params = paramsOf(type);
    const error = typeof def.validate === 'function' ? def.validate(params) : '';
    assert.equal(error, '', `${type}: умолчания узла должны быть допустимыми`);
    assert.ok(typeof def.label === 'string' && def.label.length, `${type}: подпись`);
    assert.ok(typeof def.group === 'string' && def.group.length, `${type}: группа меню`);
  }
  const sheet = sheetFixture(), emitted = new Set();
  // У одного узла rule.value шесть видов: каждый вид обязан пройти проверку и дать эффект на лист.
  const valueParams = {
    ability: { kind: 'ability', ability: 'dex', amount: 1 },
    speed: { kind: 'speed', amount: 30 },
    hp: { kind: 'hp', amount: 2 },
    hit_die: { kind: 'hit_die', value: 'd8' },
    asi: { kind: 'asi', table: { 1: { str: 1 } } },
    armor_formula: { kind: 'armor_formula', formula: '10+@dex' },
  };
  assert.deepEqual(Object.keys(valueParams).sort(), Object.keys(R.RULE_VALUE_KINDS).sort(), 'проверены все виды rule.value');
  // У одного узла rule.list десять видов: каждый вид обязан пройти проверку и дать эффект на лист.
  const listParams = {
    languages: { kind: 'languages', value: ['Общий'] },
    proficiencies: { kind: 'proficiencies', label: 'Доспехи', value: ['Лёгкие доспехи'] },
    skill_proficiency: { kind: 'skill_proficiency', value: ['Восприятие'] },
    saving_throws: { kind: 'saving_throws', value: ['str', 'con'] },
    skills: { kind: 'skills', id: 'classSkills', count: 2, options: ['stealth', 'acrobatics'] },
    spell_list: { kind: 'spell_list', mode: 'known', ability: 'int', spells: [] },
    feature: { kind: 'feature', name: 'Умение', text: '' },
    class_features: { kind: 'class_features', table: { levels: { '1': [{ name: 'Умение', text: '' }] } } },
    equipment: { kind: 'equipment', items: [{ name: 'Дорожная одежда', qty: 1 }] },
    equipment_choice: { kind: 'equipment_choice', id: 'gear', title: 'Выберите снаряжение', options: [{ name: 'Вариант А', items: [{ name: 'Дорожная одежда', qty: 1 }], gold: 0 }] },
  };
  assert.deepEqual(Object.keys(listParams).sort(), Object.keys(R.RULE_LIST_KINDS).sort(), 'проверены все виды rule.list');
  // У одного узла rule.class четыре вида: таблица развития, правила класса, ячейки и характеристика заклинаний.
  const classParams = {
    class_progression: { kind: 'class_progression', table: { columns: [], levels: { '1': { pb: 2 } } } },
    class_rules: { kind: 'class_rules', table: { caster: { level: 'full' }, multiclass: { requirements: [] } } },
    spell_slots: { kind: 'spell_slots', table: { levels: { '1': { slots: [2] } } } },
    spellcasting: { kind: 'spellcasting', ability: 'int' },
  };
  assert.deepEqual(Object.keys(classParams).sort(), Object.keys(R.RULE_CLASS_KINDS).sort(), 'проверены все виды rule.class');
  for (const [type, def] of Object.entries(R.NODE_DEFS)) {
    if (typeof def.compute === 'function') {
      assert.doesNotThrow(() => def.compute(paramsOf(type), () => undefined), `${type}: вычисление не падает`);
    }
    if (!type.startsWith('rule.')) continue;
    const variants = type === 'rule.value' ? Object.values(valueParams) : type === 'rule.list' ? Object.values(listParams)
      : type === 'rule.class' ? Object.values(classParams) : [paramsOf(type)];
    for (const params of variants) {
      const error = typeof def.validate === 'function' ? def.validate(params) : '';
      assert.equal(error, '', `${type} ${params.kind || ''}: параметры правила допустимы`);
      const context = { edition: '2014', level: 1, subclass: '', choices: {}, source: '', nodeId: 'n1', effects: [] };
      const env = { get: () => undefined, value: key => params[key] ?? params.value, emit: (kind, data = {}) => context.effects.push({ kind, ...clone(data) }),
        sheet, context, clone, valuesOf: value => Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value],
        appendProficiency() {}, normalizeEquipmentItems: () => [], normalizeEquipmentOptions: () => [] };
      assert.doesNotThrow(() => def.project(params, env), `${type} ${params.kind || ''}: проекция не падает`);
      assert.ok(context.effects.length, `${type} ${params.kind || ''}: правило сообщает результат на лист`);
    }
    emitted.add(type);
  }
  assert.deepEqual([...emitted].sort(), Object.keys(R.NODE_DEFS).filter(type => type.startsWith('rule.')).sort(),
    'каждый узел правил персонажа проверен');
});

test('неизвестный вид правила отклоняется, спасброски проверяются по характеристикам', () => {
  assert.equal(R.NODE_DEFS['rule.class'].validate({ kind: 'unknown' }), 'Класс: неизвестный вид.');
  assert.equal(R.NODE_DEFS['rule.list'].validate({ kind: 'saving_throws', value: ['str', 'luck'] }), 'Спасброски должны быть списком характеристик.');
  assert.equal(R.NODE_DEFS['rule.list'].validate({ kind: 'saving_throws', value: ['str', 'con'] }), '');
});

test('форма параметров строится для каждого узла меню', () => {
  for (const type of listed()) {
    assert.doesNotThrow(() => NF.nodeParams({ id: 'n1', type, params: paramsOf(type) }), `${type}: форма параметров строится`);
  }
});
