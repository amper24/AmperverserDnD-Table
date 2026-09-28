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
    auth::check_password(&b.password)?;
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
        auth::check_password(pw)?;
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
    for (key, _label, n) in collect_stats(&st.db).await.map_err(|e| AppError::internal(e.to_string()))? {
        out.insert(key.to_string(), json!(n));
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

/// Колонки пользователя, которые читают API и CLI.
const USER_COLS: &str = "id, email, name, is_root, verified, password_hash, created_at";

/// Сводка по базе: (ключ в JSON, подпись для человека, запрос).
const STAT_QUERIES: &[(&str, &str, &str)] = &[
    ("users", "Пользователи", "SELECT COUNT(*) AS n FROM users"),
    ("users_root", "  из них root", "SELECT COUNT(*) AS n FROM users WHERE is_root = 1"),
    ("campaigns", "Кампании", "SELECT COUNT(*) AS n FROM campaigns"),
    ("characters", "Персонажи", "SELECT COUNT(*) AS n FROM characters"),
    ("assets", "Ассеты", "SELECT COUNT(*) AS n FROM assets"),
    ("assets_builtin", "  из них встроенных", "SELECT COUNT(*) AS n FROM assets WHERE builtin = 1"),
    ("compendium_base", "Базовый справочник", "SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL"),
    ("packs", "Наборы", "SELECT COUNT(*) AS n FROM packs"),
];

/// Посчитать сводку по базе: её печатает `stats` в CLI и отдаёт GET /api/admin/stats.
async fn collect_stats(db: &AnyPool) -> anyhow::Result<Vec<(&'static str, &'static str, i64)>> {
    let mut out = Vec::with_capacity(STAT_QUERIES.len());
    for (key, label, sql) in STAT_QUERIES {
        let n: i64 = sqlx::query(sql).fetch_one(db).await?.get("n");
        out.push((*key, *label, n));
    }
    Ok(out)
}

/// Найти пользователя по почте (почта нормализуется: Admin@Example.com найдёт admin@example.com).
async fn find_user(db: &AnyPool, email: &str) -> anyhow::Result<Option<sqlx::any::AnyRow>> {
    let sql = format!("SELECT {USER_COLS} FROM users WHERE email = ?");
    Ok(sqlx::query(&sql).bind(email.trim().to_lowercase()).fetch_optional(db).await?)
}

async fn root_count(db: &AnyPool) -> ApiResult<i64> {
    Ok(sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_root = 1").fetch_one(db).await?.get("n"))
}

/// Создать подтверждённого пользователя (используют API, CLI и автосоздание root при старте).
/// Минимальную длину пароля проверяет вызывающая сторона: веб-API требует 8 символов,
/// CLI может создать и более короткий пароль — с предупреждением.
pub async fn create(db: &AnyPool, email: &str, password: &str, name: Option<&str>, is_root: bool) -> anyhow::Result<String> {
    let email = auth::check_email(email).map_err(|m| anyhow::anyhow!(m))?;
    if password.is_empty() { anyhow::bail!("Пароль не может быть пустым"); }
    if password.chars().count() > 200 { anyhow::bail!("Слишком длинный пароль (максимум 200 символов)"); }
    if find_user(db, &email).await?.is_some() { anyhow::bail!("Пользователь {email} уже существует"); }
    let id = util::uid();
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| email.split('@').next().unwrap_or("user").to_string());
    let hash = auth::hash_password(password).map_err(|e| anyhow::anyhow!(e.1))?;
    sqlx::query("INSERT INTO users (id, email, name, created_at, password_hash, verified, is_root) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .bind(&id).bind(&email).bind(util::truncate(&name, 64)).bind(util::now()).bind(hash).bind(if is_root { 1i64 } else { 0 })
        .execute(db).await?;
    Ok(id)
}

pub async fn delete_by_id(db: &AnyPool, uid: &str) -> ApiResult<()> {
    // Кампании владельца удаляем явно (на owner_id нет каскада): вместе с ними каскадом уходят
    // сцены, персонажи, ассеты кампаний, приглашения и привязанные к кампании наборы.
    sqlx::query("DELETE FROM campaigns WHERE owner_id = ?").bind(uid).execute(db).await?;
    // Остальные ссылки на пользователя чистим явно: в SQLite каскад работает только при
    // PRAGMA foreign_keys=ON, поэтому в старых базах оставались «сироты» — чужие ассеты,
    // подписки и персонажи удалённого пользователя.
    for sql in [
        "DELETE FROM packs WHERE owner_id = ?",
        "DELETE FROM assets WHERE owner_id = ?",
        "DELETE FROM characters WHERE owner_id = ?",
        "DELETE FROM campaign_members WHERE user_id = ?",
        "DELETE FROM pack_subscriptions WHERE user_id = ?",
        "DELETE FROM pack_editors WHERE user_id = ?",
        "DELETE FROM sessions WHERE user_id = ?",
    ] {
        sqlx::query(sql).bind(uid).execute(db).await?;
    }
    let n = sqlx::query("DELETE FROM users WHERE id = ?").bind(uid).execute(db).await?.rows_affected();
    if n == 0 { return Err(AppError::not_found("Пользователь не найден")); }
    Ok(())
}

async fn find_id(db: &AnyPool, email: &str) -> anyhow::Result<String> {
    let r = sqlx::query("SELECT id FROM users WHERE email = ?").bind(email.trim().to_lowercase()).fetch_optional(db).await?;
    r.map(|r| r.get::<String, _>("id")).ok_or_else(|| anyhow::anyhow!("Пользователь {email} не найден"))
}

/// Автосоздание root при старте из ROOT_EMAIL / ROOT_PASSWORD (если такого пользователя ещё нет).
/// Если пользователь с этой почтой уже есть, но без прав root — в лог пишется подсказка,
/// как выдать права (снятые права root автоматически не восстанавливаются).
pub async fn ensure_root_from_env(db: &AnyPool) -> anyhow::Result<()> {
    let Ok(email) = std::env::var("ROOT_EMAIL") else { return Ok(()) };
    let email = email.trim().to_lowercase();
    if email.is_empty() { return Ok(()); }
    let password = std::env::var("ROOT_PASSWORD").unwrap_or_default();
    match find_user(db, &email).await? {
        Some(u) => {
            if u.get::<i64, _>("is_root") != 0 {
                tracing::info!("root: {email}");
            } else {
                tracing::info!("ROOT_EMAIL={email}: аккаунт есть, но без прав root. Выдать права: users make-root {email}");
            }
        }
        None => {
            if password.is_empty() {
                tracing::warn!("ROOT_EMAIL={email} задан, но ROOT_PASSWORD пуст — root не создан. Создайте аккаунт командой: users create {email} <пароль> --root");
                return Ok(());
            }
            if password.chars().count() < WEB_PASSWORD_MIN {
                tracing::warn!("ROOT_PASSWORD короче {WEB_PASSWORD_MIN} символов — такой пароль легко подобрать перебором");
            }
            create(db, &email, &password, Some("root"), true).await?;
            tracing::info!("root: создан аккаунт {email}");
        }
    }
    Ok(())
}

// ---------- CLI и консоль ----------
//
// Одни и те же команды работают в двух режимах:
//   * отдельным процессом — `dnd-table users create admin@example.com …`;
//   * в консоли запущенного сервера (Pterodactyl, docker attach, run.sh) — с префиксом
//     `dnd-table` или без него: `dnd-table users create admin@example.com …`.
// Разбор аргументов общий, поэтому справка, подсказки и поведение везде одинаковые.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Как программа называется в подсказках (префикс команд).
const PROG: &str = "dnd-table";

/// Минимальная длина пароля в веб-формах (регистрация, смена пароля, API администратора).
/// CLI может создать аккаунт с более коротким паролем, но предупреждает об этом.
const WEB_PASSWORD_MIN: usize = 8;

/// Откуда пришла команда.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CliMode {
    /// Отдельный процесс: можно спросить пароль и подтверждение через stdin.
    Cli,
    /// Консоль работающего сервера: stdin читает другой поток, спрашивать нельзя.
    Console,
}

impl CliMode {
    /// Есть ли интерактивный терминал, у которого можно что-то спросить.
    fn interactive(self) -> bool {
        self == CliMode::Cli && std::io::IsTerminal::is_terminal(&std::io::stdin())
    }
}

/// Ошибка команды: понятное сообщение, необязательная подсказка и код возврата.
#[derive(Debug)]
pub struct CliError {
    pub msg: String,
    pub hint: Option<String>,
    pub code: i32,
}

impl CliError {
    /// Команда, флаги или аргументы поняты неверно — код 2 (как у большинства CLI).
    pub fn usage(msg: impl Into<String>) -> Self {
        Self { msg: msg.into(), hint: Some(format!("Справка: {PROG} help (например, {PROG} help users create)")), code: 2 }
    }
    /// Команда понята, но выполнить её не удалось — код 1.
    pub fn fail(msg: impl Into<String>) -> Self {
        Self { msg: msg.into(), hint: None, code: 1 }
    }
    /// Добавить или заменить подсказку под сообщением.
    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.msg) }
}
impl std::error::Error for CliError {}

