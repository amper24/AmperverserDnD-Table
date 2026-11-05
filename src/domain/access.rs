//! Права участников кампании: возможности (capabilities), роли и проверки доступа.
//!
//! Один источник правды для HTTP-эндпоинтов и WebSocket-сообщений стола.
//! Системные роли: `gm` — мастер (все возможности), `player` — игрок (чтение кампании,
//! свои и расшаренные персонажи, свои токены). Кампания может определять свои
//! собственные роли с набором возможностей и правами на слои.
//! Клиентское зеркало — `static/core/access.js`.
//
//! Правила стола (WS), которые проверяются по возможностям:
//! `table.move_any_token` — мастер двигает и удаляет любые элементы сцены;
//! `table.move_own_token` — игрок двигает только свои токены (owner_id) и лут;
//! `table.place_any_character` / `table.place_character` — кто ставит токены;
//! `table.manage_scene` / `table.manage_fog` — сцены, слои, сетка и туман;
//! `table.manage_roles` — создание и редактирование своих ролей и прав на слои;
//! `table.manage_layers` — создание/удаление/переименование слоёв сцены.

use serde_json::{json, Value};

use crate::{api::campaigns::Member, error::ApiResult, AppError, AppState};

// ---- Возможности (capabilities) ----
pub const CAMPAIGN_READ: &str = "campaign.read";
pub const CAMPAIGN_MANAGE_MEMBERS: &str = "campaign.manage_members";
pub const CAMPAIGN_MANAGE_CHARACTERS: &str = "campaign.manage_characters";
pub const CAMPAIGN_INVITE: &str = "campaign.invite";
pub const CHARACTER_READ_OWN: &str = "character.read_own";
pub const CHARACTER_READ_SHARED: &str = "character.read_shared";
pub const CHARACTER_EDIT_OWN: &str = "character.edit_own";
pub const CHARACTER_EDIT_ANY: &str = "character.edit_any";
pub const TABLE_READ: &str = "table.read";
pub const TABLE_PLACE_CHARACTER: &str = "table.place_character";
pub const TABLE_PLACE_ANY_CHARACTER: &str = "table.place_any_character";
pub const TABLE_MOVE_OWN_TOKEN: &str = "table.move_own_token";
pub const TABLE_MOVE_ANY_TOKEN: &str = "table.move_any_token";
pub const TABLE_MANAGE_SCENE: &str = "table.manage_scene";
pub const TABLE_MANAGE_FOG: &str = "table.manage_fog";
pub const TABLE_MANAGE_MEMBERS_TOKENS: &str = "table.manage_members_tokens";
pub const TABLE_MANAGE_ROLES: &str = "table.manage_roles";
pub const TABLE_MANAGE_LAYERS: &str = "table.manage_layers";

/// Все возможности (мастер). Порядок — порядок объявления: его видят UI и тесты.
pub const ALL: &[&str] = &[
    CAMPAIGN_READ,
    CAMPAIGN_MANAGE_MEMBERS,
    CAMPAIGN_MANAGE_CHARACTERS,
    CAMPAIGN_INVITE,
    CHARACTER_READ_OWN,
    CHARACTER_READ_SHARED,
    CHARACTER_EDIT_OWN,
    CHARACTER_EDIT_ANY,
    TABLE_READ,
    TABLE_PLACE_CHARACTER,
    TABLE_PLACE_ANY_CHARACTER,
    TABLE_MOVE_OWN_TOKEN,
    TABLE_MOVE_ANY_TOKEN,
    TABLE_MANAGE_SCENE,
    TABLE_MANAGE_FOG,
    TABLE_MANAGE_MEMBERS_TOKENS,
    TABLE_MANAGE_ROLES,
    TABLE_MANAGE_LAYERS,
];

/// Возможности игрока по умолчанию.
pub const PLAYER: &[&str] = &[
    CAMPAIGN_READ,
    CHARACTER_READ_OWN,
    CHARACTER_READ_SHARED,
    CHARACTER_EDIT_OWN,
    TABLE_READ,
    TABLE_PLACE_CHARACTER,
    TABLE_MOVE_OWN_TOKEN,
];

/// Права по умолчанию для игрока на слоях: все слои кроме «map» доступны на чтение/запись/создание.
/// Слой карт (`map`) по умолчанию закрыт для игроков — только мастер.
pub const DEFAULT_PLAYER_LAYER_PERMS: &[(&str, bool, bool, bool)] = &[
    ("prop", true, true, true),
    ("mount", true, true, true),
    ("character", true, true, true),
    ("attachment", true, true, true),
    ("drawing", true, true, true),
    ("text", true, true, true),
    ("note", true, true, true),
    ("map", true, false, false), // карта: читать можно, править/создавать — нет
];

/// Нормализованная роль: неизвестное значение БД — посторонний (прав нет).
pub fn role_of(role: &str) -> &'static str {
    match role {
        "gm" => "gm",
        "player" => "player",
        _ => "outsider",
    }
}

