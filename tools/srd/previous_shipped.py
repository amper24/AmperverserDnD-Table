#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Хеши прежних поставочных версий записей справочника — для миграции узлов механики в уже развёрнутых БД.

  python3 tools/srd/previous_shipped.py <категория> <commit>... > data_seed/previous_shipped.json

Для каждого коммита берётся data_seed/srd_2014.json и srd_2024.json из git, и для записей указанной категории
записывается пара [хеш имени+data без mechanics, хеш mechanics] (та же форма, что в legacy_hashes.json).
Дубликаты пар убираются. Rust (src/seed.rs, `Upgrade::ReplaceShipped`) заменяет строку БД на новую версию только
если её хеши совпали с одним из снимков: правки пользователя не совпадают и не трогаются.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from legacy_hashes import entry_hashes  # noqa: E402

def load(commit, path):
    raw = subprocess.run(['git', 'show', f'{commit}:{path}'], check=True, capture_output=True).stdout
    return json.loads(raw.decode('utf-8'))

def main():
    category, commits = sys.argv[1], sys.argv[2:]
    out = {}
    for ed, path in (('2014', 'data_seed/srd_2014.json'), ('2024', 'data_seed/srd_2024.json')):
        table = {}
        for commit in commits:
            for e in load(commit, path):
                if e['category'] != category:
                    continue
                pair = list(entry_hashes(e))
                if not pair[1]:
                    continue  # без механики снимок не нужен: такие строки уже покрыты AddMechanics/ReplaceLegacy
                key = '%s/%s' % (e['category'], e['slug'])
                snaps = table.setdefault(key, [])
                if pair not in snaps:
                    snaps.append(pair)
        out[ed] = table
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(',', ':'), sort_keys=True)

if __name__ == '__main__':
    main()
