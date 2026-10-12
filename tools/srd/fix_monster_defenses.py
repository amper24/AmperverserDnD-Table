#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Нормализация защит монстров по официальному дампу SRD: уязвимости, сопротивления, иммунитеты.

  python3 tools/srd/fix_monster_defenses.py            # показать, что изменится (ничего не пишет)
  python3 tools/srd/fix_monster_defenses.py --write     # записать в data_seed/srd_{2014,2024}.json
  python3 tools/srd/fix_monster_defenses.py --check     # только проверить (код 1 при расхождениях)
  python3 tools/srd/fix_monster_defenses.py --src DIR   # каталог src дампа (по умолчанию /tmp/srd/src)

Проблема: в полях `vulnerabilities` / `resistances` / `immunities` / `condition_immunities`
один и тот же термин писался по-разному («Гром» в 2014 и «Громовой» в 2024 вместо «Звук» из словаря
листа `static/modules.js::DAMAGE_TYPES` и глоссария SRD; «Огненный» вместо «Огонь»), а местами в
поле попадал посторонний текст или терялся термин: у голема из плоти в иммунитетах стояло название
умения «Поглощение электричества.», у студенистого куба и мимика — «Холод» вместо «Кислота»,
у глабрезу и остальных демонов 2014 пропал «Огонь», у оборотней 2014 лишний «Холод».

Что делает инструмент:
  1. сопоставляет запись с официальным дампом SRD по английскому названию (`data.i18n.en.name`);
  2. простые термины в поле пересобирает из дампа словарём проекта (`i18n_terms.DAMAGE_EN`,
     `CONDITION_EN`) — ничего не додумывает, только те типы урона и состояния, что есть в дампе;
  3. текстовые уточнения («от немагических атак», «(от Каменной кожи)») сохраняет как есть: это
     текст правила, а не термин;
  4. печатает каждое изменение и падает с кодом 1, если поле не удалось свести к дампу
     (например, в дампе текст, а в нашем поле — термины): такие случаи разбираются руками.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import i18n_terms as T  # noqa: E402

SEED_FILES = (('2014', 'data_seed/srd_2014.json'), ('2024', 'data_seed/srd_2024.json'))
DAMAGE_FIELDS = ('vulnerabilities', 'resistances', 'immunities')

# Написания из корпуса переводов → канонический ключ DAMAGE_EN.
DAMAGE_VARIANTS = {
    'гром': 'звук',
    'громовой': 'звук',
    'звуковой': 'звук',
    'огненный': 'огонь',
    'холодный': 'холод',
    'кислотный': 'кислота',
    'электрический': 'электричество',
    'ядовитый': 'яд',
    'некротическая энергия': 'некротический',
}
# Уточнение начинается с этих слов: дальше идёт текст правила, его не пересобираем.
QUALIFIERS = (' от ', ' (', ' которым ', ' которой ', ' которых ')
RU_DAMAGE = {ru: key for key, ru in T.DAMAGE_EN.items()}
EN_CONDITION = {en.lower(): ru for ru, en in T.CONDITION_EN.items()}


def dump_plain_and_prose(items):
    """(ключи простых типов урона, текстовые уточнения) как в дампе, в порядке дампа."""
    plain, prose = [], []
    for item in items or []:
        if isinstance(item, str) and item in T.DAMAGE_RU:
            plain.append(T.DAMAGE_RU[item])
        else:
            prose.append(item)
    return plain, prose


def term_key(word):
    """Ключ DAMAGE_EN для слова из русского текста (или None)."""
    low = word.strip().lower()
    return DAMAGE_VARIANTS.get(low, low if low in T.DAMAGE_EN else None)


def clause_terms(clause):
    """Канонические термины внутри куска строки (до разделителя-уточнения)."""
    cut = len(clause)
    for marker in QUALIFIERS:
        pos = clause.find(marker)
        if pos != -1:
            cut = min(cut, pos)
    keys = set()
    for part in re.split(r',| и ', clause[:cut]):
        key = term_key(part)
        if key:
            keys.add(key)
    return keys


