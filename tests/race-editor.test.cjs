// Регрессия редактора расы (static/race-editor.js): чтение/запись записи, узлы графа
// (rule.value с kind speed/ability, rule.list с kind languages/skill_proficiency/skills/proficiencies)
// и программы черт. Скрипт запускается в vm со стабом DOM и наборами данных.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
for (const f of FILES) vm.runInContext(fs.readFileSync(path.isAbsolute(f) ? f : 'static/' + f, 'utf8'), ctx, { filename: f });

const RE = ctx.window.RaceEditor;
const M = ctx.window.Mechanics;
// Объекты из vm — другого окружения: сравнение идёт через JSON.
const plain = x => JSON.parse(JSON.stringify(x));
const seed = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8'));
const RACES = seed.filter(e => e.category === 'race');
const raceByName = name => RACES.find(e => e.name === name);
const nodesOfType = (d, type) => (d.mechanics?.graph?.nodes || []).filter(n => n.type === type);
const nodesOfKind = (d, kind) => (d.mechanics?.graph?.nodes || []).filter(n => n.type === 'rule.list' && n.params?.kind === kind);
const entryOf = (data, name = 'Дварф') => ({ id: 'r1', category: 'race', name, data });

test('круг чтения и записи: правки доходят до мастера создания и не теряют узлы', () => {
  const source = raceByName('Эльф');
  const st = RE.readState(source);
  assert.equal(st.speed, 30);
  assert.equal(st.asi.dex, 2, 'бонус прочитан из узла rule.value (kind ability)');
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
  assert.equal(nodesOfType(out, 'rule.value').filter(n => n.params.kind === 'speed')[0].params.amount, 35, 'узел скорости обновлён');
  assert.equal(nodesOfType(out, 'rule.value').filter(n => n.params.kind === 'ability').find(n => n.params.ability === 'dex').params.amount, 3);
  assert.deepEqual(plain(nodesOfKind(out, 'languages')[0].params.value), ['Общий', 'Эльфийский', 'Драконий']);
  assert.deepEqual(plain(nodesOfKind(out, 'skill_proficiency')[0].params.value), ['Восприятие', 'Скрытность']);
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
  const speedId = nodesOfType(source.data, 'rule.value').filter(n => n.params.kind === 'speed')[0].id;
  const links = source.data.mechanics.graph.links.filter(l => l.to.node === speedId).length;
  const st = RE.readState(source);
  st.speed = 25;
  const out = RE.writeData(st, source);
  assert.equal(nodesOfType(out, 'rule.value').filter(n => n.params.kind === 'speed')[0].id, speedId, 'тот же узел');
  assert.equal(out.mechanics.graph.links.filter(l => l.to.node === speedId).length, links);
});

