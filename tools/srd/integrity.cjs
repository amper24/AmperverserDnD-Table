#!/usr/bin/env node
// ---------------------------------------------------------------------------
// integrity.cjs — проверка целостности встроенного справочника SRD
// (data_seed/srd_2014.json, data_seed/srd_2024.json) и соответствия клиента
// серверу (static/node-registry.js ↔ src/mechanics_graph.rs).
//
// Запуск:   node tools/srd/integrity.cjs [--edition 2014,2024] [--json] [--quiet] [--max 20]
// Библиотека: module.exports = { runAll, checkSeed, checkRuntime, REPO }
//
// Уровни: error — данные противоречат схеме, ссылкам или движку; warn — подозрительно,
// но может быть намеренным (например, одинаковый слаг в разных категориях).
// Ничего не исправляет: отчёт с ID сущности, путём к полю и рекомендацией.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..', '..');
const EDITIONS = ['2014', '2024'];
const CATEGORIES = ['race', 'class', 'background', 'item', 'spell', 'monster', 'npc', 'feat', 'condition', 'lore'];
const SEED_CATEGORIES = ['race', 'class', 'background', 'item', 'spell', 'monster', 'feat', 'condition'];
const RUNTIME_NODE_FILES = require('../nodes/node-loader.cjs').nodeFiles().map(f => path.relative(REPO, f).split(path.sep).join('/'));
const RUNTIME_FILES = ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...RUNTIME_NODE_FILES, 'static/mechanics-graph.js'];
const CJK_CYR = /[\u0400-\u04FF]/;
const LATIN = /[A-Za-z]/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
}

// ---------- рантайм клиента: реестр узлов, валидатор графа, движок бросков ----------
// Список навыков и характеристики — из static/common.js (словари загружаются в первом слое,
// поэтому берём только их объявления, а не весь файл с DOM-зависимостями).
function commonDictionaries() {
  const text = fs.readFileSync(path.join(REPO, 'static/common.js'), 'utf8');
  const pick = (name) => {
    const m = text.match(new RegExp(`window\\.${name}\\s*=\\s*(\\[[\\s\\S]*?\\n\\]|\\{[\\s\\S]*?\\});`));
    if (!m) throw new Error(`не найден window.${name} в static/common.js`);
    return vm.runInNewContext(`(${m[1]})`);
  };
  return { SKILLS: pick('SKILLS'), ABIL: pick('ABIL') };
}

function loadRuntime() {
  const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
  vm.createContext(ctx);
  const { SKILLS, ABIL } = commonDictionaries();
  ctx.window.SKILLS = SKILLS;
  ctx.window.ABIL = ABIL;
  for (const file of RUNTIME_FILES) vm.runInContext(fs.readFileSync(path.join(REPO, file), 'utf8'), ctx, { filename: file });
  return ctx.window;
}

// Константы сервера (единственный источник списка типов узлов для сохранения записи).
function rustConstants() {
  const src = fs.readFileSync(path.join(REPO, 'src/mechanics_graph.rs'), 'utf8');
  const list = name => {
    const m = src.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
    if (!m) throw new Error(`не найдена константа ${name} в src/mechanics_graph.rs`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  };
  return {
    NODE_TYPES: list('NODE_TYPES'), ABILITIES: list('ABILITIES'), ACTIONS: list('ACTIONS'),
    ROLL_KINDS: list('ROLL_KINDS'), LOGIC_OPS: list('LOGIC_OPS'),
    FIELD_KINDS: list('FIELD_KINDS'), VALUE_FIELDS: list('VALUE_FIELDS'), FORMULA_FIELDS: list('FORMULA_FIELDS'),
    DICE_ACTIONS: list('DICE_ACTIONS'), SKILL_IDS: list('SKILL_IDS'), BUTTON_STYLES: list('BUTTON_STYLES'), SOCKET_TYPES: list('SOCKET_TYPES'),
  };
}

class Report {
  constructor() { this.issues = []; this.stats = {}; }
  add(level, check, entity, field, message, hint) {
    this.issues.push({ level, check, entity, field, message, hint: hint || '' });
  }
  error(check, entity, field, message, hint) { this.add('error', check, entity, field, message, hint); }
  warn(check, entity, field, message, hint) { this.add('warn', check, entity, field, message, hint); }
  get errors() { return this.issues.filter(i => i.level === 'error'); }
  get warnings() { return this.issues.filter(i => i.level === 'warn'); }
}

const isStr = v => typeof v === 'string';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = v => isNum(v) && Number.isInteger(v);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isArr = Array.isArray;
const nameOf = e => e.name;

// Технические токены характеристик: короткие формы из tools/srd/ru_names.py (ABIL),
// их показывает лист персонажа в чипе «СЛ … ЛОВ» (static/modules.js).
const ABILITY_CODES = ['СИЛ', 'ЛОВ', 'ТЕЛ', 'ИНТ', 'МДР', 'ХАР'];
// Тип урона — отображаемая строка (dtype/damage_type), сравнений по ней в коде нет.
const DAMAGE_TYPES_RU = ['кислота', 'дробящий', 'холод', 'огонь', 'силовое поле', 'электричество', 'некротический', 'колющий', 'яд', 'психический', 'излучение', 'рубящий', 'звук'];
// Написания, встречавшиеся в корпусе переводов: тип урона в полях монстра писали по-разному
// («Гром» в 2014 и «Громовой» в 2024 вместо «Звук»). Канон — общий словарь проекта (DAMAGE_TYPES_RU).
const DAMAGE_TYPES_VARIANTS = { 'гром': 'звук', 'громовой': 'звук', 'звуковой': 'звук', 'огненный': 'огонь', 'холодный': 'холод', 'кислотный': 'кислота', 'электрический': 'электричество', 'ядовитый': 'яд', 'некротическая энергия': 'некротический' };

/// Типы урона в русском тексте → английские имена (для сверки русского поля монстра с английским слоем).
function damageKeysRu(text) {
  const out = new Set();
  const low = String(text || '').toLowerCase();
  for (const term of [...DAMAGE_TYPES_RU, ...Object.keys(DAMAGE_TYPES_VARIANTS)]) {
    if (new RegExp(`(^|[^а-яё])${term}([^а-яё]|$)`, 'i').test(low)) out.add(DAMAGE_TYPES_EN[DAMAGE_TYPES_VARIANTS[term] || term]);
  }
  return out;
}

function damageKeysEn(text) {
  const out = new Set();
  const low = String(text || '').toLowerCase();
  for (const en of Object.values(DAMAGE_TYPES_EN)) {
    if (new RegExp(`(^|[^a-z])${en}([^a-z]|$)`).test(low)) out.add(en);
  }
  return out;
}

const DAMAGE_TYPES_EN = { 'кислота': 'acid', 'дробящий': 'bludgeoning', 'холод': 'cold', 'огонь': 'fire', 'силовое поле': 'force', 'электричество': 'lightning', 'некротический': 'necrotic', 'колющий': 'piercing', 'яд': 'poison', 'психический': 'psychic', 'излучение': 'radiant', 'рубящий': 'slashing', 'звук': 'thunder' };
// Карты «ключ — содержимое»: в английском слое ключи намеренно английские (умения классов),
// поэтому висячий ключ там не ошибка (см. src/i18n.rs merge и docs/localization.md).
const NAME_KEYED_MAPS = ['feature_texts'];
// Вынужденный спасбросок в русском тексте: «совершает спасбросок Ловкости», а не «преимущество на спасброски».
const FORCED_SAVE_RU = /(?:соверша\w+|совершить|преуспе\w+|провалит\w*|долж\w+|обязан\w*)\b[^.!?]{0,60}спасброс\w*[^.!?]{0,25}(?:СИЛ|ЛОВ|ТЕЛ|ИНТ|МДР|ХАР|Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)/i;

// Подстановка переменных листа: формулы должны оставаться бросками и после подстановки 0.
const stripVars = expr => String(expr).replace(/@[a-z_0-9]+/gi, '0').replace(/\{\{[^}]*\}\}/g, '0');

