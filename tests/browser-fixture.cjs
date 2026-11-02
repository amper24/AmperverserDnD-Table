// Общие куски браузерных сценариев: список скриптов узлов и «страница редактора».
// Раньше эти строки копировались в каждый tests/*.browser.cjs — теперь один источник.
const path = require('node:path');

// <script> для всех классов узлов из static/nodes (порядок задаёт tools/nodes/node-loader.cjs).
function nodeScripts() {
  return require('../tools/nodes/node-loader.cjs').nodeFiles()
    .map(file => `<script src="/${path.relative(process.cwd(), file).split(path.sep).join('/')}"></script>`)
    .join('');
}

// Скрипты страницы редактора механик в порядке загрузки (node-registry + классы узлов).
const EDITOR_MODULES = ['common', 'dice', 'formulas', 'equipment', 'mechanics', 'node-params-form', 'node-registry', 'node-menu', 'presets', 'mechanics-graph', 'asset-kinds', 'modules'];

function editorScripts(modules = EDITOR_MODULES) {
  return modules.map(name => name === 'node-registry'
    ? `<script src="/static/${name}.js"></script>` + nodeScripts()
    : `<script src="/static/${name}.js"></script>`).join('');
}

module.exports = { nodeScripts, EDITOR_MODULES, editorScripts };
