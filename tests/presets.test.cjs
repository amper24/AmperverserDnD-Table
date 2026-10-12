const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPresets } = require('../tools/presets/node-loader.cjs');
const plain = v => JSON.parse(JSON.stringify(v)); // массивы из vm-контекста не равны литералам напрямую

// Реестр наборов данных: встроенные наборы с диска, проверка формы, пользовательские наборы без правки кода.
function memoryStorage() {
  const store = new Map();
  return { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}
async function fresh() {
  const ctx = { console, localStorage: memoryStorage() };
  const P = await loadPresets(ctx);
  return P;
}
const starter = (id, extra = {}) => ({ id, name: 'Тест ' + id, hint: 'подсказка', nodes: [{ key: 'lvl', type: 'condition.level', params: { min: 2, max: 20 }, x: 0, y: 0 }], links: [], ...extra });
const set = (items, extra = {}) => ({ kind: 'graph_starter', id: 'user.' + Math.random().toString(36).slice(2), name: 'Мой набор', items, ...extra });

test('встроенные наборы загружаются с диска по index.json', async () => {
  const P = await fresh();
  assert.equal(P.loaded, true);
  assert.equal(P.items('graph_starter').length, 5);
  assert.deepEqual(plain(P.items('item_preset').map(i => i.id)), ['weapon', 'armor', 'consumable', 'magic', 'gear', 'blank']);
  assert.deepEqual(plain(P.items('spell_preset').map(i => i.id)), ['cantrip', 'spell1', 'spell3', 'ritual', 'blank']);
  for (const ed of ['2014', '2024']) {
    assert.equal(P.items('class_progression', ed).length, 12, `12 классов ${ed}`);
    assert.ok(P.multiclassSlots(ed).levels['20'].slots, `ячейки мультикласса ${ed}`);
  }
});

test('каждый файл из index.json существует, и никаких наборов вне реестра нет', () => {
  const index = JSON.parse(fs.readFileSync('static/presets/index.json', 'utf8'));
  for (const f of index.sets) assert.ok(fs.existsSync(path.join('static/presets', f)), f);
  const onDisk = fs.readdirSync('static/presets').filter(f => f.endsWith('.json') && f !== 'index.json');
  assert.deepEqual(onDisk.sort(), [...index.sets].sort(), 'все JSON-наборы подключены в index.json');
  assert.equal(fs.existsSync('static/presets-data.js'), false, 'старый файл с данными удалён');
  assert.equal(fs.existsSync('static/class-progression.js'), false, 'старый файл таблиц удалён');
});

test('проверка отбрасывает неверные наборы с понятной причиной', async () => {
  const P = await fresh();
  assert.match(P.problemOf({ kind: 'nope', id: 'x', name: 'x', items: [] }), /неизвестный вид/);
  assert.match(P.problemOf(set([starter('a')], { id: '' })), /нужен id/);
  assert.match(P.problemOf(set([starter('a'), starter('a')])), /повтор элемента «a»/);
  assert.match(P.problemOf(set([{ id: 'a', name: 'x' }])), /нет поля «nodes»/);
  assert.match(P.problemOf(set([starter('a', { links: [['lvl', 'value', 'missing', 'enabled']] })])), /неизвестный узел/);
  assert.match(P.problemOf(set([starter('a', { links: [['lvl', 'value']] })])), /четыре значения/);
  assert.match(P.problemOf({ kind: 'class_progression', id: 'c', name: 'Класс', items: [{ id: 'x', table: {} }] }), /укажите редакцию/);
  assert.equal(P.problemOf(set([starter('a')])), '');
});

test('свой стартовый граф импортируется и появляется в списке без правки кода', async () => {
  const P = await fresh();
  const before = P.items('graph_starter').length;
  const ids = P.importUser(JSON.stringify(set([starter('my-level')])));
  assert.equal(ids.length, 1);
  assert.equal(P.items('graph_starter').length, before + 1);
  assert.equal(P.item('graph_starter', 'my-level').name, 'Тест my-level');
});

test('пользовательские наборы сохраняются в браузере и удаляются', async () => {
  const storage = memoryStorage();
  const ctx = { console, localStorage: storage };
  const P = await loadPresets(ctx);
  P.importUser(set([starter('kept')], { id: 'user.kept' }));
  const again = await loadPresets({ console, localStorage: storage });
  assert.ok(again.item('graph_starter', 'kept'), 'после перезагрузки набор на месте');
  again.removeUser('user.kept');
  assert.equal((await loadPresets({ console, localStorage: storage })).item('graph_starter', 'kept'), null);
});

test('свой набор таблицы развития для своего класса работает по редакции и slug', async () => {
  const P = await fresh();
  P.importUser({ kind: 'class_progression', id: 'user.artificer', name: 'Изобретатель', edition: '2014',
    items: [{ id: 'artificer', table: { columns: [], levels: { 1: { pb: 2 } } } }] });
  assert.deepEqual(plain(P.classProgression('2014', 'artificer')), { columns: [], levels: { 1: { pb: 2 } } });
  assert.equal(P.classProgression('2024', 'artificer'), null, 'редакция 2024 не затронута');
});

test('импорт не перекрывает встроенный набор и не принимает неверный файл', async () => {
  const P = await fresh();
  assert.throws(() => P.importUser(set([starter('x')], { id: 'builtin.graph-starters' })), /занят встроенным/);
  assert.throws(() => P.importUser('{"kind":"graph_starter"}'), /нужен id/);
  assert.equal(P.userSets().length, 0, 'ничего не сохранилось');
});

test('элемент пользовательского набора перекрывает встроенный с тем же id', async () => {
  const P = await fresh();
  P.importUser(set([{ id: 'speed-level', name: 'Свой вариант', hint: '', nodes: [], links: [] }]));
  assert.equal(P.item('graph_starter', 'speed-level').name, 'Свой вариант');
  assert.equal(P.items('graph_starter').filter(i => i.id === 'speed-level').length, 1, 'без дублей в списке');
});
