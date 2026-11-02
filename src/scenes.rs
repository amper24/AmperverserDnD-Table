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

/// Слои по умолчанию (как LAYER_ORDER на клиенте): id прежних слоёв, порядок — порядок отрисовки.
pub fn default_layers() -> Value {
    json!([
        { "id": "map", "name": "Карта", "order": 0, "hidden": false, "locked": false },
        { "id": "prop", "name": "Объекты", "order": 1, "hidden": false, "locked": false },
        { "id": "mount", "name": "Ездовые", "order": 2, "hidden": false, "locked": false },
        { "id": "character", "name": "Персонажи", "order": 3, "hidden": false, "locked": false },
        { "id": "attachment", "name": "Прикреплённые", "order": 4, "hidden": false, "locked": false },
        { "id": "drawing", "name": "Рисунки", "order": 5, "hidden": false, "locked": false },
        { "id": "text", "name": "Текст", "order": 6, "hidden": false, "locked": false },
        { "id": "note", "name": "Заметки", "order": 7, "hidden": false, "locked": false },
    ])
}

/// Валидация `scene.layers` с клиента: массив до 32 записей {id,name,order,hidden?,locked?}.
/// id — [a-z0-9_-], до 32 символов, уникальные; order пересчитывается по порядку.
/// Возвращает нормализованный массив или None, если вход битый (тогда сцена не меняется).
pub fn normalize_layers(v: &Value) -> Option<Value> {
    let arr = v.as_array()?;
    if arr.is_empty() || arr.len() > 32 {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<(i64, Value)> = Vec::new();
    for (i, e) in arr.iter().enumerate() {
        let id = e.get("id")?.as_str()?.trim().to_lowercase();
        if id.is_empty() || id.len() > 32 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return None;
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        let name: String = e.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().chars().take(64).collect();
        let order = e.get("order").and_then(|o| o.as_i64()).unwrap_or(i as i64);
        out.push((order, json!({
            "id": id,
            "name": if name.is_empty() { id.clone() } else { name },
            "order": order,
            "hidden": e.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false),
            "locked": e.get("locked").and_then(|l| l.as_bool()).unwrap_or(false),
        })));
    }
    if out.is_empty() {
        return None;
    }
    out.sort_by_key(|(order, _)| *order);
    let list: Vec<Value> = out.into_iter().enumerate().map(|(i, (_, mut layer))| { layer["order"] = json!(i as i64); layer }).collect();
    Some(Value::Array(list))
}

/// id активной карты из строки сцены: пусто/NULL — активная не выбрана.
fn active_map_id_of(r: &sqlx::any::AnyRow) -> Value {
    let id = util::text(r, "active_map_id");
    if id.is_empty() { Value::Null } else { json!(id) }
}

pub fn scene_json(r: &sqlx::any::AnyRow) -> Value {
    // layers/active_map_id могут быть NULL (старые сцены) — клиент берёт слои по умолчанию.
    let layers_raw = util::text(r, "layers");
    let layers = if layers_raw.trim().is_empty() { Value::Null } else { util::json_value(&layers_raw) };
    json!({
        "id": r.get::<String, _>("id"), "campaign_id": r.get::<String, _>("campaign_id"), "name": r.get::<String, _>("name"),
        "grid": util::json_value(&util::text(r, "grid")), "fog": util::json_value(&util::text(r, "fog")),
        "layers": layers, "active_map_id": active_map_id_of(r),
    })
}

pub fn item_json(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "scene_id": r.get::<String, _>("scene_id"), "layer": r.get::<String, _>("layer"),
        "z": r.get::<i64, _>("z"), "data": util::json_value(&util::text(r, "data")),
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
pub struct SceneIn {
    pub name: Option<String>,
    pub grid: Option<Value>,
    pub layers: Option<Value>,
    /// Активная карта: отсутствие ключа — не менять, `null` — очистить, строка — задать.
    /// Option<Option<Value>> нужен, чтобы отличить `null` от отсутствующего поля.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub active_map_id: Option<Option<Value>>,
}

fn deserialize_double_option<'de, D>(de: D) -> Result<Option<Option<Value>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<Value>::deserialize(de)?))
}

impl SceneIn {
    /// Валидные слои из тела запроса (None — не менять/по умолчанию).
    fn layers_json(&self) -> Option<String> { self.layers.as_ref().and_then(normalize_layers).map(|v| v.to_string()) }
    /// Активная карта из тела: Some(None) — очистить, Some(Some(id)) — задать, None — не менять.
    fn map_id(&self) -> Option<Option<String>> {
        match self.active_map_id.as_ref() {
            None => None,
            Some(None) => Some(None),
            Some(Some(v)) => v.as_str().filter(|s| !s.is_empty() && s.len() <= 32).map(|s| Some(s.to_string())),
        }
    }
}

async fn list(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    get_member(&st, &cid, &user.id).await?;
    let rows = sqlx::query("SELECT * FROM scenes WHERE campaign_id = ? ORDER BY created_at").bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(scene_json).collect()))
}

