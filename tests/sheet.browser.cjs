// Браузерный тест листа: новая шапка (без темы/редакции/кнопок загрузки), меню портрета,
// нередактируемые класс/подкласс/предыстория, кастомный дропдаун мировоззрения и
// отсутствие «залипших» поповеров над инвентарём.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const browserLaunchOptions = require('./browser-launch.cjs');

const HTML = fs.readFileSync('static/sheet.html', 'utf8');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==';

const character = () => ({
  revision: 1, id: 'sheetid', campaign_id: null, owner_id: 'u1', name: 'Ария',
  portrait_asset_id: 'avatar-1', updated_at: '',
  sheet: {
    _revision: 1, name: 'Ария', edition: '2014', level: 3, xp: 0,
    race: 'Эльф', class: 'Волшебник', subclass: 'Школа Воплощения', background: 'Мудрец', alignment: '',
    abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 10, cha: 10 }, proficiency_bonus: 2,
    hp: { max: 20, current: 20, temp: 0, hit_dice: '3d6' }, ac: 12, speed: 30,
    inventory: [{
      uid: 'it-1', name: 'Кинжал', type: 'weapon', qty: 1, equipped: false, weight: 1,
      rarity: 'Обычный', desc: 'Лёгкое оружие.', actions: [],
    }],
    features: [], conditions: [], attacks: [], skills: [], expertise: [], saving_throws: [],
    notes_by: {}, currency: {}, traits: {},
    spells: { ability: 'int', slots: {}, known: [] },
  },
});

