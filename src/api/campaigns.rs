//! Кампании, участники (мастер/игрок), ссылки-приглашения, история чата,
//! собственные роли и права на слои.
use axum::{
    extract::{Path, Query, State},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{domain::access, api::auth::AuthUser, error::ApiResult, util, AppError, AppState};

pub struct Member { pub role: String }
impl Member {
    pub fn is_gm(&self) -> bool { self.role == "gm" }
    /// Возможности роли участника: системные роли — из констант, кастомные — из БД.
    pub async fn capabilities(st: &AppState, cid: &str, role: &str) -> Vec<String> {
        match role {
            "gm" => access::ALL.iter().map(|s| s.to_string()).collect(),
            "player" => access::PLAYER.iter().map(|s| s.to_string()).collect(),
            _ => {
                if let Ok(row) = sqlx::query("SELECT capabilities FROM campaign_roles WHERE campaign_id = ? AND name = ? AND is_system = 0")
                    .bind(cid).bind(role).fetch_optional(&st.db).await
                {
                    if let Some(r) = row {
                        let caps: String = r.get("capabilities");
                        serde_json::from_str::<Vec<String>>(&caps).unwrap_or_default()
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                }
            }
        }
    }
}

pub async fn get_member(st: &AppState, cid: &str, uid: &str) -> ApiResult<Member> {
    let row = sqlx::query("SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?")
        .bind(cid).bind(uid).fetch_optional(&st.db).await?;
    row.map(|r| Member { role: r.get("role") }).ok_or_else(|| AppError::forbidden("Вы не участник этой кампании"))
}

pub async fn require_gm(st: &AppState, cid: &str, uid: &str) -> ApiResult<Member> {
    let m = get_member(st, cid, uid).await?;
    if !m.is_gm() {
        return Err(AppError::forbidden("Только мастер может это делать"));
    }
    Ok(m)
}

fn campaign_json(r: &sqlx::any::AnyRow, role: Option<&str>) -> Value {
    json!({
        "id": r.get::<String, _>("id"),
        "name": r.get::<String, _>("name"),
        "description": util::text(&r, "description"),
        "owner_id": r.get::<String, _>("owner_id"),
        "active_scene_id": r.get::<Option<String>, _>("active_scene_id"),
        "role": role,
        // Права роли для UI: страница участников и стол гейтят действия по этому списку.
        "permissions": role.map(access::perms_json).unwrap_or_else(|| json!([])),
        "created_at": r.get::<String, _>("created_at"),
    })
}

async fn fetch_campaign(st: &AppState, cid: &str) -> ApiResult<sqlx::any::AnyRow> {
    sqlx::query("SELECT * FROM campaigns WHERE id = ?").bind(cid).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Кампания не найдена"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/campaigns", get(list).post(create))
        .route("/api/campaigns/:cid", get(get_one).patch(update).delete(delete_one))
        .route("/api/campaigns/:cid/active-scene", post(set_active_scene))
        // Собственные роли кампании
        .route("/api/campaigns/:cid/roles", get(list_roles).post(create_role))
        .route("/api/campaigns/:cid/roles/:rid", patch(update_role).delete(delete_role))
        // Права на слои для ролей
        .route("/api/campaigns/:cid/layer-permissions", get(list_layer_perms).patch(set_layer_perms))
        .route("/api/campaigns/:cid/invites", get(list_invites).post(create_invite))
        .route("/api/campaigns/:cid/invites/:code", axum::routing::delete(delete_invite))
        .route("/api/campaigns/:cid/members/:uid", axum::routing::patch(set_role).delete(kick))
        .route("/api/campaigns/:cid/chat", get(chat_history))
        .route("/api/join/:code", get(invite_info).post(join))
}

#[derive(Deserialize)]
pub struct CampaignIn { pub name: String, #[serde(default)] pub description: String }

async fn list(State(st): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT c.*, m.role AS member_role FROM campaigns c JOIN campaign_members m ON m.campaign_id = c.id WHERE m.user_id = ? ORDER BY c.created_at DESC")
        .bind(&user.id).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| { let role: String = r.get("member_role"); campaign_json(r, Some(&role)) }).collect()))
}

