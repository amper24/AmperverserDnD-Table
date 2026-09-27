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

use crate::{error::ApiResult, util, AppError, AppState};

pub const COOKIE: &str = "dnd_session";
const CODE_TTL_MIN: i64 = 10;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = util::cookie(&parts.headers, COOKIE).or_else(|| util::bearer(&parts.headers)).ok_or_else(|| AppError::unauthorized("Требуется вход"))?;
        user_by_token(st, &token).await?.ok_or_else(|| AppError::unauthorized("Сессия недействительна"))
    }
}

pub async fn user_by_token(st: &AppState, token: &str) -> ApiResult<Option<AuthUser>> {
    let row = sqlx::query("SELECT u.id, u.email, u.name FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?")
        .bind(token)
        .fetch_optional(&st.db)
        .await?;
    Ok(row.map(|r| AuthUser { id: r.get("id"), email: r.get("email"), name: r.get("name") }))
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
}

// ---------- отправка почты ----------
async fn send_code(st: &AppState, to: &str, code: &str) -> bool {
    let cfg = &st.cfg;
    if cfg.smtp_host.is_empty() {
        tracing::warn!("SMTP не настроен. Код для {}: {}", to, code);
        println!("\n===== КОД ПОДТВЕРЖДЕНИЯ для {to}: {code} =====\n");
        return false;
    }
    let result: anyhow::Result<()> = async {
        let email = Message::builder()
            .from(cfg.smtp_from.parse()?)
            .to(to.parse()?)
            .subject(format!("Код входа: {code}"))
            .header(ContentType::TEXT_PLAIN)
            .body(format!("Ваш код подтверждения Edge Tablet: {code}\nКод действует {CODE_TTL_MIN} минут."))?;
        let mut builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.smtp_host)?.port(cfg.smtp_port);
        if !cfg.smtp_user.is_empty() {
            builder = builder.credentials(Credentials::new(cfg.smtp_user.clone(), cfg.smtp_password.clone()));
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

fn norm_email(e: &str) -> ApiResult<String> {
    let e = e.trim().to_lowercase();
    if e.len() < 5 || !e.contains('@') || !e.split('@').nth(1).map(|d| d.contains('.')).unwrap_or(false) {
        return Err(AppError::bad("Некорректный email"));
    }
    Ok(e)
}

async fn request_code(State(st): State<AppState>, Json(body): Json<RequestCodeIn>) -> ApiResult<Json<serde_json::Value>> {
    let email = norm_email(&body.email)?;
    Ok(Json(issue_code(&st, &email).await?))
}

/// Выпустить и отправить код подтверждения на почту.
async fn issue_code(st: &AppState, email: &str) -> ApiResult<serde_json::Value> {
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(CODE_TTL_MIN)).to_rfc3339();
    sqlx::query("UPDATE auth_codes SET used = 1 WHERE email = ? AND used = 0").bind(email).execute(&st.db).await?;
    sqlx::query("INSERT INTO auth_codes (email, code, expires_at, attempts, used) VALUES (?, ?, ?, 0, 0)")
        .bind(email).bind(&code).bind(&expires).execute(&st.db).await?;
    let sent = send_code(st, email, &code).await;
    let mut out = json!({ "ok": true, "sent": sent, "ttl_min": CODE_TTL_MIN });
    if !sent && st.cfg.dev_show_code {
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
    if attempts >= 5 {
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

fn hash_password(pw: &str) -> ApiResult<String> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default().hash_password(pw.as_bytes(), &salt).map(|h| h.to_string()).map_err(|_| AppError::internal("Ошибка хэширования"))
}
fn verify_password(pw: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    PasswordHash::new(hash).map(|h| argon2::Argon2::default().verify_password(pw.as_bytes(), &h).is_ok()).unwrap_or(false)
}
fn check_password(pw: &str) -> ApiResult<()> {
    if pw.chars().count() < 8 { return Err(AppError::bad("Пароль должен быть не короче 8 символов")); }
    if pw.len() > 200 { return Err(AppError::bad("Слишком длинный пароль")); }
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
    let same_site = if https { "SameSite=None; Secure" } else { "SameSite=Lax" };
    let cookie = format!("{COOKIE}={token}; Path=/; HttpOnly; {same_site}; Max-Age={}", 60 * 60 * 24 * 30);
    resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    Ok(resp)
}

#[derive(Deserialize)]
pub struct RegisterIn { pub email: String, pub password: String, pub name: Option<String> }

/// Регистрация: email + пароль + имя → код подтверждения на почту.
async fn register(State(st): State<AppState>, Json(body): Json<RegisterIn>) -> ApiResult<Json<serde_json::Value>> {
    let email = norm_email(&body.email)?;
    check_password(&body.password)?;
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
    consume_code(&st, &email, &body.code).await?;
    let existing = sqlx::query("SELECT id, name FROM users WHERE email = ?").bind(&email).fetch_optional(&st.db).await?;
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
    check_password(&body.password)?;
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
    if let Some(token) = util::cookie(&headers, COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token = ?").bind(&token).execute(&st.db).await?;
    }
    let mut resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&format!("{COOKIE}=; Path=/; Max-Age=0")).unwrap());
    Ok(resp)
}

async fn me(user: AuthUser) -> Json<serde_json::Value> {
    Json(json!({ "id": user.id, "email": user.email, "name": user.name }))
}

#[derive(Deserialize)]
pub struct ProfileIn { pub name: String }

async fn update_me(State(st): State<AppState>, user: AuthUser, Json(body): Json<ProfileIn>) -> ApiResult<Json<serde_json::Value>> {
    let name = util::truncate(body.name.trim(), 64);
    sqlx::query("UPDATE users SET name = ? WHERE id = ?").bind(&name).bind(&user.id).execute(&st.db).await?;
    Ok(Json(json!({ "ok": true })))
}