test('характеристики: убрали бонус — узел удалён, добавили — создан', () => {
  const source = raceByName('Эльф');
  const st = RE.readState(source);
  st.asi.dex = 0;
  st.asi.cha = 1;
  const out = RE.writeData(st, source);
  const nodes = nodesOfType(out, 'rule.value').filter(n => n.params.kind === 'ability');
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
  assert.deepEqual(plain(nodesOfKind(out, 'skill_proficiency')[0].params.value), ['Восприятие']);
  const choice = nodesOfKind(out, 'skills')[0];
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

test('выбор навыков расы переживает сохранение записи: пустой список — любой навык', () => {
  // «Универсальность навыков» полуэльфа: сколько выбрать, список пуст (любой навык). Сохранение
  // записи без правок не должно потерять узел rule.list (kind: skills).
  const half = RE.readState(raceByName('Полуэльф'));
  assert.equal(half.skills.choose, 2);
  assert.deepEqual(plain(half.skills.from), []);
  const out = RE.writeData(half, raceByName('Полуэльф'));
  const node = nodesOfKind(out, 'skills')[0];
  assert.ok(node, 'узел выбора навыков остался в графе');
  assert.equal(node.params.count, 2);
  assert.deepEqual(plain(node.params.options), []);
  assert.equal(M.validate(out.mechanics) || '', '');

  // Со списком узел пишет его и не даёт выбрать больше, чем в списке.
  half.skills.choose = 3;
  half.skills.from = ['Скрытность', 'Атлетика'];
  const out2 = RE.writeData(half, raceByName('Полуэльф'));
  const node2 = nodesOfKind(out2, 'skills')[0];
  assert.deepEqual(plain(node2.params.options), ['Скрытность', 'Атлетика']);
  assert.equal(node2.params.count, 2, 'выбор ограничен списком');
});

test('владения: по узлу rule.list (kind: proficiencies) на каждый вид', () => {
  const st = RE.readState(entryOf(RE.emptyData()));
  st.profs.push({ kind: 'Оружие', values: ['Боевой топор', 'Ручной топор'] });
  st.profs.push({ kind: 'Инструменты', values: ['Кузнечные инструменты'] });
  const out = RE.writeData(st, entryOf(RE.emptyData()));
  const nodes = nodesOfKind(out, 'proficiencies');
  assert.deepEqual(plain(nodes.map(n => n.params.label)), ['Оружие', 'Инструменты']);
  assert.deepEqual(plain(nodes[0].params.value), ['Боевой топор', 'Ручной топор']);
  const st2 = RE.readState({ data: out });
  assert.deepEqual(plain(st2.profs), [{ kind: 'Оружие', values: ['Боевой топор', 'Ручной топор'] }, { kind: 'Инструменты', values: ['Кузнечные инструменты'] }]);
});

// ---------- Заклинания расы ----------
test('заговоры расы из набора правил: высший эльф выбирает один заговор волшебника', () => {
  const st = RE.readState(raceByName('Высший эльф'));
  assert.deepEqual(plain(st.spells.fixed), [], 'известных сразу заклинаний у высшего эльфа нет');
  assert.equal(st.spells.choices.length, 1, 'один выбор заговора');
  const [choice] = st.spells.choices;
  assert.equal(choice.title, 'Заговор высшего эльфа');
  assert.equal(choice.level, 0, 'выбор идёт среди заговоров');
  assert.equal(choice.classes, 'волшебник, wizard', 'фильтр по списку волшебника');
  assert.equal(choice.ability, 'int', 'Интеллект — заклинательная характеристика');
  assert.equal(st.spells.ability.mode, 'inherit', 'характеристика не выбирается игроком');
});

test('известные сразу заклинания приходят из записи, у линии 2024 — вместе с корнем', () => {
  const tiefling = RE.readState(raceByName('Тифлинг'));
  assert.deepEqual(plain(tiefling.spells.fixed), [{ name: 'Чудотворство', level: 0, ability: 'cha' }]);

  // Записи 2024 — справочник подставляется редактору вторым доводом: линия со своими заговорами
  // перекрывает корень, линия без своих заговоров берёт заговоры и выбор характеристики у корня.
  const seed24 = JSON.parse(fs.readFileSync('data_seed/srd_2024.json', 'utf8')).filter(e => e.category === 'race');
  const race24 = name => seed24.find(e => e.name === name);
  const high = RE.readState(race24('Эльфийская линия: высший эльф'), seed24);
  assert.deepEqual(plain(high.spells.fixed.map(r => r.name)), ['Фокусы'], 'своя линия перекрывает корень');
  assert.equal(high.spells.ability.mode, 'on', 'выбор характеристики наследуется от корня');
  assert.deepEqual(plain(high.spells.ability.options), ['int', 'wis', 'cha']);
  assert.equal(high.spells.ability.title, 'Заклинательная характеристика родословной');

  // Линия без своих заговоров наследует заговоры корня.
  const wood = RE.readState(race24('Эльфийская линия: лесной эльф'), seed24);
  assert.deepEqual(plain(wood.spells.fixed.map(r => r.name)), ['Искусство друидов']);
});

test('запись заклинаний: узлы rule.list (kind: spell_list), поля данных и характеристика игрока', () => {
  const source = raceByName('Высший эльф');
  const st = RE.readState(source);
  st.spells.fixed.push({ name: 'Огненный снаряд', level: 0, ability: 'cha' });
  st.spells.fixed.push({ name: 'Свет', level: 0, ability: 'choice' });
  st.spells.choices[0].classes = 'волшебник';
  st.spells.ability = { mode: 'on', options: ['int', 'cha'], title: 'Заклинательная характеристика', hint: 'Выберите характеристику.' };
  const out = RE.writeData(st, source);

  assert.deepEqual(plain(out.cantrips), [{ name: 'Огненный снаряд', level: 0, ability: 'cha' }, { name: 'Свет', level: 0, ability: 'choice' }]);
  assert.equal(out.spell_choices.length, 1);
  assert.equal(out.spell_choices[0].key, 'racialCantrip', 'ключ выбора сохранён');
  assert.deepEqual(plain(out.spell_choices[0].filter), { level: 0, classes: ['волшебник'] });
  assert.deepEqual(plain(out.spell_ability_choice), { enabled: true, options: ['int', 'cha'], title: 'Заклинательная характеристика', hint: 'Выберите характеристику.' });

  const nodes = nodesOfKind(out, 'spell_list');
  assert.equal(nodes.length, 2, 'по узлу на характеристику');
  assert.deepEqual(plain(nodes.find(n => n.params.ability === 'cha').params.spells), ['Огненный снаряд']);
  assert.deepEqual(plain(nodes.find(n => !n.params.ability).params.spells), ['Свет'], 'характеристику выбирает игрок — узел без неё');
  assert.equal(M.validate(out.mechanics) || '', '', 'граф остался валидным');

  // Круг чтения: узлы в приоритете, выбор игрока и характеристика читаются обратно.
  const st2 = RE.readState({ data: out });
  assert.deepEqual(plain(st2.spells.fixed), [{ name: 'Огненный снаряд', level: 0, ability: 'cha' }, { name: 'Свет', level: 0, ability: '' }]);
  assert.equal(st2.spells.choices[0].classes, 'волшебник');
  assert.deepEqual(plain(st2.spells.ability), { mode: 'on', options: ['int', 'cha'], title: 'Заклинательная характеристика', hint: 'Выберите характеристику.' });

  // Убрали заклинания — узлы и поля ушли вместе с ними.
  const cleared = RE.writeData(RE.readState({ data: out }), { data: out });
  cleared.cantrips = [];
  const st3 = RE.readState({ data: out });
  st3.spells.fixed = [];
  const out3 = RE.writeData(st3, { data: out });
  assert.deepEqual(plain(out3.cantrips), []);
  assert.equal(nodesOfKind(out3, 'spell_list').length, 0);
});

test('заклинания расы доходят до листа персонажа: данные и граф механик', () => {
  const spells = seed.filter(e => e.category === 'spell');
  const race = { id: 'custom-race', category: 'race', name: 'Своя раса', source: 'Тест',
    data: { edition: '2014', name_en: 'My Race', speed: 30, cantrips: [{ name: 'Чудотворство', level: 0, ability: 'cha' }],
      mechanics: { origin: 'race-editor-v2', version: 2, graph: { nodes: [{ id: 'sp1', type: 'rule.list', position: { x: 0, y: 0 }, params: { kind: 'spell_list', mode: 'known', ability: 'int', spells: ['Огненный снаряд'] } }], links: [], frames: [], groups: [] } } } };
  const sheet = ctx.window.CharacterBuilder.build({ name: 'Своя раса', edition: '2014',
    abilities: Object.fromEntries(ctx.window.CharacterBuilder.keys.map(k => [k, 10])), selected: { race },
    catalog: [...spells, race], spells: [], method: 'standard' });
  const known = plain(sheet.spells.known);
  assert.ok(known.some(s => s.name === 'Чудотворство' && s.spell_ability === 'cha'), 'известное сразу заклинание из данных');
  assert.ok(known.some(s => s.name === 'Огненный снаряд' && s.spell_ability === 'int'), 'заклинание из узла rule.list (kind: spell_list)');
  assert.ok(known.every(s => s.prepared), 'заклинания расы всегда доступны');
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
for (const f of FILES) vm.runInContext(fs.readFileSync(path.isAbsolute(f) ? f : 'static/' + f, 'utf8'), domCtx, { filename: f });

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

  // Заклинания: заклинание добавляется перетаскиванием, выбор заговора — из формы.
  navTo('Заклинания');
  const spellZone = all(captured.content, 'ced-drop')[0];
  fire(spellZone, 'drop', { dataTransfer: { types: ['application/x-spell'], getData: t => (t === 'application/x-spell' ? JSON.stringify({ spell: { name: 'Свет', level: 0 } }) : '') },
    preventDefault() { }, stopPropagation() { } });
  const spellInput = allTag(captured.content, 'input').find(i => i.attributes.placeholder === 'Название заклинания из справочника');
  assert.equal(spellInput && (spellInput.attributes.value || spellInput.value), 'Свет', 'заклинание добавлено перетаскиванием');
  clickNode(allTag(captured.content, 'button').find(b => text(b) === '+ выбор заговора'));
  typeIn(byPlaceholder(captured.content, 'Заголовок выбора, например «Заговор высшего эльфа»'), 'Заговор своей расы');
  typeIn(byPlaceholder(captured.content, 'классы через запятую: волшебник, wizard'), 'волшебник');

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
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.cantrips)), [{ name: 'Свет', level: 0, ability: '' }]);
  assert.equal(saved.data.spell_choices.length, 1);
  assert.equal(saved.data.spell_choices[0].title, 'Заговор своей расы');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.spell_choices[0].filter)), { level: 0, classes: ['волшебник'] });
  assert.ok(!('spell_ability_choice' in saved.data), 'характеристика не выбирается игроком — поле не пишется');
  assert.equal(domCtx.window.Mechanics.validate(saved.data.mechanics) || '', '', 'граф валиден');
  // Проекция: владение навыком приходит из графа, а не из отдельного поля.
  const sheet = { edition: '2014', level: 1, skills: [], proficiencies: '', languages: [], features: [], saving_throws: [], abilities: {}, hp: { max: 0, current: 0, temp: 0 } };
  const applied = domCtx.window.Mechanics.applyGraphRules(saved.data.mechanics, sheet, { edition: '2014', level: 1 });
  assert.equal(applied.error, '');
  assert.deepEqual(JSON.parse(JSON.stringify(sheet.skills)), ['stealth']);
  assert.deepEqual(JSON.parse(JSON.stringify(sheet.languages)), ['Общий']);
});

