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
    if (p.gm_only) box.append(el('small', { class: 'muted' }, 'Скрытый бросок · только мастер / локальный лист'));
    return box;
  }
  function present(payload, meta = {}) {
    // Retain immutable values for display/history; never use animation as RNG.
    const item = { payload: JSON.parse(JSON.stringify(payload)), meta, at: new Date() };
    history.unshift(item); history.splice(50);
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
  function playNext() {
    if (!queue.length) return;
    const item = queue.shift(), cfg = settings();
    const root = el('div', { class: 'dice-overlay' }), canvas = el('canvas', { class: 'dice-canvas', 'aria-hidden': 'true' });
    const card = el('section', { class: 'dice-toast', role: 'status', 'aria-live': 'polite' },
      el('div', { class: 'dice-toast-head' }, el('span', {}, (item.meta.local ? 'Локальный бросок' : item.meta.author || 'Бросок') + ' · ' + item.at.toLocaleTimeString()),
        el('button', { title: 'Закрыть результат', 'aria-label': 'Закрыть результат', onclick: dismiss }, '×')),
      renderResult(item.payload), el('div', { class: 'dice-toast-actions' }, el('button', { class: 'small', onclick: () => { const p = item.payload; dismiss(); repeat(p); } }, 'Бросить ещё'), el('button', { class: 'small', onclick: openPanel }, 'Журнал и кубики')));
    const pause = () => { if (current?.root === root) clearTimeout(current.timer); };
    const resume = () => { if (current?.root === root) current.timer = setTimeout(dismiss, 4500); };
    card.addEventListener('pointerenter', pause); card.addEventListener('pointerleave', resume);
    card.addEventListener('focusin', pause); card.addEventListener('focusout', resume);
    root.append(canvas, el('button', { class: 'dice-skip', title: 'Пропустить анимацию и закрыть результат', onclick: dismiss }, 'Пропустить ×'), card); document.body.append(root); current = { root, timer: null };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const finish = () => { if (!current || current.root !== root) return; card.classList.add('revealed'); current.timer = setTimeout(dismiss, queue.length ? 1400 : 4500); };
    if (cfg.animate && !reduced && !document.hidden) { try { animate(canvas, item.payload, cfg, finish); } catch { canvas.remove(); finish(); } } else { canvas.remove(); finish(); }
  }
  function repeat(p) {
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
    const faces = [], found = new Set();
    for (let a=0;a<v.length;a++) for(let b=a+1;b<v.length;b++) for(let c=b+1;c<v.length;c++) {
      let n = cross(sub(v[b],v[a]),sub(v[c],v[a])); if(Math.hypot(...n)<.001) continue; n=norm(n);
      const ds=v.map(p=>dot(n,sub(p,v[a]))); if(ds.some(d=>d>.001)&&ds.some(d=>d<-.001)) continue;
      if(dot(n,v[a])<0) n=n.map(x=>-x);
      const ids=ds.flatMap((d,i)=>Math.abs(d)<.001?[i]:[]), key=ids.join(','); if(found.has(key)) continue; found.add(key);
      const center=[0,1,2].map(k=>ids.reduce((sum,i)=>sum+v[i][k],0)/ids.length), u=norm(sub(v[ids[0]],center)), w=cross(n,u);
      ids.sort((i,j)=>Math.atan2(dot(sub(v[i],center),w),dot(sub(v[i],center),u))-Math.atan2(dot(sub(v[j],center),w),dot(sub(v[j],center),u)));
      faces.push(ids);
    }
    const scale=Math.max(...v.map(p=>Math.hypot(...p))); v=v.map(p=>p.map(x=>x/scale));
    const result={v,faces}; meshes.set(sides,result); return result;
  }
  function animate(canvas, payload, cfg, done) {
    const ctx = canvas.getContext('2d'); if (!ctx) { done(); return; }
    const width = window.innerWidth, height = window.innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width=width*dpr; canvas.height=height*dpr; ctx.scale(dpr,dpr);
    const dice=[];
    for(const r of payload.rolls || [payload]) for(const p of r.parts || []) if(p.rolls) p.rolls.forEach((value,i)=>{
      if(dice.length>=36) return;
      dice.push({value, sides:p.sides || Number(p.term.match(/d(\d+)/)?.[1]) || 6, dropped:!keptIndices(p).includes(i)});
    });
    if(!dice.length) { done(); return; }
    const radius=Math.max(17,Math.min(36,width/13)), floor=Math.max(120,height*.65);
    dice.forEach((d,i)=>Object.assign(d,{ x:width*.2+Math.random()*width*.6, y:floor-80+Math.random()*100, z:180+Math.random()*240+i*8,
      vx:(Math.random()-.5)*220, vy:(Math.random()-.5)*150, vz:0, angle:[Math.random()*6,Math.random()*6,Math.random()*6], spin:[Math.random()*5,Math.random()*5,Math.random()*5] }));
    const rotate=(p,a)=>{ let [x,y,z]=p; let c=Math.cos(a[0]),s=Math.sin(a[0]); [y,z]=[y*c-z*s,y*s+z*c]; c=Math.cos(a[1]);s=Math.sin(a[1]);[x,z]=[x*c+z*s,-x*s+z*c];c=Math.cos(a[2]);s=Math.sin(a[2]);return [x*c-y*s,x*s+y*c,z]; };
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
        if(d.y<height*.35||d.y>height*.78){d.vy*=-.7;d.y=Math.max(height*.35,Math.min(height*.78,d.y));}
        d.angle=d.angle.map((a,i)=>a+d.spin[i]*dt);
      }
      for(let i=0;i<dice.length;i++) for(let j=i+1;j<dice.length;j++) {
        const a=dice[i],b=dice[j],dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy);
        if(dist>0&&dist<radius*1.7&&Math.abs(a.z-b.z)<radius) {const push=(radius*1.7-dist)/2,nx=dx/dist,ny=dy/dist;a.x-=nx*push;b.x+=nx*push;a.y-=ny*push;b.y+=ny*push;const impulse=((b.vx-a.vx)*nx+(b.vy-a.vy)*ny)*.6;if(impulse<0){a.vx+=impulse*nx;a.vy+=impulse*ny;b.vx-=impulse*nx;b.vy-=impulse*ny;}}
      }
      for(const d of [...dice].sort((a,b)=>(a.y-a.z)-(b.y-b.z))) {
        ctx.fillStyle=`rgba(0,0,0,${.25/(1+d.z/90)})`;ctx.beginPath();ctx.ellipse(d.x,d.y+radius*.6,radius*(1+d.z/250),radius*.3,0,0,Math.PI*2);ctx.fill();
        const shape=mesh(d.sides), points=shape.v.map(p=>rotate(p,d.angle)), y=d.y-d.z;
        const faces=shape.faces.map(ids=>({ids,z:ids.reduce((s,i)=>s+points[i][2],0)/ids.length})).sort((a,b)=>a.z-b.z);
        ctx.globalAlpha=d.dropped&&elapsed>1400?.4:1;
        for(const f of faces) {
          ctx.beginPath();f.ids.forEach((id,i)=>{const p=points[id];ctx[i?'lineTo':'moveTo'](d.x+p[0]*radius,y+p[1]*radius);});ctx.closePath();
          ctx.fillStyle=/^#[0-9a-f]{6}$/i.test(cfg.color)?cfg.color:'#a881e8';ctx.fill();ctx.fillStyle=`rgba(0,0,0,${Math.max(0,.38-f.z*.4)})`;ctx.fill();ctx.strokeStyle='rgba(255,255,255,.42)';ctx.lineWidth=1;ctx.stroke();
        }
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`700 ${radius*.64}px system-ui`;ctx.fillStyle='#fff';ctx.shadowColor='#111';ctx.shadowBlur=5;ctx.fillText(String(d.value),d.x,y);ctx.shadowBlur=0;
        ctx.font='10px system-ui';ctx.fillStyle='#eee';ctx.fillText('d'+d.sides,d.x,y+radius+10);ctx.globalAlpha=1;
      }
      if(elapsed<2200) animation=requestAnimationFrame(frame);else done();
    }
    animation=requestAnimationFrame(frame);
  }
  function openPanel() {
    queue = []; dismiss();
    const cfg=settings(), expr=el('input',{value:'1d20',placeholder:'2d6+3','aria-label':'Формула броска'}), mode=el('select',{'aria-label':'Режим броска'},... [['normal','Обычно'],['adv','Преимущество'],['dis','Помеха']].map(([v,n])=>el('option',{value:v},n)));
    const hidden=el('input',{type:'checkbox'}), list=el('div',{class:'dice-history'});
    const refresh=()=>list.replaceChildren(...history.map(h=>el('div',{class:'dice-history-entry'},el('small',{class:'muted'},h.at.toLocaleTimeString()+' · '+(h.meta.local?'Локально':h.meta.author||'Стол')),renderResult(h.payload),el('button',{class:'small',onclick:()=>repeat(h.payload)},'Повторить'))));
    refresh();
    const run=()=>submit({type:'roll',expr:withMode(expr.value,mode.value),gm_only:hidden.checked});
    expr.addEventListener('keydown',e=>{if(e.key==='Enter')run();});
    const enabled=el('input',{type:'checkbox',checked:cfg.animate?'':null}), fast=el('input',{type:'checkbox',checked:cfg.speed===2?'':null}), color=el('input',{type:'color',value:cfg.color});
    const save=()=>LS.setItem('dice-settings',JSON.stringify({animate:enabled.checked,speed:fast.checked?2:1,color:color.value}));
    [enabled,fast,color].forEach(e=>e.addEventListener('change',save));
    return modal('Кубики · единый центр бросков',el('div',{class:'dice-panel'},el('div',{class:'dice-quick'},...[4,6,8,10,12,20,100].map(d=>el('button',{onclick:()=>{expr.value='1d'+d;run();}},'d'+d))),el('div',{class:'row'},expr,mode,el('button',{class:'primary',onclick:run},'Бросить')),el('label',{},hidden,' Только мастеру (на столе — для GM)'),el('div',{class:'dice-preferences'},el('label',{},enabled,' Анимация'),el('label',{},fast,' Быстро'),el('label',{},'Цвет ',color)),el('p',{class:'muted small'},'4d6kh3 — оставить три лучших. 2d20kl1 — помеха. Зачёркнутые кубики не учитываются. До 36 костей в анимации; все — в результате. Настройка уменьшения движения системы учитывается.'),el('h3',{},'Последние 50 бросков этой вкладки'),el('button',{class:'small',onclick:refresh},'Обновить журнал'),list),[],{wide:true});
  }
  window.addEventListener?.('keydown', e => { if (e.key === 'Escape' && current) { queue = []; dismiss(); } });
  window.addEventListener?.('pagehide', () => { queue = []; dismiss(); pending.forEach(p => clearTimeout(p.timer)); pending.clear(); });
  const button=()=>el('button',{class:'small',title:'Кубики, журнал и настройки',onclick:openPanel},icon('dice',14),' Кубики');
  return { parse, evaluate, evaluateBatch, keptIndices, withMode, doubleDice, submit, receive, present, renderResult, detail, button, openPanel, dismiss };
})();
window.rollDice = (...args) => DiceEngine.evaluate(...args);
