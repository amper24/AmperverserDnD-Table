use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self { Self(StatusCode::BAD_REQUEST, msg.into()) }
    pub fn unauthorized(msg: impl Into<String>) -> Self { Self(StatusCode::UNAUTHORIZED, msg.into()) }
    pub fn forbidden(msg: impl Into<String>) -> Self { Self(StatusCode::FORBIDDEN, msg.into()) }
    pub fn not_found(msg: impl Into<String>) -> Self { Self(StatusCode::NOT_FOUND, msg.into()) }
    pub fn internal(msg: impl Into<String>) -> Self { Self(StatusCode::INTERNAL_SERVER_ERROR, msg.into()) }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.0.is_server_error() {
            tracing::error!("{}", self.1);
        }
        (self.0, Json(json!({ "detail": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => Self::not_found("Не найдено"),
            other => Self(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {other}")),
        }
    }
}
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self { Self(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()) }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self { Self::bad(format!("json: {e}")) }
}

pub type ApiResult<T> = Result<T, AppError>;
