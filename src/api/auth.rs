//! Авторизация: email + пароль (argon2), подтверждение почты кодом, сброс пароля по коду; сессии в cookie/Bearer.
//! Задел под Google OAuth: поле users.google_sub и маршрут /api/auth/google.
use axum::{
    async_trait,
    extract::{FromRequestParts, State},
    http::{header, request::Parts, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use lettre::{message::header::ContentType, transport::smtp::authentication::Credentials, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::{config::SmtpSecurity, error::ApiResult, util, AppError, AppState};

pub const COOKIE: &str = "dnd_session";
pub const COOKIE_X: &str = "dnd_session_x";

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_root: bool,
    pub avatar_asset_id: Option<String>,
    pub created_at: String,
    /// Есть ли у аккаунта пароль: профиль просит текущий пароль только когда он задан.
    pub has_password: bool,
}

impl AuthUser {
    /// Требует права root (администратор сервера).
    pub fn require_root(&self) -> ApiResult<()> {
        if self.is_root { Ok(()) } else { Err(AppError::forbidden("Требуются права root")) }
    }
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = session_token(&parts.headers).ok_or_else(|| AppError::unauthorized("Требуется вход"))?;
        user_by_token(st, &token).await?.ok_or_else(|| AppError::unauthorized("Сессия недействительна"))
    }
}

/// Токен сессии из Bearer-заголовка или любого из двух cookie.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    util::bearer(headers).or_else(|| util::cookie(headers, COOKIE)).or_else(|| util::cookie(headers, COOKIE_X))
}

pub async fn user_by_token(st: &AppState, token: &str) -> ApiResult<Option<AuthUser>> {
    let row = sqlx::query("SELECT u.id, u.email, u.name, u.is_root, u.avatar_asset_id, u.created_at, u.password_hash, s.created_at AS session_created FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?")
        .bind(token)
        .fetch_optional(&st.db)
        .await?;
    // Срок жизни сессии (auth.session_days в config.yml; 0 — без ограничения)
    if let Some(r) = &row {
        let days = st.cfg.auth.session_days;
        if days > 0 {
            let created: String = r.get("session_created");
            let expired = chrono::DateTime::parse_from_rfc3339(&created)
                .map(|t| t + chrono::Duration::days(days) < chrono::Utc::now())
                .unwrap_or(false);
            if expired {
                sqlx::query("DELETE FROM sessions WHERE token = ?").bind(token).execute(&st.db).await?;
                return Ok(None);
            }
        }
    }
    Ok(row.map(|r| {
        let hash: Option<String> = r.get("password_hash");
        AuthUser {
            id: r.get("id"),
            email: r.get("email"),
            name: r.get("name"),
            is_root: r.get::<i64, _>("is_root") != 0,
            avatar_asset_id: r.get("avatar_asset_id"),
            created_at: r.get("created_at"),
            has_password: hash.map(|h| !h.is_empty()).unwrap_or(false),
        }
    }))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/request-code", post(request_code))
        .route("/api/auth/verify", post(verify))
        .route("/api/auth/reset-password", post(reset_password))
        .route("/api/auth/google", get(google_stub).post(google_stub))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/logout-all", post(logout_all))
        .route("/api/auth/me", get(me).patch(update_me).delete(delete_me))
        .route("/api/auth/change-email/request-code", post(change_email_request_code))
        .route("/api/auth/change-email", post(change_email))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/auth/settings", get(public_settings))
}

/// Публичные настройки для форм входа/регистрации (из config.yml).
async fn public_settings(State(st): State<AppState>) -> Json<serde_json::Value> {
    let a = &st.cfg.auth;
    Json(json!({
        "allow_registration": a.allow_registration,
        "password_min_length": a.password_min_length,
        "code_ttl_minutes": a.code_ttl_minutes,
        "max_upload_mb": st.cfg.images.max_upload_mb,
    }))
}

// ---------- отправка почты ----------
async fn send_code(st: &AppState, to: &str, code: &str) -> bool {
    let cfg = &st.cfg.smtp;
    let ttl = st.cfg.auth.code_ttl_minutes;
    if cfg.host.is_empty() {
        tracing::warn!("SMTP не настроен. Код для {}: {}", to, code);
        println!("\n===== КОД ПОДТВЕРЖДЕНИЯ для {to}: {code} =====\n");
        return false;
    }
    let result: anyhow::Result<()> = async {
        let email = Message::builder()
            .from(cfg.from.parse()?)
            .to(to.parse()?)
            .subject(format!("Код входа: {code}"))
            .header(ContentType::TEXT_PLAIN)
            .body(format!("Ваш код подтверждения Edge Tablet: {code}\nКод действует {ttl} мин."))?;
        let builder = match cfg.security() {
            SmtpSecurity::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)?,
            SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)?,
            SmtpSecurity::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
        };
        let mut builder = builder.port(cfg.port);
        if !cfg.user.is_empty() {
            builder = builder.credentials(Credentials::new(cfg.user.clone(), cfg.password.clone()));
        }
        builder.build().send(email).await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => true,
        Err(e) => {
            tracing::error!("Ошибка отправки письма: {e}. Код: {code}");
            println!("\n===== (SMTP error) КОД для {to}: {code} =====\n");
            false
        }
    }
}

