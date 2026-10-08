// Стартовое снаряжение мастера создания: разбор текста SRD и сборка предметов по правилам инвентаря.
// Модули и правила берутся настоящие (equipment.js + modules.js), справочник — компактная фикстура,
// а отдельный тест проверяет реальные записи data_seed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, localStorage: { getItem() { return null; }, setItem() {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/equipment.js', 'utf8'), ctx);
ctx.Equipment = ctx.window.Equipment;
vm.runInContext(fs.readFileSync('static/modules.js', 'utf8'), ctx);
ctx.Modules = ctx.window.Modules;
ctx.window.SKILLS = [
  ['acrobatics', 'Акробатика', 'dex'], ['animal', 'Уход за животными', 'wis'], ['arcana', 'Магия', 'int'], ['athletics', 'Атлетика', 'str'],
  ['deception', 'Обман', 'cha'], ['history', 'История', 'int'], ['insight', 'Проницательность', 'wis'], ['intimidation', 'Запугивание', 'cha'],
  ['investigation', 'Расследование', 'int'], ['medicine', 'Медицина', 'wis'], ['nature', 'Природа', 'int'], ['perception', 'Восприятие', 'wis'],
  ['performance', 'Выступление', 'cha'], ['persuasion', 'Убеждение', 'cha'], ['religion', 'Религия', 'int'], ['sleight', 'Ловкость рук', 'dex'],
  ['stealth', 'Скрытность', 'dex'], ['survival', 'Выживание', 'wis'],
];
ctx.SKILLS = ctx.window.SKILLS;
ctx.ABIL = { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' };
vm.runInContext(fs.readFileSync('static/character-builder.js', 'utf8'), ctx);
const B = ctx.window.CharacterBuilder;
// Значения приходят из песочницы vm — сравниваем структуру, а не прототипы другого контекста.
const plain = value => JSON.parse(JSON.stringify(value));

const item = (name, category, type = 'gear', extra = {}) => ({ id: 'i-' + name, category: 'item', name, source: 'Фикстура', pack_id: null,
  data: { category, type, edition: '2014', ...extra } });
const CATALOG = [
  item('Ручной топор', 'Простое рукопашное', 'weapon', { damage: '1к6', properties: ['Лёгкое', 'Метательное (20/60)'] }),
  item('Боевой топор', 'Воинское рукопашное', 'weapon', { damage: '1к8', properties: ['Универсальное (1к10)'] }),
  item('Двуручный меч', 'Воинское рукопашное', 'weapon', { damage: '2к6', properties: ['Двуручное', 'Тяжёлое'] }),
  item('Короткий меч', 'Воинское рукопашное', 'weapon', { damage: '1к6', properties: ['Фехтовальное', 'Лёгкое'] }),
  item('Длинный меч', 'Воинское рукопашное', 'weapon', { damage: '1к8', properties: ['Универсальное (1к10)'] }),
  item('Секира', 'Воинское рукопашное', 'weapon', { damage: '1к12', properties: ['Двуручное', 'Тяжёлое'] }),
  item('Дубинка', 'Простое рукопашное', 'weapon', { damage: '1к4' }),
  item('Кинжал', 'Простое рукопашное', 'weapon', { damage: '1к4', properties: ['Лёгкое', 'Метательное (20/60)'] }),
  item('Дротик', 'Простое дальнобойное', 'weapon', { damage: '1к4', properties: ['Метательное (20/60)'] }),
  item('Лёгкий арбалет', 'Простое дальнобойное', 'weapon', { damage: '1к8', properties: ['Двуручное', 'Боеприпас'] }),
  item('Длинный лук', 'Воинское дальнобойное', 'weapon', { damage: '1к8', properties: ['Двуручное', 'Боеприпас'] }),
  item('Кольчуга', 'Тяжёлый доспех', 'armor', { ac: '16', str_req: 13 }),
  item('Кожаный доспех', 'Лёгкий доспех', 'armor', { ac: '11 + Лов' }),
  item('Щит', 'Щит', 'armor', { ac: '+2' }),
  item('Стрела', 'Боеприпасы', 'gear', { weight: 0.05, ammo_tag: 'arrow', type_hint: 'ammo' }),
  item('Арбалетный болт', 'Боеприпасы', 'gear', { ammo_tag: 'bolt' }),
  item('Колчан', 'Снаряжение', 'gear', { weight: 1 }),
  item('Рюкзак', 'Снаряжение', 'gear', { weight: 5 }),
  item('Спальник', 'Снаряжение', 'gear', { weight: 7 }),
  item('Столовый набор', 'Снаряжение', 'gear', { weight: 1.5 }),
  item('Трутница', 'Снаряжение', 'gear', { weight: 1 }),
  item('Факел', 'Снаряжение', 'gear', { weight: 1 }),
  item('Рационы (1 день)', 'Снаряжение', 'consumable', { weight: 2 }),
  item('Бурдюк', 'Снаряжение', 'gear', { weight: 5 }),
  item('Верёвка пеньковая (50 футов)', 'Снаряжение', 'gear', { weight: 10 }),
  item('Одежда обычная', 'Снаряжение', 'gear', { weight: 3 }),
  item('Костюм', 'Снаряжение', 'gear', { weight: 4 }),
  item('Поясной кошель', 'Снаряжение', 'gear', { weight: 1 }),
  item('Набор путешественника', 'Наборы снаряжения', 'gear', { weight: 0, desc: 'Содержимое: Рюкзак ×1, Спальник ×1, Столовый набор ×1, Трутница ×1, Факел ×10, Рационы (1 день) ×10, Бурдюк ×1, Верёвка пеньковая (50 футов) ×1' }),
  item('Набор исследователя подземелий', 'Наборы снаряжения', 'gear', { weight: 0, desc: 'Содержимое: Рюкзак ×1, Ломик ×1, Молоток ×1, Крюк ×10, Факел ×10, Трутница ×1, Рационы (1 день) ×10, Бурдюк ×1, Верёвка пеньковая (50 футов) ×1' }),
  item('Набор артиста', 'Наборы снаряжения', 'gear', { weight: 0, desc: 'Содержимое: Рюкзак ×1, Спальник ×1, Костюм ×2, Свеча ×5, Рационы (1 день) ×5, Бурдюк ×1' }),
  item('Мешочек с компонентами', 'Снаряжение', 'gear', { weight: 2 }),
  item('Воровские инструменты', 'Другие инструменты', 'tool', { weight: 1 }),
  item('Волынка', 'Музыкальные инструменты', 'gear', { weight: 6 }),
  item('Кристалл', 'Магические фокусы', 'gear', { weight: 1 }),
  item('Веточка омелы', 'Друидические фокусы', 'gear', { weight: 0 }),
  item('Амулет', 'Священные символы', 'gear', { weight: 1 }),
  item('Инструменты алхимика', 'Инструменты ремесленника', 'tool', { weight: 8 }),
  item('Мантия сопротивления заклинаниям', 'Чудесные предметы', 'magic', { weight: 1 }),
];
// Боеприпасы опознаются по метке/типу: в фикстуре у стрел стоит ammo_tag.
CATALOG.forEach(e => { if (e.data.ammo_tag) e.data.mechanics = { item_defaults: { qty: e.data.name === 'Стрела' ? 20 : undefined, unit_weight: e.data.weight ?? 0.05, ammo_tag: e.data.ammo_tag, type: 'ammo' } }; });
CATALOG.find(e => e.name === 'Стрела').data.mechanics.item_defaults.qty = 20;
CATALOG.find(e => e.name === 'Арбалетный болт').data.mechanics.item_defaults.qty = 20;

const FIGHTER_2014 = '- (a) кольчуга или (b) кожаный доспех, длинный лук и 20 стрел\n- (a) воинское оружие и щит или (b) два воинских оружия\n- (a) лёгкий арбалет и 20 болтов или (b) два ручных топорика\n- (a) набор исследователя подземелий или (b) набор путешественника';
const BARBARIAN_2024 = 'Выберите А или Б: (А) Секира, 4 ручных топора, набор путешественника и 15 зм; или (Б) 75 зм';
const KNIGHT_CLERIC = '- (a) булава или (b) боевой молот (при владении)\n- (a) лёгкий арбалет и 20 болтов или (b) любое простое оружие\n- (a) щит, (b) священный символ или (c) магический фокус (кристалл)';
const entryOf = (category, name, data = {}) => ({ id: category + ':' + name, category, name, source: 'Фикстура', pack_id: null, data });

const draft = (over = {}) => {
  const result = Object.assign({
    name: 'Тест', edition: '2014', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    selected: { class: entryOf('class', 'Воин', { hit_die: 'd10', saves: ['str', 'con'], tools: null, starting_equipment: FIGHTER_2014 }) },
    picks: {}, skills: [], languages: [], bonuses: {}, spells: [], method: 'standard', rolls: [],
    equipment: { choice: {}, picks: {}, exclude: {}, template: {}, qty: {}, name: {}, extras: [], gold: 0, packs: true, autoEquip: true },
    catalog: CATALOG,
  }, over);
  // Test fixtures represent a player who explicitly made every available choice.
  for (const block of B.equipmentPlan(result)) if (block.kind === 'group' && !result.equipment.choice[block.id]) result.equipment.choice[block.id] = block.options[0]?.id;
  for (const slot of B.equipmentItems(result).items.filter(item => item.pick)) {
    const option = (result.catalog || []).find(item => B.PICK_FILTERS[slot.filter]?.test(item));
    if (option && !result.equipment.picks[slot.key]) result.equipment.picks[slot.key] = option.id;
  }
  return result;
};
const tokensOf = entry => B.equipmentItems(entry).items;
const pickAll = entry => { for (const it of tokensOf(entry)) if (it.pick) {
  const option = entry.catalog.find(item => B.PICK_FILTERS[it.filter]?.test(item));
  if (option) entry.equipment.picks[it.key] = option.id;
} return entry; };
const take = (entry, name) => { const it = tokensOf(entry).find(i => (i.entry ? i.entry.name : i.name) === name); return it; };

test('2014 text turns into fixed items, either/or groups and player choices', () => {
  const blocks = B.parseEquipmentText(FIGHTER_2014, 'class');
  assert.equal(blocks.length, 4);
  assert.deepEqual(plain(blocks.map(b => b.kind)), ['group', 'group', 'group', 'group']);
  assert.deepEqual(plain(blocks.map(b => b.options.length)), [2, 2, 2, 2]);
  assert.deepEqual(plain(blocks[0].options.map(o => o.marker)), ['A', 'B']);
  assert.deepEqual(plain(blocks[0].options[0].tokens.map(t => t.name + '×' + t.qty)), ['Кольчуга×1']);
  assert.deepEqual(plain(blocks[0].options[1].tokens.map(t => t.name + '×' + t.qty)), ['Кожаный доспех×1', 'Длинный лук×1', 'Стрел×20']);
  assert.deepEqual(plain(blocks[1].options[0].tokens.map(t => t.kind)), ['pick', 'item']);
  assert.equal(blocks[1].options[0].tokens[0].filter, 'martial-weapon');
  assert.deepEqual(plain(blocks[1].options[1].tokens.map(t => [t.kind, t.count])), [['pick', 2]]);
  assert.equal(blocks[3].options[1].tokens[0].name, 'Набор путешественника');
});

test('every option of a group is parsed, including the last one and the plain list', () => {
  const blocks = B.parseEquipmentText(KNIGHT_CLERIC, 'class');
  assert.equal(blocks.length, 3);
  assert.deepEqual(plain(blocks.map(b => b.kind)), ['group', 'group', 'group']);
  assert.deepEqual(plain(blocks[0].options.map(o => o.tokens[0].name)), ['Булава', 'Боевой молот']);
  assert.equal(blocks[0].options[1].tokens[0].note, 'при владении');
  assert.equal(blocks[1].options[1].tokens[0].kind, 'pick');
  assert.deepEqual(plain(blocks[2].options.map(o => o.tokens[0].kind)), ['item', 'pick', 'pick'], '«священный символ» — выбор из категории');
  assert.equal(blocks[2].options[0].tokens[0].name, 'Щит');
  assert.equal(blocks[2].options[2].tokens[0].filter, 'arcane-focus');
  assert.equal(blocks[2].options[2].tokens[0].prefer, 'кристалл');
});

test('2024 text keeps option gold and quantities from the same one-line choice', () => {
  const [group] = B.parseEquipmentText(BARBARIAN_2024, 'class');
  assert.equal(group.kind, 'group');
  assert.equal(group.options.length, 2);
  assert.equal(group.label, 'Выберите А или Б');
  assert.deepEqual(plain(group.options[0].tokens.map(t => t.kind === 'gold' ? 'gold' + t.amount : t.name + '×' + t.qty)),
    ['Секира×1', 'Ручных топора×4', 'Набор путешественника×1', 'gold15']);
  assert.deepEqual(plain(group.options[1].tokens.map(t => 'gold' + t.amount)), ['gold75']);
});

test('quantities come from ×N, digits, word numbers, quivers and counted parentheses', () => {
  const one = text => B.parseItemToken(text)[0];
  assert.equal(one('Стрела ×20').qty, 20);
  assert.equal(one('20 болтов').qty, 20);
  assert.equal(one('пять дротиков').qty, 5);
  assert.equal(one('два ручных топорика').qty, 2);
  assert.equal(one('пергамент (10 листов)').qty, 10);
  assert.equal(one('Пергамент (1 лист)').qty, 1);
  assert.equal(one('боевой молот (при владении)').note, 'при владении');
  assert.equal(one('15 зм').amount, 15);
  assert.equal(one('75 зм').amount, 75);
  const quiver = B.parseItemList('короткий лук и колчан с 20 стрелами');
  assert.deepEqual(plain(quiver.map(t => t.name + '×' + t.qty)), ['Короткий лук×1', 'Колчан×1', 'Стрела×20']);
  assert.equal(B.parseItemToken('выбранные выше').length, 0);
});

test('commas and «и» inside parentheses do not split items', () => {
  const tokens = B.parseItemToken('Металлические шарики (мешочек, 1000 шт.) ×1');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].name, 'Металлические шарики');
  assert.equal(tokens[0].note, 'мешочек, 1000 шт.');
  assert.equal(tokens[0].qty, 1);
});

