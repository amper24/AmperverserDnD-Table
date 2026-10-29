#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сверка бросков справочника с текстом записи и — при наличии дампа — с официальным SRD.

Проверяются не движок кубиков, а данные: тот ли бросок записан у умения. Правило простое —
бросок обязан быть виден в тексте, из которого он взят:

* монстры: бонус атаки `1d20+N` и кубики урона `NdM+K` из `data.actions_roll` ищутся в русском
  тексте умений записи («Рукопашная атака: +9», «14 (2к8 + 5) Звукового урона»);
* заклинания: кубики узлов `action.roll` (kind `damage` и `roll` — урон и лечение) ищутся в описании
  заклинания («8к6 урона огнём»); отдельные броски спасброска (`1d20`) не проверяются — их
  в описании и не должно быть;
* с `--src <каталог с дампом>` те же броски сверяются с официальным английским текстом:
  «+9 to hit» и «12 (2d6 + 5) bludgeoning damage» у 2014, «Attack Roll: +9» у 2024, плюс
  английское слово типа урона. Дамп берётся из 5e-database (`<src>/<редакция>/en/5e-SRD-*.json`).

Известные производные броски перечислены в `DERIVED` — текст дампа даёт слагаемое, а в справочнике
записан итог («Волшебная стрела»: три дротика по 1d4 + 1 → 3d4 + 3). Такой список печатается
в отчёте, чтобы исключение было видно, а не молча пропущено.

    python3 tools/srd/audit_rolls.py [--src /tmp/srd/src] [--list]

Код возврата 1 — если какой-то бросок не подтверждается ни текстом записи, ни дампом. Ничего не пишет.
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
EDITIONS = ('2014', '2024')

# Формулы урона в справочнике: с модификатором «2d8+5», «1d4-1» и без него («2d6»), либо плоское
# число («Укус» барсука — «1 Колющего урона»): у плоского броска нет костей, сверяется само число.
DICE_ROLL = re.compile(r'^(\d+)d(\d+)([+-]\d+)?$')
FLAT_ROLL = re.compile(r'^\d+$')

DAMAGE_EN = {'кислота': 'acid', 'дробящий': 'bludgeoning', 'колющий': 'piercing', 'рубящий': 'slashing',
             'электричество': 'lightning', 'яд': 'poison', 'огонь': 'fire', 'холод': 'cold',
             'излучение': 'radiant', 'некротический': 'necrotic', 'психический': 'psychic',
             'звук': 'thunder', 'силовое поле': 'force'}

# Производные броски: текст источника даёт слагаемое, справочник — итог для базового круга.
DERIVED = {
    'srd14-magic-missile': 'три дротика по 1d4 + 1 (в тексте дампа назван один дротик)',
}


def load_seed(edition):
    with open(os.path.join(ROOT, 'data_seed', f'srd_{edition}.json'), encoding='utf-8') as handle:
        return json.load(handle)


def compact(text):
    """Текст к сравнимому виду: «2к6 + 5» → «2d6+5», «1d4 − 1» → «1d4-1», пробелы убраны.

    Дамп 2024 пишет модификатор юникодными знаками (U+2212 «−» у барсука, U+2013 «–» у шакала),
    поэтому тире приводятся к ASCII; «к» заменяется на «d» только между цифрами, чтобы не портить
    слова («Колющего»)."""
    text = str(text or '').lower().translate({0x2212: '-', 0x2013: '-', 0x2014: '-'})
    return re.sub(r'(?<=\d)к(?=\d)', 'd', re.sub(r'\s+', '', text))


def record_texts(data):
    out = []
    for key in ('traits', 'actions', 'reactions', 'legendary_actions', 'bonus_actions'):
        for item in data.get(key) or []:
            if isinstance(item, dict) and item.get('text'):
                out.append(item['text'])
    if data.get('desc'):
        out.append(data['desc'])
    result = [compact(text) for text in out]
    # Плоский урон («1 Колющего урона»): сравнение по «попадание:1», а не по подстроке «1»,
    # иначе проверка ловит цифру из любого числа.
    for text in list(result):
        for match in re.finditer(r'(?:попадание|hit)[:.]?(\d+)(?!\d)', text):
            result.append(match.group(0))
    return result


def roll_forms(roll):
    """Формы, в которых формула урона обязана встретиться в тексте: кости, кости с модификатором,
    или — для плоского урона — само число после слова «Попадание» / «Hit»."""
    match = DICE_ROLL.match(roll)
    if match:
        dice = f'{match.group(1)}d{match.group(2)}'
        # Записан модификатор — он обязан быть и в источнике («1к4 - 1»), иначе запись «уточняет» SRD
        return {dice + match.group(3)} if match.group(3) else {dice}
    if FLAT_ROLL.match(roll):
        return {f'попадание:{roll}', f'hit:{roll}'}
    return None


