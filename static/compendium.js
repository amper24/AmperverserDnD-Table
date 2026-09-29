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
    if (rows.length) wrap.append(el('table', {}, ...rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, M().rich(String(v), ctx, { prose:!!d.mechanics, prefix: e.name }))))));
    if ((e.category === 'monster' || e.category === 'npc') && d.abilities) {
      wrap.append(el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin:6px 0' }, M().rollBtn('1d20' + fmtMod(mod(d.abilities.dex || 10)), 'Инициатива', ctx, { prose:!!d.mechanics, prefix: e.name }),
        ...Object.entries(d.abilities).map(([k, v]) => M().rollBtn('1d20' + fmtMod(mod(v)), `${ABIL[k].slice(0, 3)} ${v} (${fmtMod(mod(v))})`, ctx, { prose:!!d.mechanics, prefix: e.name })),
        d.hp && /\d+к\d+/.test(String(d.hp)) ? M().rollBtn(String(d.hp).match(/(\d+к\d+(?:\+\d+)?)/)[1], 'Хиты', ctx, { prose:!!d.mechanics, prefix: e.name }) : null));
    }
    if(d.mechanics) wrap.append(Mechanics.preview(d.mechanics,ctx));
    if (d.folder) wrap.append(el('div', { class: 'muted small' }, 'Папка: ' + d.folder));
    if (d.desc) wrap.append(el('div', { class: 'card-desc' }, M().rich(d.desc, ctx, { prose:!!d.mechanics, prefix: e.name })));
    if (d.hooks) wrap.append(el('p', {}, el('b', {}, 'Зацепки. '), M().rich(d.hooks, ctx, { prose:!!d.mechanics, prefix: e.name })));
    if (Array.isArray(d.actions) && d.actions.length && d.actions[0].roll !== undefined) wrap.append(M().actionButtons(d, ctx, e.name));
    const block = (title, arr, f) => { if (arr && arr.length) { wrap.append(el('h3', { style: 'margin-top:12px' }, title)); arr.forEach(x => wrap.append(f(x))); } };
    block('Особенности', d.traits, t => el('p', {}, el('b', {}, t.name + '. '), M().rich(t.text, ctx, { prose:!!d.mechanics, prefix: `${e.name}: ${t.name}` })));
    if (Array.isArray(d.choices) && d.choices.length) {
      wrap.append(el('h3', { style: 'margin-top:12px' }, 'Выбор при создании'));
      for (const g of d.choices) {
        const count = Number(g.count) || 1;
        wrap.append(el('p', {}, el('b', {}, (g.name || 'Выбор') + '. '),
          el('span', { class: 'muted small' }, `${window.CharacterBuilder?.CHOICE_TYPES?.[g.type] || g.type} · выбрать ${count}${g.optional ? ' (необязательно)' : ''}. `),
          (g.options || []).map(o => o.name).join(' · ')));
        for (const o of g.options || []) if (o.value && o.value.text) wrap.append(el('div', { class: 'card-desc' }, el('b', {}, o.name + '. '), M().rich(String(o.value.text), ctx, { prose:!!d.mechanics, prefix: `${e.name}: ${o.name}` })));
      }
    }
    block('Подрасы / линии', d.subraces, s => typeof s === 'string' ? el('p', {}, s) : el('p', {}, el('b', {}, s.name + ' (' + asi(s.asi) + '). '), s.text));
    if (Array.isArray(d.actions) && d.actions.length && d.actions[0].text !== undefined) block('Действия', d.actions, a => {
      const p = el('p', {}, el('b', {}, a.name + '. '));
      const hit = (a.text || '').match(/([+-]\d+)\s*(?:к попаданию|к|,)/);
      if (hit && !d.mechanics) p.append(M().rollBtn('1d20' + hit[1], 'Атака ' + hit[1], ctx, { prose:!!d.mechanics, prefix: `${e.name}: ${a.name}` }), ' ');
      p.append(M().rich(a.text || '', ctx, { prose:!!d.mechanics, prefix: `${e.name}: ${a.name}` }));
      return p;
    });
    block('Легендарные действия', d.legendary_actions, a => el('p', {}, el('b', {}, a.name + '. '), M().rich(a.text || '', ctx, { prose:!!d.mechanics, prefix: e.name })));
    if (!d.mechanics && Array.isArray(d.actions_roll) && d.actions_roll.length) wrap.append(el('div', { style: 'margin:6px 0' }, el('div', { class: 'muted small' }, 'Броски атак и урона'), M().actionButtons({ actions: d.actions_roll }, ctx, e.name)));
    block('Реакции', d.reactions, a => el('p', {}, el('b', {}, a.name + '. '), M().rich(a.text || '', ctx, { prose:!!d.mechanics, prefix: e.name })));
    if (d.prerequisites) wrap.append(el('p', { class: 'muted small' }, 'Требования: ' + d.prerequisites));
    if (d.feature_text) wrap.append(el('p', {}, el('b', {}, (d.feature || 'Умение') + '. '), M().rich(d.feature_text, ctx, { prose:!!d.mechanics, prefix: e.name })));
    const featList = (features, texts, title) => {
      if (!features || !Object.keys(features).length) return;
      wrap.append(el('h3', { style: 'margin-top:12px' }, title));
      Object.entries(features).sort((a, b) => +a[0] - +b[0]).forEach(([lvl, fs]) => {
        const p = el('div', { class: 'lvl-row' }, el('b', {}, lvl + ' ур.: '));
        (Array.isArray(fs) ? fs : [fs]).forEach((n, i) => { const t = texts?.[n]; p.append(i ? ', ' : '', t ? el('a', { href: '#', class: 'feat-link', onclick: ev => { ev.preventDefault(); const nx = p.nextSibling; if (nx?.classList?.contains('feat-text') && nx.dataset.n === n) { nx.remove(); return; } if (nx?.classList?.contains('feat-text')) nx.remove(); p.after(el('div', { class: 'feat-text card-desc', 'data-n': n }, M().rich(t, ctx, { prose:!!d.mechanics, prefix: `${e.name}: ${n}` }))); } }, n) : n); });
        wrap.append(p);
      });
    };
    featList(d.features, d.feature_texts, 'Умения по уровням');
    if (Array.isArray(d.subclasses) && d.subclasses.length) {
      wrap.append(el('h3', { style: 'margin-top:12px' }, 'Подклассы'));
      d.subclasses.forEach(sc => { if (typeof sc === 'string') { wrap.append(el('p', {}, sc)); return; } wrap.append(el('p', {}, el('b', {}, sc.name), sc.name_en && sc.name_en !== sc.name ? el('span', { class: 'muted small' }, ' ' + sc.name_en) : null)); if (sc.desc) wrap.append(el('div', { class: 'card-desc' }, M().rich(sc.desc, ctx, { prose:!!d.mechanics, prefix: sc.name }))); featList(sc.features, sc.feature_texts, sc.name + ': умения'); });
    }
    // --- действия с записью ---
    const btns = el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap;gap:4px' });
    const isRoot = !!window.ME?.is_root;
    const canEdit = isRoot || (e.pack_id && (opts.packMine || e._mine)) || (e.campaign_id && (window.TABLE_CTX?.isGM || opts.isGM));
    if (d.secrets && (canEdit || window.TABLE_CTX?.isGM || opts.isGM)) wrap.append(el('div', { class: 'card-desc', style: 'border-left:3px solid var(--danger,#c55);padding-left:8px;margin-top:8px' }, el('b', {}, 'Только для мастера. '), M().rich(d.secrets, ctx, { prose:!!d.mechanics, prefix: e.name })));
    if (canEdit) btns.append(el('button', { class: 'small', onclick: () => editEntry(e, { campaignId: e.campaign_id, packId: e.pack_id, onSaved: opts.onChanged }) }, 'Редактировать'),
      el('button', { class: 'small danger', onclick: async () => { if (confirm('Удалить запись?')) { await API.del('/api/compendium/' + e.id); opts.onChanged && opts.onChanged(); } } }, 'Удалить'));
    btns.append(el('button', { class: 'small', onclick: () => copyTo(e, opts) }, 'Копировать в набор…'));
    if (window.TABLE_CTX?.ws && ['item', 'spell', 'feat', 'condition'].includes(e.category)) btns.append(el('button', { class: 'small', onclick: () => { const doc = e.category === 'item' ? M().itemFromCompendium(e) : e.category === 'spell' ? M().spellFromCompendium(e) : { name: e.name, desc: d.desc, actions: d.actions || [] }; M().sendCard({ ...M().toChatCard(doc, e.category), icon: e.category === 'item' ? (doc.icon || M().itemIconName(doc)) : e.category === 'spell' ? 'star' : 'scroll' }); } }, 'В чат'));
    if (!opts.readOnly) wrap.append(btns);
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
    if (!e && !o.directDestination) {
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
      result = { name: r.name, data: { ...e?.data, mechanics: r.mechanics, folder: e?.data?.folder || o.folder || undefined, type: r.type, qty: r.qty, ac: r.ac, handedness: r.handedness, ammo_tag: r.ammo_tag, consume: r.consume, properties: r.properties, rarity: r.rarity, weight: r.weight, cost: r.cost, desc: r.desc, attunement: r.attunement, charges: r.charges?.max, recharge: r.charges?.recharge, actions: r.actions, tags: r.tags, icon: r.icon, asset_id: r.asset_id || null, token_asset_id: r.token_asset_id || null, category: r.tags?.[0] } };
    } else if (category === 'spell') {
      const r = await M().editSpell(e ? M().spellFromCompendium(e) : null); if (!r) return;
      result = { name: r.name, data: { ...e?.data, mechanics: r.mechanics, folder: e?.data?.folder || o.folder || undefined, level: r.level, school: r.school, casting_time: r.casting_time, range: r.range, components: r.components, duration: r.duration, concentration: r.concentration, ritual: r.ritual, desc: r.desc, classes: r.classes, actions: r.actions, asset_id: r.asset_id || null, token_asset_id: r.token_asset_id || null, effect_size: r.effect_size || 1 } };
    } else {
      const r = await M().editGeneric(e, category, { folders: o.folders, folder: o.folder }); if (!r) return; result = r;
    }
    if (!result.name) return toast('Нужно название');
    const body = { category, name: result.name, data: result.data, campaign_id: e ? e.campaign_id : o.campaignId, pack_id: e ? e.pack_id : o.packId };
    try { if (e?.id) await API.patch('/api/compendium/' + e.id, body); else await API.post('/api/compendium', body); toast('Сохранено'); o.onSaved && o.onSaved(); } catch (err) { toast('Ошибка: ' + err.message, 4000); }
  }

  // Полноэкранная мастерская справочника: фильтры/рубрики | список | карточка.
  // Повторяет рабочее пространство наборов, сохраняя компактный виджет для стола и листа.
  function workspaceWidget(opts = {}) {
    const root = el('div', { class: 'comp comp-workspace' });
    const side = el('aside', { class: 'comp-side' });
    const main = el('section', { class: 'comp-list-pane' });
    const det = el('section', { class: 'det comp-detail' }, el('div', { class: 'comp-empty' }, icon('book', 30), el('b', {}, 'Выберите запись'), el('span', { class: 'muted small' }, 'Откройте карточку, чтобы прочитать описание, бросить кубы, скопировать запись или перетащить её на стол.')));
    const srcSel = el('select', { 'aria-label': 'Источник записей' }, el('option', { value: '' }, 'Все источники'));
    const packTagSel = el('select', { 'aria-label': 'Фильтр по тегу набора' }, el('option', { value: '' }, 'Все теги наборов'));
    const edition0 = opts.edition || defaultEdition();
    const edSel = el('select', { 'aria-label': 'Редакция правил' }, ...Object.entries(EDITIONS).map(([k, v]) => el('option', { value: k, selected: edition0 === k ? '' : null }, v)), el('option', { value: '', selected: edition0 === '' ? '' : null }, 'Все редакции'));
    const q = el('input', { type: 'search', placeholder: 'Название, ключевое слово…', 'aria-label': 'Поиск в справочнике' });
    const sort = el('select', { 'aria-label': 'Сортировка' }, el('option', { value: 'name' }, 'По названию'), el('option', { value: 'source' }, 'По источнику'));
    const nav = el('div', { class: 'comp-nav' });
    const facetBar = el('div', { class: 'comp-facets', 'aria-label': 'Дополнительные фильтры' });
    const lst = el('div', { class: 'list lst comp-list' });
    const count = el('span', { class: 'muted small comp-count' }, 'Загружаем…');
    const addButton = el('button', { class: 'primary small', onclick: () => createRecord() }, '+ Своя запись');
    side.append(el('div', { class: 'comp-side-title' }, icon('book', 18), el('b', {}, 'Справочник')),
      el('label', { class: 'comp-filter-label' }, 'ИСТОЧНИК', srcSel),
      el('label', { class: 'comp-filter-label' }, 'ТЕГ НАБОРА', packTagSel),
      el('label', { class: 'comp-filter-label' }, 'РЕДАКЦИЯ', edSel),
      el('div', { class: 'pack-folder-h' }, 'Категории'), nav);
    const toolbar = el('div', { class: 'comp-toolbar' }, q, count, sort, addButton);
    main.append(toolbar, facetBar, lst);
    root.append(side, main, det);

    const state = { source: '', packTag: '', category: '', folder: '', query: '', sort: 'name', facets: {} };
    let timer, request = 0, rawItems = [], packNames = {}, packTags = {}, folders = [], folderLists = {}, activeId = null;
    const sourceKey = e => e.pack_id ? 'pack:' + e.pack_id : e.campaign_id ? 'hb' : 'srd';
    const countLabel = n => { const n100 = n % 100, n10 = n % 10; const word = n100 >= 11 && n100 <= 14 ? 'записей' : n10 === 1 ? 'запись' : n10 >= 2 && n10 <= 4 ? 'записи' : 'записей'; return `${n} ${word}`; };
    const sourceLabel = e => e.pack_id ? (packNames[e.pack_id] || e.pack_name || 'Набор') : e.campaign_id ? 'Homebrew кампании' : 'Базовый SRD';
    const packTagList = p => String(p.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const foldersFor = items => {
      const found = new Map();
      for (const e of items) if (e.data?.folder) {
        const key = sourceKey(e) + '|' + e.data.folder;
        if (!found.has(key)) found.set(key, { key, name: e.data.folder, source: sourceLabel(e), packId: e.pack_id || null, count: 0 });
        found.get(key).count++;
      }
      if (state.source.startsWith('pack:')) {
        const packId = state.source.slice(5), definitions = folderLists[packId];
        if (Array.isArray(definitions)) {
          for (const name of definitions) {
            const key = 'pack:' + packId + '|' + name;
            if (!found.has(key)) found.set(key, { key, name, source: packNames[packId] || 'Набор', packId, count: 0 });
          }
          for (const [key, folder] of found) if (folder.packId === packId && !definitions.includes(folder.name)) found.delete(key);
        }
      }
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    };
    const navItem = (label, active, number, onclick, extraClass = '', extra = null) => el('div', { class: 'pack-folder comp-nav-item' + (active ? ' active' : '') + (extraClass ? ' ' + extraClass : ''), role: 'button', tabindex: '0', onclick, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onclick(); } } }, el('span', { class: 'grow' }, label), number != null ? el('span', { class: 'muted small' }, number) : null, extra);

    side.append(el('div', { class: 'comp-source-loading muted small' }, 'Загружаем наборы…'));
    (async () => {
      try {
        const mine = await myPacks();
        let subscribed = [], campaign = [];
        try { subscribed = await API.get('/api/packs?scope=subscribed'); } catch { /* подписки не мешают просмотру справочника */ }
        if (opts.campaignId) { try { campaign = await API.get(`/api/campaigns/${opts.campaignId}/packs`); } catch { /* справочник работает и без списка кампаний */ } }
        const known = new Set(mine.map(p => p.id));
        const all = [...mine, ...subscribed.filter(p => !known.has(p.id)), ...campaign.filter(p => !known.has(p.id) && !subscribed.some(s => s.id === p.id))];
        const tagCounts = new Map();
        for (const p of all) {
          packNames[p.id] = p.name; packTags[p.id] = packTagList(p);
          if (Array.isArray(p.folders)) folderLists[p.id] = p.folders;
          for (const tag of packTags[p.id]) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          srcSel.append(el('option', { value: 'pack:' + p.id }, 'Набор: ' + p.name));
        }
        packTagSel.replaceChildren(el('option', { value: '' }, 'Все теги наборов'), ...[...tagCounts].sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([tag, n]) => el('option', { value: tag }, `${tag} · ${n}`)));
        srcSel.append(el('option', { value: 'srd' }, 'Базовый SRD'));
        if (opts.campaignId) srcSel.append(el('option', { value: 'hb' }, 'Homebrew кампании'));
      } catch { /* filters remain usable if packs aren't available */ }
      side.querySelector('.comp-source-loading')?.remove();
      if (rawItems.length) { renderNav(rawItems); renderList(); }
    })();

    function createRecord() {
      const packId = state.source.startsWith('pack:') ? state.source.slice(5) : null;
      const directHomebrew = state.source === 'hb' && opts.campaignId && opts.isGM;
      const directBase = state.source === 'srd' && window.ME?.is_root;
      const canWriteSource = packId ? (packsCache || []).some(p => p.id === packId) : !!(directHomebrew || directBase);
      editEntry(null, {
        campaignId: directHomebrew ? opts.campaignId : null, isGM: !!opts.isGM,
        packId: canWriteSource && packId ? packId : null, directDestination: canWriteSource,
        folders: packId ? (folderLists[packId] || []) : [], folder: state.folder && packId ? state.folder.slice(state.folder.indexOf('|') + 1) : undefined,
        category: state.category || 'item', onSaved: load
      });
    }

    async function saveFolders(packId, names) {
      const result = await API.post(`/api/packs/${packId}/folders`, { folders: names });
      folderLists[packId] = result.folders || names;
      await load();
    }
    async function renameFolder(folder) {
      const name = await prompt2('Новое название папки', '', folder.name);
      if (!name || name === folder.name) return;
      const entries = await API.get(`/api/compendium?pack_id=${folder.packId}&folder=${encodeURIComponent(folder.name)}&limit=3000`);
      for (const e of entries) {
        e.data.folder = name;
        await API.patch('/api/compendium/' + e.id, { category: e.category, name: e.name, data: e.data, pack_id: folder.packId });
      }
      const current = folderLists[folder.packId] || [];
      const renamedFolders = [...new Set(current.map(x => x === folder.name ? name : x))];
      await saveFolders(folder.packId, renamedFolders);
      if (state.folder === folder.key) state.folder = 'pack:' + folder.packId + '|' + name;
      renderNav(rawItems); renderList();
    }
    async function removeFolder(folder) {
      if (!confirm(`Удалить папку «${folder.name}»? Записи останутся в наборе без папки.`)) return;
      const current = folderLists[folder.packId] || [];
      const result = await API.post(`/api/packs/${folder.packId}/folders`, { folders: current.filter(x => x !== folder.name) });
      folderLists[folder.packId] = result.folders || current.filter(x => x !== folder.name);
      if (state.folder === folder.key) state.folder = '';
      await load();
    }
    function renderNav(items) {
      nav.replaceChildren();
      const categoryCounts = Object.fromEntries(Object.keys(CAT_NAMES).map(k => [k, 0]));
      for (const e of items) categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
      nav.append(navItem('Все записи', !state.category && !state.folder, items.length, () => { state.category = ''; state.folder = ''; state.facets = {}; renderNav(items); renderList(); }));
      for (const [k, label] of Object.entries(CAT_NAMES)) nav.append(navItem(label, state.category === k && !state.folder, categoryCounts[k] || 0, () => { state.category = k; state.folder = ''; state.facets = {}; renderNav(items); renderList(); }));
      folders = foldersFor(items);
      if (folders.length || state.source.startsWith('pack:')) {
        const selectedPackId = state.source.startsWith('pack:') ? state.source.slice(5) : null;
        const canManage = !!selectedPackId && ((packsCache || []).some(p => p.id === selectedPackId) || window.ME?.is_root);
        nav.append(el('div', { class: 'pack-folder-h comp-folder-heading' }, el('span', { class: 'grow' }, 'Папки'), canManage ? el('button', { class: 'small ghost', title: 'Новая папка', onclick: async () => {
          const name = await prompt2('Название папки', 'Например: Персонажи таверны');
          if (!name) return;
          try { await saveFolders(selectedPackId, [...(folderLists[selectedPackId] || []), name]); }
          catch (e) { toast('Не удалось создать папку: ' + e.message, 4000); }
        } }, '+') : null));
        if (!folders.length) nav.append(el('div', { class: 'muted small', style: 'padding:2px 8px' }, canManage ? 'Добавьте папку для группировки записей.' : 'В наборе пока нет папок.'));
        for (const f of folders) {
          const canEditFolder = !!(f.packId && ((packsCache || []).some(p => p.id === f.packId) || window.ME?.is_root));
          const actions = canEditFolder ? el('span', { class: 'folder-menu' },
            el('button', { class: 'small ghost', title: 'Переименовать папку', onclick: async ev => { ev.stopPropagation(); try { await renameFolder(f); } catch (e) { toast('Не удалось переименовать папку: ' + e.message, 4000); } } }, icon('edit', 12)),
            el('button', { class: 'small ghost', title: 'Удалить папку (записи останутся)', onclick: async ev => { ev.stopPropagation(); try { await removeFolder(f); } catch (e) { toast('Не удалось удалить папку: ' + e.message, 4000); } } }, icon('close', 12))) : null;
          nav.append(navItem(el('span', {}, f.name, el('small', { class: 'comp-folder-source' }, f.source)), state.folder === f.key, f.count, () => { state.folder = f.key; state.category = ''; state.facets = {}; renderNav(items); renderList(); }, 'comp-folder-entry', actions));
        }
      }
      renderFacets();
    }

    const listValues = value => Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean) : value === undefined || value === null || value === '' ? [] : typeof value === 'string' ? value.split(/[;,]/).map(x => x.trim()).filter(Boolean) : [String(value)];
    function facetDefinitions(items) {
      const relevant = state.category ? items.filter(e => e.category === state.category) : items;
      const definitions = [];
      const add = (key, label, values, display = x => x) => {
        const unique = [...new Set(values.map(String).map(x => x.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
        if (unique.length > 1 || state.facets[key]) definitions.push({ key, label, options: unique.map(value => [value, display(value)]) });
      };
      if (state.category === 'item') {
        add('item.type', 'Тип предмета', [...new Set(relevant.map(e => e.data?.type).filter(Boolean))], v => M().ITEM_TYPES?.[v] || v);
        add('item.rarity', 'Редкость', [...new Set(relevant.map(e => e.data?.rarity).filter(Boolean))]);
        add('item.tag', 'Тег предмета', relevant.flatMap(e => listValues(e.data?.tags)));
      } else if (state.category === 'spell') {
        add('spell.level', 'Круг', [...new Set(relevant.map(e => e.data?.level).filter(v => v !== undefined && v !== null))], v => Number(v) === 0 ? 'Заговор' : `${v} круг`);
        add('spell.school', 'Школа', relevant.map(e => e.data?.school).filter(Boolean));
        add('spell.class', 'Класс', relevant.flatMap(e => listValues(e.data?.classes)));
      } else if (state.category === 'monster') {
        add('monster.type', 'Тип существа', relevant.map(e => e.data?.type).filter(Boolean));
        add('monster.size', 'Размер', relevant.map(e => e.data?.size).filter(Boolean));
        add('monster.cr', 'Опасность', relevant.map(e => e.data?.cr).filter(v => v !== undefined && v !== null));
      } else if (state.category === 'race') {
        add('race.size', 'Размер', relevant.map(e => e.data?.size).filter(Boolean));
        add('race.parent', 'Основной вид', relevant.map(e => e.data?.parent).filter(Boolean));
        add('race.speed', 'Скорость', relevant.map(e => e.data?.speed).filter(Boolean), v => `${v} фт.`);
      } else if (state.category === 'class') {
        add('class.hit_die', 'Кость хитов', relevant.map(e => e.data?.hit_die).filter(Boolean));
        add('class.primary', 'Основная характеристика', relevant.map(e => e.data?.primary).filter(Boolean));
      } else if (state.category === 'background') {
        add('background.feature', 'Умение предыстории', relevant.map(e => e.data?.feature).filter(Boolean));
        add('background.tool', 'Инструмент', relevant.flatMap(e => listValues(e.data?.tools)));
      } else if (state.category === 'npc') {
        add('npc.role', 'Роль', relevant.map(e => e.data?.role).filter(Boolean));
        add('npc.faction', 'Фракция', relevant.map(e => e.data?.faction).filter(Boolean));
        add('npc.attitude', 'Отношение', relevant.map(e => e.data?.attitude).filter(Boolean));
      }
      if (!state.category) add('entry.tag', 'Тег записи', rawItems.flatMap(e => listValues(e.data?.tags)));
      return definitions;
    }
    function renderFacets() {
      facetBar.replaceChildren();
      const definitions = facetDefinitions(rawItems);
      if (!definitions.length) { facetBar.hidden = true; return; }
      facetBar.hidden = false;
      for (const def of definitions) {
        const values = [...def.options];
        if (state.facets[def.key] && !values.some(([v]) => v === state.facets[def.key])) values.unshift([state.facets[def.key], state.facets[def.key]]);
        const select = el('select', { 'aria-label': def.label, title: def.label, onchange: () => { if (select.value) state.facets[def.key] = select.value; else delete state.facets[def.key]; renderList(); } },
          el('option', { value: '' }, def.label), ...values.map(([v, label]) => el('option', { value: v, selected: state.facets[def.key] === v ? '' : null }, label)));
        facetBar.append(select);
      }
      if (Object.keys(state.facets).length) facetBar.append(el('button', { class: 'small ghost', onclick: () => { state.facets = {}; renderFacets(); renderList(); } }, 'Сбросить фильтры'));
    }
    function facetMatches(e) {
      const d = e.data || {};
      const value = key => ({
        'item.type': () => e.category === 'item' ? d.type : '', 'item.rarity': () => e.category === 'item' ? d.rarity : '',
        'item.tag': () => e.category === 'item' ? listValues(d.tags) : [],
        'spell.level': () => e.category === 'spell' ? String(d.level ?? '') : '', 'spell.school': () => e.category === 'spell' ? d.school : '',
        'spell.class': () => e.category === 'spell' ? listValues(d.classes) : [],
        'monster.type': () => e.category === 'monster' ? d.type : '', 'monster.size': () => e.category === 'monster' ? d.size : '', 'monster.cr': () => e.category === 'monster' ? d.cr : '',
        'race.size': () => e.category === 'race' ? d.size : '', 'race.parent': () => e.category === 'race' ? d.parent : '', 'race.speed': () => e.category === 'race' ? d.speed : '',
        'class.hit_die': () => e.category === 'class' ? d.hit_die : '', 'class.primary': () => e.category === 'class' ? d.primary : '',
        'background.feature': () => e.category === 'background' ? d.feature : '', 'background.tool': () => e.category === 'background' ? listValues(d.tools) : [],
        'npc.role': () => e.category === 'npc' ? d.role : '', 'npc.faction': () => e.category === 'npc' ? d.faction : '', 'npc.attitude': () => e.category === 'npc' ? d.attitude : '',
        'entry.tag': () => listValues(d.tags)
      }[key] || (() => ''))();
      return Object.entries(state.facets).every(([key, expected]) => listValues(value(key)).includes(String(expected)));
    }
    function filteredItems() {
      let items = rawItems.filter(e => (!state.category || e.category === state.category) && (!state.folder || (sourceKey(e) + '|' + (e.data?.folder || '')) === state.folder) && (!state.packTag || (packTags[e.pack_id] || []).includes(state.packTag)) && facetMatches(e));
      if (state.sort === 'source') items.sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b), 'ru') || a.name.localeCompare(b.name, 'ru'));
      else items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return items;
    }

    function showEntry(e, row) {
      activeId = e.id;
      lst.querySelectorAll('.item').forEach(x => x.classList.toggle('active', x === row));
      det.replaceChildren(renderData(e, { isGM: opts.isGM, campaignId: opts.campaignId, packMine: e._mine, onChanged: load }));
      const availableFolders = e.pack_id && folderLists[e.pack_id];
      if ((e._mine || window.ME?.is_root) && Array.isArray(availableFolders) && availableFolders.length) {
        const data = { ...(e.data || {}) };
        const picker = el('select', { 'aria-label': 'Папка записи', onchange: async () => {
          if (picker.value) data.folder = picker.value; else delete data.folder;
          try { await API.patch('/api/compendium/' + e.id, { category: e.category, name: e.name, data, pack_id: e.pack_id }); toast('Запись перемещена'); load(); }
          catch (err) { toast('Не удалось переместить: ' + err.message, 4000); }
        } }, el('option', { value: '' }, '— без папки'), ...availableFolders.map(name => el('option', { value: name, selected: data.folder === name ? '' : null }, name)));
        det.append(el('div', { class: 'comp-folder-control' }, el('span', { class: 'muted small' }, 'Папка записи'), picker));
      }
    }

    function renderList() {
      const items = filteredItems();
      lst.replaceChildren();
      count.textContent = countLabel(items.length);
      if (!items.length) {
        activeId = null;
        det.replaceChildren(el('div', { class: 'comp-empty' }, icon('book', 30), el('b', {}, 'Пустая рубрика'), el('span', { class: 'muted small' }, 'Измените фильтры или добавьте запись в набор.')));
        lst.append(el('div', { class: 'comp-no-results' }, el('span', {}, 'В этой рубрике пока пусто.'), el('span', { class: 'muted small' }, 'Измените фильтры или добавьте запись в набор.')));
        return;
      }
      const rows = new Map();
      for (const e of items) {
        e.pack_name = packNames[e.pack_id] || e.pack_name;
        e._mine = !!(e.pack_id && (packsCache || []).some(p => p.id === e.pack_id));
        const ico = e.data?.asset_id ? M().docIcon(e.data, 'box', 16) : e.category === 'item' ? M().itemIcon({ type: e.data?.type, icon: e.data?.icon }) : icon({ spell: 'star', monster: 'skull', npc: 'user', lore: 'book', race: 'user', class: 'shield', background: 'book', feat: 'scroll', condition: 'zap' }[e.category] || 'box', 16);
        const row = el('div', { class: 'item comp-entry', role: 'button', tabindex: '0', draggable: 'true' }, el('span', { class: 'lst-ico' }, ico), el('span', { class: 'grow' }, el('b', {}, e.name), el('small', { class: 'muted comp-entry-source' }, sourceLabel(e))), e.data?.edition ? el('span', { class: 'badge' }, e.data.edition) : null);
        rows.set(e.id, row);
        row.addEventListener('click', () => showEntry(e, row));
        row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showEntry(e, row); } });
        row.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-compendium', JSON.stringify(e)); if (e.category === 'item') ev.dataTransfer.setData('application/x-item', JSON.stringify({ item: M().itemFromCompendium(e) })); if (e.category === 'spell') ev.dataTransfer.setData('application/x-spell', JSON.stringify({ spell: M().spellFromCompendium(e) })); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; });
        lst.append(row);
      }
      const active = items.find(e => e.id === activeId);
      if (active && rows.has(active.id)) showEntry(active, rows.get(active.id));
      else { activeId = null; det.replaceChildren(el('div', { class: 'comp-empty' }, icon('book', 30), el('b', {}, 'Выберите запись'), el('span', { class: 'muted small' }, 'Карточка появится здесь справа.'))); }
    }

    async function load() {
      const version = ++request;
      count.textContent = 'Загружаем…';
      const params = new URLSearchParams({ limit: '3000' });
      if (q.value.trim()) params.set('q', q.value.trim());
      if (edSel.value) params.set('edition', edSel.value);
      if (state.source.startsWith('pack:')) params.set('pack_id', state.source.slice(5));
      else if (opts.campaignId) params.set('campaign_id', opts.campaignId);
      try {
        let items = await API.get('/api/compendium?' + params);
        if (state.source.startsWith('pack:')) {
          const packId = state.source.slice(5);
          if (!Object.prototype.hasOwnProperty.call(folderLists, packId)) {
            try { const pack = await API.get('/api/packs/' + packId); folderLists[packId] = pack.folders || []; packNames[packId] = pack.name || packNames[packId]; }
            catch { folderLists[packId] = []; }
          }
        }
        if (version !== request) return;
        if (state.source === 'srd') items = items.filter(e => !e.campaign_id && !e.pack_id);
        else if (state.source === 'hb') items = items.filter(e => e.campaign_id);
        if (state.packTag) items = items.filter(e => e.pack_id && (packTags[e.pack_id] || []).includes(state.packTag));
        rawItems = items;
        renderNav(rawItems);
        const retained = activeId && rawItems.some(e => e.id === activeId);
        if (!retained) activeId = null;
        renderList();
      } catch (e) {
        if (version !== request) return;
        count.textContent = 'Ошибка загрузки';
        lst.replaceChildren(el('div', { class: 'comp-no-results' }, el('b', {}, 'Не удалось загрузить справочник'), el('span', { class: 'muted small' }, e.message), el('button', { class: 'small', onclick: load }, 'Повторить')));
      }
    }

    srcSel.addEventListener('change', () => { state.source = srcSel.value; state.packTag = ''; packTagSel.value = ''; state.category = ''; state.folder = ''; state.facets = {}; load(); });
    packTagSel.addEventListener('change', () => { state.packTag = packTagSel.value; state.source = ''; srcSel.value = ''; state.category = ''; state.folder = ''; state.facets = {}; load(); });
    edSel.addEventListener('change', load);
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 240); });
    sort.addEventListener('change', () => { state.sort = sort.value; renderList(); });
    load();
    root.reload = load;
    return root;
  }

  // Виджет: категории + источник + поиск + список + карточка.
  // opts: campaignId, isGM, packId (режим редактирования набора), category (стартовая)
  function widget(opts = {}) {
    if (!opts.packId && !opts.campaignId && !opts.category && !opts.compact) return workspaceWidget(opts);
    const root = el('div', { class: 'comp comp-compact' });
    const left = el('div', { class: 'comp-compact-controls' });
    const catSel = el('select', { 'aria-label': 'Категория' }, el('option', { value: '' }, 'Все категории'), ...Object.entries(CAT_NAMES).map(([k, v]) => el('option', { value: k, selected: opts.category === k ? '' : null }, v)));
    const srcSel = el('select', { title: 'Источник', 'aria-label': 'Источник' }, el('option', { value: '' }, 'Все источники'));
    const ed0 = opts.edition || window.SHEET_EDITION || defaultEdition();
    const edSel = el('select', { title: 'Редакция правил', 'aria-label': 'Редакция правил' }, ...Object.entries(EDITIONS).map(([k, v]) => el('option', { value: k, selected: ed0 === k ? '' : null }, v)), el('option', { value: '', selected: ed0 === '' ? '' : null }, 'Обе редакции'));
    const packTagSel = el('select', { title: 'Тег набора', 'aria-label': 'Фильтр по тегу набора' }, el('option', { value: '' }, 'Все теги наборов'));
    const folderSel = el('select', { title: 'Папка набора', 'aria-label': 'Папка' }, el('option', { value: '' }, 'Все папки'));
    const q = el('input', { placeholder: 'Название или ключевое слово…', 'aria-label': 'Поиск по справочнику' });
    const facetBar = el('div', { class: 'comp-facets comp-compact-facets', 'aria-label': 'Фильтры по свойствам' });
    const count = el('span', { class: 'comp-compact-count' }, 'Загрузка…');
    const heading = el('div', { class: 'comp-compact-heading' }, icon('book', 16), el('div', { class: 'grow' }, el('b', {}, 'Записи'), el('small', { class: 'muted' }, 'Выбери или перетащи на лист')), count);
    const lst = el('div', { class: 'list lst comp-compact-list' });
    const det = el('div', { class: 'det comp-compact-detail' }, el('div', { class: 'comp-compact-empty' }, icon('book', 26), el('b', {}, 'Выбери запись'), el('span', { class: 'muted small' }, 'Описание и действия появятся здесь.')));
    const sourceRow = el('div', { class: 'comp-compact-filter-row' }, edSel, srcSel);
    const packRow = el('div', { class: 'comp-compact-filter-row' }, packTagSel, folderSel);
    left.append(heading, catSel, sourceRow, packRow, q, facetBar, lst,
      el('button', { class: 'small comp-compact-create', onclick: () => editEntry(null, { campaignId: opts.campaignId, isGM: opts.isGM, packId: opts.packId, category: catSel.value || 'item', onSaved: load }) }, '+ Создать свою запись'));
    if (opts.packId) { sourceRow.hidden = true; packTagSel.hidden = true; packRow.classList.add('comp-compact-filter-row-single'); }
    root.append(left, det);

    let timer, request = 0, packNames = {}, packTags = {}, rawItems = [], activeId = null;
    let facets = {};
    const listValues = value => (Array.isArray(value) ? value : String(value ?? '').split(/[,;|]/)).map(x => String(x).trim()).filter(Boolean);
    const packTagValues = p => String(p.tags || '').split(',').map(t => t.trim()).filter(Boolean);

    function fieldValues(e, key) {
      const d = e.data || {};
      switch (key) {
        case 'item.type': return e.category === 'item' ? d.type : '';
        case 'item.category': return e.category === 'item' ? d.category : '';
        case 'item.rarity': return e.category === 'item' ? d.rarity : '';
        case 'item.property': return e.category === 'item' ? listValues(d.properties) : [];
        case 'item.tag': return e.category === 'item' ? listValues(d.tags) : [];
        case 'spell.level': return e.category === 'spell' ? String(d.level ?? '') : '';
        case 'spell.school': return e.category === 'spell' ? d.school : '';
        case 'spell.class': return e.category === 'spell' ? listValues(d.classes) : [];
        case 'monster.type': return e.category === 'monster' ? d.type : '';
        case 'monster.size': return e.category === 'monster' ? d.size : '';
        case 'monster.cr': return e.category === 'monster' ? d.cr : '';
        case 'race.size': return e.category === 'race' ? d.size : '';
        case 'class.hit_die': return e.category === 'class' ? d.hit_die : '';
        case 'background.tool': return e.category === 'background' ? listValues(d.tools) : [];
        case 'npc.role': return e.category === 'npc' ? d.role : '';
        case 'npc.faction': return e.category === 'npc' ? d.faction : '';
        case 'entry.tag': return listValues(d.tags);
        default: return '';
      }
    }
    function facetDefinitions(items) {
      const definitions = [], category = catSel.value;
      const add = (key, label, values, format = v => String(v)) => {
        const opts = new Map();
        for (const value of values) {
          if (value === undefined || value === null || value === '') continue;
          const v = String(value);
          opts.set(v, format(v));
        }
        if (opts.size) definitions.push({ key, label, options: [...opts].sort((a, b) => a[1].localeCompare(b[1], 'ru')) });
      };
      const data = items.map(e => e.data || {});
      if (category === 'item') {
        add('item.type', 'Тип предмета', data.map(d => d.type), v => M().ITEM_TYPES?.[v] || v);
        add('item.category', 'Категория', data.map(d => d.category));
        add('item.rarity', 'Редкость', data.map(d => d.rarity));
        add('item.property', 'Свойство', data.flatMap(d => listValues(d.properties)));
        add('item.tag', 'Тег предмета', data.flatMap(d => listValues(d.tags)));
      } else if (category === 'spell') {
        add('spell.level', 'Уровень', data.map(d => d.level), v => v === '0' ? 'Заговор' : `${v} круг`);
        add('spell.school', 'Школа', data.map(d => d.school));
        add('spell.class', 'Класс', data.flatMap(d => listValues(d.classes)));
      } else if (category === 'monster') {
        add('monster.type', 'Тип существа', data.map(d => d.type));
        add('monster.size', 'Размер', data.map(d => d.size));
        add('monster.cr', 'Опасность', data.map(d => d.cr));
      } else if (category === 'race') add('race.size', 'Размер', data.map(d => d.size));
      else if (category === 'class') add('class.hit_die', 'Кость хитов', data.map(d => d.hit_die));
      else if (category === 'background') add('background.tool', 'Инструмент', data.flatMap(d => listValues(d.tools)));
      else if (category === 'npc') {
        add('npc.role', 'Роль', data.map(d => d.role));
        add('npc.faction', 'Фракция', data.map(d => d.faction));
      }
      if (!category) add('entry.tag', 'Тег записи', data.flatMap(d => listValues(d.tags)));
      return definitions;
    }
    function renderFacets() {
      facetBar.replaceChildren();
      const definitions = facetDefinitions(rawItems);
      facetBar.hidden = !definitions.length;
      if (!definitions.length) return;
      for (const def of definitions) {
        const values = [...def.options];
        if (facets[def.key] && !values.some(([v]) => v === facets[def.key])) values.unshift([facets[def.key], facets[def.key]]);
        const select = el('select', { 'aria-label': def.label, title: def.label, onchange: () => { if (select.value) facets[def.key] = select.value; else delete facets[def.key]; renderList(); } },
          el('option', { value: '' }, def.label), ...values.map(([v, label]) => el('option', { value: v, selected: facets[def.key] === v ? '' : null }, label)));
        facetBar.append(select);
      }
      if (Object.keys(facets).length) facetBar.append(el('button', { class: 'small ghost', onclick: () => { facets = {}; renderFacets(); renderList(); } }, 'Сбросить'));
    }
    function updateFolders(items) {
      const prev = folderSel.value;
      const folders = [...new Set(items.map(e => e.data?.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
      folderSel.replaceChildren(el('option', { value: '' }, 'Все папки'), ...folders.map(f => el('option', { value: f, selected: prev === f ? '' : null }, f)));
      if (prev && !folders.includes(prev)) folderSel.value = '';
    }
    function matchingItems() {
      return rawItems.filter(e => {
        if (folderSel.value && e.data?.folder !== folderSel.value) return false;
        if (packTagSel.value && !(packTags[e.pack_id] || []).some(t => t.toLocaleLowerCase() === packTagSel.value.toLocaleLowerCase())) return false;
        return Object.entries(facets).every(([key, expected]) => listValues(fieldValues(e, key)).includes(String(expected)));
      });
    }
    function selectEntry(e, row) {
      activeId = e.id;
      lst.querySelectorAll('.item').forEach(x => x.classList.toggle('active', x === row));
      det.replaceChildren(renderData(e, { isGM: opts.isGM, campaignId: opts.campaignId, packMine: e._mine, onChanged: load }));
    }
    function renderList() {
      const items = matchingItems();
      lst.replaceChildren();
      count.textContent = String(items.length);
      if (!items.length) lst.append(el('div', { class: 'comp-compact-no-results' }, icon('search', 18), el('span', {}, 'Ничего не найдено'), el('small', { class: 'muted' }, 'Попробуй изменить фильтры.')));
      let lastCat = null;
      const rows = new Map();
      for (const e of items) {
        if (!catSel.value && e.category !== lastCat) { lastCat = e.category; lst.append(el('div', { class: 'muted small', style: 'padding:6px 4px 2px;text-transform:uppercase;letter-spacing:.5px' }, CAT_NAMES[e.category] || e.category)); }
        e.pack_name = packNames[e.pack_id]; e._mine = !!(e.pack_id && (packsCache || []).some(p => p.id === e.pack_id));
        const ico = e.data?.asset_id ? M().docIcon(e.data, 'box', 16) : e.category === 'item' ? M().itemIcon({ type: e.data?.type, icon: e.data?.icon }) : icon({ spell: 'star', monster: 'skull', npc: 'user', lore: 'book', race: 'user', class: 'shield', background: 'book', feat: 'scroll', condition: 'zap' }[e.category] || 'box', 16);
        const row = el('div', { class: 'item comp-compact-entry', role: 'button', tabindex: '0', draggable: 'true', title: 'Нажми, чтобы открыть, или перетащи на лист' }, el('span', { class: 'lst-ico' }, ico), el('span', { class: 'grow' }, e.name, e.data?.name_en && e.data.name_en !== e.name ? el('span', { class: 'muted small' }, ' ' + e.data.name_en) : null), !edSel.value && e.data?.edition ? el('span', { class: 'badge' }, e.data.edition) : null, e.pack_id ? el('span', { class: 'badge', title: e.pack_name }, 'набор') : e.campaign_id ? el('span', { class: 'badge' }, 'HB') : null);
        rows.set(e.id, row);
        row.addEventListener('click', () => selectEntry(e, row));
        row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectEntry(e, row); } });
        row.addEventListener('dragstart', ev => { ev.dataTransfer.setData('application/x-compendium', JSON.stringify(e)); if (e.category === 'item') ev.dataTransfer.setData('application/x-item', JSON.stringify({ item: M().itemFromCompendium(e) })); if (e.category === 'spell') ev.dataTransfer.setData('application/x-spell', JSON.stringify({ spell: M().spellFromCompendium(e) })); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; });
        lst.append(row);
      }
      const active = items.find(e => e.id === activeId);
      if (active && rows.has(active.id)) selectEntry(active, rows.get(active.id));
      else if (activeId) { activeId = null; det.replaceChildren(el('p', { class: 'muted' }, 'Выберите запись. Перетаскивайте её на лист персонажа или на стол.')); }
    }
    async function load() {
      const version = ++request;
      try {
        const params = new URLSearchParams();
        if (catSel.value) params.set('category', catSel.value);
        if (q.value.trim()) params.set('q', q.value.trim());
        if (edSel.value && !opts.packId) params.set('edition', edSel.value);
        params.set('limit', '3000');
        const src = srcSel.value;
        if (opts.packId) params.set('pack_id', opts.packId);
        else if (src.startsWith('pack:')) params.set('pack_id', src.slice(5));
        else if (opts.campaignId) params.set('campaign_id', opts.campaignId);
        let items = await API.get('/api/compendium?' + params);
        if (src === 'srd') items = items.filter(e => !e.campaign_id && !e.pack_id);
        else if (src === 'hb') items = items.filter(e => e.campaign_id);
        if (packTagSel.value) items = items.filter(e => e.pack_id && (packTags[e.pack_id] || []).some(t => t.toLocaleLowerCase() === packTagSel.value.toLocaleLowerCase()));
        if (version !== request) return;
        rawItems = items;
        updateFolders(rawItems);
        renderFacets();
        renderList();
      } catch (e) {
        if (version !== request) return;
        lst.replaceChildren(el('p', { class: 'muted small', style: 'padding:8px' }, 'Не удалось загрузить: ' + e.message));
      }
    }
    async function loadPackOptions() {
      try {
        let packs = await myPacks();
        if (opts.packId) {
          const p = await API.get('/api/packs/' + opts.packId);
          packs = [...packs.filter(x => x.id !== p.id), p];
        } else if (opts.campaignId) {
          let camp = []; try { camp = await API.get(`/api/campaigns/${opts.campaignId}/packs`); } catch { }
          packs = [...packs, ...camp.filter(p => !packs.some(m => m.id === p.id))];
        }
        packTags = Object.fromEntries(packs.map(p => [p.id, packTagValues(p)]));
        packNames = Object.fromEntries(packs.map(p => [p.id, p.name]));
        if (!opts.packId) {
          for (const p of packs) srcSel.append(el('option', { value: 'pack:' + p.id }, p.name));
          srcSel.append(el('option', { value: 'srd' }, 'База (SRD)'));
          if (opts.campaignId) srcSel.append(el('option', { value: 'hb' }, 'Homebrew кампании'));
        }
        const tags = [...new Set(packs.flatMap(packTagValues))].sort((a, b) => a.localeCompare(b, 'ru'));
        packTagSel.replaceChildren(el('option', { value: '' }, 'Все теги наборов'), ...tags.map(t => el('option', { value: t }, t)));
        if (srcSel.value && ![...srcSel.options].some(o => o.value === srcSel.value)) srcSel.value = '';
        load();
      } catch { /* keep the compendium usable without pack metadata */ }
    }
    catSel.addEventListener('change', () => { facets = {}; folderSel.value = ''; renderFacets(); load(); });
    srcSel.addEventListener('change', () => { folderSel.value = ''; load(); });
    edSel.addEventListener('change', () => { if (!opts.edition && !window.SHEET_EDITION && edSel.value) LS.setItem('et-edition', edSel.value); load(); });
    packTagSel.addEventListener('change', () => { folderSel.value = ''; load(); });
    folderSel.addEventListener('change', renderList);
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    load();
    loadPackOptions();
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
