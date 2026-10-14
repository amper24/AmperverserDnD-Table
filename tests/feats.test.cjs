// Черты — отдельный элемент справочника: записи категории «feat» собирает tools/srd/build_feats.py,
// а редакторы расы и класса ссылаются на них полем feat (data.traits[i].feat, data.feature_feats,
// строка feat в узле rule.class_features). Проверки: сборка, полнота ссылок, граф и английский
// слой у записей, а также выбор черты из справочника в обоих редакторах (DOM-прогон).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EDITIONS = ['2014', '2024'];
const PREFIX = { 2014: 'srd14-', 2024: 'srd24-' };
const COUNTS = { 2014: 324, 2024: 282 };
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const seeds = Object.fromEntries(EDITIONS.map(e => [e, read(`data_seed/srd_${e}.json`)]));
const feats = Object.fromEntries(EDITIONS.map(e => [e, read(`data_seed/feats_${e}.json`)]));
const catalog = Object.fromEntries(EDITIONS.map(e => [e, feats[e].map((f, i) =>
  ({ id: `f-${e}-${i}`, category: 'feat', slug: f.slug, name: f.name, source: `SRD ${e}`, data: f.data }))]));
const bySlug = Object.fromEntries(EDITIONS.map(e => [e, new Map(feats[e].map(f => [f.slug, f]))]));
/// Черты записи набора: расы (data.traits), классы и подклассы (features + feature_texts).
function rowsOf(edition, kind) {
  const out = [];
  for (const row of seeds[edition]) {
    if (row.category !== 'race' && row.category !== 'class') continue;
    if (kind === 'race' && row.category === 'race') out.push(...(row.data.traits || []).map(t => ({ row, level: null, name: t.name, ref: t.feat })));
    if (kind === 'class' && row.category === 'class') {
      for (const [level, names] of Object.entries(row.data.features || {}))
        for (const name of names) out.push({ row, level, name, ref: (row.data.feature_feats?.[level] || {})[name] });
    }
    if (kind === 'subclass' && row.category === 'class') {
      for (const sub of row.data.subclasses || [])
        for (const [level, names] of Object.entries(sub.features || {}))
          for (const name of names) out.push({ row, level, name, ref: (sub.feature_feats?.[level] || {})[name], sub: sub.name });
    }
  }
  return out;
}
/// Строки узла rule.class_features: копия умений класса со ссылкой на черту.
function tableRows(row) {
  const nodes = (row.data.mechanics?.graph?.nodes || []).filter(n => n.type === 'rule.class_features');
  const levels = nodes[0]?.params?.table?.levels || {};
  return Object.entries(levels).flatMap(([level, items]) => (items || []).map(item => ({ level, ...item })));
}

test('черты справочника собраны генератором и разложены по редакциям', () => {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'srd', 'build_feats.py'), '--check']).toString();
  assert.match(out, /черты и ссылки на них актуальны/);
  for (const edition of EDITIONS) {
    const rows = feats[edition];
    assert.equal(rows.length, COUNTS[edition], `черт в ${edition}`);
    assert.equal(new Set(rows.map(r => r.slug)).size, rows.length, `${edition}: слаги уникальны`);
    assert.ok(rows.every(r => r.category === 'feat' && r.slug.startsWith(`${PREFIX[edition]}feat-`)), `${edition}: записи категории feat своей редакции`);
    assert.deepEqual([...new Set(rows.map(r => r.data.edition))], [edition], `${edition}: поле data.edition`);
  }
});

test('каждая черта набора — ссылка на запись справочника (все черты, а не часть)', () => {
  for (const edition of EDITIONS) {
    for (const kind of ['race', 'class', 'subclass']) {
      const rows = rowsOf(edition, kind);
      assert.ok(rows.length > 20, `${edition}/${kind}: черт для проверки ${rows.length}`);
      const bad = rows.filter(r => !r.ref || !bySlug[edition].has(r.ref));
      assert.deepEqual(bad.map(r => `${r.row.slug} ${r.level || ''} ${r.name}`), [], `${edition}/${kind}: без ссылки на запись справочника`);
      // Ссылка ведёт на запись того же вида и с тем же названием и текстом.
      for (const r of rows) {
        const record = bySlug[edition].get(r.ref);
        assert.equal(record.name, r.name, `${r.ref}: название записи совпадает с чертой набора`);
        assert.equal(record.data.kind, kind, `${r.ref}: вид записи`);
      }
    }
    // Умения класса скопированы в узел rule.class_features — ссылка должна быть и там.
    const classes = seeds[edition].filter(r => r.category === 'class');
    const missing = classes.flatMap(row => tableRows(row).filter(item => !item.feat || !bySlug[edition].has(item.feat))
      .map(item => `${row.slug} ${item.level} ${item.name}`));
    assert.deepEqual(missing, [], `${edition}: строки узла rule.class_features со ссылкой`);
  }
});

