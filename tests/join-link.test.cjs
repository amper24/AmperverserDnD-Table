// Вход по ссылке-приглашению (/join/:code): разбор ответа GET /api/join/:code.
// Сервер отвечает { campaign: { id, name, description }, role }, а страница раньше
// читала плоские campaign_id/campaign_name — получала undefined и вела на
// /c/undefined с окном «Нет доступа» уже после выдачи роли. Тест фиксирует
// контракт сервера (форма ответа) и то, что по приглашению всегда находится
// кампания для перехода на стол.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// lobby.js — объект с методами, DOM трогается только в рендерерах, поэтому файл
// грузится в vm с пустым окном (как nav.js в tests/nav.test.cjs).
function loadLobby() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('static/pages/lobby.js', 'utf8'), ctx, { filename: 'static/pages/lobby.js' });
  return ctx.window.Lobby;
}
const Lobby = loadLobby();

test('приглашение: ответ сервера с вложенной кампанией даёт id и имя для перехода на стол', () => {
  // Точная форма ответа src/api/campaigns.rs::invite_info.
  const target = Lobby.inviteTarget({
    campaign: { id: 'camp1', name: 'Кампания теней', description: 'Подземелья и драконы' },
    role: 'player',
  });
  assert.deepEqual({ ...target }, { id: 'camp1', name: 'Кампания теней', role: 'player' });
  assert.equal('/c/' + target.id, '/c/camp1', 'кнопка ведёт на стол кампании, а не на /c/undefined');
});

test('приглашение: роль мастера и ссылка на мастера сохраняются', () => {
  const target = Lobby.inviteTarget({ campaign: { id: 'camp2', name: 'Рудник' }, role: 'gm' });
  assert.equal(target.role, 'gm');
  assert.equal(target.name, 'Рудник');
});

test('приглашение: плоские campaign_id/campaign_name (старые сборки) тоже читаются', () => {
  const target = Lobby.inviteTarget({ campaign_id: 'camp3', campaign_name: 'Кампания теней', role: 'player' });
  assert.deepEqual({ ...target }, { id: 'camp3', name: 'Кампания теней', role: 'player' });
});

test('приглашение: пустой или неполный ответ не подменяется словом undefined', () => {
  for (const info of [null, undefined, {}, { campaign: {} }, { campaign: { name: 'Без id' } }]) {
    const target = Lobby.inviteTarget(info);
    assert.equal(target.id, '', 'id пустой — страница останется на приглашении с ошибкой');
    assert.notEqual(target.name, undefined, 'у кампании всегда есть подпись');
    assert.notEqual(target.role, undefined, 'роль по умолчанию — игрок');
  }
});

test('приглашение: страница не собирает адрес перехода из непроверенного поля', () => {
  const src = fs.readFileSync('static/pages/lobby.js', 'utf8');
  // Регрессия: info.campaign_id больше не используется напрямую в renderJoin.
  assert.doesNotMatch(src, /go\('\/c\/' \+ info\.campaign_id\)/, 'переход собирается через inviteTarget/POST');
  assert.match(src, /inviteTarget\(await API\.get\('\/api\/join\/' \+ codeStr\)\)/, 'страница приглашения разбирает ответ помощником');
  assert.match(src, /go\('\/c\/' \+ cid\)/, 'после присоединения — сразу на стол');
});

test('приглашение: серверный ответ содержит вложенную кампанию и роль', () => {
  const src = fs.readFileSync(path.join('src', 'api', 'campaigns.rs'), 'utf8');
  assert.match(src, /"campaign": \{ "id": inv\.get::<String, _>\("id"\), "name": inv\.get::<String, _>\("name"\)/, 'контракт invite_info');
  assert.match(src, /async fn join\([\s\S]*?"campaign_id": cid/, 'POST /api/join/:code возвращает campaign_id');
});
