// Creation is a pure projection of a draft + compendium snapshots, never an incremental mutation.
window.CharacterBuilder = (() => {
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const short = { СИЛ: 'str', ЛОВ: 'dex', ТЕЛ: 'con', ИНТ: 'int', МДР: 'wis', ХАР: 'cha' };
  const modifier = n => Math.floor((n - 10) / 2);
  const handlers = new Map();
  const register = (category, apply) => handlers.set(category, apply);
  const feature = (s, name, text, source, mechanics) => s.features.push(Modules.newFeature({ name, text: text || '', source, mechanics }));
  register('race', (s, e) => {
    const d = e.data || {}; s.race = d.parent ? `${d.parent} (${e.name})` : e.name; if (d.speed) s.speed = d.speed;
    if (s.edition === '2014') for (const k of keys) s.abilities[k] += Number(d.asi?.[k]) || 0;
    if (Array.isArray(d.languages)) s.proficiencies += d.languages.join(', ') + '\n';
  });
  register('class', (s, e) => {
    const d = e.data || {}; s.class = e.name; s.saving_throws = [...(d.saves || [])];
    s.hp.hit_dice = '1' + (d.hit_die || 'd8'); s.spells.ability = d.spellcasting || '';
    for (const name of d.features?.['1'] || []) feature(s, name, d.feature_texts?.[name], e.name, window.Mechanics?.forFeature(d.mechanics,name));
    s.proficiencies += [d.armor, d.weapons].filter(Boolean).join('\n') + '\n';
    if (d.starting_equipment) s.notes += 'Стартовое снаряжение — выберите и добавьте в инвентарь:\n' + d.starting_equipment + '\n';
  });
  register('background', (s, e) => {
    const d = e.data || {}; s.background = e.name;
    for (const name of Array.isArray(d.skills)?d.skills:[]) { const skill = SKILLS.find(([k, n]) => k === name || n === name); if (skill) s.skills.push(skill[0]); }
    if (d.feature) feature(s, d.feature, d.feature_text, e.name, window.Mechanics?.forFeature(d.mechanics,d.feature));
    if (d.feat) feature(s, d.feat, 'Описание и варианты выбора — в справочнике черт.', e.name);
    if (d.equipment) s.notes += 'Снаряжение предыстории — выберите и добавьте в инвентарь:\n' + d.equipment + '\n';
  });
  register('spell', (s, e) => s.spells.known.push(Modules.spellFromCompendium(e)));
  function build(draft) {
    const s = { name: draft.name.trim(), edition: draft.edition, level: 1, abilities: { ...draft.abilities },
      race: '', class: '', background: '', proficiency_bonus: 2, saving_throws: [], skills: [...(draft.skills || [])],
      hp: { max: 0, current: 0, temp: 0, hit_dice: '1d8' }, speed: 30, features: [],
      spells: { ability: '', slots: {}, known: [] }, proficiencies: '', notes: '', modules: [] };
    const entries = ['race', 'class', 'background'].map(k => draft.selected[k]).filter(Boolean).concat(draft.spells || []);
    const race = draft.selected.race;
    if (race?.data?.parent) {
      const candidates = (draft.catalog || []).filter(e => e.category === 'race' && e.name === race.data.parent && !e.data?.subrace);
      const parent = candidates.find(e => e.pack_id === race.pack_id && e.source === race.source) || candidates[0];
      if (parent) entries.unshift(parent);
    }
    for (const raw of entries) {
      const e=window.Mechanics?Mechanics.passiveData(raw):raw;
      handlers.get(e.category)?.(s, e);
      // Explicit passive blocks also work on homebrew categories, not just the old
      // race/class fields. The build remains a pure projection, so bonuses never stack on rebuild.
      for(const p of e.data?.mechanics?.programs||[])if(p.trigger==='passive')for(const b of p.blocks||[])if(b.kind==='passive'&&b.enabled!==false){
        const field=b.field,v=b.value;
        if(field==='speed'&&Number.isFinite(v))s.speed=v;
        else if(field==='hit_die')s.hp.hit_dice='1'+v;
        else if(field==='spellcasting')s.spells.ability=v;
        else if(field==='saves'&&Array.isArray(v))s.saving_throws=[...new Set([...s.saving_throws,...v])];
        else if(field==='skills'&&Array.isArray(v))for(const name of v){const skill=SKILLS.find(([k,n])=>k===name||n===name);if(skill)s.skills.push(skill[0]);}
        else if(field.startsWith('asi.')&&!(e.category==='race'&&s.edition==='2014')){const k=field.slice(4);if(keys.includes(k)&&Number.isFinite(v))s.abilities[k]+=v;}
        else if(['armor','weapons'].includes(field)&&typeof v==='string'&&v&&!s.proficiencies.includes(v))s.proficiencies+=v+'\n';
        else if(field==='languages'&&Array.isArray(v)){for(const language of v)if(!s.proficiencies.includes(language))s.proficiencies+=language+'\n';}
      }

      for (const t of e.data?.traits || []) feature(s, t.name, t.text, e.name, t.mechanics || window.Mechanics?.forFeature(e.data?.mechanics,t.name));
      const custom=e.data?.mechanics?.programs?.filter(p=>p.trigger==='use'&&!p.feature_name);
      if(custom?.length&&e.category!=='spell')feature(s,e.name,e.data.desc,e.source,{version:1,programs:JSON.parse(JSON.stringify(custom))});
      s.modules.push({ schema_version: 1, entry_id: e.id, category: e.category, source: e.source, pack_id: e.pack_id || null, snapshot: JSON.parse(JSON.stringify(e)) });
    }
    if (s.edition === '2024') for (const k of keys) s.abilities[k] += Number(draft.bonuses?.[k]) || 0;
    s.skills = [...new Set(s.skills)];
    s.hp.max = s.hp.current = Math.max(1, Number(s.hp.hit_dice.split('d')[1]) + modifier(s.abilities.con));
    s.ac = 10 + modifier(s.abilities.dex);
    s.creation = { version: 1, method: draft.method, base_abilities: { ...draft.abilities }, rolls: draft.rolls || [] };
    return s;
  }
  function rollStats(random) {
    const results = keys.map(() => DiceEngine.evaluate('4d6kh3', random));
    if (!random) DiceEngine.present({ label: 'Характеристики персонажа · 4d6, три лучших', rolls: results.map((r, i) => ({ ...r, name: `Набор ${i + 1}` })) }, { local: true });
    return results.map(r => { const p = r.parts[0]; return { dice: p.rolls, dropped: p.rolls.findIndex((_, i) => !p.kept_indices.includes(i)), total: r.total }; });
  }
  return { register, build, rollStats, keys, short };
})();

