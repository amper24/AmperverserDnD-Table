// Браузерный тест отдельной страницы редактора (настоящий Chromium):
// 1) из справочника «Редактировать» в карточке ведёт на /class-editor/<id>, а не в модалку;
// 2) страница класса: разделы, таблица развития 1–20, сохранение в саму запись справочника;
// 3) новая запись: место хранения из адреса, создание и появление своего адреса;
// 4) страница расы: каталог рас приходит сырым, правка сохраняется в запись расы;
// 5) без входа страница редактора перебрасывает на вход и помнит адрес возврата.
// Сервер не нужен: index.html и скрипты берутся из static/ (адреса страниц отдаёт тот же
// index.html, что и боевой fallback сервера), API подменяется маршрутами.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const loadSrd = require('./fixtures/srd.cjs');
const browserLaunchOptions = require('./browser-launch.cjs');

const SEED = loadSrd('data_seed/srd_2014.json');
const entry = (slug, id) => { const e = SEED.find(x => x.slug === slug); return { id, category: e.category, name: e.name, source: 'SRD 2014', pack_id: null, campaign_id: null, data: JSON.parse(JSON.stringify(e.data)) }; };

async function scenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
  const errors = [], calls = [];
  let auth = true;  // вход есть; в конце проверяем переход на страницу входа
  const ENTRIES = { 'c-1': entry('srd14-barbarian', 'c-1'), 'r-1': entry('srd14-high-elf', 'r-1') };
  // Баннер согласия не мешает кликам: согласие уже дано.
  await page.addInitScript(() => localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true })));
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());  // «уходим со страницы?» — только если правки не сохранены
  await page.route('https://editor.test/**', async route => {
    const url = new URL(route.request().url());
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.startsWith('/static/')) {
      const file = path.join(process.cwd(), url.pathname);
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript' });
    }
    const method = route.request().method(), body = (() => { try { return route.request().postDataJSON(); } catch { return null; } })();
    if (method !== 'GET') calls.push({ method, url: url.pathname, body });
    // Страница редактора отдаётся тем же index.html: так же отвечает и сервер (fallback на index.html).
    if (/^\/(compendium|class|race|background)-editor|^\/compendium$|^\/login$/.test(url.pathname))
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8') });
    if (url.pathname === '/api/auth/me') return auth ? json({ id: 1, name: 'Мастер', email: 'gm@test', is_root: true }) : json({ error: 'нужен вход' }, 401);
    if (url.pathname === '/api/auth/settings') return json({ allow_registration: true, password_min_length: 8 });
    if (url.pathname === '/api/packs') return json([{ id: 'p-1', name: 'Домашние' }]);
    // Редактору расы нужен каталог рас — записи в «сыром» виде.
    if (url.pathname === '/api/compendium' && url.searchParams.get('category') === 'race') return json(url.searchParams.get('raw') ? [ENTRIES['r-1']] : [ENTRIES['r-1']].map(e => ({ ...e, data: undefined })));
    // Список справочника: карточка класса, из которой открывается редактор.
    if (url.pathname === '/api/compendium' && method === 'GET' && url.searchParams.get('limit')) return json([ENTRIES['c-1']]);
    if (url.pathname === '/api/compendium/r-1') return json(ENTRIES['r-1']);
    if (url.pathname === '/api/compendium/c-1') return json(ENTRIES['c-1']);
    if (url.pathname === '/api/compendium' && method === 'POST') return json({ id: 'new-1', category: 'class', name: body?.name || '', pack_id: body?.pack_id ?? null, campaign_id: body?.campaign_id ?? null, data: body?.data || {} });
    if (url.pathname.startsWith('/api/compendium/')) return json({ ok: true });
    return json({});
  });

  // 1. Из справочника: «Редактировать» в карточке ведёт на страницу редактора, а не в модалку.
  await page.goto('https://editor.test/compendium');
  await page.locator('.comp-list .comp-entry').first().click();
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.waitForFunction(() => location.pathname === '/class-editor/c-1');
  await page.waitForSelector('.editor-page .ced-nav-btn');
  assert.equal(await page.locator('.modal').count(), 0, 'модалка не открывается — правим на странице');
  const kinds = await page.evaluate(() => Object.keys(window.EditorPage.KINDS));
  assert.deepEqual(JSON.parse(JSON.stringify(kinds)), ['class', 'race'], 'страницы есть у класса и расы; предыстория остаётся модалкой справочника');

  // 2. Правка существующей записи: страница со своим адресом, разделы и сохранение в запись.
  await page.goto('https://editor.test/class-editor/c-1');
  await page.waitForSelector('.editor-page .ced-nav-btn');
  assert.equal((await page.locator('.editor-page h1').first().innerText()).trim(), 'Класс: Варвар', 'заголовок страницы');
  assert.equal(await page.locator('.editor-page .ced-nav-btn').count(), 7, 'все разделы редактора класса');
  assert.ok((await page.locator('.editor-page .ced-content').innerText()).includes('Кость хитов'), 'первый раздел открыт');

  await page.locator('.editor-page .ced-nav-btn', { hasText: 'Уровни 1–20' }).click();
  const rows = page.locator('.editor-page .ced-levels .ced-levels-row');
  assert.equal(await rows.count(), 20, 'таблица развития: уровни 1–20');
  assert.equal((await rows.first().locator('.ced-levels-lv').innerText()).trim(), '1', 'первая строка — 1 уровень');
  assert.equal((await rows.last().locator('.ced-levels-lv').innerText()).trim(), '20', 'последняя строка — 20 уровень');
  assert.equal(await rows.nth(4).locator('input[type="number"]').first().inputValue(), '3', 'бонус мастерства 5 уровня');
  const feats = rows.filter({ has: page.locator('.ced-feat-btn') });
  assert.equal(await feats.count(), 20, 'у каждого уровня есть кнопка умений');
  assert.ok(/умени/.test(await rows.nth(2).locator('.ced-feat-btn').innerText()), 'умения уровня на месте');

  await page.locator('.editor-page .ced-nav-btn', { hasText: 'Общее' }).click();  // назад к общим полям
  const name = page.locator('.editor-page input[placeholder="Волшебник"]');
  await name.fill('Варвар Севера');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.editor-page .ed-head span')].some(s => s.textContent.trim() === 'сохранено'));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'сохранение ушло в справочник');
  assert.equal(patch.url, '/api/compendium/c-1');
  assert.equal(patch.body.category, 'class');
  assert.equal(patch.body.name, 'Варвар Севера');
  assert.equal(patch.body.data.hit_die, 'd12', 'данные записи целиком');
  assert.ok(patch.body.data.mechanics.graph.nodes.some(n => n.type === 'rule.class_progression'), 'таблица развития — в узле графа');
  assert.equal((await page.locator('.editor-page h1').first().innerText()).trim(), 'Класс: Варвар', 'заголовок не переписывается до перезагрузки');

  // 3. Новая запись: место хранения из адреса, POST и появление своего адреса.
  await page.goto('https://editor.test/class-editor?pack=p-1');
  await page.waitForSelector('.editor-page select[aria-label="Куда сохранить запись"]');
  const dest = page.locator('.editor-page select[aria-label="Куда сохранить запись"]');
  assert.equal(await dest.inputValue(), 'pack:p-1', 'набор из адреса страницы выбран');
  await page.locator('.editor-page input[placeholder="Волшебник"]').fill('Мой класс');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => location.pathname === '/class-editor/new-1');
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'новая запись создана');
  assert.equal(post.url, '/api/compendium');
  assert.equal(post.body.category, 'class');
  assert.equal(post.body.pack_id, 'p-1', 'сохранено в набор из адреса');
  assert.equal(post.body.campaign_id, null);
  assert.equal(await page.locator('.editor-page select[aria-label="Куда сохранить запись"]').count(), 0, 'после создания место хранения больше не спрашивают');
  assert.equal(await page.locator('.editor-page input[placeholder="Волшебник"]').inputValue(), 'Мой класс', 'правки остались на месте');

  // 4. Раса: своя страница, каталог рас приходит сырым, сохранение — в запись расы.
  await page.goto('https://editor.test/race-editor/r-1');
  await page.waitForSelector('.editor-page .ced-nav-btn');
  assert.equal((await page.locator('.editor-page h1').first().innerText()).trim(), 'Раса: Высший эльф', 'заголовок страницы расы');
  const raceNav = await page.locator('.editor-page .ced-nav-btn').allInnerTexts();
  assert.equal(raceNav.length, 8, 'все разделы редактора расы');
  assert.ok(raceNav.includes('Заклинания'), 'раздел расовых заклинаний на месте');
  await page.locator('.editor-page .ced-nav-btn', { hasText: 'Черты' }).click();
  const traits = await page.locator('.editor-page .ced-content input[placeholder="Название черты"]').evaluateAll(is => is.map(i => i.value));
  assert.deepEqual(traits, ['Эльфийская боевая подготовка', 'Заговор высшего эльфа', 'Дополнительный язык'], 'черты расы на месте');
  const traitTexts = await page.locator('.editor-page .ced-content textarea').evaluateAll(ts => ts.map(t => t.value));
  assert.ok(traitTexts.some(t => t.includes('один заговор на выбор')), 'тексты черт на месте');
  await page.locator('.editor-page .ced-nav-btn', { hasText: 'Общее' }).click();
  await page.locator('.editor-page input[placeholder="Дварф"]').fill('Высший эльф Подлунья');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.editor-page .ed-head span')].some(s => s.textContent.trim() === 'сохранено'));
  const racePatch = calls.filter(c => c.method === 'PATCH').pop();
  assert.equal(racePatch.url, '/api/compendium/r-1', 'правка расы ушла в запись');
  assert.equal(racePatch.body.category, 'race');
  assert.equal(racePatch.body.name, 'Высший эльф Подлунья');

  // 5. Без входа страница редактора перебрасывает на вход и помнит, куда вернуться.
  auth = false;
  await page.goto('https://editor.test/class-editor/c-1?pack=p-1');
  await page.waitForFunction(() => location.pathname === '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/class-editor/c-1?pack=p-1', 'адрес возврата сохранён');

  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  await page.close();
}

(async () => {
  const browser = await chromium.launch(await browserLaunchOptions());
  try { await scenario(browser); console.log('editor-page.browser: страницы редакторов класса и расы — PASS'); }
  finally { await browser.close(); }
})().catch(e => { console.error('editor-page.browser: FAIL', (e && e.stack) || e); process.exit(1); });
