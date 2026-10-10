#!/usr/bin/env node
// Переносит механику SRD-классов из наборов static/presets/ в узлы графа записи класса в data_seed/srd_*.json:
//   rule.class_progression — таблица развития (class-progression-<редакция>.json);
//   rule.class_rules — кастеры, мультикласс и мастерства оружия (class-rules-<редакция>.json, без ru, color, legacy_unarmored).
// Идемпотентно: существующий узел получает актуальную таблицу, английский оверлей обновляется.
//   node tools/srd/add_class_progression_nodes.cjs
// Ключ таблицы — как у ClassRules.slugOf: name_en в нижнем регистре. Редакция — data.edition.
const fs = require('node:fs'), vm = require('node:vm');
const { loadPresets } = require('../presets/node-loader.cjs');

const MAX_TABLE_BYTES = 100_000; // лимит таблицы в src/mechanics_graph.rs
// Английский текст владений для мультикласса (SRD 5.1, «Multiclassing»). Русский текст не должен попадать в en-вид.
const EN_PROFICIENCIES = {
  barbarian: 'shields, simple and martial weapons', bard: 'light armor, one skill of your choice, one musical instrument',
  cleric: 'light and medium armor, shields', druid: 'light and medium armor, shields',
  fighter: 'light and medium armor, shields, simple and martial weapons', monk: 'simple weapons, shortswords',
  paladin: 'light and medium armor, shields, simple and martial weapons',
  ranger: 'light and medium armor, shields, simple and martial weapons, one skill from the class list',
  rogue: 'light armor, one skill from the class list, thieves\' tools', sorcerer: '', warlock: 'light armor, simple weapons', wizard: '',
};

// Какие части набора уходят в узел и какие поля попадают в английский оверлей.
const NODES = [
  {
    id: 'class_progression', type: 'rule.class_progression', set: 'class_progression',
    table: t => t,
    overlay: (t, slug) => ({ columns: t.columns.map(c => ({ key: c.key, en: c.en })) }),
  },
  {
    id: 'class_rules', type: 'rule.class_rules', set: 'class_rules',
    table: t => ({ ...(t.caster ? { caster: t.caster } : {}), multiclass: { requirements: t.multiclass?.requirements || [] }, ...(t.weapon_mastery !== undefined ? { weapon_mastery: t.weapon_mastery } : {}) }),
    overlay: (t, slug) => ({ multiclass: { proficiencies: EN_PROFICIENCIES[slug] ?? '' } }),
  },
];

async function main() {
  const ctx = { console, crypto: require('node:crypto').webcrypto, document: {} };
  const Presets = await loadPresets(ctx);
  // Граф проверяется тем же кодом, что и в браузере.
  for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', 'static/mechanics-graph.js']) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
  }
  const M = ctx.window.Mechanics;

  let problems = 0;
  // Таблица узла по записи: набор нужной редакции и ключу.
  const tableFor = (node, edition, key) => {
    const raw = node.set === 'class_progression' ? Presets.classProgression(edition, key) : Presets.classRules(edition, key);
    return raw ? node.table(raw) : null;
  };
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = 0;
    for (const rec of records) {
      if (rec.category !== 'class') continue;
      const edition = String(rec.data?.edition || '');
      const key = String(rec.data?.name_en || '').toLowerCase();
      if (rec.data?.mechanics?.version !== 2) { console.error(`не граф v2: ${rec.slug}`); problems++; continue; }
      const graph = rec.data.mechanics.graph;
      for (const node of NODES) {
        const table = tableFor(node, edition, key);
        if (!table) { console.error(`нет таблицы в наборах: ${file} ${rec.slug} (${edition}/${key}) ${node.set}`); problems++; continue; }
        if (JSON.stringify(table).length > MAX_TABLE_BYTES) { console.error(`таблица слишком большая: ${rec.slug} ${node.id}`); problems++; continue; }
        const existing = graph.nodes.find(n => n.id === node.id);
        if (existing) {
          if (existing.type !== node.type) { console.error(`занят id узла: ${rec.slug} ${node.id}`); problems++; continue; }
          existing.params = { ...existing.params, table };
        } else {
          graph.nodes.push({ id: node.id, type: node.type, params: { table }, position: { x: 40, y: 40 } });
        }
        // Английский вид: оверлей узла (массивы заменяются целиком, поэтому без ru).
        if (rec.data.i18n?.en) {
          const en = rec.data.i18n.en;
          en.mechanics = en.mechanics || { graph: { nodes: [] } };
          en.mechanics.graph = en.mechanics.graph || { nodes: [] };
          const over = { id: node.id, params: { table: node.overlay(table, key) } };
          const i = en.mechanics.graph.nodes.findIndex(n => n.id === node.id);
          if (i >= 0) en.mechanics.graph.nodes[i] = over; else en.mechanics.graph.nodes.push(over);
        }
      }
      changed++;
    }
    fs.writeFileSync(file, JSON.stringify(records, null, 0) + '\n');
    console.log(`${file}: классов с узлами механики ${changed}`);
  }
  // Проверка: граф валиден и отдаёт те же таблицы, что наборы той же редакции.
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    for (const rec of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (rec.category !== 'class') continue;
      const err = M.validate(rec.data.mechanics);
      const key = rec.data.name_en.toLowerCase();
      const gotP = M.classProgression(rec.data.mechanics, rec.data.edition);
      const wantP = Presets.classProgression(rec.data.edition, key);
      const gotR = M.classRules(rec.data.mechanics, rec.data.edition);
      const wantR = tableFor(NODES[1], rec.data.edition, key);
      if (err || !gotP || JSON.stringify(gotP) !== JSON.stringify(wantP) || !gotR || JSON.stringify(gotR) !== JSON.stringify(wantR)) {
        console.error(`проверка не пройдена: ${rec.slug}: ${err || 'таблица не совпала'}`); problems++;
      }
    }
  }
  if (problems) { console.error(`проблем: ${problems}`); process.exit(1); }
  console.log('проверка графов пройдена');
}
main().catch(e => { console.error(e); process.exit(1); });
