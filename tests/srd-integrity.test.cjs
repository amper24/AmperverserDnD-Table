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

test('сводка механик (docs/mechanics-migration.json) соответствует данным', () => {
  // Сводку собирает tools/srd/mechanics_summary.cjs; --check ловит забытую пересборку.
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'srd', 'mechanics_summary.cjs'), '--check']).toString();
  assert.match(out, /сводка механик совпадает с данными/);
  const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'mechanics-migration.json'), 'utf8'));
  assert.equal(summary.format, 'v2-graph');
  for (const edition of EDITIONS) {
    const actual = seeds[edition].filter(row => row.data.mechanics);
    assert.equal(summary[edition].mechanics_records, actual.length, `записей с механикой ${edition}`);
    const nodes = actual.reduce((sum, row) => sum + (row.data.mechanics.graph.nodes || []).length, 0);
    assert.equal(summary[edition].nodes, nodes, `узлов ${edition}`);
    const programs = actual.reduce((sum, row) => sum + (row.data.mechanics.graph.nodes || []).filter(n => n.type === 'action.program').length, 0);
    assert.equal(summary[edition].programs, programs, `программ ${edition}`);
  }
});

test('навыки справочника собраны генератором и несут граф владения', () => {
  // data_seed/skills.json собирает tools/srd/build_skills.py; --check ловит забытую пересборку.
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'srd', 'build_skills.py'), '--check'],
    { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }).toString();
  assert.match(out, /актуален \(18 навыков\)/);
  const skills = JSON.parse(fs.readFileSync(path.join(ROOT, 'data_seed', 'skills.json'), 'utf8'));
  assert.equal(skills.length, 18);
  for (const row of skills) {
    const nodes = row.data.mechanics.graph.nodes;
    assert.equal(nodes.length, 1, `${row.name}: один узел`);
    assert.equal(nodes[0].type, 'rule.skill_proficiency', `${row.name}: узел владения навыком`);
  }
});

test('броски монстров и кубики урона заклинаний подтверждаются текстом записи', () => {
  // Бросок обязан быть виден в тексте, из которого он взят: бонус атаки «+9» — в «атака: +9»,
  // кубики «2к8 + 5» — в «14 (2к8 + 5)» описания умения, кубики заклинания — в его описании.
  // Полная сверка (в том числе с официальным английским текстом) — tools/srd/audit_rolls.py.
  // Юникодные тире дампа 2024 («1d4 − 1») приводим к ASCII; «к» — только между цифрами.
  const compact = value => String(value || '').toLowerCase().replace(/[\u2212\u2013\u2014]/g, '-')
    .replace(/\s+/g, '').replace(/(?<=\d)к(?=\d)/g, 'd');
  const textsOf = data => ['traits', 'actions', 'reactions', 'legendary_actions', 'bonus_actions']
    .flatMap(key => data[key] || []).map(item => compact(item.text)).concat([compact(data.desc)])
    .flatMap(text => [text].concat([...text.matchAll(/(?:попадание|hit)[:.]?(\d+)(?!\d)/g)]
      .map(match => match[0])));
  // Производный бросок: текст даёт слагаемое, справочник — итог для базового круга.
  const DERIVED = { 'srd14-magic-missile': '3d4+3' };
  let attacks = 0, damages = 0, dice = 0, itemDice = 0;
  for (const edition of EDITIONS) {
    for (const row of seeds[edition]) {
      const data = row.data, texts = textsOf(data);
      for (const action of data.actions_roll || []) {
        const roll = compact(action.roll);
        if (action.kind === 'attack') {
          const match = /^1d20\+(\d+)$/.exec(roll);
          if (!match) continue;
          attacks++;
          assert.ok(texts.some(text => text.includes('+' + match[1])),
            `${row.slug} ${action.name}: бонус атаки +${match[1]} не найден в тексте записи`);
        }
        if (action.kind === 'damage') {
          // «2к8 + 5» и «1к4 - 1» — кости с модификатором; «1» — плоский урон (барсук):
          // у него сверяется само число после «Попадание:»/«Hit:», иначе подойдёт любая цифра.
          const match = /^(\d+d\d+)([+-]\d+)?$/.exec(roll);
          const flat = /^\d+$/.test(roll);
          if (!match && !flat) continue;
          damages++;
          const forms = match ? [match[1] + (match[2] || '')]      // модификатор обязан быть и в тексте
            : [`попадание:${roll}`, `hit:${roll}`];
          assert.ok(texts.some(text => forms.some(form => text.includes(form))),
            `${row.slug} ${action.name}: формула ${roll} не найдена в тексте записи`);
        }
      }
      if (row.category === 'item') {
        const fields = compact([data.damage, data.damage_type, (data.properties || []).join(' '),
          data.category, data.desc].join(' '));
        for (const node of ((data.mechanics || {}).graph || {}).nodes || []) {
          if (!(node.type === 'action.roll' && node.params.roll_kind === 'damage')) continue;
          const roll = node.params.dice || {};
          if (!roll.count) continue;
          const base = `${roll.count}d${roll.sides}`;
          if (base === '1d20') continue;
          itemDice++;
          const full = base + (roll.bonus ? '+' + roll.bonus : '');
          assert.ok(fields.includes(full) || fields.includes(base),
            `${row.slug} ${node.id}: кубики ${full} не найдены в полях записи`);
          if (data.type === 'weapon' && node.params.damage_type && data.damage_type) {
            assert.strictEqual(node.params.damage_type, data.damage_type,
              `${row.slug} ${node.id}: тип урона узла не совпал с типом оружия`);
          }
        }
        continue;
      }
      if (row.category !== 'spell') continue;
      const description = compact(data.desc);
      for (const node of ((data.mechanics || {}).graph || {}).nodes || []) {
        if (!(node.type === 'action.roll' && ['damage', 'roll'].includes(node.params.roll_kind || 'roll'))) continue;
        const roll = node.params.dice || {};
        if (!roll.count) continue;
        const base = `${roll.count}d${roll.sides}`;
        if (base === '1d20') continue;            // бросок спасброска: в описании его нет
        dice++;
        const full = base + (roll.bonus ? '+' + roll.bonus : '');
        if (DERIVED[row.slug] === full) continue;
        assert.ok(description.includes(full) || description.includes(base),
          `${row.slug} ${node.id}: кубики ${full} не найдены в описании записи`);
      }
    }
  }
  assert.ok(attacks > 900 && damages > 1200 && dice > 150 && itemDice > 80,
    `проверок стало меньше: атак ${attacks}, урона ${damages}, кубиков ${dice}, оружия ${itemDice}`);
});

