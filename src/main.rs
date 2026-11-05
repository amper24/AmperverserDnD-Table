//! Edge Tablet — сервер виртуального стола (axum + sqlx, MySQL/SQLite).
mod api;
mod domain;
mod store;
mod ws;

mod config;
mod error;
mod i18n;
mod util;

use crate::store::sdr_source::make_source;

// Слои по папкам: api/ — HTTP-эндпоинты, domain/ — правила, store/ — БД и сид,
// ws/ — realtime. Везде полные пути вида crate::api::auth, crate::domain::mechanics.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use rust_embed::RustEmbed;
use sqlx::Row;
use tower_http::{compression::CompressionLayer, trace::TraceLayer};

pub use error::AppError;

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::AnyPool,
    pub cfg: Arc<config::Config>,
    pub hub: ws::realtime::Hub,
    pub is_sqlite: bool,
}

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/static/"]
struct StaticFiles;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    // Паники пишем в файл: без этого случайный выход сервера не оставляет следов.
    std::panic::set_hook(Box::new(|info| {
        let text = format!(
            "[{}] panic: {}\n{}",
            chrono::Utc::now().to_rfc3339(),
            info,
            std::backtrace::Backtrace::force_capture()
        );
        let _ = std::fs::write("dnd-panic.log", &text);
        eprintln!("{text}");
    }));

    // Конфигурация: config.yml (создаётся при первом запуске) + переменные окружения.
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let cfg_path = config::resolve_path(config::take_path_arg(&mut args));
    let loaded = match config::load(cfg_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Ошибка конфигурации: {e:#}");
            eprintln!("Исправьте файл (или удалите его — при следующем запуске будет создан новый с настройками по умолчанию).");
            std::process::exit(1);
        }
    };
    let filter = tracing_subscriber::EnvFilter::try_new(&loaded.cfg.logging.level).unwrap_or_else(|_| {
        eprintln!("logging.level = «{}» не распознан — используется info,sqlx=warn", loaded.cfg.logging.level);
        "info,sqlx=warn".into()
    });
    tracing_subscriber::fmt()
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .with_env_filter(filter)
        .init();
    for m in &loaded.info { tracing::info!("{m}"); }
    for m in &loaded.warnings { tracing::warn!("{m}"); }
    if !loaded.overrides.is_empty() {
        let list = loaded.overrides.iter().map(|o| format!("{} ← {}", o.key, o.var)).collect::<Vec<_>>().join(", ");
        tracing::info!("Конфигурация: {} (перекрыто переменными окружения: {list})", config::display_path(&loaded.path));
    } else {
        tracing::info!("Конфигурация: {}", config::display_path(&loaded.path));
    }
    config::set_current(&loaded);
    let cfg = Arc::new(loaded.cfg.clone());

    let (db, is_sqlite) = store::db::connect(&cfg.database.url, cfg.database.max_connections).await?;
    store::db::migrate(&db, is_sqlite).await?;
    let sdr_source: Arc<dyn store::sdr_source::SdrSource> = Arc::from(make_source(&loaded.cfg));
    tracing::info!(
        "SDR: источник = {}",
        if loaded.cfg.sdr.enabled { "Git" } else { "локальная папка / встроенный fallback" }
    );
    store::seed::seed(&db, &cfg.images, sdr_source.as_ref()).await?;
    api::admin::ensure_root_from_config(&db, &cfg.root).await?;

    // Команды администрирования (dnd-table users …, stats, reseed, config). Ошибка команды — выход
    // с понятным сообщением и кодом 2 (неверное использование) или 1 (ошибка выполнения).
    match api::admin::run_cli(&db, &args, api::admin::CliMode::Cli, &cfg.images, sdr_source.as_ref()).await {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => api::admin::exit_cli_error(&e),
    }

    // Первый запуск: без администратора в веб-интерфейс не войти — подсказываем прямо в консоли.
    let roots: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_root = 1").fetch_one(&db).await?.get("n");

    let state_db = db.clone();
    let state = AppState { db, cfg: cfg.clone(), hub: ws::realtime::Hub::default(), is_sqlite };

    let app = Router::new()
        .route("/api/health", get(|| async { axum::Json(serde_json::json!({"ok": true})) }))
        .merge(api::auth::router())
        .merge(api::admin::router())
        .merge(api::campaigns::router())
        .merge(api::scenes::router())
        .merge(api::assets::router(cfg.images.max_upload_bytes()))
        .merge(api::characters::router())
        .merge(api::compendium::router())
        .merge(api::packs::router())
        .merge(ws::realtime::router())
        .route("/static/*path", get(static_handler))
        .route("/sheet/:id", get(|| async { serve_embedded("sheet.html", None) }))
        // Страница «Участники стола» (токены, HP, скрытность, владелец).
        .route("/table/:cid", get(|| async { serve_embedded("table.html", None) }))
        .route("/profile", get(|| async { serve_embedded("profile.html", None) }))
        .fallback(get(|| async { serve_embedded("index.html", None) }))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("{}:{}", cfg.server.host, cfg.server.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.map_err(|e| {
        anyhow::anyhow!("не удалось занять адрес {addr}: {e}. Порт занят другим процессом? Смените server.port в {}", config::display_path(&loaded.path))
    })?;
    let db_label = config::mask_url(&cfg.database.url);
    tracing::info!("Edge Tablet запущен: http://{}  (БД: {})", addr, db_label);
    println!("Server listening on http://{addr}");
    println!("Консоль: help — список команд. Их можно вводить как есть или с префиксом dnd-table");
    println!("         (users list, users create <email> <пароль> --root, stats, config, stop)");
    if loaded.created {
        println!("Настройки: {} — порт, база данных, почта, root-аккаунт и др. (после правки перезапустите сервер)", config::display_path(&loaded.path));
    }
    if roots == 0 {
        println!("[!] В базе нет ни одного администратора (root). Создайте его прямо здесь:");
        println!("      users create admin@example.com <пароль> --root");
        println!("    или заполните root.email и root.password в {} и перезапустите сервер.", config::display_path(&loaded.path));
    }
    api::admin::spawn_console(state_db, cfg.images.clone(), sdr_source);
    // Остановка только по Ctrl+C (или явной команде stop): отметка в логе.
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::warn!("Получен Ctrl+C — сервер останавливается");
        eprintln!("Получен Ctrl+C — сервер останавливается");
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    tracing::warn!("Сервер завершил работу (serve вернул Ok)");
    eprintln!("Сервер завершил работу");
    Ok(())
}

