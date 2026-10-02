// Регрессия «интерфейс создания персонажа не открывается»: мастер создания должен
// открыться, отрисовать все шаги и довести персонажа до готового листа без ошибок.
// Запускаем настоящие скрипты фронта в vm с минимальным DOM-стабом и реальными
// записями справочника из data_seed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// ---------- минимальный DOM ----------
function makeNode(tag) {
  return {
    tag, nodeType: 1, children: [], parentElement: null,
    style: {}, dataset: {}, attributes: {},
    className: '', value: '', checked: false, disabled: false, scrollTop: 0,
    _listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    append(...cs) { for (const c of cs) if (c != null) { c.parentElement = this; this.children.push(c); } },
    appendChild(c) { this.append(c); },
    replaceChildren(...cs) { this.children = []; this.append(...cs); },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    removeEventListener() {},
    contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentElement; } return false; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector(sel) { return findFirst(this, sel); },
    querySelectorAll(sel) { const out = []; findAll(this, sel, out); return out; },
    focus() { documentStub.activeElement = this; },
    blur() { if (documentStub.activeElement === this) documentStub.activeElement = null; },
    setSelectionRange() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    setPointerCapture() {},
  };
}
const matches = (node, sel) => !!node && node.nodeType === 1 &&
  (sel.startsWith('.') ? String(node.className || '').split(/\s+/).includes(sel.slice(1)) : node.tag === sel);
function findFirst(node, sel) {
  for (const c of node.children || []) { if (matches(c, sel)) return c; const r = findFirst(c, sel); if (r) return r; }
  return null;
}
function findAll(node, sel, out) {
  for (const c of node.children || []) { if (matches(c, sel)) out.push(c); findAll(c, sel, out); }
}
const documentStub = {
  documentElement: { dataset: {} },
  createElement: t => makeNode(t),
  createDocumentFragment: () => makeNode('#fragment'),
  createElementNS: (ns, t) => makeNode(t),
  createTextNode: t => ({ nodeType: 3, textContent: String(t), parentElement: null, children: [] }),
  body: makeNode('body'),
  activeElement: null,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

// ---------- песочница со справочником из data_seed ----------
const srd2014 = JSON.parse(fs.readFileSync('data_seed/srd_2014.json', 'utf8')).map(r => ({ ...r, id: r.slug, source: 'SRD 2014' }));
const sandbox = {
  console,
  document: documentStub,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false }),
  location: { host: 'test', protocol: 'http:', pathname: '/', search: '', href: '', reload() {}, replace() {} },
  navigator: { language: 'ru' },
  setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL, structuredClone,
  fetch: async url => {
    const u = new URL(url, 'http://test');
    const cat = u.searchParams.get('category');
    return { ok: true, status: 200, json: async () => srd2014.filter(r => r.category === cat) };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['common.js', 'dice.js', 'equipment.js', 'mechanics.js', 'modules.js', 'compendium.js', 'character-builder.js', 'builder-dialog.js'])
  vm.runInContext(fs.readFileSync('static/' + f, 'utf8'), sandbox, { filename: f });

// ---------- помощники ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = node => !node ? '' : node.nodeType === 3 ? node.textContent : (node.children || []).map(text).join('');
const walk = (node, fn) => { fn(node); for (const c of node.children || []) walk(c, fn); };
const buttons = root => { const out = []; walk(root, n => { if (n.tag === 'button') out.push(n); }); return out; };
const findButton = (root, label) => buttons(root).find(b => text(b).includes(label));
const click = node => { for (const fn of node._listeners.click || []) fn({ target: node, stopPropagation() {}, clientX: 0, clientY: 0 }); };
const fireChange = (node, value) => { if (value !== undefined) node.value = value; for (const fn of node._listeners.change || []) fn({ target: node }); };
const fireInput = (node, value) => { node.value = value; for (const fn of node._listeners.input || []) fn({ target: node }); };
const selects = root => { const out = []; walk(root, n => { if (n.tag === 'select') out.push(n); }); return out; };
const findSelect = (root, ariaLabel) => selects(root).find(s => s.attributes['aria-label'] === ariaLabel);
const findByPrefix = (root, cls, startsWith) => {
  let found = null;
  walk(root, n => {
    if (n.tag === 'label' && String(n.className).includes(cls) && text(n).startsWith(startsWith)) {
      const input = (n.children || []).find(c => c.tag === 'input');
      if (input && !input.attributes.disabled && !found) found = input;
    }
  });
  return found;
};

