//! Наборы (packs): пользовательские коллекции записей справочника (homebrew).
//!
//! Возможности:
//! - владелец создаёт набор, наполняет записями (свои папки-категории внутри: data.folder), приглашает соавторов;
//! - делится ссылкой (share_code → /packs/join/<code>): получатель «подписывается», набор появляется у него в справочнике
//!   и его можно подключить к кампании;
//! - публикует в каталог (is_public): любой может смотреть, подписаться или клонировать к себе и править;
//! - экспорт/импорт JSON, клонирование, версия и дата обновления.
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
        .route("/api/packs/join/:code", get(preview_by_code).post(join_by_code))
        .route("/api/packs/:pid", get(get_one).patch(update).delete(delete_one))
        .route("/api/packs/:pid/export", get(export))
        .route("/api/packs/:pid/share", post(share).delete(unshare))
        .route("/api/packs/:pid/subscribe", post(subscribe).delete(unsubscribe))
        .route("/api/packs/:pid/clone", post(clone_pack))
        .route("/api/packs/:pid/editors", get(editors).post(add_editor))
        .route("/api/packs/:pid/editors/:uid", axum::routing::delete(remove_editor))
        .route("/api/packs/:pid/folders", post(set_folders))
        .route("/api/campaigns/:cid/packs", get(campaign_packs))
        .route("/api/campaigns/:cid/packs/:pid", post(enable).delete(disable))
}

fn opt(r: &sqlx::any::AnyRow, col: &str) -> Option<String> {
    if let Ok(v) = r.try_get::<Option<String>, _>(col) { return v; }
    let t = util::text(r, col);
    if t.is_empty() { None } else { Some(t) }
}
fn folders_of(r: &sqlx::any::AnyRow) -> Value {
    let t = util::text(r, "folders");
    let v = util::json_value(&t);
    if v.is_array() { v } else { json!([]) }
}

fn pack_json(r: &sqlx::any::AnyRow, extra: Value) -> Value {
    let folders = folders_of(r);
    let mut v = json!({
        "id": r.get::<String, _>("id"), "owner_id": r.get::<String, _>("owner_id"), "name": r.get::<String, _>("name"),
        "description": util::text(r, "description"), "is_public": r.get::<i64, _>("is_public") != 0, "created_at": r.get::<String, _>("created_at"),
        "share_code": opt(r, "share_code"), "cover_asset_id": opt(r, "cover_asset_id"), "folders": folders,
        "tags": opt(r, "tags").unwrap_or_default(), "edition": opt(r, "edition").unwrap_or_default(),
        "updated_at": opt(r, "updated_at"), "published_at": opt(r, "published_at"), "version": r.try_get::<i64, _>("version").unwrap_or(1),
    });
    if let (Some(dst), Some(src)) = (v.as_object_mut(), extra.as_object()) {
        for (k, val) in src { dst.insert(k.clone(), val.clone()); }
    }
    v
}

async fn fetch(st: &AppState, pid: &str) -> ApiResult<sqlx::any::AnyRow> {
    sqlx::query("SELECT * FROM packs WHERE id = ?").bind(pid).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Набор не найден"))
}

/// Владелец набора или root.
pub async fn require_owner(st: &AppState, pid: &str, user: &AuthUser) -> ApiResult<()> {
    let r = fetch(st, pid).await?;
    if user.is_root || r.get::<String, _>("owner_id") == user.id {
        return Ok(());
    }
    Err(AppError::forbidden("Это не ваш набор"))
}

/// Владелец, соавтор или root — право добавлять и править записи.
pub async fn require_editor(st: &AppState, pid: &str, user: &AuthUser) -> ApiResult<()> {
    if require_owner(st, pid, user).await.is_ok() {
        return Ok(());
    }
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pack_editors WHERE pack_id = ? AND user_id = ?").bind(pid).bind(&user.id).fetch_one(&st.db).await?.get("n");
    if n > 0 { Ok(()) } else { Err(AppError::forbidden("Вы не соавтор этого набора")) }
}

