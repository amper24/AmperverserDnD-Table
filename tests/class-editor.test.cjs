// Регрессия редактора класса (static/class-editor.js): чтение/запись данных записи,
// текст стартового снаряжения (совместимый с парсером мастера создания) и навыки как
// записи справочника. Скрипт запускается в vm с минимальным DOM-стабом и наборами данных.
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
for (const f of ['common.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'modules.js', 'class-rules.js', 'character-builder.js', 'class-editor.js'])
  vm.runInContext(fs.readFileSync('static/' + f, 'utf8'), ctx, { filename: f });
const CE = ctx.window.ClassEditor;
// Объекты из vm — другого окружения: сравнение идёт через JSON.
const plain = x => JSON.parse(JSON.stringify(x));
const B = ctx.window.CharacterBuilder;

const entry = (data, name = 'Свой класс') => ({ id: 'c1', category: 'class', name, data });

test('круг чтения и записи: данные класса доходят до мастера создания без потерь', () => {
  const data = { name_en: 'Artificer', edition: '2024', hit_die: 'd8', saves: ['int', 'con'], spellcasting: 'int', primary: 'int',
    armor: 'Лёгкие', weapons: 'Простое', tools: 'Инструменты ремесленника', desc: 'Мастер устройств.',
    skills: { choose: 2, from: ['Магия', 'История'] },
    features: { 1: ['Мастер ремесла'], 3: ['Увеличение характеристик'] }, feature_texts: { 'Мастер ремесла': 'Даёт владение инструментами.' },
    starting_equipment: 'Книга заклинаний ×1\n- (a) боевой посох или (b) кинжал',
    subclasses: [{ name: 'Алхимик', name_en: 'Alchemist', flavor: 'Традиция', desc: 'Зелья.', features: { 3: ['Зельеварение'] }, feature_texts: { 'Зельеварение': 'Варите зелья.' } }],
    progression: { columns: [], levels: { 1: { pb: 2, cantrips: 2, known: null, slots: [2, 0, 0, 0, 0, 0, 0, 0, 0] } } },
    languages_fixed: ['Гномий'], languages_extra: 1,
    caster: { level: 'half', start: 'known', prepared: 'level', book: { start: 4, per_level: 2 }, start_prepared: 'level' } };
  const st = CE.readState(entry(data));
  assert.equal(st.name, 'Свой класс');
  assert.equal(st.hit_die, 'd8');
  assert.deepEqual(plain(st.saves), ['int', 'con']);
  assert.equal(st.skills.choose, 2);
  assert.deepEqual(plain(st.skills.from), ['Магия', 'История']);
  assert.deepEqual(plain(st.features['1']), [{ name: 'Мастер ремесла', text: 'Даёт владение инструментами.' }]);
  assert.equal(st.levels['1'].cantrips, 2);
  assert.equal(st.levels['1'].slots[0], 2);
  assert.deepEqual(plain(st.languages), { fixed: ['Гномий'], extra: 1 });
  assert.equal(st.subclasses.length, 1);
  assert.deepEqual(plain(st.subclasses[0].features), [{ level: 3, name: 'Зельеварение', text: 'Варите зелья.' }]);
  assert.equal(st.caster.level, 'half');

  const out = CE.writeData(st, entry(data));
  assert.equal(out.starting_equipment, 'Книга заклинаний\n- (a) боевой посох или (b) кинжал');
  assert.deepEqual(plain(out.skills), { choose: 2, from: ['Магия', 'История'] });
  assert.deepEqual(plain(out.features['3']), ['Увеличение характеристик']);
  assert.equal(out.feature_texts['Мастер ремесла'], 'Даёт владение инструментами.');
  assert.equal(out.progression.levels['1'].cantrips, 2);
  assert.deepEqual(plain(out.languages_fixed), ['Гномий']);
  assert.equal(out.languages_extra, 1);
  assert.deepEqual(plain(out.subclasses[0].features), { 3: ['Зельеварение'] });
  assert.equal(out.subclasses[0].feature_texts['Зельеварение'], 'Варите зелья.');
  assert.deepEqual(plain(out.caster.book), { start: 4, per_level: 2 });
  // неизвестные редактору поля прежней записи не теряются
  assert.equal(CE.writeData(st, entry({ ...data, folder: 'Домашние' })).folder, 'Домашние');
});

test('таблица развития пишется только когда её правили', () => {
  const st = CE.readState(entry({ skills: { choose: 2, from: ['Магия'] } }));
  assert.equal(Object.keys(st.levels).length, CE.MAX_LEVEL, 'в состоянии все уровни, но пустые');
  assert.equal(st.levels['7'].pb, 3, 'бонус мастерства пустого уровня — по кривой SRD');
  assert.equal(CE.writeData(st, entry({ skills: {} })).progression, undefined);
  st.levels['4'].slots[1] = 3;
  st.levels['4'].slots[1] = 3;
  assert.equal(CE.writeData(st, entry({ skills: {} })).progression.levels['4'].slots[1], 3);
});

test('таблица развития: свои колонки не теряются и пишется вся сразу', () => {
  const d = { ...CE.emptyData(), progression: { columns: [], levels: { 2: { pb: 2, cantrips: 1, slots: [2, 0, 0, 0, 0, 0, 0, 0, 0], 'x:ki_points': 2 } } } };
  const st = CE.readState(entry(d));
  assert.equal(plain(st.levels['2']['x:ki_points']), 2, 'своя колонка уровня прочитана');
  st.levels['3'].slots[0] = 3;             // правим только третий уровень
  const out = CE.writeData(st, { data: d });
  assert.equal(Object.keys(out.progression.levels).length, CE.MAX_LEVEL, 'в таблице все уровни');
  assert.equal(out.progression.levels['2']['x:ki_points'], 2, 'своя колонка не потеряна');
  assert.equal(out.progression.levels['5'].pb, 3, 'бонус мастерства нетронутого уровня — по кривой SRD');
  assert.equal(out.progression.levels['3'].slots[0], 3);
  assert.equal(out.progression.levels['4'].slots[0], 0);
});

test('снаряжение: блоки → текст, который понимает парсер мастера создания', () => {
  const blocks = [
    { kind: 'fixed', rows: [{ kind: 'item', name: 'Книга заклинаний', qty: 1 }, { kind: 'item', name: 'Факел', qty: 3 }] },
    { kind: 'group', label: 'Оружие', options: [{ rows: [{ kind: 'item', name: 'Боевой посох', qty: 1 }] }, { rows: [{ kind: 'item', name: 'Кинжал', qty: 1 }] }] },
    { kind: 'group', label: '', options: [{ rows: [{ kind: 'pick', filter: 'simple-weapon' }] }, { rows: [{ kind: 'gold', amount: 75 }] }] },
  ];
  const text = CE.equipmentText(blocks);
  assert.equal(text, 'Книга заклинаний, Факел ×3\nОружие: (a) Боевой посох или (b) Кинжал\n- (a) любое простое оружие или (b) 75 зм');
  const parsed = B.parseEquipmentText(text, 'Тест');
  assert.equal(parsed.length, 3);
  assert.deepEqual(plain(parsed[0].tokens.map(t => t.name)), ['Книга заклинаний', 'Факел']);
  assert.equal(parsed[1].kind, 'group');
  assert.equal(parsed[1].label, 'Оружие');
  assert.deepEqual(plain(parsed[1].options.map(o => o.tokens[0].name)), ['Боевой посох', 'Кинжал']);
  assert.equal(parsed[2].options[0].tokens[0].kind, 'pick', '«любое простое оружие» разбирается как выбор');
  assert.equal(parsed[2].options[1].tokens[0].kind, 'gold');
});

test('снаряжение: текст существующего класса разбирается обратно в блоки', () => {
  const text = 'Книга заклинаний ×1\n- (a) боевой посох или (b) кинжал\n- (a) набор учёного или (b) набор путешественника';
  const blocks = CE.blocksFromText(text);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].rows[0].name, 'Книга заклинаний');
  assert.equal(blocks[0].rows[0].qty, 1);
  assert.equal(blocks[1].kind, 'group');
  assert.equal(blocks[1].options.length, 2);
  assert.equal(blocks[1].options[1].rows[0].name, 'кинжал');
  assert.equal(CE.equipmentText(blocks), 'Книга заклинаний\n- (a) боевой посох или (b) кинжал\n- (a) набор учёного или (b) набор путешественника');
});