/// Мастер?
pub fn is_gm(role: &str) -> bool {
    role_of(role) == "gm"
}

/// Возможности роли. gm — все, player — базовый набор, остальные — пусто.
/// Кастомные роли загружаются из ББ и не входят в этот справочник (их права хранятся в campaign_roles).
pub fn perms(role: &str) -> Vec<&'static str> {
    match role_of(role) {
        "gm" => ALL.to_vec(),
        "player" => PLAYER.to_vec(),
        _ => Vec::new(),
    }
}

/// Возможности роли для клиента (GET кампании: `permissions`).
pub fn perms_json(role: &str) -> Value {
    json!(perms(role))
}

/// Есть ли у роли возможность.
pub fn allows(role: &str, cap: &str) -> bool {
    match role_of(role) {
        "gm" => ALL.contains(&cap),
        "player" => PLAYER.contains(&cap),
        _ => false,
    }
}

/// HTTP/WS-проверка: 403 с понятным сообщением, если возможности нет.
pub fn require(role: &str, cap: &str) -> Result<(), AppError> {
    if allows(role, cap) {
        Ok(())
    } else {
        Err(AppError::forbidden(format!("Недостаточно прав: {cap}")))
    }
}

/// Участник кампании с проверкой возможности.
pub async fn require_cap(st: &AppState, cid: &str, uid: &str, cap: &str) -> ApiResult<Member> {
    let member = crate::api::campaigns::get_member(st, cid, uid).await?;
    require(&member.role, cap)?;
    Ok(member)
}

// ---- Правила WebSocket для элементов сцены ----

/// Что можно делать с существующим элементом сцены (`item_upsert`/`item_delete`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemWrite {
    /// Полная замена (мастер): layer/z/data как пришли.
    Full,
    /// Только игровые поля (x, y, w, h, rotation, hp, conditions, …) — владелец токена и лут:
    /// двигает и меняет размер своего токена, но не переименовывает и не скрывает его.
    PlayerFields,
    /// Нельзя ни менять, ни удалять.
    Deny,
}

/// Права на изменение существующего элемента сцены.
pub fn item_write(role: &str, old: &Value, user_id: &str) -> ItemWrite {
    if allows(role, TABLE_MOVE_ANY_TOKEN) {
        return if old["managed_loot"] == true {
            ItemWrite::PlayerFields
        } else {
            ItemWrite::Full
        };
    }
    if !allows(role, TABLE_MOVE_OWN_TOKEN) {
        return ItemWrite::Deny;
    }
    if old["owner_id"].as_str() == Some(user_id) {
        return ItemWrite::PlayerFields;
    }
    if old["loot"].as_bool().unwrap_or(false) {
        return ItemWrite::PlayerFields;
    }
    if old["editors"].as_array().map(|a| a.iter().any(|e| e.as_str() == Some(user_id))).unwrap_or(false) {
        return ItemWrite::PlayerFields;
    }
    ItemWrite::Deny
}

/// Права на создание элемента в слое.
/// layer_perms — (can_read, can_write, can_create) для роли на этом слое.
pub fn can_create_item(role: &str, layer: &str, data: &Value, user_id: &str, layer_can_create: bool) -> bool {
    if allows(role, TABLE_PLACE_ANY_CHARACTER) {
        return true;
    }
    if !allows(role, TABLE_PLACE_CHARACTER) {
        return false;
    }
    if !layer_can_create {
        return false;
    }
    if layer == "prop" && data["loot"].as_bool().unwrap_or(false) {
        return true;
    }
    // Владельца игрок задаёт только себе.
    match data.get("owner_id").and_then(|v| v.as_str()) {
        Some(owner) => owner == user_id,
        None => true,
    }
}

/// Можно ли читать слой (видеть элементы на нём).
pub fn layer_can_read(_role: &str, _layer: &str, layer_can_read: bool) -> bool {
    layer_can_read
}

