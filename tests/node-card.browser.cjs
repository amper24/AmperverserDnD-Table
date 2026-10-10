// Браузерный тест (Chromium через Playwright):
//  1) параметр узла меняется прямо на карточке, а ввод не двигает узел и не ломает провод;
//  2) кнопка на листе персонажа отправляет программу «попадание → урон» на сервер (исполнение — серверное,
//     в браузере эффекты не применяются; проверка самой цепочки на сервере — Rust-тест в CI).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ORIGIN = 'https://node-card.test';
const EDITOR_MODULES = ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets', 'mechanics-graph', 'asset-kinds', 'modules'];

// Программа «Удар жезлом»: атака (КД 12) → «Если» по условию «Попадание атаки» → урон 1d8 только при попадании.
const WAND = {
  uid: 'wand', name: 'Жезл', type: 'consumable', qty: 1, rarity: 'Обычный', weight: 0, cost: '', desc: '', equipped: false, attuned: false, attunement: false, charges: null, actions: [], tags: [], icon: '', asset_id: null, token_asset_id: null, source: '',
  mechanics: { version: 2, origin: 'test', graph: { frames: [], groups: [], nodes: [
    { id: 'p', type: 'action.program', params: { program_id: 'use', name: 'Удар жезлом', trigger: 'use' }, position: { x: 0, y: 0 } },
    { id: 'atk', type: 'action.attack', params: { block_id: 'atk', enabled: true, dice: { count: 0, sides: 20, bonus: 5, stat: '' }, dc: 12 }, position: { x: 260, y: 0 } },
    { id: 'hit', type: 'condition.hit', params: {}, position: { x: 520, y: 130 } },
    { id: 'if', type: 'flow.if', params: {}, position: { x: 520, y: 0 } },
    { id: 'dmg', type: 'action.damage', params: { block_id: 'dmg', enabled: true, dice: { count: 1, sides: 8, bonus: 0, stat: '' } }, position: { x: 780, y: 0 } },
  ], links: [
    { from: { node: 'p', socket: 'exec' }, to: { node: 'atk', socket: 'exec' } },
    { from: { node: 'atk', socket: 'exec' }, to: { node: 'if', socket: 'exec' } },
    { from: { node: 'hit', socket: 'value' }, to: { node: 'if', socket: 'condition' } },
    { from: { node: 'if', socket: 'then' }, to: { node: 'dmg', socket: 'exec' } },
  ] } },
};

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    let sheet = { _revision: 0, name: 'Стрелок', level: 1, skills: [], saving_throws: [], expertise: [], conditions: [], death_saves: { success: 0, failure: 0 }, proficiency_bonus: 2, ac: 10, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hp: { current: 9, max: 20, temp: 0 }, inventory: [JSON.parse(JSON.stringify(WAND))], features: [], spells: { known: [] } };
    const character = () => ({ id: 'hero', name: 'Стрелок', owner_id: 'user', revision: sheet._revision, sheet: JSON.parse(JSON.stringify(sheet)) });
    await page.route(`${ORIGIN}/**`, async route => {
      const url = new URL(route.request().url()), req = route.request();
      const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      if (url.pathname === '/api/auth/me') return json({ id: 'user', name: 'Игрок' });
      if (url.pathname === '/api/characters/hero') {
        // Автосохранение листа перед операцией: ревизия растёт на единицу, как на сервере.
        if (req.method() === 'PATCH' && req.postDataJSON().sheet) sheet = { ...req.postDataJSON().sheet, _revision: sheet._revision + 1 };
        return json(character());
      }
      if (url.pathname === '/api/characters/hero/inventory' && req.method() === 'POST') {
        const body = req.postDataJSON();
        requests.push(body);
        await new Promise(resolve => setTimeout(resolve, 100));
        // Ответ сервера (здесь — заглушка формы ответа): клиент только показывает результат, эффекты не считает.
        return json({ character: character(), result: { label: 'Жезл · Удар жезлом', rolls: [], spent: [], effects: [] } });
      }
      if (url.pathname.startsWith('/sheet/')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync('static/sheet.html') });
      if (url.pathname.startsWith('/api/')) return json([]);
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' + EDITOR_MODULES.map(name => `<script src="/static/${name}.js"></script>`).join('') });
    });

    // ---- 1. Параметр меняется на карточке узла --------------------------------------------------
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.Presets?.loaded === true);
    await page.evaluate(() => {
      window.doc = Modules.newItem({ name: 'Карточка', type: 'feature', mechanics: { version: 2, origin: 'test', graph: {
        nodes: [
          { id: 'num', type: 'data.number', params: { value: 5 }, position: { x: 80, y: 80 } },
          { id: 'spd', type: 'rule.speed', params: { value: 30 }, position: { x: 420, y: 80 } },
        ], links: [], frames: [], groups: [] } } });
      Modules.editItem(window.doc);
    });
    await page.locator('.node-editor').waitFor();
    await page.locator('.node-canvas').scrollIntoViewIfNeeded();
    const graphNode = id => page.locator(`.graph-node[data-node-id="${id}"]`);
    const graph = () => page.evaluate(() => document.querySelector('.node-editor').getGraph());
    const pos = id => page.evaluate(id => document.querySelector('.node-editor').getGraph().nodes.find(n => n.id === id).position, id);
    const paramOf = (id, key) => page.evaluate(([id, key]) => document.querySelector('.node-editor').getGraph().nodes.find(n => n.id === id).params[key], [id, key]);
    const center = async loc => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const socket = (node, dir, name) => page.locator(`.node-socket[data-node="${node}"][data-dir="${dir}"][data-socket="${name}"]`);
    const wireCount = () => page.locator('.node-wire:not(.node-wire-preview)').count();

    // Поле есть на карточке, а не только в боковой панели.
    const speedInput = graphNode('spd').locator('.node-inline input[type="number"]');
    assert.equal(await speedInput.count(), 1, 'число выводится на карточке узла');
    assert.equal(await speedInput.inputValue(), '30');

    // Нажатие и протяжка по полю не двигают узел (pointer-события отделены от карточки).
    const before = await pos('spd');
    const inputBox = await speedInput.boundingBox();
    await page.mouse.move(inputBox.x + 4, inputBox.y + inputBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(inputBox.x + 90, inputBox.y + 60, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await pos('spd'), before, 'протяжка по полю не двигает узел');

    // Провод от числа к скорости: после правки значения провод остаётся на месте.
    const a = await center(socket('num', 'outputs', 'value')), b = await center(socket('spd', 'inputs', 'value'));
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
    assert.equal((await graph()).links.length, 1, 'провод соединён');
    const wiresBefore = await wireCount();

    // Значение меняется на карточке: change → граф обновлён, провод и позиция на месте.
    await speedInput.fill('35');
    await speedInput.press('Enter');
    await page.waitForFunction(() => document.querySelector('.node-editor').getGraph().nodes.find(n => n.id === 'spd').params.value === 35);
    assert.equal(await paramOf('spd', 'value'), 35, 'параметр записан в граф с карточки');
    assert.deepEqual(await pos('spd'), before, 'правка значения не сдвигает узел');
    assert.equal((await graph()).links.length, 1, 'провод не потерян после правки');
    assert.equal(await wireCount(), wiresBefore, 'провод на холсте остался');
    // Боковая панель показывает то же значение: поле не единственное место ввода, но и не расходится с картой.
    assert.equal(await page.locator('.node-properties input[type="number"]').first().inputValue(), '35', 'панель параметров синхронна');

    // Текстовый параметр тоже меняется на карточке (строка показывается в инлайн-форме).
    await graphNode('num').locator('.node-inline input[type="number"]').fill('7');
    await graphNode('num').locator('.node-inline input[type="number"]').press('Tab');
    await page.waitForFunction(() => document.querySelector('.node-editor').getGraph().nodes.find(n => n.id === 'num').params.value === 7);
    assert.equal(await paramOf('num', 'value'), 7, 'второй узел тоже меняется на карточке');

    // ---- 2. Цепочка попадание → урон по кнопке листа -------------------------------------------
    await page.goto(`${ORIGIN}/sheet/hero`);
    await page.evaluate(() => Consent.set(false));
    await page.getByRole('button', { name: /Инвентарь/ }).click();
    const wandRow = page.locator('[data-uid="wand"]');
    await wandRow.waitFor();
    // Проекция графа в программу (та же, что уходит на сервер по ссылке): атака, затем урон только при попадании.
    const program = await page.evaluate(wand => Mechanics.programsOf(wand.mechanics, { edition: '2014', level: 1 })[0], WAND);
    assert.deepEqual(program.blocks.map(b => [b.kind, b.when || 'always']), [['attack', 'always'], ['damage', 'hit']], 'цепочка: атака → урон при попадании');
    // Кнопка всей цепочки (класс all): отдельных бросков «Попадание»/«Урон» для ветвления недостаточно.
    await wandRow.locator('.act-btn.all').click();
    await page.waitForTimeout(400);
    assert.equal(await wandRow.locator('.act-btn.all').count(), 1, 'кнопка цепочки видна на листе');
    assert.equal(requests.length, 1, 'кнопка отправила одну операцию');
    const sent = requests[0];
    assert.equal(sent.op, 'program');
    assert.equal(sent.source_uid, 'wand');
    assert.equal(sent.program_id, 'use');
    assert.equal(sent.blocks, undefined, 'клиент не присылает эффекты: сервер исполняет программу по её ссылке');
    assert.equal(sent.target_id, 'hero');
    assert.deepEqual(errors, [], 'страница без ошибок');
    console.log('PASS node card browser: parameter edited on the canvas card (drag and wire intact), hit-to-damage chain sent by the sheet button');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
