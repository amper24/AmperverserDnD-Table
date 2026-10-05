#!/usr/bin/env python3
"""Conservative, deterministic SRD -> blocks migration. Does not execute extracted prose dice.
Re-running is idempotent. Existing non-generated mechanics are never overwritten.

Схема ориентирована на владельца листа: урон, спасброски и лечение других персонажей —
это бросок и правило, результат применяет ДМ (см. normalise()). После пересборки русской
механики инструмент пересчитывает и английский слой data.i18n.en.mechanics — он хранится
как разница по id программ и блоков.
"""
import json
import re
from pathlib import Path
from collections import Counter

VERSION = 1
ORIGIN = 'srd-blocks-v1'
PASSIVE = ('speed', 'hit_die', 'spellcasting', 'saves', 'skills', 'languages', 'armor', 'weapons')


# Строки, которые генератор подставляет сам (не из текста записи). Язык выбирается через convert(..., lang=...).
STR = {
    'ru': {
        'rule': 'Правило', 'feature': 'Особенность', 'creation': 'Параметры при создании', 'attack': 'Атака и урон',
        'choose_variant': 'Выбрать разновидность', 'variant_hint': 'Импортируйте конкретную разновидность зелья: эта запись — таблица редкостей, не отдельное зелье.',
        'empty_vial': 'Пустой флакон', 'drink': 'Выпить зелье', 'use': 'Использовать',
        'use_manual': 'Эффект и длительность применяются вручную по правилам предмета.',
        'spell_check': 'Проверьте дистанцию, допустимость цели, компоненты и ограничения в описании. Используется базовый круг; повышение круга требует отдельной программы.',
        'spell_default': 'Правила применения уточняет мастер.', 'ref_formula': 'Справочная формула (не автоматический эффект): ',
        'higher': 'Большие круги: ', 'cast': 'Сотворить (базовый круг)', 'cond_add': 'Наложить состояние', 'cond_remove': 'Снять состояние',
        'roll_only_name': 'Отдельный бросок: ', 'dice': 'Кубики',
        'roll_only': 'Только отдельный бросок кубиков: не тратит ячейку, заряд или действие и ничего не применяет к цели — результат применяет ДМ. Сверьте момент, количество и условия урона с полным описанием; поздний и альтернативный урон не бросаются вместе.',
        'heal_roll': 'Лечение',
        'heal_rule': 'Бросок показывает, сколько хитов восстановит заклинание. Допустимую цель выбирает игрок по правилам заклинания, а хиты применяет ДМ: себе — прибавьте результат к текущим хитам на листе.',
        'rules': 'Правила применения', 'no_mech': 'Нет активной автоматической механики. Параметры предмета приведены в карточке.',
    },
    'en': {
        'rule': 'Rule', 'feature': 'Feature', 'creation': 'Character creation parameters', 'attack': 'Attack and damage',
        'choose_variant': 'Choose a variant', 'variant_hint': 'Import a specific variant of the potion: this entry is a rarity table, not a single potion.',
        'empty_vial': 'Empty vial', 'drink': 'Drink the potion', 'use': 'Use',
        'use_manual': "Apply the effect and duration manually according to the item's rules.",
        'spell_check': 'Check the range, valid targets, components and restrictions in the description. The base spell level is used; upcasting needs a separate program.',
        'spell_default': 'The GM clarifies how the rules apply.', 'ref_formula': 'Reference formula (not an automatic effect): ',
        'higher': 'Higher levels: ', 'cast': 'Cast (base level)', 'cond_add': 'Apply condition', 'cond_remove': 'Remove condition',
        'roll_only_name': 'Separate roll: ', 'dice': 'Dice',
        'roll_only': 'A separate dice roll only: it spends no slot, charge or action and applies nothing to anyone — the GM applies the result. Check the timing, count and damage conditions against the full description; delayed and alternative damage are not rolled together.',
        'heal_roll': 'Healing',
        'heal_rule': 'The roll shows how many hit points the spell restores. The player chooses a legal target, and the GM applies the result: add it to your own current hit points if you healed yourself.',
        'rules': 'Rules', 'no_mech': 'No active automatic mechanics. The item parameters are shown on the card.',
    },
}
LANG = 'ru'


