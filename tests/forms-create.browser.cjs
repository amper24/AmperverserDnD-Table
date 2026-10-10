// Creation flow for items, spells and graphs in Chromium: preset step, collapsible sections, graph starters.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://forms-create.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' +
        ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'mechanics-graph', 'asset-kinds', 'modules'].map(name => `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://forms-create.test/');

    // 1. Новый предмет: сначала шаг «Что создаём?», потом форма с заполненной основой.
    await page.evaluate(() => { window.itemResult = Modules.editItem(null); });
    assert.equal(await page.locator('.preset-tile').count(), 6, 'item presets are offered first');
    await page.locator('.preset-tile', { hasText: 'Магический предмет' }).click();
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    const nameInput = page.locator('.field', { has: page.locator('label', { hasText: /^Название$/ }) }).locator('input');
    assert.equal(await nameInput.inputValue(), 'Магический предмет', 'preset fills the name');
    assert.equal(await page.locator('select').first().inputValue(), 'magic', 'preset fills the type');
    assert.equal(await page.getByLabel(/Требует настройки/).isChecked(), true, 'preset sets attunement');
    const chargesOpen = await page.locator('details.form-section', { hasText: 'Заряды' }).evaluate(d => d.open);
    assert.equal(chargesOpen, false, 'empty charges section is collapsed');
    assert.ok(await page.locator('details.form-section', { hasText: 'Основное' }).evaluate(d => d.open), 'main section is open');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const item = await page.evaluate(() => window.itemResult);
    assert.equal(item.type, 'magic');
    assert.equal(item.attunement, true);

    // 2. Отмена на шаге выбора не создаёт запись.
    await page.evaluate(() => { window.cancelled = Modules.editItem(null); });
    await page.locator('.preset-tile').first().waitFor();
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    // Существующую запись шаг не показывает: редактирование сразу открывает форму.
    await page.evaluate(() => { window.edited = Modules.editItem(Modules.newItem({ name: 'Меч', type: 'weapon', charges: { cur: 2, max: 3, recharge: 'днём' } })); });
    assert.equal(await page.locator('.preset-tile').count(), 0, 'editing skips the preset step');
    assert.ok(await page.locator('details.form-section', { hasText: 'Заряды' }).evaluate(d => d.open), 'filled charges section opens itself');
    await page.getByRole('button', { name: 'Отмена' }).click().catch(() => {});
    await page.keyboard.press('Escape');

    // 3. Заклинание: заговор ставит круг 0 и расход «без расхода».
    await page.evaluate(() => { window.spellResult = Modules.editSpell(null); });
    await page.locator('.preset-tile', { hasText: 'Заговор' }).click();
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    assert.equal(await page.locator('.editor-form select').first().inputValue(), '0', 'cantrip preset sets level 0');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const spell = await page.evaluate(() => window.spellResult);
    assert.equal(spell.level, 0);
    assert.equal(spell.cast_cost, 'free');

    // 4. Стартовые графы в пустом редакторе предмета: вставка даёт валидный граф.
    await page.evaluate(() => { window.g = Modules.editItem(null, { noPresets: true }); });
    await page.locator('.node-editor').waitFor();
    assert.equal(await page.locator('.node-starters button').count(), 3, 'blank graph (only the default use program) offers starters');
    const base = await page.locator('.graph-node').count();
    await page.locator('.node-starters button', { hasText: 'Скорость с уровня' }).click();
    assert.equal(await page.locator('.graph-node').count(), base + 2, 'speed starter adds two nodes');
    assert.equal(await page.locator('.node-starters').count(), 0, 'starters hide after first node');
    const status = await page.locator('.node-status').innerText();
    assert.ok(!status.includes('не исполняется'), `speed starter is valid, got: ${status}`);
    await page.getByRole('button', { name: '↶ Отменить' }).click();
    assert.equal(await page.locator('.graph-node').count(), base, 'starter insertion is undoable');
    await page.locator('.node-starters button', { hasText: 'Хиты с 3 уровня' }).click();
    assert.equal(await page.locator('.graph-node').count(), base + 3, 'level-gated hp starter adds three nodes');
    assert.ok(!(await page.locator('.node-status').innerText()).includes('не исполняется'), 'hp starter is valid');
    await page.getByRole('button', { name: 'Отмена' }).click().catch(() => {});
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('forms-create browser test: PASS');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
