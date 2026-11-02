// ---------------------------------------------------------------------------
// access.js — модель прав интерфейса: те же строки возможностей, что и
// src/access.rs. Даёт: window.Access = { ALL, PLAYER, ROLES, CAP, perms,
// can, label }.
// Зависимости: нет. Загружается до table-page.js, app.js и table.js.
// Источник правды — сервер: GET кампании отдаёт role и permissions. Локальная
// матрица ролей нужна только как запасной вариант (если пришла одна role),
// а can() — единственный способ гейтить кнопки на клиенте.
// ---------------------------------------------------------------------------
(function () {
  // Возможности — дословно как в src/access.rs (тест tests/access.test.cjs сверяет списки).
  const ALL = [
    'campaign.read',
    'campaign.manage_members',
    'campaign.manage_characters',
    'campaign.invite',
    'character.read_own',
    'character.read_shared',
    'character.edit_own',
    'character.edit_any',
    'table.read',
    'table.place_character',
    'table.place_any_character',
    'table.move_own_token',
    'table.move_any_token',
    'table.manage_scene',
    'table.manage_fog',
    'table.manage_members_tokens',
  ];
  const PLAYER = [
    'campaign.read',
    'character.read_own',
    'character.read_shared',
    'character.edit_own',
    'table.read',
    'table.place_character',
    'table.move_own_token',
  ];
  const ROLES = { gm: ALL, player: PLAYER };
  // Именованные константы, чтобы код читался: Access.CAP.manageFog.
  const CAP = {
    campaignRead: 'campaign.read',
    manageMembers: 'campaign.manage_members',
    manageCharacters: 'campaign.manage_characters',
    invite: 'campaign.invite',
    readOwn: 'character.read_own',
    readShared: 'character.read_shared',
    editOwn: 'character.edit_own',
    editAny: 'character.edit_any',
    tableRead: 'table.read',
    placeCharacter: 'table.place_character',
    placeAnyCharacter: 'table.place_any_character',
    moveOwnToken: 'table.move_own_token',
    moveAnyToken: 'table.move_any_token',
    manageScene: 'table.manage_scene',
    manageFog: 'table.manage_fog',
    manageMembersTokens: 'table.manage_members_tokens',
  };

  /// Список возможностей из ответа сервера (кампания или готовый массив) либо по роли.
  function perms(source) {
    if (Array.isArray(source)) return source.slice();
    const list = source && Array.isArray(source.permissions) ? source.permissions : null;
    if (list) return list.slice();
    const role = typeof source === 'string' ? source : source && source.role;
    return ROLES[role] ? ROLES[role].slice() : [];
  }
  /// Есть ли возможность в списке (единственная проверка для гейтинга кнопок).
  function can(list, cap) {
    return Array.isArray(list) && list.indexOf(cap) >= 0;
  }
  /// Подпись роли для бейджа.
  function label(role) {
    return role === 'gm' ? 'Мастер' : role === 'player' ? 'Игрок' : 'Гость';
  }
  window.Access = { ALL, PLAYER, ROLES, CAP, perms, can, label };
})();
