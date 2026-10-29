const loadSrd = require('./fixtures/srd.cjs');
const { test }=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function node(tag,attrs={},...children){return {tag,attrs,children:children.flat().filter(x=>x!==null&&x!==undefined),classList:{add(){}},append(...more){this.children.push(...more.flat().filter(x=>x!==null&&x!==undefined));}};}
const ctx={window:{},crypto:require('node:crypto').webcrypto,el:node,toast(){}};vm.createContext(ctx);
// Шаблоны и стартовые программы читаются из наборов mechanic_templates / mechanic_starters.
const presetsReady=require('../tools/presets/node-loader.cjs').loadPresets(ctx);vm.runInContext(fs.readFileSync('static/dice.js','utf8'),ctx);vm.runInContext(fs.readFileSync('static/mechanics.js','utf8'),ctx);
// SRD хранится в графе v2; проверки ниже читают его план исполнения (toLegacy), то есть ту же логику, что редактор.
vm.runInContext(fs.readFileSync('static/formulas.js','utf8'),ctx);vm.runInContext(fs.readFileSync('static/node-params-form.js','utf8'),ctx);vm.runInContext(fs.readFileSync('static/node-registry.js','utf8'),ctx);require('../tools/nodes/node-loader.cjs').nodeFiles().forEach(f=>vm.runInContext(fs.readFileSync(f,'utf8'),ctx));vm.runInContext(fs.readFileSync('static/mechanics-graph.js','utf8'),ctx);const M=ctx.window.Mechanics,G=M;
// Данные справочника остаются графом v2; `plan` — его план исполнения для проверок блоков.
const srd=f=>loadSrd(f).map(e=>e.data?.mechanics?.version===2?{...e,data:{...e.data,plan:JSON.parse(JSON.stringify(G.toLegacy(e.data.mechanics)))}}:e);
const plain=x=>JSON.parse(JSON.stringify(x));
const v2node=(id,type,params={})=>({id,type,params,position:{x:0,y:0}});
const graphOf=(nodes,links=[])=>{const graph={nodes,links,frames:[],groups:[]};M.addFlowEnds(graph);return {version:2,graph};};
const program=(id='p',name='Действие',params={})=>v2node(id,'action.program',{program_id:id,name,trigger:'use',...params});
const wire=(from,fromSocket,to,toSocket)=>({from:{node:from,socket:fromSocket},to:{node:to,socket:toSocket}});
test('dice composer round trips healing without proficiency',()=>{assert.deepEqual(plain(M.dice('2d8+@spell_mod')),{count:2,sides:8,bonus:0,stat:'spell_mod'});assert.equal(M.expression(M.dice('2d8+@spell_mod')),'2d8+@spell_mod');assert.equal(M.dice('2d20kh1+@prof').advanced,'2d20kh1+@prof');});
test('each use program is one button: attack and damage in one program are a single chain, not two buttons',()=>{
  ctx.window.SHEET_CTX={};
  const attack=v2node('a','action.roll',{block_id:'a',kind:'attack',dice:M.dice('d20+5')});
  const damage=v2node('d','action.roll',{block_id:'d',kind:'damage',dice:M.dice('1d8+3')});
  const buttons=root=>{const all=[];const visit=n=>{if(!n||typeof n!=='object')return;if(n.tag==='button')all.push(n);(n.children||[]).forEach(visit);};visit(root);return all;};
  const pure=M.buttons({mechanics:graphOf([program('p','Удар'),attack,damage],[wire('p','exec','a','exec'),wire('a','exec','d','exec')])});
  assert.equal(buttons(pure).length,1);
  const consume=v2node('c','action.spend',{block_id:'c',resource:'quantity',source:'self',trigger:'use',amount:1});
  const extended=M.buttons({mechanics:graphOf([program('p2','Удар с расходом'),consume,attack,damage],[wire('p2','exec','c','exec'),wire('c','exec','a','exec'),wire('a','exec','d','exec')])});
  assert.equal(buttons(extended).length,1);
  const two=M.buttons({mechanics:graphOf([
    program('a1','Атака'),attack,program('d1','Урон'),damage,
  ],[wire('a1','exec','a','exec'),wire('d1','exec','d','exec')])});
  assert.equal(buttons(two).length,2,'две программы — две кнопки');
  const styled=M.buttons({mechanics:graphOf([program('s','Огнь',{style:'spell'}),damage],[wire('s','exec','d','exec')])});
  assert.match(buttons(styled)[0].attrs.class,/btn-style-spell/);
  const manual=v2node('m','action.manual',{block_id:'m',text:'Use it.'});
  const blocked=M.buttons({mechanics:graphOf([program('p3','Potion'),manual],[wire('p3','exec','m','exec')])},{disabled:true});
  assert.equal(blocked.children[0].attrs.disabled,'','item state disables activation controls');
});
test('v1 mechanics are rejected: no synthesis from old record fields',()=>{
  const v1={version:1,origin:'legacy',programs:[{id:'use',name:'Использовать',trigger:'use',blocks:[M.block('consume')]}]};
  assert.match(M.validate(v1),/Неподдерживаемая схема механик/);
  assert.deepEqual(plain(M.problems(v1)),['Неподдерживаемая схема механик.']);
  assert.equal(M.migrate,undefined);
  assert.equal(M.normalize,undefined);
  assert.equal(M.toGraph,undefined);
  assert.equal(M.forFeature(v1,'Использовать'),undefined);
});
test('validation rejects fractional spending, ungated branches, duplicate IDs and active passive blocks',()=>{
  const spend=v2node('c','action.spend',{block_id:'c',resource:'quantity',source:'self',trigger:'use',amount:1});
  const valid=graphOf([program(),spend],[wire('p','exec','c','exec')]);
  assert.equal(M.validate(valid),'');
  spend.params.amount=1.5; assert.ok(M.validate(valid));
  spend.params.amount=1; spend.params.resource='gold'; assert.ok(M.validate(valid),'неизвестный ресурс отклоняется');
  spend.params.resource='quantity'; spend.params.when='hit'; assert.ok(M.validate(valid));
  spend.params.when='always';
  assert.ok(M.validate(graphOf([program(),spend,v2node('c','action.manual',{block_id:'m'})],[wire('p','exec','c','exec')])),'повторяющийся ID узла отклоняется');
  const passive=v2node('x','action.field',{kind: 'formula',block_id:'x',field:'speed',value:40});
  assert.ok(M.validate(graphOf([program(),passive],[wire('p','exec','x','exec')])),'пассивный узел не живёт в действии');
});
test('every action node has enabled and condition inputs',()=>{
  const types=Object.keys(ctx.window.NodeRegistry.NODE_DEFS).filter(type=>type.startsWith('action.')&&type!=='action.program');
  assert.ok(types.length>=5,types.join(','));
  for(const type of types){
    assert.equal(ctx.window.NodeRegistry.NODE_DEFS[type].inputs.enabled,'bool',type);
    assert.equal(ctx.window.NodeRegistry.NODE_DEFS[type].inputs.condition,'bool',type);
  }
});
test('action.field projects status/value/formula into condition/adjust/passive blocks and rejects unknown kinds',()=>{
  const field=(params,programParams={})=>graphOf([program('p','Тест',programParams),v2node('f','action.field',{block_id:'f',...params})],[wire('p','exec','f','exec')]);
  assert.equal(M.validate(field({kind:'status',condition:'Отравленный',operation:'add'})),'');
  const status=plain(M.toLegacy(field({kind:'status',condition:'Отравленный',operation:'add'})).programs[0].blocks[0]);
  assert.equal(status.kind,'condition');assert.equal(status.condition,'Отравленный');assert.equal(status.operation,'add');assert.equal(status.field,undefined,'лишние поля вида в блок не попадают');
  const value=plain(M.toLegacy(field({kind:'value',field:'speed',amount:5})).programs[0].blocks[0]);
  assert.equal(value.kind,'adjust');assert.equal(value.field,'speed');assert.equal(value.amount,5);
  const formula=plain(M.toLegacy(field({kind:'formula',field:'asi.str',value:2},{trigger:'passive'})).programs[0].blocks[0]);
  assert.equal(formula.kind,'passive');assert.equal(formula.field,'asi.str');assert.equal(formula.value,2);
  assert.match(M.validate(field({kind:'unknown',field:'speed'})),/вид status, value или formula/);
});
test('condition=false skips the block and the flow continues; true runs it',()=>{
  const build=value=>{
    const field=v2node('f','action.field',{block_id:'f',kind:'value',field:'speed',amount:5});
    const bool=v2node('b','data.boolean',{value});
    const manual=v2node('m','action.manual',{block_id:'m',text:'После условия'});
    return graphOf([program(),field,manual,bool],[wire('p','exec','f','exec'),wire('f','exec','m','exec'),wire('b','value','f','condition')]);
  };
  // Предпросмотр на клиенте по-прежнему статический: data.result/data.sheet без состояния дают 0.
  const skipped=build(false);
  assert.equal(M.validate(skipped),'');
  assert.deepEqual(plain(M.toLegacy(skipped).programs[0].blocks.map(block=>block.kind)),['manual'],'выключенный блок пропущен, поток идёт дальше');
  assert.deepEqual(plain(M.toLegacy(build(true)).programs[0].blocks.map(block=>block.kind)),['adjust','manual'],'включённый блок выполняется');
});
test('advanced dice formulas are validated at save time, including stat variables',()=>{
  const damage=v2node('d','action.roll',{block_id:'d',kind:'damage',dice:{...M.dice('2d6'),advanced:'2d6+@str'}});
  const m=graphOf([program(),damage],[wire('p','exec','d','exec')]);
  assert.equal(M.validate(m),'');
  damage.params.dice.advanced='2d6++4'; assert.match(M.validate(m),/формула кубов/i);
});
test('passives project new values without mutating source or accumulating bonuses',()=>{
  const m=graphOf([program('p','Параметры',{trigger:'passive'}),
    v2node('s','action.field',{kind: 'formula',block_id:'s',field:'speed',value:40}),
    v2node('d','action.field',{kind: 'formula',block_id:'d',field:'asi.dex',value:1})],
  [wire('p','exec','s','exec'),wire('p','exec','d','exec')]);
  const e={data:{speed:30,asi:{dex:2},mechanics:m}};
  const next=M.passiveData(e);assert.equal(next.data.speed,40);assert.equal(next.data.asi.dex,1);
  assert.equal(e.data.speed,30);assert.equal(M.passiveData(next).data.asi.dex,1);
});
test('full SRD coverage: all 2499 records across categories, optional item mechanics validate when present',()=>{
  let count=0;
  const expected={2014:{total:1294,item:599,attunement:176},2024:{total:1205,item:444,attunement:136}};
  for(const ed of ['2014','2024']){
    const data=srd(`data_seed/srd_${ed}.json`);
    assert.equal(data.length,expected[ed].total,ed);
    assert.equal(data.filter(e=>e.category==='item').length,expected[ed].item,ed);
    assert.equal(data.filter(e=>e.category==='item'&&e.data.attunement===true).length,expected[ed].attunement,ed+' attunement');
    for(const e of data){
      if(e.data.mechanics) assert.equal(M.validate(e.data.mechanics),'',e.slug);
      if(e.category==='item') for(const p of e.data.plan?.programs||[]) assert.ok(p.blocks.length,`${e.slug}: нет пустых программ`);
      count++;
    }
  }
  assert.equal(count,2499);
  const passive=srd('data_seed/srd_2014.json').find(e=>e.slug==='srd14-backpack');
  assert.equal(passive.data.mechanics,undefined,'пассивное снаряжение не получает фиктивные правила использования');
});
test('curated healing: potion expenditure is separate from a target-applied healing roll',()=>{
  for(const ed of ['2014','2024']){
    const data=srd(`data_seed/srd_${ed}.json`);
    const spell=data.find(e=>e.category==='spell'&&e.data.name_en==='Cure Wounds');
    const blocks=spell.data.plan.programs[0].blocks;
    const slot=blocks.find(b=>b.kind==='consume');
    assert.ok(slot&&slot.resource==='slot'&&slot.slot_level===0,'ячейку выбирает игрок, а списывает действие');
    assert.ok(!blocks.some(b=>b.kind==='heal'));
    const roll=blocks.find(b=>b.kind==='roll');
    assert.equal(roll.name,'Лечение');assert.equal(roll.dice.count,ed==='2014'?1:2);assert.equal(roll.dice.sides,8);assert.equal(roll.dice.stat,'spell_mod');
    assert.ok(blocks.some(b=>b.kind==='manual'&&/применяет ДМ/.test(b.text||'')));
    const potionSlug=ed==='2014'?'srd14-potion-of-healing-common':'srd24-potion-of-healing';
    const potion=data.find(e=>e.slug===potionSlug), pblocks=potion.data.plan.programs[0].blocks;
    assert.deepEqual(pblocks.map(b=>b.kind),['consume','manual','roll']);
    assert.equal(pblocks[2].dice.advanced,undefined);
    assert.equal(pblocks[2].dice.count,ed==='2014'?2:2);assert.equal(pblocks[2].dice.sides,4);assert.equal(pblocks[2].dice.bonus,2);
    assert.ok(!pblocks.some(b=>['heal','grant_item'].includes(b.kind)));
    if(ed==='2014')assert.match(pblocks[1].text,/требует действия/);
    else assert.match(pblocks[1].text,/бонусным действием/i);
  }
  const legacy=srd('data_seed/srd_2014.json');
  for(const slug of ['srd14-potion-of-healing','srd14-spell-scroll','srd14-feather-token','srd14-ring-of-elemental-command']){
    const family=legacy.find(e=>e.slug===slug);assert.ok(family);assert.equal(family.data.mechanics,undefined,slug);
  }
  const family24=srd('data_seed/srd_2024.json').find(e=>e.slug==='srd24-potions-of-healing');
  if(family24)assert.equal(family24.data.mechanics,undefined);
});
test('charge automation is limited to one explicit fixed cost; variable costs stay manual',()=>{
  const data=srd('data_seed/srd_2014.json');
  const data24=srd('data_seed/srd_2024.json');
  const find=(rows,slug)=>rows.find(e=>e.slug===slug);
  const blocks=(rows,slug)=>find(rows,slug).data.plan.programs[0].blocks;
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
  const d14=srd('data_seed/srd_2014.json');
  const d24=srd('data_seed/srd_2024.json');
  // Атака и урон — две программы (кнопки): блоки проверяем по всем программам предмета.
  const dartPrograms=d14.find(e=>e.slug==='srd14-dart').data.plan.programs;
  assert.deepEqual(dartPrograms.map(p=>p.name),['Атака','Урон']);
  const dart=dartPrograms.flatMap(p=>p.blocks);
  assert.equal(dart.find(b=>b.kind==='attack').dice.stat,'atk');
  assert.equal(dart.find(b=>b.kind==='damage').dice.stat,'best');
  const net14=d14.find(e=>e.slug==='srd14-net').data.plan.programs.flatMap(p=>p.blocks);
  assert.deepEqual(net14.map(b=>b.kind),['attack','manual']);
  assert.match(net14[1].text,/Опутан/);
  const net24=d24.find(e=>e.slug==='srd24-net').data.plan.programs.flatMap(p=>p.blocks);
  assert.deepEqual(net24.map(b=>b.kind),['manual']);
  assert.match(net24[0].text,/спасброске Ловкости/);
  const lance=d14.find(e=>e.slug==='srd14-lance').data.plan.programs.flatMap(p=>p.blocks);
  assert.ok(lance.some(b=>b.kind==='manual'&&/помехой/.test(b.text||'')));
});
test('no standard entry targets another character: weapons and conditions are owner-side',()=>{for(const ed of ['2014','2024']){for(const e of srd(`data_seed/srd_${ed}.json`)){for(const p of e.data.plan?.programs||[])for(const b of p.blocks){assert.ok(b.target!=='target',`${e.slug}: цель «${b.target}»`);if(['heal','temp_hp','condition','adjust','grant_item'].includes(b.kind))assert.equal(b.target,'self',`${e.slug}/${b.kind}`);if(['attack','damage','roll'].includes(b.kind))assert.equal(b.apply,undefined,`${e.slug}/${b.kind}`);}}}});
test('monster extracted conditional dice never become one automatically executed attack',()=>{const data=srd('data_seed/srd_2014.json');const m=data.find(e=>e.category==='monster'&&e.data.name_en==='Aboleth').data.plan;assert.ok(m.programs.every(p=>p.blocks.filter(b=>b.dice).length<=1));assert.ok(m.programs.flatMap(p=>p.blocks).every(b=>b.apply!==true));});
test('standard ammo defaults conserve package weight and distinguish firearm resources',()=>{for(const ed of ['2014','2024']){const data=srd(`data_seed/srd_${ed}.json`);for(const e of data){const d=e.data.mechanics?.item_defaults;if(!d)continue;assert.ok(Number.isInteger(d.qty)&&d.qty>1);assert.ok(Math.abs(d.qty*d.unit_weight-e.data.weight)<1e-9,e.slug);if(e.data.name_en==='Bullets, Firearm')assert.equal(d.ammo_tag,'firearm_bullet');}}});
test('named feature projection returns a v2 subgraph without sharing mutable nodes',()=>{
  const rule=v2node('b','action.manual',{block_id:'b',text:'Правило'});
  const m=graphOf([program('rage','Ярость',{feature_name:'Ярость'}),rule,program('profile','Параметры',{trigger:'passive'})],
    [wire('rage','exec','b','exec')]);
  const f=M.forFeature(m,'Ярость');
  assert.equal(f.version,2);
  assert.deepEqual(plain(f.graph.nodes.filter(n=>n.type==='action.program').map(n=>n.params.program_id)),['rage']);
  assert.deepEqual(plain(f.graph.nodes.filter(n=>n.type==='action.manual').map(n=>n.params.text)),['Правило']);
  f.graph.nodes.find(n=>n.type==='action.manual').params.text='Изменено';
  assert.equal(m.graph.nodes.find(n=>n.id==='b').params.text,'Правило');
  assert.equal(M.forFeature(m,'Иное'),undefined);
  assert.equal(M.forFeature({version:1,programs:[]},'Ярость'),undefined);
});
test('starter templates give race and class valid creation blocks that project into the entry',async()=>{
  await presetsReady;
  for(const cat of ['race','class','background']){
    const m=G.starter(cat);
    assert.equal(m.version,2,cat);
    assert.equal(G.validate(m),'',cat);
    const v1=G.toLegacy(m);
    assert.ok(v1.programs.some(p=>p.trigger==='passive'&&p.blocks.some(b=>b.kind==='passive')),cat);
    assert.ok(v1.programs.some(p=>p.trigger==='use'),cat);
  }
  assert.equal(G.starter('item'),undefined);
  const race=G.passiveData({data:{mechanics:G.starter('race')}});
  assert.equal(race.data.speed,30);assert.equal(race.data.asi.str,2);
  const cls=G.passiveData({data:{mechanics:G.starter('class')}});
  assert.equal(cls.data.hit_die,'d8');assert.deepEqual(JSON.parse(JSON.stringify(cls.data.saves)),['str']);assert.equal(cls.data.skills.choose,2);
});
test('template library builds valid programs and keeps creation templates apart',async()=>{
  await presetsReady;
  const ids=c=>M.templates(c).map(t=>t.id);
  for(const cat of ['item','spell','feature','monster','race','class','background']){
    const list=M.templates(cat);
    assert.ok(list.length>=8,cat+': '+list.length);
    for(const t of list){
      const p=t.build();
      assert.ok(p.name&&p.blocks.length,cat+' / '+t.id);
      assert.ok(t.hint&&t.chain.length,cat+' / '+t.id);
      const graph=ctx.window.Presets.item('mechanic_templates',t.id).table.graph;
      assert.equal(M.validate(graphOf(graph.nodes,graph.links)),'',cat+' / '+t.id);
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
test('blocks never target another character: damage is a roll, a save is a GM rule',()=>{
  const b=M.block('damage'), a=M.block('attack'), h=M.block('heal'), c=M.block('condition');
  assert.equal(b.target,undefined); assert.equal(b.apply,undefined);
  assert.equal(a.target,undefined); assert.equal(a.apply,undefined);
  assert.equal(h.target,'self'); assert.equal(h.apply,true);
  assert.equal(c.target,'self');
  // Спасбросок цели — обычное ручное правило узла, а не автоматически созданный блок.
  const rule='Спасбросок (ЛОВ): бросает цель или ДМ, а не игрок. СЛ 15 из записи.';
  const m=graphOf([program('p','Пламя'),v2node('s','action.manual',{block_id:'s',text:rule}),v2node('d','action.roll',{block_id:'d',kind:'damage',dice:M.dice('8d6')})],
    [wire('p','exec','s','exec'),wire('s','exec','d','exec')]);
  assert.equal(M.validate(m),'');
  const blocks=plain(M.toLegacy(m).programs[0].blocks);
  assert.deepEqual(blocks.map(block=>block.kind),['manual','damage']);
  assert.equal(blocks[0].text,rule,'правило передаётся как есть');
  assert.equal(blocks[0].dice,undefined,'игроку не остаётся бросок d20');
  assert.equal(blocks[1].when,undefined);
  assert.match(M.validate({version:1,programs:[{id:'p',name:'Пламя',trigger:'use',blocks:[{id:'s',kind:'save',ability:'dex',dc:15}]}]}),/Неподдерживаемая схема механик/);
  assert.equal(M.normalize,undefined);
});