test('заклинания: спасбросок цели — правило для мастера, а не бросок игрока', () => {
  // 0.7.0 держала на каждый спасбросок отдельную кнопку «Отдельный бросок: Спасбросок» — игрок
  // кидал чужой d20. Теперь характеристика спасброска читается правилом действия «Сотворить»,
  // а ячейку списывает лист (круг, Договор, ритуал) — расхода в графе нет.
  let checked = 0;
  for (const edition of EDITIONS) {
    for (const row of spells(edition)) {
      const data = row.data;
      const nodes = (data.mechanics.graph || {}).nodes || [];
      assert.equal(nodes.some(n => n.type === 'action.program' && String(n.params.name || '').startsWith(SAVE_PROGRAM)),
        false, `${row.slug}: осталась кнопка «${SAVE_PROGRAM}»`);
      assert.equal(nodes.some(n => n.type === 'action.roll' && n.params.dice && n.params.dice.sides === 20
        && !n.params.dice.stat && !n.params.dice.bonus && (n.params.roll_kind || 'roll') === 'roll'),
        false, `${row.slug}: у игрока остался бросок d20 спасброска`);
      assert.equal(nodes.some(n => n.type === 'action.consume' && n.params.resource === 'slot'),
        false, `${row.slug}: расход ячейки в графе спорит с учётом ячеек на листе`);
      const action = (data.actions || []).find(a => a.kind === 'save');
      if (!data.save_ability) {
        assert.ok(!action, `${row.slug}: действие спасброска без save_ability`);
        continue;
      }
      assert.ok(ABILITY_CODES.includes(data.save_ability), `${row.slug}: неизвестная характеристика ${data.save_ability}`);
      assert.ok(action, `${row.slug}: нет действия kind=save`);
      assert.match(action.note, /СЛ (\{\{@dc\}\}|\d+) /, `${row.slug}: подсказка спасброска «${action.note}»`);
      assert.ok(action.note.endsWith(` ${data.save_ability}`), `${row.slug}: подсказка «${action.note}» не совпадает с save_ability`);
      const rules = nodes.filter(n => n.type === 'action.manual' && /бросает цель или ДМ/.test(String(n.params.text || '')));
      assert.ok(rules.length, `${row.slug}: нет правила «кто кидает спасбросок»`);
      assert.ok(rules.some(n => String(n.params.text).includes(`(${data.save_ability})`)),
        `${row.slug}: в правилах нет основной характеристики ${data.save_ability}`);
      checked++;
    }
  }
  assert.ok(checked > 240, `заклинаний со спасброском проверено: ${checked}`);
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
  for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles().map(f => path.relative(ROOT, f).split(path.sep).join('/'))])
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
  const variants = { 'гром': 'звук', 'громовой': 'звук', 'звуковой': 'звук', 'огненный': 'огонь', 'холодный': 'холод', 'кислотный': 'кислота', 'электрический': 'электричество', 'ядовитый': 'яд', 'некротическая энергия': 'некротический' };
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
    'srd14-prismatic-spray': ['ЛОВ', 'ТЕЛ', 'МДР'],
    'srd14-prismatic-wall': ['ЛОВ', 'ТЕЛ', 'МДР'],
    'srd14-sleet-storm': ['ЛОВ', 'ТЕЛ'],
    'srd14-storm-of-vengeance': ['ТЕЛ', 'ЛОВ'],
    'srd14-symbol': ['ТЕЛ', 'МДР', 'ХАР', 'ИНТ'],
    'srd14-wall-of-ice': ['ЛОВ', 'ТЕЛ'],
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

