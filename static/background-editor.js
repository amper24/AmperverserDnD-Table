// ---------------------------------------------------------------------------
// background-editor.js — отдельный редактор предыстории справочника.
//
// Открывается из справочника там же, где раньше правилась предыстория: «Создать свою
// запись» → категория «Предыстории» и кнопка «Редактировать» в карточке.
// Вместо одного поля с данными — разделы: Общее · Навыки · Владения · Языки ·
// Снаряжение · Способности · Характер.
//
// Редактор пишет в те же поля записи, которые читают мастер создания персонажа
// и лист, поэтому ничего не мигрирует:
//   rule.skill_proficiency (id bg_skills) и data.skills — владения навыками;
//   rule.skills (id bg_skills_choice) и data.skills_choice { count, from } — выбор навыков;
//   rule.proficiencies (kind «Инструменты») и data.tools — инструменты;
//   rule.languages и data.languages           — языки;
//   rule.feature и data.feature/feature_text  — умение предыстории;
//   data.feat                                  — черта 2024 (название из справочника);
//   data.asi_options                           — варианты характеристик 2024;
//   data.equipment                             — текст стартового снаряжения;
//   data.personality_traits/ideals/bonds/flaws — характер (2014).
//
// Даёт: window.BackgroundEditor { edit, readState, writeData, emptyData, SECTIONS }.
// ---------------------------------------------------------------------------
window.BackgroundEditor = (() => {
  const KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const ABIL_SHORT = { str: 'СИЛ', dex: 'ЛОВ', con: 'ТЕЛ', int: 'ИНТ', wis: 'МДР', cha: 'ХАР' };
  const clone = x => JSON.parse(JSON.stringify(x));
  const M = () => window.Modules;
  const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const str = v => String(v === undefined || v === null ? '' : v);
  const norm = v => str(v).toLocaleLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,;:()[\]×*]/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- Данные: словарь навыков и запись ----------
  /// Справочник навыков: из словаря листа (window.SKILLS) — им же пользуются лист и мастер.
  const skillsCatalog = () => (window.SKILLS || []).map(([key, name, ability]) => ({ key, name, ability }));
  const skillNameOfKey = key => (skillsCatalog().find(s => s.key === key) || {}).name || str(key);
  function skillKeyOfName(value) {
    const want = norm(value);
    if (!want) return '';
    const catalog = skillsCatalog();
    return (catalog.find(s => norm(s.name) === want) || catalog.find(s => norm(s.key) === want) || {}).key || '';
  }
  /// Навык из записи справочника (категория «Навыки»): ключ берётся из data.key, иначе по названию.
  const skillFromEntry = entry => (entry?.category === 'skill' ? (str(entry.data?.key) || skillKeyOfName(entry.name)) : '');
  const skillAbil = value => (skillsCatalog().find(s => s.name === value || s.key === value) || {}).ability || '';

  function emptyData(edition = '2014') {
    return { name_en: '', edition, desc: '', skills: [], tools: [], languages: [], equipment: '',
      feature: '', feature_text: '', asi_options: [], personality_traits: [], ideals: [], bonds: [], flaws: [] };
  }

  // ---------- Граф механик ----------
  const nodesOf = g => (Array.isArray(g?.nodes) ? g.nodes : (g.nodes = []));
  const linksOf = g => (Array.isArray(g?.links) ? g.links : (g.links = []));
  const ruleNodes = (graph, type) => nodesOf(graph).filter(n => n.type === type);
  let seq = 0;
  const nodeId = prefix => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  function removeNode(graph, id) {
    const nodes = nodesOf(graph), links = linksOf(graph);
    graph.nodes = nodes.filter(n => n.id !== id);
    graph.links = links.filter(l => l.from?.node !== id && l.to?.node !== id);
  }
  /// Узел правила с постоянным id: создаётся, обновляется или удаляется, когда значений нет.
  function syncRule(graph, id, type, params, keep = true) {
    const node = nodesOf(graph).find(n => n.id === id);
    if (!keep) { if (node) removeNode(graph, id); return; }
    if (node) { node.type = type; node.params = { ...node.params, ...params }; return; }
    nodesOf(graph).push({ id, type, position: { x: 40, y: 40 + (nodesOf(graph).length % 12) * 60 }, params: clone(params) });
  }
  const graphOf = d => {
    d.mechanics = d.mechanics && typeof d.mechanics === 'object' ? d.mechanics : { version: 2, origin: 'background-editor', graph: { nodes: [], links: [] } };
    d.mechanics.version = d.mechanics.version || 2;
    d.mechanics.graph = d.mechanics.graph && typeof d.mechanics.graph === 'object' ? d.mechanics.graph : { nodes: [], links: [] };
    nodesOf(d.mechanics.graph); linksOf(d.mechanics.graph);
    // Группы повторного использования нужны проверке графа — в записи предыстории их обычно нет.
    if (!Array.isArray(d.mechanics.graph.groups)) d.mechanics.graph.groups = [];
    return d.mechanics.graph;
  };

  // ---------- Чтение записи ----------
  /// Список значений узла (значение может быть строкой или списком).
  const listOf = node => (Array.isArray(node?.params?.value) ? node.params.value : [node?.params?.value]).map(str).filter(Boolean);

  function readState(entry) {
    const d = entry?.data || {};
    const graph = d.mechanics?.graph || { nodes: [] };
    const skillNode = ruleNodes(graph, 'rule.skill_proficiency')[0];
    const choiceNode = ruleNodes(graph, 'rule.skills')[0];
    const toolNode = ruleNodes(graph, 'rule.proficiencies').find(n => str(n.params?.kind) === 'Инструменты');
    const langNode = ruleNodes(graph, 'rule.languages')[0];
    const featureNode = ruleNodes(graph, 'rule.feature')[0];
    const rawSkills = Array.isArray(d.skills) ? d.skills.map(str) : [];
    const rawChoice = d.skills_choice && typeof d.skills_choice === 'object' ? d.skills_choice : null;
    const passiveSkills = ruleNodes(graph, 'action.passive').filter(n => str(n.params?.field) === 'skills')
      .flatMap(n => (Array.isArray(n.params?.value) ? n.params.value : [n.params?.value]).map(str).filter(Boolean));
    return {
      name: str(entry?.name),
      // Английское имя: сервер отдаёт его полем data.name_en, в «сырых» данных оно лежит в слое i18n.en.
      name_en: str(d.name_en || d.i18n?.en?.name),
      edition: str(d.edition) || '2014',
      desc: str(d.desc),
      skills: {
        fixed: skillNode ? listOf(skillNode) : (rawSkills.length ? rawSkills : passiveSkills),
        choose: num(choiceNode?.params?.count ?? rawChoice?.count, 0),
        from: choiceNode ? (Array.isArray(choiceNode.params?.options) ? choiceNode.params.options.map(str) : [])
          : (Array.isArray(rawChoice?.from) ? rawChoice.from.map(str) : []),
      },
      tools: toolNode ? listOf(toolNode) : (Array.isArray(d.tools) ? d.tools.map(str) : []),
      languages: langNode ? listOf(langNode) : (Array.isArray(d.languages) ? d.languages.map(str) : []),
      languagesNote: typeof d.languages === 'string' ? d.languages : '',
      languagesCount: typeof d.languages === 'number' ? num(d.languages, 0) : 0,
      equipment: str(d.equipment),
      feature: { name: featureNode ? str(featureNode.params?.name) : str(d.feature), text: featureNode ? str(featureNode.params?.text) : str(d.feature_text) },
      feat: str(d.feat),
      asiOptions: (Array.isArray(d.asi_options) ? d.asi_options : []).map(str).filter(x => KEYS.includes(String(x).toLowerCase()) || Object.values(ABIL_SHORT).includes(x)),
      character: {
        personality_traits: Array.isArray(d.personality_traits) ? d.personality_traits.map(str) : [],
        ideals: Array.isArray(d.ideals) ? d.ideals.map(str) : [],
        bonds: Array.isArray(d.bonds) ? d.bonds.map(str) : [],
        flaws: Array.isArray(d.flaws) ? d.flaws.map(str) : [],
      },
    };
  }

  // ---------- Запись записи ----------
  function writeData(st, entry) {
    const d = clone(entry?.data || {});
    const graph = graphOf(d);
    d.edition = str(st.edition) || '2014';
    if (str(st.name_en).trim()) d.name_en = str(st.name_en).trim();
    d.desc = str(st.desc);

    // Навыки: фиксированные — узлом rule.skill_proficiency, выбор игрока — узлом rule.skills.
    const fixed = st.skills.fixed.map(s => str(s).trim()).filter(Boolean);
    syncRule(graph, 'bg_skills', 'rule.skill_proficiency', { value: fixed }, fixed.length > 0);
    if (fixed.length) d.skills = fixed; else delete d.skills;
    const choose = Math.max(0, num(st.skills.choose, 0));
    const from = st.skills.from.map(s => str(s).trim()).filter(Boolean);
    const choice = choose > 0 ? { count: choose, from } : null;
    syncRule(graph, 'bg_skills_choice', 'rule.skills', { id: 'bg_skills_choice', count: choose, options: from }, !!choice);
    if (choice) d.skills_choice = choice; else delete d.skills_choice;

    // Инструменты: узел rule.proficiencies с видом «Инструменты» (его читает мастер создания).
    const tools = st.tools.map(s => str(s).trim()).filter(Boolean);
    syncRule(graph, 'bg_tools', 'rule.proficiencies', { kind: 'Инструменты', value: tools }, tools.length > 0);
    if (tools.length) d.tools = tools; else delete d.tools;

    // Языки: узел rule.languages (фиксированные названия) и текст примечания полем.
    const languages = st.languages.map(s => str(s).trim()).filter(Boolean);
    syncRule(graph, 'bg_languages', 'rule.languages', { value: languages }, languages.length > 0);
    const languagesCount = Math.max(0, num(st.languagesCount, 0));
    if (languages.length || st.languagesNote) d.languages = str(st.languagesNote) || languages;
    else if (languagesCount) d.languages = languagesCount; // «любые N языков» — число, как в записях SRD
    else delete d.languages;

    // Умение предыстории: узел rule.feature и поля data.feature/feature_text (их читает билдер).
    const featureName = str(st.feature.name).trim(), featureText = str(st.feature.text);
    syncRule(graph, 'bg_feature', 'rule.feature', { name: featureName, text: featureText }, !!featureName);
    if (featureName) { d.feature = featureName; d.feature_text = featureText; } else { delete d.feature; delete d.feature_text; }

    if (str(st.equipment).trim()) d.equipment = str(st.equipment); else delete d.equipment;
    if (str(st.feat).trim()) d.feat = str(st.feat).trim(); else delete d.feat;
    const asi = st.asiOptions.map(s => str(s).trim().toUpperCase()).filter(x => Object.values(ABIL_SHORT).includes(x));
    if (asi.length) d.asi_options = asi; else delete d.asi_options;
    for (const key of ['personality_traits', 'ideals', 'bonds', 'flaws']) {
      const values = (st.character?.[key] || []).map(s => str(s).trim()).filter(Boolean);
      if (values.length) d[key] = values; else delete d[key];
    }
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
  const area = (value, rows, placeholder, onChange) => el('textarea', { rows, placeholder: str(placeholder || ''), oninput: e => onChange(e.target.value) }, str(value));
  /// Скачок фокуса между разделами: список разделов слева, содержимое справа (как в редакторах расы и класса).
  const SECTIONS = [
    { id: 'common', title: 'Общее', hint: 'Название, редакция и описание' },
    { id: 'skills', title: 'Навыки', hint: 'Владение навыками и выбор игрока' },
    { id: 'proficiencies', title: 'Владения', hint: 'Инструменты и прочие владения' },
    { id: 'languages', title: 'Языки', hint: 'Какими языками владеет предыстория' },
    { id: 'equipment', title: 'Снаряжение', hint: 'Стартовое снаряжение (текст формата SRD)' },
    { id: 'features', title: 'Способности', hint: 'Умение предыстории, черта и характеристики 2024' },
    { id: 'character', title: 'Характер', hint: 'Идеалы, привязанности, слабости и черты характера' },
  ];

  /// Список значений чипами с приёмом навыков перетаскиванием: render — перерисовка раздела.
  function listEditor(values, render, opts = {}) {
    const box = el('div', {});
    const list = el('div', { class: 'ced-chips' });
    const draw = () => {
      list.replaceChildren(...values.map((value, i) => el('span', { class: 'ced-chip' },
        el('b', {}, str(value)), opts.noteOf && opts.noteOf(value) ? el('small', {}, opts.noteOf(value)) : null,
        el('button', { type: 'button', class: 'ced-chip-x', title: 'Убрать', onclick: () => { values.splice(i, 1); render(); } }, '×'))));
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
    const zone = el('div', { class: 'ced-drop' }, el('span', { class: 'muted' }, str(opts.drop || 'Перетащите сюда')));
    if (opts.drop) {
      zone.addEventListener('dragover', ev => { if (M().hasType(ev, 'application/x-skill', 'application/x-compendium')) { ev.preventDefault(); ev.stopPropagation(); zone.classList.add('over'); } });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', ev => {
        zone.classList.remove('over');
        const payload = M().getDrag(ev, 'application/x-skill') || M().getDrag(ev, 'application/x-compendium');
        if (!payload) return;
        ev.preventDefault(); ev.stopPropagation();
        const entry = payload.entry || payload;
        // Принимаем только навыки: свою запись раздела «Навыки» или название из словаря листа.
        const key = payload.key || skillFromEntry(entry) || skillKeyOfName(entry?.name || payload?.name);
        if (!key) { toast('Сюда можно перетащить только запись из раздела «Навыки»'); return; }
        add(skillNameOfKey(key));
      });
    }
    box.append(el('div', { class: 'ced-row' },
      opts.options ? select('', [{ value: '', label: str(opts.addLabel || '+ добавить…') },
        ...opts.options.filter(o => !values.some(x => norm(x) === norm(o.value))).map(o => ({ value: o.value, label: o.label }))], v => { if (v) add(v); }) : null,
      input,
      el('button', { type: 'button', class: 'small', onclick: () => { if (add(input.value)) input.value = ''; } }, 'Добавить')));
    if (opts.drop) box.append(zone);
    return box;
  }

  // ---------- Разделы ----------
  function commonSection(st) {
    const box = el('div', { class: 'ced-grid' });
    box.append(el('div', { class: 'ced-row2' },
      field('Название (русское)', textInput(st.name, 'например, Прислужник', v => st.name = v)),
      field('Название (английское, name_en)', textInput(st.name_en, 'например, Acolyte', v => st.name_en = v))));
    box.append(field('Редакция', select(st.edition, [{ value: '2014', label: '2014' }, { value: '2024', label: '2024' }], v => st.edition = v),
      'По редакции мастер создания выбирает правила предыстории.'));
    box.append(field('Описание', area(st.desc, 6, 'Что это за предыстория и откуда она у персонажа', v => st.desc = v)));
    return box;
  }

  function skillsSection(st, render) {
    const box = el('div', {});
    const skillOptions = () => skillsCatalog().map(s => ({ value: s.name, label: `${s.name} (${ABIL_SHORT[s.ability] || s.ability})` }));
    box.append(el('h4', { class: 'ced-sub' }, 'Владение навыками'));
    box.append(listEditor(st.skills.fixed, render, { options: skillOptions(), addLabel: '+ добавить навык…', placeholder: 'свой навык',
      drop: 'Перетащите навык из справочника сюда', empty: 'Предыстория не даёт владения навыками.', noteOf: value => ABIL_SHORT[skillAbil(value)] || '' }));
    box.append(el('h4', { class: 'ced-sub' }, 'Выбор игрока'));
    box.append(el('div', { class: 'ced-row' },
      el('label', { class: 'ced-inline' }, el('span', {}, 'Игрок выбирает'), numInput(st.skills.choose, v => { st.skills.choose = Math.max(0, v); render(); }, { max: 18 }),
        el('small', { class: 'muted' }, 'навыков из списка ниже')),
      el('span', { class: 'grow' }),
      el('span', { class: 'ced-counter' + (st.skills.from.length ? ' ok' : '') }, `${st.skills.from.length} в списке`)));
    box.append(listEditor(st.skills.from, render, { options: skillOptions(), addLabel: '+ добавить навык…', placeholder: 'свой навык',
      drop: 'Перетащите навык из справочника сюда', empty: 'Списка выбора нет.', noteOf: value => ABIL_SHORT[skillAbil(value)] || '' }));
    box.append(el('p', { class: 'muted small' },
      'Владение записывается узлом rule.skill_proficiency — тем же, что несёт запись навыка из справочника: перетаскивайте навыки прямо сюда.'));
    return box;
  }

  function proficienciesSection(st, render) {
    const box = el('div', {});
    box.append(el('p', { class: 'muted small' }, 'Инструменты записываются узлом rule.proficiencies с видом «Инструменты» — его читает мастер создания.'));
    box.append(listEditor(st.tools, render, { placeholder: 'например, Инструменты каллиграфа', empty: 'Инструментов нет.' }));
    return box;
  }

  function languagesSection(st, render) {
    const box = el('div', {});
    box.append(el('div', { class: 'ced-row2' },
      field('Языки', listEditor(st.languages, render, { placeholder: 'название языка', empty: 'Языков нет.' })),
      el('div', {},
        field('Языков на выбор', numInput(st.languagesCount, v => st.languagesCount = Math.max(0, v), { max: 10 }),
          'Сколько языков отмечает игрок: записывается числом, как в записях SRD.'),
        field('Примечание', textInput(st.languagesNote, 'например, любые два языка на выбор', v => st.languagesNote = v),
          'Свободный текст для листа.'))));
    return box;
  }

  function equipmentSection(st) {
    const box = el('div', {});
    box.append(field('Стартовое снаряжение', area(st.equipment, 6, 'Одежда обычная ×1, Поясной кошель ×1', v => st.equipment = v),
      'Тот же текст, что в карточке SRD: мастер создания разбирает его по правилам снаряжения.'));
    return box;
  }

  function featuresSection(st, render) {
    const box = el('div', {});
    box.append(el('h4', { class: 'ced-sub' }, 'Умение предыстории'));
    box.append(field('Название', textInput(st.feature.name, 'например, Приют верующих', v => st.feature.name = v)));
    box.append(field('Текст', area(st.feature.text, 5, 'Что даёт умение', v => st.feature.text = v),
      'Пишется узлом rule.feature и полем data.feature: лист покажет умение отдельной карточкой.'));
    box.append(el('h4', { class: 'ced-sub' }, 'Черта и характеристики 2024'));
    box.append(field('Черта (data.feat)', textInput(st.feat, 'например, Посвящённый в магию (Жрец)', v => st.feat = v),
      'Название записи справочника: мастер создания подставит черту как отдельный модуль.'));
    box.append(el('h4', { class: 'ced-sub' }, 'Характеристики на выбор (2024)'));
    box.append(listEditor(st.asiOptions, render, { options: Object.entries(ABIL_SHORT).map(([key, short]) => ({ value: short, label: `${ABIL[key] || key} (${short})` })),
      addLabel: '+ добавить характеристику…', placeholder: 'СИЛ', empty: 'Характеристики распределяются свободно.' }));
    return box;
  }

  function characterSection(st, render) {
    const box = el('div', {});
    const rows = [['personality_traits', 'Черты характера'], ['ideals', 'Идеалы'], ['bonds', 'Привязанности'], ['flaws', 'Слабости']];
    for (const [key, title] of rows) {
      box.append(el('h4', { class: 'ced-sub' }, title));
      box.append(listEditor(st.character[key], render, { placeholder: 'вариант из таблицы SRD', empty: 'Вариантов нет.' }));
    }
    box.append(el('p', { class: 'muted small' }, 'Эти списки — материал для отыгрыша: лист показывает их в карточке персонажа.'));
    return box;
  }

  /// Открыть редактор: возвращает { name, data } (сохранение делает справочник) или null.
  /// Тело редактора: разделы, навигация и состояние — общее для модалки и для
  /// отдельной страницы редактора. Возвращает { root, state, save, title }:
  /// save() отдаёт { name, data } или null с подсказкой.
  function form(entry, opts = {}) {
    const st = readState(entry);
    let section = 'common';
    const content = el('div', { class: 'ced-content' });
    const nav = el('div', { class: 'ced-nav' });
    const render = () => {
      const sec = SECTIONS.find(s => s.id === section) || SECTIONS[0];
      nav.replaceChildren(...SECTIONS.map(s => el('button', { type: 'button', class: 'ced-nav-btn' + (s.id === sec.id ? ' on' : ''),
        onclick: () => { section = s.id; render(); } }, s.title)));
      const body = sec.id === 'common' ? commonSection(st)
        : sec.id === 'skills' ? skillsSection(st, render)
          : sec.id === 'proficiencies' ? proficienciesSection(st, render)
            : sec.id === 'languages' ? languagesSection(st, render)
              : sec.id === 'equipment' ? equipmentSection(st)
                : sec.id === 'features' ? featuresSection(st, render)
                  : characterSection(st, render);
      content.replaceChildren(el('div', { class: 'ced-section' }, el('h3', {}, sec.title), el('p', { class: 'muted small' }, sec.hint), body));
    };
    render();
    const root = el('div', { class: 'class-editor' }, nav, content);
    const save = () => {
      const name = st.name.trim();
      if (!name) { toast('Нужно название предыстории'); return null; }
      return { name, data: writeData(st, entry) };
    };
    return { root, state: st, save, title: entry?.id ? 'Предыстория: ' + (entry.name || '') : 'Новая предыстория' };
  }

  /// Модалка редактора — для встраиваемых мест (свой стол, лист персонажа).
  function edit(entry, opts = {}) {
    const f = form(entry, opts);
    return modal(f.title, f.root, [{ label: 'Сохранить', cls: 'primary', fn: () => f.save() || false }], { wide: true });
  }

  return { edit, form, readState, writeData, emptyData, SECTIONS };
})();
