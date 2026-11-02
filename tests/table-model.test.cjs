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
