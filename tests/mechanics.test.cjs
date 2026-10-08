const { test }=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function node(tag,attrs={},...children){return {tag,attrs,children:children.flat().filter(x=>x!==null&&x!==undefined),classList:{add(){}},append(...more){this.children.push(...more.flat().filter(x=>x!==null&&x!==undefined));}};}
const ctx={window:{},crypto:require('node:crypto').webcrypto,el:node,toast(){}};vm.createContext(ctx);vm.runInContext(fs.readFileSync('static/dice.js','utf8'),ctx);vm.runInContext(fs.readFileSync('static/mechanics.js','utf8'),ctx);const M=ctx.window.Mechanics;
const plain=x=>JSON.parse(JSON.stringify(x));
test('dice composer round trips healing without proficiency',()=>{assert.deepEqual(plain(M.dice('2d8+@spell_mod')),{count:2,sides:8,bonus:0,stat:'spell_mod'});assert.equal(M.expression(M.dice('2d8+@spell_mod')),'2d8+0+@spell_mod');assert.equal(M.dice('2d20kh1+@prof').advanced,'2d20kh1+@prof');});
test('pure attack plus damage shows only hit and damage buttons; extra blocks keep the full-action button',()=>{
  ctx.window.Modules={attackRow:(name,hit,damage)=>node('div',{class:'attack-row'},node('button',{},'Попадание'),node('button',{},'Урон'))};
  ctx.window.SHEET_CTX={};
  const pair=[{id:'a',kind:'attack',dice:M.dice('d20+5')},{id:'d',kind:'damage',dice:M.dice('1d8+3')}];
  const buttons=root=>{const all=[];const visit=n=>{if(!n||typeof n!=='object')return;if(n.tag==='button')all.push(n);(n.children||[]).forEach(visit);};visit(root);return all;};
  const pure=M.buttons({mechanics:{programs:[{id:'p',name:'Удар',trigger:'use',blocks:pair}]}});
  assert.equal(buttons(pure).length,2);
  const extended=M.buttons({mechanics:{programs:[{id:'p2',name:'Удар с расходом',trigger:'use',blocks:[{id:'c',kind:'consume'},...pair]}]}});
  assert.equal(buttons(extended).length,3);
  const blocked=M.buttons({mechanics:{programs:[{id:'p3',name:'Potion',trigger:'use',blocks:[{id:'m',kind:'manual',text:'Use it.'}]}]}},{disabled:true});
  assert.equal(blocked.children[0].attrs.disabled,'','item state disables activation controls');
});
test('legacy item prose alone does not create an empty activation; explicit legacy rolls remain',()=>{
  const passive={name:'Backpack',desc:'A container for adventuring equipment.'};
  const m=M.migrate(passive,'item');
  assert.deepEqual(plain(m.programs),[]);
  assert.equal(M.buttons(passive).children.length,0);
  const active={name:'Potion',desc:'Drink to restore hit points.',consume:{enabled:true,resource:'quantity',target_uid:'self',amount:1},actions:[]};
  assert.deepEqual(plain(M.migrate(active,'item').programs[0].blocks.map(b=>b.kind)),['consume']);
});
test('legacy conversion preserves resource opt-out, explicit source and hand variants',()=>{const d={consume:{enabled:false,resource:'charges',target_uid:'staff',amount:2,trigger:'attack'},actions:[{kind:'attack',roll:'d20+@atk'},{kind:'damage',roll:'d10+@str',grip:'two'}]};const m=M.migrate(d);assert.equal(m.programs[0].blocks[0].enabled,false);assert.equal(m.programs[0].blocks[0].item_uid,'staff');assert.equal(m.programs[0].blocks[2].grip,'two');assert.equal(M.migrate(d),m);assert.equal(M.validate(m),'');});
test('validation rejects fractional spending, ungated branches, duplicate IDs and active passive blocks',()=>{const b=M.block('consume'),p={id:'p',name:'Use',trigger:'use',blocks:[b]},m={version:1,programs:[p]};assert.equal(M.validate(m),'');b.amount=1.5;assert.ok(M.validate(m));b.amount=1;b.when='hit';assert.ok(M.validate(m));b.when='always';p.blocks.push({...b});assert.ok(M.validate(m));p.blocks=[M.block('passive')];assert.ok(M.validate(m));});
test('advanced dice formulas are validated at save time, including stat variables',()=>{const b=M.block('damage');b.dice.advanced='2d6+@str';const m={version:1,programs:[{id:'p',name:'Damage',trigger:'use',blocks:[b]}]};assert.equal(M.validate(m),'');b.dice.advanced='2d6++4';assert.match(M.validate(m),/формула кубов/i);});
test('passives project new values without mutating source or accumulating bonuses',()=>{const e={data:{speed:30,asi:{dex:2},mechanics:{version:1,programs:[{trigger:'passive',blocks:[{kind:'passive',field:'speed',value:40},{kind:'passive',field:'asi.dex',value:1}]}]}}};const next=M.passiveData(e);assert.equal(next.data.speed,40);assert.equal(next.data.asi.dex,1);assert.equal(e.data.speed,30);assert.equal(M.passiveData(next).data.asi.dex,1);});
test('full SRD coverage: all 2499 records across categories, optional item mechanics validate when present',()=>{
  let count=0;
  const expected={2014:{total:1294,item:599,attunement:176},2024:{total:1205,item:444,attunement:136}};
  for(const ed of ['2014','2024']){
    const data=JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`));
    assert.equal(data.length,expected[ed].total,ed);
    assert.equal(data.filter(e=>e.category==='item').length,expected[ed].item,ed);
    assert.equal(data.filter(e=>e.category==='item'&&e.data.attunement===true).length,expected[ed].attunement,ed+' attunement');
    for(const e of data){
      if(e.data.mechanics) assert.equal(M.validate(e.data.mechanics),'',e.slug);
      if(e.category==='item') for(const p of e.data.mechanics?.programs||[]) assert.ok(p.blocks.length,`${e.slug}: нет пустых программ`);
      count++;
    }
  }
  assert.equal(count,2499);
  const passive=JSON.parse(fs.readFileSync('data_seed/srd_2014.json')).find(e=>e.slug==='srd14-backpack');
  assert.equal(passive.data.mechanics,undefined,'пассивное снаряжение не получает фиктивные правила использования');
});
test('curated healing: potion expenditure is separate from a target-applied healing roll',()=>{
  for(const ed of ['2014','2024']){
    const data=JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`));
    const spell=data.find(e=>e.category==='spell'&&e.data.name_en==='Cure Wounds');
    const blocks=spell.data.mechanics.programs[0].blocks;
    assert.equal(blocks[0].resource,'slot');
    assert.ok(!blocks.some(b=>b.kind==='heal'));
    const roll=blocks.find(b=>b.kind==='roll');
    assert.equal(roll.name,'Лечение');assert.equal(roll.dice.count,ed==='2014'?1:2);assert.equal(roll.dice.sides,8);assert.equal(roll.dice.stat,'spell_mod');
    assert.ok(blocks.some(b=>b.kind==='manual'&&/применяет ДМ/.test(b.text||'')));
    const potionSlug=ed==='2014'?'srd14-potion-of-healing-common':'srd24-potion-of-healing';
    const potion=data.find(e=>e.slug===potionSlug), pblocks=potion.data.mechanics.programs[0].blocks;
    assert.deepEqual(pblocks.map(b=>b.kind),['consume','manual','roll']);
    assert.equal(pblocks[2].dice.advanced,undefined);
    assert.equal(pblocks[2].dice.count,ed==='2014'?2:2);assert.equal(pblocks[2].dice.sides,4);assert.equal(pblocks[2].dice.bonus,2);
    assert.ok(!pblocks.some(b=>['heal','grant_item'].includes(b.kind)));
    if(ed==='2014')assert.match(pblocks[1].text,/требует действия/);
    else assert.match(pblocks[1].text,/бонусным действием/i);
  }
  const legacy=JSON.parse(fs.readFileSync('data_seed/srd_2014.json'));
  for(const slug of ['srd14-potion-of-healing','srd14-spell-scroll','srd14-feather-token','srd14-ring-of-elemental-command']){
    const family=legacy.find(e=>e.slug===slug);assert.ok(family);assert.equal(family.data.mechanics,undefined,slug);
  }
  const family24=JSON.parse(fs.readFileSync('data_seed/srd_2024.json')).find(e=>e.slug==='srd24-potions-of-healing');
  if(family24)assert.equal(family24.data.mechanics,undefined);
});
test('charge automation is limited to one explicit fixed cost; variable costs stay manual',()=>{
  const data=JSON.parse(fs.readFileSync('data_seed/srd_2014.json'));
  const data24=JSON.parse(fs.readFileSync('data_seed/srd_2024.json'));
  const find=(rows,slug)=>rows.find(e=>e.slug===slug);
  const blocks=(rows,slug)=>find(rows,slug).data.mechanics.programs[0].blocks;
  const hasChargeSpend=bs=>bs.some(b=>b.kind==='consume'&&b.resource==='charges');
  const fixed=blocks(data,'srd14-cubic-gate').find(b=>b.kind==='consume');
  assert.equal(fixed.resource,'charges');assert.equal(fixed.amount,1);
  for(const slug of ['srd14-ring-of-elemental-command-air','srd14-wand-of-fireballs','srd14-wand-of-binding','srd14-staff-of-swarming-insects']){
    const variable=blocks(data,slug);
    assert.ok(!hasChargeSpend(variable),slug);
    assert.ok(variable.some(b=>b.kind==='manual'&&/спишите.*вручную/i.test(b.text||'')),slug);
  }
  for(const slug of ['srd24-staff-of-charming','srd24-staff-of-the-woodlands'])
    assert.ok(!hasChargeSpend(blocks(data24,slug)),slug);
  const fixedUse=blocks(data,'srd14-gem-of-seeing');
  assert.ok(hasChargeSpend(fixedUse),'a single explicit fixed charge cost remains automated');
});
test('item rules preserve finesse and edition-specific net procedures without invented rolls',()=>{
  const d14=JSON.parse(fs.readFileSync('data_seed/srd_2014.json'));
  const d24=JSON.parse(fs.readFileSync('data_seed/srd_2024.json'));
  const dart=d14.find(e=>e.slug==='srd14-dart').data.mechanics.programs[0].blocks;
  assert.equal(dart.find(b=>b.kind==='attack').dice.stat,'atk');
  assert.equal(dart.find(b=>b.kind==='damage').dice.stat,'best');
  const net14=d14.find(e=>e.slug==='srd14-net').data.mechanics.programs[0].blocks;
  assert.deepEqual(net14.map(b=>b.kind),['attack','manual']);
  assert.match(net14[1].text,/Опутан/);
  const net24=d24.find(e=>e.slug==='srd24-net').data.mechanics.programs[0].blocks;
  assert.deepEqual(net24.map(b=>b.kind),['manual']);
  assert.match(net24[0].text,/спасброске Ловкости/);
  const lance=d14.find(e=>e.slug==='srd14-lance').data.mechanics.programs[0].blocks;
  assert.ok(lance.some(b=>b.kind==='manual'&&/помехой/.test(b.text||'')));
});
test('no standard entry targets another character: weapons and conditions are owner-side',()=>{for(const ed of ['2014','2024']){for(const e of JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`))){for(const p of e.data.mechanics?.programs||[])for(const b of p.blocks){assert.ok(b.target!=='target',`${e.slug}: цель «${b.target}»`);if(['heal','temp_hp','condition','adjust','grant_item'].includes(b.kind))assert.equal(b.target,'self',`${e.slug}/${b.kind}`);if(['attack','damage','roll'].includes(b.kind))assert.equal(b.apply,undefined,`${e.slug}/${b.kind}`);}}}});
test('monster extracted conditional dice never become one automatically executed attack',()=>{const data=JSON.parse(fs.readFileSync('data_seed/srd_2014.json'));const m=data.find(e=>e.category==='monster'&&e.data.name_en==='Aboleth').data.mechanics;assert.ok(m.programs.every(p=>p.blocks.filter(b=>b.dice).length<=1));assert.ok(m.programs.flatMap(p=>p.blocks).every(b=>b.apply!==true));});
test('standard ammo defaults conserve package weight and distinguish firearm resources',()=>{for(const ed of ['2014','2024']){const data=JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`));for(const e of data){const d=e.data.mechanics?.item_defaults;if(!d)continue;assert.ok(Number.isInteger(d.qty)&&d.qty>1);assert.ok(Math.abs(d.qty*d.unit_weight-e.data.weight)<1e-9,e.slug);if(e.data.name_en==='Bullets, Firearm')assert.equal(d.ammo_tag,'firearm_bullet');}}});
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
test('template library builds valid programs and keeps creation templates apart',()=>{
  const ids=c=>M.templates(c).map(t=>t.id);
  for(const cat of ['item','spell','feature','monster','race','class','background']){
    const list=M.templates(cat);
    assert.ok(list.length>=8,cat+': '+list.length);
    for(const t of list){
      const p=t.build();
      assert.ok(p.name&&p.blocks.length,cat+' / '+t.id);
      assert.ok(t.hint&&t.chain.length,cat+' / '+t.id);
      const m={version:1,programs:[{id:'x',name:p.name,trigger:p.trigger||'use',blocks:p.blocks}]};
      assert.equal(M.validate(m),'',cat+' / '+t.id);
      const again=t.build();assert.notEqual(again.blocks[0].id,p.blocks[0].id,'each template build gets fresh ids');
    }
  }
  assert.ok(!ids('item').some(id=>ids('race').includes(id)),'creation templates are separate');
  for(const id of ['asi','skills','saves','hit_die','spellcasting','languages','feature'])assert.ok(ids('race').includes(id),id);
  assert.ok(ids('item').includes('potion')&&ids('item').includes('weapon')&&ids('item').includes('area_damage'));
  // Блок «спасбросок цели» убран: в палитре его нет, а урон по площади — своё действие.
  assert.ok(!ids('item').includes('save_damage'));
  for(const cat of ['item','spell','feature','monster']) assert.ok(!M.templates(cat).some(t=>(t.chain||[]).includes('save')),cat);
});
test('blocks never target another character: damage and saves are custom actions',()=>{
  const b=M.block('damage'), a=M.block('attack'), h=M.block('heal');
  assert.equal(b.target,undefined); assert.equal(b.apply,undefined);
  assert.equal(a.target,undefined); assert.equal(a.apply,undefined);
  assert.equal(h.target,'self'); assert.equal(h.apply,true);
  // Старый блок спасброска цели превращается в своё действие с правилом для ДМ.
  const legacy={version:1,programs:[{id:'p',name:'Пламя',trigger:'use',blocks:[{id:'s',kind:'save',when:'always',ability:'dex',dc:15},{id:'d',kind:'damage',when:'hit',target:'target',apply:true,dice:M.dice('8d6')}]}]};
  const m=M.normalize(legacy);
  assert.equal(m.programs[0].blocks[0].kind,'roll');
  assert.match(m.programs[0].blocks[0].text,/Спасбросок|СЛ 15/);
  assert.equal(m.programs[0].blocks[1].when,'always','ветвление без атаки больше не держится на спасбросоке');
  assert.equal(m.programs[0].blocks[1].target,undefined);
  assert.equal(M.validate(m),'');
  // Эффекты всегда идут владельцу листа, даже если в старых данных указана цель.
  const heal={version:1,programs:[{id:'p',name:'Лечение',trigger:'use',blocks:[{id:'h',kind:'heal',target:'target',dice:M.dice('1d8')},{id:'c',kind:'condition',target:'target',condition:'Отравленный',operation:'add'}]}]};
  const n=M.normalize(heal);
  assert.deepEqual(n.programs[0].blocks.map(b=>b.target),['self','self']);
  assert.equal(M.validate(n),'');
});
