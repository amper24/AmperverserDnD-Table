#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверка пути обновления уже развёрнутых баз (src/seed.rs) на реальных данных.

Скрипт сравнивает текущий справочник с прежней поставочной версией из git и проверяет,
что каждая изменённая запись покрыта снимком `data_seed/previous_shipped.json` ровно с теми
хешами, которые лежат в развёрнутой базе. Иначе строка в чужой БД останется старой:
`Upgrade::ReplaceShipped` срабатывает только при точном совпадении пары хешей.

    python3 tools/srd/verify_migration.py --prev v0.6.7
    python3 tools/srd/verify_migration.py --prev <commit> --edition 2014

Проверки:
  1. покрытие: для каждой строки прежней сборки, отличающейся от текущей, есть путь обновления
     (`ReplaceLegacy` по `legacy_hashes.json`, `ReplaceShipped` по снимку `previous_shipped.json`
     или `AddMechanics` — строка совпадает с текущими данными, но без механики);
  2. свежесть: ни один снимок не совпадает с текущей записью (иначе в базе он ничего не заменит);
  3. старые хеши: у каждой вшитой записи есть хеш до локализации (или она в списке новых);
  4. сводка: сколько записей изменилось, как именно (данные, механика, и то и другое) и каким путём
     обновятся строки прежних сборок.

Код возврата 1, если есть расхождения в покрытии снимков.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from legacy_hashes import entry_hashes, canon, fnv64  # noqa: E402

# Записи, которых не было до локализации: у них нет хеша старой версии (см. src/seed.rs, mod tests).
NEW_AFTER_LOCALIZATION = ['item/srd24-shield-magic']
SEED_FILES = (('2014', 'data_seed/srd_2014.json'), ('2024', 'data_seed/srd_2024.json'))


def load_worktree(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as fh:
        return json.load(fh)


def load_rev(rev, path):
    out = subprocess.run(['git', 'show', f'{rev}:{path}'], cwd=ROOT, check=True, capture_output=True).stdout
    return json.loads(out.decode('utf-8'))


def load_json_dir(directory, edition):
    """Каталог версий релизов: <directory>/<версия>/<edition>.json (см. previous_shipped.py)."""
    out = []
    for version in sorted(os.listdir(directory)):
        path = os.path.join(directory, version, edition + '.json')
        if os.path.exists(path):
            with open(path, encoding='utf-8') as fh:
                out.append((version, json.load(fh)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--prev', default='v0.6.7', help='прежняя поставочная версия в git (тег, ветка или коммит)')
    ap.add_argument('--prev-json-dir', help='каталог с данными релизов вместо git: <каталог>/<версия>/<edition>.json')
    ap.add_argument('--edition', default='2014,2024')
    args = ap.parse_args()

    shipped = load_worktree('data_seed/previous_shipped.json')
    legacy = load_worktree('data_seed/legacy_hashes.json')
    problems = 0

    for edition in args.edition.split(','):
        seed_path = dict(SEED_FILES)[edition]
        current = load_worktree(seed_path)
        if args.prev_json_dir:
            previous = load_json_dir(args.prev_json_dir, edition)
        else:
            try:
                previous = [(args.prev, load_rev(args.prev, seed_path))]
            except subprocess.CalledProcessError:
                print(f'{edition}: не удалось прочитать {seed_path} из «{args.prev}» — проверьте имя версии')
                return 1
        snaps = shipped.get(edition, {})
        changed = []
        missing = []
        stale = []
        label = args.prev_json_dir or args.prev
        legacy_pairs = legacy.get(edition, {})
        routes = {}
        for e in current:
            key = f"{e['category']}/{e['slug']}"
            data_hash, mech_hash = entry_hashes(e)
            pairs = [tuple(p) for p in snaps.get(key, [])]
            legacy_pair = tuple(legacy_pairs.get(key, ())) or None
            for version, rows in previous:
                old = {f"{x['category']}/{x['slug']}": x for x in rows}.get(key)
                if old is None:
                    continue
                old_data, old_mech = entry_hashes(old)
                if (old_data, old_mech) == (data_hash, mech_hash) and old['name'] == e['name']:
                    routes['без изменений'] = routes.get('без изменений', 0) + 1
                    continue
                kind = 'данные' if old_data != data_hash else ''
                kind = (kind + '+механика') if old_mech != mech_hash and kind else ('механика' if old_mech != mech_hash else kind)
                changed.append((key, kind))
                # Тот же порядок решений, что в src/seed.rs: classify → ReplaceLegacy/AddMechanics, затем снимок.
                if legacy_pair and old_data == legacy_pair[0] and (not old_mech or old_mech == legacy_pair[1]):
                    route = 'ReplaceLegacy'
                elif not old_mech and old['name'] == e['name'] and old_data == data_hash:
                    route = 'AddMechanics'
                elif (old_data, old_mech) in pairs:
                    route = 'ReplaceShipped'
                else:
                    route = None
                routes[route or 'НЕ ПОКРЫТО'] = routes.get(route or 'НЕ ПОКРЫТО', 0) + 1
                if route is None:
                    missing.append((f'{key} ({version})', kind, (old_data, old_mech), pairs))
            if (data_hash, mech_hash) in pairs:
                stale.append(key)
        print(f'== {edition}: изменений против «{label}» — {len(changed)}')
        kinds = {}
        for _, kind in changed:
            kinds[kind] = kinds.get(kind, 0) + 1
        for kind, count in sorted(kinds.items()):
            print(f'   {kind or "без механики"}: {count}')
        covered = len({k.split(' (')[0] for k, _ in changed}) - len({k.split(' (')[0] for k, _, _, _ in missing})
        print(f'   записей с изменениями: {len({k for k, _ in changed})}, покрыто снимками previous_shipped.json: {covered}')
        print('   пути обновления строк прежних сборок: ' + ', '.join(
            f'{name} — {routes[name]}' for name in ('ReplaceLegacy', 'ReplaceShipped', 'AddMechanics', 'без изменений', 'НЕ ПОКРЫТО') if name in routes))
        if missing:
            problems += len(missing)
            print(f'   НЕ ПОКРЫТО: {len(missing)}')
            for key, kind, pair, pairs in missing[:10]:
                print(f'      {key} ({kind}): ожидалась пара {pair}, в снимке {pairs or "—"}')
        if stale:
            print(f'   предупреждение: снимок совпал с текущей записью у {len(stale)} записей (в базе он ничего не заменит): {", ".join(stale[:5])}')
        # старые хеши до локализации: покрытие ключей
        no_legacy = [f"{e['category']}/{e['slug']}" for e in current
                     if f"{e['category']}/{e['slug']}" not in legacy.get(edition, {})
                     and f"{e['category']}/{e['slug']}" not in NEW_AFTER_LOCALIZATION]
        print(f'   записей без хеша старой версии: {len(no_legacy)}' + (f' → {", ".join(no_legacy[:5])}' if no_legacy else ''))
        problems += len(no_legacy)

    print('\nпроблем: %d' % problems)
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