/// Отметить изменение набора (дата обновления, версия).
pub async fn touch(st: &AppState, pid: &str) -> ApiResult<()> {
    sqlx::query("UPDATE packs SET updated_at = ?, version = version + 1 WHERE id = ?").bind(util::now()).bind(pid).execute(&st.db).await?;
    Ok(())
}

/// Чтение: свои, публичные, подписки, соавторство, подключённые к кампании пользователя.
pub async fn can_read(st: &AppState, pid: &str, uid: &str) -> ApiResult<()> {
    let r = fetch(st, pid).await?;
    if r.get::<String, _>("owner_id") == uid || r.get::<i64, _>("is_public") != 0 {
        return Ok(());
    }
    let n: i64 = sqlx::query("SELECT (SELECT COUNT(*) FROM pack_subscriptions WHERE pack_id = ? AND user_id = ?) + (SELECT COUNT(*) FROM pack_editors WHERE pack_id = ? AND user_id = ?) + (SELECT COUNT(*) FROM campaign_packs cp JOIN campaign_members m ON m.campaign_id = cp.campaign_id WHERE cp.pack_id = ? AND m.user_id = ?) AS n")
        .bind(pid).bind(uid).bind(pid).bind(uid).bind(pid).bind(uid).fetch_one(&st.db).await?.get("n");
    if n > 0 { Ok(()) } else { Err(AppError::forbidden("Нет доступа к набору")) }
}

/// Сводка по набору: число записей, подписчиков, разбивка по категориям, роль пользователя.
async fn stats(st: &AppState, pid: &str, uid: &str) -> ApiResult<Value> {
    let rows = sqlx::query("SELECT category, COUNT(*) AS n FROM compendium WHERE pack_id = ? GROUP BY category").bind(pid).fetch_all(&st.db).await?;
    let mut by_cat = serde_json::Map::new();
    let mut total = 0i64;
    for r in &rows { let n: i64 = r.get("n"); total += n; by_cat.insert(r.get::<String, _>("category"), json!(n)); }
    let subs: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pack_subscriptions WHERE pack_id = ?").bind(pid).fetch_one(&st.db).await?.get("n");
    let subscribed: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pack_subscriptions WHERE pack_id = ? AND user_id = ?").bind(pid).bind(uid).fetch_one(&st.db).await?.get("n");
    let editor: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pack_editors WHERE pack_id = ? AND user_id = ?").bind(pid).bind(uid).fetch_one(&st.db).await?.get("n");
    Ok(json!({ "entries": total, "by_category": by_cat, "subscribers": subs, "subscribed": subscribed > 0, "editor": editor > 0 }))
}

#[derive(Deserialize)]
pub struct ListQuery { pub scope: Option<String>, pub q: Option<String>, pub tag: Option<String>, pub sort: Option<String> }

