// ---------------------------------------------------------------------------
// mechanics.js — версионные декларативные механики умений: блоки (расход,
// атака, урон, лечение, состояние, …), валидация схемы, пассивные параметры
// при создании. Без eval, скриптов и циклов — проза не исполняется.
// Даёт: window.Mechanics.
// Зависимости: common.js; window.Modules использует лениво при отрисовке.
// Загружается в обеих страницах (слой 2).
// ---------------------------------------------------------------------------
// Versioned, declarative mechanics. No eval, scripts, loops or automatic execution of prose.
window.Mechanics = (() => {
  const VERSION = 1, clone = x => JSON.parse(JSON.stringify(x)), uid = () => crypto.randomUUID();
  // Блоки не работают по чужой цели: эффекты применяются к владельцу листа, а урон и
  // бывший «спасбросок цели» — это своё действие (бросок и правило), результат которого применяет ДМ.
  const TYPES = { consume: ['Расход ресурса','cost'], attack: ['Атака','roll'], damage: ['Урон · бросок','roll'], heal: ['Лечение','effect'], temp_hp: ['Временные хиты','effect'], roll: ['Своё действие','roll'], grant_item: ['Выдать предмет','effect'], condition: ['Состояние','effect'], adjust: ['Изменить показатель','effect'], require: ['Проверка условия','control'], manual: ['Ручное правило','control'], passive: ['Параметр при создании','passive'] };
  // Виды блоков, которых больше нет в палитре: старые записи с ними читаются и превращаются в свои действия.
  const LEGACY_KINDS = ['save'];
  const STATS = {'':'Без модификатора',str:'Сила',dex:'Ловкость',con:'Телосложение',int:'Интеллект',wis:'Мудрость',cha:'Харизма',best:'Лучшая Сила / Ловкость',prof:'Мастерство',atk:'Оружейная атака',atk_str:'Атака Силой',atk_dex:'Атака Ловкостью',spell:'Атака заклинанием',spell_mod:'Модификатор заклинателя',level:'Уровень',dc:'СЛ заклинаний'};
  const FIELDS = {speed:'Скорость',initiative_bonus:'Бонус инициативы','currency.gp':'Золотые','currency.sp':'Серебряные','hp.max':'Максимум хитов',...Object.fromEntries(Object.entries(window.ABIL || {}).map(([k,n])=>['abilities.'+k,n]))};
  const PASSIVE = {speed:'Скорость',hit_die:'Кость хитов класса',spellcasting:'Характеристика заклинателя',saves:'Владение спасбросками',skills:'Навыки',languages:'Языки',armor:'Владение доспехами',weapons:'Владение оружием',...Object.fromEntries(Object.entries(window.ABIL || {}).map(([k,n])=>['asi.'+k,'Бонус: '+n]))};
  function dice(expr) {
    const text=String(expr || '0').replace(/\s/g,'').replace(/к/g,'d');
    const m=text.match(/^(?:(\d*)d(\d+))?([+-]?\d+)?(?:\+@([a-z_]+))?$/i);
    if(!m || (!m[1]&&!m[2]&&!m[3]&&!m[4])) return {count:0,sides:6,bonus:0,stat:'',advanced:text};
    return {count:m[2]?Number(m[1]||1):0,sides:Number(m[2]||6),bonus:Number(m[3]||0),stat:m[4]||''};
  }
  function expression(d) { if(d?.advanced) return d.advanced; return (d?.count ? `${d.count}d${d.sides}` : '0') + (Number(d?.bonus)>=0?'+':'') + (Number(d?.bonus)||0) + (d?.stat?'+@'+d.stat:''); }
  function block(kind) {
    const b={id:uid(),kind,enabled:true,when:'always'};
    if(['attack','damage','heal','temp_hp','roll'].includes(kind)) Object.assign(b,{dice:dice(kind==='attack'?'1d20+@atk':'1d6'),...(['heal','temp_hp'].includes(kind)?{target:'self',apply:true}:{})});
    if(kind==='consume') Object.assign(b,{resource:'quantity',source:'self',amount:1,trigger:'use'});
    if(kind==='grant_item') Object.assign(b,{target:'self',amount:1,item:{name:'Пустой флакон',type:'gear',qty:1,weight:0.1,stackable:true,handedness:'none',actions:[]}});
    if(kind==='condition') Object.assign(b,{target:'self',condition:'Отравленный',operation:'add'});
    if(kind==='adjust') Object.assign(b,{target:'self',field:'speed',amount:5});
    if(kind==='require') Object.assign(b,{field:'hp.current',minimum:1});
    if(kind==='manual') Object.assign(b,{text:'Опишите правило, которое мастер применяет вручную.'});
    if(kind==='passive') Object.assign(b,{field:'speed',value:30});
    return b;
  }
  /// Стартовый набор блоков для **новой** записи создания персонажа: влияет на характеристики,
  /// владения и даёт заготовку умения. Только для расы, класса и предыстории; правится как обычные блоки.
  const STARTERS = {
    race: () => ({ version: VERSION, origin: 'starter', programs: [
      { id: uid(), name: 'Параметры при создании', trigger: 'passive', blocks: [
        { ...block('passive'), field: 'speed', value: 30 },
        { ...block('passive'), field: 'asi.str', value: 2 },
        { ...block('passive'), field: 'languages', value: ['Общий'] } ] },
      { id: uid(), name: 'Умение расы', trigger: 'use', blocks: [{ ...block('manual'), text: 'Опишите особенность расы: что она даёт и когда применяется.' }] } ] }),
    class: () => ({ version: VERSION, origin: 'starter', programs: [
      { id: uid(), name: 'Параметры при создании', trigger: 'passive', blocks: [
        { ...block('passive'), field: 'hit_die', value: 'd8' },
        { ...block('passive'), field: 'saves', value: ['str'] },
        { ...block('passive'), field: 'skills', value: { choose: 2, from: [] } } ] },
      { id: uid(), name: 'Умение класса', trigger: 'use', blocks: [{ ...block('manual'), text: 'Опишите умение 1 уровня: что оно даёт и когда применяется.' }] } ] }),
    background: () => ({ version: VERSION, origin: 'starter', programs: [
      { id: uid(), name: 'Параметры при создании', trigger: 'passive', blocks: [
        { ...block('passive'), field: 'skills', value: [] },
        { ...block('passive'), field: 'languages', value: [] } ] },
      { id: uid(), name: 'Умение предыстории', trigger: 'use', blocks: [{ ...block('manual'), text: 'Опишите умение предыстории.' }] } ] }),
  };
  function starter(category) { const make = STARTERS[category]; return make ? make() : undefined; }
  /// Библиотека шаблонов: готовые цепочки блоков. build() собирает новую программу.
  /// creation — шаблоны для расы, класса и предыстории (параметры создания персонажа).
  const TEMPLATES = [
    { id:'weapon', group:'Бой', name:'Атака → урон', hint:'Оружейная атака и урон с модификатором Силы/Ловкости', chain:['attack','damage'],
      build:()=>({name:'Атака',blocks:[block('attack'),block('damage')]}) },
    { id:'spell_attack', group:'Бой', name:'Атака заклинанием → урон', hint:'Бонус атаки заклинанием, урон, сравнение с КД цели', chain:['attack','damage'],
      build:()=>({name:'Атака заклинанием',blocks:[{...block('attack'),dice:dice('1d20+@spell')},{...block('damage'),dice:dice('1d10+@spell_mod')}]}) },
    { id:'area_damage', group:'Бой', name:'Своё действие: урон', hint:'Правило области, спасбросок и условия описываете вы — блок только бросает урон, применяет результат ДМ', chain:['manual','damage'],
      build:()=>({name:'Урон по площади',blocks:[{...block('manual'),text:'Опишите область, условия и спасбросок цели: что именно и в каком порядке применяет ДМ.'},block('damage')]}) },
    { id:'ammo_attack', group:'Бой', name:'Патрон → атака → урон', hint:'Расход боеприпаса перед каждой атакой', chain:['consume','attack','damage'],
      build:()=>({name:'Выстрел',blocks:[{...block('consume'),source:'tag',tag:'стрела',trigger:'attack'},block('attack'),block('damage')]}) },
    { id:'double_attack', group:'Бой', name:'Две атаки', hint:'Два удара: урон каждого бросается отдельно', chain:['attack','damage','attack','damage'],
      build:()=>({name:'Две атаки',blocks:[block('attack'),block('damage'),block('attack'),block('damage')]}) },
    { id:'potion', group:'Лечение', name:'Зелье → хиты → флакон', hint:'Расход предмета, лечение, выдача пустого флакона', chain:['consume','heal','grant_item'],
      build:()=>({name:'Выпить зелье',blocks:[block('consume'),{...block('heal'),dice:dice('2d4+2')},block('grant_item')]}) },
    { id:'spell', group:'Лечение', name:'Ячейка → лечение', hint:'Расход ячейки и лечение цели', chain:['consume','heal'],
      build:()=>({name:'Сотворить',blocks:[{...block('consume'),resource:'slot',source:'self',slot_level:1},{...block('heal'),dice:dice('1d8+@spell_mod')}]}) },
    { id:'temp_hp', group:'Лечение', name:'Временные хиты', hint:'Берутся максимумом, не суммируются', chain:['temp_hp'],
      build:()=>({name:'Временные хиты',blocks:[{...block('temp_hp'),dice:dice('1d6+2')}]}) },
    { id:'heal_temp', group:'Лечение', name:'Лечение + временные хиты', hint:'Сначала лечение, затем запас сверху', chain:['heal','temp_hp'],
      build:()=>({name:'Лечение с запасом',blocks:[{...block('heal'),dice:dice('1d8+3')},{...block('temp_hp'),dice:dice('1d6')}]}) },
    { id:'heal_charge', group:'Лечение', name:'Заряд → лечение', hint:'Тратит заряд предмета, а не количество', chain:['consume','heal'],
      build:()=>({name:'Использовать заряд',blocks:[{...block('consume'),resource:'charges',source:'self'},{...block('heal'),dice:dice('2d4+2')}]}) },
    { id:'craft', group:'Предметы', name:'Сырьё → предмет', hint:'Расход по метке и выдача нового предмета', chain:['consume','grant_item'],
      build:()=>({name:'Изготовить',blocks:[{...block('consume'),source:'tag',tag:'ingredient'},block('grant_item')]}) },
    { id:'grant_ammo', group:'Предметы', name:'Выдать боеприпасы', hint:'Выдача пачки с меткой ресурса', chain:['grant_item'],
      build:()=>({name:'Выдать',blocks:[{...block('grant_item'),amount:20,item:{...block('grant_item').item,name:'Стрелы',type:'ammo',ammo_tag:'стрела'}}]}) },
    { id:'consume_only', group:'Предметы', name:'Расход заряда', hint:'Только списание ресурса, без эффектов', chain:['consume'],
      build:()=>({name:'Потратить заряд',blocks:[{...block('consume'),resource:'charges',source:'self'}]}) },
    { id:'condition_on', group:'Умения и эффекты', name:'Наложить состояние', hint:'Добавляет состояние владельцу или цели', chain:['condition'],
      build:()=>({name:'Наложить',blocks:[{...block('condition'),condition:'Отравленный'}]}) },
    { id:'condition_off', group:'Умения и эффекты', name:'Снять состояние', hint:'Убирает состояние, например яд или страх', chain:['condition'],
      build:()=>({name:'Снять',blocks:[{...block('condition'),condition:'Испуганный',operation:'remove'}]}) },
    { id:'buff', group:'Умения и эффекты', name:'Изменить показатель', hint:'Скорость, хиты, инициатива, характеристика', chain:['adjust'],
      build:()=>({name:'Усиление',blocks:[{...block('adjust'),field:'speed',amount:10}]}) },
    { id:'check', group:'Умения и эффекты', name:'Проверка характеристики', hint:'Отдельный бросок d20 с модификатором', chain:['roll'],
      build:()=>({name:'Проверка',blocks:[{...block('roll'),dice:dice('1d20+@str')}]}) },
    { id:'uses_effect', group:'Умения и эффекты', name:'Умение с запасом использований', hint:'Списание использования и ручное правило', chain:['consume','manual'],
      build:()=>({name:'Применить',blocks:[{...block('consume'),resource:'uses',source:'self'},{...block('manual'),text:'Опишите, что делает умение и когда применяется.'}]}) },
    { id:'require_effect', group:'Умения и эффекты', name:'Условие → эффект', hint:'Проверка показателя перед изменением', chain:['require','adjust'],
      build:()=>({name:'Под условием',blocks:[{...block('require'),field:'hp.current',minimum:1},{...block('adjust'),field:'speed',amount:10}]}) },
    { id:'manual', group:'Умения и эффекты', name:'Ручное правило', hint:'Не исполняется: требует подтверждения перед цепочкой', chain:['manual'],
      build:()=>({name:'Правило',blocks:[{...block('manual'),text:'Опишите правило, которое мастер применяет вручную.'}]}) },
    { id:'asi', creation:true, group:'Персонаж', name:'Бонус характеристики', hint:'+2 или +1 к одной-двум характеристикам', chain:['passive'],
      build:()=>({name:'Характеристики',trigger:'passive',blocks:[{...block('passive'),field:'asi.str',value:2}]}) },
    { id:'skills', creation:true, group:'Персонаж', name:'Навыки на выбор', hint:'Игрок выбирает указанное число навыков', chain:['passive'],
      build:()=>({name:'Навыки',trigger:'passive',blocks:[{...block('passive'),field:'skills',value:{choose:2,from:[]}}]}) },
    { id:'saves', creation:true, group:'Персонаж', name:'Владение спасбросками', hint:'Владение выбранными спасбросками', chain:['passive'],
      build:()=>({name:'Спасброски',trigger:'passive',blocks:[{...block('passive'),field:'saves',value:[]}]}) },
    { id:'hit_die', creation:true, group:'Персонаж', name:'Кость хитов класса', hint:'d6, d8, d10 или d12 — максимум на первом уровне', chain:['passive'],
      build:()=>({name:'Хиты',trigger:'passive',blocks:[{...block('passive'),field:'hit_die',value:'d8'}]}) },
    { id:'spellcasting', creation:true, group:'Персонаж', name:'Характеристика заклинателя', hint:'От чего считаются СЛ и бонус атаки', chain:['passive'],
      build:()=>({name:'Заклинания',trigger:'passive',blocks:[{...block('passive'),field:'spellcasting',value:'int'}]}) },
    { id:'armor', creation:true, group:'Персонаж', name:'Владение доспехами', hint:'Строка владения доспехами и щитами', chain:['passive'],
      build:()=>({name:'Доспехи',trigger:'passive',blocks:[{...block('passive'),field:'armor',value:''}]}) },
    { id:'weapons_prof', creation:true, group:'Персонаж', name:'Владение оружием', hint:'Строка владения оружием и инструментами', chain:['passive'],
      build:()=>({name:'Оружие',trigger:'passive',blocks:[{...block('passive'),field:'weapons',value:''}]}) },
    { id:'languages', creation:true, group:'Персонаж', name:'Языки', hint:'Список языков или число языков на выбор', chain:['passive'],
      build:()=>({name:'Языки',trigger:'passive',blocks:[{...block('passive'),field:'languages',value:[]}]}) },
    { id:'speed', creation:true, group:'Персонаж', name:'Скорость', hint:'Скорость персонажа в футах', chain:['passive'],
      build:()=>({name:'Скорость',trigger:'passive',blocks:[{...block('passive'),field:'speed',value:30}]}) },
    { id:'feature', creation:true, group:'Персонаж', name:'Умение', hint:'Особенность расы, класса или предыстории', chain:['manual'],
      build:()=>({name:'Умение',blocks:[{...block('manual'),text:'Опишите умение: что оно даёт и когда применяется.'}]}) },
    { id:'proficiency', creation:true, group:'Персонаж', name:'Владение', hint:'Произвольная строка владения', chain:['passive'],
      build:()=>({name:'Владения',trigger:'passive',blocks:[{...block('passive'),field:'armor',value:''}]}) },
  ];
  /// Быстрые шаблоны по категории: самые ходовые цепочки — одним нажатием.
  const QUICK = {
    item: ['potion','weapon','area_damage','manual'],
    spell: ['spell','spell_attack','area_damage','temp_hp'],
    feature: ['uses_effect','condition_on','buff','manual'],
    monster: ['weapon','area_damage','condition_on','manual'],
    race: ['asi','skills','feature','proficiency'],
    class: ['hit_die','skills','feature','proficiency'],
    background: ['asi','skills','feature','proficiency'],
  };
  QUICK.default = ['weapon','potion','area_damage','manual'];
  const templates = (category) => TEMPLATES.filter(t => ['race','class','background'].includes(category) ? !!t.creation : !t.creation);
  /// Галерея шаблонов: группы, описание и цепочка блоков — вместо плоского списка кнопок.
  function templatePicker(category = 'item') {
    const all = templates(category), query = el('input', { placeholder: 'Найти шаблон…', 'aria-label': 'Поиск шаблона' });
    const grid = el('div', { class: 'template-grid' });
    let chosen = null;
    const card = (t) => el('button', { class: 'template-card', title: t.hint,
        onclick: () => { chosen = t; grid.closest('.modal')?.querySelector('.template-add')?.click(); } },
      el('div', { class: 'template-card-head' }, el('b', {}, t.name), el('span', { class: 'badge' }, t.group)),
      el('div', { class: 'muted small' }, t.hint),
      el('div', { class: 'template-chain' }, ...t.chain.map(k => el('span', { class: 'template-block ' + (TYPES[k]?.[1] || 'control') }, TYPES[k]?.[0] || k))));
    const render = () => {
      const q = String(query.value || '').toLowerCase().trim();
      const found = all.filter(t => !q || (t.name + ' ' + t.hint + ' ' + t.group).toLowerCase().includes(q));
      const groups = [...new Set(found.map(t => t.group))];
      grid.replaceChildren(...groups.flatMap(g => [el('h4', {}, g), el('div', { class: 'template-group' }, ...found.filter(t => t.group === g).map(card))]),
        found.length ? null : el('p', { class: 'muted' }, 'Ничего не найдено. Измените запрос или соберите цепочку вручную.'));
    };
    query.addEventListener('input', render);
    render();
    const body = el('div', { class: 'template-picker' }, query, grid);
    return modal('Шаблоны блоков', body, [{ label: 'Добавить шаблон', cls: 'primary template-add', fn: () => chosen || false }], { wide: true });
  }
  /// Блоки не работают по чужой цели: эффекты применяются владельцу листа, а урон и бывший
  /// «спасбросок цели» — это своё действие (бросок и правило), результат которого применяет ДМ.
  /// Старые записи приводятся к новому виду при открытии в редакторе; сохранение закрепляет результат.
  function normalize(m) {
    if (!m || !Array.isArray(m.programs)) return m;
    for (const p of m.programs) {
      if (!Array.isArray(p.blocks)) continue;
      let gate = false;
      for (let i = 0; i < p.blocks.length; i++) {
        let b = p.blocks[i];
        if (!b || typeof b !== 'object') continue;
        // Спасбросок цели → своё действие: бросок d20 и правило, которое сравнивает ДМ.
        if (b.kind === 'save') {
          const ability = (window.ABIL || {})[b.ability] || b.ability || '';
          const dc = Number(b.dc) || 0;
          b = p.blocks[i] = { id: b.id || uid(), kind: 'roll', enabled: b.enabled !== false, when: 'always', name: b.name || 'Спасбросок',
            dice: dice('1d20'), text: `Спасбросок${ability ? ' ' + ability : ''}${dc ? ' · СЛ ' + dc : ''}. Результат сравнивает ДМ.` };
        }
        if (['attack', 'damage', 'roll'].includes(b.kind)) { delete b.target; delete b.apply; }
        if (['heal', 'temp_hp', 'condition', 'adjust', 'grant_item'].includes(b.kind)) b.target = 'self';
        if (['hit', 'miss'].includes(b.when) && !gate) b.when = 'always'; // ветвление держалось на спасбросоке цели
        if (b.kind === 'attack') gate = true;
      }
    }
    return m;
  }
  /// Программы для показа: чужих целей нет, старые блоки спасброска показаны своим действием.
  const programsOf = m => m?.programs ? normalize(clone({ programs: m.programs })).programs : [];
  function migrate(doc, category='item') {
    if(doc.mechanics) return normalize(doc.mechanics);
    const blocks=[], extra=[];
    if(['race','class','background'].includes(category)) {
      const fields=['speed','hit_die','spellcasting','saves','skills','languages','armor','weapons'];
      const bs=fields.filter(k=>doc[k]!==undefined).map(k=>({...block('passive'),field:k,value:clone(doc[k])}));
      for(const [k,v] of Object.entries(doc.asi||{})) bs.push({...block('passive'),field:'asi.'+k,value:v});
      if(bs.length)extra.push({id:uid(),name:'Параметры при создании',trigger:'passive',blocks:bs});
    }
    for(const group of ['traits','actions','reactions','legendary_actions'])for(const row of doc[group]||[])if(row.text)extra.push({id:uid(),name:row.name||'Правило',feature_name:row.name,group,trigger:'use',blocks:[{...block('manual'),text:row.text}]});
    for(const [name,text] of Object.entries(doc.feature_texts||{}))if(text)extra.push({id:uid(),name,feature_name:name,trigger:'use',blocks:[{...block('manual'),text}]});
    if(doc.feature_text)extra.push({id:uid(),name:doc.feature||'Особенность',feature_name:doc.feature,trigger:'use',blocks:[{...block('manual'),text:doc.feature_text}]});
    if(category==='spell'&&doc.level>0)blocks.push({...block('consume'),resource:'slot',slot_level:doc.level});

    if(category==='item' && doc.consume) {
      const c=doc.consume; blocks.push({...block('consume'),enabled:c.enabled!==false,resource:c.resource||'quantity',source:c.target_uid==='self'?'self':c.target_uid?'item':'tag',item_uid:c.target_uid==='self'?'':c.target_uid||'',tag:c.ammo_tag||'',amount:c.amount||1,trigger:c.trigger||'use'});
    }
    // Старые действия: урон и атака — только броски, лечение применяется владельцу.
    for(const a of (doc.actions || []).filter(a=>a.roll)) blocks.push(Object.assign({...block(['attack','damage','heal'].includes(a.kind)?a.kind:'roll'),name:a.name||'',dice:dice(a.kind==='heal'?a.roll.replace(/@spell\b/g,'@spell_mod'):a.roll),grip:a.grip||'',damage_type:a.dtype||''},a.kind==='heal'?{apply:true}:null));
    if(!blocks.some(b=>b.kind==='manual') && (doc.desc || doc.text)) blocks.push({...block('manual'),text:doc.desc||doc.text});
    doc.mechanics={version:VERSION,origin:'legacy',programs:blocks.length?[...extra,{id:'use',name:category==='spell'?'Сотворить':category==='item'?'Использовать':'Применить',trigger:'use',blocks}]:extra};
    return normalize(doc.mechanics);
  }
  function validate(m) {
    if(!m || m.version!==VERSION || !Array.isArray(m.programs) || m.programs.length>256) return 'Неподдерживаемая схема механик.';
    const ids=new Set();
    for(const p of m.programs) {
      if(!p.id || ids.has(p.id) || !p.name?.trim()) return 'Действию нужны уникальный ID и название.'; ids.add(p.id);
      if(!['use','passive'].includes(p.trigger)||!Array.isArray(p.blocks)||p.blocks.length>32) return 'Действие: до 32 блоков, триггер использования или параметров.';
      const bids=new Set(); let gate=false;
      for(const b of p.blocks) {
        if(!b.id||bids.has(b.id)||!(TYPES[b.kind]||LEGACY_KINDS.includes(b.kind))) return 'Неизвестный блок или повторяющийся ID.'; bids.add(b.id);
        if(b.enabled===false) continue;
        if(p.trigger==='passive'&&!['passive','manual'].includes(b.kind)||b.kind==='passive'&&p.trigger!=='passive')return 'Пассивные параметры помещаются в программу «Параметры при создании», отдельно от активных эффектов.';
        if(b.kind==='consume'&&b.trigger==='attack'&&!p.blocks.slice(p.blocks.indexOf(b)+1).some(x=>x.kind==='attack'&&x.enabled!==false))return 'Расход за атаку должен стоять перед атакой.';

        if(b.when && b.when!=='always' && !gate) return 'Условному блоку нужна предшествующая атака или спасбросок.';
        if(['attack','save'].includes(b.kind)) gate=true;
        if(b.dice) {
          if(b.dice.advanced) {
            if(b.dice.advanced.length>64) return 'Формула слишком длинная (максимум 64 символа).';
            if(window.DiceEngine?.parse) {
              try { window.DiceEngine.parse(String(b.dice.advanced).replace(/@[a-z_]+/gi, '0')); }
              catch { return 'Неверная формула кубов. Пример: 2d6+@str.'; }
            }
          }
          else if(!Number.isInteger(b.dice.count)||b.dice.count<0||b.dice.count>100||!Number.isInteger(b.dice.sides)||b.dice.sides<1||b.dice.sides>1000||!Number.isInteger(b.dice.bonus)||Math.abs(b.dice.bonus)>1000000) return 'Проверьте числа в блоке кубиков.';
        }
        if(['consume','grant_item'].includes(b.kind)&&(!Number.isInteger(b.amount)||b.amount<1||b.amount>10000)) return 'Количество расхода / выдачи: целое от 1 до 10000.';
        if(b.kind==='consume' && b.source==='item' && !b.item_uid) return 'Выберите предмет-источник расхода.';
        if(b.kind==='consume' && b.source==='tag' && !b.tag?.trim()) return 'Укажите метку ресурса.';
        if(b.kind==='grant_item' && !b.item?.name?.trim()) return 'Выберите выдаваемый предмет.';
      }
    }
    return '';
  }
  function programSummary(p) { return p.blocks.filter(b=>b.enabled!==false).map(b=>TYPES[b.kind]?.[0]||b.kind).join(' → '); }
  function preview(m, ctx) {
    if(!m) return null;
    return el('div',{class:'mechanics-preview'},...programsOf(m).map(p=>el('details',{},el('summary',{},p.name,' · ',p.trigger==='passive'?'параметры':`${p.blocks.length} блоков`),...p.blocks.map(b=>el('div',{class:'mechanic-preview-block '+(TYPES[b.kind]?.[1]||'')},el('b',{},TYPES[b.kind]?.[0]||b.kind),b.enabled===false?' · выключен':b.dice?' · '+expression(b.dice):b.kind==='consume'?` · −${b.amount} (${b.source})`:b.kind==='grant_item'?` · +${b.amount} ${b.item?.name||''}`:b.kind==='manual'?' · вручную':b.kind==='passive'?` · ${b.field}: ${JSON.stringify(b.value)}`:'',b.text?el('p',{class:'small muted'},b.text):null, b.dice?el('button',{class:'small',title:'Только кубики, без расхода и изменения листа',onclick:()=>Modules.roll(expression(b.dice),'Отдельный бросок: '+p.name,{ctx,kind:['attack','damage'].includes(b.kind)?b.kind:'other'})},'Бросить отдельно · без эффектов'):null)) )));
  }
  function buttons(doc, options={}) {
    const root=el('div',{class:'action-buttons mechanics-buttons'});
    for(const p of programsOf(doc.mechanics)) {
      if(p.trigger!=='use') continue;
      const blocks=(p.blocks||[]).filter(b=>b.enabled!==false);
      const program=el('button',{class:'act-btn',disabled:options.disabled?'':null,title:programSummary(p),onclick:e=>{e.stopPropagation(); if(options.onProgram) options.onProgram(p,window.Modules?.modeFromEvent(e)||{}); else toast('Исполняемые эффекты применяются с листа персонажа. Справочник — только шаблон.');}},el('span',{},p.name),el('small',{},` ${blocks.length} блоков`));
      // Атака с уроном показывается как на листах: попадание и урон — две отдельные кнопки.
      const atk=blocks.find(b=>b.kind==='attack'), dmg=blocks.find(b=>b.kind==='damage');
      if(atk&&dmg&&window.Modules?.attackRow){
        const row=window.Modules.attackRow(p.name,
          {expr:expression(atk.dice),dtype:atk.damage_type,kind:'attack',name:atk.name||p.name,index:blocks.indexOf(atk)},
          {expr:expression(dmg.dice),dtype:dmg.damage_type,kind:'damage',name:dmg.name||p.name,index:blocks.indexOf(dmg)},
          window.SHEET_CTX||{},'',{disabled:options.disabled,note:options.onUse?'Сотворение заклинания сначала оплачивает расход':'Отдельный бросок: без расхода и эффектов',onUse:options.onUse});
        const pureAttackDamage = blocks.length === 2 && blocks.some(b=>b.kind==='attack') && blocks.some(b=>b.kind==='damage');
        if(pureAttackDamage) root.append(el('div',{class:'actions-row'},row));
        else {
          program.classList.add('all');
          program.title='Вся цепочка целиком: расход, эффекты и удвоение костей при крите. '+programSummary(p);
          root.append(el('div',{class:'actions-row'},row,program));
        }
      } else root.append(program);
    }
    return root;
  }
  function editor(doc, options={}) {
    const m=migrate(doc,options.category||'item'), root=el('div',{class:'mechanics-editor'}), instance=uid(); let selected=0;
    const field=(n,c)=>el('label',{class:'block-field'},el('span',{},n),c);
    const input=(obj,key,type='text',extra={})=>el('input',{type,value:obj[key]??'',...extra,oninput:e=>obj[key]=type==='number'?Number(e.target.value):e.target.value});
    const select=(pairs,value,fn)=>el('select',{onchange:e=>{fn(e.target.value);render();}},...pairs.map(([k,n])=>el('option',{value:k,selected:String(value??'')===k?'':null},n)));
    // Получателя больше нет: эффекты идут владельцу листа, остальное применяет ДМ.
    const note=text=>el('p',{class:'muted small'},text);
    const makeProgram=()=>({id:uid(),name:'Новое действие',trigger:'use',blocks:[]});
    function render() {
      root.replaceChildren(); selected=Math.max(0,Math.min(selected,m.programs.length-1)); const p=m.programs[selected];
      const nav=el('div',{class:'mechanics-programs'},...m.programs.map((p,i)=>el('button',{class:i===selected?'active':'',onclick:()=>{selected=i;render();}},p.name)),el('button',{onclick:()=>{m.programs.push(makeProgram());selected=m.programs.length-1;render();}},'+ Действие'));
      root.append(el('div',{class:'mechanics-heading'},el('div',{},el('h3',{},'Конструктор механик'),el('p',{class:'muted small'},'Соберите действие из блоков. Описание ничего не исполняет. Порядок — сверху вниз; при ошибке откатывается вся цепочка.')),el('span',{class:'badge'},'BLOCKS · v1')),nav);
      if(!p) { root.append(el('p',{class:'muted'},'Добавьте действие или начните с рецепта ниже.')); }
      const pick=(id)=>TEMPLATES.find(t=>t.id===id);
      const addTemplate=(t)=>{const prog=makeProgram(),made=t.build();prog.name=made.name;prog.blocks=made.blocks;if(made.trigger)prog.trigger=made.trigger;m.programs.push(prog);selected=m.programs.length-1;render();};
      const quickIds=QUICK[options.category||'item']||QUICK.default;
      const presets=el('div',{class:'mechanics-presets'},el('span',{class:'muted small'},'Шаблоны:'),
        ...quickIds.map(id=>{const t=pick(id);return t?el('button',{class:'small',title:t.hint,onclick:()=>addTemplate(t)},t.name):null;}),
        el('button',{class:'small primary',title:'Все шаблоны по группам с описанием',onclick:async()=>{const t=await templatePicker(options.category||'item');if(t)addTemplate(t);}},'Все шаблоны ▸'));
      root.append(presets); if(!p) return;
      root.append(el('div',{class:'block-program-header'},field('Название действия',input(p,'name')),field('Когда',select([['use','По нажатию «Использовать»'],['passive','Параметры при создании']],p.trigger,v=>p.trigger=v)),el('button',{class:'small',onclick:()=>{const copy=clone(p);copy.id=uid();copy.name+=' (копия)';copy.blocks.forEach(b=>b.id=uid());m.programs.push(copy);selected=m.programs.length-1;render();}},'Копия'),el('button',{class:'small danger',onclick:()=>{if(confirm('Удалить действие со всеми блоками?')){m.programs.splice(selected,1);render();}}},'Удалить действие')));
      const workspace=el('div',{class:'block-workspace'}), palette=el('aside',{class:'block-palette'},el('b',{},'Добавить блок'),...Object.entries(TYPES).map(([k,[name,color]])=>el('button',{class:'palette-block '+color,onclick:()=>{if(p.blocks.length>=32)return toast('Не более 32 блоков.');p.blocks.push(block(k));render();}},'+ '+name)));
      const stack=el('div',{class:'block-stack'});workspace.append(palette,stack);root.append(workspace);
      p.blocks.forEach((b,i)=>{
        const card=el('section',{class:'mechanic-block '+(TYPES[b.kind]?.[1]||'control')+(b.enabled===false?' disabled':''),'data-block':b.id});
        const move=(from,to)=>{if(to<0||to>=p.blocks.length)return;const [b]=p.blocks.splice(from,1);p.blocks.splice(to,0,b);render();};
        const handle=el('span',{class:'block-handle',draggable:'true',title:'Перетащите блок'},'⠿');handle.addEventListener('dragstart',e=>e.dataTransfer.setData('application/x-mechanics-block',JSON.stringify({instance,index:i})));
        card.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('application/x-mechanics-block'))e.preventDefault();});card.addEventListener('drop',e=>{try{const d=JSON.parse(e.dataTransfer.getData('application/x-mechanics-block'));if(d.instance===instance){e.preventDefault();e.stopPropagation();move(d.index,i);}}catch{}});
        card.append(el('header',{},handle,el('span',{class:'block-index'},String(i+1).padStart(2,'0')),el('b',{},TYPES[b.kind]?.[0]||b.kind),el('label',{class:'block-switch'},el('input',{type:'checkbox',checked:b.enabled!==false?'':null,'aria-label':b.kind==='consume'?'Автоматически расходовать ресурс':'Включить блок',onchange:e=>{b.enabled=e.target.checked;render();}}),' Вкл.'),el('button',{class:'small','aria-label':'Блок выше',disabled:i===0?'':null,onclick:()=>move(i,i-1)},'↑'),el('button',{class:'small','aria-label':'Блок ниже',disabled:i===p.blocks.length-1?'':null,onclick:()=>move(i,i+1)},'↓'),el('button',{class:'small','aria-label':'Копировать блок',onclick:()=>{if(p.blocks.length>=32)return;const copy=clone(b);copy.id=uid();p.blocks.splice(i+1,0,copy);render();}},'⧉'),el('button',{class:'small danger','aria-label':'Удалить блок',onclick:()=>{p.blocks.splice(i,1);render();}},'×')));
        const body=el('div',{class:'block-controls'});
        if(b.kind!=='passive') body.append(field('Условие',select([['always','Всегда'],['hit','Если попадание'],['miss','Если промах']],b.when||'always',v=>b.when=v)));
        if(b.dice){
          const d=b.dice;
          body.append(field('Кубиков',input(d,'count','number',{min:0,max:100,step:1})),field('Грани',select([...new Set([4,6,8,10,12,20,100,d.sides])].sort((a,b)=>a-b).map(n=>[String(n),'d'+n]),String(d.sides),v=>d.sides=Number(v))),field('Бонус',input(d,'bonus','number',{step:1})),field('Модификатор',select(Object.entries(STATS),d.stat,v=>d.stat=v)));
          const adv=el('details',{class:'block-advanced'},el('summary',{},'Своя формула (необязательно)'),field('Формула заменяет поля кубиков',input(d,'advanced')));body.append(adv);
        }
        if(['heal','temp_hp','condition','grant_item','adjust'].includes(b.kind)) body.append(note('Применяется владельцу листа. Эффекты по другим персонажам — задача ДМ.'));
        if(b.kind==='attack'||b.kind==='damage') body.append(field('Хват',select([['','Любой'],['one','Одной рукой'],['two','Двумя руками']],b.grip,v=>b.grip=v)));
        if(b.kind==='attack') body.append(field('КД цели (необязательно)',input(b,'dc','number',{min:0,max:40,step:1,placeholder:'0 — решает ДМ'})),
          note('Попадание решает ДМ. Если указать КД, ветка «при попадании» сработает только при результате не ниже КД; без КД промахом считается одна натуральная 1.'));
        if(b.kind==='damage') body.append(field('Тип урона',select((window.Modules?.DAMAGE_TYPES||['','рубящий','огонь']).map(n=>[n,n||'Не задан']),b.damage_type,v=>b.damage_type=v)),note('Урон не списывается с цели: бросок показывает результат, хиты меняет ДМ.'));
        if(b.kind==='roll') body.append(field('Правило действия (необязательно)',el('textarea',{oninput:e=>b.text=e.target.value},b.text||'')),note('Своё действие: бросок кубов и правило, которое применяет ДМ.'));
        if(b.kind==='consume'){
          body.append(field('Ресурс',select([['quantity','Количество предмета'],['charges','Заряды предмета'],['slot','Ячейка заклинания'],['uses','Использования умения']],b.resource,v=>b.resource=v)));
          if(['quantity','charges'].includes(b.resource)){
            body.append(field('Источник',select([['self','Сам этот предмет'],['item','Другой предмет инвентаря'],['tag','Предметы по метке']],b.source,v=>b.source=v)));
            if(b.source==='item')body.append(field('Предмет',select([['','Выберите…'],...(options.inventory||[]).map(x=>[x.uid,`${x.name} · ${x.qty??1} шт.`]),...(b.item_uid&&!(options.inventory||[]).some(x=>x.uid===b.item_uid)?[[b.item_uid,'Недоступная привязка']]:[])],b.item_uid,v=>b.item_uid=v)));
            if(b.source==='tag')body.append(field('Метка ресурса',input(b,'tag')));
          }
          if(b.resource==='slot')body.append(field('Уровень ячейки',input(b,'slot_level','number',{min:1,max:9})));
          body.append(field('Количество',input(b,'amount','number',{min:1,max:10000,step:1})),field('Списание',select([['use','Один раз за действие'],['attack','За каждую атаку в цепочке']],b.trigger,v=>b.trigger=v)));
        }
        if(b.kind==='grant_item'){
          body.append(field('Количество',input(b,'amount','number',{min:1,max:10000,step:1})),field('Выдаваемый предмет',input(b.item,'name')),field('Тип',select(Object.entries(window.Modules?.ITEM_TYPES||{gear:'Снаряжение'}),b.item.type,v=>b.item.type=v)),field('Метка ресурса',input(b.item,'ammo_tag')),
            el('button',{class:'small',onclick:async()=>{try{const entries=await API.get('/api/compendium?category=item&limit=3000&edition='+encodeURIComponent(window.SHEET_EDITION||defaultEdition()));const sel=el('select',{},...entries.map(e=>el('option',{value:e.id},e.name+' · '+e.source)));const id=await modal('Выдать копию шаблона',sel,[{label:'Выбрать',cls:'primary',fn:()=>sel.value}]);const entry=entries.find(e=>e.id===id);if(entry){b.item=Modules.itemFromCompendium(entry);delete b.item.uid;b.item.qty=1;b.item.equipped=false;b.item.hand_slot=null;render();}}catch(e){toast(e.message);}}},'Из справочника…'),el('span',{class:'muted small'},'Копия шаблона, не ссылка на чужую стопку. Механики выданного предмета не запускаются автоматически.'));
        }
        if(b.kind==='condition')body.append(field('Состояние',input(b,'condition')),field('Операция',select([['add','Добавить'],['remove','Снять']],b.operation,v=>b.operation=v)));
        if(b.kind==='adjust')body.append(field('Показатель',select(Object.entries(FIELDS),b.field,v=>b.field=v)),field('Изменение',input(b,'amount','number',{min:-10000,max:10000,step:1})));
        if(b.kind==='require')body.append(field('Показатель владельца',select([['hp.current','Текущие хиты'],...Object.entries(FIELDS)],b.field,v=>b.field=v)),field('Не меньше',input(b,'minimum','number',{step:1})));
        if(b.kind==='manual')body.append(field('Правило / ограничение (не исполняется)',el('textarea',{oninput:e=>b.text=e.target.value},b.text||'')),el('small',{class:'muted'},'Перед использованием потребуется подтверждение. Этот блок не притворяется автоматизацией сложных правил.'));
        if(b.kind==='passive') {
          body.append(field('Параметр',select(Object.entries(PASSIVE),b.field,v=>{b.field=v;b.value=v==='hit_die'?'d8':v==='spellcasting'?'int':['saves','skills','languages'].includes(v)?[]:['armor','weapons'].includes(v)?'':v==='speed'?30:0;})));
          if(b.field==='hit_die')body.append(field('Кость',select(['d6','d8','d10','d12'].map(x=>[x,x]),b.value,v=>b.value=v)));
          else if(b.field==='spellcasting')body.append(field('Характеристика',select(Object.entries(window.ABIL||{}),b.value,v=>b.value=v)));
          else if(b.field==='saves'||b.field==='skills'){
            const skills=b.field==='skills', choice=skills&&!Array.isArray(b.value),values=choice?b.value.from||[]:Array.isArray(b.value)?b.value:[];
            if(skills)body.append(field('Вид',select([['fixed','Предоставить выбранные навыки'],['choose','Выбрать из списка при создании']],choice?'choose':'fixed',v=>b.value=v==='choose'?{choose:2,from:[...values]}:[...values])));
            if(choice)body.append(field('Сколько выбрать',input(b.value,'choose','number',{min:0,max:18,step:1})));
            const checks=el('div',{class:'block-checks'},...(skills?(window.SKILLS||[]).map(([k,n])=>[n,n]):Object.entries(window.ABIL||{})).map(([key,name])=>el('label',{},el('input',{type:'checkbox',checked:values.includes(key)?'':null,onchange:e=>{const next=values.filter(v=>v!==key);if(e.target.checked)next.push(key);if(choice)b.value.from=next;else b.value=next;render();}}),name)));
            body.append(checks);
          }else if(b.field==='languages'){
            body.append(field('Языки (через запятую) / число языков на выбор',el('input',{value:Array.isArray(b.value)?b.value.join(', '):b.value,oninput:e=>b.value=/^\d+$/.test(e.target.value)?Number(e.target.value):e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})));
          }else body.append(field('Значение',input(b,'value',b.field==='speed'||b.field.startsWith('asi.')?'number':'text')));
          body.append(el('small',{class:'muted'},'Применяется при создании персонажа; повторное нажатие не накапливает бонусы.'));
        }
        card.append(body);stack.append(card);
      });
      if(!p.blocks.length)stack.append(el('div',{class:'block-empty'},'Добавьте первый блок из палитры слева.'));
      const check=el('div',{class:'mechanics-validation',role:'status'});root.append(el('button',{class:'small',onclick:()=>check.textContent=validate(m)||'✓ Структура корректна. Проверка ничего не расходует и не бросает.'},'Проверить цепочку'),check);
    }
    render(); return root;
  }
  function passiveData(entry) {
    const e=clone(entry);for(const p of e.data?.mechanics?.programs||[])if(p.trigger==='passive')for(const b of p.blocks||[])if(b.kind==='passive'&&b.enabled!==false){const parts=b.field.split('.');if(parts.some(k=>['__proto__','prototype','constructor'].includes(k)))continue;let d=e.data;parts.slice(0,-1).forEach(k=>{if(!d[k]||typeof d[k]!=='object')d[k]={};d=d[k];});d[parts.at(-1)]=clone(b.value);}
    return e;
  }
  function forFeature(m,name) {
    const ps=m?.programs?.filter(p=>p.trigger==='use'&&p.feature_name===name)||[];
    return ps.length?{version:VERSION,programs:clone(ps)}:undefined;
  }
  return {forFeature,VERSION,TYPES,STATS,block,dice,expression,starter,templates,templatePicker,migrate,normalize,programsOf,validate,editor,preview,buttons,programSummary,passiveData};
})();