/// Напечатать ошибку команды в stderr и выйти: код 2 — неверное использование, 1 — ошибка.
pub fn exit_cli_error(e: &anyhow::Error) -> ! {
    match e.downcast_ref::<CliError>() {
        Some(c) => {
            eprintln!("Ошибка: {}", c.msg);
            if let Some(h) = &c.hint { eprintln!("{h}"); }
            std::process::exit(c.code);
        }
        None => {
            eprintln!("Ошибка: {e:#}");
            std::process::exit(1);
        }
    }
}

/// Дополнить строку пробелами до ширины (считая символы — имена бывают на кириллице).
fn pad(s: &str, width: usize) -> String {
    format!("{s}{}", " ".repeat(width.saturating_sub(s.chars().count())))
}

/// Ответ «да» на вопрос в консоли (латиницей или по-русски).
fn is_yes(s: &str) -> bool {
    matches!(s.trim().to_lowercase().as_str(), "y" | "yes" | "д" | "да")
}

/// Предупреждение о слабом пароле. CLI создаёт такой аккаунт (доступ к базе — это уже полный
/// доступ), но честно говорит, что веб-форма и открытый интернет такого пароля не простят.
fn weak_password(password: &str) -> Option<String> {
    let n = password.chars().count();
    if n == 0 || n >= WEB_PASSWORD_MIN { return None; }
    Some(format!(
        "Пароль короче {WEB_PASSWORD_MIN} символов (их {n}): такой аккаунт легко подобрать перебором. \
         Веб-форма требует минимум {WEB_PASSWORD_MIN} символов — смените пароль: {PROG} users set-password <email>"
    ))
}

