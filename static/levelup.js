// ---------------------------------------------------------------------------
// levelup.js — повышение уровня: чистая логика (план, расчёт, применение
// к листу, отмена) плюс мастер в стиле D&D Beyond.
// Даёт: window.LevelUp.
// Зависимости: common.js; лениво: Presets (таблицы развития, ячейки мультикласса),
// Mechanics, Modules, DiceEngine. Загружается только в sheet.html (слой 5).
// ---------------------------------------------------------------------------
// Повышение уровня: чистая логика (план, расчёт, применение к листу, отмена) + мастер в стиле D&D Beyond.
// Данные берутся из записи класса справочника (features по уровням, subclasses, hit_die, spellcasting)
// и из наборов таблиц развития (static/presets/, реестр Presets; бонус мастерства, заговоры, заклинания, ячейки, столбцы классов).
// Лист хранит классы в `sheet.classes = [{name, level, subclass, hit_die}]`; `sheet.level` — суммарный уровень,
// `sheet.class` и `sheet.subclass` — строки для показа. У листов без `classes` класс берётся из `sheet.class`.
window.LevelUp = (() => {
  const KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const MAX_LEVEL = 20;
  // Классификация особенностей класса — набор feature_rules (вид + шаблон) по редакции. Правила проверяются по порядку набора.
  const featureRulesOf = edition => window.Presets?.items('feature_rules', edition) || [];
  const featureRuleMatch = (rule, name) => {
    const t = rule.table || {}, p = String(t.pattern || '');
    if (t.match === 'exact') return name === p;
    if (t.match === 'prefix') return name.startsWith(p);
    return new RegExp(p, String(t.flags || '')).test(name);
  };
  const featureKinds = (name, edition) => featureRulesOf(edition).filter(r => featureRuleMatch(r, name)).map(r => r.table.kind);
  const hasFeatureKind = (name, kind, edition) => featureKinds(name, edition).includes(kind);
  const featureRuleOf = (kind, edition) => featureRulesOf(edition).find(r => r.table.kind === kind)?.table || null;
  const featureTagOf = (name, edition) => featureRulesOf(edition).find(r => r.table.tag && featureRuleMatch(r, name))?.table.tag || '';
  const EXPERTISE_GAINS = { '2014': { bard: { 3: 2, 10: 2 }, rogue: { 1: 2, 6: 2 } }, '2024': { bard: { 2: 2, 9: 2 }, rogue: { 1: 2, 6: 2 }, ranger: { 2: 1, 9: 2 }, wizard: { 2: 1 } } };
  const expertiseGain = (edition, slug, level) => Number(EXPERTISE_GAINS[edition]?.[slug]?.[level]) || 0;
  const SKILL_KEYS_RU = { Акробатика: 'acrobatics', 'Уход за животными': 'animal_handling', Магия: 'arcana', Атлетика: 'athletics', Обман: 'deception', История: 'history', Проницательность: 'insight', Запугивание: 'intimidation', Анализ: 'investigation', Медицина: 'medicine', Природа: 'nature', Восприятие: 'perception', Выступление: 'performance', Убеждение: 'persuasion', Религия: 'religion', 'Ловкость рук': 'sleight_of_hand', Скрытность: 'stealth', Выживание: 'survival' };
  const skillKeyFromName = name => SKILL_KEYS_RU[name] || (typeof SKILLS !== 'undefined' ? SKILLS.find(([, label]) => label === name)?.[0] : null);
  const skillName = k => k === 'thieves_tools' ? 'Воровские инструменты' : (typeof SKILLS !== 'undefined' && (SKILLS.find(x => x[0] === k) || [])[1]) || k;
  const modOf = n => Math.floor(((Number(n) || 10) - 10) / 2);
  const profBonus = lvl => Math.ceil(1 + lvl / 4);
  const dieOf = cls => Number(String(cls?.data?.hit_die || 'd8').replace(/\D/g, '')) || 8;
  // Правила мультикласса и цвет класса — из набора class_rules (static/presets/) по slug и редакции.
  const classRulesOf = (slug, edition) => window.Presets?.classRules(String(edition || '2014'), slug) || {};
  const mcRequirements = (slug, edition) => classRulesOf(slug, edition).multiclass?.requirements || [];
  const mcProficiency = (slug, edition) => classRulesOf(slug, edition).multiclass?.proficiencies || '';
  const TERRAINS = ['Арктика', 'Побережье', 'Пустыня', 'Лес', 'Луг', 'Горы', 'Болото', 'Подземье'];
  // Правила черт — набор feat_rules (по редакции записи): группы (style, epic, asi), прибавка характеристики, требования.
  const featRuleOf = feat => {
    const edition = String(feat?.data?.edition || ''), nameEn = String(feat?.data?.name_en || '').toLowerCase();
    const found = (window.Presets?.items('feat_rules', edition || undefined) || []).find(i => String(i.table?.name_en || '').toLowerCase() === nameEn);
    return found?.table || {};
  };
  const isStyleFeat = e => (featRuleOf(e).groups || []).includes('style');

  // ---------- Чистая логика: классы, подклассы, таблицы развития ----------
  const slugOf = entry => window.ClassRules.slugOf(entry);
  /// Совпадает ли название класса на листе с записью справочника (по русскому и английскому названию).
  function sameClass(name, entry) {
    const n = String(name || '').trim().toLowerCase(); if (!n || !entry) return false;
    return [entry.name, entry.data?.name_en, entry.name_en].some(v => v && String(v).trim().toLowerCase() === n);
  }
  const clampLevel = v => Math.min(MAX_LEVEL, Math.max(1, Math.round(Number(v) || 1)));
  /// Классы листа: `sheet.classes` или, для старых листов, единственный класс из `sheet.class` и `sheet.level`.
  function classesOf(sheet) {
    const total = clampLevel(sheet.level);
    const list = (Array.isArray(sheet.classes) ? sheet.classes : []).filter(c => c && typeof c === 'object' && String(c.name || '').trim() && Number(c.level) > 0)
      .map(c => ({ ...c, name: String(c.name).trim(), level: Math.round(Number(c.level)), subclass: String(c.subclass || '') }));
    if (!list.length) return String(sheet.class || '').trim() ? [{ name: String(sheet.class).trim(), level: total, subclass: String(sheet.subclass || '') }] : [];
    const sum = list.reduce((n, c) => n + c.level, 0);
    if (list.length === 1) list[0].level = total; // лист с одним классом следует полю «Уровень»
    else if (sum !== total) list[0].level = Math.max(1, list[0].level + total - sum);
    return list;
  }
  /// Строка класса из `classesOf` для записи справочника или null, если такого класса на листе нет (новый класс).
  function classRow(sheet, entry) {
    const list = classesOf(sheet);
    return list.find(c => sameClass(c.name, entry)) || (list.length === 1 && !list[0].name ? list[0] : null);
  }
  const classLabel = list => list.length > 1 ? list.map(c => `${c.name} ${c.level}`).join(' / ') : list[0]?.name || '';
  const subclassLabel = list => list.map(c => c.subclass).filter(Boolean).join(' / ');
  /// Проверка требований мультиклассирования к характеристикам: { ok, missing:[текст] }.
  function multiclassReq(abilities, slug, edition) {
    const groups = mcRequirements(slug, edition), missing = [];
    for (const g of groups) if (!g.some(k => (Number(abilities?.[k]) || 10) >= 13)) missing.push(g.map(k => (typeof ABIL !== 'undefined' && ABIL[k]) || k).join(' или ') + ' 13');
    return { ok: !missing.length, missing };
  }

  // Порядок: данные записи → узел rule.class_progression в графе записи → встроенная таблица SRD (запасной вариант).
  function progression(entry, edition) {
    return entry?.data?.progression || (typeof window !== 'undefined' ? window.Mechanics?.classProgression?.(entry?.data?.mechanics, edition) : null)
      || (typeof window !== 'undefined' ? window.Presets?.classProgression(edition, slugOf(entry)) : null) || null;
  }
  /// Заклинательные показатели класса на уровне класса: заговоры, известные/подготовленные, ячейки, магия договора.
  function spellStats(entry, edition, level, castMod = 0) {
    const prog = progression(entry, edition), row = prog?.levels?.[String(level)];
    if (!row) return null;
    const slug = slugOf(entry);
    let prepared = row.prepared ?? null;
    if (prepared === null && edition === '2014') {
      const rule = window.ClassRules.preparedFormula(entry, edition);
      if (rule === 'level') prepared = Math.max(1, level + castMod);
      else if (rule === 'half') prepared = Math.max(1, Math.floor(level / 2) + castMod);
    }
    const slots = Array.from({ length: 9 }, (_, i) => Number(row.slots?.[i]) || 0);
    const pact = row.pact_slots ? { count: Number(row.pact_slots), level: Number(row.pact_level) || 1 } : null;
    const top = pact ? pact.level : slots.reduce((m, n, i) => n > 0 ? i + 1 : m, 0);
    return { cantrips: Number(row.cantrips) || 0, known: row.known ?? null, prepared, slots, pact, maxSpellLevel: top, row };
  }
  /// Ячейки заклинаний по всем классам листа: один заклинательный класс — по его таблице, два и больше — по таблице
  /// «Мультиклассовый заклинатель» (уровень заклинателя складывается), магия договора колдуна — отдельно.
  function castingSummary(edition, classes, resolve) {
    const parts = [];
    for (const c of classes) {
      const entry = resolve(c.name); if (!entry) continue;
      const stats = spellStats(entry, edition, c.level); if (!stats) continue;
      parts.push({ c, entry, stats, slug: slugOf(entry) });
    }
    const pact = parts.find(x => x.stats.pact)?.stats.pact || null;
    const casters = parts.filter(x => !x.stats.pact && x.stats.slots.some(n => n > 0));
    let slots = Array(9).fill(0), combined = false, casterLevel = 0;
    if (casters.length === 1) slots = casters[0].stats.slots.slice();
    else if (casters.length > 1) {
      combined = true;
      for (const x of casters) {
        const third = /eldritch knight|arcane trickster|мистический рыцарь|мастер иллюзий|ловкач/i.test(`${x.c.subclass} ${x.entry.data?.subclasses?.find?.(s => s.name === x.c.subclass)?.name_en || ''}`);
        casterLevel += window.ClassRules.casterLevel(x.entry, edition) === 'full' ? x.c.level : window.ClassRules.casterLevel(x.entry, edition) === 'half' ? (edition === '2024' ? Math.ceil(x.c.level / 2) : Math.floor(x.c.level / 2)) : third ? Math.floor(x.c.level / 3) : x.c.level;
      }
      // Общая таблица мультикласса заклинателей (SRD), не таблица отдельного класса.
      const wiz = typeof window !== 'undefined' ? window.Presets?.multiclassSlots(edition) : null;
      slots = Array.from({ length: 9 }, (_, i) => Number(wiz?.levels?.[String(Math.min(20, Math.max(1, casterLevel)))]?.slots?.[i]) || 0);
    }
    return { slots, pact, combined, casterLevel };
  }
  /// Умения класса на уровне без мусорных строк данных и повторов.
  function classFeaturesAt(entry, level) {
    const d = entry?.data || {}, seen = new Set();
    return (d.features?.[String(level)] || []).filter(n => typeof n === 'string' && n.trim() && !n.trim().startsWith('|') && !seen.has(n) && seen.add(n))
      .map(name => ({ name, text: d.feature_texts?.[name] || '' }));
  }
  const subclassOf = (entry, name) => {
    const n = String(name || '').trim().toLowerCase(); if (!n) return null;
    return (entry?.data?.subclasses || []).find(x => [x.name, x.name_en].some(v => v && (String(v).toLowerCase() === n || n.includes(String(v).toLowerCase())))) || null;
  };
  function subclassVariantGroups(sub, level) {
    const groups = new Map();
    for (const name of sub?.features?.[String(level)] || []) {
      if (typeof name !== 'string') continue;
      const match = name.match(/^(.+?):\s+(.+)$/); if (!match) continue;
      const options = groups.get(match[1]) || []; options.push(name); groups.set(match[1], options);
    }
    return [...groups].filter(([, options]) => options.length > 1).map(([base, options]) => ({ id: `sub:${base}`, base, options }));
  }
  const subclassFeaturesAt = (sub, level, choices = {}) => sub ? [...new Set((sub.features?.[String(level)] || []).filter(n => typeof n === 'string' && !n.startsWith('|')))]
    .filter(name => { const group = subclassVariantGroups(sub, level).find(g => g.options.includes(name)); return !group || choices[group.base] === name; })
    .map(name => ({ name, text: sub.feature_texts?.[name] || '' })) : [];
  function subclassCantripGain(entry, sub, edition, level) {
    return edition === '2014' && slugOf(entry) === 'druid' && Number(level) === 2 && /круг земли/i.test(sub?.name || '')
      && subclassFeaturesAt(sub, 2).some(feature => /дополнительный заговор/i.test(feature.name)) ? 1 : 0;
  }
  function subclassSkillChoices(entry, sub, level) {
    const features = subclassFeaturesAt(sub, level);
    return slugOf(entry) === 'bard' && Number(level) === 3 && /коллегия знаний|college of lore/i.test(`${sub?.name || ''} ${sub?.name_en || ''}`)
      && features.some(feature => /дополнительные владения|bonus proficiencies/i.test(feature.name) && /три навык|трем[яи]\s+навы|three skills/i.test(feature.text))
      ? { count: 3, any: true } : null;
  }
  /// Уровень выбора подкласса: первый уровень, на котором у подклассов есть умения.
  function subclassLevel(entry) {
    const lv = (entry?.data?.subclasses || []).flatMap(s => Object.keys(s.features || {}).map(Number)).filter(Number.isFinite);
    return lv.length ? Math.min(...lv) : null;
  }
  const columnValue = (prog, col, level) => prog?.levels?.[String(level)]?.[col.key];

  /// Варианты умений, которые нужно выбрать (боевой стиль, метамагия, воззвания, договор, избранный враг…).
  /// В записях класса все варианты перечислены среди умений уровня — на лист должны попасть только выбранные.
  // ---------- Чистая логика: план повышения (умения, выборы, ячейки) ----------
  function optionGroups(entry, edition, from, to, sheet, prog) {
    const d = entry?.data || {}, slug = slugOf(entry), groups = [], hidden = new Set();
    const names = classFeaturesAt(entry, to).map(f => f.name), textOf = n => d.feature_texts?.[n] || '';
    const opt = n => ({ name: n, text: textOf(n) });
    const owned = new Set((sheet.features || []).map(f => f.name));
    const listed = lv => classFeaturesAt(entry, lv).map(f => f.name);
    const hide = list => list.forEach(n => hidden.add(n));
    if (['fighter', 'paladin', 'ranger'].includes(slug) && names.includes('Боевой стиль')) {
      if (edition === '2024') { groups.push({ id: 'style', kind: 'feat', label: 'Боевой стиль', hint: 'Выберите черту «Боевой стиль»', count: 1 }); hide(['Боевой стиль']); }
      else {
        const options = names.filter(n => n.startsWith('Боевой стиль: ') && !owned.has(n)).map(opt);
        if (options.length) { groups.push({ id: 'style', kind: 'feature', label: 'Боевой стиль', hint: 'Один стиль боя', count: 1, options }); hide(['Боевой стиль', ...names.filter(n => n.startsWith('Боевой стиль: '))]); }
      }
    }
    if (edition === '2014' && slug === 'sorcerer' && names.includes('Метамагия')) {
      const first = Object.keys(d.features || {}).map(Number).filter(l => (d.features[l] || []).includes('Метамагия')).sort((a, b) => a - b)[0];
      const all = listed(first).filter(n => n !== 'Метамагия'), options = all.filter(n => !owned.has(n)).map(opt);
      if (options.length) { groups.push({ id: 'meta', kind: 'feature', label: 'Метамагия', hint: to === first ? 'Два варианта метамагии' : 'Ещё один вариант метамагии', count: to === first ? 2 : 1, options }); hide(['Метамагия', ...all]); }
    }
    if (edition === '2014' && slug === 'warlock') {
      const prefix = featureRuleOf('invocation', edition)?.pattern || '';
      const pool = Object.keys(d.features || {}).map(Number).filter(l => l <= to).sort((a, b) => a - b).flatMap(l => listed(l)).filter(n => n.startsWith(prefix));
      const nb = Number(prog?.levels?.[String(to)]?.['x:invocations_known']) || 0, na = Number(prog?.levels?.[String(from)]?.['x:invocations_known']) || 0;
      const options = [...new Set(pool)].filter(n => !owned.has(n)).map(opt), known = (sheet.features || []).filter(f => f.name.startsWith(prefix));
      if (nb > na && options.length) groups.push({ id: 'inv', kind: 'feature', label: 'Таинственные воззвания', hint: `Новых воззваний: ${nb - na}`, count: nb - na, options, swap: known.length ? known.map(f => ({ uid: f.uid, name: f.name })) : null });
      else if (from > 0 && known.length && options.length) groups.push({ id: 'inv', kind: 'feature', label: 'Таинственные воззвания', hint: 'Можно заменить одно воззвание', count: 0, options, swap: known.map(f => ({ uid: f.uid, name: f.name })) });
      hide(listed(to).filter(n => n.startsWith(prefix) || hasFeatureKind(n, 'invocation', edition)));
      const choice = names.find(n => hasFeatureKind(n, 'pact_choice', edition));
      if (choice) {
        const boons = names.filter(n => hasFeatureKind(n, 'pact_boon', edition) && !owned.has(n)).map(opt);
        if (boons.length) { groups.push({ id: 'pact', kind: 'feature', label: choice, hint: 'Выберите договор', count: 1, options: boons }); hide([choice, ...names.filter(n => hasFeatureKind(n, 'pact_boon', edition))]); }
      }
    }
    if (edition === '2014' && slug === 'ranger') {
      let i = 0;
      for (const n of names) {
        if (hasFeatureKind(n, 'enemy', edition)) groups.push({ id: 'enemy' + i++, kind: 'text', label: 'Избранный враг', hint: 'Тип существ', feature: n, suggestions: ENEMY_TYPES, count: 1 });
        else if (hasFeatureKind(n, 'terrain', edition)) groups.push({ id: 'terrain' + i++, kind: 'text', label: 'Природный исследователь', hint: 'Тип местности', feature: n, suggestions: TERRAINS, count: 1 });
      }
    }
    return { groups, hidden };
  }

  /// План повышения класса на один уровень: что изменится и какие выборы нужны. Если класса на листе нет — это мультиклассирование (уровень 1 нового класса).
  /// opts.resolve(name) возвращает запись справочника для других классов листа (нужна для ячеек мультикласса).
  function plan(sheet, entry, edition = sheet.edition || '2014', opts = {}) {
    const row = classRow(sheet, entry), classes = classesOf(sheet), isNew = !row;
    const from = isNew ? 0 : row.level, to = from + 1, d = entry?.data || {}, prog = progression(entry, edition);
    const totalFrom = classes.reduce((n, c) => n + c.level, 0) || (isNew ? Math.max(0, Math.round(Number(sheet.level) || 0)) : clampLevel(sheet.level)), totalTo = totalFrom + 1;
    if (totalFrom >= MAX_LEVEL || (!isNew && from >= MAX_LEVEL)) throw new RangeError('Достигнут предел 20-го уровня персонажа или класса.');
    const slug = slugOf(entry), castMod = modOf(sheet.abilities?.[sheet.spells?.ability || d.spellcasting || 'int']);
    const before = spellStats(entry, edition, from, castMod), after = spellStats(entry, edition, to, castMod);
    const { groups, hidden } = optionGroups(entry, edition, from, to, sheet, prog);
    const feats = classFeaturesAt(entry, to).filter(f => !hidden.has(f.name)).map(f => ({ ...f, source: entry.name, tag: groups.some(g => g.feature === f.name) ? 'pick' : featureTagOf(f.name, edition) }));
    const expertise = expertiseGain(edition, slug, to);
    const expertiseFrom = edition === '2024' && slug === 'wizard' && to === 2 ? (d.skills?.from || []).map(skillKeyFromName).filter(Boolean) : null;
    if (expertise && !feats.some(f => hasFeatureKind(f.name, 'expertise', edition) || /экспертиз/i.test(f.text))) feats.push({ name: 'Экспертиза', text: `Выберите ${expertise} владения навыками для экспертизы.`, source: entry.name, tag: 'expertise' });
    const subLevel = subclassLevel(entry), subclass = subclassOf(entry, row?.subclass || opts.subclass?.name);
    const needSubclass = !subclass && subLevel !== null && to >= subLevel && (d.subclasses || []).length > 0;
    const subFeatures = subclassFeaturesAt(subclass, to, row?.subclass_choices || {}).map(f => ({ ...f, source: subclass.name, tag: '' }));
    const changes = [];
    const pbFrom = profBonus(totalFrom), pbTo = profBonus(totalTo);
    for (const col of prog?.columns || []) {
      const a = columnValue(prog, col, from), b = columnValue(prog, col, to);
      if (b !== undefined && a !== b) changes.push({ label: col.ru || col.en, from: a, to: b });
    }
    const spells = { cantrips: 0, spells: 0, mode: null, swap: 0, maxLevel: after?.maxSpellLevel || 0, prepared: after?.prepared ?? null, book: 0, secrets: 0 };
    if (after) {
      spells.cantrips = Math.max(0, after.cantrips - (before?.cantrips || 0));
      if (after.known !== null) { spells.mode = 'known'; spells.spells = Math.max(0, after.known - (before?.known || 0)); }
      else if (edition === '2024' && (window.ClassRules.isPicker(entry, edition) || window.ClassRules.casterLevel(entry, edition) === 'half') && after.prepared !== null) { spells.mode = 'known'; spells.spells = Math.max(0, after.prepared - (before?.prepared || 0)); }
      else if (window.ClassRules.startMode(entry, edition) === 'book') { spells.mode = 'book'; spells.spells = after.maxSpellLevel > 0 ? (isNew ? 6 : 2) : 0; }
      else if (after.prepared !== null) spells.mode = 'prepared';
      if (spells.mode === 'known' && from > 0 && after.maxSpellLevel > 0) spells.swap = 1;
      if (feats.some(f => hasFeatureKind(f.name, 'secrets', edition))) spells.secrets = 2;
    }
    const resolve = opts.resolve || (() => null);
    const nextClasses = isNew ? [...classes.filter(c => c.name), { name: entry.name, level: 1, subclass: '' }] : classes.map(c => c === row || sameClass(c.name, entry) ? { ...c, level: to } : c);
    const cur = castingSummary(edition, classes.filter(c => c.name), n => sameClass(n, entry) ? entry : resolve(n));
    const nxt = castingSummary(edition, nextClasses, n => sameClass(n, entry) ? entry : resolve(n));
    const multi = isNew ? classes.some(c => c.name) : classes.filter(c => c.name).length > 1;
    const req = isNew ? multiclassReq(sheet.abilities, slug, sheet.edition) : null;
    const reqCurrent = isNew ? classes.filter(c => c.name).map(c => ({ name: c.name, ...multiclassReq(sheet.abilities, slugOf(resolve(c.name)), sheet.edition) })).filter(r => !r.ok) : [];
    const skillRule = isNew && multi && ['bard', 'ranger', 'rogue'].includes(slug) ? { count: 1, any: slug === 'bard', from: d.skills?.from || [] } : null;
    return { from, to, entry, slug, edition, isNew, multi, hitDie: dieOf(entry), pb: { from: pbFrom, to: pbTo }, total: { from: totalFrom, to: totalTo }, columns: changes, features: feats, subclass, subclassChoices: row?.subclass_choices || {}, subclassFeatures: subFeatures,
      needSubclass, subclassLevel: subLevel, asi: feats.some(f => f.tag === 'asi'), epic: feats.some(f => f.tag === 'epic'), expertise, expertiseFrom,
      groups, spells, slotsFrom: (multi || cur.combined ? cur.slots : before?.slots) || null, slotsTo: multi || nxt.combined ? nxt.slots : (after?.slots || null), combined: nxt.combined, casterLevel: nxt.casterLevel,
      pactFrom: cur.pact, pactTo: nxt.pact, castingFrom: cur, castingTo: nxt, nextClasses,
      multiclass: isNew && multi ? { req, reqCurrent, proficiency: mcProficiency(slug, sheet.edition), skill: skillRule } : null };
  }
  const hpAverage = die => Math.floor(die / 2) + 1;
  const hpChoiceValid = (die, choice) => choice?.mode === 'avg' || (['roll', 'manual'].includes(choice?.mode) && Number.isInteger(Number(choice.mode === 'roll' ? choice.roll : choice.manual)) && Number(choice.mode === 'roll' ? choice.roll : choice.manual) >= 1 && Number(choice.mode === 'roll' ? choice.roll : choice.manual) <= Number(die));
  /// Прирост хитов: значение кости + мод. Телосложения (не меньше 1) и задним числом за смену мода.
  function hpGain(die, choice, conBefore, conAfter, fromLevel) {
    const base = choice.mode === 'roll' ? Number(choice.roll) || 0 : choice.mode === 'manual' ? Number(choice.manual) || 0 : hpAverage(die);
    const gain = Math.max(1, base + conAfter);
    const retro = (conAfter - conBefore) * fromLevel;
    return { base, conMod: conAfter, gain, retro, total: gain + retro };
  }
  /// Допустимые улучшения характеристик: до +2 суммарно, максимум 20.
  const asiValid = (abilities, plus) => {
    const total = KEYS.reduce((n, k) => n + (plus[k] || 0), 0);
    const room = KEYS.reduce((n, k) => n + Math.min(2, Math.max(0, 20 - (abilities[k] || 10))), 0);
    return KEYS.every(k => Number.isInteger(plus[k] || 0) && (plus[k] || 0) >= 0 && (plus[k] || 0) <= 2 && Number.isInteger(abilities[k] || 10) && (abilities[k] || 10) + (plus[k] || 0) <= 20) && total === Math.min(2, room);
  };
  function expertiseCandidates(sheet, allowThievesTools = false, only = null) {
    const allowed = Array.isArray(only) ? new Set(only) : null;
    const candidates = (sheet.skills || []).filter(key => !(sheet.expertise || []).includes(key) && (!allowed || allowed.has(key)));
    if (allowThievesTools && (!allowed || allowed.has('thieves_tools')) && /воровские инструменты/i.test(sheet.proficiencies || '') && !(sheet.expertise || []).includes('thieves_tools')) candidates.push('thieves_tools');
    return candidates;
  }
  const hitDiceOf = (classes, dieFor) => { const by = new Map(); for (const c of classes) { const die = Number(c.hit_die) || dieFor(c); by.set(die, (by.get(die) || 0) + c.level); } return [...by].map(([die, n]) => `${n}d${die}`).join('+'); };

  /// Применить повышение к листу. choices: { hp, subclass, asi:{mode,plus,feat}, expertise:[], cantrips:[], spells:[], drop:[uid],
  /// picks:{группа:[имена]}, feats:{группа:запись черты}, texts:{группа:строка}, swap:{группа:uid умения}, secrets:[записи заклинаний], skills:[ключи] }.
  // ---------- Чистая логика: применение плана к листу и отмена повышения ----------
  function apply(sheet, p, choices = {}, deps = {}) {
    if (p.total.from >= MAX_LEVEL || p.total.to > MAX_LEVEL || p.to > MAX_LEVEL) throw new RangeError('Нельзя повысить персонажа или класс выше 20-го уровня.');
    if (!hpChoiceValid(p.hitDie, choices.hp || { mode: 'avg' })) throw new RangeError(`Значение хитов должно быть целым числом от 1 до ${p.hitDie}.`);
    const M = deps.Modules || (typeof window !== 'undefined' ? window.Modules : null);
    const newFeature = deps.newFeature || (f => M.newFeature(f));
    const spellFrom = deps.spellFromCompendium || (e => M.spellFromCompendium(e));
    const resolve = deps.resolve || (() => null);
    const log = { level: p.to, total: p.total.to, class: p.entry.name, at: deps.now || new Date().toISOString(), choices: [] };
    sheet.features ||= []; sheet.skills ||= []; sheet.abilities ||= {}; sheet.hp ||= { max: 0, current: 0, temp: 0 };
    const undo = { prev: { level: sheet.level, pb: sheet.proficiency_bonus, hit_dice: sheet.hp.hit_dice, class: sheet.class, subclass: sheet.subclass, classes: sheet.classes ? JSON.parse(JSON.stringify(sheet.classes)) : null, proficiencies: sheet.proficiencies },
      abilities: {}, features: [], removedFeatures: [], spells: [], droppedSpells: [], skills: [], expertise: [], slots: sheet.spells?.slots ? JSON.parse(JSON.stringify(sheet.spells.slots)) : null, pactSlots: sheet.spells?.pact_slots ? JSON.parse(JSON.stringify(sheet.spells.pact_slots)) : null, spellAbility: sheet.spells?.ability };
    const addFeature = f => { const x = newFeature(f); sheet.features.push(x); if (x.uid) undo.features.push(x.uid); return x; };
    const conBefore = modOf(sheet.abilities?.con);
    if (choices.asi?.mode === 'asi') {
      for (const k of KEYS) if (choices.asi.plus?.[k]) { const old = sheet.abilities[k] || 10, now = Math.min(20, old + choices.asi.plus[k]); sheet.abilities[k] = now; undo.abilities[k] = now - old; }
      const ups = KEYS.filter(k => choices.asi.plus?.[k]);
      if (ups.length) log.choices.push('Характеристики: ' + ups.map(k => `${(typeof ABIL !== 'undefined' && ABIL[k]) || k} +${choices.asi.plus[k]}`).join(', '));
    } else if (choices.asi?.mode === 'feat' && choices.asi.feat) {
      const f = choices.asi.feat, abilityRule = featAbilityRule(f), ability = choices.asi.ability;
      if (!featPrerequisitesMet(f, p, sheet)) throw new Error(`Не выполнены предварительные условия черты «${f.name}».`);
      if (abilityRule) {
        if (!abilityRule.allowed.includes(ability) || Number(sheet.abilities[ability] || 10) >= abilityRule.max) throw new Error(`Выберите допустимую характеристику для черты «${f.name}».`);
        const old = Number(sheet.abilities[ability]) || 10;
        sheet.abilities[ability] = Math.min(abilityRule.max, old + abilityRule.amount);
        undo.abilities[ability] = sheet.abilities[ability] - old;
        log.choices.push(`Характеристика от черты: ${abilName(ability)} +${undo.abilities[ability]}`);
      }
      addFeature({ name: f.name, text: f.data?.desc || '', mechanics: f.data?.mechanics, source: 'Черта · уровень ' + p.total.to });
      log.choices.push('Черта: ' + f.name);
    }
    const hp = hpGain(p.hitDie, choices.hp || { mode: 'avg' }, conBefore, modOf(sheet.abilities?.con), p.total.from);
    // классы листа
    const before = classesOf(sheet).filter(c => c.name), classes = before.length ? before.map(c => ({ ...c })) : [];
    const rowIdx = classes.findIndex(c => sameClass(c.name, p.entry));
    if (rowIdx >= 0) { classes[rowIdx].level = p.to; classes[rowIdx].hit_die = p.hitDie; } else classes.push({ name: p.entry.name, level: p.to, subclass: '', hit_die: p.hitDie });
    const idx = rowIdx >= 0 ? rowIdx : classes.length - 1;
    sheet.level = p.total.to; sheet.proficiency_bonus = p.pb.to;
    sheet.hp.max = Math.max(1, (sheet.hp.max || 0) + hp.total); sheet.hp.current = Math.min(sheet.hp.max, (sheet.hp.current || 0) + hp.total);
    undo.hpTotal = hp.total;
    log.hp = hp.total;
    const sub = choices.subclass || p.subclass, subName = sub?.name;
    if (choices.subclass) { classes[idx].subclass = choices.subclass.name; log.choices.push('Подкласс: ' + choices.subclass.name); }
    else if (p.subclass && !classes[idx].subclass) classes[idx].subclass = p.subclass.name;
    const selectedSubclassChoices = { ...(classes[idx].subclass_choices || {}), ...(choices.subclassVariants || {}) };
    if (Object.keys(selectedSubclassChoices).length) classes[idx].subclass_choices = selectedSubclassChoices;
    for (const [base, name] of Object.entries(choices.subclassVariants || {})) log.choices.push(`${base}: ${name.split(':').slice(1).join(':').trim()}`);
    for (const c of classes) if (!c.hit_die) c.hit_die = dieOf(resolve(c.name)) || 8;
    sheet.classes = classes;
    sheet.class = classLabel(classes); sheet.subclass = subclassLabel(classes);
    sheet.hp.hit_dice = hitDiceOf(classes, c => dieOf(resolve(c.name)));
    const picked = new Set();
    const own = new Set((sheet.features || []).map(f => f.name + '|' + f.source));
    const src = name => `${name} ${p.to}`;
    const forFeature = name => typeof window !== 'undefined' && window.Mechanics?.forFeature ? window.Mechanics.forFeature(p.entry.data?.mechanics, name) : undefined;
    // варианты умений: выбранные попадают на лист, при замене прежнее воззвание снимается
    for (const g of p.groups || []) {
      if (g.kind === 'feature') {
        const swapUid = choices.swap?.[g.id];
        if (swapUid) { const i = sheet.features.findIndex(f => f.uid === swapUid); if (i >= 0) { undo.removedFeatures.push(sheet.features[i]); log.choices.push(`${g.label}: замена «${sheet.features[i].name}»`); sheet.features.splice(i, 1); } }
        const names = choices.picks?.[g.id] || [];
        for (const n of names) { const o = (g.options || []).find(x => x.name === n); if (!o) continue; addFeature({ name: o.name, text: o.text || '', source: src(p.entry.name), mechanics: forFeature(o.name) }); picked.add(o.name); }
        if (names.length) log.choices.push(`${g.label}: ${names.map(n => n.replace(/^(Боевой стиль|Таинственные воззвания):?\s+/, '')).join(', ')}`);
      } else if (g.kind === 'feat') {
        const f = choices.feats?.[g.id];
        if (f) { addFeature({ name: f.name, text: f.data?.desc || '', source: `${g.label} · ${p.entry.name} ${p.to}` }); log.choices.push(`${g.label}: ${f.name}`); }
      }
    }
    const gained = [...p.features.map(f => ({ ...f })), ...subclassFeaturesAt(sub, p.to, selectedSubclassChoices).map(f => ({ ...f, source: subName }))];
    // при выборе подкласса на этом уровне добавляются и его умения этого уровня
    for (const f of gained) {
      if (f.tag === 'asi' || f.tag === 'epic') continue;
      const source = src(f.source || p.entry.name);
      if (own.has(f.name + '|' + source)) continue;
      const tg = (p.groups || []).find(g => g.kind === 'text' && g.feature === f.name), value = tg ? String(choices.texts?.[tg.id] || '').trim() : '';
      if (value) log.choices.push(`${tg.label}: ${value}`);
      addFeature({ name: f.name, text: value ? `${tg.label}: ${value}.\n${f.text || ''}` : f.text || '', source, mechanics: forFeature(f.name) });
    }
    if (choices.subclassSkills?.length) {
      for (const key of choices.subclassSkills) if ((typeof SKILLS === 'undefined' || SKILLS.some(([skill]) => skill === key)) && !sheet.skills.includes(key)) { sheet.skills.push(key); undo.skills.push(key); }
      log.choices.push('Навыки подкласса: ' + choices.subclassSkills.map(skillName).join(', '));
    }
    // мультиклассирование: владения нового класса
    if (p.multiclass) {
      const prof = p.multiclass.proficiency;
      if (prof) {
        addFeature({ name: `Владения мультикласса: ${p.entry.name}`, text: `При первом уровне в классе «${p.entry.name}» вы получаете владение: ${prof}.`, source: src(p.entry.name) });
        const old = String(sheet.proficiencies || ''); sheet.proficiencies = (old ? old.replace(/\s+$/, '') + '\n' : '') + `${p.entry.name} (мультикласс): ${prof}`;
      }
      for (const k of choices.skills || []) if (!sheet.skills.includes(k)) { sheet.skills.push(k); undo.skills.push(k); }
      if (choices.skills?.length) log.choices.push('Навыки: ' + choices.skills.map(skillName).join(', '));
      log.choices.push('Новый класс: ' + p.entry.name);
    }
    if (choices.expertise?.length) {
      for (const k of choices.expertise) if (!(sheet.expertise || []).includes(k)) undo.expertise.push(k);
      sheet.expertise = [...new Set([...(sheet.expertise || []), ...choices.expertise])];
      if (choices.expertise.includes('thieves_tools') && !(undo.prev.proficiencies || '').includes('Экспертиза инструмента'))
        sheet.proficiencies = `${String(sheet.proficiencies || '').trim()}\nЭкспертиза инструмента: Воровские инструменты`.trim();
      for (const k of choices.expertise) if (k !== 'thieves_tools' && !sheet.skills.includes(k)) { sheet.skills.push(k); undo.skills.push(k); }
      log.choices.push('Компетентность: ' + choices.expertise.map(skillName).join(', '));
    }
    const stats = spellStats(p.entry, p.edition, p.to, modOf(sheet.abilities?.[sheet.spells?.ability || p.entry.data?.spellcasting || 'int']));
    if (stats) {
      sheet.spells ||= { known: [], slots: {}, ability: '' }; sheet.spells.known ||= []; sheet.spells.slots ||= {};
      if (!sheet.spells.ability && p.entry.data?.spellcasting) sheet.spells.ability = p.entry.data.spellcasting;
      const casting = castingSummary(p.edition, classes, n => sameClass(n, p.entry) ? p.entry : resolve(n));
      const isSlotClass = stats.slots.some(n => n > 0) || stats.pact || (p.spells.mode !== null) || casting.combined;
      if (isSlotClass) for (let l = 1; l <= 9; l++) {
        const max = casting.slots[l - 1];
        const old = sheet.spells.slots[l] || { max: 0, used: 0 };
        if (max || old.max) sheet.spells.slots[l] = { max, used: Math.min(old.used || 0, max) };
      }
      if (casting.pact) {
        const oldPact = sheet.spells.pact_slots;
        const legacy = undo.slots?.[casting.pact.level] || { used: 0 };
        const legacyUsed = Math.max(0, (legacy.used || 0) - (casting.slots[casting.pact.level - 1] || 0));
        sheet.spells.pact_slots = { level: casting.pact.level, max: casting.pact.count, used: Math.min(oldPact?.used ?? legacyUsed, casting.pact.count) };
      } else delete sheet.spells.pact_slots;
      const drop = new Set(choices.drop || []);
      if (drop.size) { undo.droppedSpells = sheet.spells.known.filter(x => drop.has(x.uid)); sheet.spells.known = sheet.spells.known.filter(x => !drop.has(x.uid)); }
      const have = new Set(sheet.spells.known.map(x => x.name));
      const added = [];
      for (const e of [...(choices.cantrips || []), ...(choices.spells || []), ...(choices.secrets || [])]) {
        if (have.has(e.name)) continue; have.add(e.name);
        const sp = spellFrom(e); sp.prepared = p.spells.mode === 'known' || sp.level === 0 || (choices.secrets || []).includes(e) ? true : !!sp.prepared;
        sp.casting_mode = p.spells.mode || sp.casting_mode || null; sp.source_class = p.entry.name;
        sheet.spells.known.push(sp); added.push(e.name); if (sp.uid) undo.spells.push(sp.uid);
      }
      if (added.length) log.choices.push(`Заклинания: ${added.join(', ')}`);
    }
    // на листе остаётся только последняя запись с данными для отмены
    for (const l of sheet.level_log || []) delete l.undo;
    log.undo = undo;
    sheet.level_log = [...(sheet.level_log || []), log].slice(-40);
    return { hp, log };
  }

  /// Можно ли отменить последнее повышение: запись есть, а уровень листа с тех пор не менялся вручную.
  function canUndo(sheet) {
    const log = (sheet.level_log || [])[(sheet.level_log || []).length - 1];
    return !!(log?.undo && Number(sheet.level) === Number(log.total));
  }
  /// Откатить последнее повышение: вернуть уровень, классы, хиты, характеристики, умения, заклинания и ячейки. Прочие правки листа остаются.
  function undo(sheet) {
    if (!canUndo(sheet)) throw new Error('Отменить нельзя: уровень листа изменён вручную или записи об отмене нет.');
    const log = sheet.level_log.pop(), u = log.undo, prev = u.prev;
    for (const [k, n] of Object.entries(u.abilities || {})) sheet.abilities[k] = Math.max(1, (sheet.abilities[k] || 10) - n);
    sheet.level = prev.level; sheet.proficiency_bonus = prev.pb; sheet.hp.hit_dice = prev.hit_dice; sheet.class = prev.class; sheet.subclass = prev.subclass;
    if (prev.classes) sheet.classes = prev.classes; else delete sheet.classes;
    if (prev.proficiencies !== undefined) sheet.proficiencies = prev.proficiencies;
    sheet.hp.max = Math.max(1, (sheet.hp.max || 1) - (u.hpTotal || 0)); sheet.hp.current = Math.min(sheet.hp.max, sheet.hp.current || 0);
    const gone = new Set(u.features || []);
    sheet.features = (sheet.features || []).filter(f => !gone.has(f.uid));
    for (const f of u.removedFeatures || []) sheet.features.push(f);
    const skills = new Set(u.skills || []), exp = new Set(u.expertise || []);
    sheet.skills = (sheet.skills || []).filter(k => !skills.has(k)); sheet.expertise = (sheet.expertise || []).filter(k => !exp.has(k));
    if (sheet.spells) {
      const sp = new Set(u.spells || []);
      sheet.spells.known = (sheet.spells.known || []).filter(x => !sp.has(x.uid));
      for (const x of u.droppedSpells || []) sheet.spells.known.push(x);
      if (u.slots) {
        // сохраняем потраченные ячейки, если они уместятся в прежний максимум
        const next = {};
        for (const [l, v] of Object.entries(u.slots)) next[l] = { max: v.max, used: Math.min(sheet.spells.slots?.[l]?.used ?? v.used ?? 0, v.max) };
        sheet.spells.slots = next;
      }
      if (u.pactSlots) {
        const pact = u.pactSlots;
        sheet.spells.pact_slots = { ...pact, used: Math.min(sheet.spells.pact_slots?.used ?? pact.used ?? 0, pact.max) };
      } else delete sheet.spells.pact_slots;
      sheet.spells.ability = u.spellAbility ?? sheet.spells.ability;
    }
    return log;
  }

  // ------------------------------------------------------------------ интерфейс ------------------------------------------------------------------
  const h = (tag, cls, ...c) => el(tag, cls ? { class: cls } : {}, ...c);
  const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
  const sign = n => (n >= 0 ? '+' : '') + n;
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };
  const abilName = k => (typeof ABIL !== 'undefined' && ABIL[k]) || k;

  // Цвета классов и школ магии: акцент мастера подстраивается под класс.
  // Типы врагов для избранного врага следопыта — из набора enemy_types (список обновляется при загрузке наборов).
  const ENEMY_TYPES = window.Presets?.liveList('enemy_types') || [];
  // Цвет школы магии из набора spell_schools (поле color).
  const schoolColor = name => window.Presets?.items('spell_schools').find(i => i.table.ru === name)?.table.color || '';
  const classColor = e => window.Presets?.item('class_rules', slugOf(e))?.table?.color || '#8fa8d0';
  const monogram = e => String(e?.name || '?').trim().charAt(0).toUpperCase();
  const hexRgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)).join(', ');
  const savesOf = e => [].concat(e?.data?.saves || []).map(k => (KEYS.includes(k) ? abilName(k) : String(k))).filter(Boolean);
  const primaryKeys = e => { const t = String(e?.data?.primary || '').toLowerCase(); return KEYS.filter(k => t.includes(abilName(k).toLowerCase().slice(0, 5))); };
  const school = e => e?.data?.school || '';
  const shortTime = t => String(t || '').replace(/^1\s+(действие|бонусное)/i, (m, w) => w.charAt(0).toUpperCase() + w.slice(1)).replace(/^Бонусное действие.*/i, 'Бонусное действие').replace(/^Реакция.*/i, 'Реакция');
  const hasPrereq = v => typeof v === 'string' && v.trim() && !/^[a-z_,\s]+$/.test(v);
  const featAbilityRule = feat => {
    const inc = featRuleOf(feat).ability_increase;
    if (!inc || !inc.abilities?.length || !(Number(inc.amount) > 0)) return null;
    return { amount: Number(inc.amount), max: Number(inc.max) || 20, allowed: inc.abilities.slice() };
  };
  function featPrerequisitesMet(feat, p, sheet) {
    const req = featRuleOf(feat).requires || {};
    if (req.level && !(p.total.to >= req.level)) return false;
    if (req.feature_contains) {
      const features = [...(sheet.features || []), ...(p.features || [])];
      if (!features.some(f => { const name = String(f.name || '').toLowerCase(); return req.feature_contains.some(part => name.includes(part)); })) return false;
    }
    for (const [key, min] of Object.entries(req.ability || {})) if (Number(sheet.abilities?.[key] || 10) < min) return false;
    return true;
  }

  /// Простое оформление текста записей справочника: абзацы, маркированные списки и таблицы.
  // ---------- Мастер повышения: тексты, шаги и панели ----------
  function rich(text) {
    const lines = String(text || '').split('\n').map(x => x.trim()).filter(Boolean), out = [];
    const isRow = l => l.startsWith('|'), isLi = l => /^[-•*]\s+/.test(l);
    for (let i = 0; i < lines.length;) {
      if (isRow(lines[i])) {
        const rows = []; while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
        const body = rows.filter(r => !/^\|?[\s:|-]+\|?$/.test(r)).map(r => r.replace(/^\||\|$/g, '').split('|').map(x => x.trim()));
        if (body.length) out.push(h('div', 'lu-table-wrap', el('table', { class: 'lu-table' }, el('thead', {}, el('tr', {}, ...body[0].map(c => el('th', {}, c)))), el('tbody', {}, ...body.slice(1).map(r => el('tr', {}, ...r.map(c => el('td', {}, c))))))));
      } else if (isLi(lines[i])) {
        const items = []; while (i < lines.length && isLi(lines[i])) items.push(lines[i++].replace(/^[-•*]\s+/, ''));
        out.push(el('ul', { class: 'lu-list' }, ...items.map(x => el('li', {}, x))));
      } else out.push(h('p', '', lines[i++]));
    }
    return out;
  }
  const crest = (text, cls = '') => h('span', 'lu-hex ' + cls, h('b', '', String(text)));
  const chip = (text, cls = '') => h('span', 'lu-tagchip ' + cls, text);
  const pips = (n, total, fresh = 0) => h('span', 'lu-pips', ...Array.from({ length: total }, (_, k) => h('i', 'lu-pip' + (k < n ? ' on' : '') + (k >= n - fresh && k < n ? ' new' : ''))));
  const activate = (node, fn, role = 'radio', checked = false) => {
    node.tabIndex = 0; node.setAttribute('role', role); node.setAttribute('aria-checked', String(checked));
    node.addEventListener('click', e => { if (!e.target.closest('[data-stop]')) fn(e); });
    node.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); fn(e); } });
    return node;
  };
  /// Полоса уровней класса 1–20: пройденные, текущий и вехи (улучшение характеристик, подкласс).
  function levelTrack(entry, from, to) {
    const ms = {}, sub = subclassLevel(entry);
    const edition = entry?.data?.edition || '2014';
    for (let l = 1; l <= MAX_LEVEL; l++) { const names = classFeaturesAt(entry, l).map(f => f.name); if (names.some(n => hasFeatureKind(n, 'asi', edition) || hasFeatureKind(n, 'epic', edition))) ms[l] = 'asi'; }
    if (sub && !ms[sub]) ms[sub] = 'sub'; else if (sub) ms[sub] = 'both';
    return h('div', 'lu-track', ...Array.from({ length: MAX_LEVEL }, (_, i) => { const l = i + 1;
      return h('span', 'lu-tick' + (l <= from ? ' done' : '') + (l === to ? ' now' : '') + (ms[l] ? ' ms' : ''), ms[l] ? h('i', '', ms[l] === 'sub' ? '✦' : '★') : null, h('b', '', String(l))); }));
  }
  /// Ячейки заклинаний точками: было → стало.
  function slotsPanel(p) {
    const rows = [];
    for (let i = 0; i < 9; i++) { const a = p.slotsFrom?.[i] || 0, b = p.slotsTo?.[i] || 0; if (!a && !b) continue;
      rows.push(h('div', 'lu-slot-row', h('span', 'lu-slot-lv', `${i + 1} круг`), pips(b, Math.max(a, b), Math.max(0, b - a)), h('span', 'lu-slot-n', b !== a ? h('s', '', String(a)) : null, b !== a ? ' → ' : '', h('b', '', String(b))))); }
    if (p.pactTo) rows.push(h('div', 'lu-slot-row', h('span', 'lu-slot-lv', 'Договор'), pips(p.pactTo.count, Math.max(p.pactTo.count, p.pactFrom?.count || 0), Math.max(0, p.pactTo.count - (p.pactFrom?.count || 0))),
      h('span', 'lu-slot-n', `${p.pactFrom && p.pactFrom.count !== p.pactTo.count ? p.pactFrom.count + ' → ' : ''}`, h('b', '', String(p.pactTo.count)), ` × ${p.pactTo.level} кр.`)));
    if (!rows.length) return null;
    return h('section', 'lu-panel', h('h3', 'lu-h', 'Ячейки заклинаний', p.combined ? h('small', 'muted', `общий уровень заклинателя ${p.casterLevel}`) : null), ...rows);
  }

  /// Класс, который повышается по умолчанию: последний из журнала повышений, иначе первый класс листа.
  async function findClass(sheet, campaignId) {
    const cur = classesOf(sheet).filter(c => c.name), last = (sheet.level_log || []).slice().reverse().find(l => cur.some(c => c.name === l.class));
    const name = last?.class || cur[0]?.name || '';
    const snap = [...(sheet.modules || [])].reverse().find(m => m.category === 'class' && m.snapshot && (!name || m.snapshot.name === name));
    const params = new URLSearchParams({ edition: sheet.edition || '2014', limit: '3000', category: 'class' }); if (campaignId) params.set('campaign_id', campaignId);
    const list = await API.get('/api/compendium?' + params);
    const found = list.find(e => sameClass(name, e));
    return { list, entry: found || (snap ? snap.snapshot : null) };
  }
  async function loadCatalog(category, sheet, campaignId) {
    const params = new URLSearchParams({ edition: sheet.edition || '2014', limit: '3000', category }); if (campaignId) params.set('campaign_id', campaignId);
    return API.get('/api/compendium?' + params);
  }

  /// Открыть мастер повышения уровня. Меняет переданный лист на месте и возвращает true, если уровень повышен.
  // ---------- Мастер повышения: открытие и сохранение ----------
  async function open({ sheet, campaignId, onApply }) {
    if ((sheet.level || 1) >= 20) { toast('Достигнут максимальный уровень — 20.'); return false; }
    return new Promise(resolve => {
      const root = h('div', 'lu-overlay'), shell = h('div', 'lu-shell'); root.append(shell); document.body.append(root); document.body.classList.add('lu-open');
      const st = { loading: true, error: '', entry: null, classes: [], p: null, step: 0, hp: { mode: 'avg', roll: 0, manual: '' }, subclass: null, subclassSkills: [], subclassVariants: {}, asi: { mode: 'asi', plus: {}, feat: null, ability: '' }, expertise: [], cantrips: [], spells: [], drop: [],
        catalogs: {}, q: '', lvFilter: 0, featQ: '', open: new Set(), done: null, applied: false, pick: {}, pfeat: {}, ptext: {}, pswap: {}, secrets: [], skills: [], ignoreReq: false };
      const resolveEntry = name => (st.entry && sameClass(name, st.entry) ? st.entry : null) || st.classes.find(e => sameClass(name, e)) || null;
      const close = ok => { root.remove(); document.body.classList.remove('lu-open'); document.removeEventListener('keydown', onKey); resolve(ok); };
      const onKey = e => { if (e.key === 'Escape' && !st.busy) close(st.applied); };
      document.addEventListener('keydown', onKey);
      const steps = () => {
        const p = st.p, out = [{ id: 'class', label: 'Класс', hint: p.isNew ? 'Новый класс' : p.entry.name }, { id: 'overview', label: 'Обзор', hint: `Уровень ${p.to}` }, { id: 'hp', label: 'Здоровье', hint: 'Кость хитов' }];
        if (p.needSubclass) out.push({ id: 'subclass', label: 'Подкласс', hint: 'Выберите путь' });
        if (subclassVariantRules().length) out.push({ id: 'subclass_variants', label: 'Выбор пути', hint: 'Выберите один вариант умения' });
        if (p.multiclass?.skill) out.push({ id: 'skills', label: 'Навык', hint: 'Владение навыком' });
        if (subclassSkillRule()) out.push({ id: 'subclass_skills', label: 'Навыки подкласса', hint: 'Три навыка Коллегии знаний' });
        if (p.asi) out.push({ id: 'asi', label: 'Характеристики', hint: '+2 или черта' });
        if (p.epic) out.push({ id: 'epic', label: 'Эпический дар', hint: 'Выберите дар' });
        if (p.expertise) out.push({ id: 'expertise', label: 'Компетентность', hint: 'Два навыка' });
        if (optionGroupsNeeded()) out.push({ id: 'options', label: 'Варианты', hint: p.groups.map(g => g.label).filter((v, i, a) => a.indexOf(v) === i).join(', ') });
        if (p.spells.cantrips + subclassCantripChoices() || p.spells.spells || p.spells.secrets) out.push({ id: 'spells', label: 'Заклинания', hint: 'Новые заклинания и заговоры' });
        out.push({ id: 'summary', label: 'Итог', hint: 'Подтвердить' });
        return out;
      };
      const conBefore = () => modOf(sheet.abilities?.con);
      const newAbilities = () => Object.fromEntries(KEYS.map(k => {
        const base = Number(sheet.abilities[k]) || 10;
        if (st.asi.mode === 'asi') return [k, base + (st.asi.plus[k] || 0)];
        const rule = featAbilityRule(st.asi.feat);
        return [k, base + (rule && st.asi.ability === k && rule.allowed.includes(k) && base < rule.max ? rule.amount : 0)];
      }));
      const hpInfo = () => hpGain(st.p.hitDie, st.hp, conBefore(), modOf(newAbilities().con), st.p.total.from);
      const spellPool = () => {
        const cls = st.p.entry.name, maxLv = st.p.spells.maxLevel, have = new Set([...sheet.spells.known.filter(x => !st.drop.includes(x.uid)).map(x => x.name), ...st.secrets.map(e => e.name)]);
        return (st.catalogs.spell || []).filter(e => { const c = e.data?.classes || []; return (!c.length || c.includes(cls)) && !have.has(e.name); });
      };
      const styleFeats = () => { const have = new Set((sheet.features || []).map(f => f.name)); return (st.catalogs.feat || []).filter(e => isStyleFeat(e) && !have.has(e.name) && featPrerequisitesMet(e, st.p, sheet)); };
      const selectedFeatValid = () => {
        const feat = st.asi.feat, rule = featAbilityRule(feat);
        return !!feat && featPrerequisitesMet(feat, st.p, sheet) && (!rule || (rule.allowed.includes(st.asi.ability) && Number(sheet.abilities[st.asi.ability] || 10) < rule.max));
      };
      const optionNeed = g => g.kind === 'feature' ? Math.min(g.count, (g.options || []).length) : g.kind === 'feat' ? Math.min(g.count, styleFeats().length) : g.count;
      const optionGroupsNeeded = () => st.p.groups.some(g => optionNeed(g) > 0 || (g.swap && g.swap.length));
      const secretsPool = () => {
        const p = st.p, have = new Set([...sheet.spells.known.map(x => x.name), ...st.cantrips.map(e => e.name), ...st.spells.map(e => e.name)]);
        const four = ['Бард', 'Жрец', 'Друид', 'Волшебник', 'Bard', 'Cleric', 'Druid', 'Wizard'];
        return (st.catalogs.spell || []).filter(e => (e.data?.level || 0) <= p.spells.maxLevel && !have.has(e.name) && (p.edition !== '2024' || (e.data?.classes || []).some(c => four.includes(c))));
      };
      const subclassSkillRule = () => subclassSkillChoices(st.p.entry, st.subclass || st.p.subclass, st.p.to);
      const subclassVariantRules = () => subclassVariantGroups(st.subclass || st.p.subclass, st.p.to);
      const subclassCantripChoices = () => {
        const sub = st.subclass || st.p.subclass;
        return subclassCantripGain(st.p.entry, sub, st.p.edition, st.p.to);
      };
      const skillCandidates = (rule = st.p.multiclass?.skill) => {
        if (!rule) return [];
        const owned = new Set(sheet.skills || []);
        return SKILLS.filter(x => !owned.has(x[0]) && (rule.any || rule.from.includes(x[1]))).map(x => x[0]);
      };
      const valid = id => {
        const p = st.p;
        if (id === 'class') return !p.isNew || !p.multiclass || st.ignoreReq || (p.multiclass.req.ok && !p.multiclass.reqCurrent.length);
        if (id === 'skills') return st.skills.length === Math.min(p.multiclass?.skill?.count || 0, skillCandidates().length);
        if (id === 'subclass_skills') { const rule = subclassSkillRule(); return !!rule && st.subclassSkills.length === Math.min(rule.count, skillCandidates(rule).length); }
        if (id === 'options') return p.groups.every(g => g.kind === 'text' ? String(st.ptext[g.id] || '').trim().length > 0 : g.kind === 'feat' ? (st.pfeat[g.id] ? 1 : 0) === optionNeed(g) : (st.pick[g.id] || []).length === optionNeed(g));
        if (id === 'hp') return hpChoiceValid(p.hitDie, st.hp);
        if (id === 'subclass') return !!st.subclass && (p.entry.data?.subclasses || []).some(sub => sub.name === st.subclass.name);
        if (id === 'subclass_variants') { const saved = { ...(p.subclassChoices || {}), ...(st.subclassVariants || {}) }; return subclassVariantRules().every(group => group.options.includes(saved[group.base])); }
        if (id === 'asi') return st.asi.mode === 'asi' ? asiValid(sheet.abilities, st.asi.plus) : selectedFeatValid();
        if (id === 'epic') return selectedFeatValid();
        if (id === 'expertise') return st.expertise.length === Math.min(p.expertise, expertiseCandidates(sheet, p.edition === '2014' && p.slug === 'rogue', p.expertiseFrom).length);
        if (id === 'spells') {
          const pool = spellPool(); const c = pool.filter(e => (e.data?.level || 0) === 0).length, s = pool.filter(e => (e.data?.level || 0) > 0 && (e.data?.level || 0) <= p.spells.maxLevel).length;
          return st.cantrips.length === Math.min(p.spells.cantrips + subclassCantripChoices(), c) && st.spells.length === Math.min(p.spells.spells + st.drop.length, s) && st.secrets.length === Math.min(p.spells.secrets, secretsPool().length);
        }
        return true;
      };

      // ----- отрисовка шагов -----
      const SUB = { class: 'Какой класс повышаем', overview: 'Что вы получаете', hp: 'Кость хитов', subclass: 'Ваш путь и его умения', skills: 'Владение навыком', subclass_skills: 'Навыки подкласса', subclass_variants: 'Выбор пути', asi: 'Характеристики или черта', epic: 'Награда за мастерство', expertise: 'Двойной бонус мастерства', options: 'Выбор особенностей класса', spells: 'Заклинания и заговоры', summary: 'Проверьте изменения' };
      const tile = ({ icon, label, from, to, note, cls = '' }) => {
        const changed = from !== undefined && from !== null && String(from) !== String(to), delta = changed && typeof from === 'number' && typeof to === 'number' ? to - from : null;
        return h('div', 'lu-tile ' + cls + (changed ? ' up' : ''), h('span', 'lu-tile-ic', icon),
          h('div', 'lu-tile-b', h('small', '', label), h('div', 'lu-tile-v', changed ? [h('s', '', String(from)), h('i', '', '→')] : null, h('b', '', String(to)), delta ? h('em', 'lu-delta', sign(delta)) : null), note ? h('span', 'lu-tile-n', note) : null));
      };
      const featIcon = f => f.tag === 'asi' || f.tag === 'epic' ? '★' : f.tag === 'expertise' ? '✔' : f.tag === 'pick' ? '✦' : f.tag === 'manual' ? '✎' : '◆';
      const featureCard = f => {
        const key = f.source + '|' + f.name, isOpen = st.open.has(key), hasText = !!f.text, toggle = () => { isOpen ? st.open.delete(key) : st.open.add(key); render(); };
        const need = ['pick', 'asi', 'epic', 'expertise'].includes(f.tag) || (st.p.needSubclass && /подкласс|архетип|традиц|коллеги|домен|клятва|круг|путь|покровител|происхожд/i.test(f.name));
        const c = h('article', 'lu-feat' + (isOpen ? ' open' : '') + (need ? ' choose' : ''),
          el('button', { type: 'button', class: 'lu-feat-head', 'aria-expanded': String(isOpen), onclick: toggle },
            h('span', 'lu-feat-ic', featIcon(f)), h('span', 'lu-feat-t', h('b', '', f.name), h('small', '', f.source)),
            need ? chip('Нужен выбор', 'gold') : f.tag === 'manual' ? chip('Вручную', 'warn') : null, h('span', 'lu-chev', '▾')),
          isOpen ? h('div', 'lu-feat-body', ...(hasText ? rich(f.text) : [h('p', 'muted', 'Описание умения в записи класса не заполнено.')]),
            f.tag === 'manual' ? h('p', 'lu-note', 'Вариант этого умения выбирается вручную: найдите его в справочнике и добавьте на лист.') : null)
            : hasText ? h('p', 'lu-feat-ex', clip(f.text.replace(/\|[^\n]*/g, ' '), 190)) : null);
        return c;
      };
      const classFacts = e => {
        const d = e?.data || {}, rows = [['Кость хитов', `d${dieOf(e)}`], ['Основная характеристика', d.primary], ['Спасброски', savesOf(e).join(', ')], ['Доспехи', d.armor], ['Оружие', d.weapons], ['Навыки', d.skills?.choose ? `выберите ${d.skills.choose}` : ''], ['Колдовская характеристика', d.spellcasting ? abilName(d.spellcasting) : '']].filter(r => r[1] && r[1] !== '—');
        return h('dl', 'lu-facts', ...rows.flatMap(([a, b]) => [h('dt', '', a), h('dd', '', b)]));
      };
      const upcoming = p => {
        const rows = [], sub = st.subclass || p.subclass, skip = n => /^(Таинственные воззвания |Договор |Боевой стиль: )/.test(n);
        for (let l = p.to + 1; l <= MAX_LEVEL && rows.length < 4; l++) {
          const names = [...classFeaturesAt(p.entry, l).map(f => f.name).filter(n => !skip(n)).map(n => [n, false]), ...subclassFeaturesAt(sub, l).map(f => [f.name, true])];
          if (names.length) rows.push(h('div', 'lu-up-row', h('span', 'lu-up-lv', h('small', '', 'ур.'), h('b', '', String(l))), h('div', 'lu-up-names', ...names.slice(0, 5).map(([n, s]) => chip((s ? '✦ ' : '') + n, s ? 'sub' : '')), names.length > 5 ? chip(`+${names.length - 5}`, 'muted') : null)));
        }
        return rows.length ? h('section', 'lu-panel', h('h3', 'lu-h', 'Дальше по классу'), ...rows) : null;
      };
      const overview = () => {
        const p = st.p, out = [], list = steps(), picks = list.filter(s => !['class', 'overview', 'summary'].includes(s.id));
        out.push(h('div', 'lu-hero', crest(monogram(p.entry), 'big'),
          h('div', 'lu-hero-b', h('small', 'lu-kick', p.isNew ? 'Новый класс' : p.multi ? `${p.entry.name} · мультикласс` : p.entry.name),
            h('h2', '', ...(p.isNew ? [h('span', 'lu-to', '1')] : [h('span', 'lu-from', String(p.from)), h('i', '', '→'), h('span', 'lu-to', String(p.to))]), h('small', '', ' уровень')),
            h('p', 'muted', p.isNew ? `Вы начинаете новый класс. Общий уровень персонажа: ${p.total.from} → ${p.total.to}.` : `Общий уровень персонажа: ${p.total.from} → ${p.total.to}.`),
            levelTrack(p.entry, p.from, p.to),
            h('div', 'lu-legend', h('span', '', '★ улучшение характеристик'), subclassLevel(p.entry) ? h('span', '', '✦ подкласс') : null))));
        if (picks.length) out.push(h('div', 'lu-todo', h('span', 'lu-todo-t', `Вас ждёт ${picks.length} ${plural(picks.length, 'выбор', 'выбора', 'выборов')}:`), ...picks.map(s => chip(s.label, 'accent'))));
        const tiles = [];
        tiles.push(tile({ icon: '◆', label: 'Бонус мастерства', from: p.pb.from === p.pb.to ? undefined : sign(p.pb.from), to: sign(p.pb.to) }));
        tiles.push(tile({ icon: '⬢', label: 'Кость хитов', from: p.isNew ? undefined : `${p.from}d${p.hitDie}`, to: `${p.to}d${p.hitDie}`, note: `≈ +${hpAverage(p.hitDie) + modOf(sheet.abilities?.con)} хитов` }));
        for (const c of p.columns) tiles.push(tile({ icon: '✧', label: c.label, from: c.from, to: c.to }));
        if (p.spells.secrets) tiles.push(tile({ icon: '✦', label: 'Заклинания любых классов', to: '+' + p.spells.secrets }));
        const newCantrips = p.spells.cantrips + subclassCantripChoices();
        if (newCantrips) tiles.push(tile({ icon: '✧', label: 'Новые заговоры', to: '+' + newCantrips, cls: 'gain' }));
        if (p.spells.spells) tiles.push(tile({ icon: '✧', label: p.spells.mode === 'book' ? 'В книгу заклинаний' : 'Новые заклинания', to: '+' + p.spells.spells, cls: 'gain' }));
        if (p.spells.prepared && (p.spells.mode === 'prepared' || p.spells.mode === 'book')) tiles.push(tile({ icon: '✎', label: 'Подготовлено заклинаний', to: p.spells.prepared }));
        out.push(h('div', 'lu-tiles', ...tiles));
        out.push(slotsPanel(p));
        if (p.multiclass) out.push(h('div', 'lu-callout', h('b', '', 'Мультиклассирование. '), p.multiclass.proficiency ? `Первый уровень класса даёт владения: ${p.multiclass.proficiency}. ` : 'Первый уровень класса не даёт новых владений. ', 'Спасброски и стартовое снаряжение нового класса не выдаются.', p.combined ? ` Ячейки заклинаний считаются по общему уровню заклинателя (${p.casterLevel}).` : ''));
        const all = [...p.features, ...(p.subclass ? p.subclassFeatures : [])];
        out.push(h('h3', 'lu-h', 'Новые умения', h('small', 'muted', all.length ? `${all.length}` : '')));
        out.push(all.length ? h('div', 'lu-feats', ...all.map(featureCard)) : h('div', 'lu-empty', 'На этом уровне новых классовых умений нет — растут только показатели.'));
        if (p.needSubclass) out.push(h('div', 'lu-callout accent', h('b', '', 'Подкласс. '), 'Выберите его на шаге «Подкласс» — он даёт умения уже на этом уровне.'));
        out.push(upcoming(p));
        const about = st.open.has('about');
        out.push(h('section', 'lu-panel about' + (about ? ' open' : ''), el('button', { type: 'button', class: 'lu-about-head', 'aria-expanded': String(about), onclick: () => { about ? st.open.delete('about') : st.open.add('about'); render(); } }, h('h3', 'lu-h', `О классе: ${p.entry.name}`), h('span', 'lu-chev', '▾')), about ? classFacts(p.entry) : null));
        return out;
      };
      const hpStep = () => {
        const p = st.p, die = p.hitDie, info = hpInfo(), hp = st.hp, modNow = modOf(newAbilities().con), oldMax = sheet.hp.max, newMax = Math.max(1, oldMax + info.total);
        const choose = mode => { if (st.busy) return; hp.mode = mode; render(); };
        const dieView = (n, cls = '') => h('span', 'lu-die ' + cls, h('b', '', String(n)), h('small', '', `d${die}`));
        const card = (mode, title, sub, ...body) => activate(h('div', 'lu-option' + (hp.mode === mode ? ' on' : ''), h('div', 'lu-option-title', title), h('div', 'lu-option-sub', sub), ...body), () => choose(mode), 'radio', hp.mode === mode);
        const rollBtn = el('button', { class: 'lu-roll primary', type: 'button', 'data-stop': '1', disabled: hp.roll || st.busy ? '' : null, onclick: e => {
          hp.mode = 'roll'; if (hp.roll || st.busy) return; st.busy = true; const dieEl = shell.querySelector('.lu-die.roll'); dieEl?.classList.add('rolling'); shell.querySelectorAll('.lu-roll').forEach(b => { b.disabled = true; });
          const iv = setInterval(() => { const b = dieEl?.querySelector('b'); if (b) b.textContent = String(1 + Math.floor(Math.random() * die)); }, 55);
          setTimeout(() => { clearInterval(iv); hp.roll = 1 + Math.floor(Math.random() * die); st.busy = false; render(); }, 750); } }, hp.roll ? `Выпало ${hp.roll}` : `Бросить d${die}`);
        const manual = el('input', { type: 'number', min: 1, max: die, step: 1, value: hp.manual, placeholder: `1–${die}`, 'aria-label': 'Своё значение', 'data-stop': '1', oninput: e => { hp.manual = e.target.value; hp.mode = 'manual'; renderSummaryOnly(); } });
        const label = hp.mode === 'roll' ? 'Бросок' : hp.mode === 'manual' ? 'Своё значение' : 'Среднее';
        const barW = Math.round(oldMax / Math.max(newMax, oldMax) * 100);
        return [h('div', 'lu-options', card('avg', 'Среднее', 'Надёжный вариант', dieView(hpAverage(die), 'avg')), card('roll', `Бросок d${die}`, 'Рискните ради большего', dieView(hp.roll || '?', 'roll' + (hp.roll ? ' done' : '')), rollBtn),
          card('manual', 'Своё значение', 'Если бросили кость за столом', manual)),
          h('section', 'lu-panel lu-eq', h('div', 'lu-eq-row', h('div', 'lu-eq-term', h('small', '', label), h('b', 'lu-eq-base', String(info.base))), h('span', 'lu-eq-op', '+'), h('div', 'lu-eq-term', h('small', '', `Телосложение (${sign(modNow)})`), h('b', '', sign(modNow))),
            info.retro ? [h('span', 'lu-eq-op', '+'), h('div', 'lu-eq-term', h('small', '', 'Пересчёт прошлых'), h('b', '', sign(info.retro)))] : null, h('span', 'lu-eq-op', '='), h('div', 'lu-eq-term total', h('small', '', 'Прибавка'), h('b', 'lu-eq-gain', sign(info.total)))),
            h('div', 'lu-hpbar', h('div', 'lu-hpbar-track', el('i', { class: 'base', style: `width:${barW}%` }), el('i', { class: 'gain', style: `width:${100 - barW}%` })), h('div', 'lu-hpbar-l', h('span', '', 'Максимум хитов'), h('b', 'lu-hpmax', `${oldMax} → ${newMax}`))))];
      };
      const subclassStep = () => {
        const p = st.p, list = p.entry.data.subclasses || [];
        const lead = (p.features.find(f => /подкласс|архетип|традиц|коллеги|домен|клятва|круг|путь|покровител|происхожд/i.test(f.name)) || {}).name;
        return [lead ? h('p', 'lu-lead', lead + ' — навсегда определяет облик вашего класса.') : null, h('div', 'lu-cards wide', ...list.map(sub => {
          const on = st.subclass?.name === sub.name, key = 'sc' + sub.name, isOpen = st.open.has(key), lvls = Object.keys(sub.features || {}).map(Number).filter(l => l <= Math.max(p.to + 4, 8)).sort((a, b) => a - b).slice(0, 4);
          const c = h('div', 'lu-pick sub' + (on ? ' on' : ''), h('div', 'lu-pick-head', crest('✦', 'sm'), h('div', 'lu-pick-t', h('b', '', sub.name), sub.name_en ? h('small', 'muted', sub.name_en) : null), on ? h('span', 'lu-check', '✓') : null),
            sub.flavor ? h('p', 'lu-flavor', clip(sub.flavor, 200)) : null,
            sub.desc ? h('div', 'lu-pick-desc' + (isOpen ? ' full' : ''), ...(isOpen ? rich(sub.desc) : [h('p', '', clip(sub.desc, 260))])) : null,
            sub.desc && sub.desc.length > 260 ? el('button', { type: 'button', class: 'lu-more', 'data-stop': '1', onclick: () => { isOpen ? st.open.delete(key) : st.open.add(key); render(); } }, isOpen ? 'Свернуть' : 'Читать полностью') : null,
            lvls.length ? h('div', 'lu-sub-lv', ...lvls.map(l => h('div', 'lu-sub-row' + (l <= p.to ? ' now' : ''), h('span', 'lu-up-lv', h('small', '', 'ур.'), h('b', '', String(l))), h('div', 'lu-up-names', ...subclassFeaturesAt(sub, l).map(f => chip(f.name, l <= p.to ? 'accent' : '')))))) : null);
          return activate(c, () => { st.subclass = sub; render(); }, 'radio', on);
        }))];
      };
      const subclassVariantsStep = () => {
        const sub = st.subclass || st.p.subclass, selected = { ...(st.p.subclassChoices || {}), ...(st.subclassVariants || {}) };
        return subclassVariantRules().map(group => h('section', 'lu-panel', h('h3', 'lu-h', group.base),
          h('p', 'lu-lead', group.base === 'Круг Земли' ? 'Выберите тип местности, от которого зависят умения и заклинания круга.' : 'Выберите один вариант умения подкласса.'),
          h('div', 'lu-cards', ...group.options.map(name => {
            const feature = sub.feature_texts?.[name] || '', option = name.slice(group.base.length + 1).trim(), on = selected[group.base] === name;
            const card = h('div', 'lu-pick' + (on ? ' on' : ''), h('div', 'lu-pick-head', crest('✦', 'sm'), h('div', 'lu-pick-t', h('b', '', option)), on ? h('span', 'lu-check', '✓') : null),
              feature ? h('div', 'lu-pick-desc', h('p', '', clip(feature, 240))) : null);
            return activate(card, () => { st.subclassVariants[group.base] = name; render(); }, 'radio', on);
          }))));
      };
      const featList = (filter, sel = () => st.asi.feat, setSel = e => { st.asi.feat = e; st.asi.ability = ''; }) => {
        const have = new Set((sheet.features || []).map(f => f.name)), fq = st.featQ.toLowerCase();
        const rows = (st.catalogs.feat || []).filter(e => !(featRuleOf(e).groups || []).includes('asi') && !have.has(e.name) && filter(e) && featPrerequisitesMet(e, st.p, sheet) && (!fq || (e.name + ' ' + (e.data?.desc || '')).toLowerCase().includes(fq)));
        const search = el('input', { type: 'search', placeholder: 'Поиск по чертам…', value: st.featQ, 'aria-label': 'Поиск', class: 'lu-search', oninput: e => { st.featQ = e.target.value; const pos = e.target.selectionStart; render(); const i = shell.querySelector('.lu-search'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } } });
        return [search, rows.length ? h('div', 'lu-cards', ...rows.map(e => {
          const on = sel()?.id === e.id && sel()?.name === e.name, key = 'ft' + e.name, isOpen = st.open.has(key), d = e.data || {}, long = String(d.desc || '').length > 240;
          const c = h('div', 'lu-pick' + (on ? ' on' : ''), h('div', 'lu-pick-head', crest('★', 'sm'), h('div', 'lu-pick-t', h('b', '', e.name), hasPrereq(d.prerequisites) ? h('small', 'muted', 'Требуется: ' + d.prerequisites) : null), on ? h('span', 'lu-check', '✓') : null),
            h('div', 'lu-pick-desc' + (isOpen ? ' full' : ''), ...(isOpen ? rich(d.desc) : [h('p', '', clip(d.desc, 240))])),
            long ? el('button', { type: 'button', class: 'lu-more', 'data-stop': '1', onclick: () => { isOpen ? st.open.delete(key) : st.open.add(key); render(); } }, isOpen ? 'Свернуть' : 'Читать полностью') : null);
          return activate(c, () => { setSel(e); render(); }, 'radio', on);
        })) : h('div', 'lu-empty', 'Подходящих черт в справочнике не найдено. Добавьте черту в справочник или выберите повышение характеристик.')];
      };
      const featAbilityChoice = () => {
        const rule = featAbilityRule(st.asi.feat);
        if (!rule) return [];
        const allowed = rule.allowed.filter(key => Number(sheet.abilities[key] || 10) < rule.max);
        return [h('p', 'lu-lead', `Эта черта повышает одну допустимую характеристику на ${rule.amount} (максимум ${rule.max}); выберите её:`),
          el('select', { class: 'lu-select', 'aria-label': 'Характеристика от черты', value: st.asi.ability, onchange: e => { st.asi.ability = e.target.value; render(); } },
            el('option', { value: '' }, 'Выберите характеристику…'), ...allowed.map(key => el('option', { value: key, selected: st.asi.ability === key ? '' : null }, `${abilName(key)}: ${sheet.abilities[key] || 10} → ${(sheet.abilities[key] || 10) + rule.amount}`)))];
      };
      const asiStep = () => {
        const tabs = h('div', 'lu-tabs', ...[['asi', 'Повысить характеристики'], ['feat', '★ Взять черту']].map(([m, t]) => el('button', { type: 'button', class: st.asi.mode === m ? 'on' : '', onclick: () => { st.asi.mode = m; render(); } }, t)));
        if (st.asi.mode === 'feat') return [tabs, ...featList(e => !(featRuleOf(e).groups || []).includes('epic')), ...featAbilityChoice()];
        const used = KEYS.reduce((n, k) => n + (st.asi.plus[k] || 0), 0), room = KEYS.reduce((n, k) => n + Math.min(2, Math.max(0, 20 - sheet.abilities[k])), 0), need = Math.min(2, room);
        const prim = primaryKeys(st.p.entry), saves = st.p.entry.data?.saves || [];
        return [tabs, h('p', 'lu-lead', `Распределите ${need} ${plural(need, 'очко', 'очка', 'очков')}: +2 к одной характеристике или +1 к двум. Максимум — 20.`),
          h('div', 'lu-abilities', ...KEYS.map(k => {
            const base = sheet.abilities[k] || 10, plus = st.asi.plus[k] || 0, now = base + plus, dm = modOf(now) - modOf(base);
            return h('div', 'lu-ability' + (plus ? ' up' : '') + (prim.includes(k) ? ' prim' : ''), h('div', 'lu-ab-top', h('span', 'lu-ab-name', abilName(k)), prim.includes(k) ? h('span', 'lu-ab-star', '★', h('small', '', 'основная')) : saves.includes(k) ? h('span', 'lu-ab-save', 'спасбросок') : null),
              h('div', 'lu-ab-score', plus ? h('s', '', String(base)) : null, plus ? h('i', '', '→') : null, h('b', '', String(now))),
              h('div', 'lu-ab-mod', sign(modOf(now)), dm ? h('em', 'lu-delta', '▲ ' + sign(dm)) : null),
              h('div', 'lu-ab-btns', el('button', { type: 'button', 'aria-label': `Уменьшить ${abilName(k)}`, disabled: plus > 0 ? null : '', onclick: () => { st.asi.plus[k] = plus - 1; render(); } }, '−'),
                el('button', { type: 'button', 'aria-label': `Увеличить ${abilName(k)}`, disabled: used < need && plus < 2 && now < 20 ? null : '', onclick: () => { st.asi.plus[k] = plus + 1; render(); } }, '+')));
          })), h('div', 'lu-points', h('span', '', 'Очки:'), pips(need - used, need), h('small', 'muted', `распределено ${used} из ${need}`))];
      };
      const classStep = () => {
        const p = st.p, cur = classesOf(sheet).filter(c => c.name), total = cur.reduce((n, c) => n + c.level, 0) || clampLevel(sheet.level);
        const reqChips = slug => mcRequirements(slug, sheet.edition).map(g => { const v = Math.max(...g.map(k => Number(sheet.abilities?.[k]) || 10)), ok = v >= 13; return chip(`${ok ? '✓' : '✗'} ${g.map(abilName).join(' / ')} 13 (${v})`, ok ? 'ok' : 'bad'); });
        const card = (e, { head, sub, on, disabled, note, chips = [], level }) => {
          const col = classColor(e || p.entry), c = h('div', 'lu-cls' + (on ? ' on' : '') + (disabled ? ' off' : ''), crest(monogram(e || { name: head }), 'md'),
            h('div', 'lu-cls-b', h('div', 'lu-cls-h', h('b', '', head), on ? h('span', 'lu-check', '✓') : null), h('small', 'muted', sub), chips.length ? h('div', 'lu-cls-chips', ...chips) : null, note ? h('p', 'lu-cls-note', note) : null,
              level ? h('div', 'lu-mini-bar', el('i', { style: `width:${Math.min(100, level / MAX_LEVEL * 100)}%` })) : null));
          c.style.setProperty('--lu-acc', col); c.style.setProperty('--lu-acc-rgb', hexRgb(col));
          if (disabled) { c.setAttribute('aria-disabled', 'true'); return c; }
          return activate(c, () => selectClass(e), 'radio', on);
        };
        const out = [h('p', 'lu-lead', total >= 20 ? 'Достигнут максимальный уровень.' : `Общий уровень ${total}. Выберите, какой класс повысить на уровень.`)];
        if (cur.length) out.push(h('h3', 'lu-h', 'Ваши классы'), h('div', 'lu-cards wide', ...cur.map(c => { const e = resolveEntry(c.name);
          return card(e, { head: c.name, sub: `${c.level} → ${c.level + 1} уровень${c.subclass ? ' · ' + c.subclass : ''}`, on: !!e && !p.isNew && sameClass(c.name, p.entry), disabled: !e || total >= MAX_LEVEL || c.level >= MAX_LEVEL, level: c.level,
            chips: e ? [chip(`d${dieOf(e)}`, 'die'), ...savesOf(e).map(s => chip(s)), ...(e.data?.primary ? [chip('★ ' + e.data.primary, 'gold')] : [])] : [],
            note: e ? '' : 'Класса нет в справочнике этой редакции — повысить его мастером нельзя.' }); })));
        const others = st.classes.filter(e => !cur.some(c => sameClass(c.name, e)));
        if (cur.length && others.length) {
          const curFail = cur.map(c => ({ name: c.name, ...multiclassReq(sheet.abilities, slugOf(resolveEntry(c.name)), sheet.edition) })).filter(r => !r.ok);
          out.push(h('h3', 'lu-h', 'Мультикласс: новый класс'), h('p', 'muted small', 'Нужно 13 в основных характеристиках и нынешних классов, и нового. Первый уровень нового класса даёт ограниченные владения.'),
            curFail.length ? h('p', 'lu-note', `Не хватает у текущих классов: ${curFail.map(r => `${r.name} — ${r.missing.join(', ')}`).join('; ')}.`) : null,
            h('label', 'lu-check-row', el('input', { type: 'checkbox', checked: st.ignoreReq ? '' : null, onchange: e => { st.ignoreReq = e.target.checked; render(); } }), ' Игнорировать требования (решение мастера)'),
            h('div', 'lu-cards', ...others.map(e => { const r = multiclassReq(sheet.abilities, slugOf(e), sheet.edition), blocked = (!r.ok || curFail.length) && !st.ignoreReq;
              return card(e, { head: e.name, sub: `Начать с 1 уровня · d${dieOf(e)}`, on: p.isNew && st.entry === e, disabled: blocked || total >= 20, chips: [...reqChips(slugOf(e)), ...(e.data?.primary ? [chip('★ ' + e.data.primary, 'gold')] : [])] }); })));
        }
        return out;
      };
      const skillTile = (k, on, disabled, kind, toggle) => {
        const sk = (typeof SKILLS !== 'undefined' && SKILLS.find(x => x[0] === k)) || [k, k, ''], m = modOf(newAbilities()[sk[2]] || 10), pb = st.p.pb.to;
        const a = kind === 'expert' ? m + pb : m, b = kind === 'expert' ? m + 2 * pb : m + pb;
        return el('button', { type: 'button', class: 'lu-skill' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: disabled ? '' : null, onclick: toggle },
          h('span', 'lu-skill-ab', abilName(sk[2]).slice(0, 3)), h('span', 'lu-skill-n', sk[1]), h('span', 'lu-skill-b', kind === 'expert' ? [sign(a), ' → '] : [], h('b', '', sign(b))), h('span', 'lu-skill-ck', on ? '✓' : ''));
      };
      const skillsStep = (rule = st.p.multiclass.skill, selected = st.skills, setSelected = next => { st.skills = next; }) => {
        const need = Math.min(rule.count, skillCandidates(rule).length), cands = skillCandidates(rule);
        return [h('p', 'lu-lead', `Выберите ${need} ${plural(need, 'навык', 'навыка', 'навыков')}: ${rule.any ? 'любой' : 'из списка класса'}.`), h('div', 'lu-count-bar', chip(`${selected.length} / ${need}`, selected.length === need ? 'ok' : 'accent')),
          cands.length ? h('div', 'lu-skills', ...cands.map(k => { const on = selected.includes(k); return skillTile(k, on, !on && selected.length >= need, 'new', () => { setSelected(on ? selected.filter(x => x !== k) : [...selected, k]); render(); }); }))
            : h('div', 'lu-empty', 'Все подходящие навыки уже есть на листе.')];
      };
      const subclassSkillsStep = () => {
        const rule = subclassSkillRule();
        return rule ? skillsStep(rule, st.subclassSkills, next => { st.subclassSkills = next; }) : [h('div', 'lu-empty', 'Для выбранного подкласса нет отдельного выбора навыков.')];
      };
      const expertiseStep = () => {
        const cands = expertiseCandidates(sheet, st.p.edition === '2014' && st.p.slug === 'rogue', st.p.expertiseFrom), need = Math.min(st.p.expertise, cands.length);
        const tiles = cands.map(k => {
          const on = st.expertise.includes(k), disabled = !on && st.expertise.length >= need;
          if (k === 'thieves_tools') return el('button', { type: 'button', class: 'lu-skill' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: disabled ? '' : null,
            onclick: () => { st.expertise = on ? st.expertise.filter(x => x !== k) : [...st.expertise, k]; render(); } }, h('span', 'lu-skill-ab', 'ИНС'), h('span', 'lu-skill-n', 'Воровские инструменты'), h('span', 'lu-skill-b', on ? 'Компетентность' : 'Владение'), h('span', 'lu-skill-ck', on ? '✓' : ''));
          return skillTile(k, on, disabled, 'expert', () => { st.expertise = on ? st.expertise.filter(x => x !== k) : [...st.expertise, k]; render(); });
        });
        return [h('p', 'lu-lead', `Выберите ${need} ${plural(need, 'владение', 'владения', 'владений')}: бонус мастерства будет удвоен для них.`), h('div', 'lu-count-bar', chip(`${st.expertise.length} / ${need}`, st.expertise.length === need ? 'ok' : 'accent')),
          tiles.length ? h('div', 'lu-skills', ...tiles) : h('div', 'lu-empty', 'На листе нет подходящих владений для компетентности.')];
      };
      const optionsStep = () => {
        const p = st.p, out = [];
        for (const g of p.groups) {
          if (g.kind === 'feature') {
            const chosen = st.pick[g.id] ||= [], need = optionNeed(g);
            if (need > 0) out.push(h('h3', 'lu-h', g.label, h('span', 'lu-count' + (chosen.length === need ? ' ok' : ''), `${chosen.length} / ${need}`)), g.hint ? h('p', 'muted small', g.hint) : null,
              h('div', 'lu-cards', ...g.options.map(o => {
                const on = chosen.includes(o.name), full = !on && chosen.length >= need, key = 'op' + g.id + o.name, isOpen = st.open.has(key), long = o.text.length > 200;
                const c = h('div', 'lu-pick' + (on ? ' on' : '') + (full ? ' off' : ''), h('div', 'lu-pick-head', crest('✦', 'sm'), h('div', 'lu-pick-t', h('b', '', o.name.replace(/^(Боевой стиль|Таинственные воззвания):?\s+/, ''))), on ? h('span', 'lu-check', '✓') : null),
                  h('div', 'lu-pick-desc' + (isOpen ? ' full' : ''), ...(isOpen ? rich(o.text) : [h('p', '', clip(o.text, 200))])),
                  long ? el('button', { type: 'button', class: 'lu-more', 'data-stop': '1', onclick: () => { isOpen ? st.open.delete(key) : st.open.add(key); render(); } }, isOpen ? 'Свернуть' : 'Читать полностью') : null);
                if (full) { c.setAttribute('aria-disabled', 'true'); return c; }
                return activate(c, () => { st.pick[g.id] = on ? chosen.filter(x => x !== o.name) : [...chosen, o.name]; render(); }, 'checkbox', on);
              })));
            if (g.swap?.length) out.push(h('h3', 'lu-h', `${g.label}: замена`, h('small', 'muted', 'по желанию')), h('div', 'row', h('div', '', h('small', 'muted', 'Забыть одно из известных'), el('select', { 'aria-label': 'Заменяемое умение', onchange: e => { if (e.target.value) st.pswap[g.id] = e.target.value; else delete st.pswap[g.id]; } },
              el('option', { value: '' }, '— оставить все —'), ...g.swap.map(x => el('option', { value: x.uid, selected: st.pswap[g.id] === x.uid ? '' : null }, x.name))))));
          } else if (g.kind === 'feat') {
            out.push(h('h3', 'lu-h', g.label), g.hint ? h('p', 'muted small', g.hint) : null, ...featList(isStyleFeat, () => st.pfeat[g.id], e => { st.pfeat[g.id] = e; }));
          } else {
            out.push(h('h3', 'lu-h', `${g.label}: ${g.feature}`), h('p', 'muted small', g.hint + '. Выберите из подсказок или впишите своё.'),
              h('div', 'lu-chips', ...g.suggestions.map(v => el('button', { type: 'button', class: 'lu-chip' + (st.ptext[g.id] === v ? ' on' : ''), onclick: () => { st.ptext[g.id] = v; render(); } }, v))),
              el('input', { type: 'text', class: 'lu-text', value: st.ptext[g.id] || '', placeholder: g.hint, 'aria-label': g.label, oninput: e => { st.ptext[g.id] = e.target.value; renderSummaryOnly(); } }));
          }
        }
        return out;
      };
      const spellsStep = () => {
        const p = st.p, pool = spellPool();
        const cant = pool.filter(e => (e.data?.level || 0) === 0), leveled = pool.filter(e => (e.data?.level || 0) > 0 && e.data.level <= p.spells.maxLevel);
        const newCantrips = p.spells.cantrips + subclassCantripChoices();
        const needSp = Math.min(p.spells.spells + st.drop.length, leveled.length), needC = Math.min(newCantrips, cant.length), q = st.q.toLowerCase();
        const card = (e, list, cap) => {
          const d = e.data || {}, on = list.includes(e), full = !on && list.length >= cap, open = st.open.has('sp' + e.name), col = schoolColor(school(e)) || '#8b919c';
          const meta = [school(e), shortTime(d.casting_time)].filter(Boolean);
          const c = h('article', 'lu-sp' + (on ? ' on' : '') + (full ? ' full' : '') + (open ? ' open' : ''),
            el('button', { type: 'button', class: 'lu-sp-main', 'aria-pressed': String(on), disabled: full ? '' : null, onclick: () => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); else list.push(e); render(); } },
              el('span', { class: 'lu-sp-lv', title: d.level ? d.level + ' круг' : 'Заговор' }, d.level ? String(d.level) : '0'), h('span', 'lu-sp-t', h('b', '', e.name), h('small', '', h('i', 'lu-dot'), meta.join(' · '))), h('span', 'lu-sp-ck', on ? '✓' : '')),
            h('div', 'lu-sp-foot', d.concentration ? chip('Концентрация', 'muted') : null, d.ritual ? chip('Ритуал', 'muted') : null, h('span', 'grow'),
              el('button', { type: 'button', class: 'lu-sp-more', 'aria-expanded': String(open), onclick: () => { open ? st.open.delete('sp' + e.name) : st.open.add('sp' + e.name); render(); } }, open ? 'Скрыть' : 'Описание', h('span', 'lu-chev', ' ▾'))),
            open ? h('div', 'lu-sp-body', h('div', 'lu-sp-facts', ...[['Время', d.casting_time], ['Дистанция', d.range], ['Компоненты', d.components], ['Длительность', d.duration]].filter(x => x[1]).map(([a, b]) => h('span', '', h('small', '', a), b))), ...rich(clip(d.desc, 1400)),
              d.higher_level ? h('p', 'lu-hl', h('b', '', 'На более высоких кругах. '), clip(d.higher_level, 400)) : null) : null);
          c.style.setProperty('--sch', col); return c;
        };
        const search = el('input', { type: 'search', class: 'lu-search', placeholder: 'Поиск заклинания…', value: st.q, 'aria-label': 'Поиск', oninput: e => { st.q = e.target.value; const pos = e.target.selectionStart; render(); const i = shell.querySelector('.lu-search'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } } });
        const lvs = [...new Set(leveled.map(e => e.data.level))].sort((a, b) => a - b);
        const filt = list => list.filter(e => !q || e.name.toLowerCase().includes(q) || (e.data?.desc || '').toLowerCase().includes(q));
        const sp = p.spells.secrets ? secretsPool() : [], needS = Math.min(p.spells.secrets, sp.length);
        const tally = [];
        if (newCantrips) tally.push(['Заговоры', st.cantrips.length, needC]);
        if (p.spells.spells) tally.push([p.spells.mode === 'book' ? 'В книгу' : 'Заклинания', st.spells.length, needSp]);
        if (p.spells.secrets) tally.push(['Тайны магии', st.secrets.length, needS]);
        const out = [h('div', 'lu-sticky', h('div', 'lu-tally', ...tally.map(([n, a, b]) => h('span', 'lu-tally-i' + (a === b ? ' ok' : ''), h('small', '', n), h('b', '', `${a} / ${b}`)))), search)];
        const none = t => h('div', 'lu-empty', t), grid = (list, sel, cap) => h('div', 'lu-spells', ...list.map(e => card(e, sel, cap)));
        if (newCantrips) out.push(h('h3', 'lu-h', 'Заговоры', h('span', 'lu-count' + (st.cantrips.length === needC ? ' ok' : ''), `${st.cantrips.length} / ${needC}`)), cant.length ? grid(filt(cant), st.cantrips, needC) : none('В справочнике нет доступных заговоров этого класса.'));
        if (p.spells.spells) {
          out.push(h('h3', 'lu-h', p.spells.mode === 'book' ? 'В книгу заклинаний' : 'Новые заклинания', h('span', 'lu-count' + (st.spells.length === needSp ? ' ok' : ''), `${st.spells.length} / ${needSp}`)),
            h('div', 'lu-lvfilter', el('button', { type: 'button', class: st.lvFilter === 0 ? 'on' : '', onclick: () => { st.lvFilter = 0; render(); } }, 'Все'), ...lvs.map(l => el('button', { type: 'button', class: st.lvFilter === l ? 'on' : '', onclick: () => { st.lvFilter = l; render(); } }, `${l} круг`))),
            leveled.length ? grid(filt(leveled).filter(e => !st.lvFilter || e.data.level === st.lvFilter), st.spells, needSp) : none('В справочнике нет доступных заклинаний этого класса.'));
          if (p.spells.swap) {
            const known = sheet.spells.known.filter(x => x.level > 0);
            out.push(h('h3', 'lu-h', 'Заменить заклинание', h('small', 'muted', 'по желанию')), h('div', 'row', h('div', '', h('small', 'muted', 'Забыть одно из известных'), el('select', { 'aria-label': 'Заменяемое заклинание', onchange: e => { st.drop = e.target.value ? [e.target.value] : []; st.spells = st.spells.slice(0, p.spells.spells + st.drop.length); render(); } },
              el('option', { value: '' }, '— оставить все —'), ...known.map(x => el('option', { value: x.uid, selected: st.drop.includes(x.uid) ? '' : null }, `${x.name} (${x.level} кр.)`))))));
          }
        }
        if (p.spells.secrets) out.push(h('h3', 'lu-h', 'Тайны магии', h('span', 'lu-count' + (st.secrets.length === needS ? ' ok' : ''), `${st.secrets.length} / ${needS}`)), h('p', 'muted small', 'Любые заклинания доступных вам кругов и заговоры — из списков всех классов.'), sp.length ? grid(filt(sp), st.secrets, needS) : none('В справочнике нет подходящих заклинаний.'));
        if (!p.spells.spells && p.spells.mode === 'prepared') out.push(h('p', 'lu-lead', `Подготовленных заклинаний: ${p.spells.prepared}. Список меняется на вкладке «Заклинания» после отдыха.`));
        return out;
      };
      const nameOf = k => (typeof SKILLS !== 'undefined' && (SKILLS.find(x => x[0] === k) || [])[1]) || k;
      const summary = () => {
        const p = st.p, info = hpInfo(), sub = st.subclass || p.subclass, rows = [], newMax = Math.max(1, sheet.hp.max + info.total);
        if (st.subclass) rows.push(['✦', 'Подкласс', st.subclass.name]);
        if (p.asi || p.epic) {
          const featRule = featAbilityRule(st.asi.feat), featBump = featRule && st.asi.ability ? ` · ${abilName(st.asi.ability)} +${featRule.amount}` : '';
          rows.push(['★', p.epic ? 'Эпический дар' : 'Улучшение', st.asi.mode === 'feat' || p.epic ? `${st.asi.feat?.name || '—'}${featBump}` : KEYS.filter(k => st.asi.plus[k]).map(k => `${abilName(k)} ${sign(st.asi.plus[k])}`).join(', ')]);
        }
        if (p.expertise) rows.push(['✔', 'Компетентность', st.expertise.map(nameOf).join(', ') || '—']);
        for (const g of p.groups) { const v = g.kind === 'feature' ? (st.pick[g.id] || []).join(', ') : g.kind === 'feat' ? st.pfeat[g.id]?.name : st.ptext[g.id]; if (v) rows.push(['✦', g.label, v]); if (g.kind === 'feature' && st.pswap[g.id]) rows.push(['⇄', `${g.label}: замена`, g.swap.find(x => x.uid === st.pswap[g.id])?.name || '']); }
        if (st.skills.length) rows.push(['✔', 'Навыки', st.skills.map(nameOf).join(', ')]);
        if (st.subclassSkills.length) rows.push(['✔', 'Навыки подкласса', st.subclassSkills.map(nameOf).join(', ')]);
        if (st.secrets.length) rows.push(['✧', 'Тайны магии', st.secrets.map(e => e.name).join(', ')]);
        if (st.cantrips.length) rows.push(['✧', 'Заговоры', st.cantrips.map(e => e.name).join(', ')]);
        if (st.spells.length) rows.push(['✧', 'Заклинания', st.spells.map(e => e.name).join(', ')]);
        if (st.drop.length) rows.push(['⇄', 'Забываете', sheet.spells.known.filter(x => st.drop.includes(x.uid)).map(x => x.name).join(', ')]);
        const feats = [...p.features.filter(f => f.tag !== 'asi' && f.tag !== 'epic'), ...subclassFeaturesAt(sub, p.to, { ...(p.subclassChoices || {}), ...(st.subclassVariants || {}) }).map(f => ({ ...f, source: sub.name }))];
        return [h('div', 'lu-tiles', tile({ icon: '▲', label: 'Уровень персонажа', from: p.total.from, to: p.total.to }),
          tile({ icon: '♥', label: 'Максимум хитов', from: sheet.hp.max, to: newMax }), tile({ icon: '◆', label: 'Бонус мастерства', from: p.pb.from === p.pb.to ? undefined : sign(p.pb.from), to: sign(p.pb.to) }),
          tile({ icon: '⬢', label: p.isNew ? `Новый класс: ${p.entry.name}` : p.entry.name, from: p.isNew ? undefined : `${p.from} ур.`, to: `${p.to} ур.` })),
          rows.length ? h('section', 'lu-panel', h('h3', 'lu-h', 'Ваши выборы'), ...rows.map(([i, a, b]) => h('div', 'lu-sum-row', h('span', 'lu-sum-ic', i), h('span', 'lu-sum-k', a), h('b', '', b)))) : null,
          feats.length ? h('section', 'lu-panel', h('h3', 'lu-h', 'Умения появятся на листе'), h('div', 'lu-chips static', ...feats.map(f => chip(f.name, 'accent')))) : null,
          h('p', 'muted small', 'Изменения применяются к листу сразу после подтверждения. Историю повышений можно посмотреть на вкладке «Умения».')];
      };

      // ----- каркас -----
      let renderSummaryOnly = () => render();
      function go(i) { st.step = i; st.anim = true; st.top = true; render(); }
      function render() {
        const keepScroll = st.top ? 0 : shell.querySelector('.lu-content')?.scrollTop || 0; st.top = false;
        const fkey = n => n ? `${n.tagName}|${n.className}|${(n.getAttribute('aria-label') || n.textContent || '').slice(0, 60)}` : '', ae = document.activeElement, focusKey = ae && shell.contains(ae) && ae.tagName !== 'INPUT' ? fkey(ae) : '';
        shell.innerHTML = '';
        const accent = classColor(st.p?.entry || st.entry); root.style.setProperty('--lu-acc', accent); root.style.setProperty('--lu-acc-rgb', hexRgb(accent));
        shell.className = 'lu-shell' + (st.loading || st.error || !st.entry ? ' single' : '');
        if (st.loading) { shell.append(h('div', 'lu-loading', h('div', 'lu-spinner'), h('p', 'muted', 'Загружаю данные класса…'))); return; }
        if (st.error || !st.entry) {
          shell.append(h('div', 'lu-loading', h('h2', '', 'Не удалось подобрать класс'), h('p', 'muted', st.error || `Класс «${sheet.class || '—'}» не найден в справочнике выбранной редакции. Перетащите блок класса на лист или выберите его ниже.`),
            st.classes.length ? h('div', 'lu-cards', ...st.classes.map(e => { const c = h('div', 'lu-cls', crest(monogram(e), 'md'), h('div', 'lu-cls-b', h('b', '', e.name), h('small', 'muted', e.source || ''))); c.style.setProperty('--lu-acc', classColor(e)); return activate(c, () => choose(e), 'button', false); })) : null,
            el('button', { onclick: () => close(st.applied) }, 'Закрыть')));
          return;
        }
        const list = steps(), cur = list[st.step], p = st.p, info = hpInfo();
        const side = h('aside', 'lu-side', h('div', 'lu-side-top', crest(p.total.to, 'lg'), h('div', 'lu-side-title', p.entry.name), h('div', 'lu-side-sub', p.isNew ? `Новый класс · всего ${p.total.to}` : p.multi ? `${p.from} → ${p.to} · всего ${p.total.to}` : `Уровень ${p.from} → ${p.to}`)),
          h('ol', 'lu-steps', ...list.map((s, i) => h('li', 'lu-step' + (i === st.step ? ' cur' : '') + (i < st.step ? ' done' : ''),
            el('button', { type: 'button', disabled: i > st.step ? '' : null, 'aria-current': i === st.step ? 'step' : null, onclick: () => go(i) }, h('span', 'lu-step-n', i < st.step ? '✓' : String(i + 1)), h('span', 'lu-step-t', h('b', '', s.label), h('small', '', s.hint)))))),
          h('div', 'lu-side-mini', h('div', '', h('small', '', 'Хиты'), h('b', '', `${sheet.hp.max} → ${Math.max(1, sheet.hp.max + info.total)}`)), h('div', '', h('small', '', 'Мастерство'), h('b', '', p.pb.from === p.pb.to ? sign(p.pb.to) : `${sign(p.pb.from)} → ${sign(p.pb.to)}`))));
        const content = h('div', 'lu-content' + (st.anim ? ' anim' : ''));
        const build = { class: classStep, overview, hp: hpStep, skills: skillsStep, subclass_skills: subclassSkillsStep, subclass_variants: subclassVariantsStep, options: optionsStep, subclass: subclassStep, asi: asiStep, epic: () => [h('p', 'lu-lead', 'На 19 уровне вы получаете эпический дар — особую награду за мастерство.'), ...featList(e => /^дар(\s|$)/i.test(e.name)), ...featAbilityChoice()], expertise: expertiseStep, spells: spellsStep, summary }[cur.id];
        content.append(h('div', 'lu-title', h('span', 'lu-kick', `Шаг ${st.step + 1} из ${list.length} · ${SUB[cur.id] || ''}`), h('h1', '', cur.label)), ...build().filter(Boolean));
        const last = st.step === list.length - 1, ok = valid(cur.id);
        const foot = h('footer', 'lu-foot', h('div', 'lu-progressline', el('i', { style: `width:${(st.step + 1) / list.length * 100}%` })),
          el('button', { type: 'button', onclick: () => close(st.applied) }, 'Отмена'), h('span', 'grow'),
          st.step > 0 ? el('button', { type: 'button', onclick: () => go(st.step - 1) }, '← Назад') : null,
          el('button', { type: 'button', class: 'primary lu-next', disabled: ok && !st.busy ? null : '', title: ok ? '' : 'Завершите выбор на этом шаге', onclick: last ? confirmApply : () => go(st.step + 1) }, last ? (p.isNew ? `Добавить класс: ${p.entry.name}` : `Повысить до ${p.total.to} уровня`) : 'Далее →'));
        shell.append(side, h('div', 'lu-main', el('button', { type: 'button', class: 'lu-x', 'aria-label': 'Закрыть', onclick: () => close(st.applied) }, '×'), content, foot));
        content.scrollTop = keepScroll; st.anim = false;
        if (focusKey) [...shell.querySelectorAll('button:not(:disabled), select, [tabindex="0"]')].find(n => fkey(n) === focusKey)?.focus({ preventScroll: true });
        renderSummaryOnly = () => {
          const b = shell.querySelector('.lu-foot .lu-next'); if (b) b.disabled = !valid(cur.id) || !!st.busy;
          const inf = hpInfo(), oldMax = sheet.hp.max, newMax = Math.max(1, oldMax + inf.total), set = (sel, t) => { const n = shell.querySelector(sel); if (n) n.textContent = t; };
          set('.lu-eq-base', String(inf.base)); set('.lu-eq-gain', sign(inf.total)); set('.lu-hpmax', `${oldMax} → ${newMax}`);
          const w = Math.round(oldMax / Math.max(newMax, oldMax) * 100), bi = shell.querySelector('.lu-hpbar-track .base'), gi = shell.querySelector('.lu-hpbar-track .gain'); if (bi) bi.style.width = w + '%'; if (gi) gi.style.width = (100 - w) + '%';
          const mini = shell.querySelector('.lu-side-mini b'); if (mini) mini.textContent = `${oldMax} → ${newMax}`;
        };
      }
      function confirmApply() {
        if (st.busy || st.applied && st.done) return;
        try {
          const res = apply(sheet, st.p, { hp: st.hp, subclass: st.subclass, asi: st.asi.mode === 'feat' || st.p.epic ? { mode: 'feat', feat: st.asi.feat, ability: st.asi.ability } : { mode: 'asi', plus: st.asi.plus }, expertise: st.expertise, cantrips: st.cantrips, spells: st.spells, drop: st.drop,
            picks: st.pick, feats: st.pfeat, texts: st.ptext, swap: st.pswap, secrets: st.secrets, skills: st.skills, subclassSkills: st.subclassSkills }, { resolve: resolveEntry });
          st.applied = true; st.done = { log: res.log, level: sheet.level };
          toast(`Уровень повышен: ${sheet.level} — вернулись на лист персонажа. Хиты: ${sheet.hp.max}.`, 5000);
          if (onApply) onApply();
          // После повышения сразу возвращаемся на страницу персонажа: итог виден на листе.
          close(true);
        } catch (e) { console.error(e); toast('Не удалось повысить уровень: ' + e.message, 4000); }
      }
      function choose(entry) { st.entry = entry; sheet.class = entry.name; init(); }
      function init() {
        st.p = plan(sheet, st.entry, sheet.edition || '2014', { resolve: resolveEntry }); st.step = 0;
        if (!st.p.needSubclass) st.subclass = null;
        if (st.p.epic) st.asi.mode = 'feat';
        render();
      }
      (async () => {
        render();
        try {
          const { list, entry } = await findClass(sheet, campaignId); st.classes = list;
          const [feat, spell] = await Promise.all([loadCatalog('feat', sheet, campaignId), loadCatalog('spell', sheet, campaignId)]);
          st.catalogs = { feat, spell };
          st.loading = false;
          if (entry) { st.entry = entry; init(); } else render();
        } catch (e) { st.loading = false; st.error = e.message; render(); }
      })();
    });
  }
  return { featRuleOf, featPrerequisitesMet, featAbilityRule, isStyleFeat, slugOf, sameClass, classesOf, classRow, classLabel, multiclassReq, progression, spellStats, castingSummary, optionGroups, classFeaturesAt, subclassOf, subclassFeaturesAt, subclassVariantGroups, subclassSkillChoices, subclassCantripGain, subclassLevel, plan, hpAverage, hpGain, hpChoiceValid, asiValid, expertiseCandidates, featAbilityRule, featPrerequisitesMet, apply, canUndo, undo, open, modOf, profBonus };
})();