test('names resolve to compendium entries by stems, not by magic look-alikes', () => {
  const find = name => B.findItemTemplate(name, CATALOG)?.name;
  assert.equal(find('4 ручных топора'), 'Ручной топор');
  assert.equal(find('Ручных топорика'), 'Ручной топор');
  assert.equal(find('деревянный щит'), 'Щит');
  assert.equal(find('20 болтов'), 'Арбалетный болт', 'число из текста не мешает поиску шаблона');
  assert.equal(find('Коротких меча'), 'Короткий меч');
  assert.equal(find('мантия'), undefined);
  assert.equal(find('Фокусировка друида'), undefined);
});

test('equipment variants and item slots are never silently defaulted or allowed outside their category', () => {
  const unchosen = draft();
  unchosen.equipment.choice = {};
  unchosen.equipment.picks = {};
  assert.deepEqual(plain(B.equipmentItems(unchosen).items), [], 'no equipment from an either/or group is projected before choosing a variant');

  const selectedVariant = draft();
  selectedVariant.equipment.choice['class:1'] = 'opt1';
  selectedVariant.equipment.picks = {};
  const slot = B.equipmentItems(selectedVariant).items.find(item => item.pick);
  assert.ok(slot);
  assert.equal(slot.name, '', 'a category choice remains empty until explicitly selected');
  selectedVariant.equipment.picks[slot.key] = 'i-Кристалл';
  assert.equal(B.equipmentItems(selectedVariant).items.find(item => item.pick).name, '', 'an item from a different category is rejected');
});

