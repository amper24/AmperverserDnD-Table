//! Inventory invariants and item use. Pure transformations; callers commit with revision CAS.
use std::collections::{HashMap, HashSet};
use serde_json::{json, Value};
use crate::{AppError, error::ApiResult, util};

pub fn handedness(it: &Value) -> String {
    if let Some(v) = it["handedness"].as_str().filter(|v| ["none", "one", "two", "versatile"].contains(v)) { return v.into(); }
    let text = format!("{} {} {}", it["name"].as_str().unwrap_or(""), it["desc"].as_str().unwrap_or(""), it["properties"]).to_lowercase();
    if text.contains("двуруч") || text.contains("two-handed") { "two" }
    else if text.contains("универсаль") || text.contains("versatile") { "versatile" }
    else if it["type"] == "weapon" || text.contains("щит") || text.contains("shield") { "one" }
    else { "none" }.into()
}
pub fn slots(slot: &str) -> &[&str] { match slot { "main" => &["main"], "off" => &["off"], "both" => &["main", "off"], _ => &[] } }
pub fn unequip(it: &mut Value) { it["equipped"] = json!(false); it["hand_slot"] = Value::Null; }
pub fn normalize(sheet: &mut Value) -> ApiResult<()> {
    if !sheet.is_object() { return Err(AppError::bad("Лист должен быть объектом")); }
    if sheet.get("inventory").is_none() { sheet["inventory"] = json!([]); }
    let inv = sheet["inventory"].as_array_mut().ok_or_else(|| AppError::bad("Инвентарь должен быть списком"))?;
    if inv.len() > 2000 { return Err(AppError::bad("Слишком много предметов")); }
    let mut seen = HashSet::new(); let mut occupied = HashSet::new();
    for it in inv {
        if let Some(m) = it.get("mechanics") { crate::mechanics::validate(m)?; }
        if !it.is_object() { return Err(AppError::bad("Неверный предмет")); }
        if it["uid"].as_str().unwrap_or("").is_empty() { it["uid"] = json!(util::uid()); }
        if !seen.insert(it["uid"].as_str().unwrap().to_string()) { return Err(AppError::bad("Один UID предмета встречается дважды")); }
        let qty = if it.get("qty").is_none() { 1 } else { it["qty"].as_i64().ok_or_else(|| AppError::bad("Количество должно быть целым"))? };
        if !(0..=1_000_000).contains(&qty) { return Err(AppError::bad("Количество вне диапазона 0–1000000")); }
        it["qty"] = json!(qty);
        let hands = handedness(it); it["handedness"] = json!(hands);
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
        if hands == "none" || it["equipped"] != true { it["hand_slot"] = Value::Null; continue; }
        let mut slot = it["hand_slot"].as_str().unwrap_or("").to_string();
        if slot.is_empty() { slot = if hands == "two" { "both" } else if !occupied.contains("main") { "main" } else { "off" }.into(); }
        let valid = match hands.as_str() { "two" => slot == "both", "one" => slot == "main" || slot == "off", _ => !slots(&slot).is_empty() };
        if !valid || qty != 1 || slots(&slot).iter().any(|s| occupied.contains(*s)) { unequip(it); }
        else { it["hand_slot"] = json!(slot); occupied.extend(slots(&slot).iter().map(|s| s.to_string())); }
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
    let valid = match hands.as_str() { "none" => slot == "worn", "one" => slot == "main" || slot == "off", "two" => slot == "both", _ => !slots(slot).is_empty() };
    if !valid { return Err(AppError::bad("Этот хват недоступен для предмета")); }
    if inv[pos]["qty"] != 1 { return Err(AppError::bad("Сначала отделите один предмет от стопки")); }
    let wearing_armor = inv[pos]["type"] == "armor";
    for (i, it) in inv.iter_mut().enumerate() {
        if i != pos && (slots(it["hand_slot"].as_str().unwrap_or("")).iter().any(|s| slots(slot).contains(s)) || (wearing_armor && slot == "worn" && hands == "none" && it["type"] == "armor" && handedness(it) == "none")) { unequip(it); }
    }
    inv[pos]["equipped"] = json!(true);
    inv[pos]["hand_slot"] = if slot == "worn" { Value::Null } else { json!(slot) };
    normalize(sheet)
}
pub fn split(sheet: &mut Value, uid: &str, qty: i64) -> ApiResult<String> {
    normalize(sheet)?;
    let inv = sheet["inventory"].as_array_mut().unwrap();
    let it = inv.iter_mut().find(|i| i["uid"] == uid).ok_or_else(|| AppError::not_found("Предмет не найден"))?;
    let have = it["qty"].as_i64().unwrap();
    if qty <= 0 || qty >= have { return Err(AppError::bad("Отделите целое количество меньше размера стопки")); }
    it["qty"] = json!(have - qty);
    let mut copy = it.clone(); let new_uid = util::uid(); copy["uid"] = json!(new_uid); copy["qty"] = json!(qty); unequip(&mut copy); copy["attuned"] = json!(false);
    partition_charges(it, &mut copy, qty, have);
    inv.push(copy); Ok(new_uid)
}
/// Charges are a pool belonging to the stack, not free copies per unit.
/// Splitting/transferring conserves both current and maximum charges.
pub fn partition_charges(remaining: &mut Value, part: &mut Value, qty: i64, total: i64) {
    if remaining["charges"].is_object() {for key in ["cur","max"] {let have=remaining["charges"][key].as_i64().unwrap_or(0);let share=have*qty/total;remaining["charges"][key]=json!(have-share);part["charges"][key]=json!(share);}}
}
pub fn armor_class(sheet: &Value) -> i64 {
    let dex = modifier(sheet, "dex"); let mut base = 10 + dex; let mut shield = 0; let mut armored = false;
    let number = regex::Regex::new(r"[0-9]+").unwrap();
    for it in sheet["inventory"].as_array().into_iter().flatten() {
        if it["type"] != "armor" || it["equipped"] != true || it["qty"].as_i64().unwrap_or(0) == 0 { continue; }
        let text = it["ac"].as_str().map(str::to_lowercase).unwrap_or_else(|| it["ac"].to_string());
        let Some(n) = number.find(&text).and_then(|m| m.as_str().parse::<i64>().ok()) else { continue };
        if handedness(it) != "none" { shield = shield.max(n); }
        else if !armored { base = n + if text.contains("лов") || text.contains("dex") { if text.contains("макс") || text.contains("max") { dex.min(2) } else { dex } } else { 0 }; armored = true; }
    }
    base + shield
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
    if item.get("mechanics").is_some() { return Err(AppError::bad("Предмет переведён на блоки. Обновите лист и используйте новое действие.")); }
    if item["qty"].as_i64().unwrap_or(0) < 1 { return Err(AppError::bad("Предмет закончился")); }
    if handedness(&item) != "none" && item["equipped"] != true { return Err(AppError::bad("Сначала возьмите предмет в руку")); }
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
        if !["damage", "heal"].contains(&kind) && ["adv", "dis"].contains(&mode) {
            let re = regex::Regex::new(r"(^|[+\-])(1?)[dк]20($|[+\-])").unwrap();
            expr = re.replace(&expr, |c: &regex::Captures| format!("{}2d20k{}1{}", &c[1], if mode == "adv" { "h" } else { "l" }, &c[3])).to_string();
        }
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
        assert!(r["rolls"][0]["expr"].as_str().unwrap().starts_with("2d20kh1"));
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
    #[test] fn depleted_self_and_charges_do_not_resurrect() {
        let mut s=json!({"inventory":[{"uid":"p","type":"consumable","qty":1,"consume":{"enabled":true,"target_uid":"self","amount":1,"resource":"quantity","trigger":"use"}}]});
        use_item(&mut s,"p",&[],"").unwrap(); assert_eq!(s["inventory"][0]["qty"],0); assert!(use_item(&mut s,"p",&[],"").is_err());
        s["inventory"][0]["qty"]=json!(1); s["inventory"][0]["charges"]=json!({"cur":2,"max":2}); s["inventory"][0]["consume"]["resource"]=json!("charges");
        use_item(&mut s,"p",&[],"").unwrap(); assert_eq!(s["inventory"][0]["charges"]["cur"],1); assert_eq!(s["inventory"][0]["qty"],1);
    }
}
