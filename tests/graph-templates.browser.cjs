// Конечный узел в быстрой панели, защита от второго «Конца», сохранение цепочки действия
// как шаблона через диалог «Шаблоны действий» и его вставка/удаление.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const NODE_SCRIPTS = require('../tools/nodes/node-loader.cjs').nodeFiles().map(f => `<script src="/${path.relative(process.cwd(), f).split(path.sep).join('/')}"></script>`).join('');

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://mechanics-graph.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' +
        ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets', 'mechanics-graph', 'asset-kinds', 'modules'].map(name => name === 'node-registry' ? `<script src="/static/${name}.js"></script>` + NODE_SCRIPTS : `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://mechanics-graph.test/');
    await page.waitForFunction(() => window.Presets?.loaded === true);
    await page.evaluate(() => {
      window.mechanics = { version: 2, origin: 'test', graph: {
        nodes: [
          { id: 'potion', type: 'action.program', params: { program_id: 'potion', name: 'Выпить зелье', trigger: 'use' }, position: { x: 60, y: 70 } },
          { id: 'consume', type: 'action.consume', params: { block_id: 'consume', resource: 'quantity', source: 'self', amount: 1, when: 'always', enabled: true }, position: { x: 330, y: 70 } },
          { id: 'heal', type: 'action.roll', params: { block_id: 'heal', roll_kind: 'heal', dice: { count: 2, sides: 4, bonus: 2, stat: '' }, when: 'always', enabled: true }, position: { x: 590, y: 70 } },
        ],
        links: [
          { from: { node: 'potion', socket: 'exec' }, to: { node: 'consume', socket: 'exec' } },
          { from: { node: 'consume', socket: 'exec' }, to: { node: 'heal', socket: 'exec' } },
        ], frames: [], groups: [],
      } };
      window.editing = Modules.editItem(Modules.newItem({ name: 'Эликсир', type: 'consumable', qty: 3, mechanics: window.mechanics }));
    });
    await page.locator('.node-editor').waitFor();

    // 1. Конечный узел виден в быстрой панели.
    assert.equal(await page.locator('.node-toolbar button.node-add[title="flow.end"]').count(), 1, 'конец есть на быстрой панели');

    // 2. Второй «Конец» в действии не добавляется.
    await page.locator('.node-toolbar button.node-add[title="flow.end"]').click();
    const ends = await page.locator('.graph-node', { hasText: 'Конец' }).count();
    assert.equal(ends, 1, 'первый конец создан');
    await page.locator('.node-toolbar button.node-add[title="flow.end"]').click();
    assert.equal(await page.locator('.graph-node', { hasText: 'Конец' }).count(), 1, 'второй конец не создан');

    // 2б. Удаление «Конца» предупреждает, что действие осталось без конца; кнопка возвращает его.
    await page.locator('.graph-node', { hasText: 'Конец' }).locator('.node-delete').click();
    assert.equal(await page.locator('.graph-node', { hasText: 'Конец' }).count(), 0, 'конец удалён');
    assert.match(await page.locator('.node-status').innerText(), /без «Конца»/i, 'виден статус об удалённом «Конце»');
    await page.locator('.node-toolbar button.node-add[title="flow.end"]').click();
    assert.equal(await page.locator('.graph-node', { hasText: 'Конец' }).count(), 1, 'конец добавлен снова');

    // 3. Сохраняем цепочку действия как свой шаблон через диалог «Шаблоны действий».
    await page.getByRole('button', { name: 'Сохранить как шаблон', exact: true }).click();
    const saveDialog = page.getByRole('dialog', { name: 'Шаблоны действий' });
    await saveDialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Название шаблона', 'фокус сразу в поле названия');
    await saveDialog.getByLabel('Название шаблона', { exact: true }).fill('Моё лечение');
    await saveDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await saveDialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('.node-status').innerText(), /Шаблон «Моё лечение» сохранён/, 'статус после сохранения шаблона');
    const saved = await page.evaluate(() => (window.Presets.items('graph_starter').find(s => s.name === 'Моё лечение') || null));
    assert.ok(saved, 'шаблон сохранён в наборе graph_starter');
    assert.ok(saved.nodes.length > 0, 'в шаблоне есть узлы действия');
    assert.ok(saved.nodes.every(n => !['action.program', 'flow.end'].includes(n.type)), 'Начало и Конец в шаблон не входят');

    // 4. Новое действие, вставка шаблона из вкладки «Мои».
    await page.locator('.node-toolbar button.node-add[title="action.program"]').click();
    await page.getByRole('button', { name: 'Шаблоны действий', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Шаблоны действий' });
    await dialog.getByRole('tab', { name: /Мои/ }).click();
    const card = dialog.locator('.templates-card', { hasText: 'Моё лечение' });
    await card.waitFor();
    const before = await page.locator('.graph-node').count();
    await card.getByRole('button', { name: 'Вставить', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('.node-status').innerText(), /Шаблон «Моё лечение» вставлен/, 'статус после вставки шаблона');
    const after = await page.locator('.graph-node').count();
    assert.equal(after - before, saved.nodes.length, 'вставлены все узлы шаблона');
    // Вставленная цепочка встаёт между «Началом» и «Концом», а не рядом с прямым проводом в «Конец».
    const problems = await page.evaluate(() => window.Mechanics.problems({ version: 2, graph: document.querySelector('.node-editor').getGraph() }));
    assert.deepEqual(problems, [], 'поток обоих действий завершается «Концом»');

    // 5. Свой шаблон удаляется из вкладки «Мои» с подтверждением вторым нажатием.
    await page.getByRole('button', { name: 'Шаблоны действий', exact: true }).click();
    await page.getByRole('tab', { name: /Мои/ }).click();
    const ownCard = page.locator('.templates-card', { hasText: 'Моё лечение' });
    await ownCard.getByRole('button', { name: 'Удалить', exact: true }).click();
    assert.equal(await ownCard.getByRole('button', { name: 'Точно удалить?', exact: true }).count(), 1, 'первое нажатие просит подтверждение');
    await ownCard.getByRole('button', { name: 'Точно удалить?', exact: true }).click();
    assert.equal(await page.evaluate(() => Boolean(window.Presets.items('graph_starter').find(s => s.name === 'Моё лечение'))), false, 'свой шаблон удалён');
    assert.equal(await page.locator('.templates-card', { hasText: 'Моё лечение' }).count(), 0, 'карточка исчезла из диалога');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: 'Шаблоны действий' }).count(), 0, 'Esc закрывает диалог');

    assert.deepEqual(errors, [], 'страница без ошибок');
    console.log('PASS graph templates: end node on the quick panel, single end per action, save/insert/delete own template');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
