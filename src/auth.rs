//! Авторизация: одноразовый код на почту, сессии в cookie. Задел под Google OAuth (поле users.google_sub).
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
        .route("/api/auth/request-code", post(request_code))
        .route("/api/auth/verify", post(verify))
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
            .body(format!("Ваш код подтверждения для DnD Table: {code}\nКод действует {CODE_TTL_MIN} минут."))?;
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
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(CODE_TTL_MIN)).to_rfc3339();
    sqlx::query("UPDATE auth_codes SET used = 1 WHERE email = ? AND used = 0").bind(&email).execute(&st.db).await?;
    sqlx::query("INSERT INTO auth_codes (email, code, expires_at, attempts, used) VALUES (?, ?, ?, 0, 0)")
        .bind(&email).bind(&code).bind(&expires).execute(&st.db).await?;
    let sent = send_code(&st, &email, &code).await;
    let mut out = json!({ "ok": true, "sent": sent, "ttl_min": CODE_TTL_MIN });
    if !sent && st.cfg.dev_show_code {
        out["dev_code"] = json!(code);
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct VerifyIn { pub email: String, pub code: String, pub name: Option<String> }

async fn verify(State(st): State<AppState>, Json(body): Json<VerifyIn>) -> ApiResult<Response> {
    let email = norm_email(&body.email)?;
    let row = sqlx::query("SELECT id, code, expires_at, attempts FROM auth_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1")
        .bind(&email).fetch_optional(&st.db).await?;
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
    if real != body.code.trim() {
        sqlx::query("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?").bind(id).execute(&st.db).await?;
        return Err(AppError::bad("Неверный код"));
    }
    sqlx::query("UPDATE auth_codes SET used = 1 WHERE id = ?").bind(id).execute(&st.db).await?;

    let name_in = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| util::truncate(s, 64));
    let existing = sqlx::query("SELECT id, name FROM users WHERE email = ?").bind(&email).fetch_optional(&st.db).await?;
    let (user_id, name) = match existing {
        Some(r) => {
            let uid: String = r.get("id");
            let mut nm: String = r.get("name");
            if let Some(n) = name_in {
                sqlx::query("UPDATE users SET name = ? WHERE id = ?").bind(&n).bind(&uid).execute(&st.db).await?;
                nm = n;
            }
            (uid, nm)
        }
        None => {
            let uid = util::uid();
            let nm = name_in.unwrap_or_else(|| email.split('@').next().unwrap_or("Игрок").to_string());
            sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
                .bind(&uid).bind(&email).bind(&nm).bind(util::now()).execute(&st.db).await?;
            (uid, nm)
        }
    };
    let token = util::token(48);
    sqlx::query("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").bind(&token).bind(&user_id).bind(util::now()).execute(&st.db).await?;

    let body = json!({ "ok": true, "token": token, "user": { "id": user_id, "email": email, "name": name } });
    let mut resp = Json(body).into_response();
    let cookie = format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}", 60 * 60 * 24 * 30);
    resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    Ok(resp)
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
