//! Кампании, участники (мастер/игрок), ссылки-приглашения, история чата.
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, error::ApiResult, util, AppError, AppState};

pub struct Member { pub role: String }
impl Member { pub fn is_gm(&self) -> bool { self.role == "gm" } }

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
    let name = { let n = util::truncate(body.name.trim(), 128); if n.is_empty() { "Новая кампания".to_string() } else { n } };
    let now = util::now();
    sqlx::query("INSERT INTO campaigns (id, name, description, owner_id, active_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&cid).bind(&name).bind(&body.description).bind(&user.id).bind(&sid).bind(&now).execute(&st.db).await?;
    sqlx::query("INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, 'gm', ?)")
        .bind(&cid).bind(&user.id).bind(&now).execute(&st.db).await?;
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&sid).bind(&cid).bind("Первая сцена").bind(crate::scenes::default_grid().to_string()).bind(crate::scenes::default_fog().to_string()).bind(&now)
        .execute(&st.db).await?;
    let row = fetch_campaign(&st, &cid).await?;
    Ok(Json(campaign_json(&row, Some("gm"))))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let m = get_member(&st, &cid, &user.id).await?;
    let row = fetch_campaign(&st, &cid).await?;
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
        .bind(util::truncate(body.name.trim(), 128)).bind(&body.description).bind(&cid).execute(&st.db).await?;
    let row = fetch_campaign(&st, &cid).await?;
    Ok(Json(campaign_json(&row, Some("gm"))))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    let row = fetch_campaign(&st, &cid).await?;
    if row.get::<String, _>("owner_id") != user.id {
        return Err(AppError::forbidden("Удалить может только владелец"));
    }
    // SQLite/MySQL каскад по FK; на всякий случай чистим явно зависимые без FK-каскада
    sqlx::query("DELETE FROM campaigns WHERE id = ?").bind(&cid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ActiveSceneIn { pub scene_id: Option<String> }

async fn set_active_scene(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<ActiveSceneIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
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
    require_gm(&st, &cid, &user.id).await?;
    let body = body.map(|b| b.0).unwrap_or(InviteIn { role: player(), max_uses: 0 });
    let code = util::token(16);
    let role = norm_role(&body.role);
    sqlx::query("INSERT INTO invites (code, campaign_id, role, max_uses, uses, created_at) VALUES (?, ?, ?, ?, 0, ?)")
        .bind(&code).bind(&cid).bind(role).bind(body.max_uses).bind(util::now()).execute(&st.db).await?;
    Ok(Json(json!({ "code": code, "role": role, "url": format!("/join/{code}") })))
}

async fn list_invites(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    let rows = sqlx::query("SELECT * FROM invites WHERE campaign_id = ? ORDER BY created_at").bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| { let code: String = r.get("code"); json!({
        "code": code, "role": r.get::<String, _>("role"), "uses": r.get::<i64, _>("uses"), "max_uses": r.get::<i64, _>("max_uses"), "url": format!("/join/{code}")
    }) }).collect()))
}

async fn delete_invite(State(st): State<AppState>, user: AuthUser, Path((cid, code)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    sqlx::query("DELETE FROM invites WHERE code = ? AND campaign_id = ?").bind(&code).bind(&cid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RoleIn { pub role: String }

async fn set_role(State(st): State<AppState>, user: AuthUser, Path((cid, uid)): Path<(String, String)>, Json(body): Json<RoleIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    let c = fetch_campaign(&st, &cid).await?;
    if c.get::<String, _>("owner_id") == uid && body.role != "gm" {
        return Err(AppError::bad("Владелец всегда мастер"));
    }
    get_member(&st, &cid, &uid).await?;
    sqlx::query("UPDATE campaign_members SET role = ? WHERE campaign_id = ? AND user_id = ?").bind(norm_role(&body.role)).bind(&cid).bind(&uid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn kick(State(st): State<AppState>, user: AuthUser, Path((cid, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    if uid != user.id {
        require_gm(&st, &cid, &user.id).await?;
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
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query("SELECT m.id, m.user_id, m.kind, m.payload, m.created_at, u.name FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.campaign_id = ? ORDER BY m.id DESC LIMIT ?")
        .bind(&cid).bind(limit).fetch_all(&st.db).await?;
    let mut out: Vec<Value> = rows.iter().map(|r| json!({
        "id": r.get::<i64, _>("id"), "user_id": r.get::<String, _>("user_id"), "name": r.get::<String, _>("name"),
        "kind": r.get::<String, _>("kind"), "payload": util::json_value(&util::text(&r, "payload")), "at": r.get::<String, _>("created_at"),
    })).filter(|m_| m.is_gm() || !m_["payload"]["gm_only"].as_bool().unwrap_or(false)).collect();
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
