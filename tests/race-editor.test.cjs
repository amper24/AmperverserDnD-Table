// Регрессия редактора расы (static/race-editor.js): чтение/запись записи, узлы графа
// (rule.speed, rule.languages, rule.ability_bonus, rule.skill_proficiency, rule.skills,
// rule.proficiencies) и программы черт. Скрипт запускается в vm со стабом DOM и наборами данных.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { console, crypto: require('node:crypto').webcrypto, window: {}, localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
  matchMedia: () => ({ matches: false }), location: { host: 'test', protocol: 'http:', pathname: '/', href: '' },
  navigator: { language: 'ru' }, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL, structuredClone };
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

const presetsReady = require('../tools/presets/node-loader.cjs').loadPresets(ctx);
before(() => presetsReady);
// presets.js не перезапускаем: его уже загрузил node-loader (иначе реестр пуст).
// node-loader отдаёт абсолютные пути, остальные файлы — относительно static/.
const FILES = ['common.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'node-params-form.js', 'node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'mechanics-graph.js', 'modules.js', 'class-rules.js', 'character-builder.js', 'race-editor.js'];
for (const f of FILES) vm.runInContext(fs.readFileSync(f.startsWith('/') ? f : 'static/' + f, 'utf8'), ctx, { filename: f });

const RE = ctx.window.RaceEditor;
const M = ctx.window.Mechanics;
// Объекты из vm — другого окружения: сравнение идёт через JSON.
const plain = x => JSON.parse(JSON.stringify(x));
const seed = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
const RACES = seed.filter(e => e.category === 'race');
const raceByName = name => RACES.find(e => e.name === name);
const nodesOfType = (d, type) => (d.mechanics?.graph?.nodes || []).filter(n => n.type === type);
const entryOf = (data, name = 'Дварф') => ({ id: 'r1', category: 'race', name, data });

test('круг чтения и записи: правки доходят до мастера создания и не теряют узлы', () => {
  const source = raceByName('Эльф');
  const st = RE.readState(source);
  assert.equal(st.speed, 30);
  assert.equal(st.asi.dex, 2, 'бонус прочитан из узла rule.ability_bonus');
  assert.ok(st.languages.fixed.includes('Эльфийский'));
  assert.ok(st.languages.note.includes('говорить, читать и писать'), 'длинное примечание отделено от имён');
  assert.deepEqual(plain(st.skills.fixed), ['Восприятие'], 'владение навыком из пассивного блока/поля');
  assert.ok(st.traits.some(t => t.name === 'Транс'));

  st.speed = 35;
  st.asi.dex = 3;
  st.languages.fixed.push('Драконий');
  st.skills.fixed.push('Скрытность');
  st.traits[0].text = 'Новый текст черты.';
  const out = RE.writeData(st, source);
  assert.equal(out.speed, 35);
  assert.equal(nodesOfType(out, 'rule.speed')[0].params.value, 35, 'узел скорости обновлён');
  assert.equal(nodesOfType(out, 'rule.ability_bonus').find(n => n.params.ability === 'dex').params.amount, 3);
  assert.deepEqual(plain(nodesOfType(out, 'rule.languages')[0].params.value), ['Общий', 'Эльфийский', 'Драконий']);
  assert.deepEqual(plain(nodesOfType(out, 'rule.skill_proficiency')[0].params.value), ['Восприятие', 'Скрытность']);
  assert.ok(out.languages.includes('Драконий'));
  assert.ok(out.languages.some(x => x.includes('говорить, читать и писать')), 'примечание не потеряно');
  assert.equal(out.traits[0].text, 'Новый текст черты.');
  // Прочие узлы графа (пассивные блоки, программы черт) не пропали.
  const before = (source.data.mechanics.graph.nodes || []).length;
  assert.ok((out.mechanics.graph.nodes || []).length >= before, 'узлы графа сохранились');
  assert.equal(M.validate(out.mechanics) || '', '', 'граф остался валидным');
});

test('узлы правил обновляются на месте: связи условия редакции не рвутся', () => {
  const source = raceByName('Дварф');
  const speedId = nodesOfType(source.data, 'rule.speed')[0].id;
  const links = source.data.mechanics.graph.links.filter(l => l.to.node === speedId).length;
  const st = RE.readState(source);
  st.speed = 25;
  const out = RE.writeData(st, source);
  assert.equal(nodesOfType(out, 'rule.speed')[0].id, speedId, 'тот же узел');
  assert.equal(out.mechanics.graph.links.filter(l => l.to.node === speedId).length, links);
});

test('характеристики: убрали бонус — узел удалён, добавили — создан', () => {
  const source = raceByName('Эльф');
  const st = RE.readState(source);
  st.asi.dex = 0;
  st.asi.cha = 1;
  const out = RE.writeData(st, source);
  const nodes = nodesOfType(out, 'rule.ability_bonus');
  assert.deepEqual(plain(nodes.map(n => n.params.ability)), ['cha']);
  assert.equal(nodes[0].params.amount, 1);
  assert.deepEqual(plain(out.asi), { cha: 1 });
});

