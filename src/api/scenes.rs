//! Сцены (бесконечный холст с картой, сеткой, туманом) и их элементы.
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{domain::access, api::auth::AuthUser, api::campaigns::get_member, error::ApiResult, util, AppError, AppState};

pub fn default_grid() -> Value { json!({ "size": 70, "type": "square", "visible": true, "color": "#00000055", "scale": "5 фт" }) }
/// Туман войны хранится бинарной растровой маской на карту:
/// by_map = { "<id карты>": { x, y, cell, cols, rows, data: [[0|100, …], …] } }.
/// 100 — клетка открыта, 0 — скрыта; записи нет (или она вся из 0) — карта полностью скрыта.
/// Старый векторный формат (shapes) клиент растеризует в маску при загрузке.
pub fn default_fog() -> Value { json!({ "enabled": false, "by_map": {} }) }

pub const FOG_MAX_DIM: usize = 512;   // предел cols/rows маски (столько же на клиенте)
pub const FOG_MAX_MAP_ID: usize = 64;
const FOG_MAX_COORD: f64 = 1e7;
const FOG_MIN_CELL: f64 = 1.0;
const FOG_MAX_CELL: f64 = 10000.0;

/// Координата/размер маски: конечное число в разумных пределах.
fn fog_coord(v: f64) -> Option<f64> { if v.is_finite() && v.abs() <= FOG_MAX_COORD { Some(v) } else { None } }
/// Целые числа пишем целыми — JSON маски остаётся компактным.
fn fog_number(v: f64) -> Value { if v.fract() == 0.0 { json!(v as i64) } else { json!(v) } }

/// Бинарная растровая маска карты из произвольного JSON. None — маска битая или вся из 0
/// (такую запись не храним: нет записи = карта полностью скрыта).
fn normalize_mask(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let x = fog_coord(obj.get("x")?.as_f64()?)?;
    let y = fog_coord(obj.get("y")?.as_f64()?)?;
    let cell = obj.get("cell")?.as_f64()?;
    if !(FOG_MIN_CELL..=FOG_MAX_CELL).contains(&cell) { return None; }
    let cols = obj.get("cols")?.as_u64()? as usize;
    let rows = obj.get("rows")?.as_u64()? as usize;
    if cols == 0 || rows == 0 || cols > FOG_MAX_DIM || rows > FOG_MAX_DIM { return None; }
    let data_in = obj.get("data")?.as_array()?;
    if data_in.len() != rows { return None; }
    let mut all_zero = true;
    let mut data = Vec::with_capacity(rows);
    for row_in in data_in {
        let row_in = row_in.as_array()?;
        if row_in.len() != cols { return None; }
        let mut row = Vec::with_capacity(cols);
        for v in row_in {
            let b = if v.as_i64() == Some(100) { 100 } else { 0 }; // строго 0/100, прочее → 0
            if b == 100 { all_zero = false; }
            row.push(json!(b));
        }
        data.push(Value::Array(row));
    }
    if all_zero { return None; }
    Some(json!({ "x": fog_number(x), "y": fog_number(y), "cell": fog_number(cell), "cols": cols, "rows": rows, "data": data }))
}

/// Валидация `scene.fog` с клиента. None — это не новый формат (fog не меняем):
/// старый векторный shapes сервер не читает, его растеризует клиент при загрузке.
pub fn normalize_fog(v: &Value) -> Option<Value> {
    let obj = v.as_object()?;
    let by_map = obj.get("by_map")?.as_object()?;
    let mut out = serde_json::Map::new();
    for (id, mask) in by_map {
        // id карты — до 64 символов; битые/нулевые маски просто не рассылаем.
        if id.is_empty() || id.len() > FOG_MAX_MAP_ID {
            continue;
        }
        if let Some(m) = normalize_mask(mask) {
            out.insert(id.clone(), m);
        }
    }
    Some(json!({
        "enabled": obj.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false),
        "by_map": Value::Object(out),
    }))
}

/// Оставить в маске только существующие карты сцены (чужой/устаревший id отбрасывается).
pub fn restrict_fog_to_maps(fog: &Value, map_ids: &[String]) -> Value {
    let enabled = fog.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
    let mut out = serde_json::Map::new();
    if let Some(by_map) = fog.get("by_map").and_then(|b| b.as_object()) {
        for (id, mask) in by_map {
            if map_ids.iter().any(|m| m == id) {
                out.insert(id.clone(), mask.clone());
            }
        }
    }
    json!({ "enabled": enabled, "by_map": Value::Object(out) })
}

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
        if !util::short_id(&id) || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
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
            Some(Some(v)) => v.as_str().filter(|s| util::short_id(s)).map(|s| Some(s.to_string())),
        }
    }
}