test('навыки: ключ по названию и запись справочника как источник', () => {
  assert.equal(CE.skillKeyOfName('Магия'), 'arcana');
  assert.equal(CE.skillKeyOfName('уход за животными'), 'animal');
  assert.equal(CE.skillKeyOfName('Acrobatics'), 'acrobatics');
  assert.equal(CE.skillKeyOfName('Нет такого'), '');
  assert.equal(CE.skillNameOfKey('sleight'), 'Ловкость рук');
  assert.equal(CE.skillFromEntry({ category: 'skill', name: 'Скрытность', data: { key: 'stealth' } }), 'stealth');
  assert.equal(CE.skillFromEntry({ category: 'skill', name: 'Расследование', data: {} }), 'investigation');
  assert.equal(CE.skillFromEntry({ category: 'item', name: 'Меч' }), '');
});

test('редактор отдаёт то, что сохранит справочник: имя и данные', () => {
  const st = CE.readState(entry({ skills: { choose: 1, from: [] } }, 'Кузнец'));
  st.skills.from.push('Атлетика');
  st.features['2'] = [{ name: 'Удар молота', text: 'Оружие бьёт сильнее.' }];
  const data = CE.writeData(st, entry({ skills: {} }, 'Кузнец'));
  assert.deepEqual(plain(data.skills), { choose: 1, from: ['Атлетика'] });
  assert.deepEqual(plain(data.features), { 2: ['Удар молота'] });
  assert.equal(data.feature_texts['Удар молота'], 'Оружие бьёт сильнее.');
  // с пустым названием редактор не сохраняет
  assert.equal(CE.readState(entry({}, '   ')).name, '   ');
});

