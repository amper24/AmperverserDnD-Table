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