async fn list(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_READ).await?;
    let rows = sqlx::query("SELECT * FROM scenes WHERE campaign_id = ? ORDER BY created_at").bind(&cid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(scene_json).collect()))
}

async fn create(State(st): State<AppState>, user: AuthUser, Path(cid): Path<String>, Json(body): Json<SceneIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_SCENE).await?;
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
    // Сцена вместе с ролью участника — одним запросом (было: get_member + fetch_scene).
    // Роль берём подзапросом: если строка сцены нашлась, а роли нет, пользователь не участник —
    // get_member вернёт 403; если сцены нет, участник получит 404 (как и раньше).
    let row = sqlx::query("SELECT s.*, (SELECT m.role FROM campaign_members m WHERE m.campaign_id = s.campaign_id AND m.user_id = ?) AS member_role FROM scenes s WHERE s.id = ? AND s.campaign_id = ?")
        .bind(&user.id).bind(&sid).bind(&cid).fetch_optional(&st.db).await?;
    let Some(s) = row else {
        get_member(&st, &cid, &user.id).await?; // не участник — 403 (иначе сцены правда нет)
        return Err(AppError::not_found("Сцена не найдена"));
    };
    let role = match s.try_get::<Option<String>, _>("member_role") {
        Ok(Some(role)) => role,
        _ => get_member(&st, &cid, &user.id).await?.role, // чужой участник кампании — 403
    };
    access::require(&role, access::TABLE_READ)?;
    let is_gm = access::is_gm(&role);
    let rows = sqlx::query("SELECT * FROM scene_items WHERE scene_id = ? ORDER BY z").bind(&sid).fetch_all(&st.db).await?;
    let items: Vec<Value> = rows.iter().map(item_json)
        .filter(|it| is_gm || !it["data"]["hidden"].as_bool().unwrap_or(false))
        .collect();
    let mut out = scene_json(&s);
    out["items"] = Value::Array(items);
    Ok(Json(out))
}

