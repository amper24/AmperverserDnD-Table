//! Inventory invariants and item use. Pure transformations; callers commit with revision CAS.
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use regex::Regex;
use serde_json::{json, Value};
use crate::{AppError, error::ApiResult, util};

// ---- Слоты экипировки ----
// Предмет либо берётся в руки (handedness: one / two / versatile — слоты main, off, both), либо надевается в один из слотов
// одежды (wear: armor, head, neck, cloak, gloves, belt, feet, ring — слоты armor, head, neck, cloak, gloves, belt, feet, ring1, ring2).
// Остальные предметы (снаряжение, расходники, боеприпасы, инструменты…) экипировать нельзя.
pub const WEAR_KINDS: [&str; 8] = ["armor", "head", "neck", "cloak", "gloves", "belt", "feet", "ring"];
/// Версия схемы слотов в предмете (`slots_v`): у предметов без неё хват и место ношения выводятся заново.
const SLOTS_V: i64 = 2;

pub fn worn_slots(kind: &str) -> &'static [&'static str] {
    match kind { "armor" => &["armor"], "head" => &["head"], "neck" => &["neck"], "cloak" => &["cloak"], "gloves" => &["gloves"], "belt" => &["belt"], "feet" => &["feet"], "ring" => &["ring1", "ring2"], _ => &[] }
}

static NOT_EQUIPPABLE: OnceLock<Regex> = OnceLock::new();
static WEAR_RULES: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
static HAND_MAGIC: OnceLock<Regex> = OnceLock::new();
static SHIELD: OnceLock<Regex> = OnceLock::new();

/// Текст для распознавания: название, теги (там категория справочника) и свойства, в нижнем регистре.
fn item_text(it: &Value) -> String {
    format!("{} {} {}", it["name"].as_str().unwrap_or(""), it["tags"], it["properties"]).to_lowercase()
}

/// Что носят, если хват не задан. Только для магических предметов, снаряжения и ценностей: оружие, доспех-«тип armor»,
/// расходники, боеприпасы и инструменты сюда не попадают. Русские и английские названия (справочник двуязычный).
fn infer_wear(it: &Value) -> &'static str {
    let ty = it["type"].as_str().unwrap_or("");
    if ty == "armor" { return "armor"; }
    if !["magic", "gear", "treasure"].contains(&ty) { return ""; }
    let text = item_text(it);
    if NOT_EQUIPPABLE.get_or_init(|| Regex::new(r"зель|свиток|свитки|боеприпас|potion|scroll|ammunition|палочк|\bwands?\b|конск|horse|barding|упряж|седл|saddle|кошел|pouch|посох|\bstaff|жезл|\brods?\b|(?:^|[^а-яё])щит|\bshield\b").unwrap()).is_match(&text)
        && ["брошь", "brooch", "амулет", "amulet", "ожерель", "necklace", "кольц"].iter().all(|w| !text.contains(w)) { return ""; }
    for (kind, re) in WEAR_RULES.get_or_init(|| [
        ("ring", r"кольц|\brings?\b"),
        ("neck", r"амулет|ожерель|медальон|талисман|подвеск|ладанк|брошь|бусы|amulet|necklace|periapt|medallion|pendant|brooch|talisman|scarab|beads"),
        ("head", r"шлем|шляп|колпак|корон|диадем|обруч|(?:^|[^а-яё])маск|(?:^|[^а-яё])очки|(?:^|[^а-яё])глаза|линзы|капюшон|\bhelm|\bhat\b|crown|circlet|headband|goggles|\bmask|lenses|\beyes of|\bhood|\bcap\b"),
        ("cloak", r"плащ|накидк|мантия|одеян|(?:^|[^а-яё])роба(?:$|[^а-яё])|cloak|\bcape\b|mantle|\brobe"),
        ("gloves", r"перчатк|рукавиц|наручи|браслет|gauntlet|glove|bracer|bracelet"),
        ("belt", r"пояс|\bbelt\b"),
        ("feet", r"сапог|ботин|башмак|туфл|sandal|\bboots?\b|slippers?"),
        ("armor", r"доспех|\barmor\b|кольчуг|кирас|(?:^|[^а-яё])латы|breastplate|chain mail|half plate|splint|studded leather|scale mail|ring mail"),
    ].iter().map(|(k, p)| (*k, Regex::new(p).unwrap())).collect()) {
        if re.is_match(&text) { return *kind; }
    }
    ""
}

/// Хват по умолчанию: оружие и щиты — в руку, волшебные палочки, посохи, жезлы и магическое оружие — тоже.
fn infer_hands(it: &Value) -> &'static str {
    let ty = it["type"].as_str().unwrap_or("");
    let text = item_text(it);
    let shield = SHIELD.get_or_init(|| Regex::new(r"(?:^|[^а-яё])щит|\bshield\b").unwrap()).is_match(&text)
        && ["брошь", "brooch", "амулет", "amulet", "кольц"].iter().all(|w| !text.contains(w));
    let consumable = ["зель", "свиток", "боеприпас", "potion", "scroll", "ammunition"].iter().any(|w| text.contains(w));
    let magic_hand = ty == "magic" && !consumable
        && HAND_MAGIC.get_or_init(|| Regex::new(r"оружие|weapon|посох|\bstaff|жезл|\brods?\b|палочк|\bwands?\b").unwrap()).is_match(&text);
    if !(ty == "weapon" || shield || magic_hand) { return "none"; }
    if text.contains("двуруч") || text.contains("two-handed") { "two" }
    else if text.contains("универсаль") || text.contains("versatile") { "versatile" }
    else { "one" }
}

