//! Bounded declarative programs. Only stored definitions execute; caller owns the CAS transaction.
use serde_json::{json, Value};
use std::collections::HashSet;
use crate::{AppError, error::ApiResult, inventory, util};
// `save` остаётся в схеме только для старых записей: при выполнении он превращается в своё действие.
const KINDS: &[&str] = &["consume","attack","damage","heal","temp_hp","roll","save","grant_item","condition","adjust","require","manual","passive"];
fn bad(s: &str) -> AppError { AppError::bad(s) }
fn text<'a>(v: &'a Value, k: &str) -> &'a str { v[k].as_str().unwrap_or("") }
fn num(v: &Value, k: &str) -> i64 { v[k].as_i64().unwrap_or(0) }
fn bounded(v: &Value, k: &str, low: i64, high: i64) -> ApiResult<i64> { v[k].as_i64().filter(|n| (low..=high).contains(n)).ok_or_else(|| bad("Некорректное число в блоке")) }
fn field_ok(s: &str) -> bool { ["speed","initiative_bonus","currency.gp","currency.sp","hp.max","abilities.str","abilities.dex","abilities.con","abilities.int","abilities.wis","abilities.cha"].contains(&s) }
fn pointer(s: &str) -> String { format!("/{}", s.replace('.', "/")) }
pub fn validate(m: &Value) -> ApiResult<()> { validate_depth(m, 0) }
/// Выбор «либо / либо» при создании персонажа: `data.choices` расы, класса или предыстории.
/// Ограниченная схема: группа (тип, сколько выбрать) и до 18 вариантов со значением по типу.
const CHOICE_TYPES: &[&str] = &["ability","skill","language","feature","proficiency"];
const ABILITIES: &[&str] = &["str","dex","con","int","wis","cha"];
pub fn validate_choices(v: &Value) -> ApiResult<()> {
    let groups = v.as_array().filter(|a| a.len() <= 12).ok_or_else(|| bad("Некорректные варианты выбора"))?;
    let mut gids = HashSet::new();
    for g in groups {
        let gid = text(g, "id");
        if gid.is_empty() || gid.len() > 64 || !gids.insert(gid) { return Err(bad("У каждой группы выбора должен быть свой код")); }
        if text(g, "name").trim().is_empty() || text(g, "name").chars().count() > 120 { return Err(bad("Название группы выбора: до 120 символов")); }
        let kind = text(g, "type");
        if !CHOICE_TYPES.contains(&kind) { return Err(bad("Неизвестный тип варианта выбора")); }
        let opts = g["options"].as_array().filter(|a| !a.is_empty() && a.len() <= 18).ok_or_else(|| bad("В группе выбора от 1 до 18 вариантов"))?;
        let count = g["count"].as_i64().unwrap_or(1);
        if !(0..=(opts.len() as i64)).contains(&count) { return Err(bad("Сколько вариантов выбрать: от 0 до числа вариантов")); }
        let mut oids = HashSet::new();
        for o in opts {
            let oid = text(o, "id");
            if oid.is_empty() || oid.len() > 64 || !oids.insert(oid) { return Err(bad("У каждого варианта должен быть свой код")); }
            if text(o, "name").trim().is_empty() || text(o, "name").chars().count() > 120 { return Err(bad("Название варианта: до 120 символов")); }
            match kind {
                "ability" => {
                    let bonus = o["value"].as_object().filter(|m| !m.is_empty() && m.len() <= 6).ok_or_else(|| bad("Бонус характеристики задаётся объектом"))?;
                    for (k, n) in bonus { if !ABILITIES.contains(&k.as_str()) || n.as_i64().filter(|n| (-5..=5).contains(n)).is_none() { return Err(bad("Бонус характеристики: целое от -5 до +5")); } }
                }
                "skill" => {
                    let skills = o["value"].as_array().filter(|a| !a.is_empty() && a.len() <= 18).ok_or_else(|| bad("Навыки варианта задаются списком"))?;
                    if !skills.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= 40)) { return Err(bad("Некорректный навык в варианте выбора")); }
                }
                "language" => {
                    let langs = o["value"].as_array().filter(|a| !a.is_empty() && a.len() <= 18).ok_or_else(|| bad("Языки варианта задаются списком"))?;
                    if !langs.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= 80)) { return Err(bad("Некорректный язык в варианте выбора")); }
                }
                "feature" => {
                    let t = text(&o["value"], "text");
                    if t.trim().is_empty() || t.chars().count() > 4000 { return Err(bad("Описание умения варианта: до 4000 символов")); }
                    if !o["value"]["mechanics"].is_null() { validate_depth(&o["value"]["mechanics"], 0)?; }
                }
                _ => {
                    let s = o["value"].as_str().unwrap_or("");
                    if s.trim().is_empty() || s.chars().count() > 200 { return Err(bad("Описание владения: до 200 символов")); }
                }
            }
        }
    }
    Ok(())
}
fn validate_depth(m: &Value, depth: usize) -> ApiResult<()> {
    if depth>4 || m.to_string().len()>1_000_000 || m["version"]!=1 { return Err(bad("Неподдерживаемая или слишком большая схема механик")); }
    let ps=m["programs"].as_array().filter(|a|a.len()<=256).ok_or_else(||bad("Некорректные действия"))?;
    let mut ids=HashSet::new();
    for p in ps {
        if text(p,"id").is_empty()||text(p,"id").len()>100||!ids.insert(text(p,"id"))||text(p,"name").trim().is_empty()||!["use","passive"].contains(&text(p,"trigger")) { return Err(bad("Некорректное имя, ID или триггер действия")); }
        let bs=p["blocks"].as_array().filter(|a|a.len()<=32).ok_or_else(||bad("В действии не более 32 блоков"))?;
        for (i,b) in bs.iter().enumerate() {if b["kind"]=="consume"&&b["enabled"]!=false&&b["trigger"]=="attack"&&!bs[i+1..].iter().any(|x|x["kind"]=="attack"&&x["enabled"]!=false){return Err(bad("Поставьте расход за атаку перед блоком атаки"));}}
        let mut bids=HashSet::new(); let mut gate=false;
        for b in bs {
            let kind=text(b,"kind");
            if !KINDS.contains(&kind)||text(b,"id").is_empty()||!bids.insert(text(b,"id")) { return Err(bad("Неизвестный блок или повторяющийся ID")); }
            if b["enabled"]==false { continue; }
            if !["","always","hit","miss"].contains(&text(b,"when")) || (["hit","miss"].contains(&text(b,"when"))&&!gate) { return Err(bad("Условному блоку нужна предшествующая атака или спасбросок")); }
            if ["attack","save"].contains(&kind) { gate=true; }
            if !["","self","target"].contains(&text(b,"target")) { return Err(bad("Неизвестная цель")); }
            // Старый блок спасброска при выполнении становится броском d20, поэтому кубы в нём необязательны.
            if ["attack","damage","heal","temp_hp","roll"].contains(&kind) || (kind == "save" && !b["dice"].is_null()) { formula(b)?; }
            match kind {
                "consume" => { bounded(b,"amount",1,10000)?; if !["quantity","charges","slot","uses"].contains(&text(b,"resource"))||!["self","item","tag"].contains(&text(b,"source"))||!["use","attack"].contains(&text(b,"trigger")) { return Err(bad("Неизвестный способ расхода")); } if b["source"]=="item"&&text(b,"item_uid").is_empty()||b["source"]=="tag"&&text(b,"tag").is_empty() { return Err(bad("Не задан источник расхода")); } if b["resource"]=="slot" { bounded(b,"slot_level",1,9)?; } }
                "grant_item" => { bounded(b,"amount",1,10000)?; if !b["item"].is_object()||text(&b["item"],"name").trim().is_empty() { return Err(bad("Нет шаблона выдаваемого предмета")); } if !b["item"]["mechanics"].is_null() { validate_depth(&b["item"]["mechanics"],depth+1)?; } }
                "adjust" => { if !field_ok(text(b,"field")) { return Err(bad("Недоступный показатель")); } bounded(b,"amount",-10000,10000)?; }
                "require" => { if !field_ok(text(b,"field"))&&b["field"]!="hp.current" { return Err(bad("Недоступное условие")); } bounded(b,"minimum",-1000000,1000000)?; }
                "attack" => { if let Some(dc)=b["dc"].as_i64() { if !(0..=40).contains(&dc) { return Err(bad("КД цели: целое от 1 до 40")); } } }
                "condition" => { if text(b,"condition").trim().is_empty()||text(b,"condition").len()>200||!["add","remove"].contains(&text(b,"operation")) { return Err(bad("Неверное состояние")); } }
                "save" => { bounded(b,"dc",1,40)?; if !["str","dex","con","int","wis","cha"].contains(&text(b,"ability")) { return Err(bad("Неверный спасбросок")); } }
                "passive" => { if text(p,"trigger")!="passive"||!["speed","hit_die","spellcasting","saves","skills","languages","armor","weapons","asi.str","asi.dex","asi.con","asi.int","asi.wis","asi.cha"].contains(&text(b,"field")) { return Err(bad("Параметр доступен только в пассивной программе")); } }
                _ => {}
            }
            if text(p,"trigger")=="passive"&&!["passive","manual"].contains(&kind) { return Err(bad("Пассивная программа не может расходовать или выдавать ресурсы")); }
        }
    }
    Ok(())
}
/// Приводит старую схему к текущей: спасбросок цели становится своим действием (бросок + правило,
/// которое сравнивает ДМ), чужих целей нет — эффекты идут владельцу листа, а ветвление, державшееся
/// на спасброске, становится безусловным. Зеркалит `normalize()` из `static/mechanics.js`.
fn normalize(m: &Value) -> Value {
    let mut out = m.clone();
    let Some(programs) = out["programs"].as_array_mut() else { return out };
    for p in programs {
        let Some(blocks) = p["blocks"].as_array_mut() else { continue };
        let mut gate = false;
        for b in blocks {
            if b["kind"] == "save" {
                let ability = text(b, "ability").to_string(); let dc = num(b, "dc");
                let name = if text(b, "name").is_empty() { "Спасбросок".to_string() } else { text(b, "name").to_string() };
                if let Some(o) = b.as_object_mut() {
                    o.insert("kind".into(), json!("roll"));
                    o.insert("name".into(), json!(name));
                    o.insert("when".into(), json!("always"));
                    o.insert("dice".into(), json!({ "count": 1, "sides": 20, "bonus": 0, "stat": "" }));
                    o.insert("text".into(), json!(format!("Спасбросок{}{}. Результат сравнивает ДМ.",
                        if ability.is_empty() { String::new() } else { format!(" {ability}") },
                        if dc > 0 { format!(" · СЛ {dc}") } else { String::new() })));
                    o.remove("target"); o.remove("apply");
                }
            }
            let kind = b["kind"].as_str().unwrap_or("").to_string();
            if let Some(o) = b.as_object_mut() {
                if ["attack", "damage", "roll", "save"].contains(&kind.as_str()) { o.remove("target"); o.remove("apply"); }
                if ["heal", "temp_hp", "condition", "adjust", "grant_item"].contains(&kind.as_str()) { o.insert("target".into(), json!("self")); }
                let when = o.get("when").and_then(Value::as_str).unwrap_or("").to_string();
                if ["hit", "miss"].contains(&when.as_str()) && !gate { o.insert("when".into(), json!("always")); }
            }
            if kind == "attack" { gate = true; }
        }
    }
    out
}
fn formula(b: &Value) -> ApiResult<String> {
    let d=&b["dice"];
    if let Some(s)=d["advanced"].as_str().filter(|s|!s.is_empty()) { if s.len()>128 { return Err(bad("Формула слишком длинная")); } return Ok(s.into()); }
    let count=bounded(d,"count",0,100)?; let sides=bounded(d,"sides",1,1000)?; let bonus=bounded(d,"bonus",-1_000_000,1_000_000)?;
    let stat=text(d,"stat"); if !["","str","dex","con","int","wis","cha","best","prof","atk","atk_str","atk_dex","spell","spell_mod","level","dc"].contains(&stat) { return Err(bad("Неизвестный модификатор")); }
    Ok(format!("{}{}{:+}{}",if count>0{count.to_string()}else{"0".into()},if count>0{format!("d{sides}")}else{String::new()},bonus,if stat.is_empty(){String::new()}else{format!("+@{stat}")}))
}
fn spend(s: &mut Value, doc: &Value, category: &str, b: &Value, times: i64, spent: &mut Vec<Value>) -> ApiResult<()> {
    let mut need=num(b,"amount")*times; if need==0 { return Ok(()); } let resource=text(b,"resource");
    if resource=="slot"||resource=="uses" {
        if resource=="slot" {
            let key=num(b,"slot_level").to_string();let slot=&mut s["spells"]["slots"][&key];
            let max=bounded(slot,"max",0,10000)?;let used=bounded(slot,"used",0,10000)?;if used<0||max-used<need {return Err(bad("Недостаточно ячеек. Цепочка отменена"));}slot["used"]=json!(used+need);spent.push(json!({"name":format!("Ячейки {} круга",key),"amount":need,"remaining":max-used-need,"resource":resource}));return Ok(());
        }
        if category!="feature" { return Err(bad("Использования доступны только умению")); }
        let idx=s["features"].as_array().and_then(|a|a.iter().position(|v|v["uid"]==doc["uid"])).ok_or_else(||bad("Умение не найдено"))?; let path=format!("/features/{idx}/uses/cur");
        let v=s.pointer_mut(&path).ok_or_else(||bad("Ресурс не настроен"))?; let have=v.as_i64().filter(|v|(0..=10000).contains(v)).ok_or_else(||bad("Неверный запас использований"))?; if have<need { return Err(bad("Недостаточно ресурса. Цепочка отменена")); } *v=json!(have-need);spent.push(json!({"name":if resource=="slot"{"Ячейки"}else{"Использования"},"amount":need,"remaining":have-need,"resource":resource}));return Ok(());
    }
    let inv=s["inventory"].as_array_mut().ok_or_else(||bad("Нет инвентаря"))?;
    for it in inv {
        let matches=match text(b,"source") { "self"=>category=="item"&&it["uid"]==doc["uid"],"item"=>it["uid"]==b["item_uid"],"tag"=>it["ammo_tag"]==b["tag"]||it["tags"].as_array().is_some_and(|t|t.contains(&b["tag"])),_=>false };
        if !matches||num(it,"qty")<=0||need==0 { continue; }
        let have=if resource=="charges" {num(&it["charges"],"cur")}else{num(it,"qty")}; let n=have.min(need).max(0); if n==0{continue;}
        if resource=="charges" {it["charges"]["cur"]=json!(have-n);}else{it["qty"]=json!(have-n);if have==n{inventory::unequip(it);}}
        spent.push(json!({"uid":it["uid"],"name":it["name"],"amount":n,"remaining":have-n,"resource":resource}));need-=n;
    }
    if need>0 { return Err(bad("Недостаточно предметов / зарядов. Цепочка отменена")); } Ok(())
}
fn signature(it: &Value) -> Value { let mut v=it.clone();if let Some(o)=v.as_object_mut(){for k in ["uid","qty","equipped","hand_slot","attuned"] {o.remove(k);}}v }
fn grant(s: &mut Value, b: &Value) -> ApiResult<()> {
    let mut it=b["item"].clone(); it["uid"]=json!(util::uid());it["qty"]=b["amount"].clone();inventory::unequip(&mut it);it["attuned"]=json!(false);
    let mut tmp=json!({"inventory":[it]});inventory::normalize(&mut tmp)?;let it=tmp["inventory"][0].clone();let sig=signature(&it);
    let inv=s["inventory"].as_array_mut().ok_or_else(||bad("Нет инвентаря у получателя"))?;
    if !it["charges"].is_object() && it["attunement"]!=true && (it["stackable"]==true||["gear","ammo","consumable"].contains(&text(&it,"type"))) {
        if let Some(existing)=inv.iter_mut().find(|x|x["equipped"]!=true&&x["attuned"]!=true&&signature(x)==sig) { let n=num(existing,"qty")+num(&it,"qty");if n>1_000_000 {return Err(bad("Переполнение стопки"));}existing["qty"]=json!(n);return Ok(()); }
    }
    if inv.len()>=2000 {return Err(bad("Инвентарь получателя заполнен"));}inv.push(it);Ok(())
}
/// Эффекты применяются только владельцу листа: урон, состояния и спасброски по другим персонажам —
/// задача ДМ, действие даёт бросок и правило. Лист не меняется ни на йоту при ЛЮБОЙ ошибке цепочки.
pub fn execute(sheet: &mut Value, category: &str, uid: &str, program: &str, mode: &str, acknowledged: bool) -> ApiResult<Value> {
    let mut s=sheet.clone();inventory::normalize(&mut s)?;
    let list=match category {"item"=>&s["inventory"],"spell"=>&s["spells"]["known"],"feature"=>&s["features"],_=>return Err(bad("Неизвестный источник механики"))};
    let doc=list.as_array().and_then(|a|a.iter().find(|d|d["uid"]==uid)).cloned().ok_or_else(||bad("Источник не найден"))?;
    let m=normalize(&doc["mechanics"]);validate(&m)?;
    let p=m["programs"].as_array().unwrap().iter().find(|p|p["id"]==program&&p["trigger"]=="use").ok_or_else(||bad("Действие не найдено"))?;
    if category=="item"&&(num(&doc,"qty")<1||(inventory::handedness(&doc)!="none"&&doc["equipped"]!=true)) {return Err(bad("Предмет закончился или не экипирован"));}
    let blocks: Vec<&Value>=p["blocks"].as_array().unwrap().iter().filter(|b|b["enabled"]!=false).filter(|b|text(b,"grip").is_empty()||text(b,"grip")==if doc["hand_slot"]=="both"{"two"}else{"one"}).collect();
    if blocks.iter().any(|b|b["kind"]=="manual")&&!acknowledged {return Err(bad("Подтвердите ручные правила"));}
    let mut attack_costs: Vec<&Value>=Vec::new();
    let mut spent=Vec::new();let mut rolls=Vec::new();let mut effects=Vec::new();let mut hit=None;let mut crit=false;
    for b in blocks {
        let kind=text(b,"kind");let when=text(b,"when");
        if ["hit","miss"].contains(&when) { let h=hit.ok_or_else(||bad("Ветвление доступно только после блока атаки"))?;if h!=(when=="hit"){continue;} }
        if kind=="consume" {if b["trigger"]=="attack"{attack_costs.push(b);}else{spend(&mut s,&doc,category,b,1,&mut spent)?;}continue;}
        if kind=="attack"{for cost in &attack_costs{spend(&mut s,&doc,category,cost,1,&mut spent)?;}}
        if kind=="require" {if s.pointer(&pointer(text(b,"field"))).and_then(Value::as_i64).unwrap_or(0)<num(b,"minimum"){return Err(bad("Условие действия не выполнено"));}continue;}
        if kind=="manual" {effects.push(json!({"kind":"manual","text":b["text"]}));continue;}
        if kind=="passive" {return Err(bad("Пассивный блок нельзя выполнить повторно"));}
        let mut total=0;
        if ["attack","damage","heal","temp_hp","roll"].contains(&kind) {
            let raw=formula(b)?;let mut expr=inventory::resolve(&raw,&s)?;
            if ["attack","roll"].contains(&kind){expr=crate::realtime::with_d20_mode(&expr,mode);}
            let base=expr.clone();let doubled=kind=="damage"&&crit;if doubled{expr=crate::realtime::double_dice(&expr);}
            let mut r=crate::realtime::roll_expression(&expr).ok_or_else(||bad("Некорректная формула. Все изменения отменены"))?;total=num(&r,"total");let(n20,n1)=crate::realtime::nat_d20(&r);
            // Попадание решает ДМ: промах только на натуральной 1, а если задан КД — результат должен его достичь.
            if kind=="attack" {crit=n20;let dc=num(b,"dc");hit=Some(n20||(!n1&&(dc<=0||total>=dc)));}
            r["name"]=json!(if text(b,"name").is_empty(){text(p,"name")}else{text(b,"name")});r["kind"]=json!(kind);r["dtype"]=b["damage_type"].clone();r["doubled"]=json!(doubled);r["base_expr"]=json!(base);r["crit"]=json!(n20&&kind=="attack");r["fumble"]=json!(n1&&kind=="attack");rolls.push(r);
        }
        let recipient=&mut s;
        match kind {
            "heal"|"temp_hp" => {
                let hp=recipient["hp"].as_object_mut().ok_or_else(||bad("У цели не настроены хиты"))?;
                let cur=hp.get("current").and_then(Value::as_i64).unwrap_or(0);let max=hp.get("max").and_then(Value::as_i64).unwrap_or(0);let tmp=hp.get("temp").and_then(Value::as_i64).unwrap_or(0);let n=total.max(0);
                if kind=="heal" {hp.insert("current".into(),json!(cur.saturating_add(n).min(max).max(0)));}else if kind=="temp_hp"{hp.insert("temp".into(),json!(tmp.max(n)));}else{hp.insert("temp".into(),json!((tmp-n).max(0)));hp.insert("current".into(),json!((cur-(n-tmp).max(0)).max(0)));}
                effects.push(json!({"kind":kind,"amount":n,"target":"self","hp":recipient["hp"]}));
            }
            "grant_item"=>{grant(recipient,b)?;effects.push(json!({"kind":kind,"name":b["item"]["name"],"amount":b["amount"],"target":"self"}));}
            "condition"=>{if recipient["conditions"].is_null(){recipient["conditions"]=json!([]);}let a=recipient["conditions"].as_array_mut().ok_or_else(||bad("Неверный список состояний"))?;if b["operation"]=="remove"{a.retain(|v|v!=&b["condition"]);}else if !a.contains(&b["condition"]){a.push(b["condition"].clone());}effects.push(b.clone());}
            "adjust"=>{let field=text(b,"field");let ptr=pointer(field);let v=recipient.pointer_mut(&ptr).ok_or_else(||bad("Показатель цели не задан"))?;let n=v.as_i64().and_then(|v|v.checked_add(num(b,"amount"))).ok_or_else(||bad("Показатель не числовой или переполнен"))?;let(low,high)=if field.starts_with("abilities."){(1,30)}else if field=="initiative_bonus"{(-1000,1000)}else{(0,1_000_000)};if !(low..=high).contains(&n){return Err(bad("Показатель вышел за допустимые пределы"));}*v=json!(n);if field=="hp.max"&&num(&recipient["hp"],"current")>n{recipient["hp"]["current"]=json!(n);}effects.push(b.clone());}
            _=>{}
        }
    }
    inventory::normalize(&mut s)?;
    *sheet=s;
    Ok(json!({"label":format!("{} · {}",text(&doc,"name"),text(p,"name")),"rolls":rolls,"spent":spent,"effects":effects,"program_id":program,"source_uid":uid,"source_kind":category}))
}

