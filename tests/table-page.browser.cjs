// Точечный браузерный тест страницы «Участники стола» (/table/<кампания>):
// список персонажей и токенов сцены, поиск/фильтры, кнопки «На сцену»/«Убрать».
// HTTP API подменяется через page.route, WebSocket-сервер не нужен.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SCRIPTS = ['common', 'asset-kinds', 'table-model', 'table-page'];

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const answers = {
      '/api/auth/me': { id: 'u1', name: 'Мастер', email: 'gm@test', is_root: false },
      '/api/campaigns/camp-1': { id: 'camp-1', name: 'Тестовая кампания', role: 'gm', owner_id: 'u1', active_scene_id: 'sc1', members: [{ user_id: 'u1', name: 'Мастер', role: 'gm', email: 'gm@test' }] },
      '/api/campaigns/camp-1/scenes': [{ id: 'sc1', name: 'Подземелье' }],
      '/api/campaigns/camp-1/scenes/sc1': {
        id: 'sc1', name: 'Подземелье', grid: { size: 70, type: 'square', visible: true, scale: '5 фт' }, fog: { enabled: false, shapes: [] },
        items: [
          { id: 't1', layer: 'character', z: 0, data: { type: 'image', x: 350, y: 350, w: 70, h: 70, name: 'Ария', character_id: 'ch1', hp: { cur: 12, max: 18 }, owner_id: 'u1' } },
          { id: 't2', layer: 'character', z: 0, data: { type: 'image', x: 420, y: 350, w: 70, h: 70, name: 'Гоблин', monster: true, hp: { cur: 7, max: 7 }, owner_id: 'u1', hidden: true } },
          { id: 'p1', layer: 'prop', z: 0, data: { type: 'image', x: 0, y: 0, w: 70, h: 70, name: 'Бочка' } },
        ],
      },
      '/api/characters?campaign_id=camp-1': [
        { id: 'ch1', name: 'Ария', owner_id: 'u1', campaign_id: 'camp-1', sheet: { race: 'Эльф', class: 'Волшебник', level: 3, hp: { current: 12, max: 18 } } },
        { id: 'ch2', name: 'Борин', owner_id: 'u1', campaign_id: 'camp-1', sheet: { race: 'Дварф', class: 'Воин', level: 2, hp: { current: 20, max: 20 } } },
      ],
      '/api/assets?kind=token': [],
    };

    await page.route('https://table-page.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) {
        return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: 'text/javascript' });
      }
      if (!url.pathname.startsWith('/api/')) {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style><div id="app"></div>' +
            SCRIPTS.map(name => `<script src="/static/${name}.js"></script>`).join(''),
        });
      }
      const body = answers[url.pathname + url.search] || answers[url.pathname];
      if (body !== undefined) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' });
    });

    await page.goto('https://table-page.test/table/camp-1');
    await page.waitForSelector('.list .item');

    // ---- шапка и «Войти на карту» ----
    assert.equal(await page.locator('h1', { hasText: 'Участники стола' }).count(), 1, 'страница участников открылась');
    assert.equal(await page.locator('a', { hasText: 'Войти на карту' }).getAttribute('href'), '/c/camp-1', 'кнопка ведёт на стол кампании');

    // ---- список: персонаж на сцене, персонаж без токена, NPC/монстр из сцены ----
    const rows = page.locator('.list .item');
    assert.equal(await rows.count(), 3, 'две строки персонажей + монстр со сцены');
    const ariaRow = page.locator('.list .item', { hasText: 'Ария' });
    const aria = await ariaRow.innerText();
    assert.ok(aria.includes('на сцене'), 'у Арии есть токен на сцене');
    const ariaHp = await ariaRow.locator('input[type=number]').evaluateAll(els => els.map(e => e.value));
    assert.deepEqual(ariaHp, ['12', '18'], 'HP токена показаны в строке');
    const borin = await page.locator('.list .item', { hasText: 'Борин' }).innerText();
    assert.ok(borin.includes('не на сцене'), 'Борин ещё не на сцене');
    assert.ok(borin.includes('20'), 'HP листа персонажа видны до добавления токена');
    assert.equal(await page.getByRole('button', { name: /На сцену/ }).count(), 1, 'кнопка «На сцену» есть только у персонажа без токена');
    const goblin = await page.locator('.list .item', { hasText: 'Гоблин' }).innerText();
    assert.ok(goblin.includes('монстр'), 'токен без character_id показан как NPC/монстр');
    assert.ok(goblin.includes('скрыт'), 'скрытность видна мастеру');

    // ---- фильтр и поиск ----
    await page.locator('select[title="Фильтр участников"]').selectOption('off');
    assert.equal(await page.locator('.list .item').count(), 1, 'фильтр «Не на сцене»');

    await page.locator('select[title="Фильтр участников"]').selectOption('hidden');
    assert.equal(await page.locator('.list .item').count(), 1, 'фильтр «Скрытые»');

    await page.locator('select[title="Фильтр участников"]').selectOption('');
    await page.locator('input[placeholder="Поиск по имени…"]').fill('гобл');
    assert.equal(await page.locator('.list .item').count(), 1, 'поиск по имени');
    assert.equal(await page.locator('.list .item').first().innerText().then(t => t.includes('Гоблин')), true);

    // ---- добавление токена без ассетов объясняет, чего не хватает (WS-сообщение в очередь) ----
    await page.locator('input[placeholder="Поиск по имени…"]').fill('');
    await page.getByRole('button', { name: /На сцену/ }).click();
    await page.waitForSelector('.toast');
    const toastText = await page.locator('.toast').last().innerText();
    assert.match(toastText, /нет токенов|добавлен/i, 'нажатие «На сцену» обрабатывается');

    assert.deepEqual(errors, []);
    console.log('PASS table page browser: участники (персонажи/NPC), HP, скрытность, поиск/фильтры, «На сцену», «Войти на карту»');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
