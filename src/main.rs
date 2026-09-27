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
mod images;
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
    tracing_subscriber::fmt()
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()))
        .init();

    let cfg = Arc::new(config::Config::from_env());
    let (db, is_sqlite) = db::connect(&cfg.database_url).await?;
    db::migrate(&db, is_sqlite).await?;
    seed::seed(&db).await?;
    admin::ensure_root_from_env(&db).await?;

    // CLI-команды администрирования (dnd-table users ..., stats, reseed)
    let args: Vec<String> = std::env::args().skip(1).collect();
    if admin::run_cli(&db, &args).await? {
        return Ok(());
    }

    let state_db = db.clone();
    let state = AppState { db, cfg: cfg.clone(), hub: realtime::Hub::default(), is_sqlite };

    let app = Router::new()
        .route("/api/health", get(|| async { axum::Json(serde_json::json!({"ok": true})) }))
        .merge(auth::router())
        .merge(admin::router())
        .merge(campaigns::router())
        .merge(scenes::router())
        .merge(assets::router())
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

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let db_label = cfg.database_url.split('@').last().unwrap_or("").to_string();
    tracing::info!("Edge Tablet запущен: http://{}  (БД: {})", addr, db_label);
    println!("Server listening on http://{addr}");
    println!("Консоль: введите help для списка команд (users list, users make-root <email>, stats, stop)");
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
