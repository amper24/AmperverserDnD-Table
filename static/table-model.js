// ---------------------------------------------------------------------------
// table-model.js — чистые функции виртуального стола: слои сцены, карты,
// геометрия сетки (квадраты/гексы), привязка позиций, линейка.
// Без DOM и без сети — поэтому проверяется юнит-тестами (tests/table-model.test.cjs)
// и используется table.js и table-page.js.
// Даёт: window.TableModel.
// Зависимости: asset-kinds.js (LAYER_ORDER, LAYER, kindForLayer).
// ---------------------------------------------------------------------------
// Слои: список scene.layers = [{ id, name, order, locked?, hidden? }]. Порядок order
// задаёт отрисовку: меньший order рисуется первым (слой «ниже»). Старые сцены без
// scene.layers получают список из LAYER_ORDER — так элементы со старыми id слоёв
// продолжают работать. Неизвестный id слоя у элемента попадает на слой prop.
window.TableModel = (() => {
  const A = window.AssetKinds;
  const LAYER = A.LAYER;
  // Слой, на который попадают элементы неизвестных (удалённых/чужих) слоёв.
  const FALLBACK_LAYER = LAYER.prop;
  const MAX_LAYERS = 32;
  const MAX_NAME = 64;
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  // Имена слоёв по умолчанию: прежние подписи интерфейса стола.
  const LAYER_NAMES = {
    map: 'Карта', prop: 'Объекты', mount: 'Ездовые', character: 'Персонажи',
    attachment: 'Прикреплённые', drawing: 'Рисунки', text: 'Текст', note: 'Заметки',
  };
  const layerName = id => LAYER_NAMES[id] || String(id || '');

  // ---------- модель слоёв ----------
  /// Слои по умолчанию: прежний фиксированный порядок LAYER_ORDER.
  function defaultLayers() {
    return A.layerOrder.map((id, i) => ({ id, name: layerName(id), order: i, hidden: false, locked: false }));
  }

  /// Приводит произвольное значение к валидному списку слоёв.
  /// Пустой/битый вход — слои по умолчанию (совместимость со старыми сценами).
  function normalize(raw) {
    const seen = new Set();
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const id = String(entry.id ?? '').trim().toLowerCase();
      if (!ID_RE.test(id) || seen.has(id) || out.length >= MAX_LAYERS) return;
      seen.add(id);
      const order = Number(entry.order);
      out.push({
        id,
        name: String(entry.name ?? '').trim().slice(0, MAX_NAME) || layerName(id),
        order: Number.isFinite(order) ? order : i,
        hidden: !!entry.hidden,
        locked: !!entry.locked,
      });
    });
    if (!out.length) return defaultLayers();
    out.sort((a, b) => a.order - b.order);
    out.forEach((l, i) => { l.order = i; });
    return out;
  }

  const all = layers => (Array.isArray(layers) && layers.length ? layers : defaultLayers());
  function find(layers, id) { return all(layers).find(l => l.id === id) || null; }
  /// Слой по id с фолбэком на prop (и на первый доступный слой).
  function resolve(layers, id) {
    const list = all(layers);
    return find(list, id) || find(list, FALLBACK_LAYER) || list[0] || { id: FALLBACK_LAYER, name: layerName(FALLBACK_LAYER), order: 0, hidden: false, locked: false };
  }
  const orderOf = (layers, id) => resolve(layers, id).order;
  function nextLayerId(layers) {
    const ids = new Set(all(layers).map(l => l.id));
    let n = 1;
    while (ids.has('custom-' + n)) n++;
    return 'custom-' + n;
  }
  /// Добавляет слой сверху. Возвращает новый список.
  function addLayer(layers, name) {
    const list = normalize(layers);
    if (list.length >= MAX_LAYERS) return list;
    const order = list.reduce((m, l) => Math.max(m, l.order), -1) + 1;
    const id = nextLayerId(list);
    return normalize([...list, { id, name: String(name ?? '').trim().slice(0, MAX_NAME) || 'Слой ' + (list.length + 1), order }]);
  }
  /// Удаляет слой (не последний). Элементы удалённого слоя попадут на prop.
  function removeLayer(layers, id) {
    const list = normalize(layers);
    if (list.length <= 1) return list;
    const next = list.filter(l => l.id !== id);
    return next.length === list.length ? list : normalize(next);
  }
  function renameLayer(layers, id, name) {
    const clean = String(name ?? '').trim().slice(0, MAX_NAME);
    return normalize(normalize(layers).map(l => (l.id === id && clean ? { ...l, name: clean } : l)));
  }
  /// Сдвиг слоя по порядку: delta > 0 — выше (рисуется позже), delta < 0 — ниже.
  function moveLayer(layers, id, delta) {
    const list = normalize(layers).slice();
    const i = list.findIndex(l => l.id === id);
    if (i < 0) return list;
    const j = Math.max(0, Math.min(list.length - 1, i + (delta < 0 ? -1 : 1)));
    if (i === j) return list;
    const [moved] = list.splice(i, 1);
    list.splice(j, 0, moved);
    return normalize(list.map((l, k) => ({ ...l, order: k })));
  }
  function setLayerFlag(layers, id, flag, value) {
    if (flag !== 'hidden' && flag !== 'locked') return normalize(layers);
    return normalize(normalize(layers).map(l => (l.id === id ? { ...l, [flag]: !!value } : l)));
  }
  /// Сколько элементов лежит на слое (для «удалить пустой слой»).
  function countItems(items, id) {
    return (items || []).filter(it => (it.layer || FALLBACK_LAYER) === id).length;
  }
  /// Сортировка отрисовки: разрешённый порядок слоя, затем z, затем исходный порядок.
  function sortItems(items, layers) {
    const list = all(layers);
    const order = new Map(list.map(l => [l.id, l.order]));
    const fallback = order.has(FALLBACK_LAYER) ? order.get(FALLBACK_LAYER) : 0;
    const layerIndexOf = it => (order.has(it.layer) ? order.get(it.layer) : fallback);
    return (items || []).map((it, i) => ({ it, i, o: layerIndexOf(it) }))
      .sort((a, b) => a.o - b.o || (a.it.z || 0) - (b.it.z || 0) || a.i - b.i)
      .map(x => x.it);
  }

  // ---------- карты ----------
  function isMap(item) { return (item?.layer || FALLBACK_LAYER) === LAYER.map; }
  function mapItems(items) { return (items || []).filter(isMap); }
  function findMap(scene, id) { return (scene?.items || []).find(it => it.id === id && isMap(it)) || null; }
  /// Активная карта: явный scene.active_map_id, а если он не задан/устарел и карта одна —
  /// эта карта (совместимость со старыми сценами).
  function activeMapId(scene) {
    const items = mapItems(scene?.items);
    if (!items.length) return null;
    const id = scene?.active_map_id;
    if (id && items.some(it => it.id === id)) return id;
    if (items.length === 1) return items[0].id;
    return null;
  }
  function activeMap(scene) { const id = activeMapId(scene); return id ? findMap(scene, id) : null; }
  function boundsOf(item) {
    const d = item?.data || {};
    if (![d.x, d.y, d.w, d.h].every(v => Number.isFinite(+v)) || !(d.w > 0) || !(d.h > 0)) return null;
    return { x: d.x - d.w / 2, y: d.y - d.h / 2, w: d.w, h: d.h };
  }
  function unionBounds(list) {
    const bs = (list || []).filter(Boolean);
    if (!bs.length) return null;
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    const x1 = Math.max(...bs.map(b => b.x + b.w)), y1 = Math.max(...bs.map(b => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /// Границы активной карты, иначе всех карт сцены.
  function boardBounds(scene) { return boundsOf(activeMap(scene)) || unionBounds(mapItems(scene?.items).map(boundsOf)); }
  /// Камера, вписывающая прямоугольник в экран (как прежний fitToMap: поля 50 px, не крупнее 1.5×).
  function fitView(bounds, view, opts = {}) {
    if (!bounds || !(bounds.w > 0) || !(bounds.h > 0) || !view || !(view.w > 0) || !(view.h > 0)) return null;
    const pad = opts.padding ?? 50, maxK = opts.maxScale ?? 1.5, minK = opts.minScale ?? 0.02;
    const k = Math.max(minK, Math.min(maxK, Math.min(view.w / (bounds.w + 2 * pad), view.h / (bounds.h + 2 * pad))));
    return { k, x: (view.w - bounds.w * k) / 2 - bounds.x * k, y: (view.h - bounds.h * k) / 2 - bounds.y * k };
  }

  // ---------- сетка ----------
  const GRID_SIZE = 70;
  const gridSize = grid => (Number(grid?.size) > 0 ? Number(grid.size) : GRID_SIZE);
  const isHex = grid => (grid?.type || 'square') === 'hex';
  function hexMetrics(grid) { const w = gridSize(grid), r = w / Math.sqrt(3); return { w, r, hstep: w, vstep: r * 1.5 }; }
  function hexCenter(q, rr, grid) { const { w, r } = hexMetrics(grid); return { x: w * (q + rr / 2), y: r * 1.5 * rr }; }
  function hexAt(x, y, grid) {
    const { r } = hexMetrics(grid);
    const qf = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / r, rf = (2 / 3 * y) / r;
    let rx = Math.round(qf), rz = Math.round(rf);
    const ry = Math.round(-qf - rf);
    const dx = Math.abs(rx - qf), dz = Math.abs(rz - rf), dy = Math.abs(ry + qf + rf);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dz > dx && dz > dy) rz = -rx - ry;
    return { q: rx, r: rz };
  }
  /// Привязка позиции объекта: мелкий объект — к центру клетки, крупный — к её углу
  /// (гексы — всегда к центру гекса). opts: { grid, snap }.
  function snapPos(x, y, w, h, opts = {}) {
    if (!opts.snap) return { x, y };
    if (isHex(opts.grid)) { const c = hexAt(x, y, opts.grid); return hexCenter(c.q, c.r, opts.grid); }
    const g = gridSize(opts.grid);
    if ((w ?? 0) <= g * 1.01 && (h ?? 0) <= g * 1.01) return { x: Math.round((x - g / 2) / g) * g + g / 2, y: Math.round((y - g / 2) / g) * g + g / 2 };
    return { x: Math.round(x / g) * g, y: Math.round(y / g) * g };
  }
  /// Привязка угла (например, левого верхнего угла карты) к узлу сетки.
  function snapCorner(x, y, grid) {
    if (isHex(grid)) { const c = hexAt(x, y, grid); const p = hexCenter(c.q, c.r, grid); return { x: p.x, y: p.y }; }
    const g = gridSize(grid);
    return { x: Math.round(x / g) * g, y: Math.round(y / g) * g };
  }

  // ---------- линейка ----------
  /// Привязка точек линейки к сетке: квадраты — к узлам (углам клеток), гексы — к центрам.
  /// ctrl === true — свободный режим без привязки.
  function snapRuler(points, grid, ctrl) {
    const raw = (points || []).map(p => [Number(p?.[0]) || 0, Number(p?.[1]) || 0]);
    if (ctrl) return raw;
    return raw.map(([x, y]) => { const p = snapCorner(x, y, grid); return [p.x, p.y]; });
  }
  /// Длина линейки в клетках (как считается расстояние в D&D: по осям/гексам, без диагоналей).
  function rulerCells(points, grid) {
    const [a, b] = points || [];
    if (!a || !b) return 0;
    if (isHex(grid)) {
      const ha = hexAt(a[0], a[1], grid), hb = hexAt(b[0], b[1], grid);
      return Math.max(Math.abs(ha.q - hb.q), Math.abs(ha.r - hb.r), Math.abs((-ha.q - ha.r) - (-hb.q - hb.r)));
    }
    const g = gridSize(grid);
    return Math.max(Math.abs(b[0] - a[0]) / g, Math.abs(b[1] - a[1]) / g);
  }
  /// Футы на клетку из scene.grid.scale («5 фт» → 5).
  function scaleFt(grid, fallback = 5) { const n = parseInt(grid?.scale); return Number.isFinite(n) && n > 0 ? n : fallback; }
  /// Подпись линейки — тот же текст, что и раньше: «30 фт (6 кл.) — Имя».
  function rulerLabel(points, grid, ft, name) {
    const cells = rulerCells(points, grid);
    const total = Math.round(cells * (Number(ft) || 5));
    return `${total} фт (${Math.round(cells * 10) / 10} кл.)` + (name ? ' — ' + name : '');
  }

  return {
    LAYER, FALLBACK_LAYER, LAYER_NAMES, layerName, MAX_LAYERS,
    defaultLayers, normalize, find, resolve, orderOf, addLayer, removeLayer, renameLayer, moveLayer, setLayerFlag,
    countItems, sortItems,
    isMap, mapItems, findMap, activeMapId, activeMap, boundsOf, unionBounds, boardBounds, fitView,
    gridSize, isHex, hexMetrics, hexCenter, hexAt, snapPos, snapCorner,
    snapRuler, rulerCells, scaleFt, rulerLabel,
  };
})();
