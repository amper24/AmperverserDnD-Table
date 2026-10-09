// Smoke-test the production v2 graph editor in Chromium, including record constructors.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  let launch = { headless: true };
  if (process.env.SPARTICUZ) {
    const pkg = require('@sparticuz/chromium'), bin = pkg.default || pkg;
    launch = { ...launch, args: bin.args, executablePath: await bin.executablePath() };
  }
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://mechanics-graph.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' +
        ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'mechanics-graph', 'modules'].map(name => `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://mechanics-graph.test/');
    await page.evaluate(() => {
      window.legacy = { version: 1, origin: 'test', programs: [{ id: 'potion', name: 'Выпить зелье', trigger: 'use', blocks: [
        { id: 'consume', kind: 'consume', resource: 'quantity', source: 'self', amount: 1, when: 'always' },
        { id: 'heal', kind: 'heal', dice: { count: 2, sides: 4, bonus: 2, stat: '' }, target: 'self', when: 'always' },
        { id: 'vial', kind: 'grant_item', item: { name: 'Пустой флакон', type: 'gear', qty: 1 }, amount: 1, when: 'always' },
      ] }] };
      window.editing = Modules.editItem(Modules.newItem({ name: 'Эликсир', type: 'consumable', qty: 3, mechanics: legacy }));
    });
    await page.locator('.node-editor').waitFor();
    assert.ok(await page.locator('.node-preview').isVisible(), 'edition/level preview is part of the editor');
    assert.ok(await page.getByLabel('Выборы для предпросмотра').isVisible(), 'preview can receive non-persisted choices');
    assert.equal(await page.locator('.graph-node').count(), 4, 'v1 program and blocks appear as graph action nodes');

    // Add a node, then exercise local undo/redo without saving an intermediate state.
    const originalCount = await page.locator('.graph-node').count();
    await page.locator('button.node-add[title="data.text"]').click();
    assert.equal(await page.locator('.graph-node').count(), originalCount + 1);
    await page.getByRole('button', { name: '↶ Отменить' }).click();
    assert.equal(await page.locator('.graph-node').count(), originalCount);
    await page.getByRole('button', { name: '↷ Повторить' }).click();
    assert.equal(await page.locator('.graph-node').count(), originalCount + 1);
    await page.getByRole('button', { name: '↶ Отменить' }).click();

    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.evaluate(async () => { window.saved = await window.editing; });
    const roundTrip = await page.evaluate(() => ({
      version: saved.mechanics.version,
      valid: Mechanics.validate(saved.mechanics),
      programs: Mechanics.toLegacy(saved.mechanics).programs,
    }));
    assert.equal(roundTrip.version, 2, 'saving an edited v1 record writes graph v2');
    assert.equal(roundTrip.valid, '');
    const potion = roundTrip.programs.find(program => program.id === 'potion');
    assert.deepEqual(potion.blocks.map(block => block.kind), ['consume', 'heal', 'grant_item']);
    assert.equal(potion.blocks[2].amount, 1);
    assert.equal(potion.blocks[2].item.name, 'Пустой флакон');

    // Existing entry points used by items, spells, monsters, races and classes all create the node editor.
    for (const category of ['spell', 'monster', 'race', 'class', 'background']) {
      await page.evaluate(cat => {
        const pending = cat === 'spell' ? Modules.editSpell() : Modules.editGeneric(null, cat);
        pending.then(value => { window.lastEditorResult = value; });
      }, category);
      await page.locator('.node-editor').waitFor();
      assert.ok(await page.locator('.node-editor').isVisible(), category);
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    console.log('PASS mechanics graph browser: v1-to-v2 edit/save, typed graph preview, choices preview, undo/redo, item/spell/monster/race/class/background constructors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