// ---------- эндпоинты ----------
#[derive(Deserialize)]
pub struct RequestCodeIn { pub email: String }

/// Проверка и нормализация почты: одно правило на вход, регистрацию, сброс пароля и CLI
/// (чтобы аккаунт, созданный в CLI, точно можно было использовать для входа).
pub fn check_email(e: &str) -> Result<String, String> {
    let e = e.trim().to_lowercase();
    if e.len() > 255 {
        return Err("Слишком длинная почта (максимум 255 символов)".into());
    }
    if e.len() < 5 || !e.contains('@') || !e.split('@').nth(1).map(|d| d.contains('.')).unwrap_or(false) {
        return Err(format!("Некорректная почта: {e} (нужен вид name@domain.tld)"));
    }
    Ok(e)
}

fn norm_email(e: &str) -> ApiResult<String> {
    check_email(e).map_err(AppError::bad)
}

async fn request_code(State(st): State<AppState>, Json(body): Json<RequestCodeIn>) -> ApiResult<Json<serde_json::Value>> {
    let email = norm_email(&body.email)?;
    Ok(Json(issue_code(&st, &email).await?))
}

/// Выпустить и отправить код подтверждения на почту.
async fn issue_code(st: &AppState, email: &str) -> ApiResult<serde_json::Value> {
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
    let ttl = st.cfg.auth.code_ttl_minutes;
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(ttl)).to_rfc3339();
    sqlx::query("UPDATE auth_codes SET used = 1 WHERE email = ? AND used = 0").bind(email).execute(&st.db).await?;
    sqlx::query("INSERT INTO auth_codes (email, code, expires_at, attempts, used) VALUES (?, ?, ?, 0, 0)")
        .bind(email).bind(&code).bind(&expires).execute(&st.db).await?;
    let sent = send_code(st, email, &code).await;
    let mut out = json!({ "ok": true, "sent": sent, "ttl_min": ttl });
    if !sent && st.cfg.auth.dev_show_code {
        out["dev_code"] = json!(code);
    }
    Ok(out)
}

/// Проверить код (сжигает его при успехе).
async fn consume_code(st: &AppState, email: &str, code: &str) -> ApiResult<()> {
    let row = sqlx::query("SELECT id, code, expires_at, attempts FROM auth_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1")
        .bind(email).fetch_optional(&st.db).await?;
    let row = row.ok_or_else(|| AppError::bad("Код не запрошен или истёк"))?;
    let id: i64 = row.get("id");
    let expires: String = row.get("expires_at");
    let attempts: i64 = row.get("attempts");
    let real: String = row.get("code");
    let expired = chrono::DateTime::parse_from_rfc3339(&expires).map(|t| t < chrono::Utc::now()).unwrap_or(true);
    if expired {
        return Err(AppError::bad("Код не запрошен или истёк"));
    }
    if attempts >= st.cfg.auth.code_max_attempts {
        sqlx::query("UPDATE auth_codes SET used = 1 WHERE id = ?").bind(id).execute(&st.db).await?;
        return Err(AppError::bad("Слишком много попыток, запросите новый код"));
    }
    if real != code.trim() {
        sqlx::query("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?").bind(id).execute(&st.db).await?;
        return Err(AppError::bad("Неверный код"));
    }
    sqlx::query("UPDATE auth_codes SET used = 1 WHERE id = ?").bind(id).execute(&st.db).await?;
    Ok(())
}

