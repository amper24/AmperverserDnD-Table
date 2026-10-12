// Пул векторных иконок (common.js ICONS): новые иконки есть, сопоставление рас указывает на существующие.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('static/common.js', 'utf8'), ctx);
const names = ctx.window.ICON_NAMES;

test('новые иконки предметов и рас есть в пуле', () => {
  for (const n of ['bow', 'gem', 'helm', 'chest', 'leaf', 'halfleaf', 'horns', 'dragon', 'cog']) {
    assert.ok(names.includes(n), `иконка ${n}`);
  }
});

test('иконки, которые раньше были только в ICONS_KNOWN (modules.js), доступны', () => {
  for (const n of ['arrow', 'zap', 'wand', 'scroll', 'box']) assert.ok(names.includes(n), n);
});

test('сопоставление рас указывает на существующие иконки', () => {
  const src = fs.readFileSync('static/modules.js', 'utf8');
  const block = src.match(/const RACE_ICONS = \{([^}]*)\}/);
  assert.ok(block, 'RACE_ICONS объявлен');
  const values = [...block[1].matchAll(/:\s*'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(values.length >= 7, 'есть сопоставления для рас');
  for (const v of values) assert.ok(names.includes(v), `иконка для расы: ${v}`);
});

test('modules.js не держит отдельный список иконок', () => {
  const src = fs.readFileSync('static/modules.js', 'utf8');
  assert.ok(src.includes('window.ICON_NAMES'), 'ICONS_KNOWN берёт список из common.js');
});