/// Полный проход мастера: имя → модули → подкласс/инструменты дварфа → покупка очков →
/// навыки и языки → снаряжение → готовый лист. Возвращает результат диалога.
async function walkWizard() {
  documentStub.body = makeNode('body');
  const rejections = [];
  const dialog = sandbox.newCharacterDialog({});
  dialog.catch(e => rejections.push(e));
  await sleep(50);
  assert.equal(rejections.length, 0, `диалог создания не должен падать: ${rejections[0]?.stack}`);

  // шаг 1 «Концепция»
  let nameInput; walk(documentStub.body, n => { if (n.tag === 'input' && n.attributes.placeholder === 'Как вас будут помнить?') nameInput = n; });
  fireInput(nameInput, 'Эмбер Тест');
  click(findButton(documentStub.body, 'Далее')); await sleep(20);

  // шаг 2 «Происхождение»: холмовой дварф, жрец, прислужник (2014)
  const pick = (aria, entryId) => { const s = findSelect(documentStub.body, aria); assert.ok(s, 'выбор «' + aria + '» отрисован'); fireChange(s, entryId); };
  pick('Расы', 'srd14-hill-dwarf'); await sleep(20);
  pick('Классы', 'srd14-cleric'); await sleep(20);
  pick('Предыстории', 'srd14-acolyte'); await sleep(20);
  let subRadio; walk(documentStub.body, n => { if (n.tag === 'input' && n.attributes.name === 'builder-subclass' && !subRadio) subRadio = n; });
  assert.ok(subRadio, 'подкласс жреца отрисован'); fireChange(subRadio); await sleep(20);
  let toolRadio; walk(documentStub.body, n => { if (n.tag === 'input' && n.attributes.name === 'builder-race-dwarfTool' && !toolRadio) toolRadio = n; });
  assert.ok(toolRadio, 'выбор инструментов дварфа отрисован'); fireChange(toolRadio); await sleep(20);
  click(findButton(documentStub.body, 'Далее')); await sleep(20);

  // шаг 3 «Характеристики»: покупка очков (стандартный набор стоит ровно 27)
  click(findButton(documentStub.body, 'Покупка очков')); await sleep(20);
  click(findButton(documentStub.body, 'Далее')); await sleep(20);

  // шаг 4 «Навыки»: два навыка класса + две взаимозамены (навыки предыстории в списке класса) + два языка
  for (const skill of ['История', 'Медицина', 'Акробатика', 'Выживание']) {
    const cb = findByPrefix(documentStub.body, 'builder-skill', skill);
    assert.ok(cb, 'навык «' + skill + '» доступен'); cb.checked = true; fireChange(cb); await sleep(10);
  }
  for (const lang of ['Драконий', 'Эльфийский']) {
    const cb = findByPrefix(documentStub.body, 'builder-chip', lang);
    assert.ok(cb, 'язык «' + lang + '» доступен'); cb.checked = true; fireChange(cb); await sleep(10);
  }
  click(findButton(documentStub.body, 'Далее')); await sleep(20);

  // шаг 5 «Заклинания»: жрец 2014 — проверка лимитов проходит без ручного выбора
  click(findButton(documentStub.body, 'Далее')); await sleep(20);

  // шаг 6 «Снаряжение»: первый вариант в каждой группе + выбор священного символа
  const eqGroups = [];
  walk(documentStub.body, n => { if (n.tag === 'input' && n.attributes.type === 'radio' && String(n.attributes.name || '').startsWith('eq-') && !eqGroups.includes(n.attributes.name)) eqGroups.push(n.attributes.name); });
  for (const name of eqGroups) {
    let radio; walk(documentStub.body, n => { if (n.tag === 'input' && n.attributes.name === name && !radio) radio = n; });
    fireChange(radio); await sleep(10);
  }
  let symbolSelect;
  walk(documentStub.body, n => {
    if (n.tag === 'label' && String(n.className).includes('builder-eq-pick') && text(n).includes('священный символ') && !symbolSelect)
      symbolSelect = (n.children || []).find(c => c.tag === 'select');
  });
  assert.ok(symbolSelect, 'выбор «священный символ» из безусловной выдачи показан игроку');
  const symbolOption = (symbolSelect.children || []).find(c => c.tag === 'option' && c.attributes.value);
  fireChange(symbolSelect, symbolOption.attributes.value); await sleep(20);
  click(findButton(documentStub.body, 'Далее')); await sleep(20);

  // шаг 7 «Личность» → шаг 8 «Проверка» → создание
  click(findButton(documentStub.body, 'Далее')); await sleep(20);
  click(buttons(documentStub.body).find(b => text(b).includes('Создать персонажа'))); await sleep(20);
  const result = await Promise.race([dialog, sleep(500).then(() => null)]);
  assert.equal(rejections.length, 0, rejections[0]?.stack);
  return result;
}

test('мастер создания персонажа открывается и рисует все восемь шагов', async () => {
  documentStub.body = makeNode('body');
  const rejections = [];
  const dialog = sandbox.newCharacterDialog({});
  dialog.catch(e => rejections.push(e));
  await sleep(50);
  assert.equal(rejections.length, 0, `диалог создания не должен падать при открытии: ${rejections[0]?.stack}`);
  const stepButtons = buttons(documentStub.body).filter(b => String(b.className).includes('builder-step'));
  assert.equal(stepButtons.length, 8, 'навигация показывает восемь шагов');
  assert.ok(findButton(documentStub.body, 'Далее'), 'кнопка «Далее» на месте');
});

test('полный проход мастера завершается готовым листом персонажа', async () => {
  const result = await walkWizard();
  assert.ok(result && result.sheet, 'диалог вернул лист персонажа');
  assert.equal(result.name, 'Эмбер Тест');
  const sheet = result.sheet;
  assert.match(sheet.race, /Дварф/);
  assert.equal(sheet.class, 'Жрец');
  assert.match(sheet.background, /Прислужник/);
  assert.ok(sheet.skills.includes('history') && sheet.skills.includes('insight'), 'навыки класса и предыстории на месте');
  assert.ok(sheet.inventory.length > 0, 'стартовое снаряжение попало в инвентарь');
  assert.ok(sheet.inventory.some(it => /Амулет|Эмблема|Реликварий/.test(it.name)), 'выбранный священный символ в инвентаре');
});