test('slot picks use explicit items from the allowed category', () => {
  const draftSheet = pickAll(draft());
  draftSheet.equipment.choice['class:1'] = 'opt1';  // воинское оружие и щит
  const picked = tokensOf(draftSheet).filter(i => i.pick);
  assert.deepEqual(plain(picked.map(i => i.name)), ['Боевой топор'], 'щит — конкретный предмет, его не предлагают выбирать');
  assert.equal(tokensOf(draftSheet).find(i => (i.entry || {}).name === 'Щит').qty, 1);
  const cleric = draft({ selected: { class: entryOf('class', 'Жрец', { hit_die: 'd8', starting_equipment: KNIGHT_CLERIC }) } });
  cleric.equipment.choice['class:2'] = 'opt3';
  const focus = tokensOf(cleric).find(i => i.pick);
  assert.equal(focus.name, '', 'выбор предмета по категориям не подставляется молча');
  cleric.equipment.picks[focus.key] = 'i-Кристалл';
  assert.equal(tokensOf(cleric).find(i => i.pick).name, 'Кристалл', 'конкретный выбор из разрешённой категории попадает в инвентарь');
});

test('starting inventory uses real item templates, stacks, ammo and slots', () => {
  const draftSheet = pickAll(draft());
  draftSheet.equipment.choice['class:1'] = 'opt1';
  draftSheet.equipment.choice['class:2'] = 'opt2'; // два ручных топорика вместо арбалета
  draftSheet.equipment.choice['class:3'] = 'opt2';
  const sheet = B.build(draftSheet);
  const byName = name => sheet.inventory.find(i => i.name === name);
  assert.equal(byName('Кольчуга').qty, 1);
  assert.equal(byName('Кольчуга').str_req, 13);
  assert.equal(byName('Кольчуга').worn_slot, 'armor');
  assert.equal(byName('Кольчуга').slots_v, 2);
  assert.equal(byName('Боевой топор').handedness, 'versatile');
  assert.equal(byName('Боевой топор').hand_slot, 'main');
  assert.equal(byName('Щит').hand_slot, 'off');
  assert.equal(byName('Ручной топор').qty, 2);
  assert.equal(byName('Ручной топор').equipped, false, 'стопку нельзя взять в руки');
  assert.equal(byName('Набор исследователя подземелий'), undefined, 'набор раскладывается на содержимое');
  assert.ok(sheet.inventory.every(i => i.uid && i.consume), 'каждый предмет получает uid и настройки расхода');
  assert.equal(sheet.ac, 18, 'КД считается от надетого доспеха и щита');
  assert.equal(sheet.auto_armor, true);
});

