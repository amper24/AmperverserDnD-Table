// UI integration with a deterministic API fixture; server transaction tests live in inventory-api.py.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch(await require('./browser-launch.cjs')());
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900},reducedMotion:'reduce'}), errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().startsWith('Наборы данных не загружены:'))errors.push(m.text());});
    let sheet={_revision:0,name:'Следопыт',level:1,race:'Эльф',class:'Воин',abilities:{str:12,dex:16,con:14,int:10,wis:13,cha:8},skills:[],expertise:[],saving_throws:[],proficiency_bonus:2,hp:{current:12,max:12,temp:0,hit_dice:'1d10'},ac:13,speed:30,death_saves:{success:0,failure:0},conditions:[],auto_armor:true,inventory:[
      // GET /characters returns the server-normalized hand metadata (handedness + slots_v).
      {uid:'bow',name:'Длинный лук',type:'weapon',qty:1,handedness:'two',slots_v:2,properties:['Двуручное','Боеприпас'],actions:[{name:'Атака',kind:'attack',roll:'d20+@atk_dex'},{name:'Урон',kind:'damage',roll:'d8+@dex'}]},
      {uid:'arrows',name:'Стрелы',type:'ammo',qty:3,actions:[]},
      // Второй предмет с графом v3: расход зарядов — узел action.spend. На нём проверяется
      // редактор механик («Ресурс» / «Включено»), не трогая проверки лука и связки действий.
      {uid:'wand',name:'Жезл стрел',type:'magic',qty:1,actions:[],mechanics:{version:2,origin:'test',graph:{nodes:[
        {id:'prog',type:'action.program',params:{program_id:'use',name:'Залп',trigger:'use'},position:{x:40,y:40}},
        {id:'spend',type:'action.spend',params:{block_id:'spend',enabled:true,resource:'charges',source:'self',amount:1,trigger:'use'},position:{x:280,y:40}},
        {id:'end',type:'flow.end',params:{},position:{x:520,y:40}}
      ],links:[
        {from:{node:'prog',socket:'exec'},to:{node:'spend',socket:'exec'}},
        {from:{node:'spend',socket:'exec'},to:{node:'end',socket:'exec'}}
      ],frames:[],groups:[]}}}
    ]}; const ops=[]; let concurrentSave = false;
    const character=()=>({id:'hero',name:sheet.name,owner_id:'user',campaign_id:'campaign1',revision:sheet._revision,sheet:JSON.parse(JSON.stringify(sheet))});
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
      if(url.pathname==='/api/characters' && url.searchParams.get('campaign_id')==='campaign1') return json([
        {id:'hero',campaign_id:'campaign1',name:'Следопыт'},
        {id:'ally',campaign_id:'campaign1',name:'Жрец'}
      ]);
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
    await page.locator('.sheet .ab').first().waitFor();
    const campaignChat = page.getByRole('link', { name: 'Чат кампании' });
    assert.equal(await campaignChat.getAttribute('href'), '/c/campaign1', 'the character sheet opens its associated campaign');
    assert.equal(await campaignChat.getAttribute('target'), '_blank', 'the chat opens without leaving the character sheet');
    const presetState=await page.evaluate(()=>({loaded:Presets.loaded,equipmentRules:Presets.items('equipment_text_rules').length}));
    assert.equal(presetState.loaded,true,`browser preset loading failed: ${JSON.stringify(presetState)}; ${errors.join('; ')}`);
    assert.ok(presetState.equipmentRules>0,`browser equipment rules missing: ${JSON.stringify(presetState)}`);
    await page.evaluate(() => { window.rollMessages = []; DiceEngine.submit = message => { window.rollMessages.push(message); return 'captured'; }; });
    const abilityCheck = page.locator('.sheet .ab').first();
    await abilityCheck.evaluate(node => node.addEventListener('contextmenu', e => { window.rollModeNativeMenuPrevented = e.defaultPrevented; }, { once: true }));
    await abilityCheck.click({ button: 'right' });
    const rollMenu = page.locator('.roll-mode-menu');
    assert.equal(await rollMenu.getByRole('menuitem').count(), 3, 'right-click opens exactly the three requested roll modes');
    assert.deepEqual(await rollMenu.getByRole('menuitem').allTextContents(), ['Обычный бросок', 'С помехой', 'С преимуществом']);
    assert.equal(await page.evaluate(() => window.rollModeNativeMenuPrevented), true, 'the browser context menu is suppressed');
    const menuBox = await rollMenu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 1200 && menuBox.y + menuBox.height <= 900, 'the popup stays inside the viewport');
    await rollMenu.getByRole('menuitem', { name: 'С преимуществом', exact: true }).click();
    assert.equal(await page.evaluate(() => rollMessages[0].expr), '2d20kh1+1');
    const saveRow = page.locator('.sheet-proficiencies .skills').nth(0).locator(':scope > div').first();
    await saveRow.click({ button: 'right' });
    await page.locator('.roll-mode-menu').getByRole('menuitem', { name: 'С помехой', exact: true }).click();
    assert.equal(await page.evaluate(() => rollMessages[1].expr), '2d20kl1+1');
    const skillRow = page.locator('.sheet-proficiencies .skills').nth(1).locator(':scope > div').first();
    // Третий режим проверяем на строке навыка. Клик мышью Playwright сам прокручивает
    // страницу, а попап «Режим броска» закрывается на любом scroll — получалась гонка:
    // отложенный scroll закрывал попап сразу после открытия (первый и второй режимы выше
    // проверены настоящим ПКМ). Поэтому здесь открываем меню и сразу выбираем первый пункт
    // в одной задаче — ровно так же, как обработчик строки делает это по клику.
    await skillRow.evaluate(node => {
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 440 }));
      document.querySelector('.roll-mode-menu [role="menuitem"]').click();
    });
    assert.equal(await page.evaluate(() => rollMessages[2].expr), 'd20+3');
    await abilityCheck.click();
    assert.equal(await page.evaluate(() => rollMessages[3].expr), 'd20+1', 'left-click remains an ordinary roll');
    await abilityCheck.click({ button: 'right' }); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.roll-mode-menu').count(), 0, 'Escape dismisses the popup without rolling');

    const levelInput = page.locator('.level-value-row input');
    const levelButton = page.getByRole('button', { name: 'Повысить уровень' });
    await page.waitForSelector('.level-value-row .lvlup-btn');
    assert.equal(await levelButton.count(), 1);
    const levelBox = await levelInput.boundingBox(), levelActionBox = await levelButton.boundingBox();
    assert.ok(Math.abs(levelBox.y - levelActionBox.y) < 2, 'level-up action sits beside the level value, not on a detached row');
    assert.ok(levelActionBox.x >= levelBox.x + levelBox.width, 'level-up action is aligned after the number input');

    await page.getByRole('button',{name:/Инвентарь/}).click();
    const transferButton = page.getByRole('button', { name: 'Передать Жезл стрел' });
    assert.equal(await transferButton.count(), 1, 'each campaign item has a visible transfer button without expanding it');
    await transferButton.click();
    const transferModal = page.locator('.modal');
    await transferModal.getByRole('heading', { name: 'Передать «Жезл стрел»' }).waitFor();
    assert.deepEqual(await transferModal.locator('select option').allTextContents(), ['Жрец'], 'the recipient dropdown contains other heroes, not the current character');
    assert.equal(await transferModal.getByLabel('Количество предметов').getAttribute('max'), '1', 'the quantity picker is shown even for a single item');
    await transferModal.getByRole('button', { name: 'Отмена' }).click();
    await page.getByRole('button', { name: 'Передать Стрелы' }).click();
    const stackTransferModal = page.locator('.modal');
    await stackTransferModal.getByRole('heading', { name: 'Передать «Стрелы»' }).waitFor();
    assert.equal(await stackTransferModal.getByLabel('Количество предметов').getAttribute('max'), '3', 'the quantity selector is capped at the available stack');
    await stackTransferModal.getByRole('button', { name: 'Отмена' }).click();
    const equipmentSlots = page.locator('.inv .equipment-hands .hand-slot');
    assert.equal(await equipmentSlots.count(), 3, 'main hand, off hand, and armor share one slot row');
    const slotBoxes = await equipmentSlots.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
    assert.ok(slotBoxes.every(box => Math.abs(box.y - slotBoxes[0].y) < 2), 'armor stays on the hand-slot row');
    assert.ok(slotBoxes[0].x < slotBoxes[1].x && slotBoxes[1].x < slotBoxes[2].x, 'the armor card follows both hand cards');
    const slotStyles = await equipmentSlots.evaluateAll(nodes => nodes.map(n => { const s = getComputedStyle(n); return [s.padding, s.borderRadius, s.backgroundColor, s.borderColor]; }));
    assert.deepEqual(slotStyles[2], slotStyles[0], 'armor uses the same card style as hand slots');

    await page.getByLabel('Основная рука',{exact:true}).selectOption('bow');
    await page.waitForFunction(()=>document.querySelectorAll('.hand-slot.filled').length===1&&!document.querySelector('.sheet').inert);
    assert.equal(ops[0].slot,'both');assert.equal(sheet.inventory.length,3);
    await page.locator('[data-uid="bow"] .act-btn.all').evaluate(b=>{b.click();b.click();});
    await page.waitForFunction(()=>document.querySelector('[data-uid="bow"] .item-resource').textContent.includes('2 ·'));
    assert.equal(ops.filter(x=>x.op==='use').length,1);assert.equal(sheet.inventory[1].qty,2);
    // Перетаскивание руки: двуручный лук (обе руки) сбрасывается в одну руку → одноручный хват.
    // Двуручный хват показывается одной общей рамкой на обе руки; «Одной рукой» переводит в одноручный хват.
    assert.equal(await page.locator('.equipment-hands .hand-slot.two-handed.merged').count(), 1, 'обе руки — одна рамка');
    await page.locator('.equipment-hands .hand-slot.merged').getByRole('button',{name:'Одной рукой',exact:true}).click();
    await page.waitForTimeout(300);
    assert.equal(ops.at(-1).op,'equip');assert.equal(ops.at(-1).item_uid,'bow');assert.equal(ops.at(-1).slot,'main','одна рука — одноручный хват');
    await page.keyboard.press('Escape');
    const wandCard = page.locator('[data-uid="wand"]');
    // Clicking the middle of the full header can hit the quantity control, whose handler
    // intentionally stops propagation; target the item name to deterministically expand it.
    await wandCard.locator('.mcard-name').click();
    await wandCard.locator('.mcard-body').waitFor();
    const itemMenu = wandCard.locator('.mcard-body .row').filter({ hasText: 'В чат' });
    await itemMenu.waitFor();
    await page.evaluate(() => { window.sentCards = []; Modules.sendCard = card => window.sentCards.push(structuredClone(card)); });
    const opsBeforeSend = ops.length;
    const sendItemCard = itemMenu.getByRole('button', { name: 'В чат', exact: true });
    await sendItemCard.click(); await sendItemCard.click();
    await page.waitForFunction(() => window.sentCards.length === 2);
    const sentCards = await page.evaluate(() => window.sentCards);
    assert.equal(sentCards.length, 2, 'the same item information can be sent repeatedly');
    assert.ok(sentCards.every(card => card.name === 'Жезл стрел' && !('item_ref' in card)), 'chat receives an informational card, not a link to the live inventory item');
    assert.equal(ops.length, opsBeforeSend, 'sending a card does not consume or mutate the inventory item');
    assert.equal(await itemMenu.evaluate(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()).length), 0, 'conditional button slots never turn null into visible text nodes');
    assert.doesNotMatch(await itemMenu.innerText(), /nullnullnull|null\s+null/i, 'there is no null text between item actions');
    await page.locator('[data-uid="wand"]').getByRole('button',{name:'Изменить',exact:true}).click();
    // Карточку узла ищем по заголовку «Расход ресурса»: поле ресурса — select без <label>,
    // поэтому getByLabel('Ресурс') его не находит, а чекбокс «Включено» — находится.
    const consumeCard = page.locator('.graph-node').filter({ hasText: 'Расход ресурса' });
    await consumeCard.getByLabel('Включено', { exact: true }).uncheck();
    await page.getByRole('button',{name:'Сохранить',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-uid="wand"] .item-resource').textContent.includes('выключен'));
    assert.ok(await page.locator('.equipment-hands').count());
    await page.waitForTimeout(600);
    const before = ops.length; concurrentSave = true;
    // Двуручный лук теперь в основной руке (одноручный хват): снятие идёт с неё.
    await page.getByLabel('Основная рука',{exact:true}).selectOption('');
    await page.getByText('Лист обновлён параллельно.',{exact:false}).first().waitFor();
    assert.equal(ops.length,before, 'a concurrent revision must abort the inventory operation');
    assert.equal(sheet.inventory[1].qty,1);
    page.once('dialog', d => d.accept());
    await page.getByRole('button',{name:'Обновить',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-uid="arrows"] .qty span').textContent==='1');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('.equipment-hands').isVisible());
    await page.evaluate(() => { toast('toast-test-one', 700); toast('toast-test-two', 700); });
    const stackedToasts = page.locator('.toast-stack .toast').filter({ hasText: /^toast-test-/ });
    await stackedToasts.first().waitFor();
    const toastBoxes = await stackedToasts.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
    assert.equal(toastBoxes.length, 2, 'simultaneous notifications share a single stack');
    assert.ok(toastBoxes[0].y + toastBoxes[0].height <= toastBoxes[1].y, 'notifications occupy separate vertical rows');
    await page.waitForFunction(() => ![...document.querySelectorAll('.toast')].some(n => n.textContent.startsWith('toast-test-')), null, { timeout: 2500 });
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'sheet-embed-test'; frame.src = '/sheet/hero?embed=1'; document.body.append(frame); });
    await page.waitForFunction(() => document.querySelector('#sheet-embed-test')?.contentDocument?.querySelector('.sheet .ab'));
    const embeddedSheet = page.frameLocator('#sheet-embed-test');
    assert.equal(await embeddedSheet.locator('.dice-dock').count(), 0, 'an embedded character sheet does not duplicate the table dice dock');
    assert.equal(await embeddedSheet.locator('.dice-log-button').count(), 0, 'an embedded character sheet does not duplicate the table roll journal');
    await page.evaluate(() => document.querySelector('#sheet-embed-test').contentWindow.toast('iframe-toast-check', 1500));
    await page.locator('.toast-stack .toast').filter({ hasText: 'iframe-toast-check' }).waitFor();
    assert.equal(await embeddedSheet.locator('.toast-stack').count(), 0, 'embedded-sheet notifications use the top-level stack');
    assert.deepEqual(errors,[]);
    console.log('PASS: sheet UI, repeated informational item cards, campaign chat link, embedded dock suppression, single toast stack, roll modes, equipment and mobile layout');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