async fn create(State(st): State<AppState>, user: AuthUser, Json(body): Json<CampaignIn>) -> ApiResult<Json<Value>> {
    let cid = util::uid();
    let sid = util::uid();
    let name = { let n = util::trim_to(&body.name, 128); if n.is_empty() { "Новая кампания".to_string() } else { n } };
    let now = util::now();
    sqlx::query("INSERT INTO campaigns (id, name, description, owner_id, active_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&cid).bind(&name).bind(&body.description).bind(&user.id).bind(&sid).bind(&now).execute(&st.db).await?;
    sqlx::query("INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, 'gm', ?)")
        .bind(&cid).bind(&user.id).bind(&now).execute(&st.db).await?;
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&sid).bind(&cid).bind("Первая сцена").bind(crate::api::scenes::default_grid().to_string()).bind(crate::api::scenes::default_fog().to_string()).bind(&now)
        .execute(&st.db).await?;
    let row = fetch_campaign(&st, &cid).await?;
    Ok(Json(campaign_json(&row, Some("gm"))))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let row = sqlx::query("SELECT c.*, m.role AS member_role FROM campaigns c JOIN campaign_members m ON m.campaign_id = c.id AND m.user_id = ? WHERE c.id = ?")
        .bind(&user.id).bind(&cid).fetch_optional(&st.db).await?
        .ok_or_else(|| AppError::forbidden("Вы не участник этой кампании"))?;
    let m = Member { role: row.get("member_role") };
    access::require(&m.role, access::CAMPAIGN_READ)?;
    let members = sqlx::query("SELECT m.user_id, m.role, u.name, u.email, u.avatar_asset_id FROM campaign_members m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = ? ORDER BY m.joined_at")
        .bind(&cid).fetch_all(&st.db).await?;
    let mut out = campaign_json(&row, Some(&m.role));
    out["members"] = members.iter().map(|r| json!({
        "user_id": r.get::<String, _>("user_id"),
        "avatar_asset_id": r.get::<Option<String>, _>("avatar_asset_id"), "name": r.get::<String, _>("name"),
        "email": if m.is_gm() { Some(r.get::<String, _>("email")) } else { None },
        "role": r.get::<String, _>("role"),
    })).collect();
    Ok(Json(out))
}

async fn update(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<CampaignIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    sqlx::query("UPDATE campaigns SET name = ?, description = ? WHERE id = ?")
        .bind(util::trim_to(&body.name, 128)).bind(&body.description).bind(&cid).execute(&st.db).await?;
    let row = fetch_campaign(&st, &cid).await?;
    Ok(Json(campaign_json(&row, Some("gm"))))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let row = fetch_campaign(&st, &cid).await?;
    if row.get::<String, _>("owner_id") != user.id {
        return Err(AppError::forbidden("Удалить может только владелец"));
    }
    sqlx::query("DELETE FROM campaigns WHERE id = ?").bind(&cid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ActiveSceneIn { pub scene_id: Option<String> }

async fn set_active_scene(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<ActiveSceneIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_SCENE).await?;
    sqlx::query("UPDATE campaigns SET active_scene_id = ? WHERE id = ?").bind(&body.scene_id).bind(&cid).execute(&st.db).await?;
    st.hub.broadcast(&cid, &json!({ "type": "active_scene", "scene_id": body.scene_id }), None).await;
    Ok(Json(json!({ "ok": true })))
}

// ---- приглашения ----
#[derive(Deserialize)]
pub struct InviteIn { #[serde(default = "player")] pub role: String, #[serde(default)] pub max_uses: i64 }
fn player() -> String { "player".into() }
fn norm_role(r: &str) -> &'static str { if r == "gm" { "gm" } else { "player" } }

async fn create_invite(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, body: Option<Json<InviteIn>>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::CAMPAIGN_INVITE).await?;
    let body = body.map(|b| b.0).unwrap_or(InviteIn { role: player(), max_uses: 0 });
    let code = util::token(16);
    let role = norm_role(&body.role);
    sqlx::query("INSERT INTO invites (code, campaign_id, role, max_uses, uses, created_at) VALUES (?, ?, ?, ?, 0, ?)")
        .bind(&code).bind(&cid).bind(role).bind(body.max_uses).bind(util::now()).execute(&st.db).await?;
    Ok(Json(json!({ "code": code, "role": role, "url": format!("/join/{code}") })))
}

async fn list_invites(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::CAMPAIGN_INVITE).await?;
    let rows = sqlx::query("SELECT * FROM invites WHERE campaign_id = ? ORDER BY created_at").bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| { let code: String = r.get("code"); json!({
        "code": code, "role": r.get::<String, _>("role"), "uses": r.get::<i64, _>("uses"), "max_uses": r.get::<i64, _>("max_uses"), "url": format!("/join/{code}")
    }) }).collect()))
}

