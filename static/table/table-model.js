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
  /// Видимый диапазон гексов для прямоугольника мира (x0..x1, y0..y1).
  /// Формула та же, что у отрисовки: запас в один гекс по краям, поэтому
  /// диапазон можно использовать и для подсчёта клеток кадра.
  function hexRowRange(rr, x0, x1, grid) {
    const { w } = hexMetrics(grid);
    return { q0: Math.floor(x0 / w - rr / 2) - 1, q1: Math.ceil(x1 / w - rr / 2) + 1 };
  }
  function hexVisibleRange(x0, y0, x1, y1, grid) {
    const { r } = hexMetrics(grid);
    const hstep = r * 1.5;
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 < x0 || y1 < y0) return { r0: 0, r1: -1, q0: 0, q1: -1, rows: 0, count: 0 };
    const r0 = Math.floor(y0 / hstep) - 1, r1 = Math.ceil(y1 / hstep) + 1;
    let count = 0, q0 = Infinity, q1 = -Infinity, rows = 0;
    for (let rr = r0; rr <= r1; rr++) {
      const row = hexRowRange(rr, x0, x1, grid);
      if (row.q1 < row.q0) continue;
      rows++;
      count += row.q1 - row.q0 + 1;
      if (row.q0 < q0) q0 = row.q0;
      if (row.q1 > q1) q1 = row.q1;
    }
    return { r0, r1, q0: rows ? q0 : 0, q1: rows ? q1 : -1, rows, count };
  }
  /// Ключ кэша сетки: тип/размер/цвет/видимость, зум, dpr и размер вьюпорта.
  /// Пан камеры в ключ не входит — кэш сдвигается без перерисовки.
  function gridCacheKey(opts = {}) {
    const g = opts.grid || {};
    return [isHex(g) ? 'hex' : 'square', gridSize(g), String(opts.color ?? g.color ?? ''), g.visible ? 1 : 0,
      Number(opts.dpr) || 1, Number(opts.k) || 1, Number(opts.w) || 0, Number(opts.h) || 0].join('|');
  }
  /// Накрывает ли прямоугольник кэша (экранные CSS-px) весь вьюпорт.
  function gridCacheCovers(rect, w, h, tolerance = 0) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return false;
    return rect.x <= tolerance && rect.y <= tolerance
      && rect.x + rect.w >= w - tolerance && rect.y + rect.h >= h - tolerance;
  }
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

  /// Привязка к центру клетки/гекса (линейка): край клетки не используется.
  function snapCenter(x, y, grid) {
    if (isHex(grid)) { const c = hexAt(x, y, grid); const p = hexCenter(c.q, c.r, grid); return { x: p.x, y: p.y }; }
    const g = gridSize(grid);
    return { x: Math.round((x - g / 2) / g) * g + g / 2, y: Math.round((y - g / 2) / g) * g + g / 2 };
  }

  // ---------- ресайз объекта за ручку ----------
  /// Прямоугольник после протяжки ручки. start = { x, y, w, h } — центр и размеры на
  /// момент нажатия; dx/dy — ход курсора от точки нажатия (не от прошлого события!);
  /// handle — 'nw','n','ne','e','se','s','sw','w'. Противоположная ручке сторона стоит
  /// на месте, поэтому ручка идёт за курсором ровно, а размер меняется на весь ход.
  /// opts.lockAspect — сцепленные пропорции (ведёт потянутая ось); opts.min — минимум в px.
  function resizeRect(start, handle, dx, dy, opts = {}) {
    const min = Number(opts.min) > 0 ? Number(opts.min) : 8;
    const h = String(handle || '');
    const west = h.includes('w'), east = h.includes('e');
    const north = h.includes('n'), south = h.includes('s');
    let w = start.w, ht = start.h;
    if (west) w = Math.max(min, start.w - dx);
    if (east) w = Math.max(min, start.w + dx);
    if (north) ht = Math.max(min, start.h - dy);
    if (south) ht = Math.max(min, start.h + dy);
    if (opts.lockAspect) {
      const aspect = start.w / Math.max(start.h, 1);
      if (west || east) ht = Math.max(min, w / aspect);
      else if (north || south) w = Math.max(min, ht * aspect);
    }
    return {
      x: start.x + ((west || east) ? dx / 2 : 0),
      y: start.y + (north ? (start.h - ht) / 2 : south ? (ht - start.h) / 2 : 0),
      w, h: ht,
    };
  }

  /// Угол поворота объекта после протяжки ручки поворота.
  /// startAng — угол «центр → точка нажатия» (градусы), curAng — «центр → курсор»;
  /// step > 1 — шаг привязки (45° по Shift, 15° по Ctrl+Shift); base — угол на нажатии.
  /// Результат всегда в 0..360.
  function rotateAngle(startAng, curAng, step = 1, base = 0) {
    let delta = curAng - startAng;
    if (step > 1) delta = Math.round((base + delta) / step) * step - base;
    return ((base + delta) % 360 + 360) % 360;
  }

  // ---------- размещение ассетов ----------
  /// Прямоугольник новой карты: размер — пиксели картинки (карта занимает столько клеток,
  /// сколько у неё пикселей при текущем размере сетки; нет размеров — 10×10 клеток).
  /// Центр — в точке броска; на квадратах верхний левый угол притягивается к узлу сетки,
  /// чтобы клетки карты совпали с клетками стола. На гексах/без привязки — как бросили.
  /// opts: { grid, snap, hex }.
  function mapRect(asset, point, opts = {}) {
    const g = gridSize(opts.grid);
    const w = Number(asset?.width) > 0 ? Number(asset.width) : g * 10;
    const h = Number(asset?.height) > 0 ? Number(asset.height) : g * 10;
    const x = Number(point?.x) || 0, y = Number(point?.y) || 0;
    if (opts.hex || !opts.snap) return { x, y, w, h };
    const c = snapCorner(x - w / 2, y - h / 2, opts.grid);
    return { x: c.x + w / 2, y: c.y + h / 2, w, h };
  }

  // ---------- линейка ----------
  /// Привязка точек линейки к центрам клеток (квадраты и гексы).
  /// ctrl === true — свободный режим без привязки.
  function snapRuler(points, grid, ctrl) {
    const raw = (points || []).map(p => [Number(p?.[0]) || 0, Number(p?.[1]) || 0]);
    if (ctrl) return raw;
    return raw.map(([x, y]) => { const p = snapCenter(x, y, grid); return [p.x, p.y]; });
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

  // ---------- туман войны ----------
  // Бинарная растровая маска НА КАРТУ: scene.fog = { enabled, by_map: { "<id карты>": mask } }.
  // mask = { x, y, cell, cols, rows, data: [[0|100, …], …] } — data[row][col], 100 = открыто, 0 = скрыто.
  // x/y — левый верхний угол карты (маска приклеена к карте и следует за ней), cell — размер клетки
  // маски в мировых px (обычно scene.grid.size), cols/rows покрывают карту.
  // Единая маска на все мазки: reveal-мазок ставит клеткам 100, hide-мазок — 0, отмена восстанавливает
  // снимок маски до мазка. Записи нет (или она вся из 0) — карта полностью скрыта.
  // Старые форматы (глобальный scene.fog.shapes и per-map shapes) растеризуются в маску при загрузке —
  // только в normalizeFog; дальше код читает только растровую маску.
  const FOG_UNDO_MAX = 20;      // шагов отмены на карту
  const FOG_BRUSH_MIN = 1;
  const FOG_BRUSH_MAX = 10;
  const FOG_MAX_MAP_ID = 64;
  const FOG_MAX_COORD = 1e7;
  const FOG_MAX_WIDTH = 10000;  // ширина мазка, мировые px
  const FOG_MAX_DIM = 512;      // предел cols/rows маски (столько же проверяет сервер)
  const FOG_MIN_CELL = 1;
  const FOG_MAX_CELL = 10000;
  /// Размытие края тумана — доля клетки в мировых px; на экране ширина края = fogBlurPx(cell, zoom),
  /// т.е. масштабируется вместе с зумом. Внутри маски значения строго 0/100 — размывается только край.
  const FOG_EDGE_BLUR = 0.5;
  const FOG_SHAPES = ['rect', 'circle', 'polygon', 'path'];
  const FOG_MODES = ['reveal', 'hide'];

  const finite = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= FOG_MAX_COORD;
  const clampBrush = n => Math.max(FOG_BRUSH_MIN, Math.min(FOG_BRUSH_MAX, Math.round(Number(n) || FOG_BRUSH_MIN)));
  /// Ширина мазка кисти в мировых px: размер в клетках × размер клетки.
  const fogBrushWidth = (cells, gridSize) => clampBrush(cells) * (Number(gridSize) > 0 ? Number(gridSize) : GRID_SIZE);
  /// Размытие края в мировых px (при зуме 1) и на экране при данном зуме — линейно от зума.
  const fogBlurWorld = cell => (Number(cell) > 0 ? Number(cell) : GRID_SIZE) * FOG_EDGE_BLUR;
  const fogBlurPx = (cell, zoom) => fogBlurWorld(cell) * (Number(zoom) || 1);

  /// Одна фигура-мазок из произвольного JSON; null — битая (неизвестный вид/режим/точки/ширина).
  /// 'poly' — старое имя многоугольника: дальше живёт только 'polygon'.
  function normalizeShape(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const kind = String(raw.shape ?? '').trim().toLowerCase();
    const shape = kind === 'poly' ? 'polygon' : kind;
    if (!FOG_SHAPES.includes(shape)) return null;
    const mode = String(raw.mode ?? '').trim().toLowerCase();
    if (!FOG_MODES.includes(mode)) return null;
    if (!Array.isArray(raw.points)) return null;
    const points = [];
    for (const p of raw.points) {
      if (!Array.isArray(p) || p.length < 2 || !finite(p[0]) || !finite(p[1])) return null;
      points.push([p[0], p[1]]);
    }
    const limits = shape === 'rect' || shape === 'circle' ? [2, 2] : shape === 'polygon' ? [3, 256] : [2, 2048];
    if (points.length < limits[0] || points.length > limits[1]) return null;
    const out = { shape, mode, points };
    if (shape === 'path') {
      const w = raw.width;
      if (!finite(w) || w <= 0 || w > FOG_MAX_WIDTH) return null;
      out.width = w;
    }
    return out;
  }

  // --- геометрия фигур-мазков: попадание точки (нужно и для растеризации, и для миграции) ---
  const shapeRadius = sh => (sh && sh.points && sh.points.length > 1 ? Math.hypot(sh.points[1][0] - sh.points[0][0], sh.points[1][1] - sh.points[0][1]) : 0);
  function pointInPolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i][0], yi = points[i][1], xj = points[j][0], yj = points[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToSegment(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    if (!len) return Math.hypot(x - ax, y - ay);
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  }
  /// Точка внутри фигуры (для path — не дальше половины ширины мазка от линии).
  function containsShape(shape, x, y) {
    if (!shape || !finite(x) || !finite(y)) return false;
    const p = Array.isArray(shape.points) ? shape.points : [];
    if (shape.shape === 'rect') {
      if (p.length < 2) return false;
      return x >= Math.min(p[0][0], p[1][0]) && x <= Math.max(p[0][0], p[1][0])
        && y >= Math.min(p[0][1], p[1][1]) && y <= Math.max(p[0][1], p[1][1]);
    }
    if (shape.shape === 'circle') {
      if (p.length < 2) return false;
      return Math.hypot(x - p[0][0], y - p[0][1]) <= shapeRadius(shape);
    }
    if (shape.shape === 'polygon') return p.length >= 3 && pointInPolygon(p, x, y);
    if (shape.shape === 'path') {
      const half = (Number(shape.width) || 0) / 2;
      if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= half;
      for (let i = 1; i < p.length; i++) if (distToSegment(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= half) return true;
      return false;
    }
    return false;
  }

  // --- бинарная растровая маска ---
  /// Значение клетки строго 0/100: 100 только за 100, прочее — 0 (скрыто).
  const maskCell = v => (v === 100 ? 100 : 0);
  /// Пустая (вся скрытая) маска по прямоугольнику карты; null — плохие границы/клетка.
  function emptyMask(bounds, cell) {
    const cs = Number(cell);
    if (!bounds || !(bounds.w > 0) || !(bounds.h > 0) || !(cs >= FOG_MIN_CELL && cs <= FOG_MAX_CELL)) return null;
    const cols = Math.max(1, Math.min(FOG_MAX_DIM, Math.ceil(bounds.w / cs)));
    const rows = Math.max(1, Math.min(FOG_MAX_DIM, Math.ceil(bounds.h / cs)));
    return { x: bounds.x, y: bounds.y, cell: cs, cols, rows, data: Array.from({ length: rows }, () => new Array(cols).fill(0)) };
  }
  const copyMask = mask => (mask && Array.isArray(mask.data)
    ? { x: mask.x, y: mask.y, cell: mask.cell, cols: mask.cols, rows: mask.rows, data: mask.data.map(r => r.slice()) }
    : null);
  const maskAllZero = mask => !mask || mask.data.every(r => r.every(v => v === 0));
  /// Маска из произвольного JSON (только растр; старый формат shapes здесь не читается).
  /// bounds (если даны) приклеивают маску к текущим границам карты: x/y = границам карты.
  function normalizeMask(raw, bounds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.data)) return null;
    const cell = Number(raw.cell), cols = Number(raw.cols), rows = Number(raw.rows);
    if (!(cell >= FOG_MIN_CELL && cell <= FOG_MAX_CELL)) return null;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > FOG_MAX_DIM || rows > FOG_MAX_DIM) return null;
    if (!finite(Number(raw.x)) || !finite(Number(raw.y))) return null;
    const data = [];
    for (let r = 0; r < rows; r++) {
      const rowIn = Array.isArray(raw.data[r]) ? raw.data[r] : [];
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) row[c] = maskCell(rowIn[c]);
      data.push(row);
    }
    const m = { x: Number(raw.x), y: Number(raw.y), cell, cols, rows, data };
    if (bounds && bounds.w > 0 && bounds.h > 0) { m.x = bounds.x; m.y = bounds.y; }
    return m;
  }
  /// Растеризовать векторные фигуры прежнего формата в бинарную маску карты (миграция при загрузке).
  function rasterizeShapes(shapes, bounds, cell) {
    let mask = emptyMask(bounds, cell);
    if (!mask) return null;
    for (const sh of (shapes || []).map(normalizeShape).filter(Boolean)) mask = paintShapeIntoMask(mask, sh, bounds).mask;
    return mask;
  }
  /// Сцена/сеть → валидный scene.fog (растровые маски по картам). opts: { activeMapId, mapIds, cell, boundsByMap }.
  /// Если by_map нет, а есть старый глобальный shapes — он растеризуется в маску активной (или единственной) карты.
  /// Наличие by_map (даже пустого) отменяет старое поле: маску уже правили в новом формате.
  function normalizeFog(raw, opts = {}) {
    const out = { enabled: false, by_map: {} };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    out.enabled = !!raw.enabled;
    const cell = Number(opts.cell) > 0 ? Number(opts.cell) : GRID_SIZE;
    const boundsOfMap = id => (opts.boundsByMap && typeof opts.boundsByMap === 'object') ? opts.boundsByMap[id] || null : null;
    const put = (id, mask) => {
      if (!id || id.length > FOG_MAX_MAP_ID) return;
      const m = normalizeMask(mask, boundsOfMap(id));
      if (m && !maskAllZero(m)) out.by_map[id] = m;
    };
    if (raw.by_map && typeof raw.by_map === 'object' && !Array.isArray(raw.by_map)) {
      for (const [id, mask] of Object.entries(raw.by_map)) {
        if (mask && typeof mask === 'object' && Array.isArray(mask.shapes)) put(id, rasterizeShapes(mask.shapes, boundsOfMap(id), cell));
        else put(id, mask);
      }
      return out;
    }
    const legacy = (Array.isArray(raw.shapes) ? raw.shapes : []).map(normalizeShape).filter(Boolean);
    const single = Array.isArray(opts.mapIds) && opts.mapIds.length === 1 ? opts.mapIds[0] : null;
    const target = opts.activeMapId || single;
    if (legacy.length && target) put(target, rasterizeShapes(legacy, boundsOfMap(target), cell));
    return out;
  }

  const fogEnabled = fog => !!(fog && fog.enabled);
  function setFogEnabled(fog, on) { const base = normalizeFog(fog); base.enabled = !!on; return base; }
  /// Растровая маска карты из scene.fog; null — записи нет (карта вся скрыта).
  function maskOf(fog, mapId, bounds) {
    if (!mapId || !fog || typeof fog !== 'object' || !fog.by_map || typeof fog.by_map !== 'object') return null;
    return normalizeMask(fog.by_map[mapId], bounds);
  }
  /// Маска карты для редактирования/отрисовки: существующая (приклеенная к границам) или новая пустая.
  function maskForMap(fog, mapId, bounds, cell) {
    return maskOf(fog, mapId, bounds) || emptyMask(bounds, cell);
  }
  /// Заменить маску карты; null или вся-ноль → запись удаляется (карта вся скрыта).
  function setMask(fog, mapId, mask) {
    const base = normalizeFog(fog);
    if (!mapId) return base;
    const m = normalizeMask(mask);
    if (m && !maskAllZero(m)) base.by_map[mapId] = m;
    else delete base.by_map[mapId];
    return base;
  }
  /// Центр клетки маски в мировых координатах.
  const maskCellCenter = (mask, col, row) => [mask.x + (col + 0.5) * mask.cell, mask.y + (row + 0.5) * mask.cell];
  /// Применить фигуру-мазок к маске: клетки, чей центр внутри фигуры, получают 100 (reveal) или 0 (hide).
  /// Клетки вне границ карты не трогаются (обрезка по карте). Возвращает { mask, changed }.
  function paintShapeIntoMask(mask, shape, bounds) {
    const s = normalizeShape(shape);
    const m = copyMask(mask);
    if (!s || !m) return { mask, changed: false };
    let changed = false;
    for (let row = 0; row < m.rows; row++) {
      for (let col = 0; col < m.cols; col++) {
        const [cx, cy] = maskCellCenter(m, col, row);
        if (bounds && (cx < bounds.x || cx > bounds.x + bounds.w || cy < bounds.y || cy > bounds.y + bounds.h)) continue;
        if (containsShape(s, cx, cy)) {
          const v = s.mode === 'reveal' ? 100 : 0;
          if (m.data[row][col] !== v) { m.data[row][col] = v; changed = true; }
        }
      }
    }
    return { mask: m, changed };
  }
  /// Добавить мазок в единую маску карты. { fog, added, mask } — added=false, если мазок ничего не задел.
  function addMaskStroke(fog, mapId, shape, bounds, cell) {
    const base = normalizeFog(fog);
    if (!mapId) return { fog: base, added: false, mask: null };
    const mask = maskForMap(base, mapId, bounds, cell);
    if (!mask) return { fog: base, added: false, mask: null };
    const res = paintShapeIntoMask(mask, shape, bounds);
    if (!res.changed) return { fog: base, added: false, mask };
    return { fog: setMask(base, mapId, res.mask), added: true, mask: res.mask };
  }
  /// «Открыть всё»: маска вся из 100 по границам карты.
  function revealAllMask(bounds, cell) {
    const m = emptyMask(bounds, cell);
    if (!m) return null;
    for (const row of m.data) row.fill(100);
    return m;
  }
  /// Открыта ли точка: в клетке точки 100. Вне карты и без маски — скрыто.
  function isRevealed(fog, mapId, x, y, bounds) {
    if (!bounds || !finite(x) || !finite(y)) return false;
    if (x < bounds.x || x > bounds.x + bounds.w || y < bounds.y || y > bounds.y + bounds.h) return false;
    const m = maskOf(fog, mapId, bounds);
    if (!m) return false;
    const col = Math.floor((x - m.x) / m.cell), row = Math.floor((y - m.y) / m.cell);
    if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return false;
    return m.data[row][col] === 100;
  }
  /// Клетка строго ВНУТРИ скрытой области: все клетки окрестности r тоже скрыты. Только такие клетки
  /// рисуются жёстко (строго 0); клетки у границы — размытым краем.
  function isInteriorCell(mask, col, row, r = 1) {
    if (!mask || !Array.isArray(mask.data) || col < 0 || row < 0 || col >= mask.cols || row >= mask.rows) return false;
    if (mask.data[row][col] !== 0) return false;
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const rr = row + dr, cc = col + dc;
        if (rr < 0 || cc < 0 || rr >= mask.rows || cc >= mask.cols) continue;
        if (mask.data[rr][cc] !== 0) return false;
      }
    }
    return true;
  }

  // --- инструменты: фигура из протяжки (геометрия мазка; в маску она растеризуется) ---
  const clampPath = (points, max = 512) => {
    const list = points || [];
    if (list.length <= max) return list.map(p => [p[0], p[1]]);
    const step = (list.length - 1) / (max - 1), out = [];
    for (let i = 0; i < max; i++) out.push([...list[Math.round(i * step)]]);
    return out;
  };
  /// Фигура тумана из протяжки: tool — brush | rect | circle | eraser (ластик — та же кисть).
  /// opts: { mode, cells, gridSize }. Вырожденные протяжки (клик без движения) ничего не создают.
  function fogShape(tool, points, opts = {}) {
    const mode = opts.mode === 'hide' ? 'hide' : 'reveal';
    const pts = (points || []).filter(p => Array.isArray(p) && finite(p[0]) && finite(p[1])).map(p => [p[0], p[1]]);
    if (tool === 'brush' || tool === 'eraser' || tool === 'path') {
      if (!pts.length) return null;
      // Клик кистью без движения — точка (две совпадающие точки дают круглый отпечаток).
      const list = pts.length === 1 ? [pts[0], [pts[0][0], pts[0][1]]] : pts;
      return { shape: 'path', mode, points: clampPath(list), width: fogBrushWidth(opts.cells, opts.gridSize) };
    }
    if (tool === 'rect') {
      if (pts.length < 2) return null;
      const [a, b] = [pts[0], pts[pts.length - 1]];
      return a[0] === b[0] || a[1] === b[1] ? null : { shape: 'rect', mode, points: [a, b] };
    }
    if (tool === 'circle') {
      if (pts.length < 2) return null;
      const [a, b] = [pts[0], pts[pts.length - 1]];
      return a[0] === b[0] && a[1] === b[1] ? null : { shape: 'circle', mode, points: [a, b] };
    }
    if (tool === 'polygon' || tool === 'poly') return pts.length >= 3 ? { shape: 'polygon', mode, points: clampPath(pts, 256) } : null;
    return null;
  }
  /// Положить снимок маски в стек отмены (не больше FOG_UNDO_MAX шагов на карту; null — маски не было).
  function pushUndo(stack, mask, max = FOG_UNDO_MAX) {
    const list = Array.isArray(stack) ? stack.slice() : [];
    list.push(copyMask(mask));
    const limit = Math.max(1, Number(max) || FOG_UNDO_MAX);
    return list.length > limit ? list.slice(list.length - limit) : list;
  }
  /// Снять последний снимок: { mask: undefined, stack } — отменять нечего; иначе mask — прежняя маска (null — не было).
  function undoStep(stack) {
    const list = Array.isArray(stack) ? stack : [];
    if (!list.length) return { mask: undefined, stack: list };
    return { mask: list[list.length - 1], stack: list.slice(0, -1) };
  }

  return {
    LAYER, FALLBACK_LAYER, LAYER_NAMES, layerName, MAX_LAYERS,
    defaultLayers, normalize, find, resolve, orderOf, addLayer, removeLayer, renameLayer, moveLayer, setLayerFlag,
    countItems, sortItems,
    isMap, mapItems, findMap, activeMapId, activeMap, boundsOf, unionBounds, boardBounds, fitView,
    gridSize, isHex, hexMetrics, hexCenter, hexAt, hexVisibleRange, hexRowRange, gridCacheKey, gridCacheCovers, snapPos, snapCorner, snapCenter, resizeRect, rotateAngle,
    mapRect,
    snapRuler, rulerCells, scaleFt, rulerLabel,
    // туман войны: бинарная растровая маска на карту (scene.fog.by_map), значения строго 0/100
    FOG_UNDO_MAX, FOG_BRUSH_MIN, FOG_BRUSH_MAX, FOG_SHAPES, FOG_MODES,
    FOG_MAX_DIM, FOG_MIN_CELL, FOG_MAX_CELL, FOG_EDGE_BLUR,
    normalizeShape, containsShape, normalizeMask, emptyMask, copyMask, rasterizeShapes, normalizeFog,
    fogEnabled, setFogEnabled, maskOf, maskForMap, setMask, paintShapeIntoMask, addMaskStroke, revealAllMask,
    isRevealed, isInteriorCell, maskCellCenter, fogBlurWorld, fogBlurPx,
    clampBrush, fogBrushWidth, fogShape, pushUndo, undoStep,
  };
})();
