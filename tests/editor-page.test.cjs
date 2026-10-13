// Отдельная страница редактора записи (static/editor-page.js): адреса /class-editor/<id>,
// загрузка записи, сохранение (создание и правка) и переходы из справочника.
// Прогон в vm с минимальным DOM-стабом; API подменяется, ничего наружу не уходит.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeNode(tag) {
  return {
    tag, nodeType: 1, children: [], parentElement: null, style: {}, dataset: {}, attributes: {},
    className: '', value: '', checked: false, disabled: false, _listeners: {}, options: [], selectedIndex: 0,
    setAttribute(k, v) { this.attributes[k] = v; },
    append(...cs) { for (const c of cs) if (c != null) { c.parentElement = this; this.children.push(c); } },
    appendChild(c) { this.append(c); },
    insertBefore(c) { this.children.unshift(c); c.parentElement = this; return c; },
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
const domStub = { title: '', documentElement: { dataset: {} }, createElement: t => makeNode(t), createDocumentFragment: () => makeNode('#fragment'),
  createElementNS: (ns, t) => makeNode(t), createTextNode: t => ({ nodeType: 3, textContent: String(t), parentElement: null, children: [] }),
  body: makeNode('body'), activeElement: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() { }, removeEventListener() { } };

const ctx = { console, crypto: require('node:crypto').webcrypto, document: domStub, matchMedia: () => ({ matches: false }),
  localStorage: { getItem: () => null, setItem() { }, removeItem() { } }, navigator: { language: 'ru' },
  setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, URL, structuredClone };
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.location = { host: 'test', protocol: 'http:', pathname: '/compendium', href: '', search: '' };
ctx.history = { replaced: [], replaceState(a, b, url) { this.replaced.push(url); ctx.location.href = url; }, pushState() { } };
ctx.opened = [];
ctx.open = (href, target) => { ctx.opened.push({ href, target }); return {}; };
vm.createContext(ctx);
require('../tools/presets/node-loader.cjs').loadPresets(ctx);
// Редактор класса в отдельной странице: графовый слой нужен (правила пишутся узлами),
// но сама страница графа не показывает — форма остаётся формой.
for (const f of ['common.js', 'dice.js', 'formulas.js', 'equipment.js', 'mechanics.js', 'node-params-form.js', 'node-registry.js',
  ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'mechanics-graph.js', 'modules.js', 'class-rules.js', 'character-builder.js',
  'class-editor.js', 'race-editor.js', 'editor-page.js'])
  vm.runInContext(fs.readFileSync(f.startsWith('/') ? f : 'static/' + f, 'utf8'), ctx, { filename: f });

const EP = ctx.window.EditorPage;
const CE = ctx.window.ClassEditor;
const plain = x => JSON.parse(JSON.stringify(x));
const walk = (node, fn) => { fn(node); for (const c of node.children || []) walk(c, fn); };
const textOf = node => !node ? '' : node.nodeType === 3 ? node.textContent : (node.children || []).map(textOf).join('');
const all = (root, cls) => { const out = []; walk(root, n => { if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n); }); return out; };
const allTag = (root, tag) => { const out = []; walk(root, n => { if (n.tag === tag) out.push(n); }); return out; };
const fire = (node, ev, arg) => { for (const fn of node._listeners[ev] || []) fn(arg); };
const typeIn = (node, value) => { node.value = value; fire(node, 'input', { target: node }); };
const clickText = (root, label) => { const btn = allTag(root, 'button').find(b => textOf(b).trim() === label); assert.ok(btn, `кнопка «${label}»`); fire(btn, 'click', {}); return btn; };

// Записи классов в «сыром» виде — как их отдаёт /api/compendium/<id>?raw=1.
const seed = require('./fixtures/srd.cjs')('data_seed/srd_2014.json');
const rawClass = () => JSON.parse(JSON.stringify(seed.find(e => e.slug === 'srd14-barbarian')));
const record = e => ({ id: 'c-1', category: 'class', name: e.name, source: 'SRD 2014', pack_id: null, campaign_id: null, data: e.data });

