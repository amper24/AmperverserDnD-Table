#!/usr/bin/env python3
"""Черты справочника (data_seed/feats_2014.json, data_seed/feats_2024.json): каждая черта расы,
умение класса и умение подкласса — отдельная запись категории «feat».

    python3 tools/srd/build_feats.py            # пересобрать черты и ссылки на них в наборах SRD
    python3 tools/srd/build_feats.py --check    # только проверить, что файлы и ссылки актуальны

Откуда берутся черты: из уже собранных наборов SRD (data_seed/srd_2014.json, srd_2024.json) —
черты рас (data.traits), умения классов (data.features + feature_texts) и умения подклассов
(subclasses[].features + feature_texts). Английский слой — из тех же записей (i18n.en.traits!,
i18n.en.features + feature_texts!, i18n.en.subclasses!).

Одинаковые по названию и тексту черты (например, «Тёмное зрение» у дварфа и полуэльфа или
«Увеличение характеристик» у всех классов) становятся ОДНОЙ записью: у неё в data.owners
перечислены владельцы, а в data.levels — уровни, на которых черта встречается у классов.

Обратная сторона ссылки: у черты расы появляется поле data.traits[i].feat, у класса и подкласса —
data.feature_feats = { уровень: { название: слаг } } и то же самое в узле rule.list (kind: class_features)
(запись {name, text, feat}). Редакторы расы и класса читают эти ссылки и дают выбрать черту
из справочника — так же, как навыки выбираются записью с узлом rule.list (kind: skill_proficiency).

Ссылки пишутся прямо в наборы SRD (как это делают tools/srd/add_*_nodes.cjs): наборы остаются
единственным источником данных, а --check ловит забытую пересборку.
"""
import argparse
import json
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parents[2]
EDITIONS = (('2014', 'srd14'), ('2024', 'srd24'))
ORIGIN = 'srd-feats-graph-v1'

# Транслитерация — запасной вариант для названий без английского слоя (ГОСТ-подобная таблица).
TRANSLIT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y',
    'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
}


def read(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))


def text(value):
    return '' if value is None else str(value)


def slugify(value):
    """Слаг из английского названия, иначе транслит русского."""
    value = text(value).strip().lower().replace('ё', 'е')
    if re.search(r'[а-я]', value):
        value = ''.join(TRANSLIT.get(ch, ch) for ch in value)
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^a-z0-9]+', '-', value).strip('-')
    return re.sub(r'-{2,}', '-', value) or 'trait'


def bare(key):
    """Ключи английского слоя иногда идут с восклицательным знаком: «1!» — это уровень 1, «features» — «features!»."""
    return text(key).rstrip('!')


def obj(value):
    return value if isinstance(value, dict) else {}


def arr(value):
    return value if isinstance(value, list) else []


def ordered_levels(value):
    """Ключи-уровни в числовом порядке: сборка ссылок идёт по чертам, а не по уровням, и без
    сортировки порядок ключей зависел бы от порядка записей (файл «дрожал» бы при --check)."""
    mapping = obj(value)
    return {key: mapping[key] for key in sorted(mapping, key=lambda key: (0, int(key)) if str(key).isdigit() else (1, str(key)))}


def en_of(entry):
    return obj(obj(entry.get('data')).get('i18n', {}).get('en'))


def en_get(layer, *keys):
    """Значение английского слоя по любому из имён (с восклицательным знаком и без)."""
    for key in keys:
        if key in layer:
            return layer[key]
        if key + '!' in layer:
            return layer[key + '!']
    return None


def pick_en(levels, texts, level, index, ru_name):
    """Английское название и текст: по позиции в списке уровня, иначе по русскому названию.

    Ключи английского слоя идут с восклицательным знаком («1!»), поэтому уровни сверяются по bare-ключу.
    """
    names = []
    for key, value in obj(levels).items():
        if bare(key) == str(level):
            names = arr(value)
            break
    name = text(names[index]) if index < len(names) else ''
    if not name:
        name = ru_name
    return name.strip(), text(obj(texts).get(name, ''))


def race_items(row):
    """Черты расы: data.traits + английский слой i18n.en.traits!."""
    data = obj(row.get('data'))
    layer = en_of(row)
    traits = arr(data.get('traits'))
    en_traits = arr(en_get(layer, 'traits'))
    out = []
    for index, trait in enumerate(traits):
        name = text(trait.get('name')).strip()
        if not name:
            continue
        en = obj(en_traits[index]) if index < len(en_traits) else {}
        out.append(({'kind': 'race', 'owner': row['name'], 'level': None, 'name': name, 'text': text(trait.get('text')),
                     'name_en': text(en.get('name')).strip(), 'text_en': text(en.get('text'))},
                    ('race', index)))
    return out


