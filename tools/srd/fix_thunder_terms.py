#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тип урона «звук» вместо «гром»/«громовой» в текстах справочника.

Словарь листа (`static/modules.js::DAMAGE_TYPES`) и словарь локализации
(`tools/srd/i18n_terms.py::DAMAGE_EN`) называют тип урона «звук» (thunder), и в обычных полях
защит он уже приведён к словарю (`tools/srd/fix_monster_defenses.py`). Но в текстах остался
перевод «гром»/«громовой» («2к6 урона громом», «Громового урона», «Яд или Гром для типа…»,
таблицы «Тип урона» у предметов сопротивления), а в записях защит с оговоркой — «Гром»
(2014) и «Громовой» (2024). Из-за этого одно правило читается в справочнике двумя словами,
хотя лист знает только «звук».

Скрипт меняет только те места, где слово обозначает ТИП УРОНА, и не трогает:

* имена: заклинание «Волна грома», свойства посоха («Гром», «Гром и молния», «Раскат грома»),
  умения и действия («Громовой удар», «Громовая булава», «Громовой заряд», «Громовой рёв»,
  «Гром бури», «Громовой голос», «Раскат грома») — по именам ссылаются другие поля записи
  (`actions_roll[].name`, `mechanics.graph.nodes[].params.feature_name`), поэтому переименование
  было бы правкой кросс-ссылок;
* явления и сравнения: «гремит гром», «раскатистый гром», «громче», «громкий», «громовой раскат»,
  «громовой взрыв», «волна громовой силы»;
* размер «Громадный» — слово лишь содержит «гром».

Каждая правка подтверждается английским слоем записи: соседний английский текст обязан говорить
thunder (`data.i18n.en.desc`, `traits!`, `actions!`, `legendary_actions!`, `subclasses!`,
overlay графа, поля защит). Если подтверждения нет, строка не меняется, а попадает в отчёт.

    python3 tools/srd/fix_thunder_terms.py [--check] [--list]

Без `--check` скрипт правит оба набора данных (`data_seed/srd_2014.json`, `data_seed/srd_2024.json`)
и возвращает код 1 только при ошибке подтверждения: строку, где слово похоже на тип урона,
но английский слой не говорит thunder, он не меняет и перечисляет в `problems` (защита от
правки имени или явления «на глазок»). `--check` ничего не пишет и меняет код возврата лишь
по тем же `problems`; оставшиеся упоминания именами и явлениями он печатает по категориям
(name/phenomenon/plain) и на код не влияет — это ожидаемый остаток, перечисленный в отчёте.
`--list` печатает каждое оставшееся упоминание с адресом поля. Повторный прогон ничего не меняет.
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
EDITIONS = ('2014', '2024')

# Русские формы слов: «гром» как существительное (тип урона — «звук») и «громовой» как прилагательное
# (тип урона — «звуковой»). Форма сохраняется, меняется только основа.
NOUN = {'гром': 'звук', 'грома': 'звука', 'грому': 'звуку', 'громом': 'звуком', 'громе': 'звуке'}
ADJ = {'громовой': 'звуковой', 'громового': 'звукового', 'громовому': 'звуковому',
       'громовым': 'звуковым', 'громовом': 'звуковом', 'громовая': 'звуковая',
       'громовую': 'звуковую', 'громовое': 'звуковое', 'громовые': 'звуковые',
       'громовых': 'звуковых', 'громовыми': 'звуковыми'}
NOUN_PATTERN = re.compile(r'(?<![А-Яа-яЁё])([Гг]ром(?:ом|а|у|е)?)(?![а-яё])')
ADJ_PATTERN = re.compile(r'(?<![А-Яа-яЁё])([Гг]ромов\w*)(?![а-яё])')
ADJ_DAMAGE_PATTERN = re.compile(r'(?<![А-Яа-яЁё])([Гг]ромов\w*)(?![а-яё])(?=\s+[Уу]рон)')
# Слова, после которых «гром» — это тип урона, а не явление.
DAMAGE_WORD = re.compile(r'(?:урон\w*|уязвим\w*|иммунитет\w*|сопротивлени\w*|получа\w+)', re.I)
# Имена, в которых «гром» — часть названия: их переименование затронуло бы кросс-ссылки записей.
NAMES = ('Волна грома', 'Раскат грома', 'Гром и молния', 'Гром бури', 'Громовой голос',
         'Громовой удар', 'Громовая булава', 'Громовой заряд', 'Громовой рёв', 'Громовой раскат',
         'громовой раскат', 'громовой взрыв', 'Раскатистый гром', 'Гром штормового')
