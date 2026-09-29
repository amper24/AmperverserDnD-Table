// Creation is a pure projection of a draft + compendium snapshots, never an incremental mutation.
window.CharacterBuilder = (() => {
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const short = { СИЛ: 'str', ЛОВ: 'dex', ТЕЛ: 'con', ИНТ: 'int', МДР: 'wis', ХАР: 'cha' };
  const ALIGNMENTS = ['', 'Законно-доброе', 'Нейтрально-доброе', 'Хаотично-доброе', 'Законно-нейтральное', 'Нейтральное', 'Хаотично-нейтральное', 'Законно-злое', 'Нейтрально-злое', 'Хаотично-злое', 'Без мировоззрения'];
  const LANGUAGES = ['Общий', 'Дварфийский', 'Эльфийский', 'Великаний', 'Гномий', 'Гоблинский', 'Полуросличий', 'Орочий', 'Абиссальный', 'Небесный', 'Драконий', 'Глубинная речь', 'Инфернальный', 'Первичный', 'Сильван', 'Подземный общий'];
  const modifier = n => Math.floor((n - 10) / 2);
  const appendProficiency = (s, label, values) => {
    const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
    const text = list.map(x => String(x || '').trim()).filter(Boolean).join(', ');
    if (text && !s.proficiencies.includes(text)) s.proficiencies += `${label}: ${text}\n`;
  };
  const handlers = new Map();
  const register = (category, apply) => handlers.set(category, apply);
  const feature = (s, name, text, source, mechanics) => s.features.push(Modules.newFeature({ name, text: text || '', source, mechanics }));
  register('race', (s, e) => {
    const d = e.data || {}; s.race = d.parent ? `${d.parent} (${e.name})` : e.name; if (d.speed) s.speed = d.speed;
    if (s.edition === '2014') for (const k of keys) s.abilities[k] += Number(d.asi?.[k]) || 0;
    appendProficiency(s, 'Языки расы', d.languages);
  });
  register('class', (s, e) => {
    const d = e.data || {}; s.class = e.name; s.saving_throws = [...(d.saves || [])];
    s.hp.hit_dice = '1' + (d.hit_die || 'd8'); s.spells.ability = d.spellcasting || '';
    for (const name of d.features?.['1'] || []) feature(s, name, d.feature_texts?.[name], e.name, window.Mechanics?.forFeature(d.mechanics,name));
    appendProficiency(s, 'Доспехи', d.armor);
    appendProficiency(s, 'Оружие', d.weapons);
    appendProficiency(s, 'Инструменты', d.tools);
  });
  register('background', (s, e) => {
    const d = e.data || {}; s.background = e.name;
    for (const name of Array.isArray(d.skills)?d.skills:[]) { const skill = SKILLS.find(([k, n]) => k === name || n === name); if (skill) s.skills.push(skill[0]); }
    appendProficiency(s, 'Инструменты предыстории', d.tools);
    appendProficiency(s, 'Языки предыстории', Array.isArray(d.languages) || typeof d.languages === 'string' ? d.languages : null);
    if (d.feature) feature(s, d.feature, d.feature_text, e.name, window.Mechanics?.forFeature(d.mechanics,d.feature));
    if (d.feat) feature(s, d.feat, 'Описание и варианты выбора — в справочнике черт.', e.name);
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
  const skillKey = name => (SKILLS || []).find(([k, n]) => k === name || n === name)?.[0];
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
    const options = pickOptions(token.filter, catalog);
    const explicit = options.find(e => e.id === equipment.picks?.[key]) || (catalog || []).find(e => e.id === equipment.picks?.[key]);
    return explicit || (token.prefer ? findItemTemplate(token.prefer, options) : null) || options[0] || null;
  }
  /// Что игрок выбрал и что из этого попадёт в инвентарь (шаблоны — из справочника предметов).
  function equipmentItems(draft) {
    const equip = draft.equipment || {};
    const catalog = (draft.catalog || []).filter(e => e.category === 'item');
    const expandPacks = equip.packs !== false;
    const items = [];
    let gold = Number(equip.gold) || 0;
    for (const block of equipmentPlan(draft)) {
      let tokens = block.tokens || [], option = null;
      if (block.kind === 'group') {
        option = block.options.find(o => o.id === (equip.choice?.[block.id] ?? block.options[0]?.id)) || block.options[0];
        tokens = option?.tokens || [];
      }
      tokens.forEach((token, index) => {
        const stem = `${block.id}:${option ? option.id : '-'}`;
        if (token.kind === 'gold') { gold += token.amount; return; }
        if (token.kind === 'pick') for (let slot = 0; slot < (token.count || 1); slot++) {
          const key = `${stem}:p${index}:${slot}`;
          if (equip.exclude?.[key]) continue;
          const entry = pickEntry(token, key, equip, catalog);
          items.push({ key, pick: true, filter: token.filter, label: token.label, prefer: token.prefer || '', source: block.sourceName, qty: 1, entry, name: entry ? entryName(entry) : '' });
        }
        else {
          const key = `${stem}:i${index}`;
          if (equip.exclude?.[key]) return;
          const entry = catalog.find(e => e.id === equip.template?.[key]) || findItemTemplate(equip.name?.[key] || token.name, catalog) || null;
          items.push({ key, name: entry ? entryName(entry) : (equip.name?.[key] || token.name), qty: Math.max(1, Number(equip.qty?.[key] ?? token.qty) || 1), note: token.note, source: block.sourceName, entry });
        }
      });
    }
    for (const extra of equip.extras || []) {
      const entry = catalog.find(e => e.id === extra.entryId) || null;
      if (entry || extra.name) items.push({ key: extra.key, name: extra.name || entryName(entry), qty: Math.max(1, Number(extra.qty) || 1), note: '', source: 'Добавлено вручную', manual: true, entry });
    }
    // Наборы раскладываются на содержимое: сам набор остаётся строкой-контейнером,
    // а предметы из описания попадают в инвентарь по отдельности (и учитываются в весе).
    const expanded = [];
    for (const item of items) {
      const contents = expandPacks && item.entry ? packContents(item.entry, catalog) : null;
      if (!contents) { expanded.push(item); continue; }
      const packQty = Math.max(1, Number(equip.qty?.[item.key] ?? item.qty) || 1);
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
  function passiveSkills(entry) {
    if (!entry) return [];
    const out = [], add = name => { const key = skillKey(name); if (key && !out.some(x => x.key === key)) out.push({ key, name: skillName(key), ability: (SKILLS.find(([k]) => k === key) || [])[2] || 'str', source: entry.name }); };
    const data = entry.data || {};
    for (const name of Array.isArray(data.skills) ? data.skills : []) add(name);
    const passive = window.Mechanics?.passiveData?.(entry) || entry;
    for (const name of Array.isArray(passive?.data?.skills) ? passive.data.skills : []) add(name);
    for (const program of data.mechanics?.programs || []) if (program.trigger === 'passive')
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
          if (key && !out.some(x => x.key === key)) out.push({ key, name: skillName(key), ability: (SKILLS.find(([k]) => k === key) || [])[2] || 'str', source: entry.name });
        }
      }
    }
    return out;
  }
  /// Группы выбора «либо / либо», объявленные выбранными модулями.
  function moduleChoices(draft) {
    const out = [];
    for (const key of ['race', 'class', 'background']) {
      const entry = draft.selected?.[key];
      if (!entry) continue;
      for (const group of entry.data?.choices || []) out.push({ entry, group });
    }
    return out;
  }
  /// Навыки, которые дают модули, и выбор класса: сколько выбрать и что уже занято.
  function skillsState(draft) {
    const granted = [...passiveSkills(draft.selected?.race), ...passiveSkills(draft.selected?.class), ...passiveSkills(draft.selected?.background), ...choiceSkills(draft)];
    const unique = []; for (const item of granted) if (!unique.some(x => x.key === item.key)) unique.push(item);
    const taken = new Set(unique.map(g => g.key));
    const klass = draft.selected?.class;
    const data = ((klass && window.Mechanics?.passiveData?.(klass)) || klass)?.data || {};
    const from = Array.isArray(data.skills?.from) ? data.skills.from : [];
    const choose = Math.max(0, Math.min(Number(data.skills?.choose) || 0, from.length));
    const options = from.map(name => {
      const key = skillKey(name);
      if (!key) return null;
      const grant = unique.find(g => g.key === key);
      return { key, name: skillName(key), ability: (SKILLS.find(([k]) => k === key) || [])[2] || 'str', granted: grant ? grant.source : '' };
    }).filter(Boolean);
    const picked = (draft.skills || []).filter(key => options.some(o => o.key === key) && !taken.has(key));
    const source = klass?.name || '';
    return { granted: unique, klass: options.length && choose ? { source, choose, options, picked } : null };
  }
  function build(draft) {
    const s = { name: draft.name.trim(), edition: draft.edition, level: 1, alignment: draft.alignment || '', abilities: { ...draft.abilities },
      race: '', class: '', background: '', proficiency_bonus: 2, saving_throws: [], skills: [...(draft.skills || [])],
      hp: { max: 0, current: 0, temp: 0, hit_dice: '1d8' }, speed: 30, features: [], ac: 10, auto_armor: true,
      spells: { ability: '', slots: {}, known: [] }, proficiencies: '', notes: '', modules: [],
      inventory: [], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
      traits: Object.fromEntries(['player_name', 'faith', 'age', 'height', 'weight', 'eyes', 'skin', 'hair', 'personality', 'ideals', 'bonds', 'flaws', 'appearance', 'backstory'].map(k => [k, String(draft.traits?.[k] || '')])) };
    const picks = draft.picks || {}, chosen = [];
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
      for (const t of e.data?.traits || []) feature(s, t.name, t.text, e.name, t.mechanics || window.Mechanics?.forFeature(e.data?.mechanics,t.name));
      const custom=e.data?.mechanics?.programs?.filter(p=>p.trigger==='use'&&!p.feature_name);
      if(custom?.length&&e.category!=='spell')feature(s,e.name,e.data.desc,e.source,{version:1,programs:JSON.parse(JSON.stringify(custom))});
      s.modules.push({ schema_version: 1, entry_id: e.id, category: e.category, source: e.source, pack_id: e.pack_id || null, snapshot: JSON.parse(JSON.stringify(e)) });
    }
    if (s.edition === '2024') for (const k of keys) s.abilities[k] += Number(draft.bonuses?.[k]) || 0;
    appendProficiency(s, 'Языки', draft.languages);
    s.skills = [...new Set(s.skills)];
    s.hp.max = s.hp.current = Math.max(1, Number(s.hp.hit_dice.split('d')[1]) + modifier(s.abilities.con));
    // Стартовое снаряжение: предметы справочника со стопками, слотами и расходом боеприпасов.
    const starting = startingInventory(draft);
    s.inventory = starting.inventory;
    s.currency.gp = starting.gold;
    if (draft.equipment?.autoEquip !== false && window.Equipment?.equipDefaults) window.Equipment.equipDefaults(s.inventory);
    s.ac = window.Equipment?.armorClassParts ? window.Equipment.armorClassParts(s).ac : 10 + modifier(s.abilities.dex);
    s.creation = { version: 1, method: draft.method, base_abilities: { ...draft.abilities }, rolls: draft.rolls || [], choices: chosen, equipment: { gold: starting.gold, items: s.inventory.length } };
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
  return { register, build, rollStats, keys, short, ALIGNMENTS, LANGUAGES, CHOICE_TYPES, CHOICE_MAX, validateChoices, applyChoice, choiceState, newChoiceGroup, newChoiceOption, choiceEditor, choiceHint, asList, moduleChoices,
    parseEquipmentText, parseItemList, parseItemToken, findItemTemplate, equipmentPlan, equipmentItems, startingInventory, packContents, skillsState, passiveSkills, itemKind, PICK_FILTERS };
})();

