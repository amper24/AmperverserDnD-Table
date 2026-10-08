// UI integration with a deterministic API fixture; server transaction tests live in inventory-api.py.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
  let launch={headless:true};if(process.env.SPARTICUZ){const pkg=require('@sparticuz/chromium'),bin=pkg.default||pkg;launch={...launch,args:bin.args,executablePath:await bin.executablePath()};}
  const browser=await chromium.launch(launch);
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900},reducedMotion:'reduce'}), errors=[];page.on('pageerror',e=>errors.push(e.message));
    let sheet={_revision:0,name:'Следопыт',level:1,race:'Эльф',class:'Воин',abilities:{str:12,dex:16,con:14,int:10,wis:13,cha:8},skills:[],expertise:[],saving_throws:[],proficiency_bonus:2,hp:{current:12,max:12,temp:0,hit_dice:'1d10'},ac:13,speed:30,death_saves:{success:0,failure:0},conditions:[],auto_armor:true,inventory:[
      {uid:'bow',name:'Длинный лук',type:'weapon',qty:1,properties:['Двуручное','Боеприпас'],actions:[{name:'Атака',kind:'attack',roll:'d20+@atk_dex'},{name:'Урон',kind:'damage',roll:'d8+@dex'}]},
      {uid:'arrows',name:'Стрелы',type:'ammo',qty:3,actions:[]}
    ]}; const ops=[]; let concurrentSave = false;
    const character=()=>({id:'hero',name:sheet.name,owner_id:'user',revision:sheet._revision,sheet:JSON.parse(JSON.stringify(sheet))});
    await page.route('https://equipment.test/**',async route=>{
      const url=new URL(route.request().url()), req=route.request();
      const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(url.pathname.startsWith('/static/')) {const f=path.join(process.cwd(),url.pathname);return route.fulfill({body:fs.readFileSync(f),contentType:f.endsWith('.css')?'text/css':'text/javascript'});}
      if(url.pathname.startsWith('/sheet/')) return route.fulfill({contentType:'text/html',body:fs.readFileSync('static/sheet.html')});
      if(url.pathname==='/api/auth/me') return json({id:'user',name:'Игрок'});
      if(url.pathname==='/api/characters/hero'){
        if(req.method()==='PATCH') {const b=req.postDataJSON();if(b.sheet){assert.equal(b.sheet._revision,sheet._revision);sheet={...b.sheet,_revision:sheet._revision+1}; if (concurrentSave) { concurrentSave = false; sheet._revision++; sheet.inventory[1].qty--; }}}
        return json(character());
      }
      if(url.pathname==='/api/characters/hero/inventory'){
        const b=req.postDataJSON();ops.push(b);await new Promise(r=>setTimeout(r,200));const item=sheet.inventory.find(i=>i.uid===b.item_uid);let result={};
        if(b.op==='equip'){item.equipped=b.slot!=='backpack';item.hand_slot=item.equipped?b.slot:null;}
        if(b.op==='use'){
          assert.deepEqual(b.actions,[0,1]);sheet.inventory.find(i=>i.uid==='arrows').qty--;result={label:'Лук',rolls:[{name:'Атака',expr:'d20+5',kind:'attack',total:15,parts:[{term:'d20',sides:20,rolls:[10],kept:[10]},{term:'+5',value:5}]}],spent:[{name:'Стрелы',amount:1,remaining:2}]};
        }
        sheet._revision++;return json({character:character(),result});
      }
      return json([]);
    });
    await page.goto('https://equipment.test/sheet/hero'); await page.evaluate(() => Consent.set(false));
    const levelInput = page.locator('.level-value-row input');
    const levelButton = page.getByRole('button', { name: 'Повысить уровень' });
    await page.waitForSelector('.level-value-row .lvlup-btn');
    assert.equal(await levelButton.count(), 1);
    const levelBox = await levelInput.boundingBox(), levelActionBox = await levelButton.boundingBox();
    assert.ok(Math.abs(levelBox.y - levelActionBox.y) < 2, 'level-up action sits beside the level value, not on a detached row');
    assert.ok(levelActionBox.x >= levelBox.x + levelBox.width, 'level-up action is aligned after the number input');

    await page.getByRole('button',{name:/Инвентарь/}).click();
    const equipmentSlots = page.locator('.inv .equipment-hands .hand-slot');
    assert.equal(await equipmentSlots.count(), 3, 'main hand, off hand, and armor share one slot row');
    const slotBoxes = await equipmentSlots.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
    assert.ok(slotBoxes.every(box => Math.abs(box.y - slotBoxes[0].y) < 2), 'armor stays on the hand-slot row');
    assert.ok(slotBoxes[0].x < slotBoxes[1].x && slotBoxes[1].x < slotBoxes[2].x, 'the armor card follows both hand cards');
    const slotStyles = await equipmentSlots.evaluateAll(nodes => nodes.map(n => { const s = getComputedStyle(n); return [s.padding, s.borderRadius, s.backgroundColor, s.borderColor]; }));
    assert.deepEqual(slotStyles[2], slotStyles[0], 'armor uses the same card style as hand slots');

    await page.getByLabel('Основная рука',{exact:true}).selectOption('bow');
    await page.waitForFunction(()=>document.querySelectorAll('.hand-slot.filled').length===2&&!document.querySelector('.sheet').inert);
    assert.equal(ops[0].slot,'both');assert.equal(sheet.inventory.length,2);
    await page.locator('[data-uid="bow"] .act-btn.all').evaluate(b=>{b.click();b.click();});
    await page.waitForFunction(()=>document.querySelector('[data-uid="bow"] .item-resource').textContent.includes('2 ·'));
    assert.equal(ops.filter(x=>x.op==='use').length,1);assert.equal(sheet.inventory[1].qty,2);
    await page.keyboard.press('Escape');
    await page.locator('[data-uid="bow"] .mcard-head').click();
    await page.locator('[data-uid="bow"]').getByRole('button',{name:'Изменить',exact:true}).click();
    await page.getByLabel('Автоматически расходовать ресурс').uncheck();
    await page.getByRole('button',{name:'Сохранить',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-uid="bow"] .item-resource').textContent.includes('выключен'));
    assert.ok(await page.locator('.equipment-hands').count());
    await page.waitForTimeout(600);
    const before = ops.length; concurrentSave = true;
    await page.getByLabel('Основная рука',{exact:true}).selectOption('');
    await page.getByText('Лист обновлён параллельно.',{exact:false}).first().waitFor();
    assert.equal(ops.length,before, 'a concurrent revision must abort the inventory operation');
    assert.equal(sheet.inventory[1].qty,1);
    page.once('dialog', d => d.accept());
    await page.getByRole('button',{name:'Обновить',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-uid="arrows"] .qty span').textContent==='1');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('.equipment-hands').isVisible());
    assert.deepEqual(errors,[]);
    console.log('PASS: real sheet UI, two-hand slots, no copies, single use on double-click, atomic action payload, resource feedback, per-item opt-out, mobile layout');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