pub fn handedness(it: &Value) -> String {
    if let Some(v) = it["handedness"].as_str().filter(|v| ["none", "one", "two", "versatile"].contains(v)) { return v.into(); }
    infer_hands(it).into()
}

/// Место ношения предмета: пусто — надеть нельзя. Для предметов «в руках» всегда пусто.
pub fn wear_kind(it: &Value) -> String {
    if handedness(it) != "none" { return String::new(); }
    if it["slots_v"].as_i64() == Some(SLOTS_V) {
        if let Some(w) = it["wear"].as_str() { if w.is_empty() || WEAR_KINDS.contains(&w) { return w.to_string(); } }
    }
    infer_wear(it).to_string()
}

pub fn equippable(it: &Value) -> bool { handedness(it) != "none" || !wear_kind(it).is_empty() }

/// Shared server-side gate for both legacy item rolls and declarative item programs.
pub fn validate_use(it: &Value) -> ApiResult<()> {
    if it["qty"].as_i64().unwrap_or(0) < 1 { return Err(AppError::bad("Предмет закончился")); }
    if it["attunement"] == true && it["attuned"] != true { return Err(AppError::bad("Сначала настройтесь на предмет")); }
    if handedness(it) != "none" && it["equipped"] != true { return Err(AppError::bad("Сначала возьмите предмет в руку")); }
    if !wear_kind(it).is_empty() && it["equipped"] != true { return Err(AppError::bad("Сначала наденьте предмет")); }
    Ok(())
}

