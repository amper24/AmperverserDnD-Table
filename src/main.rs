//! Amperverser DnD Table — сервер виртуального стола (axum + sqlx, MySQL/SQLite).
mod assets;
mod auth;
mod campaigns;
mod characters;
mod compendium;
mod config;
mod db;
mod error;
mod images;
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
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()))
        .init();

    let cfg = Arc::new(config::Config::from_env());
    let (db, is_sqlite) = db::connect(&cfg.database_url).await?;
    db::migrate(&db, is_sqlite).await?;
    seed::seed(&db).await?;

    let state = AppState { db, cfg: cfg.clone(), hub: realtime::Hub::default(), is_sqlite };

    let app = Router::new()
        .route("/api/health", get(|| async { axum::Json(serde_json::json!({"ok": true})) }))
        .merge(auth::router())
        .merge(campaigns::router())
        .merge(scenes::router())
        .merge(assets::router())
        .merge(characters::router())
        .merge(compendium::router())
        .merge(realtime::router())
        .route("/static/*path", get(static_handler))
        .route("/sheet/:id", get(|| async { serve_embedded("sheet.html") }))
        .fallback(get(|| async { serve_embedded("index.html") }))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let db_label = cfg.database_url.split('@').last().unwrap_or("").to_string();
    tracing::info!("DnD Table запущен: http://{}  (БД: {})", addr, db_label);
    println!("Server listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches("/static/");
    serve_embedded(path)
}

fn serve_embedded(path: &str) -> Response {
    match StaticFiles::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            let cache = if path.ends_with(".html") { "no-cache" } else { "public, max-age=3600" };
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .header(header::CACHE_CONTROL, cache)
                .body(Body::from(file.data.into_owned()))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