def _(key):
    return STR[LANG][key]


def block(kind, **kw):
    return {'kind': kind, 'enabled': True, 'when': 'always', **kw}


def dice(expr):
    expr = str(expr).replace('к', 'd').replace(' ', '')
    m = re.fullmatch(r'(?:(\d*)d(\d+))?([+-]?\d+)?(?:\+@([a-z_]+))?', expr)
    if not m or not expr:
        return {'count': 0, 'sides': 6, 'bonus': 0, 'stat': '', 'advanced': expr}
    count, sides, bonus, stat = m.groups()
    return {'count': int(count or 1) if sides else 0, 'sides': int(sides or 6), 'bonus': int(bonus or 0), 'stat': stat or ''}


def program(name, blocks, trigger='use', **kw):
    return {'name': name or _('rule'), 'trigger': trigger, 'blocks': blocks, **kw}


def manual(text):
    return block('manual', text=str(text))


def cost(**kw):
    return block('consume', resource='quantity', source='self', amount=1, trigger='use', **kw)


# Эффекты по чужой цели в системе не применяются: урон, спасброски и лечение других —
# это бросок и правило, результат применяет ДМ. Эффекты владельцу остаются.
TARGETED = ('attack', 'damage', 'roll', 'save')
SELF_ONLY = ('heal', 'temp_hp', 'condition', 'adjust', 'grant_item')


def normalise(programs):
    """Никаких чужих целей: эффекты — владельцу листа, ветвление без атаки безусловно.
    Зеркалит Mechanics.normalize (static/mechanics.js) и mechanics::normalize (src/mechanics.rs)."""
    for p in programs:
        gate = False
        for b in p['blocks']:
            kind = b.get('kind')
            if kind in TARGETED:
                b.pop('target', None)
                b.pop('apply', None)
            if kind in SELF_ONLY:
                b['target'] = 'self'
            if b.get('when') in ('hit', 'miss') and not gate:
                b['when'] = 'always'
            if kind == 'attack':
                gate = True
    return programs


def finalise(programs):
    programs = normalise(programs)
    for i, p in enumerate(programs):
        p['id'] = f'p{i+1}'
        for j, b in enumerate(p['blocks']):
            b['id'] = f'b{j+1}'
    return {'version': VERSION, 'origin': ORIGIN, 'programs': programs}


