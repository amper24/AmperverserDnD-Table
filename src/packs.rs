//! Наборы (packs): пользовательские коллекции записей справочника.
//! Владелец создаёт набор, наполняет его записями, может сделать публичным и экспортировать в JSON.
//! Мастер подключает наборы к кампании — их записи появляются в справочнике стола.
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, campaigns::{get_member, require_gm}, compendium::CATEGORIES, error::ApiResult, util, AppError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/packs", get(list).post(create))
        .route("/api/packs/import", post(import))
        .route("/api/packs/:pid", get(get_one).patch(update).delete(delete_one))
        .route("/api/packs/:pid/export", get(export))
        .route("/api/campaigns/:cid/packs", get(campaign_packs))
        .route("/api/campaigns/:cid/packs/:pid", post(enable).delete(disable))
}

fn pack_json(r: &sqlx::any::AnyRow, extra: Value) -> Value {
    let mut v = json!({
        "id": r.get::<String, _>("id"), "owner_id": r.get::<String, _>("owner_id"), "name": r.get::<String, _>("name"),
        "description": util::text(r, "description"), "is_public": r.get::<i64, _>("is_public") != 0, "created_at": r.get::<String, _>("created_at"),
    });
    if let (Some(dst), Some(src)) = (v.as_object_mut(), extra.as_object()) {
        for (k, val) in src { dst.insert(k.clone(), val.clone()); }
    }
    v
}

async fn fetch(st: &AppState, pid: &str) -> ApiResult<sqlx::any::AnyRow> {
    sqlx::query("SELECT * FROM packs WHERE id = ?").bind(pid).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Набор не найден"))
}

pub async fn require_owner(st: &AppState, pid: &str, uid: &str) -> ApiResult<()> {
    let r = fetch(st, pid).await?;
    if r.get::<String, _>("owner_id") != uid {
        return Err(AppError::forbidden("Это не ваш набор"));
    }
    Ok(())
}

/// Наборы, доступные пользователю для чтения: свои, публичные, подключённые к кампании.
pub async fn can_read(st: &AppState, pid: &str, uid: &str) -> ApiResult<()> {
    let r = fetch(st, pid).await?;
    if r.get::<String, _>("owner_id") == uid || r.get::<i64, _>("is_public") != 0 {
        return Ok(());
    }
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM campaign_packs cp JOIN campaign_members m ON m.campaign_id = cp.campaign_id WHERE cp.pack_id = ? AND m.user_id = ?")
        .bind(pid).bind(uid).fetch_one(&st.db).await?.get("n");
    if n > 0 { Ok(()) } else { Err(AppError::forbidden("Нет доступа к набору")) }
}

#[derive(Deserialize)]
pub struct ListQuery { pub scope: Option<String>, pub q: Option<String> }

async fn list(State(st): State<AppState>, user: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let scope = q.scope.as_deref().unwrap_or("all");
    let mut sql = String::from("SELECT p.*, (SELECT COUNT(*) FROM compendium c WHERE c.pack_id = p.id) AS entries, u.name AS owner_name FROM packs p JOIN users u ON u.id = p.owner_id WHERE ");
    sql.push_str(match scope { "mine" => "p.owner_id = ?", "public" => "p.is_public = 1 AND p.owner_id <> ?", _ => "(p.owner_id = ? OR p.is_public = 1)" });
    if q.q.is_some() { sql.push_str(" AND LOWER(p.name) LIKE ?"); }
    sql.push_str(" ORDER BY p.created_at DESC LIMIT 500");
    let mut query = sqlx::query(&sql).bind(&user.id);
    if let Some(s) = &q.q { query = query.bind(format!("%{}%", s.to_lowercase())); }
    let rows = query.fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| pack_json(r, json!({ "entries": r.get::<i64, _>("entries"), "owner_name": r.get::<String, _>("owner_name"), "mine": r.get::<String, _>("owner_id") == user.id }))).collect()))
}