pub fn slots(slot: &str) -> &[&str] { match slot { "main" => &["main"], "off" => &["off"], "both" => &["main", "off"], _ => &[] } }
pub fn unequip(it: &mut Value) { it["equipped"] = json!(false); it["hand_slot"] = Value::Null; it["worn_slot"] = Value::Null; }
pub fn normalize(sheet: &mut Value) -> ApiResult<()> {
    if !sheet.is_object() { return Err(AppError::bad("Лист должен быть объектом")); }
    if sheet.get("inventory").is_none() { sheet["inventory"] = json!([]); }
    let inv = sheet["inventory"].as_array_mut().ok_or_else(|| AppError::bad("Инвентарь должен быть списком"))?;
    if inv.len() > 2000 { return Err(AppError::bad("Слишком много предметов")); }
    let mut seen = HashSet::new(); let mut occupied = HashSet::new(); let mut worn_taken: HashSet<String> = HashSet::new();
    for it in inv {
        if let Some(m) = it.get("mechanics") { crate::mechanics::validate(m)?; }
        if !it.is_object() { return Err(AppError::bad("Неверный предмет")); }
        if it["uid"].as_str().unwrap_or("").is_empty() { it["uid"] = json!(util::uid()); }
        if !seen.insert(it["uid"].as_str().unwrap().to_string()) { return Err(AppError::bad("Один UID предмета встречается дважды")); }
        let qty = if it.get("qty").is_none() { 1 } else { it["qty"].as_i64().ok_or_else(|| AppError::bad("Количество должно быть целым"))? };
        if !(0..=1_000_000).contains(&qty) { return Err(AppError::bad("Количество вне диапазона 0–1000000")); }
        it["qty"] = json!(qty);
        // предметы старой схемы: «без рук» могло означать просто «не задано» — хват и место ношения выводим заново
        if it["slots_v"].as_i64() != Some(SLOTS_V) && it["handedness"].as_str() == Some("none") { if let Some(o) = it.as_object_mut() { o.remove("handedness"); } }
        let hands = handedness(it); it["handedness"] = json!(hands);
        let wear = wear_kind(it); it["wear"] = json!(wear); it["slots_v"] = json!(SLOTS_V);
        it["favorite"] = json!(it["favorite"] == true);
        if hands == "versatile" {
            if let Some(actions) = it["actions"].as_array_mut() {
                let variant = actions.iter().any(|a| { let n = a["name"].as_str().unwrap_or("").to_lowercase(); n.contains("двумя руками") || n.contains("two-hand") });
                if variant { for a in actions { if a["kind"] == "damage" && a["grip"].as_str().unwrap_or("").is_empty() { let n = a["name"].as_str().unwrap_or("").to_lowercase(); a["grip"] = json!(if n.contains("двумя руками") || n.contains("two-hand") { "two" } else { "one" }); } } }
            }
        }
        if it["charges"].is_object() {
            let max = it["charges"]["max"].as_i64().unwrap_or(-1); let cur = it["charges"]["cur"].as_i64().unwrap_or(-1);
            if !(0..=10000).contains(&max) || cur < 0 || cur > max { return Err(AppError::bad("Неверное число зарядов")); }
        }
        if qty != 1 && it["equipped"] == true { unequip(it); }
        if it["equipped"] != true { it["hand_slot"] = Value::Null; it["worn_slot"] = Value::Null; continue; }
        if hands != "none" {
            it["worn_slot"] = Value::Null;
            let mut slot = it["hand_slot"].as_str().unwrap_or("").to_string();
            if slot.is_empty() { slot = if hands == "two" { "both" } else if !occupied.contains("main") { "main" } else { "off" }.into(); }
            let valid = match hands.as_str() { "two" => slot == "both", "one" => slot == "main" || slot == "off", _ => !slots(&slot).is_empty() };
            if !valid || qty != 1 || slots(&slot).iter().any(|s| occupied.contains(*s)) { unequip(it); }
            else { it["hand_slot"] = json!(slot); occupied.extend(slots(&slot).iter().map(|s| s.to_string())); }
        } else if !wear.is_empty() {
            // одежда: слот из вида предмета; кольца занимают любой из двух слотов, лишние предметы снимаются
            it["hand_slot"] = Value::Null;
            let allowed = worn_slots(&wear);
            let cur = it["worn_slot"].as_str().unwrap_or("").to_string();
            let slot = if allowed.iter().any(|s| *s == cur) && !worn_taken.contains(cur.as_str()) { cur }
                else { allowed.iter().copied().find(|s| !worn_taken.contains(*s)).unwrap_or("").to_string() };
            if qty != 1 || slot.is_empty() { unequip(it); }
            else { it["worn_slot"] = json!(slot); worn_taken.insert(slot); }
        } else {
            // такой предмет экипировать нельзя (расходник, снаряжение, боеприпас…) — остаётся в рюкзаке
            unequip(it);
        }
    }
    let mut attuned = 0;
    for it in sheet["inventory"].as_array_mut().unwrap() {
        if it["attuned"] != true { continue; }
        if it["attunement"] != true || it["qty"].as_i64() != Some(1) || attuned >= 3 { it["attuned"] = json!(false); }
        else { attuned += 1; }
    }
    for path in ["/features", "/spells/known"] {
        if let Some(list)=sheet.pointer_mut(path) {
            let list=list.as_array_mut().ok_or_else(||AppError::bad("Модули должны быть списком"))?;
            if list.len()>2000 {return Err(AppError::bad("Слишком много модулей"));}let mut ids=HashSet::new();
            for doc in list {if !doc.is_object(){return Err(AppError::bad("Неверный модуль"));}if doc["uid"].as_str().unwrap_or("").is_empty(){doc["uid"]=json!(util::uid());}if !ids.insert(doc["uid"].as_str().unwrap().to_string()){return Err(AppError::bad("Повторяющийся UID модуля"));}if let Some(m)=doc.get("mechanics"){crate::mechanics::validate(m)?;}}
        }
    }
    if sheet["auto_armor"] == true { sheet["ac"] = json!(armor_class(sheet)); }
    Ok(())
}
pub fn equip(sheet: &mut Value, uid: &str, slot: &str) -> ApiResult<()> {
    normalize(sheet)?;
    let inv = sheet["inventory"].as_array_mut().unwrap();
    let pos = inv.iter().position(|i| i["uid"] == uid).ok_or_else(|| AppError::not_found("Предмет не найден"))?;
    if slot == "backpack" { unequip(&mut inv[pos]); return normalize(sheet); }
    let hands = handedness(&inv[pos]);
    let wear = wear_kind(&inv[pos]);
    let mut target = String::new();
    if hands != "none" {
        let valid = match hands.as_str() { "one" => slot == "main" || slot == "off", "two" => slot == "both", _ => !slots(slot).is_empty() };
        if !valid { return Err(AppError::bad("Этот хват недоступен для предмета")); }
    } else if !wear.is_empty() {
        let allowed = worn_slots(&wear);
        if slot == "worn" || slot.is_empty() {
            // «просто надеть»: первый свободный слот вида предмета, иначе первый (вытеснит прежний)
            let taken: Vec<String> = inv.iter().enumerate().filter(|(i, it)| *i != pos && it["equipped"] == true).filter_map(|(_, it)| it["worn_slot"].as_str().map(|s| s.to_string())).collect();
            target = allowed.iter().copied().find(|s| !taken.iter().any(|t| t.as_str() == *s)).or_else(|| allowed.first().copied()).unwrap_or("").to_string();
        } else if allowed.iter().any(|s| *s == slot) { target = slot.to_string(); }
        else { return Err(AppError::bad("Предмет не подходит для этого слота")); }
    } else {
        return Err(AppError::bad("Этот предмет нельзя экипировать"));
    }
    if inv[pos]["qty"] != 1 { return Err(AppError::bad("Сначала отделите один предмет от стопки")); }
    for (i, it) in inv.iter_mut().enumerate() {
        if i == pos { continue; }
        let hand_clash = hands != "none" && slots(it["hand_slot"].as_str().unwrap_or("")).iter().any(|s| slots(slot).contains(s));
        let worn_clash = hands == "none" && it["equipped"] == true && it["worn_slot"].as_str() == Some(target.as_str());
        if hand_clash || worn_clash { unequip(it); }
    }
    inv[pos]["equipped"] = json!(true);
    inv[pos]["hand_slot"] = if hands != "none" { json!(slot) } else { Value::Null };
    inv[pos]["worn_slot"] = if hands == "none" { json!(target) } else { Value::Null };
    normalize(sheet)
}
pub fn split(sheet: &mut Value, uid: &str, qty: i64) -> ApiResult<String> {
    normalize(sheet)?;
    let inv = sheet["inventory"].as_array_mut().unwrap();
    let it = inv.iter_mut().find(|i| i["uid"] == uid).ok_or_else(|| AppError::not_found("Предмет не найден"))?;
    let have = it["qty"].as_i64().unwrap();
    if qty <= 0 || qty >= have { return Err(AppError::bad("Отделите целое количество меньше размера стопки")); }
    it["qty"] = json!(have - qty);
    let mut copy = it.clone(); let new_uid = util::uid(); copy["uid"] = json!(new_uid); copy["qty"] = json!(qty); unequip(&mut copy); copy["attuned"] = json!(false); copy["favorite"] = json!(false);
    partition_charges(it, &mut copy, qty, have);
    inv.push(copy); Ok(new_uid)
}
/// Charges are a pool belonging to the stack, not free copies per unit.
/// Splitting/transferring conserves both current and maximum charges.
pub fn partition_charges(remaining: &mut Value, part: &mut Value, qty: i64, total: i64) {
    if remaining["charges"].is_object() {for key in ["cur","max"] {let have=remaining["charges"][key].as_i64().unwrap_or(0);let share=have*qty/total;remaining["charges"][key]=json!(have-share);part["charges"][key]=json!(share);}}
}
/// КД из экипировки: основа — надетый доспех (слот armor) по своей формуле, иначе 10 + Лов; щит в руке добавляет свой бонус;
/// прочие надетые предметы с бонусом «+N» (кольцо или плащ защиты) суммируются. Считается от текущего состояния, а не накапливается.
pub fn armor_class(sheet: &Value) -> i64 { armor_class_parts(sheet).0 }

