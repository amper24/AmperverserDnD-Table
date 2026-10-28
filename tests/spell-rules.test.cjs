// Учёт ячеек заклинаний и сборка действия «Сотворить»: чистые правила листа и сборка
// действия из плана исполнения (те же функции вызывают лист персонажа и tools/srd).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function el(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat().filter(value => value !== null && value !== undefined), style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, append(...more) { this.children.push(...more.flat()); }, appendChild(value) { this.children.push(value); }, replaceChildren(...values) { this.children = values.flat().filter(value => value !== null && value !== undefined); }, addEventListener() {}, querySelector() { return null; }, closest() { return null; } };
}
const ctx = { window: {}, crypto: require('node:crypto').webcrypto, el, toast() {}, document: { createElementNS() { return { setAttribute() {}, appendChild() {} }; } }, ABIL: { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' }, SKILLS: [] };
vm.createContext(ctx);
// Порядок загрузки — как на листе персонажа: правила заклинаний опираются на Mechanics.
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js',
                    ...require('../tools/nodes/node-loader.cjs').nodeFiles().map(f => path.relative(ROOT, f)), 'static/spell-rules.js', 'static/mechanics-graph.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
const M = ctx.window.Mechanics, R = ctx.window.SpellRules;
const plain = value => JSON.parse(JSON.stringify(value));
const seeds = { 2014: JSON.parse(fs.readFileSync(path.join(ROOT, 'data_seed/srd_2014.json'), 'utf8')), 2024: JSON.parse(fs.readFileSync(path.join(ROOT, 'data_seed/srd_2024.json'), 'utf8')) };

const modulesCtx = { window: {} }; vm.createContext(modulesCtx);
vm.runInContext(fs.readFileSync('static/formulas.js', 'utf8'), modulesCtx);
vm.runInContext(fs.readFileSync('static/modules.js', 'utf8'), modulesCtx);
const Modules = modulesCtx.window.Modules;

test('модуль заклинания задаёт обычный расход по умолчанию и сохраняет индивидуальную стоимость/заряды из справочника', () => {
  const fresh = Modules.newSpell(); assert.equal(fresh.cast_cost, null); assert.equal(fresh.use_cost, 1); assert.equal(fresh.uses, null);
  const imported = Modules.spellFromCompendium({ name: 'Особое заклинание', data: { level: 2, cast_cost: 'uses', use_cost: 2, uses: { cur: 3, max: 4, recharge: 'long' } } });
  assert.equal(imported.cast_cost, 'uses'); assert.equal(imported.use_cost, 2); assert.deepEqual(plain(imported.uses), { cur: 3, max: 4, recharge: 'long' });
});

test('обычные заклинания расходуют ровно одну ячейку подходящего круга; upcast и отсутствующий ресурс', () => {
  const spells = { slots: { 1: { max: 2, used: 2 }, 2: { max: 1, used: 0 } } };
  assert.deepEqual(plain(R.slotPool(spells, { level: 1 })), [{ pool: 'slots', level: 2, remaining: 1 }]);
  assert.deepEqual(plain(R.spend(spells, { level: 1 }, { pool: 'slots', level: 2 })), { ok: true, cost: 'slots', level: 2 });
  assert.equal(spells.slots[2].used, 1);
  assert.equal(R.spend(spells, { level: 1 }, { pool: 'slots', level: 2 }).ok, false);
  assert.equal(R.spend(spells, { level: 3 }, { pool: 'slots', level: 2 }).ok, false);
});

test('заговор бесплатный, ритуал может не тратить ячейку, если заклинание помечено ритуальным', () => {
  const spells = { slots: {} };
  assert.equal(R.castCost({ level: 0, cast_cost: 'slot' }), 'free', 'заговор не расходует ячейку даже при некорректном старом значении');
  assert.deepEqual(plain(R.spend(spells, { level: 0 })), { ok: true, cost: 'free', level: 0 });
  assert.deepEqual(plain(R.spend(spells, { level: 1, ritual: true }, { ritual: true })), { ok: true, cost: 'ritual', level: 1 });
  assert.equal(R.spend(spells, { level: 1, ritual: false }, { ritual: true }).ok, false);
});

test('ячейки Договора независимы от обычных, а заданный расход зарядов проверяется и списывается', () => {
  const spells = { slots: { 2: { max: 1, used: 0 } }, pact_slots: { level: 2, max: 2, used: 0 } };
  assert.deepEqual(plain(R.slotPool(spells, { level: 1 })), [
    { pool: 'slots', level: 2, remaining: 1 }, { pool: 'pact_slots', level: 2, remaining: 2 }
  ]);
  assert.deepEqual(plain(R.spend(spells, { level: 1 }, { pool: 'pact_slots', level: 2 })), { ok: true, cost: 'pact_slots', level: 2 });
  const chargeSpell = { level: 1, cast_cost: 'uses', use_cost: 2, uses: { cur: 3, max: 3, recharge: 'short' } };
  assert.deepEqual(plain(R.spend(spells, chargeSpell)), { ok: true, cost: 'uses', amount: 2 });
  assert.equal(chargeSpell.uses.cur, 1);
  assert.equal(R.spend(spells, chargeSpell).ok, false);
});

test('короткий отдых восстанавливает ячейки Договора, но не обычные ячейки; долгий отдых — обе группы', () => {
  const sheet = { slots: { 1: { max: 2, used: 1 } }, pact_slots: { level: 2, max: 2, used: 2 }, known: [] };
  const features = [{ uses: { cur: 0, max: 1, recharge: 'short' } }, { uses: { cur: 0, max: 2, recharge: 'long' } }];
  const short = R.restore(sheet, features, 'short');
  assert.deepEqual(plain(short), { slots: 0, pactSlots: 2, features: 1, spellUses: 0 });
  assert.equal(sheet.slots[1].used, 1); assert.equal(sheet.pact_slots.used, 0); assert.equal(features[1].uses.cur, 0);
  const long = R.restore(sheet, features, 'long');
  assert.deepEqual(plain(long), { slots: 1, pactSlots: 0, features: 1, spellUses: 0 });
  assert.equal(sheet.slots[1].used, 0); assert.equal(features[0].uses.cur, 1); assert.equal(features[1].uses.cur, 2);
});

test('кости хитов списываются только в доступном количестве, долгий отдых возвращает до половины общего запаса', () => {
  const counts = { 8: 2, 10: 2 }, used = { 8: 1, 10: 2 };
  const spend = R.spendHitDice(used, counts, 8, 1);
  assert.deepEqual(plain(spend), { ok: true, used: { 8: 2, 10: 2 }, spent: 1 });
  assert.equal(R.spendHitDice(spend.used, counts, 8, 1).ok, false);
  const recovered = R.recoverHitDice(used, counts);
  assert.deepEqual(plain(recovered), { used: { 8: 1, 10: 0 }, recovered: 2 });
  assert.deepEqual(plain(R.recoverHitDice({}, counts)), { used: { 8: 0, 10: 0 }, recovered: 0 });
});

test('заряды заклинаний восстанавливаются по типу отдыха', () => {
  const spells = { slots: {}, known: [
    { uses: { cur: 0, max: 1, recharge: 'short' } },
    { uses: { cur: 0, max: 2, recharge: 'long' } },
    { uses: { cur: 0, max: 3, recharge: 'dawn' } }
  ] };
  R.restore(spells, [], 'short'); assert.deepEqual(plain(spells.known.map(s => s.uses.cur)), [1, 0, 0]);
  R.restore(spells, [], 'long'); assert.deepEqual(plain(spells.known.map(s => s.uses.cur)), [1, 2, 0]);
});

// ---------- сотворение: кто списывает ячейку ----------
test('новая запись без блока расхода: ячейку списывает лист, доступны круги не ниже и ячейки Договора', () => {
  const spells = { slots: { 2: { max: 1, used: 1 }, 3: { max: 1, used: 0 } }, pact_slots: { level: 3, max: 2, used: 1 } };
  const plan = R.castPlan({ level: 3 }, { id: 'p1', trigger: 'use', blocks: [{ kind: 'attack' }, { kind: 'damage', when: 'hit' }] }, spells);
  assert.equal(plan.spend, 'client');
  assert.equal(plan.level, 0);
  assert.deepEqual(plain(plan.options), [
    { pool: 'slots', level: 3, remaining: 1 }, { pool: 'pact_slots', level: 3, remaining: 1 }
  ]);
});

test('старая запись со своим блоком расхода: платит действие, круг один и тот же, двойного расхода нет', () => {
  const spells = { slots: { 3: { max: 2, used: 1 }, 4: { max: 1, used: 0 } }, pact_slots: { level: 3, max: 1, used: 0 } };
  const legacy = { id: 'p1', trigger: 'use', blocks: [{ kind: 'consume', resource: 'slot', slot_level: 3 }, { kind: 'manual', text: 'rule' }] };
  const plan = R.castPlan({ level: 3 }, legacy, spells);
  assert.equal(plan.spend, 'server');
  assert.equal(plan.level, 3);
  assert.deepEqual(plain(plan.options), [{ pool: 'slots', level: 3, remaining: 1 }], 'ячейка Договора и повышенный круг не предлагаются: их граф не спишет');
  assert.equal(R.spend(spells, { level: 3 }, { pool: 'slots', level: 3 }).ok, true);
  assert.equal(spells.slots[3].used, 2);
});

test('«отдельный бросок» и заговор ничего не тратят, заклинание с зарядами списывает заряды', () => {
  const spells = { slots: { 1: { max: 1, used: 0 } } };
  assert.deepEqual(plain(R.castPlan({ level: 1 }, { id: 'p2', name: 'Отдельный бросок: Урон', trigger: 'use', roll_only: true, blocks: [{ kind: 'damage' }] }, spells)),
    { cost: 'slot', spend: 'none', level: 0, options: [] });
  assert.equal(R.castPlan({ level: 0 }, { id: 'p1', trigger: 'use', blocks: [] }, spells).cost, 'free');
  assert.equal(R.castPlan({ level: 0 }, { id: 'p1', trigger: 'use', blocks: [] }, spells).spend, 'none');
  const charged = { level: 1, cast_cost: 'uses', use_cost: 1, uses: { cur: 1, max: 1 } };
  assert.equal(R.castPlan(charged, { id: 'p1', trigger: 'use', blocks: [] }, spells).spend, 'client');
});

test('ритуал добавляется к вариантам расхода, а пустые круги не показываются', () => {
  const spells = { slots: { 1: { max: 1, used: 1 } } };
  const plan = R.castPlan({ level: 1, ritual: true }, { id: 'p1', trigger: 'use', blocks: [] }, spells);
  assert.deepEqual(plain(plan.options), [{ pool: 'ritual', level: 1, remaining: 0 }]);
});

// ---------- сборка действия из старых записей ----------
const legacySpellPrograms = () => ([
  { id: 'p1', name: 'Сотворить (базовый круг)', trigger: 'use', blocks: [
    { id: 'b1', kind: 'consume', resource: 'slot', source: 'self', slot_level: 2, amount: 1, trigger: 'use', when: 'always' },
    { id: 'b2', kind: 'manual', when: 'always', text: 'Выберите существо, которое видите в пределах дистанции. Цель должна преуспеть в спасброске, иначе получит урон и станет ослеплённой. Справочная формула (не автоматический эффект): Урон 1к8' },
    { id: 'b3', kind: 'manual', when: 'always', text: 'Большие круги: урон увеличивается на 1к8 за каждый уровень выше 2-го.' }
  ] },
  { id: 'p2', name: 'Отдельный бросок: Атака заклинанием', trigger: 'use', roll_only: true, blocks: [
    { id: 'b1', kind: 'manual', when: 'always', text: 'Только отдельный бросок кубиков: не тратит ячейку, заряд или действие.' },
    { id: 'b2', kind: 'attack', when: 'always', dice: { count: 1, sides: 20, bonus: 0, stat: 'spell' } }
  ] },
  { id: 'p3', name: 'Отдельный бросок: Урон', trigger: 'use', roll_only: true, blocks: [
    { id: 'b1', kind: 'manual', when: 'always', text: 'Только отдельный бросок кубиков: не тратит ячейку, заряд или действие.' },
    { id: 'b2', kind: 'damage', when: 'always', dice: { count: 1, sides: 8, bonus: 0, stat: '' }, damage_type: 'некротический' }
  ] },
  { id: 'p4', name: 'Отдельный бросок: Спасбросок', trigger: 'use', roll_only: true, blocks: [
    { id: 'b1', kind: 'manual', when: 'always', text: 'Только отдельный бросок кубиков: не тратит ячейку, заряд или действие.' },
    { id: 'b2', kind: 'roll', when: 'always', name: 'Спасбросок', dice: { count: 1, sides: 20, bonus: 0, stat: '' } }
  ] },
  { id: 'p5', name: 'Урон', trigger: 'use', blocks: [
    { id: 'b1', kind: 'manual', when: 'always', text: 'Поздний урон: цель получает 1к6 в начале своего хода.' },
    { id: 'b2', kind: 'damage', when: 'always', dice: { count: 1, sides: 6, bonus: 0, stat: '' }, damage_type: 'огонь' }
  ] }
]);
const spellMeta = { level: 2, desc: 'Выберите существо, которое видите в пределах дистанции. Цель должна преуспеть в спасброске, иначе получит урон и станет ослеплённой.', actions: [{ kind: 'save', roll: '1d20', note: 'СЛ {@dc} МДР' }], saveAbility: 'МДР' };

test('старые «отдельные броски» сворачиваются в действие: атака, урон по попаданию и правило спасброска', () => {
  const out = R.spellPrograms(legacySpellPrograms(), spellMeta);
  assert.equal(out.changed, true);
  assert.equal(out.programs.length, 2, 'действие «Сотворить» и отдельный «Урон» (отложенный, не сворачивается)');
  const [use, extra] = out.programs;
  assert.equal(extra.roll_only, true, 'отдельное действие больше не тратит ячейку');
  assert.deepEqual(plain(use.blocks.map(b => b.kind)), ['manual', 'attack', 'damage', 'manual']);
  assert.match(use.blocks[0].text, /Спасбросок \(МДР\).*не игрок/s);
  assert.equal(use.blocks[1].dice.stat, 'spell');
  assert.equal(use.blocks[2].when, 'hit', 'урон после атаки срабатывает по попаданию');
  assert.equal(use.blocks[2].damage_type, 'некротический');
  assert.match(use.blocks[3].text, /^Большие круги/);
  assert.equal(use.blocks.some(b => b.kind === 'consume'), false, 'ячейку списывает лист: расхода в действии нет');
  assert.equal(use.blocks.some(b => b.kind === 'roll' && b.dice.sides === 20), false, 'игрок не кидает спасбросок цели');
  assert.equal(use.blocks.some(b => b.kind === 'manual' && /Справочная формула/.test(b.text)), false, 'описание записи остаётся описанием');
});

test('урон без атаки бросается всегда, повторные формулы не дублируются, а собранная запись больше не меняется', () => {
  const spellFireball = [{ id: 'p1', name: 'Сотворить (базовый круг)', trigger: 'use', blocks: [
    { id: 'b1', kind: 'consume', resource: 'slot', source: 'self', slot_level: 3, amount: 1, trigger: 'use', when: 'always' },
    { id: 'b2', kind: 'manual', when: 'always', text: 'Яркая вспышка срывается с вашего указательного пальца к выбранной вами точке в пределах дистанции и расцветает взрывом пламени.' }
  ] }];
  const actions = [{ kind: 'damage', roll: '8d6', dtype: 'огонь' }, { kind: 'damage', roll: '8d6', dtype: 'огонь' }, { kind: 'save', roll: '1d20', note: 'СЛ {@dc} ЛОВ' }];
  const meta = { level: 3, desc: 'Яркая вспышка срывается с вашего указательного пальца к выбранной вами точке в пределах дистанции и расцветает взрывом пламени.', actions, saveAbility: 'ЛОВ' };
  const out = R.spellPrograms(spellFireball, meta);
  const blocks = out.programs[0].blocks;
  assert.deepEqual(plain(blocks.map(b => b.kind)), ['manual', 'damage']);
  assert.equal(blocks[1].when, 'always', 'без атаки урон не привязан к попаданию');
  assert.equal(blocks[1].dice.count, 8);
  const again = R.spellPrograms(out.programs, meta);
  assert.equal(again.changed, false, 'собранная запись не пересобирается повторно');
});

test('запись без бросков и без спасброска не трогается, а лишние служебные правила не подтверждаются', () => {
  const plainSpell = [{ id: 'p1', name: 'Сотворить (базовый круг)', trigger: 'use', blocks: [
    { id: 'b1', kind: 'consume', resource: 'slot', slot_level: 1, amount: 1, trigger: 'use', when: 'always' },
    { id: 'b2', kind: 'manual', when: 'always', text: 'Вспышка света.' }
  ] }];
  const out = R.spellPrograms(plainSpell, { level: 1, desc: 'Вспышка света.' });
  assert.deepEqual(plain(out.programs[0].blocks.map(b => b.kind)), ['manual'], 'расход ячейки убран, правило записи осталось');
  assert.equal(out.changed, true);
  assert.equal(R.serviceManual('Только отдельный бросок кубиков: не тратит ячейку, заряд или действие.'), true, 'пояснение кнопки не требует подтверждения');
  assert.equal(R.serviceManual('Спасбросок (МДР): бросает цель или ДМ, а не игрок.'), true, 'правило спасброска показывает окно по своему условию');
  assert.equal(R.serviceManual('Поздний урон: цель получает 1к6 в начале своего хода.'), false, 'решение мастера подтверждается');
});

test('правило спасброска: игрок не кидает бросок, подстановка СЛ из старых записей очищается', () => {
  assert.equal(M.saveRule('СЛ {@dc} МДР'), M.saveRule('МДР'));
  assert.match(M.saveRule('dex'), /Спасбросок \(ЛОВ\)/);
  assert.match(M.saveRule(''), /СЛ = 8 \+ владение/);
  assert.match(M.saveRule('ХАР', [], 'en'), /Saving throw \(CHA\)/);
  assert.match(M.saveRule('ТЕЛ', ['Раздор', 'Боль']), /эффекты: Раздор, Боль/);
  assert.equal(M.isSaveRule(M.saveRule('ЛОВ')), true);
});

test('пересборки копий заклинаний больше нет: v1-механики не принимаются', () => {
  assert.equal(R.legacySpellMechanics, undefined, 'лист больше не пересобирает старые копии');
  assert.equal(M.migrate, undefined);
  assert.match(M.validate({ version: 1, origin: 'spell-v1', programs: legacySpellPrograms() }), /Неподдерживаемая схема механик/);
  assert.deepEqual(plain(M.problems({ version: 1, origin: 'spell-v1', programs: legacySpellPrograms() })), ['Неподдерживаемая схема механик.']);
});

test('все заклинания справочника уже собраны: одно действие, расход на листе, чужого броска нет', () => {
  let spells = 0, notAssembled = [];
  for (const [edition, rows] of Object.entries(seeds)) {
    for (const row of rows) {
      if (row.category !== 'spell') continue;
      spells++;
      const data = row.data;
      const legacy = M.toLegacy(data.mechanics, { level: data.level, edition });
      const meta = { level: data.level, desc: data.desc, actions: data.actions, saveAbility: data.save_ability, lang: 'ru' };
      const out = R.spellPrograms(legacy.programs, meta);
      if (out.changed) notAssembled.push(row.slug);
      const use = out.programs.filter(program => program.trigger === 'use');
      const casting = use.filter(program => !program.roll_only);
      assert.equal(casting.length, 1, `${row.slug}: действий сотворения ${casting.length}`);
      assert.equal(casting[0].blocks.some(block => block.kind === 'consume' && block.resource === 'slot'), false, `${row.slug}: расход ячейки убран`);
      for (const program of use) assert.equal(program.blocks.some(block => block.kind === 'roll' && block.dice && block.dice.sides === 20 && !block.dice.stat && !block.dice.bonus),
        false, `${row.slug}: игроку оставлен бросок спасброска цели`);
      if (data.save_ability) assert.equal(casting[0].blocks.some(block => block.kind === 'manual' && R.serviceManual(block.text)),
        true, `${row.slug}: нет правила «кто кидает спасбросок»`);
      assert.equal(M.validate(data.mechanics), '', `${row.slug}: ${M.validate(data.mechanics)}`);
      assert.deepEqual(plain(M.problems(data.mechanics)), [], `${row.slug}: граф не проходит проверку`);
    }
  }
  assert.equal(spells, 658, 'заклинаний в справочнике');
  assert.deepEqual(notAssembled, [], 'пересборка данных справочника: node tools/srd/migrate_spells_071.cjs');
});