test('заклинания с несколькими спасбросками: у каждой характеристики своё правило для мастера', () => {
  for (const [edition, expected] of Object.entries(MULTI_SAVES)) {
    for (const [slug, abilities] of Object.entries(expected)) {
      const row = seeds[edition].find(r => r.slug === slug);
      assert.ok(row, `${edition}: нет записи ${slug}`);
      const data = row.data;
      const nodes = (data.mechanics.graph || {}).nodes || [];
      const rules = nodes.filter(n => n.type === 'action.manual' && /бросает цель или ДМ/.test(String(n.params.text || '')));
      const found = new Set(rules.flatMap(n => [...String(n.params.text).matchAll(/\((СИЛ|ЛОВ|ТЕЛ|ИНТ|МДР|ХАР)\)/g)].map(m => m[1])));
      assert.deepEqual([...found].sort(), [...new Set(abilities)].sort(),
        `${slug}: характеристики правил спасброска`);
      // Эффекты не смешались между характеристиками: у каждого правила свой перечень.
      const labeled = new Map(rules.map(n => {
        const m = String(n.params.text).match(/эффекты: ([^:]+):/);
        return [String(n.params.text).match(/\((СИЛ|ЛОВ|ТЕЛ|ИНТ|МДР|ХАР)\)/)[1], m ? m[1] : ''];
      }));
      const labels = [...labeled.values()].filter(Boolean).flatMap(v => v.split(', '));
      assert.equal(new Set(labels).size, labels.length, `${slug}: эффект попал в два правила: ${labels.join(', ')}`);
      // Основной спасбросок записи идёт первым: правило читается сверху вниз.
      assert.ok(String(rules[0].params.text).includes(`(${data.save_ability})`),
        `${slug}: первое правило — не основной спасбросок ${data.save_ability}`);
      // Метаданные записи остались: подсказки действий и английский слой не переписывались.
      const saves = (data.actions || []).filter(a => a.kind === 'save');
      assert.deepEqual([...new Set(saves.map(a => a.note.split(' ').at(-1)))].sort(), [...new Set(abilities)].sort(),
        `${slug}: характеристики действий записи`);
      const en = (data.i18n || {}).en || {};
      const enRules = ((en.mechanics || {}).graph || {}).nodes || [];
      assert.equal(enRules.filter(n => /the target or the GM rolls it/.test(String((n.params || {}).text || ''))).length,
        rules.length, `${slug}: английских правил спасброска ${enRules.length} против русских ${rules.length}`);
      const ABILITY_EN = { 'СИЛ': 'STR', 'ЛОВ': 'DEX', 'ТЕЛ': 'CON', 'ИНТ': 'INT', 'МДР': 'WIS', 'ХАР': 'CHA' };
      const enFound = new Set(enRules.flatMap(n => [...String((n.params || {}).text || '').matchAll(/\((STR|DEX|CON|INT|WIS|CHA)\)/g)].map(m => m[1])));
      assert.deepEqual([...enFound].sort(), [...new Set(abilities.map(a => ABILITY_EN[a]))].sort(),
        `${slug}: характеристики правил в английском слое`);
    }
  }
});