#[cfg(test)] mod tests {
    use super::*;
    fn fixture() -> Value {json!({"hp":{"max":20,"current":1,"temp":0},"inventory":[{"uid":"p","name":"Potion","qty":2,"type":"consumable","mechanics":{"version":1,"programs":[{"id":"use","name":"Drink","trigger":"use","blocks":[{"id":"c","kind":"consume","resource":"quantity","source":"self","amount":1,"trigger":"use"},{"id":"h","kind":"heal","target":"self","dice":{"count":0,"sides":6,"bonus":7,"stat":""}},{"id":"g","kind":"grant_item","target":"self","amount":1,"item":{"name":"Vial","type":"gear"}}]}]}}]})}
    #[test] fn potion_is_atomic_and_stacks_identical_rewards(){let mut s=fixture();execute(&mut s,"item","p","use","",false).unwrap();assert_eq!(s["hp"]["current"],8);assert_eq!(s["inventory"][0]["qty"],1);execute(&mut s,"item","p","use","",false).unwrap();assert_eq!(s["inventory"].as_array().unwrap().len(),2);assert_eq!(s["inventory"][1]["qty"],2);let before=s.clone();assert!(execute(&mut s,"item","p","use","",false).is_err());assert_eq!(s,before);}
    #[test] fn late_failure_rolls_back_everything(){let mut s=fixture();s["inventory"][0]["mechanics"]["programs"][0]["blocks"].as_array_mut().unwrap().push(json!({"id":"x","kind":"adjust","field":"currency.gp","amount":5}));let before=s.clone();assert!(execute(&mut s,"item","p","use","",false).is_err());assert_eq!(s,before);}
    /// Чужих целей нет: урон никому не списывается, спасбросок цели стал своим действием с броском d20.
    #[test] fn damage_and_saves_are_custom_actions(){
        let mut s=json!({"hp":{"max":20,"current":20,"temp":0},"inventory":[{"uid":"w","name":"Wand","qty":1,"type":"gear","mechanics":{"version":1,"programs":[{"id":"use","name":"Burst","trigger":"use","blocks":[
            {"id":"s","kind":"save","ability":"dex","dc":15},
            {"id":"d","kind":"damage","target":"target","apply":true,"when":"hit","dice":{"count":1,"sides":6,"bonus":0,"stat":""}}]}]}}]});
        let r=execute(&mut s,"item","w","use","",false).unwrap();
        assert_eq!(s["hp"]["current"],20);
        assert_eq!(s["hp"]["temp"],0);
        let rolls=r["rolls"].as_array().unwrap();
        assert_eq!(rolls.len(),2);
        assert_eq!(rolls[0]["kind"],"roll");
        assert_eq!(rolls[1]["kind"],"damage");
        assert!(r["effects"].as_array().unwrap().is_empty());
    }
    /// Ветка попадания считается только по броску и КД: чужой лист (тут AC 99) не участвует.
    #[test] fn hit_branch_uses_only_the_roll(){
        let mk=|dc:i64| json!({"hp":{"max":20,"current":10,"temp":0},"ac":99,"inventory":[{"uid":"w","name":"W","qty":1,"type":"gear","mechanics":{"version":1,"programs":[{"id":"use","name":"Hit","trigger":"use","blocks":[
            {"id":"a","kind":"attack","dc":dc,"dice":{"count":0,"sides":20,"bonus":5,"stat":""}},
            {"id":"h","kind":"heal","when":"hit","dice":{"count":0,"sides":6,"bonus":7,"stat":""}}]}]}}]});
        let mut hit=mk(3); // результат 5 достигает КД 3 — срабатывает ветка попадания
        let r=execute(&mut hit,"item","w","use","",false).unwrap();
        assert_eq!(r["rolls"].as_array().unwrap().len(),2);
        assert_eq!(hit["hp"]["current"],17);
        let mut miss=mk(10); // результат 5 ниже КД 10 — лечения нет
        let r=execute(&mut miss,"item","w","use","",false).unwrap();
        assert_eq!(r["rolls"].as_array().unwrap().len(),1);
        assert_eq!(miss["hp"]["current"],10);
    }
    #[test] fn creation_choices_are_bounded(){
        let one=json!([{"id":"g","name":"Бонус","type":"ability","count":1,"options":[{"id":"o","name":"+2 Сила","value":{"str":2}}]}]);
        validate_choices(&one).unwrap();
        let feature=json!([{"id":"g","name":"Линия","type":"feature","count":1,"options":[{"id":"o","name":"Дракон","value":{"text":"Дыхание"}}]}]);
        validate_choices(&feature).unwrap();
        let mut too_many=one.clone();too_many[0]["count"]=json!(5);assert!(validate_choices(&too_many).is_err());
        let mut unknown=one.clone();unknown[0]["type"]=json!("other");assert!(validate_choices(&unknown).is_err());
        let mut huge=one.clone();huge[0]["options"][0]["value"]=json!({"str":9});assert!(validate_choices(&huge).is_err());
        let mut blank=one.clone();blank[0]["options"][0]["value"]=json!({});assert!(validate_choices(&blank).is_err());
        let mut empty=one.clone();empty[0]["options"]=json!([]);assert!(validate_choices(&empty).is_err());
        assert!(validate_choices(&json!({})).is_err());
    }
    #[test] fn healing_does_not_include_proficiency(){let s=json!({"abilities":{"wis":16},"proficiency_bonus":4,"spells":{"ability":"wis"}});assert_eq!(inventory::resolve("1d8+@spell_mod",&s).unwrap(),"1d8+3");}
    #[test] fn program_attack_modes_use_the_shared_d20_formula(){
        let fixture=||json!({"features":[{"uid":"f","name":"Проверка","mechanics":{"version":1,"programs":[{"id":"p","name":"Бросок","trigger":"use","blocks":[{"id":"b","kind":"attack","dice":{"count":1,"sides":20,"bonus":5,"stat":"","advanced":"d20+5"}}]}]}}]});
        for (mode,expected) in [("adv","2d20kh1+5"),("dis","2d20kl1+5")] {
            let mut sheet=fixture();let result=execute(&mut sheet,"feature","f","p",mode,false).unwrap();
            assert_eq!(result["rolls"][0]["expr"],expected);
        }
    }
}
