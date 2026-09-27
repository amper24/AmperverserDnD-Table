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
        "ac": 10, "speed": 30, "initiative_bonus": 0, "inspiration": false,
        "attacks": [], "inventory": [], "spells": { "slots": {}, "known": [], "ability": "" },
        "features": [], "traits": { "personality": "", "ideals": "", "bonds": "", "flaws": "" },
        "notes": "", "currency": { "cp": 0, "sp": 0, "ep": 0, "gp": 0, "pp": 0 },
        "conditions": [], "death_saves": { "success": 0, "fail": 0 }
    })
}

fn char_json(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "campaign_id": r.get::<Option<String>, _>("campaign_id"), "owner_id": r.get::<String, _>("owner_id"),
        "name": r.get::<String, _>("name"), "portrait_asset_id": r.get::<Option<String>, _>("portrait_asset_id"),
        "sheet": util::json_value(&util::text(&r, "sheet")), "updated_at": r.get::<String, _>("updated_at"),
    })
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/characters", get(list).post(create))
        .route("/api/characters/:id", get(get_one).patch(patch).delete(delete_one))
        .route("/api/characters/:id/transfer", axum::routing::post(transfer))
}

#[derive(Deserialize)]
pub struct TransferIn { pub item_uid: String, pub to_character_id: String, pub qty: Option<i64> }

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
    let mut src_sheet = src["sheet"].clone();
    let mut dst_sheet = dst["sheet"].clone();
    let inv = src_sheet["inventory"].as_array().cloned().unwrap_or_default();
    let Some(pos) = inv.iter().position(|it| it["uid"] == body.item_uid.as_str()) else { return Err(AppError::not_found("Предмет не найден")) };
    let mut item = inv[pos].clone();
    let have = item["qty"].as_i64().unwrap_or(1).max(1);
    let qty = body.qty.unwrap_or(have).clamp(1, have);
    let mut new_inv = inv.clone();
    if qty >= have {
        new_inv.remove(pos);
    } else {
        new_inv[pos]["qty"] = json!(have - qty);
        item["qty"] = json!(qty);
    }
    item["uid"] = json!(util::uid());
    item["equipped"] = json!(false);
    item["attuned"] = json!(false);
    src_sheet["inventory"] = json!(new_inv);
    let mut dst_inv = dst_sheet["inventory"].as_array().cloned().unwrap_or_default();
    dst_inv.push(item.clone());
    dst_sheet["inventory"] = json!(dst_inv);
    let now = util::now();
    sqlx::query("UPDATE characters SET sheet = ?, updated_at = ? WHERE id = ?").bind(src_sheet.to_string()).bind(&now).bind(&id).execute(&st.db).await?;
    sqlx::query("UPDATE characters SET sheet = ?, updated_at = ? WHERE id = ?").bind(dst_sheet.to_string()).bind(&now).bind(&body.to_character_id).execute(&st.db).await?;
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
    let mut name = c["name"].as_str().unwrap_or("").to_string();
    let mut sheet = c["sheet"].to_string();
    let mut portrait = c["portrait_asset_id"].as_str().map(|s| s.to_string());
    let mut campaign = c["campaign_id"].as_str().map(|s| s.to_string());
    if let Some(n) = &body.name { name = util::truncate(n, 128); }
    if let Some(s) = &body.sheet {
        if let Some(n) = s["name"].as_str() { if !n.is_empty() { name = util::truncate(n, 128); } }
        sheet = s.to_string();
    }
    if let Some(p) = &body.portrait_asset_id { portrait = Some(p.clone()); }
    if body.detach_campaign {
        campaign = None;
    } else if let Some(cid) = &body.campaign_id {
        get_member(&st, cid, &user.id).await?;
        campaign = Some(cid.clone());
    }
    sqlx::query("UPDATE characters SET name = ?, sheet = ?, portrait_asset_id = ?, campaign_id = ?, updated_at = ? WHERE id = ?")
        .bind(&name).bind(&sheet).bind(&portrait).bind(&campaign).bind(util::now()).bind(&id).execute(&st.db).await?;
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
