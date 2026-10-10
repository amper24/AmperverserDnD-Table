const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(fs.readFileSync('static/formulas.js','utf8'),ctx);vm.runInContext(fs.readFileSync('static/equipment.js','utf8'),ctx);
const E = ctx.window.Equipment;
test('defaults connect a bow to arrows and crossbow to bolts without overwriting opt-out',()=>{
  const bow = E.normalize({name:'Длинный лук',type:'weapon',properties:['Двуручное','Боеприпас'],qty:1});
  assert.equal(bow.handedness,'two'); assert.equal(bow.consume.ammo_tag,'arrow'); assert.equal(bow.consume.trigger,'attack');
  assert.equal(E.normalize({name:'Арбалет',type:'weapon'}).consume.ammo_tag,'bolt');
  bow.consume.enabled=false; E.normalize(bow); assert.equal(bow.consume.enabled,false);
});
test('migration occupies both hands once and unequips conflicts without deleting inventory',()=>{
  const inv=[{uid:'a',type:'weapon',name:'Лук',handedness:'two',equipped:true,qty:1},{uid:'b',type:'weapon',equipped:true,qty:1}];
  E.migrate(inv); assert.equal(inv.length,2); assert.equal(inv[0].hand_slot,'both'); assert.equal(inv[1].equipped,false);
});
test('universal damage variants are mutually exclusive',()=>{
  const it=E.normalize({type:'weapon',handedness:'versatile',actions:[{name:'Атака',kind:'attack'},{name:'Урон',kind:'damage'},{name:'Урон двумя руками',kind:'damage'}]});
  it.hand_slot='main'; assert.equal(E.activeActions(it).length,2); assert.equal(E.activeActions(it)[1].index,1);
  it.hand_slot='both'; assert.equal(E.activeActions(it).length,2); assert.equal(E.activeActions(it)[1].index,2);
});
test('explicit resource links do not silently bind a different stack; automatic links sum matching stacks',()=>{
  const inv=[{uid:'a',name:'Стрелы',qty:0,ammo_tag:'arrow'},{uid:'b',name:'Стрелы',qty:8,ammo_tag:'arrow'}];
  const it={consume:{enabled:true,target_uid:'a',resource:'quantity',amount:1}};
  assert.equal(E.resourceStatus(it,inv).available,0); it.consume.target_uid='';it.consume.ammo_tag='arrow';assert.equal(E.resourceStatus(it,inv).available,8);
});
test('invalid counts rejected, depleted consumables stay depleted',()=>{
  assert.ok(E.validate({qty:1.5})); assert.ok(E.validate({qty:1,consume:{enabled:true,amount:0}}));
  const it=E.normalize({type:'consumable',qty:0,equipped:true}); assert.equal(it.qty,0); assert.equal(it.hand_slot,null); assert.equal(it.consume.target_uid,'self');
});
test('armor class recomputes without stacking shield bonuses',()=>{
  const s={abilities:{dex:16},inventory:[{type:'armor',name:'Кольчуга',handedness:'none',ac:'16',qty:1,equipped:true},{type:'armor',name:'Щит',handedness:'one',ac:'+2',qty:1,equipped:true}]};
  assert.equal(E.armorClass(s),18); assert.equal(E.armorClass(s),18);
  s.inventory[1].equipped=false;assert.equal(E.armorClass(s),16);s.inventory[0].equipped=false;assert.equal(E.armorClass(s),13);
});
test('legacy bolt cases do not become ammunition resources',()=>{
  const it=E.normalize({name:'Футляр для болтов',type:'ammo',qty:1});assert.equal(it.type,'gear');assert.equal(it.ammo_tag,undefined);
});
test('a capitalized shield is a one-handed item, not body armor',()=>{
  const it=E.normalize({name:'Щит',type:'armor',qty:1,ac:'+2'});assert.equal(it.handedness,'one');assert.ok(E.choices(it).includes('off'));
});
const plain = x => JSON.parse(JSON.stringify(x));
const inv = (...items) => E.migrate(items.map((it, i) => ({ uid: 'u' + i, qty: 1, ...it })));
test('только носимые и держимые предметы можно экипировать; слот выводится из названия и категории (ru и en)', () => {
  const [rope, potion, wand, chain, shield, ring, ringEn, protectionRing, brooch] = inv(
    { name: 'Верёвка', type: 'gear' }, { name: 'Зелье лечения', type: 'magic', tags: ['Зелья'] }, { name: 'Волшебная палочка', type: 'magic', tags: ['Волшебные палочки'] },
    { name: 'Кольчуга', type: 'armor', handedness: 'none', ac: '16' }, { name: 'Щит', type: 'armor', ac: '+2' }, { name: 'Кольцо невидимости', type: 'magic', tags: ['Кольца'] },
    { name: 'Ring of Warmth', type: 'magic', tags: ['Rings'] }, { name: 'Кольцо защиты', type: 'magic' }, { name: 'Brooch of Shielding', type: 'magic' });
  assert.equal(E.canEquip(rope), false); assert.deepEqual(plain(E.choices(rope)), []);
  assert.equal(E.canEquip(potion), false);
  assert.deepEqual(plain(E.choices(wand)), ['main', 'off']);
  assert.equal(chain.wear, 'armor'); assert.deepEqual(plain(E.choices(chain)), ['armor']);
  assert.equal(shield.handedness, 'one'); assert.equal(shield.wear, '');
  assert.deepEqual(plain(E.choices(ring)), ['ring1', 'ring2']); assert.equal(ringEn.wear, 'ring');
  assert.equal(protectionRing.handedness, 'none', '«защита» не содержит слова «щит»'); assert.equal(protectionRing.wear, 'ring');
  assert.equal(brooch.handedness, 'none'); assert.equal(brooch.wear, 'neck');
  const kinds = ['Cloak of Protection', 'Boots of Elvenkind', 'Amulet of Health', 'Belt of Giant Strength', 'Gauntlets of Ogre Power', 'Шлем ужаса', 'Сапоги скорохода', 'Пояс силы'].map(name => E.normalize({ name, type: 'magic' }).wear);
  assert.deepEqual(kinds, ['cloak', 'feet', 'neck', 'belt', 'gloves', 'head', 'feet', 'belt']);
});
test('предметы старой схемы: «без рук» выводится заново, экипированное неносимое снимается, ничего не удаляется', () => {
  const list = E.migrate([{ uid: 'a', name: 'Верёвка', type: 'gear', handedness: 'none', equipped: true, qty: 1 }, { uid: 'b', name: 'Жезл', type: 'magic', tags: ['Жезлы'], handedness: 'none', qty: 1 }, { uid: 'c', name: 'Плащ', type: 'magic', handedness: 'none', equipped: true, qty: 1 }]);
  assert.equal(list.length, 3); assert.equal(list[0].equipped, false); assert.equal(list[1].handedness, 'one');
  assert.equal(list[2].equipped, true); assert.equal(list[2].worn_slot, 'cloak');
});
test('в слоте один предмет: лишний снимается, кольца занимают два слота', () => {
  const list = E.migrate([{ uid: 'a', name: 'Кольчуга', type: 'armor', handedness: 'none', ac: '16', equipped: true, qty: 1 }, { uid: 'b', name: 'Кожаный доспех', type: 'armor', handedness: 'none', ac: '11 + Лов', equipped: true, qty: 1 },
    ...['1', '2', '3'].map(n => ({ uid: 'r' + n, name: 'Кольцо ' + n, type: 'magic', tags: ['Кольца'], equipped: true, qty: 1 }))]);
  assert.deepEqual(list.map(i => i.equipped), [true, false, true, true, false]);
  assert.deepEqual(list.map(i => i.worn_slot), ['armor', null, 'ring1', 'ring2', null]);
});
test('КД зависит от слотов: доспех по формуле, щит в руке, бонусы колец и плащей, лишнее не накапливается', () => {
  const s = { abilities: { dex: 16 }, inventory: inv({ name: 'Полулаты', type: 'armor', handedness: 'none', ac: '15 + Лов (макс 2)', equipped: true }, { name: 'Щит', type: 'armor', ac: '+2', equipped: true },
    { name: 'Кольцо защиты', type: 'magic', ac: '+1', equipped: true }, { name: 'Cloak of Protection', type: 'magic', ac: '+1', equipped: true }, { name: 'Сумка', type: 'gear', ac: '+1' }) };
  assert.equal(E.armorClass(s), 17 + 2 + 1 + 1); assert.equal(E.armorClass(s), 21);
  const parts = E.armorClassParts(s).parts; assert.deepEqual(plain(parts[0]), ['Полулаты', 17]); assert.equal(parts.length, 4);
  s.inventory[0].equipped = false; assert.equal(E.armorClass(s), 13 + 2 + 2);
  s.inventory[2].equipped = false; assert.equal(E.armorClass(s), 13 + 2 + 1);
  s.inventory[4].equipped = true; E.migrate(s.inventory); assert.equal(s.inventory[4].equipped, false, 'сумка не носится, бонус не даётся');
  const heavy = { abilities: { dex: 16 }, inventory: inv({ name: 'Кольчуга', type: 'armor', handedness: 'none', ac: '16', equipped: true }, { name: 'Кожаный доспех', type: 'armor', handedness: 'none', ac: '11 + Лов', equipped: true }) };
  assert.equal(E.armorClass(heavy), 16, 'два доспеха не складываются: второй снят');
});
test('избранное сохраняется при нормализации и не подменяется мусором', () => {
  assert.equal(E.normalize({ name: 'Меч', type: 'weapon', favorite: true }).favorite, true);
  assert.equal(E.normalize({ name: 'Меч', type: 'weapon', favorite: 'да' }).favorite, false);
});
test('справочные предметы: конская упряжь и кошель не носятся, брошь щита — на шею, глаза — на голову', () => {
  const mk = (name, type, cat) => E.normalize({ name, type, tags: [cat] });
  assert.equal(E.canEquip(mk('Конский доспех: кольчуга', 'gear', 'Упряжь и повозки')), false);
  assert.equal(E.canEquip(mk('Поясной кошель', 'gear', 'Снаряжение')), false);
  const brooch = mk('Брошь щита', 'magic', 'Чудесные предметы'); assert.equal(brooch.wear, 'neck'); assert.equal(brooch.handedness, 'none');
  assert.equal(mk('Глаза орла', 'magic', 'Чудесные предметы').wear, 'head');
});
test('настройка: без неё предмет не влияет на КД; требования доспеха выдают предупреждения', () => {
  const s = { abilities: { str: 10, dex: 16 }, inventory: inv({ name: 'Кольцо защиты', type: 'magic', ac: '+1', attunement: true, attuned: false, equipped: true },
    { name: 'Кольчуга', type: 'armor', handedness: 'none', ac: '16', str_req: 13, stealth_disadvantage: true, equipped: true }) };
  let d = E.armorClassParts(s); assert.equal(d.ac, 16);
  assert.equal(d.speedPenalty, 10); assert.equal(d.stealth, true); assert.equal(d.notes.length, 3);
  s.inventory[0].attuned = true; s.abilities.str = 13; d = E.armorClassParts(s); assert.equal(d.ac, 17); assert.equal(d.speedPenalty, 0);
});
test('активация доступна только при наличии предмета, экипировке и обязательной настройке', () => {
  const potion = E.normalize({ name: 'Potion of Healing', type: 'consumable', qty: 1 });
  assert.equal(E.canUse(potion), true);
  potion.qty = 0; assert.equal(E.canUse(potion), false);
  const ring = E.normalize({ name: 'Ring of Protection', type: 'magic', qty: 1, attunement: true, attuned: false });
  assert.equal(E.canUse(ring), false, 'нужна настройка и кольцо не надето');
  ring.attuned = true; assert.equal(E.canUse(ring), false, 'настроенное кольцо всё ещё нужно надеть');
  ring.equipped = true; assert.equal(E.canUse(ring), true);
  const wand = E.normalize({ name: 'Wand of Fireballs', type: 'magic', qty: 1 });
  assert.equal(E.canUse(wand), false, 'палочку нужно взять в руку');
  wand.equipped = true; assert.equal(E.canUse(wand), true);
  const ringStack = E.normalize({ name: 'Ring of Protection', type: 'magic', qty: 2, attunement: true, attuned: true });
  assert.equal(ringStack.attuned, false, 'стопку нельзя настроить как один предмет');
  assert.equal(E.canUse(E.normalize({ name: 'Backpack', type: 'gear', qty: 1 })), true, 'обычное снаряжение не нужно экипировать');
});
test('настройка по правилам: только предметы с требованием, не больше трёх одновременно', () => {
  const inv = [
    { uid: 'a', name: 'Кольцо защиты', type: 'magic', attunement: true, attuned: true, qty: 1 },
    { uid: 'b', name: 'Плащ защиты', type: 'magic', attunement: true, attuned: true, qty: 1 },
    { uid: 'c', name: 'Амулет здоровья', type: 'magic', attunement: true, attuned: true, qty: 1 },
    { uid: 'd', name: 'Сапоги эльфов', type: 'magic', attunement: true, attuned: true, qty: 1 },
    { uid: 'e', name: 'Верёвка', type: 'gear', attuned: true, qty: 1 },
  ];
  E.migrate(inv);
  assert.equal(inv.filter(i => i.attuned).length, 3, 'лишняя настройка снимается');
  assert.equal(inv[3].attuned, false, 'четвёртый предмет с настройкой отпущен');
  assert.equal(inv[4].attuned, false, 'предмет без требования настройки не может быть настроен');
});

