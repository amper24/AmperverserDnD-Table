// Мастера создания и повышения уровня не сравнивают класс по имени: признаки берутся из наборов.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = p => fs.readFileSync(p, 'utf8');
const feature2014 = JSON.parse(read('static/presets/feature-rules-2014.json'));
const feature2024 = JSON.parse(read('static/presets/feature-rules-2024.json'));

test('создание: «Боевой стиль» пропускается по признаку набора, а не по классу fighter', () => {
  const src = read('static/character-builder.js');
  assert.equal(src.includes("slug === 'fighter'"), false);
  const rule = feature2014.items.find(i => i.table?.creation === 'skip');
  assert.ok(rule, 'в наборе 2014 есть правило creation: skip');
  assert.equal(new RegExp(rule.table.pattern, rule.table.flags || '').test('Боевой стиль'), true);
  assert.equal(new RegExp(rule.table.pattern, rule.table.flags || '').test('Боевой стиль: Защита'), true);
  assert.equal(new RegExp(rule.table.pattern, rule.table.flags || '').test('Второе дыхание'), false);
  assert.equal(feature2024.items.some(i => i.table?.creation === 'skip'), false, 'в 2024 пропуска нет');
});

test('повышение: список классов для тайных заклинаний 2024 — из набора', () => {
  const src = read('static/levelup.js');
  assert.equal(src.includes("'Волшебник'"), false, 'нет литерала списка классов');
  const secrets = feature2024.items.find(i => i.id === 'secrets');
  assert.deepEqual(secrets.table.spell_classes, ["Бард", "Жрец", "Друид", "Волшебник", "Bard", "Cleric", "Druid", "Wizard"]);
});

test('блок атаки: умолчание формулы берётся из block_defaults', () => {
  const src = read('static/node-registry.js');
  assert.equal(src.includes("'1d20+@atk' : '1d6'"), false, 'нет запасной формулы в коде');
  assert.ok(src.includes("Presets?.item('block_defaults', kind)"));
  const bd = JSON.parse(read('static/presets/block-defaults.json'));
  assert.equal(bd.items.find(i => i.id === 'attack').table.dice, '1d20+@atk');
});