pub fn hash_password(pw: &str) -> ApiResult<String> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default().hash_password(pw.as_bytes(), &salt).map(|h| h.to_string()).map_err(|_| AppError::internal("Ошибка хэширования"))
}
fn verify_password(pw: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    PasswordHash::new(hash).map(|h| argon2::Argon2::default().verify_password(pw.as_bytes(), &h).is_ok()).unwrap_or(false)
}
/// Правило длины пароля для веб-форм и API; `min` — auth.password_min_length из config.yml
/// (CLI может создать и более короткий пароль — он предупреждает, но не запрещает: доступ к базе
/// и так даёт полные права).
pub fn check_password(pw: &str, min: usize) -> ApiResult<()> {
    let n = pw.chars().count();
    if n < min { return Err(AppError::bad(format!("Пароль должен быть не короче {min} символов (сейчас {n})"))); }
    if n > 200 { return Err(AppError::bad("Слишком длинный пароль (максимум 200 символов)")); }
    Ok(())
}

/// Имя профиля: обрезаем пробелы, требуем 1..64 символа. Это правило общее для страницы
/// профиля, PATCH /api/auth/me и тестов, поэтому длинное имя отклоняется, а не обрезается молча.
pub fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let n = name.chars().count();
    if n == 0 {
        return Err("Имя не может быть пустым".into());
    }
    if n > 64 {
        return Err(format!("Имя слишком длинное: {n} символов (максимум 64)"));
    }
    Ok(name.to_string())
}

/// Создать сессию и ответ с cookie + токеном.
async fn start_session(st: &AppState, headers: &HeaderMap, user_id: &str, email: &str, name: &str) -> ApiResult<Response> {
    let token = util::token(48);
    sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").bind(&token).bind(user_id).bind(util::now()).execute(&st.db).await?;
    let body = json!({ "ok": true, "token": token, "user": { "id": user_id, "email": email, "name": name } });
    let mut resp = Json(body).into_response();
    // За HTTPS-прокси (в т.ч. во фрейме на другом домене) нужен SameSite=None; Secure
    let https = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).map(|v| v.starts_with("https")).unwrap_or(false);
    let _ = https;
    // Срок cookie = auth.session_days; «без ограничения» — 400 дней (максимум, который допускают браузеры)
    let days = if st.cfg.auth.session_days > 0 { st.cfg.auth.session_days } else { 400 };
    let max_age = 60 * 60 * 24 * days;
    // Ставим два cookie: обычный (SameSite=Lax, работает по http и в своей вкладке) и «фреймовый»
    // (SameSite=None; Secure; Partitioned — для встраивания на чужой домен по https). Сервер принимает любой.
    let c1 = format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}");
    let c2 = format!("{COOKIE_X}={token}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age={max_age}");
    resp.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&c1).unwrap());
    resp.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&c2).unwrap());
    Ok(resp)
}

const REGISTRATION_OFF: &str = "Регистрация на этом сервере отключена — попросите администратора создать вам аккаунт";

/// Имя нового аккаунта: из запроса (без пробелов по краям) или левая часть почты.
fn display_name(name: Option<&str>, email: &str) -> String {
    name.map(str::trim).filter(|name| !name.is_empty()).map(|name| util::truncate(name, 64))
        .unwrap_or_else(|| email.split('@').next().unwrap_or("Игрок").to_string())
}

#[derive(Deserialize)]
pub struct RegisterIn { pub email: String, pub password: String, pub name: Option<String> }

