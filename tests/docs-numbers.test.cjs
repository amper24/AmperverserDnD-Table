// Счётчики в документации обязаны совпадать с данными: типы узлов, шаблоны, стартеры,
// записи справочника, сводка механик и список исторических предупреждений integrity.
// Здесь проверяются именно числа из docs/README/CHANGELOG, а не только код.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const readJson = file => JSON.parse(read(file));
const num = value => new Intl.NumberFormat('ru-RU').format(value).replace(/\u00a0/g, ' ');

const seeds = {
  2014: readJson('data_seed/srd_2014.json'),
  2024: readJson('data_seed/srd_2024.json'),
};
const templates = readJson('static/presets/mechanic-templates.json');
const starters = readJson('static/presets/graph-starters.json');
const mechanicStarters = readJson('static/presets/mechanic-starters.json');
const summary = readJson('docs/mechanics-migration.json');
const nodeFiles = require('../tools/nodes/node-loader.cjs').nodeFiles();

test('типы узлов: 46 файлов, 44 видимых и два внутренних узла групп — так и написано в docs/README', () => {
  assert.equal(nodeFiles.length, 46, 'файлов узлов');
  const palette = read('docs/node-system-v3.md');
  assert.match(palette, /Всего 46 типов: 44 видимых в меню и два внутренних узла групп/);
  const readme = read('README.md');
  assert.match(readme, /Всего в палитре 44 типа; ещё два/, 'README: 44 видимых + 2 внутренних');
  const registry = read('static/node-registry.js');
  assert.equal((registry.match(/category/g)?.length > 0), true);
  assert.match(read('docs/node-system-v3-audit.md'), /\*\*46 \/ 46\*\* \(44 видимых \+ 2 внутренних\)/);
});

test('шаблоны: 46 механик, 19 стартовых графов, 16 с attach, 3 графа создания', () => {
  assert.equal(templates.items.length, 46, 'mechanic-templates');
  assert.equal(starters.items.length, 19, 'graph-starters');
  assert.equal(starters.items.filter(item => item.attach).length, 16, 'стартеры с attach');
  assert.equal(mechanicStarters.items.length, 3, 'mechanic-starters');
  const audit = read('docs/node-system-v3-audit.md');
  assert.match(audit, /\*\*46 \/ 19\*\* \(было 40 \/ 13; 16 стартеров с `attach`\)/);
  const readme = read('README.md');
  assert.match(readme, /46 шаблонов механик и 19 стартовых графов \(16 вставляются в пустое действие\)/);
  assert.match(read('docs/node-system-v3.md'), /— 19 тел цепочек для диалога «Шаблоны действий»/);
  assert.match(read('CHANGELOG.md'), /Шаблоны: 46 механик и 19 стартеров/);
});

