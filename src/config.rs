//! Конфигурация сервера: `config.yml` (создаётся при первом запуске) + переменные окружения.
//!
//! Порядок применения (от слабого к сильному):
//!   1. значения по умолчанию (`Config::default()`);
//!   2. `config.yml` — путь из `--config <файл>`, переменной `DND_CONFIG` или `./config.yml`;
//!   3. переменные окружения и `.env` (`DATABASE_URL`, `PORT`, `SMTP_*`, …) — если в файле
//!      не выключено `env_overrides: false`. Порт панели Pterodactyl (`SERVER_PORT`)
//!      учитывается всегда, иначе сервер окажется недоступен.
//!
//! Если в существующем файле не хватает параметров (вышла новая версия), он перезаписывается
//! полным шаблоном с сохранением заданных значений, а прежняя версия кладётся рядом в `*.bak`.
use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::OnceLock,
};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

/// Имя файла конфигурации по умолчанию (в текущем каталоге).
pub const DEFAULT_PATH: &str = "config.yml";
/// Переменная окружения с путём к файлу конфигурации.
pub const PATH_ENV: &str = "DND_CONFIG";

// ---------------------------------------------------------------------------
// Структура конфигурации
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Разрешить переменным окружения перекрывать значения из файла.
    pub env_overrides: bool,
    pub server: ServerCfg,
    pub database: DatabaseCfg,
    pub smtp: SmtpCfg,
    pub auth: AuthCfg,
    pub root: RootCfg,
    pub images: ImagesCfg,
    pub logging: LoggingCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCfg {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DatabaseCfg {
    pub url: String,
    pub max_connections: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SmtpCfg {
    pub host: String,
    pub port: u16,
    /// auto | starttls | tls | none
    pub encryption: String,
    pub user: String,
    pub password: String,
    pub from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthCfg {
    pub allow_registration: bool,
    pub dev_show_code: bool,
    pub code_ttl_minutes: i64,
    pub code_max_attempts: i64,
    pub session_days: i64,
    pub password_min_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RootCfg {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ImagesCfg {
    pub quality: u32,
    pub max_upload_mb: usize,
    pub map_max_side: u32,
    pub token_max_side: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LoggingCfg {
    pub level: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            env_overrides: true,
            server: ServerCfg::default(),
            database: DatabaseCfg::default(),
            smtp: SmtpCfg::default(),
            auth: AuthCfg::default(),
            root: RootCfg::default(),
            images: ImagesCfg::default(),
            logging: LoggingCfg::default(),
        }
    }
}
impl Default for ServerCfg {
    fn default() -> Self { Self { host: "0.0.0.0".into(), port: 8080 } }
}
impl Default for DatabaseCfg {
    fn default() -> Self { Self { url: "sqlite://data/dnd.db".into(), max_connections: 10 } }
}
impl Default for SmtpCfg {
    fn default() -> Self {
        Self { host: String::new(), port: 587, encryption: "auto".into(), user: String::new(), password: String::new(), from: "noreply@example.com".into() }
    }
}
impl Default for AuthCfg {
    fn default() -> Self {
        Self { allow_registration: true, dev_show_code: true, code_ttl_minutes: 10, code_max_attempts: 5, session_days: 30, password_min_length: 8 }
    }
}
impl Default for RootCfg {
    fn default() -> Self { Self { email: String::new(), password: String::new() } }
}
impl Default for ImagesCfg {
    fn default() -> Self { Self { quality: 82, max_upload_mb: 25, map_max_side: 4096, token_max_side: 1024 } }
}
impl Default for LoggingCfg {
    fn default() -> Self { Self { level: "info,sqlx=warn".into() } }
}

/// Как подключаться к SMTP-серверу.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpSecurity {
    /// STARTTLS (обычно порт 587)
    StartTls,
    /// Сразу TLS (SMTPS, обычно порт 465)
    Tls,
    /// Без шифрования (локальный relay, порт 25) — пароль идёт открытым текстом
    None,
}

impl SmtpCfg {
    /// Режим шифрования с учётом `auto`: порт 465 — TLS, иначе STARTTLS.
    pub fn security(&self) -> SmtpSecurity {
        match self.encryption.as_str() {
            "tls" | "ssl" | "smtps" => SmtpSecurity::Tls,
            "none" | "plain" | "off" => SmtpSecurity::None,
            "starttls" => SmtpSecurity::StartTls,
            _ => if self.port == 465 { SmtpSecurity::Tls } else { SmtpSecurity::StartTls },
        }
    }
}

/// Класс лимита размера картинки: карты и токены настраиваются отдельно (images.*_max_side в config.yml).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeClass {
    Map,
    Token,
}

/// Тип ассета → класс лимита. Новый тип — одна строка здесь и одна в `ASSET_KINDS` (src/assets.rs).
/// Неизвестный тип получает лимит токенов. Тест `kind_size_table_covers_asset_kinds` сверяет списки.
pub const KIND_SIZE_CLASS: &[(&str, SizeClass)] = &[
    ("map", SizeClass::Map),
    ("token", SizeClass::Token),
    ("prop", SizeClass::Token),
    ("portrait", SizeClass::Token),
    ("item", SizeClass::Token),
];

impl ImagesCfg {
    /// Максимальный размер загружаемого файла в байтах.
    pub fn max_upload_bytes(&self) -> usize { self.max_upload_mb.saturating_mul(1024 * 1024) }
    /// Максимальная сторона картинки после сжатия для данного типа ассета.
    pub fn max_side(&self, kind: &str) -> u32 {
        let class = KIND_SIZE_CLASS.iter().find(|(k, _)| *k == kind).map(|(_, c)| *c).unwrap_or(SizeClass::Token);
        match class {
            SizeClass::Map => self.map_max_side,
            SizeClass::Token => self.token_max_side,
        }
    }
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

/// Параметр, значение которого взято из переменной окружения.
#[derive(Debug, Clone)]
pub struct Override {
    pub key: &'static str,
    pub var: &'static str,
}

/// Результат загрузки: конфигурация + сообщения для лога (логгер ещё не инициализирован,
/// поэтому сообщения копятся и печатаются после его настройки).
#[derive(Debug, Clone)]
pub struct Loaded {
    pub cfg: Config,
    pub path: PathBuf,
    pub created: bool,
    pub overrides: Vec<Override>,
    pub info: Vec<String>,
    pub warnings: Vec<String>,
}

/// Вынуть `--config <файл>` / `--config=<файл>` из аргументов командной строки.
pub fn take_path_arg(args: &mut Vec<String>) -> Option<PathBuf> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        if let Some(v) = args[i].strip_prefix("--config=") {
            found = Some(PathBuf::from(v));
            args.remove(i);
            continue;
        }
        if args[i] == "--config" {
            args.remove(i);
            if i < args.len() {
                found = Some(PathBuf::from(args.remove(i)));
            }
            continue;
        }
        i += 1;
    }
    found
}

/// Путь к файлу конфигурации: аргумент → `DND_CONFIG` → `./config.yml`.
pub fn resolve_path(arg: Option<PathBuf>) -> PathBuf {
    arg.or_else(|| env_val(PATH_ENV).map(PathBuf::from)).unwrap_or_else(|| PathBuf::from(DEFAULT_PATH))
}

/// Прочитать (или создать) файл конфигурации и применить переменные окружения.
pub fn load(path: PathBuf) -> anyhow::Result<Loaded> {
    let mut info = Vec::new();
    let mut warnings = Vec::new();
    let shown = display_path(&path);
    let mut created = false;

    let mut cfg = if !path.exists() {
        let cfg = Config::default();
        match write_file(&path, &render(&cfg)) {
            Ok(()) => {
                created = true;
                info.push(format!("Создан файл конфигурации {shown} — в нём можно настроить порт, базу данных, почту, root-аккаунт и остальное. После правки перезапустите сервер."));
            }
            Err(e) => warnings.push(format!("Не удалось создать файл конфигурации {shown}: {e:#}. Используются значения по умолчанию и переменные окружения.")),
        }
        cfg
    } else {
        let raw = fs::read_to_string(&path).with_context(|| format!("не удалось прочитать {shown}"))?;
        let text = raw.trim_start_matches('\u{feff}'); // BOM, который ставит «Блокнот»
        let parsed: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_yaml::from_str(text).map_err(|e| anyhow::anyhow!("ошибка синтаксиса YAML в {shown}: {e}"))?
        };
        let parsed = match parsed {
            Value::Null => Value::Mapping(Mapping::new()),
            Value::Mapping(m) => Value::Mapping(m),
            _ => anyhow::bail!("{shown}: ожидается набор параметров вида «ключ: значение», а не одиночное значение"),
        };
        let defaults = serde_yaml::to_value(Config::default())?;

        let mut missing = Vec::new();
        let mut unknown = Vec::new();
        diff_keys(&defaults, &parsed, "", &mut missing, &mut unknown);

        let normalized = normalize(&defaults, parsed);
        let normalized = drop_invalid(&defaults, normalized, &shown, &mut warnings);
        let cfg: Config = serde_yaml::from_value(normalized).map_err(|e| anyhow::anyhow!("неверное значение в {shown}: {e}"))?;

        for k in &unknown {
            warnings.push(format!("{shown}: неизвестный параметр «{k}» — опечатка? Он игнорируется."));
        }
        if !missing.is_empty() {
            // Файл от старой версии: перезаписываем полным шаблоном с текущими значениями.
            let mut bak = OsString::from(path.as_os_str());
            bak.push(".bak");
            let bak = PathBuf::from(bak);
            match fs::copy(&path, &bak).map_err(anyhow::Error::from).and_then(|_| write_file(&path, &render(&cfg))) {
                Ok(()) => {
                    let mut msg = format!("В {shown} добавлены новые параметры: {}. Ваши значения сохранены, прежняя версия файла — {}.", missing.join(", "), display_path(&bak));
                    if !unknown.is_empty() {
                        msg.push_str(&format!(" Неизвестные параметры ({}) из нового файла убраны.", unknown.join(", ")));
                    }
                    info.push(msg);
                }
                Err(e) => warnings.push(format!("{shown}: не хватает параметров ({}), для них берутся значения по умолчанию; дописать их в файл не удалось: {e:#}", missing.join(", "))),
            }
        }
        cfg
    };

    let overrides = cfg.apply_env(&mut warnings);
    cfg.validate(&mut warnings);
    Ok(Loaded { cfg, path, created, overrides, info, warnings })
}