/// Регистрация: email + пароль + имя → код подтверждения на почту.
async fn register(State(st): State<AppState>, Json(body): Json<RegisterIn>) -> ApiResult<Json<serde_json::Value>> {
    if !st.cfg.auth.allow_registration {
        return Err(AppError::forbidden(REGISTRATION_OFF));
    }
    let email = norm_email(&body.email)?;
    check_password(&body.password, st.cfg.auth.password_min_length)?;
    let name = display_name(body.name.as_deref(), &email);
    let hash = hash_password(&body.password)?;
    let existing = sqlx::query("SELECT id, verified, password_hash FROM users WHERE email = ?").bind(&email).fetch_optional(&st.db).await?;
    match existing {
        Some(r) => {
            let verified: i64 = r.get("verified");
            let has_pw = r.get::<Option<String>, _>("password_hash").map(|h| !h.is_empty()).unwrap_or(false);
            if verified != 0 && has_pw {
                return Err(AppError::bad("Эта почта уже зарегистрирована — войдите или восстановите пароль"));
            }
            // незавершённая регистрация или старый аккаунт без пароля: обновляем пароль и имя, требуем подтверждение
            sqlx::query("UPDATE users SET password_hash = ?, name = ? WHERE id = ?").bind(&hash).bind(&name).bind(r.get::<String, _>("id")).execute(&st.db).await?;
        }
        None => {
            sqlx::query("INSERT INTO users (id, email, name, created_at, password_hash, verified) VALUES (?, ?, ?, ?, ?, 0)")
                .bind(util::uid()).bind(&email).bind(&name).bind(util::now()).bind(&hash).execute(&st.db).await?;
        }
    }
    let mut out = issue_code(&st, &email).await?;
    out["need_verify"] = json!(true);
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct LoginIn { pub email: String, pub password: String }

/// Вход по паролю. Если почта не подтверждена — шлём код и просим подтвердить.
async fn login(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<LoginIn>) -> ApiResult<Response> {
    let email = norm_email(&body.email)?;
    let r = sqlx::query("SELECT id, name, verified, password_hash FROM users WHERE email = ?").bind(&email).fetch_optional(&st.db).await?;
    let Some(r) = r else { return Err(AppError::bad("Неверная почта или пароль")) };
    let hash = r.get::<Option<String>, _>("password_hash").unwrap_or_default();
    if hash.is_empty() {
        return Err(AppError::bad("У этого аккаунта ещё нет пароля — нажмите «Забыли пароль?» и задайте его по коду из письма"));
    }
    if !verify_password(&body.password, &hash) {
        return Err(AppError::bad("Неверная почта или пароль"));
    }
    if r.get::<i64, _>("verified") == 0 {
        let mut out = issue_code(&st, &email).await?;
        out["need_verify"] = json!(true);
        return Ok(Json(out).into_response());
    }
    start_session(&st, &headers, &r.get::<String, _>("id"), &email, &r.get::<String, _>("name")).await
}

#[derive(Deserialize)]
pub struct VerifyIn { pub email: String, pub code: String, pub name: Option<String> }

/// Подтверждение почты кодом → аккаунт активирован, сессия открыта.
async fn verify(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<VerifyIn>) -> ApiResult<Response> {
    let email = norm_email(&body.email)?;
    let existing = sqlx::query("SELECT id, name FROM users WHERE email = ?").bind(&email).fetch_optional(&st.db).await?;
    if existing.is_none() && !st.cfg.auth.allow_registration {
        return Err(AppError::forbidden(REGISTRATION_OFF));
    }
    consume_code(&st, &email, &body.code).await?;
    let (user_id, name) = match existing {
        Some(r) => (r.get::<String, _>("id"), r.get::<String, _>("name")),
        None => {
            // вход только по коду (без регистрации) — оставлен для совместимости
            let uid = util::uid();
            let nm = display_name(body.name.as_deref(), &email);
            sqlx::query("INSERT INTO users (id, email, name, created_at, verified) VALUES (?, ?, ?, ?, 1)").bind(&uid).bind(&email).bind(&nm).bind(util::now()).execute(&st.db).await?;
            (uid, nm)
        }
    };
    sqlx::query("UPDATE users SET verified = 1 WHERE id = ?").bind(&user_id).execute(&st.db).await?;
    start_session(&st, &headers, &user_id, &email, &name).await
}

#[derive(Deserialize)]
pub struct ResetIn { pub email: String, pub code: String, pub password: String }

/// Сброс/установка пароля по коду из письма.
async fn reset_password(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<ResetIn>) -> ApiResult<Response> {
    let email = norm_email(&body.email)?;
    check_password(&body.password, st.cfg.auth.password_min_length)?;
    consume_code(&st, &email, &body.code).await?;
    let r = sqlx::query("SELECT id, name FROM users WHERE email = ?").bind(&email).fetch_optional(&st.db).await?;
    let Some(r) = r else { return Err(AppError::bad("Аккаунт с такой почтой не найден — зарегистрируйтесь")) };
    let hash = hash_password(&body.password)?;
    sqlx::query("UPDATE users SET password_hash = ?, verified = 1 WHERE id = ?").bind(&hash).bind(r.get::<String, _>("id")).execute(&st.db).await?;
    start_session(&st, &headers, &r.get::<String, _>("id"), &email, &r.get::<String, _>("name")).await
}

/// Заглушка под Google OAuth: место зарезервировано, конфигурация появится позже.
async fn google_stub() -> ApiResult<Json<serde_json::Value>> {
    Err(AppError::bad("Вход через Google пока не подключён"))
}

/// Удалить обе сессионные cookie в ответе (выход, «на всех устройствах», удаление аккаунта).
fn clear_session_cookies(resp: &mut Response) {
    resp.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&format!("{COOKIE}=; Path=/; Max-Age=0; SameSite=Lax")).unwrap());
    resp.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&format!("{COOKIE_X}=; Path=/; Max-Age=0; SameSite=None; Secure; Partitioned")).unwrap());
}

fn json_with_cleared_cookies(body: serde_json::Value) -> Response {
    let mut resp = Json(body).into_response();
    clear_session_cookies(&mut resp);
    resp
}

