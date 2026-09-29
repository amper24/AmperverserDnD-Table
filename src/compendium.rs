//! Справочник: расы, классы, предыстории, предметы, заклинания, монстры, черты, состояния.
//! Источники записей: базовый набор (SRD), homebrew кампании (мастер), наборы пользователей (packs).
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{auth::AuthUser, campaigns::{get_member, require_gm}, error::ApiResult, i18n, packs, util, AppError, AppState};

pub const CATEGORIES: &[&str] = &["race", "class", "background", "item", "spell", "monster", "npc", "feat", "condition", "lore"];

/// Как отдавать запись. `lang` — язык вида (слой перевода накладывается на данные, `i18n` скрыт);
/// без `lang` и `raw=1` запись отдаётся как хранится (со всеми слоями перевода) — так работают редактор и старые клиенты.
#[derive(Clone, Copy)]
pub struct View { pub lang: Option<&'static str> }

impl View {
    pub fn from_query(lang: &Option<String>, raw: &Option<String>) -> View {
        let raw = matches!(raw.as_deref(), Some("1") | Some("true"));
        View { lang: if raw { None } else { lang.as_deref().and_then(i18n::norm_lang) } }
    }
}

/// Базовый язык записи: у записей наборов — язык набора (`packs.locale`), у остальных — русский.
fn base_locale(r: &sqlx::any::AnyRow) -> String {
    let l = r.try_get::<Option<String>, _>("pack_locale").ok().flatten().unwrap_or_default();
    i18n::norm_lang(&l).unwrap_or(i18n::DEFAULT_LANG).to_string()
}

const SELECT_ENTRY: &str = "SELECT c.*, p.locale AS pack_locale FROM compendium c LEFT JOIN packs p ON p.id = c.pack_id";

fn entry_json(r: &sqlx::any::AnyRow, view: View) -> Value {
    let base = base_locale(r);
    let mut data = util::json_value(&util::text(r, "data"));
    let mut name = r.get::<String, _>("name");
    let locales = i18n::locales(&data, &base);
    let mut lang = base.clone();
    if let Some(want) = view.lang {
        let (d, eff) = i18n::view(&data, &base, want);
        data = d;
        if eff != base {
            // название берётся из слоя перевода; в данных отдельного поля name у записей нет
            if let Some(o) = data.as_object_mut() {
                if let Some(Value::String(n)) = o.remove("name") { if !n.trim().is_empty() { name = n; } }
            }
        }
        lang = eff;
    }
    json!({
        "id": r.get::<String, _>("id"), "category": r.get::<String, _>("category"), "slug": r.get::<String, _>("slug"), "name": name,
        "source": r.get::<String, _>("source"), "campaign_id": r.get::<Option<String>, _>("campaign_id"), "pack_id": r.get::<Option<String>, _>("pack_id"),
        "data": data, "base_locale": base, "lang": lang, "locales": locales,
    })
}

async fn fetch_entry(st: &AppState, id: &str, view: View) -> ApiResult<Value> {
    let r = sqlx::query(&format!("{SELECT_ENTRY} WHERE c.id = ?")).bind(id).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Запись не найдена"))?;
    Ok(entry_json(&r, view))
}

pub fn slugify(name: &str) -> String {
    util::truncate(&name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-"), 64)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/compendium/categories", get(|| async { Json(json!(CATEGORIES)) }))
        .route("/api/compendium", get(search).post(create))
        .route("/api/compendium/:id", get(get_one).patch(update).delete(delete_one))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub category: Option<String>, pub q: Option<String>, pub campaign_id: Option<String>, pub pack_id: Option<String>,
    pub limit: Option<i64>, pub mine: Option<bool>,
    /// Редакция правил: "2014" или "2024" — скрывает базовые записи другой редакции (свои записи видны всегда).
    pub edition: Option<String>,
    /// Папка (своя категория) внутри набора: data.folder.
    pub folder: Option<String>,
    /// Язык вида: "ru" | "en" (по умолчанию записи отдаются как хранятся, со слоями перевода).
    pub lang: Option<String>,
    /// raw=1 — принудительно отдать сохранённые данные без наложения перевода (для редактора).
    pub raw: Option<String>,
}

#[derive(Deserialize)]
pub struct GetQuery { pub lang: Option<String>, pub raw: Option<String> }

async fn search(State(st): State<AppState>, user: AuthUser, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    // Источники: SRD (без кампании и набора) + homebrew кампании + наборы, подключённые к кампании + свои наборы
    let mut conds: Vec<String> = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    if let Some(pid) = &q.pack_id {
        packs::can_read(&st, pid, &user.id).await?;
        conds.push("c.pack_id = ?".into());
        binds.push(pid.clone());
    } else {
        conds.push("(c.campaign_id IS NULL AND c.pack_id IS NULL)".into());
        if let Some(cid) = &q.campaign_id {
            get_member(&st, cid, &user.id).await?;
            conds.push("c.campaign_id = ?".into());
            binds.push(cid.clone());
            conds.push("c.pack_id IN (SELECT pack_id FROM campaign_packs WHERE campaign_id = ?)".into());
            binds.push(cid.clone());
        }
        if q.mine.unwrap_or(true) {
            conds.push("c.pack_id IN (SELECT id FROM packs WHERE owner_id = ? UNION SELECT pack_id FROM pack_subscriptions WHERE user_id = ? UNION SELECT pack_id FROM pack_editors WHERE user_id = ?)".into());
            binds.push(user.id.clone()); binds.push(user.id.clone()); binds.push(user.id.clone());
        }
    }
    let mut sql = format!("{SELECT_ENTRY} WHERE ({})", conds.join(" OR "));
    if q.category.is_some() { sql.push_str(" AND c.category = ?"); }
    let pattern = q.q.as_ref().map(|s| format!("%{}%", s.to_lowercase()));
    if pattern.is_some() { sql.push_str(" AND c.name_lc LIKE ?"); }
    let other = match q.edition.as_deref() { Some("2014") => Some("SRD 2024"), Some("2024") => Some("SRD 2014"), _ => None };
    if other.is_some() { sql.push_str(" AND c.source <> ?"); }
    let folder_pat = q.folder.as_ref().map(|f| format!("%\"folder\":{}%", serde_json::Value::String(f.clone())));
    if folder_pat.is_some() { sql.push_str(" AND c.data LIKE ?"); }
    sql.push_str(" ORDER BY c.category, c.name LIMIT ?");
    let mut query = sqlx::query(&sql);
    for b in &binds { query = query.bind(b); }
    if let Some(c) = &q.category { query = query.bind(c); }
    if let Some(p) = &pattern { query = query.bind(p); }
    if let Some(o) = other { query = query.bind(o); }
    if let Some(f) = &folder_pat { query = query.bind(f); }
    query = query.bind(q.limit.unwrap_or(300).clamp(1, 3000));
    let rows = query.fetch_all(&st.db).await?;
    let view = View::from_query(&q.lang, &q.raw);
    let mut out: Vec<Value> = rows.iter().map(|r| entry_json(r, view)).collect();
    if matches!(view.lang, Some(l) if l != i18n::DEFAULT_LANG) {
        // порядок по названию на выбранном языке (SQL сортирует по базовому)
        out.sort_by_key(|e| (e["category"].as_str().unwrap_or("").to_string(), e["name"].as_str().unwrap_or("").to_lowercase()));
    }
    Ok(Json(json!(out)))
}

async fn get_one(State(st): State<AppState>, _user: AuthUser, Path(id): Path<String>, Query(q): Query<GetQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(fetch_entry(&st, &id, View::from_query(&q.lang, &q.raw)).await?))
}