test('feat spellcasting ability is preserved when a spell is sent to chat', () => {
  const spell = { name: 'Щит', level: 1, spell_ability: 'cha', actions: [] };
  assert.equal(ctx.Modules.toChatCard(spell, 'spell').spell_ability, 'cha');
  assert.equal(ctx.Modules.toChatCard({ ...spell, spell_ability: undefined }, 'spell').spell_ability, undefined);
});

test('Unarmored Defense calculates class AC and enforces the monk shield restriction', () => {
  const base = { abilities: { dex: 14, con: 16, wis: 16 }, inventory: [] };
  assert.equal(ctx.Equipment.armorClassParts({ ...base, unarmored_defense: 'barbarian' }).ac, 15, 'barbarian adds Constitution');
  assert.equal(ctx.Equipment.armorClassParts({ ...base, unarmored_defense: 'monk' }).ac, 15, 'monk adds Wisdom');
  const shield = { name: 'Щит', type: 'armor', ac: '+2', equipped: true, hand_slot: 'off', qty: 1 };
  assert.equal(ctx.Equipment.armorClassParts({ ...base, unarmored_defense: 'barbarian', inventory: [shield] }).ac, 17, 'barbarian can use a shield with Unarmored Defense');
  assert.equal(ctx.Equipment.armorClassParts({ ...base, unarmored_defense: 'monk', inventory: [shield] }).ac, 14, 'monk loses Unarmored Defense while using a shield');
  const barbarian = B.build({ name: 'Варвар', edition: '2014', abilities: { str: 10, dex: 14, con: 16, int: 10, wis: 10, cha: 10 },
    selected: { class: entryOf('class', 'Варвар', { name_en: 'barbarian', hit_die: 'd12', starting_equipment: '' }) }, spells: [], catalog: CATALOG,
    equipment: { choice: {}, picks: {}, exclude: {}, template: {}, qty: {}, name: {}, extras: [], gold: 0, packs: true, autoEquip: true } });
  assert.equal(barbarian.ac, 15, 'the creation projection calculates unarmored AC, not just the equipment helper');
  assert.equal(barbarian.unarmored_defense, 'barbarian');
});

