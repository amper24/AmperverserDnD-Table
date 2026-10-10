#!/usr/bin/env python3
"""Исправление ru-текстов умений классов SRD 2014.

В русской записи класса `features` и `feature_texts` ключуются по названию умения. У семи классов (бард, жрец,
воин, паладин, следопыт, чародей, колдун) разные английские умения получили одинаковые русские названия
(«Боевой стиль» ×4, «Таинственные воззвания» ×11…), из‑за чего тексты затирали друг друга, а в строках уровней
попадал мусор из таблицы md. Скрипт даёт таким умениям уникальные русские названия и тексты из русского md SRD 5.1
(OmnisGM-Rules, CC BY 4.0), пересобирает ru `mechanics.programs` (id программ — как в английском оверлее) и
проверяет, что на каждый английский уровень приходится ровно одно русское название.

    python3 tools/srd/fix_class_features.py --md /path/to/OmnisGM-Rules/src/dnd/srd-5.1 [--file data_seed/srd_2014.json]
"""
import argparse, collections, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mechanics as MC

FILES = {'bard': '02_Bard', 'cleric': '03_Cleric', 'fighter': '05_Fighter', 'paladin': '07_Paladin', 'ranger': '08_Ranger',
         'sorcerer': '10_Sorcerer', 'warlock': '11_Warlock'}
# «Умение …»: общий заголовок уровня, у которого в английском варианте есть «X feature» с тем же текстом
FEATURE_RU = {'bard': 'Умение коллегии бардов', 'cleric': 'Умение божественного домена', 'fighter': 'Умение воинского архетипа'}
# куда собирать группы: префикс английского имени → префикс русского
GROUPS = {'Fighting Style': 'Боевой стиль', 'Metamagic': 'Метамагия', 'Eldritch Invocation': 'Таинственные воззвания'}
INTRO_RU = {'Fighting Style': 'Боевой стиль', 'Metamagic': 'Метамагия', 'Eldritch Invocations': 'Таинственные воззвания'}


def parse_md(path):
    out, cur = [], None
    for line in open(path, encoding='utf-8'):
        m = re.match(r'^(#{2,6})\s+(.*?)\s*$', line)
        if m:
            cur = [len(m[1]), re.sub(r'^Уровень \d+:\s*|^Level \d+:\s*', '', m[2]), []]; out.append(cur)
        elif cur is not None:
            cur[2].append(line.rstrip('\n'))
    return [(lv, t, '\n'.join(x for x in (l.strip() for l in b) if x)) for lv, t, b in out]


def norm(t):
    """Как у остальных умений в данных: без курсива и без строки «Требование: …»."""
    t = '\n'.join(l for l in t.split('\n') if not re.match(r'^\*(Требование|Prerequisite)', l))
    return t.replace('*', '')


def load_md(root, slug):
    ru = parse_md(os.path.join(root, 'ru', '06_Classes', FILES[slug] + '.md'))
    en = parse_md(os.path.join(root, 'en', '06_Classes', FILES[slug] + '.md'))
    assert len(ru) == len(en), (slug, len(ru), len(en))
    return {e[1]: r for e, r in zip(en, ru)}


def fix_class(entry, root):
    c = entry['data']; slug = entry['slug'].replace('srd14-', '')
    en = c['i18n']['en']; md = load_md(root, slug)
    enf = {k.rstrip('!'): v for k, v in en['features'].items()}
    ruft = c['feature_texts']; ruf = c['features']
    cur = {}  # английское имя -> текущее русское (по позициям в списках уровней)
    for l, names in enf.items():
        assert len(names) == len(ruf[l]), (slug, l)
        for n, r in zip(names, ruf[l]): cur.setdefault(n, r)
    by_ru = collections.defaultdict(list)
    for n, r in cur.items():
        if not n.endswith(' feature'): by_ru[r].append(n)
    bad = {n for n, r in cur.items() if not n.endswith(' feature') and len(by_ru[r]) > 1}
    new, text = dict(cur), {}
    for n in cur:
        group = next((g for g in GROUPS if n.startswith(g)), None)
        if n.endswith(' feature'):
            base = cur[n[:-len(' feature')]]
            if cur[n].startswith('|') or cur[n] == base:
                new[n] = FEATURE_RU[slug]; text[n] = ruft[base]
        elif n in INTRO_RU and n in bad:
            new[n] = INTRO_RU[n]; text[n] = norm(md[n][2])
        elif group and (n in bad or group == 'Fighting Style'):
            sub = n.split(':', 1)[1].strip() if ':' in n else n[len(group):].strip()
            # у остальных вариантов метамагии русские названия без префикса («Осторожное заклинание»)
            new[n] = md[sub][1] if group == 'Metamagic' else f'{GROUPS[group]} {md[sub][1]}' if group == 'Eldritch Invocation' else f'{GROUPS[group]}: {md[sub][1]}'
            text[n] = norm(md[sub][2])
        else:
            assert n not in bad, (slug, n, cur[n])
    assert len(set(new.values())) == len(new), (slug, [r for r, v in collections.Counter(new.values()).items() if v > 1])
    c['features'] = {l: [new[n] for n in names] for l, names in enf.items()}
    texts = {}
    for n in cur:
        t = text.get(n) or ruft.get(cur[n])
        assert t, (slug, n, new[n])
        texts[new[n]] = t
    order = []
    for l in sorted(enf, key=int):
        for n in enf[l]:
            if new[n] not in order: order.append(new[n])
    c['feature_texts'] = {r: texts[r] for r in order}
    return new


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--md', required=True); ap.add_argument('--file', default='data_seed/srd_2014.json')
    a = ap.parse_args()
    data = json.load(open(a.file, encoding='utf-8'))
    for e in data:
        if e['category'] == 'class' and e['slug'].replace('srd14-', '') in FILES:
            new = fix_class(e, a.md)
            # русская механика пересобирается из исправленных данных тем же кодом, что и при сборке справочника
            tmp = {'category': 'class', 'slug': e['slug'], 'data': {k: v for k, v in e['data'].items() if k not in ('mechanics', 'i18n')}}
            MC.convert([tmp], '2014')
            e['data']['mechanics'] = tmp['data']['mechanics']
            print(e['slug'], 'ok', len(new))
    open(a.file, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    # MC.convert даёт блоки v1; переводим в граф v2 тем же конвертером, что и build_srd.py.
    import subprocess
    subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'graph_convert.cjs'), a.file, a.file], check=True)


if __name__ == '__main__':
    main()
