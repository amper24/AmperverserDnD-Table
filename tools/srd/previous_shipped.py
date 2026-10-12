#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Хеши прежних поставочных версий записей справочника — для миграции узлов механики в уже развёрнутых БД.

  python3 tools/srd/previous_shipped.py <категория|all> <commit>... > data_seed/previous_shipped.json
  python3 tools/srd/previous_shipped.py all --json-dir /tmp/prevrel --only-changed > data_seed/previous_shipped.json

Из каждого источника берётся data_seed/srd_2014.json и srd_2024.json (из git или из файлов каталога
`<каталог>/<версия>/<edition>.json`), и для записей указанной категории записывается пара
[хеш имени+data без mechanics, хеш mechanics] — та же форма, что в legacy_hashes.json. Дубликаты пар убираются.
Rust (src/seed.rs, `Upgrade::ReplaceShipped`) заменяет строку БД на новую версию только если её хеши совпали
с одним из снимков: правки пользователя не совпадают и не трогаются.

Прежние поставочные версии — это выпущенные релизы, поэтому их данные удобнее брать прямо с GitHub, не
раздувая клон (у нас он мелкий: `git fetch --depth=1 origin <sha>` тоже подойдёт, но качает всё дерево):

  for tag in $(gh release list --limit 60 | awk '{print $1}'); do
    mkdir -p /tmp/prevall/$tag
    for file in srd_2014.json srd_2024.json; do
      gh api -H "Accept: application/vnd.github.raw" \
        "repos/amper24/AmperverserDnD-Table/contents/data_seed/$file?ref=$tag" > /tmp/prevall/$tag/${file#srd_}
    done
  done

Скачивать нужно по имени тега (`?ref=v0.6.7`), а не по `targetCommitish` релиза: у части релизов там стоит
ветка, и тогда вернётся её текущее содержимое вместо поставочного.

Записи без механики тоже попадают в снимок (второй хеш — пустая строка), иначе строки прежних сборок без
узлов механики не обновлялись бы вовсе: `ReplaceLegacy` их не берёт (данные уже с слоем перевода), а
`ReplaceShipped` раньше требовал непустую механику. Исключение — записи, чьи данные совпадают с
до-локализационным хешем из `legacy_hashes.json`: их и так заменяет `ReplaceLegacy`.

`--only-changed` оставляет только те записи, чья пара хешей отличается от текущей сборки: без него в снимке
оказываются все записи категории из всех источников, и файл растёт на пустом месте.
Прогон проверки (каталог должен содержать все релизы, иначе непокрытые версии видны как расхождения):
`python3 tools/srd/verify_migration.py --prev-json-dir /tmp/prevall`.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from legacy_hashes import entry_hashes  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATEGORIES = ('race', 'class', 'background', 'item', 'spell', 'monster', 'feat', 'condition')

def load(commit, path):
    raw = subprocess.run(['git', 'show', f'{commit}:{path}'], check=True, capture_output=True).stdout
    return json.loads(raw.decode('utf-8'))

def load_files(directory):
    """Каталог с версиями релизов: <directory>/<версия>/<edition>.json."""
    out = {'2014': [], '2024': []}
    for version in sorted(os.listdir(directory)):
        for ed in ('2014', '2024'):
            path = os.path.join(directory, version, ed + '.json')
            if os.path.exists(path):
                out[ed].append(('%s/%s' % (version, ed), json.load(open(path, encoding='utf-8'))))
    return out

def load_legacy():
    """Хеш данных до локализации по ключу: такие строки заменяет ReplaceLegacy, снимок им не нужен."""
    path = os.path.join(ROOT, 'data_seed', 'legacy_hashes.json')
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def main():
    args = sys.argv[1:]
    category = args[0] if args and args[0] in ('all',) + CATEGORIES else 'all'
    commits = [a for a in (args[1:] if args and args[0] == category else args) if not a.startswith('--')]
    only_changed = '--only-changed' in args
    legacy = load_legacy()
    flags_with_values = {'--json-dir'}
    json_dir = args[args.index('--json-dir') + 1] if '--json-dir' in args else None
    commits = [a for a in commits if a not in flags_with_values and a != json_dir]
    out = {}
    for ed, path in (('2014', 'data_seed/srd_2014.json'), ('2024', 'data_seed/srd_2024.json')):
        current = {(e['category'], e['slug']): list(entry_hashes(e))
                   for e in json.load(open(os.path.join(ROOT, path), encoding='utf-8'))}
        sources = [(commit, load(commit, path)) for commit in commits]
        if json_dir:
            sources += load_files(json_dir)[ed]
        table = {}
        for _source, entries in sources:
            for e in entries:
                if category != 'all' and e['category'] != category:
                    continue
                pair = list(entry_hashes(e))
                key = '%s/%s' % (e['category'], e['slug'])
                if not pair[1]:
                    # Без механики: строку покроет ReplaceLegacy, если её данные совпадают с до-локализационной
                    # сборкой; в остальных случаях (слой перевода уже есть) нужен снимок с пустым хешем механики.
                    if (legacy.get(ed) or {}).get(key, [None])[0] == pair[0]:
                        continue
                if only_changed and current.get((e['category'], e['slug'])) == pair:
                    continue  # запись не менялась — снимку нечего заменять
                snaps = table.setdefault(key, [])
                if pair not in snaps:
                    snaps.append(pair)
        out[ed] = table
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


if __name__ == '__main__':
    main()