def convert_entry(e, edition):
    d = e['data']
    if d.get('mechanics', {}).get('origin', ORIGIN) != ORIGIN:
        return e
    category = e['category']
    name = d.get('name_en', '')
    programs = []
    params = []
    if category in ('race', 'class', 'background'):
        params = [block('passive', field=k, value=d[k]) for k in PASSIVE if k in d]
        params += [block('passive', field='asi.'+k, value=v) for k,v in d.get('asi', {}).items() if k in ('str','dex','con','int','wis','cha')]
        if params:
            programs.append(program(_('creation'), params, 'passive'))
    # Stable nested feature names are carried into character creation, not executed twice.
    for group in ('traits', 'actions', 'reactions', 'legendary_actions'):
        if category == 'item' or category == 'spell':
            break
        for row in d.get(group, []) or []:
            if isinstance(row, dict) and row.get('text'):
                programs.append(program(row.get('name', group), [manual(row['text'])], feature_name=row.get('name',''), group=group))
    for fname, text in d.get('feature_texts', {}).items():
        if text:
            programs.append(program(fname, [manual(text)], feature_name=fname))
    if d.get('feature_text'):
        programs.append(program(d.get('feature', _('feature')), [manual(d['feature_text'])], feature_name=d.get('feature',_('feature'))))
    if category == 'item' and d.get('type') == 'weapon' and d.get('damage'):
        props = ' '.join(d.get('properties', []))
        ranged = bool(re.search(r'дальнобойное|ranged', d.get('category',''), re.I))
        finesse = bool(re.search(r'фехтовальное|finesse', props, re.I))
        ab = 'dex' if ranged else 'best' if finesse else 'str'
        atk = 'atk' if ab=='best' else 'atk_'+ab
        actions = [block('attack', dice=dice('1d20+@'+atk))]
        versatile = re.search(r'(?:универсальное|versatile).*?\((\d+[кd]\d+)\)', props, re.I)
        actions.append(block('damage', dice=dice(str(d['damage'])+'+@'+ab), damage_type=d.get('damage_type',''), grip='one' if versatile else ''))
        if versatile:
            actions.append(block('damage', dice=dice(versatile[1]+'+@'+ab), damage_type=d.get('damage_type',''), grip='two'))
        if re.search(r'боеприпас|ammunition', props, re.I):
            tag = 'bolt' if 'crossbow' in name.lower() else 'bullet' if 'sling' in name.lower() else 'needle' if 'blowgun' in name.lower() else 'firearm_bullet' if name.lower() in ('musket','pistol') else 'arrow'
            actions.insert(0, block('consume', resource='quantity', source='tag', tag=tag, amount=1, trigger='attack'))
        programs.append(program(_('attack'), actions))
    elif category == 'item' and name in ('Potion of Healing','Potion of Greater Healing','Potion of Superior Healing','Potion of Supreme Healing'):
        # The 2014 magic-item umbrella is a rarity table, not a fourfold potion.
        generic = name=='Potion of Healing' and (bool(d.get('variants')) or 'greater' in d.get('desc','').lower() or 'большого' in d.get('desc','').lower()) and not e['slug'].endswith('-common')
        if generic:
            programs.append(program(_('choose_variant'), [manual(d.get('desc','')+'\n'+_('variant_hint'))]))
        else:
            expr={'Potion of Healing':'2d4+2','Potion of Greater Healing':'4d4+4','Potion of Superior Healing':'8d4+8','Potion of Supreme Healing':'10d4+20'}[name]
            programs.append(program(_('drink'), [cost(),block('heal',dice=dice(expr),target='self',apply=True),block('grant_item',target='self',amount=1,item={'name':_('empty_vial'),'type':'gear','qty':1,'weight':0.1,'handedness':'none','stackable':True,'actions':[]})]))
    elif category == 'item' and (name.startswith('Potion of ') or name in ('Antitoxin (vial)','Antitoxin','Rations (1 day)','Rations')):
        programs.append(program(_('use'), [cost(),manual(d.get('desc','') or _('use_manual'))]))
    elif category == 'spell':
        blocks=[]
        level=d.get('level',0)
        if level:
            blocks.append(block('consume',resource='slot',source='self',slot_level=level,amount=1,trigger='use'))
        if name in ('Cure Wounds','Healing Word'):
            sides=8 if name=='Cure Wounds' else 4
            blocks.append(manual(_('spell_check')))
            # Лечение другого существа — отдельный бросок с правилом: хиты цели применяет ДМ.
            blocks.append(block('roll',name=_('heal_roll'),dice=dice(f'{2 if edition=="2024" else 1}d{sides}+@spell_mod')))
            blocks.append(manual(_('heal_rule')))
        else:
            blocks.append(manual(d.get('desc','') or _('spell_default')))
            # Existing explicitly authored spell roll buttons are preserved as MANUAL choices,
            # never concatenated: delayed damage / alternatives must not all fire at once.
            for a in d.get('actions',[]) or []:
                if a.get('roll'):
                    blocks[ -1 ]['text'] += '\n'+_('ref_formula')+a.get('name','')+' '+str(a['roll'])
        if d.get('higher_level'):
            blocks.append(manual(_('higher')+str(d['higher_level'])))
        programs.append(program(_('cast'),blocks))
    elif category == 'condition':
        programs.append(program(_('cond_add'), [block('condition',target='self',operation='add',condition=e['name']), manual(d.get('desc',''))]))
        programs.append(program(_('cond_remove'), [block('condition',target='self',operation='remove',condition=e['name'])]))
    # Preserve explicit legacy roll controls as separate, opt-in dice blocks. They are
    # NOT appended to a casting/action chain: the old extractor included delayed and
    # conditional damage in the same list. The GM chooses which isolated roll is due.
    legacy_rolls = d.get('actions_roll', []) if category == 'monster' else d.get('actions', []) if category == 'spell' and name not in ('Cure Wounds','Healing Word') else []
    for action in legacy_rolls or []:
        if not isinstance(action, dict) or not action.get('roll'):
            continue
        kind=action.get('kind','roll')
        if kind not in ('attack','damage','heal','save'):
            kind='roll'
        # A legacy heal/save control rolled dice only. Do not silently turn it into
        # HP mutation / target saving throw. Keep its numerical meaning as a roll.
        if kind in ('heal','save'):
            kind='roll'
        expr=str(action['roll'])
        if action.get('kind')=='heal':
            expr=re.sub(r'@spell\b','@spell_mod',expr)
        programs.append(program(_('roll_only_name')+action.get('name',_('dice')),[
            manual(_('roll_only')),
            block(kind,dice=dice(expr),damage_type=action.get('dtype',''))
        ],roll_only=True))
    if not programs:
        programs.append(program(_('rules'), [manual(d.get('desc','') or _('no_mech'))]))
    d['mechanics']=finalise(programs)
    ammo_defaults={'Arrow':(20,'arrow'),'Arrows':(20,'arrow'),'Crossbow bolt':(20,'bolt'),'Bolts':(20,'bolt'),'Sling bullet':(20,'bullet'),'Bullets, Sling':(20,'bullet'),'Blowgun needle':(50,'needle'),'Needles':(50,'needle'),'Bullets, Firearm':(10,'firearm_bullet')}
    if category=='item' and d.get('category') in ('Ammunition','Боеприпасы') and name in ammo_defaults:
        count,tag=ammo_defaults[name]
        d['mechanics']['item_defaults']={'qty':count,'unit_weight':d.get('weight',0)/count,'ammo_tag':tag,'type':'ammo'}
    return e