/// Путь для сообщений: абсолютный, если его можно получить.
pub fn display_path(p: &Path) -> String {
    let abs = if p.is_absolute() { p.to_path_buf() } else { env::current_dir().map(|d| d.join(p)).unwrap_or_else(|_| p.to_path_buf()) };
    abs.display().to_string()
}

fn write_file(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir)?;
        }
    }
    fs::write(path, content)?;
    Ok(())
}

/// Ключи, которых нет в файле (`missing`), и лишние ключи (`unknown`) — сравнение с шаблоном.
fn diff_keys(defaults: &Value, actual: &Value, prefix: &str, missing: &mut Vec<String>, unknown: &mut Vec<String>) {
    let (Value::Mapping(d), Value::Mapping(a)) = (defaults, actual) else { return };
    let path = |k: &Value| {
        let k = k.as_str().map(str::to_string).unwrap_or_else(|| serde_yaml::to_string(k).unwrap_or_default().trim().to_string());
        if prefix.is_empty() { k } else { format!("{prefix}.{k}") }
    };
    for (k, dv) in d {
        match a.get(k) {
            None => missing.push(path(k)),
            Some(av) => {
                if dv.is_mapping() {
                    // «smtp:» без вложенных ключей — вся секция считается отсутствующей
                    let av = if av.is_null() { Value::Mapping(Mapping::new()) } else { av.clone() };
                    diff_keys(dv, &av, &path(k), missing, unknown);
                }
            }
        }
    }
    for k in a.keys() {
        if !d.contains_key(k) {
            unknown.push(path(k));
        }
    }
}

