//! Стартовые данные: справочник (data_seed/srd_2014.json, srd_2024.json — сборка tools/srd/build_srd.py) и встроенные ассеты (data_seed/builtin/*),
//! всё вшито в бинарник на этапе сборки.
use rust_embed::RustEmbed;
use serde::Deserialize;
use sqlx::{AnyPool, Row};

use crate::{i18n, images, util};

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/data_seed/"]
struct SeedFiles;

#[derive(Deserialize)]
struct Entry { category: String, slug: String, name: String, data: serde_json::Value }

#[derive(Deserialize)]
struct BuiltinAsset { file: String, name: String, kind: String }

/// Файлы справочника и метка источника. Каждый файл заливается независимо: если записей с таким
/// источником ещё нет — добавляем (так новые редакции подтягиваются и в уже существующие БД).
const SEED_FILES: &[(&str, &str, &str)] = &[("srd_2014.json", "SRD 2014", "2014"), ("srd_2024.json", "SRD 2024", "2024")];

/// Хеши записей справочника до локализации: `{"2014": {"категория/slug": [хеш имени+data без mechanics, хеш mechanics]}}`
/// (tools/srd/legacy_hashes.py). По ним при обновлении находим строки БД, которые никто не менял, и переводим их на новую версию.
type LegacyHashes = std::collections::HashMap<String, std::collections::HashMap<String, (String, String)>>;

