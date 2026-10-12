#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сверка встроенного справочника с официальным дампом SRD (5e-bits/5e-database).

Проверяет машинно-сопоставимые поля (числа, кости, коды, перечисления), которые сборка
tools/srd/build_srd.py переносит из источника без перевода. Русские тексты и названия
сравниваются отдельно, слоем перевода, и здесь не участвуют.

Запуск (дамп берётся из git-архива проекта 5e-bits/5e-database, лицензия CC-BY-4.0/MIT):

    curl -sSL -o /tmp/5e.tar.gz https://codeload.github.com/5e-bits/5e-database/tar.gz/refs/heads/main
    mkdir -p /tmp/5e && tar -xzf /tmp/5e.tar.gz -C /tmp/5e --strip-components=1
    python3 tools/srd/compare_upstream.py --src /tmp/5e/src [--max 15]

Печатает по каждой категории и полю: сколько записей сверено, сколько совпало и примеры
расхождений. Ненулевые расхождения — повод проверить сборку или данные, а не «норма»:
все перечисленные поля в SRD машиночитаемые.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ru_names as R  # noqa: E402
import i18n_terms as T  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ABILITY_KEY = {'strength': 'str', 'dexterity': 'dex', 'constitution': 'con', 'intelligence': 'int', 'wisdom': 'wis', 'charisma': 'cha'}
SCHOOL_EN = {v: k for k, v in T.SCHOOL.items()} if hasattr(T, 'SCHOOL') else {}


def load(ed):
    path = os.path.join(ROOT, 'data_seed', f'srd_{ed}.json')
    return json.load(open(path, encoding='utf-8'))


def upstream(src, ed, name):
    path = os.path.join(src, ed, 'en', f'5e-SRD-{name}.json')
    return {row['index']: row for row in json.load(open(path, encoding='utf-8'))} if os.path.exists(path) else {}


def txt(value):
    if value is None:
        return ''
    if isinstance(value, list):
        return '\n'.join(txt(x) for x in value)
    return str(value)


def num(value):
    if isinstance(value, (int, float)):
        return value
    m = re.search(r'-?\d+(?:\.\d+)?', txt(value))
    return float(m.group(0)) if m else None


def compare_group(name, pairs, report):
    """pairs: список (slug, полe, значение набора, значение источника)."""
    stats = report.setdefault(name, {})
    for slug, field, ours, theirs in pairs:
        cell = stats.setdefault(field, {'checked': 0, 'same': 0, 'examples': []})
        cell['checked'] += 1
        if ours == theirs:
            cell['same'] += 1
        elif len(cell['examples']) < 8:
            cell['examples'].append(f'{slug}: набор «{ours}» ≠ источник «{theirs}»')


def normalize_dice(value):
    """«1d8 + MOD» / «1d8+@spell» → «1d8»; пробелы и регистр d/D приводятся к одному виду."""
    text = re.sub(r'\s*\+\s*(MOD|@spell)', '', txt(value)).replace(' ', '').replace('к', 'd')
    return text


def check_spells(src, ed, report, edition):
    rows = [r for r in load(ed) if r['category'] == 'spell']
    up = upstream(src, edition, 'Spells')
    class_ru = {en: ru for ru, en in T.CLASS.items()}
    damage_ru = {en: ru for ru, en in T.DAMAGE_EN.items()}
    pairs = []
    for row in rows:
        u = up.get(row['slug'].split('-', 1)[1])
        if not u:
            continue
        slug, d = row['slug'], row['data']
        pairs += [
            (slug, 'level', d['level'], u['level']),
            (slug, 'concentration', bool(d['concentration']), bool(u.get('concentration'))),
            (slug, 'ritual', bool(d['ritual']), bool(u.get('ritual'))),
            (slug, 'casting_time', bool(d['casting_time']), bool(u.get('casting_time'))),
            (slug, 'classes', sorted(d['classes']), sorted(class_ru.get(c['name'], c['name']) for c in u.get('classes', []))),
        ]
        dmg = u.get('damage') or []
        if isinstance(dmg, dict):
            dmg = [dmg]
        ours = sorted((normalize_dice(a['roll']), a.get('dtype') or '') for a in (d.get('actions') or []) if a.get('kind') == 'damage')
        theirs = []
        for item in dmg:
            table = item.get('damage_at_slot_level') or item.get('damage_at_character_level')
            if not table:
                continue
            index = (item.get('damage_type') or {}).get('index', '')
            theirs.append((normalize_dice(list(table.values())[0]), damage_ru.get(index, index)))
        if ours or theirs:
            pairs.append((slug, 'damage (кости и тип)', ours, sorted(theirs)))
    compare_group(f'{ed}: заклинания', pairs, report)