def level_items(data, layer):
    """Умения по уровням: русские data.features/feature_texts и английский слой i18n.en.features/feature_texts!."""
    features, texts = obj(data.get('features')), obj(data.get('feature_texts'))
    en_features, en_texts = en_get(layer, 'features'), en_get(layer, 'feature_texts')
    out = []
    for level, names in features.items():
        for index, name in enumerate(arr(names)):
            name = text(name).strip()
            if not name:
                continue
            name_en, text_en = pick_en(en_features, en_texts, level, index, name)
            out.append(({'level': int(level) if text(level).isdigit() else None, 'name': name,
                         'text': text(texts.get(name, '')), 'name_en': name_en, 'text_en': text_en},
                        ('level', str(level), name)))
    return out


def collect(rows):
    """Черты набора и место ссылки на каждую: (черта, как записать ссылку в набор)."""
    out = []
    for row in rows:
        category = row.get('category')
        if category == 'race':
            for item, ref in race_items(row):
                out.append((dict(item, ref=(row, ref)), row))
        elif category == 'class':
            data = obj(row.get('data'))
            for item, (_, level, name) in level_items(data, en_of(row)):
                out.append((dict(item, kind='class', owner=row['name'], ref=(row, ('class', level, name))), row))
    for row in rows:
        if row.get('category') != 'class':
            continue
        data = obj(row.get('data'))
        en_subs = arr(en_get(en_of(row), 'subclasses'))
        for index, sub in enumerate(arr(data.get('subclasses'))):
            name = text(sub.get('name')).strip()
            if not name:
                continue
            layer = obj(en_subs[index]) if index < len(en_subs) else {}
            for item, (_, level, feature) in level_items(obj(sub), obj(layer)):
                out.append((dict(item, kind='subclass', owner=f'{name} ({row["name"]})',
                                 ref=(row, ('subclass', index, level, feature))), row))
    return [(item, item.pop('ref')) for item, _ in out]


def merge(items):
    """Одинаковые черты (вид + название + текст) — одна запись со списком владельцев и уровней."""
    order, by_key = [], {}
    for item, ref in items:
        key = (item['kind'], item['name'], item['text'])
        entry = by_key.get(key)
        if entry is None:
            entry = by_key[key] = {'kind': item['kind'], 'name': item['name'], 'text': item['text'],
                                   'name_en': item['name_en'], 'text_en': item['text_en'],
                                   'owners': [], 'levels': [], 'refs': []}
            order.append(key)
        if item['owner'] not in entry['owners']:
            entry['owners'].append(item['owner'])
        if item['level'] and item['level'] not in entry['levels']:
            entry['levels'].append(item['level'])
        for field in ('name_en', 'text_en'):
            if not entry[field] and item[field]:
                entry[field] = item[field]
        entry['refs'].append(ref)
    for key in order:
        by_key[key]['levels'].sort()
    return [by_key[key] for key in order]


def graph(body):
    """Граф записи черты — как у черт набора SRD: программа «Правила применения» и текстовый блок."""
    return {
        'origin': ORIGIN,
        'version': 2,
        'graph': {
            'nodes': [
                {'id': 'program-feat', 'type': 'action.program',
                 'params': {'program_id': 'p1', 'name': 'Правила применения', 'trigger': 'use'},
                 'position': {'x': 60, 'y': 70}},
                {'id': 'action-feat-1', 'type': 'action.manual',
                 'params': {'enabled': True, 'when': 'always', 'text': body, 'block_id': 'b1'},
                 'position': {'x': 330, 'y': 70}},
            ],
            'links': [{'from': {'node': 'program-feat', 'socket': 'exec'},
                       'to': {'node': 'action-feat-1', 'socket': 'exec'}}],
            'frames': [],
            'groups': [],
        },
    }


def entry_of(record, edition):
    data = {'kind': record['kind'], 'owners': record['owners'], 'edition': edition, 'desc': record['text'],
            'mechanics': graph(record['text'])}
    if record['levels']:
        data['levels'] = record['levels']
    en = {}
    if record['name_en']:
        en['name'] = record['name_en']
    if record['text_en']:
        en['desc'] = record['text_en']
    if en:
        data['i18n'] = {'en': en}
    return {'category': 'feat', 'slug': record['slug'], 'name': record['name'], 'data': data}