window.newCharacterDialog = async function (defaults = {}) {
  const B = CharacterBuilder;
  const emptyEquipment = () => ({ choice: {}, picks: {}, exclude: {}, template: {}, qty: {}, name: {}, extras: [], gold: 0, packs: true, autoEquip: true });
  const emptyDraft = {
    name: defaults.name || '', edition: defaultEdition(), alignment: '',
    traits: Object.fromEntries(['player_name', 'faith', 'age', 'height', 'weight', 'eyes', 'skin', 'hair', 'personality', 'ideals', 'bonds', 'flaws', 'appearance', 'backstory'].map(k => [k, ''])),
    abilities: Object.fromEntries(B.keys.map((k, i) => [k, [15, 14, 13, 12, 10, 8][i]])),
    selected: {}, spells: [], skills: [], languages: [], bonuses: {}, picks: {}, method: 'standard', rolls: [], equipment: emptyEquipment()
  };
  const draft = JSON.parse(JSON.stringify(emptyDraft));
  const steps = ['Концепция', 'Происхождение', 'Характеристики', 'Навыки', 'Заклинания', 'Снаряжение', 'Личность', 'Проверка'];
  const stepTips = [
    'Задайте имя и выберите редакцию правил.',
    'Выберите расу, класс и предысторию — это записи-модули из справочника.',
    'Распределите характеристики: бросок, стандартный набор или ручной ввод.',
    'Отметьте навыки класса, проверьте языки и владения от модулей.',
    'Необязательный шаг: добавьте подходящие заклинания.',
    'Соберите стартовое снаряжение: предметы сразу попадут в инвентарь листа.',
    'Укажите мировоззрение и детали, которые помогут отыгрывать персонажа.',
    'Проверьте итоговые значения, снаряжение и выбранные блоки.'
  ];
  let step = 0, entries = [], loading = false, error = '', request = 0, query = '', spellFilter = 'all';
  const root = el('div', { class: 'character-builder' });
  const status = el('p', { class: 'builder-error', role: 'alert' });
  const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);
  const signed = n => (n >= 0 ? '+' : '') + n;
  const last = steps.length - 1;
  let previewCache = null;
  /// Собранный лист для предпросмотра — считается один раз за перерисовку.
  const preview = () => (previewCache ||= B.build(draft));
  const equipmentCatalog = () => (draft.catalog || []).filter(e => e.category === 'item');
  const entryName = e => String(e?.name || e?.data?.name || '');
  const entryCategory = e => String(e?.data?.category || e?.category || '');
  const equipmentPickOptions = filter => equipmentCatalog().filter(e => (B.PICK_FILTERS[filter] || {}).test ? B.PICK_FILTERS[filter].test(e) : false);
  const weight = it => Math.round((Number(it.weight) || 0) * (Number(it.qty) || 1) * 100) / 100;

  function pendingChoices() {
    return B.moduleChoices(draft).filter(({ group }) => !B.choiceState(group, draft.picks[group.id]).done);
  }
  /// Родительская раса подрасы — её языки считаются известными.
  function parentRace() {
    const race = draft.selected.race;
    if (!race?.data?.parent) return null;
    const candidates = (draft.catalog || []).filter(e => e.category === 'race' && e.name === race.data.parent && !e.data?.subrace);
    return candidates.find(e => e.pack_id === race.pack_id && e.source === race.source) || candidates[0] || null;
  }
  /// Языки, которые раса выдаёт без выбора: в data.languages рядом с названиями лежит пояснение.
  function raceKnownLanguages() {
    const names = [];
    for (const entry of [draft.selected.race, parentRace()]) for (const value of B.asList(entry?.data?.languages)) {
      const name = String(value || '').trim();
      const known = B.LANGUAGES.find(l => l.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (known && !names.includes(known)) names.push(known);
    }
    return names;
  }
  /// «Один дополнительный язык на ваш выбор» из пояснения расы.
  function raceLanguageChoice() {
    for (const entry of [draft.selected.race, parentRace()]) for (const value of B.asList(entry?.data?.languages)) {
      if (/дополнительн[а-яё]*\s+язык|язык\s+на\s+ваш\s+выбор|extra\s+language/i.test(String(value || ''))) return 1;
    }
    return 0;
  }
  /// Сколько языков ещё выбирает игрок: от предыстории и от расы.
  function languageRule() {
    const needed = Number(draft.selected.background?.data?.languages);
    return (Number.isInteger(needed) && needed > 0 ? needed : 0) + raceLanguageChoice();
  }
  /// Что мешает пройти шаг — для подсказок в навигации и сообщений.
  function stepProblem(index) {
    if (index === 0) return draft.name.trim() ? '' : 'Дайте персонажу имя.';
    if (index === 1) {
      if (['race', 'class', 'background'].some(k => !draft.selected[k])) return 'Выберите расу, класс и предысторию.';
      const pending = pendingChoices();
      return pending.length ? 'Сделайте выбор в модулях: ' + pending.map(x => x.group.name || 'вариант').join(', ') + '.' : '';
    }
    if (index === 2) {
      if (Object.values(draft.abilities).some(n => !Number.isInteger(n) || n < 3 || n > 20)) return 'Базовые характеристики: целые числа от 3 до 20.';
      const opts = draft.selected.background?.data?.asi_options || [];
      if (draft.edition === '2024' && opts.length) {
        const values = Object.values(draft.bonuses).filter(Boolean).sort();
        if (!['1,2', '1,1,1'].includes(values.join(','))) return 'Распределите бонусы предыстории: +2/+1 или +1/+1/+1.';
      }
      return '';
    }
    if (index === 3) {
      const skills = B.skillsState(draft);
      if (skills.klass && skills.klass.picked.length !== skills.klass.choose) return `Навыки класса: выбрано ${skills.klass.picked.length} из ${skills.klass.choose}.`;
      const needed = languageRule();
      if (needed && (draft.languages || []).length !== needed) return `Языки: выбрано ${(draft.languages || []).length} из ${needed}.`;
      return '';
    }
    if (index === 5) {
      const missing = B.equipmentItems(draft).items.find(item => item.pick && !item.name);
      return missing ? `Выберите предмет: «${missing.label}».` : '';
    }
    return '';
  }
  function stepIssues() {
    const map = new Map();
    for (let i = 0; i < steps.length; i++) { const problem = stepProblem(i); if (problem) map.set(i, problem); }
    return map;
  }
  function valid() { return stepProblem(step); }
  async function load() {
    const version = ++request; loading = true; error = ''; render();
    try {
      const params = new URLSearchParams({ edition: draft.edition, limit: '3000' });
      if (defaults.campaignId) params.set('campaign_id', defaults.campaignId);
      const result = await Promise.all(['race', 'class', 'background', 'spell', 'item'].map(category => API.get('/api/compendium?' + params + '&category=' + category)));
      if (version !== request) return;
      entries = result.flat(); draft.catalog = entries;
    } catch (e) { if (version === request) error = e.message; }
    if (version === request) { loading = false; render(); }
  }
  function knownRaceLanguages() {
    return new Set(raceKnownLanguages().map(x => x.toLocaleLowerCase()));
  }
  function choose(category) {
    const selected = draft.selected[category];
    const select = el('select', { 'aria-label': CAT_NAMES[category], onchange: e => {
      draft.selected[category] = entries.find(x => x.id === e.target.value);
      if (category === 'background') { draft.bonuses = {}; draft.languages = []; }
      if (category === 'race') {
        const known = knownRaceLanguages();
        draft.languages = (draft.languages || []).filter(x => !known.has(String(x).toLocaleLowerCase()));
      }
      if (category === 'class') { draft.skills = []; draft.spells = []; }
      if (category === 'class' || category === 'background') draft.equipment = emptyEquipment();
      render();
    } }, el('option', { value: '' }, 'Выберите…'), ...entries.filter(e => e.category === category).map(e => el('option', { value: e.id, selected: selected?.id === e.id ? '' : null }, e.name + ' · ' + e.source)));
    const d = selected?.data || {};
    return el('section', { class: 'builder-module' }, field(CAT_NAMES[category], select),
      selected ? el('div', {}, el('p', { class: 'muted small' }, [d.hit_die && 'Кость хитов: ' + d.hit_die, d.primary && 'Основная: ' + d.primary, d.speed && 'Скорость: ' + d.speed + ' фт.'].filter(Boolean).join(' · ')), el('p', { class: 'builder-description' }, d.desc || (d.traits || []).map(t => t.name).join(' · ') || 'Подробности — в справочнике.'), category === 'race' ? el('p', { class: 'builder-readonly-note small' }, 'Раса — цельный блок справочника. Текст и особенности здесь не редактируются; выберите другой блок или создайте отдельную запись расы.') : null, el('details', {}, el('summary', {}, 'Поля записи'), Compendium.renderData(selected, { readOnly: true }))) : null,
      el('button', { class: 'small', onclick: async () => { try { await Compendium.editEntry(null, { category, onSaved: load }); } catch (e) { toast(e.message); } } }, '+ Создать свой модуль'));
  }
  function choiceSection() {
    const all = B.moduleChoices(draft).map(({ entry, group }) => ({ entry, group }));
    const ids = new Set(all.map(x => x.group.id));
    for (const id of Object.keys(draft.picks)) if (!ids.has(id)) delete draft.picks[id]; // смена модуля сбрасывает чужой выбор
    if (!all.length) return null;
    const box = el('section', { class: 'builder-module builder-choices' },
      el('h3', {}, 'Выбор в модулях'),
      el('p', { class: 'muted small' }, 'Модули предлагают варианты: выберите один или несколько — бонус характеристики, навык, язык или умение.'));
    for (const { entry, group } of all) {
      const { need } = B.choiceState(group, draft.picks[group.id]);
      const many = need !== 1, picked = draft.picks[group.id] || [];
      box.append(el('div', { class: 'builder-choice' },
        el('div', { class: 'builder-choice-head' }, el('b', {}, group.name || 'Выбор'),
          el('span', { class: 'muted small' }, `${B.CHOICE_TYPES[group.type] || group.type} · ${entry.name}${group.optional ? ' · необязательно' : ''}`),
          many ? el('span', { class: 'builder-counter' + (picked.length === need ? ' ok' : '') }, `${picked.length} из ${need}`) : null),
        many ? el('p', { class: 'muted small' }, `Выберите ${need}`) : el('p', { class: 'muted small' }, 'Выберите один вариант'),
        el('div', { class: 'builder-choice-options' }, ...(group.options || []).map(o => el('label', { class: 'builder-choice-option' + (picked.includes(o.id) ? ' on' : '') },
          el('input', { type: many ? 'checkbox' : 'radio', name: 'choice-' + group.id, checked: picked.includes(o.id) ? '' : null, onchange: ev => {
            if (many) {
              const next = picked.filter(x => x !== o.id);
              if (ev.target.checked) next.push(o.id);
              draft.picks[group.id] = next.slice(0, Math.max(1, need));
            } else draft.picks[group.id] = ev.target.checked ? [o.id] : [];
            render();
          } }),
          el('span', {}, el('b', {}, o.name), B.choiceHint(group, o)))))));
    }
    return box;
  }
  function languageSection() {
    const needed = languageRule();
    if (!needed) return null;
    const known = raceKnownLanguages();
    const options = B.LANGUAGES.filter(x => !known.includes(x));
    const selected = draft.languages || [];
    const fromRace = raceLanguageChoice();
    const origin = [languageRule() - fromRace ? `предыстория — ${languageRule() - fromRace}` : '', fromRace ? `раса — ${fromRace}` : ''].filter(Boolean).join(' · ');
    return el('section', { class: 'builder-panel builder-languages' },
      el('div', { class: 'builder-panel-head' },
        el('div', {}, el('b', {}, 'Дополнительные языки'), el('small', { class: 'muted' }, `${origin} · знаете от расы: ${known.length ? known.join(', ') : 'нет'}`)),
        el('span', { class: 'builder-counter' + (selected.length === needed ? ' ok' : '') }, `${selected.length} из ${needed}`)),
      el('div', { class: 'builder-chips' }, ...options.map(language => {
        const on = selected.includes(language);
        return el('label', { class: 'builder-chip toggle' + (on ? ' on' : '') },
          el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && selected.length >= needed ? '' : null, onchange: e => {
            const next = selected.filter(x => x !== language);
            if (e.target.checked) { if (next.length >= needed) return render(); next.push(language); }
            draft.languages = next; render();
          } }), language);
      })));
  }
  function skillsSection(getPreview) {
    const skills = B.skillsState(draft);
    const box = el('section', { class: 'builder-panel builder-skills-panel' });
    if (skills.klass) {
      const { choose, options, picked, source } = skills.klass;
      const full = picked.length >= choose;
      box.append(el('div', { class: 'builder-panel-head' },
        el('div', {}, el('b', {}, 'Навыки класса'), el('small', { class: 'muted' }, source + (choose ? ` · выберите ${choose}` : ''))),
        el('span', { class: 'builder-counter' + (picked.length === choose ? ' ok' : '') }, `${picked.length} из ${choose}`)));
      box.append(el('div', { class: 'builder-skills' }, ...options.map(o => {
        const on = picked.includes(o.key), mod = Math.floor(((getPreview().abilities[o.ability] ?? 10) - 10) / 2);
        return el('label', { class: 'builder-skill' + (on ? ' on' : '') + (o.granted ? ' taken' : '') },
          el('input', { type: 'checkbox', checked: on ? '' : null, disabled: o.granted || (!on && full) ? '' : null, onchange: e => {
            draft.skills = (draft.skills || []).filter(x => x !== o.key);
            if (e.target.checked) draft.skills.push(o.key);
            render();
          } }),
          el('span', {}, el('b', {}, o.name), el('small', { class: 'muted' }, `${ABIL[o.ability] || o.ability} ${signed(mod)}${o.granted ? ' · уже есть от модуля' : ''}`)));
      })));
    } else box.append(el('p', { class: 'builder-note' }, 'Выбранные класс и предыстория не дают выбора навыков — владения указаны ниже.'));
    if (skills.granted.length) box.append(el('div', { class: 'builder-granted' },
      el('h3', {}, 'Навыки от модулей'),
      el('div', { class: 'builder-chips' }, ...skills.granted.map(g => el('span', { class: 'builder-chip' }, el('b', {}, g.name), el('small', { class: 'muted' }, g.source))))));
    return box;
  }
  function proficiencySection() {
    const s = preview(), chips = [];
    if (s.saving_throws.length) chips.push(['Спасброски', s.saving_throws.map(k => ABIL[k] || k).join(', ')]);
    for (const line of String(s.proficiencies || '').split('\n')) {
      const at = line.indexOf(':');
      if (at > 0) chips.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
    if (!chips.length) return null;
    return el('section', { class: 'builder-panel builder-proficiencies' },
      el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, 'Владения и спасброски'), el('small', { class: 'muted' }, 'Приходят из расы, класса и предыстории'))),
      el('div', { class: 'builder-facts' }, ...chips.map(([label, value]) => el('div', { class: 'builder-fact' }, el('span', {}, label), el('b', {}, value)))));
  }
  function equipmentOptionCard(block, option) {
    const on = (draft.equipment.choice[block.id] ?? block.options[0]?.id) === option.id;
    const gold = option.tokens.filter(t => t.kind === 'gold').reduce((a, t) => a + t.amount, 0);
    return el('label', { class: 'builder-eq-option' + (on ? ' on' : '') },
      el('input', { type: 'radio', name: 'eq-' + block.id, checked: on ? '' : null, onchange: () => { draft.equipment.choice[block.id] = option.id; render(); } }),
      el('span', { class: 'builder-eq-body' },
        el('span', { class: 'builder-eq-head' }, el('b', {}, `Вариант ${option.marker}`), gold ? el('span', { class: 'builder-chip gold' }, `${gold} зм`) : null),
        el('span', { class: 'builder-eq-list' }, ...option.tokens.filter(t => t.kind !== 'gold').map(t => el('span', { class: 'builder-eq-item' },
          el('b', {}, t.kind === 'pick' ? `по выбору: ${t.label}${(t.count || 1) > 1 ? ` ×${t.count}` : ''}` : t.name + ((t.qty || 1) > 1 ? ` ×${t.qty}` : '')),
          t.kind === 'item' && findTemplateFor(t.name) ? null : t.kind === 'item' ? el('small', { class: 'muted' }, 'нет в справочнике — попадёт как предмет без шаблона') : null)))));
  }
  const findTemplateFor = name => B.findItemTemplate(name, equipmentCatalog());
  function equipmentItemRow(item) {
    const excluded = !!draft.equipment.exclude[item.key];
    const qty = Math.max(1, Number(draft.equipment.qty[item.key] ?? item.qty) || 1);
    const listId = 'builder-item-names';
    return el('div', { class: 'builder-eq-row' + (excluded ? ' off' : '') },
      el('label', { class: 'builder-eq-check', title: 'Добавить предмет в инвентарь' },
        el('input', { type: 'checkbox', checked: excluded ? null : '', onchange: e => { if (e.target.checked) delete draft.equipment.exclude[item.key]; else draft.equipment.exclude[item.key] = true; render(); } })),
      el('span', { class: 'builder-eq-name' }, el('b', {}, item.entry ? entryName(item.entry) : item.name),
        el('small', { class: 'muted' }, [item.pack && `разложен на ${item.contents} предметов`, item.note, item.entry ? entryCategory(item.entry) : 'нет шаблона в справочнике', item.source].filter(Boolean).join(' · '))),
      el('input', { class: 'builder-eq-qty', type: 'number', min: 1, max: 1000, value: qty, 'aria-label': 'Количество: ' + item.name,
        onchange: e => { draft.equipment.qty[item.key] = Math.max(1, Math.min(1000, Math.round(Number(e.target.value) || 1))); render(); } }),
      el('input', { class: 'builder-eq-template', list: listId, value: item.entry ? item.entry.name : item.name, placeholder: 'Шаблон из справочника или своё название', 'aria-label': 'Шаблон предмета: ' + item.name,
        onchange: e => {
          const name = e.target.value.trim(), entry = equipmentCatalog().find(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
          if (entry) draft.equipment.template[item.key] = entry.id; else delete draft.equipment.template[item.key];
          draft.equipment.name[item.key] = name; render();
        } }),
      el('span', { class: 'builder-eq-weight muted small' }, item.pack ? 'набор' : item.entry ? `${weight({ ...item.entry.data, qty })} фнт` : '—'));
  }
  function equipmentPickRow(item) {
    const options = equipmentPickOptions(item.filter);
    const value = draft.equipment.picks[item.key] ?? '';
    return el('label', { class: 'field builder-eq-pick' },
      el('span', {}, `Выберите: ${item.label}`),
      el('select', { onchange: e => { draft.equipment.picks[item.key] = e.target.value; render(); } },
        el('option', { value: '' }, item.name ? `${item.name} — подставлено по правилам` : '— не выбрано —'),
        ...options.map(e => el('option', { value: e.id, selected: value === e.id ? '' : null }, `${entryName(e)} · ${entryCategory(e) || e.source || 'справочник'}`))));
  }
  function equipmentSummary() {
    const s = preview();
    const capacity = (s.abilities.str || 10) * 15;
    const total = Math.round(s.inventory.reduce((a, it) => a + weight(it), 0) * 10) / 10;
    return el('section', { class: 'builder-panel builder-eq-summary' },
      el('div', { class: 'builder-panel-head' },
        el('div', {}, el('b', {}, 'Итоговый инвентарь'), el('small', { class: 'muted' }, `${s.inventory.length} предметов · ${total} из ${capacity} фнт`)),
        el('span', { class: 'builder-chip gold' }, `${s.currency.gp} зм`)),
      s.inventory.length
        ? el('div', { class: 'builder-eq-totals' }, ...s.inventory.map(it => el('span', { class: 'builder-eq-total' },
            el('b', {}, it.name), el('small', { class: 'muted' }, [(it.qty || 1) > 1 ? `${it.qty} шт.` : '', it.equipped ? (it.hand_slot ? Equipment.slots[it.hand_slot] : it.worn_slot ? Equipment.slots[it.worn_slot] : 'надето') : 'в рюкзаке', `${weight(it)} фнт`].filter(Boolean).join(' · ')))))
        : el('p', { class: 'builder-note' }, 'Пока ничего не выбрано — отметьте предметы выше.'),
      el('p', { class: 'muted small' }, 'Стопки нельзя взять в руки и надеть: сначала отделите одну штуку на листе персонажа.'));
  }
  function equipmentSection() {
    const plan = B.equipmentPlan(draft);
    const { items } = B.equipmentItems(draft);
    const body = el('section', { class: 'builder-equipment' });
    body.append(el('h2', {}, 'Стартовое снаряжение'), el('p', { class: 'muted' }, 'Предметы попадут прямо в инвентарь листа — с количеством, боеприпасами, слотами и хватом по правилам инвентаря. Изменить выбор можно здесь, а надеть предметы — на листе.'));
    if (!plan.length) body.append(el('p', { class: 'builder-note' }, 'У выбранных класса и предыстории нет стартового снаряжения. Добавьте предметы вручную.'));
    // Безусловные предметы всех блоков собираются в одну панель — иначе три одинаковых
    // заголовка «Обязательные предметы» подряд занимают пол-экрана.
    const rowsOf = block => items.filter(i => i.key.startsWith(block.id + ':') && !i.pick && !i.parent);
    const guaranteed = plan.filter(b => b.kind === 'fixed').flatMap(rowsOf);
    if (guaranteed.length) body.append(el('div', { class: 'builder-eq-block' },
      el('div', { class: 'builder-eq-block-head' },
        el('b', {}, 'Выдаётся сразу'),
        el('small', { class: 'muted' }, [...new Set(plan.filter(b => b.kind === 'fixed').map(b => b.sourceName))].join(' · '))),
      el('div', { class: 'builder-eq-rows' }, ...guaranteed.map(equipmentItemRow))));
    for (const block of plan) {
      if (block.kind !== 'group') continue;
      const chosenId = draft.equipment.choice[block.id] ?? block.options?.[0]?.id;
      const option = block.options.find(o => o.id === chosenId) || null;
      const picks = items.filter(i => i.pick && i.key.startsWith(block.id + ':'));
      const rows = rowsOf(block);
      body.append(el('div', { class: 'builder-eq-block' },
        el('div', { class: 'builder-eq-block-head' },
          el('b', {}, block.label),
          el('small', { class: 'muted' }, block.sourceName)),
        el('div', { class: 'builder-eq-options' }, ...block.options.map(o => equipmentOptionCard(block, o))),
        !option ? el('p', { class: 'builder-error small' }, 'Выберите вариант выше.') : null,
        picks.length ? el('div', { class: 'builder-eq-picks' }, ...picks.map(equipmentPickRow)) : null,
        rows.length ? el('div', { class: 'builder-eq-rows' }, ...rows.map(equipmentItemRow)) : null));
    }
    if (plan.length) body.append(el('p', { class: 'muted small' }, 'Название в строке можно заменить на любую запись справочника — количество, вес и действия подтянутся из неё.'));
    body.append(el('div', { class: 'builder-eq-extras' },
      el('b', {}, 'Дополнительно'),
      el('div', { class: 'builder-eq-extra-row' },
        el('input', { id: 'builder-extra-name', list: 'builder-item-names', placeholder: 'Ещё предмет, например «Верёвка пеньковая (50 футов)»' }),
        el('input', { id: 'builder-extra-qty', class: 'builder-eq-qty', type: 'number', min: 1, max: 1000, value: 1, 'aria-label': 'Количество нового предмета' }),
        el('button', { class: 'small', onclick: () => {
          const nameInput = root.querySelector('#builder-extra-name'), qtyInput = root.querySelector('#builder-extra-qty');
          const name = (nameInput?.value || '').trim(); if (!name) return;
          const entry = equipmentCatalog().find(x => entryName(x).toLocaleLowerCase() === name.toLocaleLowerCase());
          draft.equipment.extras.push({ key: uidSafe(), entryId: entry?.id || '', name: name, qty: Math.max(1, Math.round(Number(qtyInput?.value) || 1)) });
          render();
        } }, '+ Добавить'))));
    body.append(el('div', { class: 'builder-eq-settings' },
      field('Дополнительное золото, зм', el('input', { type: 'number', min: 0, max: 999999, value: Number(draft.equipment.gold) || 0, onchange: e => { draft.equipment.gold = Math.max(0, Math.round(Number(e.target.value) || 0)); render(); } })),
      el('label', { class: 'builder-check-row' }, el('input', { type: 'checkbox', checked: draft.equipment.autoEquip === false ? null : '', onchange: e => { draft.equipment.autoEquip = e.target.checked; render(); } }), 'Надеть доспех, щит и основное оружие сразу'),
      el('label', { class: 'builder-check-row' }, el('input', { type: 'checkbox', checked: draft.equipment.packs === false ? null : '', onchange: e => { draft.equipment.packs = e.target.checked; render(); } }), 'Раскладывать наборы на содержимое'),
      el('p', { class: 'muted small' }, 'Наборы «Набор путешественника» и подобные раскладываются на список вещей из описания — так их видно в весе инвентаря. Выключите, чтобы хранить набор одной строкой.')));
    if (draft.equipment.extras.length) body.append(el('div', { class: 'builder-eq-rows' }, ...items.filter(i => i.manual).map(item => el('div', { class: 'builder-eq-row' },
      el('span', { class: 'builder-eq-name' }, el('b', {}, item.name), el('small', { class: 'muted' }, item.entry ? item.entry.category : 'нет шаблона в справочнике')),
      el('span', { class: 'builder-eq-qty muted' }, `×${item.qty}`),
      el('button', { class: 'small danger', onclick: () => { draft.equipment.extras = draft.equipment.extras.filter(x => x.key !== item.key); render(); } }, 'Убрать')))));
    body.append(equipmentSummary());
    return body;
  }
  const uidSafe = () => 'ex' + Math.random().toString(36).slice(2, 9);
  /// Переход между шагами: вперёд пускает только заполненный текущий шаг.
  function goTo(target) {
    if (target === step) return;
    if (target < step) { step = target; render(); return; }
    for (let i = step; i < target; i++) {
      const problem = stepProblem(i);
      if (problem) { step = i; status.textContent = problem; render(); return; }
    }
    step = target; render();
  }
  function render() {
    root.replaceChildren(); status.textContent = ''; previewCache = null;
    const issues = stepIssues();
    root.append(el('nav', { class: 'builder-steps', 'aria-label': 'Шаги создания персонажа' }, ...steps.map((name, i) => {
      const done = i < step, problem = issues.get(i) && i !== step;
      return el('button', {
        type: 'button', class: `builder-step${i === step ? ' current' : done ? ' done' : ''}${problem ? ' flag' : ''}`,
        'aria-current': i === step ? 'step' : null, title: issues.get(i) || stepTips[i],
        onclick: () => goTo(i)
      }, el('span', { class: 'builder-step-n' }, done ? '✓' : String(i + 1)),
        el('span', { class: 'builder-step-t' }, el('b', {}, name), el('small', {}, i === last ? 'Готовый лист' : stepTips[i])));
    })));
    const problem = issues.get(step);
    root.append(el('div', { class: 'builder-step-context' },
      el('div', { class: 'builder-progress' }, el('span', { style: `width:${((step + 1) / steps.length) * 100}%` })),
      el('div', { class: 'builder-context-row' },
        el('b', {}, `Шаг ${step + 1} из ${steps.length} · ${steps[step]}`),
        el('span', { class: problem ? 'builder-flag' : 'muted small' }, problem ? '! ' + problem : stepTips[step]))));
    const body = el('div', { class: 'builder-body' });
    const add = (...nodes) => nodes.filter(Boolean).forEach(node => body.append(node));
    root.append(body);
    if (step === 0) {
      add(el('div', { class: 'builder-intro' }, el('span', { class: 'builder-eyebrow' }, 'DUNGEONS & DRAGONS · УРОВЕНЬ 1'), el('h2', {}, 'Каждая история начинается с героя'), el('p', { class: 'muted' }, 'Восемь понятных шагов — от концепции до готового листа. Расы, классы и предыстории подключаются как блоки из справочника, а навыки и снаряжение собираются по правилам.')),
        field('Имя персонажа', el('input', { value: draft.name, maxlength: 128, placeholder: 'Как вас будут помнить?', oninput: e => draft.name = e.target.value })),
        field('Редакция правил', el('select', { onchange: e => { draft.edition = e.target.value; draft.selected = {}; draft.spells = []; draft.skills = []; draft.languages = []; draft.bonuses = {}; draft.equipment = emptyEquipment(); load(); } }, ...Object.entries(EDITIONS).map(([k, n]) => el('option', { value: k, selected: draft.edition === k ? '' : null }, n)))),
        el('p', { class: 'muted small' }, '2014: бонусы характеристик от расы. 2024: от предыстории. Пользовательские модули доступны из ваших наборов и наборов кампании.'));
    }
    if (step === 1 || step === 4) {
      if (loading) add(el('p', { role: 'status' }, 'Загружаем модули…'));
      else if (error) add(el('p', { role: 'alert' }, 'Не удалось загрузить: ' + error), el('button', { onclick: load }, 'Повторить'));
      else if (step === 1) add(el('div', { class: 'builder-modules' }, ...['race', 'class', 'background'].map(choose)), choiceSection());
      else {
        const chosen = draft.spells.length;
        add(el('h2', {}, 'Книга заклинаний'),
          el('p', { class: 'muted' }, 'Необязательный шаг. Выбирайте заговоры и заклинания 1-го круга. Ограничения класса и число известных заклинаний проверьте с мастером.'),
          el('div', { class: 'builder-spell-filters' },
            el('input', { type: 'search', value: query, placeholder: 'Найти заклинание…', 'aria-label': 'Поиск заклинаний', oninput: e => { query = e.target.value; updateSpells(); } }),
            ...Object.entries({ all: 'Все', cantrip: 'Заговоры', first: '1 круг' }).map(([key, label]) => el('button', {
              class: 'small' + (spellFilter === key ? ' on' : ''), onclick: () => { spellFilter = key; render(); }
            }, label)),
            el('span', { class: 'builder-counter' + (chosen ? ' ok' : '') }, `Выбрано: ${chosen}`),
            el('button', { class: 'small', onclick: async () => { try { await Compendium.editEntry(null, { category: 'spell', onSaved: load }); } catch (e) { toast(e.message); } } }, '+ Создать заклинание')));
        const list = el('div', { class: 'builder-spells' }); body.append(list);
        updateSpells();
        function updateSpells() {
          const levelOf = e => Number(e.data?.level || 0);
          const found = entries.filter(e => e.category === 'spell' && levelOf(e) <= 1
            && (spellFilter === 'all' || (spellFilter === 'cantrip' ? levelOf(e) === 0 : levelOf(e) === 1))
            && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
          list.replaceChildren(...found.map(e => el('label', { class: 'builder-spell' + (draft.spells.some(x => x.id === e.id) ? ' on' : '') },
            el('input', { type: 'checkbox', checked: draft.spells.some(x => x.id === e.id) ? '' : null, onchange: ev => {
              draft.spells = draft.spells.filter(x => x.id !== e.id);
              if (ev.target.checked) draft.spells.push(e);
              ev.target.closest('.builder-spell')?.classList.toggle('on', ev.target.checked);
            } }),
            el('span', {}, el('b', {}, e.name), el('small', { class: 'muted' }, `${levelOf(e) === 0 ? 'Заговор' : levelOf(e) + ' круг'} · ${e.source}`)),
            el('span', { class: 'builder-spell-info', title: e.data?.desc || '' }, 'ⓘ'))));
          if (!found.length) list.append(el('p', { class: 'muted' }, 'Заклинаний не найдено. Измените поиск или создайте свой модуль.'));
        }
      }
    }
    if (step === 2) {
      add(el('h2', {}, 'Шесть граней вашего героя'), el('p', { class: 'muted' }, 'Бросок 4d6: минимальный кубик отбрасывается. Значения можно поменять местами; бонусы модулей добавятся отдельно.'));
      add(el('div', { class: 'row builder-ability-actions' },
        el('button', { onclick: () => { draft.method = 'rolled'; draft.rolls = B.rollStats(); B.keys.forEach((k, i) => draft.abilities[k] = draft.rolls[i].total); render(); } }, icon('dice'), ' Бросить 6 × 4d6'),
        el('button', { onclick: () => { draft.method = 'standard'; draft.rolls = []; B.keys.forEach((k, i) => draft.abilities[k] = [15, 14, 13, 12, 10, 8][i]); render(); } }, 'Стандартный набор'),
        el('button', { onclick: () => { draft.method = 'manual'; render(); } }, 'Вручную')));
      const sheet = preview();
      add(el('div', { class: 'builder-abilities' }, ...B.keys.map((k, i) => {
        const input = draft.method === 'manual'
          ? el('input', { type: 'number', min: 3, max: 20, value: draft.abilities[k], 'aria-label': ABIL[k], onchange: e => { draft.abilities[k] = Number(e.target.value); render(); } })
          : el('select', { 'aria-label': ABIL[k], onchange: e => { const other = e.target.value; [draft.abilities[k], draft.abilities[other]] = [draft.abilities[other], draft.abilities[k]]; render(); } },
              ...B.keys.map(other => el('option', { value: other, selected: other === k ? '' : null }, draft.abilities[other] + (other === k ? '' : ' ↔ ' + ABIL[other]))));
        return el('div', { class: 'builder-ability' }, el('label', {}, ABIL[k]), el('strong', {}, signed(Math.floor((sheet.abilities[k] - 10) / 2))), input,
          el('small', {}, `Итого ${sheet.abilities[k]} · бонус ${signed(sheet.abilities[k] - draft.abilities[k])}`));
      })));
      if (draft.rolls.length) body.append(el('div', { class: 'builder-rolls' }, ...draft.rolls.map((r, i) => el('span', {}, `${i + 1}: `, ...r.dice.map((v, j) => el(j === r.dropped ? 's' : 'b', {}, v + ' ')), '= ' + r.total))));
      const options = draft.selected.background?.data?.asi_options || [];
      if (draft.edition === '2024' && options.length) body.append(el('h3', {}, 'Бонусы предыстории: +2/+1 или +1/+1/+1'), el('div', { class: 'row' }, ...options.map(n => {
        const k = B.short[n] || n; return field(ABIL[k] || n, el('select', { onchange: e => { draft.bonuses[k] = Number(e.target.value); render(); } }, ...[0, 1, 2].map(v => el('option', { value: v, selected: (draft.bonuses[k] || 0) === v ? '' : null }, '+' + v))));
      })));
    }
    if (step === 3) {
      add(el('h2', {}, 'Навыки и владения'),
        el('p', { class: 'muted' }, 'Навыки класса выбираются по счётчику, навыки от расы, класса и предыстории уже отмечены. Языки и владения приходят из модулей.'));
      if (loading) add(el('p', { role: 'status' }, 'Загружаем модули…'));
      else if (error) add(el('p', { role: 'alert' }, 'Не удалось загрузить: ' + error), el('button', { onclick: load }, 'Повторить'));
      else add(skillsSection(preview), languageSection(), proficiencySection());
    }
    if (step === 5) {
      if (loading) add(el('p', { role: 'status' }, 'Загружаем справочник предметов…'));
      else if (error) add(el('p', { role: 'alert' }, 'Не удалось загрузить: ' + error), el('button', { onclick: load }, 'Повторить'));
      else add(equipmentSection());
    }
    if (step === 6) {
      const traitField = (key, label, placeholder, wide = false) => field(label, el('textarea', {
        maxlength: 1500, rows: wide ? 4 : 3, placeholder, class: wide ? 'builder-long-field' : '',
        oninput: e => draft.traits[key] = e.target.value
      }, draft.traits[key] || ''));
      const alignment = el('select', { 'aria-label': 'Мировоззрение', onchange: e => draft.alignment = e.target.value },
        ...B.ALIGNMENTS.map(value => el('option', { value, selected: (draft.alignment || '') === value ? '' : null }, value || 'Не выбрано')));
      const identityFields = el('div', { class: 'builder-identity-grid' },
        traitField('personality', 'Черты характера', 'Например: сначала слушает, потом действует.'),
        traitField('ideals', 'Идеалы', 'Что герой считает правильным?'),
        traitField('bonds', 'Привязанности', 'Кого или что герой защищает?'),
        traitField('flaws', 'Слабости', 'Что часто мешает герою?'),
        traitField('appearance', 'Дополнительные приметы', 'Шрамы, татуировки, голос, манеры.', true),
        traitField('backstory', 'Предыстория героя', 'Откуда он и почему отправился в путь.', true));
      const bioField = (key, label, placeholder = '') => field(label, el('input', { value: draft.traits[key] || '', maxlength: 120, placeholder, oninput: e => draft.traits[key] = e.target.value }));
      const identityBasics = el('section', { class: 'builder-panel builder-identity-extra' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, 'Анкета героя'), el('small', { class: 'muted' }, 'Необязательно — детали, которые часто забывают'))),
        el('div', { class: 'builder-identity-extra-grid' },
          bioField('player_name', 'Имя игрока'), bioField('faith', 'Божество или вера'), bioField('age', 'Возраст', 'например, 120 лет'),
          bioField('height', 'Рост', 'например, 180 см'), bioField('weight', 'Вес', 'например, 75 кг'), bioField('eyes', 'Глаза'),
          bioField('skin', 'Кожа'), bioField('hair', 'Волосы')));
      add(el('section', { class: 'builder-identity' },
        el('h2', {}, 'Мировоззрение и личность'),
        el('p', { class: 'muted' }, 'Укажите мировоззрение, личные ориентиры и детали биографии. Все поля необязательны.'),
        field('Мировоззрение', alignment), identityBasics, identityFields));
    }
    if (step === last) {
      const s = preview();
      const skillNames = s.skills.map(key => SKILLS.find(([k]) => k === key)?.[1] || key);
      const saves = s.saving_throws.map(key => ABIL[key] || key);
      const capacity = (s.abilities.str || 10) * 15, carry = Math.round(s.inventory.reduce((a, it) => a + weight(it), 0) * 10) / 10;
      const narrative = [['Игрок', s.traits.player_name], ['Божество или вера', s.traits.faith], ['Возраст', s.traits.age], ['Рост', s.traits.height], ['Вес', s.traits.weight], ['Глаза', s.traits.eyes], ['Кожа', s.traits.skin], ['Волосы', s.traits.hair], ['Черты характера', s.traits.personality], ['Идеалы', s.traits.ideals], ['Привязанности', s.traits.bonds], ['Слабости', s.traits.flaws], ['Дополнительные приметы', s.traits.appearance], ['Предыстория героя', s.traits.backstory]].filter(([, value]) => value);
      add(el('div', { class: 'builder-paper' },
        el('span', { class: 'builder-eyebrow' }, 'ЛИСТ ПЕРСОНАЖА · ' + EDITIONS[s.edition]),
        el('h2', {}, s.name),
        el('p', { class: 'builder-review-subtitle' }, [s.race, s.class + ' · 1 уровень', s.background].join(' / ')),
        el('div', { class: 'builder-review-alignment' }, el('span', { class: 'muted small' }, 'Мировоззрение'), el('strong', {}, s.alignment || 'Не выбрано')),
        el('div', { class: 'builder-abilities' }, ...B.keys.map(k => el('div', { class: 'builder-ability' }, el('label', {}, ABIL[k]), el('strong', {}, signed(Math.floor((s.abilities[k] - 10) / 2))), el('span', {}, s.abilities[k])))),
        el('div', { class: 'builder-summary' }, ...[['Хиты', `${s.hp.max} · ${s.hp.hit_dice}`], ['КД', s.ac], ['Скорость, фт.', s.speed], ['Бонус мастерства', '+2']].map(([n, v]) => el('div', {}, el('strong', {}, v), el('small', {}, n)))),
        el('div', { class: 'builder-review-grid' },
          el('section', {}, el('h3', {}, 'Владения и подготовка'),
            el('p', {}, el('b', {}, 'Спасброски: '), saves.join(', ') || 'не выбраны'),
            el('p', {}, el('b', {}, 'Навыки: '), skillNames.join(', ') || 'не выбраны'),
            el('p', { class: 'builder-review-text' }, s.proficiencies || 'Языки и владения не указаны.'),
            s.spells.ability ? el('p', {}, el('b', {}, 'Заклинательная характеристика: '), ABIL[s.spells.ability] || s.spells.ability) : null),
          el('section', {}, el('h3', {}, 'Снаряжение'),
            el('p', {}, el('b', {}, `${s.inventory.length} предметов`), ` · ${carry} из ${capacity} фнт · `, el('b', {}, `${s.currency.gp} зм`)),
            s.inventory.length ? el('ul', { class: 'builder-review-items' }, ...s.inventory.map(it => el('li', {}, it.name, (it.qty || 1) > 1 ? ` ×${it.qty}` : '', it.equipped ? el('span', { class: 'muted' }, ' — в руках или надето') : null))) : el('p', { class: 'muted small' }, 'Инвентарь пуст — предметы можно добавить на самом листе.'),
            s.spells.known.length ? el('p', { class: 'muted small' }, `Заклинаний: ${s.spells.known.length}`) : null)),
        el('div', { class: 'builder-review-grid' },
          el('section', {}, el('h3', {}, 'Личность'),
            ...(narrative.length ? narrative.map(([label, value]) => el('p', { class: 'builder-review-text' }, el('b', {}, label + ': '), value)) : [el('p', { class: 'muted small' }, 'Личность можно дополнить на вкладке «Заметки».')]))),
        el('h3', {}, 'Подключённые блоки'),
        el('p', { class: 'builder-review-text' }, s.modules.map(m => m.snapshot.name).join(' · ')),
        s.creation.choices.length ? el('p', { class: 'muted small' }, 'Выбор в модулях: ' + s.creation.choices.map(c => `${c.group} — ${c.name}`).join(' · ')) : null,
        el('p', { class: 'muted small' }, 'Снаряжение уже в инвентаре: останется проверить слоты рук и надетых предметов на листе персонажа.')));
    }
    const nav = el('div', { class: 'builder-nav' },
      el('button', { class: 'builder-back', disabled: step === 0 ? '' : null, onclick: () => goTo(step - 1) }, '← Назад'),
      el('span', { class: 'builder-nav-info' }, el('b', {}, `${step + 1} / ${steps.length}`), el('small', {}, steps[step])),
      step < last ? el('button', { class: 'primary', onclick: () => goTo(step + 1) }, 'Далее →')
        : el('span', { class: 'builder-nav-hint' }, 'Осталось нажать «Создать персонажа»'));
    root.append(status, nav, el('datalist', { id: 'builder-item-names' }, ...equipmentCatalog().map(e => el('option', { value: e.name }))));
  }
  render(); load();
  const result = await modal('Создание персонажа', root, [{ label: 'Создать персонажа', cls: 'primary builder-submit', fn: () => {
    if (step !== last) { status.textContent = 'Пройдите шаги и проверьте готовый лист.'; return false; }
    const msg = valid(); if (msg) { status.textContent = msg; return false; }
    LS.setItem('et-edition', draft.edition);
    return { name: draft.name.trim(), sheet: B.build(draft) };
  } }], { wide: true });
  request++; // Ignore late fetches after cancellation.
  return result;
};
