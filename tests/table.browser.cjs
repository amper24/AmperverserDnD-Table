// Точечный браузерный тест стола: несколько карт + активная карта + линейка
// с привязкой к сетке и со Ctrl. Страница собирается из static/ через page.route,
// сервер не нужен (WebSocket подменён очередью сообщений).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SCRIPTS = ['core/common', 'core/asset-kinds', 'table/table-model', 'table/table'];

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
    // Камера 1:1, чтобы бросок в (300,300) экрана попал в известную мировую точку.
    await page.evaluate(() => { const st = Table.state(); st.cam.x = 0; st.cam.y = 0; st.cam.k = 1; Table.requestDraw(); });
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
      const item = upsert.item;
      return {
        confirmCalled: window.confirmCalled, upsert, item,
        deletes: window.sent.filter(m => m.type === 'item_delete').length,
        maps: Table.getMapItems().length,
        inScene: !!Table.getScene().items.find(i => i.id === item.id),
        name: Table.getScene().items.find(i => i.id === item.id)?.data.name,
        pending: [...Table.state().pending],
        sceneUpdate: window.sent.find(m => m.type === 'scene_update'),
      };
    });
    assert.equal(dropped.confirmCalled, false, 'карту больше не «заменяют» с подтверждением');
    assert.equal(dropped.deletes, 0, 'старые карты не удаляются');
    assert.equal(dropped.item.layer, 'map', 'новая карта кладётся на слой map');
    assert.equal(dropped.item.data.w, 700, 'карта занимает пиксели картинки, а не одну клетку');
    assert.ok(/^[0-9a-f]{32}$/.test(dropped.item.id), 'у новой карты есть id для выбора активной');
    // Причина, по которой карты не появлялись: клиент присылал готовый id, а сервер считал
    // «id есть, строки нет» запоздавшим движением удалённого токена и молча отбрасывал.
    assert.equal(dropped.item.create, true, 'создание карты помечено create:true');
    assert.equal(dropped.inScene, true, 'карта видна сразу, не дожидаясь рассылки сервера');
    assert.equal(dropped.name, 'Карта C', 'имя ассета переносится на карту (видно в «Картах сцены»)');
    assert.deepEqual(dropped.pending, [dropped.item.id], 'карта ждёт подтверждения сервера');
    assert.equal(dropped.sceneUpdate, undefined, 'карта — обычный объект: активной автоматически не становится');
    assert.equal(dropped.maps, 2, 'локальный список карт: новая карта рядом со старой');
    const mapId = dropped.item.id;
    assert.notEqual(await page.evaluate(() => Table.getActiveMapId()), mapId, 'активная карта не сменилась сама');
    assert.equal(await page.evaluate(() => Table.getScene().active_map_id), undefined, 'scene.active_map_id не выставлен');

    // Карта реально рисуется на канве: камера 1:1, точка внутри карты (вне линий сетки) — не пустая.
    const mapPixels = await page.evaluate(async () => {
      const st = Table.state();
      st.cam.x = 0; st.cam.y = 0; st.cam.k = 1;
      const m = Table.getMapItems().find(i => i.id !== 'only-map');
      const b = TableModel.boundsOf(m);
      const read = (wx, wy) => {
        const d = st.ctx2d.getImageData(Math.round(wx * devicePixelRatio), Math.round(wy * devicePixelRatio), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      // Стираем прошлый кадр: иначе пиксель мог бы остаться от прежней камеры и проверка
      // «внутри/снаружи» ничего не доказывала. Дальше ждём настоящий кадр (rAF).
      st.ctx2d.save();
      st.ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      st.ctx2d.clearRect(0, 0, st.canvas.width, st.canvas.height);
      st.ctx2d.restore();
      const insideAt = () => read(b.x + b.w / 2 + 20, b.y + b.h / 2 + 20);
      let inside = insideAt();
      for (let i = 0; i < 40 && inside[3] === 0; i++) {
        Table.requestDraw();
        await new Promise(r => setTimeout(r, 50));
        inside = insideAt();
      }
      return { bounds: b, inside, outside: read(b.x + b.w + 40, b.y + b.h + 40) };
    });
    assert.ok(mapPixels.inside[0] > 30 && mapPixels.inside[0] < 80 && mapPixels.inside[3] > 0,
      `внутри карты канва не пустая (${mapPixels.inside}) — карта нарисована (без картинки — заглушкой)`);
    assert.equal(mapPixels.outside[3], 0, 'за пределами карты по-прежнему пусто');

    // ---- карту можно выделить и тащить только на слое «Карта» ----
    // Точка — в правом нижнем углу новой карты: там её не перекрывает старая карта (у той z=0).
    const mapCenter = await page.evaluate(() => {
      const st = Table.state(); st.cam.x = 0; st.cam.y = 0; st.cam.k = 1; st.tool = 'select'; Table.requestDraw();
      const b = TableModel.boundsOf(Table.getMapItems().find(i => i.id !== 'only-map'));
      return { x: b.x + b.w - 40, y: b.y + b.h - 40 };
    });
    const cb2 = await page.evaluate(() => { const r = Table.state().canvas.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await page.evaluate(() => Table.setActiveLayer('character'));
    await page.mouse.click(cb2.x + mapCenter.x, cb2.y + mapCenter.y);
    const onOtherLayer = await page.evaluate(id => ({ sel: Table.state().sel, set: [...Table.state().selSet], x: Table.getScene().items.find(i => i.id === id).data.x }), mapId);
    assert.deepEqual([onOtherLayer.sel, onOtherLayer.set], [null, []], 'на другом слое клик по карте не перехватывается');

    await page.evaluate(() => Table.setActiveLayer('map'));
    await page.mouse.click(cb2.x + mapCenter.x, cb2.y + mapCenter.y);
    assert.deepEqual(await page.evaluate(() => [...Table.state().selSet]), [mapId], 'на слое «Карта» карта выделяется');

    const beforeMove = await page.evaluate(id => { const d = Table.getScene().items.find(i => i.id === id).data; return { x: d.x, y: d.y }; }, mapId);
    await page.evaluate(() => { window.sent = []; });
    await page.mouse.move(cb2.x + mapCenter.x, cb2.y + mapCenter.y);
    await page.mouse.down();
    await page.mouse.move(cb2.x + mapCenter.x + 90, cb2.y + mapCenter.y + 60, { steps: 6 });
    await page.mouse.up();
    const movedMap = await page.evaluate(id => {
      const d = Table.getScene().items.find(i => i.id === id).data;
      const ups = window.sent.filter(m => m.type === 'item_upsert' && m.item.id === id);
      return { x: d.x, y: d.y, ups: ups.length, create: ups.some(m => m.item.create === true) };
    }, mapId);
    assert.notEqual(movedMap.x, beforeMove.x, 'карта сдвинулась на слое «Карта»');
    assert.equal(movedMap.ups, 1, 'движение карты уходит на сервер');
    assert.equal(movedMap.create, false, 'движение не помечается созданием (защита от «воскрешения» удалённого)');

    // ---- удаление одной карты не трогает остальные ----
    await page.evaluate(() => { window.sent = []; });
    await page.keyboard.press('Delete');
    const deleted = await page.evaluate(id => ({
      ids: window.sent.filter(m => m.type === 'item_delete').map(m => m.id),
      sel: Table.state().sel,
    }), mapId);
    assert.deepEqual(deleted.ids, [mapId], 'Delete удаляет только выбранную карту');
    assert.equal(deleted.sel, null, 'выделение снято');
    // Подтверждение сервера: ушла одна карта, вторая на месте.
    const afterDelete = await page.evaluate(id => {
      Table.onMessage({ type: 'item_delete', scene_id: Table.getScene().id, id });
      return Table.getMapItems().map(m => m.id);
    }, mapId);
    assert.deepEqual(afterDelete, ['only-map'], 'вторая карта не потерялась');

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
    assert.deepEqual(snapped, [[105, 105], [315, 315]], 'без Ctrl концы линейки притянуты к центрам клеток');

    await page.keyboard.down('Control');
    const free = await page.evaluate(() => Table.state().temp.points.map(p => p.slice()));
    assert.deepEqual(free, [[100, 100], [281, 349]], 'с зажатым Ctrl линейка свободная (пересчёт без движения мыши)');
    await page.keyboard.up('Control');
    const resnapped = await page.evaluate(() => Table.state().temp.points.map(p => p.slice()));
    assert.deepEqual(resnapped, [[105, 105], [315, 315]], 'после отпускания Ctrl линия снова привязана к центрам');

    const label = await page.evaluate(() => TableModel.rulerLabel(Table.state().temp.points, Table.getScene().grid, Table.state().gridScaleFt));
    assert.equal(label, '15 фт (3 кл.)', 'подпись линейки показывает футы и клетки');

    await page.mouse.up();
    await page.waitForTimeout(100);
    const afterUp = await page.evaluate(() => ({ temp: Table.state().temp, sent: window.sent.slice() }));
    assert.equal(afterUp.temp, null, 'после отпускания линейка завершается');
    assert.ok(afterUp.sent.some(m => m.type === 'ruler' && m.points === null), 'линейка убирается у всех');

    // ---- сетка «соты» на большой карте: видимый диапазон, кэш, coalescing ----
    // До оптимизации 200×200 при вписывании рисовала ~60 000 гексов в каждом кадре
    // (≈422 000 вызовов path и 10 с на кадр в headless Chromium).
    const hexPerf = await page.evaluate(async () => {
      Table.setScene({
        id: 'scene-hex', name: 'Соты', grid: { size: 70, type: 'hex', visible: true, color: '#00000055', scale: '5 фт' },
        active_map_id: 'big', fog: { enabled: false, by_map: {} },
        items: [{ id: 'big', layer: 'map', z: -100, data: { type: 'image', asset_id: 'a', x: 7000, y: 7000, w: 14000, h: 14000, name: '200×200' } }],
      });
      Table.fitToMap();
      // Даём кэшу построиться (один кадр), затем меряем только устоявшиеся кадры.
      await new Promise(r => setTimeout(r, 400));
      const built = Table.gridStats();
      Table.resetGridStats();
      // Кадры идут по требованию: для замера просим их 500 мс подряд.
      const force = setInterval(() => Table.requestDraw(), 5);
      await new Promise(r => setTimeout(r, 500));
      clearInterval(force);
      const st = Table.state();
      const stats = Table.gridStats();
      const range = TableModel.hexVisibleRange(
        (0 - st.cam.x) / st.cam.k, (0 - st.cam.y) / st.cam.k,
        (st.w - st.cam.x) / st.cam.k, (st.h - st.cam.y) / st.cam.k, st.scene.grid);
      return { built, stats, range, cam: { x: st.cam.x, y: st.cam.y, k: st.cam.k }, w: st.w, h: st.h };
    });
    assert.equal(hexPerf.range.count, 60298, 'модель видимого диапазона совпадает с замером старого drawGrid');
    assert.ok(hexPerf.built.rebuilds >= 1 && hexPerf.built.rebuilds <= 3, 'кэш сетки построен один раз');
    assert.ok(hexPerf.built.visibleCells >= hexPerf.range.count, 'в кэш попадает видимый диапазон (плюс поля)');
    assert.ok(hexPerf.stats.frames >= 10, `за 500 мс прошло ${hexPerf.stats.frames} кадров — сетка не тормозит`);
    assert.equal(hexPerf.stats.rebuilds, 0, 'устоявшиеся кадры не перестраивают кэш');
    assert.equal(hexPerf.stats.rasterizedLast, 0, 'в устоявшемся кадре гексы не перерисовываются — только блит');
    assert.ok(hexPerf.stats.blits > 0, 'кадры берут готовый кэш');
    assert.ok(hexPerf.stats.drawGridMsAvg < 1.5, `drawGrid в среднем ${hexPerf.stats.drawGridMsAvg} мс, а не десятки/тысячи`);

    // Пан в пределах поля кэша не перерисовывает сетку; выход за поле — перестраивает.
    const pan = await page.evaluate(async () => {
      Table.resetGridStats();
      const st = Table.state();
      const before = st.gridCache;
      st.cam.x += 40; Table.requestDraw();
      await new Promise(r => setTimeout(r, 100));
      const near = Table.gridStats().rebuilds;
      st.cam.x += 500; Table.requestDraw();
      await new Promise(r => setTimeout(r, 150));
      const far = Table.gridStats().rebuilds;
      return { near, far, replaced: before !== st.gridCache };
    });
    assert.equal(pan.near, 0, 'пан внутри поля кэша не перерисовывает сетку');
    assert.ok(pan.far >= 1, 'выход за поле кэша перестраивает сетку');
    assert.equal(pan.replaced, true, 'кэш заменён новым');

    // Зум меняет ключ кэша: после колеса сетка перестраивается, кадры продолжают идти.
    await page.mouse.move(canvasBox.x + 400, canvasBox.y + 300);
    const zoomBefore = await page.evaluate(() => { Table.resetGridStats(); return Table.state().cam.k; });
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(200);
    const zoomAfter = await page.evaluate(() => ({ k: Table.state().cam.k, stats: Table.gridStats() }));
    assert.ok(zoomAfter.k > zoomBefore, 'колесо приблизило камеру');
    assert.ok(zoomAfter.stats.rebuilds >= 1, 'зум инвалидирует кэш сетки');
    const afterZoomBlit = await page.evaluate(async () => {
      Table.requestDraw();
      await new Promise(r => setTimeout(r, 80));
      return Table.gridStats().rasterizedLast;
    });
    assert.equal(afterZoomBlit, 0, 'после перестройки снова только блит');

    // Сетка реально рисуется, а выключение видимости убирает её с канвы.
    const pixels = await page.evaluate(async () => {
      const st = Table.state();
      st.cam.x = 0; st.cam.y = 0; st.cam.k = 1;
      const read = () => {
        const d = st.ctx2d.getImageData(0, Math.floor(st.canvas.height / 2), st.canvas.width, 1).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 50 && d[i + 1] < 50 && d[i + 2] < 50) n++;
        return n;
      };
      Table.sendScene({ grid: st.scene.grid }); await new Promise(r => setTimeout(r, 120));
      const on = read();
      st.scene.grid.visible = false; Table.sendScene({ grid: st.scene.grid }); await new Promise(r => setTimeout(r, 120));
      const off = read();
      st.scene.grid.visible = true;
      st.scene.grid.type = 'square'; Table.sendScene({ grid: st.scene.grid }); await new Promise(r => setTimeout(r, 120));
      const square = read();
      st.scene.grid.type = 'hex'; Table.sendScene({ grid: st.scene.grid }); await new Promise(r => setTimeout(r, 120));
      const hex = read();
      return { on, off, square, hex };
    });
    assert.ok(pixels.on > 0, 'соты видны на канве');
    assert.equal(pixels.off, 0, 'при visible=false сетки нет');
    assert.ok(pixels.square > 0, 'квадратная сетка после кэша тоже рисуется');
    assert.ok(pixels.hex > 0, 'возврат к сотам снова рисует гексы');

    // Линейка и hover на сотах: привязка к центрам гексов, Ctrl — свободно.
    await page.evaluate(() => { const st = Table.state(); st.cam.x = 0; st.cam.y = 0; st.cam.k = 1; Table.requestDraw(); });
    await page.keyboard.press('r');
    await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 281, canvasBox.y + 349, { steps: 4 });
    const hexRuler = await page.evaluate(() => {
      const st = Table.state();
      return { points: st.temp.points.map(p => p.slice()), expected: TableModel.snapRuler(st.temp.raw, st.scene.grid, false), hover: st.hover };
    });
    assert.deepEqual(hexRuler.points, hexRuler.expected, 'линейка на сотах привязана к центрам гексов');
    assert.deepEqual(hexRuler.hover, { x: 281, y: 349 }, 'hover на сотах обновляется');
    await page.keyboard.down('Control');
    const hexFree = await page.evaluate(() => Table.state().temp.points.map(p => p.slice()));
    assert.deepEqual(hexFree, [[100, 100], [281, 349]], 'Ctrl на сотах отключает привязку');
    await page.keyboard.up('Control');
    await page.mouse.up();
    // Без действий кадры не рисуются вовсе (раньше draw() крутился 60 раз в секунду).
    await page.waitForTimeout(120);
    const idleFrames = await page.evaluate(async () => {
      Table.resetGridStats();
      await new Promise(r => setTimeout(r, 300));
      return Table.gridStats().frames;
    });
    assert.equal(idleFrames, 0, 'в покое кадры не рисуются — coalescing работает');

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

    // ======================= Размер canvas при скрытии боковой панели =======================
    // Панель меняет ширину контейнера: буфер canvas пересчитывается, а камера
    // (центр мира и зум) остаётся прежней — карта не растягивается по горизонтали.
    const resized = await page.evaluate(() => {
      const st = Table.state();
      st.tool = 'select';
      st.cam.x = 0; st.cam.y = 0; st.cam.k = 1;
      const wrap = st.canvas.parentElement;
      const cellPx = () => TableModel.gridSize(Table.getScene().grid) * st.cam.k;
      const worldCenter = () => ({ x: (st.w / 2 - st.cam.x) / st.cam.k, y: (st.h / 2 - st.cam.y) / st.cam.k });
      const before = { w: st.w, h: st.h, bufW: st.canvas.width, bufH: st.canvas.height, cssW: st.canvas.style.width, cam: { ...st.cam }, cell: cellPx(), center: worldCenter() };
      wrap.style.width = '700px'; // как будто боковая панель стала шире/уже
      Table.refreshSize();
      const after = { w: st.w, h: st.h, bufW: st.canvas.width, bufH: st.canvas.height, cssW: st.canvas.style.width, cssH: st.canvas.style.height, cam: { ...st.cam }, cell: cellPx(), center: worldCenter() };
      return { before, after, dpr: devicePixelRatio || 1 };
    });
    assert.notEqual(resized.after.w, resized.before.w, 'ширина canvas изменилась вместе с контейнером');
    assert.equal(resized.after.w, 700);
    assert.equal(resized.after.bufW, Math.round(700 * resized.dpr), 'буфер canvas = clientWidth × dpr');
    assert.equal(resized.after.cssW, '700px', 'CSS-размер задан явно, а не растянут старым буфером');
    assert.equal(resized.after.cssH, '800px');
    assert.equal(resized.after.cam.k, resized.before.cam.k, 'зум не изменился');
    assert.equal(resized.after.cell, resized.before.cell, 'масштаб клетки в пикселях не изменился — карта не растянута');
    assert.deepEqual(resized.after.center, resized.before.center, 'центр мира остался в центре экрана');

    // ======================= Мультивыделение рамкой (мастер) =======================
    await page.evaluate(() => {
      const st = Table.state();
      st.tool = 'select'; st.isGM = true; st.user = { id: 'u1', name: 'Мастер' }; st.activeLayer = 'character';
      st.cam.x = 0; st.cam.y = 0; st.cam.k = 1; // экран = мир
      const items = Table.getScene().items.filter(i => !i.id.startsWith('sel-'));
      items.push(
        { id: 'sel-a', layer: 'character', z: 0, data: { type: 'image', x: 200, y: 200, w: 70, h: 70, name: 'A', owner_id: 'u1' } },
        { id: 'sel-b', layer: 'character', z: 0, data: { type: 'image', x: 340, y: 200, w: 70, h: 70, name: 'B', owner_id: 'u1' } },
        { id: 'sel-map', layer: 'map', z: -100, data: { type: 'image', x: 3000, y: 3000, w: 70, h: 70, name: 'D' } },
      );
      Table.getScene().items = items;
      window.sent.length = 0;
    });
    // Протяжка по пустому месту: рамка 120,120 → 420,300 накрывает A и B.
    await page.evaluate(() => window.scrollTo(0, 0));
    const cb = await page.evaluate(() => { const r = Table.state().canvas.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await page.mouse.move(cb.x + 120, cb.y + 120);
    await page.mouse.down();
    await page.mouse.move(cb.x + 420, cb.y + 300, { steps: 6 });
    await page.mouse.up();
    const gmSelection = await page.evaluate(() => ({ ids: [...Table.state().selSet].sort(), props: Table.state().propsBox.textContent }));
    assert.deepEqual(gmSelection.ids, ['sel-a', 'sel-b'], 'рамка выделила два токена на слое персонажей');
    assert.ok(gmSelection.props.includes('Выбрано 2'), 'статус «Выбрано 2»');

    // Групповой драг: тянем A — двигаются оба, взаимное расположение сохраняется.
    const beforeDrag = await page.evaluate(() => {
      const items = Table.getScene().items;
      const a = items.find(i => i.id === 'sel-a').data, b = items.find(i => i.id === 'sel-b').data;
      return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    });
    await page.mouse.move(cb.x + 200, cb.y + 200);
    await page.mouse.down();
    await page.mouse.move(cb.x + 270, cb.y + 270, { steps: 6 });
    await page.mouse.up();
    const dragged = await page.evaluate(() => {
      const items = Table.getScene().items;
      const a = items.find(i => i.id === 'sel-a').data, b = items.find(i => i.id === 'sel-b').data;
      const ups = window.sent.filter(m => m.type === 'item_upsert' && ['sel-a', 'sel-b'].includes(m.item.id)).map(m => m.item.id);
      return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, ups };
    });
    assert.notEqual(dragged.a.x, beforeDrag.a.x, 'первый выделенный сдвинулся');
    assert.notEqual(dragged.b.x, beforeDrag.b.x, 'второй выделенный сдвинулся вместе с группой');
    assert.equal(dragged.b.x - dragged.a.x, beforeDrag.b.x - beforeDrag.a.x, 'взаимное расположение сохранено');
    assert.deepEqual(dragged.ups.sort(), ['sel-a', 'sel-b'], 'на сервер ушли оба элемента');

    // Delete удаляет всё выделение.
    await page.keyboard.press('Delete');
    const gmDeleted = await page.evaluate(() => ({ ids: window.sent.filter(m => m.type === 'item_delete').map(m => m.id).sort(), left: Table.state().selSet.size }));
    assert.deepEqual(gmDeleted.ids, ['sel-a', 'sel-b'], 'Delete удаляет все выделенные');
    assert.equal(gmDeleted.left, 0, 'выделение снято');

    // ======================= Мультивыделение: права игрока =======================
    await page.evaluate(() => {
      const st = Table.state();
      st.tool = 'select'; st.isGM = false; st.user = { id: 'u2', name: 'Игрок' }; st.activeLayer = 'character';
      st.cam.x = 0; st.cam.y = 0; st.cam.k = 1;
      const items = Table.getScene().items.filter(i => !i.id.startsWith('sel-'));
      items.push(
        { id: 'sel-own', layer: 'character', z: 0, data: { type: 'image', x: 340, y: 200, w: 70, h: 70, name: 'Свой', owner_id: 'u2' } },
        { id: 'sel-foreign', layer: 'character', z: 0, data: { type: 'image', x: 200, y: 200, w: 70, h: 70, name: 'Чужой', owner_id: 'u1' } },
      );
      Table.getScene().items = items;
      window.sent.length = 0;
    });
    await page.mouse.move(cb.x + 120, cb.y + 120);
    await page.mouse.down();
    await page.mouse.move(cb.x + 420, cb.y + 300, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => [...Table.state().selSet]), ['sel-own'], 'игрок выделяет только своего');

    // Тянуть чужой токен нельзя: он даже не выделяется.
    const foreignBefore = await page.evaluate(() => {
      const f = Table.getScene().items.find(i => i.id === 'sel-foreign').data; return { x: f.x, y: f.y };
    });
    await page.mouse.move(cb.x + 200, cb.y + 200);
    await page.mouse.down();
    await page.mouse.move(cb.x + 300, cb.y + 300, { steps: 5 });
    await page.mouse.up();
    const foreignAfter = await page.evaluate(() => {
      const f = Table.getScene().items.find(i => i.id === 'sel-foreign').data;
      return { x: f.x, y: f.y, ups: window.sent.filter(m => m.type === 'item_upsert' && m.item.id === 'sel-foreign').length, sel: [...Table.state().selSet] };
    });
    assert.deepEqual([foreignAfter.x, foreignAfter.y], [foreignBefore.x, foreignBefore.y], 'чужой токен не сдвинулся');
    assert.equal(foreignAfter.ups, 0, 'по чужому токену ничего не отправлено');
    assert.deepEqual(foreignAfter.sel, [], 'чужой токен не выделяется');

    // Delete игрока удаляет только своего.
    await page.mouse.move(cb.x + 120, cb.y + 120);
    await page.mouse.down();
    await page.mouse.move(cb.x + 420, cb.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'item_delete').map(m => m.id)), ['sel-own'], 'игрок удаляет только своего');

    assert.deepEqual(errors, []);
    console.log('PASS table browser: несколько карт + активная + fitToMap, добавление карты броском (сразу в сцене и на канве, create:true, не активна; клик/драг только на слое «Карта», удаление одной не трогает вторую), слои сцены, линейка (сетка/Ctrl), туман (маска на карту, кисть/прямоугольник, Ctrl+Z, предпросмотр), соты 200×200 (видимый диапазон, кэш, пан/зум, линейка/hover), размер canvas при панели (камера и масштаб сохранены), мультивыделение рамкой (групповой драг/Delete, права игрока)');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
