//! Авторизация: email + пароль (argon2), подтверждение почты кодом, сброс пароля по коду; сессии в cookie/Bearer.
//! Задел под Google OAuth: поле users.google_sub и маршрут /api/auth/google.
use axum::{
    async_trait,
    extract::{FromRequestParts, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
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
    let row = sqlx::query("SELECT u.id, u.email, u.name, u.is_root, u.avatar_asset_id, u.created_at, s.created_at AS session_created FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?")
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
    Ok(row.map(|r| AuthUser { id: r.get("id"), email: r.get("email"), name: r.get("name"), is_root: r.get::<i64, _>("is_root") != 0, avatar_asset_id: r.get("avatar_asset_id"), created_at: r.get("created_at") }))
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
        .route("/api/auth/me", get(me).patch(update_me))
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

#[derive(Deserialize)]
pub struct RegisterIn { pub email: String, pub password: String, pub name: Option<String> }

/// Регистрация: email + пароль + имя → код подтверждения на почту.
async fn register(State(st): State<AppState>, Json(body): Json<RegisterIn>) -> ApiResult<Json<serde_json::Value>> {
    if !st.cfg.auth.allow_registration {
        return Err(AppError::forbidden(REGISTRATION_OFF));
    }
    let email = norm_email(&body.email)?;
    check_password(&body.password, st.cfg.auth.password_min_length)?;
    let name = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| util::truncate(s, 64)).unwrap_or_else(|| email.split('@').next().unwrap_or("Игрок").to_string());
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
            let nm = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| util::truncate(s, 64)).unwrap_or_else(|| email.split('@').next().unwrap_or("Игрок").to_string());
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

async fn logout(State(st): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token = ?").bind(&token).execute(&st.db).await?;
    }
    let mut resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
    resp.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&format!("{COOKIE}=; Path=/; Max-Age=0; SameSite=Lax")).unwrap());
    resp.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&format!("{COOKIE_X}=; Path=/; Max-Age=0; SameSite=None; Secure; Partitioned")).unwrap());
    Ok(resp)
}

async fn me(user: AuthUser) -> Json<serde_json::Value> {
    Json(json!({ "id": user.id, "email": user.email, "name": user.name, "is_root": user.is_root, "avatar_asset_id": user.avatar_asset_id, "created_at": user.created_at }))
}

#[derive(Deserialize)]
pub struct ProfileIn { pub name: Option<String>, pub avatar_asset_id: Option<Option<String>> }

/// Профиль: имя и аватар (asset kind=portrait, владелец — сам пользователь). avatar_asset_id: null — убрать.
async fn update_me(State(st): State<AppState>, user: AuthUser, Json(body): Json<ProfileIn>) -> ApiResult<Json<serde_json::Value>> {
    if let Some(name) = &body.name {
        let name = util::truncate(name.trim(), 64);
        if name.is_empty() { return Err(AppError::bad("Имя не может быть пустым")); }
        sqlx::query("UPDATE users SET name = ? WHERE id = ?").bind(&name).bind(&user.id).execute(&st.db).await?;
    }
    if let Some(av) = &body.avatar_asset_id {
        if let Some(aid) = av {
            let ok = sqlx::query("SELECT id FROM assets WHERE id = ? AND (owner_id = ? OR builtin = 1)").bind(aid).bind(&user.id).fetch_optional(&st.db).await?.is_some();
            if !ok { return Err(AppError::bad("Аватар не найден")); }
        }
        sqlx::query("UPDATE users SET avatar_asset_id = ? WHERE id = ?").bind(av).bind(&user.id).execute(&st.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ChangePasswordIn { pub old_password: String, pub password: String }

/// Смена пароля: старый + новый; остальные сессии завершаются.
async fn change_password(State(st): State<AppState>, headers: HeaderMap, user: AuthUser, Json(body): Json<ChangePasswordIn>) -> ApiResult<Json<serde_json::Value>> {
    check_password(&body.password, st.cfg.auth.password_min_length)?;
    let r = sqlx::query("SELECT password_hash FROM users WHERE id = ?").bind(&user.id).fetch_one(&st.db).await?;
    let hash: Option<String> = r.get("password_hash");
    if let Some(h) = hash { if !verify_password(&body.old_password, &h) { return Err(AppError::bad("Старый пароль неверен")); } }
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash_password(&body.password)?).bind(&user.id).execute(&st.db).await?;
    let cur = session_token(&headers).unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token <> ?").bind(&user.id).bind(&cur).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}
