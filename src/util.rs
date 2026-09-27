use axum::http::HeaderMap;
use rand::{distributions::Alphanumeric, Rng};
use serde::de::DeserializeOwned;

pub fn uid() -> String { uuid::Uuid::new_v4().simple().to_string() }
pub fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true) }
pub fn token(n: usize) -> String { rand::thread_rng().sample_iter(&Alphanumeric).take(n).map(char::from).collect() }

/// Разбор JSON из текстовой колонки с запасным значением.
pub fn parse_json<T: DeserializeOwned + Default>(s: &str) -> T {
    serde_json::from_str(s).unwrap_or_default()
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