test('все ссылки разрешаются в своей редакции, чужих записей нет', () => {
  for (const edition of EDITIONS) {
    const other = edition === '2014' ? '2024' : '2014';
    const refs = ['race', 'class', 'subclass'].flatMap(kind => rowsOf(edition, kind).map(r => r.ref));
    assert.ok(refs.every(ref => !bySlug[other].has(ref)), `${edition}: ссылок на записи другой редакции нет`);
    // Обратная сторона: у каждой записи есть владелец из набора.
    for (const record of feats[edition]) {
      assert.ok(Array.isArray(record.data.owners) && record.data.owners.length, `${record.slug}: владельцы перечислены`);
      assert.ok(['race', 'class', 'subclass'].includes(record.data.kind), `${record.slug}: вид черты`);
    }
  }
});

test('запись черты: текст, английский слой и граф с программой «Правила применения»', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  const files = ['static/common.js', 'static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js',
    'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js'];
  for (const file of files)
    vm.runInContext(fs.readFileSync(file.startsWith('/') ? file : path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  const Mechanics = ctx.window.Mechanics;
  for (const edition of EDITIONS) {
    for (const record of feats[edition]) {
      const data = record.data;
      assert.ok(data.desc && data.desc.trim(), `${record.slug}: текст черты`);
      assert.ok(data.i18n?.en?.name && data.i18n?.en?.desc, `${record.slug}: английский слой`);
      assert.ok(!/[\u0400-\u04FF]/.test(data.i18n.en.desc), `${record.slug}: в английском тексте нет кириллицы`);
      const nodes = data.mechanics?.graph?.nodes || [];
      const program = nodes.find(n => n.type === 'action.program');
      const manual = nodes.find(n => n.type === 'action.manual');
      assert.equal(program?.params?.name, 'Правила применения', `${record.slug}: программа`);
      assert.equal(program?.params?.trigger, 'use', `${record.slug}: триггер программы`);
      assert.equal(manual?.params?.text, data.desc, `${record.slug}: текст черты — в блоке программы`);
      assert.equal(Mechanics.validate(data.mechanics) || '', '', `${record.slug}: граф без ошибок`);
      // Проекция графа кладёт черту на лист умением — как запись черты набора SRD.
      const sheet = { edition: String(edition), level: 1, features: [], skills: [], saving_throws: [], abilities: {}, hp: { max: 0, current: 0, temp: 0 } };
      const applied = Mechanics.applyGraphRules(data.mechanics, sheet, { edition: String(edition), level: 1, source: record.name });
      assert.equal(applied.error, '', `${record.slug}: проекция без ошибок`);
    }
  }
});

// ---------- DOM-прогон: выбор черты из справочника в редакторах ----------
function makeNode(tag) {
  return {
    tag, nodeType: 1, children: [], parentElement: null, style: {}, dataset: {}, attributes: {},
    className: '', value: '', checked: false, disabled: false, _listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    append(...cs) { for (const c of cs) if (c != null) { c.parentElement = this; this.children.push(c); } },
    appendChild(c) { this.append(c); },
    replaceChildren(...cs) { this.children = []; this.append(...cs); },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    removeEventListener() { },
    contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentElement; } return false; },
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], focus() { }, blur() { }, setSelectionRange() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }), setPointerCapture() { },
  };
}
const domStub = { documentElement: { dataset: {} }, createElement: t => makeNode(t), createDocumentFragment: () => makeNode('#fragment'),
  createElementNS: (ns, t) => makeNode(t), createTextNode: t => ({ nodeType: 3, textContent: String(t), parentElement: null, children: [] }),
  body: makeNode('body'), activeElement: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() { }, removeEventListener() { } };
