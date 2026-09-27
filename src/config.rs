use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub host: String,
    pub port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from: String,
    pub dev_show_code: bool,
    pub image_quality: u8,
}

fn var(k: &str, default: &str) -> String {
    env::var(k).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

impl Config {
    pub fn from_env() -> Self {
        // Pterodactyl передаёт порт в SERVER_PORT
        let port = var("PORT", &var("SERVER_PORT", "8080")).parse().unwrap_or(8080);
        Self {
            database_url: var("DATABASE_URL", "sqlite://data/dnd.db?mode=rwc"),
            host: var("HOST", "0.0.0.0"),
            port,
            smtp_host: var("SMTP_HOST", ""),
            smtp_port: var("SMTP_PORT", "587").parse().unwrap_or(587),
            smtp_user: var("SMTP_USER", ""),
            smtp_password: var("SMTP_PASSWORD", ""),
            smtp_from: var("SMTP_FROM", "noreply@example.com"),
            dev_show_code: var("DEV_SHOW_CODE", "true") == "true",
            image_quality: var("IMAGE_QUALITY", "82").parse().unwrap_or(82),
        }
    }
}