def check_monsters(src, ed, report, edition):
    rows = [r for r in load(ed) if r['category'] == 'monster']
    up = upstream(src, edition, 'Monsters')
    pairs = []
    for row in rows:
        u = up.get(row['slug'].split('-', 1)[1])
        if not u:
            continue
        slug, d = row['slug'], row['data']
        pairs += [
            (slug, 'xp', num(d['xp']), num(u.get('xp'))),
            (slug, 'hp', num(d['hp']), num(u.get('hit_points'))),
            (slug, 'ac', num(d.get('ac')), num((u.get('armor_class') or [{}])[0].get('value') if isinstance(u.get('armor_class'), list) else u.get('armor_class'))),
        ]
        for key, ru in ABILITY_KEY.items():
            pairs.append((slug, f'abilities.{ru}', int(num(d['abilities'][ru])), int(num(u.get(key)))))
    compare_group(f'{ed}: монстры', pairs, report)


def check_items(src, ed, report, edition):
    rows = [r for r in load(ed) if r['category'] == 'item']
    up = upstream(src, edition, 'Equipment')
    up_items = {**up, **upstream(src, edition, 'Magic-Items')}
    pairs = []
    for row in rows:
        slug = row['slug'].split('-', 1)[1]
        u = up_items.get(slug)
        if not u:
            continue
        d = row['data']
        weight = None
        if isinstance(u.get('weight'), (int, float)):
            weight = u['weight']
        elif isinstance(u.get('weight'), dict):
            weight = None
        cost = None
        if isinstance(u.get('cost'), dict):
            cost = u['cost'].get('quantity')
        for field, theirs in (('weight', weight), ('cost', cost)):
            ours = num(d.get(field))
            if theirs is not None:
                pairs.append((row['slug'], field, ours, num(theirs)))
        if (u.get('damage') or {}).get('damage_dice'):
            pairs.append((row['slug'], 'damage', (d.get('damage') or '').replace('к', 'd'), u['damage']['damage_dice'].replace(' ', '')))
    compare_group(f'{ed}: предметы', pairs, report)


def check_classes(src, ed, report, edition):
    rows = [r for r in load(ed) if r['category'] == 'class']
    up = upstream(src, edition, 'Classes')
    pairs = []
    for row in rows:
        u = up.get(row['slug'].split('-', 1)[1])
        if not u:
            continue
        d = row['data']
        pairs += [
            (row['slug'], 'hit_die', num(d['hit_die']), num(u.get('hit_die'))),
            (row['slug'], 'saves', sorted(d['saves']), sorted(ABILITY_KEY.get((p.get('index') or '').replace('saving-throw-', ''), p.get('index')) for p in u.get('saving_throws', []))),
            (row['slug'], 'skills.choose', int(d['skills']['choose']), int((u.get('proficiency_choices') or [{}])[0].get('choose', 0)) if u.get('proficiency_choices') else None),
        ]
        pairs = [p for p in pairs if p[3] is not None]
    compare_group(f'{ed}: классы', pairs, report)


def check_species(src, ed, report, edition):
    rows = [r for r in load(ed) if r['category'] == 'race']
    up = {**upstream(src, edition, 'Species' if edition == '2024' else 'Races'),
          **upstream(src, edition, 'Subspecies' if edition == '2024' else 'Subraces')}
    pairs = []
    for row in rows:
        u = up.get(row['slug'].split('-', 1)[1])
        if not u:
            continue
        d = row['data']
        if u.get('speed'):
            pairs.append((row['slug'], 'speed', num(d.get('speed')), num(u['speed']) if not isinstance(u['speed'], dict) else None))
    compare_group(f'{ed}: виды/расы', [p for p in pairs if p[3] is not None], report)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='/tmp/srd/src', help='каталог дампов: <src>/2014/en, <src>/2024/en')
    ap.add_argument('--max', type=int, default=10)
    args = ap.parse_args()
    report = {}
    for edition in ('2014', '2024'):
        ed = edition
        check_spells(args.src, ed, report, edition)
        check_monsters(args.src, ed, report, edition)
        check_items(args.src, ed, report, edition)
        check_classes(args.src, ed, report, edition)
        check_species(args.src, ed, report, edition)
    problems = 0
    for group, fields in report.items():
        print(f'== {group}')
        for field, cell in sorted(fields.items()):
            bad = cell['checked'] - cell['same']
            problems += bad
            mark = 'ок' if not bad else 'РАСХОЖДЕНИЯ'
            print(f'   {field}: сверено {cell["checked"]}, совпало {cell["same"]}, {mark} {bad if bad else ""}'.rstrip())
            for example in cell['examples'][:args.max]:
                print(f'      {example}')
    print(f'\nвсего расхождений: {problems}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