/// Прощаем типичные ошибки ручной правки: `port: "8080"`, `password: 12345678`,
/// `allow_registration: yes`, пустое значение `host:` и пустую секцию `smtp:`.
fn normalize(defaults: &Value, actual: Value) -> Value {
    match (defaults, actual) {
        (Value::Mapping(d), Value::Mapping(a)) => {
            let mut out = Mapping::new();
            for (k, v) in a {
                let Some(dv) = d.get(&k) else { continue }; // неизвестные ключи отбрасываем
                if v.is_null() && !dv.is_string() && !dv.is_mapping() {
                    continue; // пустое число/флаг — значение по умолчанию
                }
                out.insert(k, normalize(dv, v));
            }
            Value::Mapping(out)
        }
        (Value::Mapping(_), Value::Null) => Value::Mapping(Mapping::new()),
        (Value::String(_), Value::Null) => Value::String(String::new()),
        (Value::String(_), Value::Number(n)) => Value::String(n.to_string()),
        (Value::String(_), Value::Bool(b)) => Value::String(b.to_string()),
        (Value::Number(_), Value::String(s)) => match serde_yaml::from_str::<Value>(s.trim()) {
            Ok(Value::Number(n)) => Value::Number(n),
            _ => Value::String(s),
        },
        (Value::Bool(_), Value::String(s)) => match parse_bool(&s) {
            Some(b) => Value::Bool(b),
            None => Value::String(s),
        },
        (Value::Bool(_), Value::Number(n)) if n.as_i64() == Some(0) || n.as_i64() == Some(1) => Value::Bool(n.as_i64() == Some(1)),
        (_, v) => v,
    }
}