// ---------- Вид редактора: разделы расы устроены как разделы редактора класса ----------
const KEYS_ALL = ['Сила', 'Ловкость', 'Телосложение', 'Интеллект', 'Мудрость', 'Харизма'];
test('редактор расы разложен как редактор класса: те же чипы, счётчики и карточки с меткой', async () => {
  await domPresets;
  let captured = null;
  domCtx.modal = (title, content, buttons, opts) => { captured = { title, content, buttons, opts }; return Promise.resolve(null); };
  const RE3 = domCtx.window.RaceEditor;
  const source = raceByName('Высший эльф');
  await RE3.edit(source, {});

  // Навигация — тот же список кнопок того же класса, что у редактора класса.
  const nav = all(captured.content, 'ced-nav-btn').map(text);
  assert.deepEqual(nav, plain(RE3.SECTIONS.map(s => s.title)), 'разделы расы идут как у класса: общее, характеристики, навыки, языки, …');
  assert.deepEqual(nav.slice(2, 4), ['Навыки', 'Языки'], 'сначала навыки, потом языки — порядок класса');
  assert.ok(captured.opts.wide, 'окно на всю ширину, как у редактора класса');

  const navTo = title => { clickNode(all(captured.content, 'ced-nav-btn').find(b => text(b) === title)); };
  const section = () => all(captured.content, 'ced-section')[0];

  // Навыки: подразделы, счётчик и чипы — как в классе.
  navTo('Навыки');
  assert.deepEqual(all(section(), 'ced-sub').map(text), ['Владение навыками', 'Выбор игрока'], 'подразделы навыков');
  assert.deepEqual(all(all(section(), 'ced-row')[1], 'ced-counter').map(text).concat(all(section(), 'ced-counter').map(text)).slice(0, 1),
    ['пусто — любой навык'], 'счётчик выбора навыков');
  assert.equal(all(section(), 'ced-chips').length, 2, 'у навыков владения и выбора — свои списки-чипы');
  const addSelects = allTag(section(), 'select').filter(s => (s.children || []).some(o => o.attributes?.value === '' && text(o) === '+ добавить навык…'));
  assert.equal(addSelects.length, 2, 'навык добавляется из справочника той же строкой, что в классе');
  assert.equal(all(section(), 'ced-drop').length, 2, 'навык можно перетащить в оба списка');

  // Владения: кнопка добавляет вид владений карточкой с меткой.
  navTo('Владения');
  clickNode(allTag(section(), 'button').find(b => text(b) === '+ Доспехи'));
  const profBlocks = all(section(), 'ced-block');
  assert.equal(profBlocks.length, 1, 'вид владений — карточка .ced-block');
  assert.equal(text(all(profBlocks[0], 'badge')[0]), 'владения', 'метка вида владений в шапке карточки');
  assert.ok(all(profBlocks[0], 'ced-block-head').length, 'шапка карточки та же, что у подклассов класса');

  // Черты: каждая — карточка с меткой и названием в шапке, а не голое поле.
  navTo('Черты');
  const traitBlocks = all(section(), 'ced-block');
  assert.equal(traitBlocks.length, 3, 'каждая черта — карточка');
  assert.deepEqual(all(section(), 'ced-block-head').map(b => text(all(b, 'badge')[0])), ['черта', 'черта', 'черта'], 'метка в шапке каждой карточки');
  assert.deepEqual(all(section(), 'ced-block-head').map(b => allTag(b, 'input')[0].attributes.value),
    ['Эльфийская боевая подготовка', 'Заговор высшего эльфа', 'Дополнительный язык'], 'название черты — в шапке карточки');

  // Заклинания: два блока с метками (как «выдаётся всегда» и «выбор варианта» у класса).
  navTo('Заклинания');
  assert.deepEqual(all(section(), 'ced-block-head').map(b => text(all(b, 'badge')[0])), ['известны сразу', 'выбор игрока'], 'заклинания сгруппированы блоками с метками');
  assert.equal(all(section(), 'ced-eq-option').length, 1, 'выбор заговора — карточкой варианта, как варианты снаряжения');
  const abilityField = all(section(), 'ced-field').find(f => text(f).includes('Заклинательная характеристика'));
  assert.ok(abilityField, 'заклинательная характеристика — обычным полем, как у класса');
  // Характеристика по выбору игрока: галочки отмечаются той же строкой, что спасброски класса.
  const modeSel = allTag(abilityField, 'select')[0];
  modeSel.value = 'on'; fire(modeSel, 'change', { target: modeSel });
  assert.equal(all(section(), 'ced-saves').length, 1, 'характеристики выбора — строка с галочками');
  assert.equal(all(section(), 'ced-check').length, KEYS_ALL.length, 'по галочке на каждую характеристику');

  // Языки: число дополнительных языков и счётчик фиксированных — как в классе.
  navTo('Языки');
  assert.match(text(section()), /Дополнительных языков по выбору/, 'условные языки задаются числом');
  assert.deepEqual(all(section(), 'ced-counter').map(text), ['0 фиксированных'], 'счётчик фиксированных языков');
});