test('an ammo weapon consumes ammo, and the pack is a single row unless disabled', () => {
  const draftSheet = draft();
  draftSheet.equipment.choice['class:0'] = 'opt2'; // кожаный доспех, длинный лук и 20 стрел
  draftSheet.equipment.choice['class:1'] = 'opt2';
  draftSheet.equipment.choice['class:2'] = 'opt1'; // лёгкий арбалет и 20 болтов
  draftSheet.equipment.choice['class:3'] = 'opt1'; // набор исследователя подземелий
  const sheet = B.build(draftSheet);
  const bow = sheet.inventory.find(i => i.name === 'Длинный лук');
  assert.equal(bow.consume.enabled, true);
  assert.equal(bow.consume.ammo_tag, 'arrow');
  assert.equal(sheet.inventory.find(i => i.name === 'Стрела').qty, 20);
  assert.ok(sheet.inventory.some(i => i.name === 'Рюкзак'), 'содержимое набора в инвентаре');
  assert.ok(!sheet.inventory.some(i => i.name === 'Набор исследователя подземелий'));
});

test('a two-handed weapon does not remove a shield from the other hand', () => {
  const draftSheet = draft();
  draftSheet.equipment.choice['class:0'] = 'opt1';
  draftSheet.equipment.choice['class:1'] = 'opt1';
  draftSheet.equipment.choice['class:2'] = 'opt1';
  draftSheet.equipment.choice['class:3'] = 'opt1';
  draftSheet.equipment.picks = {};
  for (const it of tokensOf(draftSheet)) if (it.pick) draftSheet.equipment.picks[it.key] = 'i-Двуручный меч';
  const sheet = B.build(draftSheet);
  const shield = sheet.inventory.find(i => i.name === 'Щит');
  const sword = sheet.inventory.find(i => i.name === 'Двуручный меч');
  assert.equal(shield.hand_slot, 'off');
  assert.equal(sword.equipped, false, 'двуручный меч не выбивает щит из второй руки');
});