/// Можно ли писать в слой (менять существующие элементы).
pub fn layer_can_write(_role: &str, _layer: &str, layer_can_write: bool) -> bool {
    layer_can_write
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps_of(role: &str) -> Vec<&'static str> {
        perms(role)
    }

    #[test]
    fn gm_has_every_capability_in_declaration_order() {
        assert_eq!(caps_of("gm"), ALL.to_vec());
        assert_eq!(ALL.len(), 18, "список возможностей изменился — обновите static/core/access.js");
        for cap in ALL {
            assert!(allows("gm", cap), "мастер без {cap}");
        }
    }

    #[test]
    fn player_has_only_the_documented_capabilities() {
        assert_eq!(caps_of("player"), vec![
            CAMPAIGN_READ, CHARACTER_READ_OWN, CHARACTER_READ_SHARED, CHARACTER_EDIT_OWN,
            TABLE_READ, TABLE_PLACE_CHARACTER, TABLE_MOVE_OWN_TOKEN,
        ]);
        for cap in [CAMPAIGN_MANAGE_MEMBERS, CAMPAIGN_MANAGE_CHARACTERS, CAMPAIGN_INVITE,
                    CHARACTER_EDIT_ANY, TABLE_PLACE_ANY_CHARACTER, TABLE_MOVE_ANY_TOKEN,
                    TABLE_MANAGE_SCENE, TABLE_MANAGE_FOG, TABLE_MANAGE_MEMBERS_TOKENS,
                    TABLE_MANAGE_ROLES, TABLE_MANAGE_LAYERS] {
            assert!(!allows("player", cap), "игрок получил {cap}");
        }
        assert!(allows("player", TABLE_READ), "игрок читает стол");
    }

    #[test]
    fn outsider_has_nothing() {
        for role in ["", "outsider", "guest", "GM", "Player"] {
            assert_eq!(caps_of(role), Vec::<&str>::new(), "роль {role:?} получила права");
            assert!(!allows(role, CAMPAIGN_READ));
            assert!(!allows(role, TABLE_READ));
            assert!(!is_gm(role));
        }
    }

    #[test]
    fn capability_list_has_no_duplicates_and_json_matches() {
        let mut seen = std::collections::HashSet::new();
        for cap in ALL {
            assert!(seen.insert(*cap), "дубликат возможности {cap}");
        }
        assert_eq!(perms_json("gm"), json!(ALL));
        assert_eq!(perms_json("player"), json!(PLAYER));
        assert_eq!(perms_json("nobody"), json!([]));
        assert_eq!(role_of("gm"), "gm");
        assert_eq!(role_of("player"), "player");
    }

    #[test]
    fn require_rejects_and_accepts_by_role() {
        assert!(require("gm", CAMPAIGN_MANAGE_MEMBERS).is_ok());
        assert!(require("player", CAMPAIGN_MANAGE_MEMBERS).is_err());
        let err = require("player", TABLE_MANAGE_FOG).unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::FORBIDDEN);
        assert!(err.1.contains(TABLE_MANAGE_FOG), "в ошибке видно, какой возможности не хватило");
        assert!(require("player", TABLE_READ).is_ok());
        assert!(require("outsider", TABLE_READ).is_err());
        assert!(require("player", "no.such.cap").is_err());
    }

    #[test]
    fn item_write_follows_owner_loot_and_gm_rules() {
        let own = json!({ "owner_id": "u1", "x": 10 });
        let foreign = json!({ "owner_id": "u2", "x": 10 });
        let loot = json!({ "loot": true, "owner_id": "u2" });
        let managed = json!({ "managed_loot": true, "owner_id": "u2" });
        let shared = json!({ "owner_id": "u2", "editors": ["u1"] });

        assert_eq!(item_write("gm", &own, "u1"), ItemWrite::Full);
        assert_eq!(item_write("gm", &foreign, "u1"), ItemWrite::Full);
        assert_eq!(item_write("gm", &managed, "u1"), ItemWrite::PlayerFields, "физический лут мастер не переписывает");
        assert_eq!(item_write("player", &own, "u1"), ItemWrite::PlayerFields);
        assert_eq!(item_write("player", &foreign, "u1"), ItemWrite::Deny, "чужой токен не двигается");
        assert_eq!(item_write("player", &loot, "u1"), ItemWrite::PlayerFields, "лут подбирает любой игрок");
        assert_eq!(item_write("player", &shared, "u1"), ItemWrite::PlayerFields, "соавтор токена");
        assert_eq!(item_write("outsider", &own, "u1"), ItemWrite::Deny);
    }

    #[test]
    fn can_create_item_respects_layer_permissions() {
        let own = json!({ "owner_id": "u1" });
        let foreign = json!({ "owner_id": "u2" });
        let anonymous = json!({});

        // Мастер всегда может создавать в любой слой.
        assert!(can_create_item("gm", "map", &foreign, "u1", true));
        assert!(can_create_item("gm", "prop", &foreign, "u1", true));

        // Игрок не может создавать в слой без права can_create.
        assert!(!can_create_item("player", "map", &anonymous, "u1", false));
        assert!(!can_create_item("player", "prop", &anonymous, "u1", false));

        // С правом can_create — может.
        assert!(can_create_item("player", "character", &own, "u1", true));
        assert!(can_create_item("player", "character", &anonymous, "u1", true));
        assert!(!can_create_item("player", "character", &foreign, "u1", true));
        assert!(can_create_item("player", "prop", &json!({ "loot": true }), "u1", true));
        assert!(can_create_item("player", "drawing", &anonymous, "u1", true));
        assert!(can_create_item("player", "text", &anonymous, "u1", true));
        assert!(!can_create_item("outsider", "character", &own, "u1", true));
    }
}