def convert(entries, edition, lang='ru'):
    global LANG
    LANG = lang
    try:
        return [convert_entry(e, edition) for e in entries]
    finally:
        LANG = 'ru'


def refresh_en(entries, edition):
    """Пересобирает английский слой механик (data.i18n.en.mechanics) после изменений генератора.

    Слой хранится как разница по id программ и блоков, поэтому при изменении состава
    блоков его надо пересчитать: собираем английский вид записи (слияние русских данных
    с существующим слоем) и заново берём diff от русской механики. Остальной перевод
    записи не трогается — он собран tools/srd/localize.py по параллельному корпусу.
    """
    import localize as LZ
    pairs = []
    for e in entries:
        ov = e.get('data', {}).get('i18n', {}).get('en')
        if not isinstance(ov, dict):
            continue
        base = {k: v for k, v in e['data'].items() if k != 'i18n'}
        pairs.append((e, {'category': e['category'], 'slug': e['slug'], 'name': e['name'], 'data': LZ.merge(base, ov)}))
    if not pairs:
        return 0
    convert([en for _, en in pairs], edition, lang='en')
    for e, en in pairs:
        ov = e['data']['i18n']['en']
        mp = LZ.diff(e['data']['mechanics'], en['data']['mechanics'])
        ov.pop('mechanics', None)
        if mp:
            ov['mechanics'] = mp
    return len(pairs)


if __name__=='__main__':
    root=Path(__file__).resolve().parents[2]
    report={}
    for edition in ('2014','2024'):
        path=root/'data_seed'/f'srd_{edition}.json'
        data=convert(json.loads(path.read_text()),edition)
        refreshed=refresh_en(data,edition)
        path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')))
        print(edition,'английский слой механик пересчитан:',refreshed)
        kinds=Counter(b['kind'] for e in data for p in e['data']['mechanics']['programs'] for b in p['blocks'])
        report[edition]={'records':len(data),'categories':dict(Counter(e['category'] for e in data)),'blocks':dict(kinds)}
    (root/'docs'/'mechanics-migration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
