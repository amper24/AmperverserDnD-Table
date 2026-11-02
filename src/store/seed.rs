//! Стартовые данные: справочник (data_seed/*.json — сборка tools/srd/build_srd.py) и встроенные
//! ассеты (data_seed/builtin/*). Всё вшито в бинарник.
//!
//! Базовый справочник — часть сборки, а не пользовательские данные: он заменяется целиком, когда
//! меняются вшитые файлы (отпечаток SHA-256 хранится в `seed_state`). Пока отпечаток совпадает,
//! база не трогается — правки базовых записей (root) переживают перезапуск, но при пересборке
//! данных сбрасываются вместе с базой. Пользовательский контент живёт в наборах и homebrew кампаний.
use rust_embed::RustEmbed;
use serde::Deserialize;
use sqlx::{AnyPool, Row};

use crate::{config::ImagesCfg, i18n, images, util};

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/data_seed/"]
struct SeedFiles;

#[derive(Deserialize)]
struct Entry { category: String, slug: String, name: String, data: serde_json::Value }

#[derive(Deserialize)]
struct BuiltinAsset { file: String, name: String, kind: String }

/// Файлы справочника и метка источника. Черты идут под источниками SRD (фильтр по редакции должен
/// показывать черты своей редакции), навыки — вне редакций: источник «Навыки» не совпадает с SRD.
const SEED_FILES: &[(&str, &str)] = &[
    ("srd_2014.json", "SRD 2014"),
    ("srd_2024.json", "SRD 2024"),
    ("feats_2014.json", "SRD 2014"),
    ("feats_2024.json", "SRD 2024"),
    ("skills.json", "Навыки"),
];

/// Отпечаток вшитых данных: SHA-256 каждого файла, склеенные через запятую.
fn fingerprint() -> String {
    SEED_FILES.iter().filter_map(|(file, _)| SeedFiles::get(file))
        .map(|f| f.metadata.sha256_hash().iter().map(|b| format!("{b:02x}")).collect::<String>())
        .collect::<Vec<_>>().join(",")
}

/// Удалить базовый справочник и отметку о вшитых данных (полная перезаливка при reseed).
pub async fn reset(pool: &AnyPool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM seed_state WHERE key = 'compendium'").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn seed(pool: &AnyPool, img_cfg: &ImagesCfg) -> anyhow::Result<()> {
    seed_compendium(pool).await?;
    seed_assets(pool, img_cfg).await?;
    Ok(())
}

