const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(fs.readFileSync('static/equipment.js','utf8'),ctx);
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
