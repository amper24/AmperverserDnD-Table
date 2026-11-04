// Точечный браузерный тест единой навигации и главной страницы.
// Проверяет: одинаковые пункты и активный раздел на index/sheet/table/profile,
// переход по пункту, отсутствие дублей локальных ссылок, рабочее меню на узком
// экране и содержимое главной (кампании, персонажи, быстрые действия).
// Страницы читаются из static/, HTTP API и WebSocket подменяются page.route —
// запущенный сервер не нужен.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const browserLaunchOptions = require('./browser-launch.cjs');

const HOST = 'https://nav.test';
const APP = ['home', 'campaigns', 'characters', 'compendium', 'table', 'profile'];
const LABELS = { campaigns: 'Кампании', characters: 'Персонажи', compendium: 'Справочник', table: 'Стол', profile: 'Профиль' };
const HREFS = { home: '/', campaigns: '/campaigns', characters: '/characters', compendium: '/compendium', table: '/c/camp1', profile: '/profile' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==';

const campaign = () => ({
  id: 'camp1', name: 'Кампания теней', description: 'Подземелья и драконы', owner_id: 'u1',
  active_scene_id: 'sc1', role: 'gm', created_at: '2025-01-01T10:00:00Z',
});
const character = () => ({
  revision: 1, id: 'char1', campaign_id: 'camp1', owner_id: 'u1', name: 'Ария',
  portrait_asset_id: null, updated_at: '',
  sheet: {
    _revision: 1, name: 'Ария', edition: '2014', level: 3, xp: 0,
    race: 'Эльф', class: 'Волшебник', subclass: 'Школа Воплощения', background: 'Мудрец', alignment: '',
    abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 10, cha: 10 }, proficiency_bonus: 2,
    hp: { max: 20, current: 20, temp: 0, hit_dice: '3d6' }, ac: 12, speed: 30,
    inventory: [], features: [], conditions: [], attacks: [], skills: [], expertise: [], saving_throws: [],
    notes_by: {}, currency: {}, traits: {}, spells: { ability: 'int', slots: {}, known: [] },
  },
});
const characterSummary = () => ({
  revision: 1, id: 'char1', campaign_id: 'camp1', owner_id: 'u1', name: 'Ария',
  portrait_asset_id: null, updated_at: '',
  sheet: { level: 3, race: 'Эльф', class: 'Волшебник', subclass: 'Школа Воплощения' },
});
const API = {
  '/api/auth/me': () => ({ id: 'u1', name: 'Игрок', email: 'player@test', is_root: false, avatar_asset_id: null, has_password: true, created_at: '2025-01-01T10:00:00Z' }),
  '/api/auth/settings': () => ({ allow_registration: true, password_min_length: 8, max_upload_mb: 25 }),
  '/api/campaigns': () => [campaign()],
  '/api/campaigns/camp1': () => Object.assign(campaign(), {
    members: [
      { user_id: 'u1', name: 'Мастер', email: 'gm@test', role: 'gm' },
      { user_id: 'u2', name: 'Игрок', email: 'pl@test', role: 'player' },
    ],
  }),
  '/api/campaigns/camp1/scenes': () => [{ id: 'sc1', name: 'Пещера' }],
  '/api/characters': () => [characterSummary()],
  '/api/characters?campaign_id=camp1': () => [],
  '/api/characters/char1': () => character(),
  '/api/join/abc123': () => ({ campaign_id: 'camp1', campaign_name: 'Кампания теней', role: 'player' }),
  '/api/assets': () => [],
  '/api/assets?kind=portrait': () => [],
  '/api/compendium': () => [],
};

function pageFile(pathname) {
  if (pathname === '/') return 'static/index.html';
  if (pathname === '/profile') return 'static/profile.html';
  if (pathname.startsWith('/sheet/')) return 'static/sheet.html';
  if (pathname.startsWith('/table/')) return 'static/table.html';
  return 'static/index.html'; // SPA: /campaigns, /characters, /compendium, /c/:cid, /join/:code
}