PROSE_GROUPS = ('traits', 'actions', 'legendary_actions', 'reactions')
DEFENSE_FIELDS = ('vulnerabilities', 'resistances', 'immunities')


def load(edition):
    path = os.path.join(ROOT, 'data_seed', f'srd_{edition}.json')
    return json.load(open(path, encoding='utf-8'))


def damage_context_before(text, index):
    """Перед словом есть слово про урон — и между ними нет конца предложения."""
    window = text[max(0, index - 120):index]
    found = None
    for match in DAMAGE_WORD.finditer(window):
        found = match
    if not found:
        return False
    return not re.search(r'[.;!?]', window[found.end():])


def damage_context_after(text, index):
    """После слова стоит «для типа …» — выбор типа урона («Яд или Гром для типа сферы»)."""
    return bool(re.search(r'для\s+типа', text[index:index + 40], re.I))


def in_table_of_damage_types(text, index, word):
    """Строка таблицы «Тип урона»: у предметов сопротивления тип урона стоит отдельной ячейкой.

    Таблица бывает из двух столбцов («Тип урона») и из трёх (у кольца сопротивления третий —
    самоцвет), поэтому проверяется сама ячейка, а не вся строка.
    """
    line_start = text.rfind('\n', 0, index) + 1
    line_end = text.find('\n', index)
    line = text[line_start:line_end if line_end >= 0 else len(text)]
    cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
    if len(cells) not in (2, 3) or not cells[0].isdigit() or cells[1] != word:
        return False
    header = text[max(0, line_start - 400):line_start]
    return bool(re.search(r'\|\s*(?:к10|1d10|d10)\s*\|\s*Тип урона\s*\|', header))


def is_property_title(text, start, end):
    """Заголовок свойства предмета: «Гром. Когда вы попадаете…», «свойства «Молния» и «Гром»»."""
    before = text[max(0, start - 3):start]
    after = text[end:end + 2]
    if after.lstrip().startswith('»') or before.rstrip().endswith('«'):
        return True
    return bool(re.search(r'(?:^|\n|\.)\s*$', before) and after.startswith('.')) and text[start].isupper()


def named_phrase(text, start, end):
    """Слово стоит внутри известного имени («Волна грома», «Гром бури», …)."""
    window = text[max(0, start - 25):end + 25].lower()
    return any(name.lower() in window for name in NAMES)


def replace_form(word, table):
    new = table[word.lower()]
    return new.capitalize() if word[0].isupper() else new


def fix_prose(text):
    """Правки в одном тексте: возвращает (новый текст, список описаний правок)."""
    changes = []

    def noun(match):
        word = match.group(1)
        if named_phrase(text, match.start(), match.end()):
            return word
        if (not damage_context_before(text, match.start()) and not damage_context_after(text, match.end())
                and not in_table_of_damage_types(text, match.start(), word)):
            return word
        changes.append(f'{word} → {replace_form(word, NOUN)}')
        return replace_form(word, NOUN)

    out = NOUN_PATTERN.sub(noun, text)

    def adj(match):
        word = match.group(1)
        if named_phrase(text, match.start(), match.end()):
            return word
        changes.append(f'{word} → {replace_form(word, ADJ)}')
        return replace_form(word, ADJ)

    return ADJ_DAMAGE_PATTERN.sub(adj, out), changes


def fix_defenses(text):
    """Поля защит: до оговорки «; … от …» тип урона называется по словарю листа."""
    if not text:
        return text, []
    head, sep, tail = text.partition(';')
    changes = []
    for pattern, table in ((NOUN_PATTERN, NOUN), (ADJ_PATTERN, ADJ)):
        for match in list(pattern.finditer(head)):
            word = match.group(1)
            head = head[:match.start(1)] + replace_form(word, table) + head[match.end(1):]
            changes.append(f'{word} → {replace_form(word, table)}')
    return head + sep + tail, changes


