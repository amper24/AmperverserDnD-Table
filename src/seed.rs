//! Стартовые данные: справочник (data_seed/compendium.json) и встроенные ассеты (data_seed/builtin/*),
//! всё вшито в бинарник на этапе сборки.
use rust_embed::RustEmbed;
use serde::Deserialize;
use sqlx::{AnyPool, Row};

use crate::{images, util};

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/data_seed/"]
struct SeedFiles;

#[derive(Deserialize)]
struct Entry { category: String, slug: String, name: String, data: serde_json::Value }

#[derive(Deserialize)]
struct BuiltinAsset { file: String, name: String, kind: String }

pub async fn seed(pool: &AnyPool) -> anyhow::Result<()> {
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL").fetch_one(pool).await?.get("n");
    if n == 0 {
        let raw = SeedFiles::get("compendium.json").ok_or_else(|| anyhow::anyhow!("compendium.json не вшит"))?;
        let entries: Vec<Entry> = serde_json::from_slice(&raw.data)?;
        let count = entries.len();
        for e in entries {
            sqlx::query("INSERT INTO compendium (id, campaign_id, category, slug, name, source, data) VALUES (?, NULL, ?, ?, ?, 'SRD', ?)")
                .bind(util::uid()).bind(&e.category).bind(&e.slug).bind(&e.name).bind(e.data.to_string()).execute(pool).await?;
        }
        tracing::info!("Справочник: добавлено {} записей", count);
    }

    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM assets WHERE builtin = 1").fetch_one(pool).await?.get("n");
    if n == 0 {
        let raw = SeedFiles::get("builtin/manifest.json").ok_or_else(|| anyhow::anyhow!("manifest.json не вшит"))?;
        let list: Vec<BuiltinAsset> = serde_json::from_slice(&raw.data)?;
        let mut count = 0;
        for a in list {
            let Some(file) = SeedFiles::get(&format!("builtin/{}", a.file)) else { continue };
            let bytes = file.data.into_owned();
            let max_side = if a.kind == "map" { 2048 } else { 512 };
            let info = tokio::task::spawn_blocking(move || images::compress_image(&bytes, max_side, 85)).await??;
            sqlx::query("INSERT INTO assets (id, campaign_id, owner_id, name, kind, mime, width, height, encoding, data_b64, builtin, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
                .bind(util::uid()).bind(&a.name).bind(&a.kind).bind(&info.mime).bind(info.width).bind(info.height).bind(&info.encoding).bind(&info.data_b64).bind(util::now())
                .execute(pool).await?;
            count += 1;
        }
        tracing::info!("Ассеты: добавлено {} встроенных", count);
    }
    Ok(())
}
