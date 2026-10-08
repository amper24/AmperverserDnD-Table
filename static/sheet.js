// ---------------------------------------------------------------------------
// sheet.js — страница листа персонажа (/sheet/:id): вкладки, блоки модулей,
// инвентарь и слоты, заклинания и ячейки, умения с механиками, заметки.
// Работает и отдельной страницей/окном, и встраиванием в стол (embed=1).
// Даёт: страницу; наружу ничего не экспортирует (только контекст листа).
// Зависимости: вся цепочка sheet.html (common → … → spell-rules).
// ---------------------------------------------------------------------------
// Лист персонажа. Работает и в iframe поверх стола (embed=1), и как отдельная страница/окно.
// Предметы и заклинания — модули (Modules.*): их можно перетаскивать между окнами, на стол и другим игрокам.
(async function () {
  const M = window.Modules;
  const app = document.getElementById('app');
  const id = location.pathname.split('/').pop();
  const embed = new URLSearchParams(location.search).get('embed') === '1';
  setTimeout(() => Consent.banner(), 300);
  let me; try { me = await API.get('/api/auth/me'); window.ME = me; } catch { app.innerHTML = '<div class="center"><div class="card">Нужно войти. <a href="/">На главную</a></div></div>'; return; }
  let ch; try { ch = await API.get('/api/characters/' + id); } catch (e) { app.innerHTML = `<div class="center"><div class="card">${e.message}</div></div>`; return; }
  let s = ch.sheet; let readonly = false;
  try { await API.patch('/api/characters/' + id, {}); } catch { readonly = true; }
  document.title = ch.name + ' — лист';
  let tab = LS.getItem('sheet_tab_' + id) || 'main';
  const ui = { invQ: '', invType: '', invFav: false, spellQ: '', spellLevel: '', onlyPrepared: false, spellFav: false, open: new Set(), headEdit: null };

  // ---- заметки «возле всего»: s.notes_by[key] = текст; кнопка-карандаш у любого блока ----
  function noteBtn(key, title) {
    const has = !!(s.notes_by[key] || '').trim();
    return el('button', { class: 'note-btn' + (has ? ' has' : ''), title: (has ? 'Заметка: ' + s.notes_by[key].slice(0, 200) : 'Добавить заметку') + (title ? ' — ' + title : ''), onclick: async e => {
      e.stopPropagation();
      const ta = el('textarea', { style: 'min-height:140px', disabled: dis() }, s.notes_by[key] || '');
      const ok = await modal('Заметка: ' + (title || key), el('div', {}, ta, el('p', { class: 'muted small' }, 'Работают кнопки бросков [[1d20+@prof]]{Проверка} и значения {{@dc}}.')),
        readonly ? [{ label: 'Закрыть', fn: () => false }] : [{ label: 'Удалить', cls: 'danger', fn: () => 'del' }, { label: 'Сохранить', cls: 'primary', fn: () => true }]);
      if (!ok) return;
      if (ok === 'del') delete s.notes_by[key]; else s.notes_by[key] = ta.value;
      save(); render();
    } }, icon('edit', 12));
  }
  /// Текст заметки под блоком (если есть).
  function noteLine(key) {
    const t = (s.notes_by[key] || '').trim();
    return t ? el('div', { class: 'note-line' }, M.rich(t, ctx(), { prefix: ch.name })) : null;
  }
  const h3n = (text, key) => el('h3', { class: 'h3n' }, el('span', { class: 'grow' }, text), noteBtn(key, text));

  // ---- миграция старых данных в модули ----
  /// Приводит лист к ожидаемым типам: старые записи и импорт могут содержать null вместо чисел, строк и списков.
  // ---------- Данные листа: нормализация, миграция, автосохранение ----------
  function normalizeSheet() {
    const num = (v, d) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d;
    const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    for (const k of ['name', 'race', 'class', 'subclass', 'background', 'alignment', 'notes', 'proficiencies']) if (typeof s[k] !== 'string') s[k] = s[k] === null || s[k] === undefined ? '' : String(s[k]);
    s.level = Math.min(20, Math.max(1, Math.round(num(s.level, 1)))); s.xp = num(s.xp, 0); s.ac = num(s.ac, 10); s.speed = num(s.speed, 30); s.initiative_bonus = num(s.initiative_bonus, 0);
    s.proficiency_bonus = num(s.proficiency_bonus, Math.ceil(1 + s.level / 4));
    if (s.classes !== undefined) { const list = Array.isArray(s.classes) ? s.classes.filter(c => c && typeof c === 'object' && String(c.name || '').trim() && Number(c.level) > 0) : []; if (list.length) s.classes = list; else delete s.classes; }
    s.abilities = obj(s.abilities); for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) s.abilities[k] = num(s.abilities[k], 10);
    s.hp = obj(s.hp); s.hp.max = num(s.hp.max, 10); s.hp.current = num(s.hp.current, s.hp.max); s.hp.temp = num(s.hp.temp, 0); if (typeof s.hp.hit_dice !== 'string' || !s.hp.hit_dice) s.hp.hit_dice = `${s.level}d8`; s.hp.hit_dice_used = obj(s.hp.hit_dice_used); for (const k of Object.keys(s.hp.hit_dice_used)) s.hp.hit_dice_used[k] = num(s.hp.hit_dice_used[k], 0);
    for (const k of ['skills', 'expertise', 'saving_throws', 'conditions', 'attacks', 'inventory', 'features']) if (!Array.isArray(s[k])) s[k] = [];
    s.death_saves = obj(s.death_saves); s.death_saves.success = num(s.death_saves.success, 0); s.death_saves.failure = num(s.death_saves.failure ?? s.death_saves.fail, 0); delete s.death_saves.fail;
    s.currency = obj(s.currency); for (const k of ['pp', 'gp', 'ep', 'sp', 'cp']) s.currency[k] = num(s.currency[k], 0);
    s.traits = obj(s.traits); s.notes_by = obj(s.notes_by);
    s.spells = obj(s.spells); if (!Array.isArray(s.spells.known)) s.spells.known = []; s.spells.slots = obj(s.spells.slots); if (typeof s.spells.ability !== 'string' || !s.spells.ability) s.spells.ability = s.spells.ability ? String(s.spells.ability) : 'int';
    for (const sl of Object.values(s.spells.slots)) { sl.max = Math.max(0, Math.min(20, Math.floor(num(sl.max, 0)))); sl.used = Math.max(0, Math.min(sl.max, Math.floor(num(sl.used, 0)))); }
    if (s.spells.pact_slots && typeof s.spells.pact_slots === 'object') { s.spells.pact_slots.max = Math.max(0, Math.min(20, Math.floor(num(s.spells.pact_slots.max, 0)))); s.spells.pact_slots.used = Math.max(0, Math.min(s.spells.pact_slots.max, Math.floor(num(s.spells.pact_slots.used, 0)))); s.spells.pact_slots.level = Math.max(1, Math.min(9, Math.floor(num(s.spells.pact_slots.level, 1)))); }
    s.inventory = s.inventory.filter(it => it && typeof it === 'object'); s.features = s.features.filter(f => f && typeof f === 'object'); s.spells.known = s.spells.known.filter(x => x && typeof x === 'object');
    for (const it of s.inventory) { it.qty = it.qty === null || it.qty === undefined ? undefined : num(it.qty, 1); if (it.uid) M.fillDefaults('item', it); if (it.name === null || it.name === '') it.name = 'Предмет'; }
    for (const f of s.features) if (f.uid) M.fillDefaults('feature', f);
    for (const x of s.spells.known) {
      if (x.uid) M.fillDefaults('spell', x);
      x.level = Math.max(0, Math.min(9, Math.floor(num(x.level, 0))));
      if (!['slot', 'free', 'uses'].includes(x.cast_cost)) x.cast_cost = null;
      x.use_cost = Math.max(1, Math.floor(num(x.use_cost, 1)));
      if (x.uses && typeof x.uses === 'object') { x.uses.max = Math.max(0, Math.floor(num(x.uses.max, 0))); x.uses.cur = Math.max(0, Math.min(x.uses.max, Math.floor(num(x.uses.cur, x.uses.max)))); }
    }
  }
  function migrate() {
    normalizeSheet();
    s.inventory ||= []; s.spells ||= { ability: 'int', slots: {}, known: [] }; s.spells.known ||= []; s.spells.slots ||= {}; s.features ||= []; s.attacks ||= []; s.notes_by ||= {}; s.currency ||= { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }; s.traits ||= {};
    s.inventory = Equipment.migrate(s.inventory.map(it => it.uid ? it : M.newItem({ ...it, type: it.type || 'gear' })));
    s.features=s.features.map(f=>f.uid?f:M.newFeature(f));
    s.spells.known = s.spells.known.map(sp => sp.uid ? sp : M.newSpell({ ...sp, actions: sp.actions || [] }));
  }
  migrate();

  let saveTimer, dirty = false, saving = null, inventoryBusy = false, pendingOperation = null, restBusy = false;
  const status = el('span', { class: 'muted', style: 'font-size:11px' });
  async function flush() {
    clearTimeout(saveTimer);
    if (saving) { await saving; if (!dirty) return true; }
    if (readonly || !dirty) return true;
    saving = (async () => {
      while (dirty) {
        dirty = false;
        const snapshot = JSON.parse(JSON.stringify(s));
        try {
          const fresh = await API.patch('/api/characters/' + id, { sheet: snapshot });
          if (fresh.revision !== (snapshot._revision || 0) + 1) {
            // Read-after-write may already include a concurrent inventory operation. Never
            // attach that newer revision to our older local inventory snapshot.
            s._revision = (snapshot._revision || 0) + 1;
            throw new Error('Лист обновлён параллельно. Нажмите «Обновить», чтобы получить актуальные ресурсы.');
          }
          s._revision = fresh.revision; ch.revision = fresh.revision; status.textContent = 'сохранено';
        } catch (e) { dirty = true; status.textContent = e.message; throw e; }
      }
      return true;
    })();
    try { return await saving; } finally { saving = null; }
  }
  function save(now) {
    dirty = true; status.textContent = '…'; clearTimeout(saveTimer);
    if (now) return flush();
    saveTimer = setTimeout(() => flush().catch(e => toast(e.message, 6000)), 400);
  }
  async function reload(force = false) {
    if (inventoryBusy || saving || (dirty && !force)) return;
    try { const fresh = await API.get('/api/characters/' + id); if (inventoryBusy || saving || (dirty && !force) || fresh.revision < (s._revision || 0)) return; clearTimeout(saveTimer); ch = fresh; s = fresh.sheet; dirty = false; migrate(); render(); } catch { }
  }
  window.addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'character_update' && (!e.data.id || e.data.id === id) && (!e.data.revision || e.data.revision > (s._revision || 0))) reload(); });
  // ---------- Операции инвентаря и механики умений ----------
  async function inventoryOp(operation, retry = false) {
    if (readonly || inventoryBusy) return;
    if (pendingOperation && !retry) return toast('Сначала повторите незавершённую операцию тем же запросом.');
    inventoryBusy = true; render();
    try {
      // Persist edits and legacy migration before using the authoritative item definition.
      if (!retry) { dirty = true; await flush(); pendingOperation = { ...operation, request_id: crypto.randomUUID() }; }
      const response = await API.post('/api/characters/' + id + '/inventory', pendingOperation);
      ch = response.character; s = ch.sheet; dirty = false; pendingOperation = null; migrate();
      const r = response.result;
      if (r.message) DiceEngine.committed(r.message);
      else if (r.rolls?.length && !response.replayed) DiceEngine.present(r, { local: true });
      if(r.effects?.length) toast(r.effects.map(e=>({heal:'Лечение',temp_hp:'Временные хиты',damage:'Урон',grant_item:'Выдано',condition:'Состояние',adjust:'Показатель',manual:'Правило подтверждено'}[e.kind]||e.kind)+(e.amount!==undefined?' · '+e.amount:'')+(e.name?' '+e.name:'')).join(' / '),6500);
      if (r.spent?.length) toast(r.spent.map(x => `${x.name}: −${x.amount} (осталось ${x.remaining})`).join(' · '));
      else toast(['use','program'].includes(operation?.op) ? 'Использовано · без расхода' : 'Инвентарь обновлён');
      return response;
    } catch (e) {
      if (e.status && e.status < 500) pendingOperation = null;
      toast(e.message, 6500); status.textContent = e.message; return null;
    } finally { inventoryBusy = false; render(); }
  }
  window.PROGRAM_USE = ref => {
    if(ref.character_id!==id)return toast('Откройте лист владельца.');
    const list=ref.source_kind==='item'?s.inventory:ref.source_kind==='spell'?s.spells.known:s.features;
    const doc=list.find(d=>d.uid===ref.source_uid),p=doc?.mechanics?.programs.find(p=>p.id===ref.program_id);
    if(!p)return toast('Действие больше недоступно.');return runProgram(doc,ref.source_kind,p,{mode:ref.mode,gm_only:ref.gm_only});
  };
  window.ITEM_USE = ref => ref.character_id === id ? inventoryOp({ op: 'use', item_uid: ref.item_uid, actions: ref.actions, mode: ref.mode, gm_only: ref.gm_only }) : toast('Используйте предмет на листе его владельца.');
  /// Действие из блоков: эффекты применяются владельцу листа, цель не выбирается —
  /// урон и состояния по другим персонажам применяет ДМ (на столе, через меню токена).
  async function runProgram(doc, kind, p, opts={}) {
    if(readonly||inventoryBusy) return;
    const manual=p.blocks.filter(b=>b.enabled!==false&&b.kind==='manual');
    if(manual.length){
      const yes=await modal(doc.name+' · '+p.name,el('div',{},...manual.map(b=>el('div',{class:'manual-rule'},el('b',{},'Вручную · подтвердите допустимость действия'),el('p',{},b.text))),el('p',{class:'muted small'},'Расход и эффекты применятся владельцу листа одной операцией. Урон, состояния и спасброски по другим персонажам не считаются автоматически — их применяет ДМ: действие даёт бросок и правило.')),[{label:'Подтвердить и применить',cls:'primary',fn:()=>true}]);
      if(!yes)return;
    }
    return await inventoryOp({op:'program',source_kind:kind,source_uid:doc.uid,program_id:p.id,target_id:id,acknowledged:manual.length>0,...opts});
  }
  const docActions=(doc,kind,context)=>M.actionButtons(doc,context||ctx(),`${ch.name}: ${doc.name}`,{disabled:readonly||inventoryBusy,onProgram:(p,opts)=>runProgram(doc,kind,p,opts)});
  const spellActions = (doc, context) => M.actionButtons(doc, context || ctx(), `${ch.name}: ${doc.name}`, { disabled: readonly || inventoryBusy, onUse: () => cast(doc), onProgram: () => cast(doc) });
  // У предмета на блоках старый op:'use' не работает (сервер его отклоняет): кнопки
  // «Попадание» и «Урон» просто бросают кубы, а расход и эффекты идут через действие целиком.
  const itemActions = it => M.actionButtons(it, ctx(), `${ch.name}: ${it.name}`, { onProgram:(p,opts)=>runProgram(it,'item',p,opts), item: true, disabled: readonly || inventoryBusy || !Equipment.canUse(it), onUse: it.mechanics ? undefined : (actions, opts) => inventoryOp({ op: 'use', item_uid: it.uid, actions, ...opts }) });
  // ---------- Экипировка: руки и доспех ----------
  function handPanel() {
    return el('div', { class: 'equipment-panel' }, handsSection(), acLine());
  }
  // Карточка доспеха использует тот же слот/визуальный компонент, что и руки.
  function armorSection() {
    const current = s.inventory.find(i => i.equipped && i.worn_slot === 'armor');
    const choices = s.inventory.filter(it => it.qty === 1 && Equipment.wornSlots(it.wear).includes('armor'));
    return el('div', { class: 'hand-slot armor-slot' + (current ? ' filled' : '') },
      el('label', {}, Equipment.slots.armor),
      el('strong', {}, current?.name || 'Пусто'),
      el('span', { class: 'muted small' }, current ? 'Надет на тело' : 'Защита тела'),
      !readonly && choices.length ? el('select', { 'aria-label': Equipment.slots.armor, onchange: e => {
        if (!e.target.value && current) return inventoryOp({ op: 'equip', item_uid: current.uid, slot: 'backpack' });
        if (e.target.value) inventoryOp({ op: 'equip', item_uid: e.target.value, slot: 'armor' });
      } }, el('option', { value: '', selected: !current ? '' : null }, '— Пусто —'), ...choices.map(it => el('option', { value: it.uid, selected: it.uid === current?.uid ? '' : null }, it.name))) : null);
  }
  // Из чего сложился КД (всегда считается от доспеха).
  function acLine() {
    const d = Equipment.armorClassParts(s);
    return el('div', { class: 'ac-line-wrap' }, el('p', { class: 'muted small ac-line' }, `КД ${d.ac} = ` + d.parts.map(([n, v], i) => i ? `${n} ${v >= 0 ? '+' : ''}${v}` : `${n} ${v}`).join(' · ')),
      ...d.notes.map(t => el('p', { class: 'small ac-warn' }, '⚠ ' + t)));
  }
  async function levelUp() {
    if (!window.LevelUp) return toast('Мастер повышения уровня не загружен.');
    await flush();
    const ok = await LevelUp.open({ sheet: s, campaignId: ch.campaign_id, onApply: () => { dirty = true; } });
    if (ok) { s.ac = Equipment.armorClass(s); save(); render(); } else if (dirty) { save(); }
  }
  function handsSection() {
    const occupied = key => s.inventory.find(i => i.equipped && (i.hand_slot === key || i.hand_slot === 'both'));
    return el('section', { class: 'equipment-hands', 'aria-label': 'Экипировка рук и доспеха' }, ...['main', 'off'].map(key => {
      const current = occupied(key);
      const choices = s.inventory.filter(it => it.qty === 1 && it.handedness !== 'none' && Equipment.canEquip(it));
      return el('div', { class: 'hand-slot' + (current ? ' filled' : '') }, el('label', {}, Equipment.slots[key]),
        el('strong', {}, current?.name || 'Свободна'), el('span', { class: 'muted small' }, current?.hand_slot === 'both' ? 'Один предмет занимает обе руки' : current ? Equipment.kinds[current.handedness] : 'Оружие, щит или предмет'),
        readonly ? null : el('select', { 'aria-label': Equipment.slots[key], onchange: e => {
          if (!e.target.value && current) return inventoryOp({ op: 'equip', item_uid: current.uid, slot: 'backpack' });
          const it = s.inventory.find(i => i.uid === e.target.value); if (it) inventoryOp({ op: 'equip', item_uid: it.uid, slot: it.handedness === 'two' ? 'both' : key });
        } }, el('option', { value: '', selected: !current ? '' : null }, '— Свободна —'), ...choices.map(it => el('option', { value: it.uid, selected: it.uid === current?.uid ? '' : null }, it.name + (it.handedness === 'two' ? ' · 2 руки' : '')))));
    }), armorSection());
  }

  const prof = () => s.proficiency_bonus || Math.ceil(1 + (s.level || 1) / 4);
  const abMod = (k) => mod(s.abilities[k]);
  const skillVal = (k, ab) => abMod(ab) + (s.expertise.includes(k) ? 2 : s.skills.includes(k) ? 1 : 0) * prof();
  const saveVal = (k) => abMod(k) + (s.saving_throws.includes(k) ? prof() : 0);
  const passive = () => 10 + skillVal('perception', 'wis');
  const ctx = () => { const c = M.ctxFromSheet(s); window.SHEET_CTX = c; window.SHEET_EDITION = s.edition || '2014'; return c; };
  function roll(expr, label, event, kind = 'check', modeOverride = null) {
    const options = { ctx: ctx(), kind, ...M.modeFromEvent(event) };
    if (modeOverride) options.mode = modeOverride;
    M.roll(expr, `${ch.name}: ${label}`, options);
  }
  let activeRollModeMenu = null, rollModeMenuCleanup = null;
  function closeRollModeMenu() {
    rollModeMenuCleanup?.(); rollModeMenuCleanup = null;
    activeRollModeMenu?.remove(); activeRollModeMenu = null;
  }
  function openRollModeMenu(event, expr, label, kind = 'check') {
    // Keep native text-editing and note-button context menus intact.
    if (event.target.closest?.('button, input, select, textarea')) return;
    event.preventDefault(); event.stopPropagation();
    closeRollModeMenu();
    const menu = el('div', { class: 'roll-mode-menu', role: 'menu', 'aria-label': `Режим броска: ${label}` });
    const modes = [['normal', 'Обычный бросок'], ['dis', 'С помехой'], ['adv', 'С преимуществом']];
    for (const [mode, text] of modes) menu.append(el('button', {
      type: 'button', class: 'roll-mode-option' + (mode === 'normal' ? ' normal' : ''), role: 'menuitem',
      onclick: () => { closeRollModeMenu(); roll(expr, label, null, kind, mode); }
    }, text));
    document.body.append(menu);
    activeRollModeMenu = menu;
    const margin = 8, rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin))}px`;
    const onOutsidePointerDown = e => { if (!menu.contains(e.target)) closeRollModeMenu(); };
    const onKeyDown = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRollModeMenu(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const buttons = [...menu.querySelectorAll('[role="menuitem"]')], current = buttons.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      e.preventDefault(); buttons[next]?.focus();
    };
    const cleanup = () => {
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', closeRollModeMenu);
      window.removeEventListener('scroll', closeRollModeMenu, true);
    };
    rollModeMenuCleanup = cleanup;
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', closeRollModeMenu);
    window.addEventListener('scroll', closeRollModeMenu, true);
    menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  }
  const dis = () => readonly ? '' : null;

  // ---- отправка в чат / на карту / другому персонажу ----
  function sendCard(doc, kind) { M.sendCard({ ...M.toChatCard(doc, kind), owner: ch.name, ...(kind === 'item' ? { item_ref: { character_id: id, uid: doc.uid } } : {}) }); toast('Отправлено в чат'); }
  async function transfer(it) {
    if (!ch.campaign_id) return toast('Персонаж не в кампании');
    const chars = (await API.get('/api/characters?campaign_id=' + ch.campaign_id)).filter(c => c.id !== id);
    if (!chars.length) return toast('Некому передать');
    const sel = el('select', {}, ...chars.map(c => el('option', { value: c.id }, c.name + (c.owner_name ? ` (${c.owner_name})` : ''))));
    const qty = el('input', { type: 'number', value: it.qty ?? 1, min: 1, max: it.qty ?? 1 });
    const ok = await modal(`Передать «${it.name}»`, el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Кому'), sel), it.qty > 1 ? el('div', { class: 'field' }, el('label', {}, 'Сколько'), qty) : null), [{ label: 'Передать', cls: 'primary', fn: () => ({ to: sel.value, qty: +qty.value }) }]);
    if (!ok) return;
    try { await save(true); await API.post(`/api/characters/${id}/transfer`, { item_uid: it.uid, to_character_id: ok.to, qty: ok.qty }); toast('Передано'); reload(); } catch (e) { toast('Ошибка: ' + e.message); }
  }
  async function dropToMap(it) {
    const target = window.parent !== window ? window.parent : (window.opener && !window.opener.closed ? window.opener : null);
    try { if (!target || target.location.origin !== location.origin || !target.TABLE_CTX) return toast('Стол не открыт'); } catch { return toast('Стол не открыт'); }
    try { await save(true); target.postMessage({ type: 'loot_drop', item: it, from_character_id: id }, location.origin); }
    catch (e) { toast(e.message); }
  }

  // ================= РЕНДЕР =================
  function render() {
    Equipment.migrate(s.inventory);
    s.ac = Equipment.armorClass(s);
    ctx();
    app.innerHTML = '';
    const root = el('div', { class: 'sheet' });
    root.inert = inventoryBusy;
    if (inventoryBusy) status.textContent = 'Сохраняем операцию…';
    root.append(topBar());
    if (pendingOperation && !inventoryBusy) root.append(el('div', { class: 'inventory-warning' }, 'Ответ не получен. Повтор использует тот же ID и не спишет ресурс дважды.', el('button', { onclick: () => inventoryOp(pendingOperation, true) }, 'Повторить запрос')));
    const tabs = [['main', 'Основное'], ['inv', `Инвентарь (${s.inventory.length})`], ['spells', `Заклинания (${s.spells.known.length})`], ['feats', `Умения (${s.features.length})`], ['notes', 'Заметки']];
    root.append(el('div', { class: 'tabs sheet-tabs' }, ...tabs.map(([k, n]) => el('button', { class: tab === k ? 'active' : '', onclick: () => { tab = k; LS.setItem('sheet_tab_' + id, k); render(); } }, n))));
    root.append({ main: mainTab, inv: invTab, spells: spellsTab, feats: featsTab, notes: notesTab }[tab]());
    app.append(root);
    // Кубики — док в левом нижнем углу, журнал бросков — в правом (ставится один раз).
    DiceEngine.dock();
    if (!readonly) bindDrops(root);
  }

  function hitDiceCounts() {
    const counts = {}, limit = Math.max(1, Math.min(20, Number(s.level) || 1));
    let total = 0;
    for (const match of String(s.hp.hit_dice || '').matchAll(/(\d+)d(\d+)/gi)) {
      const die = Number(match[2]), count = Math.max(0, Number(match[1]) || 0);
      if (!Number.isSafeInteger(die) || die < 1 || total >= limit) continue;
      const accepted = Math.min(count, limit - total);
      counts[die] = (counts[die] || 0) + accepted; total += accepted;
    }
    return counts;
  }
  async function shortRest() {
    if (readonly || inventoryBusy || restBusy) return;
    restBusy = true;
    try {
    const counts = hitDiceCounts(), used = s.hp.hit_dice_used || {}, available = Object.entries(counts).map(([die, max]) => [Number(die), Math.max(0, max - (Number(used[die]) || 0))]).filter(([, n]) => n > 0);
    let spend = null;
    if (available.length && s.hp.current < s.hp.max) {
      const die = el('select', {}, ...available.map(([size, n]) => el('option', { value: size }, `d${size} · доступно ${n}`)));
      const count = el('input', { type: 'number', min: 1, max: available[0][1], value: 1, style: 'width:80px' });
      const rolled = el('input', { type: 'number', min: 0, value: '', placeholder: 'итог лечения', style: 'width:100%' });
      const formula = el('p', { class: 'muted small' });
      const update = () => { const size = +die.value, max = Math.min(20, available.find(x => x[0] === size)?.[1] || 1); count.max = max; count.value = Math.min(max, Math.max(1, Math.floor(+count.value) || 1)); formula.textContent = `Бросок: ${count.value}d${size}, затем добавьте ${count.value} × мод. Телосложения (${fmtMod(abMod('con'))}).` + (rolled.value ? ` Результат: ${rolled.value}.` : ''); };
      const rollHitDice = () => {
        const size = +die.value, availableCount = available.find(x => x[0] === size)?.[1] || 0;
        const n = Math.min(20, availableCount, Math.max(0, Math.floor(Number(count.value) || 0)));
        if (!Number.isInteger(size) || size < 1 || size > 100 || n < 1) return toast('Укажите допустимое число доступных костей хитов.', 3000);
        count.value = String(n);
        const con = abMod('con'), values = Array.from({ length: n }, () => DiceEngine.evaluate(`1d${size}`).total);
        const results = values.map((value, index) => { const healing = Math.max(0, value + con); const parts = [{ term: `1d${size}`, sides: size, rolls: [value], kept: [value], kept_indices: [0] }]; if (con) parts.push({ term: con > 0 ? `+${con}` : String(con), value: con }); return { name: `Кость хитов ${index + 1}`, expr: `1d${size}${fmtMod(con)}`, total: healing, kind: 'heal', parts }; });
        rolled.value = String(results.reduce((sum, item) => sum + item.total, 0));
        DiceEngine.present({ type: 'multi', kind: 'multi', label: `${ch.name}: короткий отдых`, rolls: results }, { local: true }); update();
      };
      die.addEventListener('change', update); count.addEventListener('input', update); update();
      const picked = await modal('Короткий отдых · кости хитов', el('div', {}, el('p', { class: 'muted small' }, 'Выберите тип и количество костей. Можно бросить их здесь или ввести результат своего броска; кость хитов спишется после подтверждения.'), el('div', { class: 'row' }, el('label', {}, 'Кость', die), el('label', {}, 'Сколько', count), el('button', { class: 'small', type: 'button', onclick: rollHitDice }, 'Бросить')), formula, el('label', { class: 'field' }, 'Итог лечения', rolled)), [{ label: 'Отдохнуть', cls: 'primary', fn: () => ({ die: +die.value, count: +count.value, healing: +rolled.value }) }], { wide: true });
      if (picked === null) return;
      const max = available.find(x => x[0] === picked.die)?.[1] || 0, con = abMod('con');
      const minHeal = picked.count * Math.max(0, 1 + con), maxHeal = picked.count * Math.max(0, picked.die + con);
      if (!Number.isInteger(picked.count) || picked.count < 1 || picked.count > max || !Number.isInteger(picked.healing) || picked.healing < minHeal || picked.healing > maxHeal) return toast(`Проверьте количество костей и лечение (${minHeal}–${maxHeal}).`, 4000);
      spend = picked;
    } else {
      const yes = await modal('Короткий отдых', el('p', { class: 'muted small' }, 'Восстановятся умения с восстановлением после короткого отдыха и ячейки Магии договора. Обычные ячейки не восстановятся.'), [{ label: 'Завершить отдых', cls: 'primary', fn: () => true }]); if (yes === null) return;
    }
    if (spend) {
      const spentDice = SpellRules.spendHitDice(s.hp.hit_dice_used || {}, counts, spend.die, spend.count);
      if (!spentDice.ok) return toast(spentDice.reason, 4000);
      s.hp.hit_dice_used = spentDice.used;
      s.hp.current = Math.min(s.hp.max, s.hp.current + spend.healing);
    }
    const restored = SpellRules.restore(s.spells, s.features, 'short');
    save(); render();
    const details = [spend && `${spend.count}d${spend.die}: +${spend.healing} хитов`, restored.pactSlots && 'восстановлены ячейки Договора', restored.features && `восстановлены умения (${restored.features})`, restored.spellUses && `заряды заклинаний (${restored.spellUses})`].filter(Boolean);
    toast('Короткий отдых завершён' + (details.length ? ': ' + details.join(' · ') : '.'), 4500);
    } finally { restBusy = false; }
  }
  async function longRest() {
    if (readonly || inventoryBusy || restBusy) return;
    restBusy = true;
    try {
    const yes = await modal('Долгий отдых', el('p', { class: 'muted small' }, 'Восстановятся хиты, все ячейки и умения с восстановлением после короткого или долгого отдыха. Вернётся количество потраченных костей хитов до половины общего запаса (округление вниз, минимум одна).'), [{ label: 'Завершить отдых', cls: 'primary', fn: () => true }]); if (yes === null) return;
    const restored = SpellRules.restore(s.spells, s.features, 'long');
    const recoveredDice = SpellRules.recoverHitDice(s.hp.hit_dice_used || {}, hitDiceCounts());
    s.hp.hit_dice_used = recoveredDice.used; s.hp.current = s.hp.max;
    s.death_saves = { success: 0, failure: 0 };
    save(); render();
    toast(`Долгий отдых завершён: хиты восстановлены${restored.slots || restored.pactSlots ? ', ячейки восстановлены' : ''}${restored.features ? `, умения: ${restored.features}` : ''}${restored.spellUses ? `, заряды заклинаний: ${restored.spellUses}` : ''}.`, 4500);
    } finally { restBusy = false; }
  }
  function topBar() {
    const portrait = el('div', { class: 'portrait', title: 'Загрузить портрет' }, icon('user', 40));
    if (ch.portrait_asset_id) assetURL(ch.portrait_asset_id).then(u => { portrait.innerHTML = ''; portrait.append(el('img', { src: u })); });
    const pf = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    pf.addEventListener('change', async () => {
      if (!pf.files[0] || readonly || inventoryBusy) return;
      inventoryBusy = true; render();
      try {
        const fd = new FormData(); fd.append('file', pf.files[0]); fd.append('name', ch.name); fd.append('kind', 'portrait'); if (ch.campaign_id) fd.append('campaign_id', ch.campaign_id);
        const a = await API.upload('/api/assets', fd); await flush();
        ch = await API.patch('/api/characters/' + id, { portrait_asset_id: a.id }); s = ch.sheet; dirty = false; migrate();
      } catch (e) { toast(e.message); } finally { inventoryBusy = false; render(); }
    });
    if (!readonly) portrait.addEventListener('click', () => pf.click());
    const tokenPick = readonly ? null : M.imagePicker(s, 'token_asset_id', { kind: 'token', label: 'Токен на карте', icon: 'user', compact: true, onChange: () => save() });
    const inp = (key, ph, type = 'text') => el('input', { value: s[key] ?? '', placeholder: ph, type, disabled: dis(), onchange: e => { s[key] = type === 'number' ? +e.target.value : e.target.value; if (key === 'level') s.proficiency_bonus = Math.ceil(1 + s.level / 4); save(); if (['level', 'name'].includes(key)) render(); } });
    const moduleOf = category => (s.modules || []).slice().reverse().find(m => m.category === category && m.snapshot);
    /// Список или строка → массив строк: языки, инструменты и навыки в записях бывают в обоих видах.
    const asList = value => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()) : typeof value === 'string' && value.trim() ? [value] : [];
    const skillLabel = name => (SKILLS.find(([k, n]) => k === name || n.toLowerCase() === String(name).toLowerCase()) || [])[1] || name;
    /// Компактный блок в шапке листа: раса, класс, подкласс, предыстория, мировоззрение.
    const headBlock = (cat, o) => el('div', { class: 'dropslot mod-block' + (o.filled ? ' filled' : ''), 'data-cat': cat || null, role: 'group', 'aria-label': 'Блок: ' + o.label, title: o.hint || '' },
      el('span', { class: 'mod-block-head' }, el('b', {}, o.label), cat ? el('span', { class: 'mod-block-drop', 'aria-hidden': 'true' }, '⤓') : null),
      o.control || (o.value ? el('strong', { class: 'mod-block-name' }, o.value) : el('span', { class: 'mod-block-empty' }, o.empty || 'Не выбрано')),
      o.facts ? el('small', { class: 'mod-block-facts', title: o.factsTitle || o.facts }, o.facts) : null,
      o.note ? el('small', { class: 'mod-block-note' }, o.note) : null);
    const alignmentOptions = window.CharacterBuilder?.ALIGNMENTS || ['', 'Законно-доброе', 'Нейтрально-доброе', 'Хаотично-доброе', 'Законно-нейтральное', 'Нейтральное', 'Хаотично-нейтральное', 'Законно-злое', 'Нейтрально-злое', 'Хаотично-злое', 'Без мировоззрения'];
    const raceModule = moduleOf('race'), classModule = moduleOf('class'), bgModule = moduleOf('background');
    const raceData = raceModule?.snapshot?.data || {}, classData = classModule?.snapshot?.data || {}, bgData = bgModule?.snapshot?.data || {};
    const raceFacts = [raceData.speed && `скорость ${raceData.speed} фт.`, asList(raceData.languages).slice(0, 2).join(', ')].filter(Boolean).join(' · ');
    const classFacts = [`уровень ${s.level || 1}`, classData.hit_die && `кость хитов ${classData.hit_die}`, asList(classData.saves).length ? 'спасброски: ' + asList(classData.saves).map(k => ABIL[k] || k).join(', ') : ''].filter(Boolean).join(' · ');
    const bgSkills = asList(bgData.skills).map(skillLabel), bgTools = asList(bgData.tools);
    const bgFacts = [bgSkills.length ? 'навыки: ' + bgSkills.join(', ') : '', bgTools.length ? '+ инструменты: ' + bgTools.join(', ') : ''].filter(Boolean).join(' · ');
    /// Блоки шапки: раса, класс, подкласс, предыстория и мировоззрение выглядят одинаково —
    /// компактный блок с текстом, как у «Расы». Клик по тексту открывает правку прямо в блоке.
    const headText = (key, value, empty) => el(value ? 'strong' : 'span',
      { class: (value ? 'mod-block-name' : 'mod-block-empty') + (readonly ? '' : ' editable'),
        title: readonly ? (value || '') : value ? `${value} · клик — изменить` : 'Клик — вписать',
        onclick: readonly ? null : e => { e.stopPropagation(); ui.headEdit = key; render(); } }, value || empty);
    const closeEdit = () => { ui.headEdit = null; render(); };
    const editInput = (key, get, set, placeholder, listId) => {
      const commit = () => { ui.headEdit = null; render(); };
      const input = el('input', { class: 'mod-block-input', list: listId || null, value: get(), placeholder, 'aria-label': placeholder, disabled: dis(), onclick: e => e.stopPropagation(),
        onchange: e => { set(e.target.value); save(); commit(); }, onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); commit(); } } });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return input;
    };
    const classControl = () => ui.headEdit === 'class' ? editInput('class', () => s.class, v => s.class = v, 'перетащите или впишите') : headText('class', s.class, 'перетащите или кликните');
    const subclassNames = asList(classData.subclasses), subclassListId = 'subclass-options-' + id;
    const subclassControl = () => {
      if (ui.headEdit !== 'subclass') return headText('subclass', s.subclass, 'кликните или повысьте уровень');
      return el('span', { class: 'mod-block-field' }, editInput('subclass', () => s.subclass, v => s.subclass = v, 'из класса или своё', subclassNames.length ? subclassListId : null),
        subclassNames.length ? el('datalist', { id: subclassListId }, ...subclassNames.map(n => el('option', { value: n }))) : null);
    };
    const backgroundControl = () => ui.headEdit === 'background' ? editInput('background', () => s.background, v => s.background = v, 'перетащите или впишите') : headText('background', s.background, 'перетащите или кликните');
    const alignmentControl = () => {
      if (ui.headEdit !== 'alignment') return headText('alignment', s.alignment, 'кликните — выберите');
      const sel = el('select', { class: 'mod-block-select', 'aria-label': 'Мировоззрение', disabled: dis(), onclick: e => e.stopPropagation(),
        onchange: e => { s.alignment = e.target.value; save(); closeEdit(); }, onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); closeEdit(); } } },
        ...(!alignmentOptions.includes(s.alignment || '') ? [el('option', { value: s.alignment, selected: '' }, 'Текущее: ' + s.alignment)] : []),
        ...alignmentOptions.map(value => el('option', { value, selected: (s.alignment || '') === value ? '' : null }, value || 'Не выбрано')));
      setTimeout(() => { try { sel.showPicker?.(); } catch { sel.focus(); } }, 0);
      return sel;
    };
    const blocks = el('div', { class: 'sheet-head-blocks' },
      headBlock('race', { label: 'Раса', filled: !!s.race, value: s.race, empty: 'перетащите блок',
        facts: raceFacts, note: raceModule ? '' : s.race ? 'старая запись без связи с модулем' : 'подключается блоком из справочника',
        hint: raceModule ? `Раса — снимок модуля (${raceModule.source || raceModule.snapshot.source || 'справочник'}). Перетащите другой блок расы, чтобы заменить.` : 'Раса подключается блоком из справочника: перетащите запись расы на этот блок.' }),
      headBlock('class', { label: 'Класс', filled: !!s.class, control: classControl(),
        facts: classFacts, note: s.class ? '' : 'блок справочника или своё название',
        hint: classModule ? `Класс — снимок модуля (${classModule.source || 'справочник'}). Перетащите запись, чтобы заменить, или кликните, чтобы вписать своё.` : 'Перетащите блок класса из справочника или кликните, чтобы вписать название.' }),
      headBlock(null, { label: 'Подкласс', filled: !!s.subclass, control: subclassControl(),
        facts: subclassNames.length ? `в классе: ${subclassNames.slice(0, 3).join(', ')}${subclassNames.length > 3 ? '…' : ''}` : '',
        hint: 'Подкласс появляется на 2–3 уровне класса: кликните и выберите из списка класса или впишите свой вариант.' }),
      headBlock('background', { label: 'Предыстория', filled: !!s.background, control: backgroundControl(),
        facts: bgFacts, factsTitle: bgFacts, note: s.background ? '' : 'блок справочника или своё название',
        hint: bgModule ? `Предыстория — снимок модуля (${bgModule.source || 'справочник'}): даёт навыки, инструменты и снаряжение.` : 'Перетащите блок предыстории из справочника или кликните, чтобы вписать название.' }),
      headBlock(null, { label: 'Мировоззрение', filled: !!s.alignment, control: alignmentControl(), hint: 'Мировоззрение влияет только на отыгрыш: кликните и выберите из списка.' }));
    const head = el('div', { class: 'head' }, portrait, el('div', {},
      el('div', { class: 'row', style: 'margin-bottom:6px' },
        el('div', { style: 'flex:2' }, el('label', {}, 'Имя'), inp('name', 'Имя персонажа')),
        el('div', { class: 'level-cell' }, el('label', {}, 'Уровень'), el('div', { class: 'level-value-row' },
          inp('level', '1', 'number'),
          readonly || (s.level || 1) >= 20 ? null : el('button', { class: 'lvlup-btn', type: 'button', 'aria-label': 'Повысить уровень', title: 'Мастер повышения уровня: здоровье, умения, подкласс, характеристики, заклинания', onclick: levelUp }, '+1'))),
        el('div', {}, el('label', {}, 'Опыт'), inp('xp', '0', 'number'))),
      blocks));
    const bar = el('div', { class: 'row', style: 'margin-bottom:6px' }, el('h1', { style: 'flex:1' }, ch.name), status,
      embed ? el('button', { class: 'small', style: 'flex:0', onclick: () => window.open(withTok('/sheet/' + id), 'sheet_' + id, 'width=1000,height=800') }, 'В окно') : null,
      el('button', { class: 'small', style: 'flex:0', onclick: () => toggleComp() }, 'Справочник'),
      readonly ? el('span', { class: 'badge', title: 'Редакция правил' }, EDITIONS[s.edition || '2014']) : el('select', { class: 'small', style: 'flex:0;width:auto', title: 'Редакция правил: влияет на набор записей справочника и порядок создания персонажа', onchange: e => { s.edition = e.target.value; save(); if (compEl) { toggleComp(); } render(); } }, ...Object.entries(EDITIONS).map(([k, v]) => el('option', { value: k, selected: (s.edition || '2014') === k ? '' : null }, v))),
      tokenPick,
      el('button', { class: 'small', onclick: () => { if (!dirty || confirm('Отбросить несохранённые изменения и загрузить актуальный лист?')) reload(true); } }, 'Обновить'),
      embed ? null : Theme.button(),
      readonly ? el('span', { class: 'badge' }, 'только чтение') : el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: s.shared ? '' : null, onchange: e => { s.shared = e.target.checked; save(); } }), ' виден игрокам'));
    return el('div', {}, bar, head);
  }

  // ---------- вкладка Основное ----------
  function mainTab() {
    const root = el('div', { class: 'sheet-main-view' });
    const cols = el('div', { class: 'cols sheet-main' });
    const restActions = readonly ? null : el('div', { class: 'rest-actions' },
      el('button', { class: 'rest-action', type: 'button', title: 'Восстановить умения короткого отдыха и потратить кости хитов', onclick: shortRest }, 'Короткий отдых'),
      el('button', { class: 'rest-action primary', type: 'button', title: 'Восстановить хиты, ячейки, умения и часть костей хитов', onclick: longRest }, 'Долгий отдых'));
    root.append(el('section', { class: 'card rest-panel', 'aria-label': 'Отдых персонажа' },
      el('div', { class: 'rest-panel-copy' }, el('h3', {}, 'Отдых'), el('p', { class: 'muted small' }, 'Короткий: кости хитов и способности. Долгий: хиты, ячейки и восстановление ресурсов.')),
      restActions));
    const c1 = el('div', { class: 'sheet-proficiencies' });
    const abil = el('div', { class: 'abil' });
    for (const [k, name] of Object.entries(ABIL)) {
      abil.append(el('div', { class: 'ab', title: 'Клик — проверка · Alt — преимущество · Ctrl — помеха · Shift — скрытый бросок GM · ПКМ — выбрать режим броска',
        onclick: e => { if (e.target.tagName !== 'INPUT') roll('d20' + fmtMod(abMod(k)), 'проверка ' + name, e); },
        oncontextmenu: e => openRollModeMenu(e, 'd20' + fmtMod(abMod(k)), 'проверка ' + name) },
        el('small', {}, name, ' ', noteBtn('ab:' + k, name)), el('div', { class: 'mod' }, fmtMod(abMod(k))), el('input', { type: 'number', value: s.abilities[k], disabled: dis(), onchange: ev => { s.abilities[k] = +ev.target.value; save(); render(); }, onclick: ev => ev.stopPropagation() })));
    }
    c1.append(abil);
    c1.append(el('div', { class: 'card', style: 'margin-top:8px' }, h3n('Спасброски', 'saves'), noteLine('saves'), el('div', { class: 'skills' }, ...Object.entries(ABIL).map(([k, name]) => el('div', {
      title: 'Клик — бросок · ПКМ — выбрать режим броска',
      onclick: e => { if (e.target.classList.contains('pip')) return; roll('d20' + fmtMod(saveVal(k)), 'спасбросок ' + name, e); },
      oncontextmenu: e => openRollModeMenu(e, 'd20' + fmtMod(saveVal(k)), 'спасбросок ' + name)
    }, el('span', { class: 'pip' + (s.saving_throws.includes(k) ? ' on' : ''), onclick: () => { if (readonly) return; s.saving_throws = s.saving_throws.includes(k) ? s.saving_throws.filter(x => x !== k) : [...s.saving_throws, k]; save(); render(); } }), el('span', { class: 'val' }, fmtMod(saveVal(k))), name)))));
    c1.append(el('div', { class: 'card', style: 'margin-top:8px' }, h3n('Навыки', 'skills'), noteLine('skills'), el('div', { class: 'skills' }, ...SKILLS.map(([k, name, ab]) => el('div', {
      title: 'Клик — бросок · ПКМ — выбрать режим броска',
      onclick: e => { if (e.target.classList.contains('pip')) return; roll('d20' + fmtMod(skillVal(k, ab)), name, e); },
      oncontextmenu: e => openRollModeMenu(e, 'd20' + fmtMod(skillVal(k, ab)), name)
    },
      el('span', { class: 'pip' + (s.expertise.includes(k) ? ' exp' : s.skills.includes(k) ? ' on' : ''), title: 'клик: нет → владение → компетентность', onclick: () => { if (readonly) return; if (s.expertise.includes(k)) { s.expertise = s.expertise.filter(x => x !== k); s.skills = s.skills.filter(x => x !== k); } else if (s.skills.includes(k)) s.expertise.push(k); else s.skills.push(k); save(); render(); } }),
      el('span', { class: 'val' }, fmtMod(skillVal(k, ab))), name, el('span', { class: 'muted', style: 'font-size:10px' }, ' (' + ABIL[ab].slice(0, 3) + ')'), noteBtn('skill:' + k, name)))),
      el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, 'Пассивное восприятие: ', el('b', {}, passive()), ' · Бонус мастерства: ', el('b', {}, fmtMod(prof())))));

    const c2 = el('div');
    const hp = s.hp;
    const hitCounts = hitDiceCounts(), hitTotal = Object.values(hitCounts).reduce((sum, value) => sum + value, 0), hitSpent = Object.values(hp.hit_dice_used || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    /// Вдохновение: плитка в одном ряду с КД, инициативой и скоростью; состояние сохраняется в листе.
    const toggleInspiration = () => { if (readonly) return; s.inspiration = !s.inspiration; save(); render(); };
    const inspirationTile = el('button', { type: 'button', class: 'card insp-square' + (s.inspiration ? ' on' : ''),
      title: s.inspiration ? 'Потратьте вдохновение на один бросок d20 с преимуществом' : 'Нажмите, чтобы отметить вдохновение, выданное мастером',
      'aria-label': s.inspiration ? 'Вдохновение есть; нажмите, чтобы снять отметку' : 'Вдохновения нет; нажмите, чтобы отметить',
      'aria-pressed': String(!!s.inspiration), disabled: readonly ? '' : null, onclick: toggleInspiration },
      el('label', {}, 'Вдохновение'),
      el('span', { class: 'insp-square-star', 'aria-hidden': 'true' }, '★'));
    c2.append(el('div', { class: 'stat3 has-insp' },
      el('div', { class: 'card' }, el('label', {}, 'КД ', noteBtn('ac', 'КД')), noteLine('ac'), el('input', { class: 'inline', type: 'number', value: s.ac, disabled: dis(), onchange: e => { s.ac = +e.target.value; save(); render(); } })),
      el('div', { class: 'card', style: 'cursor:pointer', onclick: e => roll('d20' + fmtMod(abMod('dex') + (s.initiative_bonus || 0)), 'инициатива', e) }, el('label', {}, 'Инициатива'), el('b', {}, fmtMod(abMod('dex') + (s.initiative_bonus || 0)))),
      el('div', { class: 'card' }, el('label', {}, 'Скорость ', noteBtn('speed', 'Скорость')), el('input', { class: 'inline', type: 'number', value: s.speed, disabled: dis(), onchange: e => { s.speed = +e.target.value; save(); } })),
      inspirationTile));
    c2.append(el('div', { class: 'card', style: 'margin-top:8px' }, h3n('Хиты', 'hp'), noteLine('hp'),
      el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Текущие'), el('input', { type: 'number', value: hp.current, disabled: dis(), onchange: e => { hp.current = +e.target.value; save(); render(); } })), el('div', {}, el('label', {}, 'Макс'), el('input', { type: 'number', value: hp.max, disabled: dis(), onchange: e => { hp.max = +e.target.value; save(); render(); } })), el('div', {}, el('label', {}, 'Врем.'), el('input', { type: 'number', value: hp.temp, disabled: dis(), onchange: e => { hp.temp = +e.target.value; save(); } })), el('div', {}, el('label', { title: `Потрачено ${hitSpent} из ${hitTotal}` }, `Кости хитов ${Math.max(0, hitTotal - hitSpent)}/${hitTotal}`), el('input', { value: hp.hit_dice, disabled: dis(), onchange: e => { hp.hit_dice = e.target.value; save(); } }))),
      el('div', { class: 'hpbar' }, el('div', { style: `width:${Math.max(0, Math.min(100, hp.current / (hp.max || 1) * 100))}%` })),
      el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { class: 'small', onclick: async () => { const v = +(await prompt2('Урон')) || 0; hp.current -= v; save(); render(); } }, '− Урон'), el('button', { class: 'small', onclick: async () => { const v = +(await prompt2('Лечение')) || 0; hp.current = Math.min(hp.max, hp.current + v); save(); render(); } }, '+ Лечение')),
      el('div', { class: 'row', style: 'margin-top:6px;font-size:12px' }, el('span', {}, 'Спасброски от смерти: ', ...[0, 1, 2].map(i => el('span', { class: 'pip', style: 'display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid var(--ok);margin:0 2px;cursor:pointer;background:' + (s.death_saves.success > i ? 'var(--ok)' : 'transparent'), onclick: () => { s.death_saves.success = s.death_saves.success > i ? i : i + 1; save(); render(); } })), ' / ', ...[0, 1, 2].map(i => el('span', { style: 'display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid var(--danger);margin:0 2px;cursor:pointer;background:' + (s.death_saves.failure > i ? 'var(--danger)' : 'transparent'), onclick: () => { s.death_saves.failure = s.death_saves.failure > i ? i : i + 1; save(); render(); } }))))));

    // Действия: экипированные предметы с кнопками + подготовленные заклинания с атаками + ручные атаки
    const act = el('div', { class: 'card dropslot', 'data-cat': 'item', style: 'margin-top:8px' }, h3n('Действия ⤓', 'actions'), noteLine('actions'));
    const c = ctx();
    const eq = s.inventory.filter(it => it.equipped && (it.actions || []).some(a => a.roll));
    eq.forEach(it => act.append(el('div', { class: 'act-line' }, el('span', { class: 'card-icon' }, M.itemIcon(it)), el('b', { style: 'cursor:pointer', title: 'Открыть в инвентаре', onclick: () => { tab = 'inv'; ui.open.add(it.uid); render(); } }, it.name), itemActions(it))));
    const castable = s.spells.known.filter(sp => (sp.casting_mode === 'known' || sp.prepared || sp.level === 0) && (sp.actions || []).some(a => a.roll));
    castable.forEach(sp => act.append(el('div', { class: 'act-line' }, el('span', { class: 'card-icon' }, icon('star', 18)), el('b', {}, sp.name), spellActions(sp))));
    if (s.attacks.length) act.append(el('div', { class: 'atk-row muted', style: 'font-size:11px' }, el('span', {}, 'Ручные атаки'), el('span', {}, 'Атака'), el('span', {}, 'Урон'), el('span'), el('span')));
    s.attacks.forEach((a, i) => act.append(el('div', { class: 'atk-row' },
      el('input', { value: a.name, disabled: dis(), onchange: e => { a.name = e.target.value; save(); } }), el('input', { value: a.bonus, disabled: dis(), onchange: e => { a.bonus = e.target.value; save(); } }), el('input', { value: a.damage, disabled: dis(), onchange: e => { a.damage = e.target.value; save(); } }),
      el('button', { class: 'small', title: 'Бросок атаки', onclick: e => roll('d20' + (/^[+-]/.test(a.bonus) ? a.bonus : '+' + (a.bonus || 0)), a.name + ' (атака)', e, 'attack') }, icon('target')),
      el('button', { class: 'small', title: 'Урон', onclick: () => roll(a.damage.replace(/[^\dкd+\-khl@a-z_]/gi, ''), a.name + ' (урон)', null, 'damage') }, icon('zap')),
      readonly ? null : el('button', { class: 'small danger', style: 'grid-column:1/-1;justify-self:end;padding:0 6px', onclick: () => { s.attacks.splice(i, 1); save(); render(); } }, 'убрать'))));
    if (!eq.length && !castable.length && !s.attacks.length) act.append(el('p', { class: 'muted small' }, 'Экипируйте оружие во вкладке «Инвентарь» или подготовьте заклинания — их кнопки появятся здесь.'));
    if (!readonly) act.append(el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { class: 'small', onclick: () => { s.attacks.push({ name: 'Атака', bonus: fmtMod(abMod('str') + prof()), damage: '1d8' + fmtMod(abMod('str')) }); save(); render(); } }, '+ Ручная атака'), el('button', { class: 'small', onclick: async () => { const it = await M.editItem(M.newItem({ type: 'weapon', equipped: false, actions: [{ name: 'Атака', kind: 'attack', roll: '1d20+@atk' }, { name: 'Урон', kind: 'damage', roll: '1d8+@best' }] })); if (it) { s.inventory.push(it); save(); render(); } } }, '+ Оружие')));
    c2.append(handPanel(), act);
    // Кратко: экипировка и настройка
    const wearing = s.inventory.filter(it => it.equipped);
    c2.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Экипировано'), wearing.length ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px' }, ...wearing.map(it => el('span', { class: 'chip', style: 'cursor:pointer', onclick: () => { tab = 'inv'; ui.open.add(it.uid); render(); } }, M.itemIcon(it), ' ' + it.name + (it.attuned ? ' (настроен)' : '')))) : el('span', { class: 'muted small' }, 'ничего'),
      el('div', { class: 'muted small', style: 'margin-top:4px' }, `Вес: ${totalWeight()} / ${s.abilities.str * 15} фнт`)));
    const favItems = s.inventory.filter(i => i.favorite), favSpells = s.spells.known.filter(x => x.favorite);
    c2.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, icon('star', 14), ' Избранное'), favItems.length || favSpells.length ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px' },
      ...favItems.map(it => el('span', { class: 'chip', style: 'cursor:pointer', title: 'Открыть в инвентаре', onclick: () => { tab = 'inv'; ui.open.add(it.uid); render(); } }, M.itemIcon(it), ' ' + it.name + (it.equipped ? ' ✓' : ''))),
      ...favSpells.map(x => el('span', { class: 'chip', style: 'cursor:pointer', title: 'Открыть в заклинаниях', onclick: () => { tab = 'spells'; ui.open.add(x.uid); render(); } }, '✦ ' + x.name))) : el('span', { class: 'muted small' }, 'Отметьте звёздочкой предметы и заклинания — они соберутся здесь.')));
    cols.append(c1, c2);
    root.append(cols);
    return root;
  }
  const totalWeight = () => Math.round(s.inventory.reduce((a, b) => a + (+b.weight || 0) * (b.qty ?? 1), 0) * 10) / 10;

  // ---------- вкладка Инвентарь ----------
  // ---------- Вкладка «Инвентарь» ----------
  function invTab() {
    const root = el('div', { class: 'inv dropslot', 'data-cat': 'item' }, handPanel());
    const bar = el('div', { class: 'inv-bar' },
      el('input', { placeholder: 'Поиск по предметам', value: ui.invQ, oninput: e => { ui.invQ = e.target.value; drawList(); } }),
      el('select', { onchange: e => { ui.invType = e.target.value; drawList(); } }, el('option', { value: '' }, 'Все типы'), ...Object.entries(M.ITEM_TYPES).map(([k, v]) => el('option', { value: k, selected: ui.invType === k ? '' : null }, v))),
      el('button', { class: 'small fav-filter' + (ui.invFav ? ' on' : ''), title: 'Показать только избранное', onclick: e => { ui.invFav = !ui.invFav; e.currentTarget.classList.toggle('on', ui.invFav); drawList(); } }, icon('star', 12), ' Избранное'),
      readonly ? null : el('button', { class: 'primary small', onclick: async () => { const it = await M.editItem(null, { inventory: s.inventory }); if (it) { s.inventory.push(it); save(); render(); } } }, '+ Предмет'),
      el('button', { class: 'small', onclick: () => toggleComp('item') }, 'Справочник'));
    const wallet = el('div', { class: 'wallet' }, ...['pp', 'gp', 'ep', 'sp', 'cp'].map(c => el('label', {}, { pp: 'ПМ', gp: 'ЗМ', ep: 'ЭМ', sp: 'СМ', cp: 'ММ' }[c], el('input', { type: 'number', value: s.currency[c], disabled: dis(), onchange: e => { s.currency[c] = +e.target.value; save(); } }))),
      el('span', { class: 'muted small', style: 'margin-left:auto' }, `Вес: ${totalWeight()} / ${s.abilities.str * 15} фнт${totalWeight() > s.abilities.str * 15 ? ' — перегруз' : ''}`));
    const list = el('div', { class: 'inv-list' });
    root.append(bar, wallet, list);
    function drawList() {
      list.innerHTML = '';
      const q = ui.invQ.toLowerCase();
      const items = s.inventory.filter(it => (!q || it.name.toLowerCase().includes(q) || (it.desc || '').toLowerCase().includes(q) || (it.tags || []).some(t => t.toLowerCase().includes(q))) && (!ui.invType || it.type === ui.invType) && (!ui.invFav || it.favorite));
      const sections = [['Экипировано', items.filter(i => i.equipped)], ['Рюкзак', items.filter(i => !i.equipped)]];
      for (const [title, arr] of sections) {
        if (!arr.length && title === 'Экипировано') continue;
        list.append(el('h3', { class: 'inv-sec' }, title, el('span', { class: 'muted small' }, ` ${arr.length}`)));
        const grid = el('div', { class: 'cards' });
        if (!arr.length) grid.append(el('div', { class: 'muted small', style: 'padding:12px' }, 'Пусто. Перетащите предмет из справочника, с другого листа или создайте свой.'));
        [...arr].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)).forEach(it => grid.append(itemCard(it)));
        list.append(grid);
      }
    }
    drawList();
    return root;
  }
  // Звёздочка избранного: у предметов и заклинаний одна и та же.
  const favButton = doc => el('button', { class: 'tiny fav' + (doc.favorite ? ' on' : ''), title: doc.favorite ? 'Убрать из избранного' : 'В избранное', 'aria-pressed': doc.favorite ? 'true' : 'false', onclick: e => { e.stopPropagation(); doc.favorite = !doc.favorite; save(); render(); } }, icon('star', 12));
  function itemCard(it) {
    const c = ctx();
    const open = ui.open.has(it.uid);
    const card = el('div', { class: 'mcard' + (it.equipped ? ' equipped' : '') + (open ? ' open' : ''), draggable: readonly ? null : 'true', 'data-uid': it.uid, style: `--rar:${M.RARITY_COLORS[it.rarity] || 'var(--border)'}` });
    const head = el('div', { class: 'mcard-head', onclick: () => { if (open) ui.open.delete(it.uid); else ui.open.add(it.uid); render(); } },
      el('span', { class: 'card-icon big' }, M.itemIcon(it)),
      el('div', { class: 'grow' }, el('div', { class: 'mcard-name' }, it.name, it.attuned ? el('span', { class: 'muted small', title: 'настроен' }, ' · настроен') : null), noteBtn('item:' + it.uid, it.name), el('div', { class: 'muted small' }, [M.ITEM_TYPES[it.type]?.slice(2), it.rarity !== 'Обычный' ? it.rarity : null, it.weight ? `${it.weight} фнт` : null, it.charges ? `заряды ${it.charges.cur}/${it.charges.max}` : null].filter(Boolean).join(' · '))),
      el('div', { class: 'qty', onclick: e => e.stopPropagation() }, readonly ? el('span', {}, '×' + it.qty) : [el('button', { class: 'tiny', onclick: () => { it.qty = Math.max(0, (it.qty ?? 1) - 1); if (!it.qty) { it.equipped = false; it.hand_slot = null; }; save(); render(); } }, '−'), el('span', {}, it.qty ?? 1), el('button', { class: 'tiny', onclick: () => { it.qty = (it.qty ?? 1) + 1; save(); render(); } }, '+')]),
      readonly ? null : favButton(it),
      readonly || !Equipment.canEquip(it) ? null : el('button', { disabled: it.qty === 0 ? '' : null, class: 'tiny eq' + (it.equipped ? ' on' : ''), title: it.equipped ? 'Снять' : 'Экипировать', onclick: e => { e.stopPropagation(); inventoryOp({ op: 'equip', item_uid: it.uid, slot: it.equipped ? 'backpack' : it.handedness !== 'none' ? Equipment.choices(it)[0] : 'worn' }); } }, icon('check', 12)));
    card.append(head);
    const acts = itemActions(it);
    const resource = Equipment.resourceStatus(it, s.inventory);
    card.append(el('div', { class: 'item-resource' + (resource.available < (it.consume?.amount || 1) ? ' empty' : '') }, resource.text));
    if (acts.children.length) card.append(acts);
    if (open) {
      const body = el('div', { class: 'mcard-body' });
      if (noteLine('item:' + it.uid)) body.append(noteLine('item:' + it.uid));
      if (it.desc) body.append(el('div', { class: 'card-desc' }, M.rich(it.desc, c, { prose:!!it.mechanics, prefix: `${ch.name}: ${it.name}` })));
      if (it.charges) body.append(el('div', { class: 'row small', style: 'align-items:center;gap:6px' }, 'Заряды: ', ...Array.from({ length: it.charges.max }, (_, i) => el('span', { class: 'pip' + (i < it.charges.cur ? ' on' : ''), style: 'cursor:pointer', onclick: () => { if (readonly) return; it.charges.cur = i < it.charges.cur ? i : i + 1; save(); render(); } })), it.charges.recharge ? el('span', { class: 'muted' }, `(${it.charges.recharge})`) : null));
      if (!readonly && Equipment.canEquip(it)) body.append(el('label', { class: 'item-grip' }, it.handedness !== 'none' ? 'Положение / хват' : 'Слот', el('select', { onchange: e => inventoryOp({ op: 'equip', item_uid: it.uid, slot: e.target.value }) }, ...['backpack', ...Equipment.choices(it)].map(slot => el('option', { value: slot, selected: (it.equipped ? it.hand_slot || it.worn_slot || 'backpack' : 'backpack') === slot ? '' : null }, Equipment.slots[slot])))));
      else if (!readonly) body.append(el('div', { class: 'muted small' }, 'Этот предмет нельзя экипировать: он лежит в рюкзаке. Если это носимая вещь, измените «Носится на» в редакторе предмета.'));
      if (it.cost || it.source) body.append(el('div', { class: 'muted small' }, [it.cost, it.source].filter(Boolean).join(' · ')));
      const menu = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin-top:6px' },
        el('button', { class: 'small', onclick: () => sendCard(it, 'item') }, 'В чат'));
      if (!readonly) menu.append(
        el('button', { class: 'small', onclick: async () => { const r = await M.editItem(it, { inventory: s.inventory }); if (r) { Object.assign(it, r); save(); render(); } } }, 'Изменить'),
        it.attunement ? el('button', { class: 'small', onclick: () => { if (!it.attuned && s.inventory.filter(i => i.attuned).length >= 3) return toast('Настроить можно не более трёх предметов одновременно.'); it.attuned = !it.attuned; save(); render(); } }, it.attuned ? 'Снять настройку' : 'Настроиться') : null,
        it.type === 'consumable' && !it.mechanics ? el('button', { class: 'small', disabled: it.qty === 0 ? '' : null, onclick: () => inventoryOp({ op: 'use', item_uid: it.uid, actions: [] }) }, 'Использовать') : null,
        ch.campaign_id ? el('button', { class: 'small', onclick: () => transfer(it) }, 'Передать') : null,
        ch.campaign_id ? el('button', { class: 'small', onclick: () => dropToMap(it) }, 'На стол') : null,
        it.qty > 1 ? el('button', { class: 'small', onclick: async () => { const n = +(await prompt2('Отделить сколько?', '', '1')); if (Number.isInteger(n) && n > 0 && n < it.qty) await inventoryOp({ op: 'split', item_uid: it.uid, qty: n }); } }, 'Разделить') : null,
        el('button', { class: 'small danger', style: 'margin-left:auto', onclick: () => { if (confirm(`Удалить «${it.name}»?${s.inventory.some(x => x.consume?.target_uid === it.uid) ? ' На предмет ссылается расход другого предмета — привязку придётся изменить.' : ''}`)) { s.inventory = s.inventory.filter(x => x !== it); save(); render(); } } }, icon('trash')));
      body.append(menu);
      card.append(body);
    }
    if (!readonly) {
      card.addEventListener('dragstart', ev => { M.setDrag(ev, 'application/x-item', { item: it, from_character_id: id, campaign_id: ch.campaign_id }); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', ev => { if (M.hasType(ev, 'application/x-item')) { ev.preventDefault(); ev.stopPropagation(); card.classList.add('dragover'); } });
      card.addEventListener('dragleave', () => card.classList.remove('dragover'));
      card.addEventListener('drop', ev => { card.classList.remove('dragover'); const p = M.getDrag(ev, 'application/x-item'); if (!p) return; ev.preventDefault(); ev.stopPropagation();
        if (p.from_character_id === id) { // перестановка
          const from = s.inventory.findIndex(x => x.uid === p.item.uid), to = s.inventory.findIndex(x => x.uid === it.uid);
          if (from >= 0 && to >= 0 && from !== to) { const [m] = s.inventory.splice(from, 1); s.inventory.splice(to, 0, m); save(); render(); }
        } else acceptItem(p);
      });
    }
    return card;
  }
  async function acceptItem(p) {
    if (p.from_character_id && p.from_character_id !== id) {
      try { await API.post(`/api/characters/${p.from_character_id}/transfer`, { item_uid: p.item.uid, to_character_id: id }); toast(`${p.item.name} получено`); reload(); } catch (e) { toast('Не удалось передать: ' + e.message); }
    } else if (!p.from_character_id) { s.inventory.push({ ...p.item, uid: M.uid(), equipped: false, hand_slot: null, worn_slot: null, favorite: false, attuned: false }); save(); render(); toast(`${p.item.name} добавлено`); }
  }

  // ---------- вкладка Заклинания ----------
  // ---------- Вкладка «Заклинания» ----------
  function spellsTab() {
    const sp = s.spells, c = ctx();
    const root = el('div', { class: 'inv dropslot', 'data-cat': 'spell' });
    const spAb = sp.ability || 'int';
    root.append(el('div', { class: 'inv-bar' },
      el('label', { style: 'flex:0;white-space:nowrap' }, 'Хар-ка ', el('select', { style: 'width:auto;padding:4px', disabled: dis(), onchange: e => { sp.ability = e.target.value; save(); render(); } }, ...['int', 'wis', 'cha'].map(k => el('option', { value: k, selected: spAb === k ? '' : null }, ABIL[k])))),
      el('span', { class: 'chip' }, 'СЛ ', el('b', {}, c.dc)), el('span', { class: 'chip', style: 'cursor:pointer', onclick: e => roll('d20' + fmtMod(c.spell), 'атака заклинанием', e, 'attack') }, 'Атака ', el('b', {}, fmtMod(c.spell))),
      el('input', { placeholder: 'Поиск по названию и описанию', value: ui.spellQ, oninput: e => { ui.spellQ = e.target.value; draw(); } }),
      el('select', { class: 'small spell-level-filter', value: ui.spellLevel, title: 'Фильтр по кругу', onchange: e => { ui.spellLevel = e.target.value; draw(); } }, el('option', { value: '' }, 'Все круги'), ...Array.from({ length: 10 }, (_, i) => el('option', { value: String(i), selected: ui.spellLevel === String(i) ? '' : null }, i === 0 ? 'Заговоры' : `${i} круг`))),
      el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: ui.onlyPrepared ? '' : null, onchange: e => { ui.onlyPrepared = e.target.checked; draw(); } }), ' доступные (подготовленные и известные)'),
      el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: ui.spellFav ? '' : null, onchange: e => { ui.spellFav = e.target.checked; draw(); } }), ' ★ избранные'),
      readonly ? null : el('button', { class: 'primary small', onclick: async () => { const x = await M.editSpell(null,{inventory:s.inventory}); if (x) { sp.known.push(x); save(); render(); } } }, '+ Заклинание'),
      el('button', { class: 'small', onclick: () => toggleComp('spell') }, 'Справочник')));
    const slots = el('div', { class: 'slots spell-slots' });
    const slotRow = (label, sl, pool, level, extra = null) => {
      const persist = () => { if (pool === 'pact_slots') sp.pact_slots = sl; else sp.slots[level] = sl; };
      slots.append(el('div', { class: 'slot' + (sl.max ? '' : ' empty') + (pool === 'pact_slots' ? ' pact-slot' : '') },
        el('b', { title: pool === 'pact_slots' ? 'Ячейки магии договора: восстанавливаются коротким или долгим отдыхом' : `${label}: восстанавливаются долгим отдыхом` }, label),
        el('span', { class: 'pips' }, ...Array.from({ length: Math.min(20, sl.max) }, (_, i) => el('span', { class: 'pip' + (i >= sl.used ? ' on' : ''), role: readonly ? null : 'button', tabindex: readonly ? null : '0', title: i >= sl.used ? 'Потратить ячейку' : 'Вернуть ячейку', onclick: readonly ? null : () => { sl.used = i >= sl.used ? i + 1 : i; persist(); save(); render(); }, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } }))),
        extra,
        readonly ? null : el('input', { type: 'number', value: sl.max, min: 0, max: 20, title: 'Всего ячеек', 'aria-label': `${label}: всего ячеек`, onchange: e => { sl.max = Math.max(0, Math.min(20, +e.target.value || 0)); sl.used = Math.min(sl.used, sl.max); persist(); save(); render(); } })));
    };
    for (let l = 1; l <= 9; l++) {
      const sl = sp.slots[l] || { max: 0, used: 0 }; if (!sl.max && readonly) continue;
      slotRow(`${l} круг`, sl, 'slots', l);
    }
    if (sp.pact_slots || !readonly) {
      const pact = sp.pact_slots || { level: 1, max: 0, used: 0 };
      const levelPick = readonly ? null : el('select', { 'aria-label': 'Круг ячейки Договора', title: 'Уровень ячейки Договора', onchange: e => { pact.level = +e.target.value; sp.pact_slots = pact; save(); render(); } }, ...Array.from({ length: 9 }, (_, i) => i + 1).map(l => el('option', { value: l, selected: pact.level === l ? '' : null }, `${l} кр.`)));
      if (pact.max || !readonly) slotRow('Договор', pact, 'pact_slots', pact.level, levelPick);
    }
    slots.append(el('p', { class: 'muted small slot-rest-hint' }, 'Обычные ячейки — долгий отдых · ячейки Договора — короткий или долгий отдых.'));
    root.append(slots);
    const list = el('div');
    root.append(list);
    function draw() {
      list.innerHTML = '';
      const q = ui.spellQ.toLowerCase();
      const arr = sp.known.filter(x => (!q || x.name.toLowerCase().includes(q) || (x.desc || '').toLowerCase().includes(q)) && (!ui.spellLevel || String(Number(x.level) || 0) === ui.spellLevel) && (!ui.onlyPrepared || x.prepared || x.casting_mode === 'known' || x.level === 0 || (x.ritual && x.casting_mode === 'book')) && (!ui.spellFav || x.favorite));
      if (!arr.length) list.append(el('p', { class: 'muted small', style: 'padding:12px' }, 'Нет заклинаний. Перетащите из справочника или создайте своё.'));
      for (let l = 0; l <= 9; l++) {
        const lv = arr.filter(x => (x.level || 0) === l); if (!lv.length) continue;
        const ready = lv.filter(x => l === 0 || x.casting_mode === 'known' || x.prepared || (x.ritual && x.casting_mode === 'book')).length;
        list.append(el('h3', { class: 'inv-sec' }, l === 0 ? 'Заговоры' : `${l} круг`, el('span', { class: 'muted small' }, ` ${ready} доступно · ${lv.length} всего`)));
        const grid = el('div', { class: 'cards' });
        lv.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.name.localeCompare(b.name)).forEach(x => grid.append(spellCard(x)));
        list.append(grid);
      }
    }
    draw();
    return root;
  }
  function spellCard(x) {
    const c = ctx(), sp = s.spells;
    const spellCtx = x.spell_ability && ['int', 'wis', 'cha'].includes(x.spell_ability)
      ? M.ctxFromSheet({ ...s, spells: { ...s.spells, ability: x.spell_ability } }) : c;
    const open = ui.open.has(x.uid);
    const card = el('div', { class: 'mcard spell' + (x.prepared || x.casting_mode === 'known' || x.level === 0 ? ' equipped' : '') + (open ? ' open' : ''), draggable: 'true', style: '--rar:var(--accent)' });
    card.append(el('div', { class: 'mcard-head', onclick: () => { if (open) ui.open.delete(x.uid); else ui.open.add(x.uid); render(); } },
      el('span', { class: 'card-icon big' }, M.docIcon(sp, 'star', 22)),
      el('div', { class: 'grow' }, el('div', { class: 'mcard-name' }, x.name, x.concentration ? el('span', { class: 'badge', title: 'концентрация' }, 'К') : null, x.ritual ? el('span', { class: 'badge', title: 'ритуал' }, 'Р') : null), noteBtn('spell:' + x.uid, x.name), el('div', { class: 'muted small' }, [x.level === 0 ? 'Заговор · не тратит ячейку' : x.casting_mode === 'known' ? 'Известно · можно сотворить' : x.prepared ? 'Подготовлено' : 'Не подготовлено', x.cast_cost === 'free' && x.level > 0 ? 'без расхода ячейки' : x.cast_cost === 'uses' ? `${x.use_cost || 1} заряд(а) · ${x.uses?.cur ?? 0}/${x.uses?.max ?? 0}` : x.level > 0 && (x.cast_cost || 'slot') === 'slot' ? `${x.level} круг · ячейка ${x.level}+` : null, x.school, x.casting_time, x.range, x.duration].filter(Boolean).join(' · '))),
      x.cast_cost === 'uses' && x.uses ? el('span', { class: 'spell-use-pips', title: `Заряды: ${x.uses.cur}/${x.uses.max}`, onclick: e => e.stopPropagation() }, readonly ? null : el('button', { class: 'tiny', 'aria-label': 'Убрать один заряд', disabled: x.uses.cur <= 0 ? '' : null, onclick: e => { e.stopPropagation(); x.uses.cur = Math.max(0, x.uses.cur - 1); save(); render(); } }, '−'), el('b', {}, `${x.uses.cur}/${x.uses.max}`), readonly ? null : el('button', { class: 'tiny', 'aria-label': 'Вернуть один заряд', disabled: x.uses.cur >= x.uses.max ? '' : null, onclick: e => { e.stopPropagation(); x.uses.cur = Math.min(x.uses.max, x.uses.cur + 1); save(); render(); } }, '+')) : null,
      readonly ? null : favButton(x),
      el('button', { class: 'tiny cast', disabled: readonly || (Number(x.level) > 0 && x.casting_mode !== 'known' && !x.prepared && !(x.ritual && x.casting_mode === 'book')) ? '' : null, title: Number(x.level) === 0 ? 'Сотворить заговор: без траты ячейки' : 'Сотворить: расход ячейки/зарядов применяется сразу', onclick: e => { e.stopPropagation(); cast(x); } }, icon('wand')),
      readonly || x.level === 0 || x.casting_mode === 'known' ? null : el('button', { class: 'tiny eq' + (x.prepared ? ' on' : ''), title: x.prepared ? 'Подготовлено' : 'Не подготовлено', onclick: e => { e.stopPropagation(); x.prepared = !x.prepared; save(); render(); } }, icon('check', 12))));
    const acts = spellActions(x, spellCtx);
    if (acts.children.length) card.append(acts);
    if (open) {
      const body = el('div', { class: 'mcard-body' }, el('div', { class: 'muted small' }, [x.components, x.spell_ability ? 'Характеристика: ' + (ABIL[x.spell_ability] || x.spell_ability) : null, x.classes?.length ? 'Классы: ' + x.classes.join(', ') : null, x.source].filter(Boolean).join(' · ')));
      if (noteLine('spell:' + x.uid)) body.append(noteLine('spell:' + x.uid));
      if (x.desc) body.append(el('div', { class: 'card-desc' }, M.rich(x.desc, spellCtx, { prose:!!x.mechanics, prefix: `${ch.name}: ${x.name}` })));
      const menu = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin-top:6px' }, el('button', { class: 'small', onclick: () => sendCard(x, 'spell') }, 'В чат'));
      if (!readonly) menu.append(el('button', { class: 'small', onclick: async () => { const r = await M.editSpell(x,{inventory:s.inventory}); if (r) { Object.assign(x, r); save(); render(); } } }, 'Изменить'),
        el('button', { class: 'small danger', style: 'margin-left:auto', onclick: () => { sp.known = sp.known.filter(y => y !== x); save(); render(); } }, icon('trash')));
      body.append(menu); card.append(body);
    }
    card.addEventListener('dragstart', ev => M.setDrag(ev, 'application/x-spell', { spell: x, from_character_id: id }));
    return card;
  }
  async function cast(x) {
    if (readonly || inventoryBusy) return;
    const canRitualFromBook = !!x.ritual && x.casting_mode === 'book';
    if (Number(x.level) > 0 && x.casting_mode !== 'known' && !x.prepared && !canRitualFromBook) return toast('Это заклинание не подготовлено. Подготовьте его или выберите известное заклинание.', 4000);
    const cost = SpellRules.castCost(x), sp = s.spells;
    let choice = {};
    if (cost === 'slot') {
      const options = SpellRules.slotPool(sp, x).map(o => ({ ...o, key: `${o.pool}:${o.level}`, label: `${o.pool === 'pact_slots' ? 'Договор · ' : ''}${o.level} круг (${o.remaining} свободно)` }));
      if (x.ritual) options.push({ pool: 'ritual', level: Number(x.level) || 0, key: 'ritual', label: 'Ритуал · без ячейки (длительное сотворение)' });
      if (!options.length) return toast('Нет доступной ячейки нужного круга. Обычное заклинание без расхода не сотворяется.', 4500);
      let selected = options[0];
      if (options.length > 1) {
        const pick = el('select', {}, ...options.map(o => el('option', { value: o.key }, o.label)));
        const result = await modal(`Сотворить «${x.name}»`, el('div', { class: 'field' }, el('label', {}, 'Расход'), pick), [{ label: 'Сотворить', cls: 'primary', fn: () => pick.value }]);
        if (!result) return;
        selected = options.find(o => o.key === result); if (!selected) return;
      }
      choice = selected.pool === 'ritual' ? { ritual: true } : { pool: selected.pool, level: selected.level };
    }
    const copySpell = JSON.parse(JSON.stringify(x));
    const check = SpellRules.spend(JSON.parse(JSON.stringify(sp)), copySpell, choice);
    if (!check.ok) return toast(check.reason, 4000);
    const program = x.mechanics?.programs?.find(p => p.trigger === 'use');
    if (x.mechanics && !program) return toast('Для этого заклинания не настроено действие сотворения.');
    if (program) {
      const result = await runProgram(x, 'spell', program);
      if (!result) return;
      const live = s.spells.known.find(spell => spell.uid === x.uid) || x;
      const paid = SpellRules.spend(s.spells, live, choice);
      if (!paid.ok) return toast('Действие выполнено, но расход не удалось подтвердить: ' + paid.reason, 5000);
      save(); render();
      return;
    }
    const paid = SpellRules.spend(sp, x, choice);
    if (!paid.ok) return toast(paid.reason, 4000);
    save(); render();
    const card = M.toChatCard(x, 'spell');
    const meta = paid.cost === 'slots' ? `${paid.level} круг · ячейка` : paid.cost === 'pact_slots' ? `${paid.level} круг · ячейка Договора` : paid.cost === 'ritual' ? 'Ритуал · без ячейки' : paid.cost === 'uses' ? `−${paid.amount} заряд(а)` : 'Без расхода ячейки';
    M.sendCard({ ...card, owner: ch.name, meta: `${meta}${card.meta ? ' · ' + card.meta : ''}` });
  }

  // ---------- вкладка Умения ----------
  // ---------- Вкладка «Умения» ----------
  function featsTab() {
    const c = ctx();
    const root = el('div', { class: 'inv dropslot', 'data-cat': 'feat' });
    if (s.level_log?.length) root.append(el('details', { class: 'card level-log', style: 'margin-bottom:12px' }, el('summary', {}, `История повышений (${s.level_log.length})`),
      ...s.level_log.slice().reverse().map((l, i) => el('div', { class: 'level-log-row' }, el('b', {}, `${l.class} → ${l.level}`), el('span', { class: 'muted small' }, ` · хиты ${l.hp >= 0 ? '+' : ''}${l.hp}${l.total && s.classes?.length > 1 ? ' · всего ' + l.total + ' ур.' : ''}${l.choices?.length ? ' · ' + l.choices.join(' · ') : ''}`),
        i === 0 && !readonly && window.LevelUp?.canUndo(s) ? el('button', { class: 'small', style: 'margin-left:8px', title: 'Вернуть уровень, хиты, умения и заклинания к состоянию до этого повышения', onclick: async () => { if (!confirm(`Отменить повышение до ${l.level} уровня класса «${l.class}»? Прочие правки листа сохранятся.`)) return; try { LevelUp.undo(s); s.ac = Equipment.armorClass(s); save(); render(); toast('Повышение отменено.'); } catch (e) { toast(e.message, 4000); } } }, '↶ Отменить') : null))));
    if (s.modules?.length) root.append(el('details', { class: 'card', style: 'margin-bottom:12px' },
      el('summary', {}, `Модули при создании (${s.modules.length})`),
      el('p', { class: 'muted small' }, 'Снимки выбранных модулей на момент создания. Изменения справочника не перезаписывают ваш лист.'),
      ...s.modules.filter(m => m.snapshot).map(m => el('details', { style: 'margin:10px 0' },
        el('summary', {}, `${m.snapshot.name} · ${m.source || 'Свой модуль'}`), Compendium.renderData(m.snapshot, { readOnly: true })))));

    root.append(el('div', { class: 'inv-bar' }, el('span', { class: 'muted small', style: 'flex:1' }, 'Умения классов, расовые особенности, черты. В тексте работают кнопки бросков: [[1d20+@prof]]{Проверка}.'),
      readonly ? null : el('button', { class: 'primary small', onclick: () => editFeature(null) }, '+ Умение'), el('button', { class: 'small', onclick: () => toggleComp('feat') }, 'Справочник')));
    const grid = el('div', { class: 'cards one' });
    s.features.forEach((f, i) => {
      const open = ui.open.has('f' + i);
      const card = el('div', { class: 'mcard' + (open ? ' open' : ''), style: '--rar:var(--border)' });
      card.append(el('div', { class: 'mcard-head', onclick: () => { if (open) ui.open.delete('f' + i); else ui.open.add('f' + i); render(); } }, el('span', { class: 'card-icon big' }, M.docIcon(f, 'scroll', 22)), el('div', { class: 'grow' }, el('div', { class: 'mcard-name' }, f.name), noteBtn('feat:' + (f.uid || i), f.name), !open ? el('div', { class: 'muted small ellipsis' }, (f.text || '').slice(0, 120)) : null),
        f.uses ? el('span', { class: 'small', onclick: e => e.stopPropagation() }, ...Array.from({ length: f.uses.max }, (_, k) => el('span', { class: 'pip' + (k < f.uses.cur ? ' on' : ''), style: 'cursor:pointer', onclick: () => { f.uses.cur = k < f.uses.cur ? k : k + 1; save(); render(); } }))) : null));
      if (f.actions?.length || f.mechanics) card.append(docActions(f, 'feature'));
      if (open) card.append(el('div', { class: 'mcard-body' }, noteLine('feat:' + (f.uid || i)), el('div', { class: 'card-desc' }, M.rich(f.text || '', c, { prefix: `${ch.name}: ${f.name}` })),
        el('div', { class: 'row', style: 'gap:4px;margin-top:6px' }, el('button', { class: 'small', onclick: () => M.sendCard({ mechanics:f.mechanics, name: f.name, kind: 'feat', desc: f.text, actions: f.actions || [], icon: 'scroll', asset_id: f.asset_id, owner: ch.name }) }, 'В чат'), readonly ? null : el('button', { class: 'small', onclick: () => editFeature(f) }, 'Изменить'), readonly ? null : el('button', { class: 'small danger', style: 'margin-left:auto', onclick: () => { s.features.splice(i, 1); save(); render(); } }, icon('trash')))));
      grid.append(card);
    });
    if (!s.features.length) grid.append(el('p', { class: 'muted small', style: 'padding:12px' }, 'Пока пусто. Перетащите расу/класс/черту из справочника.'));
    root.append(grid);
    return root;
  }
  async function editFeature(f) {
    const d = await M.editFeature(f,{inventory:s.inventory});
    if (!d) return;
    if (f) Object.assign(f, d); else s.features.push(d);
    save(); render();
  }


  // ---------- вкладка Заметки ----------
  // ---------- Вкладка «Заметки» ----------
  function notesTab() {
    const root = el('div', { class: 'cols2' });
    const pers = el('div', { class: 'card sheet-personality-notes' }, el('h3', {}, 'Личность и анкета'));
    for (const [k, n] of [['player_name', 'Имя игрока'], ['faith', 'Божество или вера'], ['age', 'Возраст'], ['height', 'Рост'], ['weight', 'Вес'], ['eyes', 'Глаза'], ['skin', 'Кожа'], ['hair', 'Волосы'], ['personality', 'Черты характера'], ['ideals', 'Идеалы'], ['bonds', 'Привязанности'], ['flaws', 'Слабости'], ['appearance', 'Дополнительные приметы'], ['backstory', 'Предыстория']]) pers.append(el('div', { class: 'field' }, el('label', {}, n), el('textarea', { disabled: dis(), style: 'min-height:48px', onchange: e => { s.traits[k] = e.target.value; save(); } }, s.traits[k] || '')));
    const notes = el('div', { class: 'card' }, el('h3', {}, 'Заметки'), el('textarea', { disabled: dis(), style: 'min-height:220px', onchange: e => { s.notes = e.target.value; save(); render(); } }, s.notes || ''),
      s.notes ? el('div', { class: 'card-desc', style: 'margin-top:6px' }, M.rich(s.notes, ctx(), { prefix: ch.name + ': заметки' })) : el('p', { class: 'muted small' }, 'В заметках работают кнопки бросков: [[1d20+@prof]]{Проверка} и переменные {{@hp_max}}.'),
      el('div', { class: 'field', style: 'margin-top:8px' }, el('label', {}, 'Владения и языки'), el('textarea', { disabled: dis(), style: 'min-height:60px', onchange: e => { s.proficiencies = e.target.value; save(); } }, s.proficiencies || '')));
    const keys = Object.keys(s.notes_by).filter(k => (s.notes_by[k] || '').trim());
    const title = k => { const [t, id] = k.split(':'); if (t === 'ab') return ABIL[id] || id; if (t === 'skill') return (SKILLS.find(x => x[0] === id) || [])[1] || id; if (t === 'item') return 'Предмет: ' + (s.inventory.find(x => x.uid === id)?.name || '?'); if (t === 'spell') return 'Заклинание: ' + (s.spells.known.find(x => x.uid === id)?.name || '?'); if (t === 'feat') return 'Умение: ' + (s.features.find((x, i) => (x.uid || i) == id)?.name || '?'); return { saves: 'Спасброски', skills: 'Навыки', ac: 'КД', speed: 'Скорость', hp: 'Хиты', actions: 'Действия' }[k] || k; };
    const all = el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Заметки на листе'), keys.length ? null : el('p', { class: 'muted small' }, 'Нажмите карандаш рядом с характеристикой, навыком, предметом или заклинанием — заметка появится здесь и рядом с блоком.'));
    keys.forEach(k => all.append(el('div', { class: 'row', style: 'align-items:flex-start;gap:6px;margin-bottom:4px' }, el('b', { class: 'small', style: 'flex:0 0 160px' }, title(k)), el('div', { class: 'note-line grow', style: 'margin:0' }, M.rich(s.notes_by[k], ctx(), { prefix: ch.name })), noteBtn(k, title(k)))));
    notes.append(all);
    root.append(pers, notes);
    return root;
  }

  // ---- drag&drop: из справочника и между листами ----
  // ---------- Перетаскивание записей из справочника ----------
  function bindDrops(root) {
    root.querySelectorAll('.dropslot').forEach(slot => {
      slot.addEventListener('dragover', e => { if (M.hasType(e, 'application/x-compendium', 'application/x-item', 'application/x-spell')) { e.preventDefault(); slot.classList.add('dragover'); } });
      slot.addEventListener('dragleave', () => slot.classList.remove('dragover'));
      slot.addEventListener('drop', e => { if (e.defaultPrevented) return; e.preventDefault(); slot.classList.remove('dragover'); handleDrop(e, slot.dataset.cat); });
    });
    root.addEventListener('dragover', e => { if (M.hasType(e, 'application/x-compendium', 'application/x-item', 'application/x-spell')) e.preventDefault(); });
    root.addEventListener('drop', e => { if (e.defaultPrevented) return; e.preventDefault(); handleDrop(e); });
  }
  function handleDrop(e, slotCat) {
    const comp = M.getDrag(e, 'application/x-compendium');
    if (slotCat) {
      if (!comp) { toast('В этот слот можно перетащить только блок соответствующей категории из справочника.'); return; }
      return applyEntry(comp, slotCat);
    }
    if (comp) return applyEntry(comp);
    const item = M.getDrag(e, 'application/x-item'); if (item) return acceptItem(item);
    const spell = M.getDrag(e, 'application/x-spell'); if (spell) { if (!s.spells.known.some(x => x.name === spell.spell.name)) { s.spells.known.push({ ...spell.spell, uid: M.uid(), prepared: false }); save(); render(); toast(`${spell.spell.name} добавлено`); } }
  }
  function applyEntry(e, slotCat) {
    if (slotCat && e.category !== slotCat) {
      toast(`В блок «${({race:'Раса',class:'Класс',background:'Предыстория'}[slotCat] || slotCat)}» можно перетащить только соответствующую запись справочника.`);
      return;
    }
    e=Mechanics.passiveData(e);
    const d = e.data || {};
    switch (e.category) {
      case 'race': {
        s.race = d.subrace && d.parent ? `${d.parent} (${e.name})` : e.name;
        s.modules ||= [];
        s.modules = s.modules.filter(m => m.category !== 'race');
        s.modules.push({ schema_version: 1, entry_id: e.id, category: 'race', source: e.source, pack_id: e.pack_id || null, snapshot: JSON.parse(JSON.stringify(e)) });
        if (d.asi && Object.keys(d.asi).length && confirm(`Применить бонусы расы к характеристикам? (${Object.entries(d.asi).filter(([k]) => ABIL[k]).map(([k, v]) => ABIL[k] + ' +' + v).join(', ')})`)) for (const [k, v] of Object.entries(d.asi)) if (ABIL[k]) s.abilities[k] += v;
        if (d.speed) s.speed = d.speed;
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push(M.newFeature({ name:t.name,text:t.text,mechanics:t.mechanics||Mechanics.forFeature(d.mechanics,t.name) })); });
        break;
      }
      case 'class': {
        s.class = e.name;
        if (d.saves && confirm('Установить спасброски и кость хитов класса?')) { s.saving_throws = [...d.saves]; s.hp.hit_dice = (s.level || 1) + d.hit_die; if (s.level === 1) { s.hp.max = parseInt(d.hit_die.slice(1)) + abMod('con'); s.hp.current = s.hp.max; } }
        if (d.spellcasting) s.spells.ability = d.spellcasting;
        Object.entries(d.features || {}).forEach(([lvl, fs]) => { if (+lvl <= (s.level || 1)) fs.forEach(n => { if (!s.features.some(f => f.name === n)) s.features.push(M.newFeature({ name: n, text: d.feature_texts?.[n] || '', mechanics:Mechanics.forFeature(d.mechanics,n), source: `${e.name}, ${lvl} ур.` })); }); });
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push(M.newFeature({ name:t.name,text:t.text,mechanics:t.mechanics||Mechanics.forFeature(d.mechanics,t.name) })); });
        break;
      }
      case 'background': {
        s.background = e.name;
        const map = Object.fromEntries(SKILLS.map(([k, n]) => [n, k]));
        (d.skills || []).forEach(n => { if (map[n] && !s.skills.includes(map[n])) s.skills.push(map[n]); });
        if (d.feature) s.features.push(M.newFeature({ name: d.feature, text: d.feature_text || '', mechanics:Mechanics.forFeature(d.mechanics,d.feature), source: `Предыстория «${e.name}»` }));
        if (d.feat) s.features.push(M.newFeature({ name: d.feat, text: 'Черта происхождения. Описание — в справочнике (Черты).', source: `Предыстория «${e.name}»` }));
        if (d.asi_options?.length) {
          const short = { СИЛ: 'str', ЛОВ: 'dex', ТЕЛ: 'con', ИНТ: 'int', МДР: 'wis', ХАР: 'cha' };
          const pick = window.prompt(`Правила 2024: предыстория даёт +2 и +1 (или +1/+1/+1) к характеристикам из списка: ${d.asi_options.join(', ')}.\nВведите, например: ${d.asi_options[0]} +2, ${d.asi_options[1] || d.asi_options[0]} +1 (пусто — пропустить)`, `${d.asi_options[0]} +2, ${d.asi_options[1] || d.asi_options[0]} +1`);
          if (pick) for (const m of pick.matchAll(/(СИЛ|ЛОВ|ТЕЛ|ИНТ|МДР|ХАР)\s*\+?(\d)/gi)) { const k = short[m[1].toUpperCase()]; if (k) s.abilities[k] += +m[2]; }
        }
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push(M.newFeature({ name:t.name,text:t.text,mechanics:t.mechanics||Mechanics.forFeature(d.mechanics,t.name) })); });
        break;
      }
      case 'item': {
        const it = M.itemFromCompendium(e, ctx());
        // AC is derived from current equipment, never incremented when copying a template.
        // Weapons enter the backpack; taking them in hand is an explicit operation.
        it.equipped = false; it.hand_slot = null; it.worn_slot = null; it.favorite = false; s.inventory.push(it);
        if (tab !== 'inv' && tab !== 'main') tab = 'inv';
        break;
      }
      case 'spell': if (!s.spells.known.some(x => x.name === e.name)) s.spells.known.push(M.spellFromCompendium(e)); if (tab !== 'spells') tab = 'spells'; break;
      case 'feat': case 'condition': s.features.push(M.newFeature({name:e.name,text:d.desc||'',actions:d.actions||[],mechanics:d.mechanics})); break;
      default: toast('Нельзя применить к листу');
    }
    save(); render(); toast(`${e.name} добавлено`);
  }

  // ---- встроенный справочник ----
  let compEl;
  function toggleComp(cat) {
    if (compEl) { compEl.remove(); compEl = null; if (!cat) return; }
    compEl = floatWindow('Справочник (перетаскивайте на лист)', el('div', { style: 'height:100%;padding:8px' }, Compendium.widget({ campaignId: ch.campaign_id, category: cat, edition: s.edition || '2014' })), { x: Math.max(0, window.innerWidth - Math.min(780, window.innerWidth - 20) - 10), y: 50, w: Math.min(780, window.innerWidth - 20), h: Math.min(640, window.innerHeight - 70) });
  }

  render();
})();
