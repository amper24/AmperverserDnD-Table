// Единая навигация: чистые пункты меню (static/nav.js) — состав, активный раздел
// по location.pathname, адрес «Стола» и отсутствие вмешательства в history API.
// nav.js не трогает DOM до вызова header()/menu(), поэтому грузится в vm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadNav() {
  const ctx = { window: {}, document: {}, console, location: { pathname: '/' } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/common.js', 'utf8'), ctx, { filename: 'static/common.js' });
  // Хранилище последней открытой кампании (в браузере — LS из common.js).
  ctx.window.LS = { getItem: key => (ctx.lastCampaign && key === 'et-last-campaign' ? ctx.lastCampaign : null) };
  vm.runInContext(fs.readFileSync('static/nav.js', 'utf8'), ctx, { filename: 'static/nav.js' });
  return { Nav: ctx.window.Nav, ctx };
}
const { Nav, ctx } = loadNav();
const plain = value => JSON.parse(JSON.stringify(value));

test('пункты меню: шесть штук, «Главная» — логотип, остальные — ссылки', () => {
  const keys = plain(Nav.ITEMS.map(item => item.key));
  assert.deepEqual(keys, ['home', 'campaigns', 'characters', 'compendium', 'table', 'profile']);
  assert.deepEqual(plain(Nav.ITEMS.map(item => item.label)), ['Главная', 'Кампании', 'Персонажи', 'Справочник', 'Стол', 'Профиль']);
  assert.equal(Nav.ITEMS.filter(item => item.brand).length, 1, 'ровно один пункт-логотип');
  assert.equal(Nav.ITEMS.find(item => item.brand).key, 'home');
  // Адреса стабильны и не зависят от текущей страницы.
  const items = plain(Nav.items('/compendium'));
  assert.deepEqual(items.filter(item => !item.brand).map(item => [item.key, item.href]), [
    ['campaigns', '/campaigns'],
    ['characters', '/characters'],
    ['compendium', '/compendium'],
    ['table', '/campaigns'],
    ['profile', '/profile'],
  ]);
  // Иконки пунктов есть в пуле common.js (компактное меню рисует их без подписи).
  for (const item of plain(Nav.ITEMS)) assert.ok(ctx.window.ICON_NAMES.includes(item.icon), `иконка ${item.icon}`);
  // Подписи пунктов совпадают с теми, что видят страницы из HTML-разметки.
  const index = fs.readFileSync('static/index.html', 'utf8');
  assert.match(index, /\/static\/nav\.js/, 'index.html подключает nav.js');
  assert.match(index, /\/static\/nav\.css/, 'index.html подключает nav.css');
});

test('активный пункт по pathname: главная, кампании, персонажи, справочник, стол, профиль', () => {
  const cases = [
    ['/', 'home'], ['', 'home'], ['/campaigns', 'campaigns'], ['/campaigns/', 'campaigns'],
    ['/characters', 'characters'], ['/characters/abc', 'characters'],
    ['/sheet/abc', 'characters'], ['/sheet/abc?embed=1', 'characters'], ['/character/abc', 'characters'],
    ['/compendium', 'compendium'], ['/compendium?category=feat', 'compendium'],
    ['/table/camp1', 'table'], ['/table/camp1/', 'table'], ['/table', 'table'],
    ['/c/camp1', 'campaigns'], ['/c/camp1?x=1', 'campaigns'],
    ['/profile', 'profile'], ['/profile/', 'profile'],
    ['/library', 'compendium'], ['/library/x', 'compendium'], ['/packs', 'compendium'], ['/packs/x', 'compendium'], ['/login', ''],
  ];
  for (const [pathname, expected] of cases) {
    assert.equal(Nav.activeKey(pathname), expected, `активный раздел для ${JSON.stringify(pathname)}`);
  }
});

test('build(): ровно один активный пункт, ссылки копируются без мутации входа', () => {
  const links = [
    { key: 'campaigns', label: 'Кампании', href: '/campaigns' },
    { key: 'characters', label: 'Персонажи', href: '/characters' },
  ];
  const sheet = plain(Nav.build(links, '/sheet/xyz'));
  assert.deepEqual(sheet.map(item => item.active), [false, true]);
  assert.deepEqual(sheet.map(item => item.href), ['/campaigns', '/characters'], 'href не переписываются');
  assert.equal(links[1].active, undefined, 'входные объекты не меняются');
  // Путь вне карты — ни одного активного пункта.
  assert.deepEqual(plain(Nav.build(links, '/library')).map(item => item.active), [false, false]);
  // Пустой список и пустой путь не ломают сборку.
  assert.deepEqual(plain(Nav.build([], '/')), []);
  assert.deepEqual(plain(Nav.build(links, undefined)).map(item => item.active), [false, false]);
});

test('«Стол» ведёт на стол кампании: /table/:cid, /c/:cid, последняя открытая, иначе /campaigns', () => {
  assert.equal(Nav.tableHref('/table/camp1'), '/c/camp1', 'со страницы участников — стол этой кампании');
  assert.equal(Nav.tableHref('/c/camp1'), '/c/camp1', 'со стола — он же');
  assert.equal(Nav.tableHref('/sheet/x'), '/campaigns', 'без истории — список кампаний');
  ctx.lastCampaign = 'camp7';
  assert.equal(Nav.tableHref('/sheet/x'), '/c/camp7', 'последняя открытая кампания');
  assert.equal(Nav.tableHref('/table/camp1'), '/c/camp1', 'своя кампания важнее последней');
  const items = plain(Nav.items('/profile'));
  assert.equal(items.find(item => item.key === 'table').href, '/c/camp7');
});

test('nav.js только рисует ссылки и не вмешивается в роутинг', () => {
  const src = fs.readFileSync('static/nav.js', 'utf8');
  for (const forbidden of ['history.pushState', 'history.replaceState', 'preventDefault()', 'location.href =']) {
    assert.equal(src.includes(forbidden), false, `nav.js не должен содержать ${forbidden}`);
  }
  // Ссылки — обычные <a href>: переходы делает браузер, SPA остаётся на place.
  assert.match(src, /el\('a', \{/);
  assert.match(src, /href: item\.href/);
});
