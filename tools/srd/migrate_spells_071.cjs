// ---------------------------------------------------------------------------
// migrate_spells_071.cjs — пересобирает заклинания справочника в одно действие (0.7.1):
// «Сотворить» само бросает атаку, урон и лечение заклинания, спасбросок цели становится
// правилом для мастера (игрок его не кидает), а расход ячейки уходит из действия в лист —
// поэтому работают ячейки Договора, ритуал и выбранный круг, и нет двойного списания.
//
// Запуск:  node tools/srd/migrate_spells_071.cjs [--check] [srd_2014.json srd_2024.json]
//          --check — только отчёт, файлы не трогаются.
//
// Пересборку записей делает static/spell-rules.js (та же функция, что и на листе персонажа):
// здесь — чтение справочника, английский слой, проверки и запись. Файл переписывается заменой
// подстроки механик: остальное содержимое остаётся байт-в-байт, иначе весь data_seed уехал бы в диф.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const LOAD = ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js',
              ...require(path.join(ROOT, 'tools/nodes/node-loader.cjs')).nodeFiles().map(f => path.relative(ROOT, f)),
              'static/spell-rules.js', 'static/mechanics-graph.js'];

function harness() {
  const el = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(v => v !== null && v !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...m) { this.children.push(...m.flat()); }, appendChild(v) { this.children.push(v); }, replaceChildren(...v) { this.children = v.flat().filter(x => x !== null && x !== undefined); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } });
  const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } },
    ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' }, SKILLS: [] };
  vm.createContext(ctx);
  for (const file of LOAD) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  return { M: ctx.window.Mechanics, SR: ctx.window.SpellRules };
}

const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const structured = v => isObj(v) || Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idAligned = (ru, en) => Array.isArray(ru) && Array.isArray(en) && ru.length === en.length && ru.length > 0
  && ru.every((x, i) => isObj(x) && isObj(en[i]) && typeof x.id === 'string') && ru.every((x, i) => x.id === en[i].id);