test('standard equipment ignores master-only changes until master mode is enabled', () => {
  const draftSheet = draft();
  const armor = take(draftSheet, 'Кольчуга');
  draftSheet.equipment.qty[armor.key] = 4;
  draftSheet.equipment.gold = 3;
  draftSheet.equipment.extras.push({ key: 'extra', name: 'Верёвка пеньковая (50 футов)', qty: 2 });
  let result = B.equipmentItems(draftSheet);
  assert.equal(result.items.find(i => i.name === 'Кольчуга').qty, 1);
  assert.equal(result.gold, 0);
  assert.ok(!result.items.some(i => i.manual), 'ручная добавка не должна попасть в стандартный инвентарь');

  draftSheet.equipment.gmOverrides = true;
  result = B.equipmentItems(draftSheet);
  assert.equal(result.items.find(i => i.name === 'Кольчуга').qty, 4);
  assert.equal(result.gold, 3);
  assert.ok(result.items.some(i => i.name === 'Верёвка пеньковая (50 футов)'));
});

test('gold, exclusions and manual extras reach the sheet', () => {
  const draftSheet = draft({ edition: '2024' });
  draftSheet.equipment.gmOverrides = true;
  draftSheet.selected = { class: entryOf('class', 'Варвар', { hit_die: 'd12', starting_equipment: BARBARIAN_2024 }),
    background: entryOf('background', 'Прислужник', { languages: 2, equipment: 'Выберите A или B: (A) Каллиграфические принадлежности, книга (молитвы), 8 зм; или (B) 50 зм' }) };
  draftSheet.equipment.choice['background:0'] = 'opt2';
  draftSheet.equipment.extras.push({ key: 'x1', name: 'Верёвка пеньковая (50 футов)', entryId: 'i-Верёвка пеньковая (50 футов)', qty: 2 });
  const excluded = take(draftSheet, 'Ручной топор');
  draftSheet.equipment.exclude[excluded.key] = true;
  draftSheet.equipment.gold = 3;
  const sheet = B.build(draftSheet);
  assert.equal(sheet.currency.gp, 15 + 50 + 3, 'золото вариантов и добавка игрока');
  assert.ok(!sheet.inventory.some(i => i.name === 'Ручной топор'), 'снятую галочку предмет не попадает в инвентарь');
  const rope = sheet.inventory.filter(i => i.name === 'Верёвка пеньковая (50 футов)').reduce((sum, i) => sum + i.qty, 0);
  assert.equal(rope, 3, 'две верёвки из «Дополнительно» плюс верёвка из набора');
  assert.equal(sheet.creation.equipment.gold, sheet.currency.gp);
});

