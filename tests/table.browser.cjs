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

    assert.deepEqual(errors, []);
    console.log('PASS table browser: несколько карт + активная + fitToMap, слои сцены, линейка (сетка/Ctrl)');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