def monster_rolls(rows, problems, report):
    attacks = damage = 0
    for row in rows:
        if row['category'] != 'monster':
            continue
        texts = record_texts(row['data'])
        for action in row['data'].get('actions_roll') or []:
            roll = compact(action.get('roll'))
            if action.get('kind') == 'attack':
                match = re.match(r'^1d20\+(\d+)$', roll)
                if not match:
                    continue
                attacks += 1
                bonus = match.group(1)
                if not any(f'+{bonus}' in text for text in texts):
                    problems.append(f'{row["slug"]} {action.get("name")}: бонус атаки +{bonus} не найден '
                                    f'в тексте умений записи')
            if action.get('kind') == 'damage':
                forms = roll_forms(roll)
                if forms is None:
                    continue
                damage += 1
                if not any(any(form in text for form in forms) for text in texts):
                    problems.append(f'{row["slug"]} {action.get("name")}: формула {roll} не найдена '
                                    f'в тексте умений записи')
    report['monster_attacks'] = report.get('monster_attacks', 0) + attacks
    report['monster_damage'] = report.get('monster_damage', 0) + damage


def spell_dice(rows, problems, report):
    checked = skipped = 0
    for row in rows:
        if row['category'] != 'spell':
            continue
        description = compact(row['data'].get('desc'))
        for node in ((row['data'].get('mechanics') or {}).get('graph') or {}).get('nodes', []):
            params = node.get('params') or {}
            if not (node['type'] == 'action.roll' and (params.get('kind') or 'roll') in ('damage', 'roll')):
                continue
            dice = params.get('dice') or {}
            if not dice.get('count'):
                continue
            base = f"{dice['count']}d{dice['sides']}"
            if base == '1d20':
                skipped += 1          # бросок спасброска или проверки: в описании его нет и быть не должно
                continue
            checked += 1
            full = base + (f"+{dice['bonus']}" if dice.get('bonus') else '')
            if full in description or base in description:
                continue
            if row['slug'] in DERIVED:
                report['derived'].append(f'{row["slug"]} {node["id"]}: {full} — {DERIVED[row["slug"]]}')
                continue
            problems.append(f'{row["slug"]} {node["id"]}: кубики {full} не найдены в описании заклинания')
    report['spell_dice'] = report.get('spell_dice', 0) + checked
    report['save_rolls_skipped'] = report.get('save_rolls_skipped', 0) + skipped


def item_dice(rows, problems, report):
    """Кубики урона оружия обязаны совпасть с полями записи: `damage`, «Универсальное (1к8)», описание."""
    checked = 0
    for row in rows:
        if row['category'] != 'item':
            continue
        data = row['data']
        fields = compact(' '.join([data.get('damage') or '', data.get('damage_type') or '',
                                   ' '.join(data.get('properties') or []), data.get('category') or '',
                                   data.get('desc') or '']))
        for node in ((data.get('mechanics') or {}).get('graph') or {}).get('nodes', []):
            params = node.get('params') or {}
            if not (node['type'] == 'action.roll' and params.get('kind') == 'damage'):
                continue
            dice = params.get('dice') or {}
            if not dice.get('count'):
                continue
            base = f"{dice['count']}d{dice['sides']}"
            if base == '1d20':
                continue
            checked += 1
            full = base + (f"+{dice['bonus']}" if dice.get('bonus') else '')
            if full not in fields and base not in fields:
                problems.append(f'{row["slug"]} {node["id"]}: кубики {full} не найдены в полях записи '
                                f'(damage «{data.get("damage")}»)')
            kind = (node.get('params') or {}).get('damage_type')
            if kind and data.get('damage_type') and kind != data['damage_type'] \
                    and compact(kind) not in fields and data.get('type') == 'weapon':
                problems.append(f'{row["slug"]} {node["id"]}: тип урона узла «{kind}» не совпал '
                                f'с типом оружия «{data["damage_type"]}»')
    report['item_dice'] = report.get('item_dice', 0) + checked


