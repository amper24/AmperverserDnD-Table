// Браузерный тест секций «Подключить к этой ноде» / «Подключить от этой ноды» в ПКМ-меню узла:
// подбор по типам сокетов, пара «выход → вход», провод, Undo, занятый вход и живучесть старого меню.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const MODULES = ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets', 'mechanics-graph', 'asset-kinds', 'modules'];
const NODE_SCRIPTS = require('../tools/nodes/node-loader.cjs').nodeFiles().map(f => `<script src="/${path.relative(process.cwd(), f).split(path.sep).join('/')}"></script>`).join('');

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://node-connections.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' + MODULES.map(name => name === 'node-registry' ? `<script src="/static/${name}.js"></script>` + NODE_SCRIPTS : `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://node-connections.test/');
    await page.waitForFunction(() => window.Presets?.loaded === true);
    await page.evaluate(() => {
      const doc = Modules.newItem({ name: 'Связи', type: 'feature', mechanics: { version: 2, origin: 'test', graph: {
        nodes: [
          { id: 'start', type: 'action.program', params: { program_id: 'use', name: 'Удар', trigger: 'use' }, position: { x: 60, y: 70 } },
          { id: 'roll', type: 'action.roll', params: { block_id: 'atk', kind: 'attack', enabled: true, dice: { count: 0, sides: 20, bonus: 5, stat: '' }, dc: 3 }, position: { x: 380, y: 70 } },
          { id: 'branch', type: 'flow.if', params: {}, position: { x: 700, y: 70 } },
          { id: 'end', type: 'flow.end', params: {}, position: { x: 1010, y: 70 } },
          { id: 'lvl', type: 'condition.context', params: { kind: 'level', min: 1, max: 20 }, position: { x: 380, y: 400 } },
        ],
        links: [
          { from: { node: 'start', socket: 'exec' }, to: { node: 'roll', socket: 'exec' } },
          { from: { node: 'roll', socket: 'exec' }, to: { node: 'branch', socket: 'exec' } },
          { from: { node: 'branch', socket: 'then' }, to: { node: 'end', socket: 'exec' } },
          { from: { node: 'branch', socket: 'else' }, to: { node: 'end', socket: 'exec' } },
          { from: { node: 'lvl', socket: 'value' }, to: { node: 'branch', socket: 'condition' } },
        ], frames: [], groups: [] } } });
      Modules.editItem(doc);
    });
    await page.locator('.node-editor').waitFor();

    const graph = () => page.evaluate(() => document.querySelector('.node-editor').getGraph());
    const nodeCount = async () => (await graph()).nodes.length;
    const links = async () => (await graph()).links.map(link => `${link.from.node}.${link.from.socket}->${link.to.node}.${link.to.socket}`);
    const statusText = () => page.locator('.node-status').textContent();
    const categories = () => page.locator('.node-menu > .node-menu-list > .node-menu-cat').allTextContents();
    const openNodeMenu = async id => { await page.locator(`.graph-node[data-node-id="${id}"] .node-id`).click({ button: 'right' }); await page.locator('.node-menu').waitFor(); };
    const hoverSection = async title => { await page.locator('.node-menu-cat', { hasText: title }).hover(); };
    const visibleItem = text => page.locator('.node-menu-item:visible', { hasText: text });
    const undo = async () => { await page.locator('.node-toolbar button', { hasText: 'Отменить' }).click(); };

    // 1. ПКМ по «Броску»: обе секции наверху, подсказка пары сокетов и жирный заголовок.
    await openNodeMenu('roll');
    assert.deepEqual(await categories(), ['Подключить к этой ноде', 'Подключить от этой ноды', 'Узел', 'Группа', 'Добавить рядом'], 'секции подключения идут первыми, старые пункты на месте');
    await hoverSection('Подключить к этой ноде');
    const fieldItem = visibleItem('Изменить поле');
    assert.equal(await fieldItem.locator('small').textContent(), 'exec → exec', 'у пункта видна пара сокетов');
    assert.equal(await fieldItem.evaluate(el => getComputedStyle(el).fontWeight), '600', 'заголовок типа жирный');
    const firstItem = page.locator('.node-menu-sub:not([hidden]) .node-menu-item').first();
    assert.match(await firstItem.textContent(), /^Условие · /, 'у блока действия условия идут первыми');

    // 2. Клик по совместимому условию: узел рядом с текущим и провод value → condition + Undo обоих.
    const nodesBefore = await nodeCount(), linksBefore = (await links()).length;
    assert.equal(await visibleItem('Условие · Уровень').locator('small').textContent(), 'value → condition');
    await visibleItem('Условие · Уровень').click();
    const withContext = await graph(), contextNode = withContext.nodes.at(-1);
    assert.equal(contextNode.type, 'condition.context', 'условие добавлено');
    assert.ok(contextNode.position.x > 380 && contextNode.position.y > 70, 'новый узел рядом и не в той же точке');
    assert.ok((await links()).includes(`${contextNode.id}.value->roll.condition`), 'провод value → condition создан');
    assert.equal((await links()).length, linksBefore + 1, 'добавлен ровно один провод');
    assert.match(await statusText(), /Узел «.+» добавлен и подключён/, 'статус подтверждает подключение');
    assert.equal(await page.locator(`.graph-node[data-node-id="${contextNode.id}"].selected`).count(), 1, 'новый узел выделен');
    await undo();
    assert.equal(await nodeCount(), nodesBefore, 'Undo убрал узел');
    assert.equal((await links()).length, linksBefore, 'Undo убрал и провод');
    assert.equal(await page.locator(`.graph-node[data-node-id="${contextNode.id}"]`).count(), 0, 'узел исчез с холста');

    // 3. condition.hit в «к этой ноде» есть, но валидация разрешает его только ко входу «Если»:
    // узел добавляется без провода, статус объясняет причину — правило connectionError не нарушено.
    const linksBeforeHit = await links();
    await openNodeMenu('roll');
    await hoverSection('Подключить к этой ноде');
    await visibleItem('Условие · Попадание атаки').click();
    const hitNode = (await graph()).nodes.at(-1);
    assert.equal(hitNode.type, 'condition.hit', 'условие попадания добавлено');
    assert.deepEqual(await links(), linksBeforeHit, 'запрещённый провод не создан');
    assert.match(await statusText(), /добавлен без провода/, 'статус объясняет отсутствие провода');
    assert.match(await statusText(), /Если/, 'причина — ограничение «Попадания атаки»');
    await undo();

    // 4. ПКМ по «Началу действия»: секции «к этой ноде» нет (у начала нет входов), «от этой ноды» есть.
    await openNodeMenu('start');
    assert.deepEqual(await categories(), ['Подключить от этой ноды', 'Узел', 'Группа', 'Добавить рядом'], 'у узла без входов только секция «от»');
    await hoverSection('Подключить от этой ноды');
    const slotItem = visibleItem('Расход ячейки');
    assert.equal(await slotItem.locator('small').textContent(), 'exec → exec', 'приоритет exec → exec');
    assert.equal(await visibleItem('Бросок').count(), 1, '«Бросок» доступен от начала действия');
    const linksBeforeSlot = await links();
    await slotItem.click();
    const slotNode = (await graph()).nodes.at(-1);
    assert.equal(slotNode.type, 'action.slot', '«Расход ячейки» добавлен');
    assert.ok((await links()).includes(`start.exec->${slotNode.id}.exec`), 'провод start.exec → новый exec');
    assert.equal((await links()).length, linksBeforeSlot.length + 1);
    await undo();

    // 5. Занятый вход: у «Если» condition уже занят, второго провода туда нет.
    const linksBeforeBusy = await links();
    await openNodeMenu('branch');
    await hoverSection('Подключить к этой ноде');
    await visibleItem('Условие · Хиты').click();
    const hpNode = (await graph()).nodes.at(-1);
    assert.equal(hpNode.type, 'condition.hp', 'узел добавлен');
    assert.deepEqual(await links(), linksBeforeBusy, 'второй провод в занятый condition не создан');
    assert.match(await statusText(), /без провода/, 'статус объясняет отказ');
    assert.match(await statusText(), /занят/, 'причина — занятый вход');
    await undo();

    // 6. Старые пункты меню живы: «Узел → Дублировать» работает как раньше.
    const nodesBeforeDup = await nodeCount();
    await openNodeMenu('roll');
    await page.locator('.node-menu-cat', { hasText: 'Узел' }).hover();
    await page.locator('.node-menu-item:visible', { hasText: 'Дублировать' }).click();
    assert.ok(await nodeCount() > nodesBeforeDup, 'дублирование из меню узла работает');

    assert.deepEqual(errors, [], 'нет ошибок страницы');
    console.log('PASS node connections browser: sections, socket pairs, bold title, condition first, node+wire, Undo both, hit restricted without wire, program section, exec priority, busy input, old items');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('FAIL node connections browser:', error.message); process.exit(1); });
