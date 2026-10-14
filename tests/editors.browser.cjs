// Браузерный тест конструкторов класса и расы в окне редактора записи (настоящий Chromium):
// 1) в карточке класса и расы кнопка называет свой конструктор («Редактор класса»,
//    «Редактор расы») и открывает его прямо в окне редактора записи — без отдельных
//    страниц и переходов;
// 2) разделы рисуются одним устройством (навигация .ced-nav-btn, чипы, счётчики,
//    карточки .ced-block с меткой) — редактор расы устроен как редактор класса;
// 3) сохранение из окна уходит в саму запись справочника, «+ Своя запись» открывает тот же конструктор.
// Сервер не нужен: страницы и скрипты берутся из static/, API подменяется маршрутами.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const loadSrd = require('./fixtures/srd.cjs');
const browserLaunchOptions = require('./browser-launch.cjs');

const SEED = loadSrd('data_seed/srd_2014.json');
const record = (slug, id) => { const e = SEED.find(x => x.slug === slug); return { id, category: e.category, name: e.name, source: 'SRD 2014', pack_id: null, campaign_id: null, data: JSON.parse(JSON.stringify(e.data)) }; };
const CLASS = record('srd14-barbarian', 'c-1'), RACE = record('srd14-high-elf', 'r-1');
// Черты — отдельный элемент справочника: записи берём из сборки tools/srd/build_feats.py.
const FEATS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data_seed', 'feats_2014.json'), 'utf8'))
  .filter(f => ['srd14-feat-elf-weapon-training', 'srd14-feat-fey-ancestry', 'srd14-feat-darkvision', 'srd14-feat-rage',
    'srd14-feat-unarmored-defense', 'srd14-feat-reckless-attack', 'srd14-feat-frenzy'].includes(f.slug))
  .map((f, i) => ({ id: `f-${i}`, category: 'feat', name: f.name, source: 'SRD 2014', pack_id: null, campaign_id: null, slug: f.slug, data: f.data }));