def dump_spells(src, edition, problems, report):
    """Сверка кубиков заклинаний с официальным английским текстом."""
    path = os.path.join(src, edition, 'en', '5e-SRD-Spells.json')
    if not os.path.exists(path):
        return 0
    dump = {spell['index']: spell for spell in json.load(open(path, encoding='utf-8'))}
    checked = 0
    for row in load_seed(edition):
        if row['category'] != 'spell':
            continue
        spell = dump.get(row['slug'].split('-', 1)[1])
        if not spell:
            continue
        parts = (list(spell.get('desc') or []) if edition == '2014' else [spell.get('description') or '']) \
            + list(spell.get('higher_level') or [])
        text = compact(' '.join(part for part in parts if part))
        for node in ((row['data'].get('mechanics') or {}).get('graph') or {}).get('nodes', []):
            params = node.get('params') or {}
            if not (node['type'] == 'action.roll' and (params.get('kind') or 'roll') in ('damage', 'roll')):
                continue
            dice = params.get('dice') or {}
            if not dice.get('count'):
                continue
            base = f"{dice['count']}d{dice['sides']}"
            if base == '1d20':
                continue
            checked += 1
            full = base + (f"+{dice['bonus']}" if dice.get('bonus') else '')
            if full in text or base in text or row['slug'] in DERIVED:
                continue
            problems.append(f'{row["slug"]} {node["id"]}: кубики {full} не найдены в официальном тексте')
    report.setdefault('dump_spell_dice', 0)
    report['dump_spell_dice'] += checked
    return checked


def dump_monsters(src, edition, problems, report):
    """Сверка бросков монстров с официальным английским текстом."""
    path = os.path.join(src, edition, 'en', '5e-SRD-Monsters.json')
    if not os.path.exists(path):
        return 0
    dump = {monster['index']: monster for monster in json.load(open(path, encoding='utf-8'))}
    checked = 0
    for row in load_seed(edition):
        if row['category'] != 'monster':
            continue
        monster = dump.get(row['slug'].split('-', 1)[1])
        if not monster:
            continue
        parts = []
        for key in ('desc', 'actions', 'special_abilities', 'reactions', 'legendary_actions', 'traits', 'bonus_actions'):
            value = monster.get(key)
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        parts.append(item.get('desc') or item.get('text') or '')
                    elif isinstance(item, str):
                        parts.append(item)
        text = compact(' '.join(parts))
        for action in row['data'].get('actions_roll') or []:
            roll = compact(action.get('roll'))
            if action.get('kind') == 'attack':
                match = re.match(r'^1d20\+(\d+)$', roll)
                if not match:
                    continue
                checked += 1
                bonus = match.group(1)
                # 2014: «+9 to hit»; 2024: «Melee Attack Roll: +9»
                if f'+{bonus}tohit' not in text and f'attackroll:+{bonus}' not in text:
                    problems.append(f'{row["slug"]} {action.get("name")}: бонус атаки +{bonus} не найден '
                                    f'в официальном тексте')
            if action.get('kind') == 'damage':
                forms = roll_forms(roll)
                if forms is None:
                    continue
                checked += 1
                if not any(form in text for form in forms):
                    problems.append(f'{row["slug"]} {action.get("name")}: формула {roll} не найдена '
                                    f'в официальном тексте')
                    continue
                english = DAMAGE_EN.get(action.get('dtype') or '')
                if english and english not in text:
                    problems.append(f'{row["slug"]} {action.get("name")}: тип урона '
                                    f'«{action.get("dtype")}» ({english}) не найден в официальном тексте')
    report.setdefault('dump_monster_rolls', 0)
    report['dump_monster_rolls'] += checked
    return checked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', help='каталог с дампом 5e-database: <src>/2014|2024/en/5e-SRD-*.json')
    ap.add_argument('--list', action='store_true', help='напечатать проверки по каждому броску')
    args = ap.parse_args()

    problems, report = [], {'derived': []}
    for edition in EDITIONS:
        rows = load_seed(edition)
        monster_rolls(rows, problems, report)
        spell_dice(rows, problems, report)
        item_dice(rows, problems, report)
    print(f'монстры: подтверждено текстом записи бросков атаки {report["monster_attacks"]}, '
          f'урона {report["monster_damage"]}')
    print(f'заклинания: подтверждено текстом записи кубиков урона и лечения {report["spell_dice"]} '
          f'(пропущено бросков спасброска {report["save_rolls_skipped"]})')
    print(f'предметы: подтверждено полями записи кубиков урона оружия {report.get("item_dice", 0)}')
    if args.src:
        for edition in EDITIONS:
            dump_spells(args.src, edition, problems, report)
            dump_monsters(args.src, edition, problems, report)
        print(f'официальный текст: кубиков заклинаний {report.get("dump_spell_dice", 0)}, '
              f'бросков монстров {report.get("dump_monster_rolls", 0)}')
    for note in report['derived']:
        print('производный бросок (известное исключение):', note)
    if problems:
        for problem in problems:
            print('ОШИБКА:', problem, file=sys.stderr)
        print(f'проблем: {len(problems)}', file=sys.stderr)
        return 1
    print('каждый записанный бросок подтверждён текстом записи'
          + (' и официальным SRD' if args.src else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
