// Браузерный тест холста редактора нод (Chromium): зум, панорама, рамка, группы, ПКМ-меню,
// типизированные провода, переподключение и удаление связей, сохранение без вида.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const MODULES = ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets-data', 'mechanics-graph', 'asset-kinds', 'modules'];

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://node-editor.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>' + MODULES.map(name => `<script src="/static/${name}.js"></script>`).join('') });
    });
    await page.goto('https://node-editor.test/');
    await page.evaluate(() => {
      window.doc = Modules.newItem({ name: 'Холст', type: 'feature', mechanics: { version: 2, origin: 'test', graph: {
        nodes: [
          { id: 'a', type: 'data.number', params: { value: 5 }, position: { x: 80, y: 80 } },
          { id: 'b', type: 'rule.speed', params: { value: 30 }, position: { x: 420, y: 80 } },
          { id: 'c', type: 'condition.level', params: { min: 1, max: 20 }, position: { x: 80, y: 320 } },
          { id: 'd', type: 'flow.if', params: {}, position: { x: 420, y: 320 } },
          { id: 'e', type: 'data.number', params: { value: 7 }, position: { x: 80, y: 540 } },
        ], links: [], frames: [], groups: [] } } }); Modules.editItem(window.doc);
    });
    await page.locator('.node-editor').waitFor();
    const canvas = page.locator('.node-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const world = page.locator('.node-world');
    const transform = () => world.evaluate(el => el.style.transform);
    const linkCount = () => page.evaluate(() => document.querySelector('.node-editor').getGraph().links.length);
    const linkOf = () => page.evaluate(() => document.querySelector('.node-editor').getGraph().links.map(l => `${l.from.node}.${l.from.socket}->${l.to.node}.${l.to.socket}`));
    const socket = (node, dir, name) => page.locator(`.node-socket[data-node="${node}"][data-dir="${dir}"][data-socket="${name}"]`);
    const center = async loc => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const pos = id => page.evaluate(id => document.querySelector('.node-editor').getGraph().nodes.find(n => n.id === id).position, id);
    const dragWire = async (from, to) => { const p = await center(from), q = await center(to); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 8 }); await page.mouse.up(); };
    const statusText = () => page.locator('.node-status').textContent();

    // 1. Зум колёсиком у курсора.
    const before = transform();
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(50);
    assert.notEqual(await transform(), before, 'колесо меняет масштаб');
    assert.match(await transform(), /scale\((1\.\d+|[2-9])/, 'колесо вверх увеличивает');
    await page.mouse.wheel(0, 200); await page.mouse.wheel(0, 200);

    // 2. Панорама средней кнопкой.
    const t0 = transform();
    await page.mouse.move(box.x + 600, box.y + 500);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + 680, box.y + 540, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    assert.notEqual(await transform(), t0, 'средняя кнопка двигает полотно');

    // 3. ПКМ на пустом месте: меню с поиском и категориями, узел появляется у курсора.
    await page.mouse.click(box.x + 600, box.y + 700, { button: 'right' }); // пустое место: карточки с полями выше, чем раньше
    await page.locator('.node-menu').waitFor();
    assert.equal(await page.locator('.node-menu-search').evaluate(el => document.activeElement === el), true, 'поиск получает фокус');
    const titles = await page.locator('.node-menu-title').allTextContents();
    for (const title of ['Данные', 'Условия', 'Поток управления', 'Бой', 'Эффекты', 'Ресурсы', 'Персонаж']) assert.ok(titles.includes(title), `категория «${title}»`);
    await page.locator('.node-menu-search').fill('уровень');
    const filtered = await page.locator('.node-menu-title').allTextContents();
    assert.deepEqual(filtered, ['Условия'], 'поиск оставляет подходящую категорию');
    await page.locator('.node-menu-item', { hasText: 'Если уровень' }).click();
    await page.locator('.node-menu').waitFor({ state: 'detached' });
    const added = await page.evaluate(() => document.querySelector('.node-editor').getGraph().nodes.at(-1));
    assert.equal(added.type, 'condition.level', 'узел из меню добавлен');
    assert.ok(added.position.x > 0 && added.position.y > 0, 'позиция узла задана');
    await page.keyboard.press('Escape').catch(() => {});

    // Сбрасываем вид к известной точке: зум и панорама в граф не сохраняются.
    const doc = await page.evaluate(() => JSON.stringify(document.querySelector('.node-editor').getGraph()));
    assert.ok(!/"view"|"zoom"|"scale"/.test(doc), 'вид не попадает в схему');

    // 4. Рамочное выделение: узлы a и b.
    await page.mouse.click(box.x + 20, box.y + 20); // снять выделение пустым кликом
    const pa = await center(page.locator('.graph-node[data-node-id="a"] .graph-node-head b')), pb = await center(page.locator('.graph-node[data-node-id="b"] .graph-node-head b'));
    await page.mouse.move(Math.min(pa.x, pb.x) - 60, Math.min(pa.y, pb.y) - 40);
    await page.mouse.down();
    await page.mouse.move(Math.max(pa.x, pb.x) + 60, Math.max(pa.y, pb.y) + 40, { steps: 6 });
    await page.mouse.up();
    const selected = await page.locator('.graph-node.selected').evaluateAll(list => list.map(n => n.dataset.nodeId).sort());
    assert.ok(selected.includes('a') && selected.includes('b'), `рамка выделяет a и b, выбрано: ${selected}`);

    // 5. Перемещение выбранной группы за тело узла (не за шапку).
    const aBefore = (await pos('a')).x, bBefore = (await pos('b')).x;
    const body = await center(page.locator('.graph-node[data-node-id="a"] .node-id'));
    await page.mouse.move(body.x, body.y); await page.mouse.down(); await page.mouse.move(body.x + 60, body.y + 30, { steps: 6 }); await page.mouse.up();
    assert.ok((await pos('a')).x > aBefore + 20, 'тело узла перетаскивается');
    assert.ok((await pos('b')).x > bBefore + 20, 'вместе с ним двигается второй выбранный узел');

    // 6. Типизированные связи: число → число разрешено, число → условие (bool) отклоняется.
    await page.mouse.click(box.x + 20, box.y + 20);
    await page.locator('.graph-node[data-node-id="a"]').click();
    const outA = socket('a', 'outputs', 'value');
    const inB = socket('b', 'inputs', 'value');
    const inD = socket('d', 'inputs', 'condition');
    const p = await center(outA);
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    const q = await center(inB);
    await page.mouse.move(q.x, q.y, { steps: 6 });
    const compatibleInputs = await page.locator('.node-socket.compatible').evaluateAll(list => list.map(s => `${s.dataset.node}.${s.dataset.socket}`));
    assert.ok(compatibleInputs.includes('b.value'), `подсвечен совместимый вход: ${compatibleInputs}`);
    assert.ok(!compatibleInputs.includes('d.condition'), 'несовместимый вход не подсвечен');
    await page.mouse.up();
    assert.deepEqual(await linkOf(), ['a.value->b.value'], 'связь number→number создана');

    await dragWire(outA, inD);
    assert.equal(await linkCount(), 1, 'связь number→bool отклонена движком');
    assert.match(await statusText(), /тип|несовмест/i, 'пользователь видит причину отказа');

    // 7. Провод ведёт к точке реального сокета (кружку), а не к шапке узла.
    await page.waitForTimeout(120); // провод пересчитывается в следующем кадре после перерисовки
    const wirePath = await page.locator('.node-world .node-wire').first().getAttribute('d');
    const nums = wirePath.trim().split(/[\s,]+/).map(Number), endX = nums.at(-2), endY = nums.at(-1);
    const dot = await center(inB.locator('i'));
    const cb = await canvas.boundingBox(), tr = (await transform()).match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/), k = Number((await transform()).match(/scale\(([\d.]+)\)/)[1]);
    const wantX = (dot.x - cb.x - Number(tr[1])) / k, wantY = (dot.y - cb.y - Number(tr[2])) / k;
    assert.ok(Math.abs(endX - wantX) < 3 && Math.abs(endY - wantY) < 3, `конец провода в точке сокета: (${endX.toFixed(1)}, ${endY.toFixed(1)}) vs (${wantX.toFixed(1)}, ${wantY.toFixed(1)})`);

    // 8. Переподключение: вход b.value перетаскиваем с a на второе число e — связь переходит к e.
    await dragWire(inB, socket('e', 'outputs', 'value'));
    assert.deepEqual(await linkOf(), ['e.value->b.value'], 'подключённый вход переподключён к другому выходу того же типа');
    // Неверный тип при переподключении: вход b возвращает прежнюю связь, если бросок отклонён.
    await dragWire(inB, socket('c', 'outputs', 'value'));
    assert.deepEqual(await linkOf(), ['e.value->b.value'], 'бросок на несовместимый выход откатывает связь');
    // Условие: bool → условие flow.if, затем отвод провода на пустое место удаляет связь.
    await dragWire(socket('c', 'outputs', 'value'), inD);
    assert.deepEqual(await linkOf(), ['e.value->b.value', 'c.value->d.condition'], 'bool → условие создано');
    // Ищем пустую точку от правого нижнего угла холста: карточки с полями занимают больше места, чем раньше.
    const cvs = await canvas.boundingBox();
    const empty = await page.evaluate(([x0, y0]) => {
      for (let y = y0; y > y0 - 500; y -= 16) for (let x = x0; x > x0 - 700; x -= 16) {
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.closest('.graph-node, .node-menu, .node-wires, .node-frame, .node-toolbar, .node-starters')) return { x, y };
      }
      return null;
    }, [cvs.x + cvs.width - 24, cvs.y + cvs.height - 24]);
    assert.ok(empty, 'на холсте есть пустая точка для отвода провода');
    assert.ok(await page.evaluate(([x, y]) => !document.elementFromPoint(x, y)?.closest('.graph-node, .node-menu'), [empty.x, empty.y]), 'точка отвода действительно пустая');
    const cond = await center(socket('d', 'inputs', 'condition'));
    await page.mouse.move(cond.x, cond.y); await page.mouse.down(); await page.mouse.move(empty.x, empty.y, { steps: 6 }); await page.mouse.up();
    assert.deepEqual(await linkOf(), ['e.value->b.value'], 'подключённый вход брошен на пустое место — провод удалён');

    // 9. Удаление провода кликом по линии.
    // Реальный клик мышью по свободной точке зоны попадания; если линия целиком под карточками — событие click на самой зоне.
    const onLine = await page.locator('.node-world .node-wire-hit').first().evaluate(path => {
      const m = path.getScreenCTM(), len = path.getTotalLength();
      for (let i = 1; i < 40; i++) {
        const pt = path.getPointAtLength((len * i) / 40);
        const x = m.a * pt.x + m.c * pt.y + m.e, y = m.b * pt.x + m.d * pt.y + m.f;
        if (document.elementFromPoint(x, y) === path) return { x, y };
      }
      return null;
    });
    if (onLine) await page.mouse.click(onLine.x, onLine.y);
    else await page.locator('.node-world .node-wire-hit').first().dispatchEvent('click');
    assert.equal(await linkCount(), 0, 'клик по проводу удаляет связь');

    // 10. Группа из выделения: Ctrl+клик выбирает c и d, ПКМ по узлу → «Сгруппировать выделенное».
    await page.locator('.graph-node[data-node-id="c"] .node-id').click();
    await page.locator('.graph-node[data-node-id="d"] .node-id').click({ modifiers: ['Control'] });
    await page.locator('.graph-node[data-node-id="d"] .node-id').click({ button: 'right' });
    await page.locator('.node-menu-item', { hasText: 'Сгруппировать выделенное' }).click();
    const graphNow = await page.evaluate(() => document.querySelector('.node-editor').getGraph());
    assert.equal(graphNow.groups.length, 1, 'выделение превращено в группу');
    assert.ok(graphNow.nodes.some(n => n.type === 'group.instance'), 'вместо выделения появился экземпляр группы');
    assert.ok(!graphNow.nodes.some(n => n.id === 'c' || n.id === 'd'), 'узлы группы убраны с полотна и лежат внутри группы');

    // 11. Неполный граф не блокирует связи; статус показывает незавершённость.
    await page.locator('.node-editor').focus();
    await page.keyboard.press('Escape'); // сбрасывает одноразовое сообщение, остаётся статус незавершённости
    assert.match(await statusText(), /не исполняется/i, 'незавершённый граф показан списком в статусе');
    assert.deepEqual(errors, [], 'нет ошибок страницы');
    console.log('PASS node editor browser: zoom, middle pan, context search menu, marquee, group move, typed wires, reconnect, detach, wire anchors, view not saved');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error('FAIL node editor browser:', error.message); process.exit(1); });
