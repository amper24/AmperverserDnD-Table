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
* характеристика принимается, только если она единственная в заклинании; заклинания с разными спасбросками
  для разных эффектов («Символ», «Радужная стена», «Радужные брызги», «Стена льда», «Землетрясение»,
  «Волшебная рука», «Гроза мщения») описаны таблицей MULTI_SAVES: первый спасбросок — основной
  (`data.save_ability`), каждый следующий получает своё действие «Спасбросок: <эффект>» и свою программу
  «Отдельный бросок: Спасбросок: <эффект>», чтобы кнопка считала нужную характеристику, а не первую;
  набор характеристик из таблицы сверяется с официальным текстом дампа (иначе — ошибка);
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
# «Advantage on Dexterity saving throws» — это не вынужденный спасбросок и не должен попадать сюда).
# Формулировки разные даже внутри одной редакции: «must make a dexterity saving throw», «must then make
# a constitution saving throw», «must make a successful constitution saving throw», а у 2014 местами
# «must make a saving throw of Wisdom». Проверяются именно глаголы вынуждения, поэтому преимущества,
# помехи и штрафы к спасброскам сюда не попадают.
FORCED = [
    re.compile(r'must\s+(?:also\s+|then\s+|first\s+)?(?:make|succeed\s+on)\s+an?\s+(?:successful\s+)?'
               r'(?:DC\s+(?P<dc>\d+)\s+)?(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)'
               r'\s+saving\s+throw', re.I),
    re.compile(r'\bmakes?\s+an?\s+(?:successful\s+)?(?:DC\s+(?P<dc>\d+)\s+)?'
               r'(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'succeeds?\s+on\s+an?\s+(?:successful\s+)?(?:DC\s+(?P<dc>\d+)\s+)?'
               r'(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'fails?\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?'
               r'(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    re.compile(r'must\s+first\s+make\s+an?\s+(?:DC\s+(?P<dc>\d+)\s+)?'
               r'(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw', re.I),
    # «must make a saving throw of Wisdom or be paralyzed» — формулировка SRD 5.1 («Удержание чудовища»)
    re.compile(r'saving\s+throw\s+of\s+(?P<ability>Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)', re.I),
]


def forced_saves(text):
    """Характеристики вынужденных спасбросков и предложение-источник по официальному тексту.

    Возвращает {код характеристики: предложение}. Один спасбросок часто упоминается несколько раз
    (повтор броска, последствия провала) — остаётся первое предложение, чтобы отчёт читался человеком.
    """
    found = {}
    for sentence in re.split(r'(?<=[.!?])\s+|\n', text):
        for pattern in FORCED:
            for match in pattern.finditer(sentence):
                ability = match.group('ability').capitalize()  # в дампе 5.1 характеристики со строчной буквы
                if ability in ABILITIES:
                    found.setdefault(ABILITIES[ability], ' '.join(sentence.split())[:200])
    return found


# Узлы программы спасброска и её английская подпись — те же, что у 2014 (tools/srd/mechanics.py).
PROGRAM_RU = 'Отдельный бросок: Спасбросок'
PROGRAM_EN = 'Separate roll: Saving throw'
ROLL_ONLY_RU = ('Только отдельный бросок кубиков: не тратит ячейку, заряд или действие и ничего не применяет к цели — '
                'результат применяет ДМ. Сверьте момент, количество и условия урона с полным описанием; поздний '
                'и альтернативный урон не бросаются вместе.')
ROLL_ONLY_EN = ('A separate dice roll only: it spends no slot, charge or action and applies nothing to anyone — the GM '
                'applies the result. Check the timing, count and damage conditions against the full description; delayed '
                'and alternative damage are not rolled together.')
# id узлов программ: соответствие «номер программы → суффикс id» берётся из самого справочника
# (slot_suffixes), как оно сложилось у всех записей; для невиданных слотов суффикс считается из слага.


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
    """(код характеристики, СЛ из текста или 0, набор всех найденных) для единственного вынужденного спасброска."""
    text = txt(spell.get('description') or spell.get('desc')) + '\n' + txt(spell.get('higher_level'))
    saves = forced_saves(text)
    fixed = {int(match.group('dc')) for pattern in FORCED for match in pattern.finditer(text)
             if 'dc' in pattern.groupindex and match.group('dc')}
    if len(saves) != 1:
        return (None, 0, sorted(saves))
    return (next(iter(saves)), (fixed.pop() if len(fixed) == 1 else 0), [])