test('packs expand into their contents unless the player keeps them whole', () => {
  const draftSheet = draft();
  draftSheet.equipment.choice['class:3'] = 'opt1'; // набор исследователя подземелий
  const expanded = B.build(draftSheet).inventory.map(i => i.name);
  assert.ok(expanded.includes('Рюкзак') && expanded.includes('Факел') && !expanded.includes('Набор исследователя подземелий'));
  assert.ok(tokensOf(draftSheet).some(i => i.pack && i.name === 'Набор исследователя подземелий'), 'набор остаётся строкой выбора');
  draftSheet.equipment.packs = false;
  const packed = B.build(draftSheet).inventory.map(i => i.name);
  assert.ok(packed.includes('Набор исследователя подземелий') && !packed.includes('Факел'));
  assert.match(B.build(draftSheet).inventory.find(i => i.name === 'Набор исследователя подземелий').desc, /Рюкзак/);
});

test('assembly is a pure projection: draft is untouched and rebuilds are identical', () => {
  const draftSheet = pickAll(draft());
  draftSheet.equipment.choice['class:2'] = 'opt2';
  const before = JSON.stringify(draftSheet);
  const withoutUids = sheet => { const copy = JSON.parse(JSON.stringify(sheet)); for (const it of copy.inventory) delete it.uid; return copy; };
  const first = B.build(draftSheet);
  const second = B.build(draftSheet);
  assert.deepEqual(withoutUids(first), withoutUids(second), 'у сборок совпадает всё, кроме случайных uid');
  assert.equal(JSON.stringify(draftSheet), before, 'сборка не меняет черновик');
  assert.ok(first.inventory.length > 0 && first.inventory.every(i => i.uid));
});

test('skills state separates class picks from skills granted by modules', () => {
  const draftSheet = draft();
  draftSheet.selected.class = entryOf('class', 'Воин', { hit_die: 'd10', skills: { choose: 2, from: ['Акробатика', 'Атлетика', 'Восприятие'] } });
  draftSheet.selected.background = entryOf('background', 'Прислужник', { skills: ['Атлетика'], choices: [{ id: 'g', name: 'Ремесло', type: 'skill', count: 1, optional: false, options: [{ id: 'o', name: 'Скрытность', value: ['stealth'] }] }] });
  draftSheet.picks = { g: ['o'] };
  draftSheet.skills = ['athletics', 'perception'];
  const state = B.skillsState(draftSheet);
  assert.deepEqual([...state.granted.map(g => g.name)].sort(), ['Атлетика', 'Скрытность']);
  assert.equal(state.klass.choose, 2);
  assert.deepEqual(state.klass.picked, ['perception'], 'уже выданные модулем навыки не тратят выбор класса');
  assert.equal(state.klass.options.find(o => o.key === 'athletics').granted, 'предыстория · Прислужник', 'источник навыка подписан видом модуля');
  const sheet = B.build(draftSheet);
  assert.deepEqual([...sheet.skills].sort(), ['athletics', 'perception', 'stealth']);
});

test('skills state survives an empty draft without modules', () => {
  const state = B.skillsState({});
  assert.deepEqual(plain(state.granted), []);
  assert.equal(state.klass, null);
});