const api = { log: [], fail: null, next: {} };
const stubAPI = () => {
  api.log = []; api.fail = null; api.next = {};
  ctx.API = ctx.window.API = {
    async get(url) {
      api.log.push(['GET', url]);
      if (api.fail) throw new Error(api.fail);
      if (url.startsWith('/api/packs')) return [{ id: 'p-1', name: 'Домашние' }];
      if (url.startsWith('/api/compendium?category=race')) return [];
      if (url.startsWith('/api/compendium/')) return api.next.entry || record(rawClass());
      throw new Error('неожиданный GET ' + url);
    },
    async post(url, body) { api.log.push(['POST', url, body]); return api.next.created || { id: 'new-1', pack_id: body.pack_id, campaign_id: body.campaign_id }; },
    async patch(url, body) { api.log.push(['PATCH', url, body]); return {}; },
  };
};
stubAPI();
// toast/prompt2 уже из common.js; prompt2 для «+ Новый набор…» не должен вызываться без нужды.
ctx.window.ME = { is_root: false };

test('адреса страницы редактора: вид по пути, id и параметры места сохранения', () => {
  assert.equal(EP.kindOfPath('/class-editor'), 'class');
  assert.equal(EP.kindOfPath('/class-editor/abc-1/'), 'class');
  assert.equal(EP.kindOfPath('/race-editor/x'), 'race');
  assert.equal(EP.kindOfPath('/background-editor'), 'background');
  assert.equal(EP.kindOfPath('/compendium'), null);
  assert.equal(EP.idOfPath('/class-editor/abc-1'), 'abc-1');
  assert.equal(EP.idOfPath('/class-editor'), null);
  assert.equal(EP.url('class', 'abc-1'), '/class-editor/abc-1');
  assert.equal(EP.url('race', null, { packId: 'p-1' }), '/race-editor?pack=p-1');
  assert.equal(EP.url('background', null, { campaignId: 'c-2' }), '/background-editor?campaign=c-2');
  assert.equal(EP.available('class'), true, 'редактор класса умеет отдавать тело для страницы');
});

test('страница редактора класса: запись загружается, разделы рисуются, сохранение идёт в запись', async () => {
  stubAPI();
  ctx.location.pathname = '/class-editor/c-1';
  const host = makeNode('div');
  await EP.render(host, { kind: 'class', id: 'c-1' });

  assert.equal(api.log[0][0], 'GET');
  assert.equal(api.log[0][1], '/api/compendium/c-1?raw=1', 'запись берётся в сыром виде');
  const head = all(host, 'ed-head')[0];
  assert.ok(textOf(head).includes('Класс: Варвар'), 'заголовок страницы');
  assert.ok(all(host, 'ced-nav-btn').length >= 7, 'разделы редактора на месте');
  assert.equal(allTag(host, 'select').filter(x => x.attributes['aria-label'] === 'Куда сохранить запись').length, 0,
    'для существующей записи место сохранения не спрашивают');

  // Правка названия и сохранение: уходит PATCH с категорией класса и данными записи.
  const title = allTag(host, 'input').find(i => i.attributes.value === 'Варвар');
  assert.ok(title, 'поле названия найдено');
  typeIn(title, 'Варвар Севера');
  clickText(host, 'Сохранить');
  await new Promise(r => setImmediate(r));
  const patch = api.log.find(x => x[0] === 'PATCH');
  assert.ok(patch, 'сохранение — PATCH существующей записи');
  assert.equal(patch[1], '/api/compendium/c-1');
  assert.equal(patch[2].category, 'class');
  assert.equal(patch[2].name, 'Варвар Севера');
  assert.equal(patch[2].data.hit_die, 'd12', 'данные записи целиком');
  assert.ok(patch[2].data.mechanics.graph.nodes.some(n => n.type === 'rule.class_progression'), 'граф правил едет вместе с записью');
  assert.equal(ctx.history.replaced.length, 0, 'адрес существующей записи не меняется');
});

test('новая запись: место сохранения из параметров, POST и появление адреса', async () => {
  stubAPI();
  ctx.location.pathname = '/class-editor';
  ctx.location.href = '/class-editor';
  ctx.history.replaced = [];
  const host = makeNode('div');
  await EP.render(host, { kind: 'class', id: null, search: '?pack=p-1' });

  const dest = allTag(host, 'select').find(x => x.attributes['aria-label'] === 'Куда сохранить запись');
  assert.ok(dest, 'для новой записи есть выбор места сохранения');
  const options = allTag(dest, 'option');
  assert.ok(options.some(o => o.attributes.value === 'pack:p-1'), 'набор пользователя предложен');
  assert.ok(options.some(o => o.attributes.value === 'pack:p-1' && o.attributes.selected === ''), 'набор из адреса страницы выбран');

  dest.value = 'pack:p-1';   // в браузере значение селекта уже выбрано по адресу страницы
  const name = allTag(host, 'input').find(i => i.attributes.placeholder === 'Волшебник');
  assert.ok(name, 'поле названия на странице');
  typeIn(name, 'Мой класс');
  clickText(host, 'Сохранить');
  await new Promise(r => setImmediate(r));
  const post = api.log.find(x => x[0] === 'POST');
  assert.ok(post, 'новая запись создаётся');
  assert.equal(post[1], '/api/compendium');
  assert.equal(post[2].category, 'class');
  assert.equal(post[2].pack_id, 'p-1', 'место сохранения из адреса страницы');
  assert.equal(post[2].campaign_id, null);
  assert.deepEqual(ctx.history.replaced, ['/class-editor/new-1'], 'у записи появляется свой адрес');
});