def save_action(ability, dc, name='Спасбросок'):
    note = f'СЛ {dc if dc else "{{@dc}}"} {ability}'
    return {'name': name, 'kind': 'save', 'roll': '1d20', 'note': note}


def save_action_en(ability, dc, name=None):
    note = f'DC {dc if dc else "{{@dc}}"} {T.ABIL_EN[ability]}'
    return {'name': name or T.SPELL_ACTION_LABEL['Спасбросок'], 'kind': 'save', 'roll': '1d20', 'note': note}


def action_en(action):
    """Английская строка действия: имя, кость, тип урона и подсказка — по словарям локализации."""
    out = {'name': T.SPELL_ACTION_LABEL.get(action['name'], action['name']), 'kind': action['kind'], 'roll': action['roll']}
    if action.get('dtype'):
        out['dtype'] = T.DAMAGE_EN.get(action['dtype'], action['dtype'])
    if action.get('note'):
        # «СЛ {{@dc}} ЛОВ» → «DC {{@dc}} DEX»
        out['note'] = re.sub(r'^СЛ', 'DC', action['note']).replace(action['note'].split()[-1], T.ABIL_EN.get(action['note'].split()[-1], action['note'].split()[-1]))
    return out


def slot_suffixes():
    """Соответствие «номер программы → суффикс id узла», как оно сложилось в справочнике.

    У всех записей программы одного номера носят один и тот же суффикс (p1 → 18h9rwa и т. д.),
    поэтому новые узлы берут суффикс своего слота, а не выдуманный id. Для слотов, которых в
    справочнике ещё нет, суффикс считается из слага детерминированно.
    """
    counts = {}
    for edition in ('2014', '2024'):
        try:
            rows = json.load(open(os.path.join(ROOT, 'data_seed', f'srd_{edition}.json'), encoding='utf-8'))
        except OSError:
            continue
        for row in rows:
            graph = (row.get('data') or {}).get('mechanics', {}).get('graph') or {}
            for node in graph.get('nodes', []):
                if node['type'] != 'action.program':
                    continue
                program_id = node['params'].get('program_id') or ''
                if not (program_id.startswith('p') and program_id[1:].isdigit()):
                    continue
                suffix = node['id'].replace('program-', '', 1)
                counts.setdefault(int(program_id[1:]), {}).setdefault(suffix, 0)
                counts[int(program_id[1:])][suffix] += 1
    table = {}
    for slot, variants in counts.items():
        table[slot] = max(sorted(variants), key=lambda name: variants[name])
    return table


SLOT_SUFFIX = slot_suffixes()


# Родительный падеж русских названий характеристик — как они стоят в текстах справочника («спасбросок Мудрости»).
RU_SAVE_FORMS = {'Силы': 'СИЛ', 'Ловкости': 'ЛОВ', 'Телосложения': 'ТЕЛ', 'Интеллекта': 'ИНТ', 'Мудрости': 'МДР', 'Харизмы': 'ХАР'}


def record_evidence(data):
    """Спасброски, названные в переводе записи: у 2024 в дампе нет таблицы «Радужные слои».

    Официальный текст 5.2.1 держит часть спасбросков в таблицах («Радужные слои»), которых в
    дампе заклинаний нет, поэтому вторая опора — уже переведённый текст самой записи справочника.
    """
    text = data.get('desc') or ''
    found, sentences = set(), []
    for sentence in re.split(r'(?<=[.!?])\s+', text):
        abilities = {ability for form, ability in RU_SAVE_FORMS.items()
                     if re.search(rf'[Сс]пасброс\w*\s+(?:в\s+)?{form}\b', sentence)}
        if abilities:
            found |= abilities
            sentences.append(' '.join(sentence.split())[:160])
    return sentences, found


# Вынуждение в русском тексте: «должно совершить спасбросок Телосложения», «совершает спасбросок
# Ловкости», «должно преуспеть в спасброске Силы». Преимущества и штрафы к спасброскам
# («преимущество на спасброски Силы») сюда не попадают — проверяются глаголы вынуждения.
RU_FORCE = re.compile(r'(?:должн\w*|обязан\w*)\s+(?:также\s+)?(?:совершить|преуспеть\s+в|пройти|сделать)\s+'
                      r'(?:успешн\w+\s+)?спасброс\w*'
                      r'|(?:заставля\w+|заставить|может|можете|могут)\s+[^.]{0,40}?совершить\s+(?:успешн\w+\s+)?спасброс\w*'
                      r'|совершает\s+(?:успешн\w+\s+)?спасбросок'
                      r'|преуспева\w+\s+в\s+спасброске'
                      r'|провалива\w+\s+спасброс\w*'
                      r'|повторя\w+\s+спасброс\w*')