def has_qualifier(clause):
    return any(marker in clause for marker in QUALIFIERS)


RU_CONDITION = sorted(T.CONDITION_EN, key=len, reverse=True)


def drop_conditions(value, edition, slug, field, report, write, d):
    """Убирает названия состояний из поля типов урона: состояние — не тип урона (см. ледяного дьявола)."""
    removed = []
    clauses = []
    for clause in value.split(';'):
        cleaned = clause
        for name in RU_CONDITION:
            pattern = re.compile(r'(^|[^а-яё])' + re.escape(name) + r'([^а-яё]|$)', re.I)
            if pattern.search(cleaned):
                removed.append(name)
                cleaned = re.sub(pattern, lambda m: m.group(1) if m.group(1) else '', cleaned, count=1)
        cleaned = cleaned.strip(' ,;')
        if cleaned:
            clauses.append(cleaned)
    if not removed:
        return value, False
    new = '; '.join(clauses)
    report('ИЗМЕНЕНО (состояние убрано из поля типа урона)', edition, slug, field, value, new, 'убрано: %s' % ', '.join(removed))
    if write:
        d[field] = new
    return new, True


def drop_damage_terms(value, edition, slug, report, write, d):
    """Убирает типы урона из поля иммунитета к состояниям."""
    parts, removed = [], []
    for part in value.split(','):
        word = part.strip()
        if term_key(word) is not None:
            removed.append(word)
        elif word:
            parts.append(word)
    if not removed:
        return value, False
    new = ', '.join(parts)
    report('ИЗМЕНЕНО (тип урона убран из иммунитета к состояниям)', edition, slug, 'condition_immunities', value, new,
           'убрано: %s' % ', '.join(removed))
    if write:
        d['condition_immunities'] = new
    return new, True


def ru_damage_field(value):
    """(термины вне уточнений, куски с уточнениями) русского поля."""
    plain, prose = set(), []
    for clause in value.split(';'):
        clause = clause.strip()
        if not clause:
            continue
        if has_qualifier(clause):
            prose.append(clause)
        else:
            plain |= clause_terms(clause)
    return plain, prose


def ru_word(key, capitals=True):
    """Русское название типа урона, как в словаре листа: ключи здесь — русские термины."""
    return key.capitalize() if capitals else key


def canon_damage(keys, capitals=True):
    return ', '.join(ru_word(key, capitals) for key in keys)


def rebuild_damage(plain, prose, capitalize=True):
    pieces = []
    if plain:
        pieces.append(canon_damage(plain, capitals=capitalize))
    pieces.extend(prose)
    return '; '.join(pieces)


def condition_names(items):
    """Русские названия состояний по элементам дампа ({index} или строка)."""
    names = []
    for item in items or []:
        index = (item or {}).get('index') if isinstance(item, dict) else str(item).lower().replace(' ', '-')
        ru = EN_CONDITION.get(str(index).lower())
        if ru:
            names.append(ru)
    return names


