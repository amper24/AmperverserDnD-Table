//! Сцены (бесконечный холст с картой, сеткой, туманом) и их элементы.
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, campaigns::{get_member, require_gm}, error::ApiResult, util, AppError, AppState};

pub fn default_grid() -> Value { json!({ "size": 70, "type": "square", "visible": true, "color": "#00000055", "scale": "5 фт" }) }
pub fn default_fog() -> Value { json!({ "enabled": false, "shapes": [] }) }

pub fn scene_json(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "campaign_id": r.get::<String, _>("campaign_id"), "name": r.get::<String, _>("name"),
        "grid": util::json_value(&util::text(&r, "grid")), "fog": util::json_value(&util::text(&r, "fog")),
    })
}

pub fn item_json(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "scene_id": r.get::<String, _>("scene_id"), "layer": r.get::<String, _>("layer"),
        "z": r.get::<i64, _>("z"), "data": util::json_value(&util::text(&r, "data")),
    })
}

pub async fn fetch_scene(st: &AppState, cid: &str, sid: &str) -> ApiResult<sqlx::any::AnyRow> {
    sqlx::query("SELECT * FROM scenes WHERE id = ? AND campaign_id = ?").bind(sid).bind(cid).fetch_optional(&st.db).await?
        .ok_or_else(|| AppError::not_found("Сцена не найдена"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/campaigns/:cid/scenes", get(list).post(create))
        .route("/api/campaigns/:cid/scenes/:sid", get(get_one).patch(update).delete(delete_one))
        .route("/api/campaigns/:cid/scenes/:sid/duplicate", post(duplicate))
}

#[derive(Deserialize)]
pub struct SceneIn { pub name: Option<String>, pub grid: Option<Value> }

async fn list(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    get_member(&st, &cid, &user.id).await?;
    let rows = sqlx::query("SELECT * FROM scenes WHERE campaign_id = ? ORDER BY created_at").bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(scene_json).collect()))
}

async fn create(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<SceneIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    let sid = util::uid();
    let name = body.name.unwrap_or_else(|| "Новая сцена".into());
    let grid = body.grid.unwrap_or_else(default_grid);
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&sid).bind(&cid).bind(util::truncate(&name, 128)).bind(grid.to_string()).bind(default_fog().to_string()).bind(util::now()).execute(&st.db).await?;
    Ok(Json(scene_json(&fetch_scene(&st, &cid, &sid).await?)))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path((cid, sid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let m = get_member(&st, &cid, &user.id).await?;
    let s = fetch_scene(&st, &cid, &sid).await?;
    let rows = sqlx::query("SELECT * FROM scene_items WHERE scene_id = ? ORDER BY z").bind(&sid).fetch_all(&st.db).await?;
    let items: Vec<Value> = rows.iter().map(item_json)
        .filter(|it| m.is_gm() || !it["data"]["hidden"].as_bool().unwrap_or(false))
        .collect();
    let mut out = scene_json(&s);
    out["items"] = Value::Array(items);
    Ok(Json(out))
}

async fn update(State(st): State<AppState>, user: AuthUser, Path((cid, sid)): Path<(String, String)>, Json(body): Json<SceneIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    let s = fetch_scene(&st, &cid, &sid).await?;
    let name = body.name.map(|n| util::truncate(&n, 128)).unwrap_or_else(|| s.get::<String, _>("name"));
    let grid = body.grid.map(|g| g.to_string()).unwrap_or_else(|| util::text(&s, "grid"));
    sqlx::query("UPDATE scenes SET name = ?, grid = ? WHERE id = ?").bind(&name).bind(&grid).bind(&sid).execute(&st.db).await?;
    st.hub.broadcast(&cid, &json!({ "type": "scene_update", "scene_id": sid, "grid": util::json_value(&grid), "name": name }), None).await;
    Ok(Json(scene_json(&fetch_scene(&st, &cid, &sid).await?)))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path((cid, sid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    fetch_scene(&st, &cid, &sid).await?;
    sqlx::query("UPDATE campaigns SET active_scene_id = NULL WHERE id = ? AND active_scene_id = ?").bind(&cid).bind(&sid).execute(&st.db).await?;
    sqlx::query("DELETE FROM scene_items WHERE scene_id = ?").bind(&sid).execute(&st.db).await?;
    sqlx::query("DELETE FROM scenes WHERE id = ?").bind(&sid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn duplicate(State(st): State<AppState>, user: AuthUser, Path((cid, sid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    let s = fetch_scene(&st, &cid, &sid).await?;
    let nid = util::uid();
    let name = format!("{} (копия)", s.get::<String, _>("name"));
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&nid).bind(&cid).bind(&name).bind(util::text(&s, "grid")).bind(util::text(&s, "fog")).bind(util::now()).execute(&st.db).await?;
    let items = sqlx::query("SELECT * FROM scene_items WHERE scene_id = ?").bind(&sid).fetch_all(&st.db).await?;
    for it in items {
        sqlx::query("INSERT INTO scene_items (id, scene_id, layer, z, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(util::uid()).bind(&nid).bind(it.get::<String, _>("layer")).bind(it.get::<i64, _>("z")).bind(util::text(&it, "data")).bind(util::now())
            .execute(&st.db).await?;
    }
    Ok(Json(scene_json(&fetch_scene(&st, &cid, &nid).await?)))
}
