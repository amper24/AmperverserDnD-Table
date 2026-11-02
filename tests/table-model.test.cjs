// Модель стола: слои сцены, активная карта, сетка и линейка (чистые функции).
// table-model.js не трогает DOM и сеть, поэтому проверяется в vm-контексте.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadModel() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/asset-kinds.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('static/table-model.js', 'utf8'), ctx);
  return ctx.window.TableModel;
}
const M = loadModel();
const plain = value => JSON.parse(JSON.stringify(value));
// Массивы из vm-контекста имеют чужой прототип — для deepStrictEqual переводим в обычные.
const ids = list => Array.from(list, l => l.id);
const orders = list => Array.from(list, l => l.order);
const grid = (size = 70, type = 'square', scale = '5 фт') => ({ size, type, scale });

test('слои по умолчанию — прежний LAYER_ORDER (старые сцены работают как раньше)', () => {
  const def = M.defaultLayers();
  assert.deepEqual(plain(ids(def)), ['map', 'prop', 'mount', 'character', 'attachment', 'drawing', 'text', 'note']);
  assert.deepEqual(plain(orders(def)), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(plain(def.map(l => l.name)), ['Карта', 'Объекты', 'Ездовые', 'Персонажи', 'Прикреплённые', 'Рисунки', 'Текст', 'Заметки']);
  assert.ok(plain(def).every(l => l.hidden === false && l.locked === false));
  // Пустая/битая сцена получает дефолт, а не пустой список.
  assert.deepEqual(plain(M.normalize(null)), plain(def));
  assert.deepEqual(plain(M.normalize([])), plain(def));
  assert.deepEqual(plain(M.normalize('мусор')), plain(def));
});

test('normalize: порядок, имена, флаги, уникальность id', () => {
  const out = M.normalize([
    { id: 'Character', name: '  Герои ', order: 5, hidden: true },
    { id: 'custom-1', name: '', order: 1, locked: true },
    { id: 'custom-1', name: 'дубль', order: 2 },
    { id: 'плохой id', name: 'нет' },
  ]);
  assert.deepEqual(plain(ids(out)), ['custom-1', 'character'], 'id приводится к нижнему регистру, дубли и битые id отброшены');
  assert.deepEqual(plain(orders(out)), [0, 1], 'order пересчитан по порядку');
  assert.equal(out[0].name, 'custom-1', 'пустое имя заменяется id');
  assert.equal(out[0].locked, true);
  assert.equal(out[1].name, 'Герои');
  assert.equal(out[1].hidden, true);
  // Длинные имена обрезаются, а не ломают слой.
  assert.equal(M.normalize([{ id: 'a', name: 'x'.repeat(200) }])[0].name.length, 64);
});

test('добавление, удаление, переименование и порядок слоёв', () => {
  let list = M.defaultLayers();
  list = M.addLayer(list, 'Декорации');
  assert.equal(list.length, 9);
  assert.equal(list[8].id, 'custom-1');
  assert.equal(list[8].name, 'Декорации');
  assert.equal(list[8].order, 8, 'новый слой — сверху');
  list = M.addLayer(list, 'Ещё');
  assert.equal(list[9].id, 'custom-2', 'id не повторяется');

  assert.deepEqual(plain(ids(M.removeLayer(list, 'custom-1'))), ['map', 'prop', 'mount', 'character', 'attachment', 'drawing', 'text', 'note', 'custom-2']);
  assert.equal(M.removeLayer(M.normalize([{ id: 'one' }]), 'one').length, 1, 'последний слой не удаляется');

  const renamed = M.renameLayer(list, 'prop', 'Предметы');
  assert.equal(M.find(renamed, 'prop').name, 'Предметы');
  assert.equal(M.renameLayer(renamed, 'prop', '   ').find(l => l.id === 'prop').name, 'Предметы', 'пустое имя не затирает старое');

  // moveLayer: +1 — выше (позже в порядке отрисовки), -1 — ниже.
  const up = M.moveLayer(M.defaultLayers(), 'map', 1);
  assert.deepEqual(plain(ids(up)).slice(0, 2), ['prop', 'map']);
  assert.deepEqual(plain(orders(up)), [0, 1, 2, 3, 4, 5, 6, 7]);
  const down = M.moveLayer(M.defaultLayers(), 'note', -1);
  assert.deepEqual(plain(ids(down)).slice(-2), ['note', 'text']);

  assert.equal(M.setLayerFlag(M.defaultLayers(), 'prop', 'hidden', true).find(l => l.id === 'prop').hidden, true);
  assert.equal(M.setLayerFlag(M.defaultLayers(), 'prop', 'unknown', true).find(l => l.id === 'prop').hidden, false, 'неизвестный флаг игнорируется');
});

test('фолбэк неизвестного слоя — prop, иначе первый доступный', () => {
  const layers = M.defaultLayers();
  assert.equal(M.resolve(layers, 'custom-42').id, 'prop');
  assert.equal(M.orderOf(layers, 'нет-такого'), M.orderOf(layers, 'prop'));
  const noProp = M.removeLayer(layers, 'prop');
  assert.equal(M.resolve(noProp, 'custom-42').id, 'map', 'если prop удалён — первый слой списка');
});

test('порядок отрисовки: слои, затем z, затем исходный порядок', () => {
  const layers = M.normalize([
    { id: 'map', name: 'Карта', order: 0 },
    { id: 'character', name: 'Герои', order: 1 },
  ]);
  const items = [
    { id: 'token-high', layer: 'character', z: 5 },
    { id: 'old-map', layer: 'map', z: -100 },
    { id: 'stranger', layer: 'deleted-layer', z: 0 },
    { id: 'token-low', layer: 'character', z: 0 },
  ];
  assert.deepEqual(plain(M.sortItems(items, layers).map(i => i.id)), ['old-map', 'stranger', 'token-low', 'token-high'], 'неизвестный слой живёт на месте prop (после карты)');
  assert.equal(M.countItems(items, 'character'), 2);
  assert.equal(M.countItems(items, 'deleted-layer'), 1, 'countItems считает точный id слоя (для «удалить пустой»)');
  assert.equal(M.countItems(items, 'none'), 0);
});

test('активная карта: одна карта — активная, явный выбор, устаревший id', () => {
  const one = { items: [{ id: 'm1', layer: 'map', data: { x: 100, y: 100, w: 700, h: 700 } }] };
  assert.equal(M.activeMapId(one), 'm1', 'старая сцена с одной картой — карта активная');
  assert.equal(M.activeMap(one).id, 'm1');
  assert.equal(M.activeMap({ items: [] }), null);
  assert.equal(M.activeMapId({ items: [] }), null);

  const two = { active_map_id: 'm2', items: [...one.items, { id: 'm2', layer: 'map', data: { x: 2000, y: 0, w: 700, h: 700 } }] };
  assert.equal(M.activeMapId(two), 'm2');
  assert.equal(M.activeMapId({ ...two, active_map_id: undefined }), null, 'две карты без выбора — активной нет (вписываем все)');
  assert.equal(M.activeMapId({ ...two, active_map_id: 'удалённая' }), null, 'устаревший id игнорируется');
  assert.equal(M.mapItems(two.items).length, 2);
});

test('границы карт: активная карта, иначе объединение всех', () => {
  const a = { id: 'a', layer: 'map', data: { x: 500, y: 500, w: 1000, h: 600 } };
  const b = { id: 'b', layer: 'map', data: { x: 2000, y: 300, w: 400, h: 400 } };
  const scene = { active_map_id: 'b', items: [a, b, { id: 't', layer: 'character', data: { x: 0, y: 0, w: 70, h: 70 } }] };
  assert.deepEqual(plain(M.boundsOf(a)), { x: 0, y: 200, w: 1000, h: 600 });
  assert.deepEqual(plain(M.boardBounds(scene)), { x: 1800, y: 100, w: 400, h: 400 }, 'вписываем активную');
  assert.deepEqual(plain(M.boardBounds({ items: [a, b] })), { x: 0, y: 100, w: 2200, h: 700 }, 'без активной — все карты');
  assert.equal(M.boardBounds({ items: [] }), null);
});

test('fitView вписывает карту как прежний fitToMap', () => {
  const view = { w: 1000, h: 800 };
  // Было: k = min(w/(W+100), h/(H+100), 1.5); cam = (view - W*k)/2 - x*k.
  assert.deepEqual(plain(M.fitView({ x: 0, y: 0, w: 700, h: 700 }, view)), { k: 1, x: 150, y: 50 });
  const bounds = { x: 350, y: 350, w: 1000, h: 500 };
  const v = M.fitView(bounds, view);
  const k = Math.min(1000 / 1100, 800 / 600, 1.5);
  assert.equal(v.k, k, 'камера учитывает координаты карты');
  assert.equal(v.x, (view.w - bounds.w * k) / 2 - bounds.x * k);
  assert.equal(v.y, (view.h - bounds.h * k) / 2 - bounds.y * k);
  assert.equal(M.fitView({ x: 0, y: 0, w: 10, h: 10 }, view).k, 1.5, 'мелкая карта не увеличивается больше 1.5×');
  assert.equal(M.fitView(null, view), null);
});

test('snapPos: центр клетки для мелкого, угол для крупного объекта', () => {
  const g = grid();
  assert.deepEqual(plain(M.snapPos(100, 100, 70, 70, { grid: g, snap: true })), { x: 105, y: 105 });
  assert.deepEqual(plain(M.snapPos(100, 100, 140, 140, { grid: g, snap: true })), { x: 70, y: 70 }, 'крупный — к узлу сетки');
  assert.deepEqual(plain(M.snapPos(100, 100, 70, 70, { grid: g, snap: false })), { x: 100, y: 100 });
  const hex = grid(70, 'hex');
  const c = M.hexAt(33, 33, hex);
  assert.deepEqual(plain(M.snapPos(33, 33, 70, 70, { grid: hex, snap: true })), plain(M.hexCenter(c.q, c.r, hex)), 'гексы — центр гекса');
});

test('snapRuler: без Ctrl — к сетке, с Ctrl — свободно (и пересчёт при движении)', () => {
  const g = grid(70);
  assert.deepEqual(plain(M.snapRuler([[103, 97], [281, 349]], g, false)), [[70, 70], [280, 350]], 'квадраты: к углам клеток');
  assert.deepEqual(plain(M.snapRuler([[103, 97], [281, 349]], g, true)), [[103, 97], [281, 349]], 'Ctrl — свободный режим');
  // Привязка идемпотентна: повторный снап уже привязанных точек ничего не двигает.
  assert.deepEqual(plain(M.snapRuler(M.snapRuler([[103, 97], [281, 349]], g, false), g, false)), [[70, 70], [280, 350]]);
  const hex = grid(70, 'hex');
  const raw = [[10, 10], [300, 220]];
  const hexSnap = M.snapRuler(raw, hex, false);
  assert.deepEqual(plain(hexSnap), plain(raw.map(([x, y]) => { const c = M.hexAt(x, y, hex); const p = M.hexCenter(c.q, c.r, hex); return [p.x, p.y]; })), 'гексы: к центрам гексов');
  assert.deepEqual(plain(M.snapRuler(raw, hex, true)), raw);
});

test('длина и подпись линейки в футах и клетках', () => {
  const g = grid(70);
  assert.equal(M.rulerCells([[0, 0], [210, 0]], g), 3);
  assert.equal(M.rulerCells([[0, 0], [210, 140]], g), 3, 'диагональ считается по длинной стороне');
  assert.equal(M.rulerLabel([[0, 0], [210, 0]], g, 5), '15 фт (3 кл.)');
  assert.equal(M.rulerLabel([[0, 0], [210, 0]], g, 5, 'Гоблин'), '15 фт (3 кл.) — Гоблин');
  assert.equal(M.rulerCells([[0, 0], [100, 0]], g), 100 / 70);
  assert.equal(M.scaleFt({ scale: '10 фт' }), 10);
  assert.equal(M.scaleFt({}), 5);
  assert.equal(M.scaleFt({ scale: 'мусор' }, 5), 5);
});

// ---------------------------------------------------------------- видимый диапазон и кэш сетки
test('видимый диапазон гексов: та же формула, что у отрисовки, с запасом в клетку', () => {
  const hex = grid(70, 'hex');
  assert.deepEqual(plain(M.hexVisibleRange(0, 0, 100, 100, hex)), { r0: -1, r1: 3, q0: -3, q1: 3, rows: 5, count: 25 });
  assert.deepEqual(plain(M.hexRowRange(-1, 0, 100, hex)), { q0: -1, q1: 3 });
  assert.deepEqual(plain(M.hexRowRange(1, 0, 100, hex)), { q0: -2, q1: 2 });
  // Каждая строка диапазона действительно рядом с вьюпортом (не дальше клетки).
  const small = M.hexVisibleRange(0, 0, 100, 100, hex);
  for (let rr = small.r0; rr <= small.r1; rr++) {
    const row = M.hexRowRange(rr, 0, 100, hex);
    for (let q = row.q0; q <= row.q1; q++) {
      const c = M.hexCenter(q, rr, hex);
      assert.ok(c.x >= -140 && c.x <= 240, `строка ${rr}, q=${q}: центр не дальше двух клеток от вьюпорта`);
    }
  }
  // 200×200 при вписывании: ровно столько клеток старый drawGrid рисовал за кадр (замер до оптимизации).
  const b = { x: 0, y: 0, w: 14000, h: 14000 };
  const view = M.fitView(b, { w: 1000, h: 800 });
  const range = M.hexVisibleRange((0 - view.x) / view.k, (0 - view.y) / view.k, (1000 - view.x) / view.k, (800 - view.y) / view.k, hex);
  assert.equal(range.count, 60298);
  assert.equal(range.rows, range.r1 - range.r0 + 1);
  // Битые входы не дают отрицательных диапазонов.
  assert.deepEqual(plain(M.hexVisibleRange(NaN, 0, 100, 100, hex)), { r0: 0, r1: -1, q0: 0, q1: -1, rows: 0, count: 0 });
  assert.deepEqual(plain(M.hexVisibleRange(10, 0, 0, 100, hex)), { r0: 0, r1: -1, q0: 0, q1: -1, rows: 0, count: 0 });
});

test('видимый диапазон покрывает все гексы, попавшие во вьюпорт', () => {
  const hex = grid(70, 'hex');
  const x0 = -137, y0 = -211, x1 = 431, y1 = 389;
  const range = M.hexVisibleRange(x0, y0, x1, y1, hex);
  let hits = 0;
  for (let rr = -10; rr <= 10; rr++) {
    const row = M.hexRowRange(rr, x0, x1, hex);
    for (let q = -15; q <= 15; q++) {
      const c = M.hexCenter(q, rr, hex);
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      hits++;
      assert.ok(rr >= range.r0 && rr <= range.r1 && q >= row.q0 && q <= row.q1, `гекс ${q},${rr} потерян`);
    }
  }
  assert.ok(hits > 0, 'в тестовый вьюпорт попадают гексы');
});

test('hexAt: кубическое округление O(1) — обратное к hexCenter и ближайший центр', () => {
  const hex = grid(70, 'hex');
  for (let q = -6; q <= 6; q++) {
    for (let rr = -6; rr <= 6; rr++) {
      const c = M.hexCenter(q, rr, hex);
      assert.deepEqual(plain(M.hexAt(c.x, c.y, hex)), { q, r: rr });
    }
  }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 200; i++) {
    const x = (rnd() - 0.5) * 2000, y = (rnd() - 0.5) * 2000;
    const h = M.hexAt(x, y, hex);
    const dist = p => { const c = M.hexCenter(p.q, p.r, hex); return Math.hypot(c.x - x, c.y - y); };
    const dh = dist(h);
    for (let dq = -1; dq <= 1; dq++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (!dq && !dr) continue;
        assert.ok(dh <= dist({ q: h.q + dq, r: h.r + dr }) + 1e-9, `hexAt не ближайший для (${x}, ${y})`);
      }
    }
  }
});