async fn logout(State(st): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token = ?").bind(&token).execute(&st.db).await?;
    }
    Ok(json_with_cleared_cookies(json!({ "ok": true })))
}

/// Выйти на всех устройствах: удаляем все сессии пользователя (включая текущую) и cookie.
async fn logout_all(State(st): State<AppState>, user: AuthUser) -> ApiResult<Response> {
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(&user.id).execute(&st.db).await?;
    Ok(json_with_cleared_cookies(json!({ "ok": true })))
}

async fn me(user: AuthUser) -> Json<serde_json::Value> {
    Json(json!({
        "id": user.id, "email": user.email, "name": user.name, "is_root": user.is_root,
        "avatar_asset_id": user.avatar_asset_id, "created_at": user.created_at, "has_password": user.has_password,
    }))
}

#[derive(Deserialize)]
pub struct ProfileIn { pub name: Option<String>, pub avatar_asset_id: Option<Option<String>> }

/// Профиль: имя и аватар (свой ассет или встроенный; страница предлагает kind=portrait). avatar_asset_id: null — убрать.
/// Пользователь берётся только из сессии: root не может этим эндпоинтом править чужой профиль.
async fn update_me(State(st): State<AppState>, user: AuthUser, Json(body): Json<ProfileIn>) -> ApiResult<Json<serde_json::Value>> {
    let mut name = user.name.clone();
    let mut avatar_asset_id = user.avatar_asset_id.clone();
    // Сначала проверяем оба поля и только потом пишем: ошибка в аватаре не должна
    // оставить имя изменённым при ответе 400.
    if let Some(new_name) = &body.name {
        name = check_name(new_name).map_err(AppError::bad)?;
    }
    if let Some(av) = &body.avatar_asset_id {
        if let Some(aid) = av {
            let ok = sqlx::query("SELECT id FROM assets WHERE id = ? AND (owner_id = ? OR builtin = 1)").bind(aid).bind(&user.id).fetch_optional(&st.db).await?.is_some();
            if !ok { return Err(AppError::bad("Аватар не найден")); }
        }
    }
    if body.name.is_some() {
        sqlx::query("UPDATE users SET name = ? WHERE id = ?").bind(&name).bind(&user.id).execute(&st.db).await?;
    }
    if let Some(av) = &body.avatar_asset_id {
        sqlx::query("UPDATE users SET avatar_asset_id = ? WHERE id = ?").bind(av).bind(&user.id).execute(&st.db).await?;
        avatar_asset_id = av.clone();
    }
    Ok(Json(json!({ "ok": true, "name": name, "avatar_asset_id": avatar_asset_id })))
}

/// Почта свободна, если её не занял другой аккаунт (сравнение по нормализованному адресу).
async fn ensure_email_free(st: &AppState, uid: &str, email: &str) -> ApiResult<()> {
    let busy = sqlx::query("SELECT id FROM users WHERE email = ? AND id <> ?")
        .bind(email)
        .bind(uid)
        .fetch_optional(&st.db)
        .await?
        .is_some();
    if busy { return Err(AppError::bad("Эта почта уже занята другим аккаунтом")); }
    Ok(())
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("unique") || msg.contains("duplicate") || msg.contains("1062")
}

