use axum::http::HeaderMap;
use rand::{distributions::Alphanumeric, Rng};

pub fn uid() -> String { uuid::Uuid::new_v4().simple().to_string() }
pub fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true) }
pub fn token(n: usize) -> String { rand::thread_rng().sample_iter(&Alphanumeric).take(n).map(char::from).collect() }

/// Чтение текстовой колонки: MySQL отдаёт TEXT/LONGTEXT через драйвер Any как BLOB — читаем байты.
pub fn text(row: &sqlx::any::AnyRow, col: &str) -> String {
    use sqlx::Row;
    if let Ok(s) = row.try_get::<String, _>(col) {
        return s;
    }
    if let Ok(b) = row.try_get::<Vec<u8>, _>(col) {
        return String::from_utf8_lossy(&b).into_owned();
    }
    String::new()
}

pub fn json_value(s: &str) -> serde_json::Value {
    serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let mut kv = part.trim().splitn(2, '=');
        if kv.next()? == name {
            return kv.next().map(|v| v.to_string());
        }
    }
    None
}

pub fn bearer(headers: &HeaderMap) -> Option<String> {
    headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

pub fn truncate(s: &str, n: usize) -> String { s.chars().take(n).collect() }
