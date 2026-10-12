// Целостность справочника SRD обеих редакций.
// Проверку выполняет tools/srd/integrity.cjs (тот же код — в CI и вручную), а тесты фиксируют
// её результат и дополнительно проверяют то, что важно для правил: спасброски заклинаний,
// словарь навыков листа и полноту английского слоя.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const dictionaries = require('./fixtures/dictionaries.cjs')();
const load = edition => JSON.parse(fs.readFileSync(path.join(ROOT, 'data_seed', `srd_${edition}.json`), 'utf8'));
const EDITIONS = ['2014', '2024'];
const SAVE_PROGRAM = 'Отдельный бросок: Спасбросок';
const ABILITY_CODES = ['СИЛ', 'ЛОВ', 'ТЕЛ', 'ИНТ', 'МДР', 'ХАР'];

const seeds = Object.fromEntries(EDITIONS.map(edition => [edition, load(edition)]));
const spells = edition => seeds[edition].filter(row => row.category === 'spell');
const rus = value => /[\u0400-\u04FF]/.test(String(value));

test('справочник SRD: у проверки целостности нет ошибок', () => {
  const raw = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'srd', 'integrity.cjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const report = JSON.parse(raw);
  const problems = [];
  for (const [name, block] of Object.entries(report)) {
    for (const issue of block.issues) if (issue.level === 'error') problems.push(`${name}: ${issue.check} ${issue.entity} ${issue.field || ''} — ${issue.message}`);
  }
  assert.deepEqual(problems, [], 'ошибки целостности:\n' + problems.join('\n'));
  for (const edition of EDITIONS) {
    assert.equal(report[edition].stats.records, seeds[edition].length, `записей ${edition}`);
    assert.equal(report[edition].stats.i18n.dangling_keys, 0, `висячих ключей перевода ${edition}`);
    assert.equal(report[edition].stats.i18n.cyrillic_in_en, 0, `русский текст в английском слое ${edition}`);
  }
});

test('заклинания: у спасброска есть характеристика, действие и программа в обеих редакциях', () => {
  for (const edition of EDITIONS) {
    for (const row of spells(edition)) {
      const data = row.data;
      const action = (data.actions || []).find(a => a.kind === 'save');
      const program = (data.mechanics.graph.nodes || []).find(n => n.type === 'action.program' && n.params.name === SAVE_PROGRAM);
      if (!data.save_ability) {
        assert.ok(!action, `${row.slug}: действие спасброска без save_ability`);
        continue;
      }
      assert.ok(ABILITY_CODES.includes(data.save_ability), `${row.slug}: неизвестная характеристика ${data.save_ability}`);
      assert.ok(action, `${row.slug}: нет действия kind=save`);
      assert.match(action.note, /СЛ (\{\{@dc\}\}|\d+) /, `${row.slug}: подсказка спасброска «${action.note}»`);
      assert.ok(action.note.endsWith(` ${data.save_ability}`), `${row.slug}: подсказка «${action.note}» не совпадает с save_ability`);
      assert.ok(program, `${row.slug}: нет программы «${SAVE_PROGRAM}»`);
      assert.equal(program.params.roll_only, true, `${row.slug}: программа спасброска не помечена roll_only`);
      const suffix = program.id.replace('program-', '');
      const roll = (data.mechanics.graph.nodes || []).find(n => n.type === 'action.roll' && n.id === `action-${suffix}-2`);
      assert.ok(roll, `${row.slug}: в программе спасброска нет узла броска`);
    }
  }
});

test('заклинания: английский слой действий не отстаёт от базового', () => {
  for (const edition of EDITIONS) {
    for (const row of spells(edition)) {
      const actions = row.data.actions || [];
      const en = (row.data.i18n.en || {})['actions!'];
      if (!actions.length) continue;
      assert.ok(Array.isArray(en), `${row.slug}: нет i18n.en.actions!`);
      assert.equal(en.length, actions.length, `${row.slug}: английских действий ${en.length} против ${actions.length}`);
      for (const [index, action] of actions.entries()) {
        const mirror = en[index];
        assert.equal(mirror.kind, action.kind, `${row.slug}: вид действия ${index}`);
        assert.equal(mirror.roll, action.roll, `${row.slug}: формула действия ${index}`);
        if (action.dtype) assert.ok(!rus(mirror.dtype), `${row.slug}: тип урона «${mirror.dtype}» не переведён`);
      }
    }
  }
});

