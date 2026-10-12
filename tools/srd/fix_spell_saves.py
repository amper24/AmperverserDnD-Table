#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Спасброски заклинаний: структурированные данные для обеих редакций.

В SRD 5.1 у заклинаний есть машинное поле `dc` (характеристика спасброска), поэтому в справочнике
2014 у заклинаний есть `data.save_ability`, действие `{kind:"save"}` и отдельная программа
«Отдельный бросок: Спасбросок». В дампе SRD 5.2.1 (5e-bits/5e-database) поля `dc` больше нет —
во всех 339 заклинаниях 2024 спасбросок упоминается только в официальном тексте, поэтому
`save_ability` был пуст, кнопки и программы спасброска у заклинаний 2024 отсутствовали,
хотя у 2014 они есть.

Скрипт восстанавливает паритет по официальному английскому тексту SRD 5.2.1:

* берутся только фразы, где спасбросок ВЫНУЖДЕН («must make/must succeed on/makes a … saving throw»);
* характеристика принимается, только если она единственная в заклинании — спорные записи
  (несколько разных спасбросков, напр. «Радужная стена») не меняются и печатаются в отчёте как «не установлено»;
* если текст задаёт собственную СЛ («DC 15 Intelligence saving throw»), в подсказке ставится число,
  иначе используется СЛ заклинателя `{{@dc}}`;
* в запись добавляются `data.save_ability`, действие вида `save`, зеркальная английская строка в
  `data.i18n.en.actions!` и программа «Отдельный бросок: Спасбросок» (те же тексты и узлы, что у 2014).

    python3 tools/srd/fix_spell_saves.py [--src /tmp/srd] [--check]

