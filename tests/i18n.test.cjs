// Локализация: целостность справочника (ru/en), семантика слоя перевода и клиентские помощники языка.
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');

const CYR = /[А-Яа-яЁё]/, LAT = /[A-Za-z]/;
const seed = ed => JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`, 'utf8'));

// Эталон слияния — те же правила, что в src/i18n.rs и tools/srd/localize.py.
function merge(base, over) {
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(over) || !isObj(base)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k.endsWith('!')) { out[k.slice(0, -1)] = structuredClone(v); continue; }
    const cur = out[k];
    if (isObj(v) && isObj(cur)) out[k] = merge(cur, v);
    else if (Array.isArray(v) && Array.isArray(cur) && [...v, ...cur].every(x => isObj(x) && 'id' in x)) {
      const res = cur.slice(), idx = new Map(cur.map((x, i) => [x.id, i]));
      for (const x of v) { if (idx.has(x.id)) res[idx.get(x.id)] = merge(res[idx.get(x.id)], x); else res.push(structuredClone(x)); }
      out[k] = res;
    } else out[k] = structuredClone(v);
  }
  return out;
}
function view(entry, lang) {
  const { i18n, ...base } = entry.data;
  if (lang === 'ru' || !i18n?.[lang]) return { name: entry.name, data: base };
  const data = merge(base, i18n[lang]);
  const name = typeof data.name === 'string' && data.name ? data.name : entry.name;
  delete data.name;
  return { name, data };
}
function client() {
  const win = {};
  Object.assign(win, { document: { querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} }, cookie: '', addEventListener() {}, body: { append() {} }, createElement: () => ({}) },
    location: { search: '', pathname: '/', reload() {} }, navigator: {}, console, setTimeout, clearTimeout, fetch: () => {}, matchMedia: () => ({ matches: false }), history: {} });
  win.window = win; vm.createContext(win);
  vm.runInContext(fs.readFileSync('static/common.js', 'utf8'), win);
  return win;
}

test('слияние: k! заменяет, словари объединяются, списки с id — по id, остальное заменяется', () => {
  const base = { a: { x: 'ру', y: 'ру' }, list: ['а', 'б'], progs: [{ id: 'p1', name: 'Атака', n: 1 }, { id: 'p2', name: 'Урон' }], keep: 1, texts: { 'Ярость': 'текст' } };
  const over = { a: { x: 'en' }, list: ['a'], progs: [{ id: 'p1', name: 'Attack' }], 'texts!': { Rage: 'text' } };
  assert.deepEqual(merge(base, over), { a: { x: 'en', y: 'ру' }, list: ['a'], progs: [{ id: 'p1', name: 'Attack', n: 1 }, { id: 'p2', name: 'Урон' }], keep: 1, texts: { Rage: 'text' } });
  assert.deepEqual(base.a, { x: 'ру', y: 'ру' }, 'исходные данные не меняются');
});

for (const ed of ['2014', '2024']) {
  test(`SRD ${ed}: у каждой записи есть русское название и слой en с английским названием`, () => {
    const entries = seed(ed); assert.ok(entries.length > 1000);
    for (const e of entries) {
      assert.ok(CYR.test(e.name) || !LAT.test(e.name), `${e.slug}: русское название «${e.name}»`);
      assert.ok(!LAT.test(e.name), `${e.slug}: латиница в русском названии «${e.name}»`);
      const en = e.data.i18n?.en;
      assert.ok(en && typeof en.name === 'string' && en.name.trim(), `${e.slug}: нет data.i18n.en.name`);
      assert.ok(!CYR.test(en.name), `${e.slug}: кириллица в английском названии «${en.name}»`);
      assert.deepEqual(Object.keys(e.data.i18n), ['en'], `${e.slug}: неожиданные языки`);
    }
  });

  test(`SRD ${ed}: английский вид не содержит русского текста, кроме служебных значений механик`, () => {
    const allowed = new Set(Object.keys(client().Lang.TERMS_EN));
    const bad = [];
    for (const e of seed(ed)) {
      const v = view(e, 'en');
      const walk = (o, path) => {
        if (typeof o === 'string') { if (CYR.test(o) && !allowed.has(o)) bad.push(`${e.slug} ${path}: ${o.slice(0, 50)}`); }
        else if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
      };
      walk(v.data, '');
      assert.ok(!CYR.test(v.name), `${e.slug}: русское название в английском виде`);
    }
    assert.deepEqual(bad.slice(0, 10), []);
  });

  test(`SRD ${ed}: механика в английском виде идентична русской по структуре (id программ и блоков)`, () => {
    const ids = m => (m?.programs || []).map(p => [p.id, ...(p.blocks || []).map(b => b.id)].join('/')).join(',');
    for (const e of seed(ed)) {
      const ru = view(e, 'ru').data, en = view(e, 'en').data;
      assert.equal(ids(en.mechanics), ids(ru.mechanics), e.slug);
      assert.deepEqual(en.mechanics?.programs?.map(p => p.trigger), ru.mechanics?.programs?.map(p => p.trigger), e.slug);
    }
  });

  test(`SRD ${ed}: перекрёстные ссылки (классы заклинаний, родительские расы) совпадают в обоих языках`, () => {
    for (const lang of ['ru', 'en']) {
      const views = seed(ed).map(e => ({ category: e.category, ...view(e, lang) }));
      const names = c => new Set(views.filter(v => v.category === c).map(v => v.name));
      const classes = names('class'), races = names('race');
      for (const v of views) {
        if (v.category === 'spell') for (const c of v.data.classes || []) assert.ok(classes.has(c), `${lang}: ${v.name}: класс «${c}»`);
        if (v.category === 'race' && v.data.parent) assert.ok(races.has(v.data.parent), `${lang}: ${v.name}: раса «${v.data.parent}»`);
      }
    }
  });
}

test('манифест встроенных ассетов: понятные русские названия', () => {
  const list = JSON.parse(fs.readFileSync('data_seed/builtin/manifest.json', 'utf8'));
  assert.ok(list.length > 0);
  for (const a of list) { const w = a.name.replace(/\d+x\d+/g, '').replace(/NPC/g, '').trim(); assert.ok(!LAT.test(w) && (!w || CYR.test(w)), a.name); assert.ok(['map', 'token', 'prop'].includes(a.kind) || a.kind, a.name); assert.ok(fs.existsSync(`data_seed/builtin/${a.file}`), a.file); }
});

test('клиент: язык по умолчанию — русский; ?lang= добавляется только к запросам справочника', () => {
  const w = client(), L = w.Lang;
  assert.equal(L.get(), 'ru');
  assert.equal(L.url('/api/compendium?category=item'), '/api/compendium?category=item&lang=ru');
  assert.equal(L.url('/api/compendium'), '/api/compendium?lang=ru');
  assert.equal(L.url('/api/compendium/abc'), '/api/compendium/abc?lang=ru');
  assert.equal(L.url('/api/compendium/abc?raw=1'), '/api/compendium/abc?raw=1');
  assert.equal(L.url('/api/compendium?lang=ru&q=x'), '/api/compendium?lang=ru&q=x');
  assert.equal(L.url('/api/packs'), '/api/packs');
  assert.equal(L.url('/api/compendium-other'), '/api/compendium-other');
  L.set('en'); assert.equal(L.get(), 'en');
  assert.equal(L.url('/api/compendium?q=a'), '/api/compendium?q=a&lang=en');
  L.set('de'); assert.equal(L.get(), 'en', 'неизвестный язык игнорируется');
});

test('клиент: названия и описания наборов берутся из перевода, иначе из основного текста', () => {
  const L = client().Lang;
  const pack = { name: 'Мой набор', description: 'Описание', locale: 'ru', i18n: { en: { name: 'My pack', description: '' } } };
  assert.equal(L.packName(pack), 'Мой набор');
  L.set('en');
  assert.equal(L.packName(pack), 'My pack');
  assert.equal(L.packDesc(pack), 'Описание', 'пустой перевод — основной текст');
  assert.equal(L.packName({ name: 'Homebrew', locale: 'en', i18n: { ru: { name: 'Хоумбрю' } } }), 'Homebrew', 'набор на английском в английском виде');
  L.set('ru');
  assert.equal(L.packName({ name: 'Homebrew', locale: 'en', i18n: { ru: { name: 'Хоумбрю' } } }), 'Хоумбрю');
  assert.equal(L.packName({ name: 'Старый набор' }), 'Старый набор', 'у старых наборов нет locale и i18n');
  assert.equal(L.term('рубящий'), 'рубящий'); L.set('en'); assert.equal(L.term('рубящий'), 'Slashing'); assert.equal(L.term('что-то'), 'что-то');
});

test('клиент: rawEntry запрашивает сохранённые данные только для записей на языке просмотра', async () => {
  const w = client(); const calls = [];
  w.API.req = async (m, u) => { calls.push(u); return { id: 'x', data: { i18n: {} } }; };
  const plain = { id: 'x', data: { a: 1 } };
  assert.equal(await w.API.rawEntry(plain), plain);
  assert.deepEqual(calls, []);
  const got = await w.API.rawEntry({ id: 'x', data: { i18n_view: 'en' } });
  assert.deepEqual(calls, ['/api/compendium/x?raw=1']);
  assert.ok(got.data.i18n);
});