// Класс: кнопка своего конструктора в карточке, разделы, сохранение и создание новой записи.
async function scenarioClass(browser) {
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
    if (url.pathname === '/api/compendium/c-1') return json(CLASS);
    if (url.pathname === '/api/compendium/r-1') return json(RACE);
    if (url.pathname === '/api/compendium' && url.searchParams.get('category') === 'feat') return json(FEATS);
    if (url.pathname === '/api/compendium') return json(url.searchParams.get('raw') ? [CLASS, RACE] : [CLASS, RACE]);
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

  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join(' ')}`);
  await page.close();
}

// Раса: тот же вход и то же устройство разделов, что у класса, — навигация, чипы, счётчики,
// карточки .ced-block с меткой; правка уходит в запись расы.
async function scenarioRace(browser) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.addInitScript(() => localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true })));
  await page.route('https://editors.test/**', async route => {
    const url = new URL(route.request().url());
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.startsWith('/static/')) {
      const file = path.join(process.cwd(), url.pathname);
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript' });
    }
    const method = route.request().method(), body = (() => { try { return route.request().postDataJSON(); } catch { return null; } })();
    if (method !== 'GET') calls.push({ method, url: url.pathname, body });
    if (url.pathname === '/compendium') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8') });
    if (url.pathname === '/api/auth/me') return json({ id: 1, name: 'Мастер', email: 'gm@test', is_root: true });
    if (url.pathname === '/api/auth/settings') return json({ allow_registration: true, password_min_length: 8 });
    if (url.pathname === '/api/packs') return json([]);
    if (url.pathname === '/api/compendium/r-1') return json(RACE);
    if (url.pathname === '/api/compendium' && url.searchParams.get('category') === 'feat') return json(FEATS);
    if (url.pathname === '/api/compendium') return json([CLASS, RACE]);
    return json([]);
  });

  await page.goto('https://editors.test/compendium');
  await page.locator('.comp-entry', { hasText: 'Высший эльф' }).click();

  // 1. «Редактор расы» в карточке: конструктор открывается окном там же, где правится запись.
  await page.getByRole('button', { name: 'Редактор расы', exact: true }).click();
  const modal = page.locator('.modal.wide');
  await modal.waitFor();
  assert.equal(page.url(), 'https://editors.test/compendium', 'страница не меняется');
  assert.ok((await modal.locator('h2').innerText()).includes('Раса: Высший эльф'), 'заголовок записи расы');
  const nav = JSON.parse(JSON.stringify(await modal.locator('.ced-nav-btn').allInnerTexts()));
  assert.deepEqual(nav, ['Общее', 'Характеристики', 'Навыки', 'Языки', 'Владения', 'Черты', 'Заклинания', 'Подрасы'],
    'разделы расы идут как у класса: общее, характеристики, навыки, языки, …');

  // 2. Навыки — то же устройство, что в классе: счётчик, чипы, строка добавления, зона перетаскивания.
  await modal.locator('.ced-nav-btn', { hasText: 'Навыки' }).click();
  assert.deepEqual(JSON.parse(JSON.stringify(await modal.locator('.ced-content .ced-sub').allInnerTexts())),
    ['Владение навыками', 'Выбор игрока'], 'подразделы навыков');
  assert.equal(await modal.locator('.ced-content .ced-chips').count(), 2, 'списки навыков целиком из справочника');
  assert.equal(await modal.locator('.ced-content .ced-drop').count(), 2, 'навык можно перетащить');
  assert.ok((await modal.locator('.ced-content .ced-counter').innerText()).includes('пусто — любой навык'), 'счётчик выбора');
  assert.equal(await modal.locator('.ced-content select option', { hasText: '+ добавить навык…' }).count(), 2, 'навыки добавляются из справочника');

  // 3. Языки: фиксированные и «по выбору» — как у класса.
  await modal.locator('.ced-nav-btn', { hasText: 'Языки' }).click();
  assert.ok((await modal.locator('.ced-content').innerText()).includes('Дополнительных языков по выбору'), 'условные языки задаются числом');
  assert.ok((await modal.locator('.ced-content .ced-counter').innerText()).includes('фиксированных'), 'счётчик фиксированных языков');

  // 4. Черты — карточки с меткой, как подклассы и снаряжение у класса.
  await modal.locator('.ced-nav-btn', { hasText: 'Черты' }).click();
  assert.equal(await modal.locator('.ced-content .ced-block').count(), 3, 'каждая черта — карточка');
  assert.deepEqual(JSON.parse(JSON.stringify(await modal.locator('.ced-content .ced-block-head .badge').allInnerTexts())),
    ['черта', 'черта', 'черта'], 'метка в шапке карточки');
  assert.equal(await modal.locator('.ced-content .ced-block-head input').first().inputValue(), 'Эльфийская боевая подготовка', 'название черты в шапке');

  // 5. Владения: вид владений добавляется кнопкой и сразу становится карточкой.
  await modal.locator('.ced-nav-btn', { hasText: 'Владения' }).click();
  await modal.getByRole('button', { name: '+ Доспехи', exact: true }).click();
  assert.equal(await modal.locator('.ced-content .ced-block').count(), 1, 'вид владений — карточка');
  assert.equal((await modal.locator('.ced-content .ced-block-head .badge').innerText()).trim(), 'владения', 'метка вида владений');

  // 6. Заклинания: два блока с метками и поле заклинательной характеристики.
  await modal.locator('.ced-nav-btn', { hasText: 'Заклинания' }).click();
  assert.deepEqual(JSON.parse(JSON.stringify(await modal.locator('.ced-content .ced-block-head .badge').allInnerTexts())),
    ['известны сразу', 'выбор игрока'], 'заклинания сгруппированы блоками');
  assert.ok((await modal.locator('.ced-content').innerText()).includes('Заклинательная характеристика'), 'характеристика заклинаний — обычным полем');
  assert.equal(await modal.locator('.ced-content .ced-eq-option').count(), 1, 'выбор заговора «Заговор высшего эльфа»');

  // 7. Сохранение идёт в саму запись расы.
  await modal.locator('.ced-nav-btn', { hasText: 'Общее' }).click();
  await modal.locator('input[placeholder="Дварф"]').fill('Высший эльф Подлунья');
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.modal.wide'));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'сохранение ушло в справочник');
  assert.equal(patch.url, '/api/compendium/r-1', 'правится та же запись расы');
  assert.equal(patch.body.category, 'race');
  assert.equal(patch.body.name, 'Высший эльф Подлунья');
  assert.equal(patch.body.data.traits.length, 3, 'черты записи на месте');
  assert.ok(patch.body.data.mechanics.graph.nodes.some(n => n.type === 'rule.ability_bonus'), 'бонусы характеристик — в узлах графа');

  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join(' ')}`);
  await page.close();
}