test('привязка центра и угла идемпотентна: повторный снап не двигает точку', () => {
  for (const g of [grid(70), grid(70, 'hex')]) {
    for (const [x, y] of [[0, 0], [33, 33], [103.4, 97.2], [-250, 411], [7000, 7000]]) {
      const c1 = M.snapCorner(x, y, g), c2 = M.snapCorner(c1.x, c1.y, g);
      assert.ok(Math.abs(c1.x - c2.x) < 1e-9 && Math.abs(c1.y - c2.y) < 1e-9, `snapCorner ${g.type}: (${x}, ${y})`);
      const p1 = M.snapPos(x, y, 70, 70, { grid: g, snap: true }), p2 = M.snapPos(p1.x, p1.y, 70, 70, { grid: g, snap: true });
      assert.ok(Math.abs(p1.x - p2.x) < 1e-9 && Math.abs(p1.y - p2.y) < 1e-9, `snapPos ${g.type}: (${x}, ${y})`);
    }
  }
});

test('ключ кэша сетки: инвалидация по типу/размеру/цвету/зуму/dpr/вьюпорту, пан не влияет', () => {
  const base = { grid: grid(70, 'hex'), color: '#00000055', dpr: 1, k: 0.5, w: 1000, h: 800 };
  const key = (o = {}) => M.gridCacheKey({ ...base, ...o });
  const k0 = key();
  assert.equal(key(), k0, 'одинаковые параметры — одинаковый ключ');
  assert.notEqual(key({ grid: grid(70, 'square') }), k0, 'тип сетки');
  assert.notEqual(key({ grid: grid(100, 'hex') }), k0, 'размер клетки');
  assert.notEqual(key({ color: '#ff0000' }), k0, 'цвет линий');
  assert.notEqual(key({ grid: { ...base.grid, visible: true } }), k0, 'видимость сетки');
  assert.notEqual(key({ dpr: 2 }), k0, 'devicePixelRatio');
  assert.notEqual(key({ k: 0.51 }), k0, 'зум');
  assert.notEqual(key({ w: 1001 }), k0, 'ширина вьюпорта');
  assert.notEqual(key({ h: 801 }), k0, 'высота вьюпорта');
  assert.equal(key({ camX: 999, camY: -999 }), k0, 'пан камеры в ключ не входит — кэш только сдвигается');
});