/// Значения неверного типа (`port: abc`, `port: 70000`) заменяются значениями по умолчанию
/// с предупреждением, где именно ошибка, — вместо отказа запускаться с невнятной ошибкой serde.
fn drop_invalid(defaults: &Value, mut actual: Value, shown: &str, w: &mut Vec<String>) -> Value {
    if serde_yaml::from_value::<Config>(actual.clone()).is_ok() {
        return actual;
    }
    // Все «листья» файла: (секция, ключ) или (ключ верхнего уровня, None)
    let mut leaves: Vec<(Value, Option<Value>)> = Vec::new();
    if let Value::Mapping(top) = &actual {
        for (sk, sv) in top {
            match sv {
                Value::Mapping(inner) => leaves.extend(inner.keys().map(|k| (sk.clone(), Some(k.clone())))),
                _ => leaves.push((sk.clone(), None)),
            }
        }
    }
    for (sk, k) in leaves {
        let value = match &k {
            Some(k) => actual.get(&sk).and_then(|s| s.get(k)).cloned(),
            None => actual.get(&sk).cloned(),
        };
        let Some(value) = value else { continue };
        // Пробуем подставить только этот параметр в конфигурацию по умолчанию
        let mut probe = defaults.clone();
        match &k {
            Some(k) => { if let Some(m) = probe.get_mut(&sk).and_then(Value::as_mapping_mut) { m.insert(k.clone(), value.clone()); } }
            None => { if let Some(m) = probe.as_mapping_mut() { m.insert(sk.clone(), value.clone()); } }
        }
        let Err(e) = serde_yaml::from_value::<Config>(probe) else { continue };
        let name = |v: &Value| v.as_str().map(str::to_string).unwrap_or_default();
        let key = match &k { Some(k) => format!("{}.{}", name(&sk), name(k)), None => name(&sk) };
        let default = match &k { Some(k) => defaults.get(&sk).and_then(|s| s.get(k)), None => defaults.get(&sk) };
        let default = default.map(|d| serde_yaml::to_string(d).unwrap_or_default().trim().to_string()).unwrap_or_default();
        let got = serde_yaml::to_string(&value).unwrap_or_default().trim().to_string();
        w.push(format!("{shown}: {key} = {got} — неверное значение ({e}); используется значение по умолчанию {default}."));
        match &k {
            Some(k) => { if let Some(m) = actual.get_mut(&sk).and_then(Value::as_mapping_mut) { m.remove(k); } }
            None => { if let Some(m) = actual.as_mapping_mut() { m.remove(&sk); } }
        }
    }
    actual
}

pub fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "y" | "on" | "да" => Some(true),
        "false" | "0" | "no" | "n" | "off" | "нет" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Переменные окружения
// ---------------------------------------------------------------------------

/// Значение переменной окружения; пустая строка считается «не задано».
fn env_val(k: &str) -> Option<String> {
    env::var(k).ok().filter(|v| !v.trim().is_empty())
}

struct EnvApplier<'a> {
    overrides: Vec<Override>,
    warnings: &'a mut Vec<String>,
}

impl EnvApplier<'_> {
    fn string(&mut self, target: &mut String, key: &'static str, var: &'static str) {
        if let Some(v) = env_val(var) {
            *target = v;
            self.overrides.push(Override { key, var });
        }
    }
    fn parse<T: FromStr>(&mut self, target: &mut T, key: &'static str, var: &'static str) {
        if let Some(v) = env_val(var) {
            match v.trim().parse() {
                Ok(x) => {
                    *target = x;
                    self.overrides.push(Override { key, var });
                }
                Err(_) => self.warnings.push(format!("Переменная {var}={v}: неверное значение — используется {key} из файла конфигурации.")),
            }
        }
    }
    fn flag(&mut self, target: &mut bool, key: &'static str, var: &'static str) {
        if let Some(v) = env_val(var) {
            match parse_bool(&v) {
                Some(b) => {
                    *target = b;
                    self.overrides.push(Override { key, var });
                }
                None => self.warnings.push(format!("Переменная {var}={v}: ожидается true или false — используется {key} из файла конфигурации.")),
            }
        }
    }
}

