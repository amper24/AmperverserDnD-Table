// ---------------------------------------------------------------------------
// class-editor.js — отдельный редактор класса справочника.
//
// Открывается из справочника там же, где раньше создавался класс: «Создать свою
// запись» → категория «Классы» и кнопка «Редактировать» в карточке класса.
// Вместо одного поля с данными — разделы: Общее · Уровни · Навыки · Языки ·
// Стартовое снаряжение · Подклассы · Заклинания.
//
// Редактор пишет в те же поля записи, которые читают мастер создания персонажа
// и мастер повышения уровня, поэтому ничего не мигрирует:
//   data.skills { choose, from }        — выбор навыков класса;
//   data.features / data.feature_texts  — умения по уровням;
//   data.progression { columns, levels }— таблица развития 1–20 (pb, заговоры,
//                                         известные, подготовленные, ячейки);
//   data.starting_equipment             — текст снаряжения (читает парсер мастера);
//   data.equipment_blocks               — те же блоки структурой (для повторного
//                                         открытия в редакторе);
//   data.languages_fixed / _extra       — языки класса;
//   data.subclasses                     — подклассы с умениями по уровням;
//   data.caster                         — режим заклинаний (читает ClassRules).
//
// Даёт: window.ClassEditor { edit, readState, writeData, emptyData,
//   equipmentText, blocksFromText, skillKeyOfName, skillsCatalog, SECTIONS }.
// ---------------------------------------------------------------------------
window.ClassEditor = (() => {
  const KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const HIT_DICE = ['d6', 'd8', 'd10', 'd12'];
  const MAX_LEVEL = 20;
  const SLOT_COUNT = 9;
  const clone = x => JSON.parse(JSON.stringify(x));
  const M = () => window.Modules;
  const B = () => window.CharacterBuilder;
  // Бонус мастерства персонажа: одна и та же таблица для всех классов.
  const PB_BY_LEVEL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6];

  // ---------- Чистые помощники данных ----------
  const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const str = v => String(v === undefined || v === null ? '' : v);
  const norm = v => str(v).toLocaleLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,;:()[\]×*]/g, ' ').replace(/\s+/g, ' ').trim();

  /// Справочник навыков: из словаря листа (window.SKILLS) — им же пользуются лист и мастер.
  const skillsCatalog = () => (window.SKILLS || []).map(([key, name, ability]) => ({ key, name, ability }));
  /// Ключ навыка по названию (русскому или английскому) — как в мастере создания.
  function skillKeyOfName(value) {
    const want = norm(value);
    if (!want) return '';
    const catalog = skillsCatalog();
    return (catalog.find(s => norm(s.name) === want) || catalog.find(s => norm(s.key) === want)
      || catalog.find(s => norm(s.name_en || '') === want) || catalog.find(s => norm(s.key) === want.replace(/ /g, '_')) || {}).key || '';
  }
  /// Название навыка по ключу: из словаря или как есть (свой навык из справочника).
  const skillNameOfKey = key => (skillsCatalog().find(s => s.key === key) || {}).name || str(key);
  /// Навык из записи справочника (категория «Навыки»): ключ берётся из data.key, иначе по названию.
  const skillFromEntry = entry => (entry?.category === 'skill' ? (skillKeyOfName(entry.data?.key) || skillKeyOfName(entry.name)) : '');

  // ---------- Граф механик ----------
  // Правила класса живут и в узлах графа, и мастер создания читает их оттуда: базовые владения,
  // спасброски, кость хитов, заклинательная характеристика, выбор навыков, умения по уровням и
  // таблица развития. Редактор пишет узлы на месте (id и связи сохраняются) и только тогда, когда
  // значения действительно изменились, — тексты и таблицы SRD остаются теми же.
  const nodesOf = g => { if (!g) return []; if (!Array.isArray(g.nodes)) g.nodes = []; return g.nodes; };
  const linksOf = g => { if (!g) return []; if (!Array.isArray(g.links)) g.links = []; return g.links; };
  const ruleNodesOf = (d, type) => nodesOf(d?.mechanics?.graph).filter(n => n.type === type);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let seq = 0;
  const nodeId = prefix => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  function removeNode(graph, id) {
    const links = linksOf(graph);
    graph.nodes = nodesOf(graph).filter(n => n.id !== id);
    graph.links = links.filter(l => l.from?.node !== id && l.to?.node !== id);
  }
  function graphOf(d) {
    d.mechanics = d.mechanics && typeof d.mechanics === 'object' ? d.mechanics : { version: 2, origin: 'class-editor', graph: { nodes: [], links: [] } };
    d.mechanics.version = d.mechanics.version || 2;
    d.mechanics.graph = d.mechanics.graph && typeof d.mechanics.graph === 'object' ? d.mechanics.graph : { nodes: [], links: [] };
    nodesOf(d.mechanics.graph); linksOf(d.mechanics.graph);
    if (!Array.isArray(d.mechanics.graph.groups)) d.mechanics.graph.groups = [];
    return d.mechanics.graph;
  }
  const newNode = (graph, id, type, params) => ({ id, type, position: { x: 40, y: 40 + (nodesOf(graph).length % 12) * 60 }, params: clone(params) });
  /// Узлы одного типа под список значений: лишние удаляются, совпавшие обновляются (совпадение — match).
  /// item.same(node) — «в узле уже ровно это значение»: запись остаётся байт в байт как в наборе SRD.
  function syncNodes(graph, type, wanted, match) {
    const existing = nodesOf(graph).filter(n => n.type === type);
    const used = new Set();
    for (const item of wanted) {
      const found = existing.find(n => !used.has(n.id) && (!match || match(n, item)));
      if (found) { used.add(found.id); if (!(item.same && item.same(found))) found.params = { ...found.params, ...item.params }; continue; }
      const node = newNode(graph, nodeId(type.split('.').pop() || 'rule'), type, item.params);
      nodesOf(graph).push(node); used.add(node.id);
    }
    for (const node of existing) if (!used.has(node.id)) removeNode(graph, node.id);
  }
  /// Табличный узел: переписывается только когда содержимое уровней действительно изменилось.
  /// Узел ищется по типу: id у записей SRD свой (например, class_features), плодить второй нельзя.
  function syncTableNode(graph, type, levels) {
    const node = nodesOf(graph).find(n => n.type === type);
    const wanted = levels && Object.keys(levels).length ? clone(levels) : null;
    if (!node) { if (wanted) nodesOf(graph).push(newNode(graph, nodeId(type.split('.').pop() || 'rule'), type, { table: { levels: wanted } })); return; }
    const current = node.params?.table && typeof node.params.table === 'object' ? node.params.table : {};
    const was = current.levels && typeof current.levels === 'object' ? current.levels : {};
    const equal = !wanted ? !Object.keys(was).length
      : Object.keys(wanted).length === Object.keys(was).length && Object.entries(wanted).every(([level, list]) => same(list, was[level]));
    if (!equal) node.params = { ...node.params, table: { ...clone(current), levels: wanted || {} } };
  }

  /// Таблица развития: данные записи в приоритете, затем узел rule.class_progression (порядок чтения
  /// тот же, что у мастера повышения уровня).
  function levelsOf(d) {
    const rows = d?.progression?.levels || ruleNodesOf(d, 'rule.class_progression')[0]?.params?.table?.levels || {};
    const out = {};
    for (let lv = 1; lv <= MAX_LEVEL; lv++) out[String(lv)] = levelRow(lv, rows[String(lv)] || rows[lv]);
    return out;
  }
  /// Умения уровней: таблица узла rule.class_features, иначе сырые поля записи.
  function readFeaturesOf(d) {
    const table = ruleNodesOf(d, 'rule.class_features')[0]?.params?.table;
    const levels = table?.levels;
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) return readFeatures(d);
    const texts = d.feature_texts || {};
    const out = {};
    for (const [level, items] of Object.entries(levels)) {
      const list = (Array.isArray(items) ? items : [])
        .map(x => (typeof x === 'string' ? { name: str(x), text: '' } : { name: str(x?.name), text: str(x?.text) }))
        .filter(x => x.name);
      for (const item of list) if (!item.text) item.text = str(texts[item.name]);
      if (list.length) out[level] = list;
    }
    return out;
  }
  /// Умения для узла: { уровень: [{ name, text }] }.
  function featureLevels(features) {
    const levels = {};
    for (const [level, items] of Object.entries(features || {})) {
      const list = (items || []).map(f => ({ name: str(f.name).trim(), text: str(f.text) })).filter(f => f.name);
      if (list.length) levels[String(level)] = list;
    }
    return levels;
  }
  /// Блок заклинателя: значения редактора поверх прежних (ключи вроде picker сохраняются).
  function casterBlock(st, base) {
    const out = { ...(base && typeof base === 'object' ? clone(base) : {}) };
    const book = num(st.caster.book_start) || num(st.caster.book_per_level)
      ? { start: num(st.caster.book_start), per_level: num(st.caster.book_per_level) } : null;
    // Число стартовых подготовленных заклинаний пишется числом (как в наборах SRD), иначе текстом.
    const startPrepared = str(st.caster.start_prepared).trim();
    const managed = { level: str(st.caster.level), start: str(st.caster.start), prepared: str(st.caster.prepared),
      start_prepared: /^\d+$/.test(startPrepared) ? Number(startPrepared) : startPrepared, book };
    for (const [key, value] of Object.entries(managed)) { if (value === '' || value === null) delete out[key]; else out[key] = value; }
    return out;
  }

  /// Строка уровня для узла: поля редактора плюс чужие ключи строки. Пустые ячейки и pact-поля не
  /// пишутся вовсе — так же хранит таблицы набор SRD («slots» есть только там, где они нужны).
  function rowForNode(row, base) {
    const out = { ...(base || {}) };
    out.pb = row.pb;
    out.cantrips = row.cantrips;
    if (row.known !== null) out.known = row.known; else delete out.known;
    if (row.prepared !== null) out.prepared = row.prepared; else delete out.prepared;
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => num(row.slots?.[i], 0));
    if (slots.some(n => n) || Array.isArray(base?.slots)) out.slots = slots; else delete out.slots;
    if (row.pact_slots) { out.pact_slots = row.pact_slots; out.pact_level = row.pact_level || 1; }
    else if (!base || base.pact_slots === undefined) { delete out.pact_slots; delete out.pact_level; }
    return out;
  }

  /// Пустая запись класса.
  function emptyData(edition = '2014') {
    return { name_en: '', edition, hit_die: 'd8', saves: [], spellcasting: '', primary: '', armor: '', weapons: '', tools: '', desc: '',
      skills: { choose: 2, from: [] }, starting_equipment: '', features: {}, feature_texts: {}, subclasses: [] };
  }

  /// Строка таблицы развития: пустая или из данных.
  function levelRow(level, row) {
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => num(row?.slots?.[i], 0));
    const out = { pb: row && row.pb !== undefined ? num(row.pb) : (PB_BY_LEVEL[level - 1] || 2),
      cantrips: row && row.cantrips !== undefined ? num(row.cantrips) : 0,
      known: row && row.known !== undefined && row.known !== null ? num(row.known) : null,
      prepared: row && row.prepared !== undefined && row.prepared !== null ? num(row.prepared) : null,
      slots,
      pact_slots: row && row.pact_slots !== undefined ? num(row.pact_slots) : 0,
      pact_level: row && row.pact_level !== undefined ? num(row.pact_level) : 0 };
    // Свои колонки класса («x:ki_points», «x:martial_arts» и подобные) не теряем.
    if (row) for (const [k, v] of Object.entries(row)) if (!(k in out) && str(k).startsWith('x:')) out[k] = v;
    return out;
  }

  /// Умения: { уровень: [{ name, text }] } — из data.features + data.feature_texts.
  function readFeatures(d) {
    const texts = d.feature_texts || {};
    const out = {};
    for (const [level, names] of Object.entries(d.features || {})) {
      const list = (Array.isArray(names) ? names : []).map(n => (typeof n === 'string' ? { name: n, text: '' } : { name: str(n?.name), text: str(n?.text) }));
      for (const item of list) if (!item.text) item.text = str(texts[item.name]);
      if (list.length) out[level] = list;
    }
    return out;
  }
  /// Умения подкласса: то же, что у класса, но внутри записи подкласса.
  const readSubFeatures = sub => readFeatures(sub || {});
  function subFeatureList(sub) {
    const out = [];
    for (const [level, items] of Object.entries(readSubFeatures(sub))) for (const item of items) out.push({ level: num(level), name: item.name, text: item.text });
    return out.sort((a, b) => a.level - b.level);
  }

  /// Блоки снаряжения из данных: структура (equipment_blocks) или разбор текста.
  function readEquipment(d) {
    if (Array.isArray(d.equipment_blocks) && d.equipment_blocks.length) return clone(d.equipment_blocks);
    return blocksFromText(d.starting_equipment);
  }
  /// Текст снаряжения → блоки (обратный ход парсера мастера: «- (a) X или (b) Y»).
  function blocksFromText(text) {
    const blocks = [];
    for (const raw of str(text).split(/\n+/)) {
      const line = raw.trim();
      if (!line) continue;
      const markers = [...line.matchAll(/\(([a-eа-еA-EА-Е])\)/g)];
      if (markers.length >= 2) {
        const options = markers.map((marker, index) => {
          const from = marker.index + marker[0].length;
          const to = index + 1 < markers.length ? markers[index + 1].index : line.length;
          const body = line.slice(from, to).replace(/[,;]?\s*(?:или|or)\s*$/i, '').replace(/[,;]\s*$/, '').trim();
          return { rows: rowsFromList(body) };
        }).filter(o => o.rows.length);
        if (options.length >= 2) {
          const lead = line.slice(0, markers[0].index).replace(/^[\s\-–—•*]+/, '').replace(/[:：]\s*$/, '').trim();
          blocks.push({ kind: 'group', label: lead && !/^выберите$/i.test(lead) ? lead : '', options });
          continue;
        }
      }
      const rows = rowsFromList(line);
      if (rows.length) blocks.push({ kind: 'fixed', rows });
    }
    return blocks;
  }
  /// Строки из «Название ×2, 15 зм».
  function rowsFromList(text) {
    return str(text).split(/,\s*/).map(part => rowFromText(part)).filter(Boolean);
  }
  function rowFromText(text) {
    const t = str(text).replace(/^[\s\-–—•*]+/, '').trim();
    if (!t || /^(?:или|or)$/i.test(t)) return null;
    const gold = t.match(/^(\d{1,5})\s*(?:зм|золот[а-яё]*)/i);
    if (gold) return { kind: 'gold', amount: num(gold[1]) };
    const pick = pickFilterOfText(t);
    if (pick) return { kind: 'pick', filter: pick };
    const trailing = t.match(/^(.*?)\s*[×x]\s*(\d{1,4})$/i);
    if (trailing) return { kind: 'item', name: trailing[1].trim(), qty: num(trailing[2], 1) };
    const counted = t.match(/^(.*?)\s*\((\d{1,4})\)$/);
    if (counted) return { kind: 'item', name: counted[1].trim(), qty: num(counted[2], 1) };
    return { kind: 'item', name: t, qty: 1 };
  }
  /// Фильтр «по выбору» по тексту: те же правила, что у парсера мастера.
  function pickFilterOfText(text) {
    const rules = (window.Presets?.items('equipment_pick_rules') || []).map(i => i.table).filter(t => t?.role === 'pattern');
    const hit = rules.find(t => new RegExp(str(t.pattern), str(t.flags)).test(text));
    return hit ? str(hit.filter) : '';
  }
  /// Список фильтров выбора для редактора: id + подпись.
  function pickFilters() {
    return (window.Presets?.items('equipment_pick_rules') || []).filter(i => i.table?.role === 'filter')
      .map(i => ({ id: i.id, label: str(i.table.label) }));
  }
  const rowText = row => row.kind === 'gold' ? `${num(row.amount)} зм`
    : row.kind === 'pick' ? `любое ${(pickFilters().find(f => f.id === row.filter) || {}).label || row.filter}`
      : `${str(row.name)}${num(row.qty, 1) > 1 ? ` ×${num(row.qty, 1)}` : ''}`;
  const rowsText = rows => (rows || []).map(rowText).filter(Boolean).join(', ');
  const MARKERS = ['a', 'b', 'c', 'd', 'e'];
  /// Блоки снаряжения → текст в формате, который понимает парсер мастера создания.
  function equipmentText(blocks) {
    const lines = [];
    for (const block of blocks || []) {
      if (block.kind === 'group') {
        const options = (block.options || []).map(o => rowsText(o.rows)).filter(Boolean);
        if (options.length < 2) { if (options[0]) lines.push(options[0]); continue; }
        const body = options.map((text, i) => `(${MARKERS[i] || i + 1}) ${text}`).join(' или ');
        // Подпись варианта стоит перед двоеточием: парсер мастера читает её как lead.
        lines.push(`${str(block.label) ? str(block.label) + ': ' : '- '}${body}`);
      } else {
        const text = rowsText(block.rows);
        if (text) lines.push(text);
      }
    }
    return lines.join('\n');
  }

  /// Данные записи → состояние редактора. Правила берутся из узлов графа, если они есть: мастер
  /// создания читает именно их, поэтому редактор показывает то же, что попадёт на лист.
  function readState(entry) {
    const d = entry?.data || {};
    // Все 20 уровней всегда в состоянии: править можно любой, а пишется таблица только если её трогали.
    const levels = levelsOf(d);
    const ruleValue = type => { const node = ruleNodesOf(d, type)[0]; if (!node) return null;
      const value = node.params?.value; return Array.isArray(value) ? value.map(str) : str(value); };
    const profText = kind => { const node = ruleNodesOf(d, 'rule.proficiencies').find(n => str(n.params?.kind) === kind);
      if (!node) return ''; const value = node.params?.value; return Array.isArray(value) ? value.map(str).join(', ') : str(value); };
    const skillNode = ruleNodesOf(d, 'rule.skills')[0];
    const hitDie = ruleValue('rule.hit_die');
    const saves = ruleValue('rule.saving_throws');
    const casting = ruleValue('rule.spellcasting');
    const languages = ruleValue('rule.languages');
    const casterTable = ruleNodesOf(d, 'rule.class_rules')[0]?.params?.table?.caster;
    const caster = (d.caster && typeof d.caster === 'object' ? d.caster : (casterTable && typeof casterTable === 'object' ? casterTable : {}));
    return {
      name: str(entry?.name),
      name_en: str(d.name_en),
      edition: str(d.edition) || '2014',
      hit_die: str(hitDie || d.hit_die) || 'd8',
      saves: (Array.isArray(saves) ? saves : (d.saves || [])).filter(k => KEYS.includes(k)),
      spellcasting: str(casting || d.spellcasting),
      primary: str(d.primary),
      armor: profText('Доспехи') || str(d.armor),
      weapons: profText('Оружие') || str(d.weapons),
      tools: profText('Инструменты') || str(d.tools),
      desc: str(d.desc),
      skills: skillNode ? { choose: num(skillNode.params?.count), from: Array.isArray(skillNode.params?.options) ? skillNode.params.options.map(str) : [] }
        : { choose: num(d.skills?.choose), from: Array.isArray(d.skills?.from) ? d.skills.from.map(str) : [] },
      languages: { fixed: (Array.isArray(languages) && languages.length ? languages : (Array.isArray(d.languages_fixed) ? d.languages_fixed.map(str) : [])), extra: num(d.languages_extra) },
      equipment: readEquipment(d),
      features: readFeaturesOf(d),
      levels,
      subclasses: (Array.isArray(d.subclasses) ? d.subclasses : []).map(s => ({
        name: str(s?.name), name_en: str(s?.name_en), flavor: str(s?.flavor), desc: str(s?.desc),
        features: subFeatureList(s),
      })),
      caster: {
        level: str(caster.level), start: str(caster.start), prepared: str(caster.prepared),
        book_start: num(caster.book?.start), book_per_level: num(caster.book?.per_level),
        start_prepared: str(caster.start_prepared),
      },
    };
  }

  /// Состояние редактора → данные записи (неизвестные поля прежней записи сохраняются).
  function writeData(st, entry) {
    const d = { ...(entry?.data || {}) };
    d.name_en = st.name_en.trim();
    d.edition = st.edition;
    d.hit_die = st.hit_die;
    d.saves = [...st.saves];
    d.primary = st.primary;
    d.armor = st.armor; d.weapons = st.weapons; d.tools = st.tools;
    d.desc = st.desc;
    if (st.spellcasting) d.spellcasting = st.spellcasting; else delete d.spellcasting;

    d.skills = { choose: num(st.skills.choose), from: st.skills.from.map(s => str(s).trim()).filter(Boolean) };

    const blocks = (st.equipment || []).filter(b => b.kind === 'group'
      ? (b.options || []).some(o => (o.rows || []).length) : (b.rows || []).length);
    d.starting_equipment = equipmentText(blocks);
    if (blocks.length) d.equipment_blocks = clone(blocks); else delete d.equipment_blocks;

    if (st.languages.fixed.length) d.languages_fixed = st.languages.fixed.map(s => str(s).trim()).filter(Boolean); else delete d.languages_fixed;
    if (num(st.languages.extra) > 0) d.languages_extra = num(st.languages.extra); else delete d.languages_extra;

    // Умения: { уровень: [названия] } + тексты по названию.
    const features = {}, texts = {};
    for (const [level, items] of Object.entries(st.features)) {
      const list = (items || []).map(f => str(f.name).trim()).filter(Boolean);
      if (!list.length) continue;
      features[String(level)] = list;
      for (const f of items) if (str(f.text).trim()) texts[str(f.name).trim()] = str(f.text);
    }
    d.features = features; d.feature_texts = texts;

    d.subclasses = st.subclasses.filter(s => str(s.name).trim()).map(s => {
      const features2 = {}, texts2 = {};
      for (const f of s.features || []) {
        const name = str(f.name).trim(); if (!name) continue;
        const lv = String(Math.min(MAX_LEVEL, Math.max(1, num(f.level, 1))));
        (features2[lv] ||= []).push(name);
        if (str(f.text).trim()) texts2[name] = str(f.text);
      }
      const out = { name: str(s.name).trim() };
      if (str(s.name_en).trim()) out.name_en = str(s.name_en).trim();
      if (str(s.flavor).trim()) out.flavor = str(s.flavor).trim();
      if (str(s.desc).trim()) out.desc = str(s.desc).trim();
      out.features = features2; out.feature_texts = texts2;
      return out;
    });

    // Правила заклинателя: прежний блок читается первым (в нём бывают ключи вроде picker), поэтому
    // редактор обновляет только свои поля и не теряет чужие.
    const caster = casterBlock(st, entry?.data?.caster);
    if (Object.keys(caster).length) d.caster = caster; else delete d.caster;

    // Правила — и в узлах графа: мастер создания читает их оттуда. Значения, которые не меняли,
    // не переписываются, поэтому тексты и таблицы SRD остаются прежними.
    const graph = graphOf(d);
    syncNodes(graph, 'rule.hit_die', [{ params: { value: str(st.hit_die) || 'd8' } }]);
    syncNodes(graph, 'rule.saving_throws', [{ params: { value: d.saves.filter(k => KEYS.includes(k)) } }]);
    syncNodes(graph, 'rule.spellcasting', str(d.spellcasting).trim() ? [{ params: { ability: str(d.spellcasting) } }] : []);
    // «—» в поле владений значит «нет владений»: узел для такого вида не создаётся (как в наборе SRD).
    syncNodes(graph, 'rule.proficiencies', [['Доспехи', d.armor], ['Оружие', d.weapons], ['Инструменты', d.tools]]
      .map(([kind, text]) => ({ kind, text: str(text).trim() })).filter(item => item.text.replace(/[\s—–-]+/g, ''))
      .map(item => ({ params: { kind: item.kind, value: item.text.split(',').map(x => x.trim()).filter(Boolean) },
        same: node => str(Array.isArray(node.params?.value) ? node.params.value.join(', ') : node.params?.value).trim() === item.text })),
    (node, item) => str(node.params?.kind) === item.params.kind);
    const skillNames = d.skills.from.map(str).filter(Boolean);
    const choose = Math.max(0, num(d.skills.choose));
    // Пустой список — «любой навык»: узел остаётся, иначе сохранение записи потеряло бы выбор класса.
    syncNodes(graph, 'rule.skills', choose > 0
      ? [{ params: { id: 'classSkills', count: skillNames.length ? Math.min(choose, skillNames.length) : choose, options: skillNames, title: 'Навыки класса' } }] : []);
    const fixedLanguages = Array.isArray(d.languages_fixed) ? d.languages_fixed : [];
    syncNodes(graph, 'rule.languages', fixedLanguages.length ? [{ params: { value: fixedLanguages } }] : []);
    syncTableNode(graph, 'rule.class_features', featureLevels(st.features));
    // Таблица развития — в узле графа, единым источником. Пишутся только правленые уровни: строки
    // SRD (со своими колонками вроде «Ярости») остаются как были. Таблица старого формата
    // (data.progression) переносится в узел и удаляется: мастер повышения уровня читает её первой.
    const was = levelsOf(entry?.data);
    if (!same(st.levels, was)) {
      const baseNode = ruleNodesOf(entry?.data, 'rule.class_progression')[0];
      const nodeTable = baseNode?.params?.table && typeof baseNode.params.table === 'object' ? clone(baseNode.params.table) : {};
      const legacy = entry?.data?.progression && typeof entry.data.progression === 'object' ? entry.data.progression : {};
      const rows = clone(nodeTable.levels && typeof nodeTable.levels === 'object' ? nodeTable.levels : {});
      if (legacy.levels && typeof legacy.levels === 'object') for (const [key, row] of Object.entries(legacy.levels)) rows[key] = clone(row);
      const columns = Array.isArray(nodeTable.columns) && nodeTable.columns.length ? clone(nodeTable.columns) : clone(legacy.columns || []);
      for (let lv = 1; lv <= MAX_LEVEL; lv++) {
        const key = String(lv);
        const row = levelRow(lv, st.levels[key]);
        // Уровень не правили и строка узла на месте — остаётся как была; иначе пишем строку
        // (и достраиваем уровни, которых в таблице записи не было).
        if (rows[key] && same(row, was[key])) continue;
        rows[key] = rowForNode(row, rows[key]);
      }
      const table = { ...nodeTable, columns, levels: rows };
      if (!columns.length) delete table.columns;
      const node = baseNode || nodesOf(graph).find(n => n.type === 'rule.class_progression');
      if (node) node.params = { ...node.params, table };
      else nodesOf(graph).push(newNode(graph, 'class_progression', 'rule.class_progression', { table }));
      delete d.progression; // старая таблица перенесена в узел
    }
    // Правила заклинателя — в таблицу узла rule.class_rules (блок caster; мультикласс не трогаем):
    // поле data.caster читается первым, но копия в графе держит запись цельной.
    const rulesNode = nodesOf(graph).find(n => n.type === 'rule.class_rules');
    if (rulesNode) {
      const table = rulesNode.params?.table && typeof rulesNode.params.table === 'object' ? rulesNode.params.table : {};
      const oldCaster = table.caster && typeof table.caster === 'object' ? table.caster : null;
      const nodeCaster = casterBlock(st, oldCaster || entry?.data?.caster);
      const next = { ...clone(table) };
      if (Object.keys(nodeCaster).length) next.caster = nodeCaster; else delete next.caster;
      if (!same(next, table)) rulesNode.params = { ...rulesNode.params, table: next };
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
  const chip = (text, onRemove, extra = {}) => el('span', { class: 'ced-chip' + (extra.class ? ' ' + extra.class : ''), title: extra.title || null },
    el('b', {}, text), extra.note ? el('small', {}, extra.note) : null,
    onRemove ? el('button', { type: 'button', class: 'ced-chip-x', title: 'Убрать', onclick: onRemove }, '×') : null);

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

  // ---------- Разделы ----------
  const SECTIONS = [
    { id: 'common', title: 'Общее', hint: 'Название, кость хитов, спасброски, владения' },
    { id: 'levels', title: 'Уровни 1–20', hint: 'Таблица развития и умения по уровням' },
    { id: 'skills', title: 'Навыки', hint: 'Сколько выбирает игрок и из каких' },
    { id: 'languages', title: 'Языки', hint: 'Фиксированные и по выбору' },
    { id: 'equipment', title: 'Снаряжение', hint: 'Что выдаётся на 1 уровне' },
    { id: 'subclasses', title: 'Подклассы', hint: 'Пути и их умения по уровням' },
    { id: 'caster', title: 'Заклинания', hint: 'Режим подготовки и ячейки' },
  ];

  function commonSection(st) {
    const box = el('div', { class: 'ced-grid' });
    box.append(
      field('Название', textInput(st.name, 'Волшебник', v => st.name = v)),
      field('Английское название (ключ)', textInput(st.name_en, 'Wizard', v => st.name_en = v), 'По нему класс связывается с наборами правил'),
      field('Редакция', select(st.edition, [{ value: '2014', label: 'D&D 5e (2014)' }, { value: '2024', label: 'D&D 5e (2024)' }], v => st.edition = v)),
      field('Кость хитов', select(st.hit_die, HIT_DICE.map(d => ({ value: d, label: d })), v => st.hit_die = v)),
      field('Заклинательная характеристика', select(st.spellcasting, [{ value: '', label: 'нет' }, ...KEYS.map(k => ({ value: k, label: ABIL[k] }))], v => st.spellcasting = v)),
      field('Главная характеристика', select(st.primary, [{ value: '', label: '—' }, ...KEYS.map(k => ({ value: k, label: ABIL[k] }))], v => st.primary = v)),
    );
    const saves = el('div', { class: 'ced-saves' }, ...KEYS.map(k => el('label', { class: 'ced-check' },
      el('input', { type: 'checkbox', checked: st.saves.includes(k) ? '' : null, onchange: e => {
        st.saves = st.saves.filter(x => x !== k); if (e.target.checked) st.saves.push(k); st.saves = KEYS.filter(x => st.saves.includes(x));
      } }), ABIL[k])));
    box.append(el('div', { class: 'ced-field wide' }, el('span', {}, 'Спасброски'), saves));
    box.append(
      field('Доспехи', textInput(st.armor, 'Лёгкие', v => st.armor = v)),
      field('Оружие', textInput(st.weapons, 'Кинжалы, дротики…', v => st.weapons = v)),
      field('Инструменты', textInput(st.tools, '—', v => st.tools = v)),
    );
    box.append(el('label', { class: 'ced-field wide' }, el('span', {}, 'Описание'),
      el('textarea', { rows: 4, oninput: e => st.desc = e.target.value }, st.desc)));
    return box;
  }

  function skillsSection(st, render) {
    const box = el('div', {});
    box.append(el('div', { class: 'ced-row' },
      el('label', { class: 'ced-inline' }, el('span', {}, 'Игрок выбирает'), numInput(st.skills.choose, v => { st.skills.choose = Math.max(0, v); render(); }, { max: 18 }),
        el('small', { class: 'muted' }, 'навыков из списка ниже')),
      el('span', { class: 'grow' }),
      el('span', { class: 'ced-counter' + (st.skills.from.length ? ' ok' : '') }, st.skills.from.length ? `${st.skills.from.length} в списке` : 'пусто — любой навык')));
    const list = el('div', { class: 'ced-chips' });
    const drawList = () => {
      list.replaceChildren(...st.skills.from.map((name, i) => chip(str(name), () => { st.skills.from.splice(i, 1); render(); },
        { note: (skillsCatalog().find(s => s.name === name || s.key === name) || {}).ability ? ABIL_SHORT[(skillsCatalog().find(s => s.name === name || s.key === name) || {}).ability] || '' : '' })));
      if (!st.skills.from.length) list.append(el('span', { class: 'muted small' }, 'Пустой список — игрок выбирает любой навык, целиком из справочника «Навыки». Добавьте навыки кнопкой или перетащите их сюда.'));
    };
    drawList();
    box.append(list);
    const free = skillsCatalog().filter(s => !st.skills.from.some(n => skillKeyOfName(n) === s.key));
    const sel = select('', [{ value: '', label: '+ добавить навык…' }, ...free.map(s => ({ value: s.key, label: `${s.name} (${ABIL[s.ability]})` }))],
      v => { if (!v) return; st.skills.from.push(skillNameOfKey(v)); render(); });
    const addSkill = key => { if (key && !st.skills.from.some(n => skillKeyOfName(n) === key)) { st.skills.from.push(skillNameOfKey(key)); render(); } };
    box.append(el('div', { class: 'ced-row' }, sel,
      dropZone('Перетащите навык из справочника сюда', ['application/x-skill', 'application/x-compendium'], payload => {
        const entry = payload.entry || payload;
        addSkill(payload.key || skillFromEntry(entry));
      })));
    box.append(el('p', { class: 'muted small' }, 'Навыки — обычные записи справочника (категория «Навыки»): их можно перетаскивать в класс, как предметы в снаряжение. Выбор хранится правилом rule.skills (id «classSkills»), поэтому мастер создания и лист читают его наравне с остальными механиками.'));
    return box;
  }

  function languagesSection(st, render) {
    const box = el('div', {});
    box.append(el('div', { class: 'ced-row' },
      el('label', { class: 'ced-inline' }, el('span', {}, 'Дополнительных языков по выбору'),
        numInput(st.languages.extra, v => { st.languages.extra = Math.max(0, v); render(); }, { max: 9 })),
      el('span', { class: 'grow' }),
      el('span', { class: 'ced-counter' }, `${st.languages.fixed.length} фиксированных`)));
    const list = el('div', { class: 'ced-chips' });
    const known = (B()?.LANGUAGES || []).slice();
    const draw = () => {
      list.replaceChildren(...st.languages.fixed.map((name, i) => chip(str(name), () => { st.languages.fixed.splice(i, 1); render(); })));
      if (!st.languages.fixed.length) list.append(el('span', { class: 'muted small' }, 'Класс не даёт языков автоматически.'));
    };
    draw();
    box.append(list);
    const custom = el('input', { placeholder: 'свой язык' });
    box.append(el('div', { class: 'ced-row' },
      select('', [{ value: '', label: '+ добавить язык…' }, ...known.map(l => ({ value: l, label: l }))],
        v => { if (v && !st.languages.fixed.includes(v)) { st.languages.fixed.push(v); render(); } }),
      custom,
      el('button', { type: 'button', class: 'small', onclick: () => { const v = custom.value.trim(); if (v && !st.languages.fixed.includes(v)) { st.languages.fixed.push(v); render(); } } }, 'Добавить')));
    box.append(el('p', { class: 'muted small' }, 'Фиксированные языки попадают во владения персонажа сразу, «по выбору» — добавляют выбор на шаге «Навыки» мастера создания.'));
    return box;
  }

  // ---------- Стартовое снаряжение ----------
  function equipmentSection(st, render) {
    const box = el('div', {});
    const blocks = st.equipment || (st.equipment = []);
    const redraw = () => render();

    const rowEditor = (row, rows, removeRow) => el('div', { class: 'ced-eq-row' },
      select(row.kind, [{ value: 'item', label: 'предмет' }, { value: 'gold', label: 'золото' }, { value: 'pick', label: 'по выбору' }],
        v => { row.kind = v; if (v === 'gold' && row.amount === undefined) row.amount = 10; if (v === 'item' && !row.name) row.name = ''; if (v === 'pick' && !row.filter) row.filter = (pickFilters()[0] || {}).id || ''; redraw(); }),
      row.kind === 'item' ? el('input', { class: 'grow', value: str(row.name), placeholder: 'название предмета',
        oninput: e => row.name = e.target.value,
        ondragover: ev => { if (M().hasType(ev, 'application/x-item', 'application/x-compendium')) { ev.preventDefault(); ev.stopPropagation(); } },
        ondrop: ev => {
          const payload = M().getDrag(ev, 'application/x-item') || M().getDrag(ev, 'application/x-compendium');
          const entry = payload?.item ? payload.item : payload;
          if (!entry || (entry.category && entry.category !== 'item')) return;
          ev.preventDefault(); ev.stopPropagation();
          row.name = str(entry.name || payload?.item?.name || ''); redraw();
        } }) : null,
      row.kind === 'item' ? numInput(row.qty || 1, v => row.qty = Math.max(1, v), { min: 1, max: 99 }) : null,
      row.kind === 'gold' ? el('span', { class: 'ced-inline' }, numInput(row.amount || 0, v => row.amount = Math.max(0, v), { max: 9999 }), el('small', { class: 'muted' }, 'зм')) : null,
      row.kind === 'pick' ? select(row.filter, pickFilters().map(f => ({ value: f.id, label: f.label })), v => row.filter = v) : null,
      el('button', { type: 'button', class: 'small ghost', title: 'Убрать строку', onclick: () => removeRow() }, '×'));

    const rowsEditor = rows => el('div', { class: 'ced-eq-rows' },
      ...rows.map(row => rowEditor(row, rows, () => { rows.splice(rows.indexOf(row), 1); redraw(); })),
      el('button', { type: 'button', class: 'small', onclick: () => { rows.push({ kind: 'item', name: '', qty: 1 }); redraw(); } }, '+ строка'));

    blocks.forEach((block, index) => {
      const card = el('section', { class: 'ced-block' });
      const head = el('div', { class: 'ced-block-head' });
      head.append(el('span', { class: 'badge' }, block.kind === 'group' ? 'выбор варианта' : 'выдаётся всегда'));
      if (block.kind === 'group') head.append(el('input', { class: 'grow', value: str(block.label), placeholder: 'Выберите вариант (необязательно)', oninput: e => block.label = e.target.value }));
      else head.append(el('span', { class: 'grow muted small' }, 'Предметы, которые класс получает сразу.'));
      head.append(el('button', { type: 'button', class: 'small ghost', onclick: () => { blocks.splice(index, 1); redraw(); } }, '×'));
      card.append(head);
      if (block.kind === 'group') {
        card.append(...(block.options || []).map((option, oi) => el('div', { class: 'ced-eq-option' },
          el('div', { class: 'ced-eq-option-head' }, el('b', {}, `Вариант ${MARKERS[oi] || oi + 1}`),
            (block.options.length > 2 ? el('button', { type: 'button', class: 'small ghost', onclick: () => { block.options.splice(oi, 1); redraw(); } }, '×') : null)),
          rowsEditor(option.rows))));
        card.append(el('button', { type: 'button', class: 'small', onclick: () => { (block.options ||= []).push({ rows: [{ kind: 'item', name: '', qty: 1 }] }); redraw(); } }, '+ вариант'));
      } else card.append(rowsEditor(block.rows || (block.rows = [])));
      box.append(card);
    });

    box.append(el('div', { class: 'ced-row' },
      el('button', { type: 'button', class: 'small', onclick: () => { blocks.push({ kind: 'fixed', rows: [{ kind: 'item', name: '', qty: 1 }] }); redraw(); } }, '+ блок «выдаётся всегда»'),
      el('button', { type: 'button', class: 'small', onclick: () => { blocks.push({ kind: 'group', label: '', options: [{ rows: [{ kind: 'item', name: '', qty: 1 }] }, { rows: [{ kind: 'item', name: '', qty: 1 }] }] }); redraw(); } }, '+ блок «выбор варианта»'),
      dropZone('Перетащите предмет из справочника, чтобы добавить блок', ['application/x-item', 'application/x-compendium'], payload => {
        const entry = payload?.item ? payload.item : payload;
        if (entry?.category && entry.category !== 'item') return;
        blocks.push({ kind: 'fixed', rows: [{ kind: 'item', name: str(entry.name || payload?.item?.name || ''), qty: 1 }] }); redraw();
      })));
    const text = equipmentText(blocks);
    box.append(el('details', { class: 'ced-preview' }, el('summary', {}, 'Так это увидит мастер создания'),
      el('pre', { class: 'ced-text' }, text || '— пусто —')));
    return box;
  }

  // ---------- Уровни ----------
  const STANDARD_FEATURES = [
    { name: 'Увеличение характеристик', text: 'Вы можете увеличить одну характеристику на 2 или две на 1 (не выше 20) либо взять черту.' },
    { name: 'Эпическое благо', text: 'Выберите одно эпическое благо: увеличение характеристики до 30 или дар судьбы.' },
    { name: 'Компетентность', text: 'Выберите два владения навыками: бонус мастерства в них удваивается.' },
  ];

  function levelsSection(st) {
    let open = null; // раскрытый уровень
    const box = el('div', {});
    const table = el('div', { class: 'ced-levels' });
    const draw = () => {
      table.replaceChildren();
      const head = el('div', { class: 'ced-levels-head' }, el('span', {}, 'Ур'), el('span', {}, 'БМ'), el('span', {}, 'Загов.'),
        el('span', {}, 'Изв.'), el('span', {}, 'Подг.'),
        ...Array.from({ length: SLOT_COUNT }, (_, i) => el('span', { title: `Ячейки ${i + 1} круга` }, String(i + 1))),
        el('span', { class: 'wide' }, 'Умения'));
      table.append(head);
      for (let lv = 1; lv <= MAX_LEVEL; lv++) {
        const key = String(lv);
        const row = st.levels[key] || (st.levels[key] = levelRow(lv));
        const feats = st.features[key] || [];
        const rowEl = el('div', { class: 'ced-levels-row' + (open === key ? ' open' : '') },
          el('span', { class: 'ced-levels-lv' }, String(lv)),
          el('span', {}, numInput(row.pb, v => row.pb = v, { min: 0, max: 9 })),
          el('span', {}, numInput(row.cantrips, v => row.cantrips = v, { max: 9 })),
          el('span', {}, el('input', { type: 'number', class: 'ced-num', value: row.known === null ? '' : String(row.known), placeholder: '—',
            oninput: e => { const t = e.target.value.trim(); row.known = t === '' ? null : num(t); } })),
          el('span', {}, el('input', { type: 'number', class: 'ced-num', value: row.prepared === null ? '' : String(row.prepared), placeholder: '—',
            oninput: e => { const t = e.target.value.trim(); row.prepared = t === '' ? null : num(t); } })),
          ...row.slots.map((n, i) => el('span', {}, numInput(n, v => { row.slots[i] = Math.max(0, v); }, { max: 9 }))),
          el('button', { type: 'button', class: 'ced-feat-btn' + (feats.length ? ' on' : ''), onclick: () => { open = open === key ? null : key; draw(); } },
            feats.length ? `${feats.length} ${plural(feats.length, 'умение', 'умения', 'умений')}` : 'нет умений'));
        table.append(rowEl);
        if (open === key) table.append(featureEditor(st, key, draw));
      }
    };
    box.append(el('p', { class: 'muted small' }, 'Кнопка «умения» раскрывает редактор умений уровня. Известные и подготовленные — числом; пустое поле значит «не показывать в таблице» (как у классов без известных заклинаний). Ячейки — по кругам 1–9.'));
    box.append(table);
    draw();
    return box;
  }

  function featureEditor(st, level, onChanged) {
    const items = st.features[level] || (st.features[level] = []);
    const box = el('div', { class: 'ced-features' });
    const draw = () => {
      box.replaceChildren();
      items.forEach((f, index) => {
        box.append(el('div', { class: 'ced-feature' },
          el('div', { class: 'ced-row' },
            el('input', { class: 'grow', value: str(f.name), placeholder: 'Название умения', oninput: e => f.name = e.target.value }),
            el('button', { type: 'button', class: 'small ghost', onclick: () => { items.splice(index, 1); refresh(); } }, '×')),
          el('textarea', { rows: 3, placeholder: 'Текст умения', oninput: e => f.text = e.target.value }, str(f.text))));
      });
      box.append(el('div', { class: 'ced-row' },
        el('button', { type: 'button', class: 'small', onclick: () => { items.push({ name: '', text: '' }); refresh(); } }, '+ умение'),
        ...STANDARD_FEATURES.map(sf => el('button', { type: 'button', class: 'small', title: sf.text,
          onclick: () => { items.push({ name: sf.name, text: sf.text }); refresh(); } }, '+ ' + sf.name.split(' ')[0]))));
    };
    // Своя перерисовка плюс обновление строки уровня (счётчик умений в таблице).
    const refresh = () => { draw(); onChanged && onChanged(); };
    draw();
    return el('div', { class: 'ced-feature-wrap' }, box);
  }

  // ---------- Подклассы ----------
  function subclassesSection(st, render) {
    const box = el('div', {});
    st.subclasses.forEach((sub, index) => {
      const card = el('section', { class: 'ced-block' });
      const head = el('div', { class: 'ced-block-head' }, el('span', { class: 'badge' }, 'подкласс'),
        el('input', { class: 'grow', value: str(sub.name), placeholder: 'Название подкласса', oninput: e => sub.name = e.target.value }),
        el('button', { type: 'button', class: 'small ghost', onclick: () => { st.subclasses.splice(index, 1); render(); } }, '×'));
      card.append(head);
      card.append(el('div', { class: 'ced-grid' },
        field('Английское название', textInput(sub.name_en, 'Evocation', v => sub.name_en = v)),
        field('Надпись (путь, школа…)', textInput(sub.flavor, 'Магическая традиция', v => sub.flavor = v))));
      card.append(el('label', { class: 'ced-field wide' }, el('span', {}, 'Описание'),
        el('textarea', { rows: 3, oninput: e => sub.desc = e.target.value }, str(sub.desc))));
      const list = el('div', { class: 'ced-features' });
      const draw = () => {
        list.replaceChildren();
        (sub.features || (sub.features = [])).forEach((f, fi) => {
          list.append(el('div', { class: 'ced-feature' },
            el('div', { class: 'ced-row' },
              el('span', { class: 'ced-inline' }, el('small', { class: 'muted' }, 'уровень'), numInput(f.level, v => f.level = Math.min(MAX_LEVEL, Math.max(1, v)), { min: 1, max: MAX_LEVEL })),
              el('input', { class: 'grow', value: str(f.name), placeholder: 'Название умения', oninput: e => f.name = e.target.value }),
              el('button', { type: 'button', class: 'small ghost', onclick: () => { sub.features.splice(fi, 1); draw(); } }, '×')),
            el('textarea', { rows: 2, placeholder: 'Текст умения', oninput: e => f.text = e.target.value }, str(f.text))));
        });
        list.append(el('button', { type: 'button', class: 'small', onclick: () => { (sub.features ||= []).push({ level: 3, name: '', text: '' }); draw(); } }, '+ умение'));
      };
      draw();
      card.append(list);
      box.append(card);
    });
    box.append(el('button', { type: 'button', class: 'small', onclick: () => { st.subclasses.push({ name: '', name_en: '', flavor: '', desc: '', features: [] }); render(); } }, '+ подкласс'));
    box.append(el('p', { class: 'muted small' }, 'Уровень получения подкласса считается по самому младшему уровню в его умениях — как в мастере повышения.'));
    return box;
  }

  // ---------- Заклинания ----------
  function casterSection(st) {
    const box = el('div', { class: 'ced-grid' });
    box.append(
      field('Тип заклинателя', select(st.caster.level, [{ value: '', label: 'не заклинатель' }, { value: 'full', label: 'полный' },
        { value: 'half', label: 'половинный' }, { value: 'third', label: 'третной' }, { value: 'pact', label: 'магия договора' }],
        v => st.caster.level = v), 'Для мультикласса'),
      field('Что на 1 уровне', select(st.caster.start, [{ value: '', label: 'по таблице' }, { value: 'book', label: 'книга заклинаний' },
        { value: 'prepared', label: 'подготовленные' }, { value: 'known', label: 'известные' }], v => st.caster.start = v)),
      field('Число подготовленных', select(st.caster.prepared, [{ value: '', label: 'из таблицы' }, { value: 'level', label: 'уровень + модификатор' },
        { value: 'half', label: 'половина уровня + модификатор' }], v => st.caster.prepared = v)),
      field('Подготовлено на 1 уровне', textInput(st.caster.start_prepared, 'level или число', v => st.caster.start_prepared = v)),
      field('Книга: старт', numInput(st.caster.book_start, v => st.caster.book_start = Math.max(0, v), { max: 30 })),
      field('Книга: за уровень', numInput(st.caster.book_per_level, v => st.caster.book_per_level = Math.max(0, v), { max: 10 })),
    );
    box.append(el('p', { class: 'muted small wide' }, 'Эти поля читает ClassRules (мастер создания и повышение уровня). Ячейки и заговоры задаются в разделе «Уровни».'));
    return box;
  }

  function plural(n, one, few, many) { const n10 = n % 10, n100 = n % 100; return n100 >= 11 && n100 <= 14 ? many : n10 === 1 ? one : n10 >= 2 && n10 <= 4 ? few : many; }

  // ---------- Окно редактора ----------
  const ABIL_SHORT = { str: 'СИЛ', dex: 'ЛОВ', con: 'ТЕЛ', int: 'ИНТ', wis: 'МДР', cha: 'ХАР' };

  /// Открыть редактор: возвращает { name, data } (сохранение делает справочник) или null.
  /// Тело редактора: разделы, навигация и состояние. Одно и то же для модалки и для
  /// отдельной страницы редактора (/class-editor/<id>).
  /// Возвращает { root, state, save, title }: save() отдаёт { name, data } или null с подсказкой.
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
        : sec.id === 'levels' ? levelsSection(st)
          : sec.id === 'skills' ? skillsSection(st, render)
            : sec.id === 'languages' ? languagesSection(st, render)
              : sec.id === 'equipment' ? equipmentSection(st, render)
                : sec.id === 'subclasses' ? subclassesSection(st, render)
                  : casterSection(st);
      content.replaceChildren(el('div', { class: 'ced-section' }, el('h3', {}, sec.title), el('p', { class: 'muted small' }, sec.hint), body));
    };
    render();
    const root = el('div', { class: 'class-editor' }, nav, content);
    const save = () => {
      const name = st.name.trim();
      if (!name) { toast('Нужно название класса'); return null; }
      return { name, data: writeData(st, entry) };
    };
    return { root, state: st, save, title: entry?.id ? 'Класс: ' + (entry.name || '') : 'Новый класс' };
  }

  /// Модалка редактора — для встраиваемых мест (лист персонажа, стол).
  function edit(entry, opts = {}) {
    const f = form(entry, opts);
    return modal(f.title, f.root, [{ label: 'Сохранить', cls: 'primary', fn: () => f.save() || false }], { wide: true });
  }

  return { edit, form, readState, writeData, emptyData, equipmentText, blocksFromText, rowsFromList, rowFromText, skillKeyOfName, skillNameOfKey, skillFromEntry,
    ABIL_SHORT, KEYS, SECTIONS, MAX_LEVEL };
})();
