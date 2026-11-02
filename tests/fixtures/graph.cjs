// Графовый слой механик для тестов мастерской сборки: особенности рас, классы и навыки живут
// узлами правил, поэтому песочнице нужен движок узлов, а не только наборы данных.
const fs = require('node:fs');
const vm = require('node:vm');
const FILES = ['static/core/formulas.js', 'static/editor/mechanics.js', 'static/editor/node-params-form.js', 'static/editor/node-registry.js',
  ...require('../../tools/nodes/node-loader.cjs').nodeFiles(), 'static/editor/mechanics-graph.js'];
module.exports = function loadGraphRuntime(ctx) {
  for (const file of FILES) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  // В браузере глобальные имена (Mechanics, Nodes, …) совпадают со свойствами window — в vm копируем их.
  for (const key of Object.keys(ctx.window)) if (!(key in ctx)) ctx[key] = ctx.window[key];
};
