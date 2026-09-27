// Лист персонажа. Работает и в iframe поверх стола (embed=1), и как отдельная страница/окно.
// Предметы и заклинания — модули (Modules.*): их можно перетаскивать между окнами, на стол и другим игрокам.
(async function () {
  const M = window.Modules;
  const app = document.getElementById('app');
  const id = location.pathname.split('/').pop();
  const embed = new URLSearchParams(location.search).get('embed') === '1';
  let me; try { me = await API.get('/api/auth/me'); } catch { app.innerHTML = '<div class="center"><div class="card">Нужно войти. <a href="/">На главную</a></div></div>'; return; }
  let ch; try { ch = await API.get('/api/characters/' + id); } catch (e) { app.innerHTML = `<div class="center"><div class="card">${e.message}</div></div>`; return; }
  let s = ch.sheet; let readonly = false;
  try { await API.patch('/api/characters/' + id, {}); } catch { readonly = true; }
  document.title = ch.name + ' — лист';
  let tab = localStorage.getItem('sheet_tab_' + id) || 'main';
  const ui = { invQ: '', invType: '', spellQ: '', onlyPrepared: false, open: new Set() };

  // ---- миграция старых данных в модули ----
  function migrate() {
    s.inventory ||= []; s.spells ||= { ability: 'int', slots: {}, known: [] }; s.spells.known ||= []; s.spells.slots ||= {}; s.features ||= []; s.attacks ||= []; s.currency ||= { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }; s.traits ||= {};
    s.inventory = s.inventory.map(it => it.uid ? it : M.newItem({ ...it, type: it.type || 'gear' }));
    s.spells.known = s.spells.known.map(sp => sp.uid ? sp : M.newSpell({ ...sp, actions: sp.actions || [] }));
  }
  migrate();

  let saveTimer;
  const status = el('span', { class: 'muted', style: 'font-size:11px' });
  function save(now) {
    clearTimeout(saveTimer); status.textContent = '…';
    const doIt = async () => { if (readonly) return; try { await API.patch('/api/characters/' + id, { sheet: s }); status.textContent = 'сохранено'; } catch (e) { status.textContent = 'ошибка: ' + e.message; } };
    if (now) return doIt(); saveTimer = setTimeout(doIt, 400);
  }
  async function reload() { try { const fresh = await API.get('/api/characters/' + id); ch = fresh; s = fresh.sheet; migrate(); render(); } catch { } }
  window.addEventListener('message', e => { if (e.data?.type === 'character_update' && (!e.data.id || e.data.id === id)) reload(); });

  const prof = () => s.proficiency_bonus || Math.ceil(1 + (s.level || 1) / 4);
  const abMod = (k) => mod(s.abilities[k]);
  const skillVal = (k, ab) => abMod(ab) + (s.expertise.includes(k) ? 2 : s.skills.includes(k) ? 1 : 0) * prof();
  const saveVal = (k) => abMod(k) + (s.saving_throws.includes(k) ? prof() : 0);
  const passive = () => 10 + skillVal('perception', 'wis');
  const ctx = () => { const c = M.ctxFromSheet(s); window.SHEET_CTX = c; return c; };
  function roll(expr, label) { M.roll(expr, `${ch.name}: ${label}`, { ctx: ctx() }); }
  const dis = () => readonly ? '' : null;

  // ---- отправка в чат / на карту / другому персонажу ----
  function sendCard(doc, kind) { M.sendCard({ ...M.toChatCard(doc, kind), owner: ch.name }); toast('Отправлено в чат'); }
  async function transfer(it) {
    if (!ch.campaign_id) return toast('Персонаж не в кампании');
    const chars = (await API.get('/api/characters?campaign_id=' + ch.campaign_id)).filter(c => c.id !== id);
    if (!chars.length) return toast('Некому передать');
    const sel = el('select', {}, ...chars.map(c => el('option', { value: c.id }, c.name + (c.owner_name ? ` (${c.owner_name})` : ''))));
    const qty = el('input', { type: 'number', value: it.qty || 1, min: 1, max: it.qty || 1 });
    const ok = await modal(`Передать «${it.name}»`, el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Кому'), sel), it.qty > 1 ? el('div', { class: 'field' }, el('label', {}, 'Сколько'), qty) : null), [{ label: 'Передать', cls: 'primary', fn: () => ({ to: sel.value, qty: +qty.value }) }]);
    if (!ok) return;
    try { await API.post(`/api/characters/${id}/transfer`, { item_uid: it.uid, to_character_id: ok.to, qty: ok.qty }); toast('Передано'); reload(); } catch (e) { toast('Ошибка: ' + e.message); }
  }
  function dropToMap(it) {
    const target = window.parent !== window ? window.parent : (window.opener && !window.opener.closed ? window.opener : null);
    if (!target) return toast('Стол не открыт');
    target.postMessage({ type: 'loot_drop', item: it, from_character_id: id }, '*');
    s.inventory = s.inventory.filter(x => x.uid !== it.uid); save(true); render(); toast('Выложено на стол');
  }

  // ================= РЕНДЕР =================
  function render() {
    ctx();
    app.innerHTML = '';
    const root = el('div', { class: 'sheet' });
    root.append(topBar());
    const tabs = [['main', 'Основное'], ['inv', `Инвентарь (${s.inventory.length})`], ['spells', `Заклинания (${s.spells.known.length})`], ['feats', `Умения (${s.features.length})`], ['notes', 'Заметки']];
    root.append(el('div', { class: 'tabs sheet-tabs' }, ...tabs.map(([k, n]) => el('button', { class: tab === k ? 'active' : '', onclick: () => { tab = k; localStorage.setItem('sheet_tab_' + id, k); render(); } }, n))));
    root.append({ main: mainTab, inv: invTab, spells: spellsTab, feats: featsTab, notes: notesTab }[tab]());
    app.append(root);
    if (!readonly) bindDrops(root);
  }

  function topBar() {
    const portrait = el('div', { class: 'portrait', title: 'Загрузить портрет' }, icon('user', 40));
    if (ch.portrait_asset_id) assetURL(ch.portrait_asset_id).then(u => { portrait.innerHTML = ''; portrait.append(el('img', { src: u })); });
    const pf = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    pf.addEventListener('change', async () => { const fd = new FormData(); fd.append('file', pf.files[0]); fd.append('name', ch.name); fd.append('kind', 'portrait'); if (ch.campaign_id) fd.append('campaign_id', ch.campaign_id); const a = await API.upload('/api/assets', fd); ch.portrait_asset_id = a.id; await API.patch('/api/characters/' + id, { portrait_asset_id: a.id }); render(); });
    if (!readonly) portrait.addEventListener('click', () => pf.click());
    const inp = (key, ph, type = 'text') => el('input', { value: s[key] ?? '', placeholder: ph, type, disabled: dis(), onchange: e => { s[key] = type === 'number' ? +e.target.value : e.target.value; if (key === 'level') s.proficiency_bonus = Math.ceil(1 + s.level / 4); save(); if (['level', 'name'].includes(key)) render(); } });
    const head = el('div', { class: 'head' }, portrait, el('div', {},
      el('div', { class: 'row', style: 'margin-bottom:6px' }, el('div', { style: 'flex:2' }, el('label', {}, 'Имя'), inp('name', 'Имя персонажа')), el('div', {}, el('label', {}, 'Уровень'), inp('level', '1', 'number')), el('div', {}, el('label', {}, 'Опыт'), inp('xp', '0', 'number'))),
      el('div', { class: 'row' }, el('div', { class: 'dropslot', 'data-cat': 'race' }, el('label', {}, 'Раса ⤓'), inp('race', 'перетащите из справочника')), el('div', { class: 'dropslot', 'data-cat': 'class' }, el('label', {}, 'Класс ⤓'), inp('class', 'перетащите')), el('div', {}, el('label', {}, 'Подкласс'), inp('subclass', '')), el('div', { class: 'dropslot', 'data-cat': 'background' }, el('label', {}, 'Предыстория ⤓'), inp('background', '')), el('div', {}, el('label', {}, 'Мировоззрение'), inp('alignment', '')))));
    const bar = el('div', { class: 'row', style: 'margin-bottom:6px' }, el('h1', { style: 'flex:1' }, ch.name), status,
      embed ? el('button', { class: 'small', style: 'flex:0', onclick: () => window.open('/sheet/' + id, 'sheet_' + id, 'width=1000,height=800') }, 'В окно') : null,
      el('button', { class: 'small', style: 'flex:0', onclick: () => toggleComp() }, 'Справочник'),
      embed ? null : Theme.button(),
      readonly ? el('span', { class: 'badge' }, 'только чтение') : el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: s.shared ? '' : null, onchange: e => { s.shared = e.target.checked; save(); } }), ' виден игрокам'));
    return el('div', {}, bar, head);
  }

  // ---------- вкладка Основное ----------
  function mainTab() {
    const cols = el('div', { class: 'cols' });
    const c1 = el('div');
    const abil = el('div', { class: 'abil' });
    for (const [k, name] of Object.entries(ABIL)) {
      abil.append(el('div', { class: 'ab', title: 'Клик — проверка характеристики', onclick: e => { if (e.target.tagName !== 'INPUT') roll('d20' + fmtMod(abMod(k)), 'проверка ' + name); } },
        el('small', {}, name), el('div', { class: 'mod' }, fmtMod(abMod(k))), el('input', { type: 'number', value: s.abilities[k], disabled: dis(), onchange: ev => { s.abilities[k] = +ev.target.value; save(); render(); }, onclick: ev => ev.stopPropagation() })));
    }
    c1.append(abil);
    c1.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Спасброски'), el('div', { class: 'skills' }, ...Object.entries(ABIL).map(([k, name]) => el('div', { onclick: e => { if (e.target.classList.contains('pip')) return; roll('d20' + fmtMod(saveVal(k)), 'спасбросок ' + name); } },
      el('span', { class: 'pip' + (s.saving_throws.includes(k) ? ' on' : ''), onclick: () => { if (readonly) return; s.saving_throws = s.saving_throws.includes(k) ? s.saving_throws.filter(x => x !== k) : [...s.saving_throws, k]; save(); render(); } }), el('span', { class: 'val' }, fmtMod(saveVal(k))), name)))));
    c1.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Навыки'), el('div', { class: 'skills' }, ...SKILLS.map(([k, name, ab]) => el('div', { onclick: e => { if (e.target.classList.contains('pip')) return; roll('d20' + fmtMod(skillVal(k, ab)), name); } },
      el('span', { class: 'pip' + (s.expertise.includes(k) ? ' exp' : s.skills.includes(k) ? ' on' : ''), title: 'клик: нет → владение → компетентность', onclick: () => { if (readonly) return; if (s.expertise.includes(k)) { s.expertise = s.expertise.filter(x => x !== k); s.skills = s.skills.filter(x => x !== k); } else if (s.skills.includes(k)) s.expertise.push(k); else s.skills.push(k); save(); render(); } }),
      el('span', { class: 'val' }, fmtMod(skillVal(k, ab))), name, el('span', { class: 'muted', style: 'font-size:10px' }, ' (' + ABIL[ab].slice(0, 3) + ')')))),
      el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, 'Пассивное восприятие: ', el('b', {}, passive()), ' · Бонус мастерства: ', el('b', {}, fmtMod(prof())))));

    const c2 = el('div');
    const hp = s.hp;
    c2.append(el('div', { class: 'stat3' },
      el('div', { class: 'card' }, el('label', {}, 'КД'), el('input', { class: 'inline', type: 'number', value: s.ac, disabled: dis(), onchange: e => { s.ac = +e.target.value; save(); } })),
      el('div', { class: 'card', style: 'cursor:pointer', onclick: () => roll('d20' + fmtMod(abMod('dex') + (s.initiative_bonus || 0)), 'инициатива') }, el('label', {}, 'Инициатива'), el('b', {}, fmtMod(abMod('dex') + (s.initiative_bonus || 0)))),
      el('div', { class: 'card' }, el('label', {}, 'Скорость'), el('input', { class: 'inline', type: 'number', value: s.speed, disabled: dis(), onchange: e => { s.speed = +e.target.value; save(); } }))));
    c2.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Хиты'),
      el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Текущие'), el('input', { type: 'number', value: hp.current, disabled: dis(), onchange: e => { hp.current = +e.target.value; save(); render(); } })), el('div', {}, el('label', {}, 'Макс'), el('input', { type: 'number', value: hp.max, disabled: dis(), onchange: e => { hp.max = +e.target.value; save(); render(); } })), el('div', {}, el('label', {}, 'Врем.'), el('input', { type: 'number', value: hp.temp, disabled: dis(), onchange: e => { hp.temp = +e.target.value; save(); } })), el('div', {}, el('label', {}, 'Кости хитов'), el('input', { value: hp.hit_dice, disabled: dis(), onchange: e => { hp.hit_dice = e.target.value; save(); } }))),
      el('div', { class: 'hpbar' }, el('div', { style: `width:${Math.max(0, Math.min(100, hp.current / (hp.max || 1) * 100))}%` })),
      el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { class: 'small', onclick: async () => { const v = +(await prompt2('Урон')) || 0; hp.current -= v; save(); render(); } }, '− Урон'), el('button', { class: 'small', onclick: async () => { const v = +(await prompt2('Лечение')) || 0; hp.current = Math.min(hp.max, hp.current + v); save(); render(); } }, '+ Лечение'), el('button', { class: 'small', onclick: () => roll(hp.hit_dice + fmtMod(abMod('con')), 'кость хитов') }, 'Кость хитов')),
      el('div', { class: 'row', style: 'margin-top:6px;font-size:12px' }, el('span', {}, 'Спасброски от смерти: ', ...[0, 1, 2].map(i => el('span', { class: 'pip', style: 'display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid var(--ok);margin:0 2px;cursor:pointer;background:' + (s.death_saves.success > i ? 'var(--ok)' : 'transparent'), onclick: () => { s.death_saves.success = s.death_saves.success > i ? i : i + 1; save(); render(); } })), ' / ', ...[0, 1, 2].map(i => el('span', { style: 'display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid var(--danger);margin:0 2px;cursor:pointer;background:' + (s.death_saves.failure > i ? 'var(--danger)' : 'transparent'), onclick: () => { s.death_saves.failure = s.death_saves.failure > i ? i : i + 1; save(); render(); } }))),
        el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: s.inspiration ? '' : null, onchange: e => { s.inspiration = e.target.checked; save(); } }), ' Вдохновение'))));

    // Действия: экипированные предметы с кнопками + подготовленные заклинания с атаками + ручные атаки
    const act = el('div', { class: 'card dropslot', 'data-cat': 'item', style: 'margin-top:8px' }, el('h3', {}, 'Действия ⤓'));
    const c = ctx();
    const eq = s.inventory.filter(it => it.equipped && (it.actions || []).some(a => a.roll));
    eq.forEach(it => act.append(el('div', { class: 'act-line' }, el('span', { class: 'card-icon' }, M.itemIcon(it)), el('b', { style: 'cursor:pointer', title: 'Открыть в инвентаре', onclick: () => { tab = 'inv'; ui.open.add(it.uid); render(); } }, it.name), M.actionButtons(it, c, `${ch.name}: ${it.name}`))));
    const castable = s.spells.known.filter(sp => (sp.prepared || sp.level === 0) && (sp.actions || []).some(a => a.roll));
    castable.forEach(sp => act.append(el('div', { class: 'act-line' }, el('span', { class: 'card-icon' }, icon('star', 18)), el('b', {}, sp.name), M.actionButtons(sp, c, `${ch.name}: ${sp.name}`))));
    if (s.attacks.length) act.append(el('div', { class: 'atk-row muted', style: 'font-size:11px' }, el('span', {}, 'Ручные атаки'), el('span', {}, 'Атака'), el('span', {}, 'Урон'), el('span'), el('span')));
    s.attacks.forEach((a, i) => act.append(el('div', { class: 'atk-row' },
      el('input', { value: a.name, disabled: dis(), onchange: e => { a.name = e.target.value; save(); } }), el('input', { value: a.bonus, disabled: dis(), onchange: e => { a.bonus = e.target.value; save(); } }), el('input', { value: a.damage, disabled: dis(), onchange: e => { a.damage = e.target.value; save(); } }),
      el('button', { class: 'small', title: 'Бросок атаки', onclick: () => roll('d20' + (/^[+-]/.test(a.bonus) ? a.bonus : '+' + (a.bonus || 0)), a.name + ' (атака)') }, icon('target')),
      el('button', { class: 'small', title: 'Урон', onclick: () => roll(a.damage.replace(/[^\dкd+\-khl@a-z_]/gi, ''), a.name + ' (урон)') }, icon('zap')),
      readonly ? null : el('button', { class: 'small danger', style: 'grid-column:1/-1;justify-self:end;padding:0 6px', onclick: () => { s.attacks.splice(i, 1); save(); render(); } }, 'убрать'))));
    if (!eq.length && !castable.length && !s.attacks.length) act.append(el('p', { class: 'muted small' }, 'Экипируйте оружие во вкладке «Инвентарь» или подготовьте заклинания — их кнопки появятся здесь.'));
    if (!readonly) act.append(el('div', { class: 'row', style: 'margin-top:6px' }, el('button', { class: 'small', onclick: () => { s.attacks.push({ name: 'Атака', bonus: fmtMod(abMod('str') + prof()), damage: '1d8' + fmtMod(abMod('str')) }); save(); render(); } }, '+ Ручная атака'), el('button', { class: 'small', onclick: async () => { const it = await M.editItem(M.newItem({ type: 'weapon', equipped: true, actions: [{ name: 'Атака', kind: 'attack', roll: '1d20+@atk' }, { name: 'Урон', kind: 'damage', roll: '1d8+@best' }] })); if (it) { s.inventory.push(it); save(); render(); } } }, '+ Оружие')));
    c2.append(act);
    // Кратко: экипировка и настройка
    const wearing = s.inventory.filter(it => it.equipped);
    c2.append(el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Экипировано'), wearing.length ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px' }, ...wearing.map(it => el('span', { class: 'chip', style: 'cursor:pointer', onclick: () => { tab = 'inv'; ui.open.add(it.uid); render(); } }, M.itemIcon(it) + ' ' + it.name + (it.attuned ? ' (настроен)' : '')))) : el('span', { class: 'muted small' }, 'ничего'),
      el('div', { class: 'muted small', style: 'margin-top:4px' }, `Настроено: ${s.inventory.filter(i => i.attuned).length}/3 · Вес: ${totalWeight()} / ${s.abilities.str * 15} фнт`)));
    cols.append(c1, c2);
    return cols;
  }
  const totalWeight = () => Math.round(s.inventory.reduce((a, b) => a + (+b.weight || 0) * (b.qty || 1), 0) * 10) / 10;

  // ---------- вкладка Инвентарь ----------
  function invTab() {
    const root = el('div', { class: 'inv dropslot', 'data-cat': 'item' });
    const bar = el('div', { class: 'inv-bar' },
      el('input', { placeholder: 'Поиск по предметам', value: ui.invQ, oninput: e => { ui.invQ = e.target.value; drawList(); } }),
      el('select', { onchange: e => { ui.invType = e.target.value; drawList(); } }, el('option', { value: '' }, 'Все типы'), ...Object.entries(M.ITEM_TYPES).map(([k, v]) => el('option', { value: k, selected: ui.invType === k ? '' : null }, v))),
      readonly ? null : el('button', { class: 'primary small', onclick: async () => { const it = await M.editItem(null); if (it) { s.inventory.push(it); save(); render(); } } }, '+ Предмет'),
      el('button', { class: 'small', onclick: () => toggleComp('item') }, 'Справочник'));
    const wallet = el('div', { class: 'wallet' }, ...['pp', 'gp', 'ep', 'sp', 'cp'].map(c => el('label', {}, { pp: 'ПМ', gp: 'ЗМ', ep: 'ЭМ', sp: 'СМ', cp: 'ММ' }[c], el('input', { type: 'number', value: s.currency[c], disabled: dis(), onchange: e => { s.currency[c] = +e.target.value; save(); } }))),
      el('span', { class: 'muted small', style: 'margin-left:auto' }, `Вес: ${totalWeight()} / ${s.abilities.str * 15} фнт${totalWeight() > s.abilities.str * 15 ? ' — перегруз' : ''}`));
    const list = el('div', { class: 'inv-list' });
    root.append(bar, wallet, list);
    function drawList() {
      list.innerHTML = '';
      const q = ui.invQ.toLowerCase();
      const items = s.inventory.filter(it => (!q || it.name.toLowerCase().includes(q) || (it.desc || '').toLowerCase().includes(q) || (it.tags || []).some(t => t.toLowerCase().includes(q))) && (!ui.invType || it.type === ui.invType));
      const sections = [['Экипировано', items.filter(i => i.equipped)], ['Рюкзак', items.filter(i => !i.equipped)]];
      for (const [title, arr] of sections) {
        if (!arr.length && title === 'Экипировано') continue;
        list.append(el('h3', { class: 'inv-sec' }, title, el('span', { class: 'muted small' }, ` ${arr.length}`)));
        const grid = el('div', { class: 'cards' });
        if (!arr.length) grid.append(el('div', { class: 'muted small', style: 'padding:12px' }, 'Пусто. Перетащите предмет из справочника, с другого листа или создайте свой.'));
        arr.forEach(it => grid.append(itemCard(it)));
        list.append(grid);
      }
    }
    drawList();
    return root;
  }
  function itemCard(it) {
    const c = ctx();
    const open = ui.open.has(it.uid);
    const card = el('div', { class: 'mcard' + (it.equipped ? ' equipped' : '') + (open ? ' open' : ''), draggable: readonly ? null : 'true', 'data-uid': it.uid, style: `--rar:${M.RARITY_COLORS[it.rarity] || 'var(--border)'}` });
    const head = el('div', { class: 'mcard-head', onclick: () => { if (open) ui.open.delete(it.uid); else ui.open.add(it.uid); render(); } },
      el('span', { class: 'card-icon big' }, M.itemIcon(it)),
      el('div', { class: 'grow' }, el('div', { class: 'mcard-name' }, it.name, it.attuned ? el('span', { class: 'muted small', title: 'настроен' }, ' · настроен') : null), el('div', { class: 'muted small' }, [M.ITEM_TYPES[it.type]?.slice(2), it.rarity !== 'Обычный' ? it.rarity : null, it.weight ? `${it.weight} фнт` : null, it.charges ? `заряды ${it.charges.cur}/${it.charges.max}` : null].filter(Boolean).join(' · '))),
      el('div', { class: 'qty', onclick: e => e.stopPropagation() }, readonly ? el('span', {}, '×' + it.qty) : [el('button', { class: 'tiny', onclick: () => { it.qty = Math.max(1, (it.qty || 1) - 1); save(); render(); } }, '−'), el('span', {}, it.qty || 1), el('button', { class: 'tiny', onclick: () => { it.qty = (it.qty || 1) + 1; save(); render(); } }, '+')]),
      readonly ? null : el('button', { class: 'tiny eq' + (it.equipped ? ' on' : ''), title: it.equipped ? 'Снять' : 'Экипировать', onclick: e => { e.stopPropagation(); it.equipped = !it.equipped; save(); render(); } }, icon('check', 12)));
    card.append(head);
    const acts = M.actionButtons(it, c, `${ch.name}: ${it.name}`);
    if (acts.children.length) card.append(acts);
    if (open) {
      const body = el('div', { class: 'mcard-body' });
      if (it.desc) body.append(el('div', { class: 'card-desc' }, M.rich(it.desc, c, { prefix: `${ch.name}: ${it.name}` })));
      if (it.charges) body.append(el('div', { class: 'row small', style: 'align-items:center;gap:6px' }, 'Заряды: ', ...Array.from({ length: it.charges.max }, (_, i) => el('span', { class: 'pip' + (i < it.charges.cur ? ' on' : ''), style: 'cursor:pointer', onclick: () => { if (readonly) return; it.charges.cur = i < it.charges.cur ? i : i + 1; save(); render(); } })), it.charges.recharge ? el('span', { class: 'muted' }, `(${it.charges.recharge})`) : null));
      if (it.cost || it.source) body.append(el('div', { class: 'muted small' }, [it.cost, it.source].filter(Boolean).join(' · ')));
      const menu = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin-top:6px' },
        el('button', { class: 'small', onclick: () => sendCard(it, 'item') }, 'В чат'));
      if (!readonly) menu.append(
        el('button', { class: 'small', onclick: async () => { const r = await M.editItem(it); if (r) { Object.assign(it, r); save(); render(); } } }, 'Изменить'),
        it.attunement ? el('button', { class: 'small', onclick: () => { it.attuned = !it.attuned; save(); render(); } }, it.attuned ? 'Снять настройку' : 'Настроиться') : null,
        it.type === 'consumable' ? el('button', { class: 'small', onclick: () => { it.qty = (it.qty || 1) - 1; sendCard(it, 'item'); if (it.qty <= 0) s.inventory = s.inventory.filter(x => x !== it); save(); render(); } }, 'Использовать') : null,
        ch.campaign_id ? el('button', { class: 'small', onclick: () => transfer(it) }, 'Передать') : null,
        ch.campaign_id ? el('button', { class: 'small', onclick: () => dropToMap(it) }, 'На стол') : null,
        it.qty > 1 ? el('button', { class: 'small', onclick: async () => { const n = +(await prompt2('Отделить сколько?', '', '1')); if (n > 0 && n < it.qty) { it.qty -= n; s.inventory.push({ ...JSON.parse(JSON.stringify(it)), uid: M.uid(), qty: n, equipped: false }); save(); render(); } } }, 'Разделить') : null,
        el('button', { class: 'small danger', style: 'margin-left:auto', onclick: () => { if (confirm(`Удалить «${it.name}»?`)) { s.inventory = s.inventory.filter(x => x !== it); save(); render(); } } }, icon('trash')));
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
          if (from >= 0 && to >= 0 && from !== to) { const [m] = s.inventory.splice(from, 1); if (m.equipped !== it.equipped) m.equipped = it.equipped; s.inventory.splice(to, 0, m); save(); render(); }
        } else acceptItem(p);
      });
    }
    return card;
  }
  async function acceptItem(p) {
    if (p.from_character_id && p.from_character_id !== id) {
      try { await API.post(`/api/characters/${p.from_character_id}/transfer`, { item_uid: p.item.uid, to_character_id: id }); toast(`${p.item.name} получено`); reload(); } catch (e) { toast('Не удалось передать: ' + e.message); }
    } else if (!p.from_character_id) { s.inventory.push({ ...p.item, uid: M.uid() }); save(); render(); toast(`${p.item.name} добавлено`); }
  }

  // ---------- вкладка Заклинания ----------
  function spellsTab() {
    const sp = s.spells, c = ctx();
    const root = el('div', { class: 'inv dropslot', 'data-cat': 'spell' });
    const spAb = sp.ability || 'int';
    root.append(el('div', { class: 'inv-bar' },
      el('label', { style: 'flex:0;white-space:nowrap' }, 'Хар-ка ', el('select', { style: 'width:auto;padding:4px', disabled: dis(), onchange: e => { sp.ability = e.target.value; save(); render(); } }, ...['int', 'wis', 'cha'].map(k => el('option', { value: k, selected: spAb === k ? '' : null }, ABIL[k])))),
      el('span', { class: 'chip' }, 'СЛ ', el('b', {}, c.dc)), el('span', { class: 'chip', style: 'cursor:pointer', onclick: () => roll('d20' + fmtMod(c.spell), 'атака заклинанием') }, 'Атака ', el('b', {}, fmtMod(c.spell))),
      el('input', { placeholder: 'Поиск', value: ui.spellQ, oninput: e => { ui.spellQ = e.target.value; draw(); } }),
      el('label', { style: 'flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: ui.onlyPrepared ? '' : null, onchange: e => { ui.onlyPrepared = e.target.checked; draw(); } }), ' только подготовленные'),
      readonly ? null : el('button', { class: 'primary small', onclick: async () => { const x = await M.editSpell(null); if (x) { sp.known.push(x); save(); render(); } } }, '+ Заклинание'),
      el('button', { class: 'small', onclick: () => toggleComp('spell') }, 'Справочник')));
    const slots = el('div', { class: 'slots' });
    for (let l = 1; l <= 9; l++) {
      const sl = sp.slots[l] || { max: 0, used: 0 }; if (!sl.max && readonly) continue;
      slots.append(el('div', { class: 'slot' + (sl.max ? '' : ' empty') }, el('b', {}, l), el('span', { class: 'pips' }, ...Array.from({ length: sl.max }, (_, i) => el('span', { class: 'pip' + (i >= sl.used ? ' on' : ''), title: 'клик — потратить/вернуть', onclick: () => { sl.used = i >= sl.used ? i + 1 : i; sp.slots[l] = sl; save(); render(); } }))),
        readonly ? null : el('input', { type: 'number', value: sl.max, min: 0, title: 'Всего ячеек', onchange: e => { sl.max = +e.target.value; sl.used = Math.min(sl.used, sl.max); sp.slots[l] = sl; save(); render(); } })));
    }
    if (!readonly) slots.append(el('button', { class: 'small', title: 'Восстановить все ячейки (длинный отдых)', onclick: () => { for (const k in sp.slots) sp.slots[k].used = 0; save(); render(); } }, 'Долгий отдых'));
    root.append(slots);
    const list = el('div');
    root.append(list);
    function draw() {
      list.innerHTML = '';
      const q = ui.spellQ.toLowerCase();
      const arr = sp.known.filter(x => (!q || x.name.toLowerCase().includes(q) || (x.desc || '').toLowerCase().includes(q)) && (!ui.onlyPrepared || x.prepared || x.level === 0));
      if (!arr.length) list.append(el('p', { class: 'muted small', style: 'padding:12px' }, 'Нет заклинаний. Перетащите из справочника или создайте своё.'));
      for (let l = 0; l <= 9; l++) {
        const lv = arr.filter(x => (x.level || 0) === l); if (!lv.length) continue;
        list.append(el('h3', { class: 'inv-sec' }, l === 0 ? 'Заговоры' : `${l} круг`, el('span', { class: 'muted small' }, ` ${lv.length}`)));
        const grid = el('div', { class: 'cards' });
        lv.sort((a, b) => a.name.localeCompare(b.name)).forEach(x => grid.append(spellCard(x)));
        list.append(grid);
      }
    }
    draw();
    return root;
  }
  function spellCard(x) {
    const c = ctx(), sp = s.spells;
    const open = ui.open.has(x.uid);
    const card = el('div', { class: 'mcard spell' + (x.prepared || x.level === 0 ? ' equipped' : '') + (open ? ' open' : ''), draggable: 'true', style: '--rar:var(--accent)' });
    card.append(el('div', { class: 'mcard-head', onclick: () => { if (open) ui.open.delete(x.uid); else ui.open.add(x.uid); render(); } },
      el('span', { class: 'card-icon big' }, icon('star', 22)),
      el('div', { class: 'grow' }, el('div', { class: 'mcard-name' }, x.name, x.concentration ? el('span', { class: 'badge', title: 'концентрация' }, 'К') : null, x.ritual ? el('span', { class: 'badge', title: 'ритуал' }, 'Р') : null), el('div', { class: 'muted small' }, [x.school, x.casting_time, x.range, x.duration].filter(Boolean).join(' · '))),
      x.level > 0 ? el('button', { class: 'tiny cast', title: 'Сотворить: тратит ячейку и отправляет карточку в чат', onclick: e => { e.stopPropagation(); cast(x); } }, icon('wand')) : el('button', { class: 'tiny cast', title: 'В чат', onclick: e => { e.stopPropagation(); sendCard(x, 'spell'); } }, icon('chat')),
      readonly || x.level === 0 ? null : el('button', { class: 'tiny eq' + (x.prepared ? ' on' : ''), title: x.prepared ? 'Подготовлено' : 'Не подготовлено', onclick: e => { e.stopPropagation(); x.prepared = !x.prepared; save(); render(); } }, icon('check', 12))));
    const acts = M.actionButtons(x, c, `${ch.name}: ${x.name}`);
    if (acts.children.length) card.append(acts);
    if (open) {
      const body = el('div', { class: 'mcard-body' }, el('div', { class: 'muted small' }, [x.components, x.classes?.length ? 'Классы: ' + x.classes.join(', ') : null, x.source].filter(Boolean).join(' · ')));
      if (x.desc) body.append(el('div', { class: 'card-desc' }, M.rich(x.desc, c, { prefix: `${ch.name}: ${x.name}` })));
      const menu = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin-top:6px' }, el('button', { class: 'small', onclick: () => sendCard(x, 'spell') }, 'В чат'));
      if (!readonly) menu.append(el('button', { class: 'small', onclick: async () => { const r = await M.editSpell(x); if (r) { Object.assign(x, r); save(); render(); } } }, 'Изменить'),
        el('button', { class: 'small danger', style: 'margin-left:auto', onclick: () => { sp.known = sp.known.filter(y => y !== x); save(); render(); } }, icon('trash')));
      body.append(menu); card.append(body);
    }
    card.addEventListener('dragstart', ev => M.setDrag(ev, 'application/x-spell', { spell: x, from_character_id: id }));
    return card;
  }
  async function cast(x) {
    const sp = s.spells;
    const avail = []; for (let l = x.level; l <= 9; l++) { const sl = sp.slots[l]; if (sl && sl.max - sl.used > 0) avail.push(l); }
    if (!avail.length) { if (!confirm('Нет свободных ячеек. Всё равно сотворить?')) return; sendCard(x, 'spell'); return; }
    let lvl = avail[0];
    if (avail.length > 1) { const sel = el('select', {}, ...avail.map(l => el('option', { value: l }, `${l} круг (${sp.slots[l].max - sp.slots[l].used} свободно)`))); const ok = await modal(`Сотворить «${x.name}»`, el('div', { class: 'field' }, el('label', {}, 'Ячейка'), sel), [{ label: 'Сотворить', cls: 'primary', fn: () => +sel.value }]); if (!ok) return; lvl = ok; }
    sp.slots[lvl].used++; save(); render();
    M.sendCard({ ...M.toChatCard(x, 'spell'), owner: ch.name, meta: `${lvl} круг · ` + (M.toChatCard(x, 'spell').meta || '') });
  }

  // ---------- вкладка Умения ----------
  function featsTab() {
    const c = ctx();
    const root = el('div', { class: 'inv dropslot', 'data-cat': 'feat' });
    root.append(el('div', { class: 'inv-bar' }, el('span', { class: 'muted small', style: 'flex:1' }, 'Умения классов, расовые особенности, черты. В тексте работают кнопки бросков: [[1d20+@prof]]{Проверка}.'),
      readonly ? null : el('button', { class: 'primary small', onclick: () => editFeature(null) }, '+ Умение'), el('button', { class: 'small', onclick: () => toggleComp('feat') }, 'Справочник')));
    const grid = el('div', { class: 'cards one' });
    s.features.forEach((f, i) => {
      const open = ui.open.has('f' + i);
      const card = el('div', { class: 'mcard' + (open ? ' open' : ''), style: '--rar:var(--border)' });
      card.append(el('div', { class: 'mcard-head', onclick: () => { if (open) ui.open.delete('f' + i); else ui.open.add('f' + i); render(); } }, el('span', { class: 'card-icon big' }, icon('scroll', 22)), el('div', { class: 'grow' }, el('div', { class: 'mcard-name' }, f.name), !open ? el('div', { class: 'muted small ellipsis' }, (f.text || '').slice(0, 120)) : null),
        f.uses ? el('span', { class: 'small', onclick: e => e.stopPropagation() }, ...Array.from({ length: f.uses.max }, (_, k) => el('span', { class: 'pip' + (k < f.uses.cur ? ' on' : ''), style: 'cursor:pointer', onclick: () => { f.uses.cur = k < f.uses.cur ? k : k + 1; save(); render(); } }))) : null));
      if (f.actions?.length) card.append(M.actionButtons(f, c, `${ch.name}: ${f.name}`));
      if (open) card.append(el('div', { class: 'mcard-body' }, el('div', { class: 'card-desc' }, M.rich(f.text || '', c, { prefix: `${ch.name}: ${f.name}` })),
        el('div', { class: 'row', style: 'gap:4px;margin-top:6px' }, el('button', { class: 'small', onclick: () => M.sendCard({ name: f.name, kind: 'feat', desc: f.text, actions: f.actions || [], icon: 'scroll', owner: ch.name }) }, 'В чат'), readonly ? null : el('button', { class: 'small', onclick: () => editFeature(f) }, 'Изменить'), readonly ? null : el('button', { class: 'small danger', style: 'margin-left:auto', onclick: () => { s.features.splice(i, 1); save(); render(); } }, icon('trash')))));
      grid.append(card);
    });
    if (!s.features.length) grid.append(el('p', { class: 'muted small', style: 'padding:12px' }, 'Пока пусто. Перетащите расу/класс/черту из справочника.'));
    root.append(grid);
    return root;
  }
  async function editFeature(f) {
    const d = JSON.parse(JSON.stringify(f || { name: '', text: '', actions: [] })); d.actions ||= [];
    const usesMax = el('input', { type: 'number', value: d.uses?.max ?? '', placeholder: '—' });
    const ok = await modal(f ? 'Изменить умение' : 'Новое умение', el('div', { class: 'editor-form' }, el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:3' }, el('label', {}, 'Название'), el('input', { value: d.name, oninput: e => d.name = e.target.value })), el('div', { class: 'field' }, el('label', {}, 'Использований (макс)'), usesMax)),
      el('div', { class: 'field' }, el('label', {}, 'Описание'), M.descEditor(d, 'text')), el('div', { class: 'field' }, el('label', {}, 'Действия'), M.actionsEditor(d))), [{ label: 'Сохранить', cls: 'primary', fn: () => true }], { wide: true });
    if (!ok) return;
    const um = +usesMax.value; d.uses = um > 0 ? { cur: Math.min(d.uses?.cur ?? um, um), max: um } : undefined;
    if (f) Object.assign(f, d); else s.features.push(d);
    save(); render();
  }

  // ---------- вкладка Заметки ----------
  function notesTab() {
    const root = el('div', { class: 'cols2' });
    const pers = el('div', { class: 'card' }, el('h3', {}, 'Личность'));
    for (const [k, n] of [['personality', 'Черты характера'], ['ideals', 'Идеалы'], ['bonds', 'Привязанности'], ['flaws', 'Слабости'], ['appearance', 'Внешность'], ['backstory', 'Предыстория']]) pers.append(el('div', { class: 'field' }, el('label', {}, n), el('textarea', { disabled: dis(), style: 'min-height:48px', onchange: e => { s.traits[k] = e.target.value; save(); } }, s.traits[k] || '')));
    const notes = el('div', { class: 'card' }, el('h3', {}, 'Заметки'), el('textarea', { disabled: dis(), style: 'min-height:320px', onchange: e => { s.notes = e.target.value; save(); } }, s.notes || ''),
      el('div', { class: 'field', style: 'margin-top:8px' }, el('label', {}, 'Владения и языки'), el('textarea', { disabled: dis(), style: 'min-height:60px', onchange: e => { s.proficiencies = e.target.value; save(); } }, s.proficiencies || '')));
    root.append(pers, notes);
    return root;
  }

  // ---- drag&drop: из справочника и между листами ----
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
    const comp = M.getDrag(e, 'application/x-compendium'); if (comp) return applyEntry(comp, slotCat);
    const item = M.getDrag(e, 'application/x-item'); if (item) return acceptItem(item);
    const spell = M.getDrag(e, 'application/x-spell'); if (spell) { if (!s.spells.known.some(x => x.name === spell.spell.name)) { s.spells.known.push({ ...spell.spell, uid: M.uid(), prepared: false }); save(); render(); toast(`${spell.spell.name} добавлено`); } }
  }
  function applyEntry(e, slotCat) {
    const d = e.data || {};
    switch (e.category) {
      case 'race': {
        s.race = e.name;
        if (d.asi && confirm(`Применить бонусы расы к характеристикам? (${Object.entries(d.asi).filter(([k]) => ABIL[k]).map(([k, v]) => ABIL[k] + ' +' + v).join(', ')})`)) for (const [k, v] of Object.entries(d.asi)) if (ABIL[k]) s.abilities[k] += v;
        if (d.speed) s.speed = d.speed;
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push({ name: t.name, text: t.text }); });
        break;
      }
      case 'class': {
        s.class = e.name;
        if (d.saves && confirm('Установить спасброски и кость хитов класса?')) { s.saving_throws = [...d.saves]; s.hp.hit_dice = (s.level || 1) + d.hit_die; if (s.level === 1) { s.hp.max = parseInt(d.hit_die.slice(1)) + abMod('con'); s.hp.current = s.hp.max; } }
        if (d.spellcasting) s.spells.ability = d.spellcasting;
        Object.entries(d.features || {}).forEach(([lvl, fs]) => { if (+lvl <= (s.level || 1)) fs.forEach(n => { if (!s.features.some(f => f.name === n)) s.features.push({ name: n, text: `${e.name}, ${lvl} ур.` }); }); });
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push({ name: t.name, text: t.text }); });
        break;
      }
      case 'background': {
        s.background = e.name;
        const map = Object.fromEntries(SKILLS.map(([k, n]) => [n, k]));
        (d.skills || []).forEach(n => { if (map[n] && !s.skills.includes(map[n])) s.skills.push(map[n]); });
        if (d.feature) s.features.push({ name: d.feature, text: `Умение предыстории «${e.name}»` });
        (d.traits || []).forEach(t => { if (!s.features.some(f => f.name === t.name)) s.features.push({ name: t.name, text: t.text }); });
        break;
      }
      case 'item': {
        const it = M.itemFromCompendium(e, ctx());
        if (it.type === 'armor' && confirm('Надеть? КД будет пересчитан.')) { const acs = String(d.ac || ''); const base = parseInt(acs); if (acs.startsWith('+')) s.ac += base; else s.ac = base + (acs.includes('Лов') ? (acs.includes('макс 2') ? Math.min(2, abMod('dex')) : abMod('dex')) : 0); it.equipped = true; }
        if (it.type === 'weapon' && slotCat === 'item' && tab === 'main') it.equipped = true;
        const ex = s.inventory.find(i => i.name === it.name && !i.equipped && it.type !== 'weapon'); if (ex) ex.qty++; else s.inventory.push(it);
        if (tab !== 'inv' && tab !== 'main') tab = 'inv';
        break;
      }
      case 'spell': if (!s.spells.known.some(x => x.name === e.name)) s.spells.known.push(M.spellFromCompendium(e)); if (tab !== 'spells') tab = 'spells'; break;
      case 'feat': case 'condition': s.features.push({ name: e.name, text: d.desc || '', actions: d.actions || [] }); break;
      default: toast('Нельзя применить к листу');
    }
    save(); render(); toast(`${e.name} добавлено`);
  }

  // ---- встроенный справочник ----
  let compEl;
  function toggleComp(cat) {
    if (compEl) { compEl.remove(); compEl = null; if (!cat) return; }
    compEl = floatWindow('Справочник (перетаскивайте на лист)', el('div', { style: 'height:100%;padding:8px' }, Compendium.widget({ campaignId: ch.campaign_id, category: cat })), { x: Math.max(0, window.innerWidth - 640), y: 60, w: 620, h: 520 });
  }

  render();
})();