(async () => {
  const browser = await chromium.launch(await browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], patches = [];
    let state = character();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true }));
        localStorage.setItem('sheet_tab_sheetid', 'inv');
      } catch { }
    });
    const json = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    await page.route('https://sheet.test/**', route => {
      const url = new URL(route.request().url()), method = route.request().method();
      if (url.pathname.startsWith('/static/')) {
        const file = path.join(process.cwd(), url.pathname);
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' });
      }
      if (url.pathname.startsWith('/sheet/')) return route.fulfill({ contentType: 'text/html', body: HTML });
      if (url.pathname === '/api/auth/me') return json(route, { id: 'u1', name: 'Игрок' });
      if (url.pathname === '/api/characters/sheetid' && method === 'GET') return json(route, state);
      if (url.pathname === '/api/characters/sheetid' && method === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        patches.push(body);
        if (Object.prototype.hasOwnProperty.call(body, 'portrait_asset_id')) state.portrait_asset_id = body.portrait_asset_id;
        if (body.sheet) { state.sheet = body.sheet; state.revision += 1; state.sheet._revision = state.revision; }
        return json(route, state);
      }
      if (url.pathname === '/api/assets') return json(route, [
        { id: 'avatar-1', kind: 'portrait', name: 'Ария' },
        { id: 'avatar-2', kind: 'portrait', name: 'Ария в плаще' },
      ]);
      if (url.pathname.startsWith('/api/assets/')) return json(route, { data_b64: PNG, encoding: 'identity', mime: 'image/png' });
      return json(route, []);
    });
    await page.goto('https://sheet.test/sheet/sheetid');
    await page.locator('.sheet-topbar').waitFor();
    await page.locator('.mcard', { hasText: 'Кинжал' }).waitFor();

    // 1. Шапка: имя/справочник/переменные есть, темы, редакции и кнопок загрузки нет.
    const topbar = page.locator('.sheet-topbar');
    for (const label of ['Справочник', 'Переменные…', 'Обновить']) {
      assert.equal(await topbar.getByRole('button', { name: label, exact: true }).count(), 1, `кнопка «${label}» в шапке`);
    }
    assert.equal(await topbar.locator('select').count(), 0, 'в шапке нет селектора редакции');
    assert.equal(await topbar.locator('.theme-btn').count(), 0, 'в шапке нет кнопки темы');
    for (const text of ['Загрузить', 'Из библиотеки', 'Убрать']) {
      assert.equal(await topbar.getByText(text, { exact: true }).count(), 0, `«${text}» больше не в шапке`);
    }

    // 2. Тема и редакция — в футере; редакция сохраняется как раньше.
    const foot = page.locator('.sheet-foot');
    assert.equal(await foot.locator('.sheet-theme-btn').count(), 1, 'тема в футере');
    assert.equal(await foot.locator('select.sheet-foot-select').count(), 1, 'редакция в футере');
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    await foot.locator('.sheet-theme-btn').click();
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), theme, 'тема переключается');
    const theme2 = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.locator('.sheet-foot .sheet-theme-btn').click();
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), theme2, 'тема переключается обратно');
    const editionPatch = page.waitForRequest(request => request.method() === 'PATCH' && request.postDataJSON()?.sheet?.edition === '2024');
    await page.locator('.sheet-foot-select').selectOption('2024');
    await editionPatch;
    await page.locator('.sheet-foot-select').waitFor();

    // 3. Класс, подкласс и предыстория — только текст снимка, без inline-инпута и клика.
    for (const [label, value] of [['Класс', 'Волшебник'], ['Подкласс', 'Школа Воплощения'], ['Предыстория', 'Мудрец']]) {
      const block = page.locator(`.mod-block[aria-label="Блок: ${label}"]`);
      assert.equal((await block.locator('.mod-block-name').innerText()).trim(), value, `${label}: значение`);
      assert.equal(await block.locator('input, select, textarea').count(), 0, `${label}: нет инлайн-редактора`);
      assert.equal(await block.locator('.editable').count(), 0, `${label}: не выглядит редактируемым`);
    }
    await page.locator('.mod-block[aria-label="Блок: Класс"] .mod-block-name').click();
    assert.equal(await page.locator('.mod-block-input').count(), 0, 'клик по классу не открывает инпут');
    assert.equal(await page.locator('.portrait-menu').isVisible(), false, 'клик по классу не оставляет меню');
    assert.equal(await page.locator('.align-picker-list').isVisible(), false, 'клик по классу не оставляет дропдаун');

    // 4. Мировоззрение: кастомный дропдаун, клавиши ↑/↓ + Enter, Esc, скролл.
    const align = page.locator('.align-picker');
    const alignBtn = align.locator('.align-picker-btn');
    const alignList = align.locator('.align-picker-list');
    assert.equal((await align.locator('.align-picker-value').innerText()).trim(), 'Не указано', 'пустое значение подписано');
    assert.equal(await align.locator('select').count(), 0, 'нативного select нет');
    await alignBtn.click();
    await alignList.waitFor();
    assert.equal(await alignList.getByRole('option').count(), 11, 'все ALIGNMENTS + пустое');
    assert.equal(await alignList.getByRole('option', { name: 'Не указано', exact: true }).count(), 1);
    assert.equal(await alignBtn.getAttribute('aria-expanded'), 'true');
    await alignList.evaluate(el => { el.scrollTop = el.scrollHeight; });
    assert.equal(await alignList.isVisible(), true, 'скролл самого списка не закрывает его');
    await alignList.getByRole('option', { name: 'Не указано', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    const alignPatch = page.waitForRequest(request => request.method() === 'PATCH' && request.postDataJSON()?.sheet?.alignment === 'Законно-доброе');
    await page.keyboard.press('Enter');
    await alignPatch;
    await page.waitForFunction(() => document.querySelector('.align-picker-value')?.textContent.trim() === 'Законно-доброе');
    await alignBtn.click();
    await alignList.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await alignList.isVisible(), false, 'Esc закрывает дропдаун');
    assert.equal(await alignBtn.getAttribute('aria-expanded'), 'false');
    await alignBtn.click();
    await alignList.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    assert.equal(await alignList.isVisible(), false, 'скролл закрывает дропдаун');
    assert.equal(await alignList.evaluate(el => getComputedStyle(el).display), 'none', 'закрытый список не слой');

    // 5. Портрет: меню открывается кликом, пункты на месте, выбор из библиотеки и удаление.
    const portrait = page.locator('.portrait');
    const portraitMenu = page.locator('.portrait-menu');
    await portrait.click();
    await portraitMenu.waitFor();
    assert.equal(await portrait.getAttribute('aria-expanded'), 'true');
    for (const label of ['Загрузить файл', 'Из библиотеки', 'Убрать', 'Выбрать токен…']) {
      assert.equal(await portraitMenu.getByRole('menuitem', { name: label, exact: true }).count(), 1, `пункт «${label}»`);
    }
    await page.keyboard.press('Escape');
    assert.equal(await portraitMenu.isVisible(), false, 'Esc закрывает меню портрета');
    assert.equal(await portraitMenu.evaluate(el => getComputedStyle(el).display), 'none', 'закрытое меню не слой');

    await portrait.click();
    await portraitMenu.waitFor();
    await portraitMenu.getByRole('menuitem', { name: 'Из библиотеки', exact: true }).click();
    const library = page.locator('.modal', { hasText: 'Портрет из библиотеки' });
    await library.waitFor();
    await library.locator('.portrait-library .asset', { hasText: 'Ария в плаще' }).click();
    const portraitPatch = page.waitForRequest(request => request.method() === 'PATCH' && request.postDataJSON()?.portrait_asset_id === 'avatar-2');
    await library.getByRole('button', { name: 'Выбрать', exact: true }).click();
    await portraitPatch;
    await page.waitForFunction(() => document.querySelector('.portrait img') !== null);

    await page.locator('.portrait').click();
    await page.locator('.portrait-menu').waitFor();
    const removePatch = page.waitForRequest(request => request.method() === 'PATCH' && request.postDataJSON()?.portrait_asset_id === null);
    await page.locator('.portrait-menu').getByRole('menuitem', { name: 'Убрать', exact: true }).click();
    await removePatch;
    await page.waitForFunction(() => document.querySelector('.portrait img') === null);
    assert.equal(await page.locator('.portrait-menu').isVisible(), false, 'после удаления меню закрыто');

    // 6. Одновременно открыт только один поповер; клик по предмету закрывает его и выбирает предмет.
    await page.locator('.portrait').click();
    await page.locator('.portrait-menu').waitFor();
    await alignBtn.click();
    await alignList.waitFor();
    assert.equal(await page.locator('.portrait-menu').isVisible(), false, 'дропдаун закрыл меню портрета');
    assert.equal(await page.locator('.align-picker-list').isVisible(), true, 'дропдаун открыт один');
    assert.equal(await page.locator('.portrait-menu').evaluate(el => getComputedStyle(el).display), 'none');

    const card = page.locator('.mcard', { hasText: 'Кинжал' });
    assert.equal(await card.locator('.mcard-body').count(), 0, 'карточка закрыта до клика');
    // Use the title as the disclosure target; fixed coordinates can land on nested controls
    // (such as quantity), which deliberately stop propagation to the card header.
    await card.locator('.mcard-name').click();
    await page.waitForFunction(() => document.querySelectorAll('.mcard.open').length === 1);
    assert.equal(await page.locator('.align-picker-list').isVisible(), false, 'клик по предмету закрыл дропдаун');
    assert.equal(await card.locator('.mcard-body').count(), 1, 'предмет открылся, клик не потерялся');
    assert.equal(await page.locator('.portrait-menu').isVisible(), false, 'чужих панелей поверх нет');

    assert.deepEqual(errors, []);
    console.log('PASS sheet browser: шапка без темы/редакции/загрузки, меню портрета, нередактируемые класс/подкласс/предыстория, кастомный дропдаун мировоззрения, клик по инвентарю не перехвачен');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