const domCtx = { console, crypto: require('node:crypto').webcrypto, document: domStub, matchMedia: () => ({ matches: false }),
  localStorage: { getItem: () => null, setItem() { }, removeItem() { } }, location: { host: 'test', protocol: 'http:', pathname: '/', href: '' },
  navigator: { language: 'ru' }, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL, structuredClone };
domCtx.window = domCtx;
domCtx.globalThis = domCtx;
vm.createContext(domCtx);
const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(domCtx);
for (const f of ['static/common.js', 'static/dice.js', 'static/formulas.js', 'static/equipment.js', 'static/mechanics.js', 'static/node-params-form.js',
  'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles().map(f => path.relative(ROOT, f)),
  'static/mechanics-graph.js', 'static/modules.js', 'static/class-rules.js', 'static/character-builder.js',
  'static/race-editor.js', 'static/class-editor.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), domCtx, { filename: f });

const walk = (node, fn) => { fn(node); for (const c of node.children || []) walk(c, fn); };
const text = node => !node ? '' : node.nodeType === 3 ? node.textContent : (node.children || []).map(text).join('');
const all = (root, cls) => { const out = []; walk(root, n => { if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n); }); return out; };
const allTag = (root, tag) => { const out = []; walk(root, n => { if (n.tag === tag) out.push(n); }); return out; };
const fire = (node, ev, arg) => { for (const fn of node._listeners[ev] || []) fn(arg); };
const clickNode = node => fire(node, 'click', { target: node, stopPropagation() { }, preventDefault() { } });
const pickIn = (node, value) => { node.value = value; fire(node, 'change', { target: node }); };
const selectIn = (root, value) => allTag(root, 'select').find(s => s.attributes['aria-label'] === value);
/// Выбранное значение списка: в стабе DOM свойство value не выводится из опций.
const selectedOf = select => (allTag(select, 'option').find(o => o.attributes.selected === '') || { attributes: {} }).attributes.value;
const drop = (zone, type, payload) => fire(zone, 'drop', {
  dataTransfer: { types: [type], getData: t => (t === type ? JSON.stringify(payload) : '') }, preventDefault() { }, stopPropagation() { },
});
const srd = (edition, slug) => {
  const row = seeds[edition].find(r => r.slug === slug);
  return { id: slug, category: row.category, name: row.name, source: `SRD ${edition}`, pack_id: null, campaign_id: null, data: JSON.parse(JSON.stringify(row.data)) };
};
const CATALOG = { 2014: catalog['2014'], 2024: catalog['2024'] };

test('редактор расы: черта выбирается из справочника и пишется ссылкой', async () => {
  await presetsReady;
  let captured = null;
  domCtx.modal = (title, content, buttons) => { captured = { title, content, buttons }; return Promise.resolve(null); };
  const RE = domCtx.window.RaceEditor;
  const entry = srd('2014', 'srd14-high-elf');
  await RE.edit(entry, { catalog: [], feats: CATALOG['2014'] });
  const navTo = title => clickNode(all(captured.content, 'ced-nav-btn').find(b => text(b) === title));
  navTo('Черты');

  // Список — записи своей редакции: черты расы, черта своей расы идёт первой.
  const cards = all(captured.content, 'ced-block');
  assert.equal(cards.length, 3, 'каждая черта — карточка');
  const first = selectIn(cards[0], 'Черта из справочника');
  assert.ok(first, 'у черты есть список записей справочника');
  assert.equal(selectedOf(first), 'srd14-feat-elf-weapon-training', 'черта SRD уже ссылается на запись');
  assert.ok(all(captured.content, 'ced-counter')[0] && text(all(captured.content, 'ced-counter')[0]).includes('3 из 3'), 'счётчик ссылок');

  // Выбор записи подтягивает название и текст, ссылка сохраняется.
  pickIn(first, 'srd14-feat-fey-ancestry');
  const card = all(captured.content, 'ced-block')[0];
  assert.equal(allTag(card, 'input')[0].attributes.value, 'Наследие фей', 'название пришло из записи');
  assert.ok(text(allTag(card, 'textarea')[0]).includes('очарования'), 'текст пришёл из записи');

  // Перетаскивание записи из справочника добавляет новую черту со ссылкой.
  const zone = all(captured.content, 'ced-drop')[0];
  drop(zone, 'application/x-feat', { entry: CATALOG['2014'].find(e => e.slug === 'srd14-feat-darkvision'), slug: 'srd14-feat-darkvision' });
  assert.equal(all(captured.content, 'ced-block').length, 4, 'перетащенная черта стала карточкой');
  assert.equal(allTag(captured.content, 'input').filter(i => i.attributes.placeholder === 'Название черты').map(i => i.attributes.value).join(','),
    'Наследие фей,Заговор высшего эльфа,Дополнительный язык,Тёмное зрение', 'прежние черты на месте, новая — в конце');

  // Сохранение: ссылки уходят и в поле данных, и в программу графа.
  const save = captured.buttons[0].fn();
  const traits = save.data.traits;
  assert.equal(traits[0].feat, 'srd14-feat-fey-ancestry');
  assert.equal(traits[0].name, 'Наследие фей');
  assert.equal(traits[3].feat, 'srd14-feat-darkvision');
  const programs = (save.data.mechanics?.graph?.nodes || []).filter(n => n.type === 'action.program' && n.params.group === 'traits');
  assert.equal(programs.length, 4, 'на каждую черту — программа графа');
  assert.ok(programs.some(p => p.params.feature_name === 'Наследие фей'), 'программа обновлена новым названием');
  assert.equal(domCtx.window.Mechanics.validate(save.data.mechanics) || '', '', 'граф записи валиден');
});

test('редактор класса: умение уровня и подкласса выбирается из справочника', async () => {
  await presetsReady;
  let captured = null;
  domCtx.modal = (title, content, buttons) => { captured = { title, content, buttons }; return Promise.resolve(null); };
  const CE = domCtx.window.ClassEditor;
  const entry = srd('2014', 'srd14-barbarian');
  await CE.edit(entry, { feats: CATALOG['2014'] });
  const navTo = title => clickNode(all(captured.content, 'ced-nav-btn').find(b => text(b) === title));

  // Умения уровня: у «Ярости» уже есть ссылка, выбор другой записи её меняет.
  navTo('Уровни 1–20');
  clickNode(all(captured.content, 'ced-feat-btn')[0]);
  const pick = selectIn(all(captured.content, 'ced-feature')[0], 'Черта из справочника');
  assert.ok(pick, 'у умения есть список записей справочника');
  assert.equal(selectedOf(pick), 'srd14-feat-rage', 'умение SRD уже ссылается на запись');
  assert.deepEqual(JSON.parse(JSON.stringify(all(captured.content, 'ced-feat-row').map(r => text(r.children.at(-1))))),
    ['ссылка: srd14-feat-rage', 'ссылка: srd14-feat-unarmored-defense'], 'подпись ссылки у каждого умения');
  pickIn(pick, 'srd14-feat-reckless-attack');
  const feature = all(captured.content, 'ced-feature')[0];
  assert.equal(allTag(feature, 'input')[0].attributes.value, 'Безрассудная атака', 'название пришло из записи');
  assert.ok(text(allTag(feature, 'textarea')[0]).includes('преимуществ'), 'текст пришёл из записи');

  // Подкласс: перетаскивание записи видов «умение подкласса».
  navTo('Подклассы');
  const subZone = all(captured.content, 'ced-drop')[0];
  drop(subZone, 'application/x-feat', { entry: CATALOG['2014'].find(e => e.slug === 'srd14-feat-frenzy'), slug: 'srd14-feat-frenzy' });
  const subFeature = all(captured.content, 'ced-feature').at(-1);
  assert.equal(allTag(subFeature, 'input')[1].attributes.value, 'Бешенство', 'умение подкласса из справочника');
  assert.ok(allTag(subFeature, 'select').length, 'строка выбора записи есть у умения подкласса');

  // Сохранение: ссылки уровня и подкласса.
  const save = captured.buttons[0].fn();
  const plain = x => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(save.data.feature_feats['1']), { 'Безрассудная атака': 'srd14-feat-reckless-attack', 'Защита без доспехов': 'srd14-feat-unarmored-defense' });
  assert.deepEqual(plain(save.data.subclasses[0].feature_feats['3']), { 'Бешенство': 'srd14-feat-frenzy' });
  const node = save.data.mechanics.graph.nodes.find(n => n.type === 'rule.class_features');
  assert.equal(node.params.table.levels['1'][0].feat, 'srd14-feat-reckless-attack', 'ссылка — и в таблице узла');
  assert.equal(domCtx.window.Mechanics.validate(save.data.mechanics) || '', '', 'граф записи валиден');
});