async fn update(State(st): State<AppState>, user: AuthUser, Path((cid, sid)): Path<(String, String)>, Json(body): Json<SceneIn>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_SCENE).await?;
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
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_SCENE).await?;
    fetch_scene(&st, &cid, &sid).await?;
    sqlx::query("UPDATE campaigns SET active_scene_id = NULL WHERE id = ? AND active_scene_id = ?").bind(&cid).bind(&sid).execute(&st.db).await?;
    sqlx::query("DELETE FROM scene_items WHERE scene_id = ?").bind(&sid).execute(&st.db).await?;
    sqlx::query("DELETE FROM scenes WHERE id = ?").bind(&sid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn duplicate(State(st): State<AppState>, user: AuthUser, Path((cid, sid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    access::require_cap(&st, &cid, &user.id, access::TABLE_MANAGE_SCENE).await?;
    let s = fetch_scene(&st, &cid, &sid).await?;
    let nid = util::uid();
    let name = format!("{} (копия)", s.get::<String, _>("name"));
    let layers = util::text(&s, "layers");
    // Элементы копируются с новыми id, поэтому активная карта исходной сцены к копии не относится.
    // Маска тумана привязана к id карт — у копии id другие, поэтому туман начинается с чистой маски.
    sqlx::query("INSERT INTO scenes (id, campaign_id, name, grid, fog, layers, active_map_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&nid).bind(&cid).bind(&name).bind(util::text(&s, "grid")).bind(default_fog().to_string())
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

/// Туман войны: бинарная растровая маска на карту (scene.fog.by_map) — та же схема, что в table-model.js.
#[cfg(test)]
mod fog_tests {
    use super::*;

    fn mask(cols: usize, rows: usize, data: Value) -> Value {
        json!({ "x": 0, "y": 0, "cell": 70, "cols": cols, "rows": rows, "data": data })
    }
    fn mask_of(fog: &Value, map: &str) -> Value { fog["by_map"][map].clone() }

    #[test]
    fn default_fog_is_an_empty_by_map_mask() {
        assert_eq!(default_fog(), json!({ "enabled": false, "by_map": {} }));
    }

    #[test]
    fn normalize_fog_accepts_the_binary_raster_contract() {
        let raw = json!({
            "enabled": true,
            "by_map": {
                "map-a": mask(2, 2, json!([[100, 0], [0, 100]])),
                "map-b": mask(3, 1, json!([[100, 100, 100]])),
            },
        });
        let out = normalize_fog(&raw).expect("валидный туман");
        assert_eq!(out["enabled"], true);
        let a = mask_of(&out, "map-a");
        assert_eq!(a["cols"], 2);
        assert_eq!(a["rows"], 2);
        assert_eq!(a["cell"], 70);
        assert_eq!(a["data"], json!([[100, 0], [0, 100]]), "значения строго 0/100");
        assert_eq!(mask_of(&out, "map-b")["data"], json!([[100, 100, 100]]));
    }

    #[test]
    fn normalize_fog_coerces_values_to_binary_and_drops_zero_masks() {
        // Прочие числа приводятся к 0/100 (только 100 остаётся 100), нечисловые — к 0.
        let out = normalize_fog(&json!({ "by_map": { "m": mask(3, 1, json!([[100, 50, "x"]])) } })).unwrap();
        assert_eq!(out["by_map"]["m"]["data"], json!([[100, 0, 0]]), "строго бинарные значения");
        // Вся нулевая маска не хранится: нет записи = карта полностью скрыта.
        let zero = normalize_fog(&json!({ "by_map": { "m": mask(2, 2, json!([[0, 0], [0, 0]])) } })).unwrap();
        assert!(zero["by_map"].as_object().unwrap().is_empty());
    }

    #[test]
    fn normalize_fog_rejects_legacy_and_broken_input() {
        // Старый векторный формат сервер не читает: растеризацию делает клиент.
        assert!(normalize_fog(&json!({ "enabled": true, "shapes": [{ "shape": "rect", "mode": "reveal", "points": [[0, 0], [10, 10]] }] })).is_none());
        let legacy_map = normalize_fog(&json!({ "by_map": { "m": { "shapes": [{ "shape": "rect", "mode": "reveal", "points": [[0, 0], [1, 1]] }] } } })).unwrap();
        assert!(legacy_map["by_map"].as_object().unwrap().is_empty(), "per-map shapes тоже не читается");
        for bad in [json!(null), json!([]), json!("туман"), json!({ "enabled": true }), json!({ "by_map": [] })] {
            assert!(normalize_fog(&bad).is_none(), "принял {bad}");
        }
        // Битые маски отбрасываются, валидная соседняя остаётся (длинный id — отдельным insert: в json! ключ — только литерал).
        let mut by_map = serde_json::Map::new();
        by_map.insert("ok".to_string(), mask(1, 1, json!([[100]])));
        by_map.insert("bad-dims".to_string(), mask(600, 1, json!([[100]])));              // cols > FOG_MAX_DIM
        by_map.insert("bad-cell".to_string(), json!({ "x": 0, "y": 0, "cell": 0, "cols": 1, "rows": 1, "data": [[100]] }));
        by_map.insert("ragged".to_string(), mask(2, 2, json!([[100, 0], [100]])));          // строка короче cols
        by_map.insert("rows-mismatch".to_string(), mask(1, 2, json!([[100]])));             // строк меньше rows
        by_map.insert("no-data".to_string(), json!({ "x": 0, "y": 0, "cell": 70, "cols": 1, "rows": 1 }));
        by_map.insert("far-coord".to_string(), json!({ "x": 1e9, "y": 0, "cell": 70, "cols": 1, "rows": 1, "data": [[100]] }));
        by_map.insert("x".repeat(65), mask(1, 1, json!([[100]])));                          // длинный id карты
        let mixed = normalize_fog(&json!({ "by_map": Value::Object(by_map) })).unwrap();
        let maps = mixed["by_map"].as_object().unwrap();
        assert_eq!(maps.len(), 1, "осталась только валидная маска: {maps:?}");
        assert!(maps.contains_key("ok"));
    }

    #[test]
    fn normalize_fog_accepts_dimension_boundary() {
        assert_eq!(FOG_MAX_DIM, 512);
        let row: Vec<Value> = (0..FOG_MAX_DIM).map(|_| json!(100)).collect();
        let ok = normalize_fog(&json!({ "by_map": { "m": mask(FOG_MAX_DIM, 1, json!([row])) } })).unwrap();
        assert_eq!(ok["by_map"]["m"]["cols"], FOG_MAX_DIM as u64);
        let over = normalize_fog(&json!({ "by_map": { "m": mask(FOG_MAX_DIM + 1, 1, json!([[100]])) } })).unwrap();
        assert!(over["by_map"].as_object().unwrap().is_empty());
    }

    #[test]
    fn restrict_fog_keeps_only_existing_maps() {
        let fog = normalize_fog(&json!({
            "enabled": true,
            "by_map": {
                "map-a": mask(1, 1, json!([[100]])),
                "deleted-map": mask(1, 1, json!([[100]])),
            },
        })).unwrap();
        let out = restrict_fog_to_maps(&fog, &["map-a".to_string()]);
        assert_eq!(out["enabled"], true);
        assert!(out["by_map"]["map-a"].is_object());
        assert!(out["by_map"]["deleted-map"].is_null(), "маска несуществующей карты не сохраняется");
        // Карт нет — масок нет, но флаг «Показать игрокам» остаётся.
        let none = restrict_fog_to_maps(&fog, &[]);
        assert!(none["by_map"].as_object().unwrap().is_empty());
        assert_eq!(none["enabled"], true);
    }
}