def prose_pairs(data):
    """Пары «русский текст → английское зеркало» по всем текстам записи."""
    en = (data.get('i18n') or {}).get('en') or {}
    out = {}
    if isinstance(data.get('desc'), str):
        out[('desc',)] = (data['desc'], en.get('desc'))
    if isinstance(data.get('higher_level'), str):
        out[('higher_level',)] = (data['higher_level'], en.get('higher_level'))
    for group in PROSE_GROUPS:
        ru_items, en_items = data.get(group), en.get(group + '!')
        if not isinstance(ru_items, list) or not isinstance(en_items, list):
            continue
        for index in range(min(len(ru_items), len(en_items))):
            if isinstance(ru_items[index].get('text'), str):
                out[(group, index)] = (ru_items[index]['text'], en_items[index].get('text'))
    ru_sub, en_sub = data.get('subclasses'), en.get('subclasses!')
    if isinstance(ru_sub, list) and isinstance(en_sub, list):
        for index in range(min(len(ru_sub), len(en_sub))):
            if isinstance(ru_sub[index].get('desc'), str):
                out[('subclasses', index)] = (ru_sub[index]['desc'], en_sub[index].get('desc'))
    graph = ((data.get('mechanics') or {}).get('graph') or {}).get('nodes') or []
    overlay = {node['id']: node for node in (((en.get('mechanics') or {}).get('graph') or {}).get('nodes') or [])}
    for index, node in enumerate(graph):
        if node['type'] == 'action.manual' and isinstance(node['params'].get('text'), str):
            out[('graph', index)] = (node['params']['text'],
                                     (overlay.get(node['id']) or {}).get('params', {}).get('text'))
    return out


def set_path(data, path, value):
    if len(path) == 1:
        data[path[0]] = value
    elif path[0] in PROSE_GROUPS:
        data[path[0]][path[1]]['text'] = value
    elif path[0] == 'subclasses':
        data['subclasses'][path[1]]['desc'] = value
    elif path[0] == 'graph':
        data['mechanics']['graph']['nodes'][path[1]]['params']['text'] = value
    else:
        raise AssertionError(path)


def label(path):
    return path[0] if len(path) == 1 else f'{path[0]}[{path[1]}]'


def check_edition(rows, write, report):
    for row in rows:
        data = row['data']
        for path, (ru, mirror) in sorted(prose_pairs(data).items(), key=lambda item: str(item[0])):
            fixed, changes = fix_prose(ru)
            if fixed == ru:
                continue
            mirror = mirror or ''
            if 'thunder' not in mirror.lower():
                report['problems'].append(
                    f'{row["slug"]} {label(path)}: правка «{changes[0]}» не подтверждена английским '
                    f'текстом («{mirror[:60]}…»)')
                continue
            report['prose'] += len(changes)
            report['prose_rows'].append(f'{row["slug"]} {label(path)}: {", ".join(changes)}')
            if write:
                set_path(data, path, fixed)
        for field in DEFENSE_FIELDS:
            value = data.get(field)
            if not isinstance(value, str) or not value:
                continue
            fixed, changes = fix_defenses(value)
            if fixed == value:
                continue
            mirror = ((data.get('i18n') or {}).get('en') or {}).get(field) or ''
            if 'thunder' not in mirror.lower():
                report['problems'].append(f'{row["slug"]} data.{field}: правка «{changes[0]}» не подтверждена '
                                          f'английским полем («{mirror}»)')
                continue
            report['defenses'] += len(changes)
            report['defense_rows'].append(f'{row["slug"]} {field}: {", ".join(changes)}')
            if write:
                data[field] = fixed


def name_texts(data):
    """Поля-имена записи: их содержимое не переписывается (по именам идут кросс-ссылки)."""
    out = []
    for group in PROSE_GROUPS:
        out.extend((f'{group}[{index}].name', item.get('name')) for index, item in enumerate(data.get(group) or []))
    out.extend((f'actions_roll[{index}].name', item.get('name')) for index, item in enumerate(data.get('actions_roll') or []))
    out.extend((f'subraces[{index}]', item) for index, item in enumerate(data.get('subraces') or []))
    for index, node in enumerate(((data.get('mechanics') or {}).get('graph') or {}).get('nodes') or []):
        for key in ('name', 'feature_name'):
            if node['params'].get(key):
                out.append((f'graph[{index}].{key}', node['params'][key]))
    return [(path, text) for path, text in out if isinstance(text, str)]