test('gridCacheCovers: кэш с полями накрывает вьюпорт, сдвиг за поля — нет', () => {
  assert.equal(M.gridCacheCovers({ x: -128, y: -128, w: 1256, h: 1056 }, 1000, 800), true);
  assert.equal(M.gridCacheCovers({ x: 0, y: 0, w: 1000, h: 800 }, 1000, 800), true, 'ровно по границе — ещё накрывает');
  assert.equal(M.gridCacheCovers({ x: 1, y: -128, w: 1256, h: 1056 }, 1000, 800), false, 'сдвинулись вправо — левая полоса открыта');
  assert.equal(M.gridCacheCovers({ x: -128, y: 1, w: 1256, h: 1056 }, 1000, 800), false, 'сдвинулись вниз — верхняя полоса открыта');
  assert.equal(M.gridCacheCovers({ x: -128, y: -128, w: 1127, h: 1056 }, 1000, 800), false, 'ширины не хватает');
  assert.equal(M.gridCacheCovers({ x: -128, y: -128, w: 1256, h: 927 }, 1000, 800), false, 'высоты не хватает');
  assert.equal(M.gridCacheCovers(null, 1000, 800), false);
  assert.equal(M.gridCacheCovers({ x: 0, y: 0, w: 0, h: 0 }, 1000, 800), false);
});