# «спасброски Силы с преимуществом» — свои броски заклинателя, а не вынужденные
RU_ADVANTAGE = re.compile(r'спасброс\w*\s+(?:Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)\s+'
                          r'с\s+(?:преимуществом|помехой)')


def forced_saves_ru(data):
    """Спасброски, которые вынуждает русский текст записи: {код: предложение}."""
    found = {}
    for sentence in re.split(r'(?<=[.!?])\s+', data.get('desc') or ''):
        if not RU_FORCE.search(sentence) or RU_ADVANTAGE.search(sentence):
            continue
        for form, ability in RU_SAVE_FORMS.items():
            if re.search(rf'[Сс]пасброс\w*\s+(?:в\s+)?{form}\b', sentence):
                found.setdefault(ability, ' '.join(sentence.split())[:160])
    return found


def recorded_saves(data):
    """Характеристики спасбросков, записанные в данных: подсказки действий вида `save`."""
    found = set()
    for action in data.get('actions') or []:
        if action.get('kind') != 'save':
            continue
        note = action.get('note') or ''
        for ability in ABILITIES.values():
            if re.search(r'\b' + ability + r'\b', note):
                found.add(ability)
    return found


def check_save_coverage(row, spell, edition, report):
    """Полнота спасбросков: набор в данных обязан совпасть с набором из источников.

    Источники — официальный английский текст (и машинное поле `dc` у 2014) плюс перевод записи:
    в дампе 2024 таблицы «Радужные слои» и «Радужные лучи» урезаны, поэтому часть спасбросков
    доказывается только текстом самой записи. Так проверка ловит и потерянный спасбросок
    («Удержание чудовища», «Ледяной шторм», где текст вынуждает второй бросок), и лишний,
    которого в правилах нет.
    """
    data = row['data']
    data_set = recorded_saves(data)
    if not data_set and not data.get('save_ability'):
        return                      # заклинания без спасбросков ведёт основной проход
    text = set(forced_saves(txt(spell.get('description') or spell.get('desc')) + '\n' + txt(spell.get('higher_level'))))
    if edition == '2014':
        machine = R.ABIL.get(((spell.get('dc') or {}).get('dc_type') or {}).get('name', ''), '')
        if machine:
            text.add(machine)
    allowed = text | set(forced_saves_ru(data))
    missing = sorted(allowed - data_set)
    extra = sorted(data_set - allowed)
    if missing:
        report['problems'].append(f'{edition}: {row["slug"]} — источники вынуждают спасбросок '
                                  f'{", ".join(missing)}, которого нет в данных')
    if extra:
        report['problems'].append(f'{edition}: {row["slug"]} — в данных есть спасбросок '
                                  f'{", ".join(extra)}, которого нет в источниках')


def table_evidence(spell, abilities_ru):
    """Проверка таблицы MULTI_SAVES по официальному тексту: все ли характеристики эффектов там есть.

    Возвращает (список предложений-подтверждений, список отсутствующих характеристик). Таблица
    заполняется человеком, поэтому каждая её характеристика обязана найтись в дампе SRD — иначе
    в справочник попали бы правила, которых в источнике нет.
    """
    text = txt(spell.get('description') or spell.get('desc')) + '\n' + txt(spell.get('higher_level'))
    found = forced_saves(text)
    missing = [ability for ability in abilities_ru if ability not in found]
    return list(found.values()), missing


def program_suffix(slug, program_id, salt=''):
    """Суффикс id программы: по слоту из справочника, иначе — из слага (детерминированно)."""
    slot = int(program_id[1:])
    if slot in SLOT_SUFFIX:
        return SLOT_SUFFIX[slot]
    import zlib
    value, digits = zlib.crc32(f'save:{slug}{salt}'.encode('utf-8')), '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while value:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
    return (out or '0')[:7].rjust(7, '0')


