// ---------------------------------------------------------------------------
// table.js — виртуальный стол в духе Owlbear Rodeo: сцены, слои, токены,
// туман войны, линейка, рисование, лут, синхронизация через WebSocket.
// Даёт: window.Table.
// Зависимости: common.js, table-model.js; лениво: DiceEngine, Modules, Compendium.
// Загружается только в index.html (слой 5).
// ---------------------------------------------------------------------------
// Виртуальный стол в духе Owlbear Rodeo: сцены, слои, токены, туман, линейка, рисование, реалтайм.
window.Table = (function () {
  const LAYER = window.AssetKinds.LAYER;
  // Порядок слоёв по умолчанию (сцена может переопределить его в scene.layers).
  const LAYER_ORDER = window.AssetKinds.layerOrder;
  // Модель слоёв/карт/сетки/линейки — чистые функции, см. table-model.js.
  const T = window.TableModel;
  const LAYER_NAMES = T.LAYER_NAMES;
  const COLORS = ['#ffffff', '#e5484d', '#f5a524', '#f7d038', '#46a758', '#3e9bff', '#7c5cff', '#000000'];
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(16) + Math.random().toString(16).slice(2, 18)).slice(0, 32));

  // ---------- производительность сетки ----------
  // Углы вершин гекса считаем один раз: раньше Math.cos/sin вызывались 12 раз
  // на каждый гекс каждый кадр.
  const HEX_COS = new Float64Array(6), HEX_SIN = new Float64Array(6);
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    HEX_COS[i] = Math.cos(a); HEX_SIN[i] = Math.sin(a);
  }
  // Кэш сетки: поля вокруг вьюпорта (чтобы панорама шла без перерисовки) и
  // предохранитель по числу пикселей на retina/4K-экранах.
  const GRID_MARGIN_MIN = 128, GRID_MARGIN_MAX = 384, GRID_CACHE_MAX_PIXELS = 16 * 1024 * 1024;
  // Счётчики кадра: включаются флагом #gridstats / ?gridstats / localStorage.
  const gridStats = {
    frames: 0, drawGridMs: 0, drawGridMsMax: 0, drawGridMsLast: 0,
    rebuilds: 0, rebuildMs: 0, rebuildMsMax: 0, rebuildMsLast: 0,
    blits: 0, rasterizedLast: 0, pathOpsLast: 0, visibleCells: 0, cacheKey: '',
  };
  let lastStatsLog = 0;
  function statsEnabled() {
    try {
      return location.hash.includes('gridstats') || new URLSearchParams(location.search).has('gridstats')
        || localStorage.getItem('table.gridStats') === '1';
    } catch { return false; }
  }
  let STATS_ON = statsEnabled();
  function gridStatsSnapshot() {
    const frames = Math.max(1, gridStats.frames);
    return {
      on: STATS_ON,
      frames: gridStats.frames,
      drawGridMsAvg: +(gridStats.drawGridMs / frames).toFixed(4),
      drawGridMsMax: +gridStats.drawGridMsMax.toFixed(4),
      drawGridMsLast: +gridStats.drawGridMsLast.toFixed(4),
      rebuilds: gridStats.rebuilds,
      rebuildMsAvg: gridStats.rebuilds ? +(gridStats.rebuildMs / gridStats.rebuilds).toFixed(3) : 0,
      rebuildMsMax: +gridStats.rebuildMsMax.toFixed(3),
      rebuildMsLast: +gridStats.rebuildMsLast.toFixed(3),
      blits: gridStats.blits,
      rasterizedLast: gridStats.rasterizedLast,
      pathOpsLast: gridStats.pathOpsLast,
      visibleCells: gridStats.visibleCells,
      cacheKey: gridStats.cacheKey,
    };
  }
  function resetGridStats() {
    gridStats.frames = 0; gridStats.drawGridMs = 0; gridStats.drawGridMsMax = 0; gridStats.drawGridMsLast = 0;
    gridStats.rebuilds = 0; gridStats.rebuildMs = 0; gridStats.rebuildMsMax = 0; gridStats.rebuildMsLast = 0;
    gridStats.blits = 0; gridStats.rasterizedLast = 0; gridStats.pathOpsLast = 0; gridStats.visibleCells = 0;
  }

  let S; // состояние стола

  // ---------- Состояние, сцены, камера ----------
  function init(ctx) {
    // ctx: {campaign, user, isGM, scene, ws, onSelect, container, onSceneChange}
    S = {
      ...ctx, cam: { x: 0, y: 0, k: 1 }, tool: 'select', sel: null, drag: null, hover: null,
      drawColor: '#e5484d', drawWidth: 6, drawShape: 'path',
      // Туман: инструмент (кисть/прямоугольник/круг/ластик), режим, размер кисти в клетках,
      // стек отмены на карту и положение курсора для предпросмотра.
      fogMode: 'reveal', fogTool: 'brush', fogCells: 3, fogUndo: {},
      temp: null, remoteRulers: {}, pings: [], cursors: {}, snap: true, gridScaleFt: 5,
      // Слои сцены и активный слой (для клика/загрузки). Активная карта живёт в scene.active_map_id.
      layers: T.normalize(ctx.scene?.layers),
      activeLayer: LAYER.character,
  pingColor: (() => { try { return localStorage.getItem('table.pingColor') || '#ffd54f'; } catch { return '#ffd54f'; } })(),
      // Мультивыделение: sel — «главный» элемент для панели свойств, selSet — все выбранные.
      selSet: new Set(), selBox: null,
      // Ресайз / поворот выделенного токена (ручки по краям, как в Owlbear Rodeo).
      resize: null,        // {kind:'resize'|'rotate', handle, it, x0,y0,w0,h0,r0, sx,sy} — sx/sy: точка нажатия
      resizeHandleSize: 14 / window.devicePixelRatio,
      // Последняя правка из панели свойств: свой ответ сервера не перерисовывает панель
      // (иначе сбрасывались прокрутка, фокус и открытые списки — «меню закрывается»).
      propsEcho: null,
      // Объекты, показанные локально до подтверждения сервером (create с готовым id):
      // подтверждение снимает id из набора, отказ сервера — убирает объект со стола.
      pending: new Set(),
      // Туман войны — право table.manage_fog (по умолчанию совпадает с ролью мастера).
      canFog: ctx.canFog !== undefined ? !!ctx.canFog : !!ctx.isGM,
      // dirty — есть ли изменения для кадра; gridCache — offscreen-кэш сетки.
      dirty: true, gridCache: null,
    };
    S.scene = adoptScene(ctx.scene);
    S.activeLayer = T.resolve(S.layers, S.activeLayer).id;
    const wrap = ctx.container;
    wrap.innerHTML = '';
    S.canvas = el('canvas', { id: 'canvas' });
    wrap.append(S.canvas);
    S.ctx2d = S.canvas.getContext('2d');
    S.fogCanvas = document.createElement('canvas');
    S.fogBuf = null;      // кэш буферов тумана (размытый край + жёсткая середина), см. fogBuffers
    S.fogVersion = 0;     // инкремент при любой смене fog — сбрасывает кэш буферов
    // propsBox и hint создаём до buildTools: setTool() пишет в S.hint и вызывается из buildTools.
    S.propsBox = el('div', { class: 'props hidden' });
    S.hint = el('div', { class: 'hint' }, 'ЛКМ — выбрать/тащить, колесо — зум, ПКМ/пробел — панорама; Ctrl при отпускании — без привязки к сетке');
    buildTools(wrap);
    wrap.append(S.propsBox);
    wrap.append(S.hint);
    bindEvents();
    syncScale();
    resize();
    window.addEventListener('resize', resize);
    // Контейнер может измениться и без resize окна (боковая панель, мобильная вёрстка):
    // пересчитываем буфер canvas, камера при этом не сбрасывается.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(wrap);
    window.addEventListener('hashchange', () => { STATS_ON = statsEnabled(); requestDraw(); });
    fitToMap();
    requestDraw();
  }

  /// Сцена при загрузке: старый scene.fog.shapes (глобальный или per-map) растеризуется
  /// в бинарную маску активной/единственной карты. Дальше код читает только scene.fog.by_map.
  function fogNormalizeOpts(scene) {
    return {
      activeMapId: T.activeMapId(scene),
      mapIds: T.mapItems(scene?.items).map(m => m.id),
      cell: T.gridSize(scene?.grid),
      boundsByMap: Object.fromEntries(T.mapItems(scene?.items).map(m => [m.id, T.boundsOf(m)]).filter(([, b]) => b)),
    };
  }
  function adoptScene(scene) {
    if (!scene || typeof scene !== 'object') return scene;
    if (!Array.isArray(scene.items)) scene.items = [];
    scene.fog = T.normalizeFog(scene.fog, fogNormalizeOpts(scene));
    return scene;
  }

  function setScene(scene) {
    S.scene = adoptScene(scene); S.sel = null; S.temp = null; S.fogUndo = {}; S.pending = new Set();
    S.fogVersion++; S.fogBuf = null;
    S.layers = T.normalize(scene?.layers);
    // Активный слой мог исчезнуть в новой сцене — фолбэк на prop, как и у элементов.
    S.activeLayer = T.resolve(S.layers, S.activeLayer).id;
    syncScale(); updateProps(); syncFogPanel(); fitToMap(); notifySceneChange(); requestDraw();
  }
  function syncScale() { S.gridScaleFt = parseInt(S.scene.grid?.scale) || 5; }

  // ---------- слои и карты (модель — table-model.js) ----------
  function layers() { return S.layers && S.layers.length ? S.layers : T.defaultLayers(); }
  /// id слоя элемента с фолбэком на prop (неизвестный/удалённый слой).
  function layerOf(item) { return T.resolve(layers(), item.layer).id; }
  function layerDef(id) { return T.find(layers(), id); }
  function layerHidden(id) { return !!layerDef(id)?.hidden; }
  function layerLocked(id) { return !!layerDef(id)?.locked; }
  function syncLayers(raw) { S.layers = T.normalize(raw); S.scene && (S.scene.layers = S.layers); }
  function activeMapId() { return T.activeMapId(S.scene); }
  function activeMap() { return T.activeMap(S.scene); }
  function notifySceneChange() { S.onSceneChange && S.onSceneChange(); }
  /// Заменить список слоёв сцены (мастер): уходит на сервер как часть сцены.
  function setLayers(next) {
    syncLayers(next);
    sendScene({ layers: S.layers });
    if (!layerDef(S.activeLayer)) S.activeLayer = T.resolve(S.layers, S.activeLayer).id;
    updateProps(); notifySceneChange(); requestDraw();
  }
  /// Сделать карту активной (fitToMap/туман/«Открыть всё» считаются по ней). null — все карты.
  function setActiveMap(id) {
    const next = id || null;
    S.scene.active_map_id = next;
    sendScene({ active_map_id: next });
    // У каждой карты своя маска тумана — панель и оверлей сразу показывают маску новой карты.
    syncFogPanel();
    updateProps(); notifySceneChange(); requestDraw();
  }
  function focusMap(id) { if (id) setActiveMap(id); fitToMap(); }

  // ---------- геометрия ----------
  /// Размер canvas по контейнеру: буфер в физических пикселях, CSS-размер — в логических.
  /// CSS больше не растягивает старый буфер (width/height задаём здесь). Камера
  /// сохраняется: тот же центр мира остаётся в центре экрана, зум не меняется, fitToMap
  /// не вызывается — после скрытия/показа боковой панели карта не растягивается и не прыгает.
  function resize() {
    if (!S?.canvas) return;
    const wrap = S.canvas.parentElement;
    if (!wrap) return;
    const w = Math.max(1, wrap.clientWidth || 0);
    const h = Math.max(1, wrap.clientHeight || 0);
    const dpr = devicePixelRatio || 1;
    // Мировая точка в центре до изменения размера — её же оставляем в центре после.
    const had = S.w > 0 && S.h > 0;
    const cx = had ? (S.w / 2 - S.cam.x) / S.cam.k : 0;
    const cy = had ? (S.h / 2 - S.cam.y) / S.cam.k : 0;
    S.w = w; S.h = h;
    S.canvas.style.width = w + 'px';
    S.canvas.style.height = h + 'px';
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    // Буфер уже нового размера — кадр запрашиваем после него, без промежуточного растяжения.
    if (S.canvas.width !== bw) S.canvas.width = bw;
    if (S.canvas.height !== bh) S.canvas.height = bh;
    if (had) { S.cam.x = w / 2 - cx * S.cam.k; S.cam.y = h / 2 - cy * S.cam.k; }
    requestDraw();
  }
  const toWorld = (sx, sy) => ({ x: (sx - S.cam.x) / S.cam.k, y: (sy - S.cam.y) / S.cam.k });
  const grid = () => T.gridSize(S.scene?.grid);
  // ---------- Сетка: квадраты и гексы, привязка позиций ----------
  const isHex = () => T.isHex(S.scene?.grid);
  const hexMetrics = () => T.hexMetrics(S.scene?.grid);
  function snapPos(x, y, w, h) { return T.snapPos(x, y, w, h, { grid: S.scene?.grid, snap: S.snap }); }
  /// Вписать в экран активную карту (или все карты, если активная не выбрана, — как раньше без карт).
  function fitToMap() {
    const g = grid();
    const b = T.boardBounds(S.scene) || { x: 0, y: 0, w: g * 20, h: g * 20 };
    const view = T.fitView(b, { w: S.w, h: S.h });
    if (view) { S.cam.k = view.k; S.cam.x = view.x; S.cam.y = view.y; }
    requestDraw();
  }
  // ---------- Объекты стола: границы, видимость, права ----------
  function itemBounds(it) {
    const d = it.data;
    if (d.type === 'drawing') {
      const xs = d.points.map(p => p[0]), ys = d.points.map(p => p[1]);
      if (d.shape === 'circle') { const r = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]); return { x: xs[0] - r, y: ys[0] - r, w: 2 * r, h: 2 * r }; }
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x: x - d.width, y: y - d.width, w: Math.max(...xs) - x + 2 * d.width, h: Math.max(...ys) - y + 2 * d.width };
    }
    if (d.type === 'text') { const w = (d.text?.length || 1) * (d.size || 24) * 0.55; return { x: d.x - w / 2, y: d.y - (d.size || 24) / 2, w, h: d.size || 24 }; }
    return { x: d.x - d.w / 2, y: d.y - d.h / 2, w: d.w, h: d.h };
  }
  function hitTest(wx, wy) {
    const items = visibleItems().slice().reverse();
    for (const it of items) {
      if (it.data.locked && S.tool === 'select' && !S.isGM) continue;
      const lid = layerOf(it);
      if (lid === LAYER.map && !S.isGM && !Access.canLayerWrite(S.campaign.id, S.campaign.role, lid)) continue;
      if (layerLocked(lid) && !S.isGM && !Access.canLayerWrite(S.campaign.id, S.campaign.role, lid)) continue; // заблокированный слой двигает только мастер
      const b = itemBounds(it);
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
        if (lid === LAYER.map && S.activeLayer !== LAYER.map) continue; // карту трогаем только на слое карты
        return it;
      }
    }
    return null;
  }
  /// Герой под указателем при отпускании предмета: скрытые и недоступные токены исключаются через visibleItems().
  function characterTokenAt(wx, wy, sourceCharacterId) {
    return visibleItems().slice().reverse().find(it => {
      const d = it.data || {};
      if (layerOf(it) !== LAYER.character || !d.character_id || d.character_id === sourceCharacterId) return false;
      const b = itemBounds(it);
      return wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
    }) || null;
  }
  /// Элементы в порядке отрисовки: порядок слоёв из scene.layers, затем z.
  function visibleItems() {
    const items = S.scene.items.filter(i => {
      const lid = layerOf(i);
      if (!S.isGM && !Access.canLayerRead(S.campaign.id, S.campaign.role, lid)) return false; // нет права читать слой
      if (!S.isGM && layerHidden(lid)) return false; // скрытый слой игроки не видят
      return S.isGM || !i.data.hidden;
    });
    return T.sortItems(items, layers());
  }
  function canEdit(it) {
    const lid = layerOf(it);
    if (!S.isGM && !Access.canLayerWrite(S.campaign.id, S.campaign.role, lid)) return false; // нет права писать в слой
    return S.isGM || it.data.owner_id === S.user.id || (it.data.editors || []).includes(S.user.id) || !!it.data.loot;
  }

  // ---------- мультивыделение (рамка, группа) ----------
  /// Элементы, которые можно выделить рамкой: слои персонажей/объектов и только свои.
  function selectableItems() {
    return S.scene.items.filter(it => {
      const lid = layerOf(it);
      if (lid !== LAYER.character && lid !== LAYER.prop) return false;
      if (it.data.locked && !S.isGM) return false;
      return canEdit(it);
    });
  }
  /// Текущее выделение (только то, что реально можно двигать/удалять).
  function selectionItems() {
    return S.scene.items.filter(i => S.selSet.has(i.id) && canEdit(i));
  }
  function setSelection(ids) {
    S.selSet = new Set(ids);
    S.sel = ids.length ? ids[ids.length - 1] : null;
    updateProps(); requestDraw();
  }
  /// Рамка выделения в мировых координатах (нормализованный прямоугольник).
  function marqueeBounds() {
    const b = S.selBox;
    if (!b) return { x: 0, y: 0, w: 0, h: 0 };
    const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
    return { x, y, w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) };
  }
  /// Отпустили рамку: в выделение попадают элементы, чьи bounds пересекаются с ней.
  function finishMarquee() {
    const box = S.selBox;
    const m = marqueeBounds();
    S.selBox = null;
    if (!box) return;
    // Клик без протяжки — просто снять выделение (сброс уже произошёл при нажатии).
    if (m.w < 2 / S.cam.k && m.h < 2 / S.cam.k) { updateProps(); requestDraw(); return; }
    const hit = selectableItems().filter(it => {
      const b = itemBounds(it);
      return b.x <= m.x + m.w && b.x + b.w >= m.x && b.y <= m.y + m.h && b.y + b.h >= m.y;
    }).map(it => it.id);
    setSelection(box.additive ? [...new Set([...S.selSet, ...hit])] : hit);
  }
  /// Действие над всем выделением: применяем и отправляем одним upsert на элемент.
  function eachSelected(fn) {
    for (const it of selectionItems()) { fn(it); upsert(it); }
  }

  // ---------- рендер ----------
  // ---------- Отрисовка: цикл, сетка, объекты, туман войны ----------
  // Кадры запрашиваются по требованию и склеиваются в один requestAnimationFrame.
  // Раньше draw() шёл 60 раз в секунду всегда, даже если ничего не менялось.
  let frameQueued = false;
  function requestDraw() {
    if (!S) return;
    S.dirty = true;
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    frameQueued = false;
    if (!S || (!S.dirty && !S.pings.length)) return;
    S.dirty = false;
    draw();
    // Пинги живут две секунды и плавно гаснут — пока они есть, кадры идут подряд.
    if (S.pings.length) requestDraw();
  }
  /// Ручки ресайза (8 по углам/граням) и поворота (над токеном) вокруг выделенного токена.
  function drawTokenHandles(c, b, it, handleColor, handleBg, handleSize, rotateColor) {
    const d = it.data;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const k = S.cam.k;
    const hs = handleSize / k;          // размер ручки в мировых координатах
    const hh = hs / 2;
    const rotLen = Math.max(b.w, b.h) * 0.55 + 14 / k;   // длина линии поворота
    const rotAng = ((d.rotation || 0) * Math.PI / 180);
    const rx = cx + Math.cos(rotAng) * rotLen, ry = cy + Math.sin(rotLen ? rotLen : 0) * Math.sin(rotAng);
    // Линия поворота от центра к ручке.
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(rx, ry);
    c.strokeStyle = rotateColor; c.lineWidth = (1.5 / k); c.stroke();
    // Ручка поворота (круг над токеном).
    c.beginPath(); c.arc(rx, ry, hh, 0, Math.PI * 2);
    c.fillStyle = handleBg; c.fill(); c.strokeStyle = handleColor; c.lineWidth = (1.5 / k); c.stroke();
    // Точка привязки поворота (маленькая точка в центре).
    c.beginPath(); c.arc(cx, cy, hh * 0.35, 0, Math.PI * 2);
    c.fillStyle = handleColor; c.fill();
    // Ручки ресайза: nw, n, ne, e, se, s, sw, w.
    const handles = [
      { k: 'nw', x: b.x, y: b.y }, { k: 'n', x: cx, y: b.y }, { k: 'ne', x: b.x + b.w, y: b.y },
      { k: 'e', x: b.x + b.w, y: cy }, { k: 'se', x: b.x + b.w, y: b.y + b.h },
      { k: 's', x: cx, y: b.y + b.h }, { k: 'sw', x: b.x, y: b.y + b.h }, { k: 'w', x: b.x, y: cy },
    ];
    for (const h of handles) {
      c.beginPath(); c.rect(h.x - hh, h.y - hh, hs, hs);
      c.fillStyle = handleBg; c.fill(); c.strokeStyle = handleColor; c.lineWidth = (1.5 / k); c.stroke();
    }
    // Подпись текущего поворота над ручкой.
    if (d.rotation) {
      c.font = `${Math.max(10 / k, 10)}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'bottom';
      c.fillStyle = rotateColor; c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--tok-text-stroke').trim() || '#000a'; c.lineWidth = 3 / k;
      const label = Math.round(d.rotation || 0) + '°';
      c.strokeText(label, rx, ry - hh - 3 / k); c.fillText(label, rx, ry - hh - 3 / k);
    }
  }

  /// Проверка попадания в ручку ресайза/поворота (в экранных пикселях).
  function hitTokenHandle(wx, wy, it) {
    if (!it || it.data.type !== 'image') return null;
    const b = itemBounds(it);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const k = S.cam.k;
    const hs = (S.resizeHandleSize || 8) / k;
    const hh = hs / 2;
    const d = it.data;
    // Ручка поворота.
    const rotLen = Math.max(b.w, b.h) * 0.55 + 14 / k;
    const rotAng = ((d.rotation || 0) * Math.PI / 180);
    const rx = cx + Math.cos(rotAng) * rotLen, ry = cy + Math.sin(rotAng) * rotLen;
    if (Math.hypot(wx - rx, wy - ry) <= hh * 2.4) return { kind: 'rotate', handle: 'rotate' };
    // Ручки ресайза.
    const handles = [
      { k: 'nw', x: b.x, y: b.y }, { k: 'n', x: cx, y: b.y }, { k: 'ne', x: b.x + b.w, y: b.y },
      { k: 'e', x: b.x + b.w, y: cy }, { k: 'se', x: b.x + b.w, y: b.y + b.h },
      { k: 's', x: cx, y: b.y + b.h }, { k: 'sw', x: b.x, y: b.y + b.h }, { k: 'w', x: b.x, y: cy },
    ];
    for (const h of handles) {
      if (wx >= h.x - hh && wx <= h.x + hh && wy >= h.y - hh && wy <= h.y + hh)
        return { kind: 'resize', handle: h.k };
    }
    return null;
  }

  /// Ресайз токена за выбранную ручку. Геометрия — в TableModel.resizeRect (чистая
  /// функция с тестами): противоположная сторона на месте, ручка идёт за курсором.
  /// Ход считается от точки нажатия, а не от прошлого события: раньше в размер
  /// попадал только последний шаг мыши — объект «дёргался» и не менялся.
  function applyResize(w) {
    const r = S.resize, d = r.it.data;
    const next = T.resizeRect({ x: r.x0, y: r.y0, w: r.w0, h: r.h0 }, r.handle, w.x - r.sx, w.y - r.sy, { lockAspect: !!d.lockAspect });
    d.x = next.x; d.y = next.y; d.w = next.w; d.h = next.h;
    requestDraw();
  }

  /// Отпустили ручку: размер фиксируем, позицию привязываем к сетке (Ctrl — свободно).
  /// Карту не притягиваем: её клетки должны совпадать с клетками стола, а не центр.
  function finishResize(ev) {
    const r = S.resize, d = r.it.data;
    d.w = Math.max(8, Math.round(d.w));
    d.h = Math.max(8, Math.round(d.h));
    // Карту не притягиваем вовсе: она растёт от того края, который тянули, а её клетки
    // должны совпадать с клетками стола. Ctrl (Cmd) — свободное размещение и у токенов.
    const free = !!ev && (ev.ctrlKey || ev.metaKey);
    if (r.handle !== 'rotate' && layerOf(r.it) !== LAYER.map && S.snap && !free) {
      const p = snapPos(d.x, d.y, d.w, d.h);
      d.x = p.x; d.y = p.y;
    }
    upsert(r.it);
    S.resize = null; S.drag = null;
    requestDraw();
  }

  /// Поворот токена мышкой: угол от центра токена к курсору.
  /// Shift — шаг 45°, Ctrl+Shift — шаг 15°. Опорный угол — точка нажатия (не прошлое
  /// событие), поэтому поворот идёт за курсором, а не суммой мелких шагов.
  function applyRotate(w, ev) {
    const r = S.resize, d = r.it.data;
    const b = itemBounds(r.it);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const curAng = Math.atan2(w.y - cy, w.x - cx) * 180 / Math.PI;
    const startAng = Math.atan2(r.sy - cy, r.sx - cx) * 180 / Math.PI;
    const step = ev && ev.shiftKey ? (ev.ctrlKey ? 15 : 45) : 1;
    d.rotation = T.rotateAngle(startAng, curAng, step, r.r0);
    requestDraw();
  }

  function draw() {
    gridStats.frames++;
    const c = S.ctx2d; c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    c.clearRect(0, 0, S.w, S.h);
    c.save(); c.translate(S.cam.x, S.cam.y); c.scale(S.cam.k, S.cam.k);
    const css = getComputedStyle(document.documentElement);
    const tokenColors = {
      rotate: css.getPropertyValue('--tok-rotate').trim() || '#ffd54f',
      hpStroke: css.getPropertyValue('--tok-hp-stroke').trim() || '#000c',
      dead: css.getPropertyValue('--tok-dead').trim() || '#e5484d',
      lootStroke: css.getPropertyValue('--tok-loot-stroke').trim() || '#f5a524',
      itemStroke: css.getPropertyValue('--tok-item-stroke').trim() || '#000c',
      textStroke: css.getPropertyValue('--tok-text-stroke').trim() || '#000a',
      hpBg: css.getPropertyValue('--tok-hp-bg').trim() || 'rgba(0,0,0,.7)',
      hpHigh: css.getPropertyValue('--tok-hp-high').trim() || '#46a758',
      hpMed: css.getPropertyValue('--tok-hp-med').trim() || '#f5a524',
      hpLow: css.getPropertyValue('--tok-hp-low').trim() || '#e5484d',
      hpText: css.getPropertyValue('--tok-hp-text').trim() || '#fff',
      condBg: css.getPropertyValue('--tok-cond-bg').trim() || '#ffd77a',
      condText: css.getPropertyValue('--tok-cond-text').trim() || '#000',
    };
    const rotateColor = tokenColors.rotate;
    const items = visibleItems();
    // Линии сетки — над всеми картами слоя map, но под остальными объектами.
    let gridAt = 0;
    for (let i = 0; i < items.length; i++) if (layerOf(items[i]) === LAYER.map) gridAt = i + 1;
    for (let i = 0; i < items.length; i++) {
      if (i === gridAt) drawGridTimed(c);
      drawItem(c, items[i], S.isGM && layerHidden(layerOf(items[i])), tokenColors);
    }
    if (gridAt >= items.length) drawGridTimed(c);
    // Подсветка активной карты — только мастеру и только когда карт несколько.
    if (S.isGM && T.mapItems(S.scene.items).length > 1) {
      const b = T.boundsOf(activeMap());
      if (b) { c.strokeStyle = rotateColor; c.lineWidth = 2 / S.cam.k; c.setLineDash([10 / S.cam.k, 6 / S.cam.k]); c.strokeRect(b.x, b.y, b.w, b.h); c.setLineDash([]); }
    }
    drawFog(c);
    drawFogPreview(c);
    // временные фигуры
    if (S.temp) drawTemp(c, S.temp, S.user.id);
    for (const r of Object.values(S.remoteRulers)) drawTemp(c, r, r.user_id);
    // выделение: контур у всех выбранных (мультивыделение), рамка — при протяжке
    const highlighted = S.selSet.size ? S.scene.items.filter(i => S.selSet.has(i.id)) : (S.sel ? S.scene.items.filter(i => i.id === S.sel) : []);
    const selColor = getComputedStyle(document.documentElement).getPropertyValue('--tok-sel').trim() || '#7c5cff';
    const selDash = (getComputedStyle(document.documentElement).getPropertyValue('--tok-sel-dash').trim() || '6 4').split(' ').map(Number);
    const selLine = +(getComputedStyle(document.documentElement).getPropertyValue('--tok-sel-line').trim() || '2');
    const handleColor = getComputedStyle(document.documentElement).getPropertyValue('--tok-handle').trim() || '#7c5cff';
    const handleBg = getComputedStyle(document.documentElement).getPropertyValue('--tok-handle-bg').trim() || '#ffffff';
    const handleSize = +(getComputedStyle(document.documentElement).getPropertyValue('--tok-handle-size').trim() || '7');
    const selBg = getComputedStyle(document.documentElement).getPropertyValue('--tok-sel-bg').trim() || 'rgba(124,92,255,0.12)';
    for (const it of highlighted) {
      const b = itemBounds(it);
      c.strokeStyle = selColor; c.lineWidth = selLine / S.cam.k; c.setLineDash(selDash.map(d => d / S.cam.k));
      c.strokeRect(b.x, b.y, b.w, b.h); c.setLineDash([]);
      // Ручки ресайза и поворота — только для одного выделенного image-токена.
      if (highlighted.length === 1 && it.data.type === 'image' && !S.resize) {
        drawTokenHandles(c, b, it, handleColor, handleBg, handleSize, rotateColor);
      }
    }
    if (S.selBox) {
      const b = marqueeBounds();
      c.fillStyle = selBg;
      c.strokeStyle = selColor; c.lineWidth = 1 / S.cam.k;
      c.fillRect(b.x, b.y, b.w, b.h); c.strokeRect(b.x, b.y, b.w, b.h);
    }
    // пинги
    const now = Date.now();
    S.pings = S.pings.filter(p => now - p.t < 2000);
    for (const p of S.pings) { const a = 1 - (now - p.t) / 2000; const hex = (p.color || '#ffd54f').replace('#', ''); const n = parseInt(hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex, 16) || 0xffd54f; const rgba = alpha => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`; c.beginPath(); c.arc(p.x, p.y, (1 - a) * 60 / S.cam.k + 10, 0, 7); c.strokeStyle = rgba(a); c.lineWidth = 4 / S.cam.k; c.stroke(); c.fillStyle = rgba(a); c.font = `${14 / S.cam.k}px sans-serif`; c.fillText(p.name, p.x + 14 / S.cam.k, p.y - 14 / S.cam.k); }
    c.restore();
    if (STATS_ON) {
      window.__gridStats = gridStatsSnapshot();
      const t = performance.now();
      if (t - lastStatsLog > 1000) { lastStatsLog = t; console.info('[grid]', window.__gridStats); }
    }
  }
  /// Обёртка замера: drawGridMs — это блит кэша или перерисовка кэша, без остальных объектов.
  function drawGridTimed(c) {
    const t0 = performance.now();
    gridStats.rasterizedLast = 0;
    gridStats.pathOpsLast = 0;
    drawGrid(c);
    const ms = performance.now() - t0;
    gridStats.drawGridMsLast = ms;
    gridStats.drawGridMs += ms;
    if (ms > gridStats.drawGridMsMax) gridStats.drawGridMsMax = ms;
  }
  const gridDpr = () => devicePixelRatio || 1;
  function gridMargin() {
    // Чем мельче клетки на экране, тем меньше поле вокруг вьюпорта: иначе на
    // дальней дистанции кэш рисовал бы десятки тысяч лишних гексов.
    const cellPx = Math.max(1, grid() * S.cam.k);
    const want = cellPx < 8 ? GRID_MARGIN_MIN : cellPx < 16 ? 192 : Math.round(Math.min(S.w, S.h) * 0.4);
    return Math.max(GRID_MARGIN_MIN, Math.min(GRID_MARGIN_MAX, want));
  }
  /// Перерисовать offscreen-кэш сетки для текущего зума и камеры.
  /// Внутри — один beginPath на всю сетку и один stroke; никаких closePath на
  /// десятках тысяч подпутей (в Chrome это O(n²) и стоило секунды на кадр).
  function rebuildGridCache(key) {
    const t0 = performance.now();
    const g = S.scene.grid;
    const dpr = gridDpr();
    let margin = gridMargin();
    let cw = Math.ceil(S.w) + margin * 2, ch = Math.ceil(S.h) + margin * 2;
    // Потолок памяти: на 4K/retina при необходимости уменьшаем поля и разрешение кэша.
    while (margin > GRID_MARGIN_MIN && cw * ch * dpr * dpr > GRID_CACHE_MAX_PIXELS) {
      margin = Math.max(GRID_MARGIN_MIN, margin - 64);
      cw = Math.ceil(S.w) + margin * 2; ch = Math.ceil(S.h) + margin * 2;
    }
    let renderDpr = dpr;
    while (renderDpr > 1 && cw * ch * renderDpr * renderDpr > GRID_CACHE_MAX_PIXELS) renderDpr = Math.max(1, renderDpr - 0.25);
    const x0 = -margin, y0 = -margin;
    const cv = S.gridCache?.canvas || document.createElement('canvas');
    const pw = Math.max(1, Math.round(cw * renderDpr)), ph = Math.max(1, Math.round(ch * renderDpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const o = cv.getContext('2d');
    o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, pw, ph);
    o.setTransform(renderDpr, 0, 0, renderDpr, 0, 0);
    o.translate(-x0, -y0);
    o.translate(S.cam.x, S.cam.y);
    o.scale(S.cam.k, S.cam.k);
    o.strokeStyle = g.color || '#00000055';
    o.lineWidth = 1 / S.cam.k;
    o.beginPath();
    const wx0 = (x0 - S.cam.x) / S.cam.k, wx1 = (x0 + cw - S.cam.x) / S.cam.k;
    const wy0 = (y0 - S.cam.y) / S.cam.k, wy1 = (y0 + ch - S.cam.y) / S.cam.k;
    let cells = 0, ops = 0;
    if (isHex()) {
      const { w, r } = hexMetrics();
      const hstep = r * 1.5;
      const r0 = Math.floor(wy0 / hstep) - 1, r1 = Math.ceil(wy1 / hstep) + 1;
      for (let rr = r0; rr <= r1; rr++) {
        const q0 = Math.floor(wx0 / w - rr / 2) - 1, q1 = Math.ceil(wx1 / w - rr / 2) + 1;
        if (q1 < q0) continue;
        const cy = hstep * rr;
        for (let q = q0; q <= q1; q++) {
          const cx = w * (q + rr / 2);
          o.moveTo(cx + r * HEX_COS[0], cy + r * HEX_SIN[0]);
          for (let i = 1; i < 6; i++) o.lineTo(cx + r * HEX_COS[i], cy + r * HEX_SIN[i]);
          // Замыкаем шестиугольник линией к первой вершине вместо closePath().
          o.lineTo(cx + r * HEX_COS[0], cy + r * HEX_SIN[0]);
          cells++; ops += 7;
        }
      }
    } else {
      const size = grid();
      const sx0 = Math.floor(wx0 / size) * size, sy0 = Math.floor(wy0 / size) * size;
      let nx = 0, ny = 0;
      for (let x = sx0; x <= wx1; x += size) { o.moveTo(x, wy0); o.lineTo(x, wy1); nx++; }
      for (let y = sy0; y <= wy1; y += size) { o.moveTo(wx0, y); o.lineTo(wx1, y); ny++; }
      ops = (nx + ny) * 2;
    }
    o.stroke();
    gridStats.rebuilds++;
    const ms = performance.now() - t0;
    gridStats.rebuildMs += ms;
    if (ms > gridStats.rebuildMsMax) gridStats.rebuildMsMax = ms;
    gridStats.rebuildMsLast = ms;
    gridStats.rasterizedLast = cells;
    gridStats.pathOpsLast = ops;
    gridStats.visibleCells = cells;
    gridStats.cacheKey = key;
    S.gridCache = { key, canvas: cv, cw, ch, x0, y0, camX: S.cam.x, camY: S.cam.y, renderDpr };
  }
  /// Кэш актуален, если совпал ключ и при текущей камере он всё ещё накрывает вьюпорт.
  function gridCacheMatches(cache, key) {
    if (!cache || cache.key !== key) return false;
    const dx = S.cam.x - cache.camX, dy = S.cam.y - cache.camY;
    return T.gridCacheCovers({ x: cache.x0 + dx, y: cache.y0 + dy, w: cache.cw, h: cache.ch }, S.w, S.h, -1);
  }
  /// Блит кэша в экранных координатах: 1:1 по устройству, без пересчёта гексов.
  function blitGridCache(c, cache) {
    const dpr = gridDpr();
    const dx = Math.round(cache.x0 * dpr + (S.cam.x - cache.camX) * dpr);
    const dy = Math.round(cache.y0 * dpr + (S.cam.y - cache.camY) * dpr);
    const dw = Math.round(cache.cw * dpr), dh = Math.round(cache.ch * dpr);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    // При renderDpr === dpr масштабирования нет — пиксели кэша ложатся как есть.
    c.imageSmoothingEnabled = cache.canvas.width !== dw || cache.canvas.height !== dh;
    c.drawImage(cache.canvas, 0, 0, cache.canvas.width, cache.canvas.height, dx, dy, dw, dh);
    c.restore();
    gridStats.blits++;
  }
  function drawGrid(c) {
    const g = S.scene.grid; if (!g?.visible) return;
    const size = T.gridSize(g);
    const tl = toWorld(0, 0), br = toWorld(S.w, S.h);
    // Слишком мелкая сетка (>400 клеток по ширине экрана) не рисуется — как раньше.
    if ((br.x - tl.x) / size > 400) return;
    const key = T.gridCacheKey({ grid: g, color: g.color || '#00000055', dpr: gridDpr(), k: S.cam.k, w: S.w, h: S.h });
    if (!gridCacheMatches(S.gridCache, key)) rebuildGridCache(key);
    blitGridCache(c, S.gridCache);
  }
  // Кадры идут по требованию: когда картинка догрузилась, просим один кадр,
  // иначе карта/токен остался бы серой заглушкой до следующего действия пользователя.
  const watchedImages = new WeakSet();
  function watchImage(img) {
    // assetImage() отдаёт <img> без src: URL появляется позже, после распаковки base64.
    // Поэтому «complete» у такой картинки уже true, а naturalWidth ещё 0 — ждём load/error,
    // иначе первый кадр рисует заглушку и больше никто не просит перерисовку.
    if (!img || watchedImages.has(img) || (img.complete && img.naturalWidth > 0)) return;
    watchedImages.add(img);
    img.addEventListener('load', () => { watchedImages.delete(img); requestDraw(); }, { once: true });
    img.addEventListener('error', () => { watchedImages.delete(img); }, { once: true });
  }
  function drawItem(c, it, dim, colors) {
    const d = it.data;
    c.save();
    if (d.hidden || dim) c.globalAlpha = 0.45;
    if (d.type === 'image') {
      const img = assetImage(d.asset_id);
      watchImage(img);
      c.translate(d.x, d.y); c.rotate((d.rotation || 0) * Math.PI / 180);
      if (img.complete && img.naturalWidth) c.drawImage(img, -d.w / 2, -d.h / 2, d.w, d.h);
      else { c.fillStyle = '#333'; c.fillRect(-d.w / 2, -d.h / 2, d.w, d.h); }
      c.rotate(-(d.rotation || 0) * Math.PI / 180);
      if (it.layer === LAYER.character || it.layer === LAYER.mount) {
        // Хиты и состояния. Имени под токеном нет: подпись занимала место на карте и
        // лезла под соседние токены — имя видно в панели свойств и на странице участников.
        // (Обводки «принадлежности» тоже нет: владелец в панели свойств.)
        // HP-бар над токеном: скруглённый фон, рамка, цвет по остатку хп, подпись cur/max
        if (d.hp && d.hp.max && (S.isGM || d.owner_id === S.user.id || d.show_hp)) {
          const bw = d.w * 0.85, bh = Math.max(5 / S.cam.k, d.h * 0.09), y = -d.h / 2 - bh - 6;
          const r = bh / 2;
          c.beginPath(); c.roundRect(-bw / 2, y, bw, bh, r);
          c.fillStyle = colors.hpBg; c.fill();
          c.strokeStyle = colors.hpStroke; c.lineWidth = 1.5 / S.cam.k; c.stroke();
          const p = Math.max(0, Math.min(1, d.hp.cur / d.hp.max));
          c.beginPath(); c.roundRect(-bw / 2 + 1.5 / S.cam.k, y + 1.5 / S.cam.k, Math.max(0, bw - 3 / S.cam.k) * p, bh - 3 / S.cam.k, Math.max(0, r - 1.5 / S.cam.k));
          c.fillStyle = p > 0.66 ? colors.hpHigh : p > 0.33 ? colors.hpMed : colors.hpLow;
          c.fill();
          // Подпись хп посередине полоски
          c.font = `bold ${Math.max(9 / S.cam.k, bh * 0.7)}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.strokeStyle = '#000a'; c.lineWidth = 3 / S.cam.k;
          const label = `${Math.round(d.hp.cur)}/${d.hp.max}`;
          c.strokeText(label, 0, y + bh / 2);
          c.fillStyle = colors.hpText;
          c.fillText(label, 0, y + bh / 2);
        }
        // Состояния — цветные круглые бейджи с иконкой под именем, по центру
        if (d.conditions?.length) {
          const chip = d.h * 0.17, gap = d.h * 0.04, total = d.conditions.length * chip + (d.conditions.length - 1) * gap;
          let x = -total / 2;
          const y = d.h / 2 + d.h * 0.30;
          for (const key of d.conditions) {
            const icon = condIcon(key);
            c.beginPath(); c.arc(x + chip / 2, y, chip / 2, 0, Math.PI * 2);
            c.fillStyle = colors.condBg; c.fill(); c.strokeStyle = colors.condText; c.lineWidth = 1.5 / S.cam.k; c.stroke();
            c.font = `bold ${chip * 0.65}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
            c.fillStyle = colors.condText; c.fillText(icon, x + chip / 2, y);
            x += chip + gap;
          }
        }
        // Мёртвый — жирный крест поверх токена
        if (d.dead) { c.strokeStyle = colors.dead; c.lineWidth = d.w * 0.12; c.beginPath(); c.moveTo(-d.w / 2.4, -d.h / 2.4); c.lineTo(d.w / 2.4, d.h / 2.4); c.moveTo(d.w / 2.4, -d.h / 2.4); c.lineTo(-d.w / 2.4, d.h / 2.4); c.stroke(); }
      }
    } else if (d.type === 'loot') {
      // мешочек с лутом: иконка предмета на подложке
      c.translate(d.x, d.y);
      const r = Math.min(d.w, d.h) / 2;
      c.beginPath(); c.roundRect(-r, -r, 2 * r, 2 * r, r * 0.3); c.fillStyle = '#2b2416ee'; c.fill(); c.strokeStyle = d.item?.rarity && d.item.rarity !== 'Обычный' ? (Modules.RARITY_COLORS[d.item.rarity] || colors.lootStroke) : colors.lootStroke; c.lineWidth = 3 / S.cam.k; c.stroke();
      const li = d.item?.token_asset_id || d.item?.asset_id ? assetImage(d.item.token_asset_id || d.item.asset_id) : null;
      if (li) watchImage(li);
      if (li && li.complete && li.naturalWidth) { c.save(); c.beginPath(); c.roundRect(-r * 0.85, -r * 0.85, 1.7 * r, 1.7 * r, r * 0.25); c.clip(); c.drawImage(li, -r * 0.85, -r * 0.85, 1.7 * r, 1.7 * r); c.restore(); }
      else { c.font = `${r * 1.1}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(d.item?.icon ? String(d.item.icon).slice(0, 2) : { weapon: 'W', armor: 'A', consumable: 'C', magic: 'M', treasure: '$', tool: 'T', ammo: 'A' }[d.item?.type] || 'L', 0, r * 0.05); }
      const label = (d.item?.name || 'Предмет') + (d.item?.qty > 1 ? ' ×' + d.item.qty : '');
      c.font = `bold ${Math.max(11 / S.cam.k, r * 0.3)}px sans-serif`; c.textBaseline = 'alphabetic'; c.lineWidth = 4 / S.cam.k; c.strokeStyle = colors.itemStroke; c.fillStyle = '#ffd77a'; c.strokeText(label, 0, r + r * 0.4); c.fillText(label, 0, r + r * 0.4);
    } else if (d.type === 'drawing') {
      drawShape(c, d);
    } else if (d.type === 'text') {
      c.font = `bold ${d.size || 24}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = d.color || '#fff'; c.strokeStyle = colors.textStroke; c.lineWidth = 3; c.strokeText(d.text, d.x, d.y); c.fillText(d.text, d.x, d.y);
    }
    c.restore();
  }
  function drawShape(c, d) {
    const p = d.points; c.strokeStyle = d.color; c.fillStyle = d.fill ? d.color + '55' : 'transparent'; c.lineWidth = d.width; c.lineCap = c.lineJoin = 'round';
    c.beginPath();
    if (d.shape === 'path' || d.shape === 'poly') { c.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) c.lineTo(q[0], q[1]); if (d.shape === 'poly') c.closePath(); }
    else if (d.shape === 'line') { c.moveTo(p[0][0], p[0][1]); c.lineTo(p[1][0], p[1][1]); }
    else if (d.shape === 'rect') { c.rect(Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.abs(p[1][0] - p[0][0]), Math.abs(p[1][1] - p[0][1])); }
    else if (d.shape === 'circle') { c.arc(p[0][0], p[0][1], Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 0, 7); }
    if (d.fill) c.fill(); c.stroke();
  }
  function drawTemp(c, t, uid) {
    if (t.kind === 'ruler') {
      const [a, b] = t.points;
      c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--tok-rotate').trim() || '#ffd54f'; c.lineWidth = 3 / S.cam.k; c.setLineDash([8 / S.cam.k, 6 / S.cam.k]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
      c.font = `bold ${16 / S.cam.k}px sans-serif`; c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--tok-rotate').trim() || '#ffd54f'; c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--tok-text-stroke').trim() || '#000a'; c.lineWidth = 4 / S.cam.k; c.textAlign = 'center';
      // Длина в футах и клетках: концы привязаны к сетке, если не зажат Ctrl (см. snapRuler).
      const label = T.rulerLabel(t.points, S.scene.grid, S.gridScaleFt, t.name);
      c.strokeText(label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12 / S.cam.k); c.fillText(label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12 / S.cam.k);
    } else if (t.kind === 'draw') {
      drawShape(c, { ...t, color: t.color, fill: true });
    } else if (t.kind === 'fog') {
      // Черновик маски: та же фигура, приглушённая и с «режимным» цветом.
      const color = t.mode === 'reveal' ? '#46a758' : '#e5484d';
      c.save();
      c.globalAlpha = 0.55;
      c.strokeStyle = color; c.fillStyle = color + '66';
      c.lineWidth = t.shape === 'path' ? t.width : 2 / S.cam.k;
      c.lineCap = c.lineJoin = 'round';
      c.beginPath(); fogPath(c, t);
      if (t.shape === 'path') c.stroke(); else { c.fill(); c.stroke(); }
      c.restore();
    }
  }
  /// Путь фигуры тумана в текущем контексте (без beginPath/fill/stroke).
  function fogPath(c, sh) {
    const p = sh.points || [];
    if (!p.length) return;
    if (sh.shape === 'rect') { c.rect(Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.abs(p[1][0] - p[0][0]), Math.abs(p[1][1] - p[0][1])); }
    else if (sh.shape === 'circle') { c.arc(p[0][0], p[0][1], Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 0, Math.PI * 2); }
    else if (sh.shape === 'polygon') { c.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) c.lineTo(q[0], q[1]); c.closePath(); }
    else { c.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) c.lineTo(q[0], q[1]); }
  }
  /// Буферы тумана по мировому размеру карты (кэшируются до смены маски/карты/границ — S.fogVersion):
  /// blur — маска с размытыми краями (радиус в мировых px, поэтому на экране край масштабируется
  /// с зумом), interior — жёстко непрозрачные клетки строго внутри скрытой области (там всегда 0/100).
  function fogBuffers(mask, b) {
    const key = [S.fogVersion, mask.cell, mask.cols, mask.rows, mask.x, mask.y, b.x, b.y, b.w, b.h].join('|');
    if (S.fogBuf && S.fogBuf.key === key) return S.fogBuf;
    const cell = mask.cell, w = Math.max(1, Math.ceil(b.w)), h = Math.max(1, Math.ceil(b.h));
    // Жёсткая основа: вся карта скрыта, открытые клетки (100) вырезаны — строгие 0/100 внутри областей.
    const hard = document.createElement('canvas'); hard.width = w; hard.height = h;
    const hc = hard.getContext('2d');
    hc.fillStyle = '#000'; hc.fillRect(0, 0, w, h);
    hc.globalCompositeOperation = 'destination-out';
    for (let row = 0; row < mask.rows; row++) for (let col = 0; col < mask.cols; col++) {
      if (mask.data[row][col] !== 100) continue;
      hc.fillRect(col * cell, row * cell, cell, cell);
    }
    hc.globalCompositeOperation = 'source-over';
    // Жёсткая середина поверх размытия: клетка строго внутри скрытой области — всегда непрозрачна.
    const interior = document.createElement('canvas'); interior.width = w; interior.height = h;
    const ic = interior.getContext('2d');
    ic.fillStyle = '#000';
    const r = Math.max(1, Math.ceil(T.fogBlurWorld(cell) / cell));
    for (let row = 0; row < mask.rows; row++) for (let col = 0; col < mask.cols; col++) {
      if (T.isInteriorCell(mask, col, row, r)) ic.fillRect(col * cell, row * cell, cell, cell);
    }
    // Размытый край: blur в мировых px (буфер мирового размера → при отрисовке с зумом край растёт вместе с ним).
    const blur = document.createElement('canvas'); blur.width = w; blur.height = h;
    const bc = blur.getContext('2d');
    if ('filter' in bc) { bc.filter = `blur(${T.fogBlurWorld(cell)}px)`; bc.drawImage(hard, 0, 0); bc.filter = 'none'; }
    else bc.drawImage(hard, 0, 0); // без поддержки filter край просто жёсткий
    S.fogBuf = { key, blur, interior };
    return S.fogBuf;
  }
  /// Туман активной карты из бинарной маски: рисуется только внутри её прямоугольника.
  /// Внутри маски строго 0/100 (жёсткие клетки), размывается только край (мировой радиус × зум).
  /// Полупрозрачен только GM-оверлей; игроки видят туман непрозрачным и только когда
  /// включено «Показать игрокам» (scene.fog.enabled).
  function drawFog(c) {
    const fog = S.scene?.fog;
    const map = activeMap();
    const b = map ? T.boundsOf(map) : null;
    if (!b) return;
    const showPlayers = T.fogEnabled(fog);
    const editing = S.canFog && S.tool === 'fog';
    if (!showPlayers && !editing) return;
    const mask = T.maskForMap(fog, map.id, b, T.gridSize(S.scene.grid));
    if (!mask) return;
    const buf = fogBuffers(mask, b);
    const fc = S.fogCanvas;
    // Пересоздаём буфер только при смене размера: иначе каждый кадр терял бы состояние.
    if (fc.width !== S.canvas.width || fc.height !== S.canvas.height) { fc.width = S.canvas.width; fc.height = S.canvas.height; }
    const x = fc.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, fc.width, fc.height);
    x.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    x.save();
    x.translate(S.cam.x, S.cam.y); x.scale(S.cam.k, S.cam.k);
    // Обрезка по карте: туман живёт только внутри её прямоугольника.
    x.beginPath(); x.rect(b.x, b.y, b.w, b.h); x.clip();
    x.globalAlpha = S.isGM ? 0.55 : 1; // GM-оверлей полупрозрачен, игроки видят непрозрачный туман
    x.drawImage(buf.blur, b.x, b.y);
    x.drawImage(buf.interior, b.x, b.y);
    x.restore();
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(fc, 0, 0); c.restore();
    // GM-оверлей в режиме редактирования: жёлтая рамка активной карты.
    if (editing) {
      c.save();
      c.strokeStyle = 'rgba(255,213,79,0.85)'; c.lineWidth = 2 / S.cam.k; c.setLineDash([10 / S.cam.k, 6 / S.cam.k]);
      c.strokeRect(b.x, b.y, b.w, b.h); c.setLineDash([]);
      c.restore();
    }
  }
  /// Предпросмотр под курсором: кружок кисти/ластика или точка-затравка для фигур.
  function drawFogPreview(c) {
    if (!S.canFog || S.tool !== 'fog' || !S.hover || S.drag) return;
    const map = activeMap(); const b = T.boundsOf(map); if (!b) return;
    // Цвет — как у будущего мазка: ластик работает в обратном режиме.
    const effective = S.fogTool === 'eraser' ? (S.fogMode === 'reveal' ? 'hide' : 'reveal') : S.fogMode;
    const color = effective === 'reveal' ? '#46a758' : '#e5484d';
    const w = S.hover;
    c.save();
    c.beginPath(); c.rect(b.x, b.y, b.w, b.h); c.clip();
    if (S.fogTool === 'brush' || S.fogTool === 'eraser') {
      const r = T.fogBrushWidth(S.fogCells, grid()) / 2;
      c.beginPath(); c.arc(w.x, w.y, r, 0, Math.PI * 2);
      c.fillStyle = color + '33'; c.fill();
      c.strokeStyle = color; c.lineWidth = 1.5 / S.cam.k; c.setLineDash([6 / S.cam.k, 4 / S.cam.k]); c.stroke(); c.setLineDash([]);
    } else {
      c.beginPath(); c.arc(w.x, w.y, 4 / S.cam.k, 0, Math.PI * 2); c.fillStyle = color; c.fill();
    }
    c.restore();
  }
  // Состояния — из набора conditions (короткое имя и значок на жетоне). Нет в наборе — показываем ключ.
  const condItem = key => window.Presets?.item('conditions', key)?.table || null;
  const condShort = key => condItem(key)?.short || key;
  const condIcon = key => condItem(key)?.icon || '?';
  const condKeys = () => window.Presets?.items('conditions').map(i => i.id) || [];

  // ---------- инструменты ----------
  // ---------- Инструменты и события мыши/касаний ----------
  function buildTools(wrap) {
    const tools = [['select', icon('select'), 'Выбор (V)'], ['pan', icon('hand'), 'Панорама (H)'], ['ruler', icon('ruler'), 'Линейка (R)'], ['draw', icon('pen'), 'Рисование (D)'], ['text', icon('text'), 'Текст'], ['pointer', icon('pin'), 'Указка (P)']];
    if (S.canFog) tools.push(['fog', icon('fog'), 'Туман войны (F)']);
    S.toolbox = el('div', { class: 'tools' });
    for (const [id, ico, title] of tools) S.toolbox.append(el('button', { class: 'icon', 'data-tool': id, title, onclick: () => setTool(id) }, ico));
    S.subbox = el('div', { class: 'sub' });
    S.toolbox.append(S.subbox);
    wrap.append(S.toolbox);
    const pingColorPicker = el('input', { type: 'color', id: 'pingColor', title: 'Цвет пинга', value: S.pingColor, style: 'width:26px;height:26px;padding:0;border:0;background:none;cursor:pointer', oninput: e => { S.pingColor = e.target.value; try { localStorage.setItem('table.pingColor', S.pingColor); } catch { } } });
    const zoom = el('div', { class: 'zoom' },
      el('button', { class: 'icon', onclick: () => zoomBy(1.25) }, '+'), el('button', { class: 'icon', onclick: () => zoomBy(0.8) }, '−'),
      el('button', { class: 'icon', title: 'Вписать карту', onclick: fitToMap }, icon('fit')),
      el('button', { class: 'icon', title: 'Привязка к сетке', id: 'snapBtn', onclick: (e) => { S.snap = !S.snap; e.currentTarget.classList.toggle('active', S.snap); } }, '#'));
    zoom.append(pingColorPicker);
    zoom.querySelector('#snapBtn').classList.add('active');
    wrap.append(zoom);
    setTool('select');
  }
  function setTool(t) {
    if (t === 'fog' && !S.canFog) t = 'select'; // игрокам туман недоступен
    // Без активной карты маска тумана не к чему привязать: выбираем первую карту сцены.
    if (t === 'fog' && !activeMap()) {
      const first = T.mapItems(S.scene.items)[0];
      if (first) setActiveMap(first.id);
    }
    S.tool = t; S.temp = null; S.hover = null;
    requestDraw();
    S.toolbox.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    S.canvas.className = 'tool-' + t;
    syncFogCursor();
    S.subbox.innerHTML = '';
    const hints = { select: 'ЛКМ — выбрать/тащить, ручки — размер и поворот, Ctrl при отпускании — без привязки к сетке; двойной клик по токену — лист, Delete — удалить; ПКМ — панорама, колесо — пинг', pan: 'Тяните для панорамирования (или ПКМ)', ruler: 'Тяните для измерения (видят все). Ctrl (Cmd) — без привязки к сетке', draw: 'Рисуйте на карте', text: 'Клик — добавить текст', pointer: 'Клик — пинг для всех', fog: '' };
    S.hint.textContent = hints[t] || '';
    if (t === 'draw') {
      const shapes = [['path', icon('path')], ['line', icon('line')], ['rect', icon('rect')], ['circle', icon('circle')], ['poly', icon('poly')]];
      const col = el('div', { style: 'display:flex;flex-direction:column;gap:3px' });
      const srow = el('div', { style: 'display:flex;gap:3px' }, ...shapes.map(([s, i]) => el('button', { class: 'icon small' + (S.drawShape === s ? ' active' : ''), style: 'width:30px;height:30px', onclick: (e) => { S.drawShape = s; srow.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); } }, i)));
      const crow = el('div', { style: 'display:flex;gap:3px;flex-wrap:wrap;width:170px' }, ...COLORS.map(cc => el('button', { style: `width:22px;height:22px;padding:0;background:${cc};border-color:${S.drawColor === cc ? '#fff' : '#444'}`, onclick: (e) => { S.drawColor = cc; crow.querySelectorAll('button').forEach(b => b.style.borderColor = '#444'); e.currentTarget.style.borderColor = '#fff'; } })));
      const wr = el('input', { type: 'range', min: 2, max: 30, value: S.drawWidth, style: 'width:170px', oninput: (e) => S.drawWidth = +e.target.value });
      col.append(srow, crow, wr); S.subbox.append(col);
    }
    if (t === 'fog') {
      // Инструменты 1–4, режим открыть/скрыть, размер кисти, действия и «Показать игрокам».
      // Маска живёт на активную карту — панель всегда показывает её.
      const col = el('div', { style: 'display:flex;flex-direction:column;gap:4px;width:190px' });
      const trow = el('div', { style: 'display:flex;gap:3px;flex-wrap:wrap' },
        ...[['brush', 'Кисть', '1'], ['rect', 'Прямоуг.', '2'], ['circle', 'Круг', '3'], ['eraser', 'Ластик', '4']].map(([k, label, key]) =>
          el('button', { class: 'small' + (S.fogTool === k ? ' active' : ''), 'data-fog': 'tool-' + k, style: 'flex:1 1 40%', title: label + ' (' + key + ')', onclick: () => selectFogTool(k) }, label)));
      const mrow = el('div', { style: 'display:flex;gap:3px' },
        el('button', { class: 'small' + (S.fogMode === 'reveal' ? ' active' : ''), 'data-fog': 'mode-reveal', style: 'flex:1', title: 'Новые мазки открывают (Shift — наоборот)', onclick: () => setFogMode('reveal') }, 'Открыть'),
        el('button', { class: 'small' + (S.fogMode === 'hide' ? ' active' : ''), 'data-fog': 'mode-hide', style: 'flex:1', title: 'Новые мазки скрывают (Shift — наоборот)', onclick: () => setFogMode('hide') }, 'Скрыть'));
      const sizeRow = el('div', { style: 'display:flex;align-items:center;gap:6px' },
        el('input', { type: 'range', min: T.FOG_BRUSH_MIN, max: T.FOG_BRUSH_MAX, step: 1, value: S.fogCells, 'data-fog': 'size', style: 'flex:1', title: 'Размер кисти, клеток ([ и ])', oninput: e => setFogCells(+e.target.value) }),
        el('span', { class: 'muted small', 'data-fog': 'size-label' }, S.fogCells + ' кл.'));
      const arow = el('div', { style: 'display:flex;gap:3px;flex-wrap:wrap' },
        el('button', { class: 'small', 'data-fog': 'all', style: 'flex:1 1 40%', title: 'Открыть всю активную карту', onclick: openAllFog }, 'Открыть всё'),
        el('button', { class: 'small', 'data-fog': 'none', style: 'flex:1 1 40%', title: 'Скрыть всю активную карту', onclick: hideAllFog }, 'Скрыть всё'),
        el('button', { class: 'small', 'data-fog': 'undo', style: 'flex:1 1 100%', title: 'Отменить последний мазок (Ctrl+Z)', onclick: undoFog }, 'Отменить мазок'));
      const players = el('label', { class: 'small', style: 'display:flex;align-items:center;gap:4px' },
        el('input', { type: 'checkbox', 'data-fog': 'players', checked: T.fogEnabled(S.scene.fog) ? '' : null, style: 'width:auto', onchange: e => setFogPlayers(e.target.checked) }), 'Показать игрокам');
      col.append(trow, mrow, sizeRow, arow, players); S.subbox.append(col);
      updateFogHint();
    }
  }

  // ---------- туман войны: панель, действия, отмена ----------
  /// Активная карта и её прямоугольник — туман живёт на карте и обрезается по ней.
  function fogTarget() {
    const map = activeMap();
    if (!map) { toast('Сначала сделайте карту активной'); return null; }
    return { map, bounds: T.boundsOf(map) };
  }
  /// Записать fog в сцену и отправить мастерам/игрокам тем же каналом, что сетку и слои.
  function commitFog(fog) {
    S.scene.fog = fog;
    S.fogVersion++; S.fogBuf = null; // маска сменилась — буферы тумана пересоберутся
    sendScene({ fog: S.scene.fog });
    syncFogPanel();
    requestDraw();
  }
  /// Снимок маски карты в стек отмены (до T.FOG_UNDO_MAX шагов на карту; null — маски не было).
  function pushFogUndo(mapId) { S.fogUndo[mapId] = T.pushUndo(S.fogUndo[mapId], T.maskOf(S.scene.fog, mapId)); }
  function selectFogTool(k) { S.fogTool = k; S.temp = null; syncFogCursor(); syncFogPanel(); requestDraw(); }
  function setFogMode(m) { S.fogMode = m === 'hide' ? 'hide' : 'reveal'; syncFogPanel(); requestDraw(); }
  function setFogCells(n) { S.fogCells = T.clampBrush(n); syncFogPanel(); requestDraw(); }
  function setFogPlayers(on) { commitFog(T.setFogEnabled(S.scene.fog, on)); }
  function openAllFog() {
    const t = fogTarget(); if (!t) return;
    const mask = T.revealAllMask(t.bounds, T.gridSize(S.scene.grid)); if (!mask) return;
    pushFogUndo(t.map.id);
    commitFog(T.setMask({ ...S.scene.fog, enabled: true }, t.map.id, mask));
  }
  /** Скрыть всё: запись маски удаляется — карта снова целиком скрыта. */
  function hideAllFog() {
    const t = fogTarget(); if (!t) return;
    pushFogUndo(t.map.id);
    commitFog(T.setMask({ ...S.scene.fog, enabled: true }, t.map.id, null));
  }
  function undoFog() {
    const t = fogTarget(); if (!t) return;
    const step = T.undoStep(S.fogUndo[t.map.id]);
    if (step.mask === undefined) { toast('Нечего отменять'); return; }
    S.fogUndo[t.map.id] = step.stack;
    commitFog(T.setMask(S.scene.fog, t.map.id, step.mask)); // null — вернуть «маски не было»
  }
  /// Растеризовать мазок в единую бинарную маску активной карты (обрезка по её границам — в модели).
  function addFogShape(tool, points, mode) {
    const target = fogTarget(); if (!target) return;
    const shape = T.fogShape(tool, points, { mode, cells: S.fogCells, gridSize: grid() });
    if (!shape) return;
    const res = T.addMaskStroke({ ...S.scene.fog, enabled: true }, target.map.id, shape, target.bounds, T.gridSize(S.scene.grid));
    if (!res.added) { toast('Мазок вне карты — туман обрезается по её границам'); return; }
    pushFogUndo(target.map.id);
    commitFog(res.fog);
  }
  function fogHintText() {
    const map = activeMap();
    const mask = map ? T.maskOf(S.scene.fog, map.id) : null;
    const tool = { brush: 'кисть', rect: 'прямоугольник', circle: 'круг', eraser: 'ластик' }[S.fogTool] || S.fogTool;
    const size = S.fogTool === 'brush' || S.fogTool === 'eraser' ? ` ${S.fogCells} кл.` : '';
    const effective = S.fogTool === 'eraser' ? (S.fogMode === 'reveal' ? 'hide' : 'reveal') : S.fogMode;
    const mode = effective === 'reveal' ? 'открывает' : 'скрывает';
    const mapName = map ? (map.data?.name || 'без имени') : 'нет активной карты';
    const players = T.fogEnabled(S.scene.fog) ? 'игроки видят туман' : 'игроки тумана не видят';
    const maskInfo = mask ? `маска ${mask.cols}×${mask.rows} кл.` : 'маски нет (карта скрыта)';
    return `Туман: ${tool}${size} ${mode} · карта «${mapName}» · ${maskInfo} · ${players} · 1–4 инструмент, [ ] размер, Shift — наоборот, Ctrl+Z отмена`;
  }
  function updateFogHint() { if (S.tool === 'fog' && S.hint) S.hint.textContent = fogHintText(); }
  /// У кисти/ластика системный курсор прячем: роль курсора играет нарисованный кружок (drawFogPreview).
  function syncFogCursor() {
    if (!S.canvas) return;
    const circle = S.canFog && S.tool === 'fog' && (S.fogTool === 'brush' || S.fogTool === 'eraser');
    S.canvas.style.cursor = circle ? 'crosshair' : '';
  }
  /// Обновить панель тумана без перерисовки (после действия, отмены и scene_update от другого мастера).
  function syncFogPanel() {
    if (S.tool !== 'fog' || !S.subbox) return;
    const players = S.subbox.querySelector('[data-fog="players"]');
    if (players) players.checked = T.fogEnabled(S.scene.fog);
    const size = S.subbox.querySelector('[data-fog="size"]');
    if (size) size.value = S.fogCells;
    const label = S.subbox.querySelector('[data-fog="size-label"]');
    if (label) label.textContent = S.fogCells + ' кл.';
    S.subbox.querySelectorAll('[data-fog^="tool-"]').forEach(b => b.classList.toggle('active', b.dataset.fog === 'tool-' + S.fogTool));
    S.subbox.querySelectorAll('[data-fog^="mode-"]').forEach(b => b.classList.toggle('active', b.dataset.fog === 'mode-' + S.fogMode));
    syncFogCursor();
    updateFogHint();
  }
  function zoomBy(f, cx = S.w / 2, cy = S.h / 2) {
    const k2 = Math.min(6, Math.max(0.08, S.cam.k * f));
    S.cam.x = cx - (cx - S.cam.x) * (k2 / S.cam.k); S.cam.y = cy - (cy - S.cam.y) * (k2 / S.cam.k); S.cam.k = k2;
    requestDraw();
  }

  // ---------- события ----------
  function bindEvents() {
    const cv = S.canvas;
    let space = false;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9, e.offsetX, e.offsetY); }, { passive: false });
    cv.addEventListener('pointerdown', e => {
      requestDraw();
      cv.setPointerCapture(e.pointerId);
      const w = toWorld(e.offsetX, e.offsetY);
      if (e.button === 2 && !space) {
        // ПКМ — панорама; короткий клик без движения по элементу откроет его меню на отпускании.
        const it = hitTest(w.x, w.y);
        S.rightClick = it ? { it, x: e.clientX, y: e.clientY } : null;
        S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: S.cam.x, cy: S.cam.y };
        return;
      }
      if (e.button === 1) {
        // Средняя кнопка (клик колесом) — пинг в точке.
        S.pings.push({ x: w.x, y: w.y, t: Date.now(), name: S.user.name, color: S.pingColor });
        S.ws.send({ type: 'ping', x: w.x, y: w.y, color: S.pingColor });
        return;
      }
      if (space || S.tool === 'pan') { S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: S.cam.x, cy: S.cam.y }; return; }
      if (S.tool === 'select') {
        // Ручка ресайза/поворота выделенного токена — начинаем ресайз или поворот.
        const itSel = S.sel ? S.scene.items.find(i => i.id === S.sel) : null;
        const handle = itSel ? hitTokenHandle(w.x, w.y, itSel) : null;
        if (handle && (handle.kind === 'resize' || handle.kind === 'rotate') && canEdit(itSel) && !itSel.data.locked) {
          const d = itSel.data;
          const b = itemBounds(itSel);
          S.resize = {
            kind: handle.kind, handle: handle.handle, it: itSel,
            x0: d.x, y0: d.y, w0: d.w, h0: d.h, r0: d.rotation || 0,
            // Точка нажатия в мировых координатах: ход ручки считается от неё.
            sx: w.x, sy: w.y,
          };
          S.drag = { kind: 'resize', sx: e.clientX, sy: e.clientY };
          requestDraw();
          return;
        }
        const it = hitTest(w.x, w.y);
        const editable = it && canEdit(it) && !it.data.locked;
        if (editable) {
          if (e.shiftKey) {
            // Shift — добавить/убрать из выделения.
            if (S.selSet.has(it.id)) S.selSet.delete(it.id); else S.selSet.add(it.id);
            S.sel = [...S.selSet].pop() || null;
            updateProps(); requestDraw();
            if (!S.selSet.has(it.id)) { S.drag = null; return; }
          } else if (!S.selSet.has(it.id)) {
            setSelection([it.id]);
          } else {
            S.sel = it.id; updateProps();
          }
          // Тянем всё выделение группой (привязка к сетке — при отпускании).
          const items = selectionItems().map(x => ({ it: x, sx: x.data.x, sy: x.data.y }));
          S.drag = { kind: 'move', items, primary: it, ox: w.x, oy: w.y, moved: false };
        } else if (it) {
          // Чужой или закреплённый элемент: только просмотр свойств, без выделения и движения.
          S.selSet = new Set(); S.sel = it.id; S.drag = null; updateProps(); requestDraw();
        } else {
          // Пустое место: рамка выделения (Shift — добавить к текущему выделению).
          if (!e.shiftKey) { S.selSet = new Set(); S.sel = null; updateProps(); }
          S.selBox = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, additive: !!e.shiftKey };
          S.drag = { kind: 'marquee' };
          requestDraw();
        }
      } else if (S.tool === 'ruler') {
        startRuler([[w.x, w.y], [w.x, w.y]], e);
      } else if (S.tool === 'draw') {
        if (S.drawShape === 'poly') {
          if (!S.temp) S.temp = { kind: 'draw', shape: 'poly', points: [[w.x, w.y], [w.x, w.y]], color: S.drawColor, width: S.drawWidth };
          else { S.temp.points.splice(-1, 0, [w.x, w.y]); }
          return;
        }
        S.temp = { kind: 'draw', shape: S.drawShape, points: [[w.x, w.y], [w.x, w.y]], color: S.drawColor, width: S.drawWidth }; S.drag = { kind: 'temp' };
      } else if (S.tool === 'fog') {
        // Режим мазка: Shift временно переворачивает; ластик — наоборот к выбранному режиму.
        const base = e.shiftKey ? (S.fogMode === 'reveal' ? 'hide' : 'reveal') : S.fogMode;
        const mode = S.fogTool === 'eraser' ? (base === 'reveal' ? 'hide' : 'reveal') : base;
        if (S.fogTool === 'brush' || S.fogTool === 'eraser') {
          S.temp = { kind: 'fog', shape: 'path', mode, points: [[w.x, w.y]], width: T.fogBrushWidth(S.fogCells, grid()) };
          S.drag = { kind: 'temp' };
        } else {
          S.temp = { kind: 'fog', shape: S.fogTool === 'circle' ? 'circle' : 'rect', mode, points: [[w.x, w.y], [w.x, w.y]], width: 2 };
          S.drag = { kind: 'temp' };
        }
      } else if (S.tool === 'pointer') {
        S.pings.push({ x: w.x, y: w.y, t: Date.now(), name: S.user.name, color: S.pingColor }); S.ws.send({ type: 'ping', x: w.x, y: w.y, color: S.pingColor });
      } else if (S.tool === 'text') {
        prompt2('Текст надписи').then(t => { if (t) upsert({ layer: LAYER.text, z: 0, data: { type: 'text', text: t, x: w.x, y: w.y, size: 28, color: '#ffffff', owner_id: S.user.id } }); });
      }
    });
    cv.addEventListener('pointermove', e => {
      requestDraw();
      const w = toWorld(e.offsetX, e.offsetY);
      S.hover = { x: w.x, y: w.y };
      if (S.temp && (S.temp.shape === 'poly')) { S.temp.points[S.temp.points.length - 1] = [w.x, w.y]; return; }
      if (!S.drag) return;
      if (S.drag.kind === 'pan') { S.cam.x = S.drag.cx + e.clientX - S.drag.sx; S.cam.y = S.drag.cy + e.clientY - S.drag.sy; }
      else if (S.drag.kind === 'move') {
        // Группа двигается одним смещением: относительные позиции сохраняются.
        const dx = w.x - S.drag.ox, dy = w.y - S.drag.oy;
        for (const entry of S.drag.items) { entry.it.data.x = entry.sx + dx; entry.it.data.y = entry.sy + dy; }
        S.drag.moved = true;
      } else if (S.drag.kind === 'marquee' && S.selBox) { S.selBox.x1 = w.x; S.selBox.y1 = w.y; }
      else if (S.drag.kind === 'resize' && S.resize) {
        if (S.resize.handle === 'rotate') applyRotate(w, e); else applyResize(w);
      }
      else if (S.drag.kind === 'temp' && S.temp) {
        if (S.temp.kind === 'ruler') moveRuler(w, e.ctrlKey || e.metaKey);
        else if (S.temp.shape === 'path') {
          // Точки мазка не чаще ~1.5 px — иначе длинный штрих раздувает JSON маски.
          const last = S.temp.points[S.temp.points.length - 1];
          if (!last || Math.hypot(w.x - last[0], w.y - last[1]) >= 1.5) S.temp.points.push([w.x, w.y]);
        }
        else S.temp.points[1] = [w.x, w.y];
      }
    });
    cv.addEventListener('pointerleave', () => { S.hover = null; requestDraw(); });
    cv.addEventListener('pointerup', e => {
      requestDraw();
      // Ctrl (Cmd) при отпускании — свободное размещение: без привязки к сетке.
      const free = e.ctrlKey || e.metaKey;
      if (S.drag?.kind === 'move' && S.drag.moved) {
        // Привязка к сетке — каждому элементу группы отдельно, затем один upsert на элемент.
        for (const entry of S.drag.items) {
          const it = entry.it, d = it.data;
          if (d.type === 'image' && it.layer !== LAYER.drawing && S.snap && !free) {
            // Карту привязываем левым верхним углом (её сетка должна совпадать с клетками).
            if (layerOf(it) === LAYER.map && !isHex()) { const c = T.snapCorner(d.x - d.w / 2, d.y - d.h / 2, S.scene.grid); d.x = c.x + d.w / 2; d.y = c.y + d.h / 2; }
            else { const p = snapPos(d.x, d.y, d.w, d.h); d.x = p.x; d.y = p.y; }
          }
          upsert(it);
        }
      }
      if (S.drag?.kind === 'resize' && S.resize) { finishResize(e); }
      if (S.drag?.kind === 'marquee') finishMarquee();
      if (S.drag?.kind === 'temp' && S.temp) finishTemp();
      // ПКМ без движения — обычный клик: выделяем элемент и показываем меню.
      if (S.drag?.kind === 'pan' && S.rightClick) {
        const moved = Math.hypot(e.clientX - S.drag.sx, e.clientY - S.drag.sy);
        if (moved < 4) {
          const { it, x, y } = S.rightClick;
          if (!(S.selSet.has(it.id) && S.selSet.size > 1)) {
            if (canEdit(it) && !it.data.locked) setSelection([it.id]);
            else { S.selSet = new Set(); S.sel = it.id; updateProps(); }
          }
          contextMenu(it, x, y);
        }
      }
      S.rightClick = null;
      S.drag = null;
    });
    cv.addEventListener('dblclick', e => {
      requestDraw();
      const w = toWorld(e.offsetX, e.offsetY);
      if (S.temp?.shape === 'poly') { S.temp.points.pop(); finishTemp(); return; }
      const it = hitTest(w.x, w.y);
      if (it?.data.character_id) S.onOpenSheet(it.data.character_id);
    });
    window.addEventListener('keydown', e => {
      if (e.target.matches('input,textarea,select') || e.target.isContentEditable) return;
      requestDraw();
      if (e.code === 'Space') { space = true; cv.style.cursor = 'grab'; }
      if (e.key === 'Escape') { S.temp = null; S.selBox = null; S.drag = null; S.resize = null; S.selSet = new Set(); S.sel = null; updateProps(); requestDraw(); }
      // Ctrl/Cmd переключает привязку линейки к сетке — пересчитываем уже протянутую линию.
      if ((e.key === 'Control' || e.key === 'Meta') && !e.repeat) refreshRulerSnap(true);
      if (e.key === 'Enter' && S.temp?.shape === 'poly') { S.temp.points.pop(); finishTemp(); }
      const map = { v: 'select', h: 'pan', r: 'ruler', d: 'draw', p: 'pointer', f: 'fog' };
      if (map[e.key.toLowerCase()] && !e.ctrlKey) { if (map[e.key.toLowerCase()] !== 'fog' || S.canFog) setTool(map[e.key.toLowerCase()]); }
      // Туман: 1–4 — инструмент, [ ] — размер кисти, Ctrl+Z — отменить последний мазок.
      if (S.canFog && S.tool === 'fog' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const fogTools = { 1: 'brush', 2: 'rect', 3: 'circle', 4: 'eraser' };
        if (fogTools[e.key]) { selectFogTool(fogTools[e.key]); return; }
        if (e.key === '[') { setFogCells(S.fogCells - 1); return; }
        if (e.key === ']') { setFogCells(S.fogCells + 1); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && S.canFog && S.tool === 'fog') { e.preventDefault(); undoFog(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (S.sel || S.selSet.size)) { deleteSel(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectionItems().length) {
        e.preventDefault();
        const g = grid(); const dx = { ArrowLeft: -g, ArrowRight: g }[e.key] || 0, dy = { ArrowUp: -g, ArrowDown: g }[e.key] || 0;
        eachSelected(it => { it.data.x += dx; it.data.y += dy; });
      }
      if (e.ctrlKey && e.key === 'c' && S.sel) { const it = S.scene.items.find(i => i.id === S.sel); if (it) S.clip = JSON.parse(JSON.stringify(it)); }
      if (e.ctrlKey && e.key === 'v' && S.clip) { const it = JSON.parse(JSON.stringify(S.clip)); delete it.id; it.data.x += grid(); it.data.y += grid(); upsert(it); }
    });
    window.addEventListener('keyup', e => {
      requestDraw();
      if (e.code === 'Space') { space = false; syncFogCursor(); }
      if (e.key === 'Control' || e.key === 'Meta') refreshRulerSnap(!!(e.ctrlKey || e.metaKey));
    });

    // drag&drop из панелей (ассеты, персонажи, монстры) и файлов
    cv.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    cv.addEventListener('drop', async e => {
      e.preventDefault();
      requestDraw();
      const w = toWorld(e.offsetX, e.offsetY); const g = grid();
      const asset = e.dataTransfer.getData('application/x-asset');
      const chr = e.dataTransfer.getData('application/x-character');
      const comp = e.dataTransfer.getData('application/x-compendium');
      const lootRaw = e.dataTransfer.getData('application/x-item');
      if (asset) { placeAsset(JSON.parse(asset), w); return; }
      if (lootRaw) {
        try {
          const payload = JSON.parse(lootRaw);
          const target = payload.from_character_id ? characterTokenAt(w.x, w.y, payload.from_character_id) : null;
          if (target) {
            const targetId = target.data.character_id;
            await API.post(`/api/characters/${encodeURIComponent(payload.from_character_id)}/transfer`, { item_uid: payload.item.uid, to_character_id: targetId });
            toast(`${payload.item.name} → ${target.data.name || 'персонажу'}`);
          } else await dropLoot(payload, w);
        } catch (err) { toast('Ошибка: ' + err.message); }
        return;
      }
      const spellRaw = e.dataTransfer.getData('application/x-spell');
      if (spellRaw) {
        const sp = JSON.parse(spellRaw);
        const src = sp.spell || sp;
        if (!src.token_asset_id && !src.asset_id) { toast('У заклинания нет токена эффекта — задайте его в редакторе заклинания'); return; }
        const cells = Math.max(1, +src.effect_size || 1), sz = g * cells;
        const p = snapPos(w.x, w.y, sz, sz);
        upsert({ layer: LAYER.prop, z: 2, data: { type: 'image', asset_id: src.token_asset_id || src.asset_id, x: p.x, y: p.y, w: sz, h: sz, name: src.name, effect: true, owner_id: S.user.id } });
        return;
      }
      if (chr) {
        const c = JSON.parse(chr);
        const data = { type: 'image', asset_id: c.sheet?.token_asset_id || c.portrait_asset_id, x: w.x, y: w.y, w: g, h: g, name: c.name, character_id: c.id, owner_id: c.owner_id, hp: { cur: c.sheet?.hp?.current ?? 10, max: c.sheet?.hp?.max ?? 10 } };
        if (!data.asset_id) { const a = (await API.get('/api/assets?kind=token')).find(x => x.name === 'NPC') || (await API.get('/api/assets?kind=token'))[0]; data.asset_id = a.id; }
        const p = snapPos(w.x, w.y, g, g); data.x = p.x; data.y = p.y;
        upsert({ layer: LAYER.character, z: 0, data }); return;
      }
      if (comp) {
        const c = JSON.parse(comp);
        if ((c.category === 'monster' || c.category === 'npc') && S.isGM) {
          const toks = await API.get('/api/assets?kind=token');
          const a = (c.data.token_asset_id ? { id: c.data.token_asset_id } : null) || toks.find(t => c.name.toLowerCase().includes(t.name.toLowerCase())) || toks.find(t => t.name === 'NPC') || toks[0];
          const sizeMul = { 'Крошечный': 0.5, 'Маленький': 1, 'Средний': 1, 'Большой': 2, 'Огромный': 3, 'Громадный': 4 }[c.data.size] || 1;
          const hp = parseInt(c.data.hp) || (c.category === 'npc' ? 4 : 10);
          const p = snapPos(w.x, w.y, g * sizeMul, g * sizeMul);
          upsert({ layer: LAYER.character, z: 1, data: { type: 'image', asset_id: a.id, x: p.x, y: p.y, w: g * sizeMul, h: g * sizeMul, name: c.name, hp: { cur: hp, max: hp }, monster: c.data.abilities || c.data.hp || c.category === 'monster' ? c.data : null, npc: c.category === 'npc' ? { desc: c.data.desc, role: c.data.role, faction: c.data.faction, attitude: c.data.attitude, hooks: c.data.hooks } : undefined, hidden: false, owner_id: S.user.id } });
        } else toast('На стол можно бросать монстров и NPC');
        return;
      }
      if (e.dataTransfer.files?.length) {
        for (const f of e.dataTransfer.files) {
          if (!f.type.startsWith('image/')) continue;
          const fd = new FormData(); fd.append('file', f); fd.append('name', f.name.replace(/\.[^.]+$/, '')); fd.append('kind', window.AssetKinds.kindForLayer(S.activeLayer)); fd.append('campaign_id', S.campaign.id);
          toast('Загрузка ' + f.name + '…');
          const a = await API.upload('/api/assets', fd); placeAsset(a, w); S.onAssetsChanged && S.onAssetsChanged();
        }
      }
    });
  }
  // Предмет на герое передаётся его листу; при броске на свободное место стола создаём «лут»-токен.
  // ---------- Лут и размещение ассетов ----------
  async function dropLoot(p, w, silent) {
    const g = grid(); const pos = snapPos(w.x, w.y, g * 0.7, g * 0.7);
    if (p.from_character_id) {
      await API.post('/api/characters/' + p.from_character_id + '/inventory', { request_id: crypto.randomUUID(), op: 'drop', item_uid: p.item.uid, scene_id: S.scene.id, x: pos.x, y: pos.y, size: g * .7 });
    } else {
      // Explicitly spawning a new template is distinct from moving a character's item.
      const item = { ...p.item, uid: Modules.uid(), equipped: false, hand_slot: null, worn_slot: null, favorite: false, attuned: false };
      upsert({ layer: LAYER.prop, z: 5, data: { type: 'loot', loot: true, item, x: pos.x, y: pos.y, w: g * .7, h: g * .7, name: item.name, owner_id: S.user.id } });
    }
    if (!silent) toast(`${p.item.name} на столе`);
  }
  const picking = new Set();
  async function pickUpLoot(it) {
    if (picking.has(it.id)) return;
    picking.add(it.id);
    try {
      const all = await API.get('/api/characters?campaign_id=' + S.campaign.id);
      const mine = S.isGM ? all : all.filter(c => c.owner_id === S.user.id);
      if (!mine.length) return toast('У вас нет персонажа в кампании');
      let target = mine[0];
      if (mine.length > 1) { const sel = el('select', {}, ...mine.map(c => el('option', { value: c.id }, c.name))); const ok = await modal(`Кто подбирает «${it.data.item?.name}»?`, el('div', { class: 'field' }, sel), [{ label: 'Подобрать', cls: 'primary', fn: () => sel.value }]); if (!ok) return; target = mine.find(c => c.id === ok); }
      await API.post('/api/characters/' + target.id + '/inventory', { request_id: crypto.randomUUID(), op: 'pickup', scene_id: S.scene.id, loot_id: it.id });
      if (S.sel === it.id) { S.sel = null; updateProps(); }
      toast(`${target.name} подбирает ${it.data.item.name}`);
    } catch (e) { toast(e.message); } finally { picking.delete(it.id); }
  }

  function placeAsset(a, w) {
    const g = grid();
    let layer = AssetKinds.layerOf(a.kind);
    if (!S.isGM && !Access.canLayerCreate(S.campaign.id, S.campaign.role, layer)) layer = LAYER.character;
    // Скрытый или заблокированный слой карты не должен «съедать» новую карту: показываем и снимаем блок.
    if (layer === LAYER.map) {
      const list = getLayers();
      const mapLayer = list.find(entry => entry.id === LAYER.map);
      if (mapLayer && (mapLayer.hidden || mapLayer.locked)) {
        setLayers(list.map(entry => entry.id === LAYER.map ? { ...entry, hidden: false, locked: false } : entry));
      }
    }
    const isMap = layer === LAYER.map;
    let wdt, hgt, x = w.x, y = w.y;
    if (isMap) {
      // На слое карт может лежать несколько карт (этажи/области): каждая — обычный объект,
      // прежнюю карту не трогаем и ничего не подтверждаем. Геометрия — в table-model.js.
      const rect = T.mapRect(a, w, { grid: S.scene.grid, snap: S.snap, hex: isHex() });
      x = rect.x; y = rect.y; wdt = rect.w; hgt = rect.h;
    } else {
      const ratio = a.width / a.height || 1; wdt = g; hgt = g / ratio; if (AssetKinds.get(a.kind).square) { wdt = g; hgt = g; } const p = snapPos(x, y, wdt, hgt); x = p.x; y = p.y;
    }
    // Карта создаётся со своим id сразу (по нему мастер выбирает активную карту для тумана)
    // и потому уходит на сервер как явное создание — иначе он счёл бы это запоздавшим
    // движением удалённого элемента и молча отбросил (см. src/ws/realtime.rs).
    const item = { id: isMap ? newId() : undefined, layer, z: isMap ? -100 : 0, data: { type: 'image', asset_id: a.id, x, y, w: wdt, h: hgt, name: isMap || layer === LAYER.character ? a.name : undefined, owner_id: S.isGM ? undefined : S.user.id, locked: isMap ? false : undefined } };
    upsert(item, { create: isMap });
    // Карта — обычный объект: не делаем её активной и не вписываем вид автоматически.
    // Активную карту (для тумана) мастер выбирает сам, а двигать/выделять её можно на слое «Карта».
    if (isMap) noticeIfOffscreen(item);
  }
  /// Новая карта за пределами видимой области не должна «теряться»: подсказываем, где она.
  function noticeIfOffscreen(it) {
    const b = T.boundsOf(it);
    if (!b || !(S.w > 0) || !(S.h > 0)) return;
    const tl = toWorld(0, 0), br = toWorld(S.w, S.h);
    const visible = b.x < br.x && b.x + b.w > tl.x && b.y < br.y && b.y + b.h > tl.y;
    if (!visible) toast('Карта добавлена за пределами экрана — она в панели «Сцены» → «Карты сцены», кнопка «Вписать» покажет её');
  }
  // ---------- линейка: привязка к сетке (Ctrl/Cmd — свободно) ----------
  /// Свободный режим линейки: зажат Ctrl/Cmd или привязка выключена кнопкой «#».
  const rulerFree = (ctrl) => !!ctrl || !S.snap;
  function startRuler(raw, e) {
    const points = raw.map(p => p.slice());
    S.temp = { kind: 'ruler', raw: points, points: T.snapRuler(points, S.scene.grid, rulerFree(e?.ctrlKey || e?.metaKey)) };
    S.drag = { kind: 'temp' };
    throttleSend({ type: 'ruler', points: S.temp.points, kind: 'ruler' });
  }
  /// Сырой указатель запоминается отдельно — при отпускании/нажатии Ctrl линия пересчитывается.
  function moveRuler(w, ctrl) {
    if (S.temp?.kind !== 'ruler' || !S.temp.raw) return;
    S.temp.raw[1] = [w.x, w.y];
    S.temp.points = T.snapRuler(S.temp.raw, S.scene.grid, rulerFree(ctrl));
    throttleSend({ type: 'ruler', points: S.temp.points, kind: 'ruler' });
  }
  function refreshRulerSnap(ctrl) {
    if (S.temp?.kind !== 'ruler') return;
    S.temp.points = T.snapRuler(S.temp.raw || S.temp.points, S.scene.grid, rulerFree(ctrl));
    throttleSend({ type: 'ruler', points: S.temp.points, kind: 'ruler' });
  }
  function finishTemp() {
    const t = S.temp; S.temp = null;
    if (t.kind === 'ruler') { S.ws.send({ type: 'ruler', points: null }); return; }
    if (t.kind === 'draw') { if (t.points.length < 2) return; upsert({ layer: LAYER.drawing, z: 0, data: { type: 'drawing', shape: t.shape, points: t.points.map(p => [Math.round(p[0]), Math.round(p[1])]), color: t.color, width: t.width, fill: t.shape !== 'path' && t.shape !== 'line' ? !!S.drawFill : false, owner_id: S.user.id } }); }
    // Мазок тумана: в маску активной карты, с обрезкой по её границам и записью в стек отмены.
    if (t.kind === 'fog') addFogShape(t.shape === 'path' ? 'brush' : t.shape, t.points, t.mode);
  }
  // ---------- Реалтайм: отправка изменений и приём сообщений ----------
  let _lastSend = 0;
  function throttleSend(m) { const n = Date.now(); if (n - _lastSend > 60) { _lastSend = n; S.ws.send(m); } }

  // ---------- синхронизация ----------
  function syncLinkedTokenHp(it) {
    const d = it?.data;
    if (d?.character_id && d.hp) CharacterHp.write(d.character_id, d.hp);
  }

  /// Отправить элемент на сервер и сразу применить локально.
  /// Новый объект с уже известным id виден немедленно (карты: id нужен сразу, чтобы выбрать
  /// карту активной), остальные получают id от сервера и появляются по его рассылке.
  /// opts.create — «создай строку с этим id, если её ещё нет» (см. src/ws/realtime.rs).
  function upsert(it, opts = {}) {
    const idx = it.id ? S.scene.items.findIndex(i => i.id === it.id) : -1;
    if (idx >= 0) S.scene.items[idx] = it;
    else if (it.id) { S.scene.items.push(it); if (opts.create) S.pending.add(it.id); }
    // create — служебное поле протокола; undefined в JSON не попадает вовсе.
    S.ws.send({ type: 'item_upsert', scene_id: S.scene.id, item: { id: it.id, layer: it.layer, z: it.z, data: it.data, create: opts.create || undefined } });
    if (T.isMap(it)) notifySceneChange();
    requestDraw();
  }
  /// Сервер отклонил действие: убираем объекты, которые мы показали, не дождавшись подтверждения.
  function rollbackPending(message) {
    if (!S.pending.size) { toast(message || 'Сервер отклонил действие'); return; }
    const gone = new Set(S.pending);
    S.scene.items = S.scene.items.filter(i => !gone.has(i.id));
    S.pending.clear();
    S.sel = null; S.selSet = new Set();
    updateProps(); notifySceneChange(); requestDraw();
    toast(message || 'Сервер отклонил действие');
  }
  /// Локальные настройки сцены (в т.ч. сетка из панели ГМ) применяются сразу,
  /// не дожидаясь ответа сервера: поэтому sendScene тоже просит кадр.
  function sendScene(patch) { S.ws.send({ type: 'scene_update', scene_id: S.scene.id, ...patch }); requestDraw(); }
  function deleteSel() {
    const items = selectionItems();
    if (!items.length) return;
    for (const it of items) S.ws.send({ type: 'item_delete', scene_id: S.scene.id, id: it.id });
    S.selSet = new Set(); S.sel = null; updateProps(); requestDraw();
  }
  function onMessage(m) {
    if (m.scene_id && m.scene_id !== S.scene.id && m.type !== 'active_scene') return;
    switch (m.type) {
      case 'item_upsert': { S.pending.delete(m.item.id); const idx = S.scene.items.findIndex(i => i.id === m.item.id); if (idx >= 0) { if (!(S.drag?.kind === 'move' && S.drag.items.some(en => en.it.id === m.item.id))) S.scene.items[idx] = m.item; } else S.scene.items.push(m.item); if (S.sel === m.item.id && !isOwnPropsEcho(m.item)) updateProps(); if (T.isMap(m.item)) notifySceneChange(); break; }
      case 'character_update': {
        const c = m.character;
        if (c?.id && c.sheet?.hp) {
          const token = S.scene.items.find(it => it.data?.character_id === c.id);
          if (token && !CharacterHp.same(token.data?.hp, c.sheet.hp)) {
            token.data.hp = CharacterHp.fromSheet(c.sheet.hp);
            upsert(token);
          }
        }
        break;
      }
      // Отказ сервера (права, запись в базу): без этого сообщения действие просто «исчезало».
      case 'error': rollbackPending(m.message); break;
      case 'item_delete': {
        const deleted = S.scene.items.find(i => i.id === m.id);
        S.scene.items = S.scene.items.filter(i => i.id !== m.id);
        S.selSet.delete(m.id);
        if (S.sel === m.id) { S.sel = null; updateProps(); } else if (S.selSet.size) updateProps();
        // Удалили карту — её маска тумана больше не нужна (ключ by_map = id карты).
        if (deleted && T.isMap(deleted) && S.scene.fog?.by_map) delete S.scene.fog.by_map[m.id];
        // Удалили активную карту — активной станет единственная оставшаяся (см. activeMapId).
        if (S.scene.active_map_id === m.id) S.scene.active_map_id = null;
        syncFogPanel();
        notifySceneChange();
        break;
      }
      case 'items_bulk': for (const u of m.items) { const it = S.scene.items.find(i => i.id === u.id); if (it) { Object.assign(it.data, u.data); if (u.z !== undefined) it.z = u.z; if (u.layer) it.layer = u.layer; } } break;
      case 'scene_update':
        if (m.grid) { S.scene.grid = m.grid; syncScale(); }
        // Туман — растровая маска на карту: сервер присылает валидный by_map, применяем как есть.
        if (m.fog) {
          S.scene.fog = T.normalizeFog(m.fog, fogNormalizeOpts(S.scene));
          S.fogVersion++; S.fogBuf = null; // маска сменилась — буферы тумана пересоберутся
          syncFogPanel();
        }
        if (m.name) S.scene.name = m.name;
        // Слои и активная карта — часть сцены: приходят от мастера и применяются у всех.
        if (m.layers !== undefined) S.layers = T.normalize(m.layers);
        if (m.active_map_id !== undefined) { S.scene.active_map_id = m.active_map_id || null; syncFogPanel(); }
        notifySceneChange();
        break;
      case 'ruler': if (m.points) S.remoteRulers[m.user_id] = { kind: 'ruler', points: m.points, name: m.name, user_id: m.user_id }; else delete S.remoteRulers[m.user_id]; break;
      case 'ping': S.pings.push({ x: m.x, y: m.y, t: Date.now(), name: m.name, color: m.color }); break;
    }
    requestDraw();
  }

  // ---------- контекстное меню (ПКМ по элементу) ----------
  // ---------- Контекстное меню и панель свойств ----------
  function contextMenu(it, x, y) {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    // Групповое меню: ПКМ по элементу, который входит в мультивыделение.
    if (S.selSet.size > 1 && S.selSet.has(it.id)) { groupMenu(x, y); return; }
    const d = it.data, editable = canEdit(it);
    const menu = el('div', { class: 'ctxmenu', style: `left:${x}px;top:${y}px` });
    const add = (label, fn, cls = '') => menu.append(el('div', { class: 'ctxitem ' + cls, onclick: () => { menu.remove(); fn(); } }, label));
    menu.append(el('div', { class: 'ctxtitle' }, d.name || d.text || T.resolve(layers(), it.layer).name || 'Элемент'));
    // Карты: активная карта задаёт fitToMap, туман войны и «Открыть всё».
    if (S.isGM && layerOf(it) === LAYER.map) {
      add(activeMapId() === it.id ? '✓ Активная карта' : 'Сделать активной', () => setActiveMap(it.id));
      add('Вписать в экран', () => focusMap(it.id));
    }
    if (d.character_id) add('Лист персонажа', () => S.onOpenSheet(d.character_id));
    if (d.type === 'loot') {
      add('Подобрать', () => pickUpLoot(it));
      add('Осмотреть', () => floatWindow(d.item?.name || 'Предмет', el('div', { style: 'padding:12px' }, Modules.itemCardBody(d.item || {}, {}), el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'small', onclick: () => Modules.sendCard(Modules.toChatCard(d.item, 'item')) }, 'В чат'))), { w: 420, h: 360 }));
    }
    if (d.monster) add('Статблок', () => floatWindow(d.name, el('div', { style: 'padding:12px' }, Compendium.renderData({ category: 'monster', name: d.name, source: 'SRD', data: d.monster })), { w: 480, h: 500 }));
    if (editable && (it.layer === LAYER.character || it.layer === LAYER.mount)) {
      add('− Урон…', () => { const v = +prompt('Урон:', '0') || 0; d.hp = { ...(d.hp || { cur: 0, max: 0 }) }; d.hp.cur -= v; if (d.hp.cur <= 0) d.dead = true; upsert(it); syncLinkedTokenHp(it); });
      add('+ Лечение…', () => { const v = +prompt('Лечение:', '0') || 0; d.hp = { ...(d.hp || { cur: 0, max: 0 }) }; d.hp.cur = Math.min(d.hp.max || v, d.hp.cur + v); if (d.hp.cur > 0) d.dead = false; upsert(it); syncLinkedTokenHp(it); });
      if (d.monster?.abilities) add('Инициатива', () => DiceEngine.submit({ type: 'roll', expr: 'd20' + fmtMod(mod(d.monster.abilities.dex || 10)), label: d.name + ': инициатива', gm_only: !!S.isGM && d.hidden }));
      add(d.dead ? 'Жив' : 'Мёртв', () => { d.dead = !d.dead; upsert(it); });
    }
    if (editable) {
      if (!d.managed_loot) add('Дублировать', () => { const c = JSON.parse(JSON.stringify(it)); delete c.id; c.data.x += grid(); c.data.y += grid(); upsert(c); });
      add('Повернуть на 90°', () => { d.rotation = ((d.rotation || 0) + 90) % 360; upsert(it); });
      add('На передний план', () => { it.z = Math.max(0, ...S.scene.items.filter(i => i.layer === it.layer).map(i => i.z || 0)) + 1; upsert(it); });
      add('На задний план', () => { it.z = Math.min(0, ...S.scene.items.filter(i => i.layer === it.layer).map(i => i.z || 0)) - 1; upsert(it); });
    }
    if (S.isGM) {
      add(d.hidden ? 'Показать игрокам' : 'Скрыть от игроков', () => { d.hidden = !d.hidden; upsert(it); });
      add(d.locked ? 'Открепить' : 'Закрепить', () => { d.locked = !d.locked; upsert(it); });
    }
    if (editable) add('Удалить', () => { S.ws.send({ type: 'item_delete', scene_id: S.scene.id, id: it.id }); S.sel = null; updateProps(); }, 'danger');
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = (x - r.width) + 'px';
    if (r.bottom > innerHeight) menu.style.top = (y - r.height) + 'px';
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  /// Контекстное меню группы: «Убрать со стола», «Скрыть» (мастер), планы.
  function groupMenu(x, y) {
    const items = selectionItems();
    if (!items.length) return;
    const menu = el('div', { class: 'ctxmenu', style: `left:${x}px;top:${y}px` });
    const add = (label, fn, cls = '') => menu.append(el('div', { class: 'ctxitem ' + cls, onclick: () => { menu.remove(); fn(); } }, label));
    menu.append(el('div', { class: 'ctxtitle' }, `Выбрано ${items.length}`));
    add('Убрать со стола', () => deleteSel(), 'danger');
    if (S.isGM) {
      add(items.every(i => i.data.hidden) ? 'Показать игрокам' : 'Скрыть от игроков', () => {
        const hide = !items.every(i => i.data.hidden);
        eachSelected(it => { it.data.hidden = hide; });
      });
    }
    add('На передний план', () => eachSelected(it => { it.z = Math.max(0, ...S.scene.items.filter(i => i.layer === it.layer).map(i => i.z || 0)) + 1; }));
    add('На задний план', () => eachSelected(it => { it.z = Math.min(0, ...S.scene.items.filter(i => i.layer === it.layer).map(i => i.z || 0)) - 1; }));
    add('Снять выделение', () => setSelection([]));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = (x - r.width) + 'px';
    if (r.bottom > innerHeight) menu.style.top = (y - r.height) + 'px';
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  // ---------- хелперы панели свойств ----------

  /// Поле с подписью и входом.
  function field(label, input) {
    return el('div', { class: 'field' }, el('label', {}, label), input);
  }

  /// Визуальный HP-бар с цветом по остатку.
  function hpBar(cur, max) {
    const pct = max > 0 ? Math.round((cur / max) * 100) : 0;
    const color = pct > 66 ? '#4ade80' : pct > 33 ? '#facc15' : '#f87171';
    return el('div', { class: 'hp-wrap' },
      el('div', { class: 'hp-label' },
        el('span', {}, `HP: ${cur} / ${max}`),
        el('span', {}, `${pct}%`)),
      el('div', { class: 'hp-bar' },
        el('div', { class: 'hp-fill', style: `width:${pct}%;background-color:${color}` })));
  }

  /// Кнопка действия в панели.
  function actionBtn(label, onclick, { primary = false, danger = false, cls = '' } = {}) {
    return el('button', {
      class: 'btn ' + (primary ? 'primary' : '') + (danger ? ' danger' : '') + ' ' + cls,
      onclick
    }, label);
  }

  // ---------- панель свойств ----------
  // Панель — одна секция без свёрток. Раньше это был аккордеон («Основное»,
  // «Внешний вид», «Позиция», «HP», «Карта», «ГМ»), а панель перерисовывается на
  // любой ответ сервера: раскрытые секции схлопывались, прокрутка сбрасывалась —
  // «меню атрибутов постоянно закрывается». Теперь блоки всегда видны, а прокрутка
  // и поле в фокусе переживают перерисовку; свой же ответ на правку панель вообще
  // не перерисовывает (см. isOwnPropsEcho).

  /// Блок панели с подзаголовком (без свёртки — ничего не «закрывается»).
  function propsBlock(title, nodes) {
    return el('div', { class: 'props-block' }, title ? el('h4', {}, title) : null, ...nodes);
  }

  /// Липкая шапка панели: что выбрано, слой/вид и «снять выделение».
  function propsHead(title, badge) {
    return el('div', { class: 'props-head' },
      el('b', { class: 'props-title' }, title),
      badge || null,
      el('button', {
        class: 'props-close', title: 'Снять выделение (Esc)', 'aria-label': 'Снять выделение',
        onclick: () => setSelection([]),
      }, '×'));
  }

  /// Состояние панели перед перерисовкой: прокрутка и поле в фокусе (по порядку полей).
  function captureProps() {
    const box = S.propsBox, a = document.activeElement;
    const nodes = box.querySelectorAll('input,select,textarea');
    const idx = a && box.contains(a) ? Array.prototype.indexOf.call(nodes, a) : -1;
    return { scroll: box.scrollTop, idx, start: idx >= 0 ? a.selectionStart : null, end: idx >= 0 ? a.selectionEnd : null };
  }
  /// Вернуть прокрутку и фокус после перерисовки — панель не прыгает и не теряет ввод.
  function restoreProps(st) {
    if (!st) return;
    const box = S.propsBox;
    box.scrollTop = st.scroll || 0;
    if (st.idx < 0) return;
    const node = box.querySelectorAll('input,select,textarea')[st.idx];
    if (!node) return;
    node.focus({ preventScroll: true });
    try { if (st.start != null && node.setSelectionRange) node.setSelectionRange(st.start, st.end); } catch { }
  }

  /// Свой ответ сервера на правку из панели: значения уже показаны — не перерисовываем.
  function isOwnPropsEcho(item) {
    const echo = S.propsEcho;
    return !!echo && echo.id === item.id && echo.data === JSON.stringify(item.data);
  }

  /// Панель свойств группы: «Выбрано N» и общие действия, разрешённые правами.
  function renderGroupProps(items) {
    const box = S.propsBox;
    box.classList.remove('hidden');
    const editable = items.filter(canEdit);
    box.append(propsHead(`Выбрано ${items.length}`, el('span', { class: 'badge' }, 'группа')));
    if (!editable.length) {
      box.append(el('div', { class: 'props-single' },
        el('div', { class: 'muted' }, 'Нет прав на редактирование этих элементов'),
        el('button', { class: 'small danger', style: 'width:100%', onclick: deleteSel }, `Убрать со стола (${items.length})`)));
      S.onSelect && S.onSelect(null);
      return;
    }
    box.append(el('div', { class: 'props-single' },
      el('div', { class: 'chips' }, ...items.map(it => el('span', { class: 'chip' }, it.data.name || it.data.text || 'элемент'))),
      propsBlock('Порядок', [
        el('div', { class: 'actions' },
          actionBtn('На передний план', () => {
            eachSelected(it => {
              it.z = Math.max(0, ...S.scene.items.filter(i => i.layer === it.layer).map(i => i.z || 0)) + 1;
              upsert(it);
            });
          }),
          actionBtn('На задний план', () => {
            eachSelected(it => {
              it.z = Math.min(0, ...S.scene.items.filter(i => i.layer === it.layer).map(i => i.z || 0)) - 1;
              upsert(it);
            });
          })),
      ]),
      propsBlock('Видимость', [
        el('div', { class: 'actions' },
          actionBtn('Скрыть всё', () => eachSelected(it => { it.data.hidden = true; upsert(it); }), { primary: true }),
          actionBtn('Показать всё', () => eachSelected(it => { it.data.hidden = false; upsert(it); }), { primary: true })),
      ]),
      S.isGM ? propsBlock('', [el('div', { class: 'actions' }, actionBtn('Удалить все', deleteSel, { danger: true }))]) : null,
      el('button', { class: 'small danger', style: 'width:100%', onclick: deleteSel }, `Убрать со стола (${editable.length})`)));
    S.onSelect && S.onSelect(null);
  }

  // ---------- панель свойств выбранного элемента ----------
  function updateProps() {
    const box = S.propsBox;
    const view = captureProps();
    box.innerHTML = '';
    // Мультивыделение: панель группы вместо свойств одного элемента.
    const group = selectionItems();
    if (group.length > 1) { renderGroupProps(group); restoreProps(view); return; }
    const it = S.scene.items.find(i => i.id === S.sel);
    S.onSelect && S.onSelect(it);
    if (!it) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const d = it.data, editable = canEdit(it);
    // Запоминаем отправленное состояние: свой ответ сервера не перерисовывает панель.
    const save = () => { S.propsEcho = { id: it.id, data: JSON.stringify(it.data) }; upsert(it); };
    const layerNameOf = T.resolve(layers(), it.layer).name;
    const isMap = layerOf(it) === LAYER.map;
    const isToken = it.layer === LAYER.character || it.layer === LAYER.mount;

    box.append(propsHead(d.name || d.text || layerNameOf || 'Элемент', el('span', { class: 'badge' }, layerNameOf)));
    const card = el('div', { class: 'props-single' });
    box.append(card);

    if (!editable) {
      card.append(propsBlock('', [
        el('div', { class: 'muted' }, 'Нет прав на редактирование этого элемента'),
        el('button', { class: 'small danger', style: 'width:100%', onclick: deleteSel }, 'Удалить (Del)')]));
      restoreProps(view);
      return;
    }

    // ---------- Имя / текст ----------
    const mainFields = [];
    if (d.type === 'image') {
      mainFields.push(field('Имя', el('input', { value: d.name || '', onchange: e => { d.name = e.target.value; save(); } })));
    } else if (d.type === 'text') {
      mainFields.push(field('Текст', el('input', { value: d.text || '', onchange: e => { d.text = e.target.value; save(); } })));
    }
    if (mainFields.length) card.append(propsBlock(isToken ? 'Токен' : 'Основное', mainFields));

    // ---------- Хиты и состояния (первым делом у токенов) ----------
    if (isToken) {
      const hpFields = [];
      const hp = d.hp || { cur: 0, max: 0 };
      hpFields.push(field('Хиты', el('div', { class: 'row', gap: 8 },
        el('input', { type: 'number', value: hp.cur, step: 1, style: 'flex:1', onchange: e => { d.hp = { ...hp, cur: +e.target.value || 0 }; syncLinkedTokenHp(it); save(); } }),
        el('span', { style: 'flex:0;color:var(--muted)' }, '/'),
        el('input', { type: 'number', value: hp.max, step: 1, style: 'flex:1', onchange: e => { d.hp = { ...hp, max: +e.target.value || 0 }; syncLinkedTokenHp(it); save(); } }))));
      hpFields.push(hpBar(hp.cur, hp.max));
      hpFields.push(el('div', { class: 'row', style: 'margin-bottom:0' },
        actionBtn('− Урон', () => {
          const v = +prompt('Урон:', '0') || 0;
          d.hp = { ...(d.hp || { cur: 0, max: 0 }) };
          d.hp.cur -= v;
          syncLinkedTokenHp(it);
          save();
        }, { cls: 'secondary' }),
        actionBtn('+ Лечение', () => {
          const v = +prompt('Лечение:', '0') || 0;
          d.hp = { ...(d.hp || { cur: 0, max: 0 }) };
          d.hp.cur = Math.min(d.hp.max, d.hp.cur + v);
          syncLinkedTokenHp(it);
          save();
        }, { cls: 'secondary' })));
      const conds = d.conditions || [];
      const condPick = el('select', { onchange: e => { if (e.target.value) { d.conditions = [...(d.conditions || []), e.target.value]; save(); } } },
        el('option', { value: '' }, '+ состояние'),
        ...condKeys().map(k => el('option', { value: k }, condIcon(k) + ' ' + condShort(k))));
      hpFields.push(el('div', { style: 'margin-top:6px' },
        el('div', { class: 'muted', style: 'margin-bottom:4px' }, 'Состояния'),
        el('div', { class: 'chips' }, ...conds.map(c => el('span', { class: 'chip' },
          condShort(c),
          el('b', { onclick: () => { d.conditions = (d.conditions || []).filter(x => x !== c); save(); } }, '×')))),
        el('div', { class: 'select-row' }, condPick)));
      hpFields.push(el('div', { class: 'row', style: 'margin-bottom:0' },
        el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.dead ? '' : null, style: 'width:auto', onchange: e => { d.dead = e.target.checked; save(); } }), ' Мёртв'),
        el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.show_hp ? '' : null, style: 'width:auto', onchange: e => { d.show_hp = e.target.checked; save(); } }), ' HP всем')));
      if (d.character_id) {
        hpFields.push(el('button', { class: 'small', style: 'width:100%;margin-bottom:6px', onclick: () => S.onOpenSheet(d.character_id) }, 'Лист персонажа'));
      }
      if (d.monster) {
        hpFields.push(el('button', { class: 'small', style: 'width:100%;margin-bottom:6px', onclick: () => floatWindow(d.name, el('div', { style: 'padding:12px' }, Compendium.renderData({ category: 'monster', name: d.name, source: 'SRD', data: d.monster })), { w: 480, h: 500 }) }, 'Статблок'));
      }
      card.append(propsBlock('Хиты и состояния', hpFields));
    }

    // ---------- Размер и вид ----------
    const lookFields = [];
    if (d.type === 'image') {
      const g = grid();
      const curW = Math.round((d.w / g) * 10) / 10, curH = Math.round((d.h / g) * 10) / 10;
      lookFields.push(el('div', { class: 'transform-grid' },
        field('Ширина (клеток)', el('input', {
          type: 'number', value: curW, step: 0.1, min: 0.1,
          onchange: e => { d.w = g * (+e.target.value || 0.1); save(); },
        })),
        field('Высота (клеток)', el('input', {
          type: 'number', value: curH, step: 0.1, min: 0.1,
          onchange: e => { d.h = g * (+e.target.value || 0.1); save(); },
        }))));
      lookFields.push(el('div', { class: 'row', style: 'margin-bottom:0' },
        el('label', { style: 'flex:1' }, el('input', {
          type: 'checkbox', checked: d.lockAspect ? '' : null, style: 'width:auto',
          onchange: e => { d.lockAspect = e.target.checked; save(); },
        }), ' Сцепить пропорции'),
        actionBtn('В сетку', () => {
          const g2 = grid();
          d.w = Math.round(d.w / g2) * g2 || g2;
          d.h = Math.round(d.h / g2) * g2 || g2;
          save();
        }, { cls: 'secondary' }),
        actionBtn('Квадрат', () => {
          const s = Math.max(d.w, d.h);
          d.w = s; d.h = s;
          save();
        }, { cls: 'secondary' })));
    } else if (d.type === 'text') {
      lookFields.push(field('Размер', el('input', { type: 'number', value: d.size || 28, onchange: e => { d.size = +e.target.value || 28; save(); } })));
      lookFields.push(field('Цвет', el('input', { type: 'color', value: d.color || '#ffffff', onchange: e => { d.color = e.target.value; save(); } })));
    } else if (d.type === 'drawing') {
      lookFields.push(el('div', { class: 'row', style: 'margin-bottom:0' },
        el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.fill ? '' : null, style: 'width:auto', onchange: e => { d.fill = e.target.checked; save(); } }), ' Заливка')));
    }
    if (lookFields.length) card.append(propsBlock('Размер и вид', lookFields));

    // ---------- Позиция и поворот ----------
    card.append(propsBlock('Позиция', [
      el('div', { class: 'transform-grid' },
        field('X', el('input', { type: 'number', value: Math.round(d.x || 0), step: 1, onchange: e => { d.x = +e.target.value || 0; save(); } })),
        field('Y', el('input', { type: 'number', value: Math.round(d.y || 0), step: 1, onchange: e => { d.y = +e.target.value || 0; save(); } })),
        field('Поворот (°)', el('input', { type: 'number', value: Math.round(d.rotation || 0), step: 1, onchange: e => { d.rotation = ((+e.target.value || 0) % 360 + 360) % 360; save(); } })),
        field('Порядок (z)', el('input', { type: 'number', value: it.z || 0, step: 1, onchange: e => { it.z = +e.target.value || 0; save(); } }))),
      el('div', { class: 'row', style: 'margin-bottom:0' },
        actionBtn('Повернуть +90°', () => { d.rotation = ((d.rotation || 0) + 90) % 360; save(); }, { cls: 'secondary' }),
        actionBtn('Выше', () => { it.z = (it.z || 0) + 1; save(); }, { cls: 'secondary' }),
        actionBtn('Ниже', () => { it.z = (it.z || 0) - 1; save(); }, { cls: 'secondary' })),
    ]));

    // ---------- Карта ----------
    if (isMap) {
      const isActive = activeMapId() === it.id;
      card.append(propsBlock('Карта', [
        el('div', { class: 'actions' },
          actionBtn(isActive ? '✓ Активная карта' : 'Сделать активной', () => { setActiveMap(it.id); updateProps(); }, { primary: true }),
          actionBtn('Вписать карту', () => focusMap(it.id), { cls: 'secondary' })),
        el('div', { class: 'muted small', style: 'margin-bottom:0' }, 'По активной карте считаются «Вписать», «Открыть все» и туман войны.'),
      ]));
    }

    // ---------- Мастер ----------
    if (S.isGM) {
      const gmFields = [];
      gmFields.push(field('Слой', el('select', { onchange: e => { it.layer = e.target.value; save(); } },
        ...layers().map(l => el('option', { value: l.id, selected: it.layer === l.id ? '' : null }, l.name)))));
      gmFields.push(el('div', { class: 'row' },
        el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.hidden ? '' : null, style: 'width:auto', onchange: e => { d.hidden = e.target.checked; save(); } }), ' Скрыт'),
        el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.locked ? '' : null, style: 'width:auto', onchange: e => { d.locked = e.target.checked; save(); } }), ' Закреплён')));
      if (isToken) {
        const members = S.campaign.members || [];
        gmFields.push(field('Владелец (игрок)', el('select', { onchange: e => { d.owner_id = e.target.value || undefined; save(); } },
          el('option', { value: '' }, '— мастер —'),
          ...members.map(m => el('option', { value: m.user_id, selected: d.owner_id === m.user_id ? '' : null }, m.name + (m.role === 'gm' ? ' (ГМ)' : ''))))));
      }
      card.append(propsBlock('Мастер', gmFields));
    }

    card.append(el('button', { class: 'small danger', style: 'width:100%', onclick: deleteSel }, 'Удалить (Del)'));
    restoreProps(view);
  }

  // ---------- Публичный API (window.Table) ----------
  /// Выбор слоя для клика/загрузки: неизвестный id фолбэчится на prop (см. table-model.js).
  function setActiveLayer(l) { S.activeLayer = T.resolve(layers(), l).id; }
  function getActiveLayer() { return S.activeLayer; }
  function getLayers() { return layers(); }
  function getScene() { return S.scene; }
  function state() { return S; }
  function getMapItems() { return T.mapItems(S.scene?.items); }
  function dropLootAtCenter(p) { return dropLoot(p, toWorld(S.w / 2, S.h / 2), true); }
  /// Токен в центре экрана (создание NPC/персонажа из меню «Создать»). data: name, hp, asset_id?, character_id?, sizeMul?
  async function placeTokenAtCenter(o = {}) {
    const g = grid(); const w = toWorld(S.w / 2, S.h / 2); const mul = o.sizeMul || 1;
    let asset_id = o.asset_id;
    if (!asset_id) { const toks = await API.get('/api/assets?kind=token'); const a = toks.find(t => o.name && t.name.toLowerCase() === (o.name || '').toLowerCase()) || toks.find(t => t.name === 'NPC') || toks[0]; asset_id = a?.id; }
    const p = snapPos(w.x, w.y, g * mul, g * mul);
    const data = { type: 'image', asset_id, x: p.x, y: p.y, w: g * mul, h: g * mul, name: o.name || 'Токен', hp: { cur: o.hp ?? 10, max: o.hp ?? 10 }, hidden: !!o.hidden, owner_id: o.owner_id || S.user.id };
    if (o.character_id) data.character_id = o.character_id;
    if (o.monster) data.monster = o.monster;
    upsert({ layer: LAYER.character, z: 1, data });
  }
  return {
    init, setScene, onMessage, sendScene, state, getScene,
    LAYER, LAYER_ORDER, LAYER_NAMES,
    // слои сцены
    setActiveLayer, getActiveLayer, getLayers, setLayers,
    // карты: активная задаёт fitToMap, «Открыть всё» и туман войны
    setActiveMap, focusMap, fitToMap, getActiveMapId: activeMapId, getActiveMap: activeMap, getMapItems,
    // туман войны: маска на карту, инструменты и отмена (см. docs/table.md)
    getFog: () => S.scene?.fog || null,
    getFogMask: (mapId) => T.maskOf(S.scene?.fog, mapId || activeMapId()),
    getFogState: () => ({ tool: S.fogTool, mode: S.fogMode, cells: S.fogCells, enabled: T.fogEnabled(S.scene?.fog) }),
    selectFogTool, setFogMode, setFogCells, setFogPlayers,
    openAllFog, hideAllFog, undoFog,
    // размер canvas по контейнеру: панель/окно меняют вёрстку — буфер пересчитывается без сброса камеры
    refreshSize: resize,
    // производительность сетки: перерисовать кадр и счётчики для отладки/тестов
    requestDraw, gridStats: gridStatsSnapshot, resetGridStats,
    dropLootAtCenter, placeTokenAtCenter,
  };
})();