test('table.js/app.js используют модель и больше не ограничивают число карт', () => {
  const table = fs.readFileSync('static/table.js', 'utf8');
  const app = fs.readFileSync('static/app.js', 'utf8');
  assert.ok(table.includes('window.TableModel'), 'table.js берёт слои/карты/линейку из модели');
  assert.equal(table.includes('Заменить текущую карту?'), false, 'карту больше не «заменяют»');
  assert.equal(/find\(i => i\.layer === LAYER\.map\)/.test(table), false, 'нет поиска «первой карты» для fitToMap/тумана');
  assert.ok(table.includes('setActiveMap') && table.includes('getActiveMapId'), 'активная карта доступна наружу');
  assert.ok(table.includes('setLayers') && table.includes('getLayers'), 'слои сцены доступны наружу');
  assert.ok(app.includes('Table.getLayers()'), 'селектор слоя берёт список из сцены');
  assert.ok(app.includes('TableModel.addLayer') && app.includes('TableModel.removeLayer'), 'панель слоёв работает через модель');
  assert.ok(app.includes('/table/'), 'со стола есть ссылка на страницу участников');
  const html = fs.readFileSync('static/index.html', 'utf8');
  assert.ok(html.indexOf('/static/table-model.js') < html.indexOf('/static/table.js'), 'table-model.js загружается до table.js');
});

