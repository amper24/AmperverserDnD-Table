// tools/nodes/node-loader.cjs — загрузка скриптов узлов графа механик в node:vm.
// Порядок: mechanics.js (база) → node-registry.js (база GraphNode + реестр) → файлы static/nodes/*
// (каждая папка — категория, каждый файл — класс узла). Возвращает список загруженных файлов.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const NODE_DIR = path.join(ROOT, 'static', 'nodes');

function nodeFiles() {
  const order = ['data', 'conditions', 'logic', 'flow', 'rules', 'actions', 'groups'];
  const out = [];
  for (const dir of order) {
    const abs = path.join(NODE_DIR, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs).filter(f => f.endsWith('.js')).sort()) out.push(path.join(abs, file));
  }
  return out;
}

function loadNodes(vm, ctx, extra = []) {
  const scripts = [
    path.join(ROOT, 'static', 'mechanics.js'),
    path.join(ROOT, 'static', 'node-registry.js'),
    ...nodeFiles(),
    ...extra,
  ];
  for (const file of scripts) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return scripts;
}

module.exports = { nodeFiles, loadNodes, NODE_DIR, ROOT };
