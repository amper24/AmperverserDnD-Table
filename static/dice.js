// ---------------------------------------------------------------------------
// dice.js — движок кубиков: единый API броска, разбор выражений (4d6kh3,
// «к»-нотация, [[формулы]]{подписи}), док с кнопками и журнал бросков.
// Сетевые броски никогда не пересчитываются локально.
// Даёт: window.DiceEngine, window.rollDice.
// Зависимости: common.js. Загружается в обеих страницах (слой 2).
// ---------------------------------------------------------------------------
// One roll API and result schema; the global screen and journal use the same authoritative values.
// Network rolls are NEVER rerolled locally.
window.DiceEngine = (() => {
  'use strict';
  const LIMIT = 100, MAX_TERMS = 32;
  const normalize = expr => String(expr).toLowerCase().replace(/к/g, 'd').replace(/[−–—]/g, '-').replace(/\s+/g, '');
  function parse(input) {
    const expr = normalize(input);
    if (!expr || expr.length > 64 || !/^[+-]?(?:\d*d\d+(?:k[hl]\d+)?|\d+)(?:[+-](?:\d*d\d+(?:k[hl]\d+)?|\d+))*$/.test(expr)) throw Error('Неверная формула. Например: 1d20+5, 2d20kh1, 4d6kh3.');
    let count = 0;
    const terms = [...expr.matchAll(/([+-]?)([^+-]+)/g)].map(m => {
      const sign = m[1] === '-' ? -1 : 1, term = m[0], d = m[2].match(/^(\d*)d(\d+)(?:k([hl])(\d+))?$/);
      if (!d) { const value = Number(m[2]); if (!Number.isSafeInteger(value) || value > 1000000) throw Error('Модификатор не больше 1 000 000.'); return { term, value: sign * value }; }
      const n = Number(d[1] || 1), sides = Number(d[2]), keep = d[4] === undefined ? n : Number(d[4]);
      count += n;
      if (n < 1 || count > LIMIT || sides < 1 || sides > 1000 || keep < 1 || keep > n) throw Error('До 100 кубиков, 1–1000 граней; сохраняйте от 1 до числа кубиков.');
      return { term, sign, n, sides, keep, mode: d[3] };
    });
    if (terms.length > MAX_TERMS) throw Error('Слишком много слагаемых.');
    return { expr, terms };
  }
  // Rejection sampling avoids modulo bias. Math.random is used only for visual motion.
  function randomDie(sides) {
    const buf = new Uint32Array(1), ceiling = Math.floor(4294967296 / sides) * sides;
    do { crypto.getRandomValues(buf); } while (buf[0] >= ceiling);
    return buf[0] % sides + 1;
  }
  function evaluate(expr, random) {
    const spec = parse(expr); let total = 0;
    const parts = spec.terms.map(t => {
      if ('value' in t) { total += t.value; return { term: t.term, value: t.value }; }
      const rolls = Array.from({ length: t.n }, () => random ? 1 + Math.floor(random() * t.sides) : randomDie(t.sides));
      const indices = rolls.map((_, i) => i);
      if (t.mode) indices.sort((a, b) => (t.mode === 'h' ? rolls[b] - rolls[a] : rolls[a] - rolls[b]) || a - b);
      const kept_indices = indices.slice(0, t.keep).sort((a, b) => a - b), kept = kept_indices.map(i => rolls[i]);
      total += t.sign * kept.reduce((a, b) => a + b, 0);
      return { term: t.term, sides: t.sides, rolls, kept, kept_indices };
    });
    return { expr: spec.expr, total, parts };
  }
  function keptIndices(p) {
    if (Array.isArray(p.kept_indices)) return p.kept_indices;
    // Old chat records have only values: consume their multiplicities, not includes(value).
    const remaining = [...(p.kept || p.rolls || [])];
    return (p.rolls || []).flatMap((v, i) => { const j = remaining.indexOf(v); if (j < 0) return []; remaining.splice(j, 1); return [i]; });
  }
  const natural = r => { const p = r.parts.find(p => p.sides === 20 || /d20(?!\d)/.test(p.term)); return p ? keptIndices(p).map(i => p.rolls[i]) : []; };
  function withMode(expr, mode) {
    if (!['adv', 'dis'].includes(mode)) return expr;
    const normalized = normalize(expr);
    // Do not let a mode turn an invalid base formula into a valid one.
    try { parse(normalized); } catch { return normalized; }
    // Preserve the d20 check when one exists. Otherwise apply the mode to every
    // dice pool of any size (d4, d6, d8, d10, d12, d100, or custom dN).
    // A canonical 2dSkh1/kl1 can switch modes without adding dice a second time.
    const diceTerm = /^([+-]?)(\d*)d(\d+)(?:k([hl])(\d+))?$/;
    const terms = [...normalized.matchAll(/([+-]?)([^+-]+)/g)].flatMap(m => {
      const die = m[0].match(diceTerm);
      return die ? [{ index: m.index, whole: m[0], sign: die[1], count: die[2], sides: die[3], priorMode: die[4], priorKeep: die[5] }] : [];
    });
    const firstD20 = terms.find(t => Number(t.sides) === 20);
    const targets = firstD20 ? [firstD20] : terms;
    if (!targets.length) return normalized;
    let result = normalized;
    // A d20 remains the single target when present; without one, each random
    // pool in the formula receives the same mode. Work right-to-left to retain spans.
    for (const target of [...targets].sort((a, b) => b.index - a.index)) {
      const keep = (mode === 'adv') !== (target.sign === '-') ? 'h' : 'l';
      const count = Number(target.count || 1), kept = Number(target.priorKeep || count);
      const canonicalMode = !!target.priorMode && count === 2 && kept === 1;
      const customKeep = !!target.priorMode && kept < count;
      const diceCount = canonicalMode ? 2 : count * 2;
      // Preserve an explicit output count in a custom keep pool while doubling
      // its candidates; ordinary pools keep their original number of dice.
      const keepCount = canonicalMode ? 1 : customKeep ? kept : count;
      const replacement = `${target.sign}${diceCount}d${target.sides}k${keep}${keepCount}`;
      result = result.slice(0, target.index) + replacement + result.slice(target.index + target.whole.length);
    }
    return result;
  }
  const doubleDice = expr => normalize(expr).replace(/(\d*)d(\d+)(?:k([hl])(\d+))?/g, (_, n, sides, mode, keep) => `${Number(n || 1) * 2}d${sides}${mode ? `k${mode}${Number(keep) * 2}` : ''}`);
  function evaluateBatch(rolls, random) {
    if (!rolls.length || rolls.length > 8) throw Error('В связке должно быть от 1 до 8 бросков.');
    let crit = false;
    return rolls.map(spec => {
      const doubled = crit && spec.kind === 'damage';
      const r = { ...spec, ...evaluate(doubled ? doubleDice(spec.expr) : spec.expr, random), base_expr: spec.expr, doubled };
      const nat = natural(r), isD20 = !['damage', 'heal'].includes(spec.kind);
      r.crit = isD20 && nat.includes(20); r.fumble = isD20 && nat.includes(1);
      if (spec.kind === 'attack') crit = r.crit;
      return r;
    });
  }
  const pending = new Map(), history = [], seen = new Set();
  const validDiceColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#a881e8';
  const settings = () => { try { const saved = JSON.parse(LS.getItem('dice-settings') || '{}'); return { animate: true, speed: 1, ...saved, audience: ['all', 'gm', 'self'].includes(saved.audience) ? saved.audience : 'all', color: validDiceColor(saved.color) }; } catch { return { animate: true, speed: 1, audience: 'all', color: '#a881e8' }; } };
  let journalRefresh = null;
  function fail(e) { toast(e.message || String(e), 5000); return null; }
  function host() {
    for (const w of [window.parent !== window ? window.parent : null, window.opener]) {
      try { if (w && !w.closed && w.location.origin === location.origin && w.TABLE_CTX?.ws) return w; } catch { /* external preview parent */ }
    }
    return null;
  }
  function submit(message, source) {
    try {
      const msg = { ...message };
      // Аудитория: явно в сообщении (Shift — мастеру) или общая настройка всех кнопок броска.
      const explicit = ['gm', 'self'].includes(msg.audience) ? msg.audience : msg.gm_only ? 'gm' : msg.visibility === 'private' ? 'self' : '';
      const stored = settings().audience === 'gm' || settings().audience === 'self' ? settings().audience : 'all';
      const audience = explicit || (stored === 'gm' && !window.TABLE_CTX?.isGM ? 'all' : stored);
      if (audience === 'gm' && !window.TABLE_CTX?.isGM) throw Error('Скрытые броски доступны только мастеру. Бросок не отправлен.');
      delete msg.audience;
      msg.dice_color = validDiceColor(msg.dice_color || settings().color);
      applyAudience(msg, audience);
      if (msg.type === 'multi') {
        if (!Array.isArray(msg.rolls) || !msg.rolls.length || msg.rolls.length > 8) throw Error('Связка: от 1 до 8 бросков.');
        msg.rolls = msg.rolls.map(r => ({ ...r, expr: parse(r.expr).expr }));
        // Validate the worst case too, so a critical hit cannot silently omit damage.
        msg.rolls.filter(r => r.kind === 'damage').forEach(r => parse(doubleDice(r.expr)));
      } else { msg.type = 'roll'; msg.expr = parse(msg.expr).expr; }
      if (!window.TABLE_CTX?.ws) {
        const target = host();
        if (target) return target.DiceEngine.submit(msg, window);
        const payload = msg.type === 'multi' ? { ...msg, rolls: evaluateBatch(msg.rolls) } : { ...msg, ...evaluate(msg.expr) };
        present(payload, { local: true }); return payload;
      }
      if (pending.size >= 32) throw Error('Дождитесь результатов предыдущих бросков.');
      const id = crypto.randomUUID(); msg.request_id = id;
      const timer = setTimeout(() => { pending.delete(id); fail(Error('Ответ на бросок не получен. Проверьте чат и соединение; автоматического переброса нет.')); }, 12000);
      pending.set(id, { timer, source });
      if (window.TABLE_CTX.ws.send(msg) === false) { clearTimeout(timer); pending.delete(id); throw Error('Нет соединения со столом. Бросок не отправлен.'); }
      return id;
    } catch (e) {
      try { source?.toast?.(e.message || String(e), 5000); } catch { }
      return fail(e);
    }
  }
  const messageKey = m => [m.id, m.at, m.user_id, m.payload?.request_id || ''].join(':');
  function hydrate(messages) {
    const restored = [];
    for (const m of messages || []) {
      if (!['roll', 'multi'].includes(m.kind)) continue;
      const key = messageKey(m);
      if (seen.has(key)) continue;
      seen.add(key);
      restored.push({ payload: JSON.parse(JSON.stringify(m.payload)), meta: { author: m.name }, at: new Date(m.at) });
    }
    if (!restored.length) return;
    history.push(...restored);
    history.sort((a, b) => b.at - a.at);
    history.splice(50);
    updateLogBadge(); journalRefresh?.();
  }
  function receive(m) {
    if (m.type === 'roll_error') {
      const req = pending.get(m.request_id); if (req) { clearTimeout(req.timer); pending.delete(m.request_id); try { req.source?.toast?.(m.message, 5000); } catch { } }
      return fail(Error(m.message || 'Бросок отклонён сервером.'));
    }
    if (!['roll', 'multi'].includes(m.kind)) return;
    const key = messageKey(m); if (seen.has(key)) return;
    seen.add(key); if (seen.size > 300) seen.delete(seen.values().next().value);
    const p = m.payload, request = pending.get(p.request_id);
    if (request) {
      clearTimeout(request.timer); pending.delete(p.request_id);
      try { if (request.source && !request.source.closed && request.source.parent === request.source) request.source.DiceEngine.present(p, { author: m.name }); } catch { }
    }
    present(p, { author: m.name });
  }
  function detail(r) {
    return (r.parts || []).map(p => p.rolls ? `${p.term}: [${p.rolls.map((v, i) => keptIndices(p).includes(i) ? v : `~${v}~`).join(', ')}]` : p.term).join(' ');
  }
  function renderResult(p) {
    const box = el('div', { class: 'dice-result', style: `--dice-color:${validDiceColor(p.dice_color)}` });
    if (p.label) box.append(el('div', { class: 'dice-label' }, p.label));
    const mark = audienceLabel(audienceOf(p));
    if (mark) box.append(el('span', { class: 'dice-visibility ' + (audienceOf(p) === 'gm' ? 'dice-gm-mark' : 'dice-private-mark') }, mark));
    for (const r of p.rolls || [p]) {
      const nat = natural(r), d20 = !['damage', 'heal'].includes(r.kind), critical = d20 && nat.includes(20), fumble = d20 && nat.includes(1);
      const row = el('div', { class: 'dice-result-row' + (critical ? ' critical' : fumble ? ' fumble' : '') },
        el('strong', { class: 'dice-total' }, r.total), el('div', { class: 'grow' }, el('b', {}, r.name || r.expr), r.name ? el('small', {}, r.expr) : null,
          el('div', { class: 'dice-breakdown' }, ...(r.parts || []).flatMap(part => part.rolls ? [el('span', { class: 'muted' }, part.term + ':'), ...part.rolls.map((v, i) => el('span', { class: 'dice-chip' + (keptIndices(part).includes(i) ? '' : ' dropped'), title: 'd' + (part.sides || '?') }, v))] : [el('span', { class: 'dice-constant' }, part.term)]))),
        critical ? el('span', { class: 'dice-badge' }, r.kind === 'attack' ? 'КРИТ' : 'НАТ. 20') : fumble ? el('span', { class: 'dice-badge' }, 'НАТ. 1') : null,
        r.doubled ? el('span', { class: 'dice-badge' }, '×2 кости') : null);
      box.append(row);
    }
    if (p.spent?.length) box.append(el('div', { class: 'dice-spent' }, ...p.spent.map(x => el('span', {}, `${x.name}: −${x.amount} · осталось ${x.remaining}`))));
    if(p.effects?.length)box.append(el('div',{class:'dice-spent'},...p.effects.map(e=>el('span',{},({heal:'Лечение',damage:'Урон',temp_hp:'Временные хиты',grant_item:'Выдан предмет',condition:'Состояние',adjust:'Показатель',manual:'Ручное правило подтверждено'}[e.kind]||e.kind)+(e.amount!==undefined?': '+e.amount:'')+(e.name?' '+e.name:'')+(e.hp?` · ХП ${e.hp.current}/${e.hp.max}`:'')))));
    if(p.program_use)box.append(el('a',{href:'/sheet/'+encodeURIComponent(p.program_use.character_id),target:'_blank',class:'small'},'Лист владельца · выполнить действие'));
    if (p.item_use) box.append(el('a', { class: 'small', href: '/sheet/' + encodeURIComponent(p.item_use.character_id), target: '_blank' }, 'Лист владельца · использовать предмет'));
    if (p.gm_only) box.append(el('small', { class: 'muted' }, 'Скрытый бросок: видят только мастера'));
    return box;
  }
  /// Счётчик на кнопке журнала: сколько бросков уже в истории этой вкладки.
  function updateLogBadge() {
    for (const btn of document.querySelectorAll('.dice-log-button')) {
      let badge = btn.querySelector('.dice-log-count');
      if (!history.length) { badge?.remove(); continue; }
      if (!badge) btn.append(badge = el('span', { class: 'dice-log-count' }));
      badge.textContent = String(Math.min(history.length, 50));
    }
  }
  /// Кому показывать бросок: всем, только мастеру или только себе.
  const AUDIENCES = [['all', 'Всем'], ['gm', 'Только мастеру'], ['self', 'Только себе']];
  const audienceOf = p => p?.gm_only ? 'gm' : p?.visibility === 'private' ? 'self' : 'all';
  function audienceLabel(audience) { return audience === 'gm' ? 'Только мастеру' : audience === 'self' ? 'Только вам' : ''; }
  /// Выбор аудитории: один и тот же список в доке, журнале и панели; значение запоминается
  /// и используется всеми кнопками броска (лист, справочник, чат).
  function audienceSelect(onchange) {
    const stored = settings().audience, isGM = !!window.TABLE_CTX?.isGM;
    const value = stored === 'gm' || stored === 'self' ? stored : 'all';
    const sel = el('select', { class: 'dice-audience', 'aria-label': 'Кому показать бросок', title: 'Кто увидит результат броска',
      onchange: () => { LS.setItem('dice-settings', JSON.stringify({ ...settings(), audience: sel.value })); onchange?.(sel.value); } },
      ...AUDIENCES.filter(([k]) => k !== 'gm' || isGM).map(([k, n]) => el('option', { value: k, selected: value === k ? '' : null }, n)));
    return sel;
  }
  /// Применяет аудиторию к сообщению: сервер понимает gm_only + visibility.
  function applyAudience(msg, audience) {
    const a = audience === 'gm' || audience === 'self' ? audience : 'all';
    msg.gm_only = a === 'gm';
    msg.visibility = a === 'self' ? 'private' : 'campaign';
    return a;
  }
  function present(payload, meta = {}) {
    // Retain immutable values for display/history; never use animation as RNG.
    const item = { payload: JSON.parse(JSON.stringify(payload)), meta, at: new Date() };
    history.unshift(item); history.splice(50); updateLogBadge(); journalRefresh?.();
    spawn(item);
  }
  const MAX_BURSTS = 10, bursts = [];
  /// Полноэкранный слой: каждая новая связка бросков получает своё место и свою анимацию.
  function stageBox() {
    let box = document.querySelector('.dice-global-stage');
    if (!box) {
      box = el('div', { class: 'dice-global-stage', role: 'status', 'aria-live': 'polite', 'aria-label': 'Броски кубиков на экране' });
      document.body.append(box);
    }
    return box;
  }
  function detach(entry) {
    const at = bursts.indexOf(entry);
    if (at >= 0) bursts.splice(at, 1);
    clearTimeout(entry.timer); entry.cancel?.();
    layoutBursts();
  }
  function dismissBurst(entry) { detach(entry); entry.root.remove(); }
  function fadeBurst(entry) {
    if (entry.root.dataset.leaving) return;
    detach(entry);
    entry.root.dataset.leaving = '1';
    entry.root.classList.add('leaving');
    setTimeout(() => entry.root.remove(), 420);
  }
  function layoutBursts() {
    const height = window.innerHeight || 800;
    const step = Math.max(58, Math.min(82, height * 0.08));
    bursts.forEach((entry, index) => {
      if (entry.canvas) entry.canvas.style.top = `${Math.round(height * 0.04 + index * step)}px`;
    });
  }
  /// Значения костей для полноэкранной анимации; источник результата остаётся авторитетным.
  function diceOf(payload) {
    const out = [];
    for (const r of payload.rolls || [payload]) for (const p of r.parts || []) if (p.rolls) p.rolls.forEach((value, i) => {
      if (out.length >= 24) return;
      const sides = p.sides || Number(p.term.match(/d(\d+)/)?.[1]) || 6;
      out.push({ value, sides, dropped: !keptIndices(p).includes(i) });
    });
    return out;
  }
  /// Каждый принятый бросок анимируется на общем экране; значения и подробности остаются в журнале.
  function spawn(item) {
    const cfg = settings(), payload = item.payload, color = validDiceColor(payload.dice_color || cfg.color);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const dice = diceOf(payload);
    const canvas = cfg.animate && !reduced && dice.length && !document.hidden
      ? el('canvas', { class: 'dice-global-canvas', 'aria-hidden': 'true' }) : null;
    const root = el('div', { class: 'dice-global-burst', style: `--dice-color:${color}` }, canvas);
    const entry = { root, canvas, timer: null, cancel: null };
    stageBox().append(root);
    bursts.push(entry);
    while (bursts.length > MAX_BURSTS) dismissBurst(bursts[0]);
    layoutBursts();
    entry.timer = setTimeout(() => fadeBurst(entry), 5400);
    if (canvas) entry.cancel = animate(canvas, payload, { ...cfg, color }, bursts.indexOf(entry));
    // Открываем журнал при броске
    openJournalForRoll();
  }
  function dismiss() { for (const entry of [...bursts]) dismissBurst(entry); }
  function repeat(p) {
    if(p.program_use)return window.PROGRAM_USE?window.PROGRAM_USE(p.program_use):toast('Повторите действие на листе владельца: вся цепочка будет выполнена заново.');
    if (p.item_use) return window.ITEM_USE ? window.ITEM_USE(p.item_use) : toast('Повторите использование на листе владельца: ресурс будет списан там.');
    return submit(p.rolls ? { type: 'multi', label: p.label, audience: audienceOf(p), gm_only: p.gm_only, visibility: p.visibility, rolls: p.rolls.map(r => ({ name: r.name, kind: r.kind, dtype: r.dtype, expr: r.base_expr || (r.doubled ? r.expr.replace(/(\d+)d/g, (_, n) => `${Number(n) / 2}d`) : r.expr) })) } : { type: 'roll', expr: p.expr, label: p.label, kind: p.kind, audience: audienceOf(p), gm_only: p.gm_only, visibility: p.visibility });
  }
  // Lightweight projected solid meshes, gravity, rebounds and table friction.
  // Physics is cosmetic. Face labels are the authoritative result, not a physics-derived random value.
  const meshes = new Map();
  function mesh(sides) {
    if (meshes.has(sides)) return meshes.get(sides);
    const phi = (1 + Math.sqrt(5)) / 2; let v = [];
    if (sides === 4) v = [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]];
    else if (sides === 6) for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) v.push([x,y,z]);
    else if (sides === 8) v = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    else if ([12,20].includes(sides)) {
      if (sides === 12) {
        for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) v.push([x,y,z]);
        for (const a of [-1,1]) for (const b of [-1,1]) v.push([0,a/phi,b*phi],[a/phi,b*phi,0],[b*phi,0,a/phi]);
      } else for (const a of [-1,1]) for (const b of [-1,1]) v.push([0,a,b*phi],[a,b*phi,0],[b*phi,0,a]);
    } else { v = [[0,0,1.35],[0,0,-1.35]]; for (let i=0;i<5;i++) v.push([Math.cos(i*Math.PI*2/5),Math.sin(i*Math.PI*2/5),0]); }
    const norm = a => { const n = Math.hypot(...a); return a.map(x => x/n); };
    const sub = (a,b) => a.map((x,i)=>x-b[i]), dot = (a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0), cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    // Грани и их внешние нормали: по нормали определяется, какая грань смотрит на зрителя.
    const faces = [], normals = [], found = new Set();
    for (let a=0;a<v.length;a++) for(let b=a+1;b<v.length;b++) for(let c=b+1;c<v.length;c++) {
      let n = cross(sub(v[b],v[a]),sub(v[c],v[a])); if(Math.hypot(...n)<.001) continue; n=norm(n);
      const ds=v.map(p=>dot(n,sub(p,v[a]))); if(ds.some(d=>d>.001)&&ds.some(d=>d<-.001)) continue;
      if(dot(n,v[a])<0) n=n.map(x=>-x);
      const ids=ds.flatMap((d,i)=>Math.abs(d)<.001?[i]:[]), key=ids.join(','); if(found.has(key)) continue; found.add(key);
      const center=[0,1,2].map(k=>ids.reduce((sum,i)=>sum+v[i][k],0)/ids.length), u=norm(sub(v[ids[0]],center)), w=cross(n,u);
      ids.sort((i,j)=>Math.atan2(dot(sub(v[i],center),w),dot(sub(v[i],center),u))-Math.atan2(dot(sub(v[j],center),w),dot(sub(v[j],center),u)));
      faces.push(ids); normals.push(n);
    }
    const scale=Math.max(...v.map(p=>Math.hypot(...p))); v=v.map(p=>p.map(x=>x/scale));
    const result={v,faces,normals}; meshes.set(sides,result); return result;
  }
  /// Цифры на гранях: по одной на грань, выпавшее значение — на своей грани.
  /// У «процентных» костей граней меньше, чем значений — тогда берётся ближайшая грань.
  function faceLabels(sides, count, value) {
    const labels = Array.from({ length: count }, (_, i) => Math.round((i + 1) * sides / count));
    let target = labels.indexOf(value);
    if (target < 0) {
      target = labels.reduce((best, v, i) => Math.abs(v - value) < Math.abs(labels[best] - value) ? i : best, 0);
      labels[target] = value;
    }
    return { labels, target };
  }
  /// Углы, при которых грань с нормалью n смотрит точно на зрителя (Rz не влияет на ось z).
  function faceAngles(n, spin) {
    const r = Math.hypot(n[1], n[2]);
    return [Math.atan2(n[1], n[2]), Math.atan2(-n[0], r), spin];
  }
  /// Поворот точки углами Эйлера (X → Y → Z). Чистая функция модели, без DOM.
  const rotate=(p,a)=>{ let [x,y,z]=p; let c=Math.cos(a[0]),s=Math.sin(a[0]); [y,z]=[y*c-z*s,y*s+z*c]; c=Math.cos(a[1]);s=Math.sin(a[1]);[x,z]=[x*c+z*s,-x*s+z*c];c=Math.cos(a[2]);s=Math.sin(a[2]);return [x*c-y*s,x*s+y*c,z]; };
  /// Кубики летят из угла на «пол» — поверхность экрана: перспектива, отскоки, качение
  /// и доворот гранью с выпавшим значением. Физика только визуальная.
  function animate(canvas, payload, cfg, burstIndex = 0) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const W = canvas.clientWidth || 104, H = canvas.clientHeight || 84, dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
    const dice = [];
    for (const r of payload.rolls || [payload]) for (const p of r.parts || []) if (p.rolls) p.rolls.forEach((value, i) => {
      if (dice.length >= 24) return;
      const sides = p.sides || Number(p.term.match(/d(\d+)/)?.[1]) || 6, shape = mesh(sides);
      dice.push({ value, sides, dropped: !keptIndices(p).includes(i), ...faceLabels(sides, shape.faces.length, value) });
    });
    if (!dice.length) return null;
    // Мир: x — влево/вправо (px), t — глубина (0 — дальний край пола, 1 — ближний), z — высота над полом (px).
    const horizon = H * 0.16, floorH = H - horizon;
    const depthScale = t => 0.44 + 0.56 * Math.max(0, Math.min(1.2, t));
    // Кубики теперь занимают поверхность всего экрана: одиночный бросок крупный,
    // а большие связки автоматически уменьшаются, чтобы кости не слипались.
    const radius = Math.max(12, Math.min(68, H * 0.09, W * 0.24 / Math.max(1, dice.length - 1)));
    const color = /^#[0-9a-f]{6}$/i.test(cfg.color) ? cfg.color : '#a881e8';
    const speed = Number(cfg.speed) === 2 ? 2 : 1;
    // Дорожки: кости летят с двух сторон и раскладываются по «полу» рядом, а не кучей.
    const laneOf = i => {
      if (dice.length > 1) return (i / (dice.length - 1) - .5) * 1.7;
      // Повторные броски садятся в разные части большого экрана, а не один на другой.
      const singleLanes = [[-.48, .42], [.48, .34], [-.18, .68], [.2, .3], [0, .55]];
      return singleLanes[burstIndex % singleLanes.length][0] + (Math.random() - .5) * .12;
    };
    dice.forEach((d, i) => {
      const side = i % 2 ? 1 : -1, flight = .7 + Math.random() * .4;
      d.x = side * W * (.45 + Math.random() * .3);          // старт за кадром, из угла
      d.t = -.15 - Math.random() * .2;                      // из-за дальнего края «пола»
      d.z = H * (.5 + Math.random() * .4);
      d.laneX = laneOf(i) * W * .36;                        // куда в итоге лечь
      const singleLanes = [[-.48, .42], [.48, .34], [-.18, .68], [.2, .3], [0, .55]];
      d.laneT = dice.length === 1 ? singleLanes[burstIndex % singleLanes.length][1] : .3 + (i % 2) * .3 + Math.random() * .22;
      d.vx = (d.laneX - d.x) / flight;
      d.vt = (d.laneT - d.t) / flight;
      d.vz = -H * (.03 + Math.random() * .15);
      // Начинаем с позиции, близкой к нужной грани, плюс небольшое случайное вращение для анимации
      const meshData = mesh(d.sides);
      const want = faceAngles(meshData.normals[d.target], 0);
      d.angle = [
        want[0] + (Math.random() - .5) * 0.3,
        want[1] + (Math.random() - .5) * 0.3,
        want[2] + (Math.random() - .5) * 0.3
      ];
      d.spin = [(Math.random() - .5) * 15, (Math.random() - .5) * 15, (Math.random() - .5) * 15];
      d.settle = false;
    });
    let start, previous, raf = 0, alive = true;
    const stop = () => { alive = false; cancelAnimationFrame(raf); };
    function frame(now) {
      start ??= now; previous ??= now;
      const elapsed = (now - start) * speed, dt = Math.min((now - previous) / 1000, .04) * speed; previous = now;
      const finished = elapsed >= 2200;
      ctx.clearRect(0, 0, W, H);
      for (const d of dice) {
        if (finished) {
          // The last frame is deterministic: park the die and align its authoritative
          // rolled face exactly to the viewer, regardless of a throttled animation frame.
          d.settle = true; d.z = 0; d.x = d.laneX; d.t = d.laneT;
          d.vx = d.vt = d.vz = 0; d.spin = [0, 0, 0];
          d.angle = faceAngles(mesh(d.sides).normals[d.target], d.angle[2]);
          continue;
        }
        if (!d.settle) {
          d.vz -= H * 4.8 * dt;                             // притяжение к «полу» (уменьшил с 6.5)
          d.z += d.vz * dt; d.x += d.vx * dt; d.t += d.vt * dt;
          if (d.z <= 0) {
            d.z = 0;
            if (Math.abs(d.vz) > H * 0.12) { d.vz = -d.vz * (0.4 + Math.random() * 0.15); d.vx *= .8; d.vt *= .8; d.spin = d.spin.map(v => v * .75); }
            else d.vz = 0;
          }
          if (d.z === 0) {                                  // качение по полу: трение гасит ход и вращение
            const damp = Math.max(0, 1 - 2.2 * dt);
            d.vx *= damp; d.vt *= damp; d.spin = d.spin.map(v => v * Math.max(0, 1 - 1.8 * dt));
          }
          // Края отбивают только «наружу»: кости, летящие в кадр из угла, заходят свободно.
          if (d.x < -W * 0.42 && d.vx < 0) { d.x = -W * 0.42; d.vx = Math.abs(d.vx) * .65; }
          if (d.x > W * 0.42 && d.vx > 0) { d.x = W * 0.42; d.vx = -Math.abs(d.vx) * .65; }
          if (d.t < 0.04 && d.vt < 0) { d.t = 0.04; d.vt = Math.abs(d.vt) * .6; }
          if (d.t > 0.9 && d.vt > 0) { d.t = 0.9; d.vt = -Math.abs(d.vt) * .6; }
          d.angle = d.angle.map((a, i) => a + d.spin[i] * dt);
          const resting = d.z === 0 && Math.abs(d.vx) < W * 0.04 && Math.abs(d.vt) < 0.04;
          // Не успели остановиться — приземляем принудительно и всё равно показываем результат.
          if (elapsed > 1800) { d.z = 0; d.vz = 0; d.vx *= .15; d.vt *= .15; d.settle = true; }
          else if (elapsed > 1000 && resting) d.settle = true;
        }
        if (d.settle) {                                     // доворачиваем к зрителю грань с результатом
          d.spin = d.spin.map(v => v * .85);
          d.x += (d.laneX - d.x) * Math.min(1, dt * 1.5);
          d.t += (d.laneT - d.t) * Math.min(1, dt * 1.5);
          const want = faceAngles(mesh(d.sides).normals[d.target], d.angle[2]);
          for (let axis = 0; axis < 2; axis++) {
            let delta = (want[axis] - d.angle[axis]) % (Math.PI * 2);
            if (delta > Math.PI) delta -= Math.PI * 2; else if (delta < -Math.PI) delta += Math.PI * 2;
            d.angle[axis] += delta * (1 - Math.exp(-dt * 6));
          }
        }
      }
      for (const d of [...dice].sort((a, b) => a.t - b.t)) {
        const k = depthScale(Math.max(0, Math.min(1.1, d.t))), floorT = Math.max(-0.18, Math.min(1, d.t)), r = radius * k;
        const x = W / 2 + d.x * k, floorY = horizon + r * .6 + (floorH - 1.6 * radius) * floorT, y = floorY - d.z * 0.66 * k;
        ctx.fillStyle = `rgba(0,0,0,${.34 / (1 + d.z / 22)})`;
        ctx.beginPath(); ctx.ellipse(x, floorY, r * (1 + d.z / 150), r * .36, 0, 0, Math.PI * 2); ctx.fill();
        const shape = mesh(d.sides), points = shape.v.map(p => rotate(p, d.angle));
        const faces = shape.faces.map((ids, i) => ({ ids, i, z: ids.reduce((t, j) => t + points[j][2], 0) / ids.length, nz: rotate(shape.normals[i], d.angle)[2] })).sort((a, b) => a.z - b.z);
        ctx.globalAlpha = d.dropped && elapsed > 1100 ? .38 : 1;
        const front = faces.reduce((best, f) => f.nz > best.nz ? f : best, faces[0]);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const f of faces) {
          const pts = f.ids.map(id => points[id]);
          ctx.beginPath(); pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](x + p[0] * r, y + p[1] * r)); ctx.closePath();
          ctx.fillStyle = color; ctx.fill();
          ctx.fillStyle = `rgba(0,0,0,${Math.max(0, .42 - f.z * .45)})`; ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = .8; ctx.stroke();
          if (f.nz > .12) {
            const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
            const faceSize = pts.reduce((t, p) => t + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
            const label = String(d.labels[f.i]), digits = label.length;
            // Цифры крупные и считаются по грани: одна цифра занимает грань целиком, две и три ужимаются.
            const want = r * (digits === 1 ? 1.05 : digits === 2 ? 0.86 : 0.66);
            const fit = faceSize * r * (digits === 1 ? 1.15 : digits === 2 ? 0.95 : 0.78);
            ctx.font = `700 ${Math.max(8, Math.min(want, fit))}px system-ui`;
            ctx.fillStyle = f === front ? '#fff' : `rgba(255,255,255,${.3 + .45 * f.nz})`;
            ctx.shadowColor = '#111'; ctx.shadowBlur = f === front ? 4 : 1.5;
            ctx.fillText(label, x + cx * r, y + cy * r);
            ctx.shadowBlur = 0;
          }
        }
        ctx.globalAlpha = 1;
      }
      if (alive && elapsed < 2200) raf = requestAnimationFrame(frame); else alive = false;
    }
    raf = requestAnimationFrame(frame);
    return stop;
  }
  // ---------- Журнал: автооткрытие при броске ----------
  let journalAutoCloseTimer = null;
  function openJournalForRoll() {
    // First roll opens the journal too, but must keep the scene spawned just above it.
    const journal = openPanel(false, { dismissScenes: false });
    if (journal) {
      // Обновляем журнал, если он уже открыт
      if (journalRefresh) journalRefresh();
      // Закрываем журнал через 8 секунд, если мышка не на нём
      if (journalAutoCloseTimer) clearTimeout(journalAutoCloseTimer);
      journalAutoCloseTimer = setTimeout(() => {
        if (!journal.contains(document.elementFromPoint(document.body.clientWidth/2, document.body.clientHeight/2)) &&
            !journal.contains(document.activeElement)) {
          journal.remove();
          journalRefresh = null;
        }
      }, 8000);
    }
  }
  // ---------- постоянный интерфейс: слева — броски, справа — личный журнал ----------
  /// Бросок из дока: формула, модификатор и режим, как в панели стола.
  function dockRoll(expr, mode = 'normal', opts = {}) {
    return submit({ type: 'roll', expr: withMode(expr, mode), gm_only: !!opts.gm_only, audience: opts.audience, label: opts.label || expr });
  }
  /// Нижний левый угол: всегда под рукой. Нижний правый: журнал этой вкладки.
  /// Возвращает false, если док уже установлен на странице.
  function dock(opts = {}) {
    if (document.querySelector('.dice-dock')) return false;
    const cfg = settings();
    const modInp = el('input', { type: 'text', placeholder: '+0', title: 'Модификатор, добавляется к броску', 'aria-label': 'Модификатор', style: 'width:54px' });
    const exprInp = el('input', { type: 'text', placeholder: '2d6+3, 4d6kh3…', title: 'Своя формула — Enter для броска', 'aria-label': 'Формула броска', style: 'width:132px' });
    const audience = audienceSelect();
    let mode = 'normal';
    const modStr = () => { const m = modInp.value.trim(); if (!m || m === '+0' || m === '0') return ''; return /^[+-]/.test(m) ? m : '+' + m; };
    const rollExpr = (expr, label) => dockRoll(expr + modStr(), mode, { audience: audience.value, label: (label || expr) + (modStr() ? ' ' + modStr() : '') });
    const die = d => {
      const label = d === 20 && mode === 'adv' ? 'к20 с преимуществом'
        : d === 20 && mode === 'dis' ? 'к20 с помехой' : 'к' + d;
      rollExpr('d' + d, label);
    };
    const modeBtns = el('div', { class: 'seg' }, ...[['normal', 'Обычно'], ['adv', 'Преим.'], ['dis', 'Помеха']].map(([k, t]) => el('button', { class: 'small' + (k === 'normal' ? ' active' : ''), onclick: e => { mode = k; modeBtns.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, t)));
    exprInp.addEventListener('keydown', e => { if (e.key === 'Enter' && exprInp.value.trim()) { rollExpr(exprInp.value.trim()); exprInp.value = ''; } });
    const dieTogether = d => {
      const expr = withMode('d' + d, mode) + modStr();
      return submit({ type: 'multi', label: `Два броска к${d} одновременно`, audience: audience.value,
        rolls: [1, 2].map(n => ({ name: `к${d} · ${n}`, expr, kind: 'other' })) });
    };
    const quick = el('div', { class: 'dice' }, ...[4, 6, 8, 10, 12, 20, 100].map(d => el('button', { title: `Бросить к${d}. Shift — два броска одновременно`, onclick: e => e.shiftKey ? dieTogether(d) : die(d) }, 'к' + d)));
    const body = el('div', { class: 'dice-dock-body' }, quick,
      el('div', { class: 'row' }, modeBtns, modInp),
      el('div', { class: 'row' }, exprInp, el('button', { class: 'small primary', title: 'Бросить формулу', onclick: () => { if (exprInp.value.trim()) { rollExpr(exprInp.value.trim()); exprInp.value = ''; } } }, 'Бросить')),
      el('div', { class: 'dice-dock-options' }, el('label', { class: 'muted small' }, 'Кому: ', audience)));
    const toggle = el('button', { class: 'dice-dock-toggle', title: 'Кубики: свернуть / развернуть', 'aria-label': 'Кубики', onclick: () => { wrap.classList.toggle('min'); LS.setItem('dicetray_min', wrap.classList.contains('min') ? '1' : ''); } }, icon('dice', 16));
    const wrap = el('div', { class: 'dice-dock' + (LS.getItem('dicetray_min') ? ' min' : '') }, toggle, body);
    const log = el('button', { class: 'dice-log-button', title: 'Личный журнал бросков', onclick: openPanel },
      icon('book', 15), el('span', {}, 'Журнал'), history.length ? el('span', { class: 'dice-log-count' }, String(Math.min(history.length, 50))) : null);
    document.body.append(wrap, log);
    return true;
  }
  /// Компактный журнал последних бросков кампании, личных результатов, повтора и настроек.
  function openPanel(toggle = true, { dismissScenes = true } = {}) {
    const currentPanel = document.querySelector('.dice-journal');
    if (currentPanel) {
      if (!toggle) return currentPanel;
      currentPanel.remove(); journalRefresh = null; return null;
    }
    const cfg = settings();
    if (dismissScenes) dismiss(); // ручное открытие журнала убирает уже идущие сцены; автооткрытие их сохраняет
    const expr = el('input', { value: '1d20', placeholder: '2d6+3', 'aria-label': 'Формула броска' });
    const mode = el('select', { 'aria-label': 'Режим броска' }, ...[['normal', 'Обычно'], ['adv', 'Преимущество'], ['dis', 'Помеха']].map(([v, n]) => el('option', { value: v }, n)));
    const audience = audienceSelect();
    const list = el('div', { class: 'dice-history' });
    const refresh = () => list.replaceChildren(...(history.length ? history.map(h => {
      const payload = h.payload, color = validDiceColor(payload.dice_color), visibilityLabel = audienceLabel(audienceOf(payload)) || (h.meta.local ? 'Локально' : 'Кампания');
      return el('article', { class: 'dice-history-entry', style: `--dice-color:${color}` },
        el('div', { class: 'dice-history-meta' }, el('small', { class: 'muted' }, h.at.toLocaleTimeString() + ' · ' + (h.meta.local ? 'Локально' : h.meta.author || 'Стол')),
          el('span', { class: 'dice-visibility' }, visibilityLabel)),
        renderResult(payload), el('button', { class: 'small', onclick: () => repeat(payload) }, 'Повторить'));
    }) : [el('p', { class: 'muted dice-empty' }, 'Здесь появятся ваши броски и результаты кампании.') ]));
    journalRefresh = refresh; refresh();
    const run = () => submit({ type: 'roll', expr: withMode(expr.value, mode.value), audience: audience.value, label: expr.value });
    expr.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    const enabled = el('input', { type: 'checkbox', checked: cfg.animate ? '' : null }), fast = el('input', { type: 'checkbox', checked: cfg.speed === 2 ? '' : null }), color = el('input', { type: 'color', value: cfg.color, 'aria-label': 'Цвет кубиков' });
    const save = () => LS.setItem('dice-settings', JSON.stringify({ ...settings(), animate: enabled.checked, speed: fast.checked ? 2 : 1, color: color.value }));
    [enabled, fast, color].forEach(e => e.addEventListener('change', save));
    const close = () => { panel.remove(); journalRefresh = null; if (journalAutoCloseTimer) { clearTimeout(journalAutoCloseTimer); journalAutoCloseTimer = null; } };
    const panel = el('section', { class: 'dice-journal', role: 'dialog', 'aria-label': 'Журнал бросков' },
      el('header', { class: 'dice-journal-head' }, el('div', {}, el('strong', {}, 'Журнал бросков'), el('small', { class: 'muted' }, 'Последние 50 результатов')), el('button', { class: 'dice-journal-close', title: 'Закрыть журнал', 'aria-label': 'Закрыть журнал', onclick: close }, '×')),
      el('div', { class: 'dice-journal-controls' },
        el('div', { class: 'dice-quick' }, ...[4, 6, 8, 10, 12, 20, 100].map(d => el('button', { title: `Бросить к${d}`, onclick: () => { expr.value = '1d' + d; run(); } }, 'к' + d))),
        el('div', { class: 'dice-journal-formula' }, expr, mode, el('button', { class: 'primary', onclick: run }, 'Бросить')),
        el('div', { class: 'dice-journal-options' }, el('label', { class: 'muted small' }, 'Кому: ', audience)),
        el('div', { class: 'dice-preferences' }, el('label', {}, enabled, ' Анимация'), el('label', {}, fast, ' Быстро'), el('label', {}, 'Цвет ', color)),
        el('p', { class: 'muted small dice-help' }, '4d6kh3 — оставить три лучших. При броске в кампанию участники увидят выбранный цвет.')),
      el('div', { class: 'dice-journal-history-head' }, el('b', {}, 'Последние броски')), list);
    document.body.append(panel);
    // Отменяем авто-закрытие, если мышка над журналом
    panel.addEventListener('mouseenter', () => { if (journalAutoCloseTimer) { clearTimeout(journalAutoCloseTimer); journalAutoCloseTimer = null; } });
    panel.addEventListener('mousemove', () => { if (journalAutoCloseTimer) { clearTimeout(journalAutoCloseTimer); journalAutoCloseTimer = null; } });
    setTimeout(() => expr.focus(), 0);
    return panel;
  }
  window.addEventListener?.('keydown', e => {
    if (e.key !== 'Escape') return;
    const journal = document.querySelector('.dice-journal');
    if (journal) { journal.remove(); journalRefresh = null; }
    if (bursts.length) dismiss();
  });
  window.addEventListener?.('pagehide', () => { dismiss(); pending.forEach(p => clearTimeout(p.timer)); pending.clear(); });
  function committed(message) { const target = host(); if (target?.DiceEngine) target.DiceEngine.receive(message); if (!target || window.parent === window) receive(message); }
  const button=()=>el('button',{class:'small',title:'Журнал бросков',onclick:openPanel},icon('dice',14),' Кубики');
  // mesh / rotate / faceLabels / faceAngles — чистая модель кубика: ей пользуется анимация и тесты.
  return { parse, evaluate, evaluateBatch, keptIndices, withMode, doubleDice, submit, receive, hydrate, committed, present, renderResult, detail, button, dock, dockRoll, openPanel, dismiss, mesh, rotate, faceLabels, faceAngles, animate };
})();
window.rollDice = (...args) => DiceEngine.evaluate(...args);