async fn create(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<SceneIn>) -> ApiResult<Json<Value>> {
    require_gm(&st, &cid, &user.id).await?;
    let sid = util::uid();
    // Сначала валидируем необязательные поля (заимствуют body), потом забираем имя/сетку.
    let layers = body.layers_json().unwrap_or_else(|| default_layers().to_string());
    let map_id = body.map_id().flatten();
    let name = body.name.unwrap_or_else(|| "Новая сцена".into());
    let grid = body.grid.unwrap_or_else(default_grid);
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, layers, active_map_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&sid).bind(&cid).bind(util::truncate(&name, 128)).bind(grid.to_string()).bind(default_fog().to_string())
        .bind(&layers).bind(&map_id).bind(util::now()).execute(&st.db).await?;
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
    let layers_in = body.layers_json();
    let map_in = body.map_id();
    let name = body.name.map(|n| util::truncate(&n, 128)).unwrap_or_else(|| s.get::<String, _>("name"));
    let grid = body.grid.map(|g| g.to_string()).unwrap_or_else(|| util::text(&s, "grid"));
    let layers = layers_in.unwrap_or_else(|| util::text(&s, "layers"));
    let map_id = match map_in {
        Some(v) => v,
        None => { let cur = util::text(&s, "active_map_id"); if cur.is_empty() { None } else { Some(cur) } }
    };
    sqlx::query("UPDATE scenes SET name = ?, grid = ?, layers = ?, active_map_id = ? WHERE id = ?")
        .bind(&name).bind(&grid).bind(&layers).bind(&map_id).bind(&sid).execute(&st.db).await?;
    let mut out = json!({ "type": "scene_update", "scene_id": sid, "grid": util::json_value(&grid), "name": name });
    // Битые слои не рассылаем: у клиентов остаётся прежний список.
    if let Some(v) = normalize_layers(&util::json_value(&layers)) { out["layers"] = v; }
    out["active_map_id"] = map_id.map(|v| json!(v)).unwrap_or(Value::Null);
    st.hub.broadcast(&cid, &out, None).await;
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
    let layers = util::text(&s, "layers");
    // Элементы копируются с новыми id, поэтому активная карта исходной сцены к копии не относится.
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, layers, active_map_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&nid).bind(&cid).bind(&name).bind(util::text(&s, "grid")).bind(util::text(&s, "fog"))
        .bind(if layers.trim().is_empty() { None } else { Some(layers) })
        .bind(None::<String>)
        .bind(util::now()).execute(&st.db).await?;
    let items = sqlx::query("SELECT * FROM scene_items WHERE scene_id = ?").bind(&sid).fetch_all(&st.db).await?;
    for it in items {
        // Physical inventory loot is not copied along with the scene template.
        if util::json_value(&util::text(&it, "data"))["managed_loot"] == true { continue; }
        // Элементы копируются с новыми id — активная карта копии на них уже не указывает.
        sqlx::query("INSERT INTO scene_items (id, scene_id, layer, z, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(util::uid()).bind(&nid).bind(it.get::<String, _>("layer")).bind(it.get::<i64, _>("z")).bind(util::text(&it, "data")).bind(util::now())
            .execute(&st.db).await?;
    }
    Ok(Json(scene_json(&fetch_scene(&st, &cid, &nid).await?)))
}

#[cfg(test)]
mod layer_tests {
    use super::*;

    #[test]
    fn default_layers_keep_the_old_layer_order() {
        let ids: Vec<String> = default_layers().as_array().unwrap().iter().map(|l| l["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["map", "prop", "mount", "character", "attachment", "drawing", "text", "note"]);
        let orders: Vec<i64> = default_layers().as_array().unwrap().iter().map(|l| l["order"].as_i64().unwrap()).collect();
        assert_eq!(orders, (0..8).collect::<Vec<i64>>());
    }

    #[test]
    fn normalize_layers_accepts_custom_layers_and_reorders_them() {
        let raw = json!([
            { "id": "Character", "name": "Герои", "order": 5, "hidden": true },
            { "id": "custom-1", "name": "  Декорации  ", "order": 1, "locked": true },
            { "id": "custom-2", "order": 1 },
        ]);
        let out = normalize_layers(&raw).expect("valid layers");
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["id"], "custom-1");
        assert_eq!(arr[0]["order"], 0);
        assert_eq!(arr[0]["name"], "Декорации");
        assert_eq!(arr[0]["locked"], true);
        assert_eq!(arr[1]["id"], "custom-2");
        assert_eq!(arr[1]["name"], "custom-2", "имя по умолчанию — id");
        assert_eq!(arr[2]["id"], "character", "id приводится к нижнему регистру");
        assert_eq!(arr[2]["hidden"], true);
        assert_eq!(arr[2]["order"], 2);
    }

    #[test]
    fn normalize_layers_rejects_broken_input() {
        let long_id = "a".repeat(33);
        for bad in [json!(null), json!([]), json!("map"), json!([{ "name": "без id" }]), json!([{ "id": "../etc" }]), json!([{ "id": long_id }])] {
            assert!(normalize_layers(&bad).is_none(), "accepted {bad}");
        }
        // Дубликаты id схлопываются, а не ломают весь список.
        let dup = normalize_layers(&json!([{ "id": "map" }, { "id": "map", "name": "вторая" }])).unwrap();
        assert_eq!(dup.as_array().unwrap().len(), 1);
    }

    #[test]
    fn scene_input_clears_or_sets_the_active_map() {
        let cleared: SceneIn = serde_json::from_value(json!({ "active_map_id": null })).unwrap();
        assert_eq!(cleared.map_id(), Some(None));
        let set: SceneIn = serde_json::from_value(json!({ "active_map_id": "abc123" })).unwrap();
        assert_eq!(set.map_id(), Some(Some("abc123".into())));
        let untouched: SceneIn = serde_json::from_value(json!({})).unwrap();
        assert_eq!(untouched.map_id(), None);
        let broken: SceneIn = serde_json::from_value(json!({ "active_map_id": "x".repeat(40) })).unwrap();
        assert_eq!(broken.map_id(), None, "слишком длинный id игнорируется");
    }
}