// ---------- проверка одной редакции ----------

// ---------- пресеты классов (запасные таблицы развития, static/levelup.js::progression) ----------
const presetCache = new Map();
function presetFor(edition) {
  if (!presetCache.has(edition)) {
    try { presetCache.set(edition, readJson(`static/presets/class-progression-${edition}.json`)); }
    catch { presetCache.set(edition, { items: [] }); }
  }
  return presetCache.get(edition);
}

function rulesPresetFor(edition) {
  const key = `class-rules-${edition}`;
  if (!presetCache.has(key)) {
    try { presetCache.set(key, readJson(`static/presets/${key}.json`)); }
    catch { presetCache.set(key, { items: [] }); }
  }
  return presetCache.get(key);
}

/// Таблица правил класса в той форме, в которой она лежит в узле (см. add_class_progression_nodes.cjs).
function rulesNodeTable(table) {
  if (!table) return null;
  return {
    ...(table.caster ? { caster: table.caster } : {}),
    multiclass: { requirements: table.multiclass?.requirements || [] },
    ...(table.weapon_mastery !== undefined ? { weapon_mastery: table.weapon_mastery } : {}),
  };
}

/// Расхождение таблиц развития: null, если объект уровней совпадает, иначе описание первого различия.
function progressionDiff(nodeLevels, presetLevels) {
  const levels = new Set([...Object.keys(nodeLevels), ...Object.keys(presetLevels)]);
  for (const level of [...levels].sort((a, b) => Number(a) - Number(b))) {
    const a = nodeLevels[level] || {}, b = presetLevels[level] || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const av = JSON.stringify(a[key] ?? null), bv = JSON.stringify(b[key] ?? null);
      if (av !== bv) return `уровень ${level}, поле «${key}»: в узле ${av}, в пресете ${bv}`;
    }
  }
  return null;
}