window.newCharacterDialog = async function (defaults = {}) {
  const B = CharacterBuilder;
  const draft = { name: defaults.name || '', edition: defaultEdition(), abilities: Object.fromEntries(B.keys.map((k, i) => [k, [15, 14, 13, 12, 10, 8][i]])), selected: {}, spells: [], skills: [], bonuses: {}, method: 'standard', rolls: [] };
  const steps = ['Концепция', 'Происхождение', 'Характеристики', 'Магия', 'Готовый лист'];
  let step = 0, entries = [], loading = false, error = '', request = 0, query = '';
  const root = el('div', { class: 'character-builder' });
  const status = el('p', { class: 'builder-error', role: 'alert' });
  const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);
  const signed = n => (n >= 0 ? '+' : '') + n;
  function valid() {
    if (!draft.name.trim()) return 'Дайте персонажу имя.';
    if (step >= 1 && ['race', 'class', 'background'].some(k => !draft.selected[k])) return 'Выберите расу, класс и предысторию.';
    if (step >= 2) {
      if (Object.values(draft.abilities).some(n => !Number.isInteger(n) || n < 3 || n > 20)) return 'Базовые характеристики: целые числа от 3 до 20.';
      const opts = draft.selected.background?.data?.asi_options || [];
      if (draft.edition === '2024' && opts.length) {
        const values = Object.values(draft.bonuses).filter(Boolean).sort();
        if (!['1,2', '1,1,1'].includes(values.join(','))) return 'Распределите бонусы предыстории: +2/+1 или +1/+1/+1.';
      }
    }
    return '';
  }
  async function load() {
    const version = ++request; loading = true; error = ''; render();
    try {
      const params = new URLSearchParams({ edition: draft.edition, limit: '3000' });
      if (defaults.campaignId) params.set('campaign_id', defaults.campaignId);
      const result = await Promise.all(['race', 'class', 'background', 'spell'].map(category => API.get('/api/compendium?' + params + '&category=' + category)));
      if (version !== request) return;
      entries = result.flat(); draft.catalog = entries;
    } catch (e) { if (version === request) error = e.message; }
    if (version === request) { loading = false; render(); }
  }
  function choose(category) {
    const selected = draft.selected[category];
    const select = el('select', { 'aria-label': CAT_NAMES[category], onchange: e => {
      draft.selected[category] = entries.find(x => x.id === e.target.value);
      if (category === 'background') draft.bonuses = {};
      if (category === 'class') { draft.skills = []; draft.spells = []; }
      render();
    } }, el('option', { value: '' }, 'Выберите…'), ...entries.filter(e => e.category === category).map(e => el('option', { value: e.id, selected: selected?.id === e.id ? '' : null }, e.name + ' · ' + e.source)));
    const d = selected?.data || {};
    return el('section', { class: 'builder-module' }, field(CAT_NAMES[category], select),
      selected ? el('div', {}, el('p', { class: 'muted small' }, [d.hit_die && 'Кость хитов: ' + d.hit_die, d.primary && 'Основная: ' + d.primary, d.speed && 'Скорость: ' + d.speed + ' фт.'].filter(Boolean).join(' · ')), el('p', { class: 'builder-description' }, d.desc || (d.traits || []).map(t => t.name).join(' · ') || 'Подробности — в справочнике.'), el('details', {}, el('summary', {}, 'Описание модуля'), Compendium.renderData(selected, { readOnly: true }))) : null,
      el('button', { class: 'small', onclick: async () => { try { await Compendium.editEntry(null, { category, onSaved: load }); } catch (e) { toast(e.message); } } }, '+ Создать свой модуль'));
  }
  function render() {
    root.replaceChildren(); status.textContent = '';
    root.append(el('div', { class: 'builder-steps' }, ...steps.map((n, i) => el('span', { class: i === step ? 'active' : i < step ? 'done' : '', 'aria-current': i === step ? 'step' : null }, `${i + 1}. ${n}`))));
    const body = el('div', { class: 'builder-body' });
    root.append(body);
    if (step === 0) {
      body.append(el('div', { class: 'builder-intro' }, el('span', { class: 'builder-eyebrow' }, 'DUNGEONS & DRAGONS · УРОВЕНЬ 1'), el('h2', {}, 'Каждая история начинается с героя'), el('p', { class: 'muted' }, 'Пять коротких шагов — и ваш лист готов к приключению. Все выбранные модули сохранятся вместе с персонажем.')),
        field('Имя персонажа', el('input', { value: draft.name, maxlength: 128, placeholder: 'Как вас будут помнить?', oninput: e => draft.name = e.target.value })),
        field('Редакция правил', el('select', { onchange: e => { draft.edition = e.target.value; draft.selected = {}; draft.spells = []; draft.skills = []; draft.bonuses = {}; load(); } }, ...Object.entries(EDITIONS).map(([k, n]) => el('option', { value: k, selected: draft.edition === k ? '' : null }, n)))),
        el('p', { class: 'muted small' }, '2014: бонусы характеристик от расы. 2024: от предыстории. Пользовательские модули доступны из ваших наборов и наборов кампании.'));
    }
    if (step === 1 || step === 3) {
      if (loading) body.append(el('p', { role: 'status' }, 'Загружаем модули…'));
      else if (error) body.append(el('p', { role: 'alert' }, 'Не удалось загрузить: ' + error), el('button', { onclick: load }, 'Повторить'));
      else if (step === 1) body.append(el('div', { class: 'builder-modules' }, ...['race', 'class', 'background'].map(choose)));
      else {
        body.append(el('h2', {}, 'Книга заклинаний'), el('p', { class: 'muted' }, 'Необязательный шаг. Выбирайте заговоры и заклинания 1-го круга. Ограничения класса и число известных заклинаний проверьте с мастером.'),
          el('input', { type: 'search', value: query, placeholder: 'Найти заклинание…', 'aria-label': 'Поиск заклинаний', oninput: e => { query = e.target.value; updateSpells(); } }),
          el('button', { class: 'small', onclick: async () => { try { await Compendium.editEntry(null, { category: 'spell', onSaved: load }); } catch (e) { toast(e.message); } } }, '+ Создать заклинание'));
        const list = el('div', { class: 'builder-spells' }); body.append(list);
        function updateSpells() {
          const found = entries.filter(e => e.category === 'spell' && Number(e.data?.level || 0) <= 1 && e.name.toLowerCase().includes(query.toLowerCase()));
          list.replaceChildren(...found.map(e => el('label', { class: 'builder-spell' }, el('input', { type: 'checkbox', checked: draft.spells.some(x => x.id === e.id) ? '' : null, onchange: ev => { draft.spells = draft.spells.filter(x => x.id !== e.id); if (ev.target.checked) draft.spells.push(e); } }), el('span', {}, el('b', {}, e.name), el('small', {}, `${e.data?.level || 0} круг · ${e.source}`)), el('span', { title: e.data?.desc || '', class: 'muted' }, 'ⓘ'))));
          if (!found.length) list.append(el('p', { class: 'muted' }, 'Заклинаний не найдено. Измените поиск или создайте свой модуль.'));
        }
        updateSpells();
      }
    }
    if (step === 2) {
      body.append(el('h2', {}, 'Шесть граней вашего героя'), el('p', { class: 'muted' }, 'Бросок 4d6: минимальный кубик отбрасывается. Значения можно поменять местами; бонусы модулей добавятся отдельно.'));
      body.append(el('div', { class: 'row' }, el('button', { onclick: () => { draft.method = 'rolled'; draft.rolls = B.rollStats(); B.keys.forEach((k, i) => draft.abilities[k] = draft.rolls[i].total); render(); } }, icon('dice'), ' Бросить 6 × 4d6'), el('button', { onclick: () => { draft.method = 'standard'; draft.rolls = []; B.keys.forEach((k, i) => draft.abilities[k] = [15, 14, 13, 12, 10, 8][i]); render(); } }, 'Стандартный набор'), el('button', { onclick: () => { draft.method = 'manual'; render(); } }, 'Вручную')));
      const sheet = B.build(draft);
      body.append(el('div', { class: 'builder-abilities' }, ...B.keys.map((k, i) => {
        const input = draft.method === 'manual' ? el('input', { type: 'number', min: 3, max: 20, value: draft.abilities[k], 'aria-label': ABIL[k], onchange: e => { draft.abilities[k] = Number(e.target.value); render(); } }) : el('select', { 'aria-label': ABIL[k], onchange: e => { const other = e.target.value; [draft.abilities[k], draft.abilities[other]] = [draft.abilities[other], draft.abilities[k]]; render(); } }, ...B.keys.map(other => el('option', { value: other, selected: other === k ? '' : null }, draft.abilities[other] + (other === k ? '' : ' ↔ ' + ABIL[other]))));
        return el('div', { class: 'builder-ability' }, el('label', {}, ABIL[k]), el('strong', {}, signed(Math.floor((sheet.abilities[k] - 10) / 2))), input, el('small', {}, `Итого ${sheet.abilities[k]} · бонус ${signed(sheet.abilities[k] - draft.abilities[k])}`));
      })));
      if (draft.rolls.length) body.append(el('div', { class: 'builder-rolls' }, ...draft.rolls.map((r, i) => el('span', {}, `${i + 1}: `, ...r.dice.map((v, j) => el(j === r.dropped ? 's' : 'b', {}, v + ' ')), '= ' + r.total))));
      const options = draft.selected.background?.data?.asi_options || [];
      if (draft.edition === '2024' && options.length) body.append(el('h3', {}, 'Бонусы предыстории: +2/+1 или +1/+1/+1'), el('div', { class: 'row' }, ...options.map(n => {
        const k = B.short[n] || n; return field(ABIL[k] || n, el('select', { onchange: e => { draft.bonuses[k] = Number(e.target.value); render(); } }, ...[0, 1, 2].map(v => el('option', { value: v, selected: (draft.bonuses[k] || 0) === v ? '' : null }, '+' + v))));
      })));
      const skills = (window.Mechanics&&draft.selected.class?Mechanics.passiveData(draft.selected.class):draft.selected.class)?.data?.skills;
      if (skills?.from) body.append(el('h3', {}, `Навыки класса (выберите ${skills.choose})`), el('div', { class: 'builder-skills' }, ...skills.from.map(n => {
        const k = SKILLS.find(([key, name]) => name === n || key === n)?.[0]; if (!k) return null;
        return el('label', {}, el('input', { type: 'checkbox', checked: draft.skills.includes(k) ? '' : null, onchange: e => { draft.skills = draft.skills.filter(x => x !== k); if (e.target.checked) draft.skills.push(k); } }), n);
      })));
    }
    if (step === 4) {
      const s = B.build(draft);
      body.append(el('div', { class: 'builder-paper' }, el('span', { class: 'builder-eyebrow' }, 'ЛИСТ ПЕРСОНАЖА · ' + EDITIONS[s.edition]), el('h2', {}, s.name), el('p', {}, [s.race, s.class + ' · 1 уровень', s.background].join(' / ')), el('div', { class: 'builder-abilities' }, ...B.keys.map(k => el('div', { class: 'builder-ability' }, el('label', {}, ABIL[k]), el('strong', {}, signed(Math.floor((s.abilities[k] - 10) / 2))), el('span', {}, s.abilities[k])))), el('div', { class: 'builder-summary' }, ...[['Хиты', s.hp.max], ['КД без брони', s.ac], ['Скорость, фт.', s.speed], ['Бонус мастерства', '+2']].map(([n, v]) => el('div', {}, el('strong', {}, v), el('small', {}, n)))), el('h3', {}, 'Подключённые модули'), el('p', {}, s.modules.map(m => m.snapshot.name).join(' · ')), el('p', { class: 'muted small' }, `Умений: ${s.features.length} · Заклинаний: ${s.spells.known.length}. Снаряжение, ячейки заклинаний и особые формулы КД настройте на листе — варианты снаряжения сохранены в заметках.`)));
    }
    const nav = el('div', { class: 'builder-nav' }, el('button', { disabled: step === 0 ? '' : null, onclick: () => { step--; render(); } }, '← Назад'), el('span', { class: 'muted small' }, `${step + 1} / ${steps.length}`));
    if (step < 4) nav.append(el('button', { class: 'primary', onclick: () => {
      const msg = valid(); if (msg) { status.textContent = msg; return; }
      const skills = (window.Mechanics&&draft.selected.class?Mechanics.passiveData(draft.selected.class):draft.selected.class)?.data?.skills;
      if (step === 2 && skills?.choose && draft.skills.length !== Number(skills.choose)) { status.textContent = `Выберите ${skills.choose} навыка класса.`; return; }
      step++; render();
    } }, 'Далее →'));
    root.append(status, nav);
  }
  render(); load();
  const result = await modal('Создание персонажа', root, [{ label: 'Создать персонажа', cls: 'primary builder-submit', fn: () => {
    if (step !== 4) { status.textContent = 'Пройдите шаги и проверьте готовый лист.'; return false; }
    const msg = valid(); if (msg) { status.textContent = msg; return false; }
    LS.setItem('et-edition', draft.edition);
    return { name: draft.name.trim(), sheet: B.build(draft) };
  } }], { wide: true });
  request++; // Ignore late fetches after cancellation.
  return result;
};