/// Скрыть/вернуть эхо в терминале, пока читаем пароль. На Unix используем stty (если он есть),
/// на остальных платформах пароль просто виден при вводе — об этом сообщаем заранее.
#[cfg(unix)]
fn terminal_echo(on: bool) {
    let _ = std::process::Command::new("stty").arg(if on { "echo" } else { "-echo" }).status();
}
#[cfg(not(unix))]
fn terminal_echo(_on: bool) {}

/// Прочитать строку из stdin, напечатав приглашение.
fn read_input(prompt: &str) -> Result<String, CliError> {
    use std::io::Write;
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut s = String::new();
    let n = std::io::stdin().read_line(&mut s).map_err(|e| CliError::fail(format!("Не удалось прочитать ввод: {e}")))?;
    if n == 0 { return Err(CliError::fail("Ввод прерван (stdin закрыт)")); }
    Ok(s.trim_end_matches(|c| c == '\r' || c == '\n').to_string())
}

/// Спросить пароль дважды. Вызывается только в интерактивном режиме (CLI + терминал).
fn ask_password(action: &str, email: &str) -> Result<String, CliError> {
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return Err(CliError::usage(format!("Не указан пароль для {email}"))
            .hint(format!("Пароль нужно передать аргументом: {PROG} users {action} {email} <пароль> (или флагом --password <пароль>)")));
    }
    if !cfg!(unix) {
        println!("Внимание: ввод пароля виден в терминале.");
    }
    terminal_echo(false);
    let first = read_input(&format!("Пароль для {email}: "));
    println!();
    let first = match first { Ok(v) => v, Err(e) => { terminal_echo(true); return Err(e); } };
    let second = read_input("Повторите пароль: ");
    println!();
    terminal_echo(true);
    let second = second?;
    if first.is_empty() { return Err(CliError::usage("Пустой пароль не подойдёт")); }
    if first != second { return Err(CliError::fail("Пароли не совпали — ничего не изменено")); }
    Ok(first)
}

/// Описание флага: как его писать (первое имя — каноническое) и нужен ли ему аргумент.
struct FlagSpec {
    keys: &'static [&'static str],
    value: bool,
}

const F_HELP: FlagSpec = FlagSpec { keys: &["help", "h"], value: false };
const F_NAME: FlagSpec = FlagSpec { keys: &["name", "n"], value: true };
const F_ROOT: FlagSpec = FlagSpec { keys: &["root", "r"], value: false };
const F_PASSWORD: FlagSpec = FlagSpec { keys: &["password", "p"], value: true };
const F_JSON: FlagSpec = FlagSpec { keys: &["json", "j"], value: false };
const F_YES: FlagSpec = FlagSpec { keys: &["yes", "y"], value: false };