impl Config {
    /// Применить переменные окружения поверх значений из файла. Возвращает список перекрытых параметров.
    fn apply_env(&mut self, warnings: &mut Vec<String>) -> Vec<Override> {
        let mut e = EnvApplier { overrides: Vec::new(), warnings };
        if !self.env_overrides {
            // Порт, выделенный панелью Pterodactyl, нужен всегда.
            e.parse(&mut self.server.port, "server.port", "SERVER_PORT");
            return e.overrides;
        }
        e.string(&mut self.server.host, "server.host", "HOST");
        if env_val("PORT").is_some() {
            e.parse(&mut self.server.port, "server.port", "PORT");
        } else {
            e.parse(&mut self.server.port, "server.port", "SERVER_PORT");
        }

        e.string(&mut self.database.url, "database.url", "DATABASE_URL");
        e.parse(&mut self.database.max_connections, "database.max_connections", "DB_MAX_CONNECTIONS");

        e.string(&mut self.smtp.host, "smtp.host", "SMTP_HOST");
        e.parse(&mut self.smtp.port, "smtp.port", "SMTP_PORT");
        e.string(&mut self.smtp.encryption, "smtp.encryption", "SMTP_ENCRYPTION");
        e.string(&mut self.smtp.user, "smtp.user", "SMTP_USER");
        e.string(&mut self.smtp.password, "smtp.password", "SMTP_PASSWORD");
        e.string(&mut self.smtp.from, "smtp.from", "SMTP_FROM");

        e.flag(&mut self.auth.allow_registration, "auth.allow_registration", "ALLOW_REGISTRATION");
        e.flag(&mut self.auth.dev_show_code, "auth.dev_show_code", "DEV_SHOW_CODE");
        e.parse(&mut self.auth.code_ttl_minutes, "auth.code_ttl_minutes", "CODE_TTL_MINUTES");
        e.parse(&mut self.auth.code_max_attempts, "auth.code_max_attempts", "CODE_MAX_ATTEMPTS");
        e.parse(&mut self.auth.session_days, "auth.session_days", "SESSION_DAYS");
        e.parse(&mut self.auth.password_min_length, "auth.password_min_length", "PASSWORD_MIN_LENGTH");

        e.string(&mut self.root.email, "root.email", "ROOT_EMAIL");
        e.string(&mut self.root.password, "root.password", "ROOT_PASSWORD");

        e.parse(&mut self.images.quality, "images.quality", "IMAGE_QUALITY");
        e.parse(&mut self.images.max_upload_mb, "images.max_upload_mb", "MAX_UPLOAD_MB");
        e.parse(&mut self.images.map_max_side, "images.map_max_side", "MAP_MAX_SIDE");
        e.parse(&mut self.images.token_max_side, "images.token_max_side", "TOKEN_MAX_SIDE");

        e.string(&mut self.logging.level, "logging.level", "RUST_LOG");
        e.overrides
    }

    /// Привести значения к допустимым диапазонам (с предупреждением в лог).
    fn validate(&mut self, w: &mut Vec<String>) {
        fn clamp<T: PartialOrd + Copy + std::fmt::Display>(v: &mut T, lo: T, hi: T, key: &str, w: &mut Vec<String>) {
            if *v < lo || *v > hi {
                let fixed = if *v < lo { lo } else { hi };
                w.push(format!("{key} = {v} вне допустимого диапазона {lo}…{hi}, используется {fixed}."));
                *v = fixed;
            }
        }
        self.server.host = self.server.host.trim().to_string();
        if self.server.host.is_empty() {
            w.push("server.host пуст — используется 0.0.0.0.".into());
            self.server.host = "0.0.0.0".into();
        }
        if self.server.port == 0 {
            w.push("server.port = 0 — используется 8080.".into());
            self.server.port = 8080;
        }
        self.database.url = self.database.url.trim().to_string();
        if self.database.url.is_empty() {
            w.push("database.url пуст — используется SQLite (sqlite://data/dnd.db).".into());
            self.database.url = DatabaseCfg::default().url;
        } else if !self.database.url.starts_with("sqlite:") && !self.database.url.starts_with("mysql:") && !self.database.url.starts_with("mariadb:") {
            w.push(format!("database.url должен начинаться с sqlite:// или mysql:// (сейчас «{}»).", mask_url(&self.database.url)));
        }
        clamp(&mut self.database.max_connections, 1, 1000, "database.max_connections", w);

        self.smtp.host = self.smtp.host.trim().to_string();
        self.smtp.encryption = self.smtp.encryption.trim().to_lowercase();
        if !matches!(self.smtp.encryption.as_str(), "auto" | "starttls" | "tls" | "ssl" | "smtps" | "none" | "plain" | "off") {
            w.push(format!("smtp.encryption = «{}» — допустимо auto, starttls, tls или none; используется auto.", self.smtp.encryption));
            self.smtp.encryption = "auto".into();
        }
        if self.smtp.port == 0 {
            self.smtp.port = 587;
        }

        clamp(&mut self.auth.code_ttl_minutes, 1, 24 * 60, "auth.code_ttl_minutes", w);
        clamp(&mut self.auth.code_max_attempts, 1, 100, "auth.code_max_attempts", w);
        clamp(&mut self.auth.session_days, 0, 3650, "auth.session_days", w);
        clamp(&mut self.auth.password_min_length, 1, 200, "auth.password_min_length", w);

        self.root.email = self.root.email.trim().to_lowercase();

        clamp(&mut self.images.quality, 1, 100, "images.quality", w);
        clamp(&mut self.images.max_upload_mb, 1, 1024, "images.max_upload_mb", w);
        clamp(&mut self.images.map_max_side, 64, 16384, "images.map_max_side", w);
        clamp(&mut self.images.token_max_side, 64, 16384, "images.token_max_side", w);

        if self.logging.level.trim().is_empty() {
            self.logging.level = LoggingCfg::default().level;
        }
    }
}