// Тип урона в справочнике называется по словарю листа: «звук» (thunder). Перевод «гром»/«громовой»
// остаётся только в именах («Волна грома», «Громовой удар», свойства посоха) и явлениях
// («гремит гром»): по именам идут кросс-ссылки, а явление — не тип урона.
test('тип урона в текстах назван по словарю листа, а имена и явления не тронуты', () => {
  const data = (edition, slug) => {
    const row = seeds[edition].find(r => r.slug === slug);
    assert.ok(row, `${edition}: нет записи ${slug}`);
    return row.data;
  };
  // Проза, таблицы «Тип урона» и поля защит читаются по словарю листа.
  assert.match(data('2014', 'srd14-androsphinx').actions[2].text, /урона Звуком/);
  assert.match(data('2024', 'srd24-air-elemental').actions[1].text, /Звукового урона/);
  assert.match(data('2014', 'srd14-armor-of-resistance').desc, /\|\s*10\s*\|\s*Звук\s*\|/);
  assert.match(data('2014', 'srd14-ring-of-resistance').desc, /\|\s*10\s*\|\s*Звук\s*\|\s*Шпинель/);
  assert.match(data('2014', 'srd14-ghost').resistances, /Звук/);
  assert.match(data('2024', 'srd24-ghost').resistances, /Звуковой/);
  assert.match(data('2024', 'srd24-horn-of-blasting').desc, /Звукового урона/);
  assert.match(data('2014', 'srd14-shatter').desc, /урона звуком/);
  // Машинные поля типов урона знают только словарь листа.
  const walk = (node, path, bad) => {
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`, bad));
    else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key, bad);
    else if (typeof node === 'string' && /(damage_type|dtype|damage)$/.test(path) && /гром/i.test(node)) bad.push(`${path}=«${node}»`);
  };
  for (const edition of EDITIONS) {
    for (const row of seeds[edition]) {
      const bad = [];
      walk(row.data, '', bad);
      assert.deepEqual(bad, [], `${row.slug}: тип урона назван «громом» в машинном поле`);
    }
  }
  // Имена действий не переименованы: на них ссылаются броски и узлы графа.
  const air = data('2024', 'srd24-air-elemental');
  const name = air.actions[1].name;
  assert.equal(name, 'Громовой удар', 'имя действия-атаки элементаля воздуха');
  assert.ok(air.actions_roll.some(r => String(r.name).startsWith(name)), 'выпадающий бросок ссылается на имя действия');
  assert.ok((air.mechanics.graph.nodes || []).some(n => n.params.feature_name === name), 'узел графа ссылается на имя действия');
  const giant = data('2024', 'srd24-cloud-giant');
  assert.equal(giant.actions[1].name, 'Громовая булава', 'имя действия великана');
  assert.ok(giant.actions_roll.some(r => String(r.name).startsWith(giant.actions[1].name)), 'бросок великана ссылается на имя действия');
  assert.ok((giant.mechanics.graph.nodes || []).some(n => n.params.feature_name === giant.actions[1].name), 'узел графа великана ссылается на имя действия');
  // Явления и названия свойств предметов остаются как были — это не тип урона.
  assert.match(data('2014', 'srd14-storm-of-vengeance').desc, /гремит гром/);
  assert.match(data('2024', 'srd24-thunderwave').desc, /волну громовой энергии/);
  assert.match(data('2014', 'srd14-staff-of-thunder-and-lightning').desc, /Раскат грома/);
  assert.match(data('2014', 'srd14-staff-of-thunder-and-lightning').desc, /(?:^|\n)Гром\./, 'свойство посоха «Гром» осталось названием');
  assert.match(data('2014', 'srd14-wizard').subclasses.map(s => s.desc).join(' '), /раскатистый гром/);
  assert.match(data('2014', 'srd14-lich').traits.map(t => t.text).join(' '), /Волна грома/, 'название заклинания в списке не переименовано');
  assert.match(data('2014', 'srd14-staff-of-thunder-and-lightning').desc, /Гром и молния/);
  // Английское зеркало подтверждает термин: правка без подтверждения не делается.
  assert.match(data('2024', 'srd24-air-elemental').i18n.en['actions!'][1].text, /Thunder damage/);
  // Проза: старой формулировки типа урона не осталось ни в одной записи обеих редакций.
  // Ищем ровно те обороты, которые правил инструмент: «урона громом», «Громового урона»,
  // ячейку таблицы «Тип урона», выбор типа в «Радужных брызгах», иммунитет к «Грому».
  const drift = [/урон[а-яё]*\s+громом/i, /[Гг]ромов[а-яё]*\s+урон/i, /\|\s*10\s*\|\s*Гром\s*\|/,
    /яд или гром/i, /иммунитет[а-яё]*\s+к\s+грому/i, /сопротивлени[а-яё]*\s+к?\s*грому/i];
  const proseOf = data => {
    const texts = [data.desc, data.resistances, data.vulnerabilities, data.immunities];
    for (const key of ['traits', 'actions', 'reactions', 'legendary_actions'])
      for (const item of data[key] || []) texts.push(item.text);
    for (const item of data.subclasses || []) texts.push(item.desc);
    for (const node of ((data.mechanics || {}).graph || {}).nodes || []) texts.push(node.params.text);
    return texts.filter(text => typeof text === 'string');
  };
  for (const edition of EDITIONS) {
    for (const row of seeds[edition]) {
      for (const text of proseOf(row.data)) {
        for (const pattern of drift)
          assert.ok(!pattern.test(text), `${row.slug}: тип урона снова назван «громом» (${pattern})`);
      }
    }
  }
});
