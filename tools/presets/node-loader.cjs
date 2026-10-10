// Загрузка реестра наборов (static/presets.js) в node — для тестов и инструментов.
// Наборы читаются с диска из static/presets/ (по index.json), как их отдаёт браузеру fetch.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// ctx — контекст vm с полем window (или пустой объект: window создаётся). Возвращает Promise<Presets>.
async function loadPresets(ctx = {}, root = process.cwd()) {
  ctx.window = ctx.window || {};
  if (!vm.isContext(ctx)) vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'static/presets.js'), 'utf8'), ctx);
  return ctx.window.Presets.load(file => JSON.parse(fs.readFileSync(path.join(root, 'static/presets', file), 'utf8')));
}
module.exports = { loadPresets };
