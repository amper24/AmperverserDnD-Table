// =============================================================================
// builder-dialog.js — UI мастера создания персонажа (окно из восьми шагов):
// Концепция → Происхождение → Характеристики → Навыки → Заклинания →
// Снаряжение → Личность → Проверка.
//
// Мастер только собирает черновик (draft) и рисует шаги; все правила считает
// модуль CharacterBuilder (character-builder.js): проекции модулей, снаряжение,
// навыки, языки, лимиты заклинаний и итоговую сборку — build(draft).
//
// Публичная точка входа:
//   newCharacterDialog({ campaignId?, name? }) → Promise<{ name, sheet } | null>
// Её используют «Новый персонаж» в лобби, меню «Создать» на столе и боковая
// панель кампании (static/app.js).
//
// Зависимости: character-builder.js, common.js (el, modal, API), dice.js,
// compendium.js (карточки записей). Загружается после character-builder.js.
// =============================================================================

window.newCharacterDialog = async function (defaults = {}) {
  const B = CharacterBuilder;
  // Внутренние помощники модуля, нужные мастеру создания персонажа.
  const { normalizeName, classSlugOf, subclassLevel, subclassVariantGroups, weaponMasteryCount, weaponMasteryOptions, pointBuyTotal, CLASS_SLUGS_RU, POINT_BUY_COST } = B;
  const emptyEquipment = () => ({ choice: {}, picks: {}, exclude: {}, template: {}, qty: {}, name: {}, extras: [], gold: 0, packs: true, autoEquip: true, gmOverrides: false });
  const emptyDraft = {
    name: defaults.name || '', edition: defaultEdition(), alignment: '',
    traits: Object.fromEntries(['player_name', 'faith', 'age', 'height', 'weight', 'eyes', 'skin', 'hair', 'personality', 'ideals', 'bonds', 'flaws', 'appearance', 'backstory'].map(k => [k, ''])),
    abilities: Object.fromEntries(B.keys.map((k, i) => [k, [15, 14, 13, 12, 10, 8][i]])),
    selected: {}, spells: [], preparedSpells: [], skills: [], freeSkills: [], languages: [], bonuses: {}, picks: {}, ruleChoices: {}, method: 'standard', rolls: [], equipment: emptyEquipment()
  };
  const draft = JSON.parse(JSON.stringify(emptyDraft));
  const steps = ['Концепция', 'Происхождение', 'Характеристики', 'Навыки', 'Заклинания', 'Снаряжение', 'Личность', 'Проверка'];
  const stepTips = [
    'Задайте имя и выберите редакцию правил.',
    'Выберите расу, класс и предысторию — это записи-модули из справочника.',
    'Выберите стандартный набор, покупку очков или бросок 4d6.',
    'Отметьте навыки класса, проверьте языки и владения от модулей.',
    'Заклинания и заговоры: доступные классу варианты и лимит 1 уровня.',
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

  // ---------- Черновик: выборы в модулях и языки ----------
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
    const names = draft.edition === '2024' ? ['Общий'] : [];
    const addStandard = value => {
      const text = String(value || '').trim();
      const known = B.LANGUAGES.find(language => normalizeName(language) === normalizeName(text));
      if (known && !names.some(language => normalizeName(language) === normalizeName(known))) names.push(known);
    };
    for (const entry of [draft.selected.race, parentRace()]) for (const value of B.asList(entry?.data?.languages)) addStandard(value);
    // Fixed language proficiencies from a background or a selected module choice also
    // consume a language the player cannot select a second time.
    for (const value of B.asList(draft.selected.background?.data?.languages)) addStandard(value);
    for (const { entry, group } of B.moduleChoices(draft)) if (group.type === 'language') {
      for (const id of B.asList(draft.picks?.[group.id])) {
        const option = (group.options || []).find(candidate => candidate.id === id);
        for (const value of B.asList(option?.value)) {
          const text = String(value || '').trim();
          if (text && !names.some(language => normalizeName(language) === normalizeName(text))) names.push(text);
        }
      }
    }
    return names;
  }
  /// «Один дополнительный язык на ваш выбор» из пояснения расы.
  function raceLanguageChoice() {
    for (const entry of [draft.selected.race, parentRace()]) for (const value of B.asList(entry?.data?.languages)) {
      if (/дополнительн[а-яё]*\s+язык[а-яё]*|язык[а-яё]*\s+на\s+ваш\s+выбор|extra\s+language/i.test(String(value || ''))) return 1;
    }
    return 0;
  }
  /// Сколько языков ещё выбирает игрок: от предыстории и от расы.
  function languageRule() {
    const backgroundLanguages = Number(draft.selected.background?.data?.languages);
    const classSlug = String(draft.selected.class?.data?.name_en || '').toLowerCase() || CLASS_SLUGS_RU[draft.selected.class?.name] || '';
    const originLanguages = draft.edition === '2024' ? 2 : 0; // Common is automatic; choose two Standard Languages
    const rogueLanguage = draft.edition === '2024' && classSlug === 'rogue' ? 1 : 0;
    return originLanguages + (Number.isInteger(backgroundLanguages) && backgroundLanguages > 0 ? backgroundLanguages : 0) + raceLanguageChoice() + rogueLanguage;
  }
  /// Что мешает пройти шаг — для подсказок в навигации и сообщений.
  // ---------- Проверка шагов: что мешает пройти каждый из восьми шагов ----------
  function stepProblem(index) {
    if (index === 0) return draft.name.trim() ? '' : 'Дайте персонажу имя.';
    if (index === 1) {
      if (['race', 'class', 'background'].some(k => !draft.selected[k])) return 'Выберите расу, класс и предысторию.';
      if (draft.edition === '2024' && !String(draft.selected.background?.data?.feat || '').trim()) return 'В редакции 2024 предыстория должна давать черту происхождения; проверьте запись справочника.';
      if (draft.edition === '2024' && draft.selected.background?.data?.feat && !draft.selected.feat) return `Черта предыстории «${draft.selected.background.data.feat}» не найдена в справочнике; добавьте корректную запись, прежде чем продолжить.`;
      if (entries.some(e => e.category === 'race' && e.data?.parent === draft.selected.race?.name) && !draft.selected.race?.data?.parent) return 'Для этой расы выберите одну из доступных родословных.';
      const raceNameEn = String(draft.selected.race?.data?.name_en || '').toLowerCase(), raceRoot = draft.selected.race?.data?.parent || draft.selected.race?.name;
      const raceParentEntry = entries.find(e => e.category === 'race' && e.name === raceRoot && !e.data?.parent);
      const raceRootNameEn = String(raceParentEntry?.data?.name_en || raceNameEn).toLowerCase();
      if (draft.edition === '2014' && raceNameEn === 'half-elf' && (draft.ruleChoices?.raceSkills || []).length !== 2) return 'Полуэльфу нужно выбрать два навыка.';
      if (draft.edition === '2014' && normalizeName(raceRoot) === normalizeName('Дварф') && !draft.ruleChoices?.dwarfTool) return 'Дварфу нужно выбрать ремесленные инструменты.';
      if (draft.edition === '2014' && raceNameEn === 'dragonborn' && !draft.ruleChoices?.dragonAncestry) return 'Выберите драконье наследие.';
      if (draft.edition === '2014' && raceNameEn === 'high elf' && !draft.ruleChoices?.racialCantrip) return 'Высшему эльфу нужно выбрать заговор волшебника.';
      if (draft.edition === '2024' && raceRootNameEn === 'elf' && (draft.ruleChoices?.raceSkills || []).length !== 1) return 'Эльфу нужно выбрать один навык из Острых чувств.';
      if (draft.edition === '2024' && raceRootNameEn === 'human') {
        const eligibleFeats = entries.filter(entry => entry.category === 'feat' && !entry.data?.prerequisites
          && normalizeName(entry.name) !== normalizeName(draft.selected.feat?.name || ''));
        if ((draft.ruleChoices?.raceSkills || []).length !== 1 || !eligibleFeats.some(feat => feat.id === draft.ruleChoices?.humanOriginFeat)) return 'Человек должен выбрать навык и допустимую дополнительную черту происхождения (без повтора черты предыстории).';
      }
      if (draft.edition === '2024' && ['elf', 'gnome', 'tiefling'].includes(raceRootNameEn) && !draft.ruleChoices?.raceSpellAbility) return 'Выберите заклинательную характеристику родословной.';
      if (subclassLevel(draft.selected.class) === 1 && (draft.selected.class?.data?.subclasses || []).some(s => typeof s === 'object' && s.name)
        && !draft.selected.subclass) return 'Выберите подкласс: у вашего класса он выбирается уже на 1 уровне.';
      for (const group of subclassVariantGroups(draft.selected.subclass, 1))
        if (!group.options.includes(draft.ruleChoices?.subclassVariants?.[group.base])) return `Выберите вариант «${group.base}» подкласса.`;
      const slug = classSlugOf(draft.selected.class);
      if (draft.edition === '2014' && slug === 'fighter'
        && Object.keys(draft.selected.class.data?.feature_texts || {}).some(name => /^Боевой стиль:\s*/.test(name))
        && !draft.ruleChoices?.fightingStyle) return 'Выберите один боевой стиль в соответствии с правилами 2014.';
      if (draft.edition === '2024' && slug === 'cleric' && !draft.ruleChoices?.clericOrder) return 'Выберите Божественный орден жреца.';
      if (draft.edition === '2024' && slug === 'druid' && !draft.ruleChoices?.druidOrder) return 'Выберите Первобытный орден друида.';
      if (draft.edition === '2024' && slug === 'fighter' && entries.some(e => e.category === 'feat' && e.data?.prerequisites === 'feature_named') && !draft.ruleChoices?.fightingStyleFeat) return 'Выберите черту Боевого стиля воина.';
      if (['2014', '2024'].includes(draft.edition) && slug === 'bard') {
        const selected = draft.ruleChoices?.bardInstruments || [], allowed = new Set(entries.filter(e => e.category === 'item' && e.data?.category === 'Музыкальные инструменты').map(e => e.name));
        if (selected.length !== 3 || new Set(selected).size !== 3 || selected.some(name => !allowed.has(name))) return 'Бард должен выбрать три разных музыкальных инструмента из справочника.';
      }
      if (draft.edition === '2014' && slug === 'ranger' && (!draft.ruleChoices?.favoredEnemy || !draft.ruleChoices?.favoredTerrain)) return 'Следопыт должен выбрать избранного врага и местность природного исследователя.';
      if (draft.edition === '2014' && slug === 'ranger' && draft.ruleChoices?.favoredEnemy === 'Гуманоиды'
        && (!draft.ruleChoices.favoredHumanoidOne?.trim() || !draft.ruleChoices.favoredHumanoidTwo?.trim() || normalizeName(draft.ruleChoices.favoredHumanoidOne) === normalizeName(draft.ruleChoices.favoredHumanoidTwo))) return 'Для гуманоидов укажите два разных вида.';
      const masteryCount = weaponMasteryCount(draft.edition, slug), masteries = draft.ruleChoices?.weaponMasteries || [];
      if (masteryCount && (masteries.length !== masteryCount || new Set(masteries).size !== masteryCount || masteries.some(id => !weaponMasteryOptions(draft.selected.class, entries).some(e => e.id === id)))) return `Выберите ${masteryCount} разных вида оружия для Мастерства оружия.`;
      const pending = pendingChoices();
      return pending.length ? 'Сделайте выбор в модулях: ' + pending.map(x => x.group.name || 'вариант').join(', ') + '.' : '';
    }
    if (index === 2) {
      const minBase = ['manual', 'd20'].includes(draft.method) ? 1 : 3;
      if (B.keys.some(key => !Number.isInteger(draft.abilities[key]) || draft.abilities[key] < minBase || draft.abilities[key] > 20)) return `Базовые характеристики: целые числа от ${minBase} до 20.`;
      if (draft.method === 'pointbuy' && !B.pointBuyValid(draft.abilities)) return 'Покупка характеристик: значения 8–15, потратьте ровно 27 очков.';
      const opts = draft.selected.background?.data?.asi_options || [];
      if (draft.edition === '2024') {
        const allowedKeys = opts.map(n => B.short[n] || n);
        if (allowedKeys.length !== 3 || new Set(allowedKeys).size !== 3 || allowedKeys.some(key => !B.keys.includes(key))) return 'У предыстории 2024 в справочнике должны быть указаны три разные характеристики для бонусов.';
        const allowed = new Set(allowedKeys);
        if (Object.entries(draft.bonuses || {}).some(([k, n]) => Number(n) && !allowed.has(k))) return 'Бонусы можно распределить только по характеристикам, разрешённым предысторией.';
        const values = Object.values(draft.bonuses).filter(Boolean).map(Number).sort();
        if (!['1,2', '1,1,1'].includes(values.join(','))) return 'Распределите бонусы предыстории: +2/+1 или +1/+1/+1.';
      }
      const finalAbilities = B.build(draft).abilities, minFinal = ['manual', 'd20'].includes(draft.method) ? 1 : 3;
      if (B.keys.some(k => finalAbilities[k] < minFinal || finalAbilities[k] > 20)) return `После бонусов характеристики должны оставаться в пределах ${minFinal}–20.`;
      return '';
    }
    if (index === 4) {
      const rule = spellRule();
      if (!rule) return (draft.spells || []).length ? 'У выбранного пользовательского класса нет проверенной таблицы заклинаний; снимите недопустимый выбор.' : magicInitiateProblem();
      const selected = spellSelectionCounts();
      if ((draft.spells || []).some(e => ![0, 1].includes(Number(e.data?.level)) || !spellAllowedToClass(e))) return 'В списке есть заклинание, недоступное классу или уровня выше 1.';
      if (selected.cantrips !== rule.cantrips) return `Заговоры: выберите ${selected.cantrips} из ${rule.cantrips} по таблице класса.`;
      if (selected.spells !== rule.spells) return `${rule.mode === 'book' ? 'Книга заклинаний' : 'Заклинания 1 уровня'}: выберите ${selected.spells} из ${rule.spells} по таблице класса.`;
      if (rule.mode === 'book') {
        const prepared = draft.preparedSpells || [], selectedNames = (draft.spells || []).filter(e => Number(e.data?.level) === 1).map(e => e.name);
        if (prepared.length !== rule.preparedCount || new Set(prepared).size !== rule.preparedCount || prepared.some(name => !selectedNames.includes(name))) return `Из книги подготовьте ${rule.preparedCount} заклинаний 1-го уровня.`;
      }
      const initiateProblem = magicInitiateProblem();
      if (initiateProblem) return initiateProblem;
      return '';
    }
    if (index === 3) {
      const skills = B.skillsState(draft);
      if (skills.klass && skills.klass.picked.length !== skills.klass.choose) return `Навыки класса: выбрано ${skills.klass.picked.length} из ${skills.klass.choose}.`;
      if (skills.free && skills.free.picked.length !== skills.free.need) return `Совпавшие навыки: выберите ещё ${skills.free.need - skills.free.picked.length} — любое владение вместо уже полученного.`;
      if (classSlugOf(draft.selected.class) === 'rogue') {
        const expertise = draft.ruleChoices?.expertise || [], availableSkills = preview().skills || [];
        const validExpertise = expertise.every(k => availableSkills.includes(k) || (draft.edition === '2014' && k === 'thieves_tools'));
        if (expertise.length !== 2 || new Set(expertise).size !== 2 || !validExpertise) return 'Экспертиза плута: выберите два разных владения, которыми уже владеете.';
      }
      const needed = languageRule();
      if ((draft.languages || []).length !== needed) return `Языки: выбрано ${(draft.languages || []).length} из ${needed}.`;
      const chosenLanguages = draft.languages || [], known = new Set(raceKnownLanguages().map(normalizeName));
      if (new Set(chosenLanguages.map(normalizeName)).size !== chosenLanguages.length || chosenLanguages.some(language => known.has(normalizeName(language)))) return 'Нельзя выбирать повторный язык, уже полученный от расы, предыстории или модуля.';
      const allowedLanguages = draft.edition === '2024' ? B.LANGUAGES_2024_STANDARD : B.LANGUAGES;
      if (chosenLanguages.some(language => !allowedLanguages.some(allowed => normalizeName(allowed) === normalizeName(language)))) return 'Выберите язык из списка, доступного в этой редакции.';
      return '';
    }
    if (index === 5) {
      const plan = B.equipmentPlan(draft);
      const missingOption = plan.find(block => block.kind === 'group' && !block.options.some(option => option.id === draft.equipment.choice?.[block.id]));
      if (missingOption) return `Выберите вариант стартового снаряжения: «${missingOption.label}» (${missingOption.sourceName}).`;
      const missing = B.equipmentItems(draft).items.find(item => item.pick && !item.entry);
      return missing ? `Выберите предмет из подходящего списка: «${missing.label}».` : '';
    }
    return '';
  }
  function stepIssues() {
    const map = new Map();
    for (let i = 0; i < steps.length; i++) { const problem = stepProblem(i); if (problem) map.set(i, problem); }
    return map;
  }
  /// Подсказка шага: всё в мастере необязательно, поэтому она ничего не запрещает,
  /// а только говорит, что осталось незаполненным (шаг можно пропустить).
  function skipNote(problem) { return problem ? problem + ' — можно пропустить' : ''; }
  /// Готовый лист из текущего черновика: пустые места остаются пустыми.
  function finishDraft() {
    LS.setItem('et-edition', draft.edition);
    return { name: draft.name.trim() || 'Новый персонаж', sheet: B.build(draft) };
  }
  /// Есть ли в черновике выборы, которые пропадут при переходе на пустой лист
  /// (одно введённое имя не считается — оно переносится в лист).
  function draftFilled() {
    return Object.keys(draft.selected).length > 0 || (draft.skills || []).length > 0 || (draft.freeSkills || []).length > 0
      || (draft.spells || []).length > 0 || (draft.languages || []).length > 0 || (draft.rolls || []).length > 0
      || draft.method !== 'standard' || (draft.equipment?.extras || []).length > 0;
  }
  /// «Заполню сам»: пустой лист без модулей, снаряжения и выборов — игрок заполняет
  /// расу, класс, характеристики и остальное уже на странице листа.
  function manualSheet(name) {
    const blank = JSON.parse(JSON.stringify(emptyDraft));
    blank.name = name; blank.edition = draft.edition; blank.method = 'manual';
    blank.abilities = Object.fromEntries(B.keys.map(k => [k, 10]));
    const sheet = B.build(blank);
    sheet.creation = { ...sheet.creation, manual: true };
    return sheet;
  }
  // ---------- Каталог: загрузка рас, классов, предысторий, черт, заклинаний и предметов ----------
  async function load() {
    const version = ++request; loading = true; error = ''; render();
    try {
      const params = new URLSearchParams({ edition: draft.edition, limit: '3000' });
      if (defaults.campaignId) params.set('campaign_id', defaults.campaignId);
      const result = await Promise.all(['race', 'class', 'background', 'feat', 'spell', 'item'].map(category => API.get('/api/compendium?' + params + '&category=' + category)));
      if (version !== request) return;
      entries = result.flat(); draft.catalog = entries;
    } catch (e) { if (version === request) error = e.message; }
    if (version === request) { loading = false; render(); }
  }
  function knownRaceLanguages() {
    return new Set(raceKnownLanguages().map(normalizeName));
  }
  // ---------- Шаг «Заклинания»: лимиты, доступные списки, «Посвящённый в магию» ----------
  const spellRule = () => B.spellLimits(draft.selected.class, draft.edition, preview().abilities, draft.ruleChoices || {});
  const spellSelectionCounts = () => ({
    cantrips: (draft.spells || []).filter(e => Number(e.data?.level) === 0).length,
    spells: (draft.spells || []).filter(e => Number(e.data?.level) === 1).length,
  });
  function spellAllowedForList(entry, slug) {
    const classes = entry?.data?.classes;
    // Without spell-list metadata we cannot establish RAW eligibility; fail closed instead of
    // silently offering an unclassified/homebrew spell to every class.
    if (!Array.isArray(classes) || !classes.length) return false;
    const aliases = { cleric: ['жрец', 'cleric'], druid: ['друид', 'druid'], wizard: ['волшебник', 'wizard'] }[slug] || [slug];
    return classes.some(name => aliases.includes(String(name).toLocaleLowerCase()));
  }
  function spellAllowedToClass(entry) {
    const klass = draft.selected.class;
    return spellAllowedForList(entry, classSlugOf(klass));
  }
  function magicInitiateFeat() {
    const extra = (draft.catalog || []).find(entry => entry.category === 'feat' && entry.id === draft.ruleChoices?.humanOriginFeat);
    const candidates = [draft.selected.feat, extra].filter(Boolean);
    return candidates.find(feat => normalizeName(feat.name || '') === normalizeName('Посвящённый в магию')
      || normalizeName(feat.data?.name_en || '') === normalizeName('Magic Initiate')) || null;
  }
  function magicInitiateListRestriction(feat) {
    const suffix = String(feat?.data?.background_feat || '').match(/\(([^()]*)\)\s*$/)?.[1] || '';
    const normalized = normalizeName(suffix);
    return ({ 'жрец': 'cleric', 'cleric': 'cleric', 'друид': 'druid', 'druid': 'druid', 'волшебник': 'wizard', 'wizard': 'wizard' })[normalized] || '';
  }
  function magicInitiateProblem() {
    const feat = magicInitiateFeat();
    if (!feat) return '';
    const choice = draft.ruleChoices?.magicInitiate || {}, spells = draft.catalog || [];
    const requiredList = magicInitiateListRestriction(feat);
    const list = requiredList || (['cleric', 'druid', 'wizard'].includes(choice.list) ? choice.list : '');
    const cantrips = (choice.cantrips || []).filter(id => spells.some(e => e.id === id && e.category === 'spell' && Number(e.data?.level) === 0 && spellAllowedForList(e, list)));
    const first = spells.some(e => e.id === choice.firstLevel && e.category === 'spell' && Number(e.data?.level) === 1 && spellAllowedForList(e, list));
    return !list || !['int', 'wis', 'cha'].includes(choice.ability) || cantrips.length !== 2 || new Set(cantrips).size !== 2 || !first
      ? '«Посвящённый в магию»: выберите список, заклинательную характеристику, два заговора и одно заклинание 1-го уровня.' : '';
  }
  function magicInitiateSection() {
    const feat = magicInitiateFeat();
    if (!feat) return null;
    const choice = draft.ruleChoices.magicInitiate || (draft.ruleChoices.magicInitiate = {});
    const lists = [{ id: 'cleric', name: 'Жрец' }, { id: 'druid', name: 'Друид' }, { id: 'wizard', name: 'Волшебник' }];
    const requiredList = magicInitiateListRestriction(feat);
    if (requiredList && choice.list !== requiredList) { choice.list = requiredList; choice.cantrips = []; choice.firstLevel = ''; }
    const list = lists.some(x => x.id === choice.list) ? choice.list : '';
    const listOptions = requiredList ? lists.filter(item => item.id === requiredList) : lists;
    const available = (level) => entries.filter(e => e.category === 'spell' && Number(e.data?.level) === level && spellAllowedForList(e, list));
    const cantrips = available(0), firstLevels = available(1), picked = choice.cantrips || [];
    return el('section', { class: 'builder-panel builder-magic-initiate' },
      el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, 'Посвящённый в магию · выборы черты'), el('small', { class: 'muted' }, requiredList ? `Список задан предысторией: ${lists.find(item => item.id === requiredList)?.name}. Выберите два заговора, заклинание 1-го уровня и характеристику.` : 'Выберите один список, два заговора, заклинание 1-го уровня и характеристику черты.')),
        el('span', { class: 'builder-counter' + (!magicInitiateProblem() ? ' ok' : ' flag') }, !magicInitiateProblem() ? 'готово' : 'нужно выбрать')),
      el('div', { class: 'builder-choice-options' }, ...listOptions.map(item => el('label', { class: 'builder-choice-option' + (choice.list === item.id ? ' on' : '') },
        el('input', { type: 'radio', name: 'magic-initiate-list', checked: choice.list === item.id ? '' : null, onchange: () => { choice.list = item.id; choice.cantrips = []; choice.firstLevel = ''; render(); } }), el('span', {}, item.name)))),
      field('Заклинательная характеристика', el('select', { onchange: e => { choice.ability = e.target.value; render(); } },
        el('option', { value: '' }, 'Выберите…'), ...[['int','Интеллект'],['wis','Мудрость'],['cha','Харизма']].map(([id,name]) => el('option', { value: id, selected: choice.ability === id ? '' : null }, name)))),
      list ? el('div', {},
        el('div', { class: 'builder-panel-head' }, el('b', {}, 'Заговоры'), el('span', { class: 'builder-counter' + (picked.length === 2 ? ' ok' : ' flag') }, `${picked.length} из 2`)),
        el('div', { class: 'builder-choice-options' }, ...cantrips.map(e => {
          const on = picked.includes(e.id);
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && picked.length >= 2 ? '' : null, onchange: ev => {
              const next = picked.filter(id => id !== e.id); if (ev.target.checked) next.push(e.id);
              choice.cantrips = next.slice(0, 2); render();
            } }), el('span', {}, el('b', {}, e.name), el('small', { class: 'muted' }, e.source)));
        })),
        field('Заклинание 1-го уровня', el('select', { onchange: e => { choice.firstLevel = e.target.value; render(); } },
          el('option', { value: '' }, 'Выберите…'), ...firstLevels.map(e => el('option', { value: e.id, selected: choice.firstLevel === e.id ? '' : null }, `${e.name} · ${e.source}`))))) : null);
  }
  // ---------- Шаг «Происхождение»: карточки расы, класса и предыстории ----------
  function choose(category) {
    const selected = draft.selected[category];
    const selectableEntries = entries.filter(e => e.category === category && !(category === 'race' && !e.data?.parent && entries.some(child => child.category === 'race' && child.data?.parent === e.name)));
    const select = el('select', { 'aria-label': CAT_NAMES[category], onchange: e => {
      draft.selected[category] = entries.find(x => x.id === e.target.value);
      if (category === 'background') { draft.bonuses = {}; draft.languages = []; draft.freeSkills = []; draft.selected.feat = B.backgroundFeatModule(draft.selected.background, entries); delete draft.ruleChoices.magicInitiate; }
      if (category === 'race') {
        const known = knownRaceLanguages();
        draft.languages = (draft.languages || []).filter(x => !known.has(normalizeName(x))).slice(0, languageRule());
      }
      if (category === 'class') {
        draft.skills = []; draft.freeSkills = []; draft.spells = []; draft.preparedSpells = []; draft.selected.subclass = null;
        // Keep race/background choices when the class changes; clear only choices owned by the old class.
        for (const key of ['expertise', 'fightingStyle', 'clericOrder', 'druidOrder', 'fightingStyleFeat', 'bardInstruments',
          'favoredEnemy', 'favoredHumanoidOne', 'favoredHumanoidTwo', 'favoredLanguage', 'favoredTerrain', 'weaponMasteries']) delete draft.ruleChoices[key];
      }
      if (category === 'class' || category === 'background') draft.equipment = emptyEquipment();
      render();
    } }, el('option', { value: '' }, 'Выберите…'), ...selectableEntries.map(e => el('option', { value: e.id, selected: selected?.id === e.id ? '' : null }, e.name + ' · ' + e.source)));
    const d = selected?.data || {};
    const list = value => Array.isArray(value) ? value.filter(Boolean).join(', ') : typeof value === 'string' ? value : '';
    const facts = category === 'class'
      ? [`Кость хитов: ${d.hit_die || 'd8'}`, d.saves?.length && `Спасброски: ${d.saves.map(k => ABIL[k] || k).join(', ')}`,
        d.armor && `Доспехи: ${list(d.armor)}`, d.weapons && `Оружие: ${list(d.weapons)}`,
        d.skills && `Навыки: ${typeof d.skills === 'object' ? `${d.skills.choose || 0} из ${(d.skills.from || []).join(', ')}` : list(d.skills)}`,
        d.spellcasting && `Заклинательная характеристика: ${ABIL[d.spellcasting] || d.spellcasting}`].filter(Boolean).join(' · ')
      : category === 'background'
        ? [Array.isArray(d.skills) && d.skills.length && `Навыки: ${list(d.skills)}`,
          d.tools && `Инструменты: ${list(d.tools)}`,
          Number(d.languages) > 0 && `Языки на выбор: ${d.languages}`,
          d.feature && `Умение: ${d.feature}`, d.feat && `Черта: ${d.feat}`].filter(Boolean).join(' · ')
        : [d.speed && `Скорость: ${d.speed} фт.`, d.size && `Размер: ${d.size}`,
          d.languages && `Языки: ${list(d.languages)}`].filter(Boolean).join(' · ');
    return el('section', { class: 'builder-module' }, field(CAT_NAMES[category], select),
      selected ? el('div', {},
        facts ? el('p', { class: 'muted small' }, facts) : null,
        el('p', { class: 'builder-description' }, d.desc || (d.traits || []).map(t => t.name).join(' · ') || 'Подробности — в справочнике.'),
        category === 'race' ? el('p', { class: 'builder-readonly-note small' }, 'Раса — цельный блок справочника. Текст и особенности здесь не редактируются; выберите другой блок или создайте отдельную запись расы.') : null,
        category === 'background' && /посвящ[её]нн[а-яё]*\s+в\s+маг(?:ии|ию)|magic initiate/i.test(String(d.feat || ''))
          ? el('p', { class: 'builder-readonly-note small' }, 'На шаге «Заклинания» выберите список, заклинательную характеристику, два заговора и одно заклинание 1-го уровня из этого списка.') : null,
        el('details', {}, el('summary', {}, 'Поля записи'), Compendium.renderData(selected, { readOnly: true }))) : null,
      el('button', { class: 'small', onclick: async () => { try { await Compendium.editEntry(null, { category, onSaved: load }); } catch (e) { toast(e.message); } } }, '+ Создать свой модуль'));
  }
  // ---------- Шаг «Происхождение»: подкласс, правила класса и расы, выборы модулей ----------
  function subclassSection() {
    const klass = draft.selected.class;
    if (!klass) return null;
    const subs = (klass.data?.subclasses || []).filter(s => s && typeof s === 'object' && String(s.name || '').trim());
    if (!subs.length) return null;
    const at = B.subclassLevel(klass);
    if (at !== 1) return el('section', { class: 'builder-module builder-subclass-note' },
      el('b', {}, 'Подкласс'),
      el('p', { class: 'muted small' }, at ? `По записи класса подкласс выбирается на ${at} уровне — вы сможете выбрать его при повышении уровня.` : 'Для этого класса в записи справочника подклассы не настроены.'));
    const available = subs.filter(sub => {
      const levels = Object.keys(sub.features || {}).map(Number).filter(n => Number.isInteger(n) && n >= 1);
      return levels.length && Math.min(...levels) === 1;
    });
    const box = el('section', { class: 'builder-module builder-subclass' },
      available.length < subs.length ? el('p', { class: 'muted small' }, 'Показаны только подклассы, выбираемые на 1 уровне по их таблице умений.') : null,
      el('h3', {}, 'Подкласс · выбор на 1 уровне'),
      el('p', { class: 'muted small' }, `Вложенные в запись класса «${klass.name}» варианты из справочника.`));
    for (const raw of available) {
      const entry = B.subclassModule(klass, raw), on = draft.selected.subclass?.name === entry.name;
      const firstFeatures = (entry.data.features?.['1'] || []).filter(n => typeof n === 'string' && !n.startsWith('|'));
      box.append(el('label', { class: 'builder-subclass-option' + (on ? ' on' : '') },
        el('input', { type: 'radio', name: 'builder-subclass', checked: on ? '' : null, onchange: () => {
          draft.selected.subclass = entry; draft.ruleChoices.subclassVariants = {}; render();
        } }),
        el('span', { class: 'builder-subclass-body' },
          el('span', { class: 'builder-subclass-head' }, el('b', {}, entry.name), el('small', { class: 'muted' }, `${klass.name} · ${klass.source || 'Справочник'}`)),
          entry.data.desc ? el('span', { class: 'builder-description' }, entry.data.desc) : null,
          firstFeatures.length ? el('span', { class: 'builder-subclass-features' }, el('b', {}, 'Умения 1 уровня: '), firstFeatures.join(' · ')) : null)));
    }
    for (const group of subclassVariantGroups(draft.selected.subclass, 1)) {
      const choices = draft.ruleChoices.subclassVariants || (draft.ruleChoices.subclassVariants = {}), selected = choices[group.base];
      box.append(el('section', { class: 'builder-panel builder-subclass-variants' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, group.base), el('small', { class: 'muted' }, 'Выберите один вариант умения подкласса.')),
          el('span', { class: 'builder-counter' + (group.options.includes(selected) ? ' ok' : ' flag') }, group.options.includes(selected) ? '1 из 1 · готово' : '0 из 1')),
        el('div', { class: 'builder-choice-options' }, ...group.options.map(name => {
          const featureName = name.slice(group.base.length + 1).trim(), on = selected === name;
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'radio', name: `subclass-variant-${group.base}`, checked: on ? '' : null, onchange: () => { choices[group.base] = name; render(); } }),
            el('span', {}, el('b', {}, featureName), el('small', { class: 'muted' }, draft.selected.subclass.data.feature_texts?.[name] || '')));
        }))));
    }
    return box;
  }
  function classRuleChoiceSection() {
    const klass = draft.selected.class;
    if (!klass) return null;
    const slug = classSlugOf(klass), choices = draft.ruleChoices || (draft.ruleChoices = {}), panels = [];
    const radioPanel = (key, title, hint, options) => {
      const selected = choices[key];
      panels.push(el('section', { class: 'builder-panel builder-class-rule-choices' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, title), el('small', { class: 'muted' }, hint)),
          el('span', { class: 'builder-counter' + (options.some(o => o.value === selected) ? ' ok' : ' flag') }, options.some(o => o.value === selected) ? '1 из 1 · готово' : '0 из 1')),
        el('div', { class: 'builder-choice-options' }, ...options.map(o => {
          const on = selected === o.value;
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'radio', name: `builder-rule-${key}`, checked: on ? '' : null, onchange: () => { choices[key] = o.value; render(); } }),
            el('span', {}, el('b', {}, o.name), o.text ? el('small', { class: 'muted' }, o.text) : null));
        }))));
    };
    if (draft.edition === '2014' && slug === 'fighter') {
      const styles = Object.keys(klass.data?.feature_texts || {}).filter(name => /^Боевой стиль:\s*/.test(name));
      if (styles.length) radioPanel('fightingStyle', 'Боевой стиль', 'Правило D&D 2014: выберите один стиль.', styles.map(name => ({ value: name, name: name.replace(/^Боевой стиль:\s*/, ''), text: klass.data.feature_texts[name] })));
    }
    if (draft.edition === '2024' && slug === 'cleric') radioPanel('clericOrder', 'Божественный орден', 'Выберите одну роль жреца на 1 уровне.', [
      { value: 'protector', name: 'Защитник', text: 'Владение воинским оружием и тяжёлыми доспехами.' },
      { value: 'thaumaturge', name: 'Чудотворец', text: 'Один дополнительный заговор жреца.' },
    ]);
    if (draft.edition === '2024' && slug === 'druid') radioPanel('druidOrder', 'Первобытный орден', 'Выберите одну роль друида на 1 уровне.', [
      { value: 'magician', name: 'Маг', text: 'Один дополнительный заговор друида.' },
      { value: 'warden', name: 'Страж', text: 'Владение воинским оружием и средними доспехами.' },
    ]);
    if (draft.edition === '2024' && slug === 'fighter') {
      const styles = entries.filter(e => e.category === 'feat' && e.data?.prerequisites === 'feature_named');
      if (styles.length) radioPanel('fightingStyleFeat', 'Черта «Боевой стиль»', 'Выберите одну черту боевого стиля воина 2024.', styles.map(e => ({ value: e.id, name: e.name, text: e.data?.desc || '' })));
    }
    if (['2014', '2024'].includes(draft.edition) && slug === 'bard') {
      const instruments = entries.filter(e => e.category === 'item' && e.data?.category === 'Музыкальные инструменты');
      const selected = choices.bardInstruments || [], need = 3;
      panels.push(el('section', { class: 'builder-panel builder-class-rule-choices' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, 'Музыкальные инструменты'), el('small', { class: 'muted' }, 'Бард выбирает владение тремя музыкальными инструментами.')),
          el('span', { class: 'builder-counter' + (selected.length === need ? ' ok' : ' flag') }, `${selected.length} из ${need}`)),
        el('div', { class: 'builder-choice-options' }, ...instruments.map(e => {
          const on = selected.includes(e.name);
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && selected.length >= need ? '' : null, onchange: ev => {
              const next = selected.filter(name => name !== e.name); if (ev.target.checked) next.push(e.name);
              choices.bardInstruments = next.slice(0, need); render();
            } }), el('span', {}, e.name));
        }))));
    }
    if (draft.edition === '2014' && slug === 'ranger') {
      radioPanel('favoredEnemy', 'Избранный враг · следопыт', 'Выберите тип существ, против которых вы особенно опытны.', ['Аберрации','Звери','Небожители','Конструкты','Драконы','Элементали','Феи','Исчадия','Великаны','Монстры','Слизи','Растения','Нежить','Гуманоиды'].map(name => ({ value: name, name })));
      if (choices.favoredEnemy === 'Гуманоиды') panels.push(el('section', { class: 'builder-panel builder-class-rule-choices' },
        el('b', {}, 'Избранный враг · гуманоиды'),
        field('Первый вид гуманоидов', el('input', { value: choices.favoredHumanoidOne || '', maxlength: 80, oninput: e => choices.favoredHumanoidOne = e.target.value })),
        field('Второй вид гуманоидов', el('input', { value: choices.favoredHumanoidTwo || '', maxlength: 80, oninput: e => choices.favoredHumanoidTwo = e.target.value }))));
      if (choices.favoredEnemy) panels.push(el('section', { class: 'builder-panel builder-class-rule-choices' },
        field('Дополнительный язык, распространённый среди избранных врагов (если применимо)', el('select', { onchange: e => { choices.favoredLanguage = e.target.value; render(); } }, el('option', { value: '' }, 'Не выбирать'), ...B.LANGUAGES.filter(x => x !== 'Общий').map(language => el('option', { value: language, selected: choices.favoredLanguage === language ? '' : null }, language))))));
      radioPanel('favoredTerrain', 'Природный исследователь · следопыт', 'Выберите одну местность, знакомую вам особенно хорошо.', ['Арктика','Побережье','Пустыня','Лес','Луга','Горы','Болото','Подземье'].map(name => ({ value: name, name })));
    }
    const masteryCount = weaponMasteryCount(draft.edition, slug);
    if (masteryCount) {
      const weaponOptions = weaponMasteryOptions(klass, entries);
      const selected = choices.weaponMasteries || [];
      panels.push(el('section', { class: 'builder-panel builder-class-rule-choices' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, `Мастерство оружия · ${masteryCount}`), el('small', { class: 'muted' }, 'Выберите разные виды оружия, которыми владеет класс.')),
          el('span', { class: 'builder-counter' + (selected.length === masteryCount ? ' ok' : ' flag') }, `${selected.length} из ${masteryCount}`)),
        el('div', { class: 'builder-choice-options' }, ...weaponOptions.map(e => {
          const on = selected.includes(e.id);
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && selected.length >= masteryCount ? '' : null, onchange: ev => {
              const next = selected.filter(id => id !== e.id);
              if (ev.target.checked) next.push(e.id);
              choices.weaponMasteries = next.slice(0, masteryCount); render();
            } }),
            el('span', {}, el('b', {}, e.name), el('small', { class: 'muted' }, `${e.data.category} · мастерство: ${e.data.mastery}`)));
        }))));
    }
    return panels.length ? el('div', { class: 'builder-class-rule-choice-list' }, ...panels) : null;
  }
  function raceRuleChoiceSection() {
    const race = draft.selected.race;
    if (!race) return null;
    const rootName = race.data?.parent || race.name;
    const rootEntry = entries.find(e => e.category === 'race' && e.name === rootName && !e.data?.parent);
    const nameEn = String(race.data?.name_en || '').toLowerCase(), rootNameEn = String(rootEntry?.data?.name_en || race.data?.name_en || '').toLowerCase();
    const choices = draft.ruleChoices || (draft.ruleChoices = {}), panels = [];
    const radioPanel = (key, title, hint, options) => {
      const selected = choices[key];
      panels.push(el('section', { class: 'builder-panel builder-race-rule-choices' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, title), el('small', { class: 'muted' }, hint)),
          el('span', { class: 'builder-counter' + (options.some(o => o.value === selected) ? ' ok' : ' flag') }, options.some(o => o.value === selected) ? '1 из 1 · готово' : '0 из 1')),
        el('div', { class: 'builder-choice-options' }, ...options.map(o => {
          const on = selected === o.value;
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'radio', name: `builder-race-${key}`, checked: on ? '' : null, onchange: () => { choices[key] = o.value; render(); } }),
            el('span', {}, el('b', {}, o.name), o.text ? el('small', { class: 'muted' }, o.text) : null));
        }))));
    };
    const skillPanel = (count, title) => {
      const selected = choices.raceSkills || [];
      panels.push(el('section', { class: 'builder-panel builder-race-rule-choices' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, title), el('small', { class: 'muted' }, `Выберите ${count} навы${count === 1 ? 'к' : 'ка'} на выбор.`)),
          el('span', { class: 'builder-counter' + (selected.length === count ? ' ok' : ' flag') }, `${selected.length} из ${count}`)),
        el('div', { class: 'builder-choice-options' }, ...SKILLS.map(([key, label]) => {
          const on = selected.includes(key);
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && selected.length >= count ? '' : null, onchange: e => {
              const next = selected.filter(k => k !== key);
              if (e.target.checked) next.push(key);
              choices.raceSkills = next.slice(0, count); render();
            } }), el('span', {}, label));
        }))));
    };
    if (draft.edition === '2014' && nameEn === 'half-elf') skillPanel(2, 'Универсальность навыков · полуэльф');
    if (draft.edition === '2024' && rootNameEn === 'elf') skillPanel(1, 'Острые чувства · эльф');
    if (draft.edition === '2024' && rootNameEn === 'human') {
      skillPanel(1, 'Умелость · человек');
      const feats = entries.filter(e => e.category === 'feat' && !e.data?.prerequisites
        && normalizeName(e.name) !== normalizeName(draft.selected.feat?.name || ''));
      if (feats.length) radioPanel('humanOriginFeat', 'Универсальность · черта происхождения', 'Человек выбирает дополнительную черту происхождения.', feats.map(e => ({ value: e.id, name: e.name, text: e.data?.desc || '' })));
    }
    if (draft.edition === '2014' && normalizeName(rootName) === normalizeName('Дварф'))
      radioPanel('dwarfTool', 'Владение инструментами · дварф', 'Выберите один вид ремесленных инструментов.', [
        { value: 'Инструменты кузнеца', name: 'Инструменты кузнеца' }, { value: 'Пивоваренные принадлежности', name: 'Пивоваренные принадлежности' }, { value: 'Инструменты каменщика', name: 'Инструменты каменщика' },
      ]);
    if (draft.edition === '2014' && nameEn === 'dragonborn')
      radioPanel('dragonAncestry', 'Драконье наследие · драконорождённый', 'Выбор определяет тип урона дыхания и сопротивление.', [
        { value: 'Чёрный', name: 'Чёрный · кислота' }, { value: 'Синий', name: 'Синий · электричество' }, { value: 'Латунный', name: 'Латунный · огонь' }, { value: 'Бронзовый', name: 'Бронзовый · электричество' }, { value: 'Медный', name: 'Медный · кислота' }, { value: 'Золотой', name: 'Золотой · огонь' }, { value: 'Зелёный', name: 'Зелёный · яд' }, { value: 'Красный', name: 'Красный · огонь' }, { value: 'Серебряный', name: 'Серебряный · холод' }, { value: 'Белый', name: 'Белый · холод' },
      ]);
    if (draft.edition === '2024' && ['elf', 'gnome', 'tiefling'].includes(rootNameEn))
      radioPanel('raceSpellAbility', 'Заклинательная характеристика родословной', 'Выберите характеристику, указанную в особенности расы.', [
        { value: 'int', name: 'Интеллект' }, { value: 'wis', name: 'Мудрость' }, { value: 'cha', name: 'Харизма' },
      ]);
    if (draft.edition === '2014' && nameEn === 'high elf') {
      const cantrips = entries.filter(e => e.category === 'spell' && Number(e.data?.level) === 0 && (e.data?.classes || []).some(c => ['волшебник', 'wizard'].includes(String(c).toLowerCase())));
      if (cantrips.length) radioPanel('racialCantrip', 'Заговор высшего эльфа', 'Выберите один заговор из списка волшебника; Интеллект — заклинательная характеристика.', cantrips.map(e => ({ value: e.id, name: e.name, text: e.data?.desc || '' })));
    }
    return panels.length ? el('div', { class: 'builder-race-rule-choice-list' }, ...panels) : null;
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
  // ---------- Шаг «Навыки»: навыки класса, взаимозамена, языки, владения ----------
  function languageSection() {
    const needed = languageRule();
    if (!needed) return null;
    const known = raceKnownLanguages();
    const eligible = draft.edition === '2024' ? B.LANGUAGES_2024_STANDARD : B.LANGUAGES;
    const selected = draft.languages || [];
    const knownSet = new Set(known.map(normalizeName));
    const options = eligible.filter(language => !knownSet.has(normalizeName(language)) || selected.some(value => normalizeName(value) === normalizeName(language)));
    const fromRace = raceLanguageChoice();
    const classSlug = String(draft.selected.class?.data?.name_en || '').toLowerCase() || CLASS_SLUGS_RU[draft.selected.class?.name] || '';
    const origin = [draft.edition === '2024' ? 'происхождение — 2 стандартных' : '',
      Number(draft.selected.background?.data?.languages) > 0 ? `предыстория — ${draft.selected.background.data.languages}` : '',
      fromRace ? `раса — ${fromRace}` : '', draft.edition === '2024' && classSlug === 'rogue' ? 'плут — 1 стандартный' : ''].filter(Boolean).join(' · ');
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
  /// Шаг «Навыки»: выбор по правилам D&D — сколько даёт класс, что уже выдано модулями
  /// и почему повторный навык заменяется другим (PHB: одно владение из двух источников).
  function skillsSection(getPreview) {
    const skills = B.skillsState(draft);
    const box = el('section', { class: 'builder-panel builder-skills-panel' });
    const pending = pendingChoices().filter(item => item.group?.type === 'skill');
    const preview = getPreview();
    /// Плитка навыка: модификатор характеристики, итоговое владение и источник, если навык уже есть.
    const skillTile = (o, { picked, full, onToggle }) => {
      const on = picked.includes(o.key), mod = Math.floor(((preview.abilities[o.ability] ?? 10) - 10) / 2), prof = preview.proficiency_bonus || 2;
      return el('label', { class: 'builder-skill' + (on ? ' on' : '') + (o.granted ? ' taken' : ''), title: o.granted ? `Этот навык уже даёт ${o.granted} — выберите другой` : `Владение: ${signed(mod + prof)} к проверкам` },
        el('input', { type: 'checkbox', checked: on ? '' : null, disabled: o.granted || (!on && full) ? '' : null, onchange: e => onToggle(o, e.target.checked) }),
        el('span', { class: 'grow' }, el('b', {}, o.name),
          el('small', { class: 'muted' }, `${ABIL[o.ability] || o.ability} ${signed(mod)}`),
          el('small', { class: on ? 'builder-skill-bonus on' : 'builder-skill-bonus' }, `владение ${signed(mod + prof)}`)),
        o.granted ? el('small', { class: 'builder-skill-src' }, o.granted) : null);
    };
    /// Навыки идут под заголовками характеристик — как список проверок (LongStory).
    const skillGroupsHtml = (options, opts) => el('div', { class: 'builder-skill-groups' },
      ...Object.entries(ABIL).map(([key, name]) => ({ key, name, list: options.filter(o => (o.ability || 'str') === key) }))
        .filter(group => group.list.length).map(group => el('section', { class: 'builder-skill-group' },
          el('div', { class: 'builder-skill-group-head' }, el('b', {}, group.name),
            el('span', { class: 'builder-counter' }, `${group.list.filter(o => opts.picked.includes(o.key)).length} из ${group.list.length}`)),
          el('div', { class: 'builder-skills' }, ...group.list.map(o => skillTile(o, opts))))));
    if (skills.klass) {
      const { choose, options, picked, source } = skills.klass;
      const full = picked.length >= choose, left = Math.max(0, choose - picked.length);
      box.append(el('div', { class: 'builder-panel-head' },
        el('div', {}, el('b', {}, 'Навыки класса'), el('small', { class: 'muted' }, `${source} · выберите ${choose} ${plural(choose, 'навык', 'навыка', 'навыков')} из списка класса`)),
        el('span', { class: 'builder-counter' + (full ? ' ok' : '') + (picked.length && !full ? ' flag' : '') }, full ? `${picked.length} из ${choose} · готово` : `${picked.length} из ${choose} · ещё ${left}`)));
      box.append(skillGroupsHtml(options, { picked, full, onToggle: (o, checked) => {
        draft.skills = (draft.skills || []).filter(x => x !== o.key);
        if (checked) draft.skills.push(o.key);
        render();
      } }));
      box.append(el('p', { class: 'muted small' }, overlapText(skills.klass.overlap)));
    } else box.append(el('p', { class: 'builder-note' }, 'Класс не даёт выбора навыков — владения приходят из модулей и показаны ниже.'));
    if (skills.free) {
      const { need, options, picked, overlap } = skills.free, fullFree = picked.length >= need, leftFree = Math.max(0, need - picked.length);
      box.append(el('div', { class: 'builder-panel-head builder-free-head' },
        el('div', {}, el('b', {}, 'Взаимозамена навыков'), el('small', { class: 'muted' },
          `Правило D&D: владение из двух источников не удваивается · ${overlap.map(o => `${o.name} — ${o.granted}`).join(', ')}`)),
        el('span', { class: 'builder-counter' + (fullFree ? ' ok' : ' flag') }, fullFree ? `${picked.length} из ${need} · готово` : `${picked.length} из ${need} · ещё ${leftFree}`)));
      box.append(skillGroupsHtml(options, { picked, full: fullFree, onToggle: (o, checked) => {
        draft.freeSkills = (draft.freeSkills || []).filter(x => x !== o.key);
        if (checked) draft.freeSkills.push(o.key);
        render();
      } }));
    }
    if (['rogue'].includes(classSlugOf(draft.selected.class)) && ['2014', '2024'].includes(draft.edition)) {
      const selectedExpertise = draft.ruleChoices.expertise || [], required = 2;
      const options = SKILLS.filter(([key]) => preview.skills.includes(key)).map(([key, name]) => ({ key, name }));
      if (draft.edition === '2014') options.push({ key: 'thieves_tools', name: 'Воровские инструменты' });
      const full = selectedExpertise.length >= required;
      box.append(el('section', { class: 'builder-panel builder-expertise' },
        el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, 'Экспертиза плута'), el('small', { class: 'muted' }, `Выберите ${required} уже полученных владения${draft.edition === '2014' ? ' навыками или воровскими инструментами' : ' навыками'}.`)),
          el('span', { class: 'builder-counter' + (full ? ' ok' : ' flag') }, `${selectedExpertise.length} из ${required}`)),
        el('div', { class: 'builder-choice-options' }, ...options.map(option => {
          const on = selectedExpertise.includes(option.key);
          return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
            el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && full ? '' : null, onchange: e => {
              const next = selectedExpertise.filter(k => k !== option.key);
              if (e.target.checked) next.push(option.key);
              draft.ruleChoices.expertise = next.slice(0, required); render();
            } }), el('span', {}, option.name));
        }))));
    }
    const granted = skills.granted;
    box.append(el('div', { class: 'builder-granted' },
      el('div', { class: 'builder-granted-head' }, el('b', {}, 'Уже владеет'), el('span', { class: 'builder-counter' }, String(granted.length))),
      granted.length
        ? el('div', { class: 'builder-chips' }, ...granted.map(g => el('span', { class: 'builder-chip' }, el('b', {}, g.name), el('small', { class: 'muted' }, sourceLabelOf(g)))))
        : el('p', { class: 'muted small' }, 'Пока пусто: навыки появятся здесь после выбора предыстории, расы и вариантов модулей.'),
      pending.length ? el('button', { class: 'builder-jump', type: 'button', onclick: () => goTo(1) }, `Выбрать навык модуля на шаге «Происхождение» →`) : null));
    return box;
  }
  /// Пометка о совпавших навыках: понятно, что именно заменяется и почему.
  const overlapText = overlap => overlap.length
    ? `Совпало с модулями: ${overlap.map(o => `${o.name} (${o.granted})`).join(', ')} — вместо них можно взять любое другое владение (см. панель ниже).`
    : 'Одно и то же владение из двух источников не складывается: если навык уже даёт раса или предыстория, отметьте другой из списка класса.';

  /// «1 навык», «2 навыка», «5 навыков» — счётчики в правилах D&D читаются словами.
  function plural(n, one, few, many) { const n10 = n % 10, n100 = n % 100; return n100 >= 11 && n100 <= 14 ? many : n10 === 1 ? one : n10 >= 2 && n10 <= 4 ? few : many; }
  /// Источник навыка для метки: «предыстория · Прислужник».
  const sourceLabelOf = g => B.sourceLabel(g) || g.source || '';
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
  // ---------- Шаг «Снаряжение»: варианты, выборы, итог ----------
  function equipmentOptionCard(block, option) {
    const on = draft.equipment.choice[block.id] === option.id;
    const gold = option.tokens.filter(t => t.kind === 'gold').reduce((a, t) => a + t.amount, 0);
    return el('label', { class: 'builder-eq-option' + (on ? ' on' : '') },
      el('input', { type: 'radio', name: 'eq-' + block.id, checked: on ? '' : null, onchange: () => { draft.equipment.choice[block.id] = option.id; render(); } }),
      el('span', { class: 'builder-eq-body' },
        el('span', { class: 'builder-eq-head' }, el('b', {}, `Вариант ${option.marker}`), gold ? el('span', { class: 'builder-chip gold' }, `${gold} зм`) : null),
        el('span', { class: 'builder-eq-list' }, ...option.tokens.filter(t => t.kind !== 'gold').map(t => el('span', { class: 'builder-eq-item' },
          el('b', {}, t.kind === 'pick' ? `по выбору: ${t.label}${t.prefer ? ` · в записи указан вариант «${t.prefer}»` : ''}${(t.count || 1) > 1 ? ` ×${t.count}` : ''}` : t.name + ((t.qty || 1) > 1 ? ` ×${t.qty}` : '')),
          t.kind === 'item' && findTemplateFor(t.name) ? null : t.kind === 'item' ? el('small', { class: 'muted' }, 'нет в справочнике — попадёт как предмет без шаблона') : null)))));
  }
  const findTemplateFor = name => B.findItemTemplate(name, equipmentCatalog());
  function equipmentItemRow(item) {
    const gmOverrides = !!draft.equipment.gmOverrides;
    const excluded = gmOverrides && !!draft.equipment.exclude[item.key];
    const qty = gmOverrides ? Math.max(1, Number(draft.equipment.qty[item.key] ?? item.qty) || 1) : Math.max(1, Number(item.qty) || 1);
    const name = item.entry ? entryName(item.entry) : item.name;
    const metadata = [item.pack && `разложен на ${item.contents} предметов`, item.note, item.entry ? entryCategory(item.entry) : 'нет шаблона в справочнике', item.source].filter(Boolean).join(' · ');
    if (!gmOverrides) return el('div', { class: 'builder-eq-row' },
      el('span', { class: 'builder-eq-name' }, el('b', {}, name), metadata ? el('small', { class: 'muted' }, metadata) : null),
      qty > 1 ? el('span', { class: 'builder-eq-qty muted' }, `×${qty}`) : null,
      el('span', { class: 'builder-eq-weight muted small' }, item.pack ? 'набор' : item.entry ? `${weight({ ...item.entry.data, qty })} фнт` : '—'));
    const listId = 'builder-item-names';
    return el('div', { class: 'builder-eq-row' + (excluded ? ' off' : '') },
      el('label', { class: 'builder-eq-check', title: 'Добавить предмет в инвентарь' },
        el('input', { type: 'checkbox', checked: excluded ? null : '', onchange: e => { if (e.target.checked) delete draft.equipment.exclude[item.key]; else draft.equipment.exclude[item.key] = true; render(); } })),
      el('span', { class: 'builder-eq-name' }, el('b', {}, name), el('small', { class: 'muted' }, metadata)),
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
      el('span', {}, `Выберите: ${item.label}${item.prefer ? ` · в записи указан вариант «${item.prefer}»` : ''}`),
      el('select', { onchange: e => { if (e.target.value) draft.equipment.picks[item.key] = e.target.value; else delete draft.equipment.picks[item.key]; render(); } },
        el('option', { value: '', selected: value ? null : '' }, '— выберите предмет —'),
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
    body.append(el('h2', {}, 'Стартовое снаряжение'), el('p', { class: 'muted' }, 'Показывается стандартная выдача класса и предыстории по выбранным вариантам. Убрать предметы, менять количество или шаблон и добавлять золото/вещи можно только в отдельном режиме правок мастера. Экипировка и её слоты проверяются по правилам инвентаря.'));
    if (!plan.length) body.append(el('p', { class: 'builder-note' }, 'У выбранных класса и предыстории нет указанного стартового снаряжения.'));
    // Безусловные предметы всех блоков собираются в одну панель — иначе три одинаковых
    // заголовка «Обязательные предметы» подряд занимают пол-экрана.
    const rowsOf = block => items.filter(i => i.key.startsWith(block.id + ':') && !i.pick && !i.parent);
    const picksOf = block => items.filter(i => i.key.startsWith(block.id + ':') && i.pick && !i.parent);
    const fixedBlocks = plan.filter(b => b.kind === 'fixed');
    const guaranteed = fixedBlocks.flatMap(rowsOf);
    // «Священный символ», «друидическая фокусировка» и другие выборы вне групп (a)/(b)
    // тоже нужно показать игроку — иначе шаг снаряжения нельзя пройти.
    const guaranteedPicks = fixedBlocks.flatMap(picksOf);
    if (guaranteed.length || guaranteedPicks.length) body.append(el('div', { class: 'builder-eq-block' },
      el('div', { class: 'builder-eq-block-head' },
        el('b', {}, 'Выдаётся сразу'),
        el('small', { class: 'muted' }, [...new Set(fixedBlocks.map(b => b.sourceName))].join(' · '))),
      guaranteedPicks.length ? el('div', { class: 'builder-eq-picks' }, ...guaranteedPicks.map(equipmentPickRow)) : null,
      el('div', { class: 'builder-eq-rows' }, ...guaranteed.map(equipmentItemRow))));
    for (const block of plan) {
      if (block.kind !== 'group') continue;
      const option = block.options.find(o => o.id === draft.equipment.choice[block.id]) || null;
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
    if (plan.length && draft.equipment.gmOverrides) body.append(el('p', { class: 'muted small' }, 'В этом режиме можно заменить название на запись справочника — количество, вес и действия подтянутся из неё.'));
    const gmOverrides = !!draft.equipment.gmOverrides;
    body.append(el('details', { class: 'builder-gm-equipment', open: gmOverrides ? '' : null },
      el('summary', {}, 'Ручные правки мастера · не базовые правила'),
      el('p', { class: 'muted small' }, 'Включайте только если мастер разрешил отклониться от стандартной стартовой выдачи.'),
      el('label', { class: 'builder-check-row' }, el('input', { type: 'checkbox', checked: gmOverrides ? '' : null, onchange: e => {
        draft.equipment.gmOverrides = e.target.checked;
        if (!e.target.checked) {
          draft.equipment.exclude = {}; draft.equipment.qty = {}; draft.equipment.template = {}; draft.equipment.name = {};
          draft.equipment.extras = []; draft.equipment.gold = 0;
        }
        render();
      } }), 'Разрешить ручные изменения снаряжения'),
      gmOverrides ? el('div', {},
        el('div', { class: 'builder-eq-extras' },
          el('b', {}, 'Добавить предмет · не часть стандартной выдачи'),
          el('div', { class: 'builder-eq-extra-row' },
            el('input', { id: 'builder-extra-name', list: 'builder-item-names', placeholder: 'Предмет, например «Верёвка пеньковая (50 футов)»' }),
            el('input', { id: 'builder-extra-qty', class: 'builder-eq-qty', type: 'number', min: 1, max: 1000, value: 1, 'aria-label': 'Количество нового предмета' }),
            el('button', { class: 'small', onclick: () => {
              const nameInput = root.querySelector('#builder-extra-name'), qtyInput = root.querySelector('#builder-extra-qty');
              const name = (nameInput?.value || '').trim(); if (!name) return;
              const entry = equipmentCatalog().find(x => entryName(x).toLocaleLowerCase() === name.toLocaleLowerCase());
              draft.equipment.extras.push({ key: uidSafe(), entryId: entry?.id || '', name, qty: Math.max(1, Math.round(Number(qtyInput?.value) || 1)) });
              render();
            } }, '+ Добавить'))),
        field('Дополнительное золото, зм', el('input', { type: 'number', min: 0, max: 999999, value: Number(draft.equipment.gold) || 0, onchange: e => { draft.equipment.gold = Math.max(0, Math.round(Number(e.target.value) || 0)); render(); } })),
        draft.equipment.extras.length ? el('div', { class: 'builder-eq-rows' }, ...items.filter(i => i.manual).map(item => el('div', { class: 'builder-eq-row' },
          el('span', { class: 'builder-eq-name' }, el('b', {}, item.name), el('small', { class: 'muted' }, item.entry ? item.entry.category : 'нет шаблона в справочнике')),
          el('span', { class: 'builder-eq-qty muted' }, `×${item.qty}`),
          el('button', { class: 'small danger', onclick: () => { draft.equipment.extras = draft.equipment.extras.filter(x => x.key !== item.key); render(); } }, 'Убрать')))) : null)
        : null));
    body.append(el('div', { class: 'builder-eq-settings' },
      el('label', { class: 'builder-check-row' }, el('input', { type: 'checkbox', checked: draft.equipment.autoEquip === false ? null : '', onchange: e => { draft.equipment.autoEquip = e.target.checked; render(); } }), 'Автоматически отметить экипировку'),
      el('label', { class: 'builder-check-row' }, el('input', { type: 'checkbox', checked: draft.equipment.packs === false ? null : '', onchange: e => { draft.equipment.packs = e.target.checked; render(); } }), 'Показывать содержимое наборов отдельными предметами'),
      el('p', { class: 'muted small' }, 'Это настройки отображения листа: состав и количество стартовой выдачи не меняются.')));
    body.append(equipmentSummary());
    return body;
  }
  const uidSafe = () => 'ex' + Math.random().toString(36).slice(2, 9);
  /// Переход между шагами. Всё в мастере необязательно: вперёд пускаем всегда,
  /// незаполненное остаётся отмеченным подсказкой в навигации и на шаге «Проверка».
  // ---------- Навигация и перерисовка ----------
  function goTo(target) {
    const next = Math.max(0, Math.min(last, Number(target) || 0));
    if (next === step) return;
    step = next; render();
  }
  function render() {
    // Rebuilding the wizard after every choice used to replace the scrolling body with a
    // fresh element at scrollTop=0. Keep the position (and focused control) for edits on
    // the same step; a deliberate step change starts at the top as expected.
    const previousBody = root.querySelector('.builder-body');
    const keepPosition = previousBody && Number(previousBody.dataset.step) === step;
    const scrollTop = keepPosition ? previousBody.scrollTop : 0;
    const active = keepPosition && previousBody.contains(document.activeElement) ? document.activeElement : null;
    const focusPath = [];
    if (active) {
      let node = active;
      while (node && node !== previousBody) {
        const parent = node.parentElement;
        if (!parent) break;
        focusPath.unshift(Array.prototype.indexOf.call(parent.children, node));
        node = parent;
      }
    }
    const selection = active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    root.replaceChildren(); status.textContent = ''; previewCache = null;
    const issues = stepIssues();
    root.append(el('nav', { class: 'builder-steps', 'aria-label': 'Шаги создания персонажа' }, ...steps.map((name, i) => {
      const done = i < step, problem = issues.get(i) && i !== step;
      return el('button', {
        type: 'button', class: `builder-step${i === step ? ' current' : done ? ' done' : ''}${problem ? ' flag' : ''}`,
        'aria-current': i === step ? 'step' : null, title: issues.get(i) ? skipNote(issues.get(i)) : stepTips[i],
        onclick: () => goTo(i)
      }, el('span', { class: 'builder-step-n' }, done ? '✓' : String(i + 1)),
        el('span', { class: 'builder-step-t' }, el('b', {}, name), el('small', {}, i === last ? 'Готовый лист' : stepTips[i])));
    })));
    const problem = issues.get(step);
    root.append(el('div', { class: 'builder-step-context' },
      el('div', { class: 'builder-progress' }, el('span', { style: `width:${((step + 1) / steps.length) * 100}%` })),
      el('div', { class: 'builder-context-row' },
        el('b', {}, `Шаг ${step + 1} из ${steps.length} · ${steps[step]}`),
        el('span', { class: problem ? 'builder-flag' : 'muted small' }, problem ? '! ' + skipNote(problem) : stepTips[step]))));
    const body = el('div', { class: 'builder-body' });
    body.dataset.step = String(step);
    const add = (...nodes) => nodes.filter(Boolean).forEach(node => body.append(node));
    root.append(body);
    if (step === 0) {
      add(el('div', { class: 'builder-intro' }, el('span', { class: 'builder-eyebrow' }, 'DUNGEONS & DRAGONS · УРОВЕНЬ 1'), el('h2', {}, 'Каждая история начинается с героя'), el('p', { class: 'muted' }, 'Восемь понятных шагов — от концепции до готового листа. Расы, классы и предыстории подключаются как блоки из справочника, а навыки и снаряжение собираются по правилам.')),
        field('Имя персонажа', el('input', { value: draft.name, maxlength: 128, placeholder: 'Как вас будут помнить?', oninput: e => draft.name = e.target.value })),
        field('Редакция правил', el('select', { onchange: e => { draft.edition = e.target.value; draft.selected = {}; draft.spells = []; draft.preparedSpells = []; draft.skills = []; draft.freeSkills = []; draft.languages = []; draft.bonuses = {}; draft.ruleChoices = {}; draft.equipment = emptyEquipment(); load(); } }, ...Object.entries(EDITIONS).map(([k, n]) => el('option', { value: k, selected: draft.edition === k ? '' : null }, n)))),
        el('p', { class: 'muted small' }, '2014: бонусы характеристик от расы. 2024: от предыстории. Пользовательские модули доступны из ваших наборов и наборов кампании.'),
        el('p', { class: 'muted small' }, 'Все шаги необязательны: незаполненное можно пропустить и дополнить позже на листе персонажа. Нужен чистый лист без подсказок мастера — нажмите «Заполнить самостоятельно» внизу окна.'));
    }
    if (step === 1 || step === 4) {
      if (loading) add(el('p', { role: 'status' }, 'Загружаем модули…'));
      else if (error) add(el('p', { role: 'alert' }, 'Не удалось загрузить: ' + error), el('button', { onclick: load }, 'Повторить'));
      else if (step === 1) add(el('div', { class: 'builder-modules' }, ...['race', 'class', 'background'].map(choose)), subclassSection(), raceRuleChoiceSection(), classRuleChoiceSection(), choiceSection());
      else {
        const limits = spellRule();
        const hasClassSpellChoices = !!limits && (limits.cantrips > 0 || limits.spells > 0);
        const limitText = limits
          ? `${limits.cantrips} ${plural(limits.cantrips, 'заговор', 'заговора', 'заговоров')} и ${limits.spells} ${plural(limits.spells, 'заклинание', 'заклинания', 'заклинаний')} 1-го круга${limits.mode === 'book' ? ' в книгу заклинаний' : ''}. Ячейки 1-го круга: ${limits.slots[1]?.max || 0}.`
          : 'Таблица развития этого класса не содержит проверяемого выбора заклинаний.';
        const countBadge = hasClassSpellChoices ? el('span', { class: 'builder-counter' }) : null;
        add(el('h2', {}, 'Заклинания на 1 уровне'),
          el('p', { class: 'muted' }, hasClassSpellChoices
            ? `${limitText} Показаны только заклинания из списка класса в справочнике.`
            : limits ? 'По таблице этого класса на 1 уровне выбирать классовые заклинания не нужно.'
              : limitText),
          hasClassSpellChoices ? el('div', { class: 'builder-spell-filters' },
            el('input', { type: 'search', value: query, placeholder: 'Найти заклинание…', 'aria-label': 'Поиск заклинания', oninput: e => { query = e.target.value; updateSpells(); } }),
            ...Object.entries({ all: 'Все', cantrip: 'Заговоры', first: '1 круг' }).map(([key, label]) => el('button', {
              class: 'small' + (spellFilter === key ? ' on' : ''), onclick: () => { spellFilter = key; render(); }
            }, label)), countBadge) : null);
        const list = hasClassSpellChoices ? el('div', { class: 'builder-spells' }) : null;
        if (list) body.append(list);
        const prepBox = limits?.mode === 'book' ? el('section', { class: 'builder-panel builder-book-preparation' }) : null;
        if (prepBox) body.append(prepBox);
        const initiateBox = magicInitiateSection(); if (initiateBox) body.append(initiateBox);
        updateSpells();
        function updateSpells() {
          if (!list) { updateBookPreparation(); return; }
          const levelOf = e => Number(e.data?.level || 0);
          const current = spellSelectionCounts();
          countBadge.textContent = `Заговоры ${current.cantrips}/${limits.cantrips} · Заклинания ${current.spells}/${limits.spells}`;
          countBadge.classList.toggle('ok', current.cantrips === limits.cantrips && current.spells === limits.spells);
          const found = entries.filter(e => e.category === 'spell' && levelOf(e) <= 1 && spellAllowedToClass(e)
            && (spellFilter === 'all' || (spellFilter === 'cantrip' ? levelOf(e) === 0 : levelOf(e) === 1))
            && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
          list.replaceChildren(...found.map(e => {
            const isOn = draft.spells.some(x => x.id === e.id), level = levelOf(e), currentForLevel = level === 0 ? current.cantrips : current.spells;
            const limit = limits ? (level === 0 ? limits.cantrips : limits.spells) : Infinity;
            return el('label', { class: 'builder-spell' + (isOn ? ' on' : '') },
              el('input', { type: 'checkbox', checked: isOn ? '' : null, disabled: !isOn && currentForLevel >= limit ? '' : null, onchange: ev => {
                if (!ev.target.checked) { draft.spells = draft.spells.filter(x => x.id !== e.id); draft.preparedSpells = (draft.preparedSpells || []).filter(name => name !== e.name); }
                else if (currentForLevel >= limit) { ev.target.checked = false; return toast(`Лимит этого класса: ${limit} ${level === 0 ? plural(limit, 'заговор', 'заговора', 'заговоров') : plural(limit, 'заклинание', 'заклинания', 'заклинаний')}.`); }
                else if (!draft.spells.some(x => x.id === e.id)) draft.spells.push(e);
                updateSpells();
              } }),
              el('span', {}, el('b', {}, e.name), el('small', { class: 'muted' }, `${level === 0 ? 'Заговор' : level + ' круг'} · ${e.source}`)),
              el('span', { class: 'builder-spell-info', title: e.data?.desc || '' }, 'ⓘ'));
          }));
          if (!found.length) list.append(el('p', { class: 'muted' }, 'Подходящих заклинаний не найдено. Измените поиск или проверьте доступные записи справочника.'));
          updateBookPreparation();
        }
        function updateBookPreparation() {
          if (!prepBox) return;
          const selectedBook = (draft.spells || []).filter(e => Number(e.data?.level) === 1);
          const prepared = draft.preparedSpells || [];
          prepBox.replaceChildren(
            el('div', { class: 'builder-panel-head' }, el('div', {}, el('b', {}, 'Подготовка из книги заклинаний'), el('small', { class: 'muted' }, `По правилам: подготовьте ${limits.preparedCount} заклинаний 1-го уровня из своей книги.`)),
              el('span', { class: 'builder-counter' + (prepared.length === limits.preparedCount ? ' ok' : ' flag') }, `${prepared.length} из ${limits.preparedCount}`)),
            el('div', { class: 'builder-choice-options' }, ...selectedBook.map(spell => {
              const on = prepared.includes(spell.name);
              return el('label', { class: 'builder-choice-option' + (on ? ' on' : '') },
                el('input', { type: 'checkbox', checked: on ? '' : null, disabled: !on && prepared.length >= limits.preparedCount ? '' : null, onchange: e => {
                  const next = prepared.filter(name => name !== spell.name);
                  if (e.target.checked) next.push(spell.name);
                  draft.preparedSpells = next.slice(0, limits.preparedCount); updateSpells();
                } }), el('span', {}, spell.name));
            })),
            selectedBook.length ? null : el('p', { class: 'muted small' }, 'Сначала выберите заклинания для книги выше.'));
        }
      }
    }
    if (step === 2) {
      add(el('h2', {}, 'Шесть граней вашего героя'), el('p', { class: 'muted' }, 'Выберите способ: стандартный набор, покупка очков (27), 4d6 с отбрасыванием меньшего или ручной ввод. Отдельный бросок 6d20 — вариант по договорённости за столом, а не стандартный способ из правил. Бонусы применяются отдельно; итог не выше 20.'));
      add(el('div', { class: 'row builder-ability-actions' },
        el('button', { class: draft.method === 'rolled' ? 'on' : '', onclick: () => { draft.method = 'rolled'; draft.rolls = B.rollStats(); B.keys.forEach((k, i) => draft.abilities[k] = draft.rolls[i].total); render(); } }, icon('dice'), ' Бросить 6 × 4d6'),
        el('button', { class: draft.method === 'd20' ? 'on' : '', onclick: () => { draft.method = 'd20'; draft.rolls = B.rollD20Stats(); B.keys.forEach((k, i) => draft.abilities[k] = draft.rolls[i].total); render(); } }, icon('dice'), ' Бросить 6 × 1d20'),
        el('button', { class: draft.method === 'manual' ? 'on' : '', onclick: () => { draft.method = 'manual'; draft.rolls = []; render(); } }, 'Ввести вручную'),
        el('button', { class: draft.method === 'standard' ? 'on' : '', onclick: () => { draft.method = 'standard'; draft.rolls = []; B.keys.forEach((k, i) => draft.abilities[k] = [15, 14, 13, 12, 10, 8][i]); render(); } }, 'Стандартный набор'),
        el('button', { class: draft.method === 'pointbuy' ? 'on' : '', onclick: () => { draft.method = 'pointbuy'; draft.rolls = []; B.keys.forEach((k, i) => draft.abilities[k] = [15, 14, 13, 12, 10, 8][i]); render(); } }, `Покупка очков · ${pointBuyTotal(draft.abilities)}/27`)));
      const sheet = preview();
      add(el('div', { class: 'builder-abilities' }, ...B.keys.map((k, i) => {
        const input = draft.method === 'pointbuy'
          ? el('select', { 'aria-label': ABIL[k], onchange: e => { draft.abilities[k] = Number(e.target.value); render(); } },
              ...Object.keys(POINT_BUY_COST).map(score => {
                const value = Number(score), remaining = 27 - pointBuyTotal({ ...draft.abilities, [k]: 8 });
                return el('option', { value, selected: draft.abilities[k] === value ? '' : null,
                  disabled: POINT_BUY_COST[value] > remaining && draft.abilities[k] !== value ? '' : null }, `${value} · ${POINT_BUY_COST[value]} оч.`);
              }))
          : draft.method === 'manual'
            ? el('input', { type: 'number', min: 1, max: 20, step: 1, value: draft.abilities[k], 'aria-label': ABIL[k], onchange: e => { draft.abilities[k] = Number(e.target.value); render(); } })
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
        el('p', { class: 'builder-review-subtitle' }, [s.race, `${s.class}${s.subclass ? ` · ${s.subclass}` : ''} · 1 уровень`, s.background].join(' / ')),
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
      step < last ? el('span', { class: 'builder-nav-actions' },
        problem ? el('button', { class: 'small builder-skip', title: skipNote(problem), onclick: () => goTo(step + 1) }, 'Пропустить шаг') : null,
        el('button', { class: 'primary', onclick: () => goTo(step + 1) }, 'Далее →'))
        : el('span', { class: 'builder-nav-hint' }, 'Осталось нажать «Создать персонажа»'));
    root.append(status, nav, el('datalist', { id: 'builder-item-names' }, ...equipmentCatalog().map(e => el('option', { value: e.name }))));
    if (keepPosition) {
      body.scrollTop = scrollTop;
      let target = body;
      for (const index of focusPath) target = target.children[index];
      if (active && target?.focus) {
        target.focus({ preventScroll: true });
        if (selection && typeof target.setSelectionRange === 'function') {
          try { target.setSelectionRange(selection[0], selection[1], selection[2]); } catch (_) { /* input type does not support selection */ }
        }
      }
      body.scrollTop = scrollTop;
    }
  }
  // ---------- Открытие: первичная отрисовка, загрузка каталога, модальное окно ----------
  render(); load();
  const result = await modal('Создание персонажа', root, [
    { label: 'Заполнить самостоятельно', title: 'Пропустить мастер и получить пустой лист: расу, класс, характеристики и снаряжение вы заполните сами',
      fn: () => {
        if (draftFilled() && !confirm('Пропустить мастер? Уже выбранные раса, класс, навыки и снаряжение не попадут в лист — он будет пустым.')) return false;
        const name = draft.name.trim() || 'Новый персонаж';
        LS.setItem('et-edition', draft.edition);
        return { name, sheet: manualSheet(name) };
      } },
    { label: 'Создать персонажа', cls: 'primary builder-submit', fn: finishDraft }
  ], { wide: true });
  request++; // Ignore late fetches after cancellation.
  return result;
};

