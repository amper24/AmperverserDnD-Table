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
        'potion_action_2014': 'В редакции 2014 выпить зелье или ввести его другому существу требует действия. Игрок выбирает допустимую цель, мастер применяет результат.',
        'manual_charges': 'Автоматический расход не задан: сверьте условие и стоимость в описании предмета, затем спишите нужное число зарядов вручную.',
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
        'potion_action_2014': 'Under the 2014 rules, drinking or administering a potion takes an action. The player chooses a legal recipient, and the GM applies the result.',
        'manual_charges': "Automatic charge spending isn't set: check the item's trigger and cost in its description, then deduct the required charges manually.",
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


def cost(resource='quantity', amount=1):
    return block('consume', resource=resource, source='self', amount=amount, trigger='use')


# Использование предмета — только когда источник прямо задаёт действие/триггер.
# Пассивное «пока носите», бонусы оружия и таблицы разновидностей не становятся кнопкой.
ITEM_ACTION_RE = re.compile(
    r"\b(?:as\s+(?:an?\s+)?(?:bonus\s+|magic\s+|utilize\s+|use\s+|reaction\s+)?action|"
    r"(?:take|use|using|requires?\s+you\s+to\s+use)\s+(?:an?\s+)?(?:bonus\s+|magic\s+|utilize\s+|use\s+|reaction\s+)?action|"
    r"(?:bonus|magic|utilize|use)\s+action|"
    r"(?:as|use|using|take|when\s+you\s+use)\s+(?:a\s+|your\s+|its\s+|the\s+)?reaction\b|"
    r"use\s+(?:your\s+|its\s+|the\s+)?action\b|"
    r"when\s+you\s+take\s+(?:an?\s+)?(?:attack|magic|utilize)\s+action|"
    r"command\s+word|\bcast\b.{0,120}\b(?:from|using)\s+(?:the\s+)?(?:item|ring|wand|staff|rod|orb|weapon|it|this)\b)",
    re.I | re.S,
)
CHARGE_USE_RE = re.compile(
    r"\b(?:expend(?:s|ed|ing)?|spend(?:s|ing)?)\s+(?:the\s+)?"
    r"(?P<n>\d+|one|two|three|four|five|six|seven|eight|nine|ten)"
    r"(?:\s+of\s+(?:(?:its|the)\s+)?[a-z'’ -]{0,24})?\s+charges?\b",
    re.I,
)
CHARGE_ACTION_RE = re.compile(
    r"\b(?:expend(?:s|ed|ing)?|spend(?:s|ing)?)\b.{0,40}\bcharges?\b",
    re.I | re.S,
)
CHARGE_WORDS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
                'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10}
VARIABLE_CHARGE_RE = re.compile(
    r"\b(?:one\s+or\s+more|\d+\s+or\s+more|\d+\s+to\s+\d+|"
    r"up\s+to\s+\d+|any\s+number\s+of|as\s+many\s+charges?)\b|"
    r"\b(?:the\s+)?(?:necessary|required|appropriate|requisite)\s+number\s+of\s+charges\b|"
    r"\b(?:the\s+)?(?:table|list)\s+(?:indicates|shows)\s+how\s+many\s+charges\b|"
    r"\bhow\s+many\s+charges\s+you\s+must\s+expend\b",
    re.I,
)
CHARGE_TABLE_COST_RE = re.compile(r"\(\s*\d+\s+charges?\s*\)|\bcharge\s+cost\b", re.I)
AMBIGUOUS_CHARGE_USE_RE = re.compile(r"\buse\s+any\s+of\s+(?:its|the)\s+properties\b", re.I)
SINGLE_USE_NAMES = {
    'Acid', 'Acid (vial)', "Alchemist's Fire", "Alchemist's fire (flask)",
    'Antitoxin', 'Antitoxin (vial)', 'Holy Water', 'Holy water (flask)',
    'Oil', 'Oil (flask)', 'Poison, Basic', 'Poison, basic (vial)',
    'Bead of Force', 'Dust of Disappearance', 'Universal Solvent',
    'Oil of Etherealness', 'Oil of Sharpness', 'Oil of Slipperiness',
    'Philter of Love',
}
HEALING_POTION_DICE = {
    'srd14-potion-of-healing-common': '2d4+2',
    'srd14-potion-of-healing-greater': '4d4+4',
    'srd14-potion-of-healing-superior': '8d4+8',
    'srd14-potion-of-healing-supreme': '10d4+20',
    'srd24-potion-of-healing': '2d4+2',
}


