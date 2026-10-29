// Шаблоны и данные: каждый пресет собирается и исполняется, каждая программа заканчивается «Концом».
// Проверяются оба формата шаблонов: полные графы (mechanic_templates) и вставляемые цепочки (graph_starter).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, crypto: require('node:crypto').webcrypto, console };
ctx.window.SKILLS = [];
vm.createContext(ctx);
for (const file of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../tools/nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
}
const M = ctx.window.Mechanics;
const R = ctx.window.NodeRegistry;
const plain = value => JSON.parse(JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// Потоки узла: flow-выходы по определению реестра графа (exec, then/else).
const flowOutputs = type => {
  const def = R.nodeDef(type);
  return Object.entries(def?.outputs || {}).filter(([, socket]) => socket === 'flow').map(([socket]) => socket);
};
const flowInputs = type => {
  const def = R.nodeDef(type);
  return Object.entries(def?.inputs || {}).filter(([, socket]) => socket === 'flow').map(([socket]) => socket);
};

function endsReached(graph, programId) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const outgoing = new Map();
  for (const link of graph.links || []) {
    if (!flowOutputs(byId.get(link.from.node)?.type).includes(link.from.socket)) continue;
    if (!flowInputs(byId.get(link.to.node)?.type).includes(link.to.socket)) continue;
    const key = `${link.from.node}:${link.from.socket}`;
    if (!outgoing.has(key)) outgoing.set(key, []);
    outgoing.get(key).push(link.to.node);
  }
  const queue = [programId], seen = new Set(queue);
  let ends = 0;
  while (queue.length) {
    const id = queue.shift(), node = byId.get(id);
    if (!node) continue;
    if (node.type === 'flow.end') { ends++; continue; }
    for (const socket of flowOutputs(node.type)) {
      for (const target of outgoing.get(`${id}:${socket}`) || []) if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return ends;
}

function danglingFlowOutputs(graph) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const linked = new Set((graph.links || []).map(link => `${link.from.node}:${link.from.socket}`));
  return graph.nodes.filter(node => flowOutputs(node.type).some(socket => !linked.has(`${node.id}:${socket}`)));
}

test('mechanic templates are executable v3 graphs with a completed flow and no dangling exec', () => {
  const templates = read('static/presets/mechanic-templates.json');
  assert.equal(templates.items.length, 40, `шаблонов ${templates.items.length}`);
  for (const item of templates.items) {
    const graph = item.table.graph;
    const mechanics = { version: 2, origin: item.table.origin || 'template', graph };
    assert.ok(graph.nodes.some(node => node.type === 'action.program'), `${item.id}: есть «Начало»`);
    const ends = graph.nodes.filter(node => node.type === 'flow.end');
    assert.ok(ends.length >= 1, `${item.id}: есть «Конец»`);
    assert.equal(M.validate(mechanics), '', `${item.id}: сохранение`);
    assert.deepEqual(plain(M.problems(mechanics)), [], `${item.id}: исполняется`);
    for (const program of graph.nodes.filter(node => node.type === 'action.program')) {
      assert.ok(endsReached(graph, program.id) > 0, `${item.id}: программа завершается «Концом»`);
    }
    assert.deepEqual(danglingFlowOutputs(graph), [], `${item.id}: нет висячих exec-выходов`);
    const built = M.toLegacy(mechanics).programs[0];
    assert.ok(built && built.blocks.length > 0, `${item.id}: шаблон даёт блоки`);
  }
});

test('eight new templates cover the requested mechanics', () => {
  const ids = new Set(read('static/presets/mechanic-templates.json').items.map(item => item.id));
  for (const id of ['attack_damage_result', 'heal_when_hurt', 'save_dc_damage', 'multiattack_two', 'staff_charges', 'smite_extra', 'aura_buff', 'sneak_attack']) {
    assert.ok(ids.has(id), id);
  }
});

test('creation starters are executable v3 graphs with a completed flow', () => {
  const starters = read('static/presets/mechanic-starters.json');
  assert.equal(starters.items.length, 3, 'раса, класс и предыстория');
  for (const item of starters.items) {
    const mechanics = item.table;
    assert.equal(M.validate(mechanics), '', `${item.id}: сохранение`);
    assert.deepEqual(plain(M.problems(mechanics)), [], `${item.id}: исполняется`);
    for (const program of mechanics.graph.nodes.filter(node => node.type === 'action.program')) {
      assert.ok(endsReached(mechanics.graph, program.id) > 0, `${item.id}: программа завершается «Концом»`);
    }
    assert.deepEqual(danglingFlowOutputs(mechanics.graph), [], `${item.id}: нет висячих exec-выходов`);
  }
});

// Повторяет attach в editor.insertStarter: пустое действие (Начало → Конец), затем цепочка встаёт между ними.
function attachStarter(item) {
  const program = { id: 'p', type: 'action.program', params: { program_id: 'prog', name: 'Проверка', trigger: 'use' } };
  const end = { id: 'e', type: 'flow.end', params: {} };
  const graph = { nodes: [program, end], links: [{ from: { node: 'p', socket: 'exec' }, to: { node: 'e', socket: 'exec' } }], frames: [], groups: [] };
  const ids = new Map();
  item.nodes.forEach((node, index) => {
    const id = `n${index}`;
    ids.set(node.key, id);
    const params = { ...plain(R.nodeDef(node.type)?.defaults || {}), ...plain(node.params || {}) };
    if (node.type.startsWith('action.') && node.type !== 'action.program') params.block_id = `b${index}`;
    graph.nodes.push({ id, type: node.type, params, position: { x: node.x, y: node.y } });
  });
  for (const [from, fromSocket, to, toSocket] of item.links) graph.links.push({ from: { node: ids.get(from), socket: fromSocket }, to: { node: ids.get(to), socket: toSocket } });
  const head = item.nodes.find(node => !item.links.some(([, , to, into]) => to === node.key && into === 'exec'));
  const direct = graph.links.find(link => link.from.node === 'p' && link.from.socket === 'exec' && link.to.node === 'e');
  if (item.attach && head && (flowInputs(head.type) || []).includes('exec')) {
    const hasChain = graph.links.some(link => link.from.node === 'p' && link.from.socket === 'exec' && link.to.node !== 'e');
    if (!hasChain) {
      if (direct) graph.links = graph.links.filter(link => link !== direct);
      graph.links.push({ from: { node: 'p', socket: 'exec' }, to: { node: ids.get(head.key), socket: 'exec' } });
      if (direct) {
        for (const id of ids.values()) {
          const node = graph.nodes.find(item => item.id === id);
          for (const socket of flowOutputs(node.type)) {
            if (graph.links.some(link => link.from.node === id && link.from.socket === socket)) continue;
            graph.links.push({ from: { node: id, socket }, to: { node: 'e', socket: 'exec' } });
          }
        }
      }
    }
  }
  return { version: 2, origin: 'test', graph };
}

test('13 стартовых графов: 5 старых и 8 новых, 10 вставляются в пустое действие', () => {
  const starters = read('static/presets/graph-starters.json').items;
  assert.equal(starters.length, 13);
  const eight = ['attack-damage-result', 'heal-when-hurt', 'save-dc-damage', 'multiattack-two', 'staff-charges', 'smite-extra', 'aura-buff', 'sneak-attack'];
  const old = ['speed-level', 'hp-bonus', 'hp-bonus-level', 'attack-only', 'damage-only'];
  assert.deepEqual(starters.filter(item => eight.includes(item.id)).map(item => item.id), eight);
  assert.deepEqual(starters.filter(item => old.includes(item.id)).map(item => item.id), old);
  const attaching = starters.filter(item => item.attach);
  assert.equal(attaching.length, 10, 'два старых действия и все восемь новых вставляются в действие');
  // Три старых правила не имеют exec: они вставляются в пассивную программу, а не в действие.
  for (const item of starters.filter(item => !item.attach)) {
    assert.ok(item.nodes.every(node => !flowInputs(node.type).includes('exec')), `${item.id}: правило без exec`);
  }
});

test('starter templates attach into a blank action without breaking «Начало → Конец»', () => {
  const starters = read('static/presets/graph-starters.json');
  for (const item of starters.items) {
    for (const node of item.nodes) assert.ok(R.nodeDef(node.type), `${item.id}: неизвестный узел ${node.type}`);
    const keys = new Set(item.nodes.map(node => node.key));
    for (const [from, fromSocket, to, toSocket] of item.links) {
      assert.ok(keys.has(from) && keys.has(to), `${item.id}: связь на неизвестный узел`);
      const fromType = item.nodes.find(node => node.key === from).type, toType = item.nodes.find(node => node.key === to).type;
      assert.ok(Object.keys(R.nodeDef(fromType)?.outputs || {}).includes(fromSocket), `${item.id}: выход ${fromSocket}`);
      assert.ok(Object.keys(R.nodeDef(toType)?.inputs || {}).includes(toSocket), `${item.id}: вход ${toSocket}`);
    }
    if (!item.attach) continue;
    const mechanics = attachStarter(item);
    assert.equal(mechanics.graph.nodes.filter(node => node.type === 'flow.end').length, 1, `${item.id}: один «Конец»`);
    assert.deepEqual(plain(M.problems(mechanics)), [], `${item.id}: поток завершён после вставки`);
  }
});

test('every data_seed record with mechanics is executable and each program ends with flow.end', () => {
  let records = 0, withMechanics = 0, programs = 0;
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json', 'data_seed/skills.json']) {
    const rows = read(file);
    records += rows.length;
    for (const row of rows) {
      const mechanics = row.data && row.data.mechanics;
      if (!mechanics) continue;
      withMechanics++;
      assert.equal(M.validate(mechanics), '', `${file}#${row.slug}: сохранение`);
      assert.deepEqual(plain(M.problems(mechanics)), [], `${file}#${row.slug}: исполняется`);
      for (const program of mechanics.graph.nodes.filter(node => node.type === 'action.program')) {
        programs++;
        assert.ok(endsReached(mechanics.graph, program.id) > 0, `${file}#${row.slug}: программа ${program.id} завершается «Концом»`);
      }
    }
  }
  assert.ok(records >= 2517, `записей ${records}`);
  assert.ok(withMechanics >= 1985, `с механиками ${withMechanics}`);
  assert.ok(programs > 2000, `программ ${programs}`);
});