// Черты — отдельный элемент справочника: рубрика «Черты» показывает записи, а редактор расы
// ссылается на них списком (и принимает перетаскивание).
async function scenarioFeatsRace(browser) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.addInitScript(() => localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true })));
  await page.route('https://feats.test/**', route => {
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
    if (url.pathname === '/api/compendium/r-1') return json(RACE);
    if (url.pathname === '/api/compendium' && url.searchParams.get('category') === 'feat') return json(FEATS);
    if (url.pathname === '/api/compendium') return json([RACE, ...FEATS]);
    if (url.pathname === '/compendium') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8') });
    return json([]);
  });

  await page.goto('https://feats.test/compendium');
  await page.locator('.comp-list .comp-entry').first().waitFor();

  // 1. В справочнике появилась своя рубрика «Черты» с записями черт рас и умений классов.
  const rubric = page.locator('.comp-nav-item', { hasText: 'Черты' });
  assert.equal(await rubric.count(), 1, 'рубрика «Черты» в навигации');
  assert.equal((await rubric.innerText()).trim().split(/\s+/).at(-1), String(FEATS.length), 'в рубрике — записи черт');
  await rubric.click();
  assert.equal(await page.locator('.comp-list .comp-entry').count(), FEATS.length, 'список записей рубрики');
  await page.locator('.comp-list .comp-entry', { hasText: 'Наследие фей' }).click();
  const card = await page.locator('.comp-detail').innerText();
  assert.ok(card.includes('Черта расы'), 'карточка называет вид черты');
  assert.ok(card.includes('srd14-feat-fey-ancestry'), 'карточка показывает ключ записи, по которому ссылаются редакторы');

  // 2. Редактор расы: черты — ссылки на записи справочника.
  await page.locator('.comp-nav-item', { hasText: 'Все записи' }).click();
  await page.locator('.comp-list .comp-entry', { hasText: 'Высший эльф' }).click();
  await page.getByRole('button', { name: 'Редактор расы', exact: true }).click();
  const modal = page.locator('.modal.wide');
  await modal.waitFor();
  await modal.locator('.ced-nav-btn', { hasText: 'Черты' }).click();
  const rows = modal.locator('.ced-feat-row');
  assert.equal(await rows.count(), 3, 'у каждой черты строка ссылки');
  assert.equal(await rows.first().locator('select').inputValue(), 'srd14-feat-elf-weapon-training', 'черта SRD уже ссылается на запись');
  assert.ok((await rows.first().innerText()).includes('ссылка: srd14-feat-elf-weapon-training'), 'ссылка подписана');
  assert.ok((await modal.locator('.ced-counter').first().innerText()).includes('3 из 3 со ссылкой'), 'счётчик ссылок');

  // 3. Выбор другой записи подтягивает название и текст.
  await rows.first().locator('select').selectOption('srd14-feat-fey-ancestry');
  assert.equal(await modal.locator('.ced-block-head input').first().inputValue(), 'Наследие фей', 'название из записи');
  assert.ok((await modal.locator('.ced-block textarea').first().inputValue()).includes('очарования'), 'текст из записи');

  // 4. Перетаскивание записи черты в раздел добавляет черту со ссылкой.
  await page.evaluate(() => {
    const zone = document.querySelector('.modal.wide .ced-drop');
    const entry = { category: 'feat', slug: 'srd14-feat-darkvision', name: 'Тёмное зрение', data: { desc: 'Текст из справочника.' } };
    const dt = new DataTransfer();
    dt.setData('application/x-feat', JSON.stringify({ entry, slug: entry.slug }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  assert.equal(await modal.locator('.ced-block').count(), 4, 'перетащенная черта стала карточкой');

  // 5. Сохранение идёт в запись расы вместе со ссылками.
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.modal.wide'));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'сохранение ушло в справочник');
  assert.equal(patch.url, '/api/compendium/r-1');
  assert.deepEqual(patch.body.data.traits.map(t => t.feat),
    ['srd14-feat-fey-ancestry', 'srd14-feat-high-elf-cantrip', 'srd14-feat-extra-language', 'srd14-feat-darkvision'], 'ссылки в записи расы');
  assert.equal(patch.body.data.traits[0].name, 'Наследие фей', 'название — из записи справочника');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join(' ')}`);
  await page.close();
}

// Редактор класса: умения уровней и подклассов ссылаются на записи «Черт».
async function scenarioFeatsClass(browser) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.addInitScript(() => localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true })));
  await page.route('https://feats-class.test/**', route => {
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
    if (url.pathname === '/api/compendium/c-1') return json(CLASS);
    if (url.pathname === '/api/compendium' && url.searchParams.get('category') === 'feat') return json(FEATS);
    if (url.pathname === '/api/compendium') return json([CLASS, ...FEATS]);
    if (url.pathname === '/compendium') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(process.cwd(), 'static/index.html'), 'utf8') });
    return json([]);
  });

  await page.goto('https://feats-class.test/compendium');
  await page.locator('.comp-list .comp-entry').first().waitFor();
  await page.locator('.comp-list .comp-entry', { hasText: 'Варвар' }).click();
  await page.getByRole('button', { name: 'Редактор класса', exact: true }).click();
  const modal = page.locator('.modal.wide');
  await modal.waitFor();

  // 1. Умения 1 уровня ссылаются на записи справочника: у «Ярости» — своя запись.
  await modal.locator('.ced-nav-btn', { hasText: 'Уровни 1–20' }).click();
  await modal.locator('.ced-feat-btn').first().click();
  const feature = modal.locator('.ced-feature').first();
  const pick = feature.locator('.ced-feat-row select');
  assert.equal(await pick.inputValue(), 'srd14-feat-rage', 'умение SRD уже ссылается на запись');
  assert.ok((await feature.locator('.ced-feat-row').innerText()).includes('ссылка: srd14-feat-rage'), 'ссылка подписана');

  // 2. Выбор записи подтягивает название и текст, в списке — черты своего вида.
  const labels = JSON.parse(JSON.stringify(await pick.locator('option').allInnerTexts()));
  assert.ok(labels.some(l => l.startsWith('Безрассудная атака — Варвар')), 'в списке — умения класса с владельцем');
  assert.ok(!labels.some(l => l.includes('Тёмное зрение')), 'черты рас в списке умений класса нет');
  await pick.selectOption('srd14-feat-reckless-attack');
  assert.equal(await feature.locator('input').first().inputValue(), 'Безрассудная атака', 'название из записи');
  assert.ok((await feature.locator('textarea').inputValue()).includes('отчаянной свирепостью'), 'текст из записи');

  // 3. Умение подкласса: та же строка ссылки.
  await modal.locator('.ced-nav-btn', { hasText: 'Подклассы' }).click();
  const subFeature = modal.locator('.ced-feature').first();
  const subPick = subFeature.locator('.ced-feat-row select');
  await subPick.selectOption('srd14-feat-frenzy');
  assert.equal(await subFeature.locator('input').nth(1).inputValue(), 'Бешенство', 'умение подкласса из записи');

  // 4. Сохранение: ссылки уходят и в поля данных, и в таблицу узла.
  await modal.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.modal.wide'));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch && patch.url === '/api/compendium/c-1', 'правится та же запись класса');
  assert.equal(patch.body.data.feature_feats['1']['Безрассудная атака'], 'srd14-feat-reckless-attack', 'ссылка умения 1 уровня');
  assert.equal(patch.body.data.subclasses[0].feature_feats['3']['Бешенство'], 'srd14-feat-frenzy', 'ссылка умения подкласса');
  const table = patch.body.data.mechanics.graph.nodes.find(n => n.type === 'rule.class_features').params.table.levels['1'];
  assert.equal(table[0].feat, 'srd14-feat-reckless-attack', 'ссылка — и в таблице умений узла');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join(' ')}`);
  await page.close();
}

(async () => {
  // Отдельный браузер на сценарий: сборка @sparticuz/chromium работает в одном процессе.
  for (const [what, scenario] of [['конструктор класса в окне редактора записи', scenarioClass],
    ['конструктор расы в окне редактора записи', scenarioRace],
    ['черты — ссылки в редакторе расы', scenarioFeatsRace], ['черты — ссылки в редакторе класса', scenarioFeatsClass]]) {
    const browser = await chromium.launch(await browserLaunchOptions());
    try { await scenario(browser); console.log(`editors.browser: ${what} — PASS`); }
    finally { await browser.close(); }
  }
})().catch(e => { console.error('editors.browser: FAIL', (e && e.stack) || e); process.exit(1); });
