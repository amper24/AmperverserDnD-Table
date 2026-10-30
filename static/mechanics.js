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
  const TYPES = { consume: ['Расход ресурса','cost'], attack: ['Атака','roll'], damage: ['Урон · бросок','roll'], heal: ['Лечение','effect'], temp_hp: ['Временные хиты','effect'], roll: ['Своё действие','roll'], grant_item: ['Выдать предмет','effect'], condition: ['Состояние','effect'], adjust: ['Изменить показатель','effect'], require: ['Проверка условия','control'], manual: ['Ручное правило','control'], passive: ['Параметр при создании','passive'], setvar: ['Записать переменную','effect'], hands: ['Руки','effect'] };
  // Спасбросок цели — не бросок игрока: его кидает цель (или ДМ), а лист показывает правило и урон.
  // Короткий код характеристики: «МДР» в русском тексте, «WIS» в английском.
  const ABILITY_INPUT = { str: 'str', dex: 'dex', con: 'con', int: 'int', wis: 'wis', cha: 'cha',
                          'СИЛ': 'str', 'ЛОВ': 'dex', 'ТЕЛ': 'con', 'ИНТ': 'int', 'МДР': 'wis', 'ХАР': 'cha',
                          'Сила': 'str', 'Ловкость': 'dex', 'Телосложение': 'con', 'Интеллект': 'int', 'Мудрость': 'wis', 'Харизма': 'cha',
                          'Strength': 'str', 'Dexterity': 'dex', 'Constitution': 'con', 'Intelligence': 'int', 'Wisdom': 'wis', 'Charisma': 'cha' };
  const ABILITY_CODES = { ru: { str: 'СИЛ', dex: 'ЛОВ', con: 'ТЕЛ', int: 'ИНТ', wis: 'МДР', cha: 'ХАР' },
                          en: { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' } };
  const abilityCode = (value, lang = 'ru') => {
    const text = String(value ?? '').replace(/\{\{?@?dc\}?\}/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const known = text.match(/СИЛ|ЛОВ|ТЕЛ|ИНТ|МДР|ХАР|STR|DEX|CON|INT|WIS|CHA|Сила|Ловкость|Телосложение|Интеллект|Мудрость|Харизма/);
    const key = ABILITY_INPUT[known ? known[0] : text.toLowerCase()];
    return key ? ABILITY_CODES[lang === 'en' ? 'en' : 'ru'][key] : text;
  };
  const SAVE_RULE = {
    ru: (ability, effects, dc) => `Спасбросок${ability ? ' (' + ability + ')' : ''}${effects ? ' — эффекты: ' + effects : ''}: бросает цель или ДМ, а не игрок. `
      + (dc ? `СЛ ${dc} из записи.` : `СЛ = 8 + владение + модификатор характеристики заклинаний${effects ? '' : '; при успехе урон и эффект — по описанию заклинания'}.`),
    en: (ability, effects, dc) => `Saving throw${ability ? ' (' + ability + ')' : ''}${effects ? ' — effects: ' + effects : ''}: the target or the GM rolls it, not the player. `
      + (dc ? `DC ${dc} from the record.` : `DC = 8 + proficiency + the spellcasting ability modifier${effects ? '' : '; on a success the damage and effect follow the description'}.`),
  };
  const SAVE_RULE_TEXTS = [/бросает цель или ДМ/, /the target or the GM rolls it/];
  /// Правило спасброска цели. effects — перечень эффектов со своей характеристикой, dc — готовая СЛ из записи.
  const saveRule = (ability, effects = [], lang = 'ru', dc = 0) => {
    const list = (Array.isArray(effects) ? effects : [effects]).map(x => String(x || '').trim()).filter(Boolean);
    return SAVE_RULE[lang === 'en' ? 'en' : 'ru'](abilityCode(ability, lang), list.join(', '), Number(dc) || 0);
  };
  /// Узнаётся ли в тексте служебное правило спасброска цели.
  const isSaveRule = text => SAVE_RULE_TEXTS.some(re => re.test(String(text || '')));
  function dice(expr) {
    const text=String(expr || '0').replace(/\s/g,'').replace(/к/g,'d');
    const m=text.match(/^(?:(\d*)d(\d+))?([+-]?\d+)?(?:\+@([a-z_]+))?$/i);
    if(!m || (!m[1]&&!m[2]&&!m[3]&&!m[4])) return {count:0,sides:6,bonus:0,stat:'',advanced:text};
    return {count:m[2]?Number(m[1]||1):0,sides:Number(m[2]||6),bonus:Number(m[3]||0),stat:m[4]||''};
  }
  /// Формула кости в каноничном виде: «1d20+@atk», «2к6+3», «@dex», «5». Нулевой бонус не пишется —
  /// иначе на кнопке действия появлялось «1d20+0+@atk_str». Тот же вид у серверной formula() и у
  /// NodeRegistry.diceTerm: формулу показывает кнопка, ею же считает лист.
  function expression(d) {
    if (!d) return '';
    if (d.advanced) return String(d.advanced);
    const count = Number(d.count) || 0, sides = Number(d.sides) || 0, bonus = Number(d.bonus) || 0;
    let out = count > 0 && sides > 0 ? `${count}d${sides}` : '';
    if (bonus) out += out ? (bonus > 0 ? '+' : '') + bonus : String(bonus);
    if (d.stat) out += (out ? '+' : '') + '@' + d.stat;
    return out || '0';
  }
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
  /// Программы плана исполнения для показа.
  const programsOf = m => m?.programs ? clone(m.programs) : [];
  function validate(m) {
    if(!m || m.version!==VERSION || !Array.isArray(m.programs) || m.programs.length>256) return 'Неподдерживаемая схема механик.';
    const ids=new Set();
    for(const p of m.programs) {
      if(!p.id || ids.has(p.id) || !p.name?.trim()) return 'Действию нужны уникальный ID и название.'; ids.add(p.id);
      if(!['use','passive'].includes(p.trigger)||!Array.isArray(p.blocks)||p.blocks.length>32) return 'Действие: до 32 блоков, триггер использования или параметров.';
      const bids=new Set(); let gate=false;
      for(const b of p.blocks) {
        if(!b.id||bids.has(b.id)||!TYPES[b.kind]) return 'Неизвестный блок или повторяющийся ID.'; bids.add(b.id);
        if(b.enabled===false) continue;
        if(p.trigger==='passive'&&!['passive','manual'].includes(b.kind)||b.kind==='passive'&&p.trigger!=='passive')return 'Пассивные параметры помещаются в программу «Параметры при создании», отдельно от активных эффектов.';
        if(b.kind==='consume'&&b.trigger==='attack'&&!p.blocks.slice(p.blocks.indexOf(b)+1).some(x=>x.kind==='attack'&&x.enabled!==false))return 'Расход за атаку должен стоять перед атакой.';

        if(b.when && b.when!=='always' && !gate) return 'Условному блоку нужна предшествующая атака или спасбросок.';
        if(b.kind==='attack') gate=true;
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
  // Живой контекст листа: ctxFromSheet() заполняет prof/level, пустой объект — справочник без листа.
  const liveContext = ctx => ctx && typeof ctx === 'object' && Number.isFinite(ctx.prof) ? ctx : null;
  function preview(m, ctx) {
    if(!m) return null;
    return el('div',{class:'mechanics-preview'},...programsOf(m).map(p=>el('details',{},el('summary',{},p.name,' · ',p.trigger==='passive'?'параметры':`${p.blocks.length} блоков`),...p.blocks.map(b=>el('div',{class:'mechanic-preview-block '+(TYPES[b.kind]?.[1]||'')},el('b',{},TYPES[b.kind]?.[0]||b.kind),b.enabled===false?' · выключен':b.dice?' · '+shownDice(b.dice,ctx):b.kind==='consume'?` · −${b.amount} (${b.source})`:b.kind==='hands'?` · ${b.operation==='set'?`рук: ${b.count}`:`${b.operation==='add'?'+':'−'}${b.count} доп.`}`:b.kind==='grant_item'?` · +${b.amount} ${b.item?.name||''}`:b.kind==='manual'?' · вручную':b.kind==='passive'?` · ${b.field}: ${JSON.stringify(b.value)}`:'',b.text?el('p',{class:'small muted'},b.text):null, b.dice?el('button',{class:'small',title:'Только кубики, без расхода и изменения листа. Alt — преимущество, Ctrl — помеха, правая кнопка — выбрать режим',onclick:e=>Modules.roll(expression(b.dice),'Отдельный бросок: '+p.name,{ctx,kind:['attack','damage'].includes(b.kind)?b.kind:'other',...window.Modules?.modeFromEvent(e)}),oncontextmenu:e=>window.Modules?.openModeMenu?.(e,'Отдельный бросок: '+p.name,mode=>Modules.roll(expression(b.dice),'Отдельный бросок: '+p.name,{ctx,kind:['attack','damage'].includes(b.kind)?b.kind:'other',...mode}))},'Бросить отдельно · без эффектов'):null)) )));
  }
  // Формула на экране: с листа — посчитанная («1d20+7»), без листа — знаками («1d20+@atk»).
  function shownDice(d, ctx) {
    const formula = expression(d), live = liveContext(ctx);
    return live && window.Modules?.resolve ? window.Modules.resolve(formula, live) : formula;
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
      // На листе формула показана посчитанной («1d20+7»), в справочнике без листа — знаками («1d20+@atk»).
      const live=liveContext(options.context);
      const shown=formula&&live?formula.split(' · ').map(part=>window.Modules.resolve(part,live)).join(' · '):formula;
      const caption=pure?(blocks[0].name||p.name):p.name;
      const fire=mode=>{ if(options.onProgram) options.onProgram(p,mode||{}); else toast('Исполняемые эффекты применяются с листа персонажа. Справочник — только шаблон.'); };
      // Правый клик по кнопке с бросками: обычный бросок / помеха / преимущество — как у характеристик и навыков листа.
      const modeMenu=rolls.length&&options.onProgram&&window.Modules?.openModeMenu;
      const hint=rolls.length&&options.onProgram?'\nAlt — преимущество, Ctrl — помеха, Shift — только мастеру, правая кнопка — выбрать режим':'';
      const program=el('button',{class:'act-btn btn-style-'+(window.BUTTON_STYLES?.[p.style]?p.style:'default'),disabled:options.disabled?'':null,title:(shown?`${caption} · ${shown}`:programSummary(p))+hint,onclick:e=>{e.stopPropagation(); fire(window.Modules?.modeFromEvent(e)||{});},...(modeMenu?{oncontextmenu:e=>window.Modules.openModeMenu(e,caption,fire)}:{})},window.icon?.(st.icon,13),el('span',{},caption),el('small',{},shown?` ${shown}`:` ${blocks.length} блоков`));
      root.append(program);
    }
    return root;
  }
  function passiveData(entry) {
    const e=clone(entry);for(const p of e.data?.mechanics?.programs||[])if(p.trigger==='passive')for(const b of p.blocks||[])if(b.kind==='passive'&&b.enabled!==false){const parts=b.field.split('.');if(parts.some(k=>['__proto__','prototype','constructor'].includes(k)))continue;let d=e.data;parts.slice(0,-1).forEach(k=>{if(!d[k]||typeof d[k]!=='object')d[k]={};d=d[k];});d[parts.at(-1)]=clone(b.value);}
    return e;
  }
  /// Программы плана одного именованного действия (базовый слой без графа).
  function forFeature(m,name) {
    const ps=m?.programs?.filter(p=>p.trigger==='use'&&p.feature_name===name)||[];
    return ps.length?{version:VERSION,programs:clone(ps)}:undefined;
  }
  return {forFeature,VERSION,TYPES,block,dice,expression,starter,templates,programsOf,validate,preview,buttons,passiveData,saveRule,abilityCode,isSaveRule};
})();
