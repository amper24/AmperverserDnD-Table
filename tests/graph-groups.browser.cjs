// Группы нод как пользовательские шаблоны и узел «Характеристика / навык» в палитре.
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
          { id: 'consume', type: 'action.spend', params: { block_id: 'consume', resource: 'quantity', source: 'self', amount: 1, trigger: 'use', when: 'always', enabled: true }, position: { x: 330, y: 70 } },
          { id: 'heal', type: 'action.roll', params: { block_id: 'heal', kind: 'heal', dice: { count: 2, sides: 4, bonus: 2, stat: '' }, when: 'always', enabled: true }, position: { x: 590, y: 70 } },
          { id: 'end', type: 'flow.end', params: {}, position: { x: 850, y: 70 } },
        ],
        links: [
          { from: { node: 'potion', socket: 'exec' }, to: { node: 'consume', socket: 'exec' } },
          { from: { node: 'consume', socket: 'exec' }, to: { node: 'heal', socket: 'exec' } },
          { from: { node: 'heal', socket: 'exec' }, to: { node: 'end', socket: 'exec' } },
        ], frames: [], groups: [],
      } };
      window.editing = Modules.editItem(Modules.newItem({ name: 'Эликсир', type: 'consumable', qty: 3, mechanics: window.mechanics }));
    });
    await page.locator('.node-editor').waitFor();

    // 1. Палитра: новые узлы находятся поиском.
    await page.getByLabel('Поиск узла', { exact: true }).fill('data.stat');
    assert.equal(await page.locator('button.node-add[title="data.stat"]').count(), 1, 'узел характеристики/навыка в палитре');
    await page.locator('button.node-add[title="data.stat"]').click();
    const statCard = page.locator('.graph-node', { hasText: 'Характеристика / навык' });
    assert.equal(await statCard.count(), 1, 'узел добавлен на холст');
    assert.ok(await page.locator('option', { hasText: 'Акробатика (навык)' }).count() > 0, 'список навыков берётся из набора SKILLS');

    // 2. Группа из выделенного узла сохраняется в шаблоны и вставляется обратно.
    await page.getByLabel('Поиск узла', { exact: true }).fill('');
    await page.getByLabel('Поиск узла', { exact: true }).fill('data.number');
    await page.locator('button.node-add[title="data.number"]').click();
    await page.getByRole('button', { name: 'Сгруппировать', exact: true }).click();
    const tplSaves = page.getByRole('button', { name: 'В шаблоны', exact: true });
    await tplSaves.first().click();
    const saved = await page.evaluate(() => window.Presets.items('graph_group'));
    assert.equal(saved.length, 1, 'группа сохранена как шаблон');
    assert.ok(saved[0].nodes.length >= 1 && saved[0].inputs.length === 0, 'в шаблоне узлы группы');
    const instancesBefore = await page.locator('.graph-node', { hasText: saved[0].name }).count();
    await page.locator('.node-group-shelf .node-group-item').nth(1).locator('button').first().click();
    assert.equal(await page.evaluate(() => window.Presets.items('graph_group').length), 1, 'шаблон остаётся после вставки');
    assert.equal(await page.locator('.graph-node', { hasText: saved[0].name }).count(), instancesBefore + 1, 'вставлен экземпляр группы из шаблона');

    // 3. Свой шаблон группы удаляется.
    await page.locator('.node-group-shelf button[title="Удалить шаблон группы"]').click();
    assert.equal(await page.evaluate(() => window.Presets.items('graph_group').length), 0, 'шаблон группы удалён');

    assert.deepEqual(errors, [], 'страница без ошибок');
    console.log('PASS graph groups: group templates save/insert/delete, data.stat node in the palette');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