#[derive(Deserialize)]
pub struct EntryIn { pub category: String, pub name: String, #[serde(default)] pub data: Value, pub campaign_id: Option<String>, pub pack_id: Option<String> }

/// Поисковый ключ: название, английское название (data.name_en) и переводы названия (data.i18n.*.name).
fn name_lc(body: &EntryIn) -> String {
    i18n::search_key(&body.name, &body.data)
}

/// Класс и раса — не объекты на карте: токена на карте у них нет.
fn strip_map_token(body: &mut EntryIn) {
    if matches!(body.category.as_str(), "race" | "class") {
        if let Some(o) = body.data.as_object_mut() { o.remove("token_asset_id"); }
    }
}

async fn create(State(st): State<AppState>, user: AuthUser, Json(mut body): Json<EntryIn>) -> ApiResult<Json<Value>> {
    strip_map_token(&mut body);
    if let Some(m) = body.data.get("mechanics") { crate::mechanics::validate(m)?; }
    if let Some(c) = body.data.get("choices") { crate::mechanics::validate_choices(c)?; }
    i18n::validate(&body.data).map_err(AppError::bad)?;
    if !CATEGORIES.contains(&body.category.as_str()) {
        return Err(AppError::bad("Неизвестная категория"));
    }
    let source = match (&body.campaign_id, &body.pack_id) {
        (_, Some(pid)) => { packs::require_editor(&st, pid, &user).await?; packs::touch(&st, pid).await?; let p = sqlx::query("SELECT name FROM packs WHERE id = ?").bind(pid).fetch_one(&st.db).await?; util::truncate(&p.get::<String, _>("name"), 32) }
        (Some(cid), None) => { require_gm(&st, cid, &user.id).await?; "Homebrew".to_string() }
        (None, None) => { user.require_root().map_err(|_| AppError::bad("Укажите кампанию или набор"))?; "SRD".to_string() }
    };
    let id = util::uid();
    let campaign_id = if body.pack_id.is_some() { None } else { body.campaign_id.clone() };
    sqlx::query("INSERT INTO compendium (id, campaign_id, pack_id, category, slug, name, name_lc, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&campaign_id).bind(&body.pack_id).bind(&body.category).bind(slugify(&body.name)).bind(util::truncate(&body.name, 128)).bind(name_lc(&body)).bind(&source).bind(body.data.to_string())
        .execute(&st.db).await?;
    Ok(Json(fetch_entry(&st, &id, View { lang: None }).await?))
}

/// Право редактировать: homebrew кампании — мастер; запись набора — владелец набора.
async fn editable(st: &AppState, id: &str, user: &AuthUser) -> ApiResult<()> {
    let r = sqlx::query("SELECT campaign_id, pack_id FROM compendium WHERE id = ?").bind(id).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Запись не найдена"))?;
    if let Some(pid) = r.get::<Option<String>, _>("pack_id") {
        packs::require_editor(st, &pid, user).await?;
        packs::touch(st, &pid).await?;
        return Ok(());
    }
    if let Some(cid) = r.get::<Option<String>, _>("campaign_id") {
        require_gm(st, &cid, &user.id).await?;
        return Ok(());
    }
    if user.is_root {
        return Ok(());
    }
    Err(AppError::forbidden("Базовые записи нельзя менять — скопируйте в свой набор"))
}

async fn update(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(mut body): Json<EntryIn>) -> ApiResult<Json<Value>> {
    strip_map_token(&mut body);
    if let Some(m) = body.data.get("mechanics") { crate::mechanics::validate(m)?; }
    if let Some(c) = body.data.get("choices") { crate::mechanics::validate_choices(c)?; }
    i18n::validate(&body.data).map_err(AppError::bad)?;
    editable(&st, &id, &user).await?;
    if !CATEGORIES.contains(&body.category.as_str()) {
        return Err(AppError::bad("Неизвестная категория"));
    }
    sqlx::query("UPDATE compendium SET name = ?, name_lc = ?, data = ?, category = ?, slug = ? WHERE id = ?")
        .bind(util::truncate(&body.name, 128)).bind(name_lc(&body)).bind(body.data.to_string()).bind(&body.category).bind(slugify(&body.name)).bind(&id).execute(&st.db).await?;
    Ok(Json(fetch_entry(&st, &id, View { lang: None }).await?))
}

async fn delete_one(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    editable(&st, &id, &user).await?;
    sqlx::query("DELETE FROM compendium WHERE id = ?").bind(&id).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}
