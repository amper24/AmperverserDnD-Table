// ---------------------------------------------------------------------------
// dice-visual.js — одна прозрачная площадка для всех кубиков броска.
// Кубы вылетают из центра и падают в случайные точки рядом с ним, катятся чуть-чуть
// по невидимому столу и останавливаются. Новая сцена заменяет предыдущую; результат
// берётся только из готового payload.
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
  // Random but compact layout around the centre. Every die gets the best of a few
  // random candidates (the one farthest from the other landings), so dice spread
  // out without overlapping much, and nothing leaves the visible stage.
  function planLayout(count, width, height) {
    const areaW = width - 48, areaH = height - 82;
    const cx = width / 2, cy = 54 + areaH / 2;
    const size = Math.max(18, Math.min(52, Math.sqrt(areaW * areaH / count) * .36));
    const halfW = Math.max(0, areaW / 2 - size * 1.4), halfH = Math.max(0, areaH / 2 - size * 1.4);
    const grow = Math.sqrt(count);
    const spreadX = Math.min(halfW, size * 1.7 + grow * size * .85);
    const spreadY = Math.min(halfH, size * .9 + grow * size * .5);
    const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));
    const landed = [], spots = [];
    for (let i = 0; i < count; i++) {
      let best = null, bestGap = -1;
      for (let k = 0; k < 24; k++) {
        const p = [(random() * 2 - 1) * spreadX, (random() * 2 - 1) * spreadY];
        const gap = landed.reduce((min, q) => Math.min(min, Math.hypot(p[0] - q[0], p[1] - q[1])), Infinity);
        if (gap > bestGap) { bestGap = gap; best = p; }
      }
      landed.push(best);
      const angle = random() * Math.PI * 2, distance = size * (.2 + random() * .45);
      const rest = [clamp(best[0] + Math.cos(angle) * distance, spreadX), clamp(best[1] + Math.sin(angle) * distance, spreadY)];
      spots.push({ land: best, rest });
    }
    return { cx, cy, size, spots, key: `${width}x${height}` };
  }
  function applyLayout(list, width, height) {
    const plan = planLayout(list.length, width, height);
    list.forEach((die, index) => {
      const spot = plan.spots[index];
      DicePhysics.place(die, {
        x: plan.cx, y: plan.cy, size: plan.size,
        landX: plan.cx + spot.land[0], landY: plan.cy + spot.land[1],
        restX: plan.cx + spot.rest[0], restY: plan.cy + spot.rest[1],
      });
      die.layoutKey = plan.key;
    });
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

    const ctx = context;
    // No frame: the dice float over the page; only the title text is drawn.
    const title = payload?.label || (Array.isArray(payload?.rolls) ? 'Бросок кубиков' : payload?.expr || 'Бросок');
    ctx.save(); ctx.fillStyle = '#f4ead4'; ctx.font = '650 12px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 4;
    ctx.fillText(title, 24, 27, Math.max(100, width - 48)); ctx.restore();

    if (!states.length) return { width, height };
    // Layout is fixed once the dice start moving, so a resize cannot make them jump.
    if (!states.some(die => die.elapsed > 0) && states[0].layoutKey !== `${width}x${height}`) applyLayout(states, width, height);
    states.forEach(die => drawDie(ctx, die, die.x, die.y, die.size * die.scale, payload?.dice_color || '#a881e8'));
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
    const stage = canvas.getBoundingClientRect();
    applyLayout(states, Math.max(300, stage.width || 820), Math.max(190, stage.height || 286));
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
  return { show, cancel, collect, plan: planLayout };
})();