/// scope: mine (свои + соавторство) | subscribed | public (каталог) | all (всё доступное для подключения)
async fn list(State(st): State<AppState>, user: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let scope = q.scope.as_deref().unwrap_or("all");
    let mut sql = String::from("SELECT p.*, (SELECT COUNT(*) FROM compendium c WHERE c.pack_id = p.id) AS entries, (SELECT COUNT(*) FROM pack_subscriptions s WHERE s.pack_id = p.id) AS subscribers, u.name AS owner_name FROM packs p JOIN users u ON u.id = p.owner_id WHERE ");
    let mut binds: Vec<String> = Vec::new();
    match scope {
        "mine" => { sql.push_str("(p.owner_id = ? OR p.id IN (SELECT pack_id FROM pack_editors WHERE user_id = ?))"); binds.push(user.id.clone()); binds.push(user.id.clone()); }
        "subscribed" => { sql.push_str("p.id IN (SELECT pack_id FROM pack_subscriptions WHERE user_id = ?)"); binds.push(user.id.clone()); }
        "public" => { sql.push_str("p.is_public = 1"); }
        _ => { sql.push_str("(p.owner_id = ? OR p.is_public = 1 OR p.id IN (SELECT pack_id FROM pack_subscriptions WHERE user_id = ?) OR p.id IN (SELECT pack_id FROM pack_editors WHERE user_id = ?))"); binds.push(user.id.clone()); binds.push(user.id.clone()); binds.push(user.id.clone()); }
    }
    if let Some(s) = &q.q { sql.push_str(" AND (LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ?)"); let pat = format!("%{}%", s.to_lowercase()); binds.push(pat.clone()); binds.push(pat); }
    if let Some(t) = &q.tag { sql.push_str(" AND LOWER(p.tags) LIKE ?"); binds.push(format!("%{}%", t.to_lowercase())); }
    sql.push_str(match q.sort.as_deref() { Some("popular") => " ORDER BY subscribers DESC, p.created_at DESC", Some("updated") => " ORDER BY p.updated_at DESC, p.created_at DESC", Some("name") => " ORDER BY p.name", _ => " ORDER BY p.created_at DESC" });
    sql.push_str(" LIMIT 500");
    let mut query = sqlx::query(&sql);
    for b in &binds { query = query.bind(b); }
    let rows = query.fetch_all(&st.db).await?;
    let mut out = Vec::new();
    for r in &rows {
        let subscribed: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pack_subscriptions WHERE pack_id = ? AND user_id = ?").bind(r.get::<String, _>("id")).bind(&user.id).fetch_one(&st.db).await?.get("n");
        let editor: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pack_editors WHERE pack_id = ? AND user_id = ?").bind(r.get::<String, _>("id")).bind(&user.id).fetch_one(&st.db).await?.get("n");
        out.push(pack_json(r, json!({ "entries": r.get::<i64, _>("entries"), "subscribers": r.get::<i64, _>("subscribers"), "owner_name": r.get::<String, _>("owner_name"),
            "mine": r.get::<String, _>("owner_id") == user.id, "editor": editor > 0, "subscribed": subscribed > 0 })));
    }
    Ok(Json(json!(out)))
}

#[derive(Deserialize)]
pub struct PackIn {
    pub name: String, #[serde(default)] pub description: String, #[serde(default)] pub is_public: bool,
    pub cover_asset_id: Option<String>, #[serde(default)] pub tags: String, #[serde(default)] pub edition: String,
}

async fn create(State(st): State<AppState>, user: AuthUser, Json(body): Json<PackIn>) -> ApiResult<Json<Value>> {
    if body.name.trim().is_empty() { return Err(AppError::bad("Укажите название набора")); }
    let id = util::uid();
    sqlx::query("INSERT INTO packs (id, owner_id, name, description, is_public, created_at, updated_at, cover_asset_id, tags, edition, folders) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')")
        .bind(&id).bind(&user.id).bind(util::truncate(body.name.trim(), 128)).bind(&body.description).bind(body.is_public as i64).bind(util::now()).bind(util::now())
        .bind(&body.cover_asset_id).bind(util::truncate(&body.tags, 255)).bind(util::truncate(&body.edition, 8)).execute(&st.db).await?;
    Ok(Json(pack_json(&fetch(&st, &id).await?, json!({ "entries": 0, "mine": true, "subscribers": 0 }))))
}

async fn get_one(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    can_read(&st, &pid, &user.id).await?;
    let r = fetch(&st, &pid).await?;
    let mut extra = stats(&st, &pid, &user.id).await?;
    let owner = sqlx::query("SELECT name FROM users WHERE id = ?").bind(r.get::<String, _>("owner_id")).fetch_optional(&st.db).await?;
    extra["owner_name"] = json!(owner.map(|o| o.get::<String, _>("name")).unwrap_or_default());
    extra["mine"] = json!(r.get::<String, _>("owner_id") == user.id);
    Ok(Json(pack_json(&r, extra)))
}

