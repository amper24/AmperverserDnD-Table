//! Листы персонажей (JSON-документ), доступ: владелец, мастер кампании, остальные — если shared.
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, campaigns::get_member, error::ApiResult, util, AppError, AppState};

pub fn default_sheet(name: &str) -> Value {
    json!({
        "name": name, "race": "", "class": "", "subclass": "", "level": 1, "background": "", "alignment": "", "xp": 0,
        "abilities": { "str": 10, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10 },
        "proficiency_bonus": 2, "saving_throws": [], "skills": [], "expertise": [],
        "hp": { "max": 10, "current": 10, "temp": 0, "hit_dice": "1d8" },
        "ac": 10, "auto_armor": true, "speed": 30, "initiative_bonus": 0, "inspiration": false,
        "attacks": [], "inventory": [], "spells": { "slots": {}, "known": [], "ability": "" },
        "features": [], "traits": { "personality": "", "ideals": "", "bonds": "", "flaws": "" },
        "notes": "", "currency": { "cp": 0, "sp": 0, "ep": 0, "gp": 0, "pp": 0 },
        "conditions": [], "death_saves": { "success": 0, "failure": 0 }
    })
}

fn char_json(r: &sqlx::any::AnyRow) -> Value {
    let revision = r.get::<i64, _>("revision");
    let mut sheet = util::json_value(&util::text(r, "sheet"));
    sheet["_revision"] = json!(revision);
    json!({ "revision": revision,
        "id": r.get::<String, _>("id"), "campaign_id": r.get::<Option<String>, _>("campaign_id"), "owner_id": r.get::<String, _>("owner_id"),
        "name": r.get::<String, _>("name"), "portrait_asset_id": r.get::<Option<String>, _>("portrait_asset_id"),
        "sheet": sheet, "updated_at": r.get::<String, _>("updated_at"),
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/characters", get(list).post(create))
        .route("/api/characters/:id", get(get_one).patch(patch).delete(delete_one))
        .route("/api/characters/:id/transfer", axum::routing::post(transfer))
        .route("/api/characters/:id/inventory", axum::routing::post(inventory_operation))
}

#[derive(Deserialize)]
pub struct TransferIn { pub item_uid: String, pub to_character_id: String, pub qty: Option<i64>, pub request_id: Option<String> }

/// Атомарная передача предмета между персонажами (владелец/мастер источника; получатель — в той же кампании).
async fn transfer(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<TransferIn>) -> ApiResult<Json<Value>> {
    if body.to_character_id == id {
        return Err(AppError::bad("Нельзя передать самому себе"));
    }
    let src = load_checked(&st, &id, &user, true).await?;
    let dst = char_json(&load_row(&st, &body.to_character_id).await?);
    let same_campaign = src["campaign_id"].is_string() && src["campaign_id"] == dst["campaign_id"];
    let dst_ok = dst["owner_id"] == user.id || same_campaign;
    if !dst_ok {
        return Err(AppError::forbidden("Получатель должен быть в той же кампании"));
    }
    let request_id = body.request_id.clone().unwrap_or_else(util::uid);
    if request_id.is_empty() || request_id.len() > 64 { return Err(AppError::bad("Неверный идентификатор передачи")); }
    if let Some(r) = sqlx::query("SELECT result FROM character_operations WHERE character_id = ? AND request_id = ?").bind(&id).bind(&request_id).fetch_optional(&st.db).await? {
        let result = util::json_value(&util::text(&r, "result"));
        if result["target"] != body.to_character_id { return Err(AppError::bad("ID операции уже использован")); }
        return Ok(Json(json!({ "ok": true, "from": src, "to": dst, "item": result["transfer_item"], "replayed": true })));
    }
    let mut src_sheet = src["sheet"].clone();
    let mut dst_sheet = dst["sheet"].clone();
    let inv = src_sheet["inventory"].as_array().cloned().unwrap_or_default();
    let Some(pos) = inv.iter().position(|it| it["uid"] == body.item_uid.as_str()) else { return Err(AppError::not_found("Предмет не найден")) };
    let mut item = inv[pos].clone();
    let have = item["qty"].as_i64().unwrap_or(1);
    let qty = body.qty.unwrap_or(have);
    if qty < 1 || qty > have { return Err(AppError::bad("Недостаточно предметов для передачи")); }
    let mut new_inv = inv.clone();
    if qty >= have {
        new_inv.remove(pos);
    } else {
        new_inv[pos]["qty"] = json!(have - qty);
        item["qty"] = json!(qty);
        crate::inventory::partition_charges(&mut new_inv[pos], &mut item, qty, have);
    }
    item["uid"] = json!(util::uid());
    crate::inventory::unequip(&mut item);
    item["attuned"] = json!(false); item["favorite"] = json!(false);
    src_sheet["inventory"] = json!(new_inv);
    let mut dst_inv = dst_sheet["inventory"].as_array().cloned().unwrap_or_default();
    dst_inv.push(item.clone());
    dst_sheet["inventory"] = json!(dst_inv);
    crate::inventory::normalize(&mut src_sheet)?; crate::inventory::normalize(&mut dst_sheet)?;
    let mut tx = st.db.begin().await?;
    // Deterministic lock order avoids inverse transfers locking characters in opposite order.
    if id < body.to_character_id {
        cas_sheet(&mut tx, &id, src["revision"].as_i64().unwrap(), &src_sheet).await?;
        cas_sheet(&mut tx, &body.to_character_id, dst["revision"].as_i64().unwrap(), &dst_sheet).await?;
    } else {
        cas_sheet(&mut tx, &body.to_character_id, dst["revision"].as_i64().unwrap(), &dst_sheet).await?;
        cas_sheet(&mut tx, &id, src["revision"].as_i64().unwrap(), &src_sheet).await?;
    }
    sqlx::query("INSERT INTO character_operations (character_id, request_id, result) VALUES (?, ?, ?)")
        .bind(&id).bind(&request_id).bind(json!({ "target": body.to_character_id, "transfer_item": item }).to_string()).execute(&mut *tx).await?;
    tx.commit().await?;
    let a = char_json(&load_row(&st, &id).await?);
    let b = char_json(&load_row(&st, &body.to_character_id).await?);
    if let Some(cid) = src["campaign_id"].as_str() {
        st.hub.broadcast(cid, &json!({ "type": "character_update", "character": a }), None).await;
        st.hub.broadcast(cid, &json!({ "type": "character_update", "character": b }), None).await;
        let text = format!("{} передал(а) «{}»{} → {}", user.name, item["name"].as_str().unwrap_or("предмет"), if qty > 1 { format!(" ×{qty}") } else { String::new() }, b["name"].as_str().unwrap_or(""));
        if let Some(m) = crate::realtime::system_message(&st, cid, &user, &text).await {
            st.hub.broadcast(cid, &m, None).await;
        }
    }
    Ok(Json(json!({ "ok": true, "from": a, "to": b, "item": item })))
}

#[derive(Deserialize)]
pub struct ListQuery { pub campaign_id: Option<String> }

async fn list(State(st): State<AppState>, user: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let rows = match &q.campaign_id {
        Some(cid) => {
            let m = get_member(&st, cid, &user.id).await?;
            let rows = sqlx::query("SELECT * FROM characters WHERE campaign_id = ? ORDER BY updated_at DESC").bind(cid).fetch_all(&st.db).await?;
            rows.iter().map(char_json).filter(|c| m.is_gm() || c["owner_id"] == user.id || c["sheet"]["shared"].as_bool().unwrap_or(false)).collect::<Vec<_>>()
        }
        None => sqlx::query("SELECT * FROM characters WHERE owner_id = ? ORDER BY updated_at DESC").bind(&user.id).fetch_all(&st.db).await?.iter().map(char_json).collect(),
    };
    Ok(Json(Value::Array(rows)))
}

#[derive(Deserialize)]
pub struct CharIn { pub name: Option<String>, pub campaign_id: Option<String>, pub sheet: Option<Value>, pub portrait_asset_id: Option<String> }

async fn create(State(st): State<AppState>, user: AuthUser, Json(body): Json<CharIn>) -> ApiResult<Json<Value>> {
    if let Some(cid) = &body.campaign_id {
        get_member(&st, cid, &user.id).await?;
    }
    let name = util::truncate(body.name.as_deref().unwrap_or("Новый персонаж"), 128);
    let mut sheet = default_sheet(&name);
    if let Some(Value::Object(extra)) = body.sheet {
        for (k, v) in extra {
            sheet[k] = v;
        }
    }
    crate::inventory::normalize(&mut sheet)?;
    sheet.as_object_mut().unwrap().remove("_revision");
    let id = util::uid();
    sqlx::query("INSERT INTO characters (id, campaign_id, owner_id, name, portrait_asset_id, sheet, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&body.campaign_id).bind(&user.id).bind(&name).bind(&body.portrait_asset_id).bind(sheet.to_string()).bind(util::now()).execute(&st.db).await?;
    Ok(Json(char_json(&load_row(&st, &id).await?)))
}

async fn load_row(st: &AppState, id: &str) -> ApiResult<sqlx::any::AnyRow> {
    sqlx::query("SELECT * FROM characters WHERE id = ?").bind(id).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Персонаж не найден"))
}

async fn load_checked(st: &AppState, id: &str, user: &AuthUser, write: bool) -> ApiResult<Value> {
    let c = char_json(&load_row(st, id).await?);
    if c["owner_id"] == user.id {
        return Ok(c);
    }
    if let Some(cid) = c["campaign_id"].as_str() {
        if let Ok(m) = get_member(st, cid, &user.id).await {
            if m.is_gm() || (!write && c["sheet"]["shared"].as_bool().unwrap_or(false)) {
                return Ok(c);
            }
        }
    }
    Err(AppError::forbidden("Нет доступа к персонажу"))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(load_checked(&st, &id, &user, false).await?))
}

#[derive(Deserialize, Default)]
pub struct CharPatch {
    pub name: Option<String>, pub campaign_id: Option<String>, pub sheet: Option<Value>, pub portrait_asset_id: Option<String>,
    #[serde(default)] pub detach_campaign: bool,
}

async fn patch(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>, body: Option<Json<CharPatch>>) -> ApiResult<Json<Value>> {
    let body = body.map(|b| b.0).unwrap_or_default();
    let c = load_checked(&st, &id, &user, true).await?;
    if body.name.is_none() && body.sheet.is_none() && body.portrait_asset_id.is_none() && body.campaign_id.is_none() && !body.detach_campaign { return Ok(Json(c)); }
    let mut name = c["name"].as_str().unwrap_or("").to_string();
    let mut initial = c["sheet"].clone(); initial.as_object_mut().unwrap().remove("_revision");
    let mut sheet = initial.to_string();
    let mut portrait = c["portrait_asset_id"].as_str().map(|s| s.to_string());
    let mut campaign = c["campaign_id"].as_str().map(|s| s.to_string());
    if let Some(n) = &body.name { name = util::truncate(n, 128); }
    if let Some(s) = &body.sheet {
        if let Some(n) = s["name"].as_str() { if !n.is_empty() { name = util::truncate(n, 128); } }
        if s["_revision"].as_i64() != c["revision"].as_i64() { return Err(conflict()); }
        let mut next = s.clone(); crate::inventory::normalize(&mut next)?;
        next.as_object_mut().unwrap().remove("_revision");
        sheet = next.to_string();
    }
    if let Some(p) = &body.portrait_asset_id { portrait = Some(p.clone()); }
    if body.detach_campaign {
        campaign = None;
    } else if let Some(cid) = &body.campaign_id {
        get_member(&st, cid, &user.id).await?;
        campaign = Some(cid.clone());
    }
    let updated = sqlx::query("UPDATE characters SET name = ?, sheet = ?, portrait_asset_id = ?, campaign_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .bind(&name).bind(&sheet).bind(&portrait).bind(&campaign).bind(util::now()).bind(&id).bind(c["revision"].as_i64().unwrap()).execute(&st.db).await?;
    if updated.rows_affected() != 1 { return Err(conflict()); }
    let out = char_json(&load_row(&st, &id).await?);
    if let Some(cid) = &campaign {
        st.hub.broadcast(cid, &json!({ "type": "character_update", "character": out }), None).await;
    }
    Ok(Json(out))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    load_checked(&st, &id, &user, true).await?;
    sqlx::query("DELETE FROM characters WHERE id = ?").bind(&id).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

fn conflict() -> AppError { AppError(axum::http::StatusCode::CONFLICT, "Лист изменён в другом окне. Обновите его; устаревшие данные не сохранены.".into()) }
async fn cas_sheet(tx: &mut sqlx::Transaction<'_, sqlx::Any>, id: &str, revision: i64, sheet: &Value) -> ApiResult<()> {
    let mut stored = sheet.clone(); stored.as_object_mut().ok_or_else(|| AppError::bad("Неверный лист"))?.remove("_revision");
    let result = sqlx::query("UPDATE characters SET sheet = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
        .bind(stored.to_string()).bind(util::now()).bind(id).bind(revision).execute(&mut **tx).await?;
    if result.rows_affected() != 1 { return Err(conflict()); } Ok(())
}
#[derive(Deserialize)]
struct InventoryOp {
    request_id: String, op: String,
    #[serde(default)] source_kind: String,
    #[serde(default)] source_uid: String,
    #[serde(default)] program_id: String,
    #[serde(default)] acknowledged: bool,
    #[serde(default)] item_uid: String,
    #[serde(default)] slot: String,
    #[serde(default)] qty: i64,
    #[serde(default)] actions: Vec<usize>,
    #[serde(default)] mode: String,
    #[serde(default)] gm_only: bool,
    #[serde(default)] scene_id: String,
    #[serde(default)] loot_id: String,
    #[serde(default)] x: f64,
    #[serde(default)] y: f64,
    #[serde(default = "loot_size")] size: f64,
}
fn loot_size() -> f64 { 50.0 }
async fn inventory_operation(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<InventoryOp>) -> ApiResult<Json<Value>> {
    let c = load_checked(&st, &id, &user, true).await?;
    if body.request_id.is_empty() || body.request_id.len() > 64 { return Err(AppError::bad("Нужен идентификатор операции")); }
    let cid = c["campaign_id"].as_str();
    let is_gm = if let Some(cid) = cid { get_member(&st, cid, &user.id).await?.is_gm() } else { false };
    if cid.is_some() && body.gm_only && !is_gm { return Err(AppError::forbidden("Скрытое использование доступно только мастеру")); }
    if ["drop", "pickup"].contains(&body.op.as_str()) {
        let row = sqlx::query("SELECT campaign_id FROM scenes WHERE id = ?").bind(&body.scene_id).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Сцена не найдена"))?;
        if Some(row.get::<String, _>("campaign_id")).as_deref() != cid { return Err(AppError::forbidden("Сцена и персонаж должны быть в одной кампании")); }
    }
    let mut tx = st.db.begin().await?;
    if let Some(r) = sqlx::query("SELECT result FROM character_operations WHERE character_id = ? AND request_id = ?").bind(&id).bind(&body.request_id).fetch_optional(&mut *tx).await? {
        let result = util::json_value(&util::text(&r, "result")); tx.rollback().await?;
        return Ok(Json(json!({ "character": char_json(&load_row(&st, &id).await?), "result": result, "replayed": true })));
    }
    let mut sheet = c["sheet"].clone(); crate::inventory::normalize(&mut sheet)?;
    let mut result = json!({ "op": body.op }); let mut scene_event = None;
    match body.op.as_str() {
        "program" => {
            result=crate::mechanics::execute(&mut sheet,&body.source_kind,&body.source_uid,&body.program_id,&body.mode,body.acknowledged)?;
            result["request_id"]=json!(body.request_id);result["gm_only"]=json!(body.gm_only);
            result["program_use"]=json!({"character_id":id,"source_kind":body.source_kind,"source_uid":body.source_uid,"program_id":body.program_id,"mode":body.mode,"gm_only":body.gm_only});
        }
        "equip" => crate::inventory::equip(&mut sheet, &body.item_uid, &body.slot)?,
        "split" => { result["new_uid"] = json!(crate::inventory::split(&mut sheet, &body.item_uid, body.qty)?); }
        "use" => {
            result = crate::inventory::use_item(&mut sheet, &body.item_uid, &body.actions, &body.mode)?;
            result["request_id"] = json!(body.request_id); result["gm_only"] = json!(body.gm_only);
            result["item_use"] = json!({ "character_id": id, "item_uid": body.item_uid, "actions": body.actions, "mode": body.mode, "gm_only": body.gm_only });
        }
        "drop" => {
            if !body.x.is_finite() || !body.y.is_finite() || !body.size.is_finite() { return Err(AppError::bad("Неверные координаты")); }
            let inv = sheet["inventory"].as_array_mut().unwrap();
            let pos = inv.iter().position(|i| i["uid"] == body.item_uid).ok_or_else(|| AppError::not_found("Предмет уже отсутствует"))?;
            let mut item = inv.remove(pos); if item["qty"].as_i64().unwrap_or(0) < 1 { return Err(AppError::bad("Пустую стопку нельзя выложить")); }
            crate::inventory::unequip(&mut item); item["attuned"] = json!(false); item["favorite"] = json!(false);
            let loot_id = util::uid(); let data = json!({ "type": "loot", "loot": true, "managed_loot": true, "item": item, "x": body.x, "y": body.y, "w": body.size.clamp(10.0, 1000.0), "h": body.size.clamp(10.0, 1000.0), "name": item["name"], "owner_id": user.id });
            sqlx::query("INSERT INTO scene_items (id, scene_id, layer, z, data, updated_at) VALUES (?, ?, 'prop', 5, ?, ?)")
                .bind(&loot_id).bind(&body.scene_id).bind(data.to_string()).bind(util::now()).execute(&mut *tx).await?;
            scene_event = Some(json!({ "type": "item_upsert", "scene_id": body.scene_id, "item": { "id": loot_id, "scene_id": body.scene_id, "layer": "prop", "z": 5, "data": data } }));
        }
        "pickup" => {
            let r = sqlx::query("SELECT data FROM scene_items WHERE id = ? AND scene_id = ?").bind(&body.loot_id).bind(&body.scene_id).fetch_optional(&mut *tx).await?.ok_or_else(|| AppError::not_found("Лут уже подобран"))?;
            let raw = util::text(&r, "data"); let data = util::json_value(&raw);
            if data["loot"] != true || !data["item"].is_object() { return Err(AppError::bad("Это не предмет на столе")); }
            let deleted = sqlx::query("DELETE FROM scene_items WHERE id = ? AND scene_id = ? AND data = ?").bind(&body.loot_id).bind(&body.scene_id).bind(raw).execute(&mut *tx).await?;
            if deleted.rows_affected() != 1 { return Err(conflict()); }
            let mut item = data["item"].clone(); item["uid"] = json!(util::uid()); crate::inventory::unequip(&mut item); item["attuned"] = json!(false); item["favorite"] = json!(false);
            sheet["inventory"].as_array_mut().unwrap().push(item); crate::inventory::normalize(&mut sheet)?;
            scene_event = Some(json!({ "type": "item_delete", "scene_id": body.scene_id, "id": body.loot_id }));
        }
        _ => return Err(AppError::bad("Неизвестная операция инвентаря")),
    }
    crate::inventory::normalize(&mut sheet)?;
    cas_sheet(&mut tx, &id, c["revision"].as_i64().unwrap(), &sheet).await?;
    let mut message = None;
    if body.op == "use" || body.op == "program" {
        if let Some(cid) = cid {
            let kind = if body.op=="program" || result["rolls"].as_array().is_some_and(|r| !r.is_empty()) { "multi" } else { "system" };
            if kind == "system" { result["text"] = json!(format!("{}: использован {}", c["name"].as_str().unwrap_or(""), result["label"].as_str().unwrap_or("предмет"))); }
            let now = util::now();
            let saved = sqlx::query("INSERT INTO chat_messages (campaign_id, user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)")
                .bind(cid).bind(&user.id).bind(kind).bind(result.to_string()).bind(&now).execute(&mut *tx).await?;
            message = Some(json!({ "type": "chat", "id": saved.last_insert_id().unwrap_or(0), "user_id": user.id, "name": user.name, "kind": kind, "payload": result, "at": now }));
            result["message"] = message.clone().unwrap();
        }
    }
    sqlx::query("INSERT INTO character_operations (character_id, request_id, result) VALUES (?, ?, ?)").bind(&id).bind(&body.request_id).bind(result.to_string()).execute(&mut *tx).await?;
    tx.commit().await?;
    let character = char_json(&load_row(&st, &id).await?);

    if let Some(cid) = cid {
        st.hub.broadcast(cid, &json!({ "type": "character_update", "character": character }), None).await;
        if let Some(event) = scene_event { st.hub.broadcast(cid, &event, None).await; }
        if let Some(m) = message { if body.gm_only { st.hub.send_to_role(cid, "gm", &m).await; } else { st.hub.broadcast(cid, &m, None).await; } }
    }
    Ok(Json(json!({ "character": character, "result": result, "replayed": false })))
}
