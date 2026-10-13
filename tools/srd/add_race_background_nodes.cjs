#!/usr/bin/env node
// Переносит базовые правила рас и предысторий из data.* в узлы rule.* (data_seed/srd_*.json):
//   Расы: rule.speed, rule.languages (без описаний), rule.ability_bonus (asi 2014, гейт edition).
//   Предыстории: rule.proficiencies (tools), rule.feature (feature + feature_text).
// Идемпотентно. Поля data.* не трогаются. node tools/srd/add_race_background_nodes.cjs
const fs = require('node:fs'), vm = require('node:vm');

const RACE_RULE_IDS = new Set(['race_speed', 'race_languages', 'race_edition', 'race_asi_str', 'race_asi_dex', 'race_asi_con', 'race_asi_int', 'race_asi_wis', 'race_asi_cha']);
const BG_RULE_IDS = new Set(['bg_tools', 'bg_feature']);
const isLangName = x => typeof x === 'string' && x.length <= 40 && !x.includes('.') && !x.includes(';');
const values = raw => (Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : []).map(x => String(x).trim()).filter(x => x && x !== '—' && x !== '–' && x !== '-');

function raceNodes(rec) {
  const d = rec.data || {};
  const nodes = [], links = [];
  if (typeof d.speed === 'number') nodes.push({ id: 'race_speed', type: 'rule.speed', params: { value: d.speed } });
  const langs = (Array.isArray(d.languages) ? d.languages : []).filter(isLangName).map(x => x.trim()).filter(Boolean);
  if (langs.length) nodes.push({ id: 'race_languages', type: 'rule.languages', params: { value: langs } });
  const asi = Object.entries(d.asi || {}).filter(([, v]) => Number(v));
  if (asi.length) {
    nodes.push({ id: 'race_edition', type: 'condition.edition', params: { editions: ['2014'] } });
    for (const [ability, amount] of asi) {
      const id = `race_asi_${ability}`;
      nodes.push({ id, type: 'rule.ability_bonus', params: { ability, amount: Number(amount) } });
      links.push({ from: { node: 'race_edition', socket: 'value' }, to: { node: id, socket: 'enabled' } });
    }
  }
  return { nodes, links };
}

function backgroundNodes(rec) {
  const d = rec.data || {};
  const nodes = [];
  const toolValues = values(d.tools);
  if (toolValues.length) nodes.push({ id: 'bg_tools', type: 'rule.proficiencies', params: { kind: 'Инструменты', value: toolValues } });
  if (typeof d.feature === 'string' && d.feature.trim()) nodes.push({ id: 'bg_feature', type: 'rule.feature', params: { name: d.feature, text: d.feature_text || '' } });
  return { nodes, links: [] };
}

function enOverlay(rec, nodes) {
  const en = rec.data?.i18n?.en;
  if (!en) return [];
  const out = [];
  for (const n of nodes) {
    if (n.type === 'rule.languages') {
      const enLangs = (Array.isArray(en['languages!']) ? en['languages!'] : []).filter(isLangName).map(x => x.trim()).filter(Boolean);
      if (enLangs.length) out.push({ id: n.id, params: { value: enLangs } });
    } else if (n.type === 'rule.proficiencies') {
      const enVals = values(en['tools!'] ?? en.tools);
      if (enVals.length) out.push({ id: n.id, params: { kind: 'Tools', value: enVals } });
    } else if (n.type === 'rule.feature') {
      out.push({ id: n.id, params: { name: en.feature || n.params.name, text: en.feature_text || '' } });
    }
  }
  return out;
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
      const isRace = rec.category === 'race', isBg = rec.category === 'background';
      if (!isRace && !isBg) continue;
      if (rec.data?.mechanics?.version !== 2) { console.error(`не граф v2: ${rec.slug}`); problems++; continue; }
      const built = isRace ? raceNodes(rec) : backgroundNodes(rec);
      const ids = isRace ? RACE_RULE_IDS : BG_RULE_IDS;
      const graph = rec.data.mechanics.graph;
      graph.nodes = (graph.nodes || []).filter(n => !ids.has(n.id));
      graph.links = (graph.links || []).filter(l => !ids.has(l.from.node) && !ids.has(l.to.node));
      built.nodes.forEach((n, i) => graph.nodes.push({ ...n, position: { x: 40, y: 40 + i * 90 } }));
      graph.links.push(...built.links);
      const overlay = enOverlay(rec, built.nodes);
      if (overlay.length && rec.data.i18n?.en) {
        const en = rec.data.i18n.en;
        en.mechanics = en.mechanics || { graph: { nodes: [] } };
        en.mechanics.graph = en.mechanics.graph || { nodes: [] };
        const enNodes = en.mechanics.graph.nodes;
        for (let i = enNodes.length - 1; i >= 0; i--) if (ids.has(enNodes[i]?.id)) enNodes.splice(i, 1);
        for (const over of overlay) enNodes.push(over);
      }
      changed++;
    }
    fs.writeFileSync(file, JSON.stringify(records, null, 0));
    console.log(`${file}: рас/предысторий с правилами в узлах ${changed}`);
  }
  for (const file of ['data_seed/srd_2014.json', 'data_seed/srd_2024.json']) {
    for (const rec of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (rec.category !== 'race' && rec.category !== 'background') continue;
      const err = M.validate(rec.data.mechanics);
      if (err) { console.error(`проверка не пройдена: ${rec.slug}: ${err}`); problems++; }
    }
  }
  if (problems) { console.error(`проблем: ${problems}`); process.exit(1); }
  console.log('проверка графов пройдена');
}
main().catch(e => { console.error(e); process.exit(1); });

