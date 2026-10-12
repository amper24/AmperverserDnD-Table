#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Английские типы урона в слое перевода `data.i18n.en`.

Тип урона — отображаемая строка (`dtype` в действиях, `damage_type` у предметов и заклинаний,
`params.damage_type` у узлов `action.damage`). Русский текст — базовый, поэтому в английском виде
он обязан быть английским: сейчас в `i18n.en` оставались русские значения («кислота» вместо `acid`),
и английский вид листа показывал русский тип урона.

Скрипт добавляет английские значения в существующий слой перевода:

* `i18n.en.actions![]` и `i18n.en.actions_roll![]` — `dtype` по позиции (слой построен из базового списка);
* `i18n.en.damage_type` — у предметов и заклинаний;
* `i18n.en.mechanics.graph.nodes[].params.damage_type` — по id узла (слияние массивов с id, src/i18n.rs).

    python3 tools/srd/fix_en_damage_types.py [--check]

`--check` ничего не пишет и завершается кодом 1 при найденных расхождениях (для CI).
Идемпотентно; порядок ключей и форматирование файлов не меняются.
"""
import argparse
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
EN = {
    'кислота': 'acid', 'дробящий': 'bludgeoning', 'холод': 'cold', 'огонь': 'fire', 'силовое поле': 'force',
    'электричество': 'lightning', 'некротический': 'necrotic', 'колющий': 'piercing', 'яд': 'poison',
    'психический': 'psychic', 'излучение': 'radiant', 'рубящий': 'slashing', 'звук': 'thunder',
}
CYRILLIC = ('а', 'б', 'в', 'г', 'д', 'е', 'ж', 'з', 'и', 'й', 'к', 'л', 'м', 'н', 'о', 'п', 'р', 'с', 'т', 'у', 'ф', 'х', 'ц', 'ч', 'ш', 'щ', 'ъ', 'ы', 'ь', 'э', 'ю', 'я')


def has_cyrillic(value):
    return isinstance(value, str) and any(ch in value.lower() for ch in CYRILLIC)


def fill_actions(base_list, en_layer, key, problems, slug):
    """dtype по позиции: английский список построен из базового (индексы совпадают)."""
    if not base_list:
        return 0
    overlay = en_layer.get(key)
    if overlay is None:
        overlay = []
        en_layer[key] = overlay
    if len(overlay) != len(base_list):
        problems.append(f'{slug}: {key} — английских действий {len(overlay)}, базовых {len(base_list)}')
        return 0
    filled = 0
    for base, over in zip(base_list, overlay):
        dtype = base.get('dtype') if isinstance(base, dict) else None
        if not dtype:
            continue
        if dtype not in EN:
            problems.append(f'{slug}: неизвестный тип урона «{dtype}»')
            continue
        if over.get('dtype') != EN[dtype]:
            over['dtype'] = EN[dtype]
            filled += 1
    return filled


def fix_record(row, problems):
    data = row['data']
    i18n = data.get('i18n')
    if not isinstance(i18n, dict):
        problems.append(f'{row["slug"]}: нет слоя переводов')
        return 0
    en = i18n.setdefault('en', {})
    filled = 0
    filled += fill_actions(data.get('actions'), en, 'actions!', problems, row['slug'])
    filled += fill_actions(data.get('actions_roll'), en, 'actions_roll!', problems, row['slug'])
    damage_type = data.get('damage_type')
    if damage_type:
        if damage_type not in EN:
            problems.append(f'{row["slug"]}: неизвестный тип урона «{damage_type}»')
        elif en.get('damage_type') != EN[damage_type]:
            en['damage_type'] = EN[damage_type]
            filled += 1
    graph = (data.get('mechanics') or {}).get('graph') if isinstance(data.get('mechanics'), dict) else None
    if graph and isinstance(en.get('mechanics'), dict):
        nodes = graph.get('nodes') or []
        over_nodes = ((en['mechanics'].get('graph') or {}).get('nodes')) or []
        by_id = {node['id']: node for node in over_nodes if isinstance(node, dict) and 'id' in node}
        for node in nodes:
            params = node.get('params') or {}
            value = params.get('damage_type')
            if not value:
                continue
            if value not in EN:
                problems.append(f'{row["slug"]}: неизвестный тип урона «{value}» в узле {node.get("id")}')
                continue
            over = by_id.get(node.get('id'))
            if over is None:
                continue  # узел не переведён: английский вид соберёт подпись из базовых данных
            over_params = over.setdefault('params', {})
            if over_params.get('damage_type') != EN[value]:
                over_params['damage_type'] = EN[value]
                filled += 1
    return filled


def remainders(row):
    """Русские типы урона, оставшиеся в английском слое (после правки — пусто)."""
    data, en = row['data'], row['data'].get('i18n', {}).get('en', {})
    bad = []
    for key in ('actions!', 'actions_roll!'):
        for index, over in enumerate(en.get(key) or []):
            if has_cyrillic(over.get('dtype')):
                bad.append(f'i18n.en.{key}[{index}].dtype')
    if has_cyrillic(en.get('damage_type')):
        bad.append('i18n.en.damage_type')
    nodes = ((en.get('mechanics') or {}).get('graph') or {}).get('nodes') or []
    for node in nodes:
        if has_cyrillic((node.get('params') or {}).get('damage_type')):
            bad.append(f'i18n.en.mechanics.graph.nodes[{node.get("id")}].params.damage_type')
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()
    problems, filled_total = [], 0
    for edition in ('2014', '2024'):
        path = os.path.join(ROOT, 'data_seed', f'srd_{edition}.json')
        rows = json.load(open(path, encoding='utf-8'))
        filled = 0
        for row in rows:
            filled += fix_record(row, problems)
            for field in remainders(row):
                problems.append(f'{row["slug"]}: русский тип урона в {field}')
        filled_total += filled
        print(f'{edition}: заполнено английских типов урона: {filled}')
        if filled and not args.check:
            open(path, 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, separators=(',', ':')))
    if problems:
        for problem in problems[:40]:
            print('ОШИБКА:', problem, file=sys.stderr)
        print(f'всего проблем: {len(problems)}', file=sys.stderr)
        return 1
    print(f'всего заполнено: {filled_total}; русских типов урона в английском слое нет')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
