#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локализация базового набора (SRD 2014/2024): русский текст в основных полях + английский слой data.i18n.en.

Использование:
  python3 tools/srd/localize.py <OmnisGM-Rules>/src/dnd [data_seed]

Вход:  data_seed/srd_2014.json, srd_2024.json в «сыром» виде (build_srd.py: русские названия, английские тексты).
Выход: те же файлы — основной язык ru (полностью русский текст), в data.i18n.en — английские название и тексты.
Русские тексты берутся из параллельного корпуса OmnisGM-Rules (CC-BY-4.0), см. i18n_md.py; короткие термины —
в i18n_terms.py. Механика (data.mechanics) пересобирается tools/srd/mechanics.py из локализованных записей.
"""
import copy, json, os, re, sys, collections
sys.path.insert(0, os.path.dirname(__file__))
import i18n_md as M

LATIN = re.compile(r'[A-Za-z]{3,}')
SKIP_KEYS = {'name_en', 'edition', 'roll', 'kind', 'dtype', 'damage_type', 'save_ability', 'mechanics', 'slug', 'folder', 'token_asset_id',
             'cr', 'hit_die', 'primary', 'i18n', 'group', 'variants_of'}

CAT_FILES = {
    '2014': {'ver': 'srd-5.1', 'spell': ['10_Spells.md'], 'monster': ['15_MonstersA-Z.md', '14_Monsters.md'],
             'item': ['09_Equipment.md', '13_MagicItems.md'], 'class': ['06_Classes/%s'], 'race': ['04_Races.md'],
             'background': ['05_CharacterDetails.md'], 'feat': ['08_Feats.md'], 'condition': ['11_Conditions.md']},
    '2024': {'ver': 'srd-5.2', 'spell': ['07_Spells.md'], 'monster': ['12_MonstersA-Z.md', '13_Animals.md'],
             'item': ['06_Equipment.md', '10_MagicItems.md'], 'class': ['03_Classes/%s'], 'race': ['04_CharacterOrigins.md'],
             'background': ['04_CharacterOrigins.md'], 'feat': ['05_Feats.md'], 'condition': ['08_RulesGlossary.md']},
}

TERM_FIX = [  # терминология проекта (лист персонажа) ← терминология корпуса
    (r'\bВнимательност(ь|и|ью)\b', lambda m: {'ь': 'Восприятие', 'и': 'Восприятия', 'ью': 'Восприятием'}[m.group(1)]),
    (r'\bвнимательност(ь|и|ью)\b', lambda m: {'ь': 'восприятие', 'и': 'восприятия', 'ью': 'восприятием'}[m.group(1)]),
]


def fix_terms(s):
    for pat, fn in TERM_FIX:
        s = re.sub(pat, fn, s)
    return s


def aliases(n):
    """Названия разделов «родителя» для предмета-варианта (в корпусе один раздел на семейство)."""
    out = []
    m = re.match(r'^(.*?)\s*\([^()]*\)$', n)
    if m: out.append(m.group(1))
    m = re.match(r'^(.*?),?\s*\+\d$', n)
    if m:
        b = m.group(1)
        out += ['%s, +1, +2, or +3' % b, '%s +1, +2, or +3' % b, '%s +1, +2, +3' % b, b]
    for pat, rep in ((r'^(?:Gray|Rust|Tan) Bag of Tricks$', 'Bag of Tricks'), (r'^Belt of \w+ Giant Strength$', 'Belt of Giant Strength'),
                     (r'^Potion of \w+ Giant Strength$', 'Potion of Giant Strength'), (r'^(?:Silver|Brass|Bronze|Iron) Horn of Valhalla$', 'Horn of Valhalla'),
                     (r'^Manual of \w+ Golems$', 'Manual of Golems'), (r'^Potion of (?:Greater|Superior|Supreme) Healing$', 'Potions of Healing'),
                     (r'^Potion of Healing$', 'Potions of Healing'), (r'^Ring of \w+ Resistance$', 'Ring of Resistance'),
                     (r'^Armor of \w+ Resistance$', 'Armor of Resistance'), (r'^(\w+) (\w+) Dragon Scale Mail$', 'Dragon Scale Mail')):
        if re.match(pat, n): out.append(re.sub(pat, rep, n))
    return out


class Ctx:
    def __init__(self, root, ed):
        self.ed = ed
        cf = CAT_FILES[ed]
        self.corpus = M.Corpus(root, cf['ver'])
        self.cf = cf
        self._sec = {}
        self._matchers = {}
        self.unmatched = []
        self.item_names = {}
        self.spell_names = {}
        self.stats = collections.Counter()

    def files(self, cat, name_en=None):
        out = []
        for f in self.cf[cat]:
            if '%s' in f:
                base = f.replace('%s', '')
                out += [k for k in self.corpus.files if k.startswith(base) and not k.endswith('00_Classes.md')]
            else:
                out.append(f)
        return [f for f in out if f in self.corpus.files]

    def section_map(self, f):
        if f not in self._sec:
            m = {}
            for t, lv, pairs in self.corpus.sections(f):
                m.setdefault(M.norm(t), pairs)
            self._sec[f] = m
        return self._sec[f]

    def matcher(self, key, pairs_fn):
        if key not in self._matchers:
            m = M.Matcher(pairs_fn())
            m.is_section = key[0] == 'sec'
            self._matchers[key] = m
        return self._matchers[key]

    def scopes(self, cat, name_en):
        """Список Matcher по убыванию точности: раздел записи (и раздел «родителя» варианта) → файл(ы) категории → вся редакция."""
        out = []
        files = self.files(cat)
        if cat == 'class':   # сначала файл самого класса: соседние классы содержат почти те же формулировки
            files = sorted(files, key=lambda f: name_en.lower() not in os.path.basename(f).lower())
        for nm in [name_en] + (aliases(name_en) if cat == 'item' else []):
            n = M.norm(nm)
            for f in files:
                sm = self.section_map(f)
                if n in sm:
                    out.append(self.matcher(('sec', f, n), lambda sm=sm, n=n: sm[n]))
        for f in files:
            out.append(self.matcher(('file', f), lambda f=f: self.corpus.whole(f)))
        out.append(self.matcher(('all',), lambda: [p for f in self.corpus.files for p in self.corpus.whole(f)]))
        return out


# ------------------------------------------------------------------------------------------------
# Перевод текста
# ------------------------------------------------------------------------------------------------
_NUM = re.compile(r'\d+(?:[.,]\d+)?')
MANUAL = {}   # tools/srd/i18n_manual.py: {английская строка: русская} — ручные переводы остатка
import i18n_terms as T
try:
    import i18n_manual as MAN
    MANUAL = MAN.TEXT
except ImportError:  # pragma: no cover
    MAN = None


def nums(s):
    s = re.sub(r'(?<=\d)[, \u00a0\u202f](?=\d{3}\b)', '', s)
    return collections.Counter(_NUM.findall(s))


def numbers_ok(en, ru):
    return nums(en) == nums(ru)


def bullet_split(s):
    m = re.match(r'^(\s*(?:[-*•]\s+)?)(.*)$', s, re.S)
    return m.group(1), m.group(2)


def norm_row(l):
    """Строка таблицы markdown без выравнивающих пробелов: '| a | b |'."""
    if not l.startswith('|'): return l
    return '| ' + ' | '.join(c.strip() for c in l.strip().strip('|').split('|')) + ' |'


class Tr:
    """Переводчик английских фрагментов одной записи."""

    def __init__(self, ctx, cat, name_en):
        self.ctx, self.cat, self.name_en = ctx, cat, name_en
        self.sc = ctx.scopes(cat, name_en)
        self.n_sec = sum(1 for k in self.sc if k is not None and getattr(k, 'is_section', False))
        self.names = {}   # заранее найденные названия (умения классов: «Level N: Name»)

    def find(self, piece, check=True, thr=0.72):
        for sc in self.sc:
            # внутри раздела самого предмета формулировки data_seed и корпуса могут слегка расходиться — порог ниже
            t = min(thr, 0.6) if (self.cat == 'item' and getattr(sc, 'is_section', False) and len(piece) > 60) else thr
            r = sc.find(piece, t)
            if r and (not check or numbers_ok(piece, r[0])):
                return fix_terms(r[0])
        return None

    def find_subst(self, piece):
        """Почти то же предложение, но с другими числами (пояса великанов, свитки): подставляем числа в русский текст."""
        pn = _NUM.findall(piece)
        if not pn or len(pn) > 8: return None
        for sc in self.sc[:3]:
            r = sc.find(piece, 0.86)
            if not r: continue
            ru, score, en_n = r
            cn = _NUM.findall(en_n)
            if len(cn) != len(pn): continue
            mp = {}
            ok = True
            for a, b in zip(cn, pn):
                if a != b:
                    if mp.get(a, b) != b: ok = False
                    mp[a] = b
            if not ok or not mp or len(mp) > 3: continue
            rn = _NUM.findall(ru)
            if collections.Counter(rn) != collections.Counter(cn): continue
            res = fix_terms(re.sub(r'(?<![\d.,])\d+(?:[.,]\d+)?(?![\d])', lambda m: mp.get(m.group(0), m.group(0)), ru))
            if not numbers_ok(piece, res): continue
            return res
        return None

    def cells(self, piece):
        """Строка таблицы markdown: переводим ячейки по отдельности."""
        if not piece.startswith('|'): return None
        cs = piece.strip().strip('|').split('|')
        out = []
        for c in cs:
            c = c.strip()
            if re.fullmatch(r'd\d+', c): out.append('к' + c[1:])
            elif LATIN.search(c):
                r = self.find(c, check=False) or self.find_subst(c) or (MANUAL.get(c))
                if r is None:
                    r = self.piece_plain(c)
                    if r is None: return None
                out.append(r)
            else: out.append(c)
        return '| ' + ' | '.join(out) + ' |'

    def piece_plain(self, c):
        for pat, rep in T.CELL_WORDS:
            if re.fullmatch(pat, c): return re.sub(pat, rep, c)
        return None

    def piece(self, piece):
        r = self._piece(piece)
        if r is None:
            r = MAN.TEXT_LAST.get(piece) or self.ctx.spell_names.get(piece) or self.ctx.item_names.get(piece)
        if r is None:
            m = re.match(r'^(.{3,60}?): (.{3,60})$', piece)
            if m and '.' not in m.group(0):
                a = self._piece(m.group(1)) or MAN.TEXT_LAST.get(m.group(1))
                b = self._piece(m.group(2)) or MAN.TEXT_LAST.get(m.group(2))
                if a and b: r = a + ': ' + b
        if r and r.endswith('.') and not piece.rstrip().endswith(('.', '!', '?', ':')) and len(piece) < 80:
            r = r[:-1]
        return r

    def _piece(self, piece):
        if piece in MANUAL: return MANUAL[piece]
        if piece in self.names: return self.names[piece]
        if piece.startswith('Содержимое: '): return 'Содержимое: ' + self.contents(piece[len('Содержимое: '):])
        if MAN:
            r = MAN.rules(piece, self.ctx)
            if r: return r
        if re.fullmatch(r'(?:.+? ×\d+)(?:, .+? ×\d+)*', piece): return self.contents(piece)
        r = self.find(piece)
        if r: return r
        r = self.cells(piece)
        if r: return r
        r = self.find_subst(piece)
        if r: return r
        pre, body = bullet_split(piece)
        if pre.strip() and body:
            r = self.find(body)
            if r: return pre + r
        # «Название. Текст» разбирается Matcher-ом по частям
        m = re.match(r'^(.{2,60}?)\.\s+(.+)$', body, re.S)
        if m:
            a, b = self.find(m.group(1)), self.find(m.group(2))
            if a and b: return pre + a + '. ' + b
        # хвост в скобках: «Name (d6)»
        m = re.match(r'^(.*?)\s*\(([^()]*)\)$', body)
        if m and m.group(1):
            a = self.find(m.group(1), check=False)
            if a:
                tail = tail_ru(m.group(2))
                if tail is not None: return pre + a + ' (' + tail + ')'
        # несколько предложений, склеенных из соседних строк корпуса: жадно набираем префикс
        sents = re.split(r'(?<=[.!?:])\s+(?=[A-Z“"(])', body)
        if len(sents) > 1:
            out, i = [], 0
            while i < len(sents):
                for k in range(len(sents), i, -1):
                    r = self.find(' '.join(sents[i:k]), thr=0.9 if k - i > 1 else 0.72)
                    if r: out.append(r); i = k; break
                else:
                    return None
            return pre + ' '.join(out)
        return None

    def contents(self, s):
        """'Backpack ×1, Bell ×1' -> русские названия предметов той же редакции."""
        out = []
        parts = re.findall(r'\s*(.+?) ×(\d+)(?:,\s*|$)', s)
        for name, n in parts:
            ru = self.ctx.item_names.get(name)
            if ru is None:
                self.ctx.unmatched.append((self.cat, self.name_en, 'contents', name)); ru = name
            out.append('%s ×%s' % (ru, n))
        return ', '.join(out)

    def section_body(self):
        """(en, ru) — текст раздела записи из корпуса без заголовка и строки типа («*Wand, rare*»); таблицы без разделителей."""
        pairs = self.raw_pairs()
        en_l, ru_l = [], []
        first = True
        for a, b in pairs:
            if M.HEAD.match(a) and first: first = False; continue
            if first: continue
            if re.fullmatch(r'\|[-:| ]+\|?', a.strip()): continue
            if M.kind(a) == 'i' and not en_l: continue
            fa, fb = re.sub(r'^#+\s*', '', M.strip_md(a)), re.sub(r'^#+\s*', '', M.strip_md(b))
            fa, fb = norm_row(fa), norm_row(fb)
            en_l.append(fa); ru_l.append(fb)
        return '\n'.join(en_l), '\n'.join(ru_l)

    def raw_pairs(self):
        """Пары строк (en, ru) раздела записи в корпусе (или [])."""
        for nm in [self.name_en] + (aliases(self.name_en) if self.cat == 'item' else []):
            n = M.norm(nm)
            for f in self.ctx.files(self.cat):
                sm = self.ctx.section_map(f)
                if n in sm: return sm[n]
        return []

    def text(self, s, where=''):
        if not isinstance(s, str) or not LATIN.search(s): return s
        if s in MANUAL: return MANUAL[s]
        if where == 'languages' and s in T.LANG_RU: return T.LANG_RU[s]
        out = []
        for line in s.split('\n'):
            if not line.strip() or not LATIN.search(line):
                out.append(line); continue
            indent = re.match(r'\s*', line).group(0)
            r = self.piece(line.strip())
            if r is None:
                self.ctx.unmatched.append((self.cat, self.name_en, where, line.strip()))
                out.append(line)
            else:
                self.ctx.stats['ok'] += 1
                out.append(indent + r)
        return '\n'.join(out)


def ru_plural(n, forms):
    n = abs(int(n)); a, b, c = forms
    if n % 10 == 1 and n % 100 != 11: return a
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14: return b
    return c


def tail_ru(t):
    """Содержимое скобок в хвосте названия умения: '1 use', '2 uses', 'd6', '3'."""
    if not LATIN.search(t) or re.fullmatch(r'[\dd+\-/ ,]+', t): return t
    m = re.fullmatch(r'(\d+) (?:use|uses)', t)
    if m: return '%s %s' % (m.group(1), ru_plural(m.group(1), ('использование', 'использования', 'использований')))
    m = re.fullmatch(r'(?:One|Two|Three|Four|Five|Six) uses?', t, re.I)
    if m: return None
    m = re.fullmatch(r'CR ([\d/]+) or below(?:, no flying or swim speed| , no flying speed|, no flying speed)?', t)
    if m:
        extra = ', без скорости полёта и плавания' if 'swim' in t else (', без скорости полёта' if 'flying' in t else '')
        return 'ПО %s или ниже%s' % (m.group(1), extra)
    m = re.fullmatch(r'(\d) (type|types|enemies|terrain type|terrain types)', t)
    if m:
        n = int(m.group(1)); w = m.group(2)
        if w.startswith('terrain'): return '%d %s местности' % (n, 'тип' if n == 1 else 'типа')
        if w == 'enemies': return '%d врага' % n
        return '%d %s' % (n, 'тип' if n == 1 else 'типа')
    W = {'Recharges after a Short or Long Rest': 'перезаряжается после короткого или продолжительного отдыха', 'Concentration': 'концентрация'}
    return W.get(t)


# ------------------------------------------------------------------------------------------------
# Обход данных
# ------------------------------------------------------------------------------------------------
KEYED_DICTS = {'feature_texts'}   # словари, ключи которых — названия и тоже переводятся


def walk(o, tr, key=None, skip=frozenset()):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in SKIP_KEYS or k in skip:
                out[k] = v; continue
            nk = tr.text(k, 'key:' + str(key)) if key in KEYED_DICTS else k
            out[nk] = walk(v, tr, k)
        return out
    if isinstance(o, list):
        return [walk(v, tr, key) for v in o]
    if isinstance(o, str):
        if key == 'spellcasting' and o in ('int', 'wis', 'cha'): return o
        return tr.text(o, str(key))
    return o


def diff(ru, en):
    """Слой перевода: то, что в en отличается от ru (формат слияния — docs/localization.md)."""
    if isinstance(ru, dict) and isinstance(en, dict):
        out = {}
        for k in en:
            if k not in ru or isinstance(ru[k], (dict, list)) != isinstance(en[k], (dict, list)):
                out[k + '!'] = en[k]; continue
            if isinstance(ru[k], dict) and isinstance(en[k], dict) and set(ru[k]) != set(en[k]):
                out[k + '!'] = en[k]; continue
            if isinstance(ru[k], list) and isinstance(en[k], list) and ru[k] != en[k] and not id_aligned(ru[k], en[k]):
                out[k + '!'] = en[k]; continue
            d = diff(ru[k], en[k])
            if d is not None: out[k] = d
        return out or None
    if isinstance(ru, list) and isinstance(en, list):
        if ru == en: return None
        if id_aligned(ru, en):
            res = []
            for a, b in zip(ru, en):
                d = diff(a, b)
                if d is not None: res.append({'id': a['id'], **d})
            return res or None
        return en
    return None if ru == en else en


def id_aligned(a, b):
    return (len(a) == len(b) and a and all(isinstance(x, dict) and isinstance(x.get('id'), str) for x in a + b)
            and all(x['id'] == y['id'] for x, y in zip(a, b)))


def merge(base, ov):
    """Слияние слоя перевода (то же правило реализовано в Rust: src/i18n.rs и в static/common.js)."""
    out = copy.deepcopy(base)
    for k, v in ov.items():
        if k.endswith('!'):
            out[k[:-1]] = copy.deepcopy(v)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        elif (isinstance(v, list) and isinstance(out.get(k), list) and v and out[k]
              and all(isinstance(x, dict) and isinstance(x.get('id'), str) for x in v + out[k])):
            cur = out[k]
            idx = {x['id']: i for i, x in enumerate(cur)}
            for x in v:
                if x['id'] in idx: cur[idx[x['id']]] = merge(cur[idx[x['id']]], x)
                else: cur.append(copy.deepcopy(x))
        else:
            out[k] = copy.deepcopy(v)
    return out


# ------------------------------------------------------------------------------------------------
# Короткие поля: пары (ru, en)
# ------------------------------------------------------------------------------------------------
def rev(d):
    return {v: k for k, v in d.items()}


CAT_RU_EN_PAIRS = {}


def pair_spell_fields(tr, d, ru, en):
    """Поля заклинания. ru/en — копии data, в которых нужно заполнить локализованные значения."""
    s = d.get('casting_time', '')
    if LATIN.search(s):
        ru['casting_time'] = T.CASTING_TIME.get(s) or tr.text(s, 'casting_time')
    s = d.get('range', '')
    if s:
        s = re.sub(r'\s*Component:.*$', '', s).strip()
        en['range'] = s
        ru['range'] = T.RANGE.get(s) or tr.text(s, 'range')
    s = d.get('duration', '')
    if s:
        r = T.duration_ru(s)
        en['duration'] = s[0].lower() + s[1:] if s.lower().startswith('up to') else s
        ru['duration'] = r or tr.text(s, 'duration')
    s = d.get('components', '')
    m = re.match(r'^([ВСМ, ]+)(?:\((.*)\))?$', s)
    if m:
        letters = m.group(1).strip().replace('В', 'V').replace('С', 'S').replace('М', 'M')
        en['components'] = letters + (' (%s)' % m.group(2).rstrip('.') if m.group(2) else '')
        if m.group(2):
            mat = None
            for a, b in tr.raw_pairs():  # материал берём из строки «Components» корпуса (текст SRD в обоих языках)
                if re.match(r'^\*\*Components:?\*\*', a):
                    ma = re.search(r'\((.*)\)\s*$', M.strip_md(a)); mb = re.search(r'\((.*)\)\s*$', M.strip_md(b))
                    if ma and mb and nums(ma.group(1)) == nums(mb.group(1)):
                        mat = mb.group(1); en['components'] = letters + ' (%s)' % ma.group(1)
                    break
            if mat is None: mat = tr.text(m.group(2), 'components')
            ru['components'] = m.group(1).strip() + ' (%s)' % mat.rstrip('.')
    en['school'] = T.SCHOOL.get(d.get('school'), d.get('school'))
    en['classes'] = [T.CLASS.get(c, c) for c in d.get('classes', [])]
    if 'damage_type' in d and d['damage_type'] in T.DAMAGE_EN: en['damage_type'] = d['damage_type']
    acts = d.get('actions')
    if acts:
        en['actions'] = []
        for a in acts:
            b = dict(a); b['name'] = T.SPELL_ACTION_LABEL.get(a['name'], a['name'])
            if a.get('note'):
                nt = a['note']
                for r_, e_ in T.ABIL_EN.items(): nt = nt.replace(' ' + r_, ' ' + e_)
                b['note'] = nt.replace('СЛ', 'DC')
            en['actions'].append(b)


def type_pair(s):
    m = re.match(r'^([^()]+?)(?:\s*\(([^()]*)\))?$', s)
    base = m.group(1).strip(); sub = m.group(2)
    if LATIN.search(base):
        if base.lower() in T.MTYPE_FULL_RU:
            ru = T.MTYPE_FULL_RU[base.lower()]; en = base
            en = 'swarm of Tiny beasts' if 'beasts' in base else 'swarm of Tiny undead'
            return ru, en
        return None
    en_b = T.MTYPE_EN.get(base, base)
    if sub is None: return base, en_b
    subs = [x.strip() for x in sub.split(',')]
    ru_s = [T.MSUB_RU.get(x, x) if LATIN.search(x) else x for x in subs]
    en_s = [T.MSUB_EN.get(x, x) for x in subs]
    return '%s (%s)' % (base, ', '.join(ru_s)), '%s (%s)' % (en_b, ', '.join(en_s))


def rus_list_en(s, table):
    return ', '.join(table.get(x.strip(), x.strip()) for x in s.split(',')) if s else s


def pair_monster_fields(tr, d, ru, en):
    s = d.get('size', '')
    if s in T.SIZE_RU: ru['size'] = T.SIZE_RU[s]; en['size'] = 'Medium or Small'
    elif s in T.SIZE_EN: en['size'] = T.SIZE_EN[s]
    t = d.get('type', '')
    if t:
        p = type_pair(t)
        if p: ru['type'], en['type'] = p
        else: tr.ctx.unmatched.append(('monster', tr.name_en, 'type', t))
    a = d.get('alignment', '')
    if a in T.ALIGN_EN: en['alignment'] = T.ALIGN_EN[a]
    elif a in T.ALIGN_RU: ru['alignment'] = T.ALIGN_RU[a]; en['alignment'] = a
    elif LATIN.search(a): tr.ctx.unmatched.append(('monster', tr.name_en, 'alignment', a))
    sp = d.get('speed', '')
    en['speed'] = re.sub(r'(\d+) фт', r'\1 ft.', re.sub(r'полёт|плавание|лазание|копание', lambda m: T.SPEED_EN[m.group(0)], sp))
    sn = d.get('senses', '')
    ru_sn = sn
    for a_, b_ in (('(blind beyond this radius)', '(за пределами этого радиуса слеп)'), (' or ', ' или '), (' while deafened', ' при глухоте'),
                   ('(unimpeded by magical darkness)', '(магическая тьма не мешает)')):
        ru_sn = ru_sn.replace(a_, b_)
    ru['senses'] = ru_sn
    e_sn = re.sub(r'слепое зрение|тёмное зрение|истинное зрение|чувство вибрации|пассивное Восприятие', lambda m: T.SENSE_EN[m.group(0)], sn)
    en['senses'] = re.sub(r'(\d+) фт', r'\1 ft.', e_sn)
    for k, tab in (('skills', T.SKILL_EN), ('saves', T.ABIL_EN)):
        v = d.get(k, '')
        if v: en[k] = ', '.join(re.sub(r'^(.*?) (\+\d+)$', lambda m: tab.get(m.group(1), m.group(1)) + ' ' + m.group(2), x.strip()) for x in v.split(','))
    if d.get('condition_immunities'): en['condition_immunities'] = rus_list_en(d['condition_immunities'], T.CONDITION_EN)
    if d.get('hp'): en['hp'] = d['hp'].replace('к', 'd')
    for k in ('languages', 'vulnerabilities', 'resistances', 'immunities'):
        v = d.get(k, '')
        if v and LATIN.search(v):
            r = tr.find(v, check=True)
            if r and r.startswith('|'): r = None
            if r is None: r = compose_list(k, v)
            if r is None and MAN: r = MAN.rules(v, tr.ctx)
            if r is None: tr.ctx.unmatched.append(('monster', tr.name_en, k, v))
            else: ru[k] = r
            en[k] = v
    # действия «Name: урон»
    ar = d.get('actions_roll')
    if ar:
        ru['actions_roll'] = []; en['actions_roll'] = []
        for x in ar:
            y = dict(x); z = dict(x)
            m = re.match(r'^(.*?): (урон|попадание)$', x['name'])
            if m:
                base = tr.find(m.group(1), check=False) or tr.text(m.group(1), 'actions_roll')
                y['name'] = '%s: %s' % (base, m.group(2)); z['name'] = '%s: %s' % (m.group(1), {'урон': 'damage', 'попадание': 'hit'}[m.group(2)])
            else:
                y['name'] = tr.find(x['name'], check=False) or tr.text(x['name'], 'actions_roll')
            ru['actions_roll'].append(y); en['actions_roll'].append(z)


def compose_list(kind, v):
    """Резервный перевод перечней (языки, сопротивления) по словарям, когда в корпусе нет строки."""
    if kind == 'languages':
        parts = re.split(r'([;,] )', v)
        out = []
        for p in parts:
            if p in ('; ', ', '): out.append(p); continue
            m = re.fullmatch(r'telepathy (\d+) ft\.?', p, re.I)
            if m: out.append('телепатия %s фт' % m.group(1)); continue
            if p in T.LANG_RU: out.append(T.LANG_RU[p]); continue
            if p.lower() == 'all': out.append('все'); continue
            if p in ('None', '—'): out.append('—'); continue
            return T.LANGS_FULL.get(v)
        return ''.join(out)
    return T.dmg_list_ru(v)


def item_category(ed, cat, typ, name_en):
    """(русская категория, английская) по единой таксономии SRD; см. i18n_terms.GEAR_CAT / MAGIC_CAT."""
    if typ in ('weapon', 'armor'):
        return cat, T.WEAPON_CAT_EN.get(cat, cat)
    if typ == 'magic':
        return T.MAGIC_CAT[cat]
    if cat in ('Боеприпасы', 'Ammunition'): return T.GEAR_CAT['Ammunition']
    if ed == '2014' and cat in T.GEAR_CAT: return T.GEAR_CAT[cat]
    n = name_en
    for names, key in ((T.ARTISAN, "Artisan's Tools"), (T.OTHER_TOOLS, 'Other Tools'), (T.GAMING, 'Gaming Sets'), (T.MUSIC, 'Musical Instrument'),
                       (T.PACKS, 'Equipment Packs'), (T.ARCANE, 'Arcane Foci'), (T.DRUIDIC, 'Druidic Foci'), (T.HOLY, 'Holy Symbols')):
        if n in names: return T.GEAR_CAT[key]
    return T.GEAR_CAT['Standard Gear']


def pair_item_fields(tr, ed, e, d, ru, en, ctx_names):
    typ = d.get('type'); cat = d.get('category', '')
    ru['category'], en['category'] = item_category(ed, cat, typ, d['name_en'])
    r = d.get('rarity')
    if r:
        if r in T.RARITY_EN: en['rarity'] = T.RARITY_EN[r]
        elif r in T.RARITY_RU: ru['rarity'] = T.RARITY_RU[r]; en['rarity'] = 'Varies' if r == 'Rarity Varies' else r
        else: ctx_names.append(('item', d['name_en'], 'rarity', r))
    props = d.get('properties')
    if props:
        ru['properties'] = []; en['properties'] = []
        for p in props:
            m = re.match(r'^([^()]+?)(?: \(([^()]*)\))?$', p)
            base, par = m.group(1), m.group(2)
            if par and par.endswith('/None'):
                fix = T.THROWN_FIX.get(d['name_en'])
                par = fix if fix else par
            ru_p = base + (' (%s)' % par if par else '')
            en_p = T.PROP_EN.get(base, base) + (' (%s)' % par.replace('к', 'd') if par else '')
            if par and par.endswith('/None'): ctx_names.append(('item', d['name_en'], 'properties', p))
            ru['properties'].append(ru_p); en['properties'].append(en_p)
    if d.get('ac'): en['ac'] = d['ac'].replace('Лов', 'Dex').replace('макс', 'max')
    if d.get('cost'): en['cost'] = re.sub(r'(мм|см|зм|эм|пм)$', lambda m: T.COST_EN[m.group(1)], d['cost'])
    if d.get('damage'): en['damage'] = str(d['damage']).replace('к', 'd')
    desc = d.get('desc') or ''
    if 'Содержимое: ' in desc:
        en['desc'] = re.sub(r'^Содержимое: ', 'Contents: ', desc, flags=re.M)
    if d.get('mastery'): ru['mastery'] = T.MASTERY_RU.get(d['mastery'], d['mastery'])
    v = d.get('variants')
    if v: ru['variants'] = [tr.ctx.item_names.get(x) or tr.find(x, check=False) or tr.text(x, 'variants') for x in v]


def pair_class_fields(tr, d, ru, en):
    en['skills'] = {**d['skills'], 'from': [T.SKILL_EN.get(x, x) for x in d['skills']['from']]}
    p = d.get('primary', '')
    def pr(x):
        x = re.sub(r'\bили\b', 'or', x); x = re.sub(r'\bи\b', 'and', x)
        return re.sub(r'[А-Яа-я]+', lambda m: T.ABILITY_FULL_EN.get(m.group(0), m.group(0)), x)
    en['primary'] = pr(p)
    for sc in ru.get('subclasses', []): pass


def pair_race_fields(tr, d, ru, en, names):
    if d.get('size') in T.SIZE_EN: en['size'] = T.SIZE_EN[d['size']]
    if d.get('subraces'): en['subraces'] = [names.get(x, x) for x in d['subraces']]
    if d.get('parent'): en['parent'] = names.get(d['parent'], d['parent'])


def pair_background_fields(tr, d, ru, en):
    if d.get('skills'): en['skills'] = [T.SKILL_EN.get(x, x) for x in d['skills']]
    if d.get('asi_options'): en['asi_options'] = [T.ABIL_EN.get(x, x) for x in d['asi_options']]
    f = d.get('feat')
    if f:
        m = re.match(r'^(.*?) \(([^()]*)\)$', f)
        base, par = (m.group(1), m.group(2)) if m else (f, None)
        en_base = FEAT_EN.get(base)
        if en_base:
            en['feat'] = en_base + (' (%s)' % par if par else '')
            ru['feat'] = base + (' (%s)' % T.CLASS_RU.get(par, par) if par else '')


FEAT_EN = {}   # русское название черты -> английское; заполняется в main из справочника


def pair_feat_fields(tr, d, ru, en):
    p = d.get('prerequisites')
    if p:
        en['prerequisites'] = re.sub(r'[А-Я]{3}', lambda m: T.ABIL_EN.get(m.group(0), m.group(0)), p)


def condition_desc(ctx, d):
    """Описание состояния берём из md по заголовку: (ru, en)."""
    f = ctx.cf['condition'][0]
    pairs = ctx.corpus.whole(f)
    n = d['name_en']
    for i, (a, b) in enumerate(pairs):
        if a.strip() in ('#### ' + n, '#### %s [Condition]' % n):
            en_l, ru_l = [], []
            for a2, b2 in pairs[i + 1:]:
                if M.HEAD.match(a2): break
                en_l.append(M.strip_md(a2)); ru_l.append(M.strip_md(b2))
            return '\n'.join(ru_l), '\n'.join(en_l)
    return None, None


CYR = re.compile(r'[А-Яа-яЁё]')
EN_NAME_CODES = {'condition'}   # ключи, где русский текст — логика (ссылка на состояние), а не текст для показа


def class_feature_names(tr, d):
    """Названия умений: заголовки «Level N: Name» ↔ «Уровень N: Имя» (по уровню и названию без хвоста в скобках)."""
    def one(feats):
        for lvl, lst in feats.items():
            for n in lst:
                m = re.match(r'^(.*?)\s*(\(([^()]*)\))?$', n)
                base = m.group(1)
                r = tr.find('Level %s: %s' % (lvl, base), check=False)
                if r:
                    r = re.sub(r'^Уровень \d+:\s*', '', r)
                    tail = ''
                    if m.group(2):
                        t = tail_ru(m.group(3))
                        if t is None: continue
                        tail = ' (%s)' % t
                    tr.names[n] = r + tail
                    tr.names.setdefault(base, r)
    one(d.get('features', {}))
    for sc in d.get('subclasses', []): one(sc.get('features', {}))


def localize_entry(ctx, e, names, feat_names):
    ed, cat, d = ctx.ed, e['category'], e['data']
    d0 = copy.deepcopy(d); d0.pop('mechanics', None)
    tr = Tr(ctx, cat, d0['name_en'])
    if cat == 'spell' and d0.get('higher_level') and ' MOD SAVE' in d0['higher_level']:
        d0['higher_level'] = re.split(r'(?<=\.)\s+(?=(?:Huge or Smaller|Large|Medium)\b[^.]*?(?:Unaligned|Neutral)\b)', d0['higher_level'])[0]
    handled = set()
    if cat == 'class': class_feature_names(tr, d0)
    if cat == 'spell': handled = {'casting_time', 'range', 'duration', 'components', 'actions', 'school', 'classes'}
    elif cat == 'monster': handled = {'size', 'type', 'alignment', 'speed', 'senses', 'skills', 'saves', 'condition_immunities', 'hp', 'languages',
                                      'vulnerabilities', 'resistances', 'immunities', 'actions_roll'}
    elif cat == 'item': handled = {'type', 'category', 'rarity', 'properties', 'ac', 'cost', 'damage', 'mastery', 'variants'}
    elif cat == 'class': handled = {'skills', 'saves'}
    elif cat == 'race': handled = {'size', 'subraces', 'parent'}
    elif cat == 'background': handled = {'skills', 'asi_options', 'feat'}
    elif cat == 'feat': handled = {'prerequisites'}
    n_before = len(ctx.unmatched)
    ru = walk(d0, tr, skip=frozenset(handled))
    for k in handled:
        if k in d0: ru[k] = copy.deepcopy(d0[k])
    en = copy.deepcopy(d0)
    if cat == 'spell': pair_spell_fields(tr, d0, ru, en)
    elif cat == 'monster': pair_monster_fields(tr, d0, ru, en)
    elif cat == 'item': pair_item_fields(tr, ed, e, d0, ru, en, ctx.unmatched)
    elif cat == 'class': pair_class_fields(tr, d0, ru, en)
    elif cat == 'race': pair_race_fields(tr, d0, ru, en, names)
    elif cat == 'background': pair_background_fields(tr, d0, ru, en)
    elif cat == 'feat': pair_feat_fields(tr, d0, ru, en)
    elif cat == 'condition':
        r_desc, e_desc = condition_desc(ctx, d0)
        if e_desc is None: ctx.unmatched.append((cat, d0['name_en'], 'desc', '(нет раздела в md)'))
        else:
            en['desc'] = e_desc
            if not d0.get('desc') or LATIN.search(d0['desc']): ru['desc'] = r_desc
    if cat in ('race', 'class'):
        pass
    ru['name_en'] = d0['name_en']
    if cat in ('item', 'spell') and any(u[2] == 'desc' and u[3] != '(нет раздела в md)' for u in ctx.unmatched[n_before:]):
        # описание не удалось перевести по кускам (в data_seed другая редакция текста) — берём раздел корпуса целиком, в обоих языках
        en_t, ru_t = tr.section_body()
        if en_t and ru_t and len(ru_t) > 0.5 * len(en_t) and 'desc' in d0:
            ctx.unmatched[n_before:] = [u for u in ctx.unmatched[n_before:] if u[2] != 'desc']
            ru['desc'] = ru_t; en['desc'] = en_t
            ctx.stats['desc_from_section'] += 1
    if cat == 'class':  # подклассы: имена и сюжеты
        for sc_ru, sc_en in zip(ru.get('subclasses', []), en.get('subclasses', [])):
            sc_en['name'] = sc_en['name_en'] if 'name_en' in sc_en else sc_en['name']
    ru = post_ru(ru)
    return ru, en, tr


_EN_PAREN = re.compile(r"(?<=[а-яё]) \(([A-Z][a-z'’]+(?: (?:[A-Z][a-z'’]+|of|the|and|de)){0,4})\)")


def clean_ru_str(s):
    s = _EN_PAREN.sub('', s)                                   # «Древень (Treant)» → «Древень»
    s = re.sub(r'(?m)^(>?\s*)Table: ', r'\1Таблица: ', s)
    s = re.sub(r'\breach (\d+) ft\.?', r'досягаемость \1 футов', s)
    s = re.sub(r'\brange (\d+)/(\d+) ft\.?', r'дистанция \1/\2 футов', s)
    s = re.sub(r'\brange (\d+) ft\.?', r'дистанция \1 футов', s)
    return s


def post_ru(o, key=None):
    if isinstance(o, dict): return {k: (v if k in SKIP_KEYS else post_ru(v, k)) for k, v in o.items()}
    if isinstance(o, list): return [post_ru(v, key) for v in o]
    if isinstance(o, str): return clean_ru_str(o)
    return o


def leaves(o, path=()):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in SKIP_KEYS: continue
            yield from leaves(v, path + (k,))
    elif isinstance(o, list):
        for v in o: yield from leaves(v, path + ('[]',))
    elif isinstance(o, str):
        yield path, o


def process(root, src, ed, report):
    import mechanics as MC
    raw = json.load(open(src, encoding='utf-8'))
    ctx = Ctx(root, ed)
    names = {e['name']: e['data']['name_en'] for e in raw if e['category'] in ('race', 'class', 'background')}
    ctx.item_names = {e['data']['name_en']: e['name'] for e in raw if e['category'] == 'item'}
    ctx.spell_names = {e['data']['name_en']: e['name'] for e in raw if e['category'] == 'spell'}
    FEAT_EN.update({e['name']: e['data']['name_en'] for e in raw if e['category'] == 'feat'})
    out = []
    for e in raw:
        ru, en, tr = localize_entry(ctx, e, names, FEAT_EN)
        out.append({'category': e['category'], 'slug': e['slug'], 'name': e['name'], 'data': ru, '_en': en})
    ctx.stats['entries'] = len(out)
    # механика: русская из русских данных, английская из английского слоя
    ru_entries = [{**x, 'data': copy.deepcopy(x['data'])} for x in out]
    MC.convert(ru_entries, ed)
    overlays = []
    en_entries = []
    for x, rm in zip(out, ru_entries):
        ov = diff(x['data'], x['_en']) or {}
        ov = {'name': x['data']['name_en'], **ov}
        overlays.append(ov)
        view = merge(x['data'], ov)
        en_entries.append({'category': x['category'], 'slug': x['slug'], 'name': x['name'], 'data': view})
    MC.convert(en_entries, ed, lang='en')
    final = []
    for x, rm, em, ov in zip(out, ru_entries, en_entries, overlays):
        data = x['data']
        data['mechanics'] = rm['data']['mechanics']
        mp = diff(rm['data']['mechanics'], em['data']['mechanics'])
        if mp: ov['mechanics'] = mp
        data['i18n'] = {'en': ov}
        final.append({'category': x['category'], 'slug': x['slug'], 'name': x['name'], 'data': data})
        # контроль: в английском виде не должно быть кириллицы, в русском — латиницы
        view = merge({k: v for k, v in data.items() if k != 'i18n'}, ov)
        for path, s in leaves(view):
            if 'mechanics' in path: continue
            if CYR.search(s) and not (path and path[-1] in EN_NAME_CODES):
                report['cyr_in_en'].append((x['category'], data['name_en'], '.'.join(path), s[:100]))
        for path, s in leaves({k: v for k, v in data.items() if k not in ('i18n', 'mechanics')}):
            if LATIN.search(s): report['latin_in_ru'].append((x['category'], data['name_en'], '.'.join(path), s[:100]))
    report['unmatched'] += [list(u) for u in ctx.unmatched]
    report['stats'][ed] = dict(ctx.stats)
    return final


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('root', help='<OmnisGM-Rules>/src/dnd')
    ap.add_argument('--src', default=os.path.join(os.path.dirname(__file__), '..', '..', 'data_seed'), help='каталог с исходными srd_*.json')
    ap.add_argument('--out', help='куда писать (по умолчанию не пишет)')
    ap.add_argument('--report', default='/tmp/work/report.json')
    ap.add_argument('--ed', default='2014,2024')
    a = ap.parse_args()
    report = {'unmatched': [], 'cyr_in_en': [], 'latin_in_ru': [], 'stats': {}}
    for ed in a.ed.split(','):
        res = process(a.root, os.path.join(a.src, 'srd_%s.json' % ed), ed, report)
        if a.out:
            with open(os.path.join(a.out, 'srd_%s.json' % ed), 'w', encoding='utf-8') as f:
                json.dump(res, f, ensure_ascii=False, separators=(',', ':'))
    json.dump(report, open(a.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    c = collections.Counter((u[0], u[2]) for u in report['unmatched'])
    print('stats', report['stats'])
    print('unmatched', len(report['unmatched']), c.most_common(25))
    print('cyr_in_en', len(report['cyr_in_en']), 'latin_in_ru', len(report['latin_in_ru']))


if __name__ == '__main__':
    main()