test('категории палитры: 6 штук, и в доке перечислен тот же порядок', () => {
  const registry = read('static/node-registry.js');
  const ids = [...registry.matchAll(/\{ id: '([a-z]+)', title: '([^']+)'/g)].map(m => ({ id: m[1], title: m[2] }));
  assert.equal(ids.length, 6, 'категорий в NodeRegistry.CATEGORIES');
  assert.deepEqual(ids.map(c => c.title), ['Начало', 'Действия', 'Данные', 'Условия', 'Правила', 'Группы']);
  assert.match(read('docs/node-system-v3.md'), /Начало → Действия → Данные → Условия → Правила → Группы/);
});

test('записи SRD 2014/2024 и сводка механик совпадают с docs/mechanics.md', () => {
  const doc = read('docs/mechanics.md');
  for (const edition of ['2014', '2024']) {
    const withMechanics = seeds[edition].filter(row => row.data && row.data.mechanics);
    assert.equal(summary[edition].records, seeds[edition].length, `записей ${edition}`);
    assert.equal(summary[edition].mechanics_records, withMechanics.length, `с механиками ${edition}`);
    assert.equal(summary[edition].nodes, withMechanics.reduce((sum, row) => sum + (row.data.mechanics.graph.nodes || []).length, 0), `узлов ${edition}`);
    assert.equal(summary[edition].links, withMechanics.reduce((sum, row) => sum + (row.data.mechanics.graph.links || []).length, 0), `связей ${edition}`);
    const programs = withMechanics.reduce((sum, row) => sum + (row.data.mechanics.graph.nodes || []).filter(node => node.type === 'action.program').length, 0);
    assert.equal(summary[edition].programs, programs, `программ ${edition}`);
  }
  const metrics = ['records', 'mechanics_records', 'nodes', 'links', 'programs'];
  const totals = Object.fromEntries(metrics.map(key => [key, summary['2014'][key] + summary['2024'][key]]));
  assert.equal(totals.records, 2499);
  assert.equal(totals.mechanics_records, 1967);
  assert.match(doc, new RegExp(`\\*\\*${num(totals.mechanics_records)} записей из ${num(totals.records)}\\*\\*`), 'записи с механиками');
  assert.match(doc, new RegExp(`${num(totals.nodes)} узлов, ${num(totals.links)} связи и ${num(totals.programs)} программы`), 'узлы/связи/программы');
  const audit = read('docs/node-system-v3-audit.md');
  assert.match(audit, /Записей SRD 2014 \/ 2024 \| 1294 \/ 1205/);
  assert.match(audit, /Из них с механиками \| 981 \/ 986/);
  assert.match(audit, /Программ \(все с «Концом»\) \| 3625 \/ 3349/);
});

test('заклинания 319/339 и ячейки/концентрация/ритуал из audit совпадают с данными', () => {
  for (const [edition, expected] of [['2014', { spells: 319, slot: 295, conc: 126, ritual: 29, upcast: 32 }], ['2024', { spells: 339, slot: 312, conc: 132, ritual: 29, upcast: 37 }]]) {
    const spells = seeds[edition].filter(row => row.category === 'spell');
    assert.equal(spells.length, expected.spells, `заклинаний ${edition}`);
    const nodes = spells.flatMap(row => (row.data.mechanics?.graph?.nodes) || []);
    assert.equal(nodes.filter(node => node.type === 'action.slot').length, expected.slot, `action.slot ${edition}`);
    assert.equal(spells.filter(row => row.data.concentration).length, expected.conc, `концентрация ${edition}`);
    assert.equal(spells.filter(row => row.data.ritual).length, expected.ritual, `ритуальных ${edition}`);
    const withUpcast = spells.filter(row => (row.data.mechanics?.graph?.nodes || []).some(node => node.type === 'action.roll' && node.params.upcast));
    assert.equal(withUpcast.length, expected.upcast, `upcast ${edition}`);
  }
  const audit = read('docs/node-system-v3-audit.md');
  assert.match(audit, /2014: 319 заклинаний, 295 `slot`, 32 upcast, 126 концентрация, 29 ритуальных; 2024: 339\/312\/37\/132\/29/);
});

test('наборы в docs/presets.md перечислены с верными счётчиками', () => {
  const doc = read('docs/presets.md');
  const presets = name => readJson('static/presets/' + name).items.length;
  const rows = {
    'graph-starters.json': [`19 готовых графов`, presets('graph-starters.json')],
    'mechanic-templates.json': [`46 шаблонов механик`, presets('mechanic-templates.json')],
    'mechanic-starters.json': [`3 полных графа`, presets('mechanic-starters.json')],
    'conditions.json': [`16 состояний`, presets('conditions.json')],
    'spell-schools.json': [`8 школ`, presets('spell-schools.json')],
    'languages.json': [`17 языков`, presets('languages.json')],
    'enemy-types.json': [`14 типов врагов`, presets('enemy-types.json')],
    'equipment-text-rules.json': [`27 правил`, presets('equipment-text-rules.json')],
    'equipment-pick-rules.json': [`28 правил`, presets('equipment-pick-rules.json')],
    'block-defaults.json': [`12 умолчаний`, presets('block-defaults.json')],
    'item-presets.json': [`6 основ`, presets('item-presets.json')],
    'spell-presets.json': [`5 основ`, presets('spell-presets.json')],
    'feature-rules-2014.json': [`14 и 13 элементов`, presets('feature-rules-2014.json') + presets('feature-rules-2024.json')],
  };
  for (const [file, [phrase, actual]] of Object.entries(rows)) {
    assert.ok(doc.includes(file), `presets.md упоминает ${file}`);
    assert.ok(doc.includes(phrase), `presets.md: «${phrase}»`);
    if (file === 'feature-rules-2014.json') assert.equal(actual, 27, 'feature_rules 14 + 13');
  }
  // Все наборы из index.json описаны в таблице (парные файлы редакций — одной строкой «…-2024.json»).
  const index = readJson('static/presets/index.json').sets;
  for (const file of index) {
    const paired = file.endsWith('-2024.json') && doc.includes(file.replace('-2024.json', '-2014.json'));
    assert.ok(doc.includes(file) || paired, `presets.md описывает набор ${file}`);
  }
});

test('docs/integrity.md описывает каждое предупреждение integrity и их общее число', () => {
  const raw = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'srd', 'integrity.cjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const report = JSON.parse(raw);
  const warnings = Object.values(report).flatMap(block => block.issues.filter(issue => issue.level === 'warn'));
  const doc = read('docs/integrity.md');
  assert.match(doc, new RegExp(`предупреждений: ${warnings.length}`), 'число в docs/integrity.md');
  for (const warning of warnings) assert.ok(doc.includes(warning.entity), `docs/integrity.md упоминает ${warning.entity}`);
  const documentedRows = [...doc.matchAll(/^\| \d+ \| `([^`]+)`/gm)].map(match => match[1]);
  assert.equal(new Set(documentedRows).size, warnings.length, 'в таблице по строке на предупреждение');
  for (const warning of warnings) assert.ok(documentedRows.includes(warning.entity), `строка для ${warning.entity}`);
});

test('счётчик JS-тестов одинаков в README, CHANGELOG и audit', () => {
  const readme = /# (\d+) тест[а-я]*: юнит \+ интеграция/.exec(read('README.md'))[1];
  const changelog = /node --test — (\d+)\/\1/.exec(read('CHANGELOG.md'))[1];
  const audit = /\| JS-тестов \| \*\*(\d+) pass\*\*/.exec(read('docs/node-system-v3-audit.md'))[1];
  assert.equal(readme, changelog, 'README и CHANGELOG');
  assert.equal(audit, changelog, 'audit и CHANGELOG');
  assert.ok(Number(readme) > 500, 'правдоподобный счётчик');
});

test('версия в Cargo.toml совпадает с верхней записью CHANGELOG', () => {
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(read('Cargo.toml'))[1];
  const changelog = /^## (\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md'))[1];
  assert.equal(cargo, changelog);
  assert.match(read('docs/node-system-v3-audit.md'), /HEAD 0\.8\.0/);
});

test('docs/db.md: 27 индексов (19 прежних + 8 новых) совпадают с src/db.rs', () => {
  const statements = read('src/db.rs').split(/\r?\n/)
    .filter(line => /CREATE (UNIQUE )?INDEX/.test(line) && !/\.replace\(/.test(line));
  const names = statements.map(line => /INDEX(?: IF NOT EXISTS)?\s+(\w+)/.exec(line)[1]);
  assert.equal(names.length, 27, 'CREATE INDEX в src/db.rs');
  assert.equal(new Set(names).size, 27, 'имена индексов не повторяются');
  const added = ['idx_chars_campaign_updated', 'idx_chars_owner_updated', 'idx_scenes_campaign_created', 'idx_items_scene_z', 'idx_comp_category_name', 'idx_comp_pack_cat_name', 'idx_pack_editors_user', 'idx_campaign_packs_pack'];
  for (const name of added) assert.ok(names.includes(name), `новый индекс ${name}`);
  assert.equal(names.length - added.length, 19, 'прежних индексов');
  assert.match(read('docs/db.md'), /19 индексов → 27 после старта/);
});
