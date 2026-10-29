// Сводка механик справочника: сколько записей с графом v2, из каких узлов и связей он состоит.
// Пересобирается из данных (ничего не меняет в data_seed) и пишет docs/mechanics-migration.json,
// на который ссылается docs/mechanics.md. Запуск: node tools/srd/mechanics_summary.cjs [--check]
// `--check` не пишет файл, а возвращает код 1, если сводка разошлась с данными (её забыли пересобрать).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'docs', 'mechanics-migration.json');

function summarise(edition) {
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data_seed', `srd_${edition}.json`), 'utf8'));
  const categories = {}, nodeTypes = {}, origin = {};
  let mechanicsRecords = 0, nodes = 0, links = 0, programs = 0, withPrograms = 0;
  // Узлы, читающие состояние исполнения: результат действия и поле листа (этап 2 v3).
  let resultReads = 0, sheetReads = 0;
  for (const row of rows) {
    categories[row.category] = (categories[row.category] || 0) + 1;
    const mechanics = row.data && row.data.mechanics;
    if (!mechanics) continue;
    mechanicsRecords++;
    origin[mechanics.origin || '—'] = (origin[mechanics.origin || '—'] || 0) + 1;
    const graph = mechanics.graph || {};
    const recordNodes = graph.nodes || [];
    nodes += recordNodes.length;
    links += (graph.links || []).length;
    let recordPrograms = 0;
    for (const node of recordNodes) {
      nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
      if (node.type === 'action.program') recordPrograms++;
      if (node.type === 'data.result') resultReads++;
      if (node.type === 'data.sheet') sheetReads++;
    }
    programs += recordPrograms;
    if (recordPrograms) withPrograms++;
  }
  // Ключи в стабильном порядке, чтобы файл не менялся от перестановок в данных.
  const ordered = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
  return {
    version: 2,
    records: rows.length,
    categories: ordered(categories),
    mechanics_records: mechanicsRecords,
    origin: ordered(origin),
    nodes,
    links,
    programs,
    records_with_programs: withPrograms,
    node_types: ordered(nodeTypes),
    result_reads: resultReads,
    sheet_reads: sheetReads,
  };
}

const check = process.argv.includes('--check');
const report = {
  format: 'v2-graph',
  generated_by: 'node tools/srd/mechanics_summary.cjs',
  note: 'Сводка графов v2 (узел-связь). Прежний файл описывал блоки v1 — формат блоков в данных больше нет.',
  '2014': summarise('2014'),
  '2024': summarise('2024'),
};
const text = JSON.stringify(report, null, 2) + '\n';
if (check) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (current !== text) { console.error('сводка устарела: пересоберите node tools/srd/mechanics_summary.cjs'); process.exit(1); }
  console.log('сводка механик совпадает с данными');
} else {
  fs.writeFileSync(TARGET, text, 'utf8');
  for (const edition of ['2014', '2024']) {
    const summary = report[edition];
    console.log(`${edition}: записей ${summary.records}, с механикой ${summary.mechanics_records}, ` +
      `узлов ${summary.nodes}, связей ${summary.links}, программ ${summary.programs} ` +
      `(в ${summary.records_with_programs} записях)`);
  }
}
