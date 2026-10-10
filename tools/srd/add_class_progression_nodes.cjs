#!/usr/bin/env node
// Переносит таблицы развития SRD-классов (static/class-progression.js) в узел rule.class_progression
// графа записи класса в data_seed/srd_*.json. Идемпотентно: существующий узел получает актуальную таблицу.
//   node tools/srd/add_class_progression_nodes.cjs
// Ключ таблицы — как у ClassRules.slugOf: name_en в нижнем регистре. Редакция берётся из data.edition.
const fs = require('node:fs'), vm = require('node:vm');

const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto, document: {} };
vm.createContext(ctx);
for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js',
  'static/node-registry.js', 'static/mechanics-graph.js', 'static/class-progression.js']) {
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
}
const tables = ctx.window.CLASS_PROGRESSION;
const NODE_ID = 'class_progression', MAX_TABLE_BYTES = 100_000; // лимит таблицы в src/mechanics_graph.rs

let problems = 0;
for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = 0;
  for (const rec of records) {
    if (rec.category !== 'class') continue;
    const edition = String(rec.data?.edition || '');
    const key = String(rec.data?.name_en || '').toLowerCase();
    const table = tables[edition]?.[key];
    if (!table) { console.error(`нет таблицы: ${file} ${rec.slug} (${edition}/${key})`); problems++; continue; }
    if (JSON.stringify(table).length > MAX_TABLE_BYTES) { console.error(`таблица слишком большая: ${rec.slug}`); problems++; continue; }
    const mech = rec.data.mechanics;
    if (mech?.version !== 2) { console.error(`не граф v2: ${rec.slug}`); problems++; continue; }
    const graph = mech.graph;
    const existing = graph.nodes.find(n => n.id === NODE_ID);
    if (existing) {
      if (existing.type !== 'rule.class_progression') { console.error(`занят id узла: ${rec.slug}`); problems++; continue; }
      existing.params = { ...existing.params, table };
    } else {
      graph.nodes.push({ id: NODE_ID, type: 'rule.class_progression', params: { table }, position: { x: 40, y: 40 } });
    }
    // Английский вид: подписи колонок в оверлее узла (массив колонок заменяется целиком, поэтому без ru).
    if (rec.data.i18n?.en) {
      const en = rec.data.i18n.en;
      en.mechanics = en.mechanics || { graph: { nodes: [] } };
      en.mechanics.graph = en.mechanics.graph || { nodes: [] };
      const over = { id: NODE_ID, params: { table: { columns: table.columns.map(c => ({ key: c.key, en: c.en })) } } };
      const i = en.mechanics.graph.nodes.findIndex(n => n.id === NODE_ID);
      if (i >= 0) en.mechanics.graph.nodes[i] = over; else en.mechanics.graph.nodes.push(over);
    }
    changed++;
  }
  fs.writeFileSync(file, JSON.stringify(records, null, 0) + '\n');
  console.log(`${file}: классов с узлом прогрессии ${changed}`);
}
// Проверка: граф валиден и отдаёт таблицу той же редакции.
const { Mechanics: M } = ctx.window;
for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
  for (const rec of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (rec.category !== 'class') continue;
    const err = M.validate(rec.data.mechanics);
    const got = M.classProgression(rec.data.mechanics, rec.data.edition);
    if (err || !got || JSON.stringify(got) !== JSON.stringify(tables[rec.data.edition][rec.data.name_en.toLowerCase()])) {
      console.error(`проверка не пройдена: ${rec.slug}: ${err || 'таблица не совпала'}`); problems++;
    }
  }
}
if (problems) { console.error(`проблем: ${problems}`); process.exit(1); }
console.log('проверка графов пройдена');