test('аудит слотов называет нарушения правил и не мешает корректной экипировке', () => {
  const sheet = { abilities: { str: 16, dex: 12 }, inventory: [
    { uid: '1', name: 'Кольчуга', type: 'armor', ac: '16', qty: 1 },
    { uid: '2', name: 'Щит', type: 'armor', ac: '+2', qty: 1 },
    { uid: '3', name: 'Секира', type: 'weapon', handedness: 'two', qty: 1 },
    { uid: '4', name: 'Кольцо защиты', type: 'magic', ac: '+1', attunement: true, qty: 1 },
  ] };
  E.equipDefaults(sheet.inventory);
  const audit = E.slotsAudit(sheet);
  assert.equal(audit.bad, 0, 'корректная раскладка не даёт нарушений: ' + JSON.stringify(audit.checks.filter(c => !c.ok)));
  assert.equal(audit.rows.find(r => r.key === 'armor').items[0].name, 'Кольчуга');
  assert.equal(audit.rows.find(r => r.key === 'off').items[0].name, 'Щит');
  assert.equal(audit.attuned, 0, 'предмет с настройкой ещё не настроен');

  // Двуручное оружие вместе со щитом — нарушение правил: мастер показывает предупреждение, а не молча.
  sheet.inventory[2].equipped = true; sheet.inventory[2].hand_slot = 'both';
  sheet.inventory[1].equipped = true; sheet.inventory[1].hand_slot = 'off';
  const conflict = E.slotsAudit(sheet);
  assert.ok(conflict.bad >= 1);
  assert.ok(conflict.checks.some(c => !c.ok && /Двуручное/.test(c.text)), JSON.stringify(conflict.checks));
});
