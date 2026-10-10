// Слоты экипировки по правилам D&D 5e (2014) и SRD 2024: руки, доспех, щит, кольца, фокусировки, настройка.
// Проверяем и правила подбора слота (Equipment.choices), и то, что migrate() не создаёт недопустимых состояний,
// и панель «Слоты по правилам» (Equipment.slotsAudit), которая показывает нарушения на листе.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, console, localStorage: { getItem() { return null; }, setItem() {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/dice.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/formulas.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('static/equipment.js', 'utf8'), ctx);
const E = ctx.window.Equipment;
const plain = x => JSON.parse(JSON.stringify(x));
const item = (name, props = {}) => E.normalize({ name, type: 'gear', qty: 1, ...props });
const inv = (...items) => E.migrate(items);
const sheetWith = list => ({ abilities: { str: 10, dex: 12 }, inventory: list });

test('щит занимает руку и не надевается как доспех', () => {
  const shield = item('Щит', { type: 'armor', ac: '+2' });
  assert.equal(E.handedness(shield), 'one');
  assert.deepEqual(plain(E.choices(shield)), ['main', 'off']);
  assert.equal(E.wearKind(shield), '');
});

test('доспех — один на тело, второй остаётся в рюкзаке', () => {
  const list = inv(item('Кольчуга', { type: 'armor', ac: '16' }), item('Кираса', { type: 'armor', ac: '14 + Лов (макс 2)' }));
  E.equipDefaults(list);
  assert.equal(list.filter(i => i.equipped && i.worn_slot === 'armor').length, 1);
  assert.equal(E.armorClassParts({ abilities: { str: 10, dex: 12 }, inventory: list }).ac, 16);
});

test('двуручное оружие занимает обе руки и несовместимо со щитом', () => {
  const both = inv(item('Двуручный меч', { type: 'weapon', properties: ['Двуручное'] }), item('Щит', { type: 'armor', ac: '+2' }));
  E.equipDefaults(both);
  assert.equal(both[0].equipped && both[1].equipped, false, 'двуручное и щит одновременно в руках невозможны');
  const only = inv(item('Двуручный меч', { type: 'weapon', properties: ['Двуручное'] }));
  only[0].equipped = true; E.migrate(only);
  assert.equal(only[0].hand_slot, 'both');
  assert.equal(E.slotsAudit(sheetWith(only)).bad, 0);
});

test('универсальное оружие — одна или две руки', () => {
  const list = inv(item('Боевой посох', { type: 'weapon', properties: ['Универсальное'] }));
  assert.deepEqual(plain(E.choices(list[0])), ['main', 'off', 'both']);
  list[0].equipped = true; list[0].hand_slot = 'both'; E.migrate(list);
  assert.equal(list[0].hand_slot, 'both');
});

test('колец не больше двух, и одно кольцо занимает один слот', () => {
  const rings = inv(item('Кольцо защиты', { type: 'magic', ac: '+1', attunement: true }), item('Кольцо тепла', { type: 'magic' }), item('Кольцо воды', { type: 'magic' }));
  assert.deepEqual(plain(E.choices(rings[0])), ['ring1', 'ring2']);
  rings.forEach(r => { r.equipped = true; });   // кольца надевает игрок, автонадевание их не трогает
  E.migrate(rings);
  assert.deepEqual(rings.map(r => r.worn_slot), ['ring1', 'ring2', null]);
  assert.deepEqual(rings.map(r => r.equipped), [true, true, false]);
});

test('настроено не более трёх предметов, и только те, кому настройка нужна', () => {
  const list = [1, 2, 3, 4].map(n => item('Кольцо ' + n, { type: 'magic', attunement: true, attuned: true }));
  E.migrate(list);
  assert.equal(list.filter(i => i.attuned).length, 3);
  assert.equal(list[3].attuned, false);
  const junk = item('Верёвка', { attuned: true });   // настройка не требуется — флаг из старых данных снимается
  E.normalize(junk);
  assert.equal(junk.attuned, false);
});

test('предмет с настройкой без настройки не усиливает КД', () => {
  const list = inv(item('Кольцо защиты', { type: 'magic', ac: '+1', attunement: true }));
  list[0].equipped = true; list[0].worn_slot = 'ring1'; E.migrate(list);
  const sheet = { abilities: { str: 10, dex: 14 }, inventory: list };
  assert.equal(E.armorClassParts(sheet).ac, 12);
  list[0].attuned = true;
  assert.equal(E.armorClassParts(sheet).ac, 13);
});

test('стопку нельзя надеть, пока не отделили одну штуку', () => {
  const list = inv(item('Факел', { type: 'gear', qty: 10 }));
  list[0].equipped = true; E.migrate(list);
  assert.equal(list[0].equipped, false);
});

test('доспех с требованием Силы даёт −10 фт и помеху на Скрытность', () => {
  const list = inv(item('Кольчуга', { type: 'armor', ac: '16', str_req: 15, stealth_disadvantage: true }));
  E.equipDefaults(list);
  const weak = E.armorClassParts({ abilities: { str: 10, dex: 10 }, inventory: list });
  assert.equal(weak.speedPenalty, 10); assert.equal(weak.stealth, true);
  const strong = E.armorClassParts({ abilities: { str: 16, dex: 10 }, inventory: list });
  assert.equal(strong.speedPenalty, 0);
});

test('фокусировка и инструмент держатся в руке, амулет остаётся на шее', () => {
  assert.equal(E.handedness(item('Священный символ', { type: 'gear' })), 'one');
  assert.equal(E.handedness(item('Инструменты каллиграфа', { type: 'gear' })), 'one');
  assert.equal(E.handedness(item('Амулет', { type: 'gear' })), 'none');
  assert.equal(E.wearKind(item('Амулет', { type: 'gear' })), 'neck');
});

test('зелья, свитки, боеприпасы и кошель не экипируются', () => {
  for (const it of [item('Зелье лечения', { type: 'consumable' }), item('Свиток огня', { type: 'consumable' }), item('Стрелы', { type: 'ammo' }), item('Поясной кошель', { type: 'gear' })])
    assert.equal(E.canEquip(it), false, it.name);
});

test('«Слоты по правилам» показывают пустые слоты и считают настройку', () => {
  const list = inv(item('Кольчуга', { type: 'armor', ac: '16' }), item('Кольцо защиты', { type: 'magic', ac: '+1', attunement: true, attuned: true }));
  E.equipDefaults(list);
  const audit = E.slotsAudit(sheetWith(list));
  assert.equal(audit.rows.length, 12);
  assert.equal(audit.rows.find(r => r.key === 'armor').items.length, 1);
  assert.equal(audit.rows.find(r => r.key === 'off').items.length, 0);
  assert.equal(audit.attuned, 1);
  assert.equal(audit.bad, 0);
});