def next_program(graph, slug, salt=''):
    """Свободный номер программы спасброска: p2 у заклинаний без второго броска, иначе следующий свободный."""
    used = {n['params'].get('program_id') for n in graph.get('nodes', []) if n['type'] == 'action.program'}
    index = 2
    while f'p{index}' in used:
        index += 1
    program_id = f'p{index}'
    return program_id, program_suffix(slug, program_id, salt)


def program_nodes(program_id, suffix, name_ru=PROGRAM_RU, name_en=PROGRAM_EN):
    """Узлы и связи программы спасброска (копия программы 2014 у «Огненного шара»)."""
    number = int(program_id[1:])
    y = 70 + (number - 1) * 170
    nodes = [
        {'id': f'program-{suffix}', 'type': 'action.program', 'params': {'program_id': program_id, 'name': name_ru, 'trigger': 'use', 'roll_only': True}, 'position': {'x': 60, 'y': y}},
        {'id': f'action-{suffix}-1', 'type': 'action.manual', 'params': {'enabled': True, 'when': 'always', 'text': ROLL_ONLY_RU, 'block_id': 'b1'}, 'position': {'x': 330, 'y': y}},
        {'id': f'action-{suffix}-2', 'type': 'action.roll', 'params': {'enabled': True, 'when': 'always', 'kind': 'roll', 'dice': {'count': 1, 'sides': 20, 'bonus': 0, 'stat': ''}, 'damage_type': '', 'block_id': 'b2'}, 'position': {'x': 590, 'y': y}},
    ]
    links = [
        {'from': {'node': f'program-{suffix}', 'socket': 'exec'}, 'to': {'node': f'action-{suffix}-1', 'socket': 'exec'}},
        {'from': {'node': f'action-{suffix}-1', 'socket': 'exec'}, 'to': {'node': f'action-{suffix}-2', 'socket': 'exec'}},
    ]
    overlay = [
        {'id': f'program-{suffix}', 'params': {'program_id': program_id, 'name': name_en, 'trigger': 'use', 'roll_only': True}},
        {'id': f'action-{suffix}-1', 'params': {'enabled': True, 'when': 'always', 'text': ROLL_ONLY_EN, 'block_id': 'b1'}},
    ]
    return nodes, links, overlay


def patch_spell(row, data, saves, report):
    """Добавляет данные спасбросков. `saves` — список (характеристика, СЛ, метка RU, метка EN).

    Первый спасбросок — основной (`data.save_ability`, действие «Спасбросок»); у заклинаний с разными
    спасбросками для разных эффектов («Символ», «Радужная стена») каждый получает своё действие и
    свою программу: тогда кнопка броска на карточке считает нужную характеристику, а не первую.
    """
    added = 0
    primary = saves[0][0]
    if data.get('save_ability') != primary:
        data['save_ability'] = primary
        added += 1
    actions = data.setdefault('actions', [])
    en = data.setdefault('i18n', {}).setdefault('en', {})
    en_actions = en.get('actions!')
    if not isinstance(en_actions, list) or len(en_actions) != len(actions):
        # Английский слой строится из базовых действий: старые строки уже переведены, новые — по словарям.
        en_actions = [action_en(a) for a in actions]
        en['actions!'] = en_actions
    graph = data.setdefault('mechanics', {}).setdefault('graph', {})
    en_graph = en.setdefault('mechanics', {}).setdefault('graph', {})
    for ability, dc, label_ru, label_en in saves:
        # Действие называется «Спасбросок» (у эффектов — «Спасбросок: <эффект>»), программа —
        # «Отдельный бросок: Спасбросок»: так же, как у заклинаний с одним спасброском.
        action_ru = f'Спасбросок: {label_ru}' if label_ru else 'Спасбросок'
        action_en = f'Saving throw: {label_en}' if label_en else T.SPELL_ACTION_LABEL['Спасбросок']
        program_ru = f'{PROGRAM_RU}: {label_ru}' if label_ru else PROGRAM_RU
        program_en = f'{PROGRAM_EN}: {label_en}' if label_en else PROGRAM_EN
        if not any(a.get('kind') == 'save' and a.get('name') == action_ru for a in actions):
            actions.append(save_action(ability, dc, action_ru))
            en_actions.append(save_action_en(ability, dc, action_en))
            added += 1
        if not any(n['type'] == 'action.program' and n['params'].get('name') == program_ru for n in graph.get('nodes', [])):
            program_id, suffix = next_program(graph, row['slug'], f':{label_ru}')
            nodes, links, overlay = program_nodes(program_id, suffix, program_ru, program_en)
            graph.setdefault('nodes', []).extend(nodes)
            graph.setdefault('links', []).extend(links)
            en_graph.setdefault('nodes', []).extend(overlay)
            added += 1
    report['patched'] += 1
    return added


