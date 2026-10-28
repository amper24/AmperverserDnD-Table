#!/usr/bin/env node
// Добавляет исполняемые узлы урона (action.roll) предметам и заклинаниям, у которых в описании
// есть бросок урона вида «XdN урона <типом>» / «XdN <тип> урона», но нет action.roll-узлов.
// Узел: программа «Урон» (style damage) → action.roll (roll_kind damage) → flow.end. Идемпотентно.
//   node tools/srd/add_missing_damage_rolls.cjs
const fs = require('node:fs'), vm = require('node:vm');

const DAMAGE_EN = { 'кислота': 'acid', 'дробящий': 'bludgeoning', 'колющий': 'piercing', 'рубящий': 'slashing', 'электричество': 'lightning', 'яд': 'poison', 'огонь': 'fire', 'холод': 'cold', 'излучение': 'radiant', 'некротический': 'necrotic', 'психический': 'psychic', 'звук': 'thunder', 'силовое поле': 'force' };
const DTYPE_FORMS = { 'кислотой': 'кислота', 'огнём': 'огонь', 'огнем': 'огонь', 'излучением': 'излучение', 'ядом': 'яд', 'колющего': 'колющий', 'дробящего': 'дробящий', 'рубящего': 'рубящий', 'электричеством': 'электричество', 'холодом': 'холод', 'звуком': 'звук', 'некротическим': 'некротический', 'психической': 'психический', 'силовым': 'силовое поле' };

function damageRolls(text) {
  const rolls = [];
  const re = /(\d*)[кd](\d+)\s+(?:урона\s+([а-яё]+)|([а-яё]+)\s+урона)/gi;
  let m;
  while ((m = re.exec(text))) {
    const count = Number(m[1] || 1), sides = Number(m[2]);
    const form = String(m[3] || m[4] || '').toLowerCase();
    rolls.push({ count, sides, dtype: DTYPE_FORMS[form] || '' });
  }
  return rolls;
}

async function main() {
  const ctx = { console, crypto: require('node:crypto').webcrypto, document: {}, window: {} };
  vm.createContext(ctx);
  for (const f of ['static/dice.js', 'static/mechanics.js', 'static/formulas.js', 'static/node-params-form.js', 'static/node-registry.js', ...require('../nodes/node-loader.cjs').nodeFiles(), 'static/mechanics-graph.js']) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
  }
  const M = ctx.window.Mechanics;
  let problems = 0;
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = 0;
    for (const rec of records) {
      if (rec.category !== 'item' && rec.category !== 'spell') continue;
      if (rec.data?.mechanics?.version !== 2) continue;
      const graph = rec.data.mechanics.graph;
      // Убираем прежние auto-dmg узлы (идемпотентность).
      graph.nodes = (graph.nodes || []).filter(n => !n.id.startsWith('auto-dmg-'));
      graph.links = (graph.links || []).filter(l => !l.from.node.startsWith('auto-dmg-') && !l.to.node.startsWith('auto-dmg-'));
      // Если есть исполняемый бросок (не наш) — пропускаем.
      const hasRoll = (graph.nodes || []).some(n => n.type === 'action.roll');
      if (hasRoll) continue;
      const text = [rec.data.desc, ...(rec.data.traits || []).map(t => t.text)].filter(Boolean).join(' ');
      const rolls = damageRolls(text);
      if (!rolls.length) continue;
      const r = rolls[0];
      const pid = `auto-dmg-${rec.slug}`, rid = `${pid}-1`;
      graph.nodes.push({ id: pid, type: 'action.program', params: { program_id: 'auto-dmg', name: 'Урон', trigger: 'use', style: 'damage' }, position: { x: 40, y: 40 } });
      graph.nodes.push({ id: rid, type: 'action.roll', params: { enabled: true, when: 'always', dice: { count: r.count, sides: r.sides, bonus: 0, stat: '' }, damage_type: r.dtype, block_id: 'auto-dmg-b1', roll_kind: 'damage' }, position: { x: 320, y: 40 } });
      // Поток действия обязан доходить до «Конца»: программа → бросок → «Конец».
      graph.nodes.push({ id: `${pid}-end`, type: 'flow.end', params: {}, position: { x: 600, y: 40 } });
      graph.links.push({ from: { node: pid, socket: 'exec' }, to: { node: rid, socket: 'exec' } });
      graph.links.push({ from: { node: rid, socket: 'exec' }, to: { node: `${pid}-end`, socket: 'exec' } });
      // Английский оверлей: имя программы и тип урона.
      if (rec.data.i18n?.en) {
        const en = rec.data.i18n.en;
        en.mechanics = en.mechanics || { graph: { nodes: [] } };
        en.mechanics.graph = en.mechanics.graph || { nodes: [] };
        const enNodes = en.mechanics.graph.nodes;
        for (let i = enNodes.length - 1; i >= 0; i--) if (enNodes[i]?.id === pid || enNodes[i]?.id === rid) enNodes.splice(i, 1);
        enNodes.push({ id: pid, params: { name: 'Damage' } });
        if (r.dtype) enNodes.push({ id: rid, params: { damage_type: DAMAGE_EN[r.dtype] || r.dtype } });
      }
      changed++;
    }
    fs.writeFileSync(file, JSON.stringify(records, null, 0));
    console.log(`${file}: добавлено узлов урона ${changed}`);
  }
  console.log('проверка графов пройдена');
}
main().catch(e => { console.error(e); process.exit(1); });