// ---------------------------------------------------------------------------
// Текущая конфигурация (для консольной команды `config`)
// ---------------------------------------------------------------------------

static CURRENT: OnceLock<Loaded> = OnceLock::new();

/// Запомнить загруженную конфигурацию (вызывается один раз при старте).
pub fn set_current(l: &Loaded) {
    let _ = CURRENT.set(l.clone());
}

/// Убрать пароль из URL базы: mysql://user:pass@host → mysql://user:***@host.
pub fn mask_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let Some((cred, host)) = rest.rsplit_once('@') else { return url.to_string() };
    match cred.split_once(':') {
        Some((user, _)) => format!("{scheme}://{user}:***@{host}"),
        None => url.to_string(),
    }
}

/// Текст для команды `config`: путь к файлу, источники значений и действующие настройки (без паролей).
pub fn describe() -> String {
    let Some(l) = CURRENT.get() else { return "Конфигурация ещё не загружена".into() };
    let mut c = l.cfg.clone();
    let hide = |s: &mut String| if !s.is_empty() { *s = "***".into() };
    hide(&mut c.smtp.password);
    hide(&mut c.root.password);
    c.database.url = mask_url(&c.database.url);
    let mut out = format!("Файл конфигурации: {}\n", display_path(&l.path));
    out.push_str(if l.cfg.env_overrides {
        "Переменные окружения: учитываются (env_overrides: true)\n"
    } else {
        "Переменные окружения: игнорируются, кроме SERVER_PORT (env_overrides: false)\n"
    });
    if l.overrides.is_empty() {
        out.push_str("Все значения взяты из файла.\n");
    } else {
        out.push_str("Перекрыто переменными окружения:\n");
        for o in &l.overrides {
            out.push_str(&format!("  {} ← {}\n", o.key, o.var));
        }
    }
    out.push_str("\nДействующие значения (пароли скрыты; изменения файла применяются после перезапуска):\n");
    out.push_str(&serde_yaml::to_string(&c).unwrap_or_default());
    out.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Шаблон файла
// ---------------------------------------------------------------------------

/// Строка в YAML: JSON-строка в двойных кавычках — корректный YAML-скаляр с экранированием.
fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Полный текст config.yml с комментариями и текущими значениями.
pub fn render(c: &Config) -> String {
    format!(
        r#"# =============================================================================
#  Edge Tablet (Amperverser DnD Table) — файл конфигурации
# =============================================================================
#  Создаётся автоматически при первом запуске. После правки перезапустите сервер.
#
#  Переменные окружения и файл .env имеют приоритет над этим файлом (если не
#  выключено env_overrides ниже). Имя переменной указано у каждого параметра.
#  Пустая переменная считается незаданной.
#
#  Посмотреть действующие значения и откуда они взялись: команда `config`
#  в консоли сервера или `dnd-table config`.
#  Другой путь к файлу: `dnd-table --config /путь/config.yml` или DND_CONFIG.
#
#  Строки лучше писать в кавычках: "значение". Если в новой версии появятся
#  новые параметры, сервер допишет их сам, а старый файл сохранит в *.bak.
# =============================================================================

# Разрешить переменным окружения перекрывать значения из этого файла.
# false — всё берётся только отсюда (удобно на Pterodactyl, где панель всегда
# передаёт свои переменные). Порт от панели (SERVER_PORT) учитывается всегда.
env_overrides: {env_overrides}

# --- Веб-сервер --------------------------------------------------------------
server:
  # Адрес: "0.0.0.0" — доступен из сети, "127.0.0.1" — только с этого компьютера.
  # Переменная: HOST
  host: {host}
  # Порт веб-интерфейса (http://localhost:ПОРТ).
  # Переменная: PORT (на Pterodactyl — SERVER_PORT)
  port: {port}

# --- База данных -------------------------------------------------------------
database:
  # SQLite (ничего ставить не нужно):  "sqlite://data/dnd.db"
  # MySQL / MariaDB (для продакшена):  "mysql://user:password@localhost:3306/dnd"
  # Переменная: DATABASE_URL
  url: {db_url}
  # Размер пула соединений (только MySQL; для SQLite всегда 1).
  # Переменная: DB_MAX_CONNECTIONS
  max_connections: {db_max}

# --- Почта (коды подтверждения и сброса пароля) ------------------------------
smtp:
  # SMTP-сервер, например "smtp.yandex.ru". Пусто — письма не отправляются,
  # код печатается в консоль сервера.                 Переменная: SMTP_HOST
  host: {smtp_host}
  # 587 — STARTTLS, 465 — TLS (SMTPS), 25 — без шифрования. Переменная: SMTP_PORT
  port: {smtp_port}
  # auto (порт 465 → tls, иначе starttls) | starttls | tls | none
  # Переменная: SMTP_ENCRYPTION
  encryption: {smtp_enc}
  # Логин и пароль (для Яндекса/Gmail — пароль приложения).
  # Переменные: SMTP_USER, SMTP_PASSWORD
  user: {smtp_user}
  password: {smtp_password}
  # Адрес отправителя; у многих сервисов должен совпадать с user.
  # Переменная: SMTP_FROM
  from: {smtp_from}

# --- Регистрация и вход ------------------------------------------------------
auth:
  # Регистрация новых аккаунтов через сайт. false — аккаунты создаёт только root
  # (страница /admin или команда users create).  Переменная: ALLOW_REGISTRATION
  allow_registration: {allow_reg}
  # Если SMTP не настроен — показывать код прямо в форме входа. Только для
  # разработки и игры «для своих»: на публичном сервере поставьте false!
  # Переменная: DEV_SHOW_CODE
  dev_show_code: {dev_code}
  # Сколько минут действует код из письма.        Переменная: CODE_TTL_MINUTES
  code_ttl_minutes: {code_ttl}
  # Сколько неверных попыток ввода кода допускается. Переменная: CODE_MAX_ATTEMPTS
  code_max_attempts: {code_attempts}
  # Сколько дней живёт сессия после входа (0 — без ограничения).
  # Переменная: SESSION_DAYS
  session_days: {session_days}
  # Минимальная длина пароля в веб-формах.         Переменная: PASSWORD_MIN_LENGTH
  password_min_length: {pw_min}

# --- Администратор (root) ----------------------------------------------------
# Если заполнено — при старте создаётся подтверждённый аккаунт с правами root
# (если аккаунта с такой почтой ещё нет). Потом пароль отсюда можно убрать:
# права хранятся в базе. Управление: консольные команды users … или /admin.
# Переменные: ROOT_EMAIL, ROOT_PASSWORD
root:
  email: {root_email}
  password: {root_password}

# --- Изображения (карты, токены, портреты) -----------------------------------
images:
  # Качество JPEG при сжатии, 1–100.                   Переменная: IMAGE_QUALITY
  quality: {img_quality}
  # Максимальный размер загружаемого файла, МБ.        Переменная: MAX_UPLOAD_MB
  max_upload_mb: {img_upload}
  # Картинки больше этого размера (по длинной стороне, пиксели) уменьшаются:
  # карты — map_max_side, токены/портреты/предметы — token_max_side.
  # Переменные: MAP_MAX_SIDE, TOKEN_MAX_SIDE
  map_max_side: {img_map}
  token_max_side: {img_token}

# --- Логи --------------------------------------------------------------------
logging:
  # error | warn | info | debug | trace; можно по модулям: "debug,sqlx=warn".
  # Переменная: RUST_LOG
  level: {log_level}
"#,
        env_overrides = c.env_overrides,
        host = q(&c.server.host),
        port = c.server.port,
        db_url = q(&c.database.url),
        db_max = c.database.max_connections,
        smtp_host = q(&c.smtp.host),
        smtp_port = c.smtp.port,
        smtp_enc = q(&c.smtp.encryption),
        smtp_user = q(&c.smtp.user),
        smtp_password = q(&c.smtp.password),
        smtp_from = q(&c.smtp.from),
        allow_reg = c.auth.allow_registration,
        dev_code = c.auth.dev_show_code,
        code_ttl = c.auth.code_ttl_minutes,
        code_attempts = c.auth.code_max_attempts,
        session_days = c.auth.session_days,
        pw_min = c.auth.password_min_length,
        root_email = q(&c.root.email),
        root_password = q(&c.root.password),
        img_quality = c.images.quality,
        img_upload = c.images.max_upload_mb,
        img_map = c.images.map_max_side,
        img_token = c.images.token_max_side,
        log_level = q(&c.logging.level),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_roundtrip_has_all_keys() {
        let mut c = Config::default();
        c.smtp.password = "p\"a:ss # word".into();
        c.root.email = "admin@example.com".into();
        let text = render(&c);
        let v: Value = serde_yaml::from_str(&text).unwrap();
        let (mut missing, mut unknown) = (Vec::new(), Vec::new());
        diff_keys(&serde_yaml::to_value(Config::default()).unwrap(), &v, "", &mut missing, &mut unknown);
        assert!(missing.is_empty(), "в шаблоне нет ключей: {missing:?}");
        assert!(unknown.is_empty(), "в шаблоне лишние ключи: {unknown:?}");
        let back: Config = serde_yaml::from_value(v).unwrap();
        assert_eq!(back.smtp.password, "p\"a:ss # word");
        assert_eq!(back.root.email, "admin@example.com");
        assert_eq!(back.server.port, 8080);
    }

    #[test]
    fn normalize_forgives_types() {
        let defaults = serde_yaml::to_value(Config::default()).unwrap();
        let v: Value = serde_yaml::from_str("server:\n  port: \"9000\"\n  host:\nsmtp:\nauth:\n  allow_registration: no\n  session_days:\nroot:\n  password: 12345678\n").unwrap();
        let (mut missing, mut unknown) = (Vec::new(), Vec::new());
        diff_keys(&defaults, &v, "", &mut missing, &mut unknown);
        assert!(missing.contains(&"smtp.host".to_string()));
        assert!(missing.contains(&"database".to_string()));
        let c: Config = serde_yaml::from_value(normalize(&defaults, v)).unwrap();
        assert_eq!(c.server.port, 9000);
        assert_eq!(c.server.host, "");
        assert!(!c.auth.allow_registration);
        assert_eq!(c.auth.session_days, 30);
        assert_eq!(c.root.password, "12345678");
    }

    #[test]
    fn invalid_values_fall_back_to_defaults() {
        let defaults = serde_yaml::to_value(Config::default()).unwrap();
        let v: Value = serde_yaml::from_str("server:\n  port: 70000\n  host: \"127.0.0.1\"\nauth:\n  session_days: abc\n").unwrap();
        let mut w = Vec::new();
        let v = drop_invalid(&defaults, normalize(&defaults, v), "config.yml", &mut w);
        let c: Config = serde_yaml::from_value(v).unwrap();
        assert_eq!(c.server.port, 8080);
        assert_eq!(c.server.host, "127.0.0.1");
        assert_eq!(c.auth.session_days, 30);
        assert_eq!(w.len(), 2, "{w:?}");
        assert!(w[0].contains("server.port"));
    }

    #[test]
    fn args_and_masking() {
        let mut a: Vec<String> = ["--config", "x.yml", "users", "list"].iter().map(|s| s.to_string()).collect();
        assert_eq!(take_path_arg(&mut a), Some(PathBuf::from("x.yml")));
        assert_eq!(a, vec!["users", "list"]);
        let mut b: Vec<String> = ["stats", "--config=/a/b.yml"].iter().map(|s| s.to_string()).collect();
        assert_eq!(take_path_arg(&mut b), Some(PathBuf::from("/a/b.yml")));
        assert_eq!(b, vec!["stats"]);
        assert_eq!(mask_url("mysql://dnd:secret@db:3306/dnd"), "mysql://dnd:***@db:3306/dnd");
        assert_eq!(mask_url("sqlite://data/dnd.db"), "sqlite://data/dnd.db");
    }

    #[test]
    fn smtp_auto_security() {
        let mut s = SmtpCfg::default();
        assert_eq!(s.security(), SmtpSecurity::StartTls);
        s.port = 465;
        assert_eq!(s.security(), SmtpSecurity::Tls);
        s.encryption = "none".into();
        assert_eq!(s.security(), SmtpSecurity::None);
    }
}

#[cfg(test)]
mod size_limit_tests {
    use super::*;

    #[test]
    fn kind_size_table_covers_asset_kinds() {
        for kind in crate::assets::ASSET_KINDS {
            assert!(KIND_SIZE_CLASS.iter().any(|(k, _)| k == kind), "нет лимита для типа {kind}");
        }
    }

    #[test]
    fn max_side_follows_the_kind_table() {
        let mut cfg = ImagesCfg::default();
        cfg.map_max_side = 3000;
        cfg.token_max_side = 500;
        assert_eq!(cfg.max_side("map"), 3000);
        assert_eq!(cfg.max_side("prop"), 500);
        assert_eq!(cfg.max_side("unknown-kind"), 500);
    }
}