test('навыки: владение узлом, выбор игрока — своим узлом, и проекция даёт владение листу', () => {
  const st = RE.readState(entryOf(RE.emptyData()));
  st.skills.fixed.push('Восприятие');
  st.skills.choose = 2;
  st.skills.from.push('Скрытность', 'Магия');
  const out = RE.writeData(st, entryOf(RE.emptyData()));
  assert.deepEqual(plain(nodesOfType(out, 'rule.skill_proficiency')[0].params.value), ['Восприятие']);
  const choice = nodesOfType(out, 'rule.skills')[0];
  assert.equal(choice.params.count, 2);
  assert.deepEqual(plain(choice.params.options), ['Скрытность', 'Магия']);
  assert.equal(choice.params.id, 'race_skills');
  // Проекция графа: владение приходит ключом, выбор — с подстановкой выбора игрока.
  const sheet = { edition: '2014', level: 1, skills: [], proficiencies: '', languages: [], features: [], saving_throws: [], abilities: {}, hp: { max: 0, current: 0, temp: 0 } };
  const applied = M.applyGraphRules(out.mechanics, sheet, { edition: '2014', level: 1, choices: { race_skills: ['Скрытность'] } });
  assert.equal(applied.error, '');
  assert.deepEqual(plain(sheet.skills), ['perception', 'stealth']);
  assert.equal(sheet.skill_choices[0].count, 2);
});

test('черты: программа графа следует за названием и текстом, лишняя удаляется', () => {
  const source = raceByName('Эльф');
  const st = RE.readState(source);
  const first = st.traits[0].name;
  st.traits[0].name = 'Острое зрение';
  st.traits[0].text = 'Видите в темноте на 60 футов.';
  const count = st.traits.length;
  st.traits.push({ name: 'Новая черта', text: 'Текст новой черты.' });
  const out = RE.writeData(st, source);
  const programs = nodesOfType(out, 'action.program').filter(n => n.params?.group === 'traits');
  assert.equal(programs.length, count + 1, 'по программе на черту');
  const renamed = programs.find(p => p.params.feature_name === 'Острое зрение');
  assert.ok(renamed, 'программа переименована вместе с чертой');
  assert.ok(!programs.some(p => p.params.feature_name === first), 'старого названия нет');
  const link = out.mechanics.graph.links.find(l => l.from.node === renamed.id);
  const manual = out.mechanics.graph.nodes.find(n => n.id === link.to.node);
  assert.equal(manual.type, 'action.manual');
  assert.equal(manual.params.text, 'Видите в темноте на 60 футов.');
  assert.equal(M.validate(out.mechanics) || '', '');

  // Убрали черту — убралась и её программа с текстом.
  const st2 = RE.readState({ data: out });
  st2.traits = st2.traits.filter(t => t.name !== 'Новая черта');
  const out2 = RE.writeData(st2, { data: out });
  const programs2 = nodesOfType(out2, 'action.program').filter(n => n.params?.group === 'traits');
  assert.equal(programs2.length, count);
  assert.ok(!programs2.some(p => p.params.feature_name === 'Новая черта'));
  assert.equal(M.validate(out2.mechanics) || '', '');
});

test('новая раса: пустая запись собирает валидный граф и полный набор полей', () => {
  const st = RE.readState(entryOf(RE.emptyData('2024'), 'Своя раса'));
  assert.equal(st.edition, '2024');
  assert.equal(st.speed, 30);
  const out = RE.writeData(st, entryOf(RE.emptyData('2024'), 'Своя раса'));
  assert.equal(out.mechanics.version, 2);
  assert.equal(M.validate(out.mechanics) || '', '');
  assert.equal(out.size, 'Средний');
  assert.deepEqual(plain(out.languages || []), []);
  assert.deepEqual(plain(out.traits), []);
});

test('владения: по узлу rule.proficiencies на каждый вид', () => {
  const st = RE.readState(entryOf(RE.emptyData()));
  st.profs.push({ kind: 'Оружие', values: ['Боевой топор', 'Ручной топор'] });
  st.profs.push({ kind: 'Инструменты', values: ['Кузнечные инструменты'] });
  const out = RE.writeData(st, entryOf(RE.emptyData()));
  const nodes = nodesOfType(out, 'rule.proficiencies');
  assert.deepEqual(plain(nodes.map(n => n.params.kind)), ['Оружие', 'Инструменты']);
  assert.deepEqual(plain(nodes[0].params.value), ['Боевой топор', 'Ручной топор']);
  const st2 = RE.readState({ data: out });
  assert.deepEqual(plain(st2.profs), [{ kind: 'Оружие', values: ['Боевой топор', 'Ручной топор'] }, { kind: 'Инструменты', values: ['Кузнечные инструменты'] }]);
});

// ---------- DOM-прогон: редактор открывается, разделы рисуются, правки сохраняются ----------
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
const domPresets = require('../tools/presets/node-loader.cjs').loadPresets(domCtx);
for (const f of FILES) vm.runInContext(fs.readFileSync(f.startsWith('/') ? f : 'static/' + f, 'utf8'), domCtx, { filename: f });