async fn static_handler(uri: Uri, headers: axum::http::HeaderMap) -> Response {
    let path = uri.path().trim_start_matches("/static/");
    serve_embedded(path, headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()))
}

/// Кэш встроенных файлов: они вкомпилированы при сборке и не меняются, поэтому ETag,
/// MIME и версионированный HTML считаем один раз за процесс, а не на каждый запрос
/// (раньше каждый HTML-запрос проходил все ~115 файлов: sha256 + строковые замены).
struct CachedAsset {
    etag: String,
    mime: String,
    body: axum::body::Bytes,
}

fn asset_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Arc<CachedAsset>>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Arc<CachedAsset>>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Хэши (4 байта, hex) всех встроенных файлов — для версионирования ссылок `?v=` в HTML; считаются один раз.
fn asset_hashes() -> &'static std::collections::HashMap<String, String> {
    static HASHES: std::sync::OnceLock<std::collections::HashMap<String, String>> = std::sync::OnceLock::new();
    HASHES.get_or_init(|| {
        StaticFiles::iter()
            .filter_map(|name| {
                StaticFiles::get(&name).map(|f| {
                    let h = f.metadata.sha256_hash()[..4].iter().map(|b| format!("{b:02x}")).collect::<String>();
                    (name.to_string(), h)
                })
            })
            .collect()
    })
}

fn cached_asset(path: &str) -> Option<Arc<CachedAsset>> {
    if let Some(asset) = asset_cache().lock().unwrap().get(path) {
        return Some(asset.clone());
    }
    let file = StaticFiles::get(path)?;
    // Всегда перепроверять (ETag по хэшу содержимого): после обновления сервера клиент не должен жить со старым JS
    let etag = format!("\"{}\"", file.metadata.sha256_hash()[..8].iter().map(|b| format!("{b:02x}")).collect::<String>());
    let mime = mime_guess::from_path(path).first_or_octet_stream().to_string();
    let mut data = file.data.into_owned();
    if path.ends_with(".html") {
        // Версионируем ссылки на скрипты/стили хэшем содержимого — браузер никогда не подхватит устаревший JS
        let mut html = String::from_utf8_lossy(&data).into_owned();
        for (name, h) in asset_hashes().iter() {
            html = html.replace(&format!("\"/static/{name}\""), &format!("\"/static/{name}?v={h}\""));
        }
        data = html.into_bytes();
    }
    let asset = Arc::new(CachedAsset { etag, mime, body: axum::body::Bytes::from(data) });
    asset_cache().lock().unwrap().insert(path.to_string(), asset.clone());
    Some(asset)
}

fn serve_embedded(path: &str, if_none_match: Option<&str>) -> Response {
    let Some(asset) = cached_asset(path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if if_none_match.map(|v| v == asset.etag).unwrap_or(false) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, asset.etag.as_str())
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::empty())
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime.as_str())
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ETAG, asset.etag.as_str())
        .body(Body::from(asset.body.clone()))
        .unwrap()
}
