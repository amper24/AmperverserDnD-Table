# -*- coding: utf-8 -*-
"""Загрузка параллельного корпуса SRD (en/ru) из OmnisGM-Rules (CC-BY-4.0) для локализации базового набора.

Источник: https://github.com/OmnisGM-App/OmnisGM-Rules  (src/dnd/srd-5.1|srd-5.2 / {en,ru})
Файлы en и ru внутри раздела построчно параллельны, но порядок разделов может отличаться (ru отсортирован по-русски),
поэтому пары строк строятся внутри раздела, найденного по английскому названию заголовка.
"""
import re, os, glob, difflib, collections

HEAD = re.compile(r'^(#{1,6})\s+(.*?)\s*$')
EN_IN_RU = re.compile(r'\(([A-Za-z0-9][^()]*(?:\([^()]*\)[^()]*)*)\)\s*$')


def norm(s):
    s = s.lower().replace('’', "'").replace('“', '"').replace('”', '"').replace('—', '-').replace('–', '-')
    s = s.replace('feet', 'ft').replace('foot', 'ft').replace('ft.', 'ft')
    return re.sub(r'[^a-z0-9а-яё+]+', ' ', s).strip()


def strip_md(s):
    """Убирает разметку выделения: в интерфейсе текст выводится как обычный."""
    s = re.sub(r'\*\*\*([^*]+)\*\*\*', r'\1', s)
    s = re.sub(r'\*\*_([^*]+?)_\*\*', r'\1', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'\1', s)
    s = re.sub(r'(?<![\w*])\*([^*\n]+)\*(?![\w*])', r'\1', s)
    s = re.sub(r'(?<![\w_])_([^_\n]+)_(?![\w_])', r'\1', s)
    return s.strip()


def kind(line):
    m = HEAD.match(line)
    if m: return 'h%d' % len(m.group(1))
    if line.startswith('|'): return 'T'
    if line.startswith('- **'): return 'b'
    if re.match(r'^\*\*\*?_?[^*]+?_?\*\*\*?\s', line): return 'n'
    if line.startswith('- '): return 'l'
    if line.startswith('*') and line.endswith('*'): return 'i'
    return 'p'


def nonempty(text):
    return [l.rstrip() for l in text.split('\n') if l.strip()]


class Block:
    def __init__(self, level, title, en, lines):
        self.level, self.title, self.en, self.lines = level, title, en, lines


def blocks_of(lines, is_ru):
    """Список разделов: заголовок + все строки до следующего заголовка того же или более высокого уровня."""
    heads = [(i, len(HEAD.match(l).group(1)), HEAD.match(l).group(2)) for i, l in enumerate(lines) if HEAD.match(l)]
    out = []
    for n, (i, lv, t) in enumerate(heads):
        j = len(lines)
        for i2, lv2, _ in heads[n + 1:]:
            if lv2 <= lv: j = i2; break
        en = None
        if is_ru:
            m = EN_IN_RU.search(t)
            en = m.group(1).strip() if m else None
        else:
            en = t
        out.append(Block(lv, t, en, lines[i:j]))
    return out


def align(a, b):
    """Пары (en, ru) для двух списков строк раздела."""
    if len(a) == len(b) and [kind(x) for x in a] == [kind(x) for x in b]:
        return list(zip(a, b))
    sa, sb = [kind(x) for x in a], [kind(x) for x in b]
    sm = difflib.SequenceMatcher(None, sa, sb, autojunk=False)
    out = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal' or (op == 'replace' and i2 - i1 == j2 - j1):
            out.extend(zip(a[i1:i2], b[j1:j2]))
    return out


class Corpus:
    """Параллельный корпус одной редакции: path -> {norm_en_title: [(en_lines, ru_lines)]}, плюс плоский список пар по файлу."""
    def __init__(self, root, ver):
        self.files = {}
        for f in sorted(glob.glob(os.path.join(root, ver, 'en', '**', '*.md'), recursive=True)):
            rel = os.path.relpath(f, os.path.join(root, ver, 'en'))
            r = os.path.join(root, ver, 'ru', rel)
            if not os.path.exists(r): continue
            self.files[rel] = (nonempty(open(f, encoding='utf-8').read()), nonempty(open(r, encoding='utf-8').read()))
        self._sections = {}

    def sections(self, rel):
        """Разделы файла: список (en_title, pairs) — по каждому заголовку с английским названием в ru."""
        if rel in self._sections: return self._sections[rel]
        en_lines, ru_lines = self.files[rel]
        eb, rb = blocks_of(en_lines, False), blocks_of(ru_lines, True)
        by_en = collections.defaultdict(list)
        for b in eb: by_en[norm(b.en)].append(b)
        used = collections.Counter()
        out = []
        for b in rb:
            if not b.en: continue
            k = norm(b.en)
            cands = by_en.get(k, [])
            idx = used[k]; used[k] += 1
            if idx >= len(cands): continue
            e = cands[idx]
            out.append((b.en, b.level, align(e.lines, b.lines)))
        self._sections[rel] = out
        return out

    def whole(self, rel):
        en_lines, ru_lines = self.files[rel]
        return align(en_lines, ru_lines)


# ---------------------------------------------------------------------------------------------
# Сопоставление английских фрагментов из data_seed с параллельными строками корпуса
# ---------------------------------------------------------------------------------------------
_PFX = re.compile(r'^\s*(?:[-*]\s+)?(\*{2,3}_?[^*]+?_?\*{2,3})[ \t]*')
_TOK = re.compile(r'[a-z0-9]{3,}')


def split_name(line):
    """'**_Name._** text' -> ('Name', 'text'); иначе (None, line)."""
    m = _PFX.match(line)
    if m:
        return strip_md(m.group(1)).rstrip('.:').strip(), line[m.end():]
    return None, line