test('классы: названия навыков берутся из словаря листа', () => {
  const names = new Set(dictionaries.SKILLS.map(([, label]) => label));
  for (const edition of EDITIONS) {
    for (const row of seeds[edition].filter(r => r.category === 'class')) {
      for (const skill of row.data.skills.from) {
        assert.ok(names.has(skill), `${row.slug}: навык «${skill}» отсутствует в window.SKILLS`);
      }
    }
    for (const row of spells(edition)) {
      assert.ok(!JSON.stringify(row.data).includes('Анализ'), `${row.slug}: в данных осталось старое название навыка «Анализ»`);
    }
  }
});

test('механики: используются только узлы, известные реестру клиента, и id узлов уникальны', () => {
  const ctx = { window: {}, console, crypto: require('node:crypto').webcrypto };
  vm.createContext(ctx);
  // Реестр узлов собирается из видов действий mechanics.js — грузим в том же порядке, что и страница.
  for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  const known = new Set(Object.keys(ctx.window.NodeRegistry.NODE_DEFS));
  for (const edition of EDITIONS) {
    for (const row of seeds[edition]) {
      const graph = row.data.mechanics && row.data.mechanics.graph;
      if (!graph) continue;
      const ids = new Set();
      for (const node of graph.nodes) {
        assert.ok(!ids.has(node.id), `${row.slug}: повторяется id узла ${node.id}`);
        ids.add(node.id);
        assert.ok(known.has(node.type), `${row.slug}: тип узла «${node.type}» неизвестен реестру клиента`);
      }
      for (const link of graph.links || []) {
        assert.ok(ids.has(link.from.node), `${row.slug}: связь из неизвестного узла ${link.from.node}`);
        assert.ok(ids.has(link.to.node), `${row.slug}: связь в неизвестный узел ${link.to.node}`);
      }
    }
  }
});