test('класс из редактора строит лист: навыки, умения и языки попадают в персонажа', () => {
  const race = { id: 'r', category: 'race', name: 'Человек', data: { edition: '2014', speed: 30, languages: ['Общий'] } };
  const klass = entry({ name_en: 'Artificer', edition: '2014', hit_die: 'd8', saves: ['int', 'con'], spellcasting: 'int',
    skills: { choose: 2, from: ['Магия', 'История'] }, features: { 1: ['Мастер ремесла'] }, feature_texts: { 'Мастер ремесла': 'Даёт инструменты.' },
    armor: 'Лёгкие', weapons: 'Простое оружие', tools: 'Инструменты ремесленника',
    languages_fixed: ['Гномий'], languages_extra: 1,
    starting_equipment: 'Книга заклинаний ×1\n- (a) боевой посох или (b) кинжал' }, 'Изобретатель');
  const background = { id: 'b', category: 'background', name: 'Прислужник', data: { edition: '2014', skills: ['Религия'], languages: 0 } };
  const draft = { name: 'Тест', edition: '2014', abilities: Object.fromEntries(B.keys.map(k => [k, 10])),
    selected: { race, class: klass, background }, skills: ['arcana', 'history'], languages: ['Драконий'], spells: [], method: 'standard', equipment: { choice: { '0': 'opt1' }, picks: {} } };
  const sheet = B.build(draft);
  assert.ok(['arcana', 'history'].every(k => sheet.skills.includes(k)), 'выбранные навыки на листе');
  assert.ok(sheet.features.some(f => f.name === 'Мастер ремесла'), 'умение 1 уровня на листе');
  assert.match(sheet.proficiencies, /Гномий/, 'фиксированный язык класса в владениях');
  assert.ok(sheet.inventory.length > 0, 'стартовое снаряжение попало в инвентарь');
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
// presets.js уже загружен node-loader — не перезапускаем.
for (const f of ['common.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'modules.js', 'class-rules.js', 'character-builder.js', 'class-editor.js'])
  vm.runInContext(fs.readFileSync('static/' + f, 'utf8'), domCtx, { filename: f });

const walk = (node, fn) => { fn(node); for (const c of node.children || []) walk(c, fn); };
const text = node => !node ? '' : node.nodeType === 3 ? node.textContent : (node.children || []).map(text).join('');
const all = (root, cls) => { const out = []; walk(root, n => { if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n); }); return out; };
const allTag = (root, tag) => { const out = []; walk(root, n => { if (n.tag === tag) out.push(n); }); return out; };
const byPlaceholder = (root, ph) => { let f = null; walk(root, n => { if (n.tag === 'input' && n.attributes.placeholder === ph && !f) f = n; }); return f; };
const fire = (node, ev, arg) => { for (const fn of node._listeners[ev] || []) fn(arg); };
const clickNode = node => fire(node, 'click', { target: node, stopPropagation() { }, preventDefault() { } });
const typeIn = (node, value) => { node.value = value; fire(node, 'input', { target: node }); };
const pickIn = (node, value) => { node.value = value; fire(node, 'change', { target: node }); };
const selWith = (root, value) => { let f = null; walk(root, n => { if (!f && n.tag === 'select' && (n.children || []).some(o => o.attributes?.value === value)) f = n; }); return f; };  // eslint-disable-line no-unused-vars
const fieldInput = (root, label) => { let f = null; walk(root, n => { if (!f && n.className === 'ced-field' && text(n.children[0]) === label) f = n.children[1]; }); return f; };

test('редактор класса открывается: все разделы рисуются и правки уходят в запись', async () => {
  await domPresets;
  let captured = null;
  domCtx.modal = (title, content, buttons, opts) => { captured = { title, content, buttons, opts }; return Promise.resolve(null); };
  const CE = domCtx.window.ClassEditor;
  await CE.edit(null, {});
  assert.ok(captured, 'модальное окно редактора открыто');
  assert.match(captured.title, /Новый класс/);

  // Название — на разделе «Общее».
  typeIn(byPlaceholder(captured.content, 'Волшебник'), 'Изобретатель');
  typeIn(byPlaceholder(captured.content, 'Wizard'), 'Artificer');

  // Все разделы открываются без ошибок.
  for (const sec of CE.SECTIONS) {
    const btn = all(captured.content, 'ced-nav-btn').find(b => text(b) === sec.title);
    assert.ok(btn, `раздел «${sec.title}» есть в навигации`);
    clickNode(btn);
    const heading = all(captured.content, 'ced-section')[0]?.children?.[0];
    assert.ok(heading && text(heading) === sec.title, `раздел «${sec.title}» отрисован`);
  }

  // Навыки: выбор из списка и перетаскивание записи «Навыки» из справочника.
  const navTo = title => clickNode(all(captured.content, 'ced-nav-btn').find(b => text(b) === title));
  navTo('Навыки');
  const addSel = [...all(captured.content, 'ced-drop')[0].parentElement.children].find(n => n.tag === 'select');
  pickIn(addSel, 'arcana');
  const zone = all(captured.content, 'ced-drop')[0];
  fire(zone, 'drop', { dataTransfer: { types: ['application/x-skill'], getData: t => (t === 'application/x-skill' ? JSON.stringify({ key: 'stealth', name: 'Скрытность' }) : '') },
    preventDefault() { }, stopPropagation() { } });
  const skills = all(captured.content, 'ced-chip').map(c => text(c).replace(/×$/, '').trim());
  assert.ok(skills.some(s => s.startsWith('Магия')), 'навык из списка добавлен');
  assert.ok(skills.some(s => s.startsWith('Скрытность')), 'навык, перетащенный из справочника, добавлен');

  // Уровни: ячейки и умение уровня.
  navTo('Уровни 1–20');
  const rows = all(captured.content, 'ced-levels-row');
  assert.equal(rows.length, CE.MAX_LEVEL, 'таблица на все уровни');
  const featBtns = all(captured.content, 'ced-feat-btn');
  assert.equal(featBtns.length, CE.MAX_LEVEL);
  clickNode(featBtns[0]);
  const addFeature = all(captured.content, 'ced-features')[0]?.children?.slice(-1)[0]?.children?.[0];
  assert.ok(addFeature && /умение/.test(text(addFeature)), 'кнопка добавления умения на месте');
  clickNode(addFeature);
  const nameInput = all(captured.content, 'ced-feature')[0]?.children?.[0]?.children?.[0];
  assert.ok(nameInput && nameInput.tag === 'input');
  typeIn(nameInput, 'Мастер ремесла');

  // Снаряжение: блок и строка предмета.
  navTo('Снаряжение');
  const addFixed = all(captured.content, 'ced-row').flatMap(r => r.children || []).find(b => b.tag === 'button' && /выдаётся всегда/.test(text(b)));
  assert.ok(addFixed, 'кнопка «+ блок «выдаётся всегда»» на месте');
  clickNode(addFixed);
  const itemInput = byPlaceholder(captured.content, 'название предмета');
  assert.ok(itemInput, 'строка предмета отрисована');
  typeIn(itemInput, 'Книга заклинаний');

  // Подкласс: название и умение 3 уровня.
  navTo('Подклассы');
  clickNode(allTag(captured.content, 'button').find(b => text(b) === '+ подкласс'));
  typeIn(byPlaceholder(captured.content, 'Название подкласса'), 'Алхимик');
  clickNode(allTag(captured.content, 'button').find(b => text(b) === '+ умение'));
  typeIn(byPlaceholder(captured.content, 'Название умения'), 'Зельеварение');

  // Заклинания: тип заклинателя и книга.
  navTo('Заклинания');
  pickIn(selWith(captured.content, 'full'), 'full');
  typeIn(fieldInput(captured.content, 'Книга: старт'), '6');

  // Уровни: правим ячейку 1 круга на 5 уровне.
  navTo('Уровни 1–20');
  const row5 = all(captured.content, 'ced-levels-row')[4];
  typeIn(row5.children[5].children[0], '4');          // ячейка 1 круга 5 уровня (число лежит в обёртке-span)

  // Языки: фиксированный язык.
  navTo('Языки');
  const langSel = all(captured.content, 'ced-row').flatMap(r => r.children || []).find(n => n.tag === 'select');
  assert.ok(langSel, 'список языков на месте');

  const saved = captured.buttons[0].fn();
  assert.ok(saved, 'сохранение вернуло запись');
  assert.equal(saved.name, 'Изобретатель');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.skills)), { choose: 0, from: ['Магия', 'Скрытность'] });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.features)), { 1: ['Мастер ремесла'] });
  assert.match(saved.data.starting_equipment, /Книга заклинаний/);
  assert.equal(saved.data.name_en, 'Artificer');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.data.subclasses[0].features)), { 3: ['Зельеварение'] });
  assert.equal(saved.data.subclasses[0].name, 'Алхимик');
  assert.equal(saved.data.caster.level, 'full');
  assert.equal(saved.data.caster.book.start, 6);
  assert.equal(Object.keys(saved.data.progression.levels).length, CE.MAX_LEVEL, 'таблица уровней записана целиком');
  assert.equal(saved.data.progression.levels['5'].slots[0], 4);
  assert.equal(saved.data.progression.levels['5'].pb, 3);
});