/// (итоговый КД, части для показа: (название, вклад)).
pub fn armor_class_parts(sheet: &Value) -> (i64, Vec<(String, i64)>) {
    let dex = modifier(sheet, "dex"); let mut base = 10 + dex; let mut base_name = String::from("Без доспеха"); let mut shield = 0; let mut shield_name = String::new(); let mut armored = false;
    let mut bonuses: Vec<(String, i64)> = Vec::new();
    let number = Regex::new(r"[0-9]+").unwrap();
    for it in sheet["inventory"].as_array().into_iter().flatten() {
        if it["equipped"] != true || it["qty"].as_i64().unwrap_or(0) == 0 { continue; }
        // предмет с настройкой без настройки бонусов не даёт
        if it["attunement"] == true && it["attuned"] != true { continue; }
        let text = it["ac"].as_str().map(str::to_lowercase).unwrap_or_else(|| if it["ac"].is_null() { String::new() } else { it["ac"].to_string() });
        let Some(n) = number.find(&text).and_then(|m| m.as_str().parse::<i64>().ok()) else { continue };
        let name = it["name"].as_str().unwrap_or("Предмет").to_string();
        let is_bonus = text.trim_start().starts_with('+');
        if handedness(it) != "none" {
            if it["type"] == "armor" && n > shield { shield = n; shield_name = name; }
        } else if wear_kind(it) == "armor" {
            if !is_bonus && !armored {
                base = n + if text.contains("лов") || text.contains("dex") { if text.contains("макс") || text.contains("max") { dex.min(2) } else { dex } } else { 0 };
                base_name = name; armored = true;
            }
        } else if is_bonus { bonuses.push((name, n)); }
    }
    let mut parts = vec![(base_name, base)];
    if shield > 0 { parts.push((shield_name, shield)); }
    let extra: i64 = bonuses.iter().map(|b| b.1).sum();
    parts.extend(bonuses);
    (base + shield + extra, parts)
}
fn modifier(sheet: &Value, key: &str) -> i64 { (sheet["abilities"][key].as_i64().unwrap_or(10) - 10).div_euclid(2) }
pub fn resolve(expr: &str, sheet: &Value) -> ApiResult<String> {
    let mut ctx = HashMap::new();
    for k in ["str", "dex", "con", "int", "wis", "cha"] { ctx.insert(k.to_string(), modifier(sheet, k)); }
    let prof = sheet["proficiency_bonus"].as_i64().unwrap_or(2); let best = ctx["str"].max(ctx["dex"]);
    for (k, v) in [("prof", prof), ("best", best), ("atk", best + prof), ("atk_str", ctx["str"] + prof), ("atk_dex", ctx["dex"] + prof), ("level", sheet["level"].as_i64().unwrap_or(1)), ("spell", modifier(sheet, sheet["spells"]["ability"].as_str().unwrap_or("int")) + prof)] { ctx.insert(k.into(), v); }
    let spell = modifier(sheet, sheet["spells"]["ability"].as_str().unwrap_or("int"));
    for (k, v) in [("spell_mod", spell), ("dc", 8 + prof + spell), ("spell_dc", 8 + prof + spell), ("half_level", sheet["level"].as_i64().unwrap_or(1) / 2), ("hp", sheet["hp"]["current"].as_i64().unwrap_or(0)), ("hp_max", sheet["hp"]["max"].as_i64().unwrap_or(0)), ("ac", sheet["ac"].as_i64().unwrap_or(10)), ("speed", sheet["speed"].as_i64().unwrap_or(30)), ("init", modifier(sheet, "dex") + sheet["initiative_bonus"].as_i64().unwrap_or(0))] { ctx.insert(k.into(), v); }
    for k in ["str", "dex", "con", "int", "wis", "cha"] { let trained = sheet["saving_throws"].as_array().is_some_and(|v| v.contains(&json!(k))); ctx.insert(format!("save_{k}"), modifier(sheet, k) + if trained { prof } else { 0 }); }
    for (k, ab) in [("acrobatics","dex"),("animal","wis"),("arcana","int"),("athletics","str"),("deception","cha"),("history","int"),("insight","wis"),("intimidation","cha"),("investigation","int"),("medicine","wis"),("nature","int"),("perception","wis"),("performance","cha"),("persuasion","cha"),("religion","int"),("sleight","dex"),("stealth","dex"),("survival","wis")] {
        let trained = sheet["skills"].as_array().is_some_and(|v| v.contains(&json!(k))); let expert = sheet["expertise"].as_array().is_some_and(|v| v.contains(&json!(k)));
        ctx.insert(k.into(), modifier(sheet, ab) + prof * if expert { 2 } else if trained { 1 } else { 0 });
    }
    ctx.insert("passive".into(), 10 + ctx["perception"]);
    let compact = expr.to_lowercase().replace(char::is_whitespace, "");
    let re = regex::Regex::new(r"@([a-z_]+)").unwrap(); let mut unknown = false;
    let s = re.replace_all(&compact, |c: &regex::Captures| { if let Some(v) = ctx.get(&c[1]) { v.to_string() } else { unknown = true; "0".into() } }).to_string();
    if unknown { return Err(AppError::bad("Неизвестная переменная в действии предмета")); }
    Ok(s.replace("+-", "-").replace("--", "+"))
}
/// Mutates only after ALL resource and roll checks pass. Quantity zero is retained for stable links.
pub fn use_item(sheet: &mut Value, uid: &str, indices: &[usize], mode: &str) -> ApiResult<Value> {
    let mut next = sheet.clone(); normalize(&mut next)?;
    let inv = next["inventory"].as_array().unwrap();
    let item = inv.iter().find(|i| i["uid"] == uid).cloned().ok_or_else(|| AppError::not_found("Предмет не найден"))?;
    validate_use(&item)?;
    // Предмет на блоках: старый op:'use' выполняет его действие целиком, а не падает с ошибкой.
    if let Some(m) = item.get("mechanics") {
        let pid = m["programs"].as_array().and_then(|a| a.iter().find(|p| p["trigger"] == "use")).and_then(|p| p["id"].as_str()).unwrap_or("").to_string();
        if pid.is_empty() { return Err(AppError::bad("У предмета нет исполняемого действия")); }
        return crate::mechanics::execute(sheet, "item", uid, &pid, mode, false);
    }
    if indices.len() > 8 || indices.iter().collect::<HashSet<_>>().len() != indices.len() { return Err(AppError::bad("Неверный набор действий")); }
    let actions = item["actions"].as_array().cloned().unwrap_or_default(); let mut selected = Vec::new();
    for &idx in indices {
        let a = actions.get(idx).ok_or_else(|| AppError::bad("Действие не найдено"))?;
        let grip = a["grip"].as_str().unwrap_or(""); let both = item["hand_slot"] == "both";
        if (grip == "two" && !both) || (grip == "one" && both) { return Err(AppError::bad("Действие не соответствует текущему хвату")); }
        selected.push(a.clone());
    }
    let attack_count = selected.iter().filter(|a| a["kind"] == "attack").count() as i64;
    let consume = &item["consume"]; let mut spent = Vec::new();
    if consume["enabled"] == true {
        let times = if consume["trigger"] == "attack" { attack_count } else { 1 };
        let amount = consume["amount"].as_i64().unwrap_or(1);
        if !(1..=10000).contains(&amount) { return Err(AppError::bad("Расход должен быть целым от 1 до 10000")); }
        let mut need = amount * times;
        let resource = consume["resource"].as_str().unwrap_or("quantity");
        if resource != "quantity" && resource != "charges" { return Err(AppError::bad("Неизвестный вид ресурса")); }
        let target = consume["target_uid"].as_str().unwrap_or(""); let tag = consume["ammo_tag"].as_str().unwrap_or("");
        let inv = next["inventory"].as_array_mut().unwrap();
        for res in inv {
            let matches = if target == "self" { res["uid"] == uid } else if !target.is_empty() { res["uid"] == target } else { !tag.is_empty() && res["ammo_tag"] == tag };
            if !matches || need == 0 || res["qty"].as_i64().unwrap_or(0) == 0 { continue; }
            let have = if resource == "charges" { res["charges"]["cur"].as_i64().unwrap_or(0) } else { res["qty"].as_i64().unwrap_or(0) };
            let count = have.min(need); if count <= 0 { continue; }
            if resource == "charges" { res["charges"]["cur"] = json!(have - count); } else { res["qty"] = json!(have - count); if have == count { unequip(res); } }
            spent.push(json!({ "uid": res["uid"], "name": res["name"], "amount": count, "resource": resource, "remaining": have - count })); need -= count;
        }
        if need > 0 { return Err(AppError::bad("Недостаточно ресурса или не выбран источник расхода. Ничего не списано.")); }
    }
    let mut rolls = Vec::new(); let mut crit = false;
    for a in selected {
        let Some(raw) = a["roll"].as_str().filter(|v| !v.is_empty()) else { continue };
        let kind = a["kind"].as_str().unwrap_or("other"); let mut expr = resolve(raw, &next)?;
        if !["damage", "heal"].contains(&kind) { expr = crate::realtime::with_d20_mode(&expr, mode); }
        let base = expr.clone(); let doubled = crit && kind == "damage";
        if doubled { expr = crate::realtime::double_dice(&expr); }
        let mut r = crate::realtime::roll_expression(&expr).ok_or_else(|| AppError::bad("Неверная формула действия. Расход отменён."))?;
        let (nat20, nat1) = crate::realtime::nat_d20(&r);
        if kind == "attack" { crit = nat20; }
        r["name"] = a["name"].clone(); r["kind"] = json!(kind); r["dtype"] = a["dtype"].clone(); r["doubled"] = json!(doubled); r["base_expr"] = json!(base);
        r["crit"] = json!(nat20 && kind == "attack"); r["fumble"] = json!(nat1 && !["damage", "heal"].contains(&kind)); rolls.push(r);
    }
    normalize(&mut next)?;
    *sheet = next;
    Ok(json!({ "label": item["name"], "rolls": rolls, "spent": spent, "item_uid": uid }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value { json!({ "abilities": {"str": 14,"dex":16}, "proficiency_bonus":2, "inventory": [
        {"uid":"sword","name":"Меч","type":"weapon","qty":1,"handedness":"versatile","actions":[{"kind":"damage","roll":"d8+@str","grip":"one"},{"kind":"damage","roll":"d10+@str","grip":"two"}]},
        {"uid":"shield","name":"Щит","type":"armor","qty":1,"handedness":"one","ac":"+2"},
        {"uid":"bow","name":"Лук","type":"weapon","qty":1,"handedness":"two","consume":{"enabled":true,"trigger":"attack","resource":"quantity","ammo_tag":"arrow","amount":1},"actions":[{"kind":"attack","roll":"d20+@atk_dex"},{"kind":"damage","roll":"d6+@dex"}]},
        {"uid":"arrows","name":"Стрелы","type":"ammo","qty":2,"ammo_tag":"arrow"}
    ]}) }
    #[test] fn splitting_conserves_charge_pool() {
        let mut s=json!({"inventory":[{"uid":"w","name":"Wands","type":"magic","qty":3,"charges":{"cur":7,"max":10}}]});
        split(&mut s,"w",1).unwrap();let a=&s["inventory"][0];let b=&s["inventory"][1];
        assert_eq!(a["charges"]["cur"].as_i64().unwrap()+b["charges"]["cur"].as_i64().unwrap(),7);
        assert_eq!(a["charges"]["max"].as_i64().unwrap()+b["charges"]["max"].as_i64().unwrap(),10);
    }
    #[test] fn hands_are_exclusive_without_copying() {
        let mut s=fixture(); equip(&mut s,"sword","main").unwrap(); equip(&mut s,"shield","off").unwrap();
        equip(&mut s,"bow","both").unwrap(); assert_eq!(s["inventory"].as_array().unwrap().len(),4);
        assert_eq!(s["inventory"][0]["equipped"],false); assert_eq!(s["inventory"][1]["equipped"],false);
        assert_eq!(s["inventory"][2]["hand_slot"],"both");
        equip(&mut s,"sword","main").unwrap(); assert_eq!(s["inventory"][2]["hand_slot"],Value::Null);
        assert!(equip(&mut s,"bow","off").is_err());
    }
    #[test] fn one_arrow_per_attack_not_per_damage_roll() {
        let mut s=fixture(); equip(&mut s,"bow","both").unwrap();
        let r=use_item(&mut s,"bow",&[0,1],"adv").unwrap(); assert_eq!(s["inventory"][3]["qty"],1); assert_eq!(r["spent"][0]["amount"],1);
        assert_eq!(r["rolls"][0]["expr"],"2d20kh1+5");
        let mut dis=fixture(); equip(&mut dis,"bow","both").unwrap();
        let r=use_item(&mut dis,"bow",&[0],"dis").unwrap(); assert_eq!(r["rolls"][0]["expr"],"2d20kl1+5");
        use_item(&mut s,"bow",&[1],"").unwrap(); assert_eq!(s["inventory"][3]["qty"],1);
        use_item(&mut s,"bow",&[0],"").unwrap(); let before=s.clone();
        assert!(use_item(&mut s,"bow",&[0],"").is_err()); assert_eq!(s,before);
        s["inventory"][2]["consume"]["enabled"]=json!(false); use_item(&mut s,"bow",&[0],"").unwrap(); assert_eq!(s["inventory"][3]["qty"],0);
    }
    #[test] fn invalid_roll_does_not_spend_and_grip_is_enforced() {
        let mut s=fixture(); equip(&mut s,"bow","both").unwrap(); s["inventory"][2]["actions"][0]["roll"]=json!("bad"); let before=s.clone();
        assert!(use_item(&mut s,"bow",&[0],"").is_err()); assert_eq!(s,before);
        equip(&mut s,"sword","both").unwrap(); assert!(use_item(&mut s,"sword",&[0],"").is_err()); assert!(use_item(&mut s,"sword",&[1],"").is_ok());
    }
    #[test] fn split_preserves_total_and_duplicate_uids_are_rejected() {
        let mut s=fixture(); let uid=split(&mut s,"arrows",1).unwrap(); assert_ne!(uid,"arrows"); assert_eq!(s["inventory"][3]["qty"],1); assert_eq!(s["inventory"][4]["qty"],1);
        assert!(split(&mut s,"arrows",1).is_err());
        s["inventory"][4]["uid"]=json!("arrows"); assert!(normalize(&mut s).is_err());
    }
    #[test] fn shield_ac_is_derived_not_accumulated() {
        let mut s=fixture(); s["auto_armor"]=json!(true);
        equip(&mut s,"shield","off").unwrap(); assert_eq!(s["ac"],15);
        equip(&mut s,"shield","off").unwrap(); assert_eq!(s["ac"],15);
        equip(&mut s,"bow","both").unwrap(); assert_eq!(s["ac"],13);
    }
    fn gear() -> Value { json!({ "abilities": { "str": 14, "dex": 16 }, "proficiency_bonus": 2, "auto_armor": true, "inventory": [
        { "uid": "chain", "name": "Кольчуга", "type": "armor", "qty": 1, "handedness": "none", "ac": "16" },
        { "uid": "leather", "name": "Кожаный доспех", "type": "armor", "qty": 1, "handedness": "none", "ac": "11 + Лов" },
        { "uid": "half", "name": "Полулаты", "type": "armor", "qty": 1, "handedness": "none", "ac": "15 + Лов (макс 2)" },
        { "uid": "shield", "name": "Щит", "type": "armor", "qty": 1, "ac": "+2" },
        { "uid": "ring1", "name": "Кольцо защиты", "type": "magic", "qty": 1, "ac": "+1", "tags": ["Кольца"] },
        { "uid": "ring2", "name": "Ring of Warmth", "type": "magic", "qty": 1, "tags": ["Rings"] },
        { "uid": "ring3", "name": "Кольцо невидимости", "type": "magic", "qty": 1, "tags": ["Кольца"] },
        { "uid": "cloak", "name": "Cloak of Protection", "type": "magic", "qty": 1, "ac": "+1" },
        { "uid": "rope", "name": "Верёвка", "type": "gear", "qty": 1 },
        { "uid": "potion", "name": "Зелье лечения", "type": "magic", "qty": 1, "tags": ["Зелья"] },
        { "uid": "wand", "name": "Волшебная палочка", "type": "magic", "qty": 1, "tags": ["Волшебные палочки"] }
    ] }) }
    #[test] fn only_wearable_or_wieldable_items_can_be_equipped() {
        let mut s = gear();
        assert!(equip(&mut s, "rope", "worn").is_err());
        assert!(equip(&mut s, "potion", "worn").is_err());
        assert!(equip(&mut s, "chain", "worn").is_ok());
        assert!(equip(&mut s, "wand", "main").is_ok());
        assert!(equip(&mut s, "chain", "head").is_err(), "доспех не надевается на голову");
        assert!(equip(&mut s, "shield", "worn").is_err(), "щит берут в руку, а не надевают");
        // предмет, который нельзя экипировать, не становится экипированным и через лист
        let inv = s["inventory"].as_array_mut().unwrap(); inv[8]["equipped"] = json!(true);
        normalize(&mut s).unwrap();
        assert_eq!(s["inventory"][8]["equipped"], false);
    }
    #[test] fn active_magic_items_require_attunement_and_their_equipped_slot() {
        let mut ring = json!({"uid":"ring","name":"Ring of Protection","type":"magic","qty":1,"attunement":true,"attuned":false});
        assert!(validate_use(&ring).unwrap_err().1.contains("настройтесь"));
        ring["attuned"] = json!(true);
        assert!(validate_use(&ring).unwrap_err().1.contains("наденьте"));
        ring["equipped"] = json!(true); ring["worn_slot"] = json!("ring1");
        assert!(validate_use(&ring).is_ok());
        let mut wand = json!({"uid":"wand","name":"Wand of Fire","type":"magic","qty":1});
        assert!(validate_use(&wand).unwrap_err().1.contains("возьмите предмет в руку"));
        wand["equipped"] = json!(true); wand["hand_slot"] = json!("main");
        assert!(validate_use(&wand).is_ok());
    }
    #[test] fn server_normalization_limits_attunement_to_three_valid_items() {
        let mut s = json!({"inventory":[
            {"uid":"a","name":"Ring A","type":"magic","attunement":true,"attuned":true},
            {"uid":"b","name":"Ring B","type":"magic","attunement":true,"attuned":true},
            {"uid":"c","name":"Ring C","type":"magic","attunement":true,"attuned":true},
            {"uid":"d","name":"Ring D","type":"magic","attunement":true,"attuned":true},
            {"uid":"e","name":"Rope","type":"gear","attuned":true},
            {"uid":"f","name":"Ring stack","type":"magic","qty":2,"attunement":true,"attuned":true}
        ]});
        normalize(&mut s).unwrap();
        assert_eq!(s["inventory"].as_array().unwrap().iter().filter(|it| it["attuned"] == true).count(), 3);
        assert_eq!(s["inventory"][3]["attuned"], false);
        assert_eq!(s["inventory"][4]["attuned"], false);
        assert_eq!(s["inventory"][5]["attuned"], false, "стопку нельзя настроить как один предмет");
    }
    #[test] fn wear_is_inferred_for_russian_and_english_names_and_old_items_are_migrated() {
        let mut s = gear(); normalize(&mut s).unwrap();
        let wear = |i: usize| s["inventory"][i]["wear"].as_str().unwrap().to_string();
        assert_eq!((wear(0), wear(3), wear(4), wear(5), wear(7), wear(8), wear(9), wear(10)), ("armor".into(), "".into(), "ring".into(), "ring".into(), "cloak".into(), "".into(), "".into(), "".into()));
        assert_eq!(s["inventory"][3]["handedness"], "one");
        assert_eq!(s["inventory"][10]["handedness"], "one", "палочку держат в руке; у предмета в старом формате «без рук» выводится заново");
        // «защита» — не «щит»
        assert_eq!(s["inventory"][4]["handedness"], "none");
        let mut t = json!({ "inventory": [{ "name": "Cloak of Protection", "type": "magic" }, { "name": "Boots of Elvenkind", "type": "magic" }, { "name": "Amulet of Health", "type": "magic" }, { "name": "Belt of Giant Strength", "type": "magic" }, { "name": "Gauntlets of Ogre Power", "type": "magic" }, { "name": "Шлем ужаса", "type": "magic" }, { "name": "Brooch of Shielding", "type": "magic" }] });
        normalize(&mut t).unwrap();
        let kinds: Vec<String> = t["inventory"].as_array().unwrap().iter().map(|i| i["wear"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["cloak", "feet", "neck", "belt", "gloves", "head", "neck"]);
        assert_eq!(t["inventory"][6]["handedness"], "none");
    }
    #[test] fn one_item_per_slot_and_two_rings() {
        let mut s = gear();
        equip(&mut s, "chain", "worn").unwrap(); equip(&mut s, "leather", "armor").unwrap();
        assert_eq!(s["inventory"][0]["equipped"], false); assert_eq!(s["inventory"][1]["worn_slot"], "armor");
        equip(&mut s, "ring1", "worn").unwrap(); equip(&mut s, "ring2", "worn").unwrap();
        assert_eq!(s["inventory"][4]["worn_slot"], "ring1"); assert_eq!(s["inventory"][5]["worn_slot"], "ring2");
        equip(&mut s, "ring3", "ring1").unwrap();
        assert_eq!(s["inventory"][4]["equipped"], false); assert_eq!(s["inventory"][6]["worn_slot"], "ring1"); assert_eq!(s["inventory"][5]["equipped"], true);
        assert!(equip(&mut s, "ring3", "neck").is_err());
        // повреждённое состояние лечится при нормализации: два предмета в одном слоте — остаётся один
        s["inventory"][0]["equipped"] = json!(true); s["inventory"][0]["worn_slot"] = json!("armor"); normalize(&mut s).unwrap();
        let worn: Vec<&Value> = s["inventory"].as_array().unwrap().iter().filter(|i| i["worn_slot"] == "armor").collect();
        assert_eq!(worn.len(), 1);
    }
    #[test] fn armor_class_follows_slots() {
        let mut s = gear(); normalize(&mut s).unwrap();
        assert_eq!(s["ac"], 13, "без доспеха: 10 + Лов");
        equip(&mut s, "chain", "worn").unwrap(); assert_eq!(s["ac"], 16, "тяжёлый доспех без Лов");
        equip(&mut s, "leather", "worn").unwrap(); assert_eq!(s["ac"], 14, "лёгкий: 11 + Лов");
        equip(&mut s, "half", "worn").unwrap(); assert_eq!(s["ac"], 17, "средний: Лов не больше 2");
        equip(&mut s, "shield", "off").unwrap(); assert_eq!(s["ac"], 19);
        equip(&mut s, "ring1", "worn").unwrap(); assert_eq!(s["ac"], 20, "кольцо защиты +1");
        equip(&mut s, "cloak", "worn").unwrap(); assert_eq!(s["ac"], 21, "плащ защиты +1");
        equip(&mut s, "ring1", "backpack").unwrap(); assert_eq!(s["ac"], 20);
        equip(&mut s, "wand", "off").unwrap(); assert_eq!(s["ac"], 18, "волшебная палочка вытеснила щит");
        let (ac, parts) = armor_class_parts(&s);
        assert_eq!(ac, 18); assert_eq!(parts[0], ("Полулаты".to_string(), 17)); assert_eq!(parts.len(), 2);
    }
    #[test] fn favorites_survive_normalization_and_are_not_copied() {
        let mut s = gear(); s["inventory"][8]["favorite"] = json!(true); s["inventory"][9]["favorite"] = json!("да");
        normalize(&mut s).unwrap();
        assert_eq!(s["inventory"][8]["favorite"], true); assert_eq!(s["inventory"][9]["favorite"], false); assert_eq!(s["inventory"][0]["favorite"], false);
        s["inventory"][8]["qty"] = json!(3); let uid = split(&mut s, "rope", 1).unwrap();
        let copy = s["inventory"].as_array().unwrap().iter().find(|i| i["uid"] == uid.as_str()).unwrap().clone();
        assert_eq!(copy["favorite"], false);
    }
    #[test] fn depleted_self_and_charges_do_not_resurrect() {
        let mut s=json!({"inventory":[{"uid":"p","type":"consumable","qty":1,"consume":{"enabled":true,"target_uid":"self","amount":1,"resource":"quantity","trigger":"use"}}]});
        use_item(&mut s,"p",&[],"").unwrap(); assert_eq!(s["inventory"][0]["qty"],0); assert!(use_item(&mut s,"p",&[],"").is_err());
        s["inventory"][0]["qty"]=json!(1); s["inventory"][0]["charges"]=json!({"cur":2,"max":2}); s["inventory"][0]["consume"]["resource"]=json!("charges");
        use_item(&mut s,"p",&[],"").unwrap(); assert_eq!(s["inventory"][0]["charges"]["cur"],1); assert_eq!(s["inventory"][0]["qty"],1);
    }
}
