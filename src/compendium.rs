//! Справочник: расы, классы, предыстории, предметы, заклинания, монстры, черты, состояния.
//! Базовый набор (SRD) + собственные записи мастера в рамках кампании (homebrew).
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, campaigns::{get_member, require_gm}, error::ApiResult, util, AppError, AppState};

pub const CATEGORIES: &[&str] = &["race", "class", "background", "item", "spell", "monster", "feat", "condition"];

fn entry_json(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "category": r.get::<String, _>("category"), "slug": r.get::<String, _>("slug"), "name": r.get::<String, _>("name"),
        "source": r.get::<String, _>("source"), "campaign_id": r.get::<Option<String>, _>("campaign_id"), "data": util::json_value(&r.get::<String, _>("data")),
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/compendium/categories", get(|| async { Json(json!(CATEGORIES)) }))
        .route("/api/compendium", get(search).post(create))
        .route("/api/compendium/:id", get(get_one).patch(update).delete(delete_one))
}

#[derive(Deserialize)]
pub struct SearchQuery { pub category: Option<String>, pub q: Option<String>, pub campaign_id: Option<String>, pub limit: Option<i64> }

async fn search(State(st): State<AppState>, user: AuthUser, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let mut sql = String::from("SELECT * FROM compendium WHERE (campaign_id IS NULL");
    if let Some(cid) = &q.campaign_id {
        get_member(&st, cid, &user.id).await?;
        sql.push_str(" OR campaign_id = ?");
    }
    sql.push(')');
    if q.category.is_some() { sql.push_str(" AND category = ?"); }
    let pattern = q.q.as_ref().map(|s| format!("%{}%", s.to_lowercase()));
    if pattern.is_some() { sql.push_str(" AND LOWER(name) LIKE ?"); }
    sql.push_str(" ORDER BY category, name LIMIT ?");
    let mut query = sqlx::query(&sql);
    if let Some(cid) = &q.campaign_id { query = query.bind(cid); }
    if let Some(c) = &q.category { query = query.bind(c); }
    if let Some(p) = &pattern { query = query.bind(p); }
    query = query.bind(q.limit.unwrap_or(200).clamp(1, 1000));
    let rows = query.fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(entry_json).collect()))
}

async fn get_one(State(st): State<AppState>, _user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("SELECT * FROM compendium WHERE id = ?").bind(&id).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Запись не найдена"))?;
    Ok(Json(entry_json(&r)))
}

#[derive(Deserialize)]
pub struct EntryIn { pub category: String, pub name: String, #[serde(default)] pub data: Value, pub campaign_id: String }

fn slugify(name: &str) -> String {
    util::truncate(&name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-"), 64)
}

async fn create(State(st): State<AppState>, user: AuthUser, Json(body): Json<EntryIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &body.campaign_id, &user.id).await?;
    if !CATEGORIES.contains(&body.category.as_str()) {
        return Err(AppError::bad("Неизвестная категория"));
    }
    let id = util::uid();
    sqlx::query("INSERT INTO compendium (id, campaign_id, category, slug, name, source, data) VALUES (?, ?, ?, ?, ?, 'Homebrew', ?)")
        .bind(&id).bind(&body.campaign_id).bind(&body.category).bind(slugify(&body.name)).bind(util::truncate(&body.name, 128)).bind(body.data.to_string())
        .execute(&st.db).await?;
    let r = sqlx::query("SELECT * FROM compendium WHERE id = ?").bind(&id).fetch_one(&st.db).await?;
    Ok(Json(entry_json(&r)))
}

async fn owned_homebrew(st: &AppState, id: &str, user: &AuthUser) -> ApiResult<()> {
    let r = sqlx::query("SELECT campaign_id FROM compendium WHERE id = ?").bind(id).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Запись не найдена"))?;
    let cid: Option<String> = r.get("campaign_id");
    let cid = cid.ok_or_else(|| AppError::not_found("Базовые записи нельзя менять"))?;
    require_gm(st, &cid, &user.id).await?;
    Ok(())
}

async fn update(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<EntryIn>) -> ApiResult<Json<Value>> {
    owned_homebrew(&st, &id, &user).await?;
    if !CATEGORIES.contains(&body.category.as_str()) {
        return Err(AppError::bad("Неизвестная категория"));
    }
    sqlx::query("UPDATE compendium SET name = ?, data = ?, category = ?, slug = ? WHERE id = ?")
        .bind(util::truncate(&body.name, 128)).bind(body.data.to_string()).bind(&body.category).bind(slugify(&body.name)).bind(&id).execute(&st.db).await?;
    let r = sqlx::query("SELECT * FROM compendium WHERE id = ?").bind(&id).fetch_one(&st.db).await?;
    Ok(Json(entry_json(&r)))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    owned_homebrew(&st, &id, &user).await?;
    sqlx::query("DELETE FROM compendium WHERE id = ?").bind(&id).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}