test('защиты монстров: термины приведены к словарю листа, состояния не в поле урона', () => {
  // Регрессия по исправленным записям: до этой работы в русских полях стояли чужие термины
  // («Холод» вместо «Кислота» у куба и мимика, «Гром»/«Громовой» вместо «Звук»), терялся «Огонь»
  // у демонов 2014, у оборотней был лишний «Холод», а у голема из плоти — название умения.
  const monster = (edition, slug) => seeds[edition].find(row => row.category === 'monster' && row.slug === slug).data;
  assert.equal(monster('2014', 'srd14-gelatinous-cube').immunities, '', 'https://www.aidedd.org — у куба 2014 иммунитета к урону нет');
  assert.equal(monster('2014', 'srd14-mimic').immunities, 'Кислота');
  assert.equal(monster('2024', 'srd24-gelatinous-cube').immunities, 'Кислота');
  assert.equal(monster('2024', 'srd24-mimic').immunities, 'Кислота');
  assert.equal(monster('2024', 'srd24-vampire-vampire').resistances, 'Некротический');
  assert.equal(monster('2024', 'srd24-flesh-golem').immunities, 'Электричество, Яд');
  assert.equal(monster('2024', 'srd24-ice-devil').immunities, 'Холодный, Огненный, Ядовитый',
    '«Отравленный» — состояние, его место в condition_immunities');
  assert.equal(monster('2024', 'srd24-clay-golem').immunities, 'Кислота, Яд, Психический');
  assert.ok(monster('2014', 'srd14-glabrezu').resistances.startsWith('Холод, Огонь, Электричество'));
  assert.ok(!monster('2014', 'srd14-androsphinx').immunities.includes('Яд'));
  assert.ok(!monster('2014', 'srd14-werewolf-hybrid').immunities.includes('Холод'));
  // общий инвариант: у каждой записи с текстом в русском поле есть тот же набор в английском слое
  const ruDamage = { 'кислота': 'acid', 'дробящий': 'bludgeoning', 'холод': 'cold', 'огонь': 'fire', 'силовое поле': 'force', 'электричество': 'lightning', 'некротический': 'necrotic', 'колющий': 'piercing', 'яд': 'poison', 'психический': 'psychic', 'излучение': 'radiant', 'рубящий': 'slashing', 'звук': 'thunder' };
  const variants = { 'гром': 'звук', 'громовой': 'звук', 'огненный': 'огонь', 'холодный': 'холод', 'кислотный': 'кислота', 'электрический': 'электричество', 'ядовитый': 'яд', 'некротическая энергия': 'некротический' };
  const keysRu = text => new Set([...Object.keys(ruDamage), ...Object.keys(variants)]
    .filter(term => new RegExp(`(^|[^а-яё])${term}([^а-яё]|$)`, 'i').test(String(text).toLowerCase()))
    .map(term => ruDamage[variants[term] || term]));
  const keysEn = text => new Set(Object.values(ruDamage)
    .filter(en => new RegExp(`(^|[^a-z])${en}([^a-z]|$)`).test(String(text).toLowerCase())));
  for (const edition of EDITIONS) {
    for (const row of seeds[edition].filter(r => r.category === 'monster')) {
      const en = (row.data.i18n || {}).en || {};
      for (const field of ['vulnerabilities', 'resistances', 'immunities']) {
        const ru = keysRu(row.data[field] || ''), e = keysEn(en[field] || '');
        assert.deepEqual([...ru].sort(), [...e].sort(), `${row.slug}: наборы типов урона в data.${field} и data.i18n.en.${field} разошлись`);
      }
    }
  }
});

// Заклинания с разными спасбросками для разных эффектов («Символ», «Радужная стена», «Землетрясение»):
// у каждого спасброска своё действие и своя программа, а data.save_ability — основной (первый) спасбросок.
const MULTI_SAVES = {
  '2014': {
    'srd14-earthquake': ['ЛОВ', 'ТЕЛ'],
    'srd14-prismatic-wall': ['ЛОВ', 'ТЕЛ', 'МДР'],
    'srd14-symbol': ['ТЕЛ', 'МДР', 'ХАР', 'ИНТ'],
  },
  '2024': {
    'srd24-arcane-hand': ['СИЛ', 'ЛОВ'],
    'srd24-prismatic-spray': ['ЛОВ', 'ТЕЛ', 'МДР'],
    'srd24-prismatic-wall': ['ЛОВ', 'ТЕЛ', 'МДР'],
    'srd24-storm-of-vengeance': ['ЛОВ', 'ТЕЛ'],
    'srd24-symbol': ['ТЕЛ', 'МДР'],
    'srd24-wall-of-ice': ['ЛОВ', 'ТЕЛ'],
  },
};
const ABILITY_EN = { 'СИЛ': 'STR', 'ЛОВ': 'DEX', 'ТЕЛ': 'CON', 'ИНТ': 'INT', 'МДР': 'WIS', 'ХАР': 'CHA' };

