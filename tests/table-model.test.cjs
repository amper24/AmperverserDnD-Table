// Модель стола: слои сцены, активная карта, сетка и линейка (чистые функции).
// table-model.js не трогает DOM и сеть, поэтому проверяется в vm-контексте.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadModel() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/core/asset-kinds.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('static/table/table-model.js', 'utf8'), ctx);
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
  assert.deepEqual(plain(M.snapRuler([[103, 97], [281, 349]], g, false)), [[105, 105], [315, 315]], 'квадраты: к центрам клеток');
  assert.deepEqual(plain(M.snapRuler([[103, 97], [281, 349]], g, true)), [[103, 97], [281, 349]], 'Ctrl — свободный режим');
  // Привязка идемпотентна: повторный снап уже привязанных точек ничего не двигает.
  assert.deepEqual(plain(M.snapRuler(M.snapRuler([[103, 97], [281, 349]], g, false), g, false)), [[105, 105], [315, 315]]);
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

test('карта: прямоугольник нового объекта — пиксели картинки и привязка угла к сетке', () => {
  const square = { size: 70, type: 'square' };
  // Размер карты — пиксели изображения (столько клеток, сколько пикселей при сетке 70).
  // Центр — в точке броска; левый верхний угол притянут к узлу сетки.
  assert.deepEqual(
    plain(M.mapRect({ width: 1400, height: 700 }, { x: 500, y: 500 }, { grid: square, snap: true })),
    { x: 490, y: 490, w: 1400, h: 700 },
  );
  // Привязка выключена или гексы — позиция ровно там, где бросили.
  assert.deepEqual(plain(M.mapRect({ width: 1400, height: 700 }, { x: 500, y: 500 }, { grid: square, snap: false })), { x: 500, y: 500, w: 1400, h: 700 });
  assert.deepEqual(plain(M.mapRect({ width: 1400, height: 700 }, { x: 500, y: 500 }, { grid: { size: 70, type: 'hex' }, snap: true, hex: true })), { x: 500, y: 500, w: 1400, h: 700 });
  // Нет размеров у ассета (старая запись) — карта 10×10 клеток, а не нулевая.
  assert.deepEqual(plain(M.mapRect({}, { x: 70, y: 70 }, { grid: square, snap: true })), { x: 70, y: 70, w: 700, h: 700 });
  assert.deepEqual(plain(M.mapRect({ width: 0, height: -5 }, { x: 0, y: 0 }, { grid: square, snap: false })), { x: 0, y: 0, w: 700, h: 700 });
  // Битые координаты точки — 0, а не NaN (иначе элемент пропадал бы с канвы).
  assert.deepEqual(plain(M.mapRect({ width: 700, height: 700 }, { x: 'a', y: null }, { grid: square, snap: false })), { x: 0, y: 0, w: 700, h: 700 });
});

test('table.js/app.js используют модель и больше не ограничивают число карт', () => {
  const table = fs.readFileSync('static/table/table.js', 'utf8');
  const app = fs.readFileSync('static/pages/app.js', 'utf8');
  assert.ok(table.includes('window.TableModel'), 'table.js берёт слои/карты/линейку из модели');
  assert.equal(table.includes('Заменить текущую карту?'), false, 'карту больше не «заменяют»');
  assert.equal(/find\(i => i\.layer === LAYER\.map\)/.test(table), false, 'нет поиска «первой карты» для fitToMap/тумана');
  assert.ok(table.includes('setActiveMap') && table.includes('getActiveMapId'), 'активная карта доступна наружу');
  assert.ok(table.includes('setLayers') && table.includes('getLayers'), 'слои сцены доступны наружу');
  assert.ok(app.includes('Table.getLayers()'), 'селектор слоя берёт список из сцены');
  assert.ok(app.includes('TableModel.addLayer') && app.includes('TableModel.removeLayer'), 'панель слоёв работает через модель');
  assert.ok(app.includes('/table/'), 'со стола есть ссылка на страницу участников');
  const html = fs.readFileSync('static/index.html', 'utf8');
  assert.ok(html.indexOf('/static/table/table-model.js') < html.indexOf('/static/table/table.js'), 'table-model.js загружается до table.js');
});

