// ---------------------------------------------------------------------------
// dice-visual.js — одна неподвижная площадка для всех кубиков броска.
// Новая сцена заменяет предыдущую; результат берётся только из готового payload.
// ---------------------------------------------------------------------------
window.DiceVisualizer = (() => {
  'use strict';
  const MAX_DICE = 32, HOLD_MS = 1050, STEP = 1 / 120;
  let root = null, canvas = null, context = null, run = 0, frame = 0;
  let states = [], payload = null, totalDice = 0, lastTime = 0, accumulator = 0, settledAt = 0;
  let fallbackRandomState = 0x6d2b79f5;

  function random() {
    if (globalThis.crypto?.getRandomValues) {
      const word = new Uint32Array(1); globalThis.crypto.getRandomValues(word); return word[0] / 4294967296;
    }
    // Cosmetic fallback only; it never participates in the actual dice result.
    fallbackRandomState = (fallbackRandomState * 1664525 + 1013904223) >>> 0;
    return fallbackRandomState / 4294967296;
  }
  function ensureRoot() {
    if (root?.isConnected) return true;
    if (typeof document === 'undefined' || !document.body || !window.DicePhysics) return false;
    canvas = el('canvas', { class: 'dice-visual-canvas', 'aria-hidden': 'true' });
    root = el('div', { class: 'dice-visual-root', role: 'status', 'aria-live': 'polite', 'aria-label': 'Анимация броска кубиков' }, canvas);
    document.body.append(root);
    context = canvas.getContext?.('2d', { alpha: true }) || null;
    return !!context;
  }
  function keepIndices(part) {
    if (Array.isArray(part.kept_indices)) return new Set(part.kept_indices);
    const remaining = [...(part.kept || part.rolls || [])];
    return new Set((part.rolls || []).flatMap((value, index) => {
      const match = remaining.indexOf(value);
      if (match < 0) return [];
      remaining.splice(match, 1); return [index];
    }));
  }
  function collect(payload) {
    const results = Array.isArray(payload.rolls) && payload.rolls.length ? payload.rolls : [payload];
    const all = [];
    for (const result of results) for (const part of result.parts || []) {
      if (!Array.isArray(part.rolls)) continue;
      const kept = keepIndices(part);
      part.rolls.forEach((value, index) => {
        if (!Number.isFinite(Number(value))) return;
        all.push({ sides: Number(part.sides) || 6, value: Number(value), kept: kept.has(index), name: result.name || '' });
      });
    }
    return all;
  }
  function labelFor(payload, dice) {
    const description = payload.label || (Array.isArray(payload.rolls) ? 'Бросок кубиков' : payload.expr || 'Бросок');
    const faces = dice.map(d => `к${d.sides}: ${d.value}`).join(', ');
    return `${description}${faces ? `. Выпало: ${faces}` : ''}`;
  }
  function roundedRect(ctx, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function parseColor(hex) {
    const value = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex.slice(1) : 'a881e8';
    return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
  }
  function shade(rgb, amount) {
    const scaled = rgb.map(channel => Math.round(Math.min(255, Math.max(0, channel * amount))));
    return `rgb(${scaled[0]} ${scaled[1]} ${scaled[2]})`;
  }
  function pointFor(vertex, orientation, x, y, size) {
    const point = DicePhysics.rotate(orientation, vertex), camera = 4.1;
    const perspective = 3.25 / (camera - point[2] * .58);
    return [x + point[0] * size * perspective, y - point[1] * size * perspective, point[2]];
  }
  function drawDie(ctx, die, x, y, size, baseColor) {
    const lift = Math.min(die.height, size * 1.15), shadowY = y + size * .53;
    ctx.save();
    ctx.globalAlpha = (die.kept ? .28 : .13) * (1 - lift / (size * 2));
    ctx.fillStyle = '#000'; ctx.filter = `blur(${Math.max(3, size * .12)}px)`;
    ctx.beginPath(); ctx.ellipse(x, shadowY, size * (.55 + lift / size * .12), size * .19, 0, 0, Math.PI * 2); ctx.fill();
    ctx.filter = 'none'; ctx.restore();

    const points = die.model.vertices.map(vertex => pointFor(vertex, die.orientation, x, y - lift * .62, size));
    const faces = die.model.faces.map(face => {
      const normal = DicePhysics.rotate(die.orientation, face.normal);
      const center = face.indices.reduce((sum, index) => sum + points[index][2], 0) / face.indices.length;
      return { face, normal, depth: center, polygon: face.indices.map(index => points[index]) };
    }).filter(item => item.normal[2] > -.035).sort((a, b) => a.depth - b.depth);
    const rgb = parseColor(baseColor);
    for (const item of faces) {
      const { face, normal, polygon } = item;
      const light = Math.max(.38, Math.min(1.18, .72 + normal[0] * -.16 + normal[1] * .18 + normal[2] * .43));
      ctx.save(); ctx.globalAlpha = die.kept ? 1 : .48;
      ctx.beginPath(); polygon.forEach((point, index) => index ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1])); ctx.closePath();
      ctx.fillStyle = shade(rgb, light); ctx.fill();
      ctx.lineWidth = Math.max(1, size * .035); ctx.strokeStyle = 'rgba(255,255,255,.68)'; ctx.stroke();
      const centerX = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
      const centerY = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
      const isResult = face.id === die.faceIndex;
      const faceText = isResult ? String(die.value) : String(face.label ?? face.id + 1);
      const fontSize = Math.max(9, Math.min(20, size * (isResult ? .43 : .29)));
      ctx.fillStyle = isResult ? '#fff' : 'rgba(255,255,255,.76)';
      ctx.font = `800 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.48)'; ctx.shadowBlur = 2;
      ctx.fillText(faceText, centerX, centerY, size * .88);
      ctx.restore();
    }
    ctx.save(); ctx.globalAlpha = die.kept ? .78 : .4;
    ctx.fillStyle = '#f3e5bf'; ctx.font = `600 ${Math.max(9, Math.min(11, size * .2))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`к${die.sides}`, x, y + size * .7, size * 1.3);
    ctx.restore();
  }
  function draw(now) {
    if (!context || !canvas) return { width: 0, height: 0 };
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, rect.width || 820), height = Math.max(190, rect.height || 286);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);

    const ctx = context, pad = 7;
    const panel = ctx.createLinearGradient(0, pad, 0, height - pad);
    panel.addColorStop(0, 'rgba(28,31,43,.94)'); panel.addColorStop(1, 'rgba(13,17,27,.93)');
    roundedRect(ctx, pad, pad, width - pad * 2, height - pad * 2, 19);
    ctx.fillStyle = panel; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(224,190,126,.68)'; ctx.stroke();
    const glow = ctx.createRadialGradient(width * .5, height * .67, 2, width * .5, height * .67, Math.min(width, height) * .58);
    glow.addColorStop(0, 'rgba(191,145,89,.15)'); glow.addColorStop(1, 'rgba(191,145,89,0)');
    roundedRect(ctx, pad + 1, pad + 1, width - pad * 2 - 2, height - pad * 2 - 2, 18); ctx.fillStyle = glow; ctx.fill();

    const title = payload?.label || (Array.isArray(payload?.rolls) ? 'Бросок кубиков' : payload?.expr || 'Бросок');
    ctx.fillStyle = '#f4ead4'; ctx.font = '650 12px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(title, 23, 27, Math.max(100, width - 46));
    ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.beginPath(); ctx.moveTo(22, 44); ctx.lineTo(width - 22, 44); ctx.stroke();

    if (!states.length) return { width, height };
    const columns = Math.min(states.length, 8, Math.ceil(Math.sqrt(states.length * 1.7)));
    const rows = Math.ceil(states.length / columns), areaX = 24, areaY = 54;
    const areaW = width - 48, areaH = height - 82, cellW = areaW / columns, cellH = areaH / rows;
    const size = Math.max(18, Math.min(52, cellW * .39, cellH * .45));
    states.forEach((die, index) => {
      const row = Math.floor(index / columns), firstInRow = row * columns, itemsInRow = Math.min(columns, states.length - firstInRow);
      const col = index - firstInRow, rowW = itemsInRow * cellW;
      const x = (width - rowW) / 2 + (col + .5) * cellW;
      const y = areaY + (row + .5) * cellH;
      // A small fixed slot grid is used for every frame; no roll gets its own
      // vertically stacked toast and no die is re-laid out while it tumbles.
      if (die.layoutWidth !== width || die.layoutHeight !== height) {
        DicePhysics.setAnchor(die, x, y, size);
        die.layoutWidth = width; die.layoutHeight = height;
      }
      drawDie(ctx, die, die.x, die.y, size, payload?.dice_color || '#a881e8');
    });
    if (states.length < totalDice) {
      ctx.fillStyle = 'rgba(244,234,212,.7)'; ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(`+${totalDice - states.length} в журнале`, width - 22, height - 13);
    }
    return { width, height, now };
  }
  function hide(runId) {
    if (runId !== run || !root) return;
    root.classList.remove('visible');
    frame = 0; states = []; payload = null; totalDice = 0;
  }
  function tick(runId, timestamp) {
    if (runId !== run) return;
    if (!lastTime) lastTime = timestamp;
    let delta = Math.min(.05, Math.max(0, (timestamp - lastTime) / 1000)); lastTime = timestamp;
    accumulator += delta;
    while (accumulator >= STEP) {
      for (const die of states) DicePhysics.step(die, STEP);
      accumulator -= STEP;
    }
    draw(timestamp);
    const allSettled = states.length && states.every(die => die.settled);
    if (allSettled) {
      if (!settledAt) settledAt = timestamp;
      if (timestamp - settledAt >= HOLD_MS) { hide(runId); return; }
    }
    frame = window.requestAnimationFrame(t => tick(runId, t));
  }
  function show(rollPayload) {
    if (!ensureRoot()) return false;
    if (frame) window.cancelAnimationFrame?.(frame);
    const runId = ++run, allDice = collect(rollPayload);
    if (!allDice.length) { root.classList.remove('visible'); return false; }
    payload = rollPayload; totalDice = allDice.length;
    states = allDice.slice(0, MAX_DICE).map(spec => DicePhysics.createDie(spec, random));
    lastTime = 0; accumulator = 0; settledAt = 0;
    root.classList.add('visible');
    root.setAttribute('aria-label', labelFor(rollPayload, allDice));
    root.setAttribute('data-values', allDice.map(d => d.value).join(','));
    // When a browser disables Canvas, the journal still carries the authoritative result.
    if (!context || !window.requestAnimationFrame) { root.classList.remove('visible'); return false; }
    draw(0);
    frame = window.requestAnimationFrame(t => tick(runId, t));
    return true;
  }
  function cancel() {
    run++;
    if (frame) window.cancelAnimationFrame?.(frame);
    frame = 0; states = []; payload = null; totalDice = 0; settledAt = 0;
    root?.classList.remove('visible');
  }
  return { show, cancel, collect };
})();