function checkSeed(edition, opts = {}) {
  const runtime = opts.runtime || loadRuntime();
  const rust = opts.rust || rustConstants();
  const report = new Report();
  const file = `data_seed/srd_${edition}.json`;
  const rows = readJson(file);
  const DiceEngine = runtime.DiceEngine;
  const Mechanics = runtime.Mechanics;

  // Состояния редакции: пары «русское название — английское» из самих записей категории condition.
  const conditionPairs = rows.filter(r => r.category === 'condition')
    .map(r => [r.name, ((r.data.i18n || {}).en || {}).name]).filter(([, en]) => isStr(en));
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }
  report.stats.records = rows.length;
  report.stats.categories = Object.fromEntries([...byCategory].map(([c, list]) => [c, list.length]));
  for (const category of byCategory.keys()) {
    if (!CATEGORIES.includes(category)) report.error('category-known', `${category}`, 'category', `категория «${category}» не входит в CATEGORIES (src/compendium.rs)`);
  }
  for (const category of SEED_CATEGORIES) {
    if (!byCategory.has(category)) report.warn('category-expected', `${edition}`, 'category', `в наборе нет записей категории «${category}»`);
  }

  const namesByCategory = new Map([...byCategory].map(([c, list]) => [c, new Set(list.map(nameOf))]));
  const spellNames = namesByCategory.get('spell') || new Set();
  const itemNames = namesByCategory.get('item') || new Set();
  const classNames = namesByCategory.get('class') || new Set();
  const raceNames = namesByCategory.get('race') || new Set();
  const subclassIds = new Set();
  for (const c of byCategory.get('class') || []) for (const s of c.data.subclasses || []) if (s && isStr(s.name_en)) subclassIds.add(s.name_en);
  const itemTypes = new Set(), schools = new Set(), damageTypes = new Set(), weaponMasteries = new Set(), conditions = new Set(), properties = new Set(), languages = new Set();
  for (const row of rows) {
    const d = row.data;
    if (row.category === 'item') { if (isStr(d.type)) itemTypes.add(d.type); if (isStr(d.damage_type)) damageTypes.add(d.damage_type); if (isStr(d.mastery)) weaponMasteries.add(d.mastery); for (const p of d.properties || []) properties.add(String(p).replace(/\s*\(.*\)$/, '')); }
    if (row.category === 'spell') { if (isStr(d.school)) schools.add(d.school); if (isStr(d.damage_type)) damageTypes.add(d.damage_type); }
    if (row.category === 'condition') conditions.add(row.name);
    if (row.category === 'race') for (const l of d.languages || []) if (isStr(l) && l.length < 40) languages.add(l);
  }
  report.stats.distinct = { item_types: [...itemTypes].sort(), schools: [...schools].sort(), damage_types: [...damageTypes].sort(), weapon_masteries: [...weaponMasteries].sort() };

  // ---- 1. базовая форма записи ----
  const seen = new Map();
  for (const row of rows) {
    const id = `${row.category}/${row.slug}`;
    const where = `#${id}`;
    for (const key of ['category', 'slug', 'name', 'data']) {
      if (!(key in row)) report.error('record-shape', where, key, `в записи нет обязательного поля «${key}»`);
    }
    if (!isObj(row.data)) { report.error('record-shape', where, 'data', 'data должен быть объектом'); continue; }
    if (!isStr(row.slug) || !/^srd\d\d-[a-z0-9()-]+$/.test(row.slug)) report.error('record-shape', where, 'slug', `слаг «${row.slug}» не вида srd14-…/srd24-…`);
    else if (/[^a-z0-9-]/.test(row.slug)) report.warn('record-shape', where, 'slug', `в слаге «${row.slug}» есть символы вне [a-z0-9-] — такие ссылки требуют кодирования в URL`);
    if (isStr(row.slug) && !row.slug.startsWith(`srd${edition.slice(2)}-`)) report.error('edition-consistency', where, 'slug', `слаг не соответствует файлу редакции ${edition}`);
    if (!isStr(row.name) || !row.name.trim()) report.error('record-shape', where, 'name', 'пустое название');
    else {
      if (row.name.length > 128) report.error('record-shape', where, 'name', 'название длиннее 128 символов (лимит util::truncate в src/compendium.rs)');
      if (LATIN.test(row.name)) report.error('localization', where, 'name', `в русском названии «${row.name}» есть латиница`);
    }
    const dup = seen.get(id);
    if (dup) report.error('duplicate-id', where, 'slug', `ID «${id}» повторяется (записи №${dup} и текущая)`);
    else seen.set(id, rows.indexOf(row));
    const bare = seen.get(`*/${row.slug}`);
    if (!bare) seen.set(`*/${row.slug}`, where);
    else if (bare !== where) report.warn('duplicate-slug-cross-category', where, 'slug', `слаг «${row.slug}» встречается и в ${bare}; ключ БД — (категория, слаг), ссылки обязаны учитывать категорию`);
    if (row.data.edition !== edition) report.error('edition-consistency', where, 'data.edition', `data.edition=«${row.data.edition}», ожидалось «${edition}»`);
    const en = row.data.i18n && row.data.i18n.en;
    if (!isObj(en)) report.error('localization', where, 'data.i18n.en', 'нет английского слоя перевода');
    else {
      const enName = en.name;
      if (!isStr(enName) || !enName.trim()) report.error('localization', where, 'data.i18n.en.name', 'нет английского названия');
      else if (CJK_CYR.test(enName)) report.error('localization', where, 'data.i18n.en.name', `кириллица в английском названии «${enName}»`);
    }
  }

  // ---- 2. поля и типы по категориям ----
  // present — поле обязано быть; allowEmpty — пустая строка допустима (например, у оружия нет описания);
  // level:'warn' — отсутствие допустимо, но подозрительно.
  const checkFields = (row, fields) => {
    const where = `#${row.category}/${row.slug}`;
    for (const [key, test, opts = {}] of fields) {
      const value = key.split('.').reduce((o, k) => (isObj(o) ? o[k] : undefined), row.data);
      const emit = opts.level === 'warn' ? report.warn.bind(report) : report.error.bind(report);
      if (value === undefined || value === null) { emit(opts.check || 'required-field', where, `data.${key}`, opts.message || `нет поля data.${key}`, opts.hint); continue; }
      if (isStr(value) && !value.trim() && !opts.allowEmpty) { emit('empty-text', where, `data.${key}`, `пустое значение data.${key}`, opts.hint); continue; }
      if (test && !test(value)) report.error('field-type', where, `data.${key}`, `data.${key} имеет неверный тип (${Array.isArray(value) ? 'array' : typeof value})`);
    }
  };
  // Английский вид не должен показывать русский текст: у отображаемых полей обязан быть слой en.
  const checkEnCoverage = (row, key, value, message) => {
    if (value === undefined || value === null || (isStr(value) && !value.trim())) return;
    const en = row.data.i18n && row.data.i18n.en;
    if (!isObj(en) || en[key] === undefined) report.warn('localization', `#${row.category}/${row.slug}`, `data.i18n.en.${key}`, message || `нет английского значения для data.${key} — английский вид покажет русский текст`);
  };
  const enAction = (row) => {
    const en = row.data.i18n && row.data.i18n.en;
    const list = en && (en['actions!'] || en.actions);
    return isArr(list) ? list : null;
  };
  for (const row of rows) {
    const d = row.data, where = `#${row.category}/${row.slug}`;
    if (row.category === 'spell') {
      checkFields(row, [['level', isInt], ['school', isStr], ['casting_time', isStr], ['range', isStr],
        ['components', isStr, { allowEmpty: true, level: 'warn', message: 'в источнике 5e-database у заклинания нет компонентов (пробел источника)' }],
        ['duration', isStr], ['concentration', v => typeof v === 'boolean'], ['ritual', v => typeof v === 'boolean'], ['classes', isArr], ['desc', isStr]]);
      if (isInt(d.level) && (d.level < 0 || d.level > 9)) report.error('field-range', where, 'data.level', `уровень заклинания ${d.level} вне 0…9`);
      if (isStr(d.school) && !schools.has(d.school)) report.error('enum-values', where, 'data.school', `школа «${d.school}» не встречается в наборе`);
      if (isStr(d.damage_type) && !DAMAGE_TYPES_RU.includes(d.damage_type)) report.error('enum-values', where, 'data.damage_type', `неизвестный тип урона «${d.damage_type}»`);
      for (const cls of d.classes || []) if (!classNames.has(cls)) report.error('broken-reference', where, 'data.classes', `заклинание ссылается на класс «${cls}», которого нет в редакции ${edition}`, 'проверьте CLASSES в tools/srd/ru_names.py и список классов SRD');
      if (d.save_ability !== undefined && !ABILITY_CODES.includes(d.save_ability)) report.error('enum-values', where, 'data.save_ability', `неизвестный код характеристики спасброска «${d.save_ability}» (ожидается одно из ${ABILITY_CODES.join('/')})`);
      const saveText = `${d.desc || ''} ${d.higher_level || ''}`;
      const hasSaveAction = (d.actions || []).some(a => a && a.kind === 'save');
      if (!d.save_ability && !hasSaveAction && FORCED_SAVE_RU.test(saveText)) report.warn('spell-save-missing', where, 'data.save_ability', 'текст вынуждает спасбросок с характеристикой, но нет ни save_ability, ни действия kind=save', 'сверьте с официальным текстом SRD и заполните tools/srd/fix_spell_saves.py');
      if (isStr(d.damage_type)) checkEnCoverage(row, 'damage_type');
      for (const [i, action] of (d.actions || []).entries()) {
        if (!isObj(action)) { report.error('field-type', where, `data.actions[${i}]`, 'действие должно быть объектом'); continue; }
        if (!isStr(action.name) || !action.name.trim()) report.error('required-field', where, `data.actions[${i}].name`, 'у действия нет названия');
        if (!isStr(action.kind) || !action.kind.trim()) report.error('required-field', where, `data.actions[${i}].kind`, 'у действия нет вида');
        if (!isStr(action.roll) || !action.roll.trim()) report.error('required-field', where, `data.actions[${i}].roll`, 'у действия нет формулы');
        else { try { DiceEngine.parse(stripVars(action.roll)); } catch (e) { report.error('dice-expression', where, `data.actions[${i}].roll`, `формула «${action.roll}» не разбирается: ${e.message}`); } }
        if (isStr(action.dtype) && !DAMAGE_TYPES_RU.includes(action.dtype)) report.error('enum-values', where, `data.actions[${i}].dtype`, `неизвестный тип урона «${action.dtype}»`);
      }
      const enActions = enAction(row);
      if (enActions) for (const [i, action] of enActions.entries()) {
        if (isStr(action.dtype) && CJK_CYR.test(action.dtype)) report.warn('localization', where, `data.i18n.en.actions[${i}].dtype`, `в английском виде остался русский тип урона «${action.dtype}» (ожидается ${DAMAGE_TYPES_EN[action.dtype] || '—'})`);
      }
    }
    if (row.category === 'item') {
      checkFields(row, [['type', isStr], ['category', isStr], ['desc', isStr, { allowEmpty: true }], ['edition', isStr]]);
      if (isStr(d.type) && !['weapon', 'armor', 'gear', 'consumable', 'magic', 'vehicle', 'tool', 'pack', 'treasure', 'mount'].includes(d.type)) report.warn('enum-values', where, 'data.type', `неизвестный тип предмета «${d.type}»`);
      if (isNum(d.weight) && d.weight < 0) report.error('field-range', where, 'data.weight', `отрицательный вес ${d.weight}`);
      if (d.ac !== undefined && !isNum(d.ac) && !isStr(d.ac)) report.error('field-type', where, 'data.ac', 'ac должен быть числом или строкой');
      if (isStr(d.damage_type) && !DAMAGE_TYPES_RU.includes(d.damage_type)) report.error('enum-values', where, 'data.damage_type', `неизвестный тип урона «${d.damage_type}»`);
      if (isStr(d.mastery) && !weaponMasteries.has(d.mastery)) report.error('enum-values', where, 'data.mastery', `мастерство оружия «${d.mastery}» неизвестно`);
      if (isStr(d.damage) && !/^\d+([кd]\d+)?$/.test(d.damage)) report.warn('field-format', where, 'data.damage', `формула урона «${d.damage}» не вида 1к8`);
      if (d.attunement !== undefined && typeof d.attunement !== 'boolean' && !isStr(d.attunement)) report.error('field-type', where, 'data.attunement', 'attunement должен быть boolean или строкой условия');
      if (isStr(d.damage_type)) checkEnCoverage(row, 'damage_type', `нет английского типа урона для «${d.damage_type}» (ожидается ${DAMAGE_TYPES_EN[d.damage_type] || '—'})`);
      if (d.edition !== edition) report.error('edition-consistency', where, 'data.edition', `data.edition=«${d.edition}»`);
    }
    if (row.category === 'monster') {
      checkFields(row, [['size', isStr], ['type', isStr], ['cr', v => isStr(v) || isNum(v)], ['xp', isNum], ['ac', isNum], ['hp', isStr], ['abilities', isObj], ['traits', isArr], ['actions', isArr]]);
      // Кнопок бросков нет — нормально, если в действиях нечего бросать (у жабы, морского конька, гриба-вопилки действий нет вовсе).
      const rollable = (d.actions || []).filter(a => /Attack(?: Roll)?:\s*\+\d|урон|Урон|\d+к\d+/.test(a && a.text || ''));
      if (!isArr(d.actions_roll) && rollable.length) report.warn('monster-actions-roll', where, 'data.actions_roll', `в действиях есть броски (${rollable.length}), но нет data.actions_roll`);
      const abilities = d.abilities || {};
      for (const key of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
        const v = abilities[key];
        if (!isInt(v) || v < 1 || v > 30) report.error('field-range', where, `data.abilities.${key}`, `характеристика ${key}=${v} вне 1…30`);
      }
      if (isStr(d.hp) && !/^\d+\s*\(/.test(d.hp)) report.warn('field-format', where, 'data.hp', `хиты «${d.hp}» не вида «9 (2к8)»`);
      const actionRollKinds = new Set(['attack', 'damage', 'heal', 'temp_hp', 'roll', 'save', 'other']);
      for (const a of d.actions_roll || []) {
        if (!isObj(a)) { report.error('field-type', where, 'data.actions_roll', 'элемент должен быть объектом'); continue; }
        if (!isStr(a.name) || !a.name.trim()) report.error('required-field', where, 'data.actions_roll[].name', 'у броска нет названия');
        if (!actionRollKinds.has(a.kind)) report.error('enum-values', where, 'data.actions_roll[].kind', `неизвестный вид броска «${a.kind}»`);
        if (!isStr(a.roll) || !a.roll.trim()) report.error('required-field', where, 'data.actions_roll[].roll', 'пустая формула броска');
        else { try { DiceEngine.parse(stripVars(a.roll)); } catch (e) { report.error('dice-expression', where, 'data.actions_roll[].roll', `формула «${a.roll}» не разбирается: ${e.message}`); } }
        if (isStr(a.dtype) && !DAMAGE_TYPES_RU.includes(a.dtype)) report.error('enum-values', where, 'data.actions_roll[].dtype', `неизвестный тип урона «${a.dtype}»`);
      }
      for (const key of ['traits', 'actions', 'reactions', 'legendary_actions']) {
        for (const t of d[key] || []) {
          if (!isObj(t) || !isStr(t.name) || !isStr(t.text)) report.error('field-type', where, `data.${key}`, `элемент ${key} должен быть {name, text}`);
          else if (!t.text.trim()) report.error('empty-text', where, `data.${key}`, `у «${t.name}» пустой текст`);
        }
      }
      // Имена умений — кросс-ссылки: на них смотрят выпадающие броски (actions_roll) и узлы графа
      // (params.feature_name). Переименование в одном месте ломает кнопки и механики записи.
      // Проверка идёт в блоке монстров и НИП: только у них `actions_roll` ссылается на `traits`/`actions`.
      // У классов, рас и происхождений `params.feature_name` ссылается на наборы умений (522 узла) —
      // их сверяет генератор наборов и тесты tests/class-*.test.cjs, здесь они не проверяются.
      const featureNames = new Set(['traits', 'actions', 'reactions', 'legendary_actions']
        .flatMap(key => (d[key] || []).filter(isObj).map(t => t.name)));
      for (const [i, a] of (d.actions_roll || []).entries()) {
        if (!isObj(a) || !isStr(a.name)) continue;
        const base = a.name.replace(/[:.]\s*(урон|Урон)?\s*$/, '').trim().replace(/\.$/, '');
        if (base && ![...featureNames].some(name => name.replace(/\.$/, '') === base))
          report.error('broken-feature-link', where, `data.actions_roll[${i}].name`, `бросок «${a.name}» не находит одноимённого умения`);
      }
      for (const [i, node] of ((d.mechanics?.graph?.nodes) || []).entries()) {
        const feature = node.params?.feature_name;
        if (isStr(feature) && !featureNames.has(feature))
          report.error('broken-feature-link', where, `data.mechanics.graph.nodes[${i}].params.feature_name`, `узел ссылается на умение «${feature}», которого нет в списке`);
      }
      const enRoll = (row.data.i18n && row.data.i18n.en && (row.data.i18n.en['actions_roll!'] || row.data.i18n.en.actions_roll)) || null;
      if (isArr(enRoll)) for (const [i, a] of enRoll.entries()) {
        if (isStr(a.dtype) && CJK_CYR.test(a.dtype)) report.warn('localization', where, `data.i18n.en.actions_roll[${i}].dtype`, `в английском виде остался русский тип урона «${a.dtype}»`);
      }
      // Защиты монстра: русское поле и английский слой перечисляют одни и те же термины, а состояние
      // не стоит в поле типов урона. Ловится и посторонний текст вместо терминов (голем из плоти).
      const enMon = (row.data.i18n && row.data.i18n.en) || null;
      for (const field of ['vulnerabilities', 'resistances', 'immunities']) {
        const ruText = isStr(d[field]) ? d[field] : '';
        const enText = isStr(enMon && enMon[field]) ? enMon[field] : '';
        if (!ruText && !enText) continue;
        const ruKeys = damageKeysRu(ruText), enKeys = damageKeysEn(enText);
        const same = ruKeys.size === enKeys.size && [...ruKeys].every(k => enKeys.has(k));
        if (!same) report.error('monster-defense-mismatch', where, `data.${field}`, `наборы типов урона в русском поле и английском слое разошлись: {${[...ruKeys].join(', ')}} ≠ {${[...enKeys].join(', ')}}`, 'сверьте с официальным дампом: python3 tools/srd/fix_monster_defenses.py');
        for (const [ruCond, enCond] of conditionPairs) if (new RegExp(`(^|[^а-яё])${ruCond.toLowerCase()}([^а-яё]|$)`).test(ruText.toLowerCase()))
          report.error('monster-defense-wrong-field', where, `data.${field}`, `в поле типов урона стоит состояние «${ruCond}» (EN ${enCond})`);
      }
      const ruCondText = isStr(d.condition_immunities) ? d.condition_immunities : '';
      const enCondText = isStr(enMon && enMon.condition_immunities) ? enMon.condition_immunities : '';
      if (ruCondText || enCondText) {
        const ruConds = new Set(), enConds = new Set();
        for (const [ruCond, enCond] of conditionPairs) {
          if (ruCondText.toLowerCase().includes(ruCond.toLowerCase())) ruConds.add(enCond);
          if (new RegExp(`(^|[^a-z])${enCond.toLowerCase()}([^a-z]|$)`).test(enCondText.toLowerCase())) enConds.add(enCond);
        }
        const sameConds = ruConds.size === enConds.size && [...ruConds].every(k => enConds.has(k));
        if (!sameConds) report.error('monster-defense-mismatch', where, 'data.condition_immunities', `наборы состояний в русском поле и английском слое разошлись: {${[...ruConds].join(', ')}} ≠ {${[...enConds].join(', ')}}`);
      }
    }
    if (row.category === 'class') {
      checkFields(row, [['hit_die', isStr], ['saves', isArr], ['skills', isObj], ['features', isObj], ['feature_texts', isObj], ['subclasses', isArr]]);
      if (isStr(d.hit_die) && !['d6', 'd8', 'd10', 'd12'].includes(d.hit_die)) report.error('enum-values', where, 'data.hit_die', `кость хитов «${d.hit_die}» не из d6/d8/d10/d12`);
      for (const s of d.saves || []) if (!['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(s)) report.error('enum-values', where, 'data.saves', `неизвестный спасбросок «${s}»`);
      if (isObj(d.skills)) {
        if (!isInt(d.skills.choose) || d.skills.choose < 0 || d.skills.choose > 18) report.error('field-range', where, 'data.skills.choose', `skills.choose=${d.skills.choose}`);
        for (const s of d.skills.from || []) if (!(runtime.SKILLS || []).some(([, ru]) => ru === s)) report.error('broken-reference', where, 'data.skills.from', `навык «${s}» не из списка SKILLS (static/common.js)`);
      }
      const featureNames = new Set(Object.values(d.features || {}).flat());
      for (const name of featureNames) if (!(name in (d.feature_texts || {}))) report.error('missing-feature-text', where, `data.feature_texts.${name}`, `у умения «${name}» нет текста`);
      const levels = Object.keys(d.features || {}).map(Number);
      if (levels.some(l => !Number.isInteger(l) || l < 1 || l > 20)) report.error('field-range', where, 'data.features', 'уровни умений должны быть целыми 1…20');
      if (levels.length && Math.min(...levels) !== 1) report.error('missing-feature-text', where, 'data.features', 'нет умений 1-го уровня');
      for (const s of d.subclasses || []) if (!isObj(s) || !isStr(s.name) || !isStr(s.name_en) || !s.name.trim()) report.error('field-type', where, 'data.subclasses', 'подкласс должен быть {name, name_en, …}');
      if (isStr(d.spellcasting) && !['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(d.spellcasting)) report.error('enum-values', where, 'data.spellcasting', `характеристика заклинаний «${d.spellcasting}»`);
      // Таблица развития класса живёт в узле rule.class (kind: class_progression) — её и читает лист, а встроенный
      // пресет static/presets/class-progression-<edition>.json — запасной вариант того же правила
      // (static/levelup.js::progression). Проверяем, что копии не разошлись.
      const classNode = (type, kind) => ((d.mechanics || {}).graph?.nodes || []).find(n => n && n.type === type && n.params?.kind === kind);
      const node = classNode('rule.class', 'class_progression');
      const presetRow = (presetFor(edition).items || []).find(it => it && it.id === row.slug.replace(/^srd\d+-/, ''));
      const nodeLevels = node?.params?.table?.levels;
      const presetLevels = presetRow?.table?.levels;
      if (nodeLevels && presetLevels) {
        const diff = progressionDiff(nodeLevels, presetLevels);
        if (diff) report.error('class-progression-mismatch', where, 'data.mechanics.graph.nodes[rule.class:class_progression].params.table.levels', diff);
      } else if (nodeLevels && !presetRow) {
        report.warn('class-progression-missing', where, 'static/presets/class-progression-' + edition + '.json', 'у класса есть таблица развития в узле, но нет записи в пресете (листу нечего взять в запасном варианте)');
      } else if (!nodeLevels && presetRow) {
        report.warn('class-progression-missing', where, 'data.mechanics.graph.nodes[rule.class:class_progression].params.table.levels', 'таблицы развития в узле нет: уровень берётся из пресета, а не из записи класса');
      }
      // Те же правила класса лежат в узле rule.class (kind: class_rules) — он первичен для листа (static/class-rules.js::rulesOf),
      // а набор class-rules-<редакция>.json — запасной вариант. Узел собирается из набора полями caster,
      // multiclass.requirements и weapon_mastery (tools/srd/add_class_progression_nodes.cjs): сверяем, что копии равны.
      const rulesRow = (rulesPresetFor(edition).items || []).find(it => it && it.id === row.slug.replace(/^srd\d+-/, ''));
      const rulesNode = classNode('rule.class', 'class_rules');
      const wantRules = rulesRow && rulesNodeTable(rulesRow.table);
      const gotRules = rulesNode && rulesNodeTable(rulesNode.params?.table);
      if (wantRules && gotRules) {
        const diff = JSON.stringify(wantRules) === JSON.stringify(gotRules) ? null
          : `в узле ${JSON.stringify(gotRules)}, в наборе ${JSON.stringify(wantRules)}`;
        if (diff) report.error('class-rules-mismatch', where, 'data.mechanics.graph.nodes[rule.class:class_rules].params.table', diff);
      } else if (wantRules && !rulesNode) {
        report.warn('class-rules-missing', where, 'data.mechanics.graph.nodes[rule.class:class_rules]', 'правил класса нет в узле: лист возьмёт их из набора');
      }
    }
    if (row.category === 'race') {
      // В дампе SRD 5.2.1 у видов нет описания: содержание — в traits. Пустой desc — не потеря данных.
      checkFields(row, [['asi', isObj], ['traits', isArr], ['desc', isStr, { allowEmpty: edition === '2024', level: edition === '2024' ? 'warn' : 'error', message: 'в источнике SRD у вида нет описания (текст — в traits)' }]]);
      for (const [k, v] of Object.entries(d.asi || {})) {
        if (!['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(k)) report.error('enum-values', where, `data.asi.${k}`, `неизвестная характеристика «${k}»`);
        if (!isInt(v) || v < -5 || v > 5) report.error('field-range', where, `data.asi.${k}`, `бонус характеристики ${v} вне −5…5`);
      }
      if (d.subrace === true) {
        if (!isStr(d.parent)) report.error('required-field', where, 'data.parent', 'у подрасы нет parent');
        else if (!raceNames.has(d.parent)) report.error('broken-reference', where, 'data.parent', `родительская раса «${d.parent}» не найдена в редакции ${edition}`);
      } else if (isArr(d.subraces) && d.subraces.length) {
        for (const s of d.subraces) if (!raceNames.has(s)) report.error('broken-reference', where, 'data.subraces', `подраса «${s}» не найдена в редакции ${edition}`);
      }
      for (const t of d.traits || []) if (!isObj(t) || !isStr(t.name) || !isStr(t.text)) report.error('field-type', where, 'data.traits', 'черта должна быть {name, text}');
    }
    if (row.category === 'background') {
      // Описание происхождения в дампе SRD лежит в feature/feature_text или отсутствует вовсе.
      checkFields(row, [['desc', isStr, { allowEmpty: edition === '2024' || edition === '2014', level: 'warn', message: 'в источнике SRD у происхождения нет поля описания (текст — в feature_text)' }], ['skills', v => isArr(v) || isObj(v)], ['tools', v => isArr(v) || isObj(v)]]);
      if (edition === '2024') {
        if (!isStr(d.feat) || !d.feat.trim()) report.error('required-field', where, 'data.feat', 'у происхождения 2024 нет черты');
        if (!isArr(d.asi_options) || !d.asi_options.length) report.error('required-field', where, 'data.asi_options', 'у происхождения 2024 нет набора asi_options');
      }
    }
    if (row.category === 'feat') {
      checkFields(row, [['desc', isStr], ['category', isStr, { allowEmpty: true }], ['prerequisites', isStr, { allowEmpty: true, level: 'warn', message: 'у черты нет требований (в источнике SRD их нет)' }]]);
    }
    if (row.category === 'condition') {
      checkFields(row, [['desc', isStr]]);
    }
  }

  // ---- 2б. тип урона в текстах: «звук», а не «гром»/«громовой» ----
  // Словарь листа знает только «звук» (DAMAGE_TYPES_RU), поэтому там, где ТЕКСТ называет тип урона,
  // перевод «громом» и «Громового урона» — расхождение с листом. Имена («Волна грома», «Громовой удар»,
  // свойства посоха) и явления («гремит гром», «громче») не трогаются: проверяется контекст, как в
  // tools/srd/fix_thunder_terms.py (тот же разбор, что и правка, — иначе правка и проверка разойдутся).
  const THUNDER_NAMES = ['волна грома', 'раскат грома', 'гром и молния', 'гром бури', 'громовой голос',
    'громовой удар', 'громовая булава', 'громовой заряд', 'громовой рёв', 'громовой раскат', 'громовой взрыв'];
  const THUNDER_NOUN = /(^|[^А-Яа-яЁё])([Гг]ром(?:ом|а|у|е)?)(?![а-яё])/gu;
  const THUNDER_ADJ = /(^|[^А-Яа-яЁё])([Гг]ромов[а-яё]*)(?![а-яё])(?=\s+[Уу]рон)/gu;
  const THUNDER_DAMAGE_WORD = /(урон[а-яё]*|уязвим[а-яё]*|иммунитет[а-яё]*|сопротивлени[а-яё]*|получа[а-яё]+)/gi;
  const thunderDamageContext = (text, index) => {
    const window = text.slice(Math.max(0, index - 120), index);
    let found = null;
    for (const match of window.matchAll(THUNDER_DAMAGE_WORD)) found = match;
    if (!found) return false;
    return !/[.;!?]/.test(window.slice(found.index + found[0].length));
  };
  const thunderTypeChoice = (text, index) => /для\s+типа/i.test(text.slice(index, index + 40));
  const thunderTableRow = (text, index, word) => {
    const start = text.lastIndexOf('\n', index) + 1, end = text.indexOf('\n', index);
    const cells = text.slice(start, end < 0 ? text.length : end).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    if (cells.length !== 2 && cells.length !== 3) return false;
    if (!/^\d+$/.test(cells[0]) || cells[1] !== word) return false;
    return /\|\s*(к10|1d10|d10)\s*\|\s*Тип урона\s*\|/.test(text.slice(Math.max(0, start - 400), start));
  };
  const thunderSkip = (text, start, end) => {
    const window = text.slice(Math.max(0, start - 25), end + 25).toLowerCase();
    if (THUNDER_NAMES.some(name => window.includes(name))) return true;
    const near = text.slice(Math.max(0, start - 14), end + 8);
    if (/[гГ]ром(кий|ко|че)|гремит\s+гром/i.test(near)) return true;
    const before = text.slice(Math.max(0, start - 3), start), after = text.slice(end, end + 2);
    return (after.startsWith('»') || before.endsWith('«') || (/[\n.]\s*$/.test(before) && after.startsWith('.')));
  };
  const thunderTexts = (row) => {
    const d = row.data, out = [];
    if (isStr(d.desc)) out.push(['data.desc', d.desc]);
    for (const key of ['traits', 'actions', 'reactions', 'legendary_actions', 'subclasses']) {
      for (const [i, item] of (d[key] || []).entries()) {
        const text = key === 'subclasses' ? item.desc : item.text;
        if (isStr(text)) out.push([`data.${key}[${i}]`, text]);
      }
    }
    for (const [name, text] of Object.entries(d.feature_texts || {})) if (isStr(text)) out.push([`data.feature_texts.${name}`, text]);
    for (const [i, node] of ((d.mechanics?.graph?.nodes) || []).entries()) if (isStr(node.params?.text)) out.push([`data.mechanics.graph.nodes[${i}].params.text`, node.params.text]);
    for (const field of ['vulnerabilities', 'resistances', 'immunities']) if (isStr(d[field])) out.push([`data.${field}`, d[field]]);
    return out;
  };
  for (const row of rows) {
    const where = `#${row.category}/${row.slug}`;
    for (const [field, text] of thunderTexts(row)) {
      for (const pattern of [THUNDER_NOUN, THUNDER_ADJ]) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const word = match[2], start = match.index + match[1].length, end = start + word.length;
          if (thunderSkip(text, start, end)) continue;
          if (pattern === THUNDER_NOUN) {
            const defenses = field.startsWith('data.vulnerabilities') || field.startsWith('data.resistances') || field.startsWith('data.immunities');
            const head = defenses ? text.slice(0, text.indexOf(';') < 0 ? text.length : text.indexOf(';')) : text;
            if (defenses && start > head.length) continue;
            if (!defenses && !thunderDamageContext(text, start) && !thunderTypeChoice(text, end) && !thunderTableRow(text, start, word)) continue;
          }
          report.error('thunder-term-drift', where, field, `тип урона назван «${word}», а словарь листа знает «звук» (${match[0].trim()})`, 'python3 tools/srd/fix_thunder_terms.py');
        }
      }
    }
  }

  // ---- 3. механики ----
  const mechanicsRows = rows.filter(r => r.data.mechanics !== undefined);
  report.stats.mechanics = mechanicsRows.length;
  const nodesUsed = new Map();
  for (const row of rows) {
    const where = `#${row.category}/${row.slug}`;
    const mechanics = row.data.mechanics;
    if (mechanics === undefined) continue;
    if (!isObj(mechanics) || mechanics.version !== 2) { report.error('mechanics-version', where, 'data.mechanics.version', `версия механику «${mechanics && mechanics.version}», ожидается 2 (граф v2)`); continue; }
    const problem = Mechanics.validate(mechanics);
    if (problem) report.error('mechanics-invalid', where, 'data.mechanics', problem);
    else {
      const list = Mechanics.problems(mechanics);
      for (const p of list) report.error('mechanics-problem', where, 'data.mechanics', p);
    }
    const graph = mechanics.graph || {};
    const ids = new Set();
    for (const node of graph.nodes || []) {
      if (ids.has(node.id)) report.error('duplicate-id', where, 'data.mechanics.graph.nodes', `ID узла «${node.id}» повторяется`);
      ids.add(node.id);
      nodesUsed.set(node.type, (nodesUsed.get(node.type) || 0) + 1);
      if (!rust.NODE_TYPES.includes(node.type)) report.error('unknown-node-type', where, `data.mechanics.graph.nodes[${node.id}]`, `тип узла «${node.type}» не поддерживается сервером (src/mechanics_graph.rs NODE_TYPES)`);
      if (node.type === 'action.roll') {
        const stat = node.params && node.params.dice && node.params.dice.stat;
        const STATS = ['', 'best', 'prof', 'atk', 'atk_str', 'atk_dex', 'spell', 'spell_mod', 'level', 'dc', 'str', 'dex', 'con', 'int', 'wis', 'cha'];
        if (stat !== undefined && !STATS.includes(stat)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.dice.stat`, `неизвестный модификатор «${stat}»`);
      }
      if (node.type === 'action.roll') {
        const kind = (node.params || {}).kind;
        if (kind !== undefined && !rust.ROLL_KINDS.includes(kind)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.kind`, `неизвестный тип броска «${kind}»`);
        const upcast = (node.params || {}).upcast;
        if (upcast !== undefined && (!isObj(upcast) || !isInt(upcast.count) || upcast.count < 0 || upcast.count > 100 || !isInt(upcast.sides) || upcast.sides < 1 || upcast.sides > 1000))
          report.error('field-range', where, `data.mechanics.graph.nodes[${node.id}].params.upcast`, 'повышение круга: количество костей 0–100 и грани 1–1000');
      }      if (node.type === 'action.field') {
        const params = node.params || {};
        if (!rust.FIELD_KINDS.includes(params.kind)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.kind`, `неизвестный вид «${params.kind}» (status, value или formula)`);
        else if (params.kind === 'value' && !rust.VALUE_FIELDS.includes(params.field)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.field`, `показатель «${params.field}» недоступен`);
        else if (params.kind === 'formula' && !rust.FORMULA_FIELDS.includes(params.field)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.field`, `параметр «${params.field}» недоступен для формулы`);
        else if (params.kind === 'status') {
          if (!['add', 'remove', 'concentration'].includes(params.operation)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.operation`, `неизвестная операция состояния «${params.operation}»`);
          if (params.operation !== 'concentration' && (!isStr(params.condition) || !params.condition.trim())) report.error('required-field', where, `data.mechanics.graph.nodes[${node.id}].params.condition`, 'у состояния нет названия');
        }
      }
      if (node.type === 'action.spend') {
        const params = node.params || {};
        if (!['quantity', 'charges', 'uses'].includes(params.resource)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.resource`, `неизвестный ресурс «${params.resource}» (ячейка — action.slot)`);
      }
      // Отдельный узел «Расход ячейки»: level 0 — круг выбирается при касте, 1–9 — фиксированный.
      if (node.type === 'action.slot') {
        const params = node.params || {};
        if (!isInt(params.level) || params.level < 0 || params.level > 9) report.error('field-range', where, `data.mechanics.graph.nodes[${node.id}].params.level`, 'круг ячейки: 0 (круг каста) или 1–9');
        if (!isInt(params.amount) || params.amount < 1 || params.amount > 10000) report.error('field-range', where, `data.mechanics.graph.nodes[${node.id}].params.amount`, 'количество ячеек: 1–10000');
      }
      if (node.type === 'data.cast') {
        const field = (node.params || {}).field;
        if (!['level', 'base', 'extra'].includes(field)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.field`, `поле круга каста «${field}» (level, base или extra)`);
      }
      // Результаты действий читаются из листа: источник — last или программа этого графа.
      if (node.type === 'data.result') {
        const params = node.params || {};
        // Программы всего графа, включая определения групп: на них ссылается data.result.
        const programs = new Set([...(graph.nodes || []), ...(graph.groups || []).flatMap(group => group.nodes || [])]
          .filter(item => item.type === 'action.program').map(item => String(item.params?.program_id || item.id)));
        if (params.source !== 'last' && !programs.has(String(params.source || ''))) report.error('broken-reference', where, `data.mechanics.graph.nodes[${node.id}].params.source`, `результат читает «${params.source}», а такой программы в графе нет`);
        if (!['total', 'hit', 'applied', 'spent'].includes(params.field)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.field`, `неизвестное поле результата «${params.field}» (total, hit, applied или spent)`);
      }
      // Поле листа: путь по вложенным ключам листа (hp.current, level, abilities.str).
      if (node.type === 'data.sheet') {
        const field = (node.params || {}).field;
        if (!isStr(field) || field.length > 100 || !/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(field)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.field`, `поле листа «${field}» должно быть непустым путём из [a-z0-9_.]`);
      }
      if (node.type === 'condition.context' && (node.params || {}).kind === 'edition') {
        const editions = (node.params || {}).editions;
        if (!isArr(editions) || !editions.length) report.error('required-field', where, `data.mechanics.graph.nodes[${node.id}].params.editions`, 'не указаны редакции условия');
        else {
          for (const e of editions) if (!EDITIONS.includes(e)) report.error('enum-values', where, `data.mechanics.graph.nodes[${node.id}].params.editions`, `неизвестная редакция «${e}»`);
          if (node.params.locked !== true && !editions.includes(edition)) report.warn('edition-consistency', where, `data.mechanics.graph.nodes[${node.id}].params.editions`, `условие «редакция ${editions.join('/')}» никогда не сработает у записи редакции ${edition}`);
        }
      }
      if (node.type === 'action.grant_item') {
        const item = node.params && node.params.item;
        if (isObj(item) && isStr(item.name) && item.name && !itemNames.has(item.name)) report.warn('broken-reference', where, `data.mechanics.graph.nodes[${node.id}].params.item.name`, `выдаваемый предмет «${item.name}» не найден в редакции ${edition}`);
      }
      const learn = node.type === 'rule.list' && node.params && node.params.kind === 'spell_list' ? node.params.spells : null;
      for (const s of learn || []) {
        const value = isObj(s) ? s.name : s;
        if (isStr(value) && value && !spellNames.has(value)) report.warn('broken-reference', where, `data.mechanics.graph.nodes[${node.id}].params.spells`, `заклинание «${value}» не найдено в редакции ${edition}`);
      }
      if (node.type === 'condition.context' && (node.params || {}).kind === 'subclass') {
        const id = (node.params || {}).id;
        if (isStr(id) && subclassIds.size && !subclassIds.has(id)) report.error('broken-reference', where, `data.mechanics.graph.nodes[${node.id}].params.id`, `подкласс «${id}» не найден среди data.subclasses.name_en редакции ${edition}`);
      }
    }
    // формулы, которые реально бросаются (в том числе вычисленные из узлов)
    try {
      const legacy = Mechanics.toLegacy(mechanics, { edition, level: 20, subclass: '', choices: {} });
      for (const program of (legacy && legacy.programs) || []) {
        for (const block of program.blocks || []) {
          const advanced = block.dice && (block.dice.advanced || '');
          if (!advanced) continue;
          try { DiceEngine.parse(stripVars(advanced)); } catch (e) { report.error('dice-expression', where, `data.mechanics.programs[${program.id}].blocks[${block.id}].dice`, `формула «${advanced}» не разбирается: ${e.message}`); }
        }
      }
    } catch (e) {
      report.error('mechanics-compile', where, 'data.mechanics', `граф не собирается в действия: ${e.message}`);
    }
  }
  report.stats.node_types = Object.fromEntries([...nodesUsed].sort());

  // ---- 4. слой перевода: висячие ключи и остатки русского в английском ----
  // Семантика слияния — как в src/i18n.rs: ключ с «!» заменяет значение целиком,
  // массивы объектов с id сливаются по id, прочие массивы заменяются,
  // карты «ключ — название умения» (feature_texts) дополняются английскими ключами.
  let dangling = 0, cyrInEn = 0;
  const examples = [];
  const walkI18n = (base, over, trail) => {
    if (!isObj(over)) return;
    for (const [key, value] of Object.entries(over)) {
      if (key === 'mechanics') return; // механики пересобираются tools/srd/mechanics.py, сверяются отдельно
      const pure = key.endsWith('!') ? key.slice(0, -1) : key;
      if (NAME_KEYED_MAPS.includes(pure)) continue;
      if (pure === 'name') continue; // имя записи лежит в row.name, i18n.<lang>.name — его перевод (src/i18n.rs::view)
      const baseValue = isObj(base) ? base[pure] : undefined;
      if (baseValue === undefined) {
        dangling++;
        if (examples.length < 8) examples.push({ entity: trail.entity, field: `data.i18n.${trail.lang}.${trail.path}${key}`, message: `в базовых данных нет поля «${pure}» — перевод некуда накладывать` });
        continue;
      }
      if (isObj(value)) { walkI18n(baseValue, value, { ...trail, path: `${trail.path}${key}.` }); continue; }
      if (isArr(value)) {
        const byId = isArr(baseValue) && value.every(x => isObj(x) && isStr(x.id)) && baseValue.every(x => isObj(x) && isStr(x.id));
        value.forEach((v, i) => {
          const match = byId ? baseValue.find(b => b.id === v.id) : (isArr(baseValue) ? (baseValue[i] !== undefined ? baseValue[i] : baseValue[0]) : undefined);
          if (isObj(v)) walkI18n(match || {}, v, { ...trail, path: `${trail.path}${key}[${i}].` });
          else if (isStr(v) && CJK_CYR.test(v)) {
            cyrInEn++;
            if (examples.length < 16) examples.push({ entity: trail.entity, field: `data.i18n.${trail.lang}.${trail.path}${key}[${i}]`, message: `кириллица в английском тексте: «${v.slice(0, 60)}»` });
          }
        });
        continue;
      }
      if (isStr(value) && CJK_CYR.test(value) && trail.lang === 'en') {
        cyrInEn++;
        if (examples.length < 16) examples.push({ entity: trail.entity, field: `data.i18n.${trail.lang}.${trail.path}${key}`, message: `кириллица в английском тексте: «${value.slice(0, 60)}»` });
      }
    }
  };
  for (const row of rows) {
    const i18n = row.data.i18n;
    if (!isObj(i18n)) continue;
    const base = { ...row.data };
    delete base.i18n;
    for (const [lang, layer] of Object.entries(i18n)) {
      if (!['ru', 'en'].includes(lang)) { report.error('localization', `#${row.category}/${row.slug}`, `data.i18n.${lang}`, `неизвестный язык «${lang}» (src/i18n.rs LANGS)`); continue; }
      walkI18n(base, layer, { entity: `#${row.category}/${row.slug}`, lang, path: '' });
    }
  }
  report.stats.i18n = { dangling_keys: dangling, cyrillic_in_en: cyrInEn };
  for (const e of examples) report.warn('i18n-layer', e.entity, e.field, e.message);

  return report;
}

// ---------- согласованность клиента и сервера ----------
function checkRuntime(opts = {}) {
  const runtime = opts.runtime || loadRuntime();
  const rust = opts.rust || rustConstants();
  const report = new Report();
  const Registry = runtime.NodeRegistry;
  const defs = Object.keys(Registry.NODE_DEFS);
  const exposed = defs.filter(t => !Registry.INTERNAL.has(t));
  for (const type of exposed) {
    if (!rust.NODE_TYPES.includes(type)) report.error('client-server-parity', `static/node-registry.js`, type, `узел есть в реестре клиента, но сервер его не принимает (src/mechanics_graph.rs NODE_TYPES)`);
  }
  // Внутренние узлы (group.input/group.output) намеренно вне палитры, но обязаны быть в реестре и на сервере.
  for (const type of rust.NODE_TYPES) {
    if (!defs.includes(type)) report.error('client-server-parity', `src/mechanics_graph.rs`, type, `сервер принимает узел, которого нет в реестре клиента (static/node-registry.js)`);
  }
  for (const type of Registry.INTERNAL) {
    if (!defs.includes(type)) report.error('client-server-parity', `static/node-registry.js`, type, `внутренний узел не описан в NODE_DEFS`);
  }
  // Настраиваемые узлы покрывают несколько видов блоков плана: «Бросок» и «Изменить поле» — через kind,
  // «Расход ресурса» — один блок consume.
  const expandKind = t => (Registry.blockKindsOf ? Registry.blockKindsOf(t) : (t === 'action.roll' ? (Registry.ROLL_KINDS || ['roll']) : [t.slice(7)]));
  const actionKinds = [...new Set(defs.filter(t => t.startsWith('action.') && t !== 'action.program').flatMap(expandKind))];
  if (actionKinds.slice().sort().join() !== rust.ACTIONS.slice().sort().join()) report.error('client-server-parity', 'static/node-registry.js', 'ACTION_KINDS', `наборы действий клиента (${actionKinds.join(',')}) и сервера (${rust.ACTIONS.join(',')}) различаются`);
  const diceKinds = [...new Set(defs.filter(t => t.startsWith('action.') && Registry.NODE_DEFS[t].inputs && Registry.NODE_DEFS[t].inputs.dice).flatMap(expandKind))];
  if (diceKinds.slice().sort().join() !== rust.DICE_ACTIONS.slice().sort().join()) report.error('client-server-parity', 'static/node-registry.js', 'DICE_KINDS', `действия с костью: клиент ${diceKinds.join(',')} против сервера ${rust.DICE_ACTIONS.join(',')}`);
  if ((Registry.ROLL_KINDS || []).slice().sort().join() !== rust.ROLL_KINDS.slice().sort().join()) report.error('client-server-parity', 'static/node-registry.js', 'ROLL_KINDS', `виды настраиваемого броска клиента (${(Registry.ROLL_KINDS || []).join(',')}) и сервера (${rust.ROLL_KINDS.join(',')}) различаются`);
  if ((Registry.LOGIC_OPS || []).slice().sort().join() !== rust.LOGIC_OPS.slice().sort().join()) report.error('client-server-parity', 'static/node-registry.js', 'LOGIC_OPS', `операции логики клиента (${(Registry.LOGIC_OPS || []).join(',')}) и сервера (${rust.LOGIC_OPS.join(',')}) различаются`);
  // «Изменить поле»: виды и списки полей листа обязаны совпадать у клиента и сервера.
  for (const [name, client, server] of [
    ['FIELD_KINDS', Registry.FIELD_KINDS, rust.FIELD_KINDS],
    ['FIELD_VALUE_FIELDS', Object.keys(Registry.FIELD_VALUE_FIELDS || {}), rust.VALUE_FIELDS],
    ['FIELD_FORMULA_FIELDS', Object.keys(Registry.FIELD_FORMULA_FIELDS || {}), rust.FORMULA_FIELDS],
  ]) {
    const a = (client || []).slice().sort().join(), b = (server || []).slice().sort().join();
    if (a !== b) report.error('client-server-parity', 'static/node-registry.js', name, `списки клиента (${a}) и сервера (${b}) различаются`);
  }
  const skillIds = (runtime.SKILLS || []).map(([id]) => id);
  if (skillIds.slice().sort().join() !== rust.SKILL_IDS.slice().sort().join()) {
    const only = (a, b) => a.filter(x => !b.includes(x)).join(',');
    report.error('client-server-parity', 'static/common.js', 'SKILLS', `идентификаторы навыков клиента и сервера (SKILL_IDS) различаются: только у клиента ${only(skillIds, rust.SKILL_IDS) || '—'}; только у сервера ${only(rust.SKILL_IDS, skillIds) || '—'}`);
  }
  const abilityValues = [...new Set(Object.values(Registry.NODE_DEFS).map(d => d.defaults && d.defaults.value).filter(v => isStr(v) && v.length === 3 && rust.ABILITIES.includes(v)))];
  if ((Registry.ABILITIES || []).slice().sort().join() !== rust.ABILITIES.slice().sort().join()) {
    report.error('client-server-parity', 'static/node-registry.js', 'ABILITIES', `характеристики клиента (${(Registry.ABILITIES || []).join(',')}) и сервера (${rust.ABILITIES.join(',')}) различаются`);
  }
  // Типы сокетов: клиент описывает их в VALUE_TYPES, сервер — в SOCKET_TYPES (проверка интерфейса групп).
  if ((Registry.VALUE_TYPES || []).slice().sort().join() !== rust.SOCKET_TYPES.slice().sort().join()) {
    report.error('client-server-parity', 'static/node-registry.js', 'VALUE_TYPES', `типы сокетов клиента (${(Registry.VALUE_TYPES || []).join(',')}) и сервера SOCKET_TYPES (${rust.SOCKET_TYPES.join(',')}) различаются`);
  }
  // Порты узлов: ни один вход не должен требовать значение, которое не производит ни один узел,
  // и ни один выход (кроме конечных эффектов) не должен оставаться без потребителя.
  const ports = { in: new Map(), out: new Map() };
  for (const [type, def] of Object.entries(Registry.NODE_DEFS)) {
    for (const kind of Object.values(def.inputs || {})) ports.in.set(kind, [...(ports.in.get(kind) || []), type]);
    for (const kind of Object.values(def.outputs || {})) ports.out.set(kind, [...(ports.out.get(kind) || []), type]);
  }
  for (const [kind, types] of ports.in) {
    if (!ports.out.has(kind)) report.error('node-sockets', 'static/node-registry.js', kind, `тип сокета «${kind}» принимают узлы (${types.join(',')}), но не производит ни один узел — вход невозможно подключить`);
  }
  for (const [kind, types] of ports.out) {
    if (kind !== 'effect' && !ports.in.has(kind)) report.error('node-sockets', 'static/node-registry.js', kind, `тип сокета «${kind}» производят узлы (${types.join(',')}), но не принимает ни один узел — значение некуда подключить`);
  }
  report.stats.parity = { abilities: abilityValues.length, skills: skillIds.length, socket_types: ports.in.size };
  report.stats.client_nodes = exposed.length;
  report.stats.server_nodes = rust.NODE_TYPES.length;
  return report;
}

function runAll(opts = {}) {
  const runtime = loadRuntime();
  const rust = rustConstants();
  const editions = opts.editions || EDITIONS;
  const reports = { runtime: checkRuntime({ runtime, rust }) };
  for (const edition of editions) reports[edition] = checkSeed(edition, { runtime, rust });
  return reports;
}

function printReports(reports, { max = 20, quiet = false, json = false } = {}) {
  if (json) {
    let jsonErrors = 0;
    for (const report of Object.values(reports)) jsonErrors += report.errors.length;
    console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, { issues: r.issues, stats: r.stats }])), null, 1));
    return jsonErrors;
  }
  let errors = 0, warnings = 0;
  for (const [name, report] of Object.entries(reports)) {
    errors += report.errors.length; warnings += report.warnings.length;
    console.log(`\n=== ${name}`);
    for (const [key, value] of Object.entries(report.stats)) console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    if (!report.issues.length) { console.log('  проблем нет'); continue; }
    const byCheck = new Map();
    for (const issue of report.issues) byCheck.set(`${issue.level}/${issue.check}`, (byCheck.get(`${issue.level}/${issue.check}`) || 0) + 1);
    for (const [key, count] of [...byCheck].sort()) console.log(`  ${key}: ${count}`);
    if (!quiet) {
      const shown = report.issues.slice(0, max);
      for (const issue of shown) console.log(`  [${issue.level}] ${issue.check} ${issue.entity} ${issue.field ? `· ${issue.field} ·` : ''} ${issue.message}${issue.hint ? ` (${issue.hint})` : ''}`);
      if (report.issues.length > shown.length) console.log(`  … ещё ${report.issues.length - shown.length} (--max, --json)`);
    }
  }
  console.log(`\nошибок: ${errors}, предупреждений: ${warnings}`);
  return errors;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const editions = get('--edition', EDITIONS.join(',')).split(',').filter(e => EDITIONS.includes(e));
  const reports = runAll({ editions });
  const errors = printReports(reports, { max: Number(get('--max', 20)), quiet: argv.includes('--quiet'), json: argv.includes('--json') });
  process.exit(errors ? 1 : 0);
}

module.exports = { runAll, checkSeed, checkRuntime, loadRuntime, rustConstants, Report, REPO, EDITIONS, CATEGORIES };