/// Каноническая форма JSON: ключи по возрастанию, без пробелов, UTF-8 — совпадает с `canon()` в tools/srd/legacy_hashes.py.
pub fn canon(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let items: Vec<String> = keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k.as_str()).unwrap_or_default(), canon(&m[k.as_str()]))).collect();
            format!("{{{}}}", items.join(","))
        }
        serde_json::Value::Array(a) => format!("[{}]", a.iter().map(canon).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/// FNV-1a 64 бита, 16 hex-символов.
pub fn fnv64(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", h)
}

/// (хеш «имя + data без mechanics», хеш mechanics или пустая строка).
fn entry_hashes(name: &str, data: &serde_json::Value) -> (String, String) {
    let mut d = data.clone();
    let mech = d.as_object_mut().and_then(|o| o.remove("mechanics"));
    let mut wrapper = serde_json::Map::new();
    wrapper.insert("name".into(), serde_json::Value::String(name.to_string()));
    wrapper.insert("data".into(), d);
    (fnv64(&canon(&serde_json::Value::Object(wrapper))), mech.map(|m| fnv64(&canon(&m))).unwrap_or_default())
}

/// Что делать с уже существующей строкой справочника при обновлении.
#[derive(Debug, PartialEq)]
enum Upgrade { Keep, AddMechanics, ReplaceLegacy }

/// * строка совпадает с новой версией, но без механики — дописываем механику (как раньше);
/// * строка — нетронутая запись старой (до локализации) сборки: имя и data, а механика либо отсутствует, либо тоже старая — заменяем целиком;
/// * всё остальное (правки пользователя, в том числе механики) не трогаем.
fn classify(current: &serde_json::Value, row_name: &str, new_data: &serde_json::Value, new_name: &str, legacy: Option<&(String, String)>) -> Upgrade {
    let mut baseline = new_data.clone();
    if let Some(o) = baseline.as_object_mut() { o.remove("mechanics"); }
    if new_data.get("mechanics").is_some() && current.get("mechanics").is_none() && *current == baseline && row_name == new_name { return Upgrade::AddMechanics; }
    if let Some((h_data, h_mech)) = legacy {
        let (cd, cm) = entry_hashes(row_name, current);
        if &cd == h_data && (cm.is_empty() || &cm == h_mech) { return Upgrade::ReplaceLegacy; }
    }
    Upgrade::Keep
}

pub async fn seed(pool: &AnyPool) -> anyhow::Result<()> {
    let legacy: LegacyHashes = SeedFiles::get("legacy_hashes.json").and_then(|f| serde_json::from_slice(&f.data).ok()).unwrap_or_default();
    for (file, source, edition) in SEED_FILES {
        let Some(raw) = SeedFiles::get(file) else { tracing::warn!("{} не вшит", file); continue };
        let entries: Vec<Entry> = serde_json::from_slice(&raw.data)?;
        let count = entries.len();
        let mut tx = pool.begin().await?;
        let rows=sqlx::query("SELECT id, name, category, slug, data FROM compendium WHERE campaign_id IS NULL AND pack_id IS NULL AND source = ?").bind(source).fetch_all(&mut *tx).await?;
        let mut stored: std::collections::HashMap<(String,String),Vec<sqlx::any::AnyRow>>=std::collections::HashMap::new();
        for row in rows {stored.entry((row.get("category"),row.get("slug"))).or_default().push(row);}
        for e in entries {
            if let Some(m)=e.data.get("mechanics") {crate::mechanics::validate(m).map_err(|err|anyhow::anyhow!("Некорректная механика {}: {:?}",e.slug,err))?;}
            let existing=stored.remove(&(e.category.clone(),e.slug.clone())).unwrap_or_default();
            if !existing.is_empty() {
                let legacy_hash = legacy.get(*edition).and_then(|m| m.get(&format!("{}/{}", e.category, e.slug)));
                for row in existing {
                    let raw=util::text(&row,"data");let current=util::json_value(&raw);
                    let row_name=row.get::<String,_>("name");
                    // Only upgrade byte-semantically matching shipped definitions. Customized rows
                    // and previously edited blocks are never replaced by a later seed boot.
                    match classify(&current,&row_name,&e.data,&e.name,legacy_hash) {
                        Upgrade::AddMechanics => {
                            let mut next=current;
                            next["mechanics"]=e.data["mechanics"].clone();
                            sqlx::query("UPDATE compendium SET data = ? WHERE id = ? AND data = ?")
                                .bind(next.to_string()).bind(row.get::<String,_>("id")).bind(raw).execute(&mut *tx).await?;
                        }
                        Upgrade::ReplaceLegacy => {
                            // запись старой сборки без правок пользователя: русский текст, слой en, название и ключ поиска
                            sqlx::query("UPDATE compendium SET name = ?, name_lc = ?, data = ? WHERE id = ? AND data = ?")
                                .bind(util::truncate(&e.name,128)).bind(i18n::search_key(&e.name,&e.data)).bind(e.data.to_string()).bind(row.get::<String,_>("id")).bind(raw).execute(&mut *tx).await?;
                        }
                        Upgrade::Keep => {}
                    }
                }
                continue;
            }
            let name_lc = i18n::search_key(&e.name, &e.data);
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
            // Размеры встроенных картинок по классу лимита (таблица KIND_SIZE_CLASS в config.rs).
            let max_side = match crate::config::size_class(&a.kind) { crate::config::SizeClass::Map => 2048, crate::config::SizeClass::Token => 512 };
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canon_and_fnv_match_the_python_tool() {
        // значения посчитаны tools/srd/legacy_hashes.py (canon + fnv64)
        let v = json!({ "name": "Меч", "data": { "b": [1, 2.5, true, null, "x\"y\n\t/é"], "a": { "z": 1, "A": -3 } } });
        assert_eq!(canon(&v), "{\"data\":{\"a\":{\"A\":-3,\"z\":1},\"b\":[1,2.5,true,null,\"x\\\"y\\n\\t/é\"]},\"name\":\"Меч\"}");
        assert_eq!(fnv64(&canon(&v)), "cba72a44704b7409");
    }

    fn legacy_dart() -> serde_json::Value {
        json!({ "cost": "5 мм", "weight": 0.25, "desc": "", "type": "weapon", "category": "Простое дальнобойное", "damage": "1к4", "damage_type": "колющий",
            "properties": ["Фехтовальное", "Метательное (20/60)"], "edition": "2014", "name_en": "Dart",
            "mechanics": { "version": 1, "origin": "srd-blocks-v1", "programs": [{ "name": "Атака и урон", "trigger": "use", "blocks": [
                { "kind": "attack", "enabled": true, "when": "always", "dice": { "count": 1, "sides": 20, "bonus": 0, "stat": "atk_dex" }, "target": "target", "apply": false, "id": "b1" },
                { "kind": "damage", "enabled": true, "when": "always", "dice": { "count": 1, "sides": 4, "bonus": 0, "stat": "dex" }, "damage_type": "колющий", "target": "target", "apply": false, "grip": "", "id": "b2" }], "id": "p1" }] } })
    }

    #[test]
    fn legacy_hashes_of_a_real_entry_match_the_python_tool() {
        // запись «Дротик» из сборки до локализации; ожидаемые хеши — из data_seed/legacy_hashes.json
        let (h_data, h_mech) = entry_hashes("Дротик", &legacy_dart());
        assert_eq!((h_data.as_str(), h_mech.as_str()), ("4ad82e06d237eff0", "b2e4398f01c7124c"));
    }

    #[test]
    fn untouched_legacy_rows_are_replaced_and_edited_rows_are_kept() {
        let legacy = ("4ad82e06d237eff0".to_string(), "b2e4398f01c7124c".to_string());
        let mut new_data = legacy_dart();
        new_data["category"] = json!("Простое дальнобойное");
        new_data["i18n"] = json!({ "en": { "name": "Dart" } });
        // нетронутая старая запись (с механикой и без)
        assert_eq!(classify(&legacy_dart(), "Дротик", &new_data, "Дротик", Some(&legacy)), Upgrade::ReplaceLegacy);
        let mut no_mech = legacy_dart(); no_mech.as_object_mut().unwrap().remove("mechanics");
        assert_eq!(classify(&no_mech, "Дротик", &new_data, "Дротик", Some(&legacy)), Upgrade::ReplaceLegacy);
        // пользователь поменял текст, название или механику — не трогаем
        let mut edited = legacy_dart(); edited["desc"] = json!("моя правка");
        assert_eq!(classify(&edited, "Дротик", &new_data, "Дротик", Some(&legacy)), Upgrade::Keep);
        assert_eq!(classify(&legacy_dart(), "Мой дротик", &new_data, "Дротик", Some(&legacy)), Upgrade::Keep);
        let mut mech_edit = legacy_dart(); mech_edit["mechanics"]["programs"][0]["name"] = json!("Бросок");
        assert_eq!(classify(&mech_edit, "Дротик", &new_data, "Дротик", Some(&legacy)), Upgrade::Keep);
        // без записи в таблице хешей ничего не заменяем
        assert_eq!(classify(&legacy_dart(), "Дротик", &new_data, "Дротик", None), Upgrade::Keep);
    }

    #[test]
    fn passive_seed_rows_do_not_get_null_mechanics_added() {
        let passive = json!({ "desc": "Пассивный предмет без отдельной активации" });
        assert_eq!(classify(&passive, "Рюкзак", &passive, "Рюкзак", None), Upgrade::Keep);
    }

    #[test]
    fn current_rows_without_mechanics_get_them_added() {
        let new_data = json!({ "desc": "Текст", "i18n": { "en": { "name": "X" } }, "mechanics": { "version": 1, "programs": [] } });
        let cur = json!({ "desc": "Текст", "i18n": { "en": { "name": "X" } } });
        assert_eq!(classify(&cur, "Х", &new_data, "Х", None), Upgrade::AddMechanics);
        let cur_with = json!({ "desc": "Текст", "i18n": { "en": { "name": "X" } }, "mechanics": { "version": 1, "programs": [] } });
        assert_eq!(classify(&cur_with, "Х", &new_data, "Х", None), Upgrade::Keep);
    }

    #[test]
    fn embedded_reference_is_fully_localized_and_covered_by_legacy_hashes() {
        let legacy: LegacyHashes = serde_json::from_slice(&SeedFiles::get("legacy_hashes.json").expect("legacy_hashes.json вшит").data).unwrap();
        for (file, _source, edition) in SEED_FILES {
            let entries: Vec<Entry> = serde_json::from_slice(&SeedFiles::get(file).expect("файл справочника вшит").data).unwrap();
            assert!(!entries.is_empty());
            for e in &entries {
                let en = &e.data["i18n"]["en"];
                let en_name = en["name"].as_str().unwrap_or("");
                assert!(!en_name.is_empty(), "{}: нет английского названия", e.slug);
                assert!(!en_name.chars().any(|c| ('\u{400}'..='\u{4FF}').contains(&c)), "{}: кириллица в английском названии", e.slug);
                assert!(!e.name.chars().any(|c| c.is_ascii_alphabetic()), "{}: латиница в русском названии «{}»", e.slug, e.name);
                assert!(i18n::validate(&e.data).is_ok(), "{}: некорректный i18n", e.slug);
                assert!(legacy[*edition].contains_key(&format!("{}/{}", e.category, e.slug)), "{}: нет хеша старой версии", e.slug);
            }
        }
    }
}
