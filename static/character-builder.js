// =============================================================================
// character-builder.js — правилное ядро создания персонажа (окно не рисует).
//
// Чистая проекция: лист собирается из черновика (draft) и снимков записей
// справочника заново при каждой сборке, бонусы никогда не накапливаются.
// Готовый лист хранит независимые снимки модулей (sheet.modules), поэтому
// правки справочника задним числом не меняют созданного персонажа.
//
// Состав модуля (window.CharacterBuilder):
//   • словари и текстовые утилиты: языки, мировоззрения, нормализация названий;
//   • реестр проекций записей справочника (раса, класс, предыстория, черта, …);
//   • выборы «либо / либо» в модулях (data.choices): проверка, применение,
//     редактор для конструктора справочника;
//   • разбор текста стартового снаряжения и план выдачи (тексты 2014 и 2024);
//   • навыки, языки, подклассы, лимиты заклинаний;
//   • сборка итогового листа — build(draft).
//
// UI мастера создания персонажа живёт отдельно — в builder-dialog.js.
// Зависимости: common.js, dice.js, mechanics.js, modules.js.
// Загружается в index.html и sheet.html (модуль нужен редактору справочника).
// =============================================================================
window.CharacterBuilder = (() => {
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const mechanicsPrograms = (mechanics, context) => window.Mechanics?.programsOf ? window.Mechanics.programsOf(mechanics, context) : mechanics?.programs || [];
  const mechanicsContext = (draft, level = 1) => ({ edition: draft.edition || '2014', level, subclass: draft.selected?.subclass?.id || '', choices: { ...(draft.picks || {}), ...(draft.ruleChoices || {}) } });
  const short = { СИЛ: 'str', ЛОВ: 'dex', ТЕЛ: 'con', ИНТ: 'int', МДР: 'wis', ХАР: 'cha' };
  const ALIGNMENTS = ['', 'Законно-доброе', 'Нейтрально-доброе', 'Хаотично-доброе', 'Законно-нейтральное', 'Нейтральное', 'Хаотично-нейтральное', 'Законно-злое', 'Нейтрально-злое', 'Хаотично-злое', 'Без мировоззрения'];
  // Языки из набора languages (ru); стандартные для 2024 — поле standard_2024. Списки обновляются при загрузке наборов,
  // поэтому ссылки, которые берёт builder-dialog.js при загрузке, остаются верными.
  const LANGUAGES = window.Presets?.liveList('languages', i => i.table.ru) || [];
  const LANGUAGES_2024_STANDARD = window.Presets?.liveList('languages', i => i.table.ru, i => i.table.standard_2024) || [];
  const modifier = n => Math.floor((n - 10) / 2);
  const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  const pointBuyTotal = abilities => Object.values(abilities || {}).reduce((sum, n) => sum + (POINT_BUY_COST[Number(n)] ?? 999), 0);
  const pointBuyValid = abilities => keys.every(key => Object.hasOwn(POINT_BUY_COST, Number(abilities?.[key]))) && pointBuyTotal(abilities) === 27;
  const appendProficiency = (s, label, values) => {
    const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
    const text = list.map(x => String(x || '').trim()).filter(Boolean).join(', ');
    if (text && !s.proficiencies.includes(text)) s.proficiencies += `${label}: ${text}\n`;
  };
  // ---------- Реестр проекций: как запись справочника меняет лист ----------
  const handlers = new Map();
  const register = (category, apply) => handlers.set(category, apply);
  // Значение пассивного блока v1 записи (без зависимости от порядка загрузки mechanics.js).
  const passiveFieldValue = (entry, field) => {
    for (const program of entry?.data?.mechanics?.programs || [])
      if (program.trigger === 'passive') for (const block of program.blocks || [])
        if (block.kind === 'passive' && block.enabled !== false && block.field === field) return block.value;
    return null;
  };
  const feature = (s, name, text, source, mechanics) => s.features.push(Modules.newFeature({ name, text: text || '', source, mechanics }));
  register('race', (s, e) => {
    const d = e.data || {}; s.race = d.parent ? `${d.parent} (${e.name})` : e.name; if (d.speed) s.speed = d.speed;
    if (s.edition === '2014') for (const k of keys) s.abilities[k] += Number(d.asi?.[k]) || 0;
    appendProficiency(s, 'Языки расы', d.languages);
  });
  register('class', (s, e) => {
    const d = e.data || {}; s.class = e.name; s.saving_throws = [...(d.saves || [])];
    s.hp.hit_dice = '1' + (d.hit_die || 'd8'); s.spells.ability = d.spellcasting || '';
    const slug = window.ClassRules.slugOf(e);
    for (const name of d.features?.['1'] || []) {
      if (s.edition === '2014' && slug === 'fighter' && /^(Боевой стиль)(:|$)/.test(name)) continue;
      feature(s, name, d.feature_texts?.[name], e.name, window.Mechanics?.forFeature(d.mechanics,name));
    }
    appendProficiency(s, 'Доспехи', d.armor);
    appendProficiency(s, 'Оружие', d.weapons);
    appendProficiency(s, 'Инструменты', d.tools);
  });
  register('background', (s, e) => {
    const d = e.data || {}; s.background = e.name;
    for (const name of Array.isArray(d.skills) ? d.skills : []) { const key = skillKey(name); if (key) s.skills.push(key); }
    appendProficiency(s, 'Инструменты предыстории', d.tools);
    appendProficiency(s, 'Языки предыстории', Array.isArray(d.languages) || typeof d.languages === 'string' ? d.languages : null);
    if (d.feature) feature(s, d.feature, d.feature_text, e.name, window.Mechanics?.forFeature(d.mechanics,d.feature));
  });
  register('feat', (s, e) => {
    const d = e.data || {};
    feature(s, e.name, d.desc || '', e.source || 'Черта', d.mechanics);
  });
  register('subclass', (s, e) => {
    const d = e.data || {}; s.subclass = e.name;
    for (const name of d.features?.['1'] || []) feature(s, name, d.feature_texts?.[name], e.name,
      window.Mechanics?.forFeature(d.mechanics, name));
    appendProficiency(s, 'Владения подкласса', d.proficiencies);
  });
  register('spell', (s, e) => s.spells.known.push(Modules.spellFromCompendium(e)));
  // ---------- варианты выбора «либо / либо» внутри расы, класса и предыстории ----------
  // data.choices = [{ id, name, type, count, optional, options: [{ id, name, value }] }]
  // Значение варианта зависит от типа: характеристика — {str:2}, навык — ['athletics'],
  // язык — ['Эльфийский'], умение — {text, mechanics}, владение — строка.
  const CHOICE_TYPES = { ability: 'Характеристика', skill: 'Навык', language: 'Язык', feature: 'Умение', proficiency: 'Владение' };
  const CHOICE_MAX = { groups: 12, options: 18, name: 120, text: 4000 };
  const asList = v => Array.isArray(v) ? v : (v === undefined || v === null || v === '') ? [] : [v];
  const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
  const SKILL_NAME_ALIASES = { 'анализ': 'investigation' };
  const skillKey = name => {
    const value = String(name || '').trim();
    return (SKILLS || []).find(([k, n]) => k === value || n === value)?.[0] || SKILL_NAME_ALIASES[value.toLocaleLowerCase('ru')];
  };
  const skillName = key => (SKILLS || []).find(([k]) => k === key)?.[1] || key;
  const uid = p => p + Math.random().toString(36).slice(2, 9);
  const newChoiceGroup = (type = 'ability') => ({ id: uid('cg'), name: '', type, count: 1, options: [] });
  function newChoiceOption(type = 'ability') {
    const value = type === 'ability' ? {} : type === 'feature' ? { text: '' } : (type === 'skill' || type === 'language') ? [] : '';
    return { id: uid('co'), name: '', value };
  }
  /// Проверка описания выбора. Пустой список допустим: значит, выборов у модуля нет.
  function validateChoices(groups) {
    if (groups === undefined || groups === null) return '';
    if (!Array.isArray(groups)) return 'Варианты выбора: нужен список.';
    if (groups.length > CHOICE_MAX.groups) return `Не более ${CHOICE_MAX.groups} групп выбора.`;
    const ids = new Set();
    for (const g of groups) {
      if (!g || !CHOICE_TYPES[g.type]) return 'Неизвестный тип выбора.';
      if (!clip(g.id, 64) || ids.has(g.id)) return 'У каждой группы выбора должен быть свой код.';
      ids.add(g.id);
      if (!String(g.name || '').trim()) return 'Назовите группу выбора.';
      const opts = Array.isArray(g.options) ? g.options : [];
      if (!opts.length || opts.length > CHOICE_MAX.options) return `В группе «${g.name}» должно быть от 1 до ${CHOICE_MAX.options} вариантов.`;
      const count = Number(g.count);
      if (!Number.isInteger(count) || count < 0 || count > opts.length) return `«${g.name}»: выбрать можно от 0 до ${opts.length} вариантов.`;
      const oids = new Set();
      for (const o of opts) {
        if (!o || !clip(o.id, 64) || oids.has(o.id)) return 'У каждого варианта должен быть свой код.';
        oids.add(o.id);
        if (!String(o.name || '').trim()) return `В группе «${g.name}» есть вариант без названия.`;
        const v = o.value;
        if (g.type === 'ability') {
          const pairs = Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
          if (!pairs.length || pairs.length > keys.length || pairs.some(([k, n]) => !keys.includes(k) || !Number.isFinite(Number(n)) || Number(n) < -5 || Number(n) > 5))
            return `«${g.name}»: бонус характеристики — целое от −5 до +5.`;
        } else if (g.type === 'skill') {
          const arr = asList(v);
          if (!arr.length || arr.length > CHOICE_MAX.options || arr.some(x => !skillKey(x))) return `«${g.name}»: выберите навыки из списка.`;
        } else if (g.type === 'language') {
          const arr = asList(v);
          if (!arr.length || arr.length > CHOICE_MAX.options || arr.some(x => !String(x).trim() || String(x).length > 80)) return `«${g.name}»: языки — до ${CHOICE_MAX.options}, не длиннее 80 символов.`;
        } else if (g.type === 'feature') {
          const text = v && typeof v === 'object' ? v.text : '';
          if (!String(text || '').trim()) return `«${g.name}»: опишите умение каждого варианта.`;
          if (String(text).length > CHOICE_MAX.text) return `«${g.name}»: слишком длинное описание умения.`;
          if (v && v.mechanics && window.Mechanics) { const err = window.Mechanics.validate(v.mechanics); if (err) return err; }
        } else if (g.type === 'proficiency') {
          const text = typeof v === 'string' ? v : '';
          if (!text.trim() || text.length > 200) return `«${g.name}»: владение — строка до 200 символов.`;
        }
      }
    }
    return '';
  }
  /// Применить выбранный вариант к листу. s.features / s.skills / s.proficiencies / s.abilities.
  function applyChoice(s, group, option, source) {
    if (!group || !option) return;
    const v = option.value;
    if (group.type === 'ability') {
      const bonus = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      for (const [k, n] of Object.entries(bonus)) if (keys.includes(k) && Number.isFinite(Number(n))) s.abilities[k] += Number(n);
    } else if (group.type === 'skill') {
      for (const name of asList(v)) { const k = skillKey(name); if (k) s.skills.push(k); }
    } else if (group.type === 'language') {
      for (const name of asList(v)) { const str = clip(name, 80).trim(); if (str && !s.proficiencies.includes(str)) s.proficiencies += str + '\n'; }
    } else if (group.type === 'feature') {
      feature(s, clip(option.name, CHOICE_MAX.name) || 'Умение', clip(v && v.text, CHOICE_MAX.text), source, v && v.mechanics);
    } else if (group.type === 'proficiency') {
      const str = clip(asList(v)[0], 200).trim(); if (str && !s.proficiencies.includes(str)) s.proficiencies += str + '\n';
    }
  }
  /// Сколько вариантов нужно выбрать в группе и сколько уже выбрано.
  function choiceState(group, picked) {
    const need = Math.max(0, Number(group.count) || 0), got = (picked || []).length;
    return { need, got, done: group.optional ? got <= need : got === need };
  }
  // ---------- Стартовое снаряжение ----------
  // Текст модуля (2014: «- (a) секира или (b) любое воинское рукопашное оружие»,
  // 2024: «Выберите А или Б: (А) секира, 4 ручных топора … и 15 зм; или (Б) 75 зм»)
  // разбирается в план: безусловные предметы, группы выбора и слоты «любое … оружие».
  // Сами предметы собираются через Modules.itemFromCompendium + Equipment.normalize,
  // поэтому на лист попадают те же стопки, хват, слоты и расход боеприпасов, что в инвентаре.
  const WORD_NUMBERS = { один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, двадцать: 20 };
  const WORD_NUMBER_RE = new RegExp('^(' + Object.keys(WORD_NUMBERS).join('|') + ')\\s+(.+)$', 'i');
  const STEM_SUFFIXES = ['ами', 'ями', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ых', 'их', 'ую', 'юю', 'ов', 'ев', 'ий', 'ый', 'ая', 'ое', 'ые', 'ой', 'ей', 'ам', 'ям', 'ах', 'ях', 'ию', 'ия', 'ье', 'ья', 'у', 'ю', 'а', 'я', 'ы', 'и', 'е', 'о', 'ь'];
  const COUNTED_UNIT = /^(?:шт\.?|штук[а-яё]*|лист[а-яё]*|фут[а-яё]*|дн[а-яё]*|день|дня|дней|доз[а-яё]*|комплект[а-яё]*|заряд[а-яё]*)$/i;
  // Категория и вид записи: у записей справочника данные лежат в data, у тестовых фикстур — на верхнем уровне.
  const entryName = e => String(e?.name || e?.data?.name || '');
  const entryCategory = e => String(e?.data?.category || (e?.category && e.category !== 'item' ? e.category : '') || '');
  const itemKind = e => {
    const t = e?.data?.mechanics?.item_defaults?.type || (e?.data?.type && e.data.type !== 'item' ? e.data.type : '') || (e?.type && e.type !== 'item' ? e.type : '');
    return t || 'gear';
  };
  // «По выбору»: категории предметов совпадают в 2014 и 2024, поэтому фильтр один на обе редакции.
  const PICK_FILTERS = {
    'martial-melee': { label: 'воинское рукопашное оружие', test: e => itemKind(e) === 'weapon' && /Воинское рукопашное/i.test(entryCategory(e)) },
    'martial-ranged': { label: 'воинское дальнобойное оружие', test: e => itemKind(e) === 'weapon' && /Воинское дальнобойное/i.test(entryCategory(e)) },
    'simple-melee': { label: 'простое рукопашное оружие', test: e => itemKind(e) === 'weapon' && /Простое рукопашное/i.test(entryCategory(e)) },
    'simple-ranged': { label: 'простое дальнобойное оружие', test: e => itemKind(e) === 'weapon' && /Простое дальнобойное/i.test(entryCategory(e)) },
    'martial-weapon': { label: 'воинское оружие', test: e => itemKind(e) === 'weapon' && /Воинское/i.test(entryCategory(e)) },
    'simple-weapon': { label: 'простое оружие', test: e => itemKind(e) === 'weapon' && /Простое/i.test(entryCategory(e)) },
    weapon: { label: 'оружие', test: e => itemKind(e) === 'weapon' },
    instrument: { label: 'музыкальный инструмент', test: e => /Музыкальные инструменты/i.test(entryCategory(e)) },
    tools: { label: 'инструменты ремесленника', test: e => /Инструменты ремесленника/i.test(entryCategory(e)) },
    'tools-or-instrument': { label: 'инструменты или музыкальный инструмент', test: e => /Инструменты ремесленника|Музыкальные инструменты/i.test(entryCategory(e)) },
    'holy-symbol': { label: 'священный символ', test: e => /Священные символы/i.test(entryCategory(e)) },
    'arcane-focus': { label: 'магический фокус', test: e => /Магические фокусы/i.test(entryCategory(e)) },
    'druidic-focus': { label: 'друидический фокус', test: e => /Друидические фокусы/i.test(entryCategory(e)) || /омел|тотем|тисовая|деревянный посох/i.test(entryName(e)) },
    'gaming-set': { label: 'игровой набор', test: e => /Игровые наборы/i.test(entryCategory(e)) },
    pack: { label: 'набор снаряжения', test: e => /Наборы снаряжения/i.test(entryCategory(e)) },
  };
  // \w в JavaScript не включает кириллицу — классы букв задаются явно. Порядок важен: узкие правила раньше общих.
  const PICK_PATTERNS = [
    [/друидическ[а-яё]*|фокусировк[а-яё]*\s+друида/i, 'druidic-focus'],
    [/священн[а-яё]*\s+символ/i, 'holy-symbol'],
    [/(?:магическ[а-яё]*|заклинательн[а-яё]*)\s+фокус/i, 'arcane-focus'],
    [/инструмент[а-яё]*\s+ремесленник[а-яё]*\s+(?:или|and)\s+.*музыкальн[а-яё]*\s+инструмент/i, 'tools-or-instrument'],
    [/инструмент[а-яё]*\s+ремесленник/i, 'tools'],
    [/музыкальн[а-яё]*\s+инструмент/i, 'instrument'],
    [/игров[а-яё]*\s+набор/i, 'gaming-set'],
    [/воинск[а-яё]*\s+рукопашн[а-яё]*/i, 'martial-melee'],
    [/прост[а-яё]*\s+рукопашн[а-яё]*/i, 'simple-melee'],
    [/прост[а-яё]*\s+дальнобойн[а-яё]*/i, 'simple-ranged'],
    [/воинск[а-яё]*\s+оружи[а-яё]*/i, 'martial-weapon'],
    [/прост[а-яё]*\s+оружи[а-яё]*/i, 'simple-weapon'],
    [/^(?:любо[ейя]|любые|любого|любую|any)?\s*оружи[а-яё]*/i, 'weapon'],
  ];
  const cap = v => { const t = String(v || '').trim(); return t ? t[0].toLocaleUpperCase() + t.slice(1) : ''; };
  const normalizeName = v => String(v === undefined || v === null ? '' : v).toLocaleLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"'.,;:()[\]×*]/g, ' ').replace(/\s+/g, ' ').trim();
  function stemWord(word) {
    for (const suffix of STEM_SUFFIXES) if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
    return word;
  }
  const nameStems = name => normalizeName(name).split(' ').filter(t => t.length > 2).map(stemWord);
  /// «стрелами» → «Стрела»: из текста «колчан с 20 стрелами» нужен предмет в именительном падеже.
  const singular = word => {
    const text = String(word || '');
    const trimmed = text.replace(/(?:ами|ями|ах|ях|ов|ев|ы|и)$/i, '');
    return trimmed.length >= 4 && trimmed !== text ? trimmed + 'а' : text;
  };
  const similarStem = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  // Названия, которые не выводятся из справочника слово в слово: сначала пробуем эти варианты.
  const ITEM_ALIASES = {
    'деревянный щит': ['Щит'],
    'святая вода': ['Святая вода', 'Святая вода (фляга)'],
    'каллиграфические принадлежности': ['Инструменты каллиграфа'],
    'кожаные доспехи': ['Кожаный доспех'],
    'кожаные доспехи (мягкие)': ['Кожаный доспех'],
    'пергамент (1 лист)': ['Пергамент (1 лист)', 'Пергамент'],
    'святая вода (фляга)': ['Святая вода (фляга)', 'Святая вода'],
  };
  /// Насколько название предмета из текста похоже на запись справочника: точные слова весят больше похожих.
  function itemMatchScore(query, entry) {
    const words = nameStems(query), stems = nameStems(entryName(entry));
    if (!words.length || !stems.length) return 0;
    let exact = 0, near = 0;
    for (const word of words) {
      if (stems.includes(word)) exact++;
      else if (stems.some(stem => similarStem(word, stem))) near++;
    }
    const matched = exact + near;
    const head = similarStem(words[words.length - 1], stems[stems.length - 1]);
    if (!exact) return 0;                                              // похожее слово без точного — случайное совпадение
    if (matched < words.length && !(head && stems.includes(words[words.length - 1]))) return 0;
    return (exact + near * 0.55) / words.length + (head ? 0.35 : 0) - 0.15 * Math.max(0, stems.length - matched) / stems.length;
  }
  /// Ближайший предмет справочника по названию из текста («4 ручных топора» → «Ручной топор»).
  function findItemTemplate(name, catalog) {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    for (const alias of ITEM_ALIASES[normalized] || []) {
      const target = (catalog || []).find(e => normalizeName(entryName(e)) === normalizeName(alias));
      if (target) return target;
    }
    let best = null, bestScore = 0;
    for (const entry of catalog || []) {
      if (itemKind(entry) === 'magic') continue; // «мантия» из снаряжения не должна находить магическую
      const score = itemMatchScore(name, entry);
      if (score > bestScore + 1e-9) { bestScore = score; best = entry; }
    }
    return best;
  }
  /// «Любое воинское рукопашное оружие», «священный символ», «два простых рукопашных оружия» — выбор игрока.
  function parsePick(text) {
    const match = PICK_PATTERNS.find(([re]) => re.test(text));
    if (!match) return null;
    const count = /^\s*(?:два|две|2)\s/i.test(text) ? 2 : /^\s*(?:три|3)\s/i.test(text) ? 3 : 1;
    const qualifier = (String(text).match(/\(([^)]*)\)/) || [])[1] || '';
    return { filter: match[1], count, label: PICK_FILTERS[match[1]].label, prefer: qualifier.trim() };
  }
  /// Один предмет из текста: количество (×N, «4», «пять»), пояснение в скобках и золото.
  function parseItemToken(raw, source) {
    let text = String(raw || '').replace(/^[\s\-–—•*]+/, '').replace(/\s+/g, ' ').trim();
    if (!text || /^(?:или|or)$/i.test(text)) return [];
    // «…, выбранные выше» — отсылка к прошлому выбору, а не отдельный предмет.
    if (/^(?:выбранн[а-яё]*|тот же|та же|такой же|the same)(?:\s|$)/i.test(text)) return [];
    const token = extra => (source === undefined ? extra : { ...extra, source });
    const gold = text.match(/^(\d{1,5})\s*(?:зм|золот[а-яё]*)/i);
    if (gold) return [token({ kind: 'gold', amount: Number(gold[1]) })];
    const quiver = text.match(/^(?:колчан|футляр)\s+с\s+(\d{1,4})\s+(\S+)$/i);
    if (quiver) return [token({ kind: 'item', name: 'Колчан', qty: 1, note: '' }),
      token({ kind: 'item', name: cap(singular(quiver[2])), qty: Number(quiver[1]), note: '' })];
    const pick = parsePick(text);
    if (pick) return [{ kind: 'pick', ...pick, text }];
    let qty = 1, note = '';
    const parenthetical = text.match(/\(([^)]*)\)/);
    if (parenthetical) {
      const inside = parenthetical[1].trim();
      const counted = inside.match(/^(\d{1,4})\s*(\S+)$/);
      if (counted && COUNTED_UNIT.test(counted[2])) qty = Number(counted[1]);
      else note = inside;
      text = (text.slice(0, parenthetical.index) + ' ' + text.slice(parenthetical.index + parenthetical[0].length)).replace(/\s+/g, ' ').trim();
    }
    const trailing = text.match(/^(.*?)\s*[×x]\s*(\d{1,4})$/i);
    if (trailing) { text = trailing[1].trim(); qty = Number(trailing[2]); }
    else {
      const leading = text.match(/^(\d{1,4})\s+(.+)$/);
      const words = text.match(WORD_NUMBER_RE);
      if (leading) { qty = Number(leading[1]); text = leading[2]; }
      else if (words) { qty = WORD_NUMBERS[words[1].toLocaleLowerCase()]; text = words[2]; }
    }
    text = text.replace(/[,;]+$/, '').trim();
    return text ? [token({ kind: 'item', name: cap(text), qty: Math.max(1, qty), note })] : [];
  }
  /// Перечисление предметов: «рапира, длинный меч», «лёгкий арбалет и 20 болтов».
  /// Запятые и «и» внутри скобок («шарики (мешочек, 1000 шт.)») не разделяют предметы.
  function splitItemList(text) {
    const source = String(text || ''), parts = [];
    let depth = 0, current = '';
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
      if (!depth) {
        if (char === ',' || char === ';') { parts.push(current); current = ''; continue; }
        if (char.toLocaleLowerCase() === 'и' && /\s/.test(source[i - 1] || '') && /\s/.test(source[i + 1] || '')) { parts.push(current); current = ''; i++; continue; }
      }
      current += char;
    }
    parts.push(current);
    return parts;
  }
  const parseItemList = text => splitItemList(text).flatMap(part => parseItemToken(part));
  /// Разбор текста снаряжения: группы «(a) … или (b) …» и безусловные предметы.
  function parseEquipmentText(text, source) {
    const blocks = [];
    for (const rawLine of String(text || '').split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const markers = [...line.matchAll(/\(([a-eа-еA-EА-Е])\)/g)];
      if (markers.length >= 2) {
        const options = markers.map((marker, index) => {
          const from = marker.index + marker[0].length;
          const to = index + 1 < markers.length ? markers[index + 1].index : line.length;
          const body = line.slice(from, to).replace(/[,;]?\s*(?:или|or)\s*$/i, '').replace(/[,;]\s*$/, '').trim();
          return { id: `opt${index + 1}`, marker: marker[1].toLocaleUpperCase(), label: body, tokens: parseItemList(body) };
        }).filter(o => o.tokens.length);
        if (options.length >= 2) {
          const lead = line.slice(0, markers[0].index).replace(/^[\s\-–—•*]+/, '').replace(/[:：]\s*$/, '').trim();
          blocks.push({ kind: 'group', label: cap(lead) || 'Выберите вариант', options });
          continue;
        }
      }
      const tokens = parseItemList(line);
      if (tokens.length) blocks.push({ kind: 'fixed', tokens });
    }
    return blocks.map((block, index) => ({ ...block, source, index }));
  }
  /// План снаряжения выбранных модулей: класс и предыстория дают текст, мастер — выбор игрока.
  function equipmentPlan(draft) {
    const blocks = [];
    for (const [kind, entry] of [['class', draft.selected?.class], ['background', draft.selected?.background]]) {
      const text = kind === 'class' ? entry?.data?.starting_equipment : entry?.data?.equipment;
      if (!entry || typeof text !== 'string' || !text.trim()) continue;
      for (const block of parseEquipmentText(text, kind)) blocks.push({ ...block, id: `${kind}:${block.index}`, sourceName: entry.name });
    }
    return blocks;
  }
  /// Содержимое набора снаряжения из его описания: «Содержимое: Рюкзак ×1, Спальник ×1 …».
  function packContents(entry, catalog) {
    const desc = String(entry?.data?.desc || '');
    const match = desc.match(/Содержимое:\s*([^\n]+)/i);
    if (!match || !/набор/i.test(entryName(entry) || '')) return null;
    const tokens = parseItemList(match[1]).filter(t => t.kind === 'item' && t.name);
    if (!tokens.length) return null;
    return tokens.map(token => ({ name: findItemTemplate(token.name, catalog)?.name || entryName(findItemTemplate(token.name, catalog)) || token.name, qty: token.qty, note: token.note, entry: findItemTemplate(token.name, catalog) || null, fromPack: entryName(entry) }));
  }
  /// Какие записи подходят под слот выбора игрока.
  const pickOptions = (filter, catalog) => (PICK_FILTERS[filter] ? (catalog || []).filter(e => PICK_FILTERS[filter].test(e)) : []);
  /// Выбранный предмет слота: явный выбор игрока, подсказка из скобок («фокус (кристалл)») или первый подходящий.
  function pickEntry(token, key, equipment, catalog) {
    // A rules-defined choice is never silently replaced with the first compendium item.
    // The selection must belong to this slot's allowed category.
    return pickOptions(token.filter, catalog).find(e => e.id === equipment.picks?.[key]) || null;
  }
  /// Что игрок выбрал и что из этого попадёт в инвентарь (шаблоны — из справочника предметов).
  function equipmentItems(draft) {
    const equip = draft.equipment || {};
    const catalog = (draft.catalog || []).filter(e => e.category === 'item');
    const expandPacks = equip.packs !== false;
    const gmOverrides = equip.gmOverrides === true;
    const items = [];
    let gold = gmOverrides ? Number(equip.gold) || 0 : 0;
    for (const block of equipmentPlan(draft)) {
      let tokens = block.tokens || [], option = null;
      if (block.kind === 'group') {
        option = block.options.find(o => o.id === equip.choice?.[block.id]) || null;
        tokens = option?.tokens || [];
      }
      tokens.forEach((token, index) => {
        const stem = `${block.id}:${option ? option.id : '-'}`;
        if (token.kind === 'gold') { gold += token.amount; return; }
        if (token.kind === 'pick') for (let slot = 0; slot < (token.count || 1); slot++) {
          const key = `${stem}:p${index}:${slot}`;
          if (gmOverrides && equip.exclude?.[key]) continue;
          const entry = pickEntry(token, key, equip, catalog);
          items.push({ key, pick: true, filter: token.filter, label: token.label, prefer: token.prefer || '', source: block.sourceName, qty: 1, entry, name: entry ? entryName(entry) : '' });
        }
        else {
          const key = `${stem}:i${index}`;
          if (gmOverrides && equip.exclude?.[key]) return;
          const entry = catalog.find(e => e.id === (gmOverrides ? equip.template?.[key] : null)) || findItemTemplate(gmOverrides ? equip.name?.[key] || token.name : token.name, catalog) || null;
          items.push({ key, name: entry ? entryName(entry) : (gmOverrides ? equip.name?.[key] || token.name : token.name), qty: Math.max(1, Number(gmOverrides ? equip.qty?.[key] ?? token.qty : token.qty) || 1), note: token.note, source: block.sourceName, entry });
        }
      });
    }
    for (const extra of (gmOverrides ? equip.extras : []) || []) {
      const entry = catalog.find(e => e.id === extra.entryId) || null;
      if (entry || extra.name) items.push({ key: extra.key, name: extra.name || entryName(entry), qty: Math.max(1, Number(extra.qty) || 1), note: '', source: 'Добавлено вручную', manual: true, entry });
    }
    // Наборы раскладываются на содержимое: сам набор остаётся строкой-контейнером,
    // а предметы из описания попадают в инвентарь по отдельности (и учитываются в весе).
    const expanded = [];
    for (const item of items) {
      const contents = expandPacks && item.entry ? packContents(item.entry, catalog) : null;
      if (!contents) { expanded.push(item); continue; }
      const packQty = Math.max(1, Number(gmOverrides ? equip.qty?.[item.key] ?? item.qty : item.qty) || 1);
      expanded.push({ ...item, pack: true, contents: contents.length });
      contents.forEach((child, index) => expanded.push({ ...child, qty: child.qty * packQty, key: `${item.key}#${index}`, source: item.source, parent: entryName(item.entry) }));
    }
    return { items: expanded, gold };
  }
  /// Предметы инвентаря для нового листа: шаблон справочника, количество, правила слотов.
  function startingInventory(draft) {
    const { items, gold } = equipmentItems(draft);
    const inventory = [];
    for (const item of items) {
      if (!item.name || item.pack) continue; // набор-контейнер остаётся только строкой выбора
      const qty = Math.max(1, Math.round(Number(item.qty) || 1));
      const doc = item.entry && window.Modules?.itemFromCompendium
        ? window.Modules.itemFromCompendium(item.entry)
        : window.Modules?.newItem?.({ name: item.name, type: 'gear', source: item.source || '' });
      if (!doc) continue;
      doc.uid = uid('it');
      doc.name = item.name;
      doc.qty = qty;
      doc.favorite = false; doc.attuned = false; doc.equipped = false; doc.hand_slot = null; doc.worn_slot = null;
      doc.source = item.entry?.source || `${item.source} · стартовое снаряжение`;
      const notes = [item.parent && `Из набора «${item.parent}»`, item.note].filter(Boolean).map(v => String(v).trim()).filter(Boolean);
      if (notes.length) doc.desc = [notes.join('. '), doc.desc].filter(Boolean).join('. ');
      inventory.push(window.Equipment?.normalize ? window.Equipment.normalize(doc) : doc);
    }
    return { inventory, gold };
  }

  // ---------- Навыки: что дают модули и что выбирает игрок ----------
  /// Навыки, которые модуль выдаёт без выбора (предыстория, раса, пассивные блоки «Навыки»).
  function passiveSkills(entry, kind = '', context = {}) {
    if (!entry) return [];
    const out = [], add = name => { const key = skillKey(name); if (key && !out.some(x => x.key === key)) out.push({ key, name: skillName(key), ability: (SKILLS.find(([k]) => k === key) || [])[2] || 'str', source: entry.name, kind }); };
    const data = entry.data || {};
    for (const name of Array.isArray(data.skills) ? data.skills : []) add(name);
    const passive = window.Mechanics?.passiveData?.(entry, context) || entry;
    for (const name of Array.isArray(passive?.data?.skills) ? passive.data.skills : []) add(name);
    if (!window.Mechanics?.passiveData) for (const program of mechanicsPrograms(data.mechanics, context)) if (program.trigger === 'passive')
      for (const block of program.blocks || []) if (block.kind === 'passive' && block.enabled !== false && block.field === 'skills')
        for (const name of asList(block.value)) add(name);
    return out;
  }
  /// Навыки, выданные выбором «либо / либо» в модулях (тип группы «skill»).
  function choiceSkills(draft) {
    const out = [];
    for (const { entry, group } of moduleChoices(draft)) {
      if (group.type !== 'skill') continue;
      for (const id of asList(draft.picks?.[group.id])) {
        const option = (group.options || []).find(o => o.id === id);
        for (const name of option ? asList(option.value) : []) {
          const key = skillKey(name);
          if (key && !out.some(x => x.key === key)) out.push({ key, name: skillName(key), ability: (SKILLS.find(([k]) => k === key) || [])[2] || 'str', source: entry.name, kind: group.type === 'skill' ? 'выбор модуля' : '' });
        }
      }
    }
    return out;
  }
  /// Группы выбора «либо / либо», объявленные выбранными модулями.
  function moduleChoices(draft) {
    const out = [];
    for (const key of ['race', 'class', 'subclass', 'background', 'feat']) {
      const entry = draft.selected?.[key];
      if (!entry) continue;
      for (const group of entry.data?.choices || []) out.push({ entry, group });
    }
    return out;
  }
  /// Подкласс — вложенный блок записи класса в справочнике. На 1 уровне выбираются
  /// только те подклассы, у которых первое умение действительно появляется на 1 уровне.
  function subclassLevel(classEntry) {
    const levels = (classEntry?.data?.subclasses || []).flatMap(sub => typeof sub === 'object'
      ? Object.keys(sub.features || {}).map(Number).filter(n => Number.isInteger(n) && n >= 1) : []);
    return levels.length ? Math.min(...levels) : null;
  }
  function subclassVariantGroups(subclass, level = 1) {
    const groups = new Map();
    for (const name of subclass?.data?.features?.[String(level)] || []) {
      if (typeof name !== 'string') continue;
      const match = name.match(/^(.+?):\s+(.+)$/); if (!match) continue;
      const options = groups.get(match[1]) || []; options.push(name); groups.set(match[1], options);
    }
    return [...groups].filter(([, options]) => options.length > 1).map(([base, options]) => ({ base, options }));
  }
  function subclassModule(classEntry, subclass) {
    if (!classEntry || !subclass) return null;
    const data = typeof subclass === 'string' ? { name: subclass } : JSON.parse(JSON.stringify(subclass));
    const name = String(data.name || '').trim();
    if (!name) return null;
    return { id: `${classEntry.id}:subclass:${name.toLocaleLowerCase()}`, category: 'subclass', name,
      source: classEntry.source || 'Справочник', pack_id: classEntry.pack_id || null,
      data: { ...data, parent_class: classEntry.name, parent_class_id: classEntry.id } };
  }
  function backgroundFeatModule(background, catalog) {
    const raw = String(background?.data?.feat || '').trim();
    if (!raw) return null;
    const base = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const feat = (catalog || []).find(e => e.category === 'feat' && normalizeName(entryName(e)) === normalizeName(base))
      || (catalog || []).find(e => e.category === 'feat' && normalizeName(entryName(e)) === normalizeName(raw));
    if (!feat) return null;
    return { ...JSON.parse(JSON.stringify(feat)), id: `${feat.id}:background:${background.id}`, data: {
      ...JSON.parse(JSON.stringify(feat.data || {})), background_feat: raw,
      parent_background: background.name, parent_background_id: background.id,
    } };
  }
  const CLASS_SLUGS_RU = window.ClassRules.RU_NAMES;
  const classSlugOf = entry => window.ClassRules.slugOf(entry);
  // Число мастерств оружия по набору class_rules (только редакция 2024 задаёт поле weapon_mastery).
  const weaponMasteryCount = (edition, slug) => Number(window.Presets?.classRules(String(edition || '2014'), slug)?.weapon_mastery) || 0;
  function weaponMasteryOptions(classEntry, catalog) {
    const slug = classSlugOf(classEntry), prof = String(classEntry?.data?.weapons || '').toLocaleLowerCase();
    return (catalog || []).filter(e => {
      if (e.category !== 'item' || e.data?.type !== 'weapon' || !e.data?.mastery) return false;
      const category = String(e.data.category || '');
      if (slug === 'monk') return category === 'Простое рукопашное' || (category === 'Воинское рукопашное' && (e.data.properties || []).some(p => /лёгкое/i.test(p)));
      return (category.startsWith('Простое') && prof.includes('простое оружие')) || (category.startsWith('Воинское') && prof.includes('воинское оружие'));
    });
  }
  // ---------- Заклинания: лимиты класса на 1 уровне ----------
  function spellLimits(classEntry, edition, abilities = {}, ruleChoices = {}) {
    const slug = window.ClassRules.slugOf(classEntry);
    const prog = classEntry?.data?.progression || window.Mechanics?.classProgression?.(classEntry?.data?.mechanics, edition) || window.Presets?.classProgression(edition, slug);
    const row = prog?.levels?.['1'];
    if (!row) return null; // homebrew-класс без таблицы развития остаётся решением мастера
    const mod = modifier(abilities[classEntry?.data?.spellcasting || 'int'] ?? 10);
    let spells = 0, mode = 'none';
    const start = window.ClassRules.startMode(classEntry, edition);
    if (start === 'book') { spells = 6; mode = 'book'; } // стартовая книга заклинаний
    else if (start === 'prepared') { spells = Math.max(1, 1 + mod); mode = 'prepared'; }
    else if (row.known !== null && row.known !== undefined) { spells = Math.max(0, Number(row.known) || 0); mode = spells ? 'known' : 'none'; }
    else if (row.prepared !== null && row.prepared !== undefined) { spells = Math.max(0, Number(row.prepared) || 0); mode = spells ? 'known' : 'none'; }
    const slots = {};
    (row.slots || []).forEach((count, i) => { if (Number(count) > 0) slots[i + 1] = { max: Number(count), used: 0 }; });
    if (row.pact_slots && row.pact_level) {
      const level = Number(row.pact_level), current = slots[level]?.max || 0;
      slots[level] = { max: current + Number(row.pact_slots), used: 0 };
    }
    const extraCantrip = edition === '2024' && ((slug === 'cleric' && ruleChoices.clericOrder === 'thaumaturge') || (slug === 'druid' && ruleChoices.druidOrder === 'magician')) ? 1 : 0;
    const preparedCount = window.ClassRules.startMode(classEntry, edition) === 'book' ? Math.max(1, 1 + modifier(abilities[classEntry?.data?.spellcasting || 'int'] ?? 10)) : null;
    return { cantrips: Math.max(0, Number(row.cantrips) || 0) + extraCantrip, spells, mode, preparedCount, slots, maxLevel: Math.max(0, ...(row.slots || []).map((n, i) => Number(n) > 0 ? i + 1 : 0), Number(row.pact_level) || 0) };
  }
  /// Навыки, которые дают модули, и выбор класса: сколько выбрать и что уже занято.
  const SKILL_SOURCES = { race: 'раса', class: 'класс', background: 'предыстория' };
  const sourceLabel = item => [SKILL_SOURCES[item.kind] || item.kind, item.source].filter(Boolean).join(' · ');
  function skillsState(draft) {
    const context = mechanicsContext(draft, 1);
    const granted = [...passiveSkills(draft.selected?.race, 'race', context), ...passiveSkills(draft.selected?.class, 'class', context), ...passiveSkills(draft.selected?.background, 'background', context), ...choiceSkills(draft)];
    const unique = []; for (const item of granted) if (!unique.some(x => x.key === item.key)) unique.push(item);
    const taken = new Set(unique.map(g => g.key));
    const klass = draft.selected?.class;
    const data = ((klass && window.Mechanics?.passiveData?.(klass, context)) || klass)?.data || {};
    const from = Array.isArray(data.skills?.from) ? data.skills.from : [];
    const choose = Math.max(0, Math.min(Number(data.skills?.choose) || 0, from.length));
    const options = from.map(name => {
      const key = skillKey(name);
      if (!key) return null;
      const grant = unique.find(g => g.key === key);
      return { key, name: skillName(key), ability: (SKILLS.find(([k]) => k === key) || [])[2] || 'str', granted: grant ? sourceLabel(grant) : '' };
    }).filter(Boolean);
    const picked = (draft.skills || []).filter(key => options.some(o => o.key === key) && !taken.has(key));
    const source = klass?.name || '';
    // Правило PHB (2014) и SRD 2024: владение из двух источников не складывается — вместо
    // совпавшего навыка игрок берёт любой другой. Считаем такие замены отдельным списком.
    const overlap = options.filter(o => o.granted);
    const freeOptions = SKILLS.map(([key, name, ability]) => ({ key, name, ability, granted: unique.find(g => g.key === key) ? sourceLabel(unique.find(g => g.key === key)) : '' }))
      .filter(o => !o.granted && !picked.includes(o.key));
    const freeNeed = Math.min(overlap.length, freeOptions.length);
    const freePicked = (draft.freeSkills || []).filter(key => freeOptions.some(o => o.key === key));
    return { granted: unique, klass: options.length && choose ? { source, choose, options, picked, overlap } : null,
      free: freeNeed ? { need: freeNeed, options: freeOptions, picked: freePicked, overlap } : null };
  }
  // ---------- Сборка листа: draft + выбранные модули → готовый лист ----------
  // Особенности расы и родословной — набор race_rules (по редакции). Запись линии переопределяет поля корня,
  // остальное наследуется от корня (владения оружием, например, относятся ко всем линиям расы).
  function raceRules(entry, rootNameEn, edition) {
    const items = window.Presets?.items('race_rules', edition) || [];
    const byName = en => { const key = String(en || '').toLowerCase(); return key ? items.find(i => String(i.table?.name_en || '').toLowerCase() === key)?.table : undefined; };
    const root = byName(rootNameEn), own = byName(entry?.data?.name_en);
    return { ...(root || {}), ...(own && own !== root ? own : {}) };
  }
  // Выборы расы из набора race_rules: навыки, варианты, заговоры и черты. Варианты заклинаний и черт
  // берутся из справочника по фильтру набора, поэтому кастомная раса описывается только данными.
  function raceChoices(draft) {
    const race = draft.selected?.race;
    if (!race) return [];
    const rootName = race.data?.parent || race.name;
    const rootEntry = (draft.catalog || []).find(e => e.category === 'race' && e.name === rootName && !e.data?.parent);
    const rootNameEn = String(rootEntry?.data?.name_en || race.data?.name_en || '').toLowerCase();
    const catalog = draft.catalog || [];
    return (raceRules(race, rootNameEn, draft.edition || '2014').choices || []).map(c => {
      const choice = { ...JSON.parse(JSON.stringify(c)), required: c.optional !== true };
      if (c.kind === 'skills') choice.options = SKILLS.map(([key, label]) => ({ value: key, name: label }));
      if (c.kind === 'spell') {
        const level = Number(c.filter?.level ?? 0), classes = c.filter?.classes || [];
        choice.options = catalog.filter(e => e.category === 'spell' && Number(e.data?.level) === level
          && (e.data?.classes || []).some(k => classes.includes(String(k).toLowerCase())))
          .map(e => ({ value: e.id, name: e.name, text: e.data?.desc || '' }));
      }
      if (c.kind === 'feat') {
        const selectedFeat = normalizeName(draft.selected?.feat?.name || '');
        choice.options = catalog.filter(e => e.category === 'feat'
          && !(c.filter?.no_prerequisites && e.data?.prerequisites)
          && !(c.filter?.exclude_selected_feat && normalizeName(e.name) === selectedFeat))
          .map(e => ({ value: e.id, name: e.name, text: e.data?.desc || '' }));
      }
      return choice;
    });
  }
  // Что мешает пройти шаг выбора расы; пустая строка — выборы сделаны.
  function raceChoiceProblem(draft) {
    for (const c of raceChoices(draft)) {
      if (!c.required) continue;
      const picked = draft.ruleChoices?.[c.key];
      if (c.kind === 'skills') {
        if ((picked || []).length !== c.count) return `Выберите ${c.count} навыка в разделе «${c.title}».`;
      } else if (!(c.options || []).some(o => o.value === picked)) return `Сделайте выбор в разделе «${c.title}».`;
    }
    return '';
  }
  function build(draft) {
    const s = { name: draft.name.trim(), edition: draft.edition, level: 1, alignment: draft.alignment || '', abilities: { ...draft.abilities },
      race: '', class: '', subclass: '', background: '', classes: [], proficiency_bonus: 2, saving_throws: [], skills: [...new Set([...(draft.skills || []), ...(draft.freeSkills || [])])], expertise: [],
      hp: { max: 0, current: 0, temp: 0, hit_dice: '1d8' }, speed: 30, features: [], ac: 10, auto_armor: true, unarmored_defense: '',
      spells: { ability: '', slots: {}, known: [] }, proficiencies: '', notes: '', modules: [],
      inventory: [], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
      traits: Object.fromEntries(['player_name', 'faith', 'age', 'height', 'weight', 'eyes', 'skin', 'hair', 'personality', 'ideals', 'bonds', 'flaws', 'appearance', 'backstory'].map(k => [k, String(draft.traits?.[k] || '')])) };
    const picks = draft.picks || {}, chosen = [], context = mechanicsContext(draft, 1);
    const entries = ['race', 'class', 'subclass', 'background', 'feat'].map(k => draft.selected[k]).filter(Boolean).concat(draft.spells || []);
    const graphHpBonuses = [];
    const race = draft.selected.race;
    if (race?.data?.parent) {
      const candidates = (draft.catalog || []).filter(e => e.category === 'race' && e.name === race.data.parent && !e.data?.subrace);
      const parent = candidates.find(e => e.pack_id === race.pack_id && e.source === race.source) || candidates[0];
      if (parent) entries.unshift(parent);
    }
    for (const raw of entries) {
      let e = window.Mechanics ? Mechanics.passiveData(raw, context) : raw;
      if (e.category === 'subclass' && e.data?.features) {
        const features = { ...e.data.features }, selections = draft.ruleChoices?.subclassVariants || {};
        for (const level of Object.keys(features)) for (const group of subclassVariantGroups(e, Number(level))) {
          const selected = selections[group.base];
          features[level] = features[level].filter(name => !group.options.includes(name) || name === selected);
        }
        e = { ...e, data: { ...e.data, features } };
      }
      handlers.get(e.category)?.(s, e);
      // Explicit passive blocks also work on homebrew categories, not just the old
      // race/class fields. The build remains a pure projection, so bonuses never stack on rebuild.
      if (!window.Mechanics?.passiveData) for (const p of mechanicsPrograms(e.data?.mechanics, context)) if(p.trigger==='passive')for(const b of p.blocks||[])if(b.kind==='passive'&&b.enabled!==false){
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

      // Явный выбор игрока («либо / либо»): применяется один раз, как и остальные проекции.
      for (const group of e.data?.choices || []) {
        const picked = asList(picks[group.id]).slice(0, Math.max(0, Number(group.count) || 0));
        for (const id of picked) {
          const option = (group.options || []).find(o => o.id === id);
          if (!option) continue;
          applyChoice(s, group, option, e.name);
          chosen.push({ group_id: group.id, group: group.name, type: group.type, source: e.name, option_id: option.id, name: option.name });
        }
      }
      for (const t of e.data?.traits || []) feature(s, t.name, t.text, e.name, t.mechanics || window.Mechanics?.forFeature(e.data?.mechanics,t.name,context));
      const custom=mechanicsPrograms(e.data?.mechanics, context).filter(p=>p.trigger==='use'&&!p.feature_name);
      if(custom?.length&&e.category!=='spell'&&e.category!=='feat')feature(s,e.name,e.data.desc,e.source,{version:1,programs:JSON.parse(JSON.stringify(custom))});
      s.modules.push({ schema_version: 1, entry_id: e.id, category: e.category, source: e.source, pack_id: e.pack_id || null, snapshot: JSON.parse(JSON.stringify(e)) });
      if (window.Mechanics?.applyGraphRules) {
        const applied = Mechanics.applyGraphRules(e.data?.mechanics, s, { ...context, source: e.name });
        if (!applied.error) graphHpBonuses.push(...applied.effects.filter(effect => effect.kind === 'hp_bonus').map(effect => Number(effect.amount) || 0));
      }
    }
    const classEntry = draft.selected.class;
    const classSlug = window.ClassRules.slugOf(classEntry);
    // Защита без доспехов — пассивный блок записи класса (поле unarmored_defense), а не проверка по имени класса.
    const classRule = passiveFieldValue(classEntry, 'unarmored_defense');
    if (classRule && typeof classRule === 'object') s.unarmored_defense = JSON.parse(JSON.stringify(classRule));
    const raceEntry = draft.selected.race, raceRoot = raceEntry?.data?.parent || raceEntry?.name;
    const raceParentEntry = (draft.catalog || []).find(e => e.category === 'race' && e.name === raceRoot && !e.data?.parent);
    const raceRootNameEn = String(raceParentEntry?.data?.name_en || raceEntry?.data?.name_en || '').toLowerCase();
    const rr = raceRules(raceEntry, raceRootNameEn, s.edition);
    const ruleChoices = draft.ruleChoices || {};
    for (const key of ruleChoices.raceSkills || []) if (SKILLS.some(([skill]) => skill === key)) s.skills.push(key);
    if (rr.speed) s.speed = rr.speed;
    if (rr.weapons?.length) appendProficiency(s, 'Оружие расы', rr.weapons);
    for (const c of raceChoices(draft)) if (c.kind === 'options' && c.grant && ruleChoices[c.key]) appendProficiency(s, c.grant, [ruleChoices[c.key]]);
    if (classSlug === 'bard' && (ruleChoices.bardInstruments || []).length)
      appendProficiency(s, 'Музыкальные инструменты', ruleChoices.bardInstruments);
    if (s.edition === '2014' && classSlug === 'ranger') {
      if (ruleChoices.favoredEnemy) {
        const favored = ruleChoices.favoredEnemy === 'Гуманоиды' ? `Гуманоиды: ${ruleChoices.favoredHumanoidOne}, ${ruleChoices.favoredHumanoidTwo}.` : `Тип существ: ${ruleChoices.favoredEnemy}.`;
        feature(s, 'Избранный враг: ' + ruleChoices.favoredEnemy, favored, classEntry.name);
        if (ruleChoices.favoredLanguage) appendProficiency(s, 'Язык класса', [ruleChoices.favoredLanguage]);
      }
      if (ruleChoices.favoredTerrain) feature(s, 'Природный исследователь: ' + ruleChoices.favoredTerrain, `Выбрана местность: ${ruleChoices.favoredTerrain}.`, classEntry.name);
    }
    for (const c of raceChoices(draft)) {
      const picked = ruleChoices[c.key];
      if (!picked) continue;
      if (c.kind === 'options' && c.feature_name) {
        const option = (c.options || []).find(o => o.value === picked);
        if (option?.feature_text) feature(s, `${c.feature_name}: ${picked}`, option.feature_text, raceEntry.name);
      }
      if (c.kind === 'feat') {
        const featEntry = (draft.catalog || []).find(e => e.category === 'feat' && e.id === picked);
        if (featEntry) {
          handlers.get('feat')?.(s, featEntry);
          s.modules.push({ schema_version: 1, entry_id: featEntry.id, category: 'feat', source: featEntry.source, pack_id: featEntry.pack_id || null, snapshot: JSON.parse(JSON.stringify(featEntry)) });
        }
      }
    }
    if (s.edition === '2014' && classSlug === 'fighter') {
      const style = draft.ruleChoices?.fightingStyle;
      if (style && classEntry.data?.feature_texts?.[style]) feature(s, style, classEntry.data.feature_texts[style], classEntry.name);
    }
    if (s.edition === '2024' && classSlug === 'fighter') {
      const style = (draft.catalog || []).find(e => e.category === 'feat' && e.id === draft.ruleChoices?.fightingStyleFeat);
      if (style) {
        feature(s, style.name, style.data?.desc || '', classEntry.name, style.data?.mechanics);
        s.modules.push({ schema_version: 1, entry_id: style.id, category: 'feat', source: style.source, pack_id: style.pack_id || null, snapshot: JSON.parse(JSON.stringify(style)) });
      }
    }
    if (s.edition === '2024' && classSlug === 'cleric' && draft.ruleChoices?.clericOrder) {
      if (draft.ruleChoices.clericOrder === 'protector') appendProficiency(s, 'Божественный орден', ['Воинское оружие', 'Тяжёлые доспехи']);
      feature(s, 'Божественный орден: ' + (draft.ruleChoices.clericOrder === 'protector' ? 'Защитник' : 'Чудотворец'),
        draft.ruleChoices.clericOrder === 'protector' ? 'Получено владение воинским оружием и тяжёлыми доспехами.' : 'Получен один дополнительный заговор из списка жреца; примените выбранную характеристику и бонус к проверкам Магии или Религии согласно правилам.', classEntry.name);
    }
    if (s.edition === '2014' && classSlug === 'cleric' && /life/i.test(String(draft.selected.subclass?.data?.name_en || '')))
      appendProficiency(s, 'Домен жизни', ['Тяжёлые доспехи']);
    if (s.edition === '2024' && classSlug === 'druid' && draft.ruleChoices?.druidOrder) {
      if (draft.ruleChoices.druidOrder === 'warden') appendProficiency(s, 'Первобытный орден', ['Воинское оружие', 'Средние доспехи']);
      feature(s, 'Первобытный орден: ' + (draft.ruleChoices.druidOrder === 'magician' ? 'Маг' : 'Страж'),
        draft.ruleChoices.druidOrder === 'magician' ? 'Получен один дополнительный заговор друида; примените бонус к проверкам Магии или Природы согласно правилам.' : 'Получено владение воинским оружием и средними доспехами.', classEntry.name);
    }
    if (classSlug === 'rogue') appendProficiency(s, 'Инструменты класса', ['Воровские инструменты']);
    const featName = String(draft.selected.background?.data?.feat || '').trim();
    if (featName && !draft.selected.feat) feature(s, featName, 'Черта предыстории указана текстом; запись черты не найдена в справочнике.', draft.selected.background.name);
    if (s.edition === '2024') for (const k of keys) s.abilities[k] += Number(draft.bonuses?.[k]) || 0;
    const creationClassSlug = window.ClassRules.slugOf(draft.selected.class);
    const chosenLanguages = [...(draft.languages || [])];
    if (s.edition === '2024') chosenLanguages.unshift('Общий');
    appendProficiency(s, 'Языки', chosenLanguages);
    if (creationClassSlug === 'druid') appendProficiency(s, 'Язык класса', ['Друидический']);
    if (creationClassSlug === 'rogue') appendProficiency(s, 'Язык класса', ['Воровской жаргон']);
    s.skills = [...new Set(s.skills)];
    const expertiseChoices = [...new Set(draft.ruleChoices?.expertise || [])];
    s.expertise = expertiseChoices.filter(k => s.skills.includes(k) || (s.edition === '2014' && creationClassSlug === 'rogue' && k === 'thieves_tools')).slice(0, 2);
    if (s.edition === '2014' && creationClassSlug === 'rogue' && expertiseChoices.includes('thieves_tools')) appendProficiency(s, 'Экспертиза инструмента', ['Воровские инструменты']);
    const masteryNames = (draft.ruleChoices?.weaponMasteries || []).map(id => (draft.catalog || []).find(e => e.id === id)).filter(Boolean).map(entryName);
    if (masteryNames.length) feature(s, 'Выбранное мастерство оружия', `Выбранные виды оружия: ${masteryNames.join(', ')}.`, classEntry?.name || 'Класс');
    const spellRule = spellLimits(draft.selected.class, s.edition, s.abilities, draft.ruleChoices || {});
    if (spellRule) {
      s.spells.slots = spellRule.slots;
      for (const spell of s.spells.known) spell.prepared = spell.level === 0 || (spellRule.mode === 'book' ? (draft.preparedSpells || []).includes(spell.name) : ['known', 'prepared'].includes(spellRule.mode));
    }
    const alwaysPrepared = [];
    if (s.edition === '2024' && creationClassSlug === 'druid') alwaysPrepared.push('Разговор с животными');
    if (s.edition === '2024' && creationClassSlug === 'ranger') alwaysPrepared.push('Метка охотника');
    alwaysPrepared.push(...(rr.always_prepared || []));
    if (s.edition === '2014' && creationClassSlug === 'cleric' && /life/i.test(String(draft.selected.subclass?.data?.name_en || '')))
      alwaysPrepared.push('Благословение', 'Лечение ран');
    for (const name of alwaysPrepared) {
      const found = (draft.catalog || []).find(e => e.category === 'spell' && normalizeName(entryName(e)) === normalizeName(name));
      if (found && !s.spells.known.some(spell => normalizeName(spell.name) === normalizeName(entryName(found)))) {
        const spell = Modules.spellFromCompendium(found); spell.prepared = true; s.spells.known.push(spell);
      }
    }
    // Заговоры расы: выбранные заговоры (kind 'spell' в choices) и фиксированные из набора; ability 'choice' — выбранная характеристика.
    const racialCantrips = [];
    for (const c of raceChoices(draft)) {
      if (c.kind !== 'spell' || !ruleChoices[c.key]) continue;
      const cantrip = (draft.catalog || []).find(e => e.category === 'spell' && e.id === ruleChoices[c.key]);
      if (cantrip) racialCantrips.push({ entry: cantrip, ability: c.ability });
    }
    for (const c of rr.cantrips || []) {
      const found = (draft.catalog || []).find(e => e.category === 'spell' && normalizeName(entryName(e)) === normalizeName(c.name));
      if (found) racialCantrips.push({ entry: found, ability: c.ability === 'choice' ? ruleChoices.raceSpellAbility : c.ability });
    }
    for (const { entry, ability } of racialCantrips) {
      const existing = s.spells.known.find(spell => normalizeName(spell.name) === normalizeName(entryName(entry)));
      if (existing) { existing.prepared = true; if (ability) existing.spell_ability = ability; }
      else { const spell = Modules.spellFromCompendium(entry); spell.prepared = true; if (ability) spell.spell_ability = ability; s.spells.known.push(spell); }
    }
    // Magic Initiate spells are granted independently of the class spell table.
    // Store the feat's ability on each spell so multiclass/class casting stats remain intact.
    const initiate = ruleChoices.magicInitiate;
    if (initiate) for (const id of [...(initiate.cantrips || []), initiate.firstLevel].filter(Boolean)) {
      const entry = (draft.catalog || []).find(e => e.id === id && e.category === 'spell');
      if (!entry) continue;
      const existing = s.spells.known.find(spell => normalizeName(spell.name) === normalizeName(entryName(entry)));
      const spell = existing || Modules.spellFromCompendium(entry);
      spell.prepared = true;
      spell.spell_ability = initiate.ability;
      if (!existing) s.spells.known.push(spell);
    }
    const ancestryHp = Number(rr.hp_bonus) || 0;
    s.hp.max = s.hp.current = Math.max(1, Number(s.hp.hit_dice.split('d')[1]) + modifier(s.abilities.con)) + ancestryHp + graphHpBonuses.reduce((sum, amount) => sum + amount, 0);
    // Стартовое снаряжение: предметы справочника со стопками, слотами и расходом боеприпасов.
    const starting = startingInventory(draft);
    s.inventory = starting.inventory;
    s.currency.gp = starting.gold;
    if (draft.equipment?.autoEquip !== false && window.Equipment?.equipDefaults) window.Equipment.equipDefaults(s.inventory);
    s.ac = window.Equipment?.armorClassParts ? window.Equipment.armorClassParts(s).ac : 10 + modifier(s.abilities.dex);
    if (s.class) s.classes = [{ name: s.class, level: 1, subclass: s.subclass || '', hit_die: Number(String(s.hp.hit_dice).replace(/\D/g, '')) || 8,
      subclass_choices: JSON.parse(JSON.stringify(draft.ruleChoices?.subclassVariants || {})) }];
    s.creation = { version: 1, method: draft.method, base_abilities: { ...draft.abilities }, rolls: draft.rolls || [], choices: chosen, rule_choices: JSON.parse(JSON.stringify(draft.ruleChoices || {})), equipment: { gold: starting.gold, items: s.inventory.length } };
    return s;
  }
  /// Короткая подсказка варианта: что именно он даёт персонажу.
  function choiceHint(group, option) {
    const v = option?.value;
    if (group.type === 'ability') {
      const pairs = Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).filter(([, n]) => Number(n));
      return pairs.length ? el('small', {}, pairs.map(([k, n]) => `${n > 0 ? '+' : ''}${n} ${ABIL[k] || k}`).join(', ')) : null;
    }
    if (group.type === 'skill') { const arr = asList(v); return arr.length ? el('small', {}, arr.map(skillName).join(', ')) : null; }
    if (group.type === 'language') { const arr = asList(v); return arr.length ? el('small', {}, arr.join(', ')) : null; }
    if (group.type === 'feature') { const t = String(v && v.text || '').trim(); return t ? el('small', {}, t.length > 180 ? t.slice(0, 180) + '…' : t) : null; }
    if (group.type === 'proficiency') { const t = String(asList(v)[0] || '').trim(); return t ? el('small', {}, t) : null; }
    return null;
  }
  function skillsLabel(arr) { return arr.length ? 'Навыки: ' + arr.map(skillName).join(', ') : 'Выберите навыки'; }
  /// Поле значения варианта по типу группы. Текст правится без перерисовки, чтобы не терять фокус.
  function choiceValueField(g, o) {
    if (g.type === 'ability') {
      const bonus = (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) ? o.value : (o.value = {});
      return el('div', { class: 'row ability-bonus' }, ...keys.map(k => el('label', { class: 'small' }, ABIL[k].slice(0, 3),
        el('input', { type: 'number', min: -5, max: 5, step: 1, value: Number(bonus[k]) || 0, style: 'width:58px',
          oninput: e => { const n = Math.max(-5, Math.min(5, Math.round(Number(e.target.value) || 0))); if (n) bonus[k] = n; else delete bonus[k]; } }))));
    }
    if (g.type === 'skill') {
      const arr = Array.isArray(o.value) ? o.value : (o.value = []);
      const sum = el('summary', {}, skillsLabel(arr));
      return el('details', {}, sum, el('div', { class: 'block-checks' }, ...(SKILLS || []).map(([k, n]) =>
        el('label', {}, el('input', { type: 'checkbox', checked: arr.includes(k) ? '' : null, onchange: ev => {
          const next = arr.filter(x => x !== k); if (ev.target.checked) next.push(k);
          o.value = next; sum.textContent = skillsLabel(next);
        } }), n))));
    }
    if (g.type === 'language') {
      const arr = Array.isArray(o.value) ? o.value : (o.value = []);
      return el('input', { value: arr.join(', '), placeholder: 'Общий, Эльфийский', oninput: e => o.value = e.target.value.split(',').map(x => x.trim()).filter(Boolean).slice(0, CHOICE_MAX.options) });
    }
    if (g.type === 'feature') {
      const obj = (o.value && typeof o.value === 'object') ? o.value : (o.value = { text: '' });
      return el('input', { value: obj.text || '', placeholder: 'Что даёт умение', style: 'flex:2', oninput: e => obj.text = e.target.value });
    }
    return el('input', { value: typeof o.value === 'string' ? o.value : (o.value = ''), placeholder: 'Военное оружие, лёгкие доспехи…', oninput: e => o.value = e.target.value });
  }
  /// Редактор вариантов выбора записи справочника (раса / класс / предыстория).
  // ---------- Редактор выборов «либо / либо» для записей справочника ----------
  function choiceEditor(data) {
    if (!Array.isArray(data.choices)) data.choices = [];
    const groups = data.choices, root = el('div', { class: 'choices-editor' });
    const f = (label, node) => el('label', { class: 'field' }, el('span', {}, label), node);
    // Проверка обновляется на каждое правку: текст ошибки не должен оставаться устаревшим.
    const error = el('p', { class: 'choice-error small' });
    const refreshError = () => { error.textContent = validateChoices(groups) || ''; error.style.display = error.textContent ? '' : 'none'; };
    root.addEventListener('input', refreshError);
    root.addEventListener('change', refreshError);
    function render() {
      root.replaceChildren();
      root.append(el('p', { class: 'muted small' }, 'Игрок выбирает один или несколько вариантов при создании персонажа: бонус характеристики, навык, язык, умение или владение.'));
      groups.forEach((g, i) => {
        const opts = el('div', { class: 'choice-options' });
        (g.options || []).forEach((o, j) => opts.append(el('div', { class: 'row choice-option' },
          el('input', { value: o.name || '', placeholder: 'Название варианта', style: 'flex:2', oninput: e => o.name = e.target.value }),
          choiceValueField(g, o),
          g.type === 'feature' ? el('button', { class: 'small', style: 'flex:0', onclick: async () => {
            const cur = (o.value && typeof o.value === 'object') ? o.value : (o.value = { text: '' });
            const r = await window.Modules.editFeature(window.Modules.newFeature({ name: o.name, text: cur.text || '', mechanics: cur.mechanics }));
            if (r) { o.name = r.name; o.value = { ...cur, text: r.text, mechanics: r.mechanics }; render(); }
          } }, 'Блоки') : null,
          el('button', { class: 'small danger', style: 'flex:0', onclick: () => { g.options.splice(j, 1); render(); } }, icon('close')))));
        root.append(el('div', { class: 'choice-group' },
          el('div', { class: 'row' },
            el('input', { value: g.name || '', placeholder: 'Например: Родословная дракона', style: 'flex:3', oninput: e => g.name = e.target.value }),
            el('select', { onchange: e => { g.type = e.target.value; for (const o of g.options || []) o.value = newChoiceOption(g.type).value; render(); } },
              ...Object.entries(CHOICE_TYPES).map(([k, n]) => el('option', { value: k, selected: g.type === k ? '' : null }, n))),
            f('Сколько', el('input', { type: 'number', min: 0, max: CHOICE_MAX.options, value: g.count ?? 1, style: 'width:76px',
              oninput: e => g.count = Math.max(0, Math.min(CHOICE_MAX.options, Math.round(Number(e.target.value) || 0))) })),
            el('label', { class: 'row small', style: 'gap:4px;flex:0;white-space:nowrap' }, el('input', { type: 'checkbox', style: 'width:auto', checked: g.optional ? '' : null, onchange: e => g.optional = e.target.checked }), 'необязательно'),
            el('button', { class: 'small danger', style: 'flex:0', onclick: () => { groups.splice(i, 1); render(); } }, 'Удалить')),
          opts,
          el('button', { class: 'small', onclick: () => { (g.options || (g.options = [])).push(newChoiceOption(g.type)); const c = Number(g.count); g.count = Math.min(Number.isFinite(c) ? Math.max(0, c) : 1, g.options.length); render(); } }, '+ Вариант')));
      });
      root.append(el('button', { class: 'small', onclick: () => { if (groups.length >= CHOICE_MAX.groups) return toast(`Не более ${CHOICE_MAX.groups} групп выбора.`); groups.push(newChoiceGroup('ability')); render(); } }, '+ Группа выбора'));
      refreshError(); root.append(error);
    }
    render();
    return el('div', { class: 'field' }, el('span', {}, 'Варианты выбора при создании персонажа'), root);
  }
  function rollStats(random) {
    const results = keys.map(() => DiceEngine.evaluate('4d6kh3', random));
    if (!random) DiceEngine.present({ label: 'Характеристики персонажа · 4d6, три лучших', rolls: results.map((r, i) => ({ ...r, name: `Набор ${i + 1}` })) }, { local: true });
    return results.map(r => { const p = r.parts[0]; return { dice: p.rolls, dropped: p.rolls.findIndex((_, i) => !p.kept_indices.includes(i)), total: r.total }; });
  }
  function rollD20Stats(random) {
    const results = keys.map(() => DiceEngine.evaluate('1d20', random));
    if (!random) DiceEngine.present({ label: 'Характеристики персонажа · 6 × 1d20 (вариант стола)', rolls: results.map((r, i) => ({ ...r, name: `${ABIL[keys[i]] || keys[i]}` })) }, { local: true });
    return results.map(r => ({ dice: r.parts[0].rolls, dropped: -1, total: r.total }));
  }
  return { register, build, raceChoices, raceChoiceProblem, rollStats, rollD20Stats, keys, short, ALIGNMENTS, LANGUAGES, LANGUAGES_2024_STANDARD, CHOICE_TYPES, CHOICE_MAX, validateChoices, applyChoice, choiceState, newChoiceGroup, newChoiceOption, choiceEditor, choiceHint, asList, moduleChoices,
    parseEquipmentText, parseItemList, parseItemToken, findItemTemplate, equipmentPlan, equipmentItems, startingInventory, packContents, skillsState, passiveSkills, itemKind, PICK_FILTERS, SKILL_SOURCES, sourceLabel, subclassLevel, subclassModule, subclassVariantGroups, backgroundFeatModule, pointBuyTotal, pointBuyValid, spellLimits,
    normalizeName, classSlugOf, weaponMasteryCount, weaponMasteryOptions, CLASS_SLUGS_RU, POINT_BUY_COST };
})();
