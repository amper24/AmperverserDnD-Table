//! Ассеты: изображения, сжатые и хранимые в БД в base64. Заготовленные (builtin) + пользовательские.
use axum::{
    extract::{Multipart, Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, campaigns::get_member, error::ApiResult, images, util, AppError, AppState};

const MAX_UPLOAD: usize = 25 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/assets", get(list).post(upload))
        .route("/api/assets/:aid", get(get_one).delete(delete_one))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_UPLOAD + 1024 * 1024))
}

fn meta(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "name": r.get::<String, _>("name"), "kind": r.get::<String, _>("kind"), "mime": r.get::<String, _>("mime"),
        "width": r.get::<i64, _>("width"), "height": r.get::<i64, _>("height"), "encoding": r.get::<String, _>("encoding"),
        "builtin": r.get::<i64, _>("builtin") != 0, "campaign_id": r.get::<Option<String>, _>("campaign_id"),
    })
}

#[derive(Deserialize)]
pub struct ListQuery { pub campaign_id: Option<String>, pub kind: Option<String> }

async fn list(State(st): State<AppState>, user: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let mut sql = String::from("SELECT id, name, kind, mime, width, height, encoding, builtin, campaign_id FROM assets WHERE (builtin = 1 OR owner_id = ?");
    if let Some(cid) = &q.campaign_id {
        get_member(&st, cid, &user.id).await?;
        sql.push_str(" OR campaign_id = ?");
    }
    sql.push(')');
    if q.kind.is_some() {
        sql.push_str(" AND kind = ?");
    }
    sql.push_str(" ORDER BY builtin DESC, created_at DESC");
    let mut query = sqlx::query(&sql).bind(&user.id);
    if let Some(cid) = &q.campaign_id {
        query = query.bind(cid);
    }
    if let Some(k) = &q.kind {
        query = query.bind(k);
    }
    let rows = query.fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(meta).collect()))
}

async fn upload(State(st): State<AppState>, user: AuthUser, mut mp: Multipart) -> ApiResult<Json<Value>> {
    let mut file: Option<(String, Vec<u8>)> = None;
    let mut name = String::new();
    let mut kind = "token".to_string();
    let mut campaign_id: Option<String> = None;
    while let Some(field) = mp.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        match field.name().unwrap_or("") {
            "file" => {
                let fname = field.file_name().unwrap_or("image").to_string();
                let bytes = field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?;
                if bytes.len() > MAX_UPLOAD {
                    return Err(AppError(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "Файл слишком большой".into()));
                }
                file = Some((fname, bytes.to_vec()));
            }
            "name" => name = field.text().await.unwrap_or_default(),
            "kind" => kind = field.text().await.unwrap_or_else(|_| "token".into()),
            "campaign_id" => { let v = field.text().await.unwrap_or_default(); if !v.is_empty() { campaign_id = Some(v); } }
            _ => {}
        }
    }
    let (fname, bytes) = file.ok_or_else(|| AppError::bad("Нет файла"))?;
    if let Some(cid) = &campaign_id {
        get_member(&st, cid, &user.id).await?;
    }
    if !["map", "token", "prop", "portrait", "item"].contains(&kind.as_str()) {
        kind = "token".into();
    }
    let max_side = if kind == "map" { 4096 } else { 1024 };
    let quality = st.cfg.image_quality;
    let info = tokio::task::spawn_blocking(move || images::compress_image(&bytes, max_side, quality))
        .await.map_err(|e| anyhow::anyhow!(e))?
        .map_err(|_| AppError::bad("Не удалось прочитать изображение"))?;
    let id = util::uid();
    let name = if name.trim().is_empty() { fname.rsplit_once('.').map(|(n, _)| n.to_string()).unwrap_or(fname) } else { name };
    sqlx::query("INSERT INTO assets (id, campaign_id, owner_id, name, kind, mime, width, height, encoding, data_b64, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
        .bind(&id).bind(&campaign_id).bind(&user.id).bind(util::truncate(&name, 128)).bind(&kind).bind(&info.mime).bind(info.width).bind(info.height).bind(&info.encoding).bind(&info.data_b64).bind(util::now())
        .execute(&st.db).await?;
    Ok(Json(json!({
        "id": id, "name": name, "kind": kind, "mime": info.mime, "width": info.width, "height": info.height, "encoding": info.encoding,
        "builtin": false, "campaign_id": campaign_id, "raw_size": info.raw_size, "stored_size": info.stored_size,
    })))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path(aid): Path<String>) -> ApiResult<Response> {
    let r = sqlx::query("SELECT * FROM assets WHERE id = ?").bind(&aid).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Ассет не найден"))?;
    let builtin: i64 = r.get("builtin");
    let owner: Option<String> = r.get("owner_id");
    let cid: Option<String> = r.get("campaign_id");
    if builtin == 0 && owner.as_deref() != Some(&user.id) {
        if let Some(cid) = &cid {
            get_member(&st, cid, &user.id).await?;
        }
    }
    let mut out = meta(&r);
    out["data_b64"] = json!(util::text(&r, "data_b64"));
    Ok(([(header::CACHE_CONTROL, "private, max-age=31536000, immutable")], Json(out)).into_response())
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(aid): Path<String>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("SELECT builtin, owner_id, campaign_id FROM assets WHERE id = ?").bind(&aid).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Ассет не найден"))?;
    if r.get::<i64, _>("builtin") != 0 {
        return Err(AppError::not_found("Встроенный ассет нельзя удалить"));
    }
    let owner: Option<String> = r.get("owner_id");
    if owner.as_deref() != Some(&user.id) {
        match r.get::<Option<String>, _>("campaign_id") {
            Some(cid) => { if !get_member(&st, &cid, &user.id).await?.is_gm() { return Err(AppError::forbidden("Нет прав")); } }
            None => return Err(AppError::forbidden("Нет прав")),
        }
    }
    sqlx::query("DELETE FROM assets WHERE id = ?").bind(&aid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}
