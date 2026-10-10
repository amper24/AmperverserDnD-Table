// Наборы данных в браузере: свой стартовый граф импортируется через «Наборы данных…» и сразу появляется
// в пустом редакторе механик; встроенный набор нельзя удалить; неверный JSON не импортируется.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const MODULES = ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets', 'mechanics-graph', 'asset-kinds', 'modules'];
const MY_SET = {
  kind: 'graph_starter', id: 'user.my-sets', name: 'Мои варианты', items: [
    { id: 'my-level-speed', name: 'Моя скорость с 3 уровня', hint: 'Свой набор: скорость 40 фт', nodes: [
      { key: 'lvl', type: 'condition.level', params: { min: 3, max: 20 }, x: 0, y: 0 },
      { key: 'spd', type: 'rule.speed', params: { value: 40 }, x: 260, y: 0 }], links: [['lvl', 'value', 'spd', 'enabled']] },
  ],
};

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://presets.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' +
        MODULES.map(name => `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://presets.test/');
    await page.waitForFunction(() => window.Presets?.loaded === true);
    await page.evaluate(() => { window.g = Modules.editItem(null, { noPresets: true }); });
    await page.locator('.node-editor').waitFor();
    const starterButtons = () => page.locator('.node-starters button');
    // Диалог наборов поверх окна редактора предмета: ищем его по заголовку.
    const dialog = () => page.locator('.modal', { has: page.locator('h2', { hasText: 'Наборы данных' }) });
    const before = await starterButtons().count();
    assert.equal(before, 5, 'встроенные стартовые графы на месте');

    // 1. Открываем диалог из редактора и импортируем свой набор текстом.
    await page.locator('button[data-action="presets"]').click();
    await dialog().locator('textarea').fill('{ не JSON');
    await dialog().getByRole('button', { name: 'Импортировать', exact: true }).click();
    assert.equal(await dialog().count(), 1, 'неверный JSON не закрывает диалог');
    await dialog().locator('textarea').fill(JSON.stringify(MY_SET));
    await dialog().getByRole('button', { name: 'Импортировать', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });

    // 2. Набор появился в списке стартов пустого редактора — без правки кода.
    await page.locator('.node-starters button', { hasText: 'Моя скорость с 3 уровня' }).waitFor();
    assert.equal(await starterButtons().count(), before + 1, 'свой граф добавлен к встроенным');

    // 3. Встроенный набор нельзя удалить, свой — можно (проверяем через реестр в той же сессии).
    await page.locator('button[data-action="presets"]').click();
    const builtinRow = dialog().locator('.preset-set-row[data-set="builtin.graph-starters"]');
    assert.equal(await builtinRow.locator('button', { hasText: 'Удалить' }).count(), 0, 'у встроенного набора нет кнопки удаления');
    await dialog().locator('.preset-set-row[data-set="user.my-sets"] button', { hasText: 'Удалить' }).click();
    assert.equal(await dialog().locator('.preset-set-row[data-set="user.my-sets"]').count(), 0, 'строка своего набора исчезла');
    await dialog().getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await page.evaluate(() => window.Presets.userSets().length), 0, 'набор удалён из хранилища');
    assert.equal(await starterButtons().count(), before, 'после удаления стартов снова столько же');

    assert.deepEqual(errors, [], 'без ошибок страницы');
    console.log('PASS presets manager browser: custom starter set imported in the dialog, shows in the editor, removable; built-in set protected');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('FAIL presets manager browser:', error.message); process.exitCode = 1; });
