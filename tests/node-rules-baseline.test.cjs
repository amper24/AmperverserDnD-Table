// Проверяет, что эталон docs/node-rules-baseline/ (каталог из маленьких файлов) читается целиком
// и соответствует описанию в meta.json и docs/node-rules-inventory.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'docs', 'node-rules-baseline');
const readJson = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const meta = readJson('meta.json');

test('meta lists every baseline entry and marks the directory layout', () => {
  assert.equal(meta.layout, 'directory');
  assert.equal(meta.entries.length, 70, 'inventory documents 70 baseline entries');
  assert.deepEqual(meta.levels, [1, 3, 5, 11, 20]);
  assert.equal(new Set(meta.entries).size, meta.entries.length, 'entries are unique');
});

test('every entry directory has entry.json and one file per declared level', () => {
  let races = 0, classes = 0, levelFiles = 0;
  for (const rel of meta.entries) {
    const head = JSON.parse(fs.readFileSync(path.join(ROOT, rel, 'entry.json'), 'utf8'));
    assert.ok(['2014', '2024'].includes(head.edition), `${rel}: edition`);
    assert.ok(['races', 'classes'].includes(head.kind), `${rel}: kind`);
    assert.equal(rel, `${head.edition}/${head.kind}/${head.slug}`, `${rel}: path matches slug`);
    assert.ok(Array.isArray(head.levels) && head.levels.length === 5, `${rel}: five levels`);
    for (const level of head.levels) {
      const file = path.join(ROOT, rel, `level-${String(level).padStart(2, '0')}.json`);
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(snap.level, level, `${rel}: level number inside file`);
      assert.equal(typeof snap.sheet, 'object', `${rel}: sheet present`);
      levelFiles++;
    }
    if (head.kind === 'races') races++; else classes++;
  }
  assert.equal(races, 46, 'race entries (both editions)');
  assert.equal(classes, 24, 'class entries (both editions)');
  assert.equal(levelFiles, 70 * 5, 'one file per entry and level');
});

test('no single file in the baseline is large', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  for (const file of walk(ROOT)) assert.ok(fs.statSync(file).size < 64 * 1024, `${path.relative(ROOT, file)} is under 64 KB`);
});

test('inventory and README point at the directory, not the removed monolith', () => {
  const inventory = fs.readFileSync(path.join(__dirname, '..', 'docs', 'node-rules-inventory.md'), 'utf8');
  assert.ok(inventory.includes('node-rules-baseline/'), 'inventory links the directory');
  assert.ok(!inventory.includes('node-rules-baseline.json'), 'inventory no longer links the monolith');
  assert.ok(fs.existsSync(path.join(ROOT, 'README.md')));
});