async fn delete_invite(State(st): State<AppState>, user: AuthUser, Path((cid, code)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::CAMPAIGN_INVITE).await?;
    sqlx::query("DELETE FROM invites WHERE code = ? AND campaign_id = ?").bind(&code).bind(&cid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RoleIn { pub role: String }

async fn set_role(State(st): State<AppState>, user: AuthUser, Path((cid, uid)): Path<(String, String)>, Json(body): Json<RoleIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::CAMPAIGN_MANAGE_MEMBERS).await?;
    let c = fetch_campaign(&st, &cid).await?;
    if c.get::<String, _>("owner_id") == uid && body.role != "gm" {
        return Err(AppError::bad("Владелец всегда мастер"));
    }
    get_member(&st, &cid, &uid).await?;
    sqlx::query("UPDATE campaign_members SET role = ? WHERE campaign_id = ? AND user_id = ?").bind(body.role).bind(&cid).bind(&uid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn kick(State(st): State<AppState>, user: AuthUser, Path((cid, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    if uid != user.id {
        access::require_cap(&st, &cid, &user.id, access::CAMPAIGN_MANAGE_MEMBERS).await?;
    }
    let c = fetch_campaign(&st, &cid).await?;
    if c.get::<String, _>("owner_id") == uid {
        return Err(AppError::bad("Владельца нельзя исключить"));
    }
    sqlx::query("DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?").bind(&cid).bind(&uid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ChatQuery { pub limit: Option<i64> }

async fn chat_history(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Query(q): Query<ChatQuery>) -> ApiResult<Json<Value>> {
    let m = get_member(&st, &cid, &user.id).await?;
    access::require(&m.role, access::CAMPAIGN_READ)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query("SELECT m.id, m.user_id, m.kind, m.payload, m.created_at, u.name FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = ? AND (m.kind NOT IN ('private_roll', 'private_multi') OR m.user_id = ?) ORDER BY m.id DESC LIMIT ?")
        .bind(&cid).bind(&user.id).bind(limit).fetch_all(&st.db).await?;
    let mut out: Vec<Value> = rows.iter().map(|r| {
        let stored_kind: String = r.get("kind");
        let kind = match stored_kind.as_str() { "private_roll" => "roll", "private_multi" => "multi", other => other };
        json!({
            "id": r.get::<i64, _>("id"), "user_id": r.get::<String, _>("user_id"), "name": r.get::<String, _>("name"),
            "kind": kind, "payload": util::json_value(&util::text(&r, "payload")), "at": r.get::<String, _>("created_at"),
        })
    }).filter(|m_| m.is_gm() || !m_["payload"]["gm_only"].as_bool().unwrap_or(false)).collect();
    out.reverse();
    Ok(Json(Value::Array(out)))
}

// ---- присоединение по ссылке ----
async fn invite_info(State(st): State<AppState>, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let inv = sqlx::query("SELECT i.role, c.id, c.name, c.description FROM invites i JOIN campaigns c ON c.id = i.campaign_id WHERE i.code = ?")
        .bind(&code).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Приглашение не найдено"))?;
    Ok(Json(json!({
        "campaign": { "id": inv.get::<String, _>("id"), "name": inv.get::<String, _>("name"), "description": util::text(&inv, "description") },
        "role": inv.get::<String, _>("role"),
    })))
}

async fn join(State(st): State<AppState>, user: AuthUser, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let inv = sqlx::query("SELECT campaign_id, role, max_uses, uses FROM invites WHERE code = ?").bind(&code).fetch_optional(&st.db).await?
        .ok_or_else(|| AppError::not_found("Приглашение не найдено"))?;
    let cid: String = inv.get("campaign_id");
    let max_uses: i64 = inv.get("max_uses");
    let uses: i64 = inv.get("uses");
    if max_uses > 0 && uses >= max_uses {
        return Err(AppError::bad("Приглашение исчерпано"));
    }
    if get_member(&st, &cid, &user.id).await.is_err() {
        sqlx::query("INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
            .bind(&cid).bind(&user.id).bind(inv.get::<String, _>("role")).bind(util::now()).execute(&st.db).await?;
        sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code = ?").bind(&code).execute(&st.db).await?;
    }
    Ok(Json(json!({ "ok": true, "campaign_id": cid })))
}

// ---- Собственные роли кампании ----
#[derive(Deserialize)]
pub struct RoleDefIn { pub name: String, #[serde(default)] pub description: String, #[serde(default)] pub capabilities: Vec<String> }

async fn list_roles(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_ROLES).await?;
    let rows = sqlx::query("SELECT id, name, description, capabilities, is_system, created_at FROM campaign_roles WHERE campaign_id = ? ORDER BY is_system DESC, name")
        .bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| {
        let caps: String = r.get("capabilities");
        json!({
            "id": r.get::<String, _>("id"),
            "name": r.get::<String, _>("name"),
            "description": util::text(&r, "description"),
            "capabilities": serde_json::from_str::<Vec<String>>(&caps).unwrap_or_default(),
            "is_system": r.get::<i64, _>("is_system") != 0,
            "created_at": r.get::<String, _>("created_at"),
        })
    }).collect()))
}

async fn create_role(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<RoleDefIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_ROLES).await?;
    let name = util::trim_to(&body.name, 64);
    if name.is_empty() { return Err(AppError::bad("Имя роли не может быть пустым")); }
    let exists: i64 = sqlx::query("SELECT COUNT(*) AS n FROM campaign_roles WHERE campaign_id = ? AND name = ?")
        .bind(&cid).bind(&name).fetch_one(&st.db).await?.get("n");
    if exists > 0 { return Err(AppError::bad("Роль с таким именем уже существует")); }
    let rid = util::uid();
    let now = util::now();
    let caps_json = serde_json::to_string(&body.capabilities).unwrap_or_else(|_| "[]".to_string());
    sqlx::query("INSERT INTO campaign_roles (id, campaign_id, name, description, capabilities, is_system, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .bind(&rid).bind(&cid).bind(&name).bind(&body.description).bind(&caps_json).bind(&now).execute(&st.db).await?;
    // Права на слои по умолчанию: все слои читать, запись/создание только на не-карт слоях.
    for &(lid, read, write, create) in access::DEFAULT_PLAYER_LAYER_PERMS {
        let lid2 = util::uid();
        sqlx::query("INSERT INTO layer_permissions (id, campaign_id, role_id, layer_id, can_read, can_write, can_create) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&lid2).bind(&cid).bind(&rid).bind(lid).bind(read as i64).bind(write as i64).bind(create as i64).execute(&st.db).await?;
    }
    Ok(Json(json!({ "id": rid, "ok": true })))
}

async fn update_role(State(st): State<AppState>, user: AuthUser, Path((cid, rid)): Path<(String, String)>, Json(body): Json<RoleDefIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_ROLES).await?;
    let row = sqlx::query("SELECT is_system FROM campaign_roles WHERE id = ? AND campaign_id = ?")
        .bind(&rid).bind(&cid).fetch_optional(&st.db).await?
        .ok_or_else(|| AppError::not_found("Роль не найдена"))?;
    if row.get::<i64, _>("is_system") != 0 {
        return Err(AppError::bad("Системную роль нельзя редактировать"));
    }
    let name = util::trim_to(&body.name, 64);
    if name.is_empty() { return Err(AppError::bad("Имя роли не может быть пустым")); }
    let caps_json = serde_json::to_string(&body.capabilities).unwrap_or_else(|_| "[]".to_string());
    sqlx::query("UPDATE campaign_roles SET name = ?, description = ?, capabilities = ? WHERE id = ? AND campaign_id = ?")
        .bind(&name).bind(&body.description).bind(&caps_json).bind(&rid).bind(&cid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_role(State(st): State<AppState>, user: AuthUser, Path((cid, rid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_ROLES).await?;
    let row = sqlx::query("SELECT is_system FROM campaign_roles WHERE id = ? AND campaign_id = ?")
        .bind(&rid).bind(&cid).fetch_optional(&st.db).await?
        .ok_or_else(|| AppError::not_found("Роль не найдена"))?;
    if row.get::<i64, _>("is_system") != 0 {
        return Err(AppError::bad("Системную роль нельзя удалить"));
    }
    // Перевести участников этой роли на player.
    sqlx::query("UPDATE campaign_members SET role = 'player' WHERE campaign_id = ? AND role = (SELECT name FROM campaign_roles WHERE id = ? AND campaign_id = ?)")
        .bind(&cid).bind(&rid).bind(&cid).execute(&st.db).await?;
    sqlx::query("DELETE FROM layer_permissions WHERE campaign_id = ? AND role_id = ?").bind(&cid).bind(&rid).execute(&st.db).await?;
    sqlx::query("DELETE FROM campaign_roles WHERE id = ? AND campaign_id = ?").bind(&rid).bind(&cid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---- Права на слои ----
fn default_true() -> bool { true }

#[derive(Deserialize)]
pub struct LayerPermIn {
    pub role_id: String,
    pub layer_id: String,
    #[serde(default = "default_true")]
    pub can_read: bool,
    #[serde(default)]
    pub can_write: bool,
    #[serde(default)]
    pub can_create: bool,
}

/// Матрица «роль × слой». Читают её все участники кампании (`table.read`): по ней клиент
/// решает, какие слои показывать и какие двигать, — иначе права своих ролей на столе
/// не применялись бы. Менять матрицу по-прежнему может только `table.manage_roles`.
async fn list_layer_perms(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_READ).await?;
    let rows = sqlx::query("SELECT lp.role_id, r.name AS role_name, lp.layer_id, lp.can_read, lp.can_write, lp.can_create FROM layer_permissions lp JOIN campaign_roles r ON r.id = lp.role_id WHERE lp.campaign_id = ? ORDER BY r.name, lp.layer_id")
        .bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| json!({
        "role_id": r.get::<String, _>("role_id"),
        "role_name": r.get::<String, _>("role_name"),
        "layer_id": r.get::<String, _>("layer_id"),
        "can_read": r.get::<i64, _>("can_read") != 0,
        "can_write": r.get::<i64, _>("can_write") != 0,
        "can_create": r.get::<i64, _>("can_create") != 0,
    })).collect()))
}

async fn set_layer_perms(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<LayerPermIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_ROLES).await?;
    let role_row = sqlx::query("SELECT is_system FROM campaign_roles WHERE id = ? AND campaign_id = ?")
        .bind(&body.role_id).bind(&cid).fetch_optional(&st.db).await?
        .ok_or_else(|| AppError::not_found("Роль не найдена"))?;
    if role_row.get::<i64, _>("is_system") != 0 {
        return Err(AppError::bad("Права системной роли нельзя менять через этот endpoint"));
    }
    let existing: Option<String> = sqlx::query("SELECT id FROM layer_permissions WHERE campaign_id = ? AND role_id = ? AND layer_id = ?")
        .bind(&cid).bind(&body.role_id).bind(&body.layer_id).fetch_optional(&st.db).await.ok().flatten()
        .map(|r| r.get("id"));
    match existing {
        Some(id) => {
            sqlx::query("UPDATE layer_permissions SET can_read = ?, can_write = ?, can_create = ? WHERE id = ?")
                .bind(body.can_read as i64).bind(body.can_write as i64).bind(body.can_create as i64).bind(&id).execute(&st.db).await?;
        }
        None => {
            sqlx::query("INSERT INTO layer_permissions (id, campaign_id, role_id, layer_id, can_read, can_write, can_create) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(&util::uid()).bind(&cid).bind(&body.role_id).bind(&body.layer_id).bind(body.can_read as i64).bind(body.can_write as i64).bind(body.can_create as i64).execute(&st.db).await?;
        }
    }
    Ok(Json(json!({ "ok": true })))
}
