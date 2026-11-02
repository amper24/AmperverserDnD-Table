// Права UI: матрица роль×возможность в static/core/access.js и её совпадение с сервером
// (src/domain/access.rs). access.js не трогает DOM и сеть, поэтому проверяется в vm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadAccess() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/core/access.js', 'utf8'), ctx);
  return ctx.window.Access;
}
const Access = loadAccess();
const plain = value => JSON.parse(JSON.stringify(value));

// Разбор src/domain/access.rs: имя константы → строка возможности и списки ALL/PLAYER.
function rustCapabilities() {
  const src = fs.readFileSync('src/domain/access.rs', 'utf8');
  const consts = new Map();
  for (const m of src.matchAll(/pub const ([A-Z_]+): &str = "([^"]+)";/g)) consts.set(m[1], m[2]);
  const list = (name) => {
    const block = src.match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
    assert.ok(block, `в src/domain/access.rs нет списка ${name}`);
    return plain([...block[1].matchAll(/\b([A-Z_]+)\b/g)].map(m => consts.get(m[1])).filter(Boolean));
  };
  return { all: list('ALL'), player: list('PLAYER'), consts };
}
const rust = rustCapabilities();

test('список возможностей совпадает с сервером (нет дрейфа UI ↔ src/domain/access.rs)', () => {
  assert.deepEqual(plain(Access.ALL), rust.all);
  assert.deepEqual(plain(Access.PLAYER), rust.player);
  // Именованные константы CAP — те же строки, что и в ALL.
  for (const [key, cap] of Object.entries(Access.CAP)) {
    assert.ok(Access.ALL.includes(cap), `CAP.${key} = ${cap} отсутствует в ALL`);
    assert.ok(rust.consts.size > 0);
    assert.ok([...rust.consts.values()].includes(cap), `CAP.${key} = ${cap} нет в src/domain/access.rs`);
  }
  assert.equal(Object.keys(Access.CAP).length, Access.ALL.length, 'у каждой возможности есть константа CAP');
});

test('роли: мастер получает всё, игрок — только свои возможности, гость — ничего', () => {
  assert.equal(Access.ALL.length, 16);
  assert.equal(Access.PLAYER.length, 7);
  assert.deepEqual(plain(Access.perms('gm')), plain(Access.ALL));
  assert.deepEqual(plain(Access.perms('player')), plain(Access.PLAYER));
  assert.deepEqual(plain(Access.perms('outsider')), []);
  assert.deepEqual(plain(Access.perms('')), []);
  assert.deepEqual(plain(Access.perms(undefined)), []);
  // Ответ сервера (permissions) — главнее локальной матрицы.
  assert.deepEqual(plain(Access.perms({ role: 'gm', permissions: ['campaign.read'] })), ['campaign.read']);
  assert.deepEqual(plain(Access.perms({ role: 'player' })), plain(Access.PLAYER));
  assert.deepEqual(plain(Access.perms(Access.PLAYER)), plain(Access.PLAYER));
});

test('can(): гейтинг действий стола и участников', () => {
  const gm = Access.perms('gm');
  const player = Access.perms('player');
  for (const cap of Access.ALL) {
    assert.equal(Access.can(gm, cap), true, `мастер без ${cap}`);
  }
  // Игроку доступно чтение и свои токены/персонажи…
  for (const cap of [Access.CAP.campaignRead, Access.CAP.readOwn, Access.CAP.readShared,
    Access.CAP.editOwn, Access.CAP.tableRead, Access.CAP.placeCharacter, Access.CAP.moveOwnToken]) {
    assert.equal(Access.can(player, cap), true, `игрок без ${cap}`);
  }
  // …и недоступно всё мастерское.
  for (const cap of [Access.CAP.manageMembers, Access.CAP.manageCharacters, Access.CAP.invite,
    Access.CAP.editAny, Access.CAP.placeAnyCharacter, Access.CAP.moveAnyToken,
    Access.CAP.manageScene, Access.CAP.manageFog, Access.CAP.manageMembersTokens]) {
    assert.equal(Access.can(player, cap), false, `игрок получил ${cap}`);
  }
  // Пустой/битый список прав ничего не разрешает.
  assert.equal(Access.can([], Access.CAP.tableRead), false);
  assert.equal(Access.can(null, Access.CAP.tableRead), false);
  assert.equal(Access.can('table.read', Access.CAP.tableRead), false, 'строка — не список прав');
  assert.equal(Access.can(player, 'no.such.cap'), false);
});

test('подпись роли для бейджа', () => {
  assert.equal(Access.label('gm'), 'Мастер');
  assert.equal(Access.label('player'), 'Игрок');
  assert.equal(Access.label('outsider'), 'Гость');
  assert.equal(Access.label(undefined), 'Гость');
});
