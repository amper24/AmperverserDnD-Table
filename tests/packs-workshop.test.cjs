const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const api = fs.readFileSync('src/api/packs.rs', 'utf8');
const db = fs.readFileSync('src/store/db.rs', 'utf8');
const ui = fs.readFileSync('static/pages/packs.js', 'utf8');

test('pack provenance and license metadata persist through API, database, import/export, and clone', () => {
  for (const field of ['license', 'source_url', 'attribution']) {
    assert.match(db, new RegExp(`ALTER TABLE packs ADD COLUMN ${field}`));
    assert.match(api, new RegExp(`\\"${field}\\"`), `pack JSON exports ${field}`);
    assert.match(api, new RegExp(`pub ${field}: Option<String>`), `request accepts ${field}`);
  }
  assert.match(api, /"entries": entries_of\(&st, &pid\)\.await\?/);
  assert.match(api, /opt\(&p, "license"\).*opt\(&p, "source_url"\).*opt\(&p, "attribution"\)/s);
  assert.match(ui, /license: j\.license \|\| ''/);
  assert.match(ui, /source_url: j\.source_url \|\| ''/);
  assert.match(ui, /attribution: j\.attribution \|\| ''/);
});

test('public catalog publishing requires a license and attribution except for CC0', () => {
  assert.match(api, /fn validate_publication\(/);
  assert.match(api, /Перед публикацией укажите лицензию набора/);
  assert.match(api, /Добавьте обязательную атрибуцию/);
  assert.match(api, /let is_cc0 = normalized\.contains\("cc0"\)/);
  assert.match(api, /All rights reserved/);
  assert.match(ui, /All rights reserved — без открытой публикации/);
  assert.match(ui, /MIT — для кода/);
  assert.match(ui, /Другая лицензия…/);
  assert.match(ui, /licenseControl\(value = ''\)/);
  assert.match(ui, /Подтверждаю, что имею право публиковать материалы/);
  assert.match(ui, /f\('Лицензия', license\.element\)/);
});

test('catalog search has metadata filters, server-side pagination, and a total count', () => {
  for (const field of ['edition', 'limit', 'offset', 'with_total']) assert.match(api, new RegExp(`pub ${field}: Option`));
  assert.match(api, /SELECT COUNT\(\*\) AS total FROM packs p WHERE/);
  assert.match(api, /LIMIT \? OFFSET \?/);
  assert.match(api, /LOWER\(p\.license\) LIKE \?/);
  assert.match(api, /REPLACE\(LOWER\(p\.tags\), ' ', ''\)/);
  assert.match(ui, /const PAGE_SIZE = 24/);
  assert.match(ui, /with_total: 'true'/);
  assert.match(ui, /← Назад/);
  assert.match(ui, /Дальше →/);
});