test('заклинания с несколькими спасбросками: у каждого своё действие, программа и характеристика', () => {
  const checked = [];
  for (const edition of EDITIONS) {
    for (const row of spells(edition)) {
      const data = row.data;
      const saves = (data.actions || []).filter(a => a.kind === 'save');
      if (saves.length < 2) continue;
      checked.push(row.slug);
      const ids = new Set(), names = new Set();
      for (const action of saves) {
        const ability = action.note.split(' ').at(-1);
        assert.ok(ABILITY_CODES.includes(ability), `${row.slug}: подсказка «${action.note}» без характеристики`);
        assert.match(action.note, /СЛ (\{\{@dc\}\}|\d+) /, `${row.slug}: подсказка спасброска «${action.note}»`);
        assert.ok(!names.has(action.name), `${row.slug}: два действия спасброска с именем «${action.name}»`);
        names.add(action.name);
        const label = action.name === 'Спасбросок' ? '' : action.name.replace('Спасбросок: ', '');
        const programName = label ? `${SAVE_PROGRAM}: ${label}` : SAVE_PROGRAM;
        const program = (data.mechanics.graph.nodes || []).find(n => n.type === 'action.program' && n.params.name === programName);
        assert.ok(program, `${row.slug}: нет программы «${programName}»`);
        assert.equal(program.params.roll_only, true, `${row.slug}: программа «${programName}» не помечена roll_only`);
        const suffix = program.id.replace('program-', '');
        assert.ok(!ids.has(suffix), `${row.slug}: программы спасбросков делят id узла ${program.id}`);
        ids.add(suffix);
        const roll = (data.mechanics.graph.nodes || []).find(n => n.type === 'action.roll' && n.id === `action-${suffix}-2`);
        assert.ok(roll, `${row.slug}: в программе «${programName}» нет узла броска`);
      }
      // основной спасбросок (data.save_ability) — действие «Спасбросок» без метки эффекта
      const primary = saves.find(a => a.name === 'Спасбросок');
      assert.ok(primary, `${row.slug}: нет основного действия «Спасбросок»`);
      assert.ok(primary.note.endsWith(` ${data.save_ability}`), `${row.slug}: data.save_ability=${data.save_ability}, а основной спасбросок «${primary.note}»`);
      // английское зеркало: столько же действий и те же характеристики
      const en = (data.i18n || {}).en || {};
      const enActions = en['actions!'] || [];
      assert.equal(enActions.length, (data.actions || []).length, `${row.slug}: английских действий ${enActions.length}, русских ${(data.actions || []).length}`);
      const enSaves = enActions.filter(a => a.kind === 'save');
      assert.equal(enSaves.length, saves.length, `${row.slug}: спасбросков в английском слое ${enSaves.length}, в русском ${saves.length}`);
      for (let i = 0; i < enSaves.length; i++) {
        const ruAbility = saves[i].note.split(' ').at(-1), enAbility = enSaves[i].note.split(' ').at(-1);
        assert.equal(enAbility, ABILITY_EN[ruAbility], `${row.slug}: в английском слое «${enSaves[i].note}» вместо ${ABILITY_EN[ruAbility]}`);
      }
    }
  }
  assert.deepEqual(checked.sort(), Object.values(MULTI_SAVES).flatMap(Object.keys).sort(),
    'набор заклинаний с несколькими спасбросками изменился — сверьте с официальным SRD');
});

test('заклинания с несколькими спасбросками: набор характеристик совпадает с официальным текстом', () => {
  for (const [edition, expected] of Object.entries(MULTI_SAVES)) {
    for (const [slug, abilities] of Object.entries(expected)) {
      const row = seeds[edition].find(r => r.slug === slug);
      assert.ok(row, `${edition}: нет записи ${slug}`);
      const saves = (row.data.actions || []).filter(a => a.kind === 'save');
      const got = [...new Set(saves.map(a => a.note.split(' ').at(-1)))].sort();
      assert.deepEqual(got, [...new Set(abilities)].sort(), `${slug}: характеристики спасбросков`);
    }
  }
  // редакции не смешиваются: у «Символа» 2014 шесть разных эффектов, у 2024 — пять
  const count = (edition, slug) => seeds[edition].find(r => r.slug === slug).data.actions.filter(a => a.kind === 'save').length;
  assert.equal(count('2014', 'srd14-symbol'), 8, '2014 «Символ»: Смерть, Раздор, Страх, Безнадёжность, Безумие, Боль, Сон, Ошеломление');
  assert.equal(count('2024', 'srd24-symbol'), 6, '2024 «Символ»: Смерть, Раздор, Страх, Боль, Сон, Ошеломление');
});