def check_edition(rows, report, edition, spells=None):
    """Паритет редакций и полнота спасбросков: данные обязаны совпасть с источниками.

    Проверяются: наличие действия и программы у каждого записанного спасброска, согласие
    `data.save_ability` с действиями и набор характеристик — с официальным текстом (см.
    `check_save_coverage`).
    """
    for row in rows:
        if row['category'] != 'spell':
            continue
        data = row['data']
        spell = (spells or {}).get(row['slug'].split('-', 1)[1])
        if spell:
            check_save_coverage(row, spell, edition, report)
        has_action = any(a.get('kind') == 'save' for a in (data.get('actions') or []))
        expected = MULTI_SAVES.get(edition, {}).get(row['slug'])
        if expected:
            save_names = {('Спасбросок: ' + label) if label else 'Спасбросок' for _a, _dc, label, _en in expected}
            program_names = {f'{PROGRAM_RU}: {label}' if label else PROGRAM_RU for _a, _dc, label, _en in expected}
            present = {a.get('name') for a in (data.get('actions') or []) if a.get('kind') == 'save'}
            missing = save_names - present
            if missing:
                report['problems'].append(f'{edition}: {row["slug"]} — нет действий-спасбросков: {", ".join(sorted(missing))}')
            programs = {n['params'].get('name') for n in (data.get('mechanics', {}).get('graph', {}).get('nodes') or [])
                        if n['type'] == 'action.program'}
            missing_programs = program_names - programs
            if missing_programs:
                report['problems'].append(f'{edition}: {row["slug"]} — нет программ спасброска: {", ".join(sorted(missing_programs))}')
        has_program = any(n['type'] == 'action.program' and n['params'].get('name') == PROGRAM_RU
                          for n in (data.get('mechanics', {}).get('graph', {}).get('nodes') or []))
        if bool(data.get('save_ability')) != has_action:
            report['problems'].append(f'{edition}: {row["slug"]} — save_ability и действие kind=save расходятся')
        if bool(data.get('save_ability')) and not has_program:
            report['problems'].append(f'{edition}: {row["slug"]} — есть спасбросок, но нет программы «{PROGRAM_RU}»')


