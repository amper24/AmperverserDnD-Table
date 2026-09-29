//! Локализация записей справочника (русский и английский).
//!
//! Запись хранится на «базовом» языке набора (для SRD и наборов по умолчанию — русский). Переводы лежат внутри самой записи:
//!
//! ```json
//! { "name": "Огненный шар", "data": { "desc": "…", "i18n": { "en": { "name": "Fireball", "desc": "…" } } } }
//! ```
//!
//! Слой перевода (`data.i18n.<язык>`) — это «разница» относительно базовых данных, а не полная копия:
//! * ключ без `!` — значение накладывается поверх базового; объекты сливаются рекурсивно;
//! * ключ с суффиксом `!` (`"properties!"`) — значение заменяет базовое целиком;
//! * массивы объектов, у которых у всех элементов есть строковое поле `id` (программы и блоки механики), сливаются по `id`;
//!   остальные массивы заменяются целиком.
//!
//! Тот же алгоритм реализован в `tools/srd/localize.py` (`merge`/`diff`) и `static/common.js` (`I18n.merge`).
//! Подробности — docs/localization.md.
use serde_json::{json, Map, Value};

/// Поддерживаемые языки содержимого.
pub const LANGS: &[&str] = &["ru", "en"];
/// Язык по умолчанию (базовый язык встроенного справочника).
pub const DEFAULT_LANG: &str = "ru";

/// Нормализует код языка (`en-US`, `EN`, `ru_RU` → `en`/`ru`); неизвестные языки → `None`.
pub fn norm_lang(s: &str) -> Option<&'static str> {
    let low = s.trim().to_lowercase();
    let head = low.split(|c| c == '-' || c == '_').next().unwrap_or("");
    LANGS.iter().copied().find(|l| *l == head)
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(|x| x.as_str())
}

fn all_with_id(a: &[Value]) -> bool {
    a.iter().all(|x| x.is_object() && id_of(x).is_some())
}

/// Накладывает слой перевода `ov` на базовые данные `base`.
pub fn merge(base: &Value, ov: &Value) -> Value {
    let (Some(b), Some(o)) = (base.as_object(), ov.as_object()) else { return ov.clone() };
    let mut out: Map<String, Value> = b.clone();
    for (k, v) in o {
        if let Some(key) = k.strip_suffix('!') {
            out.insert(key.to_string(), v.clone());
            continue;
        }
        match (v, out.get(k)) {
            (Value::Object(_), Some(cur @ Value::Object(_))) => {
                let merged = merge(cur, v);
                out.insert(k.clone(), merged);
            }
            (Value::Array(va), Some(Value::Array(ca))) if !va.is_empty() && !ca.is_empty() && all_with_id(va) && all_with_id(ca) => {
                let mut cur = ca.clone();
                for x in va {
                    let xid = id_of(x).unwrap_or_default();
                    match cur.iter().position(|c| id_of(c) == Some(xid)) {
                        Some(pos) => { let merged = merge(&cur[pos], x); cur[pos] = merged; }
                        None => cur.push(x.clone()),
                    }
                }
                out.insert(k.clone(), Value::Array(cur));
            }
            _ => { out.insert(k.clone(), v.clone()); }
        }
    }
    Value::Object(out)
}

/// Языки, на которых доступна запись: базовый + все слои `data.i18n`.
pub fn locales(data: &Value, base: &str) -> Vec<String> {
    let mut out = vec![base.to_string()];
    if let Some(i) = data.get("i18n").and_then(|v| v.as_object()) {
        for (k, v) in i {
            if k != base && v.is_object() && LANGS.contains(&k.as_str()) { out.push(k.clone()); }
        }
    }
    out.sort_by_key(|l| LANGS.iter().position(|x| x == l).unwrap_or(99));
    out
}

/// Вид записи на языке `lang`: слой `i18n` убран из данных, поверх базы наложен перевод (если он есть).
/// Возвращает (данные, фактический язык). В данные добавляется метка `i18n_view` — такие данные нельзя сохранять обратно
/// (сервер отклоняет их в `create`/`update`, см. `check_editable`), для правки нужно запросить запись с `raw=1`.
pub fn view(data: &Value, base: &str, lang: &str) -> (Value, String) {
    let mut d = data.clone();
    let layers = d.as_object_mut().and_then(|o| o.remove("i18n"));
    let mut effective = base.to_string();
    if lang != base {
        if let Some(ov) = layers.as_ref().and_then(|i| i.get(lang)).filter(|o| o.is_object()) {
            d = merge(&d, ov);
            effective = lang.to_string();
        }
    }
    if let Some(o) = d.as_object_mut() { o.insert("i18n_view".into(), json!(effective)); }
    (d, effective)
}

/// Проверка слоёв перевода при сохранении записи: объект `{ "en": {…}, "ru": {…} }`, только известные языки, разумный размер.
pub fn validate(data: &Value) -> Result<(), String> {
    if data.get("i18n_view").is_some() {
        return Err("Запись получена в виде перевода (i18n_view) — для правки загрузите её с параметром raw=1".into());
    }
    let Some(i) = data.get("i18n") else { return Ok(()) };
    let Some(map) = i.as_object() else { return Err("i18n должен быть объектом вида {\"en\": {…}}".into()) };
    for (k, v) in map {
        if !LANGS.contains(&k.as_str()) { return Err(format!("Язык «{}» не поддерживается (доступны: ru, en)", k)); }
        if !v.is_object() { return Err(format!("Перевод «{}» должен быть объектом", k)); }
        if v.to_string().len() > 2_000_000 { return Err("Слишком большой перевод".into()); }
    }
    Ok(())
}

