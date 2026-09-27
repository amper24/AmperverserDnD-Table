//! Подключение к БД (MySQL или SQLite через sqlx Any) и создание схемы.
use sqlx::{any::AnyPoolOptions, AnyPool, Row};

pub async fn connect(url: &str) -> anyhow::Result<(AnyPool, bool)> {
    sqlx::any::install_default_drivers();
    let is_sqlite = url.starts_with("sqlite");
    if is_sqlite {
        // sqlite://data/dnd.db?mode=rwc — создаём каталог
        if let Some(path) = url.strip_prefix("sqlite://").or_else(|| url.strip_prefix("sqlite:")) {
            let path = path.split('?').next().unwrap_or("");
            if let Some(dir) = std::path::Path::new(path).parent() {
                if !dir.as_os_str().is_empty() {
                    std::fs::create_dir_all(dir).ok();
                }
            }
        }
    }
    let url = if is_sqlite && !url.contains("mode=") {
        format!("{url}{}mode=rwc", if url.contains('?') { "&" } else { "?" })
    } else {
        url.to_string()
    };
    let pool = AnyPoolOptions::new()
        .max_connections(if is_sqlite { 1 } else { 10 })
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&url)
        .await?;
    if is_sqlite {
        sqlx::query("PRAGMA journal_mode=WAL").execute(&pool).await.ok();
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.ok();
        sqlx::query("PRAGMA busy_timeout=5000").execute(&pool).await.ok();
    }
    Ok((pool, is_sqlite))
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(32) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(64) NOT NULL DEFAULT '',
  google_sub VARCHAR(64) NULL,
  created_at VARCHAR(40) NOT NULL,
  password_hash VARCHAR(255) NULL,
  verified INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS auth_codes (
  id {AUTOINC},
  email VARCHAR(255) NOT NULL,
  code VARCHAR(8) NOT NULL,
  expires_at VARCHAR(40) NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  used BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS campaigns (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  owner_id VARCHAR(32) NOT NULL,
  active_scene_id VARCHAR(32) NULL,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS campaign_members (
  id {AUTOINC},
  campaign_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'player',
  joined_at VARCHAR(40) NOT NULL,
  UNIQUE (campaign_id, user_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS invites (
  code VARCHAR(32) PRIMARY KEY,
  campaign_id VARCHAR(32) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'player',
  max_uses BIGINT NOT NULL DEFAULT 0,
  uses BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS assets (
  id VARCHAR(32) PRIMARY KEY,
  campaign_id VARCHAR(32) NULL,
  owner_id VARCHAR(32) NULL,
  name VARCHAR(128) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'token',
  mime VARCHAR(32) NOT NULL,
  width BIGINT NOT NULL DEFAULT 0,
  height BIGINT NOT NULL DEFAULT 0,
  encoding VARCHAR(16) NOT NULL DEFAULT 'deflate',
  data_b64 {LONGTEXT} NOT NULL,
  builtin BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS scenes (
  id VARCHAR(32) PRIMARY KEY,
  campaign_id VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  grid TEXT NOT NULL,
  fog {MEDIUMTEXT} NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS scene_items (
  id VARCHAR(32) PRIMARY KEY,
  scene_id VARCHAR(32) NOT NULL,
  layer VARCHAR(16) NOT NULL DEFAULT 'character',
  z BIGINT NOT NULL DEFAULT 0,
  data {MEDIUMTEXT} NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS characters (
  id VARCHAR(32) PRIMARY KEY,
  campaign_id VARCHAR(32) NULL,
  owner_id VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  portrait_asset_id VARCHAR(32) NULL,
  sheet {MEDIUMTEXT} NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id {AUTOINC},
  campaign_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'text',
  payload TEXT NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS packs (
  id VARCHAR(32) PRIMARY KEY,
  owner_id VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  is_public BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(40) NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS campaign_packs (
  id {AUTOINC},
  campaign_id VARCHAR(32) NOT NULL,
  pack_id VARCHAR(32) NOT NULL,
  UNIQUE (campaign_id, pack_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (pack_id) REFERENCES packs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS compendium (
  id VARCHAR(32) PRIMARY KEY,
  campaign_id VARCHAR(32) NULL,
  pack_id VARCHAR(32) NULL,
  category VARCHAR(24) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  name_lc VARCHAR(128) NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'SRD',
  data {MEDIUMTEXT} NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (pack_id) REFERENCES packs(id) ON DELETE CASCADE
);
"#;

/// Миграции для уже существующих баз (ошибки "колонка уже есть" игнорируются).
const ALTERS: &[&str] = &[
    "ALTER TABLE compendium ADD COLUMN pack_id VARCHAR(32) NULL",
    "ALTER TABLE compendium ADD COLUMN name_lc VARCHAR(128) NULL",
    "ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL",
    "ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0",
];

const INDEXES: &[&str] = &[
    "CREATE INDEX idx_auth_codes_email ON auth_codes(email)",
    "CREATE INDEX idx_sessions_user ON sessions(user_id)",
    "CREATE INDEX idx_members_campaign ON campaign_members(campaign_id)",
    "CREATE INDEX idx_members_user ON campaign_members(user_id)",
    "CREATE INDEX idx_invites_campaign ON invites(campaign_id)",
    "CREATE INDEX idx_assets_campaign ON assets(campaign_id)",
    "CREATE INDEX idx_assets_owner ON assets(owner_id)",
    "CREATE INDEX idx_scenes_campaign ON scenes(campaign_id)",
    "CREATE INDEX idx_items_scene ON scene_items(scene_id)",
    "CREATE INDEX idx_chars_campaign ON characters(campaign_id)",
    "CREATE INDEX idx_chars_owner ON characters(owner_id)",
    "CREATE INDEX idx_chat_campaign ON chat_messages(campaign_id)",
    "CREATE INDEX idx_comp_category ON compendium(category)",
    "CREATE INDEX idx_comp_campaign ON compendium(campaign_id)",
    "CREATE INDEX idx_comp_pack ON compendium(pack_id)",
    "CREATE INDEX idx_comp_name_lc ON compendium(name_lc)",
    "CREATE INDEX idx_packs_owner ON packs(owner_id)",
];

pub async fn migrate(pool: &AnyPool, is_sqlite: bool) -> anyhow::Result<()> {
    let (autoinc, longtext, mediumtext, suffix) = if is_sqlite {
        ("INTEGER PRIMARY KEY AUTOINCREMENT", "TEXT", "TEXT", "")
    } else {
        ("BIGINT AUTO_INCREMENT PRIMARY KEY", "LONGTEXT", "MEDIUMTEXT", " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
    };
    let schema = SCHEMA.replace("{AUTOINC}", autoinc).replace("{LONGTEXT}", longtext).replace("{MEDIUMTEXT}", mediumtext);
    for stmt in schema.split(';') {
        let stmt = stmt.trim();
        if stmt.is_empty() {
            continue;
        }
        let stmt = format!("{stmt}{suffix}");
        sqlx::query(&stmt).execute(pool).await?;
    }
    for stmt in ALTERS {
        if let Err(e) = sqlx::query(stmt).execute(pool).await {
            let msg = e.to_string();
            if !(msg.contains("Duplicate") || msg.contains("duplicate") || msg.contains("1060")) {
                return Err(e.into());
            }
        }
    }
    // Индексы: MySQL не умеет IF NOT EXISTS — игнорируем ошибку "уже существует"
    for idx in INDEXES {
        let stmt = if is_sqlite { idx.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS") } else { idx.to_string() };
        if let Err(e) = sqlx::query(&stmt).execute(pool).await {
            let msg = e.to_string();
            if !(msg.contains("Duplicate") || msg.contains("already exists") || msg.contains("1061")) {
                return Err(e.into());
            }
        }
    }
    tracing::info!("Схема БД готова ({})", if is_sqlite { "SQLite" } else { "MySQL" });
    // Поиск без учёта регистра для кириллицы: SQLite LOWER() умеет только ASCII, поэтому храним name_lc
    let rows = sqlx::query("SELECT id, name FROM compendium WHERE name_lc IS NULL").fetch_all(pool).await?;
    for r in &rows {
        let name: String = r.get("name");
        sqlx::query("UPDATE compendium SET name_lc = ? WHERE id = ?").bind(name.to_lowercase()).bind(r.get::<String, _>("id")).execute(pool).await?;
    }
    Ok(())
}