# Заклинания, у которых спасброски зависят от эффекта: один и тот же текст вынуждает разные спасброски
# для разных частей заклинания (слои «Радужной стены», знаки «Символа», лучи «Радужных брызг»).
# Первый в списке — основной (data.save_ability, действие «Спасбросок»), остальные получают своё
# действие и программу. Метки взяты из официального текста SRD (названия знаков и эффектов),
# русские — из уже переведённого описания заклинания в справочнике.
MULTI_SAVES = {
    '2014': {
        'srd14-earthquake': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'поддержание концентрации', 'concentration'),
        ],
        'srd14-prismatic-wall': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'ослепление вблизи стены', 'blinded near the wall'),
            ('ТЕЛ', 0, 'опутанный: конец каждого хода', 'restrained: end of each turn'),
            ('МДР', 0, 'ослеплённый: начало следующего хода', 'blinded: start of next turn'),
        ],
        'srd14-prismatic-spray': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'опутанный: конец каждого хода', 'restrained: end of each turn'),
            ('МДР', 0, 'ослеплённый: начало следующего хода', 'blinded: start of next turn'),
        ],
        'srd14-sleet-storm': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'поддержание концентрации', 'concentration'),
        ],
        'srd14-wall-of-ice': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'слой ледяного воздуха', 'sheet of frigid air'),
        ],
        'srd14-storm-of-vengeance': [
            ('ТЕЛ', 0, '', ''),
            ('ЛОВ', 0, 'молния', 'lightning bolt'),
        ],
        'srd14-symbol': [
            ('ТЕЛ', 0, '', ''),
            ('ТЕЛ', 0, 'Раздор', 'Discord'),
            ('МДР', 0, 'Страх', 'Fear'),
            ('ХАР', 0, 'Безнадёжность', 'Despair'),
            ('ИНТ', 0, 'Безумие', 'Insanity'),
            ('ТЕЛ', 0, 'Боль', 'Pain'),
            ('МДР', 0, 'Сон', 'Sleep'),
            ('МДР', 0, 'Ошеломление', 'Stunning'),
        ],
    },
    '2024': {
        'srd24-arcane-hand': [
            ('СИЛ', 0, '', ''),
            ('ЛОВ', 0, 'захват', 'grapple'),
        ],
        'srd24-prismatic-spray': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'опутанный: конец каждого хода', 'restrained: end of each turn'),
            ('МДР', 0, 'ослеплённый: начало следующего хода', 'blinded: start of next turn'),
        ],
        'srd24-prismatic-wall': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'ослепление вблизи стены', 'blinded near the wall'),
            ('ТЕЛ', 0, 'опутанный: конец каждого хода', 'restrained: end of each turn'),
            ('МДР', 0, 'ослеплённый: начало следующего хода', 'blinded: start of next turn'),
        ],
        'srd24-storm-of-vengeance': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'появление тучи', 'when the cloud appears'),
        ],
        'srd24-symbol': [
            ('ТЕЛ', 0, '', ''),
            ('МДР', 0, 'Раздор', 'Discord'),
            ('МДР', 0, 'Страх', 'Fear'),
            ('ТЕЛ', 0, 'Боль', 'Pain'),
            ('МДР', 0, 'Сон', 'Sleep'),
            ('МДР', 0, 'Ошеломление', 'Stunning'),
        ],
        'srd24-wall-of-ice': [
            ('ЛОВ', 0, '', ''),
            ('ТЕЛ', 0, 'пелена ледяного воздуха', 'sheet of frigid air'),
        ],
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='/tmp/srd', help='каталог с дампами SRD: <src>/2014|2024/5e-SRD-Spells.json')
    ap.add_argument('--check', action='store_true', help='только проверить, ничего не писать')
    ap.add_argument('--list', action='store_true', help='напечатать все найденные спасброски с предложением-источником')
    args = ap.parse_args()
    report = {'patched': 0, 'problems': [], 'ambiguous': [], 'nosave': 0, 'fixed_dc': [], 'mismatch': [], 'found': [], 'evidence': []}
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
            forced = MULTI_SAVES.get(edition, {}).get(row['slug'])
            if forced:
                abilities = [a for a, _dc, _label, _en in forced]
                sentences, missing = table_evidence(spell, abilities)
                own_sentences, own = record_evidence(row['data'])
                missing = [ability for ability in missing if ability not in own]
                if missing:
                    report['problems'].append(
                        f'{edition}: {row["slug"]} — таблица MULTI_SAVES называет {", ".join(missing)}, '
                        'а ни в официальном тексте, ни в переводе записи этих спасбросков нет')
                report['evidence'].extend(f'{edition}: {row["slug"]} (текст записи) — {sentence}'
                                          for sentence in own_sentences)
                # Обратная сверка: спасброска из источников, забытого в таблице, быть не должно.
                in_sources = own | set(forced_saves(txt(spell.get('description') or spell.get('desc'))))
                forgotten = sorted(in_sources - set(abilities))
                if forgotten:
                    report['problems'].append(
                        f'{edition}: {row["slug"]} — в источниках есть спасбросок {", ".join(forgotten)}, '
                        'которого нет в таблице MULTI_SAVES')
                report['found'].append(f'{edition}: {row["slug"]} — спасброски эффектов: ' +
                                       ', '.join(f'{a} ({label or "основной"})' for a, _dc, label, _en in forced))
                for sentence in sentences:
                    report['evidence'].append(f'{edition}: {row["slug"]} — {sentence}')
                if not args.check:
                    changed += patch_spell(row, row['data'], forced, report)
                found += 1
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
                changed += patch_spell(row, row['data'], [(ability, dc, '', '')], report)
        print(f'{edition}: вынужденный спасбросок в источнике у {found} заклинаний; вставок: {changed}')
        if changed and not args.check:
            open(path, 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
        check_edition(rows, report, edition, spells)
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
        for note in report['evidence']:
            print('источник:', note)
    if report['problems']:
        for problem in report['problems'][:40]:
            print('ОШИБКА:', problem, file=sys.stderr)
        print(f'всего проблем: {len(report["problems"])}', file=sys.stderr)
        return 1
    print('паритет редакций по спасброскам соблюдён')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