const walk = (node, fn) => { fn(node); for (const c of node.children || []) walk(c, fn); };
const text = node => !node ? '' : node.nodeType === 3 ? node.textContent : (node.children || []).map(text).join('');
const all = (root, cls) => { const out = []; walk(root, n => { if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n); }); return out; };
const allTag = (root, tag) => { const out = []; walk(root, n => { if (n.tag === tag) out.push(n); }); return out; };
const byPlaceholder = (root, ph) => { let f = null; walk(root, n => { if (n.tag === 'input' && n.attributes.placeholder === ph && !f) f = n; }); return f; };
const fire = (node, ev, arg) => { for (const fn of node._listeners[ev] || []) fn(arg); };
const clickNode = node => fire(node, 'click', { target: node, stopPropagation() { }, preventDefault() { } });
const typeIn = (node, value) => { node.value = value; fire(node, 'input', { target: node }); };

test('редактор расы открывается: все разделы рисуются и правки уходят в запись', async () => {
  await domPresets;
  let captured = null;
  domCtx.modal = (title, content, buttons, opts) => { captured = { title, content, buttons, opts }; return Promise.resolve(null); };
  const RE2 = domCtx.window.RaceEditor;
  await RE2.edit(null, {});
  assert.ok(captured, 'модальное окно редактора открыто');
  assert.match(captured.title, /Новая раса/);

  typeIn(byPlaceholder(captured.content, 'Дварф'), 'Гном');
  typeIn(byPlaceholder(captured.content, 'Dwarf'), 'Gnome');

  const navTo = title => clickNode(all(captured.content, 'ced-nav-btn').find(b => text(b) === title));
  for (const sec of RE2.SECTIONS) {
    const btn = all(captured.content, 'ced-nav-btn').find(b => text(b) === sec.title);
    assert.ok(btn, `раздел «${sec.title}» есть в навигации`);
    clickNode(btn);
    const heading = all(captured.content, 'ced-section')[0]?.children?.[0];
    assert.ok(heading && text(heading) === sec.title, `раздел «${sec.title}» отрисован`);
  }

  // Языки: добавляем из списка.
  navTo('Языки');
  const langSel = allTag(captured.content, 'select').find(s => (s.children || []).some(o => o.attributes?.value === 'Общий'));
  assert.ok(langSel, 'список языков на месте');
  langSel.value = 'Общий'; fire(langSel, 'change', { target: langSel });
  assert.ok(all(captured.content, 'ced-chip').some(c => text(c).includes('Общий')), 'язык добавлен');

  // Навыки: владение — перетаскиванием записи навыка из справочника.
  navTo('Навыки');
  const zone = all(captured.content, 'ced-drop')[0];
  fire(zone, 'drop', { dataTransfer: { types: ['application/x-skill'], getData: t => (t === 'application/x-skill' ? JSON.stringify({ key: 'stealth', name: 'Скрытность', entry: { category: 'skill', name: 'Скрытность', data: { key: 'stealth' } } }) : '') },
    preventDefault() { }, stopPropagation() { } });
  assert.ok(all(captured.content, 'ced-chip').some(c => text(c).includes('Скрытность')), 'навык добавлен перетаскиванием');

  // Черты: новая черта с текстом.
  navTo('Черты');
  clickNode(allTag(captured.content, 'button').find(b => text(b) === '+ черта'));
  typeIn(byPlaceholder(captured.content, 'Название черты'), 'Тёмное зрение');
  const textArea = allTag(captured.content, 'textarea').find(t => t.attributes.placeholder === 'Текст черты');
  assert.ok(textArea, 'текст черты на месте');
  typeIn(textArea, 'Видите в темноте на 60 футов.');

  const saved = captured.buttons[0].fn();
  assert.ok(saved, 'сохранение вернуло запись');
  assert.equal(saved.name, 'Гном');
  assert.equal(saved.data.name_en, 'Gnome');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.languages)), ['Общий']);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.skills)), ['Скрытность']);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.traits)), [{ name: 'Тёмное зрение', text: 'Видите в темноте на 60 футов.' }]);
  assert.equal(domCtx.window.Mechanics.validate(saved.data.mechanics) || '', '', 'граф валиден');
  // Проекция: владение навыком приходит из графа, а не из отдельного поля.
  const sheet = { edition: '2014', level: 1, skills: [], proficiencies: '', languages: [], features: [], saving_throws: [], abilities: {}, hp: { max: 0, current: 0, temp: 0 } };
  const applied = domCtx.window.Mechanics.applyGraphRules(saved.data.mechanics, sheet, { edition: '2014', level: 1 });
  assert.equal(applied.error, '');
  assert.deepEqual(JSON.parse(JSON.stringify(sheet.skills)), ['stealth']);
  assert.deepEqual(JSON.parse(JSON.stringify(sheet.languages)), ['Общий']);
});