def process(entries, edition, monsters_by_name, write, report):
    changed = 0
    for e in entries:
        if e['category'] != 'monster':
            continue
        d = e['data']
        name = (d.get('i18n', {}).get('en') or {}).get('name')
        dump = monsters_by_name.get(name)
        if dump is None:
            report('НЕТ В ДАМПЕ', edition, e['slug'], '', name or '—', '', '')
            continue
        for field in DAMAGE_FIELDS:
            value = d.get(field) or ''
            if value:
                value, dropped = drop_conditions(value, edition, e['slug'], field, report, write, d)
                changed += 1 if dropped else 0
            dump_items = dump.get('damage_' + field)
            dump_plain, dump_prose = dump_plain_and_prose(dump_items)
            plain, prose = ru_damage_field(value)
            if not value and not dump_plain and not dump_prose:
                continue
            if not plain and not prose:
                # в поле нет ни одного известного термина
                if not dump_plain and dump_prose:
                    continue  # и в дампе не термины, а текст правила («тип урона выбирается умением...»)
                if not dump_plain and not dump_prose:
                    report('ЛИШНЕЕ ПОЛЕ', edition, e['slug'], field, value, '', 'в дампе пусто')
                    continue
                new = rebuild_damage(dump_plain, [])
                report('ИЗМЕНЕНО (поле пересобрано из дампа)', edition, e['slug'], field, value, new,
                       'дамп: %s' % ', '.join(ru_word(k) for k in dump_plain))
                changed += 1
                if write:
                    d[field] = new
                continue
            mismatch = plain != set(dump_plain) or len(prose) != len(dump_prose)
            if not mismatch:
                continue
            reason = ''
            if dump_prose and not prose:
                reason = 'в дампе текст, у нас его нет'
            elif prose and not dump_prose:
                reason = 'у нас текст, в дампе его нет'
            if reason:
                report('НЕЛЬЗЯ ПЕРЕСОБРАТЬ (%s)' % reason, edition, e['slug'], field, value, str(dump_items), '')
                continue
            new = rebuild_damage(dump_plain, prose)
            if new == value:
                continue
            report('ИЗМЕНЕНО', edition, e['slug'], field, value, new, 'дамп: %s' % ', '.join(ru_word(k) for k in dump_plain))
            changed += 1
            if write:
                d[field] = new
        value = d.get('condition_immunities') or ''
        if value:
            value, dropped = drop_damage_terms(value, edition, e['slug'], report, write, d)
            changed += 1 if dropped else 0
        want = condition_names(dump.get('condition_immunities'))
        got = [ru for ru in T.CONDITION_EN if ru.lower() in value.lower()]
        unknown = [part.strip() for part in value.split(',')
                   if part.strip() and part.strip().lower() not in {ru.lower(): None for ru in T.CONDITION_EN} and
                   part.strip().lower() not in {en.lower() for en in T.CONDITION_EN.values()}]
        if unknown:
            report('НЕИЗВЕСТНОЕ СОСТОЯНИЕ', edition, e['slug'], 'condition_immunities', value, str(unknown), '')
        if set(want) != set(got):
            new = ', '.join(want)
            if new != value:
                report('ИЗМЕНЕНО', edition, e['slug'], 'condition_immunities', value, new, 'дамп: %s' % ', '.join(want))
                changed += 1
                if write:
                    d['condition_immunities'] = new
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--src', default='/tmp/srd/src', help='каталог src официального дампа (5e-database)')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true', help='ничего не писать, код 1 при расхождениях')
    args = ap.parse_args()

    problems, total = [], 0

    def report(kind, edition, slug, field, before, after, extra):
        line = '%-40s %s #%s%s: %r → %r %s' % (
            kind, edition, slug, ('.' + field) if field else '', before, after, extra)
        print(line.rstrip())
        if not kind.startswith('ИЗМЕНЕНО'):
            problems.append(line)

    for edition, path in SEED_FILES:
        monsters = json.load(open(os.path.join(args.src, edition, 'en', '5e-SRD-Monsters.json'), encoding='utf-8'))
        by_name = {m['name']: m for m in monsters}
        full = os.path.join(ROOT, path)
        entries = json.load(open(full, encoding='utf-8'))
        total += process(entries, edition, by_name, args.write and not args.check, report)
        if args.write and not args.check:
            with open(full, 'w', encoding='utf-8') as fh:
                json.dump(entries, fh, ensure_ascii=False, separators=(',', ':'))

    print('\nизменённых полей: %d; замечаний: %d' % (total, len(problems)))
    if problems:
        return 1
    return 1 if (args.check and total) else 0


if __name__ == '__main__':
    raise SystemExit(main())