test('пустое название не сохраняется, а ошибка сервера показывается', async () => {
  stubAPI();
  const host = makeNode('div');
  await EP.render(host, { kind: 'class', id: 'c-1' });
  const title = allTag(host, 'input').find(i => i.attributes.value === 'Варвар');
  typeIn(title, '   ');
  clickText(host, 'Сохранить');
  await new Promise(r => setImmediate(r));
  assert.equal(api.log.filter(x => x[0] === 'PATCH').length, 0, 'пустое название в запись не уходит');

  api.fail = null;
  api.next.entry = record(rawClass());
  api.log = [];
  ctx.API = ctx.window.API = { ...ctx.window.API, async patch() { throw new Error('сервер недоступен'); } };
  const host2 = makeNode('div');
  await EP.render(host2, { kind: 'class', id: 'c-1' });
  clickText(host2, 'Сохранить');
  await new Promise(r => setImmediate(r));
  assert.ok(all(host2, 'ced-section').length, 'страница остаётся открытой после ошибки');
});

test('страница отвечает на отсутствующую запись предложением вернуться', async () => {
  stubAPI();
  api.fail = 'не найдено';
  const host = makeNode('div');
  await EP.render(host, { kind: 'class', id: 'нет-такой' });
  assert.ok(textOf(host).includes('Запись не найдена'), 'сообщение об ошибке');
  assert.ok(allTag(host, 'a').some(a => a.attributes.href === '/compendium'), 'ссылка назад в справочник');
});

test('открытие из справочника: в лобби — на месте, на столе и на листе — в новой вкладке', () => {
  ctx.opened = [];
  ctx.location.href = '/compendium';
  const went = [];
  ctx.go = ctx.window.go = url => went.push(url);
  assert.equal(EP.open('class', { id: 'c-1' }), true);
  assert.deepEqual(went, ['/class-editor/c-1'], 'в лобби страница открывается на месте');

  ctx.window.TABLE_CTX = { isGM: true };
  assert.equal(EP.open('race', { id: 'r-1' }), true);
  assert.deepEqual(ctx.opened, [{ href: '/race-editor/r-1', target: '_blank' }], 'на столе — в новой вкладке, чтобы не терять стол');
  delete ctx.window.TABLE_CTX;

  // Редактор без отдельной страницы: вызывающий остаётся при своей модалке.
  const original = ctx.window.ClassEditor.form;
  delete ctx.window.ClassEditor.form;
  assert.equal(EP.available('class'), false);
  assert.equal(EP.open('class', { id: 'c-1' }), false);
  ctx.window.ClassEditor.form = original;
});

test('справочник и наборы ведут в отдельный редактор, а модалка остаётся запасным путём', () => {
  const compendium = fs.readFileSync('static/compendium.js', 'utf8');
  assert.match(compendium, /window\.EditorPage\?\.available\?\.\(kind\)/, 'карточка проверяет отдельную страницу');
  assert.match(compendium, /EDITOR_KIND\[category\][\s\S]{0,200}window\.EditorPage\.open/, 'создание записи ведёт на страницу редактора');
  assert.match(compendium, /if \(!openEntryEditor\(e, opts\)\) editEntry\(/, 'модалка остаётся запасным путём');
  const packs = fs.readFileSync('static/packs.js', 'utf8');
  assert.match(packs, /window\.EditorPage\?\.available\?\.\(category\)/, 'мастерская набора ведёт на страницу редактора');
  const app = fs.readFileSync('static/app.js', 'utf8');
  assert.match(app, /EditorPage\?\.kindOfPath\(path\)/, 'маршрут страницы редактора зарегистрирован');
  for (const file of ['static/index.html', 'static/sheet.html']) {
    assert.match(fs.readFileSync(file, 'utf8'), /<script src="\/static\/editor-page\.js"><\/script>/, `${file}: страница подключена`);
  }
});