/// Разобранная команда: позиционные аргументы и флаги со значениями.
struct Parsed {
    pos: Vec<String>,
    flags: Vec<(&'static str, Option<String>)>,
}

impl Parsed {
    fn has(&self, key: &str) -> bool { self.flags.iter().any(|f| f.0 == key) }
    fn value(&self, key: &str) -> Option<&str> { self.flags.iter().find(|f| f.0 == key).and_then(|f| f.1.as_deref()) }
    fn arg(&self, i: usize) -> Option<&str> { self.pos.get(i).map(String::as_str) }
    /// Позиционный аргумент i или понятная ошибка с примером вызова.
    fn need(&self, i: usize, what: &str, usage: impl Into<String>) -> Result<&str, CliError> {
        self.arg(i).ok_or_else(|| CliError::usage(format!("Не указано: {what}")).hint(format!("Как пользоваться: {}", usage.into())))
    }
    /// Значение флага, иначе — позиционный аргумент i.
    fn flag_or_arg(&self, key: &str, i: usize) -> Option<String> {
        self.value(key).map(str::to_string).or_else(|| self.arg(i).map(str::to_string))
    }
}

/// Разобрать аргументы команды: `--name Иван`, `--name=Иван`, `-n Иван`, `--` (дальше — только
/// позиционные). Флаги можно писать в любом месте, неизвестные — ошибка с подсказкой.
fn parse(args: &[String], specs: &[FlagSpec]) -> Result<Parsed, CliError> {
    let mut p = Parsed { pos: Vec::new(), flags: Vec::new() };
    let mut only_pos = false;
    let mut it = args.iter();
    while let Some(tok) = it.next() {
        if only_pos { p.pos.push(tok.clone()); continue; }
        if tok == "--" { only_pos = true; continue; }
        let Some(body) = tok.strip_prefix("--").or_else(|| tok.strip_prefix('-')) else { p.pos.push(tok.clone()); continue; };
        if body.is_empty() { return Err(CliError::usage(format!("Непонятный аргумент: {tok}"))); }
        let (name, inline) = match body.split_once('=') { Some((n, v)) => (n, Some(v.to_string())), None => (body, None) };
        let key = name.to_ascii_lowercase();
        let spec = specs.iter().find(|s| s.keys.contains(&key.as_str()))
            .ok_or_else(|| CliError::usage(format!("Неизвестный флаг: {tok}")).hint(format!("Флаги команды: {PROG} help <команда>")))?;
        if spec.value {
            let value = match inline {
                Some(v) => v,
                None => it.next().cloned().ok_or_else(|| CliError::usage(format!("Флагу {tok} нужно значение, например {tok} Иван")))?,
            };
            p.flags.push((spec.keys[0], Some(value)));
        } else {
            if inline.is_some() { return Err(CliError::usage(format!("Флаг {tok} пишется без значения"))); }
            p.flags.push((spec.keys[0], None));
        }
    }
    Ok(p)
}

/// Имя программы без каталогов и расширения: `./target/release/dnd-table`, `dnd-table.exe`, `run.bat`.
fn program_stem(tok: &str) -> String {
    let base = tok.trim().rsplit(['/', '\\']).next().unwrap_or(tok).to_lowercase();
    for suf in [".exe", ".cmd", ".bat", ".sh", ".ps1"] {
        if let Some(s) = base.strip_suffix(suf) { return s.to_string(); }
    }
    base
}

/// Убрать из начала аргументов «обёртки», которые копируют вместе с командой:
/// `dnd-table users list`, `./dnd-table users list`, `dnd-table.exe users list`,
/// `run.bat users list`, `cargo run --release -- users list`.
pub(crate) fn strip_launcher(args: &[String]) -> Vec<String> {
    let mut a: Vec<String> = args.to_vec();
    loop {
        let Some(first) = a.first() else { break };
        match program_stem(first).as_str() {
            // сам бинарник и скрипты-лаунчеры: `run.sh users list`, `run.bat users list`
            "dnd-table" | "dndtable" | "dnd_table" | "run" | "start" => { a.remove(0); }
            // `cargo run [--release] [--bin dnd-table] -- users list`
            "cargo" => {
                a.remove(0);
                if a.first().map(|t| program_stem(t) == "run").unwrap_or(false) { a.remove(0); }
                while let Some(t) = a.first() {
                    if t == "--" { a.remove(0); break; }
                    if !t.starts_with('-') { break; }
                    let name = t.split('=').next().unwrap_or("");
                    let takes_value = matches!(name, "--bin" | "--package" | "-p" | "--features" | "--manifest-path" | "--example" | "--profile" | "--target");
                    let inline = t.contains('=');
                    a.remove(0);
                    if takes_value && !inline && a.first().map(|v| !v.starts_with('-')).unwrap_or(false) { a.remove(0); }
                }
            }
            _ => break,
        }
    }
    a
}

pub const HELP: &str = "\
Amperverser DnD Table (Edge Tablet) — сервер и команды администрирования

Запуск:
  dnd-table                        запустить сервер (по умолчанию)
  dnd-table serve                  то же самое

Пользователи:
  dnd-table users list [--json]    список пользователей
  dnd-table users show <email>     подробности об аккаунте
  dnd-table users create <email> [пароль] [--name <имя>] [--root]
                                   создать подтверждённого пользователя
  dnd-table users set-password <email> [пароль]
                                   сменить пароль (и разлогинить все сессии)
  dnd-table users rename <email> <имя>
                                   сменить отображаемое имя
  dnd-table users make-root <email>     выдать права root
  dnd-table users revoke-root <email>   снять права root
  dnd-table users delete <email>   удалить пользователя и его кампании

База:
  dnd-table stats [--json]         сводка по базе
  dnd-table reseed [--yes]         пересоздать базовый справочник из вшитого seed
  dnd-table version                версия
  dnd-table help [команда]         справка (например: help users create)

Пароль можно не указывать — команда спросит его (в консоли сервера так нельзя: там пароль
передаётся аргументом). Флаги пишутся как --name Иван, --name=Иван или -n Иван.
Коды возврата: 0 — успех, 1 — ошибка, 2 — неверное использование команды.

Консоль запущенного сервера (Pterodactyl, docker attach, run.sh) понимает те же команды
как есть или с префиксом dnd-table:
  help | users list | users create <email> <пароль> --root | stats | stop

Через cargo: cargo run --release -- users make-root admin@example.com
Переменные: DATABASE_URL, ROOT_EMAIL + ROOT_PASSWORD (создание root при первом старте,
если такого аккаунта ещё нет; снятые права root не восстанавливаются автоматически).";

const HELP_USERS: &str = "\
dnd-table users — управление пользователями

  users list [--json]                      список пользователей
  users show <email> [--json]              подробности об аккаунте
  users create <email> [пароль] [--name <имя>] [--root]
                                           создать подтверждённого пользователя
  users set-password <email> [пароль]      сменить пароль и разлогинить все сессии
  users rename <email> <имя>               сменить отображаемое имя
  users make-root <email>                  выдать права root
  users revoke-root <email>                снять права root
  users delete <email> [--yes]             удалить пользователя и его кампании

Справка по конкретной команде: dnd-table help users create";

const HELP_LIST: &str = "\
dnd-table users list [--json]

Список пользователей: почта, имя, права root, подтверждение почты, дата создания.
  --json    машиночитаемый вывод (те же поля, что у GET /api/admin/users)";

const HELP_SHOW: &str = "\
dnd-table users show <email> [--json]

Подробности об аккаунте: id, имя, права root, подтверждение почты, наличие пароля, дата
создания, кампании (владелец/участник), персонажи, наборы, активные сессии.";

const HELP_CREATE: &str = "\
dnd-table users create <email> [пароль] [--name <имя>] [--root]

Создаёт уже подтверждённого пользователя: код на почту не нужен, пароль хэшируется argon2,
вход работает сразу. Если пароль не указан — команда спросит его (только в терминале;
в консоли сервера пароль передаётся аргументом).