def english_description(d):
    en = d.get('i18n', {}).get('en', {})
    return str(en.get('desc') or d.get('desc') or '')


def is_generic_item_family(e, d):
    """Табличная запись семейства — не отдельный экземпляр, который можно использовать."""
    name = d.get('name_en', '')
    if name == 'Spell Scroll' or name == 'Feather Token' or name == 'Potions of Healing':
        return True
    return bool(d.get('variants')) and not d.get('is_variant')


def item_quantity_cost(e, d):
    name = d.get('name_en', '')
    if name.startswith('Potion of ') and not is_generic_item_family(e, d):
        return True
    if name.startswith('Spell Scroll ') or name.startswith('Spell Scroll(') or name.startswith('Spell Scroll, '):
        return True
    if name == 'Feather Token' and not d.get('is_variant'):
        return False
    if 'Feather Token' in name and name != 'Feather Token':
        return True
    if name.startswith(('Oil of ', 'Philter of ', 'Elixir of ')):
        return True
    return name in SINGLE_USE_NAMES


def fixed_charge_cost(d, en_desc):
    if (not d.get('charges') or VARIABLE_CHARGE_RE.search(en_desc)
            or CHARGE_TABLE_COST_RE.search(en_desc) or AMBIGUOUS_CHARGE_USE_RE.search(en_desc)):
        return None
    if re.search(r"\b(?:at\s+will|without\s+expending\s+(?:a|any)\s+charge|"
                 r"does(?:n['’]t|\s+not)\s+expend\s+(?:a|any)\s+charge|"
                 r"no\s+charge\s+is\s+expended)\b", en_desc, re.I):
        return None
    costs = {int(m.group('n')) if m.group('n').isdigit() else CHARGE_WORDS[m.group('n').lower()]
             for m in CHARGE_USE_RE.finditer(en_desc)}
    return next(iter(costs)) if len(costs) == 1 else None


def has_item_activation(e, d, en_desc):
    name = d.get('name_en', '')
    if is_generic_item_family(e, d):
        return False
    if item_quantity_cost(e, d):
        return True
    if name.startswith('Potion of ') or name in ('Antitoxin', 'Antitoxin (vial)'):
        return True
    if name.startswith('Spell Scroll ') or name.startswith('Spell Scroll(') or name.startswith('Spell Scroll, '):
        return True
    return bool(ITEM_ACTION_RE.search(en_desc) or CHARGE_ACTION_RE.search(en_desc))


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


