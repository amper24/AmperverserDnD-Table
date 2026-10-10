// Tests the real block editor in Chromium; API effects are tested separately on a live backend.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{let launch={headless:true};if(process.env.SPARTICUZ){const pkg=require('@sparticuz/chromium'),bin=pkg.default||pkg;launch={...launch,args:bin.args,executablePath:await bin.executablePath()};}const browser=await chromium.launch(launch);try{
 const page=await browser.newPage({viewport:{width:1250,height:1000}}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});
 await page.route('https://mechanics.test/**',route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/static/'))return route.fulfill({body:fs.readFileSync(path.join(process.cwd(),url.pathname)),contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript'});if(url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:'[]'});return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"><div id="app"></div>'+['common','dice','equipment','mechanics','asset-kinds','class-rules','modules','character-builder'].map(x=>`<script src="/static/${x}.js"></script>`).join('')});});
 await page.goto('https://mechanics.test/');await page.evaluate(()=>Consent.set(false));
 await page.evaluate(()=>{Modules.editItem(Modules.newItem({name:'Лечебный эликсир',type:'consumable',qty:3})).then(x=>window.saved=x);});
 await page.getByRole('button',{name:'Зелье → хиты → флакон',exact:true}).click();assert.equal(await page.locator('.mechanic-block').count(),3);
 assert.equal(await page.locator('.actions-editor').count(),0);
 await page.locator('.mechanic-block').nth(2).getByLabel('Количество',{exact:true}).fill('2');
 await page.locator('.mechanic-block').nth(2).getByRole('button',{name:'Блок выше',exact:true}).click();
 assert.match(await page.locator('.mechanic-block').nth(1).locator('header').innerText(),/Выдать предмет/);
 await page.locator('.mechanic-block').nth(1).getByRole('button',{name:'Блок ниже',exact:true}).click();
 await page.getByRole('button',{name:'Проверить цепочку',exact:true}).click();await page.getByRole('status').filter({hasText:'Структура корректна'}).waitFor();
 await page.getByRole('button',{name:'Сохранить',exact:true}).click();
 const saved=await page.evaluate(()=>window.saved);assert.equal(saved.qty,3);const potion=saved.mechanics.programs.find(p=>p.name==='Выпить зелье');assert.deepEqual(potion.blocks.map(b=>b.kind),['consume','heal','grant_item']);assert.equal(potion.blocks[2].amount,2);
 // All constructors share the same canvas, including non-item resource categories.
 for(const category of ['spell','feature','race','class','background','monster','condition','feat','npc','lore']){
  await page.evaluate(cat=>{const p=cat==='spell'?Modules.editSpell(null,{noPresets:true}):cat==='feature'?Modules.editFeature():Modules.editGeneric(null,cat);p.then(x=>window.generic=x);},category);
  assert.ok(await page.locator('.mechanics-editor').isVisible(),category);
  await page.getByRole('button',{name:'+ Действие',exact:true}).click();await page.getByRole('button',{name:'+ Ручное правило',exact:true}).click();
  assert.equal(await page.locator('.mechanic-block').count(),1,category);
  await page.getByRole('button',{name:'Отмена',exact:true}).click();
 }
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{Modules.editItem(window.saved);});
 assert.ok(await page.locator('.mechanics-editor').isVisible());
 assert.ok(await page.evaluate(()=>document.querySelector('.modal').scrollWidth<=document.querySelector('.modal').clientWidth+2),'mobile editor must not overflow');
 // The real sheet must send only a stored source/program reference, not execute effects client-side.
 await page.getByRole('button',{name:'Отмена',exact:true}).click();
 let sheet={_revision:0,name:'Алхимик',level:1,skills:[],saving_throws:[],expertise:[],conditions:[],death_saves:{success:0,failure:0},proficiency_bonus:2,ac:10,speed:30,abilities:{str:10,dex:10,con:10,int:14,wis:12,cha:10},hp:{current:2,max:20,temp:0},inventory:[{...saved,uid:'potion',qty:2,mechanics:{version:1,programs:[potion]}}]},requests=[];
 const character=()=>({id:'hero',name:'Алхимик',owner_id:'user',revision:sheet._revision,sheet:JSON.parse(JSON.stringify(sheet))});
 await page.route('https://mechanics.test/api/**',async route=>{
   const url=new URL(route.request().url()),req=route.request();const json=x=>route.fulfill({contentType:'application/json',body:JSON.stringify(x)});
   if(url.pathname==='/api/auth/me')return json({id:'user',name:'Игрок'});
   if(url.pathname==='/api/characters/hero'){
     if(req.method()==='PATCH'&&req.postDataJSON().sheet)sheet={...req.postDataJSON().sheet,_revision:sheet._revision+1};
     return json(character());
   }
   if(url.pathname==='/api/characters/hero/inventory'){
     const b=req.postDataJSON();requests.push(b);await new Promise(r=>setTimeout(r,150));assert.equal(b.op,'program');assert.equal(b.source_uid,'potion');assert.equal(b.program_id,potion.id);assert.equal(b.source_kind,'item');assert.equal(b.target_id,'hero');assert.equal(b.blocks,undefined);
     sheet.inventory[0].qty--;sheet.hp.current=9;sheet.inventory.push({uid:'vial',name:'Пустой флакон',type:'gear',qty:2,actions:[]});sheet._revision++;
     return json({character:character(),result:{label:'Зелье',rolls:[],spent:[{name:'Эликсир',amount:1,remaining:1}],effects:[{kind:'heal',amount:7,hp:sheet.hp},{kind:'grant_item',name:'Пустой флакон',amount:2}]}});
   }
   return json([]);
 });
 await page.route('https://mechanics.test/sheet/**',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync('static/sheet.html')}));
 await page.setViewportSize({width:1200,height:900});await page.goto('https://mechanics.test/sheet/hero');await page.evaluate(()=>Consent.set(false));await page.getByRole('button',{name:/Инвентарь/}).click();
 await page.locator('[data-uid="potion"] .act-btn').evaluate(b=>{b.click();b.click();});
 await page.waitForFunction(()=>document.querySelector('[data-uid="vial"]'));
 assert.equal(requests.length,1);assert.equal(sheet.inventory[0].qty,1);assert.equal(sheet.hp.current,9);
 assert.deepEqual(errors,[]);console.log('PASS mechanics browser: recipe, structured fields, reordering, validation, save, ten constructor categories, mobile layout, authoritative sheet program request, double-click guard');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