def build(rows, prefix, edition):
    """Записи черт набора и те же данные набора со ссылками на них."""
    records = merge(collect(rows))
    taken = {}
    for record in records:
        base = f'{prefix}-feat-{slugify(record["name_en"] or record["name"])}'
        slug, serial = base, 1
        while slug in taken:
            serial += 1
            slug = f'{base}-{serial}'
        taken[slug] = True
        record['slug'] = slug
    strip_links(rows)  # ссылки пересобираются целиком: устаревших (на снятую черту) не остаётся
    for record in records:
        for row, ref in record['refs']:
            link(row, ref, record['slug'])
    for row in rows:
        data = obj(row.get('data'))
        if isinstance(data.get('feature_feats'), dict):
            data['feature_feats'] = ordered_levels(data['feature_feats'])
        for sub in arr(data.get('subclasses')):
            if isinstance(obj(sub).get('feature_feats'), dict):
                sub['feature_feats'] = ordered_levels(sub['feature_feats'])
    return [entry_of(record, edition) for record in records]


def strip_links(rows):
    """Снять прежние ссылки на черты: в data.traits, data.feature_feats и узле rule.list (kind: class_features)."""
    for row in rows:
        data = obj(row.get('data'))
        for trait in arr(data.get('traits')):
            trait.pop('feat', None)
        data.pop('feature_feats', None)
        for sub in arr(data.get('subclasses')):
            obj(sub).pop('feature_feats', None)
        for node in arr(obj(obj(data.get('mechanics')).get('graph')).get('nodes')):
            levels = obj(obj(obj(node.get('params')).get('table')).get('levels'))
            for items in levels.values():
                for item in arr(items):
                    if isinstance(item, dict):
                        item.pop('feat', None)


def link(row, ref, slug):
    """Записать ссылку на запись черты: в поле данных и в узел графа (у класса)."""
    data = row.setdefault('data', {})
    if ref[0] == 'race':
        data['traits'][ref[1]]['feat'] = slug
    elif ref[0] == 'class':
        _, level, name = ref
        data.setdefault('feature_feats', {}).setdefault(level, {})[name] = slug
        for item in table_entries(row, level):
            if item.get('name') == name:
                item['feat'] = slug
    elif ref[0] == 'subclass':
        _, index, level, name = ref
        sub = data['subclasses'][index]
        sub.setdefault('feature_feats', {}).setdefault(level, {})[name] = slug


def table_entries(row, level):
    """Строки узла rule.list (kind: class_features) на уровне (там копия умений класса)."""
    for node in obj(obj(obj(row.get('data')).get('mechanics')).get('graph')).get('nodes', []):
        if node.get('type') != 'rule.list' or obj(node.get('params')).get('kind') != 'class_features':
            continue
        levels = obj(obj(obj(node.get('params')).get('table')).get('levels'))
        items = levels.get(str(level))
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return []


def write(path, value, pretty):
    text_value = json.dumps(value, ensure_ascii=False, indent=1 if pretty else None,
                            separators=None if pretty else (',', ':'))
    pathlib.Path(path).write_text(text_value + ('\n' if pretty else ''), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='проверить, что файлы черт и ссылки в наборах актуальны')
    args = ap.parse_args()
    problems = []
    for edition, prefix in EDITIONS:
        seed_path = ROOT / 'data_seed' / f'srd_{edition}.json'
        out_path = ROOT / 'data_seed' / f'feats_{edition}.json'
        rows = read(seed_path)
        original = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
        entries = build(rows, prefix, edition)
        updated = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
        feats = original_feats = out_path.read_text(encoding='utf-8') if out_path.exists() else ''
        expected = json.dumps(entries, ensure_ascii=False, separators=(',', ':'))
        if args.check:
            if original != updated:
                problems.append(f'data_seed/srd_{edition}.json: не проставлены ссылки на черты — '
                                f'запустите python3 tools/srd/build_feats.py')
            if feats != expected:
                problems.append(f'data_seed/feats_{edition}.json устарел — запустите python3 tools/srd/build_feats.py')
            continue
        write(seed_path, rows, pretty=False)
        write(out_path, entries, pretty=False)
        print(f'data_seed/feats_{edition}.json: {len(entries)} черт; ссылки проставлены в srd_{edition}.json')
    if problems:
        raise SystemExit('\n'.join(problems))
    if args.check:
        print('черты и ссылки на них актуальны (2014 и 2024)')


if __name__ == '__main__':
    main()