def item_programs(e, edition):
    """Только предметные действия, которые подтверждаются правилами/статистикой SRD."""
    d = e['data']
    name = d.get('name_en', '')
    slug = e.get('slug', '')
    desc = str(d.get('desc') or '').strip()
    props = ' '.join(d.get('properties', []))
    if d.get('type') == 'weapon':
        if d.get('damage'):
            ranged = bool(re.search(r'дальнобойное|ranged', d.get('category', ''), re.I))
            finesse = bool(re.search(r'фехтовальное|finesse', props, re.I))
            # Finesse даёт выбор Силы или Ловкости даже у дальнобойного дротика.
            ab = 'best' if finesse else 'dex' if ranged else 'str'
            atk = 'atk' if ab == 'best' else 'atk_' + ab
            actions = [block('attack', dice=dice('1d20+@' + atk))]
            versatile = re.search(r'(?:универсальное|versatile).*?\((\d+[кd]\d+)\)', props, re.I)
            actions.append(block('damage', dice=dice(str(d['damage']) + '+@' + ab),
                                 damage_type=d.get('damage_type', ''), grip='one' if versatile else ''))
            if versatile:
                actions.append(block('damage', dice=dice(versatile[1] + '+@' + ab),
                                     damage_type=d.get('damage_type', ''), grip='two'))
            if re.search(r'боеприпас|ammunition', props, re.I):
                tag = 'bolt' if 'crossbow' in name.lower() else 'bullet' if 'sling' in name.lower() else 'needle' if 'blowgun' in name.lower() else 'firearm_bullet' if name.lower() in ('musket', 'pistol') else 'arrow'
                actions.insert(0, block('consume', resource='quantity', source='tag', tag=tag, amount=1, trigger='attack'))
            if desc:
                actions.append(manual(desc))
            return [program(_('attack'), actions)]
        if name == 'Net' and edition == '2014' and desc:
            # В SRD 2014 сеть — дальнобойное оружие без урона: попадание накладывает правило сети.
            return [program(_('use'), [block('attack', dice=dice('1d20+@atk_dex')), manual(desc)])]
        return []

    healing = HEALING_POTION_DICE.get(slug)
    if healing:
        note = _('potion_action_2014') if edition == '2014' else ''
        rule = desc + (('\n\n' if desc else '') + note if note else '')
        # Зелье можно выпить самому или дать другому существу; бросок не лечит владельца листа.
        return [program(_('drink'), [cost(), manual(rule), block('roll', name=_('heal_roll'), dice=dice(healing))])]

    if is_generic_item_family(e, d):
        return []
    en_desc = english_description(d)
    if not has_item_activation(e, d, en_desc) or not desc:
        return []

    blocks = []
    if item_quantity_cost(e, d):
        blocks.append(cost())
    else:
        charge_cost = fixed_charge_cost(d, en_desc)
        if charge_cost is not None:
            blocks.append(cost('charges', charge_cost))
    rule = desc
    if name.startswith('Potion of ') and edition == '2014':
        rule += ('\n\n' if rule else '') + _('potion_action_2014')
    if d.get('charges') and re.search(r'\bcharges?\b', en_desc, re.I) and not any(b.get('resource') == 'charges' for b in blocks):
        rule += ('\n\n' if rule else '') + _('manual_charges')
    blocks.append(manual(rule))
    return [program(_('use'), blocks)]


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
    if category == 'item':
        programs.extend(item_programs(e, edition))
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
    ammo_defaults={'Arrow':(20,'arrow'),'Arrows':(20,'arrow'),'Crossbow bolt':(20,'bolt'),'Bolts':(20,'bolt'),'Sling bullet':(20,'bullet'),'Bullets, Sling':(20,'bullet'),'Blowgun needle':(50,'needle'),'Needles':(50,'needle'),'Bullets, Firearm':(10,'firearm_bullet')}
    item_defaults = None
    if category=='item' and d.get('category') in ('Ammunition','Боеприпасы') and name in ammo_defaults:
        count,tag=ammo_defaults[name]
        item_defaults={'qty':count,'unit_weight':d.get('weight',0)/count,'ammo_tag':tag,'type':'ammo'}
    if category == 'item' and not programs:
        # Пассивный предмет не получает пустую программу «Правила применения».
        if item_defaults:
            d['mechanics']=finalise([])
            d['mechanics']['item_defaults']=item_defaults
        else:
            d.pop('mechanics', None)
        return e
    if not programs:
        programs.append(program(_('rules'), [manual(d.get('desc','') or _('no_mech'))]))
    d['mechanics']=finalise(programs)
    if item_defaults:
        d['mechanics']['item_defaults']=item_defaults
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
        ru_mechanics = e['data'].get('mechanics')
        en_mechanics = en['data'].get('mechanics')
        ov.pop('mechanics', None)
        if ru_mechanics is not None and en_mechanics is not None:
            mp = LZ.diff(ru_mechanics, en_mechanics)
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
        kinds=Counter(b['kind'] for e in data for p in e['data'].get('mechanics', {}).get('programs', []) for b in p['blocks'])
        report[edition]={'records':len(data),'categories':dict(Counter(e['category'] for e in data)),
                         'mechanics_records':sum('mechanics' in e['data'] for e in data),'blocks':dict(kinds)}
    (root/'docs'/'mechanics-migration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
