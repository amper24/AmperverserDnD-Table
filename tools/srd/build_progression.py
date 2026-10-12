#!/usr/bin/env python3
"""Таблицы развития классов (SRD 5.1 → «2014», SRD 5.2 → «2024») из markdown OmnisGM-Rules (CC BY 4.0)
в наборы static/presets/class-progression-<редакция>.json (и multiclass-slots-<редакция>.json). Нужны мастеру повышения уровня: бонус мастерства, заговоры, известные и
подготовленные заклинания, ячейки, столбцы классов (ярости, скрытая атака, очки ки…).

    python3 tools/srd/build_progression.py --src /path/to/OmnisGM-Rules/src/dnd

Индекс static/presets/index.json не трогается: новые файлы наборов добавляются в него вручную.
"""
import argparse, json, re, pathlib

EDITIONS = {'2014': ('srd-5.1', '06_Classes'), '2024': ('srd-5.2', '03_Classes')}
SKIP = {'level', 'proficiency bonus', 'features', 'class features'}
SEMANTIC = {'cantrips': 'cantrips', 'cantrips known': 'cantrips', 'prepared spells': 'prepared', 'spells known': 'known',
            'spell slots': 'pact_slots', 'slot level': 'pact_level'}


def cells(line):
    return [c.strip() for c in line.strip().strip('|').split('|')]


def table(path):
    lines = path.read_text(encoding='utf-8').splitlines()
    for i, ln in enumerate(lines):
        if re.match(r'\|\s*(Level|Уровень)\b', ln):
            head = cells(ln); rows = []
            for r in lines[i + 2:]:
                if not r.startswith('|'): break
                c = cells(r)
                if c and c[0].isdigit(): rows.append(c)
            return head, rows
    raise SystemExit(f'нет таблицы уровней: {path}')


def num(v):
    v = v.strip()
    if v in ('—', '-', '–', ''): return 0
    return int(v) if re.fullmatch(r'\d+', v) else v


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--src', required=True); ap.add_argument('--out-dir', default='static/presets')
    a = ap.parse_args(); src = pathlib.Path(a.src); out = {}
    for ed, (book, folder) in EDITIONS.items():
        out[ed] = {}
        for f in sorted((src / book / 'en' / folder).glob('[0-9][0-9]_*.md')):
            if f.name.startswith('00_'): continue
            slug = f.stem.split('_', 1)[1].lower()
            eh, er = table(f); rh, rr = table(src / book / 'ru' / folder / f.name)
            assert len(eh) == len(rh) and len(er) == len(rr) == 20, (f, len(eh), len(rh), len(er), len(rr))
            cols, slots_idx, extra = [], [], []
            for i, h in enumerate(eh):
                k = h.lower()
                if re.fullmatch(r'[1-9]', h): slots_idx.append((int(h), i))
                elif k in SKIP: continue
                elif k in SEMANTIC: cols.append((SEMANTIC[k], i, rh[i], h))
                else: cols.append(('x:' + re.sub(r'\W+', '_', k).strip('_'), i, rh[i], h))
            levels = {}
            for row in er:
                lv = {'pb': int(row[1].replace('+', ''))}
                for key, i, _, _ in cols: lv[key] = num(row[i])
                if slots_idx: lv['slots'] = [num(row[i]) for _, i in sorted(slots_idx)]
                levels[row[0]] = lv
            out[ed][slug] = {'columns': [{'key': k, 'ru': ru, 'en': en} for k, _, ru, en in cols if k.startswith('x:')], 'levels': levels}
    outdir = pathlib.Path(a.out_dir); outdir.mkdir(parents=True, exist_ok=True)
    for ed, tables in out.items():
        # Таблицы классов: один набор на редакцию, элемент — класс (id = slug, как у ClassRules.slugOf).
        cls = {'kind': 'class_progression', 'id': f'builtin.class-progression.{ed}', 'name': f'Таблицы развития SRD {ed}', 'edition': ed,
               'items': [{'id': slug, 'table': t} for slug, t in tables.items()]}
        # Мультикласс заклинателей: общие ячейки по уровню колдуна — таблица волшебника, только слоты.
        slots = {lvl: {'slots': row['slots']} for lvl, row in tables['wizard']['levels'].items() if 'slots' in row}
        mc = {'kind': 'multiclass_slots', 'id': f'builtin.multiclass-slots.{ed}', 'name': f'Ячейки мультикласса SRD {ed}', 'edition': ed,
              'items': [{'id': 'multiclass', 'table': {'levels': slots}}]}
        for name, obj in ((f'class-progression-{ed}.json', cls), (f'multiclass-slots-{ed}.json', mc)):
            text = json.dumps(obj, ensure_ascii=False, indent=2) + '\n'
            (outdir / name).write_text(text, encoding='utf-8'); print(outdir / name, len(text), 'байт')


if __name__ == '__main__':
    main()