def prose_texts(data):
    """Текстовые поля записи: описание, умения, действия, подклассы, ручные узлы графа."""
    out = [('desc', data.get('desc'))] + [(f'{group}[{index}].text', item.get('text'))
                                          for group in PROSE_GROUPS for index, item in enumerate(data.get(group) or [])]
    out += [(f'subclasses[{index}].desc', item.get('desc')) for index, item in enumerate(data.get('subclasses') or [])]
    out += [(f'graph[{index}].text', node['params'].get('text'))
            for index, node in enumerate(((data.get('mechanics') or {}).get('graph') or {}).get('nodes') or [])
            if node['type'] == 'action.manual']
    # Тексты классовых умений (списки заклинаний и правила) — только для отчёта: их английские
    # зеркала ключуются по английскому имени умения, пары «строка к строке» для правки нет.
    out += [(f'feature_texts[{name}]', text) for name, text in (data.get('feature_texts') or {}).items()]
    return [(path, text) for path, text in out if isinstance(text, str)]


def classify(data):
    """Все вхождения «гром*» в записи по категориям: имена, явления, прочее."""
    result = {'name': [], 'phenomenon': [], 'plain': []}
    for path, text in name_texts(data):
        if NOUN_PATTERN.search(text) or ADJ_PATTERN.search(text):
            result['name'].append(f'{path}: {text[:90]}')
    for path, text in prose_texts(data):
        for match in NOUN_PATTERN.finditer(text):
            context = ' '.join(text[max(0, match.start() - 45):match.end() + 30].split())
            window = text[max(0, match.start() - 14):match.end() + 8]
            if named_phrase(text, match.start(), match.end()) or is_property_title(text, match.start(), match.end()):
                result['name'].append(f'{path}: …{context}…')
            elif re.search(r'(?:[Гг]ром(?:кий|ко|че)|гремит\s+гром)', window, re.I):
                result['phenomenon'].append(f'{path}: …{context}…')
            else:
                result['plain'].append(f'{path}: …{context}…')
        for match in ADJ_PATTERN.finditer(text):
            context = ' '.join(text[max(0, match.start() - 45):match.end() + 30].split())
            if named_phrase(text, match.start(), match.end()):
                result['name'].append(f'{path}: …{context}…')
            else:
                result['phenomenon'].append(f'{path}: …{context}…')
    return result


def classify_rows(rows):
    """Сводка по всем записям: сколько упоминаний осталось и какие именно."""
    summary = {'name': 0, 'phenomenon': 0, 'plain': 0, 'name_list': [], 'phenomenon_list': [], 'plain_list': []}
    for row in rows:
        found = classify(row['data'])
        for kind in ('name', 'phenomenon', 'plain'):
            summary[kind] += len(found[kind])
            summary[kind + '_list'].extend(f'{row["slug"]} {note}' for note in found[kind])
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='только проверить, ничего не писать')
    ap.add_argument('--list', action='store_true', help='напечатать все правки и остатки')
    args = ap.parse_args()
    report = {'prose': 0, 'defenses': 0, 'prose_rows': [], 'defense_rows': [], 'problems': []}
    for edition in EDITIONS:
        path = os.path.join(ROOT, 'data_seed', f'srd_{edition}.json')
        rows = load(edition)
        check_edition(rows, not args.check, report)
        if not args.check and (report['prose'] or report['defenses']):
            open(path, 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
    print(f'правок в текстах: {report["prose"]}, в полях защит: {report["defenses"]}')
    if args.list:
        for note in report['prose_rows']:
            print('текст:', note)
        for note in report['defense_rows']:
            print('защиты:', note)
    if args.check or args.list:
        for edition in EDITIONS:
            found = classify_rows(load(edition))
            print(f'{edition}: осталось упоминаний «гром» — имена {found["name"]}, явления {found["phenomenon"]}, '
                  f'прочие {found["plain"]}')
            if args.list:
                for kind in ('name', 'phenomenon', 'plain'):
                    for note in found[kind + '_list']:
                        print(f'   {kind}: {note}')
    if report['problems']:
        for problem in report['problems'][:20]:
            print('ОШИБКА:', problem, file=sys.stderr)
        print(f'всего проблем: {len(report["problems"])}', file=sys.stderr)
        return 1
    if args.check:
        print('тип урона в текстах и полях защит назван по словарю листа')
    return 0


def classify_rows(rows):
    """Сводка по всем записям: сколько упоминаний осталось и какие именно."""
    summary = {'name': 0, 'phenomenon': 0, 'plain': 0, 'name_list': [], 'phenomenon_list': [], 'plain_list': []}
    for row in rows:
        found = classify(row['data'])
        for kind in ('name', 'phenomenon', 'plain'):
            summary[kind] += len(found[kind])
            summary[kind + '_list'].extend(f'{row["slug"]} {note}' for note in found[kind])
    return summary


if __name__ == '__main__':
    raise SystemExit(main())
