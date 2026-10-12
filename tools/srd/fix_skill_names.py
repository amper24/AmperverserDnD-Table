#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Единая терминология навыков в справочнике SRD.

Клиентский словарь навыков — `window.SKILLS` в `static/common.js` («Расследование» для `investigation`).
В данных SRD этот навык назывался «Анализ» (маппинг tools/srd/ru_names.py), из-за чего:

* списки `data.skills.from` у классов предлагали название, которого нет в словаре листа
  (`skillKey()` в static/character-builder.js знает только алиас, а `expertise_from_class`
  в static/levelup.js вообще сравнивал ключи);
* в текстах умений, монстров и предметов оставалось второе написание того же навыка.

Скрипт приводит русские данные обеих редакций к названию из словаря и проверяет, что каждый
элемент `data.skills.from` у классов находится в `window.SKILLS`.

    python3 tools/srd/fix_skill_names.py [--check]

`--check` ничего не пишет и завершается кодом 1, если найдены расхождения (для CI).
Идемпотентно: повторный запуск ничего не меняет.
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OLD, NEW = 'Анализ', 'Расследование'


def skills_dictionary():
    """Названия навыков из static/common.js — единственный словарь листа."""
    text = open(os.path.join(ROOT, 'static', 'common.js'), encoding='utf-8').read()
    m = re.search(r'window\.SKILLS\s*=\s*\[([\s\S]*?)\n\];', text)
    if not m:
        raise SystemExit('не найден window.SKILLS в static/common.js')
    rows = re.findall(r"\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,", m.group(1))
    if len(rows) != 18:
        raise SystemExit(f'в SKILLS ожидалось 18 навыков, найдено {len(rows)}')
    return {key: name for key, name in rows}


def walk(value, path=()):
    """Все строки данных с путём (без слоя переводов: он на английском)."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'i18n':
                continue
            yield from walk(item, path + (key,))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from walk(item, path + (index,))
    elif isinstance(value, str):
        yield path, value


def rewrite(value, path=()):
    """Замена старого написания навыка во всех русских строках записи."""
    changed = 0
    if isinstance(value, dict):
        for key in list(value):
            if key == 'i18n':
                continue
            value[key], sub = rewrite(value[key], path + (key,))
            changed += sub
        return value, changed
    if isinstance(value, list):
        for index, item in enumerate(value):
            value[index], sub = rewrite(item, path + (index,))
            changed += sub
        return value, changed
    if isinstance(value, str) and OLD in value:
        return value.replace(OLD, NEW), value.count(OLD)
    return value, 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='только проверить, ничего не писать')
    args = ap.parse_args()
    dictionary = skills_dictionary()
    names = set(dictionary.values())
    problems, total = [], 0
    for edition in ('2014', '2024'):
        path = os.path.join(ROOT, 'data_seed', f'srd_{edition}.json')
        rows = json.load(open(path, encoding='utf-8'))
        replaced = 0
        for row in rows:
            data = row['data']
            if OLD in json.dumps(data.get('i18n', {}), ensure_ascii=False):
                problems.append(f'{row["slug"]}: старое написание осталось в слое переводов')
            if row['category'] == 'class':
                for name in (data.get('skills') or {}).get('from', []):
                    if name not in names:
                        problems.append(f'{row["slug"]}: навык «{name}» не найден в SKILLS (static/common.js)')
            data, changed = rewrite(data)
            replaced += changed
            if changed and not args.check:
                row['data'] = data
        total += replaced
        print(f'{edition}: заменено «{OLD}» → «{NEW}»: {replaced}')
        if replaced and not args.check:
            open(path, 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
    if problems:
        for problem in problems:
            print('ОШИБКА:', problem, file=sys.stderr)
        return 1
    print(f'всего замен: {total}; все названия навыков классов совпадают со словарём листа')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