def clean_ru(s):
    s = strip_md(s)
    return s


def ru_line_text(r):
    m = HEAD.match(r)
    if m:
        return clean_ru(EN_IN_RU.sub('', m.group(2)).strip())
    return clean_ru(r)


class Matcher:
    def __init__(self, pairs):
        self.items = []      # (en_norm, ru_text, kind)
        self.index = collections.defaultdict(list)
        self.exact = {}
        for e, r in pairs:
            self._add(strip_md(re.sub(r'^#+\s*', '', e)), ru_line_text(r), 'line')
            if not HEAD.match(e) and not e.startswith('|'): self._add_sentences(strip_md(e), strip_md(r))
            if e.startswith('|'): self._add_cells(e, r)
            en_n, en_t = split_name(e)
            ru_n, ru_t = split_name(r)
            if en_n is not None and ru_n is not None:
                self._add(en_n, ru_n, 'name')
                if en_t.strip() and ru_t.strip():
                    self._add(strip_md(en_t), strip_md(ru_t), 'text')
                    self._add_sentences(strip_md(en_t), strip_md(ru_t))
            # заголовки «Рус (Eng)» и пункты «- **Ключ:** значение»
            mh = HEAD.match(e)
            if mh:
                mr = HEAD.match(r)
                if mr:
                    ru_title = EN_IN_RU.sub('', mr.group(2)).strip()
                    self._add(mh.group(2), ru_title, 'name')
            if e.startswith('- **') and r.startswith('- **'):
                ek = re.match(r'^- \*\*([^*]+?):?\*\*:?\s*(.*)$', e); rk = re.match(r'^- \*\*([^*]+?):?\*\*:?\s*(.*)$', r)
                if ek and rk:
                    self._add(ek.group(1), rk.group(1), 'name')
                    if ek.group(2).strip() and rk.group(2).strip(): self._add(ek.group(2), rk.group(2), 'text')

    _SEN_EN = re.compile(r'(?<=[.!?:])\s+(?=[A-Z“"(])')
    _SEN_RU = re.compile(r'(?<=[.!?:])\s+(?=[A-ZА-ЯЁ“"«(])')
    _NUMRE = re.compile(r'\d+')

    def _add_sentences(self, en, ru):
        """Абзац → предложения (если их поровну и числа в парах совпадают): строки data_seed бывают склеены/разбиты иначе, чем в корпусе."""
        se, sr = self._SEN_EN.split(en.strip()), self._SEN_RU.split(ru.strip())
        if len(se) < 2 or len(se) != len(sr): return
        for a, b in zip(se, sr):
            if sorted(self._NUMRE.findall(a)) == sorted(self._NUMRE.findall(b)):
                self._add(strip_md(a), strip_md(b), 'sent')

    def _add_cells(self, en, ru):
        """Строка таблицы: пары одноимённых ячеек (описания, черты характера и т. п.)."""
        ce = [c.strip() for c in en.strip().strip('|').split('|')]
        cr = [c.strip() for c in ru.strip().strip('|').split('|')]
        if len(ce) != len(cr) or len(ce) < 2: return
        for a, b in zip(ce, cr):
            if len(a) > 3 and re.search(r'[A-Za-z]{3}', a) and b and not re.fullmatch(r'[-: ]*', a):
                self._add(strip_md(a), strip_md(b), 'cell')

    def _add(self, en, ru, kind):
        n = norm(en)
        if kind in ('name', 'cell', 'text', 'line') and sorted(self._NUMRE.findall(en)) != sorted(self._NUMRE.findall(ru)): return   # рассинхронизация строк корпуса
        if kind == 'name':  # «Legendary Resistance (3/Day)» ← «Legendary Resistance»
            mb = re.match(r'^(.*?)\s*\([^()]*\)$', en); rb = re.match(r'^(.*?)\s*\([^()]*\)$', ru)
            if mb and rb and mb.group(1) and rb.group(1) and norm(mb.group(1)) != n:
                self._add_one(norm(mb.group(1)), rb.group(1), 'name')
        self._add_one(n, ru, kind)

    def _add_one(self, n, ru, kind):
        if not n or not ru: return
        i = len(self.items)
        self.items.append((n, ru, kind))
        self.exact.setdefault(n, []).append(i)
        for t in set(_TOK.findall(n)):
            self.index[t].append(i)

    def find(self, piece, thr=0.72):
        n = norm(strip_md(piece))
        if not n: return None
        if n in self.exact:
            its = [self.items[i] for i in self.exact[n]]
            good = [x for x in its if x[2] != 'cell']
            if good: its = good
            cnt = collections.Counter(x[1] for x in its)
            top, c = cnt.most_common(1)[0]
            if not good and c * 2 <= len(its) and len(its) > 1: return None   # ячейки таблиц с разными переводами — рассинхронизация
            return top, 1.0, n
        if len(n) < 12: return None
        toks = set(_TOK.findall(n))
        score = collections.Counter()
        for t in toks:
            lst = self.index.get(t)
            if lst and len(lst) < 400:
                w = 1.0 / (1 + len(lst) / 20)
                for i in lst: score[i] += w
        best = (0, None, None)
        for i, _ in score.most_common(12):
            ne, ru, _k = self.items[i]
            if abs(len(ne) - len(n)) > max(30, len(n) * 0.5): continue
            sm = difflib.SequenceMatcher(None, n, ne, autojunk=False)
            if sm.real_quick_ratio() < thr or sm.quick_ratio() < thr: continue
            s = sm.ratio()
            if s > best[0]: best = (s, ru, ne)
        return (best[1], best[0], best[2]) if best[0] >= thr else None