async fn seed_compendium(pool: &AnyPool) -> anyhow::Result<()> {
    let stamp = fingerprint();
    let stored: Option<String> = sqlx::query("SELECT value FROM seed_state WHERE key = 'compendium'")
        .fetch_optional(pool).await?.map(|r| r.get("value"));
    if stored.as_deref() == Some(stamp.as_str()) {
        return Ok(());
    }

    let mut batches = Vec::new();
    for (file, source) in SEED_FILES {
        let Some(raw) = SeedFiles::get(file) else {
            tracing::warn!("{file} не вшит");
            continue;
        };
        let entries: Vec<Entry> = serde_json::from_slice(&raw.data)?;
        batches.push((*source, entries));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL").execute(&mut *tx).await?;
    let mut total = 0usize;
    for (source, entries) in batches {
        for e in entries {
            if let Some(m) = e.data.get("mechanics") {
                crate::mechanics::validate(m).map_err(|err| anyhow::anyhow!("Некорректная механика {}: {err:?}", e.slug))?;
            }
            let name = util::truncate(&e.name, 128);
            sqlx::query("INSERT INTO compendium (id, campaign_id, category, slug, name, name_lc, source, data) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)")
                .bind(util::uid()).bind(&e.category).bind(&e.slug).bind(&name)
                .bind(i18n::search_key(&name, &e.data)).bind(source).bind(e.data.to_string())
                .execute(&mut *tx).await?;
            total += 1;
        }
    }
    sqlx::query("DELETE FROM seed_state WHERE key = 'compendium'").execute(&mut *tx).await?;
    sqlx::query("INSERT INTO seed_state (key, value) VALUES ('compendium', ?)").bind(&stamp).execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!("Справочник: залито {total} записей из вшитых файлов");
    Ok(())
}

async fn seed_assets(pool: &AnyPool, img_cfg: &ImagesCfg) -> anyhow::Result<()> {
    // Каждый файл манифеста сеется один раз (отметка в builtin_seeds): новые записи добавляются и в
    // существующие базы, удалённый встроенный ассет не возвращается.
    let raw = SeedFiles::get("builtin/manifest.json").ok_or_else(|| anyhow::anyhow!("manifest.json не вшит"))?;
    let list: Vec<BuiltinAsset> = serde_json::from_slice(&raw.data)?;
    let mut added = 0;
    for a in list {
        let done: i64 = sqlx::query("SELECT COUNT(*) AS n FROM builtin_seeds WHERE file = ?").bind(&a.file).fetch_one(pool).await?.get("n");
        if done > 0 { continue; }
        let exists: i64 = sqlx::query("SELECT COUNT(*) AS n FROM assets WHERE builtin = 1 AND name = ? AND kind = ?").bind(&a.name).bind(&a.kind).fetch_one(pool).await?.get("n");
        if exists == 0 {
            let Some(file) = SeedFiles::get(&format!("builtin/{}", a.file)) else { continue };
            let bytes = file.data.into_owned();
            let max_side = img_cfg.max_side(&a.kind);
            let quality = img_cfg.quality.min(100) as u8;
            let info = tokio::task::spawn_blocking(move || images::compress_image(&bytes, max_side, quality)).await??;
            sqlx::query("INSERT INTO assets (id, campaign_id, owner_id, name, kind, mime, width, height, encoding, data_b64, builtin, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
                .bind(util::uid()).bind(&a.name).bind(&a.kind).bind(&info.mime).bind(info.width).bind(info.height)
                .bind(&info.encoding).bind(&info.data_b64).bind(util::now())
                .execute(pool).await?;
            added += 1;
        }
        sqlx::query("INSERT INTO builtin_seeds (file) VALUES (?)").bind(&a.file).execute(pool).await?;
    }
    if added > 0 { tracing::info!("Ассеты: добавлено {added} встроенных"); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Название без скобочных обозначений: у черт в имени остаются SRD-обозначения вроде «(d6)».
    fn without_latin_notations(name: &str) -> String {
        let mut out = String::new();
        let mut depth = 0usize;
        for c in name.chars() {
            match c {
                '(' => depth += 1,
                ')' if depth > 0 => depth -= 1,
                _ if depth == 0 => out.push(c),
                _ => {}
            }
        }
        out
    }

    #[test]
    fn seed_files_are_embedded_and_parse() {
        for (file, _) in SEED_FILES {
            let raw = SeedFiles::get(file).unwrap_or_else(|| panic!("{file} не вшит"));
            let rows: Vec<Entry> = serde_json::from_slice(&raw.data).unwrap_or_else(|e| panic!("{file}: {e}"));
            assert!(!rows.is_empty(), "{file}: пустой набор");
            assert!(rows.iter().all(|r| !r.slug.is_empty() && !r.name.is_empty()), "{file}: пустой slug или имя");
        }
        assert!(SeedFiles::get("builtin/manifest.json").is_some(), "манифест встроенных ассетов не вшит");
    }

    #[test]
    fn fingerprint_tracks_every_embedded_file() {
        let stamp = fingerprint();
        assert_eq!(stamp, fingerprint(), "отпечаток должен быть детерминированным");
        assert_eq!(stamp.split(',').count(), SEED_FILES.len(), "в отпечатке нет всех файлов");
        assert!(stamp.chars().all(|c| c.is_ascii_hexdigit() || c == ','), "отпечаток — только hex и запятые");
    }

    #[test]
    fn entries_are_localized_and_well_formed() {
        for (file, _) in SEED_FILES {
            let rows: Vec<Entry> = serde_json::from_slice(&SeedFiles::get(file).expect("вшит").data).unwrap();
            for e in &rows {
                let en_name = e.data["i18n"]["en"]["name"].as_str().unwrap_or("");
                assert!(!en_name.is_empty(), "{}: нет английского названия", e.slug);
                assert!(!en_name.chars().any(|c| ('\u{400}'..='\u{4FF}').contains(&c)), "{}: кириллица в английском названии", e.slug);
                assert!(!without_latin_notations(&e.name).chars().any(|c| c.is_ascii_alphabetic()), "{}: латиница в русском названии «{}»", e.slug, e.name);
                assert!(i18n::validate(&e.data).is_ok(), "{}: некорректный слой перевода", e.slug);
            }
        }
    }
}