  --name <имя>      отображаемое имя (по умолчанию — часть почты до @)
  --root            сразу выдать права администратора
  --password <пар>  пароль флагом (для скриптов; аргумент команды виден в истории)

Пароль короче 8 символов команда создать даст, но предупредит: веб-форма такой пароль не
принимает, а аккаунт доступен из сети.

Примеры:
  dnd-table users create admin@example.com 'секрет-подлиннее' --name Админ --root
  dnd-table users create player@example.com
  dnd-table users create player@example.com secret123 --name Игрок";

const HELP_SET_PASSWORD: &str = "\
dnd-table users set-password <email> [пароль]

Меняет пароль (argon2) и завершает все сессии пользователя, почта помечается подтверждённой.
Без пароля команда спросит его интерактивно; флаг --password <пароль> — для скриптов.";

const HELP_RENAME: &str = "\
dnd-table users rename <email> <имя>

Меняет отображаемое имя (то же, что «имя» в веб-интерфейсе). Длиннее 64 символов обрезается.";

const HELP_MAKE_ROOT: &str = "\
dnd-table users make-root <email>

Выдаёт права администратора (users.is_root): редактирование базового справочника, любых
наборов, встроенных ассетов и управление пользователями на странице /admin.";
const HELP_REVOKE_ROOT: &str = "\
dnd-table users revoke-root <email>

Снимает права администратора. Если root-пользователей не осталось, команда предупредит:
вернуть права можно только этой командой (или ROOT_EMAIL при следующем старте сервера).";

const HELP_DELETE: &str = "\
dnd-table users delete <email> [--yes]

Удаляет пользователя вместе с его кампаниями (сцены, персонажи, ресурсы, наборы) и сессиями.
  --yes    не спрашивать подтверждение (в скриптах вопрос и так не задаётся)";

const HELP_STATS: &str = "\
dnd-table stats [--json]

Сводка по базе: пользователи (и сколько из них root), кампании, персонажи, ассеты,
базовый справочник, наборы.  --json — тот же вывод в виде JSON (ключи как у GET /api/admin/stats).";

const HELP_RESEED: &str = "\
dnd-table reseed [--yes]

Удаляет базовые записи справочника (SRD) и заливает их заново из вшитого seed.
Правки root в базовых записях теряются; личные наборы и homebrew не трогаются.";

/// Справка по конкретной команде (или общая).
fn print_help(topic: &[String]) -> Result<(), CliError> {
    let key = topic.iter().filter(|t| !t.starts_with('-')).map(|t| t.to_lowercase()).collect::<Vec<_>>().join(" ");
    let text = match key.as_str() {
        "" => HELP,
        "users" | "user" => HELP_USERS,
        "users list" | "users ls" | "list" => HELP_LIST,
        "users show" | "users info" | "show" => HELP_SHOW,
        "users create" | "users add" | "users new" | "create" => HELP_CREATE,
        "users set-password" | "users passwd" | "set-password" => HELP_SET_PASSWORD,
        "users rename" | "users set-name" | "rename" => HELP_RENAME,
        "users make-root" | "users grant-root" | "make-root" => HELP_MAKE_ROOT,
        "users revoke-root" | "users remove-root" | "revoke-root" => HELP_REVOKE_ROOT,
        "users delete" | "users del" | "users rm" | "delete" => HELP_DELETE,
        "stats" => HELP_STATS,
        "reseed" => HELP_RESEED,
        "serve" | "server" => "dnd-table [serve]\n\nЗапускает сервер (без аргументов — то же самое).\nКоманды администрирования работают и в консоли запущенного сервера: help, users list, stats, stop.",
        "version" => "dnd-table version\n\nПечатает версию бинарника.",
        other => return Err(CliError::usage(format!("Нет справки по «{other}»"))),
    };
    println!("{text}");
    Ok(())
}

// ---------- команды ----------

/// Возвращает Ok(true), если аргументы — команда администрирования и она выполнена
/// (сервер запускать не нужно), и Ok(false), если нужно запускать сервер.
pub async fn run_cli(db: &AnyPool, args: &[String], mode: CliMode) -> anyhow::Result<bool> {
    let argv = strip_launcher(args);
    let first = argv.first().map(|s| s.to_lowercase()).unwrap_or_default();
    let rest: &[String] = if argv.is_empty() { &[] } else { &argv[1..] };

    if first.is_empty() || matches!(first.as_str(), "serve" | "server") {
        if rest.iter().any(|t| matches!(t.as_str(), "--help" | "-h" | "help")) {
            println!("{HELP}");
            return Ok(true);
        }
        return Ok(false);
    }
    match first.as_str() {
        "help" | "?" | "--help" | "-h" | "справка" => print_help(rest)?,
        "version" | "--version" | "-v" | "-V" | "версия" => println!("{PROG} {VERSION} — Amperverser DnD Table (Edge Tablet)"),
        "users" | "user" => users_cmd(db, rest, mode).await?,
        "stats" => stats_cmd(db, rest).await?,
        "reseed" => reseed_cmd(db, rest, mode).await?,
        other => return Err(CliError::usage(format!("Неизвестная команда: {other}")).into()),
    }
    Ok(true)
}

async fn users_cmd(db: &AnyPool, args: &[String], mode: CliMode) -> anyhow::Result<()> {
    let sub = args.first().map(|s| s.to_lowercase()).unwrap_or_default();
    let rest: &[String] = if args.is_empty() { &[] } else { &args[1..] };
    match sub.as_str() {
        "" | "help" | "--help" | "-h" | "?" => println!("{HELP_USERS}"),
        "list" | "ls" => users_list(db, rest).await?,
        "show" | "info" => users_show(db, rest).await?,
        "create" | "add" | "new" => users_create(db, rest, mode).await?,
        "set-password" | "passwd" | "password" => users_set_password(db, rest, mode).await?,
        "rename" | "set-name" => users_rename(db, rest).await?,
        "make-root" | "grant-root" | "root" => users_set_root(db, rest, true).await?,
        "revoke-root" | "remove-root" | "unroot" => users_set_root(db, rest, false).await?,
        "delete" | "del" | "rm" | "remove" => users_delete(db, rest, mode).await?,
        other => return Err(CliError::usage(format!("Неизвестная подкоманда: users {other}"))
            .hint(format!("Подкоманды: {PROG} help users")).into()),
    }
    Ok(())
}

async fn users_list(db: &AnyPool, args: &[String]) -> anyhow::Result<()> {
    let p = parse(args, &[F_JSON, F_HELP])?;
    if p.has("help") { println!("{HELP_LIST}"); return Ok(()); }
    let rows = sqlx::query(&format!("SELECT {USER_COLS} FROM users ORDER BY created_at")).fetch_all(db).await?;
    if p.has("json") {
        println!("{}", serde_json::to_string_pretty(&Value::Array(rows.iter().map(user_json).collect()))?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("Пользователей нет.");
        println!("Создать администратора: {PROG} users create admin@example.com <пароль> --root");
        return Ok(());
    }
    println!("{} {} {} {} {}", pad("EMAIL", 32), pad("ИМЯ", 20), pad("ROOT", 6), pad("ПОЧТА", 7), "СОЗДАН");
    for r in &rows {
        let created: String = r.get("created_at");
        println!("{} {} {} {} {}", pad(&r.get::<String, _>("email"), 32), pad(&r.get::<String, _>("name"), 20),
            pad(if r.get::<i64, _>("is_root") != 0 { "да" } else { "—" }, 6),
            pad(if r.get::<i64, _>("verified") != 0 { "да" } else { "нет" }, 7),
            created.chars().take(10).collect::<String>());
    }
    let roots = rows.iter().filter(|r| r.get::<i64, _>("is_root") != 0).count();
    println!("Всего: {} (root: {roots})", rows.len());
    println!("Подробности: {PROG} users show <email>");
    Ok(())
}

async fn users_show(db: &AnyPool, args: &[String]) -> anyhow::Result<()> {
    let p = parse(args, &[F_JSON, F_HELP])?;
    if p.has("help") { println!("{HELP_SHOW}"); return Ok(()); }
    let email = p.need(0, "почта", format!("{PROG} users show <email>"))?;
    let u = find_user(db, email).await?.ok_or_else(|| CliError::fail(format!("Пользователь {email} не найден")).hint(format!("Список: {PROG} users list")))?;
    let id: String = u.get("id");
    let email: String = u.get("email");
    let name: String = u.get("name");
    let is_root = u.get::<i64, _>("is_root") != 0;
    let verified = u.get::<i64, _>("verified") != 0;
    let has_password = u.get::<Option<String>, _>("password_hash").map(|h| !h.is_empty()).unwrap_or(false);
    let created: String = u.get("created_at");
    let owned = count(db, "SELECT COUNT(*) AS n FROM campaigns WHERE owner_id = ?", &id).await?;
    let member = count(db, "SELECT COUNT(*) AS n FROM campaign_members WHERE user_id = ?", &id).await?;
    let characters = count(db, "SELECT COUNT(*) AS n FROM characters WHERE owner_id = ?", &id).await?;
    let packs = count(db, "SELECT COUNT(*) AS n FROM packs WHERE owner_id = ?", &id).await?;
    let sessions = count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", &id).await?;
    if p.has("json") {
        println!("{}", serde_json::to_string_pretty(&json!({
            "id": id, "email": email, "name": name, "is_root": is_root, "verified": verified,
            "has_password": has_password, "created_at": created,
            "campaigns_owned": owned, "campaigns_member": member, "characters": characters, "packs": packs, "sessions": sessions,
        }))?);
        return Ok(());
    }
    println!("{email}");
    println!("  id:            {id}");
    println!("  имя:           {name}");
    println!("  root:          {}", if is_root { "да" } else { "нет" });
    println!("  почта:         {}", if verified { "подтверждена" } else { "не подтверждена" });
    println!("  пароль:        {}", if has_password { "задан" } else { "не задан (вход по коду из письма)" });
    println!("  создан:        {created}");
    println!("  кампании:      {owned} (владелец), {member} (участник)");
    println!("  персонажи:     {characters}");
    println!("  наборы:        {packs}");
    println!("  сессии:        {sessions}");
    Ok(())
}

async fn users_create(db: &AnyPool, args: &[String], mode: CliMode) -> anyhow::Result<()> {
    let p = parse(args, &[F_NAME, F_ROOT, F_PASSWORD, F_HELP])?;
    if p.has("help") { println!("{HELP_CREATE}"); return Ok(()); }
    let raw_email = p.need(0, "почта", format!("{PROG} users create <email> <пароль> [--name <имя>] [--root]"))?;
    let email = crate::auth::check_email(raw_email)
        .map_err(|_| CliError::usage(format!("Некорректная почта: {raw_email}")).hint("Нужен вид name@domain.tld — вход на сервер выполняется по этой же почте"))?;
    if let Some(u) = find_user(db, &email).await? {
        let root = u.get::<i64, _>("is_root") != 0;
        return Err(CliError::fail(format!("Пользователь {email} уже есть"))
            .hint(format!("Сменить пароль: {PROG} users set-password {email} <новый пароль>{}", if root { format!("\nСнять права root: {PROG} users revoke-root {email}") } else { format!("\nВыдать root: {PROG} users make-root {email}") })));
    }
    let mut password = p.flag_or_arg("password", 1);
    if password.is_none() && mode.interactive() { password = Some(ask_password("create", &email)?); }
    let Some(password) = password else {
        return Err(CliError::usage(format!("Не указан пароль для {email}"))
            .hint(format!("Как создать: {PROG} users create {email} <пароль> [--name <имя>] [--root]")));
    };
    if password.is_empty() { return Err(CliError::usage("Пароль не может быть пустым")); }
    if password.chars().count() > 200 { return Err(CliError::usage("Слишком длинный пароль (максимум 200 символов)")); }

    let name = p.value("name").map(str::to_string);
    let root = p.has("root");
    let id = create(db, &email, &password, name.as_deref(), root).await.map_err(|e| CliError::fail(e.to_string()))?;
    let u = sqlx::query(&format!("SELECT {USER_COLS} FROM users WHERE id = ?")).bind(&id).fetch_one(db).await?;
    println!("Пользователь создан: {}", u.get::<String, _>("email"));
    println!("  id: {}   имя: {}   root: {}", id, u.get::<String, _>("name"), if root { "да" } else { "нет" });
    println!("  Почта подтверждена — вход по паролю работает сразу.");
    if let Some(w) = weak_password(&password) { println!("  [!] {w}"); }
    Ok(())
}

async fn users_set_password(db: &AnyPool, args: &[String], mode: CliMode) -> anyhow::Result<()> {
    let p = parse(args, &[F_PASSWORD, F_HELP])?;
    if p.has("help") { println!("{HELP_SET_PASSWORD}"); return Ok(()); }
    let email = p.need(0, "почта", format!("{PROG} users set-password <email> <пароль>"))?;
    let mut password = p.flag_or_arg("password", 1);
    if password.is_none() && mode.interactive() { password = Some(ask_password("set-password", email)?); }
    let Some(password) = password else {
        return Err(CliError::usage(format!("Не указан новый пароль для {email}"))
            .hint(format!("Как сменить: {PROG} users set-password {email} <пароль>")));
    };
    if password.is_empty() { return Err(CliError::usage("Пароль не может быть пустым")); }
    let id = find_id(db, email).await.map_err(|e| CliError::fail(e.to_string()))?;
    let hash = auth::hash_password(&password).map_err(|e| CliError::fail(e.1))?;
    sqlx::query("UPDATE users SET password_hash = ?, verified = 1 WHERE id = ?").bind(hash).bind(&id).execute(db).await?;
    let closed = sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&id).execute(db).await?.rows_affected();
    println!("{email}: пароль обновлён, почта подтверждена, закрыто сессий: {closed}");
    if let Some(w) = weak_password(&password) { println!("[!] {w}"); }
    Ok(())
}

async fn users_rename(db: &AnyPool, args: &[String]) -> anyhow::Result<()> {
    let p = parse(args, &[F_NAME, F_HELP])?;
    if p.has("help") { println!("{HELP_RENAME}"); return Ok(()); }
    let email = p.need(0, "почта", format!("{PROG} users rename <email> <имя>"))?;
    let name = p.flag_or_arg("name", 1).map(|n| util::truncate(n.trim(), 64)).unwrap_or_default();
    if name.is_empty() { return Err(CliError::usage("Не указано новое имя").hint(format!("Как переименовать: {PROG} users rename {email} Иван"))); }
    let id = find_id(db, email).await.map_err(|e| CliError::fail(e.to_string()))?;
    sqlx::query("UPDATE users SET name = ? WHERE id = ?").bind(&name).bind(&id).execute(db).await?;
    println!("{email}: имя изменено на «{name}»");
    Ok(())
}

async fn users_set_root(db: &AnyPool, args: &[String], enable: bool) -> anyhow::Result<()> {
    let p = parse(args, &[F_HELP])?;
    if p.has("help") { println!("{}", if enable { HELP_MAKE_ROOT } else { HELP_REVOKE_ROOT }); return Ok(()); }
    let email = p.need(0, "почта", format!("{PROG} users {} <email>", if enable { "make-root" } else { "revoke-root" }))?;
    let id = find_id(db, email).await.map_err(|e| CliError::fail(e.to_string()))?;
    let was_root: i64 = sqlx::query("SELECT is_root FROM users WHERE id = ?").bind(&id).fetch_one(db).await?.get("is_root");
    if was_root != 0 && enable {
        println!("{email}: уже root, ничего не менялось");
        return Ok(());
    }
    sqlx::query("UPDATE users SET is_root = ?, verified = 1 WHERE id = ?").bind(if enable { 1i64 } else { 0 }).bind(&id).execute(db).await?;
    let roots = root_count(db).await.map_err(|e| CliError::fail(e.1))?;
    println!("{email}: root = {}, всего root: {roots}", if enable { "да" } else { "нет" });
    if roots == 0 {
        println!("[!] В системе не осталось ни одного root. Вернуть права: {PROG} users make-root <email>");
    }
    Ok(())
}

async fn users_delete(db: &AnyPool, args: &[String], mode: CliMode) -> anyhow::Result<()> {
    let p = parse(args, &[F_YES, F_HELP])?;
    if p.has("help") { println!("{HELP_DELETE}"); return Ok(()); }
    let email = p.need(0, "почта", format!("{PROG} users delete <email>"))?;
    let u = find_user(db, email).await?.ok_or_else(|| CliError::fail(format!("Пользователь {email} не найден")).hint(format!("Список: {PROG} users list")))?;
    let id: String = u.get("id");
    let is_root = u.get::<i64, _>("is_root") != 0;
    let campaigns = count(db, "SELECT COUNT(*) AS n FROM campaigns WHERE owner_id = ?", &id).await?;
    let characters = count(db, "SELECT COUNT(*) AS n FROM characters WHERE owner_id = ?", &id).await?;
    let packs = count(db, "SELECT COUNT(*) AS n FROM packs WHERE owner_id = ?", &id).await?;
    if !p.has("yes") && mode.interactive() {
        let answer = read_input(&format!("Удалить {email} (кампаний: {campaigns}, персонажей: {characters}, наборов: {packs})? Это необратимо [y/N]: "))?;
        if !is_yes(&answer) { println!("Отменено."); return Ok(()); }
    }
    delete_by_id(db, &id).await.map_err(|e| CliError::fail(e.1))?;
    println!("Удалён пользователь {email} (кампаний: {campaigns}, персонажей: {characters}, наборов: {packs})");
    if is_root {
        let roots = root_count(db).await.map_err(|e| CliError::fail(e.1))?;
        if roots == 0 { println!("[!] В системе не осталось ни одного root. Создать: {PROG} users create <email> <пароль> --root"); }
    }
    Ok(())
}

/// COUNT(*) с одним строковым параметром (id пользователя).
async fn count(db: &AnyPool, sql: &str, param: &str) -> anyhow::Result<i64> {
    Ok(sqlx::query(sql).bind(param).fetch_one(db).await?.get("n"))
}

async fn stats_cmd(db: &AnyPool, args: &[String]) -> anyhow::Result<()> {
    let p = parse(args, &[F_JSON, F_HELP])?;
    if p.has("help") { println!("{HELP_STATS}"); return Ok(()); }
    let rows = collect_stats(db).await?;
    if p.has("json") {
        let map: serde_json::Map<String, Value> = rows.iter().map(|(k, _, n)| ((*k).to_string(), json!(n))).collect();
        println!("{}", serde_json::to_string_pretty(&Value::Object(map))?);
        return Ok(());
    }
    for (key, label, n) in &rows {
        if *key == "users_root" || *key == "assets_builtin" { continue; } // вошли в строки выше
        match *key {
            "users" => {
                let roots = rows.iter().find(|r| r.0 == "users_root").map(|r| r.2).unwrap_or(0);
                println!("{}{} (root: {roots})", pad(label, 24), n);
            }
            "assets" => {
                let builtin = rows.iter().find(|r| r.0 == "assets_builtin").map(|r| r.2).unwrap_or(0);
                println!("{}{} (встроенных: {builtin})", pad(label, 24), n);
            }
            _ => println!("{}{}", pad(label, 24), n),
        }
    }
    Ok(())
}

async fn reseed_cmd(db: &AnyPool, args: &[String], mode: CliMode) -> anyhow::Result<()> {
    let p = parse(args, &[F_YES, F_HELP])?;
    if p.has("help") { println!("{HELP_RESEED}"); return Ok(()); }
    if !p.has("yes") && mode.interactive() {
        let answer = read_input("Заменить базовый справочник вшитым seed? Правки базовых записей потеряются [y/N]: ")?;
        if !is_yes(&answer) { println!("Отменено."); return Ok(()); }
    }
    let base = "SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL";
    let before: i64 = sqlx::query(base).fetch_one(db).await?.get("n");
    sqlx::query("DELETE FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL").execute(db).await?;
    crate::seed::seed(db).await?;
    let after: i64 = sqlx::query(base).fetch_one(db).await?.get("n");
    println!("Базовый справочник пересоздан: было {before} записей, стало {after}");
    Ok(())
}

/// Интерактивная консоль запущенного сервера: читает команды из stdin (консоль Pterodactyl /
/// docker attach / терминал) и выполняет их тем же кодом, что и CLI. Команду можно писать как
/// есть (`users list`) или с префиксом (`dnd-table users list`). Если stdin закрыт или
/// недоступен — просто завершается.
pub fn spawn_console(db: AnyPool) {
    let handle = tokio::runtime::Handle::current();
    let _ = std::thread::Builder::new().name("console".into()).spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() { continue; }
            let args: Vec<String> = match shell_split(line) {
                Ok(a) => a,
                Err(e) => { println!("{e}"); continue; }
            };
            let cmd = strip_launcher(&args);
            match cmd.first().map(|s| s.to_lowercase()).unwrap_or_default().as_str() {
                "stop" | "exit" | "quit" => { println!("Остановка сервера…"); std::process::exit(0); }
                "" | "serve" | "server" => { println!("Сервер уже запущен. Команды: help, users list, stats, stop"); continue; }
                _ => {}
            }
            let db = db.clone();
            if let Err(e) = handle.block_on(async move { run_cli(&db, &cmd, CliMode::Console).await }) {
                match e.downcast_ref::<CliError>() {
                    Some(c) => {
                        println!("Ошибка: {}", c.msg);
                        if let Some(h) = &c.hint { println!("{h}"); }
                    }
                    None => println!("Ошибка: {e}"),
                }
            }
        }
    });
}

/// Разбор строки консоли с поддержкой кавычек: users create a@b.c pass --name "Иван Иванов".
fn shell_split(s: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new(); let mut cur = String::new(); let mut quote: Option<char> = None; let mut has = false;
    for ch in s.chars() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"') | (None, '\'') => { quote = Some(ch); has = true; }
            (None, c) if c.is_whitespace() => { if has || !cur.is_empty() { out.push(std::mem::take(&mut cur)); has = false; } }
            (None, c) => { cur.push(c); has = true; }
        }
    }
    if quote.is_some() { return Err("Незакрытая кавычка".into()); }
    if has || !cur.is_empty() { out.push(cur); }
    Ok(out)
}