async function openPage(browser, options = {}) {
  const page = await browser.newPage({ viewport: options.viewport || { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  // Согласие на cookie уже дано (баннер не мешает), «последняя кампания» известна
  // всем страницам — так пункт «Стол» везде ведёт на один и тот же стол.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true }));
      localStorage.setItem('et-last-campaign', 'camp1');
    } catch { }
  });
  await page.route(HOST + '/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/static/')) {
      const file = path.join(process.cwd(), url.pathname);
      const type = url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.json') ? 'application/json' : 'text/javascript';
      return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
    }
    requests.push({ method: request.method(), pathname: url.pathname + url.search });
    if (!url.pathname.startsWith('/api/')) {
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(pageFile(url.pathname), 'utf8') });
    }
    const handler = API[url.pathname + url.search] || API[url.pathname];
    if (handler) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(handler()) });
    if (url.pathname.startsWith('/api/assets/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data_b64: PNG, encoding: 'identity', mime: 'image/png' }) });
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.routeWebSocket(/\/ws\//, () => { /* присутствие не нужно: странице достаточно пустого канала */ });
  return { page, errors, requests };
}

// Пункты шапки: key, видимая подпись (у логотипа — aria-label), href, aria-current.
async function navItems(page) {
  await page.locator('.edge-topbar').waitFor();
  return page.$$eval('.edge-topbar [data-nav]', nodes => nodes.map(node => ({
    key: node.dataset.nav,
    label: (node.querySelector('.edge-nav-label') ? node.querySelector('.edge-nav-label').textContent : (node.getAttribute('aria-label') || node.textContent)).trim(),
    href: node.getAttribute('href'),
    current: node.getAttribute('aria-current'),
  })));
}
function assertUniformNav(items, activeKey, where) {
  assert.deepEqual(items.map(item => item.key), APP, `${where}: состав и порядок пунктов`);
  for (const item of items) {
    assert.equal(item.href, HREFS[item.key], `${where}: адрес пункта ${item.key}`);
    assert.equal(item.current, item.key === activeKey ? 'page' : null, `${where}: активный пункт ${item.key}`);
  }
  const current = items.filter(item => item.current === 'page').map(item => item.key);
  assert.deepEqual(current, activeKey ? [activeKey] : [], `${where}: подсвечен ровно один пункт`);
  for (const item of items) if (LABELS[item.key]) assert.equal(item.label, LABELS[item.key], `${where}: подпись ${item.key}`);
  assert.match(items[0].label, /Главная/, `${where}: логотип подписан «Главная»`);
}

async function main() {
  const browser = await chromium.launch(await browserLaunchOptions());
  const results = [];
  try {
    // ---------- 1. Главная: кампании, персонажи, быстрые действия ----------
    {
      const { page, errors } = await openPage(browser);
      await page.goto(HOST + '/');
      await page.locator('[data-sec=campaigns] [data-campaign=camp1]').waitFor();
      await page.locator('[data-sec=characters] [data-character=char1]').waitFor();
      const items = await navItems(page);
      assertUniformNav(items, 'home', 'главная');

      // Карточка кампании: название, роль, участники, последняя сцена и три перехода.
      const camp = page.locator('[data-sec=campaigns] [data-campaign=camp1]');
      assert.equal((await camp.locator('.home-card-title').innerText()).trim(), 'Кампания теней');
      assert.equal((await camp.locator('.badge').innerText()).trim(), 'мастер');
      const campMeta = await camp.locator('.home-card-meta').innerText();
      assert.match(campMeta, /2 участника/, 'число участников из деталей кампании');
      assert.match(campMeta, /Сцена: Пещера/, 'последняя (активная) сцена');
      assert.equal(await camp.locator('a[href="/c/camp1"]').count(), 2, '«Открыть» и «На стол» ведут на стол');
      assert.equal(await camp.locator('a[href="/c/camp1"][target="_blank"]').count(), 1, '«На стол» — в новой вкладке');
      assert.equal(await camp.locator('a[href="/table/camp1"]').count(), 1, '«Участники» ведут на страницу участников');

      // Карточка персонажа: имя, уровень, раса/класс, кампания и «Лист».
      const char = page.locator('[data-sec=characters] [data-character=char1]');
      assert.equal((await char.locator('.home-card-title').innerText()).trim(), 'Ария');
      assert.equal((await char.locator('.badge').innerText()).trim(), '3 ур.');
      assert.match(await char.locator('.home-card-desc').innerText(), /Эльф · Волшебник/);
      assert.match(await char.locator('.home-card-meta').innerText(), /Кампания: Кампания теней/);
      assert.equal(await char.locator('a[href="/sheet/char1"][target="_blank"]').count(), 1, '«Лист» открывает лист');

      // Быстрые действия: на главной остались «Новая кампания» и «Новый персонаж»;
      // присоединение по коду убрано — только по ссылке-приглашению из раздела «Кампании».
      for (const name of ['Новая кампания', 'Новый персонаж']) {
        assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `быстрое действие «${name}»`);
      }
      assert.equal(await page.getByRole('button', { name: 'Присоединиться по коду', exact: true }).count(), 0, 'присоединения по коду на главной нет');
      // «Новая кампания» открывает диалог названия (проверяем и отменяем без запроса).
      await page.getByRole('button', { name: 'Новая кампания', exact: true }).click();
      const campDialog = page.locator('.modal');
      await campDialog.waitFor();
      assert.equal((await campDialog.locator('h2').innerText()).trim(), 'Название кампании', 'диалог создания кампании');
      await campDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(await page.locator('.modal').count(), 0, 'диалог закрылся без создания');

      // Присоединение по ссылке-приглашению — из раздела «Кампании».
      await page.locator('.edge-nav a[data-nav=campaigns]').click();
      await page.waitForURL(/\/campaigns$/);
      await page.locator('h1', { hasText: 'Кампании' }).waitFor();
      await page.getByRole('button', { name: 'Присоединиться по ссылке', exact: true }).click();
      const dialog = page.locator('.modal');
      await dialog.waitFor();
      await dialog.locator('input').fill(HOST + '/join/abc123');
      await dialog.getByRole('button', { name: 'OK', exact: true }).click();
      await page.waitForURL(/\/join\/abc123$/);
      await page.getByRole('heading', { name: 'Приглашение' }).waitFor();
      assert.match(await page.locator('.card.auth').innerText(), /Кампания теней/, 'страница приглашения открылась');
      assert.deepEqual(errors, [], 'главная без ошибок страницы');
      results.push('главная: карточки кампаний/персонажей, быстрые действия, присоединение по ссылке-приглашению');
      await page.close();
    }

    // ---------- 2. Лист персонажа: те же пункты, активны «Персонажи», переход работает ----------
    {
      const { page, errors } = await openPage(browser);
      await page.goto(HOST + '/sheet/char1');
      await page.locator('.sheet-topbar').waitFor();
      assertUniformNav(await navItems(page), 'characters', 'лист');
      // Локальных дублей нет: единственная ссылка на разделы — в общей шапке.
      assert.equal(await page.locator('.mainnav a[data-nav=campaigns][href="/campaigns"]').count(), 1, 'одна ссылка «Кампании»');
      assert.equal(await page.locator('.sheet-topbar a[href="/compendium"]').count(), 0, 'в шапке листа нет дубля справочника');

      await page.locator('.edge-nav a[data-nav=campaigns]').click();
      await page.waitForURL(/\/campaigns$/);
      await page.locator('.edge-topbar').waitFor();
      const after = await navItems(page);
      assert.deepEqual(after.filter(item => item.current).map(item => item.key), ['campaigns'], 'после перехода активны «Кампании»');
      assert.equal(await page.locator('h1', { hasText: 'Кампании' }).count(), 1, 'SPA показал раздел «Кампании»');
      assert.deepEqual(errors, [], 'лист и переход без ошибок страницы');
      results.push('лист: активны «Персонажи», переход в «Кампании»');
      await page.close();
    }

    // ---------- 3. Участники кампании: активен «Стол», дублей ссылок нет ----------
    {
      const { page, errors } = await openPage(browser);
      await page.goto(HOST + '/table/camp1');
      await page.locator('[data-sec=members]').waitFor();
      assertUniformNav(await navItems(page), 'table', 'участники');
      assert.equal(await page.locator('.edge-nav a[href="/c/camp1"]').count(), 1, '«Стол» ведёт на стол этой кампании');
      for (const [key, href] of [['campaigns', '/campaigns'], ['characters', '/characters'], ['compendium', '/compendium']]) {
        assert.equal(await page.locator(`.mainnav a[data-nav="${key}"][href="${href}"]`).count(), 1, `одна ссылка ${key}`);
      }
      assert.equal(await page.getByText('К столу', { exact: true }).count(), 0, 'локальная ссылка «К столу» убрана');
      assert.deepEqual(errors, [], 'участники без ошибок страницы');
      results.push('участники: активен «Стол», дубли убраны');
      await page.close();
    }

    // ---------- 4. Профиль: активен «Профиль», aria-current один ----------
    {
      const { page, errors } = await openPage(browser);
      await page.goto(HOST + '/profile');
      await page.locator('#profile-title').waitFor();
      assertUniformNav(await navItems(page), 'profile', 'профиль');
      const currents = await page.$$eval('a[aria-current="page"]', nodes => nodes.map(node => node.getAttribute('href')));
      assert.deepEqual(currents, ['/profile'], 'единственный aria-current — пункт «Профиль»');
      for (const [key, href] of [['campaigns', '/campaigns'], ['characters', '/characters'], ['compendium', '/compendium']]) {
        assert.equal(await page.locator(`.mainnav a[data-nav="${key}"][href="${href}"]`).count(), 1, `одна ссылка ${key}`);
      }
      assert.deepEqual(errors, [], 'профиль без ошибок страницы');
      results.push('профиль: активен «Профиль», aria-current один');
      await page.close();
    }

    // ---------- 5. Узкий экран: бургер, выпадающее меню, без переполнения ----------
    {
      const { page, errors } = await openPage(browser, { viewport: { width: 390, height: 780 } });
      await page.goto(HOST + '/');
      await page.locator('[data-sec=campaigns] [data-campaign=camp1]').waitFor();
      const toggle = page.locator('.edge-topbar .edge-nav-toggle');
      assert.equal(await toggle.isVisible(), true, 'на узком экране виден бургер');
      assert.equal(await page.locator('.edge-topbar .edge-nav').isVisible(), false, 'список пунктов свёрнут');
      const metrics = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      assert.ok(metrics.scroll <= metrics.inner + 1, `шапка не даёт горизонтального переполнения (${metrics.scroll} ≤ ${metrics.inner})`);

      await toggle.click();
      const panel = page.locator('.edge-topbar .edge-nav.is-open');
      await panel.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'бургер сообщает о раскрытии');
      assert.equal(await panel.locator('a[data-nav]').count(), 5, 'в меню все пять пунктов-ссылок');
      const metrics2 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      assert.ok(metrics2.scroll <= metrics2.inner + 1, 'открытое меню не даёт переполнения');

      // Esc закрывает меню и возвращает фокус бургеру.
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.edge-topbar .edge-nav.is-open').count(), 0, 'Esc закрывает меню');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'бургер сообщает о закрытии');
      assert.equal(await toggle.evaluate(node => node === document.activeElement), true, 'фокус вернулся на бургер');

      await toggle.click();
      await panel.waitFor();
      await panel.locator('a[data-nav=compendium]').click();
      await page.waitForURL(/\/compendium$/);
      await page.locator('.edge-topbar').waitFor();
      const items = await navItems(page);
      assert.deepEqual(items.filter(item => item.current).map(item => item.key), ['compendium'], 'активен «Справочник»');
      assert.deepEqual(errors, [], 'переход с узкого экрана без ошибок страницы');
      results.push('узкий экран: бургер, меню, активный пункт, без переполнения');
      await page.close();
    }

    // ---------- 6. Компактное меню «Разделы» (полноэкранный стол, /c/:cid) ----------
    {
      const { page, errors } = await openPage(browser);
      await page.goto(HOST + '/');
      await page.locator('.edge-topbar').waitFor();
      // В полноэкранном столе широкой шапки нет: app.js кладёт Nav.menu в панель .tbar.
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'nav-menu-fixture';
        host.className = 'tbar';
        host.style.cssText = 'display:flex;gap:8px;padding:8px;background:var(--panel)';
        document.body.prepend(host);
        host.append(Nav.menu({ current: '/c/camp1' }));
      });
      const menuBtn = page.locator('#nav-menu-fixture .edge-nav-menu-btn');
      const panel = page.locator('#nav-menu-fixture .edge-nav-panel');
      assert.equal(await panel.isVisible(), false, 'меню «Разделы» свёрнуто');
      await menuBtn.click();
      await panel.waitFor();
      assert.equal(await menuBtn.getAttribute('aria-expanded'), 'true', 'кнопка сообщает о раскрытии');
      assert.equal(await panel.locator('a[data-nav]').count(), 5, 'в меню все пять пунктов-ссылок');
      const active = await panel.locator('a[aria-current="page"]').evaluateAll(nodes => nodes.map(node => node.dataset.nav));
      assert.deepEqual(active, ['campaigns'], 'на столе (/c/…) активны «Кампании»');
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false, 'Esc закрывает меню «Разделы»');
      assert.equal(await menuBtn.getAttribute('aria-expanded'), 'false', 'кнопка сообщает о закрытии');
      assert.deepEqual(errors, [], 'компактное меню без ошибок страницы');
      results.push('стол: компактное меню «Разделы», активны «Кампании»');
      await page.close();
    }
  } finally {
    await browser.close();
  }
  for (const line of results) console.log('ok — ' + line);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
