//! Edge Tablet — сервер виртуального стола (axum + sqlx, MySQL/SQLite).
mod admin;
mod assets;
mod auth;
mod campaigns;
mod characters;
mod compendium;
mod config;
mod db;
mod error;
mod i18n;
mod images;
mod inventory;
mod mechanics;
mod packs;
mod realtime;
mod scenes;
mod seed;
mod util;

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
    pub hub: realtime::Hub,
    pub is_sqlite: bool,
}

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/static/"]
struct StaticFiles;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

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

    let (db, is_sqlite) = db::connect(&cfg.database.url, cfg.database.max_connections).await?;
    db::migrate(&db, is_sqlite).await?;
    seed::seed(&db).await?;
    admin::ensure_root_from_config(&db, &cfg.root).await?;

    // Команды администрирования (dnd-table users …, stats, reseed, config). Ошибка команды — выход
    // с понятным сообщением и кодом 2 (неверное использование) или 1 (ошибка выполнения).
    match admin::run_cli(&db, &args, admin::CliMode::Cli).await {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => admin::exit_cli_error(&e),
    }

    // Первый запуск: без администратора в веб-интерфейс не войти — подсказываем прямо в консоли.
    let roots: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_root = 1").fetch_one(&db).await?.get("n");

    let state_db = db.clone();
    let state = AppState { db, cfg: cfg.clone(), hub: realtime::Hub::default(), is_sqlite };

    let app = Router::new()
        .route("/api/health", get(|| async { axum::Json(serde_json::json!({"ok": true})) }))
        .merge(auth::router())
        .merge(admin::router())
        .merge(campaigns::router())
        .merge(scenes::router())
        .merge(assets::router(cfg.images.max_upload_bytes()))
        .merge(characters::router())
        .merge(compendium::router())
        .merge(packs::router())
        .merge(realtime::router())
        .route("/static/*path", get(static_handler))
        .route("/sheet/:id", get(|| async { serve_embedded("sheet.html", None) }))
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
    admin::spawn_console(state_db);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn static_handler(uri: Uri, headers: axum::http::HeaderMap) -> Response {
    let path = uri.path().trim_start_matches("/static/");
    serve_embedded(path, headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()))
}

fn serve_embedded(path: &str, if_none_match: Option<&str>) -> Response {
    match StaticFiles::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // Всегда перепроверять (ETag по хэшу содержимого): после обновления сервера клиент не должен жить со старым JS
            let etag = format!("\"{}\"", file.metadata.sha256_hash()[..8].iter().map(|b| format!("{b:02x}")).collect::<String>());
            if if_none_match.map(|v| v == etag).unwrap_or(false) {
                return Response::builder().status(StatusCode::NOT_MODIFIED).header(header::ETAG, etag).header(header::CACHE_CONTROL, "no-cache").body(Body::empty()).unwrap();
            }
            let mut data = file.data.into_owned();
            if path.ends_with(".html") {
                // Версионируем ссылки на скрипты/стили хэшем содержимого — браузер никогда не подхватит устаревший JS
                let mut html = String::from_utf8_lossy(&data).into_owned();
                for name in StaticFiles::iter() {
                    if let Some(f) = StaticFiles::get(&name) {
                        let h = f.metadata.sha256_hash()[..4].iter().map(|b| format!("{b:02x}")).collect::<String>();
                        html = html.replace(&format!("\"/static/{name}\""), &format!("\"/static/{name}?v={h}\""));
                    }
                }
                data = html.into_bytes();
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .header(header::CACHE_CONTROL, "no-cache")
                .header(header::ETAG, etag)
                .body(Body::from(data))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
