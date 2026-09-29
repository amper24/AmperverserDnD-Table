// Виртуальный стол в духе Owlbear Rodeo: сцены, слои, токены, туман, линейка, рисование, реалтайм.
window.Table = (function () {
  const LAYER_ORDER = ['map', 'prop', 'mount', 'character', 'attachment', 'drawing', 'text', 'note'];
  const COLORS = ['#ffffff', '#e5484d', '#f5a524', '#f7d038', '#46a758', '#3e9bff', '#7c5cff', '#000000'];

  let S; // состояние стола

  function init(ctx) {
    // ctx: {campaign, user, isGM, scene, ws, onSelect, container}
    S = {
      ...ctx, cam: { x: 0, y: 0, k: 1 }, tool: 'select', sel: null, drag: null, hover: null,
      drawColor: '#e5484d', drawWidth: 6, drawShape: 'path', fogMode: 'reveal', fogShape: 'rect',
      temp: null, remoteRulers: {}, pings: [], cursors: {}, snap: true, activeLayer: 'character', gridScaleFt: 5,
    };
    const wrap = ctx.container;
    wrap.innerHTML = '';
    S.canvas = el('canvas', { id: 'canvas' });
    wrap.append(S.canvas);
    S.ctx2d = S.canvas.getContext('2d');
    S.fogCanvas = document.createElement('canvas');
    buildTools(wrap);
    S.propsBox = el('div', { class: 'props hidden' });
    wrap.append(S.propsBox);
    S.hint = el('div', { class: 'hint' }, 'ЛКМ — выбрать/тащить, колесо — зум, ПКМ/пробел — панорама');
    wrap.append(S.hint);
    bindEvents();
    syncScale();
    resize();
    window.addEventListener('resize', resize);
    fitToMap();
    requestAnimationFrame(loop);
  }

  function setScene(scene) {
    S.scene = scene; S.sel = null; S.temp = null; syncScale(); updateProps(); fitToMap();
  }
  function syncScale() { S.gridScaleFt = parseInt(S.scene.grid?.scale) || 5; }

  // ---------- геометрия ----------
  function resize() {
    const r = S.canvas.parentElement.getBoundingClientRect();
    S.canvas.width = r.width * devicePixelRatio; S.canvas.height = r.height * devicePixelRatio;
    S.w = r.width; S.h = r.height;
  }
  const toWorld = (sx, sy) => ({ x: (sx - S.cam.x) / S.cam.k, y: (sy - S.cam.y) / S.cam.k });
  const toScreen = (wx, wy) => ({ x: wx * S.cam.k + S.cam.x, y: wy * S.cam.k + S.cam.y });
  const grid = () => S.scene.grid?.size || 70;
  // --- гекс-сетка (pointy-top): size = ширина гекса ---
  function hexMetrics() { const w = grid(); const r = w / Math.sqrt(3); return { w, r, hstep: w, vstep: r * 1.5 }; }
  function hexCenter(q, rr) { const { w, r } = hexMetrics(); return { x: w * (q + rr / 2), y: r * 1.5 * rr }; }
  function hexAt(x, y) {
    const { w, r } = hexMetrics();
    const qf = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / r, rf = (2 / 3 * y) / r;
    // округление кубических координат
    let rx = Math.round(qf), rz = Math.round(rf), ry = Math.round(-qf - rf);
    const dx = Math.abs(rx - qf), dz = Math.abs(rz - rf), dy = Math.abs(ry + qf + rf);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dz > dx && dz > dy) rz = -rx - ry;
    void w; return { q: rx, r: rz };
  }
  function isHex() { return (S.scene.grid?.type || 'square') === 'hex'; }
  function snapPos(x, y, w, h) {
    if (!S.snap) return { x, y };
    if (isHex()) { const c = hexAt(x, y); return hexCenter(c.q, c.r); }
    const g = grid();
    // токены меньше клетки — по центру клетки, иначе к углам
    if (w <= g * 1.01 && h <= g * 1.01) return { x: Math.round((x - g / 2) / g) * g + g / 2 - w / 2 + w / 2, y: Math.round((y - g / 2) / g) * g + g / 2 };
    return { x: Math.round(x / g) * g, y: Math.round(y / g) * g };
  }
  function fitToMap() {
    const m = S.scene.items.find(i => i.layer === 'map');
    const W = m ? m.data.w : grid() * 20, H = m ? m.data.h : grid() * 20;
    const k = Math.min(S.w / (W + 100), S.h / (H + 100), 1.5);
    S.cam.k = k; S.cam.x = (S.w - W * k) / 2 - (m ? m.data.x * k : 0); S.cam.y = (S.h - H * k) / 2 - (m ? m.data.y * k : 0);
  }
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
      if (it.layer === 'map' && !S.isGM) continue;
      const b = itemBounds(it);
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
        if (it.layer === 'map' && S.activeLayer !== 'map') continue; // карту трогаем только на слое карты
        return it;
      }
    }
    return null;
  }
  function visibleItems() {
    return S.scene.items.filter(i => S.isGM || !i.data.hidden).sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || a.z - b.z);
  }
  function canEdit(it) { return S.isGM || it.data.owner_id === S.user.id || (it.data.editors || []).includes(S.user.id) || !!it.data.loot; }

  // ---------- рендер ----------
  function loop() { draw(); requestAnimationFrame(loop); }
  function draw() {
    const c = S.ctx2d; c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    c.clearRect(0, 0, S.w, S.h);
    c.save(); c.translate(S.cam.x, S.cam.y); c.scale(S.cam.k, S.cam.k);
    const items = visibleItems();
    let gridDrawn = false;
    for (const it of items) {
      drawItem(c, it);
      if (it.layer === 'map' && !gridDrawn) { drawGrid(c); gridDrawn = true; }
    }
    if (!gridDrawn) drawGrid(c);
    drawFog(c);
    // временные фигуры
    if (S.temp) drawTemp(c, S.temp, S.user.id);
    for (const r of Object.values(S.remoteRulers)) drawTemp(c, r, r.user_id);
    // выделение
    if (S.sel) { const it = S.scene.items.find(i => i.id === S.sel); if (it) { const b = itemBounds(it); c.strokeStyle = '#7c5cff'; c.lineWidth = 2 / S.cam.k; c.setLineDash([6 / S.cam.k, 4 / S.cam.k]); c.strokeRect(b.x, b.y, b.w, b.h); c.setLineDash([]); } }
    // пинги
    const now = Date.now();
    S.pings = S.pings.filter(p => now - p.t < 2000);
    for (const p of S.pings) { const a = 1 - (now - p.t) / 2000; c.beginPath(); c.arc(p.x, p.y, (1 - a) * 60 / S.cam.k + 10, 0, 7); c.strokeStyle = `rgba(255,200,60,${a})`; c.lineWidth = 4 / S.cam.k; c.stroke(); c.fillStyle = `rgba(255,200,60,${a})`; c.font = `${14 / S.cam.k}px sans-serif`; c.fillText(p.name, p.x + 14 / S.cam.k, p.y - 14 / S.cam.k); }
    c.restore();
  }
  function drawGrid(c) {
    const g = S.scene.grid; if (!g?.visible) return;
    const size = g.size || 70;
    const tl = toWorld(0, 0), br = toWorld(S.w, S.h);
    c.strokeStyle = g.color || '#00000055'; c.lineWidth = 1 / S.cam.k; c.beginPath();
    if ((br.x - tl.x) / size > 400) return;
    if (isHex()) {
      const { w, r } = hexMetrics();
      const r0 = Math.floor(tl.y / (r * 1.5)) - 1, r1 = Math.ceil(br.y / (r * 1.5)) + 1;
      for (let rr = r0; rr <= r1; rr++) {
        const q0 = Math.floor(tl.x / w - rr / 2) - 1, q1 = Math.ceil(br.x / w - rr / 2) + 1;
        for (let q = q0; q <= q1; q++) {
          const hc = hexCenter(q, rr);
          for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); const px = hc.x + r * Math.cos(a), py = hc.y + r * Math.sin(a); if (i === 0) c.moveTo(px, py); else c.lineTo(px, py); }
          c.closePath();
        }
      }
      c.stroke();
      return;
    }
    const x0 = Math.floor(tl.x / size) * size, y0 = Math.floor(tl.y / size) * size;
    for (let x = x0; x <= br.x; x += size) { c.moveTo(x, tl.y); c.lineTo(x, br.y); }
    for (let y = y0; y <= br.y; y += size) { c.moveTo(tl.x, y); c.lineTo(br.x, y); }
    c.stroke();
  }
  function drawItem(c, it) {
    const d = it.data;
    c.save();
    if (d.hidden) c.globalAlpha = 0.45;
    if (d.type === 'image') {
      const img = assetImage(d.asset_id);
      c.translate(d.x, d.y); c.rotate((d.rotation || 0) * Math.PI / 180);
      if (img.complete && img.naturalWidth) c.drawImage(img, -d.w / 2, -d.h / 2, d.w, d.h);
      else { c.fillStyle = '#333'; c.fillRect(-d.w / 2, -d.h / 2, d.w, d.h); }
      c.rotate(-(d.rotation || 0) * Math.PI / 180);
      if (it.layer === 'character' || it.layer === 'mount') {
        // рамка владельца, имя, хиты, состояния
        if (d.owner_id) { c.strokeStyle = d.owner_id === S.user.id ? '#46a758' : '#3e9bff'; c.lineWidth = 3 / S.cam.k; c.beginPath(); c.arc(0, 0, Math.min(d.w, d.h) / 2, 0, 7); c.stroke(); }
        if (d.name && (d.show_name !== false)) { c.font = `bold ${Math.max(12 / S.cam.k, d.h * 0.16)}px sans-serif`; c.textAlign = 'center'; c.lineWidth = 4 / S.cam.k; c.strokeStyle = '#000c'; c.fillStyle = '#fff'; c.strokeText(d.name, 0, d.h / 2 + d.h * 0.18); c.fillText(d.name, 0, d.h / 2 + d.h * 0.18); }
        if (d.hp && d.hp.max && (S.isGM || d.owner_id === S.user.id || d.show_hp)) {
          const bw = d.w * 0.9, bh = Math.max(4 / S.cam.k, d.h * 0.07), y = -d.h / 2 - bh - 2;
          c.fillStyle = '#000a'; c.fillRect(-bw / 2, y, bw, bh);
          const p = Math.max(0, Math.min(1, d.hp.cur / d.hp.max));
          c.fillStyle = p > 0.5 ? '#46a758' : p > 0.25 ? '#f5a524' : '#e5484d'; c.fillRect(-bw / 2, y, bw * p, bh);
        }
        if (d.conditions?.length) { c.font = `bold ${d.h * 0.14}px sans-serif`; c.textAlign = 'left'; c.fillStyle = '#ffd77a'; c.fillText(d.conditions.map(x => CONDICON[x] || '?').join(' '), -d.w / 2, -d.h / 2 + d.h * 0.18); }
        if (d.dead) { c.strokeStyle = '#e5484d'; c.lineWidth = d.w * 0.08; c.beginPath(); c.moveTo(-d.w / 2.5, -d.h / 2.5); c.lineTo(d.w / 2.5, d.h / 2.5); c.moveTo(d.w / 2.5, -d.h / 2.5); c.lineTo(-d.w / 2.5, d.h / 2.5); c.stroke(); }
      }
    } else if (d.type === 'loot') {
      // мешочек с лутом: иконка предмета на подложке
      c.translate(d.x, d.y);
      const r = Math.min(d.w, d.h) / 2;
      c.beginPath(); c.roundRect(-r, -r, 2 * r, 2 * r, r * 0.3); c.fillStyle = '#2b2416ee'; c.fill(); c.strokeStyle = d.item?.rarity && d.item.rarity !== 'Обычный' ? (Modules.RARITY_COLORS[d.item.rarity] || '#f5a524') : '#f5a524'; c.lineWidth = 3 / S.cam.k; c.stroke();
      const li = d.item?.token_asset_id || d.item?.asset_id ? assetImage(d.item.token_asset_id || d.item.asset_id) : null;
      if (li && li.complete && li.naturalWidth) { c.save(); c.beginPath(); c.roundRect(-r * 0.85, -r * 0.85, 1.7 * r, 1.7 * r, r * 0.25); c.clip(); c.drawImage(li, -r * 0.85, -r * 0.85, 1.7 * r, 1.7 * r); c.restore(); }
      else { c.font = `${r * 1.1}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(d.item?.icon ? String(d.item.icon).slice(0, 2) : { weapon: 'W', armor: 'A', consumable: 'C', magic: 'M', treasure: '$', tool: 'T', ammo: 'A' }[d.item?.type] || 'L', 0, r * 0.05); }
      const label = (d.item?.name || 'Предмет') + (d.item?.qty > 1 ? ' ×' + d.item.qty : '');
      c.font = `bold ${Math.max(11 / S.cam.k, r * 0.3)}px sans-serif`; c.textBaseline = 'alphabetic'; c.lineWidth = 4 / S.cam.k; c.strokeStyle = '#000c'; c.fillStyle = '#ffd77a'; c.strokeText(label, 0, r + r * 0.4); c.fillText(label, 0, r + r * 0.4);
    } else if (d.type === 'drawing') {
      drawShape(c, d);
    } else if (d.type === 'text') {
      c.font = `bold ${d.size || 24}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = d.color || '#fff'; c.strokeStyle = '#000a'; c.lineWidth = 3; c.strokeText(d.text, d.x, d.y); c.fillText(d.text, d.x, d.y);
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
      const [a, b] = t.points; const g = grid();
      let cells;
      if (isHex()) { const ha = hexAt(a[0], a[1]), hb = hexAt(b[0], b[1]); cells = Math.max(Math.abs(ha.q - hb.q), Math.abs(ha.r - hb.r), Math.abs((-ha.q - ha.r) - (-hb.q - hb.r))); }
      else { const dx = Math.abs(b[0] - a[0]) / g, dy = Math.abs(b[1] - a[1]) / g; cells = Math.max(dx, dy); }
      const ft = Math.round(cells * S.gridScaleFt);
      c.strokeStyle = '#ffd54f'; c.lineWidth = 3 / S.cam.k; c.setLineDash([8 / S.cam.k, 6 / S.cam.k]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
      c.font = `bold ${16 / S.cam.k}px sans-serif`; c.fillStyle = '#ffd54f'; c.strokeStyle = '#000'; c.lineWidth = 4 / S.cam.k; c.textAlign = 'center';
      const label = `${ft} фт (${Math.round(cells * 10) / 10} кл.)` + (t.name ? ' — ' + t.name : '');
      c.strokeText(label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12 / S.cam.k); c.fillText(label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12 / S.cam.k);
    } else if (t.kind === 'draw' || t.kind === 'fog') {
      drawShape(c, { ...t, color: t.kind === 'fog' ? (t.mode === 'reveal' ? '#46a758' : '#e5484d') : t.color, fill: true });
    }
  }
  function drawFog(c) {
    const f = S.scene.fog; if (!f?.enabled) return;
    const fc = S.fogCanvas; fc.width = S.canvas.width; fc.height = S.canvas.height;
    const x = fc.getContext('2d'); x.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    x.fillStyle = S.isGM ? 'rgba(0,0,0,0.55)' : '#0b0b0e'; x.fillRect(0, 0, S.w, S.h);
    x.translate(S.cam.x, S.cam.y); x.scale(S.cam.k, S.cam.k);
    for (const sh of f.shapes || []) {
      x.globalCompositeOperation = sh.mode === 'reveal' ? 'destination-out' : 'source-over';
      x.fillStyle = S.isGM ? 'rgba(0,0,0,0.55)' : '#0b0b0e';
      x.beginPath();
      const p = sh.points;
      if (sh.shape === 'rect') x.rect(Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.abs(p[1][0] - p[0][0]), Math.abs(p[1][1] - p[0][1]));
      else if (sh.shape === 'circle') x.arc(p[0][0], p[0][1], Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), 0, 7);
      else { x.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) x.lineTo(q[0], q[1]); x.closePath(); }
      x.fill();
    }
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(fc, 0, 0); c.restore();
    c.translate(0, 0);
  }
  const CONDICON = { blinded: 'ОС', charmed: 'ОЧ', deafened: 'ГЛ', frightened: 'ИС', grappled: 'СХ', incapacitated: 'НД', invisible: 'НВ', paralyzed: 'ПР', petrified: 'ОК', poisoned: 'ОТ', prone: 'СБ', restrained: 'ОП', stunned: 'ОШ', unconscious: 'БС', exhaustion: 'ИТ', concentration: 'КЦ' };

  // ---------- инструменты ----------
  function buildTools(wrap) {
    const tools = [['select', icon('select'), 'Выбор (V)'], ['pan', icon('hand'), 'Панорама (H)'], ['ruler', icon('ruler'), 'Линейка (R)'], ['draw', icon('pen'), 'Рисование (D)'], ['text', icon('text'), 'Текст'], ['pointer', icon('pin'), 'Указка (P)']];
    if (S.isGM) tools.push(['fog', icon('fog'), 'Туман войны (F)']);
    S.toolbox = el('div', { class: 'tools' });
    for (const [id, ico, title] of tools) S.toolbox.append(el('button', { class: 'icon', 'data-tool': id, title, onclick: () => setTool(id) }, ico));
    S.subbox = el('div', { class: 'sub' });
    S.toolbox.append(S.subbox);
    wrap.append(S.toolbox);
    const zoom = el('div', { class: 'zoom' },
      el('button', { class: 'icon', onclick: () => zoomBy(1.25) }, '+'), el('button', { class: 'icon', onclick: () => zoomBy(0.8) }, '−'),
      el('button', { class: 'icon', title: 'Вписать карту', onclick: fitToMap }, icon('fit')),
      el('button', { class: 'icon', title: 'Привязка к сетке', id: 'snapBtn', onclick: (e) => { S.snap = !S.snap; e.currentTarget.classList.toggle('active', S.snap); } }, '#'));
    zoom.querySelector('#snapBtn').classList.add('active');
    wrap.append(zoom);
    setTool('select');
  }
  function setTool(t) {
    S.tool = t; S.temp = null;
    S.toolbox.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    S.canvas.className = 'tool-' + t;
    S.subbox.innerHTML = '';
    const hints = { select: 'ЛКМ — выбрать/тащить, двойной клик по токену — лист, Delete — удалить', pan: 'Тяните для панорамирования', ruler: 'Тяните для измерения (видят все)', draw: 'Рисуйте на карте', text: 'Клик — добавить текст', pointer: 'Клик — пинг для всех', fog: 'Зелёный — открыть, красный — скрыть. Shift — переключить режим' };
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
      const col = el('div', { style: 'display:flex;flex-direction:column;gap:3px' });
      const mrow = el('div', { style: 'display:flex;gap:3px' },
        el('button', { class: 'small' + (S.fogMode === 'reveal' ? ' active' : ''), onclick: (e) => { S.fogMode = 'reveal'; mrow.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); } }, 'Открыть'),
        el('button', { class: 'small' + (S.fogMode === 'hide' ? ' active' : ''), onclick: (e) => { S.fogMode = 'hide'; mrow.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); } }, 'Скрыть'));
      const srow = el('div', { style: 'display:flex;gap:3px' }, ...[['rect', icon('rect')], ['circle', icon('circle')], ['poly', icon('poly')]].map(([s, i]) => el('button', { class: 'icon small' + (S.fogShape === s ? ' active' : ''), style: 'width:30px;height:30px', onclick: (e) => { S.fogShape = s; srow.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); } }, i)));
      const en = el('button', { class: 'small' + (S.scene.fog?.enabled ? ' active' : ''), onclick: (e) => { S.scene.fog = { ...(S.scene.fog || { shapes: [] }), enabled: !S.scene.fog?.enabled }; e.currentTarget.classList.toggle('active', S.scene.fog.enabled); sendScene({ fog: S.scene.fog }); } }, 'Туман вкл/выкл');
      const clr = el('button', { class: 'small', onclick: () => { S.scene.fog = { ...S.scene.fog, shapes: [] }; sendScene({ fog: S.scene.fog }); } }, 'Скрыть всё');
      const all = el('button', { class: 'small', onclick: () => { const m = S.scene.items.find(i => i.layer === 'map'); const b = m ? itemBounds(m) : { x: -5000, y: -5000, w: 10000, h: 10000 }; S.scene.fog = { ...S.scene.fog, shapes: [{ shape: 'rect', mode: 'reveal', points: [[b.x, b.y], [b.x + b.w, b.y + b.h]] }] }; sendScene({ fog: S.scene.fog }); } }, 'Открыть всё');
      col.append(mrow, srow, en, el('div', { style: 'display:flex;gap:3px' }, clr, all)); S.subbox.append(col);
    }
  }
  function zoomBy(f, cx = S.w / 2, cy = S.h / 2) {
    const k2 = Math.min(6, Math.max(0.08, S.cam.k * f));
    S.cam.x = cx - (cx - S.cam.x) * (k2 / S.cam.k); S.cam.y = cy - (cy - S.cam.y) * (k2 / S.cam.k); S.cam.k = k2;
  }

  // ---------- события ----------
  function bindEvents() {
    const cv = S.canvas;
    let space = false;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9, e.offsetX, e.offsetY); }, { passive: false });
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      const w = toWorld(e.offsetX, e.offsetY);
      if (e.button === 2 && !space) {
        const it = hitTest(w.x, w.y);
        if (it) { S.sel = it.id; updateProps(); contextMenu(it, e.clientX, e.clientY); return; }
      }
      if (e.button === 1 || e.button === 2 || space || S.tool === 'pan') { S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: S.cam.x, cy: S.cam.y }; return; }
      if (S.tool === 'select') {
        const it = hitTest(w.x, w.y);
        if (it && canEdit(it) && !it.data.locked) { S.sel = it.id; S.drag = { kind: 'move', it, ox: w.x - it.data.x, oy: w.y - it.data.y, sx: it.data.x, sy: it.data.y }; }
        else if (it) { S.sel = it.id; S.drag = null; }
        else { S.sel = null; S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: S.cam.x, cy: S.cam.y }; }
        updateProps();
      } else if (S.tool === 'ruler') {
        S.temp = { kind: 'ruler', points: [[w.x, w.y], [w.x, w.y]] }; S.drag = { kind: 'temp' };
      } else if (S.tool === 'draw') {
        if (S.drawShape === 'poly') {
          if (!S.temp) S.temp = { kind: 'draw', shape: 'poly', points: [[w.x, w.y], [w.x, w.y]], color: S.drawColor, width: S.drawWidth };
          else { S.temp.points.splice(-1, 0, [w.x, w.y]); }
          return;
        }
        S.temp = { kind: 'draw', shape: S.drawShape, points: [[w.x, w.y], [w.x, w.y]], color: S.drawColor, width: S.drawWidth }; S.drag = { kind: 'temp' };
      } else if (S.tool === 'fog') {
        const mode = e.shiftKey ? (S.fogMode === 'reveal' ? 'hide' : 'reveal') : S.fogMode;
        if (S.fogShape === 'poly') {
          if (!S.temp) S.temp = { kind: 'fog', shape: 'poly', mode, points: [[w.x, w.y], [w.x, w.y]], width: 2 };
          else S.temp.points.splice(-1, 0, [w.x, w.y]);
          return;
        }
        S.temp = { kind: 'fog', shape: S.fogShape, mode, points: [[w.x, w.y], [w.x, w.y]], width: 2 }; S.drag = { kind: 'temp' };
      } else if (S.tool === 'pointer') {
        S.pings.push({ x: w.x, y: w.y, t: Date.now(), name: S.user.name }); S.ws.send({ type: 'ping', x: w.x, y: w.y });
      } else if (S.tool === 'text') {
        prompt2('Текст надписи').then(t => { if (t) upsert({ layer: 'text', z: 0, data: { type: 'text', text: t, x: w.x, y: w.y, size: 28, color: '#ffffff', owner_id: S.user.id } }); });
      }
    });
    cv.addEventListener('pointermove', e => {
      const w = toWorld(e.offsetX, e.offsetY);
      if (S.temp && (S.temp.shape === 'poly')) { S.temp.points[S.temp.points.length - 1] = [w.x, w.y]; return; }
      if (!S.drag) return;
      if (S.drag.kind === 'pan') { S.cam.x = S.drag.cx + e.clientX - S.drag.sx; S.cam.y = S.drag.cy + e.clientY - S.drag.sy; }
      else if (S.drag.kind === 'move') { const d = S.drag.it.data; d.x = w.x - S.drag.ox; d.y = w.y - S.drag.oy; S.drag.moved = true; }
      else if (S.drag.kind === 'temp' && S.temp) {
        if (S.temp.shape === 'path') S.temp.points.push([w.x, w.y]); else S.temp.points[1] = [w.x, w.y];
        if (S.temp.kind === 'ruler') throttleSend({ type: 'ruler', points: S.temp.points, kind: 'ruler' });
      }
    });
    cv.addEventListener('pointerup', e => {
      if (S.drag?.kind === 'move' && S.drag.moved) {
        const it = S.drag.it, d = it.data;
        if (d.type === 'image' && it.layer !== 'map' && it.layer !== 'drawing') { const p = snapPos(d.x, d.y, d.w, d.h); d.x = p.x; d.y = p.y; }
        upsert(it);
      }
      if (S.drag?.kind === 'temp' && S.temp) finishTemp();
      S.drag = null;
    });
    cv.addEventListener('dblclick', e => {
      const w = toWorld(e.offsetX, e.offsetY);
      if (S.temp?.shape === 'poly') { S.temp.points.pop(); finishTemp(); return; }
      const it = hitTest(w.x, w.y);
      if (it?.data.character_id) S.onOpenSheet(it.data.character_id);
    });
    window.addEventListener('keydown', e => {
      if (e.target.matches('input,textarea,select') || e.target.isContentEditable) return;
      if (e.code === 'Space') { space = true; cv.style.cursor = 'grab'; }
      if (e.key === 'Escape') { S.temp = null; S.sel = null; updateProps(); }
      if (e.key === 'Enter' && S.temp?.shape === 'poly') { S.temp.points.pop(); finishTemp(); }
      const map = { v: 'select', h: 'pan', r: 'ruler', d: 'draw', p: 'pointer', f: 'fog' };
      if (map[e.key.toLowerCase()] && !e.ctrlKey) { if (map[e.key.toLowerCase()] !== 'fog' || S.isGM) setTool(map[e.key.toLowerCase()]); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { deleteSel(); }
      if (S.sel && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const it = S.scene.items.find(i => i.id === S.sel); if (!it || !canEdit(it)) return; e.preventDefault();
        const g = grid(); const dx = { ArrowLeft: -g, ArrowRight: g }[e.key] || 0, dy = { ArrowUp: -g, ArrowDown: g }[e.key] || 0;
        it.data.x += dx; it.data.y += dy; upsert(it);
      }
      if (e.ctrlKey && e.key === 'c' && S.sel) { const it = S.scene.items.find(i => i.id === S.sel); if (it) S.clip = JSON.parse(JSON.stringify(it)); }
      if (e.ctrlKey && e.key === 'v' && S.clip) { const it = JSON.parse(JSON.stringify(S.clip)); delete it.id; it.data.x += grid(); it.data.y += grid(); upsert(it); }
    });
    window.addEventListener('keyup', e => { if (e.code === 'Space') { space = false; cv.style.cursor = ''; } });

    // drag&drop из панелей (ассеты, персонажи, монстры) и файлов
    cv.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    cv.addEventListener('drop', async e => {
      e.preventDefault();
      const w = toWorld(e.offsetX, e.offsetY); const g = grid();
      const asset = e.dataTransfer.getData('application/x-asset');
      const chr = e.dataTransfer.getData('application/x-character');
      const comp = e.dataTransfer.getData('application/x-compendium');
      const lootRaw = e.dataTransfer.getData('application/x-item');
      if (asset) { placeAsset(JSON.parse(asset), w); return; }
      if (lootRaw) { try { await dropLoot(JSON.parse(lootRaw), w); } catch (err) { toast('Ошибка: ' + err.message); } return; }
      const spellRaw = e.dataTransfer.getData('application/x-spell');
      if (spellRaw) {
        const sp = JSON.parse(spellRaw);
        const src = sp.spell || sp;
        if (!src.token_asset_id && !src.asset_id) { toast('У заклинания нет токена эффекта — задайте его в редакторе заклинания'); return; }
        const cells = Math.max(1, +src.effect_size || 1), sz = g * cells;
        const p = snapPos(w.x, w.y, sz, sz);
        upsert({ layer: 'prop', z: 2, data: { type: 'image', asset_id: src.token_asset_id || src.asset_id, x: p.x, y: p.y, w: sz, h: sz, name: src.name, effect: true, owner_id: S.user.id } });
        return;
      }
      if (chr) {
        const c = JSON.parse(chr);
        const data = { type: 'image', asset_id: c.sheet?.token_asset_id || c.portrait_asset_id, x: w.x, y: w.y, w: g, h: g, name: c.name, character_id: c.id, owner_id: c.owner_id, hp: { cur: c.sheet?.hp?.current ?? 10, max: c.sheet?.hp?.max ?? 10 } };
        if (!data.asset_id) { const a = (await API.get('/api/assets?kind=token')).find(x => x.name === 'NPC') || (await API.get('/api/assets?kind=token'))[0]; data.asset_id = a.id; }
        const p = snapPos(w.x, w.y, g, g); data.x = p.x; data.y = p.y;
        upsert({ layer: 'character', z: 0, data }); return;
      }
      if (comp) {
        const c = JSON.parse(comp);
        if ((c.category === 'monster' || c.category === 'npc') && S.isGM) {
          const toks = await API.get('/api/assets?kind=token');
          const a = (c.data.token_asset_id ? { id: c.data.token_asset_id } : null) || toks.find(t => c.name.toLowerCase().includes(t.name.toLowerCase())) || toks.find(t => t.name === 'NPC') || toks[0];
          const sizeMul = { 'Крошечный': 0.5, 'Маленький': 1, 'Средний': 1, 'Большой': 2, 'Огромный': 3, 'Громадный': 4 }[c.data.size] || 1;
          const hp = parseInt(c.data.hp) || (c.category === 'npc' ? 4 : 10);
          const p = snapPos(w.x, w.y, g * sizeMul, g * sizeMul);
          upsert({ layer: 'character', z: 1, data: { type: 'image', asset_id: a.id, x: p.x, y: p.y, w: g * sizeMul, h: g * sizeMul, name: c.name, hp: { cur: hp, max: hp }, monster: c.data.abilities || c.data.hp || c.category === 'monster' ? c.data : null, npc: c.category === 'npc' ? { desc: c.data.desc, role: c.data.role, faction: c.data.faction, attitude: c.data.attitude, hooks: c.data.hooks } : undefined, hidden: false, owner_id: S.user.id } });
        } else toast('На стол можно бросать монстров и NPC');
        return;
      }
      if (e.dataTransfer.files?.length) {
        for (const f of e.dataTransfer.files) {
          if (!f.type.startsWith('image/')) continue;
          const fd = new FormData(); fd.append('file', f); fd.append('name', f.name.replace(/\.[^.]+$/, '')); fd.append('kind', S.activeLayer === 'map' ? 'map' : 'token'); fd.append('campaign_id', S.campaign.id);
          toast('Загрузка ' + f.name + '…');
          const a = await API.upload('/api/assets', fd); placeAsset(a, w); S.onAssetsChanged && S.onAssetsChanged();
        }
      }
    });
  }
  // Предмет, брошенный на стол: создаём «лут»-токен; если он пришёл с листа персонажа — убираем его оттуда
  async function dropLoot(p, w, silent) {
    const g = grid(); const pos = snapPos(w.x, w.y, g * 0.7, g * 0.7);
    const item = { ...p.item };
    if (p.from_character_id) {
      const ch = await API.get('/api/characters/' + p.from_character_id);
      const inv = ch.sheet.inventory || [];
      if (!inv.some(i => i.uid === item.uid)) { if (!silent) return toast('Предмета уже нет в инвентаре'); }
      else { ch.sheet.inventory = inv.filter(i => i.uid !== item.uid); await API.patch('/api/characters/' + p.from_character_id, { sheet: ch.sheet }); }
    }
    upsert({ layer: 'prop', z: 5, data: { type: 'loot', loot: true, item, x: pos.x, y: pos.y, w: g * 0.7, h: g * 0.7, name: item.name, owner_id: S.user.id, dropped_by: p.from_character_id || null } });
    if (!silent) toast(`${item.name} на столе`);
  }
  async function pickUpLoot(it) {
    const all = await API.get('/api/characters?campaign_id=' + S.campaign.id);
    const mine = S.isGM ? all : all.filter(c => c.owner_id === S.user.id);
    if (!mine.length) return toast('У вас нет персонажа в кампании');
    let target = mine[0];
    if (mine.length > 1) { const sel = el('select', {}, ...mine.map(c => el('option', { value: c.id }, c.name))); const ok = await modal(`Кто подбирает «${it.data.item?.name}»?`, el('div', { class: 'field' }, sel), [{ label: 'Подобрать', cls: 'primary', fn: () => sel.value }]); if (!ok) return; target = mine.find(c => c.id === ok); }
    const ch = await API.get('/api/characters/' + target.id);
    const item = { ...it.data.item, uid: Modules.uid(), equipped: false };
    ch.sheet.inventory = [...(ch.sheet.inventory || []), item];
    await API.patch('/api/characters/' + target.id, { sheet: ch.sheet });
    S.ws.send({ type: 'item_delete', scene_id: S.scene.id, id: it.id }); if (S.sel === it.id) { S.sel = null; updateProps(); }
    S.ws.send({ type: 'chat', text: `${target.name} подбирает ${item.name}${item.qty > 1 ? ' ×' + item.qty : ''}` });
  }
  function placeAsset(a, w) {
    const g = grid();
    let layer = a.kind === 'map' ? 'map' : a.kind === 'prop' ? 'prop' : 'character';
    if (!S.isGM && layer !== 'character') layer = 'character';
    let wdt, hgt, x = w.x, y = w.y;
    if (layer === 'map') { wdt = a.width; hgt = a.height; if (S.scene.items.some(i => i.layer === 'map')) { if (!confirm('Заменить текущую карту?')) return; S.scene.items.filter(i => i.layer === 'map').forEach(i => S.ws.send({ type: 'item_delete', scene_id: S.scene.id, id: i.id })); } x = wdt / 2; y = hgt / 2; }
    else { const ratio = a.width / a.height || 1; wdt = g; hgt = g / ratio; if (a.kind === 'prop') { wdt = g; hgt = g; } const p = snapPos(x, y, wdt, hgt); x = p.x; y = p.y; }
    upsert({ layer, z: layer === 'map' ? -100 : 0, data: { type: 'image', asset_id: a.id, x, y, w: wdt, h: hgt, name: layer === 'character' ? a.name : undefined, owner_id: S.isGM ? undefined : S.user.id, locked: layer === 'map' } });
    if (layer === 'map') setTimeout(fitToMap, 100);
  }
  function finishTemp() {
    const t = S.temp; S.temp = null;
    if (t.kind === 'ruler') { S.ws.send({ type: 'ruler', points: null }); return; }
    if (t.kind === 'draw') { if (t.points.length < 2) return; upsert({ layer: 'drawing', z: 0, data: { type: 'drawing', shape: t.shape, points: t.points.map(p => [Math.round(p[0]), Math.round(p[1])]), color: t.color, width: t.width, fill: t.shape !== 'path' && t.shape !== 'line' ? !!S.drawFill : false, owner_id: S.user.id } }); }
    if (t.kind === 'fog') { const shapes = [...(S.scene.fog?.shapes || []), { shape: t.shape, mode: t.mode, points: t.points }]; S.scene.fog = { enabled: true, shapes }; sendScene({ fog: S.scene.fog }); }
  }
  let _lastSend = 0;
  function throttleSend(m) { const n = Date.now(); if (n - _lastSend > 60) { _lastSend = n; S.ws.send(m); } }

  // ---------- синхронизация ----------
  function upsert(it) {
    if (it.id) { const idx = S.scene.items.findIndex(i => i.id === it.id); if (idx >= 0) S.scene.items[idx] = it; }
    S.ws.send({ type: 'item_upsert', scene_id: S.scene.id, item: { id: it.id, layer: it.layer, z: it.z, data: it.data } });
  }
  function sendScene(patch) { S.ws.send({ type: 'scene_update', scene_id: S.scene.id, ...patch }); }
  function deleteSel() {
    const it = S.scene.items.find(i => i.id === S.sel); if (!it || !canEdit(it)) return;
    S.ws.send({ type: 'item_delete', scene_id: S.scene.id, id: it.id }); S.sel = null; updateProps();
  }
  function onMessage(m) {
    if (m.scene_id && m.scene_id !== S.scene.id && m.type !== 'active_scene') return;
    switch (m.type) {
      case 'item_upsert': { const idx = S.scene.items.findIndex(i => i.id === m.item.id); if (idx >= 0) { if (!(S.drag?.kind === 'move' && S.drag.it.id === m.item.id)) S.scene.items[idx] = m.item; } else S.scene.items.push(m.item); if (S.sel === m.item.id) updateProps(); break; }
      case 'item_delete': S.scene.items = S.scene.items.filter(i => i.id !== m.id); if (S.sel === m.id) { S.sel = null; updateProps(); } break;
      case 'items_bulk': for (const u of m.items) { const it = S.scene.items.find(i => i.id === u.id); if (it) { Object.assign(it.data, u.data); if (u.z !== undefined) it.z = u.z; if (u.layer) it.layer = u.layer; } } break;
      case 'scene_update': if (m.grid) { S.scene.grid = m.grid; syncScale(); } if (m.fog) S.scene.fog = m.fog; if (m.name) S.scene.name = m.name; break;
      case 'ruler': if (m.points) S.remoteRulers[m.user_id] = { kind: 'ruler', points: m.points, name: m.name, user_id: m.user_id }; else delete S.remoteRulers[m.user_id]; break;
      case 'ping': S.pings.push({ x: m.x, y: m.y, t: Date.now(), name: m.name }); break;
    }
  }

  // ---------- контекстное меню (ПКМ по элементу) ----------
  function contextMenu(it, x, y) {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    const d = it.data, editable = canEdit(it);
    const menu = el('div', { class: 'ctxmenu', style: `left:${x}px;top:${y}px` });
    const add = (label, fn, cls = '') => menu.append(el('div', { class: 'ctxitem ' + cls, onclick: () => { menu.remove(); fn(); } }, label));
    menu.append(el('div', { class: 'ctxtitle' }, d.name || d.text || Table.LAYER_NAMES[it.layer] || 'Элемент'));
    if (d.character_id) add('Лист персонажа', () => S.onOpenSheet(d.character_id));
    if (d.type === 'loot') {
      add('Подобрать', () => pickUpLoot(it));
      add('Осмотреть', () => floatWindow(d.item?.name || 'Предмет', el('div', { style: 'padding:12px' }, Modules.itemCardBody(d.item || {}, {}), el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'small', onclick: () => Modules.sendCard(Modules.toChatCard(d.item, 'item')) }, 'В чат'))), { w: 420, h: 360 }));
    }
    if (d.monster) add('Статблок', () => floatWindow(d.name, el('div', { style: 'padding:12px' }, Compendium.renderData({ category: 'monster', name: d.name, source: 'SRD', data: d.monster })), { w: 480, h: 500 }));
    if (editable && (it.layer === 'character' || it.layer === 'mount')) {
      add('− Урон…', () => { const v = +prompt('Урон:', '0') || 0; d.hp = { ...(d.hp || { cur: 0, max: 0 }) }; d.hp.cur -= v; if (d.hp.cur <= 0) d.dead = true; upsert(it); });
      add('+ Лечение…', () => { const v = +prompt('Лечение:', '0') || 0; d.hp = { ...(d.hp || { cur: 0, max: 0 }) }; d.hp.cur = Math.min(d.hp.max || v, d.hp.cur + v); if (d.hp.cur > 0) d.dead = false; upsert(it); });
      if (d.monster?.abilities) add('Инициатива', () => DiceEngine.submit({ type: 'roll', expr: 'd20' + fmtMod(mod(d.monster.abilities.dex || 10)), label: d.name + ': инициатива', gm_only: !!S.isGM && d.hidden }));
      add(d.dead ? 'Жив' : 'Мёртв', () => { d.dead = !d.dead; upsert(it); });
    }
    if (editable) {
      add('Дублировать', () => { const c = JSON.parse(JSON.stringify(it)); delete c.id; c.data.x += grid(); c.data.y += grid(); upsert(c); });
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

  // ---------- панель свойств выбранного элемента ----------
  function updateProps() {
    const box = S.propsBox; box.innerHTML = '';
    const it = S.scene.items.find(i => i.id === S.sel);
    S.onSelect && S.onSelect(it);
    if (!it) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const d = it.data, editable = canEdit(it);
    const save = () => upsert(it);
    box.append(el('div', { class: 'row', style: 'margin-bottom:8px' }, el('b', { style: 'flex:1' }, d.name || d.text || { map: 'Карта', drawing: 'Рисунок', text: 'Текст' }[it.layer] || 'Элемент'), el('span', { class: 'badge' }, it.layer)));
    if (!editable) { box.append(el('div', { class: 'muted' }, 'Нет прав на редактирование')); return; }
    if (d.type === 'image') {
      if (it.layer !== 'map') {
        box.append(el('div', { class: 'field' }, el('label', {}, 'Имя'), el('input', { value: d.name || '', onchange: e => { d.name = e.target.value; save(); } })));
        const g = grid();
        box.append(el('div', { class: 'field' }, el('label', {}, 'Размер (клеток)'), el('select', { onchange: e => { const m = +e.target.value; const r = d.w / d.h; d.w = g * m; d.h = g * m / r; save(); } }, ...[0.5, 1, 2, 3, 4, 6].map(m => el('option', { value: m, selected: Math.abs(d.w / g - m) < 0.05 ? '' : null }, m + (m === 1 ? ' (средний)' : m === 2 ? ' (большой)' : m === 3 ? ' (огромный)' : ''))))));
        if (it.layer === 'character' || it.layer === 'mount') {
          const hp = d.hp || { cur: 0, max: 0 };
          box.append(el('div', { class: 'field' }, el('label', {}, 'Хиты'), el('div', { class: 'row' },
            el('input', { type: 'number', value: hp.cur, onchange: e => { d.hp = { ...hp, cur: +e.target.value }; save(); } }), el('span', { style: 'flex:0' }, '/'),
            el('input', { type: 'number', value: hp.max, onchange: e => { d.hp = { ...hp, max: +e.target.value }; save(); } }))));
          box.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
            el('button', { class: 'small', onclick: () => { const v = +prompt('Урон:', '0') || 0; d.hp = { ...(d.hp || { cur: 0, max: 0 }) }; d.hp.cur -= v; save(); } }, '− Урон'),
            el('button', { class: 'small', onclick: () => { const v = +prompt('Лечение:', '0') || 0; d.hp = { ...(d.hp || { cur: 0, max: 0 }) }; d.hp.cur = Math.min(d.hp.max, d.hp.cur + v); save(); } }, '+ Лечение')));
          const conds = d.conditions || [];
          const cbox = el('div', { style: 'margin-bottom:8px' });
          const sel = el('select', { onchange: e => { if (e.target.value) { d.conditions = [...conds, e.target.value]; save(); } } }, el('option', { value: '' }, '+ состояние'), ...Object.entries(CONDICON).map(([k, v]) => el('option', { value: k }, v + ' ' + (CONDNAMES[k] || k))));
          cbox.append(el('div', {}, ...conds.map(c => el('span', { class: 'chip' }, CONDNAMES[c] || c, el('b', { onclick: () => { d.conditions = conds.filter(x => x !== c); save(); } }, '×')))), sel);
          box.append(cbox);
          box.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
            el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.dead ? '' : null, style: 'width:auto', onchange: e => { d.dead = e.target.checked; save(); } }), ' Мёртв'),
            el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.show_hp ? '' : null, style: 'width:auto', onchange: e => { d.show_hp = e.target.checked; save(); } }), ' HP всем')));
          if (d.character_id) box.append(el('button', { class: 'small', style: 'width:100%;margin-bottom:6px', onclick: () => S.onOpenSheet(d.character_id) }, 'Лист персонажа'));
          if (d.monster) box.append(el('button', { class: 'small', style: 'width:100%;margin-bottom:6px', onclick: () => floatWindow(d.name, el('div', { style: 'padding:12px' }, Compendium.renderData({ category: 'monster', name: d.name, source: 'SRD', data: d.monster })), { w: 480, h: 500 }) }, 'Статблок'));
        }
        box.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
          el('button', { class: 'small', onclick: () => { d.rotation = ((d.rotation || 0) + 90) % 360; save(); } }, 'Повернуть'),
          el('button', { class: 'small', onclick: () => { it.z = (it.z || 0) + 1; save(); } }, 'Выше'),
          el('button', { class: 'small', onclick: () => { it.z = (it.z || 0) - 1; save(); } }, 'Ниже')));
      }
      if (S.isGM) {
        box.append(el('div', { class: 'field' }, el('label', {}, 'Слой'), el('select', { onchange: e => { it.layer = e.target.value; save(); } }, ...LAYER_ORDER.filter(l => !['drawing', 'text', 'note'].includes(l)).map(l => el('option', { value: l, selected: it.layer === l ? '' : null }, LAYER_NAMES[l])))));
        box.append(el('div', { class: 'row', style: 'margin-bottom:8px' },
          el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.hidden ? '' : null, style: 'width:auto', onchange: e => { d.hidden = e.target.checked; save(); } }), ' Скрыт'),
          el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.locked ? '' : null, style: 'width:auto', onchange: e => { d.locked = e.target.checked; save(); } }), ' Закреплён')));
        if (it.layer === 'character' || it.layer === 'mount') {
          const members = S.campaign.members || [];
          box.append(el('div', { class: 'field' }, el('label', {}, 'Владелец (игрок)'), el('select', { onchange: e => { d.owner_id = e.target.value || undefined; save(); } }, el('option', { value: '' }, '— мастер —'), ...members.map(m => el('option', { value: m.user_id, selected: d.owner_id === m.user_id ? '' : null }, m.name + (m.role === 'gm' ? ' (ГМ)' : ''))))));
        }
      }
    } else if (d.type === 'text') {
      box.append(el('div', { class: 'field' }, el('label', {}, 'Текст'), el('input', { value: d.text, onchange: e => { d.text = e.target.value; save(); } })));
      box.append(el('div', { class: 'field' }, el('label', {}, 'Размер'), el('input', { type: 'number', value: d.size, onchange: e => { d.size = +e.target.value; save(); } })));
    } else if (d.type === 'drawing') {
      box.append(el('div', { class: 'row', style: 'margin-bottom:8px' }, el('label', { style: 'flex:1' }, el('input', { type: 'checkbox', checked: d.fill ? '' : null, style: 'width:auto', onchange: e => { d.fill = e.target.checked; save(); } }), ' Заливка')));
    }
    box.append(el('button', { class: 'small danger', style: 'width:100%', onclick: deleteSel }, 'Удалить (Del)'));
  }
  const LAYER_NAMES = { map: 'Карта', prop: 'Объекты', mount: 'Ездовые', character: 'Персонажи', attachment: 'Прикреплённые', drawing: 'Рисунки', text: 'Текст', note: 'Заметки' };
  const CONDNAMES = { blinded: 'Ослеплён', charmed: 'Очарован', deafened: 'Оглох', frightened: 'Испуган', grappled: 'Схвачен', incapacitated: 'Недееспособен', invisible: 'Невидим', paralyzed: 'Парализован', petrified: 'Окаменел', poisoned: 'Отравлен', prone: 'Сбит с ног', restrained: 'Опутан', stunned: 'Ошеломлён', unconscious: 'Без сознания', exhaustion: 'Истощение', concentration: 'Концентрация' };

  function setActiveLayer(l) { S.activeLayer = l; }
  function getScene() { return S.scene; }
  function state() { return S; }
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
    upsert({ layer: 'character', z: 1, data });
  }
  return { init, setScene, onMessage, setTool, fitToMap, setActiveLayer, getScene, sendScene, upsert, state, LAYER_NAMES, CONDNAMES, CONDICON, dropLootAtCenter, placeTokenAtCenter };
})();