// ---------------------------------------------------------------- туман войны
const bounds = (x, y, w, h) => ({ x, y, w, h });
const rect = (x0, y0, x1, y1, mode = 'reveal') => ({ shape: 'rect', mode, points: [[x0, y0], [x1, y1]] });

test('туман: старый scene.fog.shapes мигрирует в маску карты', () => {
  const legacy = {
    enabled: true,
    shapes: [
      rect(0, 0, 100, 100),
      { shape: 'poly', mode: 'hide', points: [[10, 10], [20, 10], [20, 20]] },
      { shape: 'circle', mode: 'reveal', points: [[5, 5], [15, 5]] },
      { shape: 'треугольник', mode: 'reveal', points: [[0, 0], [5, 5]] },
      { shape: 'rect', mode: 'open', points: [[0, 0], [10, 10]] },
      { shape: 'rect', mode: 'reveal', points: [[0, 0], [Infinity, 10]] },
    ],
  };
  const twoMaps = M.normalizeFog(legacy, { activeMapId: 'm2', mapIds: ['m1', 'm2'] });
  assert.equal(twoMaps.enabled, true, 'включённость переезжает');
  assert.deepEqual(plain(Object.keys(twoMaps.by_map)), ['m2'], 'маска уходит активной карте');
  const shapes = plain(twoMaps.by_map.m2.shapes);
  assert.deepEqual(shapes.map(s => s.shape), ['rect', 'polygon', 'circle'], 'poly → polygon, битые фигуры отброшены');
  assert.equal(shapes[1].mode, 'hide');

  // Одна карта без active_map_id — маска её.
  const single = M.normalizeFog(legacy, { mapIds: ['only'] });
  assert.deepEqual(plain(Object.keys(single.by_map)), ['only']);
  // Карт нет — навешивать маску не на что (туман не применяется).
  assert.deepEqual(plain(M.normalizeFog(legacy, {})), { enabled: true, by_map: {} });
  // Новый формат главнее старого поля, даже если он пуст: маску уже правили.
  const fresh = M.normalizeFog({ enabled: false, by_map: {}, shapes: [rect(0, 0, 10, 10)] }, { activeMapId: 'm1' });
  assert.deepEqual(plain(fresh), { enabled: false, by_map: {} });
  assert.deepEqual(plain(M.normalizeFog(null)), { enabled: false, by_map: {} });
  assert.deepEqual(plain(M.normalizeFog('мусор')), { enabled: false, by_map: {} });
});

