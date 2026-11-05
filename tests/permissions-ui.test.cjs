// Интерфейс системы прав (static/core/permissions-ui.js): группы возможностей,
// подписи, быстрые наборы, слои — и то, что раздел «Права» живёт на странице
// участников, а модалки со стола больше нет. Модуль не трогает DOM при загрузке,
// поэтому проверяется в vm, без браузера.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));

function load() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/core/access.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('static/core/asset-kinds.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('static/core/permissions-ui.js', 'utf8'), ctx);
  return { Permissions: ctx.window.Permissions, Access: ctx.window.Access, AssetKinds: ctx.window.AssetKinds };
}
const { Permissions, Access, AssetKinds } = load();
const read = file => fs.readFileSync(file, 'utf8');

test('возможности: каждая из Access.ALL ровно в одной группе, с подписью и подсказкой', () => {
  const ids = Permissions.allCaps();
  assert.equal(new Set(ids).size, ids.length, 'возможность не дублируется между группами');
  assert.deepEqual([...ids].sort(), [...Access.ALL].sort(), 'набор совпадает с Access.ALL (зеркалом src/domain/access.rs)');
  assert.equal(Permissions.GROUPS.length, 4, 'четыре группы: кампания, листы, стол, права');
  for (const group of Permissions.GROUPS) {
    assert.ok(group.title && group.hint, `у группы «${group.key}» есть заголовок и подсказка`);
    assert.ok(group.caps.length > 0, `группа «${group.key}» не пустая`);
    for (const cap of group.caps) {
      assert.ok(Access.ALL.includes(cap.id), `${cap.id} есть в Access.ALL`);
      assert.ok(cap.label && cap.label.length > 2, `у ${cap.id} есть подпись`);
      assert.ok(cap.hint && cap.hint.length > 5, `у ${cap.id} есть подсказка`);
    }
  }
});

test('label()/hint(): человеческая подпись вместо строки возможности', () => {
  assert.equal(Permissions.label('table.move_any_token'), 'Двигать любые токены');
  assert.equal(Permissions.label('campaign.manage_members'), 'Управлять участниками');
  assert.match(Permissions.hint('table.manage_fog'), /туман/i);
  // Неизвестная возможность не превращается в пустоту: показываем как есть.
  assert.equal(Permissions.label('no.such.cap'), 'no.such.cap');
  assert.equal(Permissions.hint('no.such.cap'), '');
});

test('summary(): сводка набора возможностей для карточки роли', () => {
  assert.equal(Permissions.summary([]), 'без доступа');
  assert.equal(Permissions.summary(null), 'без доступа');
  assert.equal(Permissions.summary(Access.ALL), 'все возможности');
  assert.equal(Permissions.summary(Access.PLAYER), '7 из 18');
  assert.equal(Permissions.summary(['campaign.read', 'table.read']), '2 из 18');
});

test('groupsOf(): в карточке роли только непустые группы с подписями', () => {
  const groups = plain(Permissions.groupsOf(Access.PLAYER));
  assert.deepEqual(groups.map(g => g.title), ['Кампания', 'Листы персонажей', 'Стол']);
  assert.deepEqual(groups.map(g => g.count), [1, 3, 3]);
  assert.deepEqual(groups[0].labels, ['Видеть кампанию']);
  assert.deepEqual(plain(Permissions.groupsOf([])), []);
});

test('быстрые наборы: игрок, только чтение, всё, ничего', () => {
  assert.deepEqual(plain(Permissions.presetCaps('player')), plain(Access.PLAYER));
  assert.deepEqual(plain(Permissions.presetCaps('gm')), plain(Access.ALL));
  assert.deepEqual(plain(Permissions.presetCaps('none')), []);
  const readonly = plain(Permissions.presetCaps('readonly'));
  assert.deepEqual(readonly.sort(), ['campaign.read', 'character.read_own', 'character.read_shared', 'table.read'].sort());
  assert.equal(readonly.includes('table.move_any_token'), false, 'наблюдатель ничего не двигает');
  assert.deepEqual(plain(Permissions.presetCaps('no-such-preset')), []);
  assert.equal(Permissions.PRESETS.length, 4);
});

test('слои матрицы: те же 8 слоёв стола, что в AssetKinds, с подписями', () => {
  const ids = Permissions.LAYERS.map(layer => layer.id);
  assert.equal(new Set(ids).size, ids.length, 'слой не повторяется');
  assert.deepEqual([...ids].sort(), [...AssetKinds.layerOrder].sort(), 'набор слоёв совпадает с AssetKinds.layerOrder');
  for (const layer of Permissions.LAYERS) assert.ok(layer.label && layer.label.length > 2, `подпись для слоя ${layer.id}`);
  // Персонажи первыми: это самый частый слой, карта — последней.
  assert.equal(ids[0], 'character');
  assert.equal(ids[ids.length - 1], 'map');
});

test('раздел «Права» — на странице участников, модалки со стола больше нет', () => {
  const page = read('static/table/table-page.js');
  assert.match(page, /Permissions\.mount\(/, 'страница участников монтирует раздел прав');
  assert.match(page, /'data-sec': 'rules'/, 'у раздела есть якорь data-sec=rules');
  assert.match(page, /roleOptions\(/, 'участнику можно назначить свою роль');
  const html = read('static/table.html');
  const lib = html.indexOf('/static/core/permissions-ui.js');
  const script = html.indexOf('/static/table/table-page.js');
  assert.ok(lib > 0 && lib < script, 'модуль прав подключён до страницы участников');
  const table = read('static/pages/app.js');
  assert.equal(table.includes('openPermissionsModal'), false, 'модальное окно прав удалено');
  assert.match(table, /href: '\/table\/' \+ cid/, 'со стола ведёт ссылка на страницу участников');
});

test('матрицу прав на слои читают все участники: иначе права своих ролей не применяются', () => {
  const src = read('src/api/campaigns.rs');
  const fn = src.slice(src.indexOf('async fn list_layer_perms'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /access::TABLE_READ/, 'GET /layer-permissions требует table.read, а не table.manage_roles');
  const setFn = src.slice(src.indexOf('async fn set_layer_perms'));
  assert.match(setFn.slice(0, setFn.indexOf('\n}\n')), /access::TABLE_MANAGE_ROLES/, 'менять матрицу — только с table.manage_roles');
});
