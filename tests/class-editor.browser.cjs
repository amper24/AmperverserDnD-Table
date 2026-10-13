// Браузерный тест места классового конструктора (настоящий Chromium): при редактировании
// класса из справочника конструктор открывается прямо в окне редактора записи — тем же
// кликом «Редактировать» в карточке, без отдельных страниц и переходов. Тут же проверяется
// сохранение результата в саму запись справочника.
// Сервер не нужен: страницы и скрипты берутся из static/, API подменяется маршрутами.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const loadSrd = require('./fixtures/srd.cjs');
const browserLaunchOptions = require('./browser-launch.cjs');

const BARBARIAN = loadSrd('data_seed/srd_2014.json').find(e => e.slug === 'srd14-barbarian');
const record = () => ({ id: 'c-1', category: 'class', name: BARBARIAN.name, source: 'SRD 2014', pack_id: null, campaign_id: null, data: JSON.parse(JSON.stringify(BARBARIAN.data)) });

async function scenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  // Согласие на cookie уже дано: баннер не перехватывает клики.
  await page.addInitScript(() => localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true })));
  await page.route('https://class-editor.test/**', async route => {
    const url = new URL(route.request().url());
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.startsWith('/static/')) {
      const file = path.join(process.cwd(), url.pathname);
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript' });
    }
    const method = route.request().method(), body = (() => { try { return route.request().postDataJSON(); } catch { return null; } })();
    if (method !== 'GET') calls.push({ method, url: url.pathname, body });
    if (url.pathname === '/api/auth/me') return json({ id: 1, name: 'Мастер', email: 'gm@test', is_root: true });
    if (url.pathname === '/api/auth/settings') return json({ allow_registration: true, password_min_length: 8 });
    if (url.pathname === '/api/packs') return json([]);
    if (url.pathname === '/api/compendium/c-1') return json(record());
    if (url.pathname === '/api/compendium') return json([record()]);
    if (url.pathname === '/compendium') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8') });
    return json([]);
  });

  await page.goto('https://class-editor.test/compendium');
  await page.locator('.comp-list .comp-entry').first().click();

  // 1. «Редактор класса» в карточке: конструктор открывается окном на той же странице.
  await page.getByRole('button', { name: 'Редактор класса', exact: true }).click();
  const modal = page.locator('.modal.wide');
  await modal.waitFor();
  assert.equal(page.url(), 'https://class-editor.test/compendium', 'страница не меняется — правим здесь же');
  assert.equal(await modal.locator('.class-editor').count(), 1, 'в окне — конструктор класса');
  const nav = await modal.locator('.ced-nav-btn').allInnerTexts();
  assert.equal(nav.length, 7, 'все разделы конструктора в окне');
  assert.deepEqual(JSON.parse(JSON.stringify(nav.slice(0, 3))), ['Общее', 'Уровни 1–20', 'Навыки'], 'разделы те же и в том же порядке');
  assert.ok((await modal.locator('.ced-content').innerText()).includes('Кость хитов'), 'первым открыт раздел «Общее»');

  // 2. Разделы конструктора работают в окне: таблица развития и умения по уровням.
  await modal.locator('.ced-nav-btn', { hasText: 'Уровни 1–20' }).click();
  const rows = modal.locator('.ced-levels .ced-levels-row');
  assert.equal(await rows.count(), 20, 'таблица развития: уровни 1–20');
  assert.equal(await rows.nth(4).locator('input[type="number"]').first().inputValue(), '3', 'бонус мастерства 5 уровня');
  assert.equal(await rows.filter({ has: page.locator('.ced-feat-btn') }).count(), 20, 'у каждого уровня кнопка умений');

  // 3. Сохранение из окна идёт в саму запись справочника.
  await modal.locator('.ced-nav-btn', { hasText: 'Общее' }).click();
  await modal.locator('input[placeholder="Волшебник"]').fill('Варвар Севера');
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.modal.wide'));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'сохранение ушло в справочник');
  assert.equal(patch.url, '/api/compendium/c-1', 'правится та же запись');
  assert.equal(patch.body.category, 'class');
  assert.equal(patch.body.name, 'Варвар Севера');
  assert.equal(patch.body.data.hit_die, 'd12', 'данные записи целиком');
  assert.ok(patch.body.data.mechanics.graph.nodes.some(n => n.type === 'rule.class_progression'), 'таблица развития — в узле графа');

  // 4. «+ Своя запись» для класса открывает тот же конструктор.
  calls.length = 0;
  await page.getByRole('button', { name: '+ Своя запись' }).click();
  const createModal = page.locator('.modal');
  await createModal.waitFor();
  await createModal.locator('select').first().selectOption('class');
  await createModal.getByRole('button', { name: 'Далее' }).click();
  await page.locator('.modal.wide .class-editor').waitFor();
  assert.equal(await page.locator('.modal.wide .class-editor').count(), 1, 'новая запись — тот же конструктор');
  assert.ok((await page.locator('.modal.wide h2').innerText()).includes('Новый класс'), 'заголовок новой записи');

  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  await page.close();
}

(async () => {
  const browser = await chromium.launch(await browserLaunchOptions());
  try { await scenario(browser); console.log('class-editor.browser: конструктор класса в окне редактора записи — PASS'); }
  finally { await browser.close(); }
})().catch(e => { console.error('class-editor.browser: FAIL', (e && e.stack) || e); process.exit(1); });
