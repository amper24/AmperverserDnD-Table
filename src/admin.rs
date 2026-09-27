//! Администрирование: root-аккаунт, API управления пользователями и CLI-команды.
//!
//! root — флаг `users.is_root`. Root может: редактировать базовый справочник (SRD),
//! любые наборы, загружать/удалять встроенные ассеты, управлять пользователями.

use axum::{extract::{Path, State}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{AnyPool, Row};

use crate::{auth::{self, AuthUser}, error::ApiResult, util, AppError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/users", get(list_users).post(create_user))
        .route("/api/admin/users/:uid", axum::routing::patch(update_user).delete(delete_user))
        .route("/api/admin/stats", get(stats))
        .route("/api/admin/reseed", post(reseed))
}

fn user_json(r: &sqlx::any::AnyRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"), "email": r.get::<String, _>("email"), "name": r.get::<String, _>("name"),
        "is_root": r.get::<i64, _>("is_root") != 0, "verified": r.get::<i64, _>("verified") != 0,
        "has_password": r.get::<Option<String>, _>("password_hash").is_some(), "created_at": r.get::<String, _>("created_at"),
    })
}

async fn list_users(State(st): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    user.require_root()?;
    let rows = sqlx::query("SELECT id, email, name, is_root, verified, password_hash, created_at FROM users ORDER BY created_at").fetch_all(&st.db).await?;
    Ok(Json(json!(rows.iter().map(user_json).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
pub struct CreateIn { pub email: String, pub password: String, pub name: Option<String>, #[serde(default)] pub is_root: bool }

async fn create_user(State(st): State<AppState>, user: AuthUser, Json(b): Json<CreateIn>) -> ApiResult<Json<Value>> {
    user.require_root()?;
    let id = create(&st.db, &b.email, &b.password, b.name.as_deref(), b.is_root).await.map_err(|e| AppError::bad(e.to_string()))?;
    let r = sqlx::query("SELECT id, email, name, is_root, verified, password_hash, created_at FROM users WHERE id = ?").bind(&id).fetch_one(&st.db).await?;
    Ok(Json(user_json(&r)))
}

#[derive(Deserialize)]
pub struct UpdateIn { pub name: Option<String>, pub is_root: Option<bool>, pub password: Option<String>, pub verified: Option<bool> }

async fn update_user(State(st): State<AppState>, user: AuthUser, Path(uid): Path<String>, Json(b): Json<UpdateIn>) -> ApiResult<Json<Value>> {
    user.require_root()?;
    if let Some(n) = &b.name {
        sqlx::query("UPDATE users SET name = ? WHERE id = ?").bind(util::truncate(n.trim(), 64)).bind(&uid).execute(&st.db).await?;
    }
    if let Some(root) = b.is_root {
        if !root && uid == user.id && root_count(&st.db).await? <= 1 {
            return Err(AppError::bad("Нельзя снять root с единственного администратора"));
        }
        sqlx::query("UPDATE users SET is_root = ? WHERE id = ?").bind(if root { 1i64 } else { 0 }).bind(&uid).execute(&st.db).await?;
    }
    if let Some(pw) = &b.password {
        if pw.len() < 8 { return Err(AppError::bad("Пароль не короче 8 символов")); }
        sqlx::query("UPDATE users SET password_hash = ?, verified = 1 WHERE id = ?").bind(auth::hash_password(pw)?).bind(&uid).execute(&st.db).await?;
        sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&uid).execute(&st.db).await?;
    }
    if let Some(v) = b.verified {
        sqlx::query("UPDATE users SET verified = ? WHERE id = ?").bind(if v { 1i64 } else { 0 }).bind(&uid).execute(&st.db).await?;
    }
    let r = sqlx::query("SELECT id, email, name, is_root, verified, password_hash, created_at FROM users WHERE id = ?").bind(&uid).fetch_optional(&st.db).await?.ok_or_else(|| AppError::not_found("Пользователь не найден"))?;
    Ok(Json(user_json(&r)))
}

async fn delete_user(State(st): State<AppState>, user: AuthUser, Path(uid): Path<String>) -> ApiResult<Json<Value>> {
    user.require_root()?;
    if uid == user.id { return Err(AppError::bad("Нельзя удалить самого себя")); }
    delete_by_id(&st.db, &uid).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn stats(State(st): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    user.require_root()?;
    let mut out = serde_json::Map::new();
    for (k, q) in [
        ("users", "SELECT COUNT(*) AS n FROM users"), ("campaigns", "SELECT COUNT(*) AS n FROM campaigns"), ("characters", "SELECT COUNT(*) AS n FROM characters"),
        ("assets", "SELECT COUNT(*) AS n FROM assets"), ("assets_builtin", "SELECT COUNT(*) AS n FROM assets WHERE builtin = 1"),
        ("compendium_base", "SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL"), ("packs", "SELECT COUNT(*) AS n FROM packs"),
    ] {
        let n: i64 = sqlx::query(q).fetch_one(&st.db).await?.get("n");
        out.insert(k.into(), json!(n));
    }
    Ok(Json(Value::Object(out)))
}

/// Пересоздать базовый справочник из вшитого seed (удаляет базовые записи и заливает заново).
async fn reseed(State(st): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    user.require_root()?;
    sqlx::query("DELETE FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL").execute(&st.db).await?;
    crate::seed::seed(&st.db).await.map_err(|e| AppError::internal(e.to_string()))?;
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL").fetch_one(&st.db).await?.get("n");
    Ok(Json(json!({ "ok": true, "entries": n })))
}

// ---------- общие операции (используются API, CLI и автосозданием root при старте) ----------

async fn root_count(db: &AnyPool) -> ApiResult<i64> {
    Ok(sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_root = 1").fetch_one(db).await?.get("n"))
}

pub async fn create(db: &AnyPool, email: &str, password: &str, name: Option<&str>, is_root: bool) -> anyhow::Result<String> {
    let email = email.trim().to_lowercase();
    if !email.contains('@') { anyhow::bail!("Некорректная почта"); }
    if password.len() < 8 { anyhow::bail!("Пароль не короче 8 символов"); }
    if sqlx::query("SELECT id FROM users WHERE email = ?").bind(&email).fetch_optional(db).await?.is_some() {
        anyhow::bail!("Пользователь {email} уже существует");
    }
    let id = util::uid();
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| email.split('@').next().unwrap_or("user").to_string());
    let hash = auth::hash_password(password).map_err(|e| anyhow::anyhow!(e.1))?;
    sqlx::query("INSERT INTO users (id, email, name, created_at, password_hash, verified, is_root) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .bind(&id).bind(&email).bind(util::truncate(&name, 64)).bind(util::now()).bind(hash).bind(if is_root { 1i64 } else { 0 })
        .execute(db).await?;
    Ok(id)
}

pub async fn delete_by_id(db: &AnyPool, uid: &str) -> ApiResult<()> {
    // Кампании, где пользователь владелец, удаляем каскадно вручную (FK без CASCADE на owner)
    sqlx::query("DELETE FROM campaigns WHERE owner_id = ?").bind(uid).execute(db).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(uid).execute(db).await?;
    let n = sqlx::query("DELETE FROM users WHERE id = ?").bind(uid).execute(db).await?.rows_affected();
    if n == 0 { return Err(AppError::not_found("Пользователь не найден")); }
    Ok(())
}

async fn find_id(db: &AnyPool, email: &str) -> anyhow::Result<String> {
    let r = sqlx::query("SELECT id FROM users WHERE email = ?").bind(email.trim().to_lowercase()).fetch_optional(db).await?;
    r.map(|r| r.get::<String, _>("id")).ok_or_else(|| anyhow::anyhow!("Пользователь {email} не найден"))
}

/// Автосоздание root при старте из ROOT_EMAIL / ROOT_PASSWORD (если такого пользователя ещё нет).
/// Если пользователь с этой почтой уже есть — ему выдаётся root и (если пароль задан) обновляется пароль.
pub async fn ensure_root_from_env(db: &AnyPool) -> anyhow::Result<()> {
    let Ok(email) = std::env::var("ROOT_EMAIL") else { return Ok(()) };
    let email = email.trim().to_lowercase();
    if email.is_empty() { return Ok(()); }
    let password = std::env::var("ROOT_PASSWORD").unwrap_or_default();
    match find_id(db, &email).await {
        Ok(id) => {
            sqlx::query("UPDATE users SET is_root = 1, verified = 1 WHERE id = ?").bind(&id).execute(db).await?;
            if password.len() >= 8 {
                sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(auth::hash_password(&password).map_err(|e| anyhow::anyhow!(e.1))?).bind(&id).execute(db).await?;
            }
            tracing::info!("root: {email} (права подтверждены из ROOT_EMAIL)");
        }
        Err(_) => {
            if password.len() < 8 {
                tracing::warn!("ROOT_EMAIL задан, но ROOT_PASSWORD пуст или короче 8 символов — root не создан");
                return Ok(());
            }
            create(db, &email, &password, Some("root"), true).await?;
            tracing::info!("root: создан аккаунт {email}");
        }
    }
    Ok(())
}

// ---------- CLI ----------

pub const HELP: &str = "\
Edge Tablet — команды администрирования

  dnd-table                                  запустить сервер (по умолчанию)
  dnd-table serve                            то же самое
  dnd-table users list                       список пользователей
  dnd-table users create <email> <password> [--name <имя>] [--root]
                                             создать пользователя (подтверждённого)
  dnd-table users make-root <email>          выдать права root
  dnd-table users revoke-root <email>        снять права root
  dnd-table users set-password <email> <пароль>
                                             сменить пароль (и разлогинить все сессии)
  dnd-table users delete <email>             удалить пользователя и его кампании
  dnd-table stats                            сводка по базе
  dnd-table reseed                           пересоздать базовый справочник из вшитого seed
  dnd-table help                             эта справка

Через cargo: cargo run --release -- users make-root admin@example.com
Переменные: DATABASE_URL, ROOT_EMAIL + ROOT_PASSWORD (автосоздание root при старте).";

/// Возвращает Ok(true), если аргументы были CLI-командой и она выполнена (сервер запускать не нужно).
pub async fn run_cli(db: &AnyPool, args: &[String]) -> anyhow::Result<bool> {
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match a.as_slice() {
        [] | ["serve"] => return Ok(false),
        ["help"] | ["--help"] | ["-h"] => println!("{HELP}"),
        ["users", "list"] => {
            let rows = sqlx::query("SELECT id, email, name, is_root, verified, password_hash, created_at FROM users ORDER BY created_at").fetch_all(db).await?;
            println!("{:<34} {:<20} {:<5} {:<5} {}", "EMAIL", "NAME", "ROOT", "VERIF", "CREATED");
            for r in &rows {
                println!("{:<34} {:<20} {:<5} {:<5} {}", r.get::<String, _>("email"), r.get::<String, _>("name"),
                    if r.get::<i64, _>("is_root") != 0 { "yes" } else { "-" }, if r.get::<i64, _>("verified") != 0 { "yes" } else { "-" },
                    &r.get::<String, _>("created_at")[..10]);
            }
            println!("Всего: {}", rows.len());
        }
        ["users", "create", email, password, rest @ ..] => {
            let mut name = None;
            let mut root = false;
            let mut it = rest.iter();
            while let Some(x) = it.next() {
                match *x { "--name" => name = it.next().copied(), "--root" => root = true, other => anyhow::bail!("Неизвестный флаг {other}") }
            }
            let id = create(db, email, password, name, root).await?;
            println!("Создан {email} (id {id}){}", if root { ", root" } else { "" });
        }
        ["users", "make-root", email] | ["users", "revoke-root", email] => {
            let on = a[1] == "make-root";
            let id = find_id(db, email).await?;
            if !on && root_count(db).await.map_err(|e| anyhow::anyhow!(e.1))? <= 1 {
                anyhow::bail!("Это единственный root — сначала назначьте другого");
            }
            sqlx::query("UPDATE users SET is_root = ?, verified = 1 WHERE id = ?").bind(if on { 1i64 } else { 0 }).bind(&id).execute(db).await?;
            println!("{email}: root = {}", if on { "yes" } else { "no" });
        }
        ["users", "set-password", email, password] => {
            if password.len() < 8 { anyhow::bail!("Пароль не короче 8 символов"); }
            let id = find_id(db, email).await?;
            sqlx::query("UPDATE users SET password_hash = ?, verified = 1 WHERE id = ?").bind(auth::hash_password(password).map_err(|e| anyhow::anyhow!(e.1))?).bind(&id).execute(db).await?;
            sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&id).execute(db).await?;
            println!("{email}: пароль обновлён, сессии сброшены");
        }
        ["users", "delete", email] => {
            let id = find_id(db, email).await?;
            delete_by_id(db, &id).await.map_err(|e| anyhow::anyhow!(e.1))?;
            println!("{email}: удалён");
        }
        ["stats"] => {
            for (k, q) in [("Пользователи", "SELECT COUNT(*) AS n FROM users"), ("  из них root", "SELECT COUNT(*) AS n FROM users WHERE is_root = 1"), ("Кампании", "SELECT COUNT(*) AS n FROM campaigns"),
                ("Персонажи", "SELECT COUNT(*) AS n FROM characters"), ("Ассеты", "SELECT COUNT(*) AS n FROM assets"), ("Базовый справочник", "SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL"), ("Наборы", "SELECT COUNT(*) AS n FROM packs")] {
                let n: i64 = sqlx::query(q).fetch_one(db).await?.get("n");
                println!("{k:<22} {n}");
            }
        }
        ["reseed"] => {
            sqlx::query("DELETE FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL").execute(db).await?;
            crate::seed::seed(db).await?;
            println!("Базовый справочник пересоздан");
        }
        _ => { println!("Неизвестная команда: {}\n\n{HELP}", args.join(" ")); std::process::exit(2); }
    }
    Ok(true)
}