/// Слой перевода записи: то, чем английский вид отличается от русского (зеркало localize.diff).
function diff(ru, en) {
  if (isObj(ru) && isObj(en)) {
    const out = {};
    for (const key of Object.keys(en)) {
      if (!(key in ru) || structured(ru[key]) !== structured(en[key])) { out[key + '!'] = en[key]; continue; }
      if (isObj(ru[key]) && isObj(en[key]) && !same(Object.keys(ru[key]).sort(), Object.keys(en[key]).sort())) { out[key + '!'] = en[key]; continue; }
      if (Array.isArray(ru[key]) && Array.isArray(en[key]) && !same(ru[key], en[key]) && !idAligned(ru[key], en[key])) { out[key + '!'] = en[key]; continue; }
      const d = diff(ru[key], en[key]);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (Array.isArray(ru) && Array.isArray(en)) {
    if (same(ru, en)) return undefined;
    if (idAligned(ru, en)) {
      const res = [];
      for (let i = 0; i < ru.length; i++) { const d = diff(ru[i], en[i]); if (d !== undefined) res.push({ id: ru[i].id, ...d }); }
      return res.length ? res : undefined;
    }
    return en;
  }
  return ru === en ? undefined : en;
}
/// Слияние слоя перевода (зеркало localize.merge): проверяем, что слой воспроизводит английский вид.
function merge(base, overlay) {
  // Массивы объектов с id сливаются по id (как в localize.merge и src/i18n.rs): слой хранит только отличия.
  if (Array.isArray(base) && Array.isArray(overlay) && base.length && overlay.length
      && [...base, ...overlay].every(item => isObj(item) && typeof item.id === 'string')) {
    const out = base.map(item => JSON.parse(JSON.stringify(item)));
    const index = new Map(out.map((item, i) => [item.id, i]));
    for (const item of overlay) {
      if (index.has(item.id)) { const at = index.get(item.id); out[at] = merge(out[at], item); }
      else { index.set(item.id, out.length); out.push(JSON.parse(JSON.stringify(item))); }
    }
    return out;
  }
  if (isObj(base) && isObj(overlay)) {
    const out = JSON.parse(JSON.stringify(base));
    for (const [key, value] of Object.entries(overlay)) {
      if (key.endsWith('!')) out[key.slice(0, -1)] = JSON.parse(JSON.stringify(value));
      else out[key] = key in out ? merge(out[key], value) : JSON.parse(JSON.stringify(value));
    }
    return out;
  }
  return JSON.parse(JSON.stringify(overlay));
}
/// Карты переводов узлов записи: русский текст, имя и тип урона → английские.
function translations(mechanics, overlay) {
  const enNodes = new Map(((overlay || {}).graph?.nodes || []).map(node => [node.id, node]));
  const texts = new Map(), names = new Map(), types = new Map();
  for (const node of mechanics?.graph?.nodes || []) {
    const en = enNodes.get(node.id);
    if (!en) continue;
    const ruParams = node.params || {}, enParams = en.params || en['params!'] || {};
    if (typeof ruParams.text === 'string' && typeof enParams.text === 'string') texts.set(ruParams.text, enParams.text);
    if (typeof ruParams.name === 'string' && typeof enParams.name === 'string') names.set(ruParams.name, enParams.name);
    if (typeof ruParams.damage_type === 'string' && typeof enParams.damage_type === 'string') types.set(ruParams.damage_type, enParams.damage_type);
  }
  const pick = map => value => map.get(value) ?? value;
  return { text: pick(texts), name: pick(names), type: pick(types), types };
}
/// Узлы, которые migrate создаёт сам (ветвление по попаданию), получают случайные id: в английском
/// виде их заменяем на русские, иначе слой перевода добавлял бы в запись лишние узлы.
function alignGenerated(russianNodes, englishGraph, report, slug) {
  const byId = new Map(russianNodes.map(node => [node.id, node]));
  const free = russianNodes.filter(node => !englishGraph.nodes.some(other => other.id === node.id));
  const renamed = new Map();
  for (const node of englishGraph.nodes) {
    if (byId.has(node.id)) continue;
    const index = free.findIndex(other => other.type === node.type);
    if (index < 0) { report.structure.push(`${slug}: узел ${node.type} ${node.id} английского вида не имеет пары в русском`); return false; }
    const pair = free.splice(index, 1)[0];
    renamed.set(node.id, pair.id);
    node.id = pair.id;
  }
  if (free.length) { report.structure.push(`${slug}: в русском виде остались узлы без пары: ${free.map(n => n.type).join(', ')}`); return false; }
  // Связи ссылаются на узлы по id: переименование узла переписывает и их.
  for (const link of englishGraph.links || []) {
    if (renamed.has(link.from.node)) link.from.node = renamed.get(link.from.node);
    if (renamed.has(link.to.node)) link.to.node = renamed.get(link.to.node);
  }
  const ids = new Set(russianNodes.map(node => node.id));
  for (const node of englishGraph.nodes) if (!ids.has(node.id)) { report.structure.push(`${slug}: узел ${node.id} английского вида чужд русскому`); return false; }
  return true;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const names = args.filter(a => a.endsWith('.json'));
const { M, SR } = harness();
const report = { records: 0, changed: 0, written: 0, saves: 0, invalid: [], problems: [], structure: [], missing: [], mismatch: [] };

for (const name of (names.length ? names : ['srd_2014.json', 'srd_2024.json'])) {
  const file = path.join(ROOT, 'data_seed', name);
  const raw = fs.readFileSync(file, 'utf8');
  const rows = JSON.parse(raw);
  let text = raw, written = 0;
  const expected = [];
  for (const row of rows) {
    if (row.category !== 'spell' || !row.data?.mechanics) continue;
    report.records++;
    const d = row.data, en = d.i18n?.en || {};
    const meta = { level: d.level, desc: d.desc, actions: d.actions, saveAbility: d.save_ability, lang: 'ru' };
    const v1 = M.toLegacy(d.mechanics, { level: d.level, edition: d.edition });
    const origin = v1.origin || d.mechanics.origin || 'spell-v1';
    const merged = SR.spellPrograms(v1.programs, meta);
    if (!merged.changed) continue;
    report.changed++;
    const russian = M.migrate({ mechanics: { version: 1, origin, programs: merged.programs } }, 'spell');
    if (russian.graph.nodes.some(node => node.type === 'action.manual' && M.isSaveRule(node.params.text))) report.saves++;
    const problem = M.validate(russian); if (problem) report.invalid.push(`${row.slug}: ${problem}`);
    const issues = M.problems(russian); if (issues.length) report.problems.push(`${row.slug}: ${issues.join(' | ')}`);
    // Английский вид собирается теми же правилами по английским текстам записи, слой — разницей ru/en.
    const map = translations(d.mechanics, en.mechanics);
    for (const [index, action] of (d.actions || []).entries()) {
      const translated = (en['actions!'] || [])[index];
      if (action?.dtype && translated?.dtype) map.types.set(action.dtype, translated.dtype);
    }
    const enMeta = { ...meta, lang: 'en', desc: en.desc ?? d.desc, actions: en['actions!'] ?? d.actions,
                     saveAbility: M.abilityCode(d.save_ability, 'en') };
    const enPrograms = v1.programs.map(program => ({ ...program, name: map.name(program.name),
      blocks: (program.blocks || []).map(block => ({ ...block,
        ...(block.text !== undefined ? { text: map.text(block.text) } : {}),
        ...(block.name !== undefined ? { name: map.name(block.name) } : {}),
        ...(block.damage_type !== undefined ? { damage_type: map.type(block.damage_type) } : {}) })) }));
    const english = M.migrate({ mechanics: { version: 1, origin, programs: SR.spellPrograms(enPrograms, enMeta).programs } }, 'spell');
    if (!alignGenerated(russian.graph.nodes, english.graph, report, row.slug)) continue;
    const overlay = diff(russian, english);
    if (overlay && !same(merge(russian, overlay), english)) report.structure.push(`${row.slug}: слой перевода не воспроизводит английский вид`);
    expected.push({ slug: row.slug, mechanics: russian, overlay });
    if (check) continue;
    const oldMechanics = JSON.stringify(d.mechanics), newMechanics = JSON.stringify(russian);
    if (!text.includes(oldMechanics)) { report.missing.push(`${row.slug} (механики)`); continue; }
    text = text.replace(oldMechanics, newMechanics);
    if (en.mechanics === undefined) continue;
    const oldOverlay = JSON.stringify(en.mechanics);
    if (!text.includes(oldOverlay)) { report.missing.push(`${row.slug} (слой перевода)`); continue; }
    // Слой пустой (английский вид совпал с русским) — ключ убирается целиком.
    text = overlay === undefined ? text.replace(`, "mechanics":${oldOverlay}`, '') : text.replace(oldOverlay, JSON.stringify(overlay));
  }
  if (check || !expected.length) { console.log(`${name}: пересобрано ${expected.length}`); continue; }
  // Проверка результата: файл разбирается, механики и слой совпадают с расчётными.
  const parsed = JSON.parse(text);
  for (const entry of expected) {
    const row = parsed.find(item => item.slug === entry.slug);
    if (!same(row?.data?.mechanics, entry.mechanics)) report.mismatch.push(`${entry.slug} (механики)`);
    if (!same(row?.data?.i18n?.en?.mechanics, entry.overlay)) report.mismatch.push(`${entry.slug} (слой перевода)`);
  }
  fs.writeFileSync(file, text);
  written = expected.length;
  report.written += written;
  console.log(`${name}: пересобрано ${written} записей`);
}
console.log(JSON.stringify(report, null, 1));
if (report.invalid.length || report.problems.length || report.structure.length || report.missing.length || report.mismatch.length) {
  console.error('ЕСТЬ ПРОБЛЕМЫ'); process.exit(1);
}