Второй проход ничего не меняет. `--check` ничего не пишет и завершается кодом 1, если паритет
редакций нарушен (у заклинания есть спасбросок, но нет данных о нём).
Исходники 5e-database берутся из каталога со подкаталогами `2014`/`2024` (как у tools/srd/build_srd.py).
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ru_names as R          # noqa: E402
import i18n_terms as T        # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# Характеристика в официальном английском тексте → код в данных проекта.
ABILITIES = {'Strength': 'СИЛ', 'Dexterity': 'ЛОВ', 'Constitution': 'ТЕЛ', 'Intelligence': 'ИНТ', 'Wisdom': 'МДР', 'Charisma': 'ХАР'}
# Фразы, где спасбросок вынуждает заклинание (а не «спасброски» вообще, как у bless или haste:
# «Advantage on Dexterity saving throws» — это не вынужденный спасбросок и не должно попадать сюда).
FORCED = [
    re.compile(r'must\s+(?:also\s+)?(?:make|succeed\s+on)\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'\bmakes?\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'succeeds?\s+on\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'fails?\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'must\s+first\s+make\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
]
# Узлы программы спасброска и её английская подпись — те же, что у 2014 (tools/srd/mechanics.py).
PROGRAM_RU = 'Отдельный бросок: Спасбросок'
PROGRAM_EN = 'Separate roll: Saving throw'
ROLL_ONLY_RU = ('Только отдельный бросок кубиков: не тратит ячейку, заряд или действие и ничего не применяет к цели — '
                'результат применяет ДМ. Сверьте момент, количество и условия урона с полным описанием; поздний '
                'и альтернативный урон не бросаются вместе.')
ROLL_ONLY_EN = ('A separate dice roll only: it spends no slot, charge or action and applies nothing to anyone — the GM '
                'applies the result. Check the timing, count and damage conditions against the full description; delayed '
                'and alternative damage are not rolled together.')
# id программ в графах записей справочника: базовый круг, второй бросок, третий бросок.
P1, P2, P3 = '18h9rwa', '187a67b', '17xakic'


def upstream_spells(src, edition):
    path = os.path.join(src, edition, '5e-SRD-Spells.json')
    if not os.path.exists(path):
        raise SystemExit(f'не найден дамп SRD: {path}')
    return {s['index']: s for s in json.load(open(path, encoding='utf-8'))}


def txt(value):
    if value is None:
        return ''
    if isinstance(value, list):
        return '\n'.join(txt(x) for x in value)
    return str(value)


def evidence(spell, ability):
    """Предложение официального текста, из которого взята характеристика (для отчёта и проверки человеком)."""
    text = txt(spell.get('description') or spell.get('desc')) + '\n' + txt(spell.get('higher_level'))
    for sentence in re.split(r'(?<=[.!?])\s+|\n', text):
        if re.search(rf'{ability}\s+saving\s+throw', sentence, re.I):
            return ' '.join(sentence.split())[:200]
    return ''


def forced_save(spell):
    """(код характеристики, СЛ из текста или 0) для единственного вынужденного спасброска."""
    text = txt(spell.get('description') or spell.get('desc')) + '\n' + txt(spell.get('higher_level'))
    found, fixed = set(), set()
    for pattern in FORCED:
        for match in pattern.finditer(text):
            ability = match.group('ability').capitalize()  # в дампе 5.1 характеристики в тексте со строчной буквы
            if ability in ABILITIES:
                found.add(ability)
                if match.group('dc'):
                    fixed.add(int(match.group('dc')))
    if len(found) != 1:
        return (None, 0, sorted(found))
    return (ABILITIES[found.pop()], (fixed.pop() if len(fixed) == 1 else 0), [])


def save_action(ability, dc):
    note = f'СЛ {dc if dc else "{{@dc}}"} {ability}'
    return {'name': 'Спасбросок', 'kind': 'save', 'roll': '1d20', 'note': note}


def save_action_en(ability, dc):
    note = f'DC {dc if dc else "{{@dc}}"} {T.ABIL_EN[ability]}'
    return {'name': T.SPELL_ACTION_LABEL['Спасбросок'], 'kind': 'save', 'roll': '1d20', 'note': note}


def action_en(action):
    """Английская строка действия: имя, кость, тип урона и подсказка — по словарям локализации."""
    out = {'name': T.SPELL_ACTION_LABEL.get(action['name'], action['name']), 'kind': action['kind'], 'roll': action['roll']}
    if action.get('dtype'):
        out['dtype'] = T.DAMAGE_EN.get(action['dtype'], action['dtype'])
    if action.get('note'):
        # «СЛ {{@dc}} ЛОВ» → «DC {{@dc}} DEX»
        out['note'] = re.sub(r'^СЛ', 'DC', action['note']).replace(action['note'].split()[-1], T.ABIL_EN.get(action['note'].split()[-1], action['note'].split()[-1]))
    return out


def program_suffix(slug, program_id):
    """Суффикс id программы: у программ 2014/2024 он фиксирован, для лишних — из слага (детерминированно)."""
    fixed = {'p2': P2, 'p3': P3}
    if program_id in fixed:
        return fixed[program_id]
    import zlib
    value, digits = zlib.crc32(f'save:{slug}'.encode('utf-8')), '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while value:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
    return (out or '0')[:7].rjust(7, '0')


def next_program(graph, slug):
    """Свободный номер программы спасброска: p2 у заклинаний без второго броска, иначе следующий свободный."""
    used = {n['params'].get('program_id') for n in graph.get('nodes', []) if n['type'] == 'action.program'}
    index = 2
    while f'p{index}' in used:
        index += 1
    program_id = f'p{index}'
    return program_id, program_suffix(slug, program_id)


def program_nodes(program_id, suffix):
    """Узлы и связи программы спасброска (копия программы 2014 у «Огненного шара»)."""
    number = int(program_id[1:])
    y = 70 + (number - 1) * 170
    nodes = [
        {'id': f'program-{suffix}', 'type': 'action.program', 'params': {'program_id': program_id, 'name': PROGRAM_RU, 'trigger': 'use', 'roll_only': True}, 'position': {'x': 60, 'y': y}},
        {'id': f'action-{suffix}-1', 'type': 'action.manual', 'params': {'enabled': True, 'when': 'always', 'text': ROLL_ONLY_RU, 'block_id': 'b1'}, 'position': {'x': 330, 'y': y}},
        {'id': f'action-{suffix}-2', 'type': 'action.roll', 'params': {'enabled': True, 'when': 'always', 'dice': {'count': 1, 'sides': 20, 'bonus': 0, 'stat': ''}, 'damage_type': '', 'block_id': 'b2'}, 'position': {'x': 590, 'y': y}},
    ]
    links = [
        {'from': {'node': f'program-{suffix}', 'socket': 'exec'}, 'to': {'node': f'action-{suffix}-1', 'socket': 'exec'}},
        {'from': {'node': f'action-{suffix}-1', 'socket': 'exec'}, 'to': {'node': f'action-{suffix}-2', 'socket': 'exec'}},
    ]
    overlay = [
        {'id': f'program-{suffix}', 'params': {'program_id': program_id, 'name': PROGRAM_EN, 'trigger': 'use', 'roll_only': True}},
        {'id': f'action-{suffix}-1', 'params': {'enabled': True, 'when': 'always', 'text': ROLL_ONLY_EN, 'block_id': 'b1'}},
    ]
    return nodes, links, overlay


def patch_spell(row, data, ability, dc, report):
    """Добавляет данные спасброска 2024. Возвращает число вставок."""
    added = 0
    if data.get('save_ability') != ability:
        data['save_ability'] = ability
        added += 1
    actions = data.setdefault('actions', [])
    en = data.setdefault('i18n', {}).setdefault('en', {})
    en_actions = en.get('actions!')
    if not isinstance(en_actions, list) or len(en_actions) != len(actions):
        # Английский слой строится из базовых действий: старые строки уже переведены, новые — по словарям.
        en_actions = [action_en(a) for a in actions]
        en['actions!'] = en_actions
    if not any(a.get('kind') == 'save' for a in actions):
        actions.append(save_action(ability, dc))
        en_actions.append(save_action_en(ability, dc))
        added += 1
    graph = data.setdefault('mechanics', {}).setdefault('graph', {})
    has_program = any(n['type'] == 'action.program' and n['params'].get('name') == PROGRAM_RU for n in graph.get('nodes', []))
    program_id, suffix = next_program(graph, row['slug'])
    nodes, links, overlay = program_nodes(program_id, suffix)
    if not has_program:
        graph.setdefault('nodes', []).extend(nodes)
        graph.setdefault('links', []).extend(links)
        en_graph = en.setdefault('mechanics', {}).setdefault('graph', {})
        en_graph.setdefault('nodes', []).extend(overlay)
        added += 1
    report['patched'] += 1
    return added


def check_edition(rows, report, edition):
    """Паритет редакций: у заклинания со спасброском обязаны быть данные и программа."""
    for row in rows:
        if row['category'] != 'spell':
            continue
        data = row['data']
        has_action = any(a.get('kind') == 'save' for a in (data.get('actions') or []))
        has_program = any(n['type'] == 'action.program' and n['params'].get('name') == PROGRAM_RU
                          for n in (data.get('mechanics', {}).get('graph', {}).get('nodes') or []))
        if bool(data.get('save_ability')) != has_action:
            report['problems'].append(f'{edition}: {row["slug"]} — save_ability и действие kind=save расходятся')
        if bool(data.get('save_ability')) and not has_program:
            report['problems'].append(f'{edition}: {row["slug"]} — есть спасбросок, но нет программы «{PROGRAM_RU}»')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='/tmp/srd', help='каталог с дампами SRD: <src>/2014|2024/5e-SRD-Spells.json')
    ap.add_argument('--check', action='store_true', help='только проверить, ничего не писать')
    ap.add_argument('--list', action='store_true', help='напечатать все найденные спасброски с предложением-источником')
    args = ap.parse_args()
    report = {'patched': 0, 'problems': [], 'ambiguous': [], 'nosave': 0, 'fixed_dc': [], 'mismatch': [], 'found': []}
    for edition in ('2014', '2024'):
        path = os.path.join(ROOT, 'data_seed', f'srd_{edition}.json')
        rows = json.load(open(path, encoding='utf-8'))
        spells = upstream_spells(args.src, edition)
        changed = found = 0
        for row in rows:
            if row['category'] != 'spell':
                continue
            spell = spells.get(row['slug'].split('-', 1)[1])
            if not spell:
                report['problems'].append(f'{edition}: нет дампа SRD для {row["slug"]}')
                continue
            ability, dc, ambiguous = forced_save(spell)
            # Машинное поле dc (есть только в дампе SRD 5.1) главнее текста: оно и было источником данных 2014.
            dc_type = ((spell.get('dc') or {}).get('dc_type') or {}).get('name', '')
            machine = R.ABIL.get(dc_type, '')
            if machine:
                if ability and ability != machine:
                    report['mismatch'].append(f'{row["slug"]}: поле dc дампа SRD даёт {machine}, текст — {ability}')
                ability, ambiguous = machine, []
            if ambiguous:
                report['ambiguous'].append(f'{edition}: {row["slug"]} — спасброски {", ".join(ambiguous)}')
                continue
            if not ability:
                report['nosave'] += 1
                continue
            found += 1
            report['found'].append(f'{edition}: {row["slug"]} — {ability} — {evidence(spell, ability)}')
            if dc:
                report['fixed_dc'].append(f'{edition}: {row["slug"]} — своя СЛ {dc}')
            if not args.check:
                changed += patch_spell(row, row['data'], ability, dc, report)
        print(f'{edition}: вынужденный спасбросок в источнике у {found} заклинаний; вставок: {changed}')
        if changed and not args.check:
            open(path, 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
        check_edition(rows, report, edition)
    print(f'записей с данными спасброска: {report["patched"]}; заклинаний без вынужденного спасброска: {report["nosave"]}')
    for note in report['ambiguous']:
        print('не установлено однозначно:', note)
    for note in report['fixed_dc']:
        print('своя СЛ в тексте:', note)
    for note in report['mismatch']:
        print('расхождение поля dc и текста SRD:', note)
    if args.list:
        for note in report['found']:
            print(note)
    if report['problems']:
        for problem in report['problems'][:40]:
            print('ОШИБКА:', problem, file=sys.stderr)
        print(f'всего проблем: {len(report["problems"])}', file=sys.stderr)
        return 1
    print('паритет редакций по спасброскам соблюдён')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
