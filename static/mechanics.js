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
  // Русское название состояния по его ключу из набора conditions (запасом — сам ключ).
  const conditionName = key => window.Presets?.item('conditions', key)?.table?.ru || key;
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
  // Умолчания полей блока по виду — набор block_defaults (dice — строка формулы, condition_key — ключ состояния).
  function blockDefaults(kind) {
    const fields = window.Presets?.item('block_defaults', kind)?.table || {};
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
      if (key === 'dice') return ['dice', dice(value)];
      if (key === 'condition_key') return ['condition', conditionName(value)];
      return [key, JSON.parse(JSON.stringify(value))];
    }));
  }
  function block(kind) {
    const b={id:uid(),kind,enabled:true,when:'always'};
    return Object.assign(b, blockDefaults(kind));
  }
  // Библиотека шаблонов и стартовые программы — наборы mechanic_templates и mechanic_starters (static/presets/).
  // Описание блока в наборе: вид (kind) и поля; dice — строка формулы, condition_key — ключ состояния
  // (русское название берётся из набора conditions), item — поля предмета поверх умолчаний вида.
  const libraryOf = kind => window.Presets?.items(kind) || [];
  /// Стартовый набор блоков для новой записи создания персонажа (раса, класс, предыстория): влияет на характеристики,
  /// владения и даёт заготовку умения. Правится как обычные блоки.
  function starter(category) {
    const item = libraryOf('mechanic_starters').find(i => i.id === category);
    if (!item) return undefined;
    return JSON.parse(JSON.stringify(item.table));
  }
  /// Шаблоны: готовые цепочки блоков из набора mechanic_templates. build() собирает новую программу.
  function templateList() {
    return libraryOf('mechanic_templates').map(item => {
      const t = item.table;
      return { id: item.id, group: t.group, name: t.name, hint: t.hint, chain: t.chain || [], creation: Boolean(t.creation), build: () => { const p = window.Mechanics.toLegacy({ version: 2, graph: clone(t.graph) }).programs[0]; return { ...p, blocks: p.blocks.map(b => ({ ...b, id: uid() })) }; } };
    });
  }
  const templates = (category) => templateList().filter(t => ['race','class','background'].includes(category) ? !!t.creation : !t.creation);
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
    // Описание снаряжения само по себе не доказывает, что предмет активируется.
    // Для предмета правило добавляется только рядом с явным расходом или броском; пассивный текст остаётся описанием.
    if(category!=='item' && !blocks.some(b=>b.kind==='manual') && (doc.desc || doc.text)) blocks.push({...block('manual'),text:doc.desc||doc.text});
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
    return el('div',{class:'mechanics-preview'},...programsOf(m).map(p=>el('details',{},el('summary',{},p.name,' · ',p.trigger==='passive'?'параметры':`${p.blocks.length} блоков`),...p.blocks.map(b=>el('div',{class:'mechanic-preview-block '+(TYPES[b.kind]?.[1]||'')},el('b',{},TYPES[b.kind]?.[0]||b.kind),b.enabled===false?' · выключен':b.dice?' · '+expression(b.dice):b.kind==='consume'?` · −${b.amount} (${b.source})`:b.kind==='grant_item'?` · +${b.amount} ${b.item?.name||''}`:b.kind==='manual'?' · вручную':b.kind==='passive'?` · ${b.field}: ${JSON.stringify(b.value)}`:'',b.text?el('p',{class:'small muted'},b.text):null, b.dice?el('button',{class:'small',title:'Только кубики, без расхода и изменения листа',onclick:e=>Modules.roll(expression(b.dice),'Отдельный бросок: '+p.name,{ctx,kind:['attack','damage'].includes(b.kind)?b.kind:'other',...window.Modules?.modeFromEvent(e)})},'Бросить отдельно · без эффектов'):null)) )));
  }
  function buttons(doc, options={}) {
    const root=el('div',{class:'action-buttons mechanics-buttons'});
    for(const p of programsOf(doc.mechanics)) {
      if(p.trigger!=='use') continue;
      const blocks=(p.blocks||[]).filter(b=>b.enabled!==false);
      const st=window.BUTTON_STYLES?.[p.style]||window.BUTTON_STYLES?.default||{icon:'dice'};
      // Если в программе есть броски, на кнопке видна их формула. Одиночный бросок называем по его имени.
      const rollKinds=['attack','damage','heal','temp_hp','roll'];
      const rolls=blocks.filter(b=>rollKinds.includes(b.kind)&&b.dice);
      const pure=blocks.length===1&&blocks[0].kind==='roll';
      const formula=rolls.map(b=>expression(b.dice)).join(' · ');
      const caption=pure?(blocks[0].name||p.name):p.name;
      const program=el('button',{class:'act-btn btn-style-'+(window.BUTTON_STYLES?.[p.style]?p.style:'default'),disabled:options.disabled?'':null,title:formula?`${caption} · ${formula}`:programSummary(p),onclick:e=>{e.stopPropagation(); if(options.onProgram) options.onProgram(p,window.Modules?.modeFromEvent(e)||{}); else toast('Исполняемые эффекты применяются с листа персонажа. Справочник — только шаблон.');}},window.icon?.(st.icon,13),el('span',{},caption),el('small',{},formula?` ${formula}`:` ${blocks.length} блоков`));
      root.append(program);
    }
    return root;
  }
  function passiveData(entry) {
    const e=clone(entry);for(const p of e.data?.mechanics?.programs||[])if(p.trigger==='passive')for(const b of p.blocks||[])if(b.kind==='passive'&&b.enabled!==false){const parts=b.field.split('.');if(parts.some(k=>['__proto__','prototype','constructor'].includes(k)))continue;let d=e.data;parts.slice(0,-1).forEach(k=>{if(!d[k]||typeof d[k]!=='object')d[k]={};d=d[k];});d[parts.at(-1)]=clone(b.value);}
    return e;
  }
  function forFeature(m,name) {
    const ps=m?.programs?.filter(p=>p.trigger==='use'&&p.feature_name===name)||[];
    return ps.length?{version:VERSION,programs:clone(ps)}:undefined;
  }
  return {forFeature,VERSION,TYPES,STATS,block,dice,expression,starter,templates,migrate,normalize,programsOf,validate,preview,buttons,programSummary,passiveData};
})();