async fn update(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>, Json(body): Json<PackIn>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user).await?;
    if body.name.trim().is_empty() { return Err(AppError::bad("Укажите название набора")); }
    let was_public = fetch(&st, &pid).await?.get::<i64, _>("is_public") != 0;
    if body.is_public && body.description.trim().len() < 10 {
        return Err(AppError::bad("Для публикации в каталоге добавьте описание набора (хотя бы пару предложений)"));
    }
    sqlx::query("UPDATE packs SET name = ?, description = ?, is_public = ?, cover_asset_id = ?, tags = ?, edition = ?, updated_at = ? WHERE id = ?")
        .bind(util::truncate(body.name.trim(), 128)).bind(&body.description).bind(body.is_public as i64).bind(&body.cover_asset_id).bind(util::truncate(&body.tags, 255)).bind(util::truncate(&body.edition, 8)).bind(util::now()).bind(&pid).execute(&st.db).await?;
    if body.is_public && !was_public {
        sqlx::query("UPDATE packs SET published_at = ? WHERE id = ?").bind(util::now()).bind(&pid).execute(&st.db).await?;
    }
    let extra = stats(&st, &pid, &user.id).await?;
    Ok(Json(pack_json(&fetch(&st, &pid).await?, extra)))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user).await?;
    sqlx::query("DELETE FROM compendium WHERE pack_id = ?").bind(&pid).execute(&st.db).await?;
    sqlx::query("DELETE FROM campaign_packs WHERE pack_id = ?").bind(&pid).execute(&st.db).await?;
    sqlx::query("DELETE FROM pack_subscriptions WHERE pack_id = ?").bind(&pid).execute(&st.db).await?;
    sqlx::query("DELETE FROM pack_editors WHERE pack_id = ?").bind(&pid).execute(&st.db).await?;
    sqlx::query("DELETE FROM packs WHERE id = ?").bind(&pid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---- папки (свои категории внутри набора) ----
#[derive(Deserialize)]
pub struct FoldersIn { pub folders: Vec<String> }

async fn set_folders(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>, Json(body): Json<FoldersIn>) -> ApiResult<Json<Value>> {
    require_editor(&st, &pid, &user).await?;
    let folders: Vec<String> = body.folders.iter().map(|f| util::truncate(f.trim(), 48)).filter(|f| !f.is_empty()).take(64).collect();
    sqlx::query("UPDATE packs SET folders = ?, updated_at = ? WHERE id = ?").bind(json!(folders).to_string()).bind(util::now()).bind(&pid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true, "folders": folders })))
}

// ---- ссылка для доступа ----
fn gen_code() -> String {
    use rand::Rng;
    const A: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..10).map(|_| A[rng.gen_range(0..A.len())] as char).collect()
}

async fn share(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user).await?;
    let code = gen_code();
    sqlx::query("UPDATE packs SET share_code = ? WHERE id = ?").bind(&code).bind(&pid).execute(&st.db).await?;
    Ok(Json(json!({ "share_code": code })))
}

