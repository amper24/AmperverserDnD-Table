// ---------------------------------------------------------------------------
// access.js — модель прав интерфейса: те же строки возможностей, что и
// src/domain/access.rs. Даёт: window.Access = { ALL, PLAYER, ROLES, CAP, perms,
// can, label, setLayerPerms, layerPerms, canLayerRead, canLayerWrite, canLayerCreate }.
// Зависимости: нет. Загружается до table-page.js, app.js и table.js.
// Источник правды — сервер: GET кампании отдаёт role и permissions.
// Кастомные роли и права на слои загружаются отдельно (GET /api/campaigns/:cid/roles,
// GET /api/campaigns/:cid/layer-permissions) и кэшируются в Access.state.
// ---------------------------------------------------------------------------
(function () {
  // Возможности — дословно как в src/domain/access.rs.
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
    'table.manage_roles',
    'table.manage_layers',
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
    manageRoles: 'table.manage_roles',
    manageLayers: 'table.manage_layers',
  };

  // Кэш прав на слои: { campaignId: { roleName: { layerId: {read,write,create} } } }
  const state = { layerPerms: new Map() };

  /// Сохранить права на слои для кампании (из ответа сервера).
  /// Ключ — имя роли (`role_name`), потому что права спрашивают по нему: `camp.role`
  /// в столе и на странице участников. Раньше кэш хранился по `role_id`, и права
  /// своих ролей на клиенте не применялись никогда — всегда брались умолчания.
  /// `role_id` тоже кладём ключом: у страницы прав под рукой бывает только id.
  function setLayerPerms(campaignId, perms) {
    const m = new Map();
    for (const p of perms || []) {
      const value = { read: !!p.can_read, write: !!p.can_write, create: !!p.can_create };
      for (const key of [p.role_name, p.role_id]) {
        if (!key) continue;
        if (!m.has(key)) m.set(key, new Map());
        m.get(key).set(p.layer_id, value);
      }
    }
    state.layerPerms.set(campaignId, m);
  }

  /// Права на слой для роли: {read, write, create}. gm — всё на всём.
  function layerPerms(campaignId, role, layerId) {
    if (role === 'gm') return { read: true, write: true, create: true };
    const m = state.layerPerms.get(campaignId);
    if (!m) return defaultLayerPerms(layerId);
    const r = m.get(role);
    if (!r) return defaultLayerPerms(layerId);
    return r.get(layerId) || defaultLayerPerms(layerId);
  }

  /// Дефолт: читать всё, писать/создавать всё кроме карты.
  function defaultLayerPerms(layerId) {
    const isMap = layerId === 'map';
    return { read: true, write: !isMap, create: !isMap };
  }

  /// Можно ли читать слой.
  function canLayerRead(campaignId, role, layerId) { return layerPerms(campaignId, role, layerId).read; }
  /// Можно ли писать в слой.
  function canLayerWrite(campaignId, role, layerId) { return layerPerms(campaignId, role, layerId).write; }
  /// Можно ли создавать в слой.
  function canLayerCreate(campaignId, role, layerId) { return layerPerms(campaignId, role, layerId).create; }

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
  window.Access = { ALL, PLAYER, ROLES, CAP, perms, can, label, setLayerPerms, layerPerms, canLayerRead, canLayerWrite, canLayerCreate };
})();
