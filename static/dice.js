// ---------------------------------------------------------------------------
// dice.js — движок кубиков: единый API броска, разбор выражений (4d6kh3,
// «к»-нотация, [[формулы]]{подписи}), док с кнопками и журнал бросков.
// Сетевые броски никогда не пересчитываются локально.
// Даёт: window.DiceEngine, window.rollDice.
// Зависимости: common.js. Загружается в обеих страницах (слой 2).
// ---------------------------------------------------------------------------
// One roll API/result schema; the journal and visualizer consume accepted results.
// Network rolls are NEVER rerolled locally, predicted or changed by the animation.
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
  // Rejection sampling avoids modulo bias in local rolls.
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
  const settings = () => { try { const saved = JSON.parse(LS.getItem('dice-settings') || '{}'); return { audience: ['all', 'gm', 'self'].includes(saved.audience) ? saved.audience : 'all', color: validDiceColor(saved.color) }; } catch { return { audience: 'all', color: '#a881e8' }; } };
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
    // Animate only the accepted payload: the server's/local evaluator's values are
    // authoritative; the visual simulation never generates or changes a result.
    try { window.DiceVisualizer?.show?.(payload); } catch { /* visuals must never block a committed roll */ }
    history.unshift({ payload: JSON.parse(JSON.stringify(payload)), meta, at: new Date() });
    history.splice(50); updateLogBadge(); journalRefresh?.();
    openJournalForRoll();
  }
  /// Повторяет формулу или действие на листе владельца, не подменяя исходный результат.
  function repeat(p) {
    if(p.program_use)return window.PROGRAM_USE?window.PROGRAM_USE(p.program_use):toast('Повторите действие на листе владельца: вся цепочка будет выполнена заново.');
    if (p.item_use) return window.ITEM_USE ? window.ITEM_USE(p.item_use) : toast('Повторите использование на листе владельца: ресурс будет списан там.');
    return submit(p.rolls ? { type: 'multi', label: p.label, audience: audienceOf(p), gm_only: p.gm_only, visibility: p.visibility, rolls: p.rolls.map(r => ({ name: r.name, kind: r.kind, dtype: r.dtype, expr: r.base_expr || (r.doubled ? r.expr.replace(/(\d+)d/g, (_, n) => `${Number(n) / 2}d`) : r.expr) })) } : { type: 'roll', expr: p.expr, label: p.label, kind: p.kind, audience: audienceOf(p), gm_only: p.gm_only, visibility: p.visibility });
  }
  // ---------- Журнал: автоматически показывает новые результаты ----------
  let journalAutoCloseTimer = null;
  function openJournalForRoll() {
    const journal = openPanel(false);
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
  function openPanel(toggle = true) {
    const currentPanel = document.querySelector('.dice-journal');
    if (currentPanel) {
      if (!toggle) return currentPanel;
      currentPanel.remove(); journalRefresh = null; return null;
    }
    const cfg = settings();
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
    const color = el('input', { type: 'color', value: cfg.color, 'aria-label': 'Цвет кубиков' });
    color.addEventListener('change', () => LS.setItem('dice-settings', JSON.stringify({ ...settings(), color: color.value })));
    const close = () => { panel.remove(); journalRefresh = null; if (journalAutoCloseTimer) { clearTimeout(journalAutoCloseTimer); journalAutoCloseTimer = null; } };
    const panel = el('section', { class: 'dice-journal', role: 'dialog', 'aria-label': 'Журнал бросков' },
      el('header', { class: 'dice-journal-head' }, el('div', {}, el('strong', {}, 'Журнал бросков'), el('small', { class: 'muted' }, 'Последние 50 результатов')), el('button', { class: 'dice-journal-close', title: 'Закрыть журнал', 'aria-label': 'Закрыть журнал', onclick: close }, '×')),
      el('div', { class: 'dice-journal-controls' },
        el('div', { class: 'dice-quick' }, ...[4, 6, 8, 10, 12, 20, 100].map(d => el('button', { title: `Бросить к${d}`, onclick: () => { expr.value = '1d' + d; run(); } }, 'к' + d))),
        el('div', { class: 'dice-journal-formula' }, expr, mode, el('button', { class: 'primary', onclick: run }, 'Бросить')),
        el('div', { class: 'dice-journal-options' }, el('label', { class: 'muted small' }, 'Кому: ', audience)),
        el('div', { class: 'dice-preferences' }, el('label', {}, 'Цвет кубиков ', color)),
        el('p', { class: 'muted small dice-help' }, '4d6kh3 — оставить три лучших. Результаты и история бросков находятся в журнале.')),
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
    if (journalAutoCloseTimer) { clearTimeout(journalAutoCloseTimer); journalAutoCloseTimer = null; }
  });
  window.addEventListener?.('pagehide', () => { pending.forEach(p => clearTimeout(p.timer)); pending.clear(); });
  function committed(message) { const target = host(); if (target?.DiceEngine) target.DiceEngine.receive(message); if (!target || window.parent === window) receive(message); }
  const button=()=>el('button',{class:'small',title:'Журнал бросков',onclick:openPanel},icon('dice',14),' Кубики');
  return { parse, evaluate, evaluateBatch, keptIndices, withMode, doubleDice, submit, receive, hydrate, committed, present, renderResult, detail, button, dock, dockRoll, openPanel };
})();
window.rollDice = (...args) => DiceEngine.evaluate(...args);
