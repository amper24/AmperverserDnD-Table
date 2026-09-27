// Справочник: SRD + homebrew кампании + наборы (packs). Записи перетаскиваются в лист персонажа / на стол.
// Кубики и [[формулы]]{подписи} в текстах становятся кнопками бросков (Modules.rich).
window.Compendium = (function () {
  const M = () => window.Modules;
  let packsCache = null;
  async function myPacks(force) { if (!packsCache || force) { try { packsCache = await API.get('/api/packs?scope=mine'); } catch { packsCache = []; } } return packsCache; }

  function renderData(e, opts = {}) {
    const d = e.data || {}, rows = [];
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push([k, Array.isArray(v) ? v.join(', ') : v]); };
    const asi = (a) => a ? Object.entries(a).map(([k, v]) => (ABIL[k] || k) + ' ' + (typeof v === 'number' ? fmtMod(v) : v)).join(', ') : '';
    const ctx = window.SHEET_CTX || {};
    switch (e.category) {
      case 'race': if (d.parent) add('Основной вид', d.parent); add('Характеристики', asi(d.asi)); add('Размер', d.size); add('Скорость', d.speed && d.speed + ' фт'); add('Тёмное зрение', d.darkvision && d.darkvision + ' фт'); add('Языки', d.languages); break;
      case 'class': add('Кость хитов', d.hit_die); add('Стартовое снаряжение', d.starting_equipment); add('Основная хар-ка', d.primary); add('Спасброски', (d.saves || []).map(s => ABIL[s])); add('Доспехи', d.armor); add('Оружие', d.weapons); add('Навыки', d.skills && `${d.skills.choose} из: ${d.skills.from.join(', ')}`); add('Подклассы', d.subclasses); break;
      case 'background': add('Навыки', d.skills); add('Инструменты', d.tools); add('Языки', d.languages); add('Умение', d.feature); add('Черта происхождения', d.feat); add('Характеристики', d.asi_options && ('+2/+1 или +1/+1/+1 из: ' + d.asi_options.join(', '))); add('Снаряжение', d.equipment); break;
      case 'item':
        add('Тип', M().ITEM_TYPES[d.type]?.slice(2)); add('Категория', d.category); add('Стоимость', d.cost); add('Урон', d.damage && `${d.damage} ${d.damage_type || ''}`); add('КД', d.ac); add('Вес', d.weight && d.weight + ' фнт'); add('Свойства', d.properties); add('Редкость', d.rarity); add('Настройка', d.attunement && 'Требуется'); add('Заряды', d.charges);
        if (d.stealth_disadvantage) add('Скрытность', 'Помеха'); if (d.str_req) add('Требование', 'Сила ' + d.str_req);
        break;
      case 'spell': add('Уровень', d.level === 0 ? 'Заговор' : d.level); add('Школа', d.school); add('Время', d.casting_time); add('Дистанция', d.range); add('Компоненты', d.components); add('Длительность', (d.concentration ? 'Концентрация, ' : '') + (d.duration || '')); add('Ритуал', d.ritual && 'Да'); add('Классы', d.classes); break;
      case 'npc': add('Роль', d.role); add('Раса', d.race); add('Фракция', d.faction); add('Отношение', d.attitude); add('Место', d.location); add('Голос и манеры', d.voice); if (d.abilities) { add('КД', d.ac); add('Хиты', d.hp); add('Скорость', d.speed); } add('Добыча', d.loot); break;
      case 'lore': add('Тип', { rule: 'Правило', place: 'Место', faction: 'Фракция', event: 'Событие', deity: 'Божество', other: 'Другое' }[d.kind]); add('Теги', d.tags); break;
      case 'monster': add('Тип', `${d.size || ''} ${d.type || ''}${d.alignment ? ', ' + d.alignment : ''}`); add('Спасброски', d.saves); add('Навыки', d.skills); add('Уязвимости', d.vulnerabilities); add('Сопротивления', d.resistances); add('Иммунитеты', d.immunities); add('Иммунитет к состояниям', d.condition_immunities); add('КД', d.ac); add('Хиты', d.hp); add('Скорость', d.speed); add('Опасность', `${d.cr} (${d.xp || 0} опыта)`); add('Чувства', d.senses); add('Языки', d.languages); add('Уязвимости', d.vulnerabilities); add('Иммунитеты', d.immunities); break;
    }
    const wrap = el('div', { class: 'entry' });
    const src = e.pack_id ? (e.pack_name || 'набор') : e.campaign_id ? 'homebrew' : e.source;
    wrap.append(el('div', { class: 'row', style: 'align-items:flex-start' }, el('h2', { style: 'flex:1' }, e.name, d.name_en && d.name_en !== e.name ? el('div', { class: 'muted small', style: 'font-weight:400' }, d.name_en) : null), el('span', { class: 'badge' }, src)));
    if (d.higher_level) rows.push(['На больших уровнях', d.higher_level]);
    if (rows.length) wrap.append(el('table', {}, ...rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, M().rich(String(v), ctx, { prefix: e.name }))))));
    if ((e.category === 'monster' || e.category === 'npc') && d.abilities) {
      wrap.append(el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin:6px 0' }, M().rollBtn('1d20' + fmtMod(mod(d.abilities.dex || 10)), 'Инициатива', ctx, { prefix: e.name }),
        ...Object.entries(d.abilities).map(([k, v]) => M().rollBtn('1d20' + fmtMod(mod(v)), `${ABIL[k].slice(0, 3)} ${v} (${fmtMod(mod(v))})`, ctx, { prefix: e.name })),
        d.hp && /\d+к\d+/.test(String(d.hp)) ? M().rollBtn(String(d.hp).match(/(\d+к\d+(?:\+\d+)?)/)[1], 'Хиты', ctx, { prefix: e.name }) : null));
    }
    if (d.folder) wrap.append(el('div', { class: 'muted small' }, 'Папка: ' + d.folder));
    if (d.desc) wrap.append(el('div', { class: 'card-desc' }, M().rich(d.desc, ctx, { prefix: e.name })));
    if (d.hooks) wrap.append(el('p', {}, el('b', {}, 'Зацепки. '), M().rich(d.hooks, ctx, { prefix: e.name })));
    if (Array.isArray(d.actions) && d.actions.length && d.actions[0].roll !== undefined) wrap.append(M().actionButtons(d, ctx, e.name));
    const block = (title, arr, f) => { if (arr && arr.length) { wrap.append(el('h3', { style: 'margin-top:12px' }, title)); arr.forEach(x => wrap.append(f(x))); } };
    block('Особенности', d.traits, t => el('p', {}, el('b', {}, t.name + '. '), M().rich(t.text, ctx, { prefix: `${e.name}: ${t.name}` })));
    block('Подрасы / линии', d.subraces, s => typeof s === 'string' ? el('p', {}, s) : el('p', {}, el('b', {}, s.name + ' (' + asi(s.asi) + '). '), s.text));
    if (Array.isArray(d.actions) && d.actions.length && d.actions[0].text !== undefined) block('Действия', d.actions, a => {
      const p = el('p', {}, el('b', {}, a.name + '. '));
      const hit = (a.text || '').match(/([+-]\d+)\s*(?:к попаданию|к|,)/);
      if (hit) p.append(M().rollBtn('1d20' + hit[1], 'Атака ' + hit[1], ctx, { prefix: `${e.name}: ${a.name}` }), ' ');
      p.append(M().rich(a.text || '', ctx, { prefix: `${e.name}: ${a.name}` }));
      return p;
    });
    block('Легендарные действия', d.legendary_actions, a => el('p', {}, el('b', {}, a.name + '. '), M().rich(a.text || '', ctx, { prefix: e.name })));
    if (Array.isArray(d.actions_roll) && d.actions_roll.length) wrap.append(el('div', { style: 'margin:6px 0' }, el('div', { class: 'muted small' }, 'Броски атак и урона'), M().actionButtons({ actions: d.actions_roll }, ctx, e.name)));
    block('Реакции', d.reactions, a => el('p', {}, el('b', {}, a.name + '. '), M().rich(a.text || '', ctx, { prefix: e.name })));
    if (d.prerequisites) wrap.append(el('p', { class: 'muted small' }, 'Требования: ' + d.prerequisites));
    if (d.feature_text) wrap.append(el('p', {}, el('b', {}, (d.feature || 'Умение') + '. '), M().rich(d.feature_text, ctx, { prefix: e.name })));
    const featList = (features, texts, title) => {
      if (!features || !Object.keys(features).length) return;
      wrap.append(el('h3', { style: 'margin-top:12px' }, title));
      Object.entries(features).sort((a, b) => +a[0] - +b[0]).forEach(([lvl, fs]) => {
        const p = el('div', { class: 'lvl-row' }, el('b', {}, lvl + ' ур.: '));
        (Array.isArray(fs) ? fs : [fs]).forEach((n, i) => { const t = texts?.[n]; p.append(i ? ', ' : '', t ? el('a', { href: '#', class: 'feat-link', onclick: ev => { ev.preventDefault(); const nx = p.nextSibling; if (nx?.classList?.contains('feat-text') && nx.dataset.n === n) { nx.remove(); return; } if (nx?.classList?.contains('feat-text')) nx.remove(); p.after(el('div', { class: 'feat-text card-desc', 'data-n': n }, M().rich(t, ctx, { prefix: `${e.name}: ${n}` }))); } }, n) : n); });
        wrap.append(p);
      });
    };
    featList(d.features, d.feature_texts, 'Умения по уровням');
    if (Array.isArray(d.subclasses) && d.subclasses.length) {
      wrap.append(el('h3', { style: 'margin-top:12px' }, 'Подклассы'));
      d.subclasses.forEach(sc => { if (typeof sc === 'string') { wrap.append(el('p', {}, sc)); return; } wrap.append(el('p', {}, el('b', {}, sc.name), sc.name_en && sc.name_en !== sc.name ? el('span', { class: 'muted small' }, ' ' + sc.name_en) : null)); if (sc.desc) wrap.append(el('div', { class: 'card-desc' }, M().rich(sc.desc, ctx, { prefix: sc.name }))); featList(sc.features, sc.feature_texts, sc.name + ': умения'); });
    }
    // --- действия с записью ---
    const btns = el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap;gap:4px' });
    const isRoot = !!window.ME?.is_root;
    const canEdit = isRoot || (e.pack_id && (opts.packMine || e._mine)) || (e.campaign_id && (window.TABLE_CTX?.isGM || opts.isGM));
    if (d.secrets && (canEdit || window.TABLE_CTX?.isGM || opts.isGM)) wrap.append(el('div', { class: 'card-desc', style: 'border-left:3px solid var(--danger,#c55);padding-left:8px;margin-top:8px' }, el('b', {}, 'Только для мастера. '), M().rich(d.secrets, ctx, { prefix: e.name })));
    if (canEdit) btns.append(el('button', { class: 'small', onclick: () => editEntry(e, { campaignId: e.campaign_id, packId: e.pack_id, onSaved: opts.onChanged }) }, 'Редактировать'),
      el('button', { class: 'small danger', onclick: async () => { if (confirm('Удалить запись?')) { await API.del('/api/compendium/' + e.id); opts.onChanged && opts.onChanged(); } } }, 'Удалить'));
    btns.append(el('button', { class: 'small', onclick: () => copyTo(e, opts) }, 'Копировать в набор…'));
    if (window.TABLE_CTX?.ws && ['item', 'spell', 'feat', 'condition'].includes(e.category)) btns.append(el('button', { class: 'small', onclick: () => { const doc = e.category === 'item' ? M().itemFromCompendium(e) : e.category === 'spell' ? M().spellFromCompendium(e) : { name: e.name, desc: d.desc, actions: d.actions || [] }; M().sendCard({ ...M().toChatCard(doc, e.category), icon: e.category === 'item' ? (doc.icon || M().itemIconName(doc)) : e.category === 'spell' ? 'star' : 'scroll' }); } }, 'В чат'));
    wrap.append(btns);
    return wrap;
  }

  async function copyTo(e, opts = {}) {
    const packs = await myPacks(true);
    const sel = el('select', {}, ...packs.map(p => el('option', { value: p.id }, p.name)), opts.campaignId && opts.isGM ? el('option', { value: 'campaign' }, '— homebrew этой кампании') : null, window.ME?.is_root ? el('option', { value: 'base' }, '— базовый справочник (root)') : null, el('option', { value: 'new' }, '+ Новый набор…'));
    const ok = await modal(`Копировать «${e.name}»`, el('div', { class: 'field' }, el('label', {}, 'Куда'), sel), [{ label: 'Копировать', cls: 'primary', fn: () => sel.value }]);
    if (!ok) return;
    let body = { category: e.category, name: e.name, data: e.data };
    if (ok === 'campaign') body.campaign_id = opts.campaignId;
    else if (ok === 'base') { /* без campaign_id и pack_id — только root */ }
    else if (ok === 'new') { const n = await prompt2('Название набора'); if (!n) return; const p = await API.post('/api/packs', { name: n }); packsCache = null; body.pack_id = p.id; }
    else body.pack_id = ok;
    await API.post('/api/compendium', body); toast('Скопировано'); opts.onChanged && opts.onChanged();
  }

  /// Редактор записи: визуальный (предмет/заклинание/общий) + выбор, куда сохранить (набор или homebrew кампании).
  async function editEntry(e, o = {}) {
    let category = e?.category || o.category || 'item';
    if (!e) {
      const cat = el('select', {}, ...Object.entries(CAT_NAMES).map(([k, v]) => el('option', { value: k, selected: category === k ? '' : null }, v)));
      const packs = await myPacks();
      const dest = el('select', {}, o.packId ? el('option', { value: 'pack:' + o.packId, selected: '' }, 'этот набор') : null, o.campaignId && o.isGM ? el('option', { value: 'campaign:' + o.campaignId }, 'Homebrew этой кампании') : null, ...packs.filter(p => p.id !== o.packId).map(p => el('option', { value: 'pack:' + p.id }, 'Набор: ' + p.name)), window.ME?.is_root ? el('option', { value: 'base' }, 'Базовый справочник (root)') : null, el('option', { value: 'new' }, '+ Новый набор…'));
      const ok = await modal('Новая запись', el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Категория'), cat), el('div', { class: 'field' }, el('label', {}, 'Сохранить в'), dest)), [{ label: 'Далее', cls: 'primary', fn: () => ({ cat: cat.value, dest: dest.value }) }]);
      if (!ok) return;
      category = ok.cat;
      if (ok.dest === 'new') { const n = await prompt2('Название набора'); if (!n) return; const p = await API.post('/api/packs', { name: n }); packsCache = null; o = { ...o, packId: p.id, campaignId: null }; }
      else if (ok.dest.startsWith('pack:')) o = { ...o, packId: ok.dest.slice(5), campaignId: null };
      else if (ok.dest === 'base') o = { ...o, packId: null, campaignId: null };
      else o = { ...o, packId: null, campaignId: ok.dest.slice(9) };
    }
    let result;
    if (category === 'item') {
      const it = e ? M().itemFromCompendium(e) : null; if (it && e.data?.icon) it.icon = e.data.icon;
      const r = await M().editItem(it, { title: e ? 'Редактировать предмет' : 'Новый предмет' }); if (!r) return;
      result = { name: r.name, data: { folder: e?.data?.folder || o.folder || undefined, type: r.type, rarity: r.rarity, weight: r.weight, cost: r.cost, desc: r.desc, attunement: r.attunement, charges: r.charges?.max, recharge: r.charges?.recharge, actions: r.actions, tags: r.tags, icon: r.icon, asset_id: r.asset_id || null, token_asset_id: r.token_asset_id || null, category: r.tags?.[0] } };
    } else if (category === 'spell') {
      const r = await M().editSpell(e ? M().spellFromCompendium(e) : null); if (!r) return;
      result = { name: r.name, data: { folder: e?.data?.folder || o.folder || undefined, level: r.level, school: r.school, casting_time: r.casting_time, range: r.range, components: r.components, duration: r.duration, concentration: r.concentration, ritual: r.ritual, desc: r.desc, classes: r.classes, actions: r.actions, asset_id: r.asset_id || null, token_asset_id: r.token_asset_id || null, effect_size: r.effect_size || 1 } };
    } else {
      const r = await M().editGeneric(e, category, { folders: o.folders, folder: o.folder }); if (!r) return; result = r;
    }
    if (!result.name) return toast('Нужно название');
    const body = { category, name: result.name, data: result.data, campaign_id: e ? e.campaign_id : o.campaignId, pack_id: e ? e.pack_id : o.packId };
    try { if (e?.id) await API.patch('/api/compendium/' + e.id, body); else await API.post('/api/compendium', body); toast('Сохранено'); o.onSaved && o.onSaved(); } catch (err) { toast('Ошибка: ' + err.message, 4000); }
  }

  // Виджет: категории + источник + поиск + список + карточка.
  // opts: campaignId, isGM, packId (режим редактирования набора), category (стартовая)
  function widget(opts = {}) {
    const root = el('div', { class: 'comp' });
    const left = el('div', { style: 'display:flex;flex-direction:column;min-height:0' });
    const catSel = el('select', {}, el('option', { value: '' }, 'Все категории'), ...Object.entries(CAT_NAMES).map(([k, v]) => el('option', { value: k, selected: opts.category === k ? '' : null }, v)));
    const srcSel = el('select', { title: 'Источник' }, el('option', { value: '' }, 'Все источники'));
    const ed0 = opts.edition || window.SHEET_EDITION || defaultEdition();
    const edSel = el('select', { title: 'Редакция правил' }, ...Object.entries(EDITIONS).map(([k, v]) => el('option', { value: k, selected: ed0 === k ? '' : null }, v)), el('option', { value: '', selected: ed0 === '' ? '' : null }, 'Обе редакции'));
    const q = el('input', { placeholder: 'Поиск…' });
    const lst = el('div', { class: 'list lst', style: 'flex:1;margin-top:6px' });
    const det = el('div', { class: 'det' }, el('p', { class: 'muted' }, 'Выберите запись. Записи можно перетаскивать на лист персонажа или на стол. Кубики в тексте — кликабельны.'));
    left.append(catSel, el('div', { style: 'height:4px' }), opts.packId ? null : el('div', { class: 'row', style: 'gap:4px' }, edSel, srcSel), el('div', { style: 'height:4px' }), q, lst);
    left.append(el('button', { class: 'small', style: 'margin-top:6px', onclick: () => editEntry(null, { campaignId: opts.campaignId, isGM: opts.isGM, packId: opts.packId, category: catSel.value || 'item', onSaved: load }) }, '+ Своя запись'));
    root.append(left, det);
    let timer, packNames = {};
    (async () => { if (opts.packId) return; const mine = await myPacks(); let camp = []; if (opts.campaignId) { try { camp = await API.get(`/api/campaigns/${opts.campaignId}/packs`); } catch { } } const all = [...mine, ...camp.filter(p => !mine.some(m => m.id === p.id))]; all.forEach(p => { packNames[p.id] = p.name; srcSel.append(el('option', { value: 'pack:' + p.id }, p.name)); }); srcSel.append(el('option', { value: 'srd' }, 'База (SRD)')); if (opts.campaignId) srcSel.append(el('option', { value: 'hb' }, 'Homebrew кампании')); })();
    async function load() {
      const params = new URLSearchParams(); if (catSel.value) params.set('category', catSel.value); if (q.value) params.set('q', q.value); if (edSel.value) params.set('edition', edSel.value); params.set('limit', '3000');
      const src = srcSel.value;
      if (opts.packId) params.set('pack_id', opts.packId); else if (src.startsWith('pack:')) params.set('pack_id', src.slice(5)); else if (opts.campaignId) params.set('campaign_id', opts.campaignId);
      let items = await API.get('/api/compendium?' + params);
      if (src === 'srd') items = items.filter(e => !e.campaign_id && !e.pack_id); if (src === 'hb') items = items.filter(e => e.campaign_id);
      lst.innerHTML = '';
      if (!items.length) lst.append(el('p', { class: 'muted small', style: 'padding:8px' }, 'Ничего не найдено'));
      let lastCat = null;
      for (const e of items) {
        if (!catSel.value && e.category !== lastCat) { lastCat = e.category; lst.append(el('div', { class: 'muted small', style: 'padding:6px 4px 2px;text-transform:uppercase;letter-spacing:.5px' }, CAT_NAMES[e.category] || e.category)); }
        e.pack_name = packNames[e.pack_id]; e._mine = !!(e.pack_id && (packsCache || []).some(p => p.id === e.pack_id));
        const ico = e.data?.asset_id ? M().docIcon(e.data, 'box', 16) : e.category === 'item' ? M().itemIcon({ type: e.data?.type, icon: e.data?.icon }) : icon({ spell: 'star', monster: 'skull', npc: 'user', lore: 'book', race: 'user', class: 'shield', background: 'book', feat: 'scroll', condition: 'zap' }[e.category] || 'box', 16);
        const it = el('div', { class: 'item', draggable: 'true' }, el('span', { class: 'lst-ico' }, ico), el('span', { class: 'grow' }, e.name, e.data?.name_en && e.data.name_en !== e.name ? el('span', { class: 'muted small' }, ' ' + e.data.name_en) : null), !edSel.value && e.data?.edition ? el('span', { class: 'badge' }, e.data.edition) : null, e.pack_id ? el('span', { class: 'badge', title: e.pack_name }, 'набор') : e.campaign_id ? el('span', { class: 'badge' }, 'HB') : null);
        it.addEventListener('click', () => { lst.querySelectorAll('.item').forEach(x => x.classList.remove('active')); it.classList.add('active'); det.innerHTML = ''; det.append(renderData(e, { isGM: opts.isGM, campaignId: opts.campaignId, packMine: e._mine, onChanged: load })); });
        it.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-compendium', JSON.stringify(e)); if (e.category === 'item') ev.dataTransfer.setData('application/x-item', JSON.stringify({ item: M().itemFromCompendium(e) })); if (e.category === 'spell') ev.dataTransfer.setData('application/x-spell', JSON.stringify({ spell: M().spellFromCompendium(e) })); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; });
        lst.append(it);
      }
    }
    catSel.addEventListener('change', load); srcSel.addEventListener('change', load); edSel.addEventListener('change', () => { if (!opts.edition && !window.SHEET_EDITION && edSel.value) LS.setItem('et-edition', edSel.value); load(); });
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    load();
    root.reload = load;
    return root;
  }

  // ---- Управление наборами (лобби) ----
  function packsPanel() {
    const root = el('div');
    const scope = el('select', {}, el('option', { value: 'mine' }, 'Мои наборы'), el('option', { value: 'public' }, 'Публичные'), el('option', { value: 'all' }, 'Все доступные'));
    const list = el('div', { class: 'list' });
    const fileInp = el('input', { type: 'file', accept: 'application/json', class: 'hidden' });
    fileInp.addEventListener('change', async () => { const f = fileInp.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); const p = await API.post('/api/packs/import', { name: j.name || f.name.replace(/\.json$/, ''), description: j.description || '', entries: j.entries || [], is_public: false }); toast(`Импортирован «${p.name}»: ${p.entries} записей`); packsCache = null; load(); } catch (e) { toast('Ошибка импорта: ' + e.message, 4000); } fileInp.value = ''; });
    root.append(el('div', { class: 'row', style: 'margin-bottom:10px' }, scope, el('button', { class: 'primary', onclick: async () => { const n = await prompt2('Название набора'); if (!n) return; await API.post('/api/packs', { name: n }); packsCache = null; load(); } }, '+ Создать'), el('button', { onclick: () => fileInp.click() }, 'Импорт JSON'), fileInp),
      el('p', { class: 'muted small' }, 'Набор — ваша коллекция предметов, заклинаний, монстров и т.д. Свои наборы всегда видны вам в справочнике; мастер может подключить набор к кампании, и он станет виден всем игрокам. Публичные наборы могут подключать все мастера.'), list);
    async function load() {
      const packs = await API.get('/api/packs?scope=' + scope.value);
      list.innerHTML = '';
      if (!packs.length) list.append(el('p', { class: 'muted' }, 'Пока нет наборов.'));
      for (const p of packs) {
        list.append(el('div', { class: 'item' }, el('span', { class: 'lst-ico' }, icon('box', 20)), el('div', { class: 'grow' }, el('b', {}, p.name), p.is_public ? el('span', { class: 'badge' }, 'публичный') : null, el('div', { class: 'muted small' }, `${p.entries} записей · ${p.owner_name || (p.mine ? 'мой' : '')}${p.description ? ' · ' + p.description : ''}`)),
          el('button', { class: 'small', onclick: () => openPack(p) }, p.mine ? 'Открыть' : 'Смотреть'),
          el('button', { class: 'small', onclick: async () => { const j = await API.get(`/api/packs/${p.id}/export`); const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' }); const a = el('a', { href: URL.createObjectURL(blob), download: p.name.replace(/[^\wа-яё\- ]/gi, '') + '.json' }); a.click(); } }, 'Экспорт'),
          p.mine ? el('button', { class: 'small', onclick: async () => { const name = el('input', { value: p.name }), desc = el('input', { value: p.description || '' }), pub = el('input', { type: 'checkbox', style: 'width:auto', checked: p.is_public ? '' : null }); const ok = await modal('Настройки набора', el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Название'), name), el('div', { class: 'field' }, el('label', {}, 'Описание'), desc), el('label', {}, pub, ' Публичный (любой мастер может подключить к кампании)')), [{ label: 'Сохранить', cls: 'primary', fn: () => true }]); if (ok) { await API.patch('/api/packs/' + p.id, { name: name.value, description: desc.value, is_public: pub.checked }); packsCache = null; load(); } } }, icon('settings')) : null,
          p.mine ? el('button', { class: 'small danger', onclick: async () => { if (confirm(`Удалить набор «${p.name}» со всеми записями?`)) { await API.del('/api/packs/' + p.id); packsCache = null; load(); } } }, icon('trash')) : null));
      }
    }
    function openPack(p) { floatWindow(p.name, el('div', { style: 'height:100%;padding:8px' }, widget({ packId: p.id, packMine: p.mine })), { x: 60, y: 60, w: Math.min(900, window.innerWidth - 80), h: Math.min(640, window.innerHeight - 100) }); }
    scope.addEventListener('change', load);
    load();
    return root;
  }

  /// Панель подключения наборов к кампании (для мастера)
  function campaignPacksPanel(campaignId, isGM) {
    const root = el('div');
    async function load() {
      root.innerHTML = '';
      const enabled = await API.get(`/api/campaigns/${campaignId}/packs`);
      root.append(el('h3', {}, 'Подключённые наборы'));
      if (!enabled.length) root.append(el('p', { class: 'muted small' }, 'Нет. Игроки видят только базу и homebrew кампании.'));
      enabled.forEach(p => root.append(el('div', { class: 'row', style: 'margin:4px 0' }, el('span', { class: 'grow' }, `${p.name} `, el('span', { class: 'muted small' }, `${p.entries} записей`)), isGM ? el('button', { class: 'small danger', onclick: async () => { await API.del(`/api/campaigns/${campaignId}/packs/${p.id}`); load(); } }, 'Отключить') : null)));
      if (isGM) {
        const avail = (await API.get('/api/packs?scope=all')).filter(p => !enabled.some(e => e.id === p.id));
        if (avail.length) { const sel = el('select', {}, ...avail.map(p => el('option', { value: p.id }, `${p.name} (${p.entries})${p.is_public && !p.mine ? ' — ' + p.owner_name : ''}`))); root.append(el('div', { class: 'row', style: 'margin-top:8px' }, sel, el('button', { class: 'small', onclick: async () => { await API.post(`/api/campaigns/${campaignId}/packs/${sel.value}`, {}); load(); } }, 'Подключить'))); }
        else root.append(el('p', { class: 'muted small' }, 'Нет доступных наборов — создайте во вкладке «Наборы» в лобби.'));
      }
    }
    load(); root.reload = load;
    return root;
  }

  return { widget, renderData, editEntry, packsPanel, campaignPacksPanel, myPacks };
})();
