// ---------------------------------------------------------------------------
// spell-rules.js — учёт ячеек заклинаний и сборка действия сотворения: стоимость
// чтения, пулы ячеек (обычные и ячейки Договора), восстановление после отдыха,
// план расхода ячейки и сборка действия «Сотворить» из плана исполнения.
// Даёт: window.SpellRules.
// Зависимости: нет (обращается к window.Mechanics, если он загружен).
// Загружается только в sheet.html; покрыт юнит-тестами.
// ---------------------------------------------------------------------------
// Pure spell-slot accounting and casting rules shared by the character sheet and unit tests.
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

  // ---------- сотворение: кто списывает ячейку ----------
  /// Старое действие тратит ячейку само, если в нём остался блок «Расход: ячейка» (граф хранит круг).
  /// Новые записи такого блока не содержат: ячейку списывает лист, поэтому работают ячейки Договора,
  /// ритуал и выбранный круг, а двойного расхода не бывает.
  function programSlotLevel(program) {
    for (const b of program?.blocks || []) {
      if (!b || b.enabled === false || b.kind !== 'consume' || b.resource !== 'slot') continue;
      const level = numeric(b.slot_level);
      if (level >= 1 && level <= 9) return level;
    }
    return 0;
  }
  /// Действие с собственным расходом (ячейка, заряды, предмет) распоряжается им само.
  const programConsumes = program => (program?.blocks || []).some(b => b && b.enabled !== false && b.kind === 'consume');
  /// «Отдельный бросок» — кнопка без расхода: она только бросает кубики.
  const programRollOnly = program => program?.roll_only === true;
  /// Варианты расхода для окна сотворения: ячейки не ниже круга заклинания, ячейки Договора, ритуал.
  /// Действие со своим расходом берёт только свой круг — иначе выбранная ячейка и граф разойдутся.
  function spendOptions(spells, spell, program) {
    const fixed = programSlotLevel(program);
    let options;
    if (fixed) options = [{ pool: 'slots', level: fixed, remaining: Math.max(0, numeric(spells?.slots?.[fixed]?.max) - numeric(spells?.slots?.[fixed]?.used)) }];
    else if (programConsumes(program)) options = [];
    else options = slotPool(spells, spell);
    if (spell?.ritual) options.push({ pool: 'ritual', level: Math.max(0, numeric(spell?.level)), remaining: 0 });
    return options.filter(o => o.pool === 'ritual' || o.remaining > 0);
  }
  /// План сотворения: 'server' — расход считает само действие (старые записи с блоком расхода),
  /// 'client' — ячейку или заряды списывает лист, 'none' — заговор или отдельный бросок.
  function castPlan(spell, program, spells) {
    const cost = castCost(spell);
    if (programRollOnly(program)) return { cost, spend: 'none', level: 0, options: [] };
    if (cost === 'free') return { cost, spend: 'none', level: 0, options: [] };
    if (cost === 'uses') return { cost, spend: 'client', level: 0, options: [] };
    const level = programSlotLevel(program);
    if (level) return { cost, spend: 'server', level, options: spendOptions(spells, spell, program) };
    if (programConsumes(program)) return { cost, spend: 'server', level: 0, options: spendOptions(spells, spell, program) };
    return { cost, spend: 'client', level: 0, options: spendOptions(spells, spell) };
  }

  // ---------- сборка действия: «отдельные броски» сворачиваются в одно действие ----------
  // Заклинание бросает кубики само: атака и урон идут цепочкой «Сотворить», а спасбросок цели
  // кидает не игрок — он остаётся правилом для мастера. Тот же код собирает справочник в tools/srd.
  const GENERATED_ROLL = /^\s*(Отдельный бросок|Separate roll)/;
  const CAST_NAMES = /^\s*(Сотворить|Cast)\b/;
  const HEAL_NAME = /Лечение|Healing/i;
  const SERVICE_TEXTS = [/Справочная формула/, /Reference formula \(not an automatic effect\)/,
                         /^\s*Проверьте дистанцию/, /^\s*Check the range/, /^\s*Только отдельный бросок/, /^\s*A separate dice roll only/];
  /// Единый текст правила и коды характеристик живут в mechanics.js: там же их читают редакторы и справочник.
  const abilityCode = (value, lang) => window.Mechanics?.abilityCode ? window.Mechanics.abilityCode(value, lang) : String(value ?? '').trim();
  const saveRule = (ability, effects, lang) => window.Mechanics?.saveRule?.(ability, effects, lang) || '';
  const isSaveRule = text => window.Mechanics?.isSaveRule ? window.Mechanics.isSaveRule(text) : /бросает цель или ДМ|the target or the GM rolls it/.test(String(text || ''));
  const LABELS = {
    ru: { attack: 'Атака заклинанием', damage: 'Урон', heal: 'Лечение' },
    en: { attack: 'Spell attack', damage: 'Damage', heal: 'Healing' },
  };
  /// Разбор и печать формулы кубиков в том же виде, что Mechanics.dice и серверная formula().
  function dice(text) {
    const src = String(text ?? '0').trim().replace(/\s/g, '').replace(/к/g, 'd');
    const m = src.match(/^(?:(\d*)d(\d+))?([+-]?\d+)?(?:\+@([a-z_]+))?$/i);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return { count: 0, sides: 6, bonus: 0, stat: '', advanced: src };
    return { count: m[2] ? Number(m[1] || 1) : 0, sides: Number(m[2] || 6), bonus: Number(m[3] || 0), stat: m[4] || '' };
  }
  function expression(d) {
    if (!d) return '';
    if (d.advanced) return String(d.advanced);
    return (d.count ? `${d.count}d${d.sides}` : '0') + (Number(d.bonus) >= 0 ? '+' : '') + (Number(d.bonus) || 0) + (d.stat ? '+@' + d.stat : '');
  }
  const block = (kind, extra) => ({ kind, enabled: true, when: 'always', ...extra });
  const serviceManual = text => SERVICE_TEXTS.some(re => re.test(String(text || ''))) || isSaveRule(text);
  /// Первый блок записи — её описание: он повторяет карточку и держит окно подтверждения на каждом сотворении.
  const descManual = (text, meta) => {
    const value = String(text || '').replace(/\s+/g, ' ').trim(), desc = String(meta.desc || '').replace(/\s+/g, ' ').trim();
    return desc.length >= 60 && value.startsWith(desc.slice(0, 60));
  };
  /// Метка эффекта из имени старого действия записи: «Спасбросок: Страх» / «Saving throw: Fear».
  const actionLabel = name => { const match = String(name || '').match(/^[^:]+:\s*(.+)$/); return match ? match[1].trim() : ''; };
  const plainD20 = d => !!d && !d.advanced && Number(d.sides) === 20 && Number(d.count || 1) === 1 && !d.stat && !Number(d.bonus);
  const CANONICAL = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  /// Свернуть программы заклинания в одно действие «Сотворить». Чистая функция над блоками плана:
  /// атака, урон и лечение встают в цепочку действия, спасбросок становится правилом для мастера
  /// («бросает цель или ДМ, а не игрок»), расход ячейки уезжает на лист, а кнопки «Отдельный бросок»
  /// исчезают. Записи, у которых менять нечего, возвращаются как есть (changed: false).
  /// meta: level, desc, actions (справочные броски записи), saveAbility, lang.
  function spellPrograms(programs, meta = {}) {
    const lang = meta.lang === 'en' ? 'en' : 'ru', labels = LABELS[lang];
    const castName = { ru: 'Сотворить', en: 'Cast' }[lang];
    const list = (Array.isArray(programs) ? programs : []).filter(p => p && typeof p === 'object');
    const generated = list.filter(p => GENERATED_ROLL.test(String(p.name || '')));
    const cast = list.find(p => !p.roll_only && CAST_NAMES.test(String(p.name || ''))) || list.find(p => !generated.includes(p))
      || { id: 'use', name: castName, trigger: 'use', blocks: [] };
    const consume = [], others = [], manuals = [], rolls = [], damages = [], saves = [];
    let attack = null;
    const sameRoll = (a, b) => expression(a) === expression(b);
    const primary = abilityCode(meta.saveAbility, lang);
    // Эффекты со своим кодом в имени («Спасбросок: Страх») не повторяются и не переезжают в чужую
    // характеристику: сначала читаются действия записи (там есть подсказка с характеристикой),
    // затем — имена программ плана.
    const SAVE_ONLY_NAME = /^(Спасбросок|Saving throw|Бросок|Roll)$/i;
    const addSave = (ability, effect) => {
      const code = abilityCode(ability, lang) || primary;
      const label = String(effect || '').split(':')[0].trim();
      if (SAVE_ONLY_NAME.test(label)) return;
      if (label && saves.some(s => s.effects.includes(label))) return;
      const found = saves.find(s => s.ability === code);
      if (found) { if (label && !found.effects.includes(label)) found.effects.push(label); return; }
      saves.push({ ability: code, effects: label ? [label] : [] });
    };
    const addAttack = entry => { if (attack) return; attack = { dice: entry.dice || dice('1d20+@spell'), name: entry.name || labels.attack }; };
    const addDamage = entry => {
      if (damages.some(d => sameRoll(d.dice, entry.dice) && (d.dtype || '') === (entry.dtype || ''))) return;
      damages.push(entry);
    };
    const addRoll = entry => {
      if (rolls.some(r => sameRoll(r.dice, entry.dice) && String(r.name || '') === String(entry.name || ''))) return;
      rolls.push(entry);
    };
    const spellAttackD20 = d => !!d && !d.advanced && Number(d.sides) === 20 && ['spell', 'atk', 'atk_str', 'atk_dex', 'best', 'prof'].includes(String(d.stat || ''));
    const readBlock = (b, program) => {
      if (!b || typeof b !== 'object') return;
      // «Расход: ячейка» убирается из плана: ячейку списывает лист — круг, ячейки Договора и
      // ритуал выбирает игрок. Прочие расходы (заряды, предмет) остаются у записи.
      if (b.kind === 'consume') { if (b.resource === 'slot') return; consume.push({ ...b, when: 'always' }); return; }
      if (b.kind === 'attack') { addAttack({ dice: b.dice, name: b.name }); return; }
      if (b.kind === 'damage') { addDamage({ dice: b.dice, dtype: b.damage_type || '', name: b.name || labels.damage }); return; }
      if (b.kind === 'heal') { addRoll({ dice: b.dice, name: b.name || labels.heal }); return; }
      if (b.kind === 'roll') {
        // Голый d20 из кнопки «Отдельный бросок: Спасбросок» — чужой бросок: игрок его не кидает.
        if (plainD20(b.dice) && program !== cast) return;
        if (spellAttackD20(b.dice)) { addAttack({ dice: b.dice, name: b.name }); return; }
        addRoll({ dice: b.dice, name: b.name || (HEAL_NAME.test(String(b.name || '')) ? labels.heal : '') });
        return;
      }
      if (b.kind === 'manual') {
        const text = String(b.text || '');
        if (serviceManual(text) || descManual(text, meta)) return;
        if (manuals.some(m => String(m.text) === text)) return;
        manuals.push({ ...b, when: 'always' });
        return;
      }
      others.push({ ...b, when: 'always' });
    };
    // Читаются только блоки сотворения и кнопок «Отдельный бросок»: собственные действия записи
    // («Урон» отдельным умением — отложенный или альтернативный) остаются отдельными кнопками.
    for (const program of [cast, ...list.filter(p => p !== cast && generated.includes(p))]) for (const b of program.blocks || []) readBlock(b, program);
    // Действия записи уточняют характеристику и перечень эффектов каждого спасброска.
    for (const a of meta.actions || []) {
      if (!a || typeof a !== 'object') continue;
      const formula = String(a.roll || '');
      if (a.kind === 'save') { addSave(a.ability || String(a.note || '').split(' ').pop(), actionLabel(a.name)); continue; }
      if (a.kind === 'attack' && formula) { addAttack({ dice: dice(formula), name: labels.attack }); continue; }
      if (a.kind === 'damage' && formula) { addDamage({ dice: dice(formula), dtype: a.dtype || '', name: labels.damage }); continue; }
      if (a.kind === 'heal' && formula) { addRoll({ dice: dice(formula.replace(/@spell\b/g, '@spell_mod')), name: labels.heal }); continue; }
    }
    // Правило спасброска встаёт перед бросками: мастеру нужно знать, кто его кидает.
    if (!saves.length && primary) addSave(primary, '');
    const order = saves.slice().sort((a, b) => (a.ability === primary ? -1 : b.ability === primary ? 1 : 0));
    const blocks = [...consume];
    for (const s of order) blocks.push(block('manual', { text: saveRule(s.ability, s.effects, lang) }));
    if (attack) blocks.push(block('attack', { dice: attack.dice, name: attack.name }));
    const gated = Boolean(attack);
    for (const d of damages) blocks.push(block('damage', { dice: d.dice, damage_type: d.dtype || '', name: d.name || labels.damage, ...(gated ? { when: 'hit' } : {}) }));
    for (const r of rolls) blocks.push(block('roll', { dice: r.dice, name: r.name || '' }));
    blocks.push(...others, ...manuals);
    // Запись без бросков и без правил сохраняет свои блоки: пустое действие ничего не объясняет.
    const kept = (cast.blocks || []).filter(b => b && b.kind !== 'consume' && !serviceManual(b.text));
    const finalBlocks = blocks.length > consume.length ? blocks : [...consume, ...kept];
    const merged = { ...cast, blocks: finalBlocks.map((b, i) => ({ ...b, id: 'b' + (i + 1) })) };
    // Чужие действия записи («Урон» отдельным умением) остаются кнопками, но без расхода ячейки:
    // ячейку тратит сотворение, а повторный бросок того же заклинания — нет.
    const extras = list.filter(p => p !== cast && !generated.includes(p)).map(p => p.roll_only ? p : { ...p, roll_only: true });
    const out = [merged, ...extras];
    return { programs: out, changed: CANONICAL(out) !== CANONICAL(list) };
  }
  return { castCost, slotPool, spend, restore, spendHitDice, recoverHitDice,
           programSlotLevel, programConsumes, programRollOnly, spendOptions, castPlan,
           serviceManual, spellPrograms, expression, dice };
})();