/// Текущий пароль нужен только если он у аккаунта уже есть: аккаунты, созданные по коду,
/// могут задать пароль без старого.
async fn require_current_password(st: &AppState, user: &AuthUser, password: Option<&str>) -> ApiResult<()> {
    let row = sqlx::query("SELECT password_hash FROM users WHERE id = ?").bind(&user.id).fetch_optional(&st.db).await?;
    let hash: Option<String> = match row { Some(r) => r.get("password_hash"), None => None };
    if let Some(hash) = hash.filter(|h| !h.is_empty()) {
        if !verify_password(password.unwrap_or(""), &hash) {
            return Err(AppError::bad("Неверный текущий пароль"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct ChangeEmailRequestIn { pub email: String }

/// Новая почта профиля: нормализована, отличается от текущей и не занята другим аккаунтом.
async fn checked_new_email(st: &AppState, user: &AuthUser, raw: &str) -> ApiResult<String> {
    let email = norm_email(raw)?;
    if email == user.email.to_lowercase() {
        return Err(AppError::bad("Это уже ваша почта"));
    }
    ensure_email_free(st, &user.id, &email).await?;
    Ok(email)
}

/// Шаг 1 смены почты: проверить, что адрес свободен, и отправить на него код.
async fn change_email_request_code(State(st): State<AppState>, user: AuthUser, Json(body): Json<ChangeEmailRequestIn>) -> ApiResult<Json<serde_json::Value>> {
    let email = checked_new_email(&st, &user, &body.email).await?;
    let mut out = issue_code(&st, &email).await?;
    out["email"] = json!(email);
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ChangeEmailIn { pub email: String, pub code: String, pub password: Option<String> }

/// Шаг 2 смены почты: код обязателен, почта уникальна, при заданном пароле нужен текущий пароль.
async fn change_email(State(st): State<AppState>, user: AuthUser, Json(body): Json<ChangeEmailIn>) -> ApiResult<Json<serde_json::Value>> {
    let email = checked_new_email(&st, &user, &body.email).await?;
    require_current_password(&st, &user, body.password.as_deref()).await?;
    consume_code(&st, &email, &body.code).await?;
    // Повторная проверка после проверки кода: между шагами адрес мог занять другой аккаунт.
    ensure_email_free(&st, &user.id, &email).await?;
    if let Err(e) = sqlx::query("UPDATE users SET email = ?, verified = 1 WHERE id = ?").bind(&email).bind(&user.id).execute(&st.db).await {
        if is_unique_violation(&e) { return Err(AppError::bad("Эта почта уже занята другим аккаунтом")); }
        return Err(e.into());
    }
    // Ненужные коды на старый адрес больше не понадобятся.
    sqlx::query("UPDATE auth_codes SET used = 1 WHERE email = ? AND used = 0").bind(&user.email).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true, "email": email })))
}

#[derive(Deserialize)]
pub struct DeleteMeIn { pub email: String }

/// Удаление своего аккаунта: подтверждение вводом текущей почты. Последнего root удалить нельзя.
/// Каскады и явную чистку ссылок выполняет admin::delete_by_id (кампании владельца, персонажи,
/// наборы, ассеты, сессии).
async fn delete_me(State(st): State<AppState>, user: AuthUser, Json(body): Json<DeleteMeIn>) -> ApiResult<Response> {
    let email = norm_email(&body.email)?;
    if email != user.email.to_lowercase() {
        return Err(AppError::bad("Введите почту аккаунта, чтобы подтвердить удаление"));
    }
    if user.is_root {
        let roots: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_root = 1").fetch_one(&st.db).await?.get("n");
        if roots <= 1 {
            return Err(AppError::bad("Нельзя удалить единственного администратора"));
        }
    }
    crate::api::admin::delete_by_id(&st.db, &user.id).await?;
    Ok(json_with_cleared_cookies(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ChangePasswordIn { pub old_password: String, pub password: String }

/// Смена пароля: старый + новый; остальные сессии завершаются.
async fn change_password(State(st): State<AppState>, headers: HeaderMap, user: AuthUser, Json(body): Json<ChangePasswordIn>) -> ApiResult<Json<serde_json::Value>> {
    check_password(&body.password, st.cfg.auth.password_min_length)?;
    let r = sqlx::query("SELECT password_hash FROM users WHERE id = ?").bind(&user.id).fetch_one(&st.db).await?;
    let hash: Option<String> = r.get("password_hash");
    if let Some(h) = hash.filter(|h| !h.is_empty()) {
        if !verify_password(&body.old_password, &h) { return Err(AppError::bad("Старый пароль неверен")); }
    }
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash_password(&body.password)?).bind(&user.id).execute(&st.db).await?;
    let cur = session_token(&headers).unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token <> ?").bind(&user.id).bind(&cur).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use sqlx::Row;

    async fn test_state() -> AppState {
        sqlx::any::install_default_drivers();
        let db = sqlx::any::AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::store::db::migrate(&db, true).await.unwrap();
        AppState { db, cfg: std::sync::Arc::new(crate::config::Config::default()), hub: crate::ws::realtime::Hub::default(), is_sqlite: true }
    }

    async fn add_user(st: &AppState, id: &str, email: &str, name: &str, password: Option<&str>, is_root: bool) {
        let hash = password.map(|p| hash_password(p).unwrap());
        sqlx::query("INSERT INTO users (id, email, name, created_at, password_hash, verified, is_root) VALUES (?, ?, ?, ?, ?, 1, ?)")
            .bind(id).bind(email).bind(name).bind(util::now()).bind(hash).bind(if is_root { 1i64 } else { 0 })
            .execute(&st.db).await.unwrap();
    }

    async fn add_session(st: &AppState, token: &str, uid: &str) {
        sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
            .bind(token).bind(uid).bind(util::now()).execute(&st.db).await.unwrap();
    }

    async fn add_code(st: &AppState, email: &str, code: &str) {
        let expires = (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        sqlx::query("INSERT INTO auth_codes (email, code, expires_at, attempts, used) VALUES (?, ?, ?, 0, 0)")
            .bind(email).bind(code).bind(expires).execute(&st.db).await.unwrap();
    }

    fn auth_user(id: &str, email: &str, name: &str, is_root: bool, has_password: bool) -> AuthUser {
        AuthUser {
            id: id.into(), email: email.into(), name: name.into(), is_root,
            avatar_asset_id: None, created_at: "2025-01-01T00:00:00Z".into(), has_password,
        }
    }

    fn headers(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_str(&format!("dnd_session={token}")).unwrap());
        h
    }

    async fn user_name(st: &AppState, id: &str) -> String {
        sqlx::query("SELECT name FROM users WHERE id = ?").bind(id).fetch_one(&st.db).await.unwrap().get("name")
    }

    async fn session_count(st: &AppState, uid: &str) -> i64 {
        sqlx::query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(uid).fetch_one(&st.db).await.unwrap().get("n")
    }

    #[test]
    fn name_rule_trims_and_rejects_empty_or_too_long() {
        assert_eq!(check_name("  Аня  ").unwrap(), "Аня");
        assert_eq!(check_name(&"я".repeat(64)).unwrap().chars().count(), 64);
        assert!(check_name("   ").is_err());
        assert!(check_name(&"я".repeat(65)).is_err());
    }

    #[test]
    fn email_rule_rejects_overlong_address() {
        assert!(check_email(&format!("{}@example.com", "a".repeat(250))).is_err());
        assert_eq!(check_email("  A@Example.COM ").unwrap(), "a@example.com");
    }

    #[tokio::test]
    async fn profile_update_touches_only_the_authenticated_account() {
        let st = test_state().await;
        add_user(&st, "u1", "a@test.ru", "Аня", Some("secret123"), false).await;
        add_user(&st, "u2", "b@test.ru", "Боря", Some("secret123"), false).await;

        let res = update_me(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ProfileIn { name: Some("  Аня Новая  ".into()), avatar_asset_id: None })).await.unwrap();
        assert_eq!(res.0["name"], "Аня Новая");
        assert_eq!(res.0["avatar_asset_id"], serde_json::Value::Null);
        assert_eq!(user_name(&st, "u1").await, "Аня Новая");
        assert_eq!(user_name(&st, "u2").await, "Боря", "чужой профиль не изменился");

        let err = update_me(State(st.clone()), auth_user("u1", "a@test.ru", "Аня Новая", false, true), Json(ProfileIn { name: Some("   ".into()), avatar_asset_id: None })).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("пустым"));
        assert_eq!(user_name(&st, "u1").await, "Аня Новая");

        // Несуществующий аватар отклоняет весь PATCH: имя не должно сохраниться наполовину.
        let err = update_me(State(st.clone()), auth_user("u1", "a@test.ru", "Аня Новая", false, true), Json(ProfileIn { name: Some("Другое имя".into()), avatar_asset_id: Some(Some("missing".into())) })).await.unwrap_err();
        assert!(err.1.contains("Аватар не найден"));
        assert_eq!(user_name(&st, "u1").await, "Аня Новая");
    }

    #[tokio::test]
    async fn password_change_checks_old_hash_and_revokes_other_sessions() {
        let st = test_state().await;
        add_user(&st, "u1", "a@test.ru", "Аня", Some("secret123"), false).await;
        add_session(&st, "tok-current", "u1").await;
        add_session(&st, "tok-other", "u1").await;

        let err = change_password(State(st.clone()), headers("tok-current"), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangePasswordIn { old_password: "wrong".into(), password: "newsecret1".into() })).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("Старый пароль"));
        let hash: String = sqlx::query("SELECT password_hash FROM users WHERE id = ?").bind("u1").fetch_one(&st.db).await.unwrap().get("password_hash");
        assert!(verify_password("secret123", &hash), "неверный старый пароль не меняет hash");
        assert_eq!(session_count(&st, "u1").await, 2, "неудачная смена не трогает сессии");

        let _ = change_password(State(st.clone()), headers("tok-current"), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangePasswordIn { old_password: "secret123".into(), password: "newsecret1".into() })).await.unwrap();
        let hash: String = sqlx::query("SELECT password_hash FROM users WHERE id = ?").bind("u1").fetch_one(&st.db).await.unwrap().get("password_hash");
        assert!(verify_password("newsecret1", &hash));
        assert!(!verify_password("secret123", &hash));
        assert_eq!(session_count(&st, "u1").await, 1);
        let current: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sessions WHERE token = 'tok-current'").fetch_one(&st.db).await.unwrap().get("n");
        assert_eq!(current, 1, "текущая сессия остаётся");
    }

    #[tokio::test]
    async fn email_change_requires_code_uniqueness_and_current_password() {
        let st = test_state().await;
        add_user(&st, "u1", "a@test.ru", "Аня", Some("secret123"), false).await;
        add_user(&st, "u2", "b@test.ru", "Боря", Some("secret123"), false).await;

        let err = change_email_request_code(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangeEmailRequestIn { email: "b@test.ru".into() })).await.unwrap_err();
        assert!(err.1.contains("занята"), "нельзя запросить код на чужую почту");
        let err = change_email_request_code(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangeEmailRequestIn { email: "a@test.ru".into() })).await.unwrap_err();
        assert!(err.1.contains("уже ваша"));

        add_code(&st, "new@test.ru", "123456").await;
        let err = change_email(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangeEmailIn { email: "new@test.ru".into(), code: "123456".into(), password: Some("wrong".into()) })).await.unwrap_err();
        assert!(err.1.contains("текущий пароль"));
        let attempts: i64 = sqlx::query("SELECT attempts FROM auth_codes WHERE email = 'new@test.ru'").fetch_one(&st.db).await.unwrap().get("attempts");
        assert_eq!(attempts, 0, "неверный пароль не сжигает попытку кода");

        let err = change_email(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangeEmailIn { email: "new@test.ru".into(), code: "000000".into(), password: Some("secret123".into()) })).await.unwrap_err();
        assert!(err.1.contains("Неверный код"));

        let ok = change_email(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(ChangeEmailIn { email: "new@test.ru".into(), code: "123456".into(), password: Some("secret123".into()) })).await.unwrap();
        assert_eq!(ok.0["email"], "new@test.ru");
        let email: String = sqlx::query("SELECT email FROM users WHERE id = 'u1'").fetch_one(&st.db).await.unwrap().get("email");
        assert_eq!(email, "new@test.ru");
        let old: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE email = 'a@test.ru'").fetch_one(&st.db).await.unwrap().get("n");
        assert_eq!(old, 0);
        let used: i64 = sqlx::query("SELECT used FROM auth_codes WHERE email = 'new@test.ru'").fetch_one(&st.db).await.unwrap().get("used");
        assert_eq!(used, 1);
    }

    #[tokio::test]
    async fn account_deletion_confirms_email_and_protects_last_root() {
        let st = test_state().await;
        add_user(&st, "root", "root@test.ru", "Root", Some("rootpass123"), true).await;
        add_user(&st, "u1", "a@test.ru", "Аня", Some("secret123"), false).await;
        add_session(&st, "tok-u1", "u1").await;
        sqlx::query("INSERT INTO campaigns (id, name, description, owner_id, created_at) VALUES ('c1', 'Кампания', '', 'u1', ?)")
            .bind(util::now()).execute(&st.db).await.unwrap();

        let err = delete_me(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(DeleteMeIn { email: "wrong@test.ru".into() })).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("почту"));

        let root = auth_user("root", "root@test.ru", "Root", true, true);
        let err = delete_me(State(st.clone()), root, Json(DeleteMeIn { email: "root@test.ru".into() })).await.unwrap_err();
        assert!(err.1.contains("единственного администратора"));
        let roots: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE id = 'root'").fetch_one(&st.db).await.unwrap().get("n");
        assert_eq!(roots, 1);

        let resp = delete_me(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true), Json(DeleteMeIn { email: "a@test.ru".into() })).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let users: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE id = 'u1'").fetch_one(&st.db).await.unwrap().get("n");
        let campaigns: i64 = sqlx::query("SELECT COUNT(*) AS n FROM campaigns WHERE owner_id = 'u1'").fetch_one(&st.db).await.unwrap().get("n");
        assert_eq!(users, 0);
        assert_eq!(campaigns, 0, "кампании удалённого пользователя удалены каскадом");
        assert_eq!(session_count(&st, "u1").await, 0);
    }

    #[tokio::test]
    async fn logout_all_removes_every_session() {
        let st = test_state().await;
        add_user(&st, "u1", "a@test.ru", "Аня", Some("secret123"), false).await;
        add_session(&st, "tok-1", "u1").await;
        add_session(&st, "tok-2", "u1").await;
        let resp = logout_all(State(st.clone()), auth_user("u1", "a@test.ru", "Аня", false, true)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(session_count(&st, "u1").await, 0);
    }
}
