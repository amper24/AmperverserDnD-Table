// ---------------------------------------------------------------------------
// equipment.js — правила инвентаря: слоты (руки/надето), экипировка, стопки,
// нормализация предметов. Зеркалит серверные правила из src/inventory.rs.
// Даёт: window.Equipment.
// Зависимости: common.js. Загружается в обеих страницах (слой 2).
// ---------------------------------------------------------------------------
// Inventory rules shared by the sheet, item templates and editors. Server enforces mutations.
window.Equipment = (() => {
  // Слоты рук и одежды. Эти ключи зеркалят src/inventory.rs; сервер повторно проверяет операции.
  const slots = {
    main: 'Основная рука', off: 'Вторая рука', both: 'Обе руки', armor: 'Доспех', head: 'Голова',
    neck: 'Шея', cloak: 'Плащ', gloves: 'Перчатки', belt: 'Пояс', feet: 'Обувь', ring1: 'Кольцо 1', ring2: 'Кольцо 2',
  };
  const kinds = { none: 'Не в руках', one: 'Одноручный', two: 'Двуручный', versatile: 'Универсальный: 1 или 2 руки' };
  const wearKinds = {
    '': 'Нельзя экипировать', armor: 'Доспех (тело)', head: 'Голова', neck: 'Шея', cloak: 'Плащ',
    gloves: 'Перчатки', belt: 'Пояс', feet: 'Обувь', ring: 'Кольцо',
  };
  const WORN_SLOTS = ['armor', 'head', 'neck', 'cloak', 'gloves', 'belt', 'feet', 'ring'];
  const SLOTS_V = 2;
  const wornSlots = kind => ({ armor: ['armor'], head: ['head'], neck: ['neck'], cloak: ['cloak'], gloves: ['gloves'], belt: ['belt'], feet: ['feet'], ring: ['ring1', 'ring2'] }[kind] || []);
  const B = '(?:^|[^а-яё])';
  const NOT_EQUIPPABLE = new RegExp(`зель|свиток|свитки|боеприпас|potion|scroll|ammunition|палочк|\\bwands?\\b|конск|horse|barding|упряж|седл|saddle|кошел|pouch|посох|\\bstaff|жезл|\\brods?\\b|${B}щит|\\bshield\\b`);
  const ARMOR_PATTERN = new RegExp(`доспех|\\barmor\\b|кольчуг|кирас|${B}латы|breastplate|chain mail|half plate|splint|studded leather|scale mail|ring mail`);
  const SHIELD = new RegExp(`${B}щит|\\bshield\\b`, 'i');
  const JEWELRY = /брошь|brooch|амулет|amulet|ожерель|necklace|кольц|\bring\b/i;
  const HAND_MAGIC = /оружие|weapon|посох|\bstaff|жезл|\brods?\b|палочк|\bwands?\b/i;
  const itemWords = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const itemText = it => [it.name || '', ...itemWords(it.tags), ...itemWords(it.properties)].join(' ').toLowerCase();
  const WEAR_RULES = [
    ['ring', /кольц|\brings?\b/i],
    ['neck', /амулет|ожерель|медальон|талисман|подвеск|ладанк|брошь|бусы|amulet|necklace|periapt|medallion|pendant|brooch|talisman|scarab|beads/i],
    ['head', /шлем|шляп|колпак|корон|диадем|обруч|(?:^|[^а-яё])маск|(?:^|[^а-яё])очки|(?:^|[^а-яё])глаза|линзы|капюшон|\bhelm|\bhat\b|crown|circlet|headband|goggles|\bmask|lenses|\beyes of|\bhood|\bcap\b/i],
    ['cloak', /плащ|накидк|мантия|одеян|(?:^|[^а-яё])роба(?:$|[^а-яё])|cloak|\bcape\b|mantle|\brobe/i],
    ['gloves', /перчатк|рукавиц|наручи|браслет|gauntlet|glove|bracer|bracelet/i],
    ['belt', /пояс|\bbelt\b/i],
    ['feet', /сапог|ботин|башмак|туфл|sandal|\bboots?\b|slippers?/i],
    ['armor', ARMOR_PATTERN],
  ];
  // Что носят, если хват не задан: сверяемся с категорией и русскими/английскими названиями.
  function inferWear(it) {
    if (it.type === 'armor') return 'armor';
    if (!['magic', 'gear', 'treasure'].includes(it.type)) return '';
    const text = itemText(it);
    if (NOT_EQUIPPABLE.test(text) && !JEWELRY.test(text)) return '';
    return WEAR_RULES.find(([, pattern]) => pattern.test(text))?.[0] || '';
  }
  // Хват по умолчанию: оружие, щиты, магические палочки/посохи/жезлы/оружие.
  // Фокусировки и инструменты держат в руке: священный символ (не амулет), магическая и
  // друидическая фокусировка, музыкальный инструмент. Амулет или подвеска — на шее, не в руке.
  const FOCUS = /фокусиров|focus|священн[а-яё]* символ|holy symbol|инструмент|instrument|лютн|флейт|рожок|барабан|арфа|дудочк/i;
  const AMULET_FOCUS = /амулет|amulet|подвеск|ожерель/;
  function inferHands(it) {
    const text = itemText(it);
    const consumable = ['зель', 'свиток', 'боеприпас', 'potion', 'scroll', 'ammunition'].some(w => text.includes(w));
    const magicHand = it.type === 'magic' && !consumable && HAND_MAGIC.test(text);
    const focusHand = it.type === 'gear' && !consumable && FOCUS.test(text) && !AMULET_FOCUS.test(text);
    if (!(it.type === 'weapon' || (SHIELD.test(text) && !JEWELRY.test(text)) || magicHand || focusHand)) return 'none';
    return /двуруч|two-handed/.test(text) ? 'two' : /универсаль|versatile/.test(text) ? 'versatile' : 'one';
  }
  const handednessOf = it => ['none', 'one', 'two', 'versatile'].includes(it.handedness) ? it.handedness : inferHands(it);
  function wearKind(it) {
    if (handednessOf(it) !== 'none') return '';
    if (it.slots_v === SLOTS_V && typeof it.wear === 'string' && (it.wear === '' || wearKinds[it.wear] !== undefined)) return it.wear;
    return inferWear(it);
  }
  const choices = it => handednessOf(it) === 'two' ? ['both'] : handednessOf(it) === 'versatile' ? ['main', 'off', 'both'] : handednessOf(it) === 'one' ? ['main', 'off'] : wornSlots(wearKind(it));
  const canEquip = it => choices(it).length > 0;
  function normalize(it) {
    it.qty ??= 1;
    if (it.type === 'ammo' && !it.ammo_tag && /футляр|колчан|case|quiver/i.test(it.name || '')) it.type = 'gear';
    const text = [it.name, it.desc, ...(it.properties || [])].join(' ').toLowerCase();
    // предметы старой схемы: «без рук» могло означать «не задано» — хват и место ношения выводим заново
    if (it.slots_v !== SLOTS_V && it.handedness === 'none') delete it.handedness;
    it.handedness = handednessOf(it); it.wear = wearKind(it); it.slots_v = SLOTS_V; it.favorite = it.favorite === true;
    // Настройка (attunement) есть только у предметов, которые её требуют: иначе флажок — мусор из старых данных.
    if (it.attuned && it.attunement !== true) it.attuned = false;
    if (it.type === 'ammo' && !it.ammo_tag) it.ammo_tag = /болт|bolt/.test(text) ? 'bolt' : /стрел|arrow/.test(text) ? 'arrow' : /пул|bullet/.test(text) ? 'bullet' : '';
    if (it.consume === undefined) {
      if (it.type === 'consumable') it.consume = { enabled: true, resource: 'quantity', target_uid: 'self', amount: 1, trigger: 'use' };
      else if (it.type === 'weapon' && /боеприпас|ammunition|арбалет|crossbow|лук|bow|пращ|sling/.test(text)) {
        it.consume = { enabled: true, resource: 'quantity', target_uid: '', ammo_tag: /арбалет|crossbow/.test(text) ? 'bolt' : /пращ|sling/.test(text) ? 'bullet' : 'arrow', amount: 1, trigger: 'attack' };
      } else it.consume = { enabled: false, resource: 'quantity', target_uid: 'self', amount: 1, trigger: 'use' };
    }
    // Legacy versatile actions used two independent damage buttons; now they are exclusive variants.
    if (it.handedness === 'versatile' && (it.actions || []).some(a => /двумя руками|two.hand/i.test(a.name || ''))) {
      it.actions.forEach(a => { if (a.kind === 'damage' && !a.grip) a.grip = /двумя руками|two.hand/i.test(a.name || '') ? 'two' : 'one'; });
    }
    if (it.qty !== 1) it.equipped = false;
    if (!it.equipped) { it.hand_slot = null; it.worn_slot = null; }
    return it;
  }
  // Раскладка стартового набора: доспех на тело, щит во вторую руку, одноручное оружие — в основную.
  // Двуручное оружие берётся в обе руки только если щита нет: иначе персонаж остаётся со щитом,
  // а оружие ждёт в рюкзаке. Слоты проверяет migrate(): стопки и конфликты не создают дублей.
  function equipDefaults(inventory, options = {}) {
    const canHands = options.hands !== false, canWear = options.wear !== false;
    const free = it => (it.qty ?? 1) === 1 && !it.equipped;
    const shieldOf = it => handednessOf(it) !== 'none' && SHIELD.test(itemText(it)) && !JEWELRY.test(itemText(it));
    const oneHanded = it => ['one', 'versatile'].includes(handednessOf(it));
    const hold = (it, slot) => { it.equipped = true; it.hand_slot = slot; it.worn_slot = null; };
    const held = slot => inventory.some(it => it.equipped && (it.hand_slot === slot || it.hand_slot === 'both'));
    if (canWear) for (const it of inventory) if (free(it) && handednessOf(it) === 'none' && wearKind(it) === 'armor') { it.equipped = true; it.worn_slot = 'armor'; break; }
    if (canHands) {
      for (const it of inventory) if (free(it) && shieldOf(it) && !held('off') && !held('both')) { hold(it, 'off'); break; }
      for (const it of inventory) if (free(it) && handednessOf(it) !== 'none' && !shieldOf(it) && oneHanded(it) && !held('main')) { hold(it, 'main'); break; }
      if (!held('main') && !held('off')) for (const it of inventory) if (free(it) && handednessOf(it) === 'two' && !shieldOf(it)) { hold(it, 'both'); break; }
      if (!held('main')) for (const it of inventory) if (free(it) && handednessOf(it) !== 'none' && !shieldOf(it)) { hold(it, 'main'); break; }
    }
    return migrate(inventory);
  }
  function migrate(inventory) {
    const occupied = new Set(), worn = new Set();
    inventory.forEach(it => {
      normalize(it);
      if (!it.equipped) return;
      if (it.handedness !== 'none') {
        it.worn_slot = null;
        const slot = it.hand_slot || (it.handedness === 'two' ? 'both' : occupied.has('main') ? 'off' : 'main');
        const used = slot === 'both' ? ['main', 'off'] : [slot];
        if (it.qty !== 1 || used.some(s => occupied.has(s)) || !choices(it).includes(slot)) { it.equipped = false; it.hand_slot = null; }
        else { it.hand_slot = slot; used.forEach(s => occupied.add(s)); }
      } else if (it.wear) {
        it.hand_slot = null;
        const allowed = wornSlots(it.wear);
        const slot = allowed.includes(it.worn_slot) && !worn.has(it.worn_slot) ? it.worn_slot : allowed.find(s => !worn.has(s));
        if (it.qty !== 1 || !slot) { it.equipped = false; it.worn_slot = null; }
        else { it.worn_slot = slot; worn.add(slot); }
      } else { it.equipped = false; it.hand_slot = null; it.worn_slot = null; }
    });
    // Правило настройки: не больше трёх предметов одновременно (PHB/DMG), лишние «отпускаются».
    let attuned = 0;
    for (const it of inventory) {
      if (!it.attuned) continue;
      if (it.attunement === true && attuned < 3) attuned++;
      else it.attuned = false;
    }
    return inventory;
  }
  // КД: основа — надетый доспех по его формуле (иначе 10 + Лов), щит в руке добавляет свой бонус, прочие надетые предметы с «+N» суммируются.
  // Поддержка blocks для кастомизации формулы КД доспеха.
  function armorClassParts(sheet) {
    const dex = Math.floor(((sheet.abilities?.dex ?? 10) - 10) / 2); let base = 10 + dex, baseName = 'Без доспеха', shield = 0, shieldName = '', armored = false;
    const bonuses = [], notes = []; let speedPenalty = 0, stealth = false;
    const str = sheet.abilities?.str ?? 10;
    
    // Сначала проверяем blocks у надетого доспеха
    const armorItem = sheet.inventory?.find(it => it.equipped && it.worn_slot === 'armor' && it.qty === 1);
    if (armorItem?.mechanics?.programs) {
      for (const prog of armorItem.mechanics.programs) {
        if (prog.trigger !== 'passive') continue;
        for (const block of prog.blocks || []) {
          if (block.kind !== 'adjust' || block.field !== 'armor' || block.enabled === false) continue;
          // Блок может задавать формулу КД напрямую
          if (block.value) {
            try {
              // Пробуем вычислить формулу типа "10 + dex + con"
              const armorValue = evaluateArmorFormula(block.value, sheet);
              if (armorValue !== null) {
                base = armorValue;
                baseName = armorItem.name || 'Доспех';
                armored = true;
                // Проверяем требования к силе
                if (armorItem.str_req && str < Number(armorItem.str_req)) {
                  speedPenalty = 10; notes.push(`${baseName}: нужна Сила ${armorItem.str_req} — скорость −10 фт`);
                }
                if (armorItem.stealth_disadvantage) {
                  stealth = true; notes.push(`${baseName}: помеха на проверки Скрытности`);
                }
              }
            } catch (e) { /* ignore */ }
          }
        }
      }
    }
    
    // Если blocks не задали КД, используем старую логику
    if (!armored) {
      for (const it of sheet.inventory || []) {
        if (!it.equipped || it.qty === 0) continue;
        // предмет с настройкой без настройки бонусов не даёт
        if (it.attunement && !it.attuned) { if (/\d/.test(String(it.ac ?? ''))) notes.push(`${it.name || 'Предмет'}: не настроен — бонус к КД не действует`); continue; }
        const text = String(it.ac ?? '').toLowerCase(), match = text.match(/\d+/); if (!match) continue;
        const n = Number(match[0]), bonus = text.trimStart().startsWith('+'), name = it.name || 'Предмет';
        if (handednessOf(it) !== 'none') {
          if (it.type === 'armor' && n > shield) { shield = n; shieldName = name; }
        } else if (wearKind(it) === 'armor') {
          if (!bonus && !armored) {
            if (it.str_req && str < Number(it.str_req)) { speedPenalty = 10; notes.push(`${name}: нужна Сила ${it.str_req} — скорость −10 фт`); }
            if (it.stealth_disadvantage) { stealth = true; notes.push(`${name}: помеха на проверки Скрытности`); }
            base = n + (/лов|dex/.test(text) ? /макс|max/.test(text) ? Math.min(dex, 2) : dex : 0); baseName = name; armored = true; }
        } else if (bonus) {
          bonuses.push([name, n]);
        }
      }
    }
    
    // Class feature: apply Unarmored Defense only while its armor/shield conditions are met.
    if (!armored && sheet.unarmored_defense === 'barbarian') {
      base = 10 + dex + Math.floor(((sheet.abilities?.con ?? 10) - 10) / 2);
      baseName = 'Защита без доспехов (варвар)';
    } else if (!armored && !shield && sheet.unarmored_defense === 'monk') {
      base = 10 + dex + Math.floor(((sheet.abilities?.wis ?? 10) - 10) / 2);
      baseName = 'Защита без доспехов (монах)';
    }
    const parts = [[baseName, base]]; if (shield > 0) parts.push([shieldName, shield]); parts.push(...bonuses);
    return { ac: base + shield + bonuses.reduce((a, b) => a + b[1], 0), parts, notes, speedPenalty, stealth };
  }
  
  // Вычисление формулы КД доспеха (например: "10 + dex + con", "14 + dex max 2")
  function evaluateArmorFormula(formula, sheet) {
    const dex = Math.floor(((sheet.abilities?.dex ?? 10) - 10) / 2);
    const con = Math.floor(((sheet.abilities?.con ?? 10) - 10) / 2);
    const wis = Math.floor(((sheet.abilities?.wis ?? 10) - 10) / 2);
    const str = sheet.abilities?.str ?? 10;
    
    const normalized = String(formula).toLowerCase().replace(/\s+/g, '');
    
    // Простые формулы: 10+dex, 12+dexmax2, 14+dex, и т.д.
    const match = normalized.match(/^(\d+)(?:\+([a-z]+)(?:max(\d+))?)?$/);
    if (match) {
      const base = Number(match[1]);
      const stat = match[2];
      const maxVal = match[3] ? Number(match[3]) : null;
      
      let statVal = 0;
      if (stat === 'dex') statVal = dex;
      else if (stat === 'con') statVal = con;
      else if (stat === 'wis') statVal = wis;
      
      if (maxVal !== null) statVal = Math.min(statVal, maxVal);
      return base + statVal;
    }
    
    return null;
  }
  const armorClass = sheet => armorClassParts(sheet).ac;
  const activeActions = it => (it.actions || []).map((a, index) => ({ ...a, index })).filter(a => !a.grip || (a.grip === 'two' ? it.hand_slot === 'both' : it.hand_slot !== 'both'));
  function resourceStatus(it, inventory) {
    if(it.mechanics){
      const costs=it.mechanics.programs.flatMap(p=>p.trigger==='use'?p.blocks.filter(b=>b.kind==='consume'&&b.enabled!==false):[]);
      if(!costs.length)return {text:'Авторасход выключен',available:Infinity};
      const reports=costs.map(b=>['slot','uses'].includes(b.resource)?{text:`${b.resource==='slot'?'Ячейка':'Использования'}: −${b.amount}`,available:Infinity}:resourceStatus({...it,mechanics:null,consume:{enabled:true,resource:b.resource,target_uid:b.source==='self'?'self':b.source==='item'?b.item_uid:'',ammo_tag:b.tag,amount:b.amount,trigger:b.trigger}},inventory));
      return {text:reports.map(r=>r.text).join(' / '),available:Math.min(...reports.map(r=>r.available))};
    }
    const c = it.consume;
    if (!c?.enabled) return { text: 'Авторасход выключен', available: Infinity };
    const targets = inventory.filter(x => c.target_uid === 'self' ? x.uid === it.uid : c.target_uid ? x.uid === c.target_uid : c.ammo_tag && (x.ammo_tag === c.ammo_tag || x.tags?.includes(c.ammo_tag)));
    const available = targets.reduce((sum, x) => sum + (x.qty === 0 ? 0 : c.resource === 'charges' ? x.charges?.cur || 0 : x.qty ?? 1), 0);
    const amount = c.amount || 1;
    return { available, text: `${c.resource === 'charges' ? 'Заряды' : targets.map(x => x.name).filter((v,i,a)=>a.indexOf(v)===i).join(', ') || 'Источник не выбран'}: ${available} · −${amount} ${c.trigger === 'attack' ? 'за атаку' : 'за использование'}` };
  }
  function editor(it, inventory) {
    normalize(it);
    const c = it.consume, field = (label, control) => el('label', { class: 'field' }, label, control);
    const select = (pairs, value, fn) => el('select', { onchange: e => fn(e.target.value) }, ...pairs.map(([v,n]) => el('option', { value: v, selected: value === v ? '' : null }, n)));
    const sourceOptions = [['self', 'Сам предмет'], ['', 'Авто: по метке боеприпаса'], ...(inventory || []).filter(x => x.uid !== it.uid).map(x => [x.uid, `${x.name} · ${x.qty ?? 1} шт.`])];
    if (c.target_uid && !sourceOptions.some(([id]) => id === c.target_uid)) sourceOptions.push([c.target_uid, 'Недоступный источник — выберите другой']);
    return el('section', { class: 'equipment-editor' }, el('h3', {}, 'Экипировка и связи'),
      el('div', { class: 'row' }, field('Хват', select(Object.entries(kinds), it.handedness, v => { it.handedness = v; it.equipped = false; it.hand_slot = null; it.worn_slot = null; if (v !== 'none') it.wear = ''; })),
        field('Носится на', select(Object.entries(wearKinds), it.handedness === 'none' ? it.wear : '', v => { it.wear = v; it.equipped = false; it.worn_slot = null; if (v) it.handedness = 'none'; })),
        field('Метка боеприпаса этого предмета', el('input', { value: it.ammo_tag || '', placeholder: 'arrow / bolt / bullet / своя', oninput: e => it.ammo_tag = e.target.value.trim() }))),
      field('КД доспеха / бонус щита', el('input', { value: it.ac ?? '', placeholder: '16 / 12 + Лов (макс 2) / +2', oninput: e => it.ac = e.target.value })),
      el('div', { class: 'row' },
        field('Требуемая Сила доспеха', el('input', { type: 'number', min: 0, max: 30, value: it.str_req ?? '', placeholder: 'нет', oninput: e => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n) && n > 0) it.str_req = n; else delete it.str_req; } })),
        field('Скрытность', el('span', { class: 'row', style: 'align-items:center;gap:6px' }, el('input', { type: 'checkbox', style: 'width:auto', checked: it.stealth_disadvantage ? '' : null, onchange: e => { if (e.target.checked) it.stealth_disadvantage = true; else delete it.stealth_disadvantage; } }), 'помеха'))),
      el('p', {class:'muted small'}, 'Расход количества, боеприпасов и зарядов задаётся блоком «Расход ресурса» ниже.'));
  }
  // Слоты по правилам: что где надето и какие правила D&D соблюдены или нарушены.
  function slotsAudit(sheet) {
    const all = (sheet.inventory || []).filter(it => it && it.equipped && (it.qty ?? 1) === 1);
    const bySlot = {};
    for (const it of all) { const slot = it.hand_slot || it.worn_slot; if (slot) (bySlot[slot] ||= []).push(it); }
    const rows = ['main', 'off', 'both', 'armor', 'head', 'neck', 'cloak', 'gloves', 'belt', 'feet', 'ring1', 'ring2']
      .map(key => ({ key, label: slots[key], items: bySlot[key] || [] }));
    const shields = all.filter(it => handednessOf(it) !== 'none' && SHIELD.test(itemText(it)) && !JEWELRY.test(itemText(it)));
    const armor = all.filter(it => it.worn_slot === 'armor' && wearKind(it) === 'armor');
    const twoHanded = bySlot.both || [];
    const rings = all.filter(it => ['ring1', 'ring2'].includes(it.worn_slot));
    const attunedItems = (sheet.inventory || []).filter(it => it.attuned);
    const check = (ok, text, detail) => ({ ok: !!ok, text, detail: ok ? '' : detail });
    const checks = [
      check(armor.length <= 1, 'Один доспех одновременно', 'надето больше одного доспеха — лишний снимите'),
      check(shields.length <= 1, 'Не больше одного щита', 'щит считается только один — второй не даёт бонуса'),
      check(!twoHanded.length || !(bySlot.off || []).length, 'Двуручное оружие занимает обе руки', 'вторая рука занята — двуручный хват невозможен'),
      check(rings.length <= 2, 'Кольца — по одному на руку', 'надето больше двух колец'),
      check(!attunedItems.length || attunedItems.every(it => it.attunement === true), 'Настраиваются только предметы с настройкой', 'есть настроенный предмет без требования настройки'),
      check(attunedItems.filter(it => it.attunement === true).length <= 3, 'Настройка — не больше трёх предметов', 'настроено больше трёх предметов'),
    ];
    return { rows, checks, bad: checks.filter(c => !c.ok).length, attuned: attunedItems.filter(it => it.attunement === true).length };
  }
  function validate(it) {
    if (!Number.isInteger(it.qty) || it.qty < 0 || it.qty > 1000000) return 'Количество должно быть целым от 0 до 1000000.';
    if (it.charges && (!Number.isInteger(it.charges.max) || !Number.isInteger(it.charges.cur) || it.charges.max < 0 || it.charges.max > 10000 || it.charges.cur < 0 || it.charges.cur > it.charges.max)) return 'Заряды: целые числа, текущие не больше максимума (до 10000).';
    if (it.consume?.enabled && (!Number.isInteger(it.consume.amount) || it.consume.amount < 1 || it.consume.amount > 10000)) return 'Расход: целое число от 1 до 10000.';
    return '';
  }
  return { slots, kinds, wearKinds, WORN_SLOTS, slotsAudit, normalize, migrate, equipDefaults, choices, canEquip, wornSlots, wearKind, handedness: handednessOf, activeActions, resourceStatus, armorClass, armorClassParts, editor, validate };
})();
