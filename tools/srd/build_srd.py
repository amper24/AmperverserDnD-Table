#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка встроенного справочника из SRD 5.1 (2014) и SRD 5.2 (2024).

Источник: https://github.com/5e-bits/5e-database (JSON-дампы SRD, лицензия CC-BY-4.0 / MIT).
Русские названия — tools/srd/ru_names.py (+ карта имён заклинаний из ru_spells.json).
Тексты описаний — оригинальный английский SRD (перевод в проект не входит).

Использование: python3 tools/srd/build_srd.py <dir-with-2014-and-2024> data_seed/
Результат: data_seed/srd_2014.json, data_seed/srd_2024.json
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
import ru_names as R

SRC = sys.argv[1] if len(sys.argv) > 1 else '/home/user/srd'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', '..', 'data_seed')
RU_SPELLS = json.load(open(os.path.join(os.path.dirname(__file__), 'ru_spells.json'), encoding='utf-8'))


def load(ed, name):
    p = os.path.join(SRC, ed, f'5e-SRD-{name}.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else []


def txt(v):
    if v is None: return ''
    if isinstance(v, list): return '\n'.join(txt(x) for x in v)
    return str(v)


def ru(name, fn):
    r = fn(name)
    return r


def entry(cat, slug, name_en, data, ru_name, ed):
    data = dict(data)
    data['edition'] = ed
    data['name_en'] = name_en
    return {'category': cat, 'slug': f'srd{ed[-2:]}-{slug}', 'name': ru_name or name_en, 'data': data}


def dice(s):
    return s.replace('d', 'к') if s else s


# ---------------- заклинания ----------------
def spells(ed):
    out = []
    for s in load(ed, 'Spells'):
        comps = ', '.join({'V': 'В', 'S': 'С', 'M': 'М'}.get(c, c) for c in s.get('components', []))
        if s.get('material'): comps += f" ({s['material']})"
        d = {
            'level': s['level'], 'school': R.SCHOOLS.get(s['school']['name'], s['school']['name']),
            'casting_time': s.get('casting_time', ''), 'range': s.get('range', ''), 'components': comps, 'duration': s.get('duration', ''),
            'concentration': bool(s.get('concentration')), 'ritual': bool(s.get('ritual')),
            'classes': [R.CLASSES.get(c['name'], c['name']) for c in s.get('classes', [])],
            'desc': txt(s.get('desc') or s.get('description')),
            'higher_level': txt(s.get('higher_level')),
        }
        dmgs = s.get('damage') or []
        if isinstance(dmgs, dict): dmgs = [dmgs]
        acts = []
        if s.get('attack_type'): acts.append({'name': 'Атака заклинанием', 'kind': 'attack', 'roll': '1d20+@spell'})
        for dm in dmgs:
            dt = R.DMG_TYPES.get((dm.get('damage_type') or {}).get('index', ''), (dm.get('damage_type') or {}).get('name', ''))
            if dt and 'damage_type' not in d: d['damage_type'] = dt
            table = dm.get('damage_at_slot_level') or dm.get('damage_at_character_level')
            if table:
                first = list(table.values())[0]
                formula = re.sub(r'\s*\+\s*MOD', '+@spell', first).replace(' ', '')
                if re.match(r'^[\dd+@a-z_]+$', formula): acts.append({'name': 'Урон', 'kind': 'damage', 'roll': formula, 'dtype': dt or None})
        if s.get('dc'):
            acts.append({'name': 'Спасбросок', 'kind': 'save', 'roll': '1d20', 'note': f"СЛ {{{{@dc}}}} {R.ABIL.get(s['dc']['dc_type']['name'], s['dc']['dc_type']['name'])}"})
            d['save_ability'] = R.ABIL.get(s['dc']['dc_type']['name'], '')
        heal = s.get('heal_at_slot_level')
        if heal:
            first = list(heal.values())[0]
            formula = re.sub(r'\s*\+\s*MOD', '+@spell', first).replace(' ', '')
            if re.match(r'^[\dd+@a-z_]+$', formula): acts.append({'name': 'Лечение', 'kind': 'heal', 'roll': formula})
        if acts: d['actions'] = acts
        out.append(entry('spell', s['index'], s['name'], d, RU_SPELLS.get(s['name']), ed))
    return out


# ---------------- монстры ----------------
def cr_str(cr):
    return {0.125: '1/8', 0.25: '1/4', 0.5: '1/2'}.get(cr, str(int(cr)) if float(cr).is_integer() else str(cr))


def monsters(ed):
    out = []
    for m in load(ed, 'Monsters'):
        ac = m.get('armor_class')
        ac_v = ac[0]['value'] if isinstance(ac, list) and ac else ac
        speed = ', '.join(f"{ {'walk': '', 'fly': 'полёт ', 'swim': 'плавание ', 'climb': 'лазание ', 'burrow': 'копание ', 'hover': 'парение '}.get(k, k + ' ')}{v}".strip() for k, v in (m.get('speed') or {}).items() if v is not True).replace('ft.', 'фт')
        saves, skills = [], []
        for p in m.get('proficiencies', []):
            n = p['proficiency']['name']
            if n.startswith('Saving Throw:'): saves.append(f"{R.ABIL.get(n.split(': ')[1], n.split(': ')[1])} +{p['value']}")
            elif n.startswith('Skill:'): skills.append(f"{R.SKILLS.get(n.split(': ')[1], n.split(': ')[1])} +{p['value']}")
        senses = ', '.join(f"{ {'darkvision': 'тёмное зрение', 'blindsight': 'слепое зрение', 'tremorsense': 'чувство вибрации', 'truesight': 'истинное зрение', 'passive_perception': 'пассивное Восприятие'}.get(k, k)} {v}" for k, v in (m.get('senses') or {}).items()).replace('ft.', 'фт')
        conv = lambda lst: [{'name': a['name'], 'text': txt(a.get('desc'))} for a in (lst or [])]
        d = {
            'size': R.SIZES.get(m.get('size'), m.get('size')), 'type': R.MTYPES.get(m.get('type'), m.get('type')) + (f" ({m['subtype']})" if m.get('subtype') else ''),
            'alignment': R.ALIGN.get(m.get('alignment'), m.get('alignment')),
            'cr': cr_str(m.get('challenge_rating', 0)), 'xp': m.get('xp'), 'ac': ac_v, 'hp': f"{m.get('hit_points')} ({dice(m.get('hit_points_roll') or m.get('hit_dice') or '')})",
            'speed': speed,
            'abilities': {'str': m['strength'], 'dex': m['dexterity'], 'con': m['constitution'], 'int': m['intelligence'], 'wis': m['wisdom'], 'cha': m['charisma']},
            'saves': ', '.join(saves), 'skills': ', '.join(skills),
            'vulnerabilities': ', '.join(m.get('damage_vulnerabilities', [])), 'resistances': ', '.join(m.get('damage_resistances', [])), 'immunities': ', '.join(m.get('damage_immunities', [])),
            'condition_immunities': ', '.join(R.CONDITIONS.get(c['name'], c['name']) for c in m.get('condition_immunities', [])),
            'senses': senses, 'languages': m.get('languages', ''),
            'traits': conv(m.get('special_abilities')), 'actions': conv(m.get('actions')), 'reactions': conv(m.get('reactions')), 'legendary_actions': conv(m.get('legendary_actions')),
            'desc': txt(m.get('desc')),
        }
        # кнопки бросков из действий: +N to hit / Melee Attack Roll: +N, урон в скобках
        acts = []
        for a in (m.get('actions') or []):
            desc = txt(a.get('desc'))
            hit = re.search(r'Attack(?: Roll)?:\s*\+(\d+)', desc)
            if hit: acts.append({'name': a['name'], 'kind': 'attack', 'roll': f"1d20+{hit[1]}"})
            for dm in a.get('damage', [])[:2]:
                dd = dm.get('damage_dice')
                if dd and re.match(r'^[\dd+\-]+$', dd.replace(' ', '')):
                    acts.append({'name': f"{a['name']}: урон", 'kind': 'damage', 'roll': dd.replace(' ', ''), 'dtype': R.DMG_TYPES.get((dm.get('damage_type') or {}).get('index', ''), '')})
        if acts: d['actions_roll'] = acts[:8]
        out.append(entry('monster', m['index'], m['name'], d, R.monster(m['name']), ed))
    return out


# ---------------- снаряжение и магические предметы ----------------
def equipment(ed):
    out = []
    for e in load(ed, 'Equipment'):
        cats = [c['name'] for c in e.get('equipment_categories', [])] or [e.get('equipment_category', {}).get('name', '')]
        cat = 'Weapon' if any(c in ('Weapon', 'Weapons') for c in cats) else 'Armor' if any(c in ('Armor',) for c in cats) else cats[0]
        d = {'cost': '', 'weight': e.get('weight', 0), 'desc': txt(e.get('desc') or e.get('description'))}
        if e.get('special'):
            special = txt(e['special'])
            if special and special not in d['desc']:
                d['desc'] = (d['desc'] + '\n' if d['desc'] else '') + special
        if e.get('cost'): d['cost'] = f"{e['cost']['quantity']} " + {'cp': 'мм', 'sp': 'см', 'ep': 'эм', 'gp': 'зм', 'pp': 'пм'}.get(e['cost']['unit'], e['cost']['unit'])
        if cat == 'Weapon':
            d['type'] = 'weapon'
            wc = e.get('weapon_category') or ('Martial' if any('Martial' in c for c in cats) else 'Simple')
            wr = e.get('weapon_range') or ('Ranged' if any('Ranged' in c for c in cats) else 'Melee')
            d['category'] = f"{ {'Simple': 'Простое', 'Martial': 'Воинское'}.get(wc, wc)} { {'Melee': 'рукопашное', 'Ranged': 'дальнобойное'}.get(wr, wr)}".strip()
            if e.get('damage'):
                d['damage'] = dice(e['damage']['damage_dice']); d['damage_type'] = R.DMG_TYPES.get(e['damage']['damage_type']['index'], e['damage']['damage_type']['name'])
            props = []
            for p in e.get('properties', []):
                n = R.WPROPS.get(p['name'], p['name']).capitalize()
                if p['name'] == 'Versatile' and e.get('two_handed_damage'): n += f" ({dice(e['two_handed_damage']['damage_dice'])})"
                if p['name'] in ('Thrown', 'Ammunition') and e.get('range'): n += f" ({e['range'].get('normal')}/{e['range'].get('long')})"
                props.append(n)
            d['properties'] = props
            if e.get('mastery'): d['mastery'] = e['mastery'].get('name')
        elif cat == 'Armor':
            d['type'] = 'armor'
            ac = e.get('armor_class', {})
            d['ac'] = str(ac.get('base', '')) + (' + Лов' + (f" (макс {ac['max_bonus']})" if ac.get('max_bonus') else '') if ac.get('dex_bonus') else '')
            ac_cat = e.get('armor_category') or next((c.split(' ')[0] for c in cats if c in ('Light Armor', 'Medium Armor', 'Heavy Armor', 'Shields')), 'Shield' if 'Shield' in e['name'] else '')
            d['category'] = {'Light': 'Лёгкий доспех', 'Medium': 'Средний доспех', 'Heavy': 'Тяжёлый доспех', 'Shield': 'Щит', 'Shields': 'Щит'}.get(ac_cat, ac_cat)
            if e.get('str_minimum'): d['str_req'] = e['str_minimum']
            if e.get('stealth_disadvantage'): d['stealth_disadvantage'] = True
            if ac_cat in ('Shield', 'Shields'): d['ac'] = '+2'
        else:
            d['type'] = 'gear'
            d['category'] = {'Adventuring Gear': 'Снаряжение', 'Tools': 'Инструменты', 'Mounts and Vehicles': 'Транспорт и ездовые животные', 'Mounts and Other Animals': 'Ездовые животные', 'Tack, Harness, and Drawn Vehicles': 'Упряжь и повозки', 'Waterborne Vehicles': 'Суда', 'Artisan\'s Tools': 'Инструменты ремесленника', 'Gaming Sets': 'Игровые наборы', 'Musical Instruments': 'Музыкальные инструменты', 'Equipment Packs': 'Наборы снаряжения', 'Ammunition': 'Боеприпасы', 'Arcane Foci': 'Магические фокусировки', 'Druidic Foci': 'Фокусировки друида', 'Holy Symbols': 'Священные символы', 'Kits': 'Наборы', 'Standard Gear': 'Снаряжение', 'Other Tools': 'Инструменты', 'Spellcasting Focus': 'Фокусировка'}.get(cat, cat)
            sub = e.get('gear_category') or e.get('tool_category') or e.get('vehicle_category')
            if sub: d['category'] = sub.get('name', sub) if isinstance(sub, dict) else sub
            if len(cats) > 1: d['category'] = {'Adventuring Gear': 'Снаряжение', 'Tools': 'Инструменты'}.get(cats[-1], cats[-1]) if cats[-1] in ('Adventuring Gear', 'Tools') else cats[0]
            if e.get('contents'): d['desc'] = (d['desc'] + '\n' if d['desc'] else '') + 'Содержимое: ' + ', '.join(f"{c['item']['name']} ×{c['quantity']}" for c in e['contents'])
        out.append(entry('item', e['index'], e['name'], d, R.equipment(e['name']), ed))
    for e in load(ed, 'Magic-Items'):
        rarity = (e.get('rarity') or {}).get('name', '')
        desc = txt(e.get('desc'))
        # В 5e-database SRD 5.2 этот один текст ошибочно подменён записью другого зелья.
        if ed == '2024' and e.get('index') == 'potion-of-gaseous-form':
            desc = "Potion, rare\nWhen you drink this potion, you gain the effect of the gaseous form spell for 1 hour (no concentration required) or until you end the effect as a Bonus Action. This potion's container seems to hold fog that moves and pours like water."
        d = {'type': 'magic', 'category': e.get('equipment_category', {}).get('name', ''),
             'rarity': {'Common': 'Обычный', 'Uncommon': 'Необычный', 'Rare': 'Редкий', 'Very Rare': 'Очень редкий', 'Legendary': 'Легендарный', 'Artifact': 'Артефакт', 'Varies': 'Разная'}.get(rarity, rarity or 'Необычный'),
             'desc': desc}
        if e.get('attunement') or re.search(r'requires attunement', d['desc'], re.I): d['attunement'] = True
        m = re.search(r'has (\d+) charges', d['desc'])
        if m: d['charges'] = int(m[1])
        if e.get('variants'): d['variants'] = [v['name'] for v in e['variants']]
        if e.get('variant'): d['is_variant'] = True
        out.append(entry('item', e['index'], e['name'], d, R.magic_item(e['name']), ed))
    return out


# ---------------- классы ----------------
def flevel(f):
    l = f.get('level', 1)
    if isinstance(l, dict):
        m = re.search(r'(\d+)$', l.get('index', '') or l.get('name', ''))
        return int(m[1]) if m else 1
    return int(l or 1)


def classes(ed):
    feats = {}
    for f in load(ed, 'Features'):
        f['level'] = flevel(f); f['desc'] = f.get('desc') or f.get('description') or ''
        feats.setdefault((f['class']['index'], (f.get('subclass') or {}).get('index')), []).append(f)
    subs = {s['index']: s for s in load(ed, 'Subclasses')}
    out = []
    for c in load(ed, 'Classes'):
        d = {'hit_die': f"d{c['hit_die']}", 'desc': txt(c.get('desc'))}
        d['saves'] = [s['index'] for s in c.get('saving_throws', [])]
        profs = [p['name'] for p in c.get('proficiencies', [])]
        d['armor'] = ', '.join(p for p in profs if 'Armor' in p or 'Shield' in p) or '—'
        d['weapons'] = ', '.join(p for p in profs if 'Weapon' in p or 'weapon' in p) or '—'
        skills = None
        for ch in c.get('proficiency_choices', []):
            opts = [o.get('item', {}).get('name', '') for o in ch.get('from', {}).get('options', [])]
            if any(o.startswith('Skill:') for o in opts):
                skills = {'choose': ch.get('choose', 2), 'from': [R.SKILLS.get(o.replace('Skill: ', ''), o.replace('Skill: ', '')) for o in opts if o.startswith('Skill:')]}
        if skills: d['skills'] = skills
        sc = c.get('spellcasting')
        if sc: d['spellcasting'] = sc.get('spellcasting_ability', {}).get('index')
        FALLBACK = {'barbarian': 'Сила', 'bard': 'Харизма', 'cleric': 'Мудрость', 'druid': 'Мудрость', 'fighter': 'Сила или Ловкость', 'monk': 'Ловкость и Мудрость', 'paladin': 'Сила и Харизма', 'ranger': 'Ловкость и Мудрость', 'rogue': 'Ловкость', 'sorcerer': 'Харизма', 'warlock': 'Харизма', 'wizard': 'Интеллект'}
        d['primary'] = FALLBACK.get(c['index'], (c.get('primary_ability') or {}).get('desc', '') if isinstance(c.get('primary_ability'), dict) else '')
        d['starting_equipment'] = txt([f"{x['equipment']['name']} ×{x['quantity']}" for x in c.get('starting_equipment', [])] + [o.get('desc', '') for o in c.get('starting_equipment_options', [])])
        by_level, texts = {}, {}
        for f in sorted(feats.get((c['index'], None), []), key=lambda f: (f.get('level', 0), f['name'])):
            by_level.setdefault(str(f.get('level', 1)), []).append(f['name'])
            texts[f['name']] = txt(f.get('desc'))
        d['features'] = by_level; d['feature_texts'] = texts
        d['subclasses'] = []
        for sref in c.get('subclasses', []):
            s = subs.get(sref['index'], {})
            sfe, stx = {}, {}
            for f in sorted(feats.get((c['index'], sref['index']), []), key=lambda f: (f.get('level', 0), f['name'])):
                sfe.setdefault(str(f.get('level', 1)), []).append(f['name']); stx[f['name']] = txt(f.get('desc'))
            d['subclasses'].append({'name': R.SUBCLASSES.get(s.get('name', sref['name']), s.get('name', sref['name'])), 'name_en': s.get('name', sref['name']), 'flavor': s.get('subclass_flavor', ''), 'desc': txt(s.get('desc')), 'features': sfe, 'feature_texts': stx})
        out.append(entry('class', c['index'], c['name'], d, R.CLASSES.get(c['name']), ed))
    return out


# ---------------- расы / виды ----------------
def races(ed):
    traits = {t['index']: t for t in load(ed, 'Traits')}
    out = []
    src = load(ed, 'Races') or load(ed, 'Species')
    subs = load(ed, 'Subraces') or load(ed, 'Subspecies')
    for r in src:
        asi = {}
        for b in r.get('ability_bonuses', []): asi[b['ability_score']['index']] = b['bonus']
        tr = []
        for t in r.get('traits', []):
            full = traits.get(t['index'], {})
            tr.append({'name': t['name'], 'text': txt(full.get('desc') or full.get('description'))})
        d = {'asi': asi, 'size': R.SIZES.get(r.get('size'), r.get('size')), 'speed': r.get('speed', 30), 'languages': [l['name'] for l in r.get('languages', [])] + ([r['language_desc']] if r.get('language_desc') and ed == '2014' else []),
             'traits': tr, 'desc': txt(r.get('desc') or r.get('alignment') or ''), 'age': r.get('age', ''), 'size_description': r.get('size_description', ''),
             'subraces': [R.RACES.get(s['name'], s['name']) for s in (r.get('subraces') or r.get('subspecies') or [])]}
        out.append(entry('race', r['index'], r['name'], d, R.RACES.get(r['name']), ed))
    for s in subs:
        parent = (s.get('race') or s.get('species') or {}).get('name', '')
        asi = {b['ability_score']['index']: b['bonus'] for b in s.get('ability_bonuses', [])}
        tr = [{'name': t['name'], 'text': txt(traits.get(t['index'], {}).get('desc') or traits.get(t['index'], {}).get('description'))} for t in s.get('racial_traits', s.get('traits', []))]
        d = {'asi': asi, 'parent': R.RACES.get(parent, parent), 'traits': tr, 'desc': txt(s.get('desc')), 'subrace': True}
        out.append(entry('race', s['index'], s['name'], d, R.RACES.get(s['name']), ed))
    return out


# ---------------- предыстории, черты, состояния ----------------
def backgrounds(ed):
    out = []
    for b in load(ed, 'Backgrounds'):
        profs = b.get('starting_proficiencies') or b.get('proficiencies') or []
        skills = [R.SKILLS.get(p['name'].replace('Skill: ', ''), p['name'].replace('Skill: ', '')) for p in profs if p['name'].startswith('Skill:')]
        tools = [p['name'].replace('Tool: ', '') for p in profs if not p['name'].startswith('Skill:')]
        d = {'skills': skills, 'tools': tools, 'desc': txt(b.get('desc'))}
        f = b.get('feature')
        if f: d['feature'] = f['name']; d['feature_text'] = txt(f.get('desc'))
        if b.get('feat'): d['feat'] = R.FEATS.get(b['feat']['name'], b['feat']['name'])
        if b.get('ability_scores'): d['asi_options'] = [R.ABIL.get(a['name'], a['name']) for a in b['ability_scores']]
        if b.get('language_options'): d['languages'] = b['language_options'].get('choose', 0)
        eq = [f"{x['equipment']['name']} ×{x['quantity']}" for x in b.get('starting_equipment', [])] + [o.get('desc', '') for o in b.get('equipment_options', []) if o.get('desc')]
        d['equipment'] = ', '.join(eq)
        if b.get('feat', {}).get('note'): d['feat'] += f" ({b['feat']['note']})"
        for k in ('personality_traits', 'ideals', 'bonds', 'flaws'):
            if b.get(k): d[k] = [txt(o.get('string') or o.get('desc') or o.get('item', {}).get('name', '')) for o in b[k].get('from', {}).get('options', [])]
        out.append(entry('background', b['index'], b['name'], d, R.BACKGROUNDS.get(b['name']), ed))
    return out


def feats(ed):
    out = []
    for f in load(ed, 'Feats'):
        pre = []
        for p in f.get('prerequisites', []) or []:
            if isinstance(p, dict): pre.append(f"{R.ABIL.get(p.get('ability_score', {}).get('name', ''), p.get('ability_score', {}).get('name', ''))} {p.get('minimum_score', '')}".strip())
            else: pre.append(str(p))
        d = {'desc': txt(f.get('desc') or f.get('description')), 'prerequisites': ', '.join(pre), 'category': f.get('category', '') if isinstance(f.get('category'), str) else (f.get('category') or {}).get('name', '')}
        out.append(entry('feat', f['index'], f['name'], d, R.FEATS.get(f['name']), ed))
    return out


def conditions(ed):
    out = []
    ru = {}
    rp = os.path.join(SRC, 'ru', '5e-SRD-Conditions.json')
    if os.path.exists(rp) and ed == '2014':
        for c in json.load(open(rp, encoding='utf-8')): ru[c['index']] = txt(c.get('desc'))
    for c in load(ed, 'Conditions'):
        out.append(entry('condition', c['index'], c['name'], {'desc': ru.get(c['index']) or txt(c.get('desc'))}, R.CONDITIONS.get(c['name']), ed))
    return out


def build(ed):
    res = spells(ed) + monsters(ed) + equipment(ed) + classes(ed) + races(ed) + backgrounds(ed) + feats(ed) + conditions(ed)
    from mechanics import convert
    return convert(res, ed)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for ed in ('2014', '2024'):
        data = build(ed)
        p = os.path.join(OUT, f'srd_{ed}.json')
        json.dump(data, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        # Механики переводятся из блоков v1 в граф v2 тем же конвертером, что использует редактор (Mechanics.migrate).
        import subprocess
        subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'graph_convert.cjs'), p, p], check=True)
        data = json.load(open(p, encoding='utf-8'))
        from collections import Counter
        c = Counter(e['category'] for e in data)
        untr = sum(1 for e in data if e['name'] == e['data']['name_en'])
        print(ed, dict(c), 'всего', len(data), 'без перевода названия', untr, 'размер', os.path.getsize(p) // 1024, 'KB')
