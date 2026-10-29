// Диалог «Шаблоны действий»: открытие, поиск, вкладки, сохранение своей цепочки, вставка,
// удаление с подтверждением, группы, Esc, клик по overlay, focus-trap и возврат фокуса.
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
    await page.route('https://templates-dialog.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' +
        ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets', 'mechanics-graph', 'asset-kinds', 'modules'].map(name => name === 'node-registry' ? `<script src="/static/${name}.js"></script>` + NODE_SCRIPTS : `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://templates-dialog.test/');
    await page.waitForFunction(() => window.Presets?.loaded === true);
    await page.evaluate(() => {
      window.mechanics = { version: 2, origin: 'test', graph: {
        nodes: [
          { id: 'potion', type: 'action.program', params: { program_id: 'potion', name: 'Выпить зелье', trigger: 'use' }, position: { x: 60, y: 70 } },
          { id: 'consume', type: 'action.spend', params: { block_id: 'consume', resource: 'quantity', source: 'self', amount: 1, trigger: 'use', when: 'always', enabled: true }, position: { x: 330, y: 70 } },
          { id: 'heal', type: 'action.roll', params: { block_id: 'heal', roll_kind: 'heal', dice: { count: 2, sides: 4, bonus: 2, stat: '' }, when: 'always', enabled: true }, position: { x: 590, y: 70 } },
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
    const dialog = page.getByRole('dialog', { name: 'Шаблоны действий' });
    const tabs = id => page.locator(`[data-templates-tab="${id}"]`);
    const cards = () => page.locator('.templates-card');
    const openBrowse = async () => {
      await page.getByRole('button', { name: 'Шаблоны действий', exact: true }).click();
      await dialog.waitFor();
    };
    const focusedAction = () => page.evaluate(() => document.activeElement?.getAttribute('data-action') || '');

    // 0. Компактная панель на месте: основная кнопка, сохранение и подсказка.
    assert.equal(await page.locator('.node-template-bar button.primary').innerText(), 'Шаблоны действий', 'основная кнопка панели');
    assert.equal(await page.locator('.node-template-bar').getByRole('button', { name: 'Сохранить как шаблон', exact: true }).count(), 1, 'кнопка сохранения в панели');
    assert.equal(await page.locator('.node-template-bar .node-template-hint').innerText(), 'Готовые наборы, свои цепочки и группы', 'подсказка панели');
    assert.equal(await page.locator('[data-templates-overlay]').count(), 0, 'до нажатия диалога нет');

    // 1. Открытие: окно внутри root редактора, role=dialog, фокус на поиске.
    await openBrowse();
    assert.equal(await page.locator('[data-templates-overlay]').count(), 1, 'оверлей один');
    assert.equal(await page.evaluate(() => document.querySelector('[data-templates-overlay]')?.parentElement?.classList.contains('node-editor')), true, 'окно вставлено в root редактора');
    assert.equal(await page.evaluate(() => document.body.querySelector(':scope > [data-templates-overlay]')), null, 'окна нет напрямую в body');
    assert.equal(await dialog.getAttribute('aria-modal'), 'true', 'aria-modal');
    assert.equal(await dialog.getAttribute('aria-label'), 'Шаблоны действий', 'aria-label');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Поиск шаблонов', 'фокус при открытии на поиске');
    assert.match(await dialog.locator('.templates-subtitle').innerText(), /Выпить зелье/, 'подзаголовок с именем действия');

    // 2. Вкладки со счётчиками и готовые карточки с мини-превью.
    assert.equal(await tabs('ready').locator('.templates-count').innerText(), '5', 'пять готовых шаблонов');
    assert.equal(await tabs('mine').locator('.templates-count').innerText(), '0', 'своих пока нет');
    assert.equal(await tabs('groups').locator('.templates-count').innerText(), '0', 'групп пока нет');
    assert.equal(await cards().count(), 5, 'карточки готовых шаблонов');
    const speed = page.locator('.templates-card[data-template-id="speed-level"]');
    assert.equal(await speed.locator('.templates-preview-svg').count(), 1, 'у карточки есть SVG-превью');
    assert.equal(await speed.locator('.templates-preview-node').count(), 2, 'в превью две рамки узлов');
    assert.equal(await speed.locator('.templates-preview-link').count(), 1, 'в превью одна связь');
    assert.equal(await speed.locator('.templates-preview-node.cat-conditions').count(), 1, 'цвет категории «Условия»');
    assert.equal(await speed.locator('.templates-preview-node.cat-character').count(), 1, 'цвет категории «Персонаж»');
    assert.match(await speed.innerText(), /готовый/, 'бейдж «готовый»');
    assert.equal(await speed.getByRole('button', { name: 'Удалить', exact: true }).count(), 0, 'готовый шаблон нельзя удалить');

    // 3. Живой поиск по названию и подсказке, регистронезависимый; пустое состояние.
    const search = dialog.getByLabel('Поиск шаблонов', { exact: true });
    await search.fill('СКОРОСТЬ');
    assert.equal(await cards().count(), 1, 'поиск регистронезависимый');
    assert.match(await cards().first().innerText(), /Скорость с уровня/);
    await search.fill('бонус');
    assert.ok(await cards().count() >= 1, 'поиск идёт и по подсказке');
    await search.fill('нет такого шаблона');
    assert.equal(await cards().count(), 0, 'ничего не найдено');
    assert.equal(await dialog.locator('[data-templates-empty]').innerText(), 'Ничего не найдено по запросу.', 'текст пустого поиска');
    await search.fill('');
    assert.equal(await cards().count(), 5, 'фильтр сброшен');

    // 4. Вкладки «Мои» и «Группы»: пустые подсказки и переключение стрелками.
    await tabs('mine').click();
    assert.equal(await dialog.locator('[data-templates-empty]').innerText(), 'Своих шаблонов пока нет — соберите цепочку и нажмите «Сохранить как шаблон».', 'подсказка для «Моих»');
    await tabs('groups').click();
    assert.match(await dialog.locator('[data-templates-empty]').innerText(), /Сгруппировать/, 'подсказка, как сохранить группу');
    await tabs('groups').press('ArrowLeft');
    assert.equal(await tabs('mine').getAttribute('aria-selected'), 'true', 'стрелка влево переключает вкладку');
    await tabs('mine').press('ArrowRight');
    assert.equal(await tabs('groups').getAttribute('aria-selected'), 'true', 'стрелка вправо переключает вкладку');
    await tabs('ready').click();

    // 5. Focus-trap: Tab и Shift+Tab не выходят из панели.
    await dialog.getByRole('button', { name: 'Закрыть шаблоны' }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.querySelector('[data-templates-panel]').contains(document.activeElement)), true, 'Shift+Tab остаётся в панели');
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.querySelector('[data-templates-panel]').contains(document.activeElement)), true, `Tab ${i + 1} остаётся в панели`);
    }

    // 6. Закрытие по Esc возвращает фокус на открывшую кнопку.
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await focusedAction(), 'templates-dialog', 'фокус вернулся на «Шаблоны действий»');

    // 7. Закрытие по клику на overlay и по кнопке ×.
    await openBrowse();
    await page.locator('[data-templates-overlay]').click({ position: { x: 4, y: 4 } });
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await focusedAction(), 'templates-dialog', 'клик по overlay вернул фокус');
    await openBrowse();
    await dialog.getByRole('button', { name: 'Закрыть шаблоны' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await focusedAction(), 'templates-dialog', 'кнопка × вернула фокус');

    // 8. Режим сохранения: поле в фокусе, подсказка с числом узлов, сохранение и статус.
    await page.getByRole('button', { name: 'Сохранить как шаблон', exact: true }).click();
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Название шаблона', 'фокус в поле названия');
    assert.equal(await dialog.locator('.templates-save-hint').innerText(), 'В шаблон войдут узлы действия, кроме «Начала», «Конца» и групп: 2 узла.', 'подсказка о содержимом шаблона');
    assert.equal(await dialog.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), false, 'кнопка сохранения доступна');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    assert.equal(await dialog.locator('.templates-save-error').innerText(), 'Укажите название шаблона.', 'ошибка видна в форме');
    assert.equal(await page.getByRole('dialog', { name: 'Шаблоны действий' }).count(), 1, 'ошибка не закрывает диалог');
    await dialog.getByLabel('Название шаблона', { exact: true }).fill('Мой шаблон');
    assert.equal(await dialog.locator('.templates-save-error').isHidden(), true, 'ошибка сбрасывается при вводе');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('.node-status').innerText(), /Шаблон «Мой шаблон» сохранён\./, 'статус сохранения');
    assert.equal(await focusedAction(), 'save-template', 'фокус вернулся на «Сохранить как шаблон»');
    assert.equal(await page.evaluate(() => window.Presets.items('graph_starter').filter(s => s.name === 'Мой шаблон').length), 1, 'шаблон в наборе');

    // 9. Вкладка «Мои»: карточка своего шаблона с бейджем и превью.
    await openBrowse();
    await tabs('mine').click();
    assert.equal(await tabs('mine').locator('.templates-count').innerText(), '1', 'счётчик «Мои»');
    const own = page.locator('.templates-card', { hasText: 'Мой шаблон' });
    assert.equal(await own.count(), 1, 'карточка во вкладке «Мои»');
    assert.match(await own.innerText(), /мой/, 'бейдж «мой»');
    assert.equal(await own.locator('.templates-preview-node').count(), 2, 'превью своего шаблона');
    assert.equal(await own.getByRole('button', { name: 'Удалить', exact: true }).count(), 1, 'свой шаблон можно удалить');
    await page.keyboard.press('Escape');

    // 10. Вставка своего шаблона в новое действие и отмена вставки.
    await page.locator('.node-toolbar button.node-add[title="action.program"]').click();
    assert.equal(await page.locator('.node-starters button').count(), 6, 'быстрые стартеры пустого действия: 5 встроенных и свой шаблон');
    // В пустом действии сохранять нечего: кнопка недоступна, причина написана в форме.
    await page.getByRole('button', { name: 'Сохранить как шаблон', exact: true }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true, 'в пустом действии сохранение недоступно');
    assert.equal(await dialog.locator('.templates-save-hint').innerText(), 'В действии нет узлов, кроме «Начала» и «Конца», — сохранять нечего.', 'причина недоступности сохранения');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await openBrowse();
    await tabs('mine').click();
    const beforeInsert = await page.locator('.graph-node').count();
    await page.locator('.templates-card', { hasText: 'Мой шаблон' }).getByRole('button', { name: 'Вставить', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('.node-status').innerText(), /Шаблон «Мой шаблон» вставлен\./, 'статус вставки');
    assert.equal(await page.locator('.graph-node').count(), beforeInsert + 2, 'вставлены оба узла шаблона');
    assert.equal(await page.locator('.node-starters').count(), 0, 'после вставки стартеры скрылись');
    assert.equal(await focusedAction(), 'templates-dialog', 'фокус вернулся на «Шаблоны действий»');
    await page.getByRole('button', { name: '↶ Отменить' }).click();
    assert.equal(await page.locator('.graph-node').count(), beforeInsert, 'вставка шаблона отменяется');

    // 11. Удаление своего шаблона с подтверждением вторым нажатием.
    await openBrowse();
    await tabs('mine').click();
    const ownCard = page.locator('.templates-card', { hasText: 'Мой шаблон' });
    const deleteButton = ownCard.getByRole('button', { name: 'Удалить', exact: true });
    await deleteButton.click();
    assert.equal(await ownCard.getByRole('button', { name: 'Точно удалить?', exact: true }).count(), 1, 'первое нажатие просит подтверждение');
    await page.waitForTimeout(3200);
    assert.equal(await ownCard.getByRole('button', { name: 'Удалить', exact: true }).count(), 1, 'подтверждение само сбрасывается через 3 секунды');
    await ownCard.getByRole('button', { name: 'Удалить', exact: true }).click();
    await ownCard.getByRole('button', { name: 'Точно удалить?', exact: true }).click();
    assert.equal(await page.evaluate(() => window.Presets.items('graph_starter').some(s => s.name === 'Мой шаблон')), false, 'шаблон удалён из набора');
    assert.equal(await page.locator('.templates-card', { hasText: 'Мой шаблон' }).count(), 0, 'карточка исчезла');
    assert.equal(await tabs('mine').locator('.templates-count').innerText(), '0', 'счётчик «Мои» обновился');
    assert.equal(await dialog.locator('[data-templates-empty]').innerText(), 'Своих шаблонов пока нет — соберите цепочку и нажмите «Сохранить как шаблон».', 'пустое состояние после удаления');
    await page.keyboard.press('Escape');

    // 12. Группы: сохранение группы в шаблоны, карточка, вставка и удаление из диалога.
    await page.locator('.node-action-tab').first().click();
    await page.locator('.graph-node[data-node-id="consume"] .graph-node-head b').click();
    await page.getByRole('button', { name: 'Сгруппировать', exact: true }).click();
    await page.locator('.node-group-shelf').waitFor();
    await page.getByRole('button', { name: 'В шаблоны', exact: true }).first().click();
    assert.equal(await page.evaluate(() => window.Presets.items('graph_group').length), 1, 'группа сохранена в шаблоны');
    await openBrowse();
    await tabs('groups').click();
    assert.equal(await tabs('groups').locator('.templates-count').innerText(), '1', 'счётчик групп');
    const groupCard = page.locator('.templates-card[data-template-kind="group"]');
    assert.equal(await groupCard.count(), 1, 'карточка группы');
    assert.match(await groupCard.innerText(), /группа/, 'мета группы');
    assert.equal(await groupCard.locator('.templates-preview-node').count() >= 1, true, 'превью группы');
    const nodesBeforeGroup = await page.locator('.graph-node').count();
    await groupCard.getByRole('button', { name: 'Вставить группу', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('.node-status').innerText(), /Группа «.*» вставлена\./, 'статус вставки группы');
    assert.equal(await page.locator('.graph-node').count(), nodesBeforeGroup + 1, 'вставлен экземпляр группы');
    await openBrowse();
    await tabs('groups').click();
    const groupDelete = page.locator('.templates-card[data-template-kind="group"]').getByRole('button', { name: 'Удалить', exact: true });
    await groupDelete.click();
    await page.locator('.templates-card[data-template-kind="group"]').getByRole('button', { name: 'Точно удалить?', exact: true }).click();
    assert.equal(await page.evaluate(() => window.Presets.items('graph_group').length), 0, 'шаблон группы удалён');
    assert.match(await dialog.locator('[data-templates-empty]').innerText(), /Сгруппировать/, 'подсказка после удаления группы');
    await page.keyboard.press('Escape');

    // 13. Импортированный шаблон без координат раскладывается в превью сеткой.
    await page.evaluate(() => window.Presets.importUser({
      kind: 'graph_starter', id: 'user.no-position', name: 'Без координат', items: [
        { id: 'no-position', name: 'Без позиций', hint: 'Шаблон без координат', nodes: [
          { key: 'a', type: 'data.number' }, { key: 'b', type: 'rule.value' }], links: [['a', 'value', 'b', 'amount']] },
      ],
    }));
    await openBrowse();
    const noPosition = page.locator('.templates-card', { hasText: 'Без позиций' });
    await noPosition.waitFor();
    assert.equal(await noPosition.locator('.templates-preview-node').count(), 2, 'превью для шаблона без позиций');
    const boxes = await noPosition.locator('.templates-preview-node').evaluateAll(nodes => nodes.map(node => [node.getAttribute('x'), node.getAttribute('y')]));
    assert.notDeepEqual(boxes[0], boxes[1], 'узлы без координат не рисуются в одной точке');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // 14. Узкий экран: одна колонка и панель почти на всю ширину.
    await page.setViewportSize({ width: 600, height: 900 });
    await openBrowse();
    const narrow = await page.evaluate(() => {
      const panel = document.querySelector('[data-templates-panel]').getBoundingClientRect();
      return { left: panel.left, right: panel.right, width: panel.width,
        columns: getComputedStyle(document.querySelector('.templates-grid')).gridTemplateColumns.split(' ').length };
    });
    assert.ok(narrow.width > 575, `панель почти на всю ширину: ${narrow.width}`);
    assert.ok(narrow.left >= 7 && narrow.right <= 593, `панель в экране: ${narrow.left}–${narrow.right}`);
    assert.equal(narrow.columns, 1, 'на узком экране одна колонка');
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, [], 'страница без ошибок');
    console.log('PASS templates dialog: open/search/tabs/save/insert/delete/groups/Esc/overlay/focus');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