test('туман: маска выбирается по карте и не смешивается', () => {
  let fog = M.normalizeFog({ enabled: true, by_map: { a: { shapes: [rect(0, 0, 50, 50)] }, b: { shapes: [rect(100, 100, 150, 150, 'hide')] } } });
  assert.equal(M.maskShapes(fog, 'a').length, 1);
  assert.equal(M.maskShapes(fog, 'b')[0].mode, 'hide');
  assert.deepEqual(plain(M.maskShapes(fog, 'c')), [], 'карта без записей — пустая маска (всё скрыто)');
  assert.deepEqual(plain(M.maskShapes(fog, null)), []);

  fog = M.setMaskShapes(fog, 'a', [rect(1, 1, 2, 2)]);
  assert.deepEqual(plain(M.maskShapes(fog, 'a')), [rect(1, 1, 2, 2)], 'маска карты заменяется, а не дополняется');
  assert.equal(M.maskShapes(fog, 'b').length, 1, 'другая карта не тронута');
  fog = M.setMaskShapes(fog, 'b', []);
  assert.equal(fog.by_map.b, undefined, 'пустая маска удаляет запись карты');

  assert.equal(M.fogEnabled(fog), true);
  assert.equal(M.fogEnabled({}), false);
  assert.equal(M.setFogEnabled(fog, false).enabled, false, '«Показать игрокам» — это fog.enabled');
});

test('туман: обрезка фигур по прямоугольнику карты', () => {
  const b = bounds(0, 0, 700, 700);
  assert.deepEqual(plain(M.clipShape(rect(-100, 100, 300, 900), b)), rect(0, 100, 300, 700), 'прямоугольник обрезан');
  assert.equal(M.clipShape(rect(800, 800, 900, 900), b), null, 'фигура вне карты не создаёт эффекта');

  const circle = M.clipShape({ shape: 'circle', mode: 'reveal', points: [[650, 350], [750, 350]] }, b);
  assert.equal(circle.shape, 'polygon', 'круг через границу становится многоугольником');
  assert.ok(plain(circle.points).every(([x, y]) => x >= -0.01 && x <= 700.01 && y >= -0.01 && y <= 700.01), 'все точки внутри карты');
  assert.equal(M.clipShape({ shape: 'circle', mode: 'reveal', points: [[100, 100], [200, 100]] }, b).shape, 'circle', 'круг целиком внутри не меняется');

  const poly = M.clipShape({ shape: 'polygon', mode: 'hide', points: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }, b);
  assert.equal(poly.shape, 'polygon');
  assert.deepEqual(plain(poly.points), [[0, 0], [50, 0], [50, 50], [0, 50]], 'многоугольник обрезан по карте');

  assert.equal(M.clipShape({ shape: 'path', mode: 'reveal', points: [[800, 800], [900, 900]], width: 20 }, b), null, 'мазок вне карты');
  assert.equal(M.clipShape({ shape: 'path', mode: 'reveal', points: [[100, 100], [200, 200]], width: 20 }, b).shape, 'path');
  assert.deepEqual(plain(M.clipShape(rect(1, 1, 2, 2), null)), rect(1, 1, 2, 2), 'без границ фигура остаётся как есть');
  assert.equal(M.clipShape({ shape: 'line', mode: 'reveal', points: [[0, 0], [1, 1]] }, b), null, 'неизвестный вид не обрезается «наугад»');
});

