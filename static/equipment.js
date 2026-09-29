// Inventory rules shared by the sheet, item templates and editors. Server enforces mutations.
window.Equipment = (() => {
  const slots = { main: 'Основная рука', off: 'Вторая рука', both: 'Обе руки', worn: 'Надето', backpack: 'Рюкзак' };
  const kinds = { none: 'Без рук / носимый', one: 'Одноручный', two: 'Двуручный', versatile: 'Универсальный: 1 или 2 руки' };
  function normalize(it) {
    it.qty ??= 1;
    if (it.type === 'ammo' && !it.ammo_tag && /футляр|колчан|case|quiver/i.test(it.name || '')) it.type = 'gear';
    const text = [it.name, it.desc, ...(it.properties || [])].join(' ').toLowerCase();
    it.handedness ||= /двуруч|two-handed/.test(text) ? 'two' : /универсаль|versatile/.test(text) ? 'versatile' : it.type === 'weapon' || /щит|shield/i.test(it.name || '') ? 'one' : 'none';
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
    if (!it.equipped) it.hand_slot = null;
    return it;
  }
  function migrate(inventory) {
    const occupied = new Set();
    inventory.forEach(it => {
      normalize(it);
      if (!it.equipped || it.handedness === 'none') return;
      const slot = it.hand_slot || (it.handedness === 'two' ? 'both' : occupied.has('main') ? 'off' : 'main');
      const used = slot === 'both' ? ['main', 'off'] : [slot];
      if (it.qty !== 1 || used.some(s => occupied.has(s)) || !choices(it).includes(slot)) { it.equipped = false; it.hand_slot = null; }
      else { it.hand_slot = slot; used.forEach(s => occupied.add(s)); }
    });
    return inventory;
  }
  function armorClass(sheet) {
    const dex = Math.floor(((sheet.abilities?.dex ?? 10) - 10) / 2); let base = 10 + dex, shield = 0, armored = false;
    for (const it of sheet.inventory || []) {
      if (it.type !== 'armor' || !it.equipped || it.qty === 0) continue;
      const text = String(it.ac ?? '').toLowerCase(), match = text.match(/\d+/); if (!match) continue;
      const n = Number(match[0]);
      if (it.handedness !== 'none') shield = Math.max(shield, n);
      else if (!armored) { base = n + (/лов|dex/.test(text) ? /макс|max/.test(text) ? Math.min(dex, 2) : dex : 0); armored = true; }
    }
    return base + shield;
  }
  const choices = it => it.handedness === 'two' ? ['both'] : it.handedness === 'versatile' ? ['main', 'off', 'both'] : it.handedness === 'one' ? ['main', 'off'] : ['worn'];
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
      el('div', { class: 'row' }, field('Хват', select(Object.entries(kinds), it.handedness, v => { it.handedness = v; it.equipped = false; it.hand_slot = null; })),
        field('Метка боеприпаса этого предмета', el('input', { value: it.ammo_tag || '', placeholder: 'arrow / bolt / bullet / своя', oninput: e => it.ammo_tag = e.target.value.trim() }))),
      field('КД доспеха / бонус щита', el('input', { value: it.ac ?? '', placeholder: '16 / 12 + Лов (макс 2) / +2', oninput: e => it.ac = e.target.value })),
      el('p', {class:'muted small'}, 'Расход количества, боеприпасов и зарядов задаётся блоком «Расход ресурса» ниже.'));
  }
  function validate(it) {
    if (!Number.isInteger(it.qty) || it.qty < 0 || it.qty > 1000000) return 'Количество должно быть целым от 0 до 1000000.';
    if (it.charges && (!Number.isInteger(it.charges.max) || !Number.isInteger(it.charges.cur) || it.charges.max < 0 || it.charges.max > 10000 || it.charges.cur < 0 || it.charges.cur > it.charges.max)) return 'Заряды: целые числа, текущие не больше максимума (до 10000).';
    if (it.consume?.enabled && (!Number.isInteger(it.consume.amount) || it.consume.amount < 1 || it.consume.amount > 10000)) return 'Расход: целое число от 1 до 10000.';
    return '';
  }
  return { slots, kinds, normalize, migrate, choices, activeActions, resourceStatus, armorClass, editor, validate };
})();