test('новая карта уходит на сервер как явное создание (иначе он её молча отбрасывал)', () => {
  const table = fs.readFileSync('static/table/table.js', 'utf8');
  // Геометрия карты — в модели, а не в placeAsset.
  assert.ok(table.includes('T.mapRect('), 'placeAsset считает прямоугольник карты через модель');
  assert.equal(/wdt = \+a\.width/.test(table), false, 'старый расчёт размера карты убран');
  // id карты известен клиенту сразу, поэтому создание помечается флагом create:true:
  // без него сервер считает «id есть, строки нет» запоздавшим движением и отбрасывает.
  assert.ok(/upsert\(item, \{ create: isMap \}\)/.test(table), 'создание карты помечено create');
  assert.ok(/create: opts\.create \|\| undefined/.test(table), 'upsert передаёт флаг в item_upsert');
  // Карта видна сразу: новый объект с известным id добавляется локально, а не ждёт рассылки.
  assert.ok(/S\.scene\.items\.push\(it\)/.test(table), 'upsert добавляет новый объект локально');
  // Отказ сервера теперь виден, а не «ничего не произошло».
  assert.ok(/case 'error': rollbackPending\(/.test(table), 'ошибка сервера обрабатывается');
  assert.ok(/S\.pending/.test(table), 'неподтверждённые объекты отслеживаются');
});

// ---------------------------------------------------------------- туман войны (бинарная растровая маска 0/100)
const bounds = (x, y, w, h) => ({ x, y, w, h });
const rect = (x0, y0, x1, y1, mode = 'reveal') => ({ shape: 'rect', mode, points: [[x0, y0], [x1, y1]] });
const B = bounds(0, 0, 700, 700);   // карта 700×700, клетка 70 → маска 10×10
const CELL = 70;
const flat = mask => mask.data.flat();
const revealedCount = mask => flat(mask).filter(v => v === 100).length;
const assertBinary = mask => assert.ok(flat(mask).every(v => v === 0 || v === 100), 'все клетки маски строго 0/100');
const opts = extra => ({ activeMapId: 'm', mapIds: ['m'], cell: CELL, boundsByMap: { m: B }, ...extra });

test('туман: старый scene.fog.shapes растеризуется в бинарную маску активной карты', () => {
  const legacy = {
    enabled: true,
    shapes: [
      rect(0, 0, 140, 140),
      { shape: 'poly', mode: 'hide', points: [[70, 70], [140, 70], [140, 140]] },
      { shape: 'circle', mode: 'reveal', points: [[350, 350], [420, 350]] },
      { shape: 'rect', mode: 'open', points: [[0, 0], [10, 10]] },   // битый режим — отброшен
      { shape: 'rect', mode: 'reveal', points: [[0, 0], [Infinity, 10]] },
    ],
  };
  const fog = M.normalizeFog(legacy, opts());
  assert.equal(fog.enabled, true, 'включённость переезжает');
  assert.deepEqual(plain(Object.keys(fog.by_map)), ['m'], 'маска уходит активной карте');
  const mask = M.maskOf(fog, 'm', B);
  assert.ok(mask, 'маска создана');
  assert.equal(mask.cols, 10); assert.equal(mask.rows, 10); assert.equal(mask.cell, CELL);
  assert.equal(mask.x, 0); assert.equal(mask.y, 0);
  assertBinary(mask);
  assert.equal(mask.data[0][0], 100, 'rect открыл клетку (0,0)');
  assert.equal(mask.data[1][0], 100, 'клетка (1,0) тоже открыта');
  assert.equal(mask.data[1][1], 0, 'hide-треугольник поверх reveal снова скрывает клетку (1,1)');
  assert.equal(mask.data[5][5], 100, 'круг открыл клетку (5,5)');
  assert.equal(mask.data[9][9], 0);

  // Одна карта без active_map_id — маска её.
  const single = M.normalizeFog(legacy, { mapIds: ['only'], cell: CELL, boundsByMap: { only: B } });
  assert.deepEqual(plain(Object.keys(single.by_map)), ['only']);
  // Карт нет — навешивать маску некуда.
  assert.deepEqual(plain(M.normalizeFog(legacy, {})), { enabled: true, by_map: {} });
  // by_map (новый формат) главнее старого глобального shapes, даже пустой.
  const fresh = M.normalizeFog({ enabled: false, by_map: {}, shapes: [rect(0, 0, 10, 10)] }, opts());
  assert.deepEqual(plain(fresh), { enabled: false, by_map: {} });
  assert.deepEqual(plain(M.normalizeFog(null)), { enabled: false, by_map: {} });
  assert.deepEqual(plain(M.normalizeFog('мусор')), { enabled: false, by_map: {} });
  // Старый per-map shapes тоже растеризуется.
  const perMap = M.normalizeFog({ by_map: { m: { shapes: [rect(0, 0, 70, 70)] } } }, opts());
  assert.equal(M.maskOf(perMap, 'm', B).data[0][0], 100, 'per-map shapes → растр');
});

test('туман: маски карт не смешиваются, переключение активной карты — своя маска', () => {
  let fog = M.normalizeFog({}, {});
  fog = M.setMask(fog, 'a', M.revealAllMask(B, CELL));
  fog = M.setMask(fog, 'b', M.revealAllMask(bounds(2000, 0, 700, 700), CELL));
  const ma = M.maskOf(fog, 'a', B), mb = M.maskOf(fog, 'b', bounds(2000, 0, 700, 700));
  assert.equal(ma.cols, 10);
  assert.equal(mb.x, 2000, 'маска карты b приклеена к её границам');
  // Правка маски a не трогает b.
  const res = M.addMaskStroke(fog, 'a', rect(0, 0, 70, 70, 'hide'), B, CELL);
  assert.equal(res.added, true);
  assert.equal(M.maskOf(res.fog, 'a', B).data[0][0], 0, 'hide-мазок закрыл клетку на карте a');
  assert.equal(M.maskOf(res.fog, 'b', bounds(2000, 0, 700, 700)).data[0][0], 100, 'карта b не изменилась');
  // Карта без записи — вся скрыта.
  assert.equal(M.maskOf(fog, 'c', B), null);
  assert.equal(M.isRevealed(fog, 'c', 100, 100, B), false);
  // setMask заменяет маску целиком, а не дополняет; null/вся-ноль удаляют запись.
  fog = M.setMask(fog, 'a', M.emptyMask(B, CELL));
  assert.equal(fog.by_map.a, undefined, 'вся-ноль маска = удалить запись (карта скрыта)');
  assert.equal(M.maskOf(fog, 'b', bounds(2000, 0, 700, 700)).data[0][0], 100, 'b на месте');
  // Маска следует за картой: подвинули карту — origin маски переехал.
  const moved = bounds(1000, 500, 700, 700);
  assert.equal(M.maskOf(fog, 'b', moved).x, 1000);
  assert.equal(M.maskOf(fog, 'b', moved).y, 500);

  assert.equal(M.fogEnabled(fog), false);
  assert.equal(M.setFogEnabled(fog, true).enabled, true, '«Показать игрокам» — это fog.enabled');
});

test('туман: мазки растеризуются в пиксели 0/100 (reveal открывает, hide закрывает)', () => {
  let fog = M.normalizeFog({}, {});
  // Кисть: протяжка [100,100]→[300,100], ширина 2 клетки = 140 px.
  const brush = M.fogShape('brush', [[100, 100], [300, 100]], { mode: 'reveal', cells: 2, gridSize: CELL });
  assert.equal(brush.shape, 'path');
  assert.equal(brush.width, 140);
  const r1 = M.addMaskStroke(fog, 'm', brush, B, CELL);
  assert.equal(r1.added, true);
  assertBinary(r1.mask);
  assert.ok(revealedCount(r1.mask) >= 6, 'мазок открыл полосу клеток');
  assert.equal(M.isRevealed(r1.fog, 'm', 200, 100, B), true, 'внутри мазка открыто');
  assert.equal(M.isRevealed(r1.fog, 'm', 200, 400, B), false, 'далеко от мазка скрыто');
  // Hide-мазок (ластик) закрывает часть открытого.
  const eraser = M.fogShape('eraser', [[150, 100], [150, 100]], { mode: 'hide', cells: 3, gridSize: CELL });
  const r2 = M.addMaskStroke(r1.fog, 'm', eraser, B, CELL);
  assert.equal(r2.added, true);
  assertBinary(r2.mask);
  assert.equal(M.isRevealed(r2.fog, 'm', 150, 100, B), false, 'ластик закрыл клетку');
  assert.equal(M.isRevealed(r2.fog, 'm', 300, 100, B), true, 'соседняя клетка осталась открытой');
  // Прямоугольник и круг — тоже в ту же единую маску.
  const r3 = M.addMaskStroke(r2.fog, 'm', M.fogShape('rect', [[500, 500], [650, 650]], { mode: 'reveal' }), B, CELL);
  assert.equal(r3.added, true);
  assert.equal(M.isRevealed(r3.fog, 'm', 550, 550, B), true, 'прямоугольник открыл свою область');
  assert.equal(M.isRevealed(r3.fog, 'm', 400, 400, B), false);
  const r4 = M.addMaskStroke(r3.fog, 'm', M.fogShape('circle', [[350, 600], [420, 600]], { mode: 'reveal' }), B, CELL);
  assert.equal(M.isRevealed(r4.fog, 'm', 385, 600, B), true, 'круг открыл центр');
  // Мазок целиком вне карты ничего не меняет.
  const out = M.addMaskStroke(r4.fog, 'm', M.fogShape('rect', [[800, 800], [900, 900]], { mode: 'reveal' }), B, CELL);
  assert.equal(out.added, false, 'вне карты мазок не добавляется');
  assert.deepEqual(plain(M.maskOf(out.fog, 'm', B)), plain(M.maskOf(r4.fog, 'm', B)));
  // За границей карты всегда скрыто.
  assert.equal(M.isRevealed(r4.fog, 'm', -10, 100, B), false);
  assert.equal(M.isRevealed(r4.fog, 'm', 100, 100, null), false, 'без границ карты тумана нет');
});

test('туман: единая маска — последним мазком задаётся состояние клетки (без порядка фигур)', () => {
  let fog = M.normalizeFog({}, {});
  fog = M.addMaskStroke(fog, 'm', rect(0, 0, 350, 350), B, CELL).fog;      // открыли квадрат 5×5
  fog = M.addMaskStroke(fog, 'm', rect(70, 70, 210, 210, 'hide'), B, CELL).fog; // закрыли внутренний 2×2
  const mask = M.maskOf(fog, 'm', B);
  assertBinary(mask);
  assert.equal(mask.data[0][0], 100, 'внешний квадрат открыт');
  assert.equal(mask.data[2][2], 0, 'внутренний квадрат скрыт последним (hide) мазком');
  assert.equal(mask.data[4][4], 100, 'снова внешняя область открыта');
});

test('туман: отмена убирает последний мазок (снимок маски до него), стек ≤ 20 на карту', () => {
  let fog = M.normalizeFog({}, {});
  let stack = M.pushUndo([], M.maskOf(fog, 'm', B));      // маски ещё не было → null
  const before = null;
  fog = M.addMaskStroke(fog, 'm', rect(0, 0, 140, 140), B, CELL).fog;
  const afterFirst = plain(M.maskOf(fog, 'm', B));
  stack = M.pushUndo(stack, M.maskOf(fog, 'm', B)); // снимок маски ДО второго мазка — как в приложении
  fog = M.addMaskStroke(fog, 'm', rect(350, 350, 490, 490), B, CELL).fog;
  const afterSecond = plain(M.maskOf(fog, 'm', B));

  let step = M.undoStep(stack);
  assert.deepEqual(plain(step.mask), afterFirst, 'отмена вернула маску до второго мазка');
  fog = M.setMask(fog, 'm', step.mask);
  stack = step.stack;
  step = M.undoStep(stack);
  assert.equal(step.mask, null, 'ещё одна отмена — маски не было (запись удаляется)');
  fog = M.setMask(fog, 'm', step.mask);
  assert.equal(fog.by_map.m, undefined, 'мазок убран совсем');
  assert.deepEqual(plain(M.undoStep(step.stack)), { stack: [] }, 'отменять нечего → mask undefined');

  // Лимит стека и независимость снимка от живой маски.
  let st = [];
  for (let i = 0; i < 25; i++) st = M.pushUndo(st, M.emptyMask(B, CELL));
  assert.equal(st.length, M.FOG_UNDO_MAX);
  assert.equal(M.FOG_UNDO_MAX, 20);
  const live = M.revealAllMask(B, CELL);
  const saved = M.pushUndo([], live)[0];
  live.data[0][0] = 0;
  assert.equal(saved.data[0][0], 100, 'снимок — глубокая копия');
});

test('туман: «Открыть всё» / «Скрыть всё» — вся маска 100 / запись удаляется', () => {
  const all = M.revealAllMask(B, CELL);
  assert.equal(all.cols, 10);
  assert.ok(flat(all).every(v => v === 100), 'вся карта открыта');
  let fog = M.setMask(M.normalizeFog({}, {}), 'm', all);
  assert.equal(M.maskOf(fog, 'm', B).data[9][9], 100);
  assert.equal(M.isRevealed(fog, 'm', 690, 690, B), true);
  fog = M.setMask(fog, 'm', null); // «Скрыть всё»
  assert.equal(fog.by_map.m, undefined);
  assert.equal(M.isRevealed(fog, 'm', 100, 100, B), false, 'карта снова вся скрыта');
  assert.equal(M.revealAllMask(null, CELL), null);
});

test('туман: размытие только по краю, внутри строго 0/100; радиус края масштабируется с зумом', () => {
  // Радиус размытия в мировых px — доля клетки; на экране = × зум.
  assert.equal(M.FOG_EDGE_BLUR, 0.5);
  assert.equal(M.fogBlurWorld(CELL), 35);
  assert.equal(M.fogBlurPx(CELL, 1), 35, 'зум 1 → 35 px на экране');
  assert.equal(M.fogBlurPx(CELL, 2), 70, 'зум 2 → 70 px: край растёт вместе с зумом');
  assert.equal(M.fogBlurPx(CELL, 0.5), 17.5, 'зум 0.5 → 17.5 px');

  // Маска: открыта левая половина карты.
  let fog = M.normalizeFog({}, {});
  fog = M.addMaskStroke(fog, 'm', rect(0, 0, 350, 700), B, CELL).fog;
  const mask = M.maskOf(fog, 'm', B);
  assertBinary(mask);
  // Клетка глубоко внутри скрытой области — «внутренняя» (рисуется жёстко, строго 0).
  assert.equal(M.isInteriorCell(mask, 8, 8, 1), true);
  // Клетка рядом с границей открытой области — край (размывается, не жёсткая).
  assert.equal(M.isInteriorCell(mask, 5, 3, 1), false, 'клетка у края — не внутренняя');
  // Открытая клетка — не внутренняя (она прозрачная, а не 0).
  assert.equal(M.isInteriorCell(mask, 0, 0, 1), false);
  // Без маски/вне сетки — не внутренняя.
  assert.equal(M.isInteriorCell(null, 0, 0, 1), false);
  assert.equal(M.isInteriorCell(mask, -1, 0, 1), false);
});

test('туман: normalizeMask приводит значения строго к 0/100 и режет битые маски', () => {
  const good = M.normalizeMask({ x: 0, y: 0, cell: 70, cols: 2, rows: 1, data: [[100, 50]] }, B);
  assert.deepEqual(plain(good.data), [[100, 0]], '50 → 0, только 100 остаётся 100');
  assert.equal(good.x, 0);
  // bounds приклеивают маску к текущим границам карты.
  assert.equal(M.normalizeMask({ x: 999, y: 0, cell: 70, cols: 1, rows: 1, data: [[100]] }, B).x, 0);
  for (const bad of [
    null, 'x', [], {}, { data: 'нет' },
    { x: 0, y: 0, cell: 0, cols: 1, rows: 1, data: [[100]] },       // cell < 1
    { x: 0, y: 0, cell: 70, cols: 600, rows: 1, data: [[100]] },    // cols > FOG_MAX_DIM
    { x: 0, y: 0, cell: 70, cols: 0, rows: 1, data: [] },           // cols = 0
    { x: 0, y: 0, cell: 70, cols: 1.5, rows: 1, data: [[100]] },    // нецелое
    { x: 1e9, y: 0, cell: 70, cols: 1, rows: 1, data: [[100]] },    // координата вне пределов
  ]) {
    assert.equal(M.normalizeMask(bad, B), null, `принял ${JSON.stringify(bad)}`);
  }
  assert.equal(M.FOG_MAX_DIM, 512);
  // id карты длиннее 64 символов отбрасывается.
  const fog = M.normalizeFog({ by_map: { ['x'.repeat(65)]: M.revealAllMask(B, CELL), m: M.revealAllMask(B, CELL) } }, opts());
  assert.deepEqual(plain(Object.keys(fog.by_map)), ['m']);
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
  // Клик кистью без движения — точка (две совпадающие точки дают круглый отпечаток).
  const dot = M.fogShape('brush', [[30, 40]], { mode: 'reveal', cells: 1, gridSize: 70 });
  assert.deepEqual(plain(dot.points), [[30, 40], [30, 40]]);
  assert.equal(M.normalizeShape(dot).shape, 'path');
});

test('туман: битые фигуры-мазки отбрасываются', () => {
  const ok = { shape: 'rect', mode: 'reveal', points: [[0, 0], [10, 10]] };
  assert.notEqual(M.normalizeShape(ok), null);
  for (const bad of [null, 'rect', {}, { ...ok, shape: 'line' }, { ...ok, mode: 'open' },
    { ...ok, points: [[0, 0], [Infinity, 10]] }, { ...ok, points: [[0]] }, { ...ok, points: [] }, { ...ok, points: 'нет' }]) {
    assert.equal(M.normalizeShape(bad), null, `принял ${JSON.stringify(bad)}`);
  }
  assert.equal(M.normalizeShape({ shape: 'path', mode: 'reveal', points: [[0, 0], [1, 1]] }), null, 'мазку нужна ширина');
  assert.equal(M.normalizeShape({ shape: 'path', mode: 'reveal', points: [[0, 0], [1, 1]], width: 10 }).shape, 'path');
});

test('table.js работает с растровой маской на карту (а не со списком фигур)', () => {
  const table = fs.readFileSync('static/table/table.js', 'utf8');
  assert.ok(table.includes('T.maskOf') && table.includes('T.addMaskStroke') && table.includes('T.setMask'), 'API растровой маски');
  assert.ok(table.includes('fogBuffers') && table.includes('isInteriorCell'), 'рендер: размытый край + жёсткая середина');
  assert.ok(table.includes('fogBlurWorld'), 'радиус края в мировых px (масштабируется с зумом)');
  assert.equal(table.includes('maskShapes'), false, 'старого списочного API нет');
  assert.equal(table.includes('S.scene.fog?.shapes'), false, 'прямого чтения старого fog.shapes нет');
  for (const name of ['getFog', 'getFogMask', 'openAllFog', 'hideAllFog', 'undoFog', 'selectFogTool']) {
    assert.ok(table.includes(name), `API тумана: ${name}`);
  }
});
