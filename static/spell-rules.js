// ---------------------------------------------------------------------------
// spell-rules.js — чистый учёт ячеек заклинаний: стоимость чтения, пулы
// ячеек (обычные и ячейки Договора), восстановление после отдыха.
// Даёт: window.SpellRules.
// Зависимости: нет. Загружается только в sheet.html; покрыт юнит-тестами.
// ---------------------------------------------------------------------------
// Pure spell-slot accounting shared by the character sheet and unit tests.
window.SpellRules = (() => {
  const numeric = n => Math.max(0, Math.floor(Number(n) || 0));
  const castCost = spell => Number(spell?.level) === 0 && spell?.cast_cost !== 'uses' ? 'free' : spell?.cast_cost || 'slot';
  const slotPool = (spells, spell, includePact = true) => {
    const minLevel = Math.max(1, numeric(spell?.level));
    const out = [];
    for (let level = minLevel; level <= 9; level++) {
      const slot = spells?.slots?.[level];
      if (slot && numeric(slot.max) > numeric(slot.used)) out.push({ pool: 'slots', level, remaining: numeric(slot.max) - numeric(slot.used) });
      const pact = spells?.pact_slots;
      if (includePact && pact && numeric(pact.level) === level && numeric(pact.max) > numeric(pact.used))
        out.push({ pool: 'pact_slots', level, remaining: numeric(pact.max) - numeric(pact.used) });
    }
    return out;
  };
  function spend(spells, spell, choice = {}) {
    const cost = castCost(spell);
    if (cost === 'uses') {
      const uses = spell?.uses, amount = Math.max(1, numeric(spell?.use_cost) || 1);
      if (!uses || numeric(uses.cur) < amount) return { ok: false, reason: 'Не хватает зарядов этого заклинания.' };
      uses.cur = numeric(uses.cur) - amount;
      return { ok: true, cost: 'uses', amount };
    }
    if (cost === 'free' || (Number(spell?.level) === 0 && cost !== 'uses')) return { ok: true, cost: 'free', level: 0 };
    const level = numeric(choice.level), pool = choice.pool === 'pact_slots' ? 'pact_slots' : 'slots';
    if (choice.ritual) {
      if (!spell?.ritual) return { ok: false, reason: 'Это заклинание не имеет свойства «Ритуал».' };
      return { ok: true, cost: 'ritual', level: Number(spell.level) || 0 };
    }
    if (level < Math.max(1, numeric(spell?.level)) || level > 9) return { ok: false, reason: 'Выбранная ячейка ниже уровня заклинания.' };
    const slot = pool === 'pact_slots' ? spells?.pact_slots : spells?.slots?.[level];
    if (!slot || (pool === 'pact_slots' && numeric(slot.level) !== level) || numeric(slot.max) <= numeric(slot.used))
      return { ok: false, reason: 'В выбранном пуле нет свободной ячейки.' };
    slot.used = numeric(slot.used) + 1;
    return { ok: true, cost: pool, level };
  }
  function spendHitDice(used = {}, counts = {}, die, amount) {
    const size = numeric(die), count = numeric(amount), available = Math.max(0, numeric(counts[size]) - numeric(used[size]));
    if (!size || !count || count > available) return { ok: false, reason: 'Недостаточно доступных костей хитов.' };
    const next = { ...used, [size]: numeric(used[size]) + count };
    return { ok: true, used: next, spent: count };
  }
  function recoverHitDice(used = {}, counts = {}) {
    const next = Object.fromEntries(Object.keys(counts).map(die => [die, Math.min(numeric(counts[die]), numeric(used[die]))]));
    const spent = Object.values(next).reduce((n, value) => n + numeric(value), 0);
    let recover = Math.min(spent, spent ? Math.max(1, Math.floor(Object.values(counts).reduce((n, value) => n + numeric(value), 0) / 2)) : 0);
    const amount = recover;
    for (const die of Object.keys(counts).map(Number).sort((a, b) => b - a)) {
      const back = Math.min(recover, numeric(next[die])); next[die] = numeric(next[die]) - back; recover -= back;
    }
    return { used: next, recovered: amount };
  }
  function restore(spells, features, kind) {
    let slots = 0, pactSlots = 0, featuresRestored = 0, spellUsesRestored = 0;
    if (kind === 'long') {
      for (const slot of Object.values(spells?.slots || {})) { slots += numeric(slot.used); slot.used = 0; }
      if (spells?.pact_slots) { pactSlots += numeric(spells.pact_slots.used); spells.pact_slots.used = 0; }
    } else if (kind === 'short' && spells?.pact_slots) {
      pactSlots = numeric(spells.pact_slots.used); spells.pact_slots.used = 0;
    }
    const recharges = kind === 'long' ? new Set(['short', 'long']) : new Set(['short']);
    for (const feature of features || []) if (feature?.uses && recharges.has(feature.uses.recharge)) {
      const before = numeric(feature.uses.cur), max = numeric(feature.uses.max);
      if (before !== max) featuresRestored++;
      feature.uses.cur = max;
    }
    for (const spell of spells?.known || []) if (spell?.uses && recharges.has(spell.uses.recharge)) {
      const before = numeric(spell.uses.cur), max = numeric(spell.uses.max);
      if (before !== max) spellUsesRestored++;
      spell.uses.cur = max;
    }
    return { slots, pactSlots, features: featuresRestored, spellUses: spellUsesRestored }; 
  }
  return { castCost, slotPool, spend, restore, spendHitDice, recoverHitDice };
})();