test('туман: попадание точки, reveal/hide поверх и границы карты', () => {
  const b = bounds(0, 0, 700, 700);
  const fog = M.normalizeFog({
    enabled: true,
    by_map: {
      m: {
        shapes: [
          rect(100, 100, 400, 400),
          { shape: 'circle', mode: 'hide', points: [[250, 250], [300, 250]] },
          { shape: 'path', mode: 'reveal', points: [[500, 100], [600, 100]], width: 40 },
        ],
      },
    },
  }, { activeMapId: 'm' });
  assert.equal(M.isRevealed(fog, 'm', 120, 120, b), true, 'reveal открывает');
  assert.equal(M.isRevealed(fog, 'm', 250, 250, b), false, 'hide поверх reveal снова скрывает');
  assert.equal(M.isRevealed(fog, 'm', 480, 480, b), false, 'вне фигур скрыто');
  assert.equal(M.isRevealed(fog, 'm', 550, 110, b), true, 'мазок открывает в пределах половины ширины');
  assert.equal(M.isRevealed(fog, 'm', 550, 140, b), false, 'дальше половины ширины мазка — нет');
  assert.equal(M.isRevealed(fog, 'm', -10, 100, b), false, 'за границей карты открыть нельзя');
  assert.equal(M.isRevealed(fog, 'm', 100, 100, null), false, 'без активной карты тумана нет');
  assert.equal(M.isRevealed({ enabled: true, by_map: {} }, 'm', 100, 100, b), false, 'карта без маски — скрыта');
  // contains: круг, многоугольник, путь
  assert.equal(M.containsShape({ shape: 'circle', mode: 'reveal', points: [[0, 0], [10, 0]] }, 0, 10), true);
  assert.equal(M.containsShape({ shape: 'circle', mode: 'reveal', points: [[0, 0], [10, 0]] }, 11, 0), false);
  assert.equal(M.containsShape({ shape: 'polygon', mode: 'reveal', points: [[0, 0], [10, 0], [10, 10]] }, 8, 2), true);
  assert.equal(M.containsShape({ shape: 'polygon', mode: 'reveal', points: [[0, 0], [10, 0], [10, 10]] }, 1, 8), false);
});

test('туман: стек отмены на карту (не больше 20 шагов)', () => {
  let stack = [];
  for (let i = 0; i < 25; i++) stack = M.pushUndo(stack, [rect(i, i, i + 1, i + 1)]);
  assert.equal(stack.length, 20);
  assert.equal(stack.length, M.FOG_UNDO_MAX);
  assert.deepEqual(plain(stack[0]), [rect(5, 5, 6, 6)], 'старые шаги вытеснены');

  let step = M.undoStep(stack);
  assert.deepEqual(plain(step.shapes), [rect(24, 24, 25, 25)], 'отменяется последний мазок');
  assert.equal(step.stack.length, 19);
  step = M.undoStep(step.stack);
  assert.deepEqual(plain(step.shapes), [rect(23, 23, 24, 24)]);
  assert.deepEqual(plain(M.undoStep([])), { shapes: null, stack: [] }, 'отменять нечего');

  // Снимок — копия: правка живой маски не меняет историю.
  const live = [rect(0, 0, 10, 10)];
  const saved = M.pushUndo([], live);
  live[0].points[0][0] = 999;
  assert.equal(saved[0][0].points[0][0], 0);
});

test('туман: «Открыть всё», добавление фигур и лимит на карту', () => {
  const b = bounds(0, 0, 700, 500);
  assert.deepEqual(plain(M.revealAllShapes(b)), [rect(0, 0, 700, 500)], '«Открыть всё» — прямоугольник по карте');
  assert.deepEqual(plain(M.revealAllShapes(null)), []);

  const fog = M.normalizeFog({}, {});
  const added = M.addMaskShape(fog, 'm', rect(-50, -50, 100, 100), b);
  assert.equal(added.added, true);
  assert.deepEqual(plain(added.shapes), [rect(0, 0, 100, 100)], 'фигура обрезана по карте');
  const outside = M.addMaskShape(added.fog, 'm', rect(800, 800, 900, 900), b);
  assert.equal(outside.added, false, 'фигура вне карты не добавляется');
  assert.equal(M.maskShapes(outside.fog, 'm').length, 1);

  const many = M.normalizeFog({ enabled: true, by_map: { m: { shapes: Array.from({ length: M.FOG_MAX_SHAPES }, (_, i) => rect(i % 700, 0, (i % 700) + 10, 10)) } } });
  const over = M.addMaskShape(many, 'm', rect(1, 1, 2, 2), b);
  assert.equal(over.added, false, 'лимит фигур на карту');
  assert.equal(M.maskShapes(over.fog, 'm').length, M.FOG_MAX_SHAPES);
  assert.equal(M.FOG_MAX_SHAPES, 200);
});

