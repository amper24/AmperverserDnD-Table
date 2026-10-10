// ---------------------------------------------------------------------------
// class-rules.js — правила классов, которые мастера читают по данным, а не по имени класса.
// Источники по порядку: блок data.caster записи (старый формат) → узел rule.class_rules в графе записи
// → набор class_rules (static/presets/, реестр Presets; запасной путь для старых снимков и баз).
// Русские названия берутся из наборов (поле ru): RU_NAMES заполняется, когда наборы загружены.
// Даёт: window.ClassRules.
// ---------------------------------------------------------------------------
window.ClassRules = (() => {
  // Русское название → slug. Объект один и тот же (на него ссылаются модули при загрузке), наполняется из наборов.
  const RU_NAMES = {};
  function fillNames() {
    for (const k of Object.keys(RU_NAMES)) delete RU_NAMES[k];
    for (const item of window.Presets?.items('class_rules') || []) if (item.table?.ru) RU_NAMES[item.table.ru] = item.id;
  }
  window.addEventListener?.('presets:changed', fillNames);
  fillNames();

  // Slug записи: name_en (латиница), иначе русское название по наборам.
  function slugOf(entry) {
    return String(entry?.data?.name_en || entry?.name_en || '').toLowerCase() || RU_NAMES[entry?.name] || '';
  }
  // Правила записи класса в редакции edition (по умолчанию — редакция записи): блок caster (старый формат),
  // узел rule.class_rules в графе записи, запас — набор по slug и редакции.
  function rulesOf(entry, edition) {
    const ed = String(edition || entry?.data?.edition || '2014');
    const legacy = entry?.data?.caster;
    if (legacy && typeof legacy === 'object') return { caster: legacy };
    const mechanics = entry?.data?.mechanics;
    const fromNode = mechanics && window.Mechanics?.classRules?.(mechanics, ed);
    if (fromNode && typeof fromNode === 'object') return fromNode;
    return window.Presets?.classRules(ed, slugOf(entry)) || {};
  }
  const casterOf = (entry, edition) => rulesOf(entry, edition).caster || {};
  // Значение может быть строкой (набор, узел) или объектом по редакции (старый блок caster).
  const byEdition = (value, edition) => (value && typeof value === 'object' ? value[String(edition || '2014')] : value) || '';
  return {
    RU_NAMES,
    refresh: fillNames,
    slugOf,
    rulesOf,
    casterOf,
    // 'full' | 'half' | '' — для мультикласса заклинателей.
    casterLevel: (entry, edition) => casterOf(entry, edition).level || '',
    // Список заклинаний выбирается при повышении уровня.
    isPicker: (entry, edition) => Boolean(casterOf(entry, edition).picker),
    // 'book' | 'prepared' | '' — режим заклинаний на 1 уровне в данной редакции.
    startMode: (entry, edition) => byEdition(casterOf(entry, edition).start, edition),
    // 'level' | 'half' | '' — формула числа подготовленных заклинаний в данной редакции.
    preparedFormula: (entry, edition) => byEdition(casterOf(entry, edition).prepared, edition),
  };
})();
