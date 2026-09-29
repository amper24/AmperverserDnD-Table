// One roll API, one result format, one renderer. Network rolls are NEVER rerolled locally.
window.DiceEngine = (() => {
  'use strict';
  const LIMIT = 100, MAX_TERMS = 32;
  const normalize = expr => String(expr).toLowerCase().replace(/к/g, 'd').replace(/\s+/g, '');
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
    return ['adv', 'dis'].includes(mode) ? normalize(expr).replace(/(^|[+-])(?:1)?d20(?!\d|k)/, (_, sign) => `${sign}2d20k${mode === 'adv' ? 'h' : 'l'}1`) : expr;
  }
  const doubleDice = expr => normalize(expr).replace(/(\d*)d(\d+)/g, (_, n, sides) => `${Number(n || 1) * 2}d${sides}`);
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
  let current = null, queue = [], animation = 0;
  const settings = () => { try { return { animate: true, speed: 1, color: '#a881e8', ...JSON.parse(LS.getItem('dice-settings') || '{}') }; } catch { return { animate: true, speed: 1, color: '#a881e8' }; } };
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
      if (msg.gm_only && !window.TABLE_CTX.isGM) throw Error('Скрытые броски доступны только мастеру. Бросок не отправлен.');
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
  function receive(m) {
    if (m.type === 'roll_error') {
      const req = pending.get(m.request_id); if (req) { clearTimeout(req.timer); pending.delete(m.request_id); try { req.source?.toast?.(m.message, 5000); } catch { } }
      return fail(Error(m.message || 'Бросок отклонён сервером.'));
    }
    if (!['roll', 'multi'].includes(m.kind)) return;
    const key = [m.id, m.at, m.user_id, m.payload?.request_id || ''].join(':'); if (seen.has(key)) return;
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
    const box = el('div', { class: 'dice-result' });
    if (p.label) box.append(el('div', { class: 'dice-label' }, p.label));
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
    if (p.gm_only) box.append(el('small', { class: 'muted' }, 'Скрытый бросок · только мастер / локальный лист'));
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
  function present(payload, meta = {}) {
    // Retain immutable values for display/history; never use animation as RNG.
    const item = { payload: JSON.parse(JSON.stringify(payload)), meta, at: new Date() };
    history.unshift(item); history.splice(50); updateLogBadge();
    queue.push(item);
    if (queue.length > 6) queue.splice(0, queue.length - 6); // history retains overflow, animation doesn't lag indefinitely
    if (!current) playNext();
    else if (current.timer && queue.length) { clearTimeout(current.timer); current.timer = setTimeout(dismiss, 1400); }
  }
  function dismiss() {
    if (!current) return;
    cancelAnimationFrame(animation); clearTimeout(current.timer); current.root.remove(); current = null;
    playNext();
  }
  /// Результат появляется, показывается и сам уходит: закрывать его не обязательно.
  function fadeOut(root) {
    if (!root?.isConnected) return;
    if (root.dataset.leaving) return;
    root.dataset.leaving = '1';
    root.classList.add('leaving');
    setTimeout(() => { if (current?.root === root) dismiss(); else root.remove(); }, 420);
  }
  function playNext() {
    if (!queue.length) return;
    const item = queue.shift(), cfg = settings();
    const root = el('div', { class: 'dice-overlay' }), canvas = el('canvas', { class: 'dice-canvas', 'aria-hidden': 'true' });
    const card = el('section', { class: 'dice-toast', role: 'status', 'aria-live': 'polite' },
      el('div', { class: 'dice-toast-head' }, el('span', {}, (item.meta.local ? 'Локальный бросок' : item.meta.author || 'Бросок') + ' · ' + item.at.toLocaleTimeString()),
        el('button', { title: 'Закрыть результат', 'aria-label': 'Закрыть результат', onclick: dismiss }, '×')),
      renderResult(item.payload), el('div', { class: 'dice-toast-actions' }, el('button', { class: 'small', onclick: () => { const p = item.payload; fadeOut(root); repeat(p); } }, 'Бросить ещё'), el('button', { class: 'small', onclick: () => { fadeOut(root); openPanel(); } }, 'Журнал')));
    const pause = () => { if (current?.root === root) clearTimeout(current.timer); };
    const resume = () => { if (current?.root === root) current.timer = setTimeout(() => fadeOut(root), 3200); };
    card.addEventListener('pointerenter', pause); card.addEventListener('pointerleave', resume);
    card.addEventListener('focusin', pause); card.addEventListener('focusout', resume);
    root.append(canvas, el('button', { class: 'dice-skip', title: 'Убрать результат', onclick: () => fadeOut(root) }, '×'), card); document.body.append(root); current = { root, timer: null };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const finish = () => { if (!current || current.root !== root) return; card.classList.add('revealed'); current.timer = setTimeout(() => fadeOut(root), queue.length ? 1200 : 3800); };
    if (cfg.animate && !reduced && !document.hidden) { try { animate(canvas, item.payload, cfg, finish); } catch { canvas.remove(); finish(); } } else { canvas.remove(); finish(); }
  }
  function repeat(p) {
    if(p.program_use)return window.PROGRAM_USE?window.PROGRAM_USE(p.program_use):toast('Повторите действие на листе владельца: вся цепочка будет выполнена заново.');
    if (p.item_use) return window.ITEM_USE ? window.ITEM_USE(p.item_use) : toast('Повторите использование на листе владельца: ресурс будет списан там.');
    return submit(p.rolls ? { type: 'multi', label: p.label, gm_only: p.gm_only, rolls: p.rolls.map(r => ({ name: r.name, kind: r.kind, dtype: r.dtype, expr: r.base_expr || (r.doubled ? r.expr.replace(/(\d+)d/g, (_, n) => `${Number(n) / 2}d`) : r.expr) })) } : { type: 'roll', expr: p.expr, label: p.label, kind: p.kind, gm_only: p.gm_only });
  }
  // Lightweight projected solid meshes, gravity, rebounds, table friction and pairwise collisions.
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
  function animate(canvas, payload, cfg, done) {
    const ctx = canvas.getContext('2d'); if (!ctx) { done(); return; }
    const width = window.innerWidth, height = window.innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width=width*dpr; canvas.height=height*dpr; ctx.scale(dpr,dpr);
    const dice=[];
    for(const r of payload.rolls || [payload]) for(const p of r.parts || []) if(p.rolls) p.rolls.forEach((value,i)=>{
      if(dice.length>=36) return;
      const sides=p.sides || Number(p.term.match(/d(\d+)/)?.[1]) || 6, shape=mesh(sides);
      dice.push({value, sides, dropped:!keptIndices(p).includes(i), ...faceLabels(sides, shape.faces.length, value)});
    });
    if(!dice.length) { done(); return; }
    const radius=Math.max(17,Math.min(36,width/13)), floor=Math.max(120,height*.45);
    dice.forEach((d,i)=>Object.assign(d,{ x:width*.2+Math.random()*width*.6, y:floor-80+Math.random()*100, z:180+Math.random()*240+i*8,
      vx:(Math.random()-.5)*220, vy:(Math.random()-.5)*150, vz:0, angle:[Math.random()*6,Math.random()*6,Math.random()*6], spin:[Math.random()*5,Math.random()*5,Math.random()*5], settle:false }));
    let start, previous;
    const speed = Number(cfg.speed) === 2 ? 2 : 1;
    function frame(now) {
      start ??= now; previous ??= now;
      const elapsed=(now-start)*speed, dt=Math.min((now-previous)/1000,.035)*speed; previous=now;
      ctx.clearRect(0,0,width,height);
      for(const d of dice) {
        d.vz-=1100*dt; d.z+=d.vz*dt; d.x+=d.vx*dt; d.y+=d.vy*dt;
        if(d.z<0){d.z=0;d.vz=Math.abs(d.vz)>.9?-d.vz*.43:0;d.vx*=.82;d.vy*=.82;d.spin=d.spin.map(v=>v*.73);}
        if(d.x<radius||d.x>width-radius){d.vx*=-.7;d.x=Math.max(radius,Math.min(width-radius,d.x));}
        if(d.y<height*.18||d.y>height*.58){d.vy*=-.7;d.y=Math.max(height*.18,Math.min(height*.58,d.y));}
        d.angle=d.angle.map((a,i)=>a+d.spin[i]*dt);
        // Кубик остановился — доворачиваем к зрителю грань с выпавшим значением.
        if(!d.settle&&(elapsed>1500||(d.z<.5&&Math.abs(d.vz)<30&&Math.abs(d.vx)<40&&Math.abs(d.vy)<40)))d.settle=true;
        if(d.settle){
          d.spin=d.spin.map(v=>v*.8);
          const want=faceAngles(mesh(d.sides).normals[d.target],d.angle[2]);
          for(let axis=0;axis<2;axis++){
            let delta=(want[axis]-d.angle[axis])%(Math.PI*2);
            if(delta>Math.PI)delta-=Math.PI*2; else if(delta<-Math.PI)delta+=Math.PI*2;
            d.angle[axis]+=delta*Math.min(1,dt*6);
          }
        }
      }
      for(let i=0;i<dice.length;i++) for(let j=i+1;j<dice.length;j++) {
        const a=dice[i],b=dice[j],dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy);
        if(dist>0&&dist<radius*1.7&&Math.abs(a.z-b.z)<radius) {const push=(radius*1.7-dist)/2,nx=dx/dist,ny=dy/dist;a.x-=nx*push;b.x+=nx*push;a.y-=ny*push;b.y+=ny*push;const impulse=((b.vx-a.vx)*nx+(b.vy-a.vy)*ny)*.6;if(impulse<0){a.vx+=impulse*nx;a.vy+=impulse*ny;b.vx-=impulse*nx;b.vy-=impulse*ny;}}
      }
      for(const d of [...dice].sort((a,b)=>(a.y-a.z)-(b.y-b.z))) {
        ctx.fillStyle=`rgba(0,0,0,${.25/(1+d.z/90)})`;ctx.beginPath();ctx.ellipse(d.x,d.y+radius*.6,radius*(1+d.z/250),radius*.3,0,0,Math.PI*2);ctx.fill();
        const shape=mesh(d.sides), points=shape.v.map(p=>rotate(p,d.angle)), y=d.y-d.z;
        const faces=shape.faces.map((ids,i)=>({ids,i,z:ids.reduce((s,j)=>s+points[j][2],0)/ids.length,nz:rotate(shape.normals[i],d.angle)[2]})).sort((a,b)=>a.z-b.z);
        ctx.globalAlpha=d.dropped&&elapsed>1400?.4:1;
        const front=faces.reduce((best,f)=>f.nz>best.nz?f:best,faces[0]);
        ctx.textAlign='center';ctx.textBaseline='middle';
        for(const f of faces) {
          const pts=f.ids.map(id=>points[id]);
          ctx.beginPath();pts.forEach((p,i)=>{ctx[i?'lineTo':'moveTo'](d.x+p[0]*radius,y+p[1]*radius);});ctx.closePath();
          ctx.fillStyle=/^#[0-9a-f]{6}$/i.test(cfg.color)?cfg.color:'#a881e8';ctx.fill();ctx.fillStyle=`rgba(0,0,0,${Math.max(0,.38-f.z*.4)})`;ctx.fill();ctx.strokeStyle='rgba(255,255,255,.42)';ctx.lineWidth=1;ctx.stroke();
          // Цифры на гранях: видно только повёрнутые к зрителю; передняя — это результат.
          if(f.nz>.12){
            const cx=pts.reduce((s,p)=>s+p[0],0)/pts.length, cy=pts.reduce((s,p)=>s+p[1],0)/pts.length;
            const size=pts.reduce((s,p)=>s+Math.hypot(p[0]-cx,p[1]-cy),0)/pts.length;
            const isFront=f===front;
            ctx.font=`700 ${Math.max(7,Math.min(radius*.78,size*1.15))}px system-ui`;
            ctx.fillStyle=isFront?'#fff':`rgba(255,255,255,${.35+.45*f.nz})`;
            ctx.shadowColor='#111';ctx.shadowBlur=isFront?5:2;
            ctx.fillText(String(d.labels[f.i]),d.x+cx*radius,y+cy*radius);
            ctx.shadowBlur=0;
          }
        }
        ctx.font='10px system-ui';ctx.fillStyle='#eee';ctx.fillText('d'+d.sides,d.x,y+radius+10);ctx.globalAlpha=1;
      }
      if(elapsed<2200) animation=requestAnimationFrame(frame);else done();
    }
    animation=requestAnimationFrame(frame);
  }
  // ---------- постоянный интерфейс: слева — броски, справа — личный журнал ----------
  /// Бросок из дока: формула, модификатор и режим, как в панели стола.
  function dockRoll(expr, mode = 'normal', gm_only = false, label) {
    return submit({ type: 'roll', expr: withMode(expr, mode), gm_only, label: label || expr });
  }
  /// Нижний левый угол: всегда под рукой. Нижний правый: журнал этой вкладки.
  /// Возвращает false, если док уже установлен на странице.
  function dock(opts = {}) {
    if (document.querySelector('.dice-dock')) return false;
    const cfg = settings();
    const modInp = el('input', { type: 'text', placeholder: '+0', title: 'Модификатор, добавляется к броску', 'aria-label': 'Модификатор', style: 'width:54px' });
    const exprInp = el('input', { type: 'text', placeholder: '2d6+3, 4d6kh3…', title: 'Своя формула — Enter для броска', 'aria-label': 'Формула броска', style: 'width:132px' });
    const hidden = opts.gm ? el('input', { type: 'checkbox', style: 'width:auto', title: 'Скрытый бросок — видит только мастер' }) : null;
    let mode = 'normal';
    const modStr = () => { const m = modInp.value.trim(); if (!m || m === '+0' || m === '0') return ''; return /^[+-]/.test(m) ? m : '+' + m; };
    const rollExpr = (expr, label) => dockRoll(expr + modStr(), mode, !!hidden?.checked, (label || expr) + (modStr() ? ' ' + modStr() : ''));
    const die = d => {
      let expr = 'd' + d, label = 'к' + d;
      if (d === 20 && mode === 'adv') { expr = '2d20kh1'; label = 'к20 с преимуществом'; }
      else if (d === 20 && mode === 'dis') { expr = '2d20kl1'; label = 'к20 с помехой'; }
      rollExpr(expr, label);
    };
    const modeBtns = el('div', { class: 'seg' }, ...[['normal', 'Обычно'], ['adv', 'Преим.'], ['dis', 'Помеха']].map(([k, t]) => el('button', { class: 'small' + (k === 'normal' ? ' active' : ''), onclick: e => { mode = k; modeBtns.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, t)));
    exprInp.addEventListener('keydown', e => { if (e.key === 'Enter' && exprInp.value.trim()) { rollExpr(exprInp.value.trim()); exprInp.value = ''; } });
    const quick = el('div', { class: 'dice' }, ...[4, 6, 8, 10, 12, 20, 100].map(d => el('button', { title: `Бросить к${d} (Shift — дважды)`, onclick: e => { die(d); if (e.shiftKey) die(d); } }, 'к' + d)));
    const body = el('div', { class: 'dice-dock-body' }, quick,
      el('div', { class: 'row' }, modeBtns, modInp),
      el('div', { class: 'row' }, exprInp, el('button', { class: 'small primary', title: 'Бросить формулу', onclick: () => { if (exprInp.value.trim()) { rollExpr(exprInp.value.trim()); exprInp.value = ''; } } }, 'Бросить')),
      hidden ? el('label', { class: 'muted small' }, hidden, ' скрытый') : null);
    const toggle = el('button', { class: 'dice-dock-toggle', title: 'Кубики: свернуть / развернуть', 'aria-label': 'Кубики', onclick: () => { wrap.classList.toggle('min'); LS.setItem('dicetray_min', wrap.classList.contains('min') ? '1' : ''); } }, icon('dice', 16));
    const wrap = el('div', { class: 'dice-dock' + (LS.getItem('dicetray_min') ? ' min' : '') }, toggle, body);
    const log = el('button', { class: 'dice-log-button', title: 'Личный журнал бросков', onclick: openPanel },
      icon('book', 15), el('span', {}, 'Журнал'), history.length ? el('span', { class: 'dice-log-count' }, String(Math.min(history.length, 50))) : null);
    document.body.append(wrap, log);
    return true;
  }
  /// Журнал бросков этой вкладки: последние 50, повтор и настройки.
  function openPanel() {
    queue = []; dismiss();
    const cfg=settings(), expr=el('input',{value:'1d20',placeholder:'2d6+3','aria-label':'Формула броска'}), mode=el('select',{'aria-label':'Режим броска'},... [['normal','Обычно'],['adv','Преимущество'],['dis','Помеха']].map(([v,n])=>el('option',{value:v},n)));
    const hidden=el('input',{type:'checkbox'}), list=el('div',{class:'dice-history'});
    const refresh=()=>list.replaceChildren(...(history.length?history.map(h=>el('div',{class:'dice-history-entry'},el('small',{class:'muted'},h.at.toLocaleTimeString()+' · '+(h.meta.local?'Локально':h.meta.author||'Стол')),renderResult(h.payload),el('button',{class:'small',onclick:()=>repeat(h.payload)},'Повторить'))):[el('p',{class:'muted'},'Бросков пока не было. Кубики — в левом нижнем углу.')]));
    refresh();
    const run=()=>submit({type:'roll',expr:withMode(expr.value,mode.value),gm_only:hidden.checked});
    expr.addEventListener('keydown',e=>{if(e.key==='Enter')run();});
    const enabled=el('input',{type:'checkbox',checked:cfg.animate?'':null}), fast=el('input',{type:'checkbox',checked:cfg.speed===2?'':null}), color=el('input',{type:'color',value:cfg.color});
    const save=()=>LS.setItem('dice-settings',JSON.stringify({animate:enabled.checked,speed:fast.checked?2:1,color:color.value}));
    [enabled,fast,color].forEach(e=>e.addEventListener('change',save));
    const clear=el('button',{class:'small danger',onclick:()=>{history.length=0;document.querySelectorAll('.dice-log-count').forEach(n=>n.remove());refresh();}},'Очистить журнал');
    return modal('Журнал бросков · последние 50',el('div',{class:'dice-panel'},el('div',{class:'dice-quick'},...[4,6,8,10,12,20,100].map(d=>el('button',{onclick:()=>{expr.value='1d'+d;run();}},'d'+d))),el('div',{class:'row'},expr,mode,el('button',{class:'primary',onclick:run},'Бросить')),window.TABLE_CTX?.isGM?el('label',{},hidden,' Только мастеру (GM)'):null,el('div',{class:'dice-preferences'},el('label',{},enabled,' Анимация'),el('label',{},fast,' Быстро'),el('label',{},'Цвет ',color)),el('p',{class:'muted small'},'4d6kh3 — оставить три лучших. 2d20kl1 — помеха. Зачёркнутые кубики не учитываются. До 36 костей в анимации; все — в результате. Настройка уменьшения движения системы учитывается.'),el('div',{class:'row',style:'margin-top:12px'},el('h3',{style:'flex:1;margin:0'},'История этой вкладки'),el('button',{class:'small',onclick:refresh},'Обновить'),clear),list),[],{wide:true});
  }
  window.addEventListener?.('keydown', e => { if (e.key === 'Escape' && current) { queue = []; dismiss(); } });
  window.addEventListener?.('pagehide', () => { queue = []; dismiss(); pending.forEach(p => clearTimeout(p.timer)); pending.clear(); });
  function committed(message) { const target = host(); if (target?.DiceEngine) target.DiceEngine.receive(message); if (!target || window.parent === window) receive(message); }
  const button=()=>el('button',{class:'small',title:'Журнал бросков',onclick:openPanel},icon('dice',14),' Кубики');
  // mesh / rotate / faceLabels / faceAngles — чистая модель кубика: ей пользуется анимация и тесты.
  return { parse, evaluate, evaluateBatch, keptIndices, withMode, doubleDice, submit, receive, committed, present, renderResult, detail, button, dock, dockRoll, openPanel, dismiss, mesh, rotate, faceLabels, faceAngles };
})();
window.rollDice = (...args) => DiceEngine.evaluate(...args);