test('туман: фигура из протяжки и размер кисти в клетках', () => {
  const brush = M.fogShape('brush', [[0, 0], [10, 10]], { mode: 'reveal', cells: 2, gridSize: 70 });
  assert.equal(brush.shape, 'path');
  assert.equal(brush.width, 140, '2 клетки по 70 px');
  assert.equal(brush.mode, 'reveal');
  assert.equal(M.fogShape('eraser', [[0, 0], [5, 5]], { mode: 'hide', cells: 1, gridSize: 70 }).width, 70);
  assert.equal(M.fogBrushWidth(0, 70), 70, 'минимум — 1 клетка');
  assert.equal(M.fogBrushWidth(42, 70), 700, 'максимум — 10 клеток');
  assert.equal(M.fogBrushWidth(3, undefined), 210, 'размер клетки по умолчанию');
  assert.equal(M.fogShape('rect', [[0, 0], [10, 10]], {}).shape, 'rect');
  assert.deepEqual(plain(M.fogShape('circle', [[0, 0], [10, 0]], {}).points), [[0, 0], [10, 0]]);
  assert.equal(M.fogShape('rect', [[0, 0]], {}), null, 'прямоугольнику нужны две точки');
  assert.equal(M.fogShape('rect', [[0, 0], [0, 10]], {}), null, 'вырожденный прямоугольник не создаётся');
  assert.equal(M.fogShape('circle', [[5, 5], [5, 5]], {}), null, 'круг нулевого радиуса не создаётся');
  assert.equal(M.fogShape('polygon', [[0, 0], [10, 0]], {}), null, 'многоугольнику — три');
  // Клик кистью без движения — точка (две совпадающие точки), сервер принимает её как мазок.
  const dot = M.fogShape('brush', [[30, 40]], { mode: 'reveal', cells: 1, gridSize: 70 });
  assert.deepEqual(plain(dot.points), [[30, 40], [30, 40]]);
  assert.equal(M.normalizeShape(dot).shape, 'path');
});

test('туман: битые фигуры и id карт отбрасываются', () => {
  const ok = { shape: 'rect', mode: 'reveal', points: [[0, 0], [10, 10]] };
  assert.notEqual(M.normalizeShape(ok), null);
  for (const bad of [null, 'rect', {}, { ...ok, shape: 'line' }, { ...ok, mode: 'open' },
    { ...ok, points: [[0, 0], [Infinity, 10]] }, { ...ok, points: [[0]] }, { ...ok, points: [] }, { ...ok, points: 'нет' }]) {
    assert.equal(M.normalizeShape(bad), null, `принял ${JSON.stringify(bad)}`);
  }
  assert.equal(M.normalizeShape({ shape: 'path', mode: 'reveal', points: [[0, 0], [1, 1]] }), null, 'мазку нужна ширина');
  assert.equal(M.normalizeShape({ shape: 'path', mode: 'reveal', points: [[0, 0], [1, 1]], width: 10 }).shape, 'path');

  const fog = M.normalizeFog({ enabled: true, by_map: { ['x'.repeat(65)]: { shapes: [ok] }, m: { shapes: [ok] } } });
  assert.deepEqual(plain(Object.keys(fog.by_map)), ['m'], 'слишком длинный id карты отброшен');
  assert.equal(fog.by_map.m.shapes.length, 1);
});

test('table.js работает с маской на карту, а не с глобальным fog.shapes', () => {
  const table = fs.readFileSync('static/table.js', 'utf8');
  assert.ok(table.includes('normalizeFog'), 'старый формат читается только в миграции (table-model.js)');
  assert.equal(table.includes('S.scene.fog?.shapes'), false, 'прямого чтения старого fog.shapes нет');
  assert.equal(table.includes('fogShape'), true, 'туман рисуется инструментами панели');
  for (const name of ['getFog', 'getFogMask', 'openAllFog', 'hideAllFog', 'undoFog', 'selectFogTool']) {
    assert.ok(table.includes(name), `API тумана: ${name}`);
  }
  assert.ok(table.includes('by_map') || table.includes('maskShapes'), 'код читает маску через модель');
});
