//! Стартовые данные: справочник (data_seed/srd_2014.json, srd_2024.json — сборка tools/srd/build_srd.py) и встроенные ассеты (data_seed/builtin/*),
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

/// Файлы справочника и метка источника. Каждый файл заливается независимо: если записей с таким
/// источником ещё нет — добавляем (так новые редакции подтягиваются и в уже существующие БД).
const SEED_FILES: &[(&str, &str)] = &[("srd_2014.json", "SRD 2014"), ("srd_2024.json", "SRD 2024")];

pub async fn seed(pool: &AnyPool) -> anyhow::Result<()> {
    for (file, source) in SEED_FILES {
        let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL AND source = ?").bind(source).fetch_one(pool).await?.get("n");
        if n > 0 { continue; }
        let Some(raw) = SeedFiles::get(file) else { tracing::warn!("{} не вшит", file); continue };
        let entries: Vec<Entry> = serde_json::from_slice(&raw.data)?;
        let count = entries.len();
        let mut tx = pool.begin().await?;
        for e in entries {
            let name_en = e.data.get("name_en").and_then(|v| v.as_str()).unwrap_or("");
            let name_lc = util::truncate(&format!("{} {}", e.name, name_en).to_lowercase(), 128);
            sqlx::query("INSERT INTO compendium (id, campaign_id, category, slug, name, name_lc, source, data) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)")
                .bind(util::uid()).bind(&e.category).bind(&e.slug).bind(util::truncate(&e.name, 128)).bind(name_lc).bind(source).bind(e.data.to_string()).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        tracing::info!("Справочник {}: добавлено {} записей", source, count);
    }
    // устаревший базовый набор (source = 'SRD' из ранних версий) убираем — его заменяют SRD 2014/2024
    sqlx::query("DELETE FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL AND source = 'SRD'").execute(pool).await?;

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
