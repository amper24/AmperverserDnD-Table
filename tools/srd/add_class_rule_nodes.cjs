#!/usr/bin/env node
// Переносит базовые правила SRD-классов из полей data.* в узлы rule.* графа записи класса
// (data_seed/srd_*.json), чтобы мастер создания и повышения уровня читали их из графа:
//   rule.hit_die        — кость хитов (data.hit_die);
//   rule.saving_throws  — спасброски (data.saves);
//   rule.proficiencies  — доспехи/оружие/инструменты (data.armor / weapons / tools);
//   rule.class_features — умения по уровням (data.features + data.feature_texts) таблицей;
//   rule.spellcasting   — заклинательная характеристика (data.spellcasting).
// Идемпотентно: узлы с фиксированными id удаляются и добавляются заново. Поля data.* не трогаются.
//   node tools/srd/add_class_rule_nodes.cjs
const fs = require('node:fs'), vm = require('node:vm');

// Все id узлов правил класса, которые пишет этот генератор (для идемпотентности удаляем все).
const RULE_IDS = new Set(['rule_hit_die', 'rule_saving_throws', 'rule_prof_armor', 'rule_prof_weapons', 'rule_prof_tools', 'rule_class_features', 'rule_spellcasting']);

// id узла → фабрика параметров из записи. value списков — строки (одна запись владения).
const build = (rec) => {
  const d = rec.data || {};
  const out = [];
  if (typeof d.hit_die === 'string' && d.hit_die) out.push({ id: 'rule_hit_die', type: 'rule.hit_die', params: { value: d.hit_die } });
  if (Array.isArray(d.saves) && d.saves.length) out.push({ id: 'rule_saving_throws', type: 'rule.saving_throws', params: { value: d.saves } });
  const prof = (id, kind, raw) => {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
    // «—» — маркер «нет владения», не настоящее владение.
    const values = list.map(x => String(x).trim()).filter(x => x && !['—', '–', '-', 'нет', 'none'].includes(x));
    if (values.length) out.push({ id, type: 'rule.proficiencies', params: { kind, value: values } });
  };
  prof('rule_prof_armor', 'Доспехи', d.armor);
  prof('rule_prof_weapons', 'Оружие', d.weapons);
  prof('rule_prof_tools', 'Инструменты', d.tools);
  const levels = {};
  for (const [level, names] of Object.entries(d.features || {})) {
    const items = (Array.isArray(names) ? names : []).map(name => ({ name: String(name), text: String(d.feature_texts?.[name] || '') }));
    if (items.length) levels[level] = items;
  }
  out.push({ id: 'rule_class_features', type: 'rule.class_features', params: { table: { levels } } });
  if (typeof d.spellcasting === 'string' && d.spellcasting) out.push({ id: 'rule_spellcasting', type: 'rule.spellcasting', params: { ability: d.spellcasting } });
  return out;
};

// Английский оверлей по id узлов: только параметры, где русский текст отличается от английского.
const KIND_EN = { 'Доспехи': 'Armor', 'Оружие': 'Weapons', 'Инструменты': 'Tools' };
const enOverlay = (rec, nodes) => {
  const en = rec.data?.i18n?.en;
  if (!en) return [];
  const enFeatures = en.features || {};          // { "1!": [enName, …], … }
  const enTexts = en['feature_texts!'] || {};    // { enName: enText }
  const out = [];
  for (const n of nodes) {
    if (n.type === 'rule.proficiencies') {
      const enVal = n.id === 'rule_prof_armor' ? en.armor : n.id === 'rule_prof_weapons' ? en.weapons : en.tools;
      const values = Array.isArray(enVal) ? enVal : typeof enVal === 'string' && enVal.trim() ? [enVal] : [];
      if (!values.length) continue;
      out.push({ id: n.id, params: { kind: KIND_EN[n.params.kind] || n.params.kind, value: values } });
    } else if (n.type === 'rule.class_features') {
      const levels = {};
      for (const [level, items] of Object.entries(n.params.table.levels || {})) {
        const enNames = enFeatures[`${level}!`] || [];
        const mapped = items.map((item, i) => {
          const enName = enNames[i] || item.name;
          return { name: enName, text: enTexts[enName] || '' };
        });
        if (mapped.length) levels[level] = mapped;
      }
      out.push({ id: n.id, params: { table: { levels } } });
    }
  }
  return out;
};

async function main() {
  const ctx = { console, crypto: require('node:crypto').webcrypto, document: {}, window: {} };
  vm.createContext(ctx);
  // Граф проверяется тем же кодом, что и в браузере.
  for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
  }
  const M = ctx.window.Mechanics;
  let problems = 0;
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = 0;
    for (const rec of records) {
      if (rec.category !== 'class') continue;
      if (rec.data?.mechanics?.version !== 2) { console.error(`не граф v2: ${rec.slug}`); problems++; continue; }
      const graph = rec.data.mechanics.graph;
      const nodes = build(rec);
      graph.nodes = (graph.nodes || []).filter(n => !RULE_IDS.has(n.id));
      nodes.forEach((n, i) => graph.nodes.push({ ...n, position: { x: 40, y: 40 + i * 90 } }));
      // Английский оверлей: по id узлов, только отличающиеся параметры.
      const overlay = enOverlay(rec, nodes);
      if (rec.data.i18n?.en) {
        const en = rec.data.i18n.en;
        en.mechanics = en.mechanics || { graph: { nodes: [] } };
        en.mechanics.graph = en.mechanics.graph || { nodes: [] };
        const enNodes = en.mechanics.graph.nodes;
        for (let i = enNodes.length - 1; i >= 0; i--) if (RULE_IDS.has(enNodes[i]?.id)) enNodes.splice(i, 1);
        for (const over of overlay) enNodes.push(over);
      }
      changed++;
    }
    fs.writeFileSync(file, JSON.stringify(records, null, 0));
    console.log(`${file}: классов с базовыми правилами в узлах ${changed}`);
  }
  // Проверка: граф валиден.
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    for (const rec of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (rec.category !== 'class') continue;
      const err = M.validate(rec.data.mechanics);
      if (err) { console.error(`проверка не пройдена: ${rec.slug}: ${err}`); problems++; }
    }
  }
  if (problems) { console.error(`проблем: ${problems}`); process.exit(1); }
  console.log('проверка графов пройдена');
}
main().catch(e => { console.error(e); process.exit(1); });
