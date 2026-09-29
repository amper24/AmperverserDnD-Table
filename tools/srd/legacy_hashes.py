#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Хеши «старых» (до локализации) записей справочника — для миграции уже развёрнутых БД (src/seed.rs).

  python3 tools/srd/legacy_hashes.py <srd_2014.json> <srd_2024.json> > data_seed/legacy_hashes.json

Хеш = FNV-1a 64 от канонической записи JSON (ключи отсортированы, без пробелов, UTF-8): имя + data без mechanics,
и отдельно — хеш mechanics. Та же каноническая форма реализована в Rust (seed::canon / seed::fnv64).
"""
import json, sys

def canon(v):
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canon(v[k]) for k in sorted(v)) + '}'
    if isinstance(v, list):
        return '[' + ','.join(canon(x) for x in v) + ']'
    if v is True: return 'true'
    if v is False: return 'false'
    if v is None: return 'null'
    if isinstance(v, float):
        r = repr(v)
        assert 'e' not in r and 'E' not in r, r
        return r
    if isinstance(v, int): return str(v)
    return json.dumps(v, ensure_ascii=False)

def fnv64(s):
    h = 0xcbf29ce484222325
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return '%016x' % h

def entry_hashes(e):
    d = dict(e['data']); mech = d.pop('mechanics', None)
    return fnv64(canon({'name': e['name'], 'data': d})), (fnv64(canon(mech)) if mech is not None else '')

def main():
    out = {}
    for ed, path in (('2014', sys.argv[1]), ('2024', sys.argv[2])):
        out[ed] = {'%s/%s' % (e['category'], e['slug']): list(entry_hashes(e)) for e in json.load(open(path, encoding='utf-8'))}
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(',', ':'), sort_keys=True)

if __name__ == '__main__':
    main()