/// Ключ поиска `name_lc`: название и переводы названия (`name_en`, `i18n.*.name`) в нижнем регистре, без повторов.
pub fn search_key(name: &str, data: &Value) -> String {
    let mut parts: Vec<String> = vec![name.trim().to_lowercase()];
    let mut push = |s: &str| {
        let s = s.trim().to_lowercase();
        if !s.is_empty() && !parts.contains(&s) { parts.push(s); }
    };
    if let Some(en) = data.get("name_en").and_then(|v| v.as_str()) { push(en); }
    if let Some(i) = data.get("i18n").and_then(|v| v.as_object()) {
        for l in LANGS {
            if let Some(n) = i.get(*l).and_then(|o| o.get("name")).and_then(|v| v.as_str()) { push(n); }
        }
    }
    parts.join(" ").chars().take(128).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_codes_are_normalized() {
        assert_eq!(norm_lang("en-US"), Some("en"));
        assert_eq!(norm_lang(" RU "), Some("ru"));
        assert_eq!(norm_lang("ru_RU"), Some("ru"));
        assert_eq!(norm_lang("de"), None);
        assert_eq!(norm_lang(""), None);
    }

    #[test]
    fn merge_overlays_scalars_and_nested_objects() {
        let base = json!({ "a": "x", "n": { "p": 1, "q": "z" }, "keep": 5 });
        let ov = json!({ "a": "y", "n": { "q": "w" } });
        assert_eq!(merge(&base, &ov), json!({ "a": "y", "n": { "p": 1, "q": "w" }, "keep": 5 }));
    }

    #[test]
    fn bang_key_replaces_the_whole_value() {
        let base = json!({ "properties": ["Лёгкое", "Метательное (20/60)"], "o": { "a": 1, "b": 2 } });
        let ov = json!({ "properties!": ["Light"], "o!": { "c": 3 } });
        assert_eq!(merge(&base, &ov), json!({ "properties": ["Light"], "o": { "c": 3 } }));
    }

    #[test]
    fn lists_with_ids_merge_by_id_and_plain_lists_are_replaced() {
        let base = json!({ "programs": [{ "id": "p1", "name": "Атака", "trigger": "use" }, { "id": "p2", "name": "Урон" }], "tags": ["а", "б"] });
        let ov = json!({ "programs": [{ "id": "p2", "name": "Damage" }], "tags": ["a"] });
        let m = merge(&base, &ov);
        assert_eq!(m["programs"], json!([{ "id": "p1", "name": "Атака", "trigger": "use" }, { "id": "p2", "name": "Damage" }]));
        assert_eq!(m["tags"], json!(["a"]));
    }

    #[test]
    fn view_applies_layer_hides_i18n_and_marks_the_result() {
        let data = json!({ "desc": "Описание", "i18n": { "en": { "desc": "Description", "name": "Fireball" } } });
        let (v, lang) = view(&data, "ru", "en");
        assert_eq!(lang, "en");
        assert_eq!(v["desc"], "Description");
        assert!(v.get("i18n").is_none());
        assert_eq!(v["i18n_view"], "en");
        let (v, lang) = view(&data, "ru", "ru");
        assert_eq!((lang.as_str(), v["desc"].as_str()), ("ru", Some("Описание")));
        assert!(v.get("i18n").is_none());
    }

    #[test]
    fn view_falls_back_to_base_when_no_translation_exists() {
        let data = json!({ "desc": "Описание" });
        let (v, lang) = view(&data, "ru", "en");
        assert_eq!(lang, "ru");
        assert_eq!(v["desc"], "Описание");
        // базовый язык набора — английский: русского перевода нет, английский слой не нужен
        let (v, lang) = view(&json!({ "desc": "Text" }), "en", "en");
        assert_eq!((lang.as_str(), v["desc"].as_str()), ("en", Some("Text")));
    }

    #[test]
    fn locales_lists_base_first_then_translations() {
        let d = json!({ "i18n": { "en": { "name": "A" }, "de": { "name": "B" } } });
        assert_eq!(locales(&d, "ru"), vec!["ru", "en"]);
        assert_eq!(locales(&json!({}), "en"), vec!["en"]);
    }

    #[test]
    fn validate_rejects_views_unknown_languages_and_bad_shapes() {
        assert!(validate(&json!({ "desc": "x" })).is_ok());
        assert!(validate(&json!({ "i18n": { "en": { "desc": "x" } } })).is_ok());
        assert!(validate(&json!({ "i18n_view": "en" })).is_err());
        assert!(validate(&json!({ "i18n": { "de": {} } })).is_err());
        assert!(validate(&json!({ "i18n": { "en": "text" } })).is_err());
        assert!(validate(&json!({ "i18n": [] })).is_err());
    }

    #[test]
    fn search_key_contains_all_names_without_duplicates() {
        let d = json!({ "name_en": "Fireball", "i18n": { "en": { "name": "Fireball" } } });
        assert_eq!(search_key("Огненный шар", &d), "огненный шар fireball");
        assert_eq!(search_key("Меч", &json!({})), "меч");
        let d2 = json!({ "i18n": { "en": { "name": "Sword" } } });
        assert_eq!(search_key("Меч", &d2), "меч sword");
    }
}
