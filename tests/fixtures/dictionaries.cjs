// Словари листа из static/common.js (window.SKILLS, window.ABIL, window.EDITIONS).
// В браузере common.js загружается первым (слой 1), поэтому тесты логики листа обязаны
// получать те же словари: иначе русское название навыка не превращается в ключ.
// Из common.js берутся только объявления-данные: остальной файл зависит от DOM/WS.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', '..', 'static', 'common.js');

function pick(name) {
  const text = fs.readFileSync(SOURCE, 'utf8');
  const m = text.match(new RegExp(`window\\.${name}\\s*=\\s*(\\[[\\s\\S]*?\\n\\]|\\{[\\s\\S]*?\\});`));
  if (!m) throw new Error(`не найден window.${name} в static/common.js`);
  return vm.runInNewContext(`(${m[1]})`);
}

module.exports = () => ({ SKILLS: pick('SKILLS'), ABIL: pick('ABIL'), EDITIONS: pick('EDITIONS') });
