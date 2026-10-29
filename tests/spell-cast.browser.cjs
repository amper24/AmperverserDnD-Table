// Браузерный тест выбора круга при сотворении: лист персонажа, узел «Расход ячейки»,
// окно круга, ритуал и показ остатка/концентрации. Сервер заменён маршрутом Playwright.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const browserLaunchOptions = require('./browser-launch.cjs');

const HTML = fs.readFileSync('static/sheet.html', 'utf8');

const graph = id => ({ version: 2, origin: 'test', graph: {
  nodes: [
    { id: `program-${id}`, type: 'action.program', params: { program_id: 'p1', name: 'Сотворить', trigger: 'use' }, position: { x: 40, y: 60 } },
    { id: `slot-${id}`, type: 'action.slot', params: { block_id: 'slot', level: 0, amount: 1 }, position: { x: 300, y: 60 } },
    { id: `end-${id}`, type: 'flow.end', params: {}, position: { x: 560, y: 60 } },
  ],
  links: [
    { from: { node: `program-${id}`, socket: 'exec' }, to: { node: `slot-${id}`, socket: 'exec' } },
    { from: { node: `slot-${id}`, socket: 'exec' }, to: { node: `end-${id}`, socket: 'exec' } },
  ],
  frames: [], groups: [],
} });

const spell = (uid, name, level, extra = {}) => ({ uid, name, level, prepared: true, concentration: false, ritual: false,
  casting_time: 'Действие', range: '60 фт', duration: 'Мгновенная', desc: `${name}: описание.`, mechanics: graph(uid), ...extra });

const character = () => ({
  revision: 1, id: 'testid', campaign_id: null, owner_id: 'u1', name: 'Волшебник', portrait_asset_id: null, updated_at: '',
  sheet: {
    _revision: 1, name: 'Волшебник', level: 5, edition: '2014',
    abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, proficiency_bonus: 3,
    hp: { max: 30, current: 30, temp: 0, hit_dice: '5d6' },
    inventory: [], features: [], conditions: [], attacks: [], skills: [], expertise: [], saving_throws: [], notes_by: {}, currency: {},
    spells: {
      ability: 'int',
      slots: { 2: { max: 1, used: 0 }, 3: { max: 1, used: 0 } },
      known: [
        spell('sp-fire', 'Огненный шар', 2, { concentration: true }),
        spell('sp-none', 'Без ячеек', 4),
        spell('sp-ritual', 'Ритуал', 1, { ritual: true, concentration: true }),
      ],
    },
  },
});

(async () => {
  const browser = await chromium.launch(await browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], calls = [];
    let state = character();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('et-consent', JSON.stringify({ decided: true, necessary: true, functional: true }));
        localStorage.setItem('sheet_tab_testid', 'spells');
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
      if (url.pathname === '/api/characters/testid' && method === 'GET') return json(route, state);
      if (url.pathname === '/api/characters/testid' && method === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        // Пустой PATCH — проверка права на запись; сохранение листа двигает ревизию.
        if (body.sheet) {
          state.revision += 1;
          state.sheet._revision = state.revision;
        }
        return json(route, state);
      }
      if (url.pathname === '/api/characters/testid/inventory') {
        const body = JSON.parse(route.request().postData() || '{}');
        calls.push(body);
        const spell = state.sheet.spells.known.find(item => item.uid === body.source_uid);
        const spent = [], effects = [];
        if (body.slot_level > 0) {
          const slot = state.sheet.spells.slots[body.slot_level];
          slot.used = Math.min(slot.max, slot.used + 1);
          spent.push({ name: `Ячейки ${body.slot_level} круга`, amount: 1, remaining: slot.max - slot.used, resource: 'slot', slot_level: body.slot_level });
        } else if (body.slot_level === 0 && spell.ritual) {
          effects.push({ kind: 'ritual', text: 'Ритуал: 10 минут, ячейка не тратится' });
        }
        if (spell.concentration) {
          state.sheet.conditions = [...state.sheet.conditions.filter(value => !value.startsWith('Концентрация:')), `Концентрация: ${spell.name}`];
          effects.push({ kind: 'condition', condition: `Концентрация: ${spell.name}`, target: 'self' });
        }
        const result = { label: `${spell.name} · Сотворить`, rolls: [], spent, effects, results: {}, program_id: 'p1', source_uid: spell.uid, source_kind: 'spell', cast: { level: body.slot_level, base: spell.level, extra: Math.max(0, body.slot_level - spell.level) } };
        return json(route, { character: state, result, replayed: false });
      }
      return json(route, []);
    });
    await page.goto('https://sheet.test/sheet/testid');
    await page.waitForFunction(() => document.querySelectorAll('.mcard.spell').length === 3);

    // 1. Круг по умолчанию — базовый; доступны только круги со свободными ячейками.
    const fire = page.locator('.mcard.spell', { hasText: 'Огненный шар' });
    await fire.locator('button.cast').click();
    const dialog = page.locator('.modal', { hasText: 'Сотворить «Огненный шар»' });
    await dialog.waitFor();
    const select = dialog.locator('select[aria-label="Круг ячейки"]');
    assert.deepEqual(await select.locator('option').allTextContents(), ['2 круг (1 свободно)', '3 круг (1 свободно)']);
    assert.equal(await select.inputValue(), 'slots:2', 'по умолчанию базовый круг');
    await select.selectOption('slots:3');
    const requestPromise = page.waitForRequest(request => request.url().endsWith('/inventory'));
    await dialog.getByRole('button', { name: 'Сотворить', exact: true }).click();
    const request = await requestPromise;
    assert.equal(JSON.parse(request.postData()).slot_level, 3, 'выбранный круг уходит на сервер');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => /Ячейки 3 круга.*осталось 0/.test(node.textContent)));
    const concentration = page.locator('.chip', { hasText: 'Концентрация: Огненный шар' });
    await concentration.waitFor();
    assert.equal(state.sheet.spells.slots[3].used, 1, 'сервер списал ячейку 3 круга');
    assert.equal(state.sheet.spells.slots[2].used, 0);

    // 2. Нет свободных ячеек: окно не открывается, запрос не уходит.
    const before = calls.length;
    await page.locator('.mcard.spell', { hasText: 'Без ячеек' }).locator('button.cast').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('Нет ячеек')));
    assert.equal(calls.length, before, 'без ячеек действие не отправляется');
    assert.equal(await page.locator('.modal').count(), 0);

    // 3. Ритуал: галочка освобождает от ячейки, сервер получает slot_level 0.
    await page.locator('.mcard.spell', { hasText: 'Ритуал' }).locator('button.cast').click();
    const ritualDialog = page.locator('.modal', { hasText: 'Сотворить «Ритуал»' });
    await ritualDialog.waitFor();
    await ritualDialog.getByLabel('Ритуал (без ячейки, 10 минут)').check();
    const [ritualRequest] = await Promise.all([
      page.waitForRequest(request => request.url().endsWith('/inventory')),
      ritualDialog.getByRole('button', { name: 'Сотворить', exact: true }).click(),
    ]);
    assert.equal(JSON.parse(ritualRequest.postData()).slot_level, 0, 'ритуал не тратит ячейку');
    assert.equal(state.sheet.spells.slots[2].used, 0);
    assert.equal(state.sheet.spells.slots[3].used, 1, 'ритуал не изменил потраченную ячейку');
    await page.locator('.chip', { hasText: 'Концентрация: Ритуал' }).waitFor();

    assert.deepEqual(errors, []);
    console.log('PASS spell cast browser: выбор круга, отправка slot_level, «Нет ячеек», ритуал, остаток и концентрация');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
