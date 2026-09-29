const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {} }; vm.createContext(ctx);
for (const f of ['static/class-progression.js', 'static/levelup.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
const L = ctx.window.LevelUp;
const plain = x => JSON.parse(JSON.stringify(x));
const seed = ed => JSON.parse(fs.readFileSync(`data_seed/srd_${ed}.json`, 'utf8')).filter(e => e.category === 'class');
const classes = { 2014: seed(2014), 2024: seed(2024) };
const cls = (ed, slug) => classes[ed].find(e => e.slug === `srd${String(ed).slice(2)}-${slug}`);
const sheet = (o = {}) => ({ edition: '2014', level: 1, class: '', subclass: '', abilities: { str: 10, dex: 10, con: 14, int: 16, wis: 10, cha: 10 }, skills: [], expertise: [], features: [],
  hp: { max: 8, current: 8, temp: 0, hit_dice: '1d8' }, spells: { ability: '', slots: {}, known: [] }, proficiency_bonus: 2, ...o });
const stubs = { newFeature: f => ({ uid: 'f' + Math.random(), ...f }), spellFromCompendium: e => ({ uid: 's' + Math.random(), name: e.name, level: e.data.level, prepared: false }) };

test('таблицы развития есть для всех 12 классов обеих редакций и 20 уровней', () => {
  const P = ctx.window.CLASS_PROGRESSION;
  for (const ed of ['2014', '2024']) { assert.equal(Object.keys(P[ed]).length, 12); for (const c of Object.values(P[ed])) assert.equal(Object.keys(c.levels).length, 20); }
  assert.deepEqual(plain(P['2014'].wizard.levels['5'].slots.slice(0, 4)), [4, 3, 2, 0]);
  assert.equal(P['2024'].wizard.levels['5'].prepared, 9);
});
test('slugOf распознаёт класс по английскому и русскому названию', () => {
  assert.equal(L.slugOf(cls('2014', 'wizard')), 'wizard'); assert.equal(L.slugOf({ name: 'Колдун', data: {} }), 'warlock'); assert.equal(L.slugOf({ name: 'Свой класс', data: {} }), '');
});
test('план: волшебник 2014 на 2 уровне — традиция, ячейки, книга заклинаний', () => {
  const w = cls('2014', 'wizard'), p = L.plan(sheet({ level: 1, class: w.name }), w);
  assert.equal(p.to, 2); assert.equal(p.hitDie, 6); assert.equal(p.needSubclass, true);
  assert.ok(p.features.some(f => f.name === 'Магическая традиция')); assert.deepEqual(plain(p.slotsTo.slice(0, 2)), [3, 0]);
  assert.equal(p.spells.mode, 'book'); assert.equal(p.spells.spells, 2); assert.equal(p.spells.cantrips, 0);
});
test('план: улучшение характеристик и новый заговор на 4 уровне; бонус мастерства на 5', () => {
  const w = cls('2014', 'wizard'), p = L.plan(sheet({ level: 3, class: w.name, subclass: 'Школа Воплощения' }), w);
  assert.equal(p.asi, true); assert.equal(p.spells.cantrips, 1); assert.equal(p.needSubclass, false); assert.ok(p.subclass);
  const p5 = L.plan(sheet({ level: 4, class: w.name, subclass: 'Школа Воплощения' }), w); assert.deepEqual(plain(p5.pb), { from: 2, to: 3 });
});
test('план: подкласс воина 2024 на 3 уровне, эпический дар на 19', () => {
  const f = cls('2024', 'fighter'); const p = L.plan(sheet({ edition: '2024', level: 2, class: f.name }), f);
  assert.equal(p.needSubclass, true); assert.equal(p.subclassLevel, 3);
  assert.equal(L.plan(sheet({ edition: '2024', level: 18, class: f.name, subclass: 'Чемпион' }), f).epic, true);
});
test('план: магия договора колдуна и известные заклинания', () => {
  const w = cls('2014', 'warlock'), p = L.plan(sheet({ level: 4, class: w.name, subclass: 'Исчадие' }), w);
  assert.deepEqual(plain(p.pactTo), { count: 2, level: 3 }); assert.equal(p.spells.mode, 'known'); assert.equal(p.spells.spells, 1); assert.equal(p.spells.maxLevel, 3);
});
test('план: компетентность плута и барда', () => {
  assert.equal(L.plan(sheet({ level: 5, class: 'Плут' }), cls('2014', 'rogue')).expertise, 2);
  assert.equal(L.plan(sheet({ level: 2, class: 'Бард' }), cls('2014', 'bard')).expertise, 2);
  assert.equal(L.plan(sheet({ level: 2, class: 'Бард' }), cls('2014', 'wizard')).expertise, 0);
});
test('хиты: среднее, бросок, минимум 1 и пересчёт задним числом при смене Телосложения', () => {
  assert.equal(L.hpAverage(10), 6); assert.equal(L.hpAverage(6), 4);
  assert.equal(L.hpGain(8, { mode: 'roll', roll: 1 }, -2, -2, 3).gain, 1);
  const g = L.hpGain(10, { mode: 'avg' }, 2, 3, 3); assert.equal(g.gain, 9); assert.equal(g.retro, 3); assert.equal(g.total, 12);
});
test('улучшение характеристик: +2 или +1/+1, максимум 20', () => {
  const ab = { str: 15, dex: 10, con: 10, int: 10, wis: 10, cha: 19 };
  assert.equal(L.asiValid(ab, { str: 2 }), true); assert.equal(L.asiValid(ab, { str: 1, dex: 1 }), true); assert.equal(L.asiValid(ab, { str: 1 }), false);
  assert.equal(L.asiValid(ab, { cha: 2 }), false, '19 + 2 > 20'); assert.equal(L.asiValid(ab, { cha: 1, dex: 1 }), true); assert.equal(L.asiValid({ ...ab, cha: 20 }, { cha: 1 }), false);
});
test('применение: воин 3→4 с +2 Силы, умения, хиты и запись в историю', () => {
  const f = cls('2014', 'fighter'), s = sheet({ level: 3, class: f.name, subclass: 'Чемпион', abilities: { str: 15, dex: 10, con: 15, int: 10, wis: 10, cha: 10 }, hp: { max: 28, current: 20, temp: 0, hit_dice: '3d10' } });
  const p = L.plan(s, f); const r = L.apply(s, p, { hp: { mode: 'avg' }, asi: { mode: 'asi', plus: { str: 2 } } }, stubs);
  assert.equal(s.level, 4); assert.equal(s.abilities.str, 17); assert.equal(s.proficiency_bonus, 2); assert.equal(s.hp.hit_dice, '4d10');
  assert.equal(r.hp.total, 8); assert.equal(s.hp.max, 36); assert.equal(s.hp.current, 28); assert.equal(s.level_log.length, 1);
});
test('применение: волшебник 4→5 — ячейки, заговор, заклинания книги и черта вместо ASI', () => {
  const w = cls('2014', 'wizard'), s = sheet({ level: 4, class: w.name, subclass: 'Школа Воплощения', spells: { ability: 'int', slots: { 1: { max: 4, used: 3 }, 2: { max: 3, used: 0 } }, known: [] }, hp: { max: 22, current: 22, temp: 0, hit_dice: '4d6' } });
  const p = L.plan(s, w); assert.equal(p.to, 5); assert.deepEqual(plain(p.slotsTo.slice(0, 3)), [4, 3, 2]);
  L.apply(s, p, { hp: { mode: 'avg' }, cantrips: [], spells: [{ name: 'Огненный шар', data: { level: 3 } }, { name: 'Щит', data: { level: 1 } }] }, stubs);
  assert.deepEqual(plain(s.spells.slots[3]), { max: 2, used: 0 }); assert.equal(s.spells.slots[1].used, 3); assert.equal(s.proficiency_bonus, 3);
  assert.equal(s.spells.known.length, 2); assert.equal(s.spells.known[0].prepared, false);
  const t = sheet({ level: 7, class: w.name, subclass: 'Школа Воплощения' }); L.apply(t, L.plan(t, w), { hp: { mode: 'avg' }, asi: { mode: 'feat', feat: { name: 'Бдительный', data: { desc: 'Текст' } } } }, stubs);
  assert.ok(t.features.some(f => f.name === 'Бдительный' && f.text === 'Текст')); assert.equal(t.abilities.int, 16);
});
test('применение: подкласс добавляет свои умения, компетентность попадает в лист', () => {
  const r = cls('2014', 'rogue'), s = sheet({ level: 2, class: r.name, skills: ['stealth', 'acrobatics'] });
  const p = L.plan(s, r); assert.equal(p.needSubclass, true);
  L.apply(s, p, { hp: { mode: 'avg' }, subclass: r.data.subclasses[0], expertise: ['stealth'] }, stubs);
  assert.equal(s.subclass, r.data.subclasses[0].name); assert.deepEqual(plain(s.expertise), ['stealth']);
  assert.ok(s.features.some(f => f.source.includes(r.data.subclasses[0].name)), 'умения подкласса добавлены');
});
test('данные: план строится для всех классов, редакций и уровней без ошибок и мусора', () => {
  for (const ed of ['2014', '2024']) for (const e of classes[ed]) for (let lv = 1; lv <= 19; lv++) {
    const p = L.plan(sheet({ edition: ed, level: lv, class: e.name }), e);
    assert.equal(p.to, lv + 1); assert.ok(p.hitDie >= 6); assert.ok(p.pb.to >= 2);
    for (const f of p.features) assert.ok(f.name && !f.name.startsWith('|'), `${e.slug} ${lv}: ${f.name}`);
    if (p.slotsTo) assert.equal(p.slotsTo.length, 9);
  }
});

// ---------------------------------------------------------------- варианты умений, мультикласс, отмена
const byName = n => classes['2014'].find(e => e.name === n);
let uidSeq = 0;
const det = { newFeature: f => ({ uid: 'f' + ++uidSeq, ...f }), spellFromCompendium: e => ({ uid: 's' + ++uidSeq, name: e.name, level: e.data.level, prepared: false }), resolve: byName };

test('варианты: боевой стиль паладина — выбирается один, остальные не попадают в умения уровня', () => {
  const pal = cls('2014', 'paladin'), p = L.plan(sheet({ level: 1, class: pal.name }), pal);
  const g = p.groups.find(x => x.id === 'style'); assert.ok(g); assert.equal(g.count, 1); assert.ok(g.options.length >= 3);
  assert.ok(p.features.every(f => !f.name.startsWith('Боевой стиль')), 'варианты не в списке умений');
  const s = sheet({ level: 1, class: pal.name }); L.apply(s, p, { hp: { mode: 'avg' }, picks: { style: ['Боевой стиль: Оборона'] } }, det);
  const styles = s.features.filter(f => f.name.startsWith('Боевой стиль')); assert.equal(styles.length, 1); assert.equal(styles[0].name, 'Боевой стиль: Оборона'); assert.ok(styles[0].text.length > 10);
});
test('варианты: метамагия чародея — два на 3 уровне, по одному на 10 и 17, без повторов', () => {
  const sor = cls('2014', 'sorcerer'), p3 = L.plan(sheet({ level: 2, class: sor.name, subclass: 'Дикая магия' }), sor);
  const g = p3.groups.find(x => x.id === 'meta'); assert.equal(g.count, 2); assert.equal(g.options.length, 8);
  const s = sheet({ level: 2, class: sor.name, subclass: 'Дикая магия' }); L.apply(s, p3, { hp: { mode: 'avg' }, picks: { meta: ['Далёкое заклинание', 'Усиленное заклинание'] }, spells: [], cantrips: [] }, det);
  assert.deepEqual(s.features.filter(f => /заклинание$/.test(f.name)).map(f => f.name), ['Далёкое заклинание', 'Усиленное заклинание']);
  s.level = 9; s.classes[0].level = 9;
  const p10 = L.plan(s, sor); const g10 = p10.groups.find(x => x.id === 'meta'); assert.equal(g10.count, 1); assert.equal(g10.options.length, 6, 'уже выбранные исключены');
});
test('варианты: воззвания колдуна — количество по таблице и замена одного известного', () => {
  const wl = cls('2014', 'warlock'), s = sheet({ level: 1, class: wl.name, subclass: 'Исчадие' });
  const p2 = L.plan(s, wl); assert.equal(p2.groups.find(x => x.id === 'inv').count, 2);
  L.apply(s, p2, { hp: { mode: 'avg' }, picks: { inv: ['Таинственные воззвания Мучительный заряд', 'Таинственные воззвания Доспех теней'] }, spells: [], cantrips: [] }, det);
  assert.equal(s.features.filter(f => f.name.startsWith('Таинственные воззвания ')).length, 2);
  const p3 = L.plan(s, wl); assert.equal(p3.groups.find(x => x.id === 'pact').count, 1);
  const p5 = L.plan({ ...s, level: 4 }, wl); const inv = p5.groups.find(x => x.id === 'inv'); assert.equal(inv.count, 1); assert.equal(inv.swap.length, 2);
  const uid = s.features.find(f => f.name.endsWith('Доспех теней')).uid;
  const t = JSON.parse(JSON.stringify(s)); t.level = 4; t.classes[0].level = 4;
  L.apply(t, L.plan(t, wl), { hp: { mode: 'avg' }, picks: { inv: ['Таинственные воззвания Речь зверя'] }, swap: { inv: uid }, spells: [], cantrips: [] }, det);
  assert.ok(!t.features.some(f => f.uid === uid)); assert.ok(t.features.some(f => f.name.endsWith('Речь зверя')));
});
test('варианты: избранный враг следопыта записывается в текст умения', () => {
  const r = cls('2014', 'ranger'), s = sheet({ level: 5, class: r.name, subclass: 'Охотник' }), p = L.plan(s, r);
  const g = p.groups.find(x => x.kind === 'text' && x.feature.startsWith('Избранный враг')); assert.ok(g);
  L.apply(s, p, { hp: { mode: 'avg' }, texts: { [g.id]: 'Нежить' }, spells: [], cantrips: [] }, det);
  assert.ok(s.features.find(f => f.name === g.feature).text.startsWith('Избранный враг: Нежить.'));
});
test('варианты: боевой стиль 2024 — это черта; тайны магии барда — два заклинания любых классов', () => {
  const pal = cls('2024', 'paladin'), p = L.plan(sheet({ edition: '2024', level: 1, class: pal.name }), pal);
  const g = p.groups.find(x => x.id === 'style'); assert.equal(g.kind, 'feat');
  const s = sheet({ edition: '2024', level: 1, class: pal.name }); L.apply(s, p, { hp: { mode: 'avg' }, feats: { style: { name: 'Оборона', data: { desc: '+1 КД' } } } }, det);
  assert.ok(s.features.some(f => f.name === 'Оборона' && f.text === '+1 КД'));
  const bard = cls('2014', 'bard'), pb = L.plan(sheet({ level: 9, class: bard.name, subclass: 'Коллегия знаний' }), bard); assert.equal(pb.spells.secrets, 2);
  const t = sheet({ level: 9, class: bard.name, subclass: 'Коллегия знаний' }); L.apply(t, pb, { hp: { mode: 'avg' }, secrets: [{ name: 'Огненный шар', data: { level: 3 } }, { name: 'Щит', data: { level: 1 } }], spells: [], cantrips: [] }, det);
  assert.deepEqual(t.spells.known.map(x => x.name), ['Огненный шар', 'Щит']); assert.ok(t.spells.known.every(x => x.prepared));
});
test('классы листа: старый лист, несколько классов и рассинхрон с полем «Уровень»', () => {
  assert.deepEqual(plain(L.classesOf(sheet({ level: 4, class: 'Воин', subclass: 'Чемпион' }))), [{ name: 'Воин', level: 4, subclass: 'Чемпион' }]);
  assert.deepEqual(plain(L.classesOf(sheet({ level: 5, class: 'x', classes: [{ name: 'Воин', level: 3 }, { name: 'Волшебник', level: 2 }] }))).map(c => c.level), [3, 2]);
  assert.deepEqual(plain(L.classesOf(sheet({ level: 7, classes: [{ name: 'Воин', level: 3 }, { name: 'Волшебник', level: 2 }] }))).map(c => c.level), [5, 2], 'разница уходит в первый класс');
  assert.deepEqual(plain(L.classesOf(sheet({ level: 6, classes: [{ name: 'Воин', level: 2 }] }))).map(c => c.level), [6], 'один класс следует за уровнем');
  assert.equal(L.classLabel([{ name: 'Воин', level: 3 }, { name: 'Волшебник', level: 2 }]), 'Воин 3 / Волшебник 2');
});
test('мультикласс: требования к характеристикам и владения нового класса', () => {
  assert.equal(L.multiclassReq({ str: 14, dex: 10 }, 'fighter').ok, true); assert.equal(L.multiclassReq({ str: 10, dex: 13 }, 'fighter').ok, true);
  assert.deepEqual(plain(L.multiclassReq({ dex: 14, wis: 10 }, 'monk').missing).length, 1); assert.equal(L.multiclassReq({}, 'sorcerer').ok, false);
  const s = sheet({ level: 3, class: 'Волшебник', subclass: 'Школа Воплощения', abilities: { str: 10, dex: 10, con: 14, int: 16, wis: 10, cha: 10 } });
  const p = L.plan(s, cls('2014', 'fighter'), '2014', { resolve: byName }); assert.equal(p.isNew, true); assert.equal(p.from, 0); assert.equal(p.to, 1); assert.equal(p.multiclass.req.ok, false);
  assert.deepEqual(plain(p.multiclass.reqCurrent.map(r => r.name)), [], 'у волшебника Инт 16 — требования выполнены');
});
test('мультикласс: волшебник 3 + воин 1 — классы, кость хитов, владения, ячейки не меняются', () => {
  const s = sheet({ level: 3, class: 'Волшебник', subclass: 'Школа Воплощения', abilities: { str: 14, dex: 10, con: 14, int: 16, wis: 10, cha: 10 }, hp: { max: 18, current: 18, temp: 0, hit_dice: '3d6' },
    spells: { ability: 'int', slots: { 1: { max: 4, used: 1 }, 2: { max: 2, used: 0 } }, known: [] }, proficiency_bonus: 2 });
  const f = cls('2014', 'fighter'), p = L.plan(s, f, '2014', { resolve: byName });
  assert.equal(p.multiclass.req.ok, true); assert.deepEqual(plain(p.pb), { from: 2, to: 2 });
  L.apply(s, p, { hp: { mode: 'avg' }, picks: { style: ['Боевой стиль: Оборона'] } }, det);
  assert.equal(s.level, 4); assert.equal(s.class, 'Волшебник 3 / Воин 1'); assert.equal(s.subclass, 'Школа Воплощения');
  assert.deepEqual(plain(s.classes.map(c => [c.name, c.level])), [['Волшебник', 3], ['Воин', 1]]); assert.equal(s.hp.hit_dice, '3d6+1d10');
  assert.equal(s.hp.max, 18 + 8, 'среднее d10 = 6, Тел +2'); assert.ok(s.features.some(f => f.name === 'Владения мультикласса: Воин')); assert.match(s.proficiencies, /Воин \(мультикласс\)/);
  assert.deepEqual(plain(s.spells.slots[1]), { max: 4, used: 1 }); assert.ok(s.features.some(f => f.name === 'Второе дыхание'));
  assert.deepEqual(plain(s.saving_throws || []), [], 'спасброски нового класса не выдаются');
  const p2 = L.plan(s, f, '2014', { resolve: byName }); assert.equal(p2.isNew, false); assert.equal(p2.from, 1); assert.equal(p2.to, 2); assert.equal(p2.total.to, 5);
  assert.deepEqual(plain(p2.pb), { from: 2, to: 3 }, 'бонус мастерства — по общему уровню');
});
test('мультикласс: ячейки двух заклинателей считаются по общему уровню заклинателя, магия договора отдельно', () => {
  const s = sheet({ level: 3, class: 'Волшебник', subclass: 'Школа Воплощения', abilities: { str: 10, dex: 10, con: 14, int: 16, wis: 14, cha: 14 }, spells: { ability: 'int', slots: { 1: { max: 4, used: 0 }, 2: { max: 2, used: 0 } }, known: [] } });
  const cl = cls('2014', 'cleric'), p = L.plan(s, cl, '2014', { resolve: byName });
  assert.equal(p.combined, true); assert.equal(p.casterLevel, 4); assert.deepEqual(plain(p.slotsTo.slice(0, 3)), [4, 3, 0]);
  L.apply(s, p, { hp: { mode: 'avg' }, subclass: cl.data.subclasses[0] }, det);
  assert.deepEqual(plain([1, 2].map(l => s.spells.slots[l].max)), [4, 3]);
  const wl = cls('2014', 'warlock'), s2 = JSON.parse(JSON.stringify(s)), pw = L.plan(s2, wl, '2014', { resolve: byName });
  L.apply(s2, pw, { hp: { mode: 'avg' }, subclass: wl.data.subclasses[0], picks: {}, spells: [], cantrips: [] }, det);
  assert.equal(s2.spells.slots[1].max, 4 + 1, 'общие ячейки + ячейка договора того же круга');
  const half = L.castingSummary('2014', [{ name: 'Паладин', level: 5 }, { name: 'Волшебник', level: 4 }], byName);
  assert.equal(half.casterLevel, 6, 'паладин считается половиной уровня, округление вниз'); assert.equal(L.castingSummary('2024', [{ name: 'Паладин', level: 5 }, { name: 'Волшебник', level: 4 }], n => classes['2024'].find(e => e.name === n)).casterLevel, 7);
});
test('отмена: повышение откатывается полностью, чужие правки листа остаются', () => {
  const w = cls('2014', 'wizard'), s = sheet({ level: 3, class: w.name, subclass: 'Школа Воплощения', abilities: { str: 10, dex: 10, con: 14, int: 15, wis: 10, cha: 10 }, hp: { max: 20, current: 15, temp: 0, hit_dice: '3d6' },
    spells: { ability: 'int', slots: { 1: { max: 4, used: 2 }, 2: { max: 2, used: 0 } }, known: [{ uid: 'old', name: 'Старое', level: 1 }] }, skills: ['arcana'] });
  const before = JSON.parse(JSON.stringify(s));
  L.apply(s, L.plan(s, w), { hp: { mode: 'avg' }, asi: { mode: 'asi', plus: { int: 1, con: 1 } }, cantrips: [{ name: 'Луч холода', data: { level: 0 } }], spells: [{ name: 'Щит', data: { level: 1 } }, { name: 'Огненный шар', data: { level: 3 } }], drop: ['old'] }, det);
  assert.ok(L.canUndo(s)); assert.equal(s.level, 4); assert.equal(s.abilities.int, 16);
  s.hp.current = 10; s.notes = 'заметка игрока';
  L.undo(s);
  assert.equal(s.level, 3); assert.equal(s.abilities.int, 15); assert.equal(s.abilities.con, 14); assert.equal(s.hp.max, 20); assert.equal(s.hp.current, 10); assert.equal(s.notes, 'заметка игрока');
  assert.equal(s.hp.hit_dice, '3d6'); assert.equal(s.proficiency_bonus, 2); assert.deepEqual(plain(s.spells.known.map(x => x.name)), ['Старое']); assert.equal(s.spells.slots[1].used, 2);
  assert.equal(s.class, before.class); assert.equal(s.subclass, before.subclass); assert.equal(s.classes, undefined); assert.deepEqual(plain(s.level_log), []); assert.deepEqual(plain(s.features), before.features);
  assert.equal(L.canUndo(s), false);
});
test('отмена: невозможна после ручной смены уровня; хранится только последняя запись отмены', () => {
  const f = cls('2014', 'fighter'), s = sheet({ level: 3, class: f.name, subclass: 'Чемпион', hp: { max: 28, current: 28, temp: 0, hit_dice: '3d10' } });
  L.apply(s, L.plan(s, f), { hp: { mode: 'avg' }, asi: { mode: 'asi', plus: { str: 2 } } }, det);
  L.apply(s, L.plan(s, f), { hp: { mode: 'avg' } }, det);
  assert.equal(s.level_log.filter(l => l.undo).length, 1); assert.equal(s.level, 5);
  s.level = 9; assert.equal(L.canUndo(s), false); assert.throws(() => L.undo(s));
  s.level = 5; L.undo(s); assert.equal(s.level, 4); assert.equal(s.hp.max, 28 + 8, 'второе повышение снято, первое осталось');
  assert.equal(L.canUndo(s), false, 'у первой записи данных для отмены уже нет');
});
test('данные: варианты умений не попадают в «Новые умения» ни у одного класса', () => {
  for (const e of classes['2014']) for (let lv = 0; lv <= 19; lv++) {
    const p = L.plan(sheet({ level: Math.max(1, lv), class: e.name }), e);
    for (const f of p.features) assert.ok(!/^(Боевой стиль: |Таинственные воззвания )/.test(f.name), `${e.slug} ${lv}: ${f.name}`);
    for (const g of p.groups) if (g.kind === 'feature') { assert.ok(g.options.length >= g.count, `${e.slug} ${lv} ${g.id}`); assert.ok(g.options.every(o => o.text.length > 5), `${e.slug} ${lv} ${g.id}`); }
  }
});
