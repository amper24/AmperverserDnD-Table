#!/usr/bin/env node
// ---------------------------------------------------------------------------
// add_flow_ends.cjs — миграция данных к правилу «начало → конец».
//
// Обходит data_seed/*.json и static/presets/*.json, находит все графы механик v2
// (граф записи, группы повторного использования, вложенные наборы, оверлеи i18n) и достраивает
// узел flow.end там, где поток действия обрывается: висячий exec-выход последнего
// узла (включая обе ветви «Если») подключается к «Концу», а если «Конца» ещё нет —
// создаётся узел. Используется тот же алгоритм, что у редактора — Mechanics.addFlowEnds.
// Оверлеи data.i18n.*.mechanics — переводы узлов по id: там нет action.program, они не меняются.
//
// Запуск:   node tools/srd/add_flow_ends.cjs           — мигрировать и записать изменённые файлы
//           node tools/srd/add_flow_ends.cjs --check   — ничего не писать; код 1, если есть обрывы
//           node tools/srd/add_flow_ends.cjs --dry-run — посчитать правки без записи
//
// Идемпотентно: повторный запуск ничего не меняет. Формат JSON сохраняется
// (файлы данных — компактная одна строка, как их пишут генераторы).
// ---------------------------------------------------------------------------
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [
  ...fs.readdirSync(path.join(ROOT, 'data_seed')).filter(name => name.endsWith('.json')).map(name => `data_seed/${name}`),
  ...fs.readdirSync(path.join(ROOT, 'static', 'presets')).filter(name => name.endsWith('.json')).map(name => `static/presets/${name}`),
];
const isCompletionProblem = message => message === '«Конец» ни к чему не подключён' || message.includes('не завершается узлом «Конец»');

const clone = value => JSON.parse(JSON.stringify(value));
const Mechanics = require('./integrity.cjs').loadRuntime().Mechanics;

/// Графы внутри документа: конверт механик (graph с nodes/links) и его группы.
function findGraphs(value, trail, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item, index) => findGraphs(item, `${trail}[${index}]`, out)); return; }
  if (value.graph && typeof value.graph === 'object' && Array.isArray(value.graph.nodes) && Array.isArray(value.graph.links)) {
    out.push({ trail: `${trail}.graph`, graph: value.graph, envelope: value });
    for (const [index, group] of (value.graph.groups || []).entries()) {
      if (group && Array.isArray(group.nodes) && Array.isArray(group.links)) out.push({ trail: `${trail}.graph.groups[${index}]`, graph: group, envelope: null, groups: value.graph.groups });
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) findGraphs(item, `${trail}.${key}`, out);
}

/// Достроить поток графа тем же движком, что у редактора. Новые узлы в seed-данных
/// не несут служебного поля action (в данных его нет — редактор ставит его у себя).
function completeGraph(graph, groups) {
  const target = { nodes: graph.nodes, links: graph.links, groups: groups || graph.groups || [] };
  const beforeNodes = new Set(graph.nodes.map(node => node.id)), beforeLinks = graph.links.length;
  const added = Mechanics.addFlowEnds(target);
  for (const node of graph.nodes) if (!beforeNodes.has(node.id)) delete node.action;
  return { added, ends: graph.nodes.filter(node => !beforeNodes.has(node.id)).length, wires: graph.links.length - beforeLinks };
}

const check = process.argv.includes('--check'), dryRun = process.argv.includes('--dry-run');
const totals = { files: 0, changedFiles: 0, graphs: 0, changedGraphs: 0, ends: 0, wires: 0, problems: [] };
for (const file of FILES) {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const graphs = [];
  findGraphs(doc, file, graphs);
  const local = { graphs: 0, changed: 0, ends: 0, wires: 0 };
  for (const entry of graphs) {
    const programs = entry.graph.nodes.filter(node => node.type === 'action.program').length;
    if (!programs) continue;
    totals.graphs++; local.graphs++;
    if (check) {
      // Тот же алгоритм на копии: граф не должен нуждаться в достройке.
      const { added } = completeGraph(clone(entry.graph), entry.groups);
      const unfinished = entry.envelope && entry.envelope.version === 2 ? Mechanics.problems(entry.envelope).filter(isCompletionProblem) : [];
      if (added) totals.problems.push(`${entry.trail}: поток не завершён (${programs} программ, ${added} правок)`);
      else if (unfinished.length) totals.problems.push(`${entry.trail}: ${unfinished.join('; ')}`);
      continue;
    }
    const result = completeGraph(entry.graph, entry.groups);
    if (!result.added) continue;
    local.changed++; local.ends += result.ends; local.wires += result.wires;
  }
  totals.files++; totals.changedFiles += local.changed ? 1 : 0; totals.changedGraphs += local.changed;
  totals.ends += local.ends; totals.wires += local.wires;
  if (local.changed) {
    if (!check && !dryRun) fs.writeFileSync(path.join(ROOT, file), JSON.stringify(doc), 'utf8');
    console.log(`${file}: графов ${local.graphs}, изменено ${local.changed}, «Концов» +${local.ends}, проводов +${local.wires}`);
  }
}

if (check) {
  for (const problem of totals.problems) console.log(`  ✗ ${problem}`);
  if (totals.problems.length) { console.error(`обрывов потока: ${totals.problems.length} — запустите node tools/srd/add_flow_ends.cjs`); process.exit(1); }
  console.log(`поток завершён: программ без достижимого «Конца» нет (проверено графов ${totals.graphs} в ${totals.files} файлах)`);
} else {
  const prefix = dryRun ? 'без записи: ' : '';
  console.log(`${prefix}файлов изменено ${totals.changedFiles}, графов ${totals.changedGraphs}: «Концов» +${totals.ends}, проводов +${totals.wires} (всего графов с программами ${totals.graphs})`);
}
