// ---------------------------------------------------------------------------
// race-editor.js — отдельный редактор расы справочника (по образу редактора класса).
//
// Открывается там же, где раньше создавалась раса: «Создать свою запись» →
// категория «Расы» и кнопка «Редактировать» в карточке расы. Разделы:
// Общее · Характеристики · Языки · Заклинания · Навыки · Владения · Черты · Подрасы.
//
// Правила расы живут в графе механик (узлы rule.*), поэтому редактор правит и
// сырые поля записи, и узлы графа — иначе правку не увидел бы мастер создания:
//   rule.speed / rule.languages / rule.ability_bonus — скорость, языки, бонусы;
//   rule.skill_proficiency                          — владение навыком (как у записи навыка);
//   rule.skills                                     — выбор навыков игроком;
//   rule.spell_list                                 — заклинания, известные расе сразу;
//   rule.proficiencies                              — владения (доспехи, оружие, инструменты);
//   action.program (group: 'traits') + action.manual — черты расы с текстом.
// Сырые поля (data.speed, data.languages, data.asi, data.skills, data.traits)
// пишутся рядом: их читают карточка справочника и старые листы.
//
// Даёт: window.RaceEditor { edit, readState, writeData, emptyData, SECTIONS }.
// ---------------------------------------------------------------------------
window.RaceEditor = (() => {
  const KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const ABIL_SHORT = { str: 'СИЛ', dex: 'ЛОВ', con: 'ТЕЛ', int: 'ИНТ', wis: 'МДР', cha: 'ХАР' };
  const SIZES = ['Крошечный', 'Маленький', 'Средний', 'Большой', 'Огромный', 'Огромнейший'];
  const PROF_KINDS = ['Доспехи', 'Оружие', 'Инструменты'];
  const clone = x => JSON.parse(JSON.stringify(x));
  const M = () => window.Modules;
  const B = () => window.CharacterBuilder;
  const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const str = v => String(v === undefined || v === null ? '' : v);
  const norm = v => str(v).toLocaleLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,;:()[\]×*]/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- Навыки (как в редакторе класса и на листе) ----------
  const skillsCatalog = () => (window.SKILLS || []).map(([key, name, ability]) => ({ key, name, ability }));
  function skillKeyOfName(value) {
    const want = norm(value);
    if (!want) return '';
    const catalog = skillsCatalog();
    return (catalog.find(s => norm(s.name) === want) || catalog.find(s => norm(s.key) === want) || {}).key || '';
  }
  const skillNameOfKey = key => (skillsCatalog().find(s => s.key === key) || {}).name || str(key);
  const skillFromEntry = entry => (entry?.category === 'skill' ? (skillKeyOfName(entry.data?.key) || skillKeyOfName(entry.name)) : '');

  // ---------- Заклинания (набор правил расы + собственные данные записи) ----------
  const LEVELS = [0, 1, 2, 3, 4, 5];
  const levelLabel = l => (num(l) > 0 ? `${num(l)}-й круг` : 'Заговор');
  const ABILITY_OPTIONS = [{ value: '', label: 'не указана' }, ...KEYS.map(k => ({ value: k, label: ABIL[k] || k })),
    { value: 'choice', label: 'выбор игрока' }];
  // Английское имя записи: сервер отдаёт его полем data.name_en, в «сырых» данных оно лежит в слое i18n.en.
  const nameEnOf = data => str(data?.name_en || data?.i18n?.en?.name);
  /// Набор правил расы (race_rules по редакции): корень — по английскому имени родителя, поверх — своя запись.
  function presetRaceRules(entry) {
    const d = entry?.data || {}, edition = str(d.edition) || '2014';
    const items = window.Presets?.items?.('race_rules', edition) || [];
    const byName = en => { const key = str(en).toLowerCase(); return key ? items.find(i => str(i.table?.name_en).toLowerCase() === key)?.table : undefined; };
    const own = byName(nameEnOf(d)), root = byName(str(d.i18n?.en?.parent));
    return { ...(root || {}), ...(own && own !== root ? own : {}) };
  }

  // ---------- Граф механик ----------
  const nodesOf = g => (Array.isArray(g?.nodes) ? g.nodes : (g.nodes = []));
  const linksOf = g => (Array.isArray(g?.links) ? g.links : (g.links = []));
  let seq = 0;
  const nodeId = prefix => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  function removeNode(graph, id) {
    const nodes = nodesOf(graph), links = linksOf(graph);
    graph.nodes = nodes.filter(n => n.id !== id);
    graph.links = links.filter(l => l.from?.node !== id && l.to?.node !== id);
  }
  /// Привести узлы типа type к списку wanted: лишние удаляются, нужные обновляются (id и связи сохраняются).
  function syncNodes(graph, type, wanted, match) {
    const existing = nodesOf(graph).filter(n => n.type === type);
    const used = new Set();
    for (const item of wanted) {
      const found = existing.find(n => !used.has(n.id) && (!match || match(n, item)));
      if (found) { found.params = { ...found.params, ...item.params }; used.add(found.id); continue; }
      const node = { id: nodeId(type.split('.')[1] || 'rule'), type, params: clone(item.params), position: { x: 40, y: 40 + (nodesOf(graph).length % 12) * 60 } };
      nodesOf(graph).push(node); used.add(node.id);
    }
    for (const n of existing) if (!used.has(n.id)) removeNode(graph, n.id);
  }
  const nextProgramId = graph => {
    const taken = nodesOf(graph).filter(n => n.type === 'action.program').map(n => num(String(n.params?.program_id || '').replace(/\D/g, ''), 0));
    return 'p' + (Math.max(0, ...taken) + 1);
  };
  /// Программы черт расы (group: 'traits'): по одной на черту, с текстом в action.manual.
  function syncTraits(graph, traits) {
    const programs = nodesOf(graph).filter(n => n.type === 'action.program' && str(n.params?.group) === 'traits');
    const used = new Set();
    traits.forEach((t, i) => {
      const name = str(t.name).trim(); if (!name) return;
      let program = programs.find(p => !used.has(p.id) && str(p.params?.feature_name) === name) || programs.find(p => !used.has(p.id));
      if (!program) {
        program = { id: nodeId('program'), type: 'action.program', position: { x: 60, y: 70 + i * 90 }, params: {} };
        nodesOf(graph).push(program);
      }
      used.add(program.id);
      program.params = { ...program.params, program_id: str(program.params.program_id) || nextProgramId(graph), name, trigger: 'use', feature_name: name, group: 'traits' };
      const links = linksOf(graph);
      const link = links.find(l => l.from?.node === program.id && str(l.from?.socket) === 'exec');
      let manual = link && nodesOf(graph).find(n => n.id === link.to?.node && n.type === 'action.manual');
      if (!manual) {
        manual = { id: nodeId('manual'), type: 'action.manual', position: { x: 330, y: 70 + i * 90 }, params: { block_id: nodeId('b') } };
        nodesOf(graph).push(manual);
        links.push({ from: { node: program.id, socket: 'exec' }, to: { node: manual.id, socket: 'exec' } });
      }
      manual.params = { ...manual.params, enabled: true, when: 'always', text: str(t.text), block_id: str(manual.params.block_id) || nodeId('b') };
    });
    for (const p of programs) {
      if (used.has(p.id)) continue;
      for (const l of linksOf(graph).filter(l => l.from?.node === p.id && str(l.from?.socket) === 'exec')) {
        const target = nodesOf(graph).find(n => n.id === l.to?.node);
        const orphans = linksOf(graph).filter(other => other.to?.node === target?.id).length;
        if (target && target.type === 'action.manual' && orphans <= 1) removeNode(graph, target.id);
      }
      removeNode(graph, p.id);
    }
  }

  // ---------- Чтение и запись записи ----------
  /// Граф записи: существующий (v2), переведённый из старого формата (v1) или новый пустой.
  function graphOf(d) {
    let mech = d.mechanics;
    if (mech && mech.version !== 2) mech = window.Mechanics?.toGraph?.(mech) || null;
    if (!(mech && mech.version === 2)) mech = null;
    const graph = mech?.graph || { nodes: [], links: [], frames: [], groups: [] };
    if (!mech) { d.mechanics = { origin: 'race-editor-v2', version: 2, graph }; mech = d.mechanics; }
    if (!Array.isArray(graph.frames)) graph.frames = [];
    if (!Array.isArray(graph.groups)) graph.groups = [];
    nodesOf(graph); linksOf(graph);
    return graph;
  }
  const ruleNodes = (graph, type) => nodesOf(graph).filter(n => n.type === type);
  const listOf = node => (Array.isArray(node?.params?.value) ? node.params.value.map(str).filter(Boolean) : []);
  /// Пассивные блоки старого формата (action.passive) ещё читает лист — правим их вместе с узлами.
  const passiveNodes = (graph, field) => nodesOf(graph).filter(n => n.type === 'action.passive' && str(n.params?.field) === field);
  function syncPassive(graph, values) {
    for (const [field, value] of Object.entries(values)) {
      const nodes = passiveNodes(graph, field);
      const keep = value === null || value === undefined || (Array.isArray(value) && !value.length) ? null : nodes[0];
      if (keep) {
        keep.params = { ...keep.params, value };
        for (const extra of nodes.slice(1)) removeNode(graph, extra.id);
      } else for (const n of nodes) removeNode(graph, n.id);
    }
  }

  /// Заклинания, известные расе сразу: по узлу rule.spell_list на каждую характеристику (пусто — характеристику выбирает игрок).
  function syncSpellNodes(graph, groups) {
    const existing = ruleNodes(graph, 'rule.spell_list');
    const used = new Set();
    for (const [ability, spells] of groups) {
      let node = existing.find(n => !used.has(n.id) && (str(n.params?.ability) || '') === ability);
      if (!node) {
        node = { id: nodeId('spell'), type: 'rule.spell_list', position: { x: 60, y: 60 + (nodesOf(graph).length % 12) * 60 }, params: {} };
        nodesOf(graph).push(node);
      }
      used.add(node.id);
      // Чужие параметры узла сохраняем, свои переписываем: характеристика без значения убирается совсем —
      // rule.spell_list не принимает пустое значение (проверка узла отклонила бы весь граф).
      node.params = { ...node.params, mode: 'known', spells: [...spells] };
      if (ability) node.params.ability = ability; else delete node.params.ability;
    }
    for (const n of existing) if (!used.has(n.id)) removeNode(graph, n.id);
  }

  function emptyData(edition = '2014') {
    return { name_en: '', edition, size: 'Средний', speed: 30, languages: [], traits: [], desc: '', age: '', size_description: '', subraces: [], asi: {} };
  }

  /// Заклинания записи: узлы графа → поля данных → набор правил расы (у высшего эльфа так приходит
  /// «Заговор высшего эльфа»: один заговор волшебника на выбор, Интеллект — характеристика).
  function readSpells(d, graph, entry) {
    const preset = presetRaceRules(entry);
    const nodes = ruleNodes(graph, 'rule.spell_list');
    const spellRow = c => (typeof c === 'string'
      ? { name: str(c), level: 0, ability: '' }
      : { name: str(c?.name), level: num(c?.level), ability: str(c?.ability) });
    const fixed = nodes.length
      ? nodes.flatMap(n => (Array.isArray(n.params?.spells) ? n.params.spells : []).map(name => ({ name: str(name), level: 0, ability: str(n.params?.ability) })))
      : Array.isArray(d.cantrips) ? d.cantrips.map(spellRow) : (preset.cantrips || []).map(spellRow);
    const choiceRow = c => ({ key: str(c?.key), title: str(c?.title), hint: str(c?.hint), ability: str(c?.ability) || 'choice',
      level: num(c?.filter?.level), classes: (Array.isArray(c?.filter?.classes) ? c.filter.classes : []).map(str).filter(Boolean).join(', ') });
    const choices = Array.isArray(d.spell_choices)
      ? d.spell_choices.filter(c => str(c?.kind) === 'spell').map(choiceRow)
      : (preset.choices || []).filter(c => str(c?.kind) === 'spell').map(choiceRow);
    const own = d.spell_ability_choice;
    const fromPreset = (preset.choices || []).find(c => str(c?.key) === 'raceSpellAbility');
    const options = c => (Array.isArray(c?.options) ? c.options : []).map(o => str(o?.value ?? o)).filter(k => KEYS.includes(k));
    const ability = own && typeof own === 'object'
      ? { mode: own.enabled ? 'on' : 'off', options: options(own).length ? options(own) : ['int', 'wis', 'cha'], title: str(own.title), hint: str(own.hint) }
      : fromPreset ? { mode: 'on', options: options(fromPreset).length ? options(fromPreset) : ['int', 'wis', 'cha'], title: str(fromPreset.title), hint: str(fromPreset.hint) }
        : { mode: 'inherit', options: ['int', 'wis', 'cha'], title: '', hint: '' };
    return { fixed: fixed.filter(r => r.name), choices, ability };
  }

  /// Состояние редактора из записи: узлы графа в приоритете, сырые поля — запасной вариант.
  function readState(entry) {
    const d = entry?.data || {};
    const graph = d.mechanics?.graph || { nodes: [] };
    const asiNodes = ruleNodes(graph, 'rule.ability_bonus');
    const asi = {};
    for (const key of KEYS) {
      const node = asiNodes.find(n => str(n.params?.ability) === key);
      asi[key] = node ? num(node.params?.amount) : num(d.asi?.[key]);
    }
    const langs = ruleNodes(graph, 'rule.languages');
    const rawLangs = Array.isArray(d.languages) ? d.languages : [];
    const fixed = langs.length ? listOf(langs[0]) : rawLangs.filter(x => str(x).length <= 40);
    const rulesNode = ruleNodes(graph, 'rule.skills')[0];
    const skillNode = ruleNodes(graph, 'rule.skill_proficiency')[0];
    const passiveSkills = passiveNodes(graph, 'skills').flatMap(n => (Array.isArray(n.params?.value) ? n.params.value : [n.params?.value]).map(str).filter(Boolean));
    return {
      name: str(entry?.name),
      name_en: str(d.name_en),
      edition: str(d.edition) || '2014',
      size: str(d.size) || 'Средний',
      speed: num(ruleNodes(graph, 'rule.speed')[0]?.params?.value ?? d.speed, 30),
      parent: str(d.parent),
      desc: str(d.desc),
      age: str(d.age),
      size_description: str(d.size_description),
      asi,
      languages: { fixed, note: rawLangs.filter(x => str(x).length > 40).join('\n') },
      skills: {
        fixed: skillNode ? listOf(skillNode) : (Array.isArray(d.skills) && d.skills.length ? d.skills.map(str) : passiveSkills),
        choose: num(rulesNode?.params?.count, 0),
        from: Array.isArray(rulesNode?.params?.options) ? rulesNode.params.options.map(str) : [],
        id: str(rulesNode?.params?.id) || 'race_skills',
      },
      spells: readSpells(d, graph, entry),
      profs: ruleNodes(graph, 'rule.proficiencies').map(n => ({ kind: str(n.params?.kind), values: listOf(n) })),
      traits: (Array.isArray(d.traits) ? d.traits : []).map(t => ({ name: str(t?.name), text: str(t?.text) })),
      subraces: (Array.isArray(d.subraces) ? d.subraces : []).map(str).filter(Boolean),
    };
  }

  /// Состояние редактора → данные записи (неизвестные поля и прочие узлы сохраняются).
  function writeData(st, entry) {
    const d = { ...(entry?.data || {}) };
    const graph = graphOf(d);
    d.name_en = st.name_en.trim();
    d.edition = st.edition;
    d.size = st.size.trim();
    d.speed = num(st.speed, 30);
    if (st.parent.trim()) { d.parent = st.parent.trim(); d.subrace = true; } else { delete d.parent; delete d.subrace; }
    d.desc = st.desc;
    if (st.age.trim()) d.age = st.age.trim(); else delete d.age;
    if (st.size_description.trim()) d.size_description = st.size_description.trim(); else delete d.size_description;

    // Характеристики: сырое поле и узлы rule.ability_bonus (их читает мастер создания).
    const asi = {};
    for (const key of KEYS) if (num(st.asi[key])) asi[key] = num(st.asi[key]);
    if (Object.keys(asi).length) d.asi = asi; else delete d.asi;
    syncNodes(graph, 'rule.ability_bonus', KEYS.filter(k => num(st.asi[k])).map(k => ({ params: { ability: k, amount: num(st.asi[k]) } })),
      (node, item) => str(node.params?.ability) === item.params.ability);
    syncNodes(graph, 'rule.speed', [{ params: { value: num(st.speed, 30) } }]);

    // Языки: узлом rule.languages (имена) и сырым полем (имена + примечание текстом).
    const langs = st.languages.fixed.map(s => str(s).trim()).filter(Boolean);
    const note = str(st.languages.note).trim();
    syncNodes(graph, 'rule.languages', langs.length ? [{ params: { value: langs } }] : []);
    if (langs.length || note) d.languages = note ? [...langs, note] : [...langs]; else delete d.languages;

    // Навыки: владение — узлом rule.skill_proficiency, выбор игрока — узлом rule.skills.
    const skillNames = st.skills.fixed.map(s => str(s).trim()).filter(Boolean);
    syncNodes(graph, 'rule.skill_proficiency', skillNames.length ? [{ params: { value: skillNames } }] : []);
    if (skillNames.length) d.skills = skillNames; else delete d.skills;
    const from = st.skills.from.map(s => str(s).trim()).filter(Boolean);
    syncNodes(graph, 'rule.skills', num(st.skills.choose) > 0 && from.length
      ? [{ params: { id: str(st.skills.id).trim() || 'race_skills', count: Math.min(num(st.skills.choose), from.length), options: from } }] : []);

    // Владения: по узлу rule.proficiencies на каждый вид.
    syncNodes(graph, 'rule.proficiencies', st.profs.filter(p => str(p.kind).trim() && (p.values || []).length)
      .map(p => ({ params: { kind: str(p.kind).trim(), value: p.values.map(str).filter(Boolean) } })),
    (node, item) => str(node.params?.kind) === item.params.kind);

    // Заклинания: известные сразу — узлом rule.spell_list и полем data.cantrips; выбор игрока — data.spell_choices.
    const spellRows = st.spells.fixed.map(r => ({ name: str(r.name).trim(), level: num(r.level), ability: str(r.ability) })).filter(r => r.name);
    d.cantrips = spellRows.map(r => ({ name: r.name, level: r.level, ability: r.ability }));
    const spellChoices = st.spells.choices.map((c, i) => ({ key: str(c.key).trim() || `spell_choice_${i + 1}`, kind: 'spell',
      title: str(c.title).trim(), hint: str(c.hint), ability: KEYS.includes(c.ability) ? c.ability : 'int',
      filter: { level: num(c.level), classes: str(c.classes).split(',').map(x => str(x).trim().toLowerCase()).filter(Boolean) } })).filter(c => c.title);
    d.spell_choices = spellChoices;
    if (st.spells.ability.mode === 'inherit') delete d.spell_ability_choice; else d.spell_ability_choice = { enabled: st.spells.ability.mode === 'on',
      options: (st.spells.ability.options || []).filter(k => KEYS.includes(k)), title: str(st.spells.ability.title), hint: str(st.spells.ability.hint) };
    const spellGroups = new Map();
    for (const row of spellRows) {
      const ability = KEYS.includes(row.ability) ? row.ability : '';
      if (!spellGroups.has(ability)) spellGroups.set(ability, []);
      spellGroups.get(ability).push(row.name);
    }
    syncSpellNodes(graph, spellGroups);

    // Черты: сырым полем data.traits и программами графа (кнопки бросков в описании черты).
    const traits = st.traits.map(t => ({ name: str(t.name).trim(), text: str(t.text) })).filter(t => t.name);
    d.traits = traits;
    syncTraits(graph, traits);

    // Пассивные блоки старого формата — в ногу с узлами: иначе лист показал бы прежние значения.
    syncPassive(graph, {
      speed: num(st.speed, 30),
      languages: langs.length || note ? [...langs, ...(note ? [note] : [])] : null,
      skills: skillNames,
      ...Object.fromEntries(KEYS.map(k => [`asi.${k}`, num(st.asi[k]) || null])),
    });

    const subraces = st.subraces.map(s => str(s).trim()).filter(Boolean);
    if (subraces.length) d.subraces = subraces; else delete d.subraces;
    return d;
  }

  // ---------- Мелкие элементы интерфейса ----------
  const field = (label, input, hint) => el('label', { class: 'ced-field' }, el('span', {}, label), input,
    hint ? el('small', { class: 'muted' }, hint) : null);
  const numInput = (value, onChange, opts = {}) => el('input', { type: 'number', class: 'ced-num', value: String(value ?? ''),
    min: String(opts.min ?? 0), max: String(opts.max ?? 99), oninput: e => onChange(num(e.target.value, 0)) });
  const textInput = (value, placeholder, onChange) => el('input', { value: str(value), placeholder: str(placeholder || ''), oninput: e => onChange(e.target.value) });
  const select = (value, options, onChange) => el('select', { onchange: e => onChange(e.target.value) },
    ...options.map(o => el('option', { value: String(o.value), selected: String(o.value) === String(value) ? '' : null }, o.label)));
  const chip = (text, onRemove, extra = {}) => el('span', { class: 'ced-chip' + (extra.class ? ' ' + extra.class : ''), title: extra.title || null },
    el('b', {}, text), extra.note ? el('small', {}, extra.note) : null,
    onRemove ? el('button', { type: 'button', class: 'ced-chip-x', title: 'Убрать', onclick: onRemove }, '×') : null);
  const area = (value, rows, placeholder, onChange) => el('textarea', { rows, placeholder: str(placeholder || ''), oninput: e => onChange(e.target.value) }, str(value));

  /// Зона, принимающая перетаскивание: типы данных — как в справочнике.
  function dropZone(label, types, onDrop) {
    const zone = el('div', { class: 'ced-drop' }, el('span', { class: 'muted' }, label));
    zone.addEventListener('dragover', ev => { if (M().hasType(ev, ...types)) { ev.preventDefault(); ev.stopPropagation(); zone.classList.add('over'); } });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', ev => {
      zone.classList.remove('over');
      const payload = types.map(t => M().getDrag(ev, t)).find(Boolean);
      if (!payload) return;
      ev.preventDefault(); ev.stopPropagation();
      onDrop(payload);
    });
    return zone;
  }

  /// Список значений чипами: что уже есть, поле ввода и кнопка. render — перерисовка раздела.
  function listEditor(values, render, opts = {}) {
    const box = el('div', {});
    const list = el('div', { class: 'ced-chips' });
    const draw = () => {
      list.replaceChildren(...values.map((value, i) => chip(str(value), () => { values.splice(i, 1); render(); },
        { note: opts.noteOf ? opts.noteOf(value) : '' })));
      if (!values.length) list.append(el('span', { class: 'muted small' }, str(opts.empty || 'Пока пусто.')));
    };
    draw();
    box.append(list);
    const input = el('input', { placeholder: str(opts.placeholder || 'своё значение') });
    const add = value => {
      const v = str(value).trim();
      if (!v || values.some(x => norm(x) === norm(v))) return false;
      values.push(v); render(); return true;
    };
    box.append(el('div', { class: 'ced-row' },
      opts.options ? select('', [{ value: '', label: str(opts.addLabel || '+ добавить…') }, ...opts.options.filter(o => !values.some(x => norm(x) === norm(o.value))).map(o => ({ value: o.value, label: o.label }))], v => { if (v) add(v); }) : null,
      input,
      el('button', { type: 'button', class: 'small', onclick: () => { if (add(input.value)) input.value = ''; } }, 'Добавить'),
      opts.drop ? dropZone(str(opts.drop), ['application/x-skill', 'application/x-compendium'], payload => {
        // Принимаем только навыки: свою запись раздела «Навыки» или название из словаря листа.
        const entry = payload.entry || payload;
        const key = payload.key || skillFromEntry(entry) || (opts.skillOnly && entry?.category === 'skill' ? skillKeyOfName(entry.name) : skillKeyOfName(entry?.name || payload?.name));
        if (!key) { toast('Сюда можно перетащить только запись из раздела «Навыки»'); return; }
        add(skillNameOfKey(key));
      }) : null));
    return box;
  }

  // ---------- Разделы ----------
  const SECTIONS = [
    { id: 'common', title: 'Общее', hint: 'Название, размер, скорость, описание' },
    { id: 'abilities', title: 'Характеристики', hint: 'Увеличение характеристик расы' },
    { id: 'languages', title: 'Языки', hint: 'Какими языками владеет раса' },
    { id: 'spells', title: 'Заклинания', hint: 'Заговоры и заклинания расы: известные сразу и выбор игрока' },
    { id: 'skills', title: 'Навыки', hint: 'Владение навыками и выбор игрока' },
    { id: 'proficiencies', title: 'Владения', hint: 'Доспехи, оружие, инструменты' },
    { id: 'traits', title: 'Черты', hint: 'Особенности расы с текстами' },
    { id: 'subraces', title: 'Подрасы', hint: 'Разновидности расы' },
  ];

  function commonSection(st) {
    const box = el('div', { class: 'ced-grid' });
    box.append(
      field('Название', textInput(st.name, 'Дварф', v => st.name = v)),
      field('Английское название (ключ)', textInput(st.name_en, 'Dwarf', v => st.name_en = v), 'По нему раса связывается с наборами правил'),
      field('Редакция', select(st.edition, [{ value: '2014', label: 'D&D 5e (2014)' }, { value: '2024', label: 'D&D 5e (2024)' }], v => st.edition = v)),
      field('Размер', select(st.size, SIZES.map(s => ({ value: s, label: s })), v => st.size = v)),
      field('Скорость', numInput(st.speed, v => st.speed = Math.max(0, v), { max: 200 }), 'футов в ход'),
      field('Родительская раса', textInput(st.parent, '—', v => st.parent = v), 'Для подрасы: запись станет разновидностью'),
    );
    box.append(el('label', { class: 'ced-field wide' }, el('span', {}, 'Описание'), area(st.desc, 4, '', v => st.desc = v)));
    box.append(el('label', { class: 'ced-field wide' }, el('span', {}, 'Возраст'), area(st.age, 2, '', v => st.age = v)));
    box.append(el('label', { class: 'ced-field wide' }, el('span', {}, 'Рост и вес'), area(st.size_description, 2, '', v => st.size_description = v)));
    return box;
  }

  function abilitiesSection(st) {
    const box = el('div', { class: 'ced-grid' });
    for (const key of KEYS) box.append(field(ABIL[key] || key, numInput(st.asi[key] || 0, v => st.asi[key] = Math.max(-5, Math.min(6, v)), { min: -5, max: 6 }), `+${num(st.asi[key])}`));
    box.append(el('p', { class: 'muted small wide' },
      'Бонусы 2014 фиксированы расой и попадают в лист сразу (узлы rule.ability_bonus). В редакции 2024 игрок сам распределяет +2 и +1 на шаге характеристик — поля оставьте пустыми.'));
    return box;
  }

  function languagesSection(st, render) {
    const box = el('div', {});
    box.append(listEditor(st.languages.fixed, render, {
      options: ((B()?.LANGUAGES || [])).map(l => ({ value: l, label: l })), addLabel: '+ добавить язык…',
      placeholder: 'свой язык', empty: 'Раса не даёт языков автоматически.',
    }));
    box.append(el('label', { class: 'ced-field' }, el('span', {}, 'Примечание о языках'),
      area(st.languages.note, 2, 'Вы можете говорить, читать и писать на Общем и Дварфийском…', v => st.languages.note = v)));
    box.append(el('p', { class: 'muted small' }, 'Языки пишутся в узел rule.languages и в поле данных: их видит и мастер создания, и карточка справочника.'));
    return box;
  }

  function spellsSection(st, render) {
    const box = el('div', {});
    box.append(el('h4', { class: 'ced-sub' }, 'Заклинания, известные сразу'));
    const rows = el('div', { class: 'ced-features' });
    const draw = () => {
      rows.replaceChildren(...st.spells.fixed.map((row, index) => el('div', { class: 'ced-feature' },
        el('div', { class: 'ced-row' },
          el('input', { class: 'grow', value: str(row.name), placeholder: 'Название заклинания из справочника', oninput: e => row.name = e.target.value }),
          select(num(row.level), LEVELS.map(l => ({ value: l, label: levelLabel(l) })), v => { row.level = num(v); render(); }),
          select(str(row.ability), ABILITY_OPTIONS, v => { row.ability = v; render(); }),
          el('button', { type: 'button', class: 'small ghost', title: 'Убрать заклинание', onclick: () => { st.spells.fixed.splice(index, 1); render(); } }, '×')))));
      if (!st.spells.fixed.length) rows.append(el('span', { class: 'muted small' }, 'Известных сразу заклинаний нет.'));
    };
    draw();
    box.append(rows);
    const addSpell = (name, level) => {
      const value = str(name).trim();
      if (!value || st.spells.fixed.some(r => norm(r.name) === norm(value))) return false;
      st.spells.fixed.push({ name: value, level: num(level), ability: '' });
      render(); return true;
    };
    box.append(el('div', { class: 'ced-row' },
      el('button', { type: 'button', class: 'small', onclick: () => { st.spells.fixed.push({ name: '', level: 0, ability: '' }); render(); } }, '+ заклинание'),
      dropZone('Перетащите заклинание из справочника сюда', ['application/x-spell', 'application/x-compendium'], payload => {
        const entry = payload.entry || (payload.spell ? { name: payload.spell.name, category: 'spell', data: { level: payload.spell.level } } : payload);
        if (entry?.category !== 'spell') { toast('Сюда можно перетащить только запись из раздела «Заклинания»'); return; }
        addSpell(entry.name, entry.data?.level);
      })));

    box.append(el('h4', { class: 'ced-sub' }, 'Выбор игрока'));
    const choices = el('div', { class: 'ced-features' });
    const drawChoices = () => {
      choices.replaceChildren(...st.spells.choices.map((row, index) => el('div', { class: 'ced-feature' },
        el('div', { class: 'ced-row' },
          el('input', { class: 'grow', value: str(row.title), placeholder: 'Заголовок выбора, например «Заговор высшего эльфа»', oninput: e => row.title = e.target.value }),
          el('button', { type: 'button', class: 'small ghost', title: 'Убрать выбор', onclick: () => { st.spells.choices.splice(index, 1); render(); } }, '×')),
        el('div', { class: 'ced-row' },
          select(num(row.level), LEVELS.map(l => ({ value: l, label: levelLabel(l) })), v => { row.level = num(v); render(); }),
          el('input', { class: 'grow', value: str(row.classes), placeholder: 'классы через запятую: волшебник, wizard', oninput: e => row.classes = e.target.value }),
          select(str(row.ability), [{ value: 'choice', label: 'характеристика игрока' }, ...KEYS.map(k => ({ value: k, label: ABIL[k] || k }))], v => { row.ability = v; render(); })),
        el('input', { class: 'grow', value: str(row.hint), placeholder: 'Подсказка игроку: откуда выбирать заговор', oninput: e => row.hint = e.target.value }))));
      if (!st.spells.choices.length) choices.append(el('span', { class: 'muted small' }, 'Выбора заговора нет — раса даёт только известные сразу.'));
    };
    drawChoices();
    box.append(choices);
    box.append(el('div', { class: 'ced-row' },
      el('button', { type: 'button', class: 'small', onclick: () => { st.spells.choices.push({ key: '', title: '', hint: '', ability: 'choice', level: 0, classes: '' }); render(); } }, '+ выбор заговора'),
      el('span', { class: 'muted small' }, 'Игрок выберет одно заклинание из списка класса по уровню.')));

    const ab = st.spells.ability;
    box.append(el('h4', { class: 'ced-sub' }, 'Заклинательная характеристика'));
    box.append(el('div', { class: 'ced-row' },
      select(ab.mode, [{ value: 'inherit', label: 'Наследуется от набора правил' }, { value: 'on', label: 'Игрок выбирает из списка' }, { value: 'off', label: 'Не задана' }], v => { ab.mode = v; render(); }),
      ab.mode === 'on' ? el('div', { class: 'ced-row' }, ...KEYS.map(k => el('label', { class: 'ced-inline' },
        el('input', { type: 'checkbox', checked: ab.options.includes(k) ? '' : null, onchange: e => {
          ab.options = e.target.checked ? [...new Set([...ab.options, k])] : ab.options.filter(x => x !== k); render();
        } }), el('span', {}, ABIL[k] || k)))) : null));
    if (ab.mode === 'on' && !ab.options.length) box.append(el('p', { class: 'danger small' }, 'Отметьте хотя бы одну характеристику — иначе игроку нечего выбирать.'));
    if (st.spells.fixed.some(r => str(r.ability) === 'choice') && ab.mode !== 'on') box.append(el('p', { class: 'muted small' },
      'Часть заклинаний использует характеристику по выбору игрока — включите «Игрок выбирает из списка».'));
    box.append(el('p', { class: 'muted small' },
      'Известные сразу заклинания пишутся узлом rule.spell_list и полем data.cantrips, выбор игрока — полями data.spell_choices и data.spell_ability_choice. '
      + 'Мастер создания задаёт вопрос на шаге расы и выдаёт заклинания листу.'));
    return box;
  }

  function skillsSection(st, render) {
    const box = el('div', {});
    box.append(el('h4', { class: 'ced-sub' }, 'Владение навыками'));
    box.append(listEditor(st.skills.fixed, render, {
      options: skillsCatalog().map(s => ({ value: s.name, label: `${s.name} (${ABIL[s.ability] || s.ability})` })),
      addLabel: '+ добавить навык…', placeholder: 'свой навык', drop: 'Перетащите навык из справочника сюда',
      empty: 'Раса не даёт владения навыками.', noteOf: value => ABIL_SHORT[skillAbil(value)] || '', skillOnly: true,
    }));
    box.append(el('h4', { class: 'ced-sub' }, 'Выбор игрока'));
    box.append(el('div', { class: 'ced-row' },
      el('label', { class: 'ced-inline' }, el('span', {}, 'Игрок выбирает'),
        numInput(st.skills.choose, v => { st.skills.choose = Math.max(0, v); render(); }, { max: 18 }),
        el('small', { class: 'muted' }, 'навыков из списка ниже')),
      el('span', { class: 'grow' }),
      el('span', { class: 'ced-counter' + (st.skills.from.length ? ' ok' : '') }, `${st.skills.from.length} в списке`)));
    box.append(listEditor(st.skills.from, render, {
      options: skillsCatalog().map(s => ({ value: s.name, label: `${s.name} (${ABIL[s.ability] || s.ability})` })),
      addLabel: '+ добавить навык…', placeholder: 'свой навык', drop: 'Перетащите навык из справочника сюда',
      empty: 'Списка выбора нет.', noteOf: value => ABIL_SHORT[skillAbil(value)] || '', skillOnly: true,
    }));
    box.append(el('p', { class: 'muted small' },
      'Владение записывается узлом rule.skill_proficiency — тем же, что несёт запись навыка из справочника: перетаскивайте навыки прямо сюда.'));
    return box;
  }
  const skillAbil = value => (skillsCatalog().find(s => s.name === value || s.key === value) || {}).ability || '';

  function proficienciesSection(st, render) {
    const box = el('div', {});
    const rows = el('div', { class: 'ced-features' });
    const draw = () => {
      rows.replaceChildren(...st.profs.map((row, index) => el('div', { class: 'ced-feature' },
        el('div', { class: 'ced-row' },
          select(row.kind, [...PROF_KINDS, ...(PROF_KINDS.includes(row.kind) ? [] : [row.kind])].map(k => ({ value: k, label: k })), v => { row.kind = v; render(); }),
          el('span', { class: 'grow' }),
          el('button', { type: 'button', class: 'small ghost', title: 'Убрать вид владений', onclick: () => { st.profs.splice(index, 1); render(); } }, '×')),
        listEditor(row.values, render, { placeholder: 'что именно', empty: 'Пока пусто.' }))));
      if (!st.profs.length) rows.append(el('span', { class: 'muted small' }, 'Владений нет — у большинства рас они описаны в чертах.'));
    };
    draw();
    box.append(rows);
    box.append(el('div', { class: 'ced-row' }, ...PROF_KINDS.map(kind => el('button', { type: 'button', class: 'small',
      onclick: () => { if (!st.profs.some(p => p.kind === kind)) { st.profs.push({ kind, values: [] }); render(); } } }, '+ ' + kind)),
      el('button', { type: 'button', class: 'small', onclick: () => { st.profs.push({ kind: 'Владения', values: [] }); render(); } }, '+ своё')));
    box.append(el('p', { class: 'muted small' }, 'Каждый вид владений — свой узел rule.proficiencies: мастер создания покажет их во владениях персонажа.'));
    return box;
  }

  function traitsSection(st, render) {
    const box = el('div', { class: 'ced-features' });
    const draw = () => {
      box.replaceChildren(...st.traits.map((t, index) => el('div', { class: 'ced-feature' },
        el('div', { class: 'ced-row' },
          el('input', { class: 'grow', value: str(t.name), placeholder: 'Название черты', oninput: e => t.name = e.target.value }),
          el('button', { type: 'button', class: 'small ghost', onclick: () => { st.traits.splice(index, 1); render(); } }, '×')),
        el('textarea', { rows: 3, placeholder: 'Текст черты', oninput: e => t.text = e.target.value }, str(t.text)))));
    };
    draw();
    return el('div', {}, box,
      el('button', { type: 'button', class: 'small', onclick: () => { st.traits.push({ name: '', text: '' }); render(); } }, '+ черта'),
      el('p', { class: 'muted small' }, 'Черта попадает и в поле данных, и в программу графа: кнопки бросков в её тексте работают на листе.'));
  }

  function subracesSection(st, render) {
    const box = el('div', {});
    box.append(listEditor(st.subraces, render, {
      placeholder: 'название подрасы', empty: 'Подрас нет.',
    }));
    box.append(el('p', { class: 'muted small' },
      'Списком подрасы видны в карточке. Саму разновидность создайте отдельной записью расы и укажите в ней родительскую расу (раздел «Общее»).'));
    return box;
  }

  /// Открыть редактор: возвращает { name, data } (сохранение делает справочник) или null.
  function edit(entry, opts = {}) {
    const st = readState(entry);
    let section = 'common';
    const content = el('div', { class: 'ced-content' });
    const nav = el('div', { class: 'ced-nav' });
    const render = () => {
      const sec = SECTIONS.find(s => s.id === section) || SECTIONS[0];
      nav.replaceChildren(...SECTIONS.map(s => el('button', { type: 'button', class: 'ced-nav-btn' + (s.id === sec.id ? ' on' : ''),
        onclick: () => { section = s.id; render(); } }, s.title)));
      const body = sec.id === 'common' ? commonSection(st)
        : sec.id === 'abilities' ? abilitiesSection(st)
          : sec.id === 'languages' ? languagesSection(st, render)
            : sec.id === 'spells' ? spellsSection(st, render)
              : sec.id === 'skills' ? skillsSection(st, render)
              : sec.id === 'proficiencies' ? proficienciesSection(st, render)
                : sec.id === 'traits' ? traitsSection(st, render)
                  : subracesSection(st, render);
      content.replaceChildren(el('div', { class: 'ced-section' }, el('h3', {}, sec.title), el('p', { class: 'muted small' }, sec.hint), body));
    };
    render();
    const root = el('div', { class: 'class-editor' }, nav, content);
    return modal(entry?.id ? 'Раса: ' + (entry.name || '') : 'Новая раса', root,
      [{ label: 'Сохранить', cls: 'primary', fn: () => {
        const name = st.name.trim();
        if (!name) { toast('Нужно название расы'); return false; }
        return { name, data: writeData(st, entry) };
      } }], { wide: true });
  }

  return { edit, readState, writeData, emptyData, SECTIONS, SIZES, PROF_KINDS, LEVELS, presetRaceRules };
})();
