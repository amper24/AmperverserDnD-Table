const { test }=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx={window:{},crypto:require('node:crypto').webcrypto};vm.createContext(ctx);vm.runInContext(fs.readFileSync('static/mechanics.js','utf8'),ctx);const M=ctx.window.Mechanics;
const plain=x=>JSON.parse(JSON.stringify(x));
test('dice composer round trips healing without proficiency',()=>{assert.deepEqual(plain(M.dice('2d8+@spell_mod')),{count:2,sides:8,bonus:0,stat:'spell_mod'});assert.equal(M.expression(M.dice('2d8+@spell_mod')),'2d8+0+@spell_mod');assert.equal(M.dice('2d20kh1+@prof').advanced,'2d20kh1+@prof');});
test('legacy conversion preserves resource opt-out, explicit source and hand variants',()=>{const d={consume:{enabled:false,resource:'charges',target_uid:'staff',amount:2,trigger:'attack'},actions:[{kind:'attack',roll:'d20+@atk'},{kind:'damage',roll:'d10+@str',grip:'two'}]};const m=M.migrate(d);assert.equal(m.programs[0].blocks[0].enabled,false);assert.equal(m.programs[0].blocks[0].item_uid,'staff');assert.equal(m.programs[0].blocks[2].grip,'two');assert.equal(M.migrate(d),m);assert.equal(M.validate(m),'');});
test('validation rejects fractional spending, ungated branches, duplicate IDs and active passive blocks',()=>{const b=M.block('consume'),p={id:'p',name:'Use',trigger:'use',blocks:[b]},m={version:1,programs:[p]};assert.equal(M.validate(m),'');b.amount=1.5;assert.ok(M.validate(m));b.amount=1;b.when='hit';assert.ok(M.validate(m));b.when='always';p.blocks.push({...b});assert.ok(M.validate(m));p.blocks=[M.block('passive')];assert.ok(M.validate(m));});
test('passives project new values without mutating source or accumulating bonuses',()=>{const e={data:{speed:30,asi:{dex:2},mechanics:{version:1,programs:[{trigger:'passive',blocks:[{kind:'passive',field:'speed',value:40},{kind:'passive',field:'asi.dex',value:1}]}]}}};const next=M.passiveData(e);assert.equal(next.data.speed,40);assert.equal(next.data.asi.dex,1);assert.equal(e.data.speed,30);assert.equal(M.passiveData(next).data.asi.dex,1);});
test('all 2499 standard resources have valid block schemas and unique IDs',()=>{let count=0;for(const ed of ['2014','2024'])for(const e of JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`))){assert.equal(M.validate(e.data.mechanics),'',e.slug);count++;}assert.equal(count,2499);});
test('curated healing uses edition-correct dice; potions consume then heal then give vial',()=>{for(const ed of ['2014','2024']){const data=JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`));const spell=data.find(e=>e.category==='spell'&&e.data.name_en==='Cure Wounds');const blocks=spell.data.mechanics.programs[0].blocks;assert.equal(blocks[0].resource,'slot');const heal=blocks.find(b=>b.kind==='heal');assert.equal(heal.dice.count,ed==='2014'?1:2);assert.equal(heal.dice.stat,'spell_mod');const potion=data.find(e=>e.category==='item'&&e.data.mechanics.programs.some(p=>p.blocks.some(b=>b.kind==='grant_item')));assert.deepEqual(potion.data.mechanics.programs[0].blocks.map(b=>b.kind),['consume','heal','grant_item']);}});
test('monster extracted conditional dice never become one automatically executed attack',()=>{const data=JSON.parse(fs.readFileSync('data_seed/srd_2014.json'));const m=data.find(e=>e.category==='monster'&&e.data.name_en==='Aboleth').data.mechanics;assert.ok(m.programs.every(p=>p.blocks.filter(b=>b.dice).length<=1));assert.ok(m.programs.flatMap(p=>p.blocks).every(b=>b.apply!==true));});
test('standard ammo defaults conserve package weight and distinguish firearm resources',()=>{for(const ed of ['2014','2024']){const data=JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`));for(const e of data){const d=e.data.mechanics.item_defaults;if(!d)continue;assert.ok(Number.isInteger(d.qty)&&d.qty>1);assert.ok(Math.abs(d.qty*d.unit_weight-e.data.weight)<1e-9,e.slug);if(e.data.name_en==='Bullets, Firearm')assert.equal(d.ammo_tag,'firearm_bullet');}}});
test('named feature projection preserves mechanics without sharing mutable blocks',()=>{const m={version:1,programs:[{id:'rage',name:'Ярость',feature_name:'Ярость',trigger:'use',blocks:[{id:'b',kind:'manual',text:'Правило'}]},{id:'profile',name:'Параметры',trigger:'passive',blocks:[]}]};const f=M.forFeature(m,'Ярость');assert.equal(f.programs.length,1);f.programs[0].blocks[0].text='Изменено';assert.equal(m.programs[0].blocks[0].text,'Правило');assert.equal(M.forFeature(m,'Иное'),undefined);});
test('starter templates give race and class valid creation blocks that project into the entry',()=>{
  for(const cat of ['race','class','background']){
    const m=M.starter(cat);
    assert.equal(m.version,1,cat);
    assert.equal(M.validate(m),'',cat);
    assert.ok(m.programs.some(p=>p.trigger==='passive'&&p.blocks.some(b=>b.kind==='passive')),cat);
    assert.ok(m.programs.some(p=>p.trigger==='use'),cat);
  }
  assert.equal(M.starter('item'),undefined);
  const race=M.passiveData({data:{mechanics:M.starter('race')}});
  assert.equal(race.data.speed,30);assert.equal(race.data.asi.str,2);
  const cls=M.passiveData({data:{mechanics:M.starter('class')}});
  assert.equal(cls.data.hit_die,'d8');assert.deepEqual(JSON.parse(JSON.stringify(cls.data.saves)),['str']);assert.equal(cls.data.skills.choose,2);
});
