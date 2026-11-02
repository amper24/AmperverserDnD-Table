// Точечный браузерный тест стола: несколько карт + активная карта + линейка
// с привязкой к сетке и со Ctrl. Страница собирается из static/ через page.route,
// сервер не нужен (WebSocket подменён очередью сообщений).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SCRIPTS = ['common', 'asset-kinds', 'table-model', 'table'];

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://table.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/static/')) {
        return route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), url.pathname)), contentType: 'text/javascript' });
      }
      if (url.pathname !== '/') return route.fulfill({ status: 404, body: 'not found', contentType: 'text/plain' });
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style><div id="wrap" style="width:1000px;height:800px"></div>' +
          SCRIPTS.map(name => `<script src="/static/${name}.js"></script>`).join(''),
      });
    });
    await page.goto('https://table.test/');
    await page.waitForFunction(() => !!window.Table && !!window.TableModel);

    const canvasBox = await page.evaluate(() => {
      // Сцена: две карты на слое map и один токен; камера — без сдвига, чтобы экран = мировые координаты.
      window.sent = [];
      window.confirmCalled = false;
      window.confirm = () => { window.confirmCalled = true; return true; };
      const scene = {
        id: 'scene-1', name: 'Тест', grid: { size: 70, type: 'square', visible: true, color: '#00000055', scale: '5 фт' },
        fog: { enabled: false, shapes: [] }, layers: null,
        items: [
          { id: 'map-a', layer: 'map', z: -100, data: { type: 'image', asset_id: 'a', x: 350, y: 350, w: 700, h: 700, name: 'Карта A' } },
          { id: 'map-b', layer: 'map', z: -100, data: { type: 'image', asset_id: 'b', x: 2000, y: 350, w: 700, h: 700, name: 'Карта B' } },
          { id: 'tok-1', layer: 'character', z: 0, data: { type: 'image', asset_id: 't', x: 350, y: 350, w: 70, h: 70, name: 'Герой' } },
        ],
      };
      Table.init({
        campaign: { id: 'camp-1', members: [] }, user: { id: 'u1', name: 'Мастер' }, isGM: true, scene,
        ws: { send: m => window.sent.push(JSON.parse(JSON.stringify(m))) },
        container: document.getElementById('wrap'), onOpenSheet: () => { }, onSelect: () => { }, onSceneChange: () => { },
      });
      const st = Table.state();
      st.cam.x = 0; st.cam.y = 0; st.cam.k = 1;
      const r = st.canvas.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });

    // ---- карты: две карты живут вместе, активная задаёт «Вписать» ----
    assert.deepEqual(await page.evaluate(() => Table.getMapItems().map(m => m.id)), ['map-a', 'map-b'], 'обе карты на слое map');
    assert.equal(await page.evaluate(() => Table.getActiveMapId()), null, 'две карты без выбора — активной нет, вписываем все');

    const fitAll = await page.evaluate(() => {
      Table.fitToMap();
      const st = Table.state();
      const b = TableModel.boardBounds(Table.getScene());
      return { cam: { x: st.cam.x, y: st.cam.y, k: st.cam.k }, expected: TableModel.fitView(b, { w: st.w, h: st.h }) };
    });
    for (const key of ['x', 'y', 'k']) assert.ok(Math.abs(fitAll.cam[key] - fitAll.expected[key]) < 1e-9, `без активной карты камера вписывает все (${key})`);

    const active = await page.evaluate(() => {
      Table.setActiveMap('map-b');
      Table.fitToMap();
      const st = Table.state();
      return {
        id: Table.getActiveMapId(),
        name: Table.getActiveMap().data.name,
        cam: { x: st.cam.x, y: st.cam.y, k: st.cam.k },
        expected: TableModel.fitView(TableModel.boundsOf(Table.getActiveMap()), { w: st.w, h: st.h }),
        sent: window.sent.filter(m => m.type === 'scene_update' && m.active_map_id === 'map-b').length,
      };
    });
    assert.equal(active.id, 'map-b', 'активная карта выбрана');
    assert.equal(active.name, 'Карта B');
    assert.ok(active.sent >= 1, 'выбор активной карты уходит на сервер как часть сцены');
    for (const key of ['x', 'y', 'k']) assert.ok(Math.abs(active.cam[key] - active.expected[key]) < 1e-9, `fitToMap вписывает активную карту (${key})`);

    // Одна карта в старой сцене — активная по умолчанию (совместимость).
    assert.equal(await page.evaluate(() => Table.setScene({ id: 'old', grid: { size: 70 }, fog: {}, items: [{ id: 'only-map', layer: 'map', data: { x: 100, y: 100, w: 700, h: 700 } }] }) || Table.getActiveMapId()), 'only-map');

    // ---- на слой map можно бросить ещё карту: старая не заменяется и не спрашиваем подтверждение ----
    const dropped = await page.evaluate(() => {
      const st = Table.state();
      const dt = new DataTransfer();
      dt.setData('application/x-asset', JSON.stringify({ id: 'asset-map-3', kind: 'map', name: 'Карта C', width: 700, height: 700 }));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'offsetX', { value: 300 });
      Object.defineProperty(ev, 'offsetY', { value: 300 });
      window.sent = [];
      st.canvas.dispatchEvent(ev);
      const upsert = window.sent.find(m => m.type === 'item_upsert');
      return { confirmCalled: window.confirmCalled, upsert, deletes: window.sent.filter(m => m.type === 'item_delete').length, maps: Table.getMapItems().length, sceneUpdate: window.sent.find(m => m.type === 'scene_update') };
    });
    assert.equal(dropped.confirmCalled, false, 'карту больше не «заменяют» с подтверждением');
    assert.equal(dropped.deletes, 0, 'старые карты не удаляются');
    assert.equal(dropped.upsert.item.layer, 'map', 'новая карта кладётся на слой map');
    assert.equal(dropped.upsert.item.data.w, 700);
    assert.ok(/^[0-9a-f]{32}$/.test(dropped.upsert.item.id), 'у новой карты есть id для выбора активной');
    assert.equal(dropped.sceneUpdate.active_map_id, dropped.upsert.item.id, 'новая карта сразу становится активной');
    assert.equal(dropped.maps, 1, 'локальный список карт не трогаем — ждём рассылку сервера');

    // ---- слои сцены: добавление уходит на сервер и доступно в селекторе ----
    const layersOut = await page.evaluate(() => {
      window.sent = [];
      const next = TableModel.addLayer(Table.getLayers(), 'Декорации');
      Table.setLayers(next);
      return { list: Table.getLayers(), sent: window.sent.filter(m => m.type === 'scene_update' && m.layers) };
    });
    assert.equal(layersOut.list.length, 9);
    assert.deepEqual(layersOut.list[8], { id: 'custom-1', name: 'Декорации', order: 8, hidden: false, locked: false });
    assert.equal(layersOut.sent.length, 1, 'слои синхронизируются как часть сцены');
    assert.equal(layersOut.sent[0].layers.length, 9);

    // ---- линейка: привязка к сетке и свободный режим по Ctrl ----
    // Бросок карты сам «вписывает» камеру — ставим её 1:1, чтобы экран = мировые координаты.
    await page.waitForTimeout(150);
    await page.evaluate(() => { const st = Table.state(); st.cam.x = 0; st.cam.y = 0; st.cam.k = 1; });
    await page.keyboard.press('r');
    assert.equal(await page.evaluate(() => Table.state().tool), 'ruler', 'линейка выбрана клавишей R');
    await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 281, canvasBox.y + 349, { steps: 4 });
    const snapped = await page.evaluate(() => Table.state().temp.points.map(p => p.slice()));
    assert.deepEqual(snapped, [[70, 70], [280, 350]], 'без Ctrl концы линейки притянуты к сетке');

    await page.keyboard.down('Control');
    const free = await page.evaluate(() => Table.state().temp.points.map(p => p.slice()));
    assert.deepEqual(free, [[100, 100], [281, 349]], 'с зажатым Ctrl линейка свободная (пересчёт без движения мыши)');
    await page.keyboard.up('Control');
    const resnapped = await page.evaluate(() => Table.state().temp.points.map(p => p.slice()));
    assert.deepEqual(resnapped, [[70, 70], [280, 350]], 'после отпускания Ctrl линия снова привязана');

    const label = await page.evaluate(() => TableModel.rulerLabel(Table.state().temp.points, Table.getScene().grid, Table.state().gridScaleFt));
    assert.equal(label, '20 фт (4 кл.)', 'подпись линейки показывает футы и клетки');

    await page.mouse.up();
    await page.waitForTimeout(100);
    const afterUp = await page.evaluate(() => ({ temp: Table.state().temp, sent: window.sent.slice() }));
    assert.equal(afterUp.temp, null, 'после отпускания линейка завершается');
    assert.ok(afterUp.sent.some(m => m.type === 'ruler' && m.points === null), 'линейка убирается у всех');

    // ---- туман войны: маска на карту, инструменты, отмена, предпросмотр ----
    const fogScene = await page.evaluate(() => {
      window.sent = [];
      Table.setScene({
        id: 'scene-fog', name: 'Туман', grid: { size: 70, type: 'square', visible: true, color: '#00000055', scale: '5 фт' },
        // Старый формат: shapes глобальные — при загрузке должны переехать в маску активной карты.
        active_map_id: 'map-a',
        fog: { enabled: false, shapes: [{ shape: 'rect', mode: 'reveal', points: [[100, 100], [200, 200]] }] },
        items: [
          { id: 'map-a', layer: 'map', z: -100, data: { type: 'image', asset_id: 'a', x: 350, y: 350, w: 700, h: 700, name: 'Карта A' } },
          { id: 'map-b', layer: 'map', z: -100, data: { type: 'image', asset_id: 'b', x: 2000, y: 350, w: 700, h: 700, name: 'Карта B' } },
        ],
      });
      const st = Table.state(); st.cam.x = 0; st.cam.y = 0; st.cam.k = 1;
      const r = st.canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, maps: Object.keys(Table.getFog().by_map), mask: Table.getFogMask('map-a').length };
    });
    assert.deepEqual(fogScene.maps, ['map-a'], 'старый fog.shapes мигрировал в маску активной карты');
    assert.equal(fogScene.mask, 1);
    assert.equal(await page.evaluate(() => 'shapes' in Table.getFog()), false, 'после миграции старого поля нет');

    await page.keyboard.press('f');
    assert.equal(await page.evaluate(() => Table.state().tool), 'fog', 'F включает туман');
    assert.equal(await page.locator('[data-fog="tool-brush"]').count(), 1, 'панель тумана: кисть');
    assert.equal(await page.locator('[data-fog="players"]').isChecked(), false, 'игрокам туман по умолчанию не показан');

    // Предпросмотр под курсором: кружок кисти следует за мышью, мазка ещё нет.
    await page.mouse.move(canvasBox.x + 250, canvasBox.y + 250);
    const preview = await page.evaluate(() => {
      const st = Table.state();
      return { hover: st.hover, temp: st.temp, tool: st.fogTool, cells: st.fogCells, width: TableModel.fogBrushWidth(st.fogCells, st.scene.grid.size), hint: st.hint.textContent };
    });
    assert.deepEqual(preview.hover, { x: 250, y: 250 }, 'предпросмотр следует за курсором');
    assert.equal(preview.temp, null, 'до нажатия мазка нет');
    assert.deepEqual([preview.tool, preview.cells, preview.width], ['brush', 3, 210], 'кисть 3 клетки = 210 px');
    assert.ok(preview.hint.includes('кисть') && preview.hint.includes('фигур 1/200'), 'подсказка показывает инструмент и число фигур');

    // Кисть: протяжка по карте A.
    await page.mouse.move(canvasBox.x + 250, canvasBox.y + 250);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 420, canvasBox.y + 330, { steps: 6 });
    await page.mouse.up();
    const brushed = await page.evaluate(() => {
      const mask = Table.getFogMask('map-a');
      const fogSent = window.sent.filter(m => m.type === 'scene_update' && m.fog);
      return { mask, enabled: Table.getFog().enabled, sent: fogSent.length, last: fogSent[fogSent.length - 1]?.fog };
    });
    assert.equal(brushed.mask.length, 2, 'мазок добавился к мигрировавшей фигуре');
    assert.equal(brushed.mask[1].shape, 'path');
    assert.equal(brushed.mask[1].mode, 'reveal');
    assert.equal(brushed.mask[1].width, 210, 'ширина мазка — размер кисти');
    assert.equal(brushed.enabled, true, 'мазок включает «Показать игрокам»');
    assert.ok(brushed.sent >= 1 && brushed.last?.by_map?.['map-a'].shapes.length === 2, 'маска уходит в scene_update');

    // Прямоугольник: кнопка панели + протяжка.
    await page.click('[data-fog="tool-rect"]');
    assert.equal(await page.evaluate(() => Table.state().fogTool), 'rect', 'кнопка панели выбирает прямоугольник');
    await page.mouse.move(canvasBox.x + 500, canvasBox.y + 400);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 650, canvasBox.y + 500, { steps: 4 });
    await page.mouse.up();
    const rected = await page.evaluate(() => Table.getFogMask('map-a'));
    assert.equal(rected.length, 3);
    assert.equal(rected[2].shape, 'rect');
    assert.deepEqual(rected[2].points.map(p => p.map(Math.round)), [[500, 400], [650, 500]], 'прямоугольник по протяжке');

    // Ctrl+Z отменяет последний мазок (прямоугольник).
    await page.evaluate(() => { window.sent = []; });
    await page.keyboard.press('Control+z');
    const undone = await page.evaluate(() => ({ mask: Table.getFogMask('map-a'), sent: window.sent.filter(m => m.type === 'scene_update' && m.fog).length }));
    assert.equal(undone.mask.length, 2, 'Ctrl+Z отменил прямоугольник');
    assert.equal(undone.mask[1].shape, 'path');
    assert.ok(undone.sent >= 1, 'отмена тоже синхронизируется');

    // Переключение карты: у каждой карты своя маска.
    await page.evaluate(() => {
      Table.setActiveMap('map-b');
      const st = Table.state(); st.cam.x = -1650; st.cam.y = 0; st.cam.k = 1;
      window.sent = [];
    });
    const onB = await page.evaluate(() => ({ b: Table.getFogMask('map-b').length, a: Table.getFogMask('map-a').length, hint: Table.state().hint.textContent, checked: document.querySelector('[data-fog="players"]').checked }));
    assert.equal(onB.b, 0, 'у карты B своя (пустая) маска');
    assert.equal(onB.a, 2, 'маска карты A не изменилась');
    assert.ok(onB.hint.includes('Карта B') && onB.hint.includes('фигур 0/200'), 'панель показывает маску активной карты');
    assert.equal(onB.checked, true, 'галочка «Показать игрокам» — общий флаг сцены (его включил мазок)');

    // Кисть по карте B (после прямоугольника на карте A инструмент снова кисть).
    await page.click('[data-fog="tool-brush"]');
    assert.equal(await page.evaluate(() => Table.state().fogTool), 'brush', '1 — кисть (кнопка панели)');
    await page.mouse.move(canvasBox.x + 150, canvasBox.y + 200);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 300, canvasBox.y + 260, { steps: 5 });
    await page.mouse.up();
    // Прямоугольник, выходящий за правую границу карты B (граница — мир x=2350).
    await page.click('[data-fog="tool-rect"]');
    await page.mouse.move(canvasBox.x + 550, canvasBox.y + 300);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 750, canvasBox.y + 400, { steps: 4 });
    await page.mouse.up();
    const onB2 = await page.evaluate(() => {
      const mask = Table.getFogMask('map-b');
      const b = TableModel.boundsOf(Table.getActiveMap());
      const fog = Table.getFog();
      return {
        mask, b,
        inside: TableModel.isRevealed(fog, 'map-b', 1750, 220, b),
        outsideMap: TableModel.isRevealed(fog, 'map-b', 2500, 350, b),
      };
    });
    assert.equal(onB2.mask.length, 2, 'мазок и прямоугольник на карте B');
    assert.deepEqual(onB2.mask[1].points.map(p => p.map(Math.round)), [[2200, 300], [2350, 400]], 'фигура обрезана по правой границе карты B');
    assert.equal(onB2.inside, true, 'мазок открывает точку внутри карты');
    assert.equal(onB2.outsideMap, false, 'за границей карты маски нет');

    // Фигура целиком вне карты не добавляется.
    await page.mouse.move(canvasBox.x + 400, canvasBox.y + 100); // мир x=2050 — внутри
    await page.mouse.move(canvasBox.x + 780, canvasBox.y + 620); // мир x=2430, y=620 — вне карты B
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 850, canvasBox.y + 680, { steps: 3 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => Table.getFogMask('map-b').length), 2, 'фигура вне карты не создаёт эффекта');

    // «Открыть всё» по активной карте.
    await page.click('[data-fog="all"]');
    const allB = await page.evaluate(() => {
      const mask = Table.getFogMask('map-b'), b = TableModel.boundsOf(Table.getActiveMap()), fog = Table.getFog();
      return { mask, b, center: TableModel.isRevealed(fog, 'map-b', 2000, 350, b), outside: TableModel.isRevealed(fog, 'map-b', 2400, 350, b) };
    });
    assert.equal(allB.mask.length, 1);
    assert.deepEqual(allB.mask[0].points.map(p => p.map(Math.round)), [[1650, 0], [2350, 700]], 'прямоугольник по границам карты B');
    assert.equal(allB.center, true, 'вся карта открыта');
    assert.equal(allB.outside, false, 'за картой по-прежнему скрыто');

    // «Показать игрокам» снимается — маска остаётся, но игроки её не видят.
    await page.locator('[data-fog="players"]').uncheck();
    const hidden = await page.evaluate(() => ({ enabled: Table.getFog().enabled, sent: window.sent.filter(m => m.type === 'scene_update' && m.fog).slice(-1)[0]?.fog.enabled, mask: Table.getFogMask('map-b').length }));
    assert.equal(hidden.enabled, false);
    assert.equal(hidden.sent, false, 'признак уходит на сервер');
    assert.equal(hidden.mask, 1, 'сама маска не пропала');

    // Возврат на карту A: маска сохранилась, подсказка снова про неё.
    await page.evaluate(() => { Table.setActiveMap('map-a'); const st = Table.state(); st.cam.x = 0; st.cam.y = 0; st.cam.k = 1; });
    const backA = await page.evaluate(() => ({ mask: Table.getFogMask('map-a').length, hint: Table.state().hint.textContent }));
    assert.equal(backA.mask, 2, 'маска карты A на месте');
    assert.ok(backA.hint.includes('Карта A'), 'панель переключилась на карту A');

    assert.deepEqual(errors, []);
    console.log('PASS table browser: несколько карт + активная + fitToMap, слои сцены, линейка (сетка/Ctrl), туман (маска на карту, кисть/прямоугольник, Ctrl+Z, предпросмотр)');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