async fn unshare(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user).await?;
    sqlx::query("UPDATE packs SET share_code = NULL WHERE id = ?").bind(&pid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn by_code(st: &AppState, code: &str) -> ApiResult<sqlx::any::AnyRow> {
    sqlx::query("SELECT * FROM packs WHERE share_code = ?").bind(code).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Ссылка недействительна или отозвана"))
}

async fn preview_by_code(State(st): State<AppState>, user: AuthUser, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let r = by_code(&st, &code).await?;
    let pid = r.get::<String, _>("id");
    let mut extra = stats(&st, &pid, &user.id).await?;
    let owner = sqlx::query("SELECT name FROM users WHERE id = ?").bind(r.get::<String, _>("owner_id")).fetch_optional(&st.db).await?;
    extra["owner_name"] = json!(owner.map(|o| o.get::<String, _>("name")).unwrap_or_default());
    extra["mine"] = json!(r.get::<String, _>("owner_id") == user.id);
    let mut v = pack_json(&r, extra);
    v["share_code"] = Value::Null;
    Ok(Json(v))
}

async fn join_by_code(State(st): State<AppState>, user: AuthUser, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let r = by_code(&st, &code).await?;
    let pid = r.get::<String, _>("id");
    if r.get::<String, _>("owner_id") != user.id {
        sqlx::query("DELETE FROM pack_subscriptions WHERE pack_id = ? AND user_id = ?").bind(&pid).bind(&user.id).execute(&st.db).await?;
        sqlx::query("INSERT INTO pack_subscriptions (pack_id, user_id, created_at) VALUES (?, ?, ?)").bind(&pid).bind(&user.id).bind(util::now()).execute(&st.db).await?;
    }
    Ok(Json(json!({ "ok": true, "id": pid, "name": r.get::<String, _>("name") })))
}

// ---- подписка на публичный набор ----
async fn subscribe(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    can_read(&st, &pid, &user.id).await?;
    sqlx::query("DELETE FROM pack_subscriptions WHERE pack_id = ? AND user_id = ?").bind(&pid).bind(&user.id).execute(&st.db).await?;
    sqlx::query("INSERT INTO pack_subscriptions (pack_id, user_id, created_at) VALUES (?, ?, ?)").bind(&pid).bind(&user.id).bind(util::now()).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn unsubscribe(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM pack_subscriptions WHERE pack_id = ? AND user_id = ?").bind(&pid).bind(&user.id).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---- соавторы ----
async fn editors(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    require_editor(&st, &pid, &user).await?;
    let rows = sqlx::query("SELECT u.id, u.name, u.email FROM pack_editors e JOIN users u ON u.id = e.user_id WHERE e.pack_id = ? ORDER BY u.name").bind(&pid).fetch_all(&st.db).await?;
    Ok(Json(rows.iter().map(|r| json!({ "id": r.get::<String, _>("id"), "name": r.get::<String, _>("name"), "email": r.get::<String, _>("email") })).collect()))
}

#[derive(Deserialize)]
pub struct EditorIn { pub email: String }

async fn add_editor(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>, Json(body): Json<EditorIn>) -> ApiResult<Json<Value>> {
    require_owner(&st, &pid, &user).await?;
    let u = sqlx::query("SELECT id FROM users WHERE LOWER(email) = ?").bind(body.email.trim().to_lowercase()).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Пользователь с таким email не найден"))?;
    let uid: String = u.get("id");
    if uid == user.id { return Err(AppError::bad("Вы и так владелец")); }
    sqlx::query("DELETE FROM pack_editors WHERE pack_id = ? AND user_id = ?").bind(&pid).bind(&uid).execute(&st.db).await?;
    sqlx::query("INSERT INTO pack_editors (pack_id, user_id) VALUES (?, ?)").bind(&pid).bind(&uid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_editor(State(st): State<AppState>, user: AuthUser, Path((pid, uid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    if uid != user.id { require_owner(&st, &pid, &user).await?; }
    sqlx::query("DELETE FROM pack_editors WHERE pack_id = ? AND user_id = ?").bind(&pid).bind(&uid).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---- экспорт / импорт / клонирование ----
async fn entries_of(st: &AppState, pid: &str) -> ApiResult<Vec<Value>> {
    let rows = sqlx::query("SELECT category, slug, name, data FROM compendium WHERE pack_id = ? ORDER BY category, name").bind(pid).fetch_all(&st.db).await?;
    Ok(rows.iter().map(|r| json!({ "category": r.get::<String, _>("category"), "slug": r.get::<String, _>("slug"), "name": r.get::<String, _>("name"), "data": util::json_value(&util::text(r, "data")) })).collect())
}

/// Экспорт набора в переносимый JSON.
async fn export(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    can_read(&st, &pid, &user.id).await?;
    let p = fetch(&st, &pid).await?;
    Ok(Json(json!({
        "format": "amperverser-pack/2",
        "name": p.get::<String, _>("name"), "description": util::text(&p, "description"),
        "folders": folders_of(&p), "tags": opt(&p, "tags").unwrap_or_default(), "edition": opt(&p, "edition").unwrap_or_default(),
        "version": p.try_get::<i64, _>("version").unwrap_or(1),
        "entries": entries_of(&st, &pid).await?,
    })))
}

async fn insert_entries(st: &AppState, pid: &str, source: &str, entries: &[Value]) -> ApiResult<i64> {
    let mut count = 0;
    let mut tx = st.db.begin().await?;
    for e in entries.iter().take(5000) {
        let cat = e["category"].as_str().unwrap_or("");
        let Some(nm) = e["name"].as_str() else { continue };
        if !CATEGORIES.contains(&cat) { continue; }
        let slug = e["slug"].as_str().map(|s| s.to_string()).unwrap_or_else(|| crate::compendium::slugify(nm));
        let en = e["data"]["name_en"].as_str().unwrap_or("");
        let name_lc = util::truncate(&format!("{} {}", nm, en).trim().to_lowercase(), 128);
        sqlx::query("INSERT INTO compendium (id, campaign_id, pack_id, category, slug, name, name_lc, source, data) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)")
            .bind(util::uid()).bind(pid).bind(cat).bind(util::truncate(&slug, 64)).bind(util::truncate(nm, 128)).bind(name_lc).bind(util::truncate(source, 32)).bind(e["data"].to_string())
            .execute(&mut *tx).await?;
        count += 1;
    }
    tx.commit().await?;
    Ok(count)
}

#[derive(Deserialize)]
pub struct ImportIn {
    pub name: Option<String>, #[serde(default)] pub description: String, #[serde(default)] pub entries: Vec<Value>,
    #[serde(default)] pub folders: Vec<String>, #[serde(default)] pub tags: String, #[serde(default)] pub edition: String,
    /// Импортировать в существующий набор (дополнить), а не создавать новый.
    pub into: Option<String>,
}

async fn import(State(st): State<AppState>, user: AuthUser, Json(body): Json<ImportIn>) -> ApiResult<Json<Value>> {
    if let Some(pid) = &body.into {
        require_editor(&st, pid, &user).await?;
        let p = fetch(&st, pid).await?;
        let name = p.get::<String, _>("name");
        let n = insert_entries(&st, pid, &name, &body.entries).await?;
        if !body.folders.is_empty() {
            let mut cur: Vec<String> = serde_json::from_value(folders_of(&p)).unwrap_or_default();
            for f in &body.folders { if !cur.contains(f) { cur.push(f.clone()); } }
            sqlx::query("UPDATE packs SET folders = ? WHERE id = ?").bind(json!(cur).to_string()).bind(pid).execute(&st.db).await?;
        }
        touch(&st, pid).await?;
        return Ok(Json(json!({ "ok": true, "id": pid, "added": n })));
    }
    let id = util::uid();
    let name = util::truncate(body.name.as_deref().unwrap_or("Импортированный набор").trim(), 128);
    sqlx::query("INSERT INTO packs (id, owner_id, name, description, is_public, created_at, updated_at, folders, tags, edition) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&user.id).bind(&name).bind(&body.description).bind(util::now()).bind(util::now()).bind(json!(body.folders).to_string()).bind(util::truncate(&body.tags, 255)).bind(util::truncate(&body.edition, 8)).execute(&st.db).await?;
    let count = insert_entries(&st, &id, &name, &body.entries).await?;
    Ok(Json(pack_json(&fetch(&st, &id).await?, json!({ "entries": count, "mine": true, "subscribers": 0 }))))
}

/// Клонировать доступный набор к себе (получается свой редактируемый экземпляр).
async fn clone_pack(State(st): State<AppState>, user: AuthUser, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    can_read(&st, &pid, &user.id).await?;
    let p = fetch(&st, &pid).await?;
    let id = util::uid();
    let name = util::truncate(&format!("{} (копия)", p.get::<String, _>("name")), 128);
    sqlx::query("INSERT INTO packs (id, owner_id, name, description, is_public, created_at, updated_at, folders, tags, edition, cover_asset_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&user.id).bind(&name).bind(util::text(&p, "description")).bind(util::now()).bind(util::now()).bind(folders_of(&p).to_string()).bind(opt(&p, "tags").unwrap_or_default()).bind(opt(&p, "edition").unwrap_or_default()).bind(opt(&p, "cover_asset_id")).execute(&st.db).await?;
    let entries = entries_of(&st, &pid).await?;
    let count = insert_entries(&st, &id, &name, &entries).await?;
    Ok(Json(pack_json(&fetch(&st, &id).await?, json!({ "entries": count, "mine": true, "subscribers": 0 }))))
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