#[derive(Deserialize)]
pub struct PackIn { pub name: String, #[serde(default)] pub description: String, #[serde(default)] pub is_public: bool }

async fn create(State(st): State<AppState>, user: AuthUser, Json(body): Json<PackIn>) -> ApiResult<Json<Value>> {
    let id = util::uid();
    sqlx::query("INSERT INTO packs (id, owner_id, name, description, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&user.id).bind(util::truncate(body.name.trim(), 128)).bind(&body.description).bind(body.is_public as i64).bind(util::now()).execute(&st.db).await?;
    Ok(Json(pack_json(&fetch(&st, &id).await?, json!({ "entries": 0, "mine": true }))))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    can_read(&st, &pid, &user.id).await?;
    let r = fetch(&st, &pid).await?;
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM compendium WHERE pack_id = ?").bind(&pid).fetch_one(&st.db).await?.get("n");
    Ok(Json(pack_json(&r, json!({ "entries": n, "mine": r.get::<String, _>("owner_id") == user.id }))))
}

async fn update(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>, Json(body): Json<PackIn>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user.id).await?;
    sqlx::query("UPDATE packs SET name = ?, description = ?, is_public = ? WHERE id = ?")
        .bind(util::truncate(body.name.trim(), 128)).bind(&body.description).bind(body.is_public as i64).bind(&pid).execute(&st.db).await?;
    Ok(Json(pack_json(&fetch(&st, &pid).await?, json!({ "mine": true }))))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user.id).await?;
    sqlx::query("DELETE FROM compendium WHERE pack_id = ?").bind(&pid).execute(&st.db).await?;
    sqlx::query("DELETE FROM campaign_packs WHERE pack_id = ?").bind(&pid).execute(&st.db).await?;
    sqlx::query("DELETE FROM packs WHERE id = ?").bind(&pid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Экспорт набора в переносимый JSON.
async fn export(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    can_read(&st, &pid, &user.id).await?;
    let p = fetch(&st, &pid).await?;
    let rows = sqlx::query("SELECT category, slug, name, data FROM compendium WHERE pack_id = ? ORDER BY category, name").bind(&pid).fetch_all(&st.db).await?;
    Ok(Json(json!({
        "format": "amperverser-pack/1",
        "name": p.get::<String, _>("name"), "description": util::text(&p, "description"),
        "entries": rows.iter().map(|r| json!({ "category": r.get::<String, _>("category"), "slug": r.get::<String, _>("slug"), "name": r.get::<String, _>("name"), "data": util::json_value(&util::text(r, "data")) })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct ImportIn { pub name: Option<String>, #[serde(default)] pub description: String, #[serde(default)] pub entries: Vec<Value>, #[serde(default)] pub is_public: bool }

async fn import(State(st): State<AppState>, user: AuthUser, Json(body): Json<ImportIn>) -> ApiResult<Json<Value>> {
    let id = util::uid();
    let name = util::truncate(body.name.as_deref().unwrap_or("Импортированный набор").trim(), 128);
    sqlx::query("INSERT INTO packs (id, owner_id, name, description, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&user.id).bind(&name).bind(&body.description).bind(body.is_public as i64).bind(util::now()).execute(&st.db).await?;
    let mut count = 0;
    for e in body.entries.iter().take(5000) {
        let cat = e["category"].as_str().unwrap_or("");
        let Some(nm) = e["name"].as_str() else { continue };
        if !CATEGORIES.contains(&cat) { continue; }
        let slug = e["slug"].as_str().map(|s| s.to_string()).unwrap_or_else(|| crate::compendium::slugify(nm));
        sqlx::query("INSERT INTO compendium (id, campaign_id, pack_id, category, slug, name, source, data) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)")
            .bind(util::uid()).bind(&id).bind(cat).bind(util::truncate(&slug, 64)).bind(util::truncate(nm, 128)).bind(util::truncate(&name, 32)).bind(e["data"].to_string())
            .execute(&st.db).await?;
        count += 1;
    }
    Ok(Json(pack_json(&fetch(&st, &id).await?, json!({ "entries": count, "mine": true }))))
}

// ---- подключение к кампании ----
async fn campaign_packs(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    get_member(&st, &cid, &user.id).await?;
    let rows = sqlx::query("SELECT p.*, (SELECT COUNT(*) FROM compendium c WHERE c.pack_id = p.id) AS entries FROM campaign_packs cp JOIN packs p ON p.id = cp.pack_id WHERE cp.campaign_id = ? ORDER BY p.name")
        .bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| pack_json(r, json!({ "entries": r.get::<i64, _>("entries"), "mine": r.get::<String, _>("owner_id") == user.id }))).collect()))
}

async fn enable(State(st): State<AppState>, user: AuthUser, Path((cid, pid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    can_read(&st, &pid, &user.id).await?;
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM campaign_packs WHERE campaign_id = ? AND pack_id = ?").bind(&cid).bind(&pid).fetch_one(&st.db).await?.get("n");
    if n == 0 {
        sqlx::query("INSERT INTO campaign_packs (campaign_id, pack_id) VALUES (?, ?)").bind(&cid).bind(&pid).execute(&st.db).await?;
    }
    st.hub.broadcast(&cid, &json!({ "type": "packs_changed" }), None).await;
    Ok(Json(json!({ "ok": true })))
}

async fn disable(State(st): State<AppState>, user: AuthUser, Path((cid, pid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    sqlx::query("DELETE FROM campaign_packs WHERE campaign_id = ? AND pack_id = ?").bind(&cid).bind(&pid).execute(&st.db).await?;
    st.hub.broadcast(&cid, &json!({ "type": "packs_changed" }), None).await;
    Ok(Json(json!({ "ok": true })))
}
