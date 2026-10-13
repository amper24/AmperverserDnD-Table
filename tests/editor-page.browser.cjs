// Браузерный тест отдельной страницы редактора (настоящий Chromium): маршрут
// /class-editor/<id> из app.js, разделы редактора класса, сохранение в справочник
// и создание новой записи с выбором места хранения.
// Сервер не нужен: index.html и скрипты берутся из static/ (адрес /class-editor/... отдаёт
// тот же index.html, что и боевой fallback сервера), API подменяется маршрутами.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const loadSrd = require('./fixtures/srd.cjs');
const browserLaunchOptions = require('./browser-launch.cjs');

const BARBARIAN = loadSrd('data_seed/srd_2014.json').find(e => e.slug === 'srd14-barbarian');
const record = () => ({ id: 'c-1', category: 'class', name: BARBARIAN.name, source: 'SRD 2014', pack_id: null, campaign_id: null, data: JSON.parse(JSON.stringify(BARBARIAN.data)) });

async function scenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
  const errors = [], calls = [];
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
    if (url.pathname === '/class-editor' || url.pathname.startsWith('/class-editor/'))
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8') });
    if (url.pathname === '/api/auth/me') return json({ id: 1, name: 'Мастер', email: 'gm@test', is_root: true });
    if (url.pathname === '/api/auth/settings') return json({ allow_registration: true, password_min_length: 8 });
    if (url.pathname === '/api/packs') return json([{ id: 'p-1', name: 'Домашние' }]);
    if (url.pathname === '/api/compendium/c-1') return json(record());
    if (url.pathname === '/api/compendium' && method === 'POST') return json({ id: 'new-1', category: 'class', name: body?.name || '', pack_id: body?.pack_id ?? null, campaign_id: body?.campaign_id ?? null, data: body?.data || {} });
    if (url.pathname.startsWith('/api/compendium/')) return json({ ok: true });
    return json({});
  });

  // 1. Правка существующей записи: страница со своим адресом, разделы и сохранение в запись.
  await page.goto('https://editor.test/class-editor/c-1');
  await page.waitForSelector('.editor-page .ced-nav-btn');
  assert.equal((await page.locator('.editor-page h1').first().innerText()).trim(), 'Класс: Варвар', 'заголовок страницы');
  assert.equal(await page.locator('.editor-page .ced-nav-btn').count(), 7, 'все разделы редактора класса');
  assert.ok((await page.locator('.editor-page .ced-content').innerText()).includes('Кость хитов'), 'первый раздел открыт');

  await page.locator('.editor-page .ced-nav-btn', { hasText: 'Уровни 1–20' }).click();
  const levels = await page.locator('.editor-page .ced-content').innerText();
  assert.ok(levels.includes('Бонус мастерства'), 'таблица развития на месте');
  assert.ok(levels.includes('20'), 'уровни 1–20');

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

  // 2. Новая запись: место хранения из адреса, POST и появление своего адреса.
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

  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  await page.close();
}

(async () => {
  const browser = await chromium.launch(await browserLaunchOptions());
  try { await scenario(browser); console.log('editor-page.browser: отдельная страница редактора класса — PASS'); }
  finally { await browser.close(); }
})().catch(e => { console.error('editor-page.browser: FAIL', (e && e.stack) || e); process.exit(1); });