test('compendium import keeps 2024 weapon mastery and action mechanics', () => {
  const it = ctx.Modules.itemFromCompendium({ name: 'Greatsword', category: 'item', data: {
    type: 'weapon', category: 'Воинское рукопашное', damage: '2к6', damage_type: 'рубящий',
    properties: ['Двуручное', 'Тяжёлое'], mastery: 'Graze', edition: '2024',
  } });
  assert.equal(it.mastery, 'Graze');
  assert.deepEqual(plain(it.actions.map(a => a.kind)), ['attack', 'damage']);
  const magic = ctx.Modules.itemFromCompendium({ name: 'Ring of Protection', category: 'item', data: {
    type: 'magic', attunement: true, charges: 3,
    mechanics: { version: 1, programs: [{ id: 'use', name: 'Use', trigger: 'use', blocks: [{ id: 'm', kind: 'manual', text: 'Rule' }] }] },
  } });
  assert.equal(magic.attunement, true);
  assert.deepEqual(plain(magic.charges), { cur: 3, max: 3, recharge: '' });
  assert.equal(magic.mechanics.programs[0].blocks[0].kind, 'manual');
});

test('real SRD records resolve for every class and background of both editions', () => {
  for (const [file, edition] of [['data_seed/srd_2014.json', '2014'], ['data_seed/srd_2024.json', '2024']]) {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'))
      .map(e => ({ id: e.slug || e.name, category: e.category, name: e.name, source: 'SRD', pack_id: null, data: e.data }));
    const classes = catalog.filter(e => e.category === 'class');
    const backgrounds = catalog.filter(e => e.category === 'background');
    assert.ok(classes.length && backgrounds.length, file + ' содержит классы и предыстории');
    for (const klass of classes) for (const background of edition === '2024' ? backgrounds.slice(0, 1) : backgrounds) {
      const draftSheet = draft({ edition, catalog, selected: { class: klass, background } });
      const plan = B.equipmentPlan(draftSheet);
      assert.ok(plan.length, `${edition} ${klass.name}: план снаряжения не пуст`);
      for (const block of plan) {
        if (block.kind !== 'group') continue;
        assert.ok(block.options.length >= 2, `${klass.name}: у группы есть варианты`);
        for (const option of block.options) assert.ok(option.tokens.length, `${klass.name}: вариант ${option.marker} не пуст`);
      }
      for (const item of B.equipmentItems(draftSheet).items) {
        if (item.pick) {
          assert.ok(typeof (B.PICK_FILTERS[item.filter] || {}).test === 'function', 'фильтр выбора известен');
          assert.ok(item.name, 'тестовый игрок явно выбрал предмет из разрешённой категории');
          continue;
        }
        // В SRD есть снаряжение без отдельной записи («Ряса», «Мантия»): предмет остаётся в инвентаре
        // с текстовым названием и попадает на лист — терять его нельзя.
        if (!item.entry) assert.ok(/\S/.test(item.name), `${edition} ${klass.name}: у предмета есть название`);
        assert.ok(item.qty >= 1 && Number.isInteger(item.qty));
      }
      const sheet = B.build(draftSheet);
      assert.ok(sheet.inventory.length, `${edition} ${klass.name}: инвентарь не пуст`);
      for (const it of sheet.inventory) assert.ok(!/undefined|null|\?\?/.test(it.name), `странное имя предмета: ${it.name}`);
      for (const item of B.equipmentItems(draftSheet).items) {
        if (item.pick || item.pack) continue; // набор раскладывается на содержимое
        assert.ok(sheet.inventory.some(it => it.name === item.name), `${klass.name}: «${item.name}» не потерялся при сборке`);
      }
      for (const it of sheet.inventory) {
        assert.ok(it.name && it.uid && it.slots_v === 2, 'предмет нормализован по правилам инвентаря');
      }
      // руками выбранные слоты и золото тоже доходят до листа
      const handPicked = draft({ edition, catalog, selected: { class: klass, background } });
      handPicked.equipment.choice = Object.fromEntries(B.equipmentPlan(handPicked).filter(b => b.kind === 'group').map(b => [b.id, b.options[b.options.length - 1].id]));
      for (const item of B.equipmentItems(handPicked).items) if (item.pick) handPicked.equipment.picks[item.key] = '';
      const lastOption = B.build(handPicked);
      assert.ok(lastOption.inventory.length + lastOption.currency.gp > 0, 'последний вариант (часто «только золото») тоже собирается');
    }
  }
});
