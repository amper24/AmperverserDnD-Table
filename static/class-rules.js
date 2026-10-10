// ---------------------------------------------------------------------------
// class-rules.js — правила классов, которые мастера читают по данным, а не по имени класса.
// Для записи класса берётся блок data.caster (тип заклинателя, выбор списка, режим и формула подготовки
// по редакции). Если блока нет, работает встроенная таблица SRD — запасной вариант до переноса в данные.
// Русские названия классов — единственная таблица здесь; остальные модули берут slug отсюда.
// Даёт: window.ClassRules.
// ---------------------------------------------------------------------------
window.ClassRules = (() => {
  // Русское название → slug (SRD). Не используется, если у записи есть name_en.
  const RU_NAMES = { 'Варвар': 'barbarian', 'Бард': 'bard', 'Жрец': 'cleric', 'Друид': 'druid', 'Воин': 'fighter', 'Монах': 'monk', 'Паладин': 'paladin',
    'Следопыт': 'ranger', 'Плут': 'rogue', 'Чародей': 'sorcerer', 'Колдун': 'warlock', 'Волшебник': 'wizard' };
  // Запасная таблица SRD. Ключи: level — полный/половинный заклинатель для мультикласса; picker — список выбирается при повышении;
  // start — режим заклинаний на 1 уровне по редакции; prepared — формула подготовки (level: уровень + мод.; half: половина уровня + мод.).
  const SRD_CASTER = {
    bard: { level: 'full', picker: true },
    cleric: { level: 'full', start: { '2014': 'prepared', '2024': 'prepared' }, prepared: { '2014': 'level' } },
    druid: { level: 'full', start: { '2014': 'prepared', '2024': 'prepared' }, prepared: { '2014': 'level' } },
    sorcerer: { level: 'full', picker: true },
    wizard: { level: 'full', start: { '2014': 'book', '2024': 'book' }, prepared: { '2014': 'level' } },
    paladin: { level: 'half', start: { '2024': 'prepared' }, prepared: { '2014': 'half' } },
    ranger: { level: 'half', picker: true, start: { '2024': 'prepared' } },
    warlock: { picker: true },
  };
  // Slug записи: name_en (латиница), иначе русское название.
  function slugOf(entry) {
    return String(entry?.data?.name_en || entry?.name_en || '').toLowerCase() || RU_NAMES[entry?.name] || '';
  }
  // Блок caster записи, а если его нет — запасная таблица SRD по slug.
  function casterOf(entry) {
    const data = entry?.data?.caster;
    if (data && typeof data === 'object') return data;
    return SRD_CASTER[slugOf(entry)] || {};
  }
  return {
    RU_NAMES,
    slugOf,
    casterOf,
    // 'full' | 'half' | '' — для мультикласса заклинателей.
    casterLevel: entry => casterOf(entry).level || '',
    // Список заклинаний выбирается при повышении уровня.
    isPicker: entry => Boolean(casterOf(entry).picker),
    // 'book' | 'prepared' | '' — режим заклинаний на 1 уровне в данной редакции.
    startMode: (entry, edition) => casterOf(entry).start?.[String(edition)] || '',
    // 'level' | 'half' | '' — формула числа подготовленных заклинаний в данной редакции.
    preparedFormula: (entry, edition) => casterOf(entry).prepared?.[String(edition)] || '',
  };
})();
