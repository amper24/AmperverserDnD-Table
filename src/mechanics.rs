//! Bounded declarative programs. Only stored definitions execute; caller owns the CAS transaction.
use serde_json::{json, Value};
use std::collections::HashSet;
use crate::{AppError, error::ApiResult, inventory, util};
// `save` остаётся в схеме только для старых записей: при выполнении он превращается в правило для мастера.
const KINDS: &[&str] = &["consume","attack","damage","heal","temp_hp","roll","grant_item","condition","adjust","require","manual","passive","setvar","hands"];
fn bad(s: &str) -> AppError { AppError::bad(s) }
fn text<'a>(v: &'a Value, k: &str) -> &'a str { v[k].as_str().unwrap_or("") }
fn num(v: &Value, k: &str) -> i64 { v[k].as_i64().unwrap_or(0) }
fn bounded(v: &Value, k: &str, low: i64, high: i64) -> ApiResult<i64> { v[k].as_i64().filter(|n| (low..=high).contains(n)).ok_or_else(|| bad("Некорректное число в блоке")) }
fn field_ok(s: &str) -> bool { ["speed","initiative_bonus","currency.gp","currency.sp","hp.max","abilities.str","abilities.dex","abilities.con","abilities.int","abilities.wis","abilities.cha"].contains(&s) }
fn pointer(s: &str) -> String { format!("/{}", s.replace('.', "/")) }
pub fn validate(m: &Value) -> ApiResult<()> { validate_nested(m, 0) }
fn validate_nested(m: &Value, depth: usize) -> ApiResult<()> {
    if depth > 4 { return Err(bad("Слишком глубокая вложенность механик")); }
    match m["version"].as_i64() {
        Some(2) => {
            crate::mechanics_graph::validate(m)?;
            // Незавершённый поток («Начало → Конец») плану не мешает: проверяем блоки, как только
            // исправлены все прочие проблемы (см. plan_checks_apply).
            if !crate::mechanics_graph::plan_checks_apply(m) { return Ok(()); }
            validate_plan(&crate::mechanics_graph::to_v1(m), depth)
        }
        _ => Err(bad("Механики должны быть графом версии 2")),
    }
}
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
                    if !o["value"]["mechanics"].is_null() { validate_nested(&o["value"]["mechanics"], 1)?; }
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
fn validate_plan(m: &Value, depth: usize) -> ApiResult<()> {
    if depth>4 || m.to_string().len()>1_000_000 || m["version"]!=1 { return Err(bad("Внутренний план механики некорректен")); }
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
            if ["attack"].contains(&kind) { gate=true; }
            if !["","self","target"].contains(&text(b,"target")) { return Err(bad("Неизвестная цель")); }
            if ["attack","damage","heal","temp_hp","roll"].contains(&kind) { formula(b)?; }
            if ["damage","heal"].contains(&kind) && b.get("upcast").is_some() {
                let upcast=&b["upcast"];
                if !upcast.is_object() || bounded(upcast,"count",0,100).is_err() || bounded(upcast,"sides",1,1000).is_err() { return Err(bad("Повышение круга: количество костей 0–100 и грани 1–1000")); }
            }
            match kind {
                "consume" => { bounded(b,"amount",1,10000)?; if !["quantity","charges","slot","uses"].contains(&text(b,"resource"))||!["self","item","tag"].contains(&text(b,"source"))||!["use","attack"].contains(&text(b,"trigger")) { return Err(bad("Неизвестный способ расхода")); } if b["source"]=="item"&&text(b,"item_uid").is_empty()||b["source"]=="tag"&&text(b,"tag").is_empty() { return Err(bad("Не задан источник расхода")); } if b["resource"]=="slot" { bounded(b,"slot_level",0,9)?; } }
                "grant_item" => { bounded(b,"amount",1,10000)?; if !b["item"].is_object()||text(&b["item"],"name").trim().is_empty() { return Err(bad("Нет шаблона выдаваемого предмета")); } if !b["item"]["mechanics"].is_null() { validate_nested(&b["item"]["mechanics"], depth + 1)?; } }
                "adjust" => { if !field_ok(text(b,"field")) { return Err(bad("Недоступный показатель")); } bounded(b,"amount",-10000,10000)?; }
                "require" => { if !field_ok(text(b,"field"))&&b["field"]!="hp.current" { return Err(bad("Недоступное условие")); } bounded(b,"minimum",-1000000,1000000)?; }
                "attack" => { if let Some(dc)=b["dc"].as_i64() { if !(0..=40).contains(&dc) { return Err(bad("КД цели: целое от 1 до 40")); } } }
                "condition" => { let operation=text(b,"operation"); if !["add","remove","concentration"].contains(&operation)||(operation!="concentration"&&text(b,"condition").trim().is_empty())||text(b,"condition").len()>200 { return Err(bad("Неверное состояние")); } }
                "passive" => { if text(p,"trigger")!="passive"||!["speed","hit_die","spellcasting","saves","skills","languages","armor","weapons","unarmored_defense","asi.str","asi.dex","asi.con","asi.int","asi.wis","asi.cha"].contains(&text(b,"field")) { return Err(bad("Параметр доступен только в пассивной программе")); } }
                // Руки: add/remove — на столько extra_hands, set — общее число рук (2 = main+off).
                "hands" => {
                    if !["add", "remove", "set"].contains(&text(b,"operation")) { return Err(bad("Руки: операция add, remove или set")); }
                    bounded(b,"count",1,6)?;
                }
                // Переменная: имя и область те же, что у узлов action.setvar/data.var; значение —
                // число или (в рантайме) провод value_src.
                "setvar" => {
                    if !crate::mechanics_graph::valid_var_name(text(b,"name")) { return Err(bad("Переменная: имя из латинских букв, цифр и «_» (1–32).")); }
                    if !crate::mechanics_graph::valid_var_scope(text(b,"scope")) { return Err(bad("Переменная: область action или sheet.")); }
                    if let Some(value) = b.get("value") { if !value.as_f64().is_some_and(f64::is_finite) { return Err(bad("Переменная: значение должно быть конечным числом.")); } }
                    if let Some(source) = b.get("value_src") { if !source.as_str().is_some_and(|source| !source.is_empty() && source.chars().count() <= 100) { return Err(bad("Переменная: некорректный источник значения.")); } }
                }
                _ => {}
            }
            if text(p,"trigger")=="passive"&&!["passive","manual"].contains(&kind) { return Err(bad("Пассивная программа не может расходовать или выдавать ресурсы")); }
        }
    }
    Ok(())
}
fn formula(b: &Value) -> ApiResult<String> {
    let d=&b["dice"];
    if let Some(s)=d["advanced"].as_str().filter(|s|!s.is_empty()) { if s.len()>128 { return Err(bad("Формула слишком длинная")); } return Ok(s.into()); }
    let count=bounded(d,"count",0,100)?; let sides=bounded(d,"sides",1,1000)?; let bonus=bounded(d,"bonus",-1_000_000,1_000_000)?;
    let stat=text(d,"stat"); if !["","str","dex","con","int","wis","cha","best","prof","atk","atk_str","atk_dex","spell","spell_mod","level","dc"].contains(&stat) { return Err(bad("Неизвестный модификатор")); }
    // Каноничный вид формулы — как Mechanics.expression: нулевой бонус не пишется, «1d20+@atk_str»,
    // «2d8+@spell_mod», «@dex», «5». Иначе игрок видел «1d20+0+@atk_str».
    let mut out=if count>0{format!("{count}d{sides}")}else{String::new()};
    if bonus!=0 { out.push_str(&if out.is_empty(){bonus.to_string()}else{format!("{bonus:+}")}); }
    if !stat.is_empty() { if out.is_empty() { out.push('@'); out.push_str(&stat); } else { out.push_str(&format!("+@{stat}")); } }
    if out.is_empty() { out="0".into(); }
    Ok(out)
}
/// Ячейка нужного круга: обычная, а если её нет — ячейка Договора того же круга.
/// Возвращает `(имя для ответа, остаток)`.
fn take_slot(s: &mut Value, level: i64, need: i64) -> ApiResult<(String, i64)> {
    if !(1..=9).contains(&level) { return Err(bad("Укажите круг ячейки")); }
    let key = level.to_string();
    let max = s["spells"]["slots"][&key]["max"].as_i64().unwrap_or(0);
    let used = s["spells"]["slots"][&key]["used"].as_i64().unwrap_or(0);
    if max - used >= need {
        s["spells"]["slots"][&key]["used"] = json!(used + need);
        return Ok((format!("Ячейки {level} круга"), max - used - need));
    }
    let pact = &s["spells"]["pact_slots"];
    if pact["level"].as_i64() == Some(level) {
        let pact_max = pact["max"].as_i64().unwrap_or(0);
        let pact_used = pact["used"].as_i64().unwrap_or(0);
        if pact_max - pact_used >= need {
            s["spells"]["pact_slots"]["used"] = json!(pact_used + need);
            return Ok((format!("Ячейки Договора {level} круга"), pact_max - pact_used - need));
        }
    }
    Err(bad("Недостаточно ячеек. Цепочка отменена"))
}
fn slot_free(s: &Value, level: i64) -> bool {
    let key = level.to_string();
    let max = s["spells"]["slots"][&key]["max"].as_i64().unwrap_or(0);
    let used = s["spells"]["slots"][&key]["used"].as_i64().unwrap_or(0);
    if max - used > 0 { return true; }
    let pact = &s["spells"]["pact_slots"];
    pact["level"].as_i64() == Some(level) && pact["max"].as_i64().unwrap_or(0) > pact["used"].as_i64().unwrap_or(0)
}
/// Расход блока consume. Ячейка: `slot_level` 0 — выбранный при касте круг из `sheet.cast`
/// (ритуал — 0: ячейка не тратится и блок пропускается).
fn spend(s: &mut Value, doc: &Value, category: &str, b: &Value, times: i64, spent: &mut Vec<Value>) -> ApiResult<()> {
    let mut need=num(b,"amount")*times; if need==0 { return Ok(()); } let resource=text(b,"resource");
    if resource=="slot"||resource=="uses" {
        if resource=="slot" {
            // Ритуал: круг каста 0 — ячейка не тратится, даже если у старого блока свой круг.
            if s.get("cast").and_then(|cast|cast["level"].as_i64())==Some(0) { return Ok(()); }
            let block_level=num(b,"slot_level");
            let level=if block_level>0 {block_level} else {s.get("cast").and_then(|cast|cast["level"].as_i64()).unwrap_or(0)};
            if level==0 { return Ok(()); }
            let (name,remaining)=take_slot(s,level,need)?;
            spent.push(json!({"name":name,"amount":need,"remaining":remaining,"resource":resource,"slot_level":level}));return Ok(());
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
/// Поле заклинания на листе: модуль хранит `level`/`ritual`/`concentration` на верхнем уровне,
/// а запись справочника — в `data`. Поддерживаем оба вида.
fn spell_field(doc: &Value, key: &str) -> Value {
    doc["data"].get(key).cloned().or_else(|| doc.get(key).cloned()).unwrap_or(Value::Null)
}
fn spell_i64(doc: &Value, key: &str) -> i64 { spell_field(doc, key).as_i64().unwrap_or(0) }
fn spell_true(doc: &Value, key: &str) -> bool { spell_field(doc, key) == json!(true) }
/// Есть ли в графе заклинания узел, который сам списывает ячейку. Старые записи без него
/// считают ячейку на листе: сервер не требует круг и не трогает ресурс.
fn has_slot_node(mechanics: &Value) -> bool {
    let nodes = || mechanics["graph"]["nodes"].as_array().into_iter().flatten();
    let groups = || mechanics["graph"]["groups"].as_array().into_iter().flatten().flat_map(|group| group["nodes"].as_array().into_iter().flatten());
    nodes().chain(groups()).any(|node| node["type"] == "action.slot" || (node["type"] == "action.spend" && node["params"]["resource"] == "slot"))
}
/// Есть ли узел, который оставляет круг на выбор игрока (level 0). Старый фиксированный
/// блок расхода такого выбора не даёт и не требует `slot_level` в операции.
fn has_slot_choice_node(mechanics: &Value) -> bool {
    let nodes = || mechanics["graph"]["nodes"].as_array().into_iter().flatten();
    let groups = || mechanics["graph"]["groups"].as_array().into_iter().flatten().flat_map(|group| group["nodes"].as_array().into_iter().flatten());
    nodes().chain(groups()).any(|node| (node["type"] == "action.slot" && node["params"]["level"].as_i64().unwrap_or(0) == 0)
        || (node["type"] == "action.spend" && node["params"]["resource"] == "slot" && node["params"]["slot_level"].as_i64().unwrap_or(0) == 0))
}
/// Концентрация — состояние листа «Концентрация: <имя>»: прежняя запись заменяется, чужие не трогаются.
fn set_concentration(s: &mut Value, name: &str) -> ApiResult<()> {
    let value = format!("Концентрация: {name}");
    if s["conditions"].is_null() { s["conditions"] = json!([]); }
    let list = s["conditions"].as_array_mut().ok_or_else(|| bad("Неверный список состояний"))?;
    list.retain(|item| !item.as_str().is_some_and(|text| text.starts_with("Концентрация:")));
    list.push(json!(value));
    Ok(())
}
/// Эффекты применяются только владельцу листа: урон, состояния и спасброски по другим персонажам —
/// задача ДМ, действие даёт бросок и правило. Лист не меняется ни на йоту при ЛЮБОЙ ошибке цепочки.
pub fn execute(sheet: &mut Value, category: &str, uid: &str, program: &str, mode: &str, acknowledged: bool) -> ApiResult<Value> {
    execute_with_slot(sheet, category, uid, program, mode, acknowledged, 0)
}
/// То же, но для заклинания: `slot_level` — выбранный игроком круг ячейки (0 — базовый/ритуал).
pub fn execute_with_slot(sheet: &mut Value, category: &str, uid: &str, program: &str, mode: &str, acknowledged: bool, slot_level: i64) -> ApiResult<Value> {
    let mut s=sheet.clone();inventory::normalize(&mut s)?;
    let list=match category {"item"=>&s["inventory"],"spell"=>&s["spells"]["known"],"feature"=>&s["features"],_=>return Err(bad("Неизвестный источник механики"))};
    let doc=list.as_array().and_then(|a|a.iter().find(|d|d["uid"]==uid)).cloned().ok_or_else(||bad("Источник не найден"))?;
    validate(&doc["mechanics"])?;
    // Контекст каста: базовый круг из записи, выбранный — из операции. Без узла ячейки в графе
    // старые записи считают ячейку на клиенте, поэтому строгие проверки круга к ним не применяются.
    let (base_level, chosen, extra_levels) = if category=="spell" {
        let base=spell_i64(&doc,"level");
        if slot_level<0 { return Err(bad("Круг ячейки должен быть не ниже круга заклинания (1–9)")); }
        let own_slot=has_slot_node(&doc["mechanics"]);
        let slot_choice=own_slot&&has_slot_choice_node(&doc["mechanics"]);
        // 0 в slot_level — ритуал (ячейка не тратится) или старый клиент, который считает ячейку
        // на листе. Новый клиент всегда присылает выбранный круг для обычного каста.
        let chosen=if !own_slot {base}
            else if slot_level>0 {slot_level}
            else if base==0 {0}
            else if spell_true(&doc,"ritual") {0}
            else if !slot_choice {base}
            else { return Err(bad("Укажите круг ячейки")); };
        if !(0..=9).contains(&chosen)||(chosen>0&&chosen<base) { return Err(bad("Круг ячейки должен быть не ниже круга заклинания (1–9)")); }
        if own_slot&&chosen>0&&!slot_free(&s,chosen) { return Err(bad("Недостаточно ячеек. Цепочка отменена")); }
        (base,chosen,chosen-base)
    } else { (0,0,0) };
    let cast=json!({"level":chosen,"base":base_level,"extra":extra_levels});
    let mut graph_context = json!({
        "edition": s.get("edition").and_then(Value::as_str).unwrap_or("2014"),
        "level": s.get("level").and_then(Value::as_i64).unwrap_or(1),
        "subclass": s.get("subclass").cloned().unwrap_or(json!("")),
        "choices": s.pointer("/creation/rule_choices").filter(|value| value.is_object()).cloned().unwrap_or(json!({})),
    });
    if category=="spell" {
        graph_context["cast"]=cast.clone();
        // Формулы и data.sheet видят круг только на время выполнения: лист его не хранит.
        s["cast"]=cast.clone();
    }
    if !crate::mechanics_graph::is_executable(&doc["mechanics"]) { return Err(bad("Граф механики содержит ошибки: исправьте провода в редакторе.")); }
    let m = crate::mechanics_graph::to_v1_with_context(&doc["mechanics"], &graph_context);
    validate_plan(&m, 0)?;
    // Граф нужен для condition_src: условие блока считается в рантайме по листу и результатам.
    let graph = m["graph"].clone();
    let p=m["programs"].as_array().unwrap().iter().find(|p|p["id"]==program&&p["trigger"]=="use").ok_or_else(||bad("Действие не найдено"))?;
    if category=="item" { inventory::validate_use(&doc)?; }
    let blocks: Vec<&Value>=p["blocks"].as_array().unwrap().iter().filter(|b|b["enabled"]!=false).filter(|b|text(b,"grip").is_empty()||text(b,"grip")==if doc["hand_slot"]=="both"{"two"}else{"one"}).collect();
    if blocks.iter().any(|b|b["kind"]=="manual")&&!acknowledged {return Err(bad("Подтвердите ручные правила"));}
    let mut attack_costs: Vec<&Value>=Vec::new();
    let mut spent=Vec::new();let mut rolls=Vec::new();let mut effects=Vec::new();let mut hit=None;let mut crit=false;
    let mut concentration_set=false;
    let mut last_total: Option<i64>=None;
    // Результаты прошлых действий: новые программы сохраняют уже записанные программы листа.
    let mut results = s.get("action_results").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({"last": Value::Null, "by_program": {}}));
    if !results["by_program"].is_object() { results["by_program"] = json!({}); }
    if results.get("last").is_none() { results["last"] = Value::Null; }
    // Переменные выполнения: числа sheet.vars — стартовые значения. Переменные области action
    // живут только до конца этого выполнения и в лист не попадают.
    let mut vars: serde_json::Map<String, Value> = s.get("vars").and_then(Value::as_object)
        .map(|object| object.iter().filter_map(|(name, value)| value.as_f64().map(|number| (name.clone(), json!(number)))).collect())
        .unwrap_or_default();
    for b in blocks {
        // Контекст пересобирается на каждый блок: лист и переменные меняются по ходу цепочки.
        // condition_src — провод на вход condition: false или 0 пропускает блок, поток идёт дальше.
        let mut context = graph_context.clone();
        context["runtime"] = json!({"sheet": &s, "results": &results, "vars": Value::Object(vars.clone())});
        if let Some(source) = b["condition_src"].as_str() {
            let value = crate::mechanics_graph::node_value(&graph, source, &context)?;
            let skip = match &value { Value::Bool(value) => !*value, Value::Number(number) => number.as_f64() == Some(0.0), _ => false };
            if skip { continue; }
        }
        let kind=text(b,"kind");let when=text(b,"when");
        if ["hit","miss"].contains(&when) { let h=hit.ok_or_else(||bad("Ветвление доступно только после блока атаки"))?;if h!=(when=="hit"){continue;} }
        // Записать переменную: значение с провода value считается в рантайме, без провода — 0.
        if kind=="setvar" {
            let raw = match b["value_src"].as_str() {
                Some(source) => crate::mechanics_graph::node_value(&graph, source, &context)?,
                None => b["value"].clone(),
            };
            let value = raw.as_f64().filter(|value| value.is_finite()).ok_or_else(||bad("Переменная: значение входа value должно быть конечным числом"))?;
            let name=text(b,"name");
            if text(b,"scope")=="sheet" {
                if !s["vars"].is_object() { s["vars"]=json!({}); }
                s["vars"][name]=json!(value);
            }
            vars.insert(name.to_string(), json!(value));
            continue;
        }
        if kind=="consume" {if b["trigger"]=="attack"{attack_costs.push(b);}else{spend(&mut s,&doc,category,b,1,&mut spent)?;}continue;}
        if kind=="attack"{for cost in &attack_costs{spend(&mut s,&doc,category,cost,1,&mut spent)?;}}
        if kind=="require" {if s.pointer(&pointer(text(b,"field"))).and_then(Value::as_i64).unwrap_or(0)<num(b,"minimum"){return Err(bad("Условие действия не выполнено"));}continue;}
        if kind=="manual" {effects.push(json!({"kind":"manual","text":b["text"]}));continue;}
        if kind=="passive" {return Err(bad("Пассивный блок нельзя выполнить повторно"));}
        let mut total=0;
        if ["attack","damage","heal","temp_hp","roll"].contains(&kind) {
            let mut raw=formula(b)?;
            // Upcast: на каждый круг выше базового формула получает ещё count костей sides.
            if ["damage","heal"].contains(&kind)&&extra_levels>0 {
                if let Some(upcast)=b.get("upcast").filter(|value| value.is_object()) {
                    let count=upcast["count"].as_i64().unwrap_or(0);let sides=upcast["sides"].as_i64().unwrap_or(0);
                    if count>0&&(1..=1000).contains(&sides) { raw.push_str(&format!("+{}d{}",extra_levels*count,sides)); }
                }
            }
            let mut expr=inventory::resolve(&raw,&s)?;
            // Двуручное оружие в одной руке: помеха только на броски атаки предмета.
            let roll_mode=if kind=="attack" {inventory::attack_mode(mode,category=="item"&&inventory::one_hand_penalty(&doc))} else {mode.to_string()};
            expr=crate::realtime::with_dice_mode(&expr,&roll_mode);
            let base=expr.clone();let doubled=kind=="damage"&&crit;if doubled{expr=crate::realtime::double_dice(&expr);}
            let mut r=crate::realtime::roll_expression(&expr).ok_or_else(||bad("Некорректная формула. Все изменения отменены"))?;total=num(&r,"total");let(n20,n1)=crate::realtime::nat_d20(&r);
            // Попадание решает ДМ: промах только на натуральной 1, а если задан КД — результат должен его достичь.
            if kind=="attack" {crit=n20;let dc=num(b,"dc");hit=Some(n20||(!n1&&(dc<=0||total>=dc)));}
            last_total=Some(total);
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
            // Руки: extra_hands — это дополнительные руки после main/off. add/remove меняют их на count,
            // set задаёт общее число рук: 2 — обычные две, 3 — одна дополнительная и т. д.
            "hands"=>{
                let operation=text(b,"operation");
                let count=bounded(b,"count",1,6)?;
                let current=inventory::extra_hands(recipient);
                let next=match operation {
                    "add"=>current.saturating_add(count).min(inventory::MAX_EXTRA_HANDS),
                    "remove"=>current.saturating_sub(count).max(0),
                    "set"=>(count-2).clamp(0,inventory::MAX_EXTRA_HANDS),
                    _=>return Err(bad("Руки: операция add, remove или set")),
                };
                recipient["extra_hands"]=json!(next);
                // Предметы с исчезнувших дополнительных рук уходят в рюкзак и попадают в отчёт эффекта.
                let removed=inventory::drop_extra_hands(recipient,next);
                effects.push(json!({"kind":kind,"operation":operation,"count":count,"extra_hands":next,"removed":removed,"target":"self"}));
            }
            "condition"=>{
                let operation=text(b,"operation");
                if operation=="concentration" {
                    // Название подставляет сервер: condition у узла пустой.
                    set_concentration(recipient,text(&doc,"name"))?;
                    concentration_set=true;
                    effects.push(json!({"kind":"condition","condition":format!("Концентрация: {}",text(&doc,"name")),"target":"self"}));
                } else {
                    if recipient["conditions"].is_null(){recipient["conditions"]=json!([]);}
                    let a=recipient["conditions"].as_array_mut().ok_or_else(||bad("Неверный список состояний"))?;
                    if operation=="remove"{a.retain(|v|v!=&b["condition"]);}else if !a.contains(&b["condition"]){a.push(b["condition"].clone());}
                    effects.push(b.clone());
                }
            }
            "adjust"=>{let field=text(b,"field");let ptr=pointer(field);let v=recipient.pointer_mut(&ptr).ok_or_else(||bad("Показатель цели не задан"))?;let n=v.as_i64().and_then(|v|v.checked_add(num(b,"amount"))).ok_or_else(||bad("Показатель не числовой или переполнен"))?;let(low,high)=if field.starts_with("abilities."){(1,30)}else if field=="initiative_bonus"{(-1000,1000)}else{(0,1_000_000)};if !(low..=high).contains(&n){return Err(bad("Показатель вышел за допустимые пределы"));}*v=json!(n);if field=="hp.max"&&num(&recipient["hp"],"current")>n{recipient["hp"]["current"]=json!(n);}effects.push(b.clone());}
            _=>{}
        }
    }
    // Концентрация и ритуал — свойства заклинания, а не блоков: даже запись без узлов
    // получает состояние и эффект. Концентрация заменяет прежнюю, а не копится.
    if category=="spell" {
        if spell_true(&doc,"concentration")&&!concentration_set {
            set_concentration(&mut s,text(&doc,"name"))?;
            effects.push(json!({"kind":"condition","condition":format!("Концентрация: {}",text(&doc,"name")),"target":"self"}));
        }
        if chosen==0&&base_level>0&&spell_true(&doc,"ritual") {
            effects.push(json!({"kind":"ritual","text":"Ритуал: 10 минут, ячейка не тратится"}));
        }
        // Круг каста — только контекст выполнения: в лист он не сохраняется.
        if let Some(object)=s.as_object_mut() { object.remove("cast"); }
    }
    // Итог действия — в лист: total последнего броска, hit (0/1), применённое лечение/хиты,
    // израсходованное и число бросков. Так другие действия читают его через data.result.
    let applied: i64 = effects.iter().filter(|effect| matches!(text(effect,"kind"), "heal"|"temp_hp"|"damage")).map(|effect| num(effect,"amount")).sum();
    let spent_total: i64 = spent.iter().map(|entry| num(entry,"amount")).sum();
    let result = json!({
        "total": last_total.unwrap_or(0),
        "hit": hit.map(Value::Bool).unwrap_or(Value::Null),
        "applied": applied,
        "spent": spent_total,
        "rolls": rolls.len(),
        "at": chrono::Utc::now().timestamp(),
    });
    results["last"] = result.clone();
    results["by_program"][program] = result;
    s["action_results"] = results.clone();
    inventory::normalize(&mut s)?;
    *sheet=s;
    Ok(json!({"label":format!("{} · {}",text(&doc,"name"),text(p,"name")),"rolls":rolls,"spent":spent,"effects":effects,"results":results,"program_id":program,"source_uid":uid,"source_kind":category,"cast":cast}))
}

#[cfg(test)] mod tests {
    use super::*;
    /// Узел v2: тип, параметры и координата; ID уникален внутри графа.
    pub(super) fn node(id: &str, kind: &str, params: Value) -> Value {
        json!({"id": id, "type": kind, "params": params, "position": {"x": 0, "y": 0}})
    }
    /// Провод между сокетами; `link` — обычный поток управления exec → exec.
    fn wire(from: &str, out_socket: &str, to: &str, in_socket: &str) -> Value {
        json!({"from": {"node": from, "socket": out_socket}, "to": {"node": to, "socket": in_socket}})
    }
    pub(super) fn link(from: &str, to: &str) -> Value { wire(from, "exec", to, "exec") }
    /// Достроить «Конец» каждой программе тестового графа: висячие flow-выходы (exec, then/else)
    /// подключаются к узлу flow.end, а если его ещё нет — узел создаётся (как Mechanics.addFlowEnds).
    fn terminate(graph: &mut Value) {
        let nodes = graph["graph"]["nodes"].as_array().cloned().unwrap_or_default();
        let kinds: std::collections::HashMap<String, String> = nodes.iter()
            .filter_map(|node| Some((node["id"].as_str()?.to_string(), node["type"].as_str()?.to_string()))).collect();
        let mut links = graph["graph"]["links"].as_array().cloned().unwrap_or_default();
        fn has_link(links: &[Value], node: &str, socket: &str) -> bool {
            links.iter().any(|link| link["from"]["node"] == node && link["from"]["socket"] == socket)
        }
        let mut dangling: Vec<(String, String)> = Vec::new();
        for node in &nodes {
            let id = node["id"].as_str().unwrap_or("");
            let sockets: &[&str] = match kinds.get(id).map(String::as_str) {
                Some("action.program") => &["exec"],
                Some(kind) if kind.starts_with("action.") => &["exec"],
                Some("flow.if") => &["then", "else"],
                _ => &[],
            };
            for socket in sockets { if !has_link(&links, id, socket) { dangling.push((id.to_string(), (*socket).to_string())); } }
        }
        if dangling.is_empty() { return; }
        let end = match nodes.iter().find(|node| node["type"] == "flow.end").and_then(|node| node["id"].as_str()) {
            Some(id) => id.to_string(),
            None => {
                graph["graph"]["nodes"].as_array_mut().unwrap().push(json!({"id": "end", "type": "flow.end", "params": {}, "position": {"x": 900, "y": 0}}));
                "end".to_string()
            }
        };
        for (node, socket) in dangling { links.push(wire(&node, &socket, &end, "exec")); }
        graph["graph"]["links"] = json!(links);
    }
    /// Оболочка графа v2 — единственная схема, которую принимает сервер после удаления старых механик.
    /// Поток достраивается до «Конца»: с незавершённым потоком граф не исполняется.
    pub(super) fn mech(nodes: Vec<Value>, links: Vec<Value>) -> Value {
        let mut graph = json!({"version": 2, "origin": "test", "graph": {"nodes": nodes, "links": links, "frames": [], "groups": []}});
        terminate(&mut graph);
        graph
    }
    /// Зелье: расход → лечение → выдача пузырька — одна цепочка v2.
    fn fixture() -> Value {
        json!({"hp": {"max": 20, "current": 1, "temp": 0}, "inventory": [{
            "uid": "p", "name": "Potion", "qty": 2, "type": "consumable",
            "mechanics": mech(vec![
                node("p", "action.program", json!({"program_id": "use", "name": "Drink", "trigger": "use"})),
                node("c", "action.spend", json!({"block_id": "c", "resource": "quantity", "source": "self", "amount": 1, "trigger": "use"})),
                node("h", "action.roll", json!({"block_id": "h", "kind": "heal", "target": "self", "dice": {"count": 0, "sides": 6, "bonus": 7, "stat": ""}})),
                node("g", "action.grant_item", json!({"block_id": "g", "target": "self", "amount": 1, "item": {"name": "Vial", "type": "gear"}}))
            ], vec![link("p", "c"), link("c", "h"), link("h", "g")])
        }]})
    }
    #[test] fn potion_is_atomic_and_stacks_identical_rewards(){let mut s=fixture();execute(&mut s,"item","p","use","",false).unwrap();assert_eq!(s["hp"]["current"],8);assert_eq!(s["inventory"][0]["qty"],1);execute(&mut s,"item","p","use","",false).unwrap();assert_eq!(s["inventory"].as_array().unwrap().len(),2);assert_eq!(s["inventory"][1]["qty"],2);let before=s.clone();assert!(execute(&mut s,"item","p","use","",false).is_err());assert_eq!(s,before);}
    #[test] fn late_failure_rolls_back_everything(){
        let mut s=fixture();
        // Ошибка в самом конце цепочки: расход, лечение и выдача успели сработать, а у листа нет валюты.
        // Новый узел встаёт перед «Концом»: поток остаётся завершённым, и падает именно выполнение.
        let graph = &mut s["inventory"][0]["mechanics"]["graph"];
        let end = graph["nodes"].as_array().unwrap().iter().find(|node| node["type"] == "flow.end").unwrap()["id"].as_str().unwrap().to_string();
        graph["nodes"].as_array_mut().unwrap().push(node("x","action.field",json!({"block_id":"x","kind":"value","field":"currency.gp","amount":5})));
        let links = graph["links"].as_array_mut().unwrap();
        links.retain(|link| !(link["from"]["node"] == "g" && link["to"]["node"] == end));
        links.push(link("g","x"));
        links.push(link("x", &end));
        let before=s.clone();
        assert!(execute(&mut s,"item","p","use","",false).is_err());
        assert_eq!(s,before);
    }
    #[test] fn item_program_requires_attunement_and_equipping_before_use() {
        let mk = |attuned: bool, equipped: bool| json!({"hp":{"max":20,"current":20,"temp":0},"inventory":[{"uid":"ring","name":"Ring of Protection","type":"magic","qty":1,"attunement":true,"attuned":attuned,"equipped":equipped,"worn_slot":if equipped {json!("ring1")} else {Value::Null},"mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Activate","trigger":"use"})),
            node("m","action.manual",json!({"block_id":"m","text":"Rule"}))
        ], vec![link("p","m")])}]});
        let mut un_attuned = mk(false, true); let before = un_attuned.clone();
        assert!(execute(&mut un_attuned,"item","ring","use","",true).is_err()); assert_eq!(un_attuned,before);
        let mut not_worn = mk(true, false); let before = not_worn.clone();
        assert!(execute(&mut not_worn,"item","ring","use","",true).is_err()); assert_eq!(not_worn,before);
        let mut ready = mk(true, true);
        assert!(execute(&mut ready,"item","ring","use","",true).is_ok());
    }
    /// Чужих целей нет: урон никому не списывается, а спасбросок цели — ручное правило мастера.
    #[test] fn damage_and_saves_are_custom_actions(){
        const RULE: &str = "Спасбросок ЛОВ Сл 15; при провале цель получает урон — решает мастер, не игрок.";
        let mut s=json!({"hp":{"max":20,"current":20,"temp":0},"inventory":[{"uid":"w","name":"Wand","qty":1,"type":"gear","mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Burst","trigger":"use"})),
            node("m","action.manual",json!({"block_id":"m","text":RULE})),
            node("d","action.roll",json!({"block_id":"d","kind":"damage","dice":{"count":1,"sides":6,"bonus":0,"stat":""}}))
        ], vec![link("p","m"), link("m","d")])}]});
        // Текст правила передаётся в графе как есть: спасбросок больше не генерируется автоматически.
        // Правило подтверждается игроком — без подтверждения сервер отказывает до любых эффектов.
        assert!(execute(&mut s,"item","w","use","",false).is_err());
        let r=execute(&mut s,"item","w","use","",true).unwrap();
        assert_eq!(s["hp"]["current"],20);
        assert_eq!(s["hp"]["temp"],0);
        let rolls=r["rolls"].as_array().unwrap();
        assert_eq!(rolls.len(),1);
        assert_eq!(rolls[0]["kind"],"damage");
        let effects=r["effects"].as_array().unwrap();
        assert_eq!(effects.len(),1);
        assert_eq!(effects[0]["kind"],"manual");
        assert_eq!(effects[0]["text"], RULE);
    }
    /// Ветка попадания считается только по броску и КД: чужой лист (тут AC 99) не участвует.
    #[test] fn hit_branch_uses_only_the_roll(){
        let mk=|dc:i64| json!({"hp":{"max":20,"current":10,"temp":0},"ac":99,"inventory":[{"uid":"w","name":"W","qty":1,"type":"gear","mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Hit","trigger":"use"})),
            node("a","action.roll",json!({"block_id":"a","kind":"attack","dc":dc,"dice":{"count":0,"sides":20,"bonus":5,"stat":""}})),
            node("hit","condition.hit",json!({})),
            node("f","flow.if",json!({})),
            node("heal","action.roll",json!({"block_id":"h","kind":"heal","dice":{"count":0,"sides":6,"bonus":7,"stat":""}}))
        ], vec![link("p","a"), link("a","f"), wire("hit","value","f","condition"), wire("f","then","heal","exec")])}]});
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
    #[test] fn formula_skips_zero_bonus(){ // Вид формулы совпадает с Mechanics.expression на клиенте: «1d20+@atk_str», «7», «@dex».
        assert_eq!(formula(&json!({"dice":{"count":1,"sides":20,"bonus":0,"stat":"atk_str"}})).unwrap(),"1d20+@atk_str");
        assert_eq!(formula(&json!({"dice":{"count":0,"sides":6,"bonus":7,"stat":""}})).unwrap(),"7");
        assert_eq!(formula(&json!({"dice":{"count":0,"sides":6,"bonus":0,"stat":"dex"}})).unwrap(),"@dex");
        assert_eq!(formula(&json!({"dice":{"count":2,"sides":6,"bonus":-1,"stat":""}})).unwrap(),"2d6-1");
        assert_eq!(formula(&json!({"dice":{"count":1,"sides":8,"bonus":0,"stat":""}})).unwrap(),"1d8");
        assert_eq!(formula(&json!({"dice":{"count":0,"sides":6,"bonus":0,"stat":""}})).unwrap(),"0");
        assert_eq!(formula(&json!({"dice":{"count":1,"sides":20,"bonus":0,"stat":"","advanced":"d20+5"}})).unwrap(),"d20+5");
    }
    /// Четыре программы одного предмета: бросок, условие по последнему результату, условие по
    /// конкретной программе и условие по полю листа.
    fn result_graph() -> Value {
        mech(vec![
            node("p1","action.program",json!({"program_id":"strike","name":"Удар","trigger":"use"})),
            node("a","action.roll",json!({"block_id":"a","kind":"attack","dc":0,"dice":{"count":0,"sides":20,"bonus":12,"stat":""}})),
            node("d","action.roll",json!({"block_id":"d","kind":"damage","dice":{"count":0,"sides":6,"bonus":12,"stat":""}})),
            node("p2","action.program",json!({"program_id":"follow","name":"После удара","trigger":"use"})),
            node("res","data.result",json!({"source":"last","field":"total"})),
            node("ten","data.number",json!({"value":10})),
            node("cmp","data.compare",json!({"op":">"})),
            node("f","action.field",json!({"block_id":"f","kind":"value","field":"speed","amount":1})),
            node("p3","action.program",json!({"program_id":"follow-program","name":"По программе","trigger":"use"})),
            node("res2","data.result",json!({"source":"strike","field":"total"})),
            node("ten2","data.number",json!({"value":10})),
            node("cmp2","data.compare",json!({"op":">"})),
            node("f2","action.field",json!({"block_id":"f2","kind":"value","field":"speed","amount":2})),
            node("p4","action.program",json!({"program_id":"sheet-check","name":"По листу","trigger":"use"})),
            node("sh","data.sheet",json!({"field":"hp.current"})),
            node("zero","data.number",json!({"value":0})),
            node("cmp3","data.compare",json!({"op":">"})),
            node("f3","action.field",json!({"block_id":"f3","kind":"value","field":"speed","amount":4})),
        ], vec![
            link("p1","a"), link("a","d"), link("p2","f"), link("p3","f2"), link("p4","f3"),
            wire("res","value","cmp","a"), wire("ten","value","cmp","b"), wire("cmp","value","f","condition"),
            wire("res2","value","cmp2","a"), wire("ten2","value","cmp2","b"), wire("cmp2","value","f2","condition"),
            wire("sh","value","cmp3","a"), wire("zero","value","cmp3","b"), wire("cmp3","value","f3","condition"),
        ])
    }
    /// Результат действия сохраняется в листе, а condition_src следующего действия читает его в рантайме.
    #[test] fn action_results_gate_the_next_action_in_the_runtime() {
        let mut s = json!({"hp":{"max":20,"current":10,"temp":0},"speed":30,
            "inventory":[{"uid":"w","name":"Клинок","qty":1,"type":"gear","mechanics": result_graph()}]});
        let r = execute(&mut s,"item","w","strike","",false).unwrap();
        assert_eq!(r["rolls"].as_array().unwrap().len(),2);
        assert_eq!(r["results"]["last"]["total"],12);
        let stored = &s["action_results"]["last"];
        assert_eq!(stored["total"],12);
        assert_eq!(stored["hit"],true,"попадание атаки хранится как bool в листе");
        assert_eq!(stored["applied"],0);
        assert_eq!(stored["spent"],0);
        assert_eq!(stored["rolls"],2);
        assert!(stored["at"].as_i64().unwrap()>0,"время выполнения в unix-секундах");
        assert_eq!(s["action_results"]["by_program"]["strike"]["total"],12);
        // last.total = 12 > 10 — блок выполняется.
        execute(&mut s,"item","w","follow","",false).unwrap();
        assert_eq!(s["speed"],31);
        assert_eq!(s["action_results"]["last"]["total"],0,"итог последнего действия без бросков");
        // Программа strike остаётся в by_program: follow-program читает именно её.
        execute(&mut s,"item","w","follow-program","",false).unwrap();
        assert_eq!(s["speed"],33);
        // last.total = 3 — блок пропускается, поток идёт дальше.
        s["action_results"]["last"] = json!({"total":3,"hit":null,"applied":0,"spent":0,"rolls":0,"at":0});
        execute(&mut s,"item","w","follow","",false).unwrap();
        assert_eq!(s["speed"],33,"условие ложно — показатель не изменился");
        // data.sheet: hp.current > 0 пропускает блок; 0 — нет.
        execute(&mut s,"item","w","sheet-check","",false).unwrap();
        assert_eq!(s["speed"],37);
        s["hp"]["current"] = json!(0);
        execute(&mut s,"item","w","sheet-check","",false).unwrap();
        assert_eq!(s["speed"],37,"отсутствующее условие по нулевому хиту блок не выполняет");
    }
    #[test] fn healing_does_not_include_proficiency(){let s=json!({"abilities":{"wis":16},"proficiency_bonus":4,"spells":{"ability":"wis"}});assert_eq!(inventory::resolve("1d8+@spell_mod",&s).unwrap(),"1d8+3");}
    #[test] fn program_modes_apply_to_d20_and_non_d20_rolls(){
        let attack=||json!({"features":[{"uid":"f","name":"Проверка","mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"p","name":"Бросок","trigger":"use"})),
            node("r","action.roll",json!({"block_id":"b","kind":"attack","dice":{"count":1,"sides":20,"bonus":5,"stat":"","advanced":"d20+5"}}))
        ], vec![link("p","r")])}]});
        for (mode,expected) in [("adv","2d20kh1+5"),("dis","2d20kl1+5")] {
            let mut sheet=attack();let result=execute(&mut sheet,"feature","f","p",mode,false).unwrap();
            assert_eq!(result["rolls"][0]["expr"],expected);
        }
        let generic=||json!({"hp":{"max":20,"current":0,"temp":0},"features":[{"uid":"f","name":"Проверка","mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"p","name":"Бросок","trigger":"use"})),
            node("d","action.roll",json!({"block_id":"d","kind":"damage","dice":{"count":1,"sides":8,"bonus":2,"stat":"","advanced":"d8+2"}})),
            node("h","action.roll",json!({"block_id":"h","kind":"heal","dice":{"count":1,"sides":4,"bonus":1,"stat":"","advanced":"d4+1"}}))
        ], vec![link("p","d"), link("d","h")])}]});
        for (mode,damage,heal) in [("adv","2d8kh1+2","2d4kh1+1"),("dis","2d8kl1+2","2d4kl1+1")] {
            let mut sheet=generic();let result=execute(&mut sheet,"feature","f","p",mode,false).unwrap();
            assert_eq!(result["rolls"][0]["expr"],damage);
            assert_eq!(result["rolls"][1]["expr"],heal);
        }
    }
    /// Действие с переменной области action: значение живёт только до конца выполнения.
    #[test] fn setvar_action_scope_is_visible_to_later_blocks_only() {
        let mut s = json!({"hp":{"max":20,"current":10,"temp":0},"speed":30,"features":[{"uid":"f","name":"Переменная","mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Переменная","trigger":"use"})),
            node("five","data.number",json!({"value":5})),
            node("sv","action.setvar",json!({"block_id":"sv","name":"tmp","scope":"action"})),
            node("v","data.var",json!({"name":"tmp","scope":"action"})),
            node("three","data.number",json!({"value":3})),
            node("cmp","data.compare",json!({"op":">"})),
            node("f","action.field",json!({"block_id":"f","kind":"value","field":"speed","amount":1})),
        ], vec![
            link("p","sv"), wire("five","value","sv","value"), link("sv","f"),
            wire("v","value","cmp","a"), wire("three","value","cmp","b"), wire("cmp","value","f","condition"),
        ])}]});
        execute(&mut s,"feature","f","use","",false).unwrap();
        assert_eq!(s["speed"],31,"условие читает переменную, записанную этим же действием");
        assert!(s.get("vars").is_none(),"переменная действия не сохраняется в лист");
        // План блока: имя и область из узла, статическая оценка провода и его источник для рантайма.
        let compiled = crate::mechanics_graph::to_v1(&s["features"][0]["mechanics"]);
        let block = &compiled["programs"][0]["blocks"][0];
        assert_eq!(block["kind"],"setvar");
        assert_eq!(block["name"],"tmp");
        assert_eq!(block["scope"],"action");
        assert_eq!(block["value"],5);
        assert_eq!(block["value_src"],"five");
    }
    /// Переменная области sheet сохраняется после execute и видна второй программе.
    #[test] fn setvar_sheet_scope_persists_for_the_next_program() {
        let mut s = json!({"hp":{"max":20,"current":10,"temp":0},"speed":30,"features":[{"uid":"f","name":"Переменная","mechanics": mech(vec![
            node("p1","action.program",json!({"program_id":"store","name":"Записать","trigger":"use"})),
            node("seven","data.number",json!({"value":7})),
            node("sv","action.setvar",json!({"block_id":"sv","name":"power","scope":"sheet"})),
            node("end1","flow.end",json!({})),
            node("p2","action.program",json!({"program_id":"read","name":"Прочитать","trigger":"use"})),
            node("v","data.var",json!({"name":"power","scope":"sheet"})),
            node("three","data.number",json!({"value":3})),
            node("cmp","data.compare",json!({"op":">"})),
            node("f","action.field",json!({"block_id":"f","kind":"value","field":"speed","amount":2})),
            node("end2","flow.end",json!({})),
        ], vec![
            link("p1","sv"), wire("seven","value","sv","value"), link("sv","end1"),
            link("p2","f"), wire("v","value","cmp","a"), wire("three","value","cmp","b"),
            wire("cmp","value","f","condition"), link("f","end2"),
        ])}]});
        execute(&mut s,"feature","f","store","",false).unwrap();
        assert_eq!(s["vars"]["power"],7.0,"sheet.vars сохраняется в лист");
        assert_eq!(s["speed"],30,"вторая программа ещё не выполнялась");
        execute(&mut s,"feature","f","read","",false).unwrap();
        assert_eq!(s["speed"],32,"вторая программа видит sheet-переменную первой");
        assert_eq!(s["vars"]["power"],7.0);
    }
    /// Математика одного числа: все восемь операций считаются при компиляции плана.
    #[test] fn mathfun_node_evaluates_every_operation() {
        let cases: &[(&str, f64, Option<f64>, Option<f64>, f64)] = &[
            ("abs", -4.0, None, None, 4.0),
            ("round", 2.5, None, None, 3.0),
            ("round", -2.5, None, None, -2.0),
            ("floor", 2.9, None, None, 2.0),
            ("ceil", 2.1, None, None, 3.0),
            ("sign", -9.0, None, None, -1.0),
            ("sign", 0.0, None, None, 0.0),
            ("min", 5.0, Some(3.0), None, 3.0),
            ("max", 5.0, Some(3.0), None, 5.0),
            ("clamp", 10.0, Some(0.0), Some(6.0), 6.0),
        ];
        for (op, a, b, c, expected) in cases {
            let mut nodes = vec![
                node("p","action.program",json!({"program_id":"use","name":"Математика","trigger":"use"})),
                node("a","data.number",json!({"value":a})),
                node("mf","data.mathfun",json!({"op":op})),
                node("sv","action.setvar",json!({"block_id":"sv","name":"x","scope":"action"})),
            ];
            let mut links = vec![link("p","sv"), wire("a","value","mf","a"), wire("mf","value","sv","value")];
            if let Some(b)=b { nodes.push(node("b","data.number",json!({"value":b}))); links.push(wire("b","value","mf","b")); }
            if let Some(c)=c { nodes.push(node("c","data.number",json!({"value":c}))); links.push(wire("c","value","mf","c")); }
            let graph = mech(nodes, links);
            let plan = crate::mechanics_graph::to_v1(&graph);
            let blocks = plan["programs"][0]["blocks"].as_array().unwrap();
            assert_eq!(blocks[0]["value"].as_f64(), Some(*expected), "операция {op}");
        }
        let unknown = mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Математика","trigger":"use"})),
            node("mf","data.mathfun",json!({"op":"root"})),
        ], vec![link("p","mf")]);
        assert!(crate::mechanics_graph::validate(&unknown).unwrap_err().1.contains("Математика"));
    }
    /// Ссылка на статический числовой узел работает при исполнении, а цикл ссылок отклоняется.
    #[test] fn data_ref_reads_a_number_and_rejects_cycles() {
        let mut s = json!({"hp":{"max":20,"current":10,"temp":0},"speed":30,"features":[{"uid":"f","name":"Ссылка","mechanics": mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Ссылка","trigger":"use"})),
            node("r","data.ref",json!({"node":"n"})),
            node("n","data.number",json!({"value":7})),
            node("sv","action.setvar",json!({"block_id":"sv","name":"x","scope":"sheet"})),
        ], vec![link("p","sv"), wire("r","value","sv","value")])}]});
        execute(&mut s,"feature","f","use","",false).unwrap();
        assert_eq!(s["vars"]["x"],7.0,"ссылка читает значение числового узла");
        let cycle = mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Ссылка","trigger":"use"})),
            node("r1","data.ref",json!({"node":"r2"})),
            node("r2","data.ref",json!({"node":"r1"})),
            node("end","flow.end",json!({})),
        ], vec![link("p","end")]);
        assert!(crate::mechanics_graph::validate(&cycle).unwrap_err().1.contains("Циклическая ссылка"));
        let self_ref = mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Ссылка","trigger":"use"})),
            node("r","data.ref",json!({"node":"r"})),
            node("end","flow.end",json!({})),
        ], vec![link("p","end")]);
        assert!(crate::mechanics_graph::validate(&self_ref).unwrap_err().1.contains("не может ссылаться на себя"));
        let missing = mech(vec![
            node("p","action.program",json!({"program_id":"use","name":"Ссылка","trigger":"use"})),
            node("r","data.ref",json!({"node":"ghost"})),
            node("end","flow.end",json!({})),
        ], vec![link("p","end")]);
        assert!(crate::mechanics_graph::validate(&missing).unwrap_err().1.contains("не найден"));
    }
}

#[cfg(test)]
mod graph_hit_tests {
    use super::*;
    use serde_json::json;

    /// Лист с предметом-графом: атака (КД задаёт тест) → «Попадание атаки» → урон. Бросок атаки детерминирован.
    /// Обе ветви «Если» и хвост цепочки сходятся в «Конце»: поток действия завершён.
    fn sheet_with(dc: i64) -> Value {
        json!({"hp": {"max": 20, "current": 10, "temp": 0}, "inventory": [{"uid": "w", "name": "Клинок", "qty": 1, "type": "gear", "mechanics": {"version": 2, "origin": "test", "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Удар", "trigger": "use"}, "position": {"x": 0, "y": 0}},
            {"id": "a", "type": "action.roll", "params": {"block_id": "atk", "kind": "attack", "enabled": true, "dice": {"count": 0, "sides": 20, "bonus": 5, "stat": ""}, "dc": dc}, "position": {"x": 260, "y": 0}},
            {"id": "h", "type": "condition.hit", "params": {}, "position": {"x": 520, "y": 120}},
            {"id": "f", "type": "flow.if", "params": {}, "position": {"x": 520, "y": 0}},
            {"id": "d", "type": "action.roll", "params": {"block_id": "dmg", "kind": "damage", "enabled": true, "dice": {"count": 0, "sides": 6, "bonus": 2, "stat": ""}}, "position": {"x": 780, "y": 0}},
            {"id": "e", "type": "flow.end", "params": {}, "position": {"x": 1040, "y": 0}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "a", "socket": "exec"}},
            {"from": {"node": "a", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}},
            {"from": {"node": "h", "socket": "value"}, "to": {"node": "f", "socket": "condition"}},
            {"from": {"node": "f", "socket": "then"}, "to": {"node": "d", "socket": "exec"}},
            {"from": {"node": "f", "socket": "else"}, "to": {"node": "e", "socket": "exec"}},
            {"from": {"node": "d", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}}}]})
    }

    /// Урон по кнопке исполняется только после попадания: при промахе второго броска нет.
    #[test]
    fn hit_chain_runs_damage_only_after_a_hit() {
        let mut hit = sheet_with(3);
        let r = execute(&mut hit, "item", "w", "use", "", false).unwrap();
        let rolls = r["rolls"].as_array().unwrap();
        assert_eq!(rolls.len(), 2);
        assert_eq!(rolls[0]["kind"], "attack");
        assert_eq!(rolls[1]["kind"], "damage");

        let mut miss = sheet_with(10);
        let r = execute(&mut miss, "item", "w", "use", "", false).unwrap();
        assert_eq!(r["rolls"].as_array().unwrap().len(), 1);
    }
}

#[cfg(test)]
mod spell_tests {
    use super::*;
    use super::tests::{link, mech, node};

    /// Заклинание: «Сотворить» → «Расход ячейки» (level 0) → урон с повышением круга.
    fn spell_mechanics(concentration: bool) -> Value {
        let mut nodes = vec![
            node("p", "action.program", json!({"program_id": "use", "name": "Сотворить", "trigger": "use"})),
            node("s", "action.slot", json!({"block_id": "s", "level": 0, "amount": 1})),
            node("d", "action.roll", json!({"block_id": "d", "kind": "damage",
                "dice": {"count": 2, "sides": 6, "bonus": 0, "stat": ""}, "upcast": {"count": 1, "sides": 6}})),
        ];
        let mut links = vec![link("p", "s"), link("s", "d")];
        if concentration {
            nodes.push(node("c", "action.field", json!({"block_id": "c", "kind": "status", "operation": "concentration", "condition": "", "target": "self"})));
            links = vec![link("p", "s"), link("s", "c"), link("c", "d")];
        }
        mech(nodes, links)
    }
    fn spell_sheet(level: i64, ritual: bool, concentration: bool, slots: Value, conditions: Value) -> Value {
        json!({
            "edition": "2014", "level": 5,
            "hp": {"max": 30, "current": 30, "temp": 0},
            "spells": {"ability": "int", "slots": slots, "known": [{
                "uid": "sp", "name": "Огненный шар", "level": level,
                "ritual": ritual, "concentration": concentration,
                "mechanics": spell_mechanics(concentration)
            }]},
            "conditions": conditions,
        })
    }
    /// Каст 2-го круга ячейкой 3-го: тратится ячейка 3-го, к урону добавляется кость повышения.
    #[test] fn spell_cast_spends_the_chosen_slot_and_adds_upcast_dice() {
        let mut s = spell_sheet(2, false, false, json!({"2": {"max": 1, "used": 0}, "3": {"max": 1, "used": 0}}), json!([]));
        let r = execute_with_slot(&mut s, "spell", "sp", "use", "", false, 3).unwrap();
        assert_eq!(s["spells"]["slots"]["3"]["used"], 1);
        assert_eq!(s["spells"]["slots"]["2"]["used"], 0);
        assert_eq!(r["cast"], json!({"level": 3, "base": 2, "extra": 1}));
        assert_eq!(r["rolls"][0]["expr"], "2d6+1d6", "2d6 + 1d6 за круг выше базового");
        assert_eq!(s["spells"]["slots"]["3"]["max"], 1);
        assert!(s.get("cast").is_none(), "лист не хранит контекст каста");
    }
    /// Каст без свободных ячеек — ошибка до любых изменений: лист остаётся прежним.
    #[test] fn spell_cast_without_slots_changes_nothing() {
        let mut s = spell_sheet(2, false, false, json!({"2": {"max": 0, "used": 0}, "3": {"max": 0, "used": 0}}), json!([]));
        let before = s.clone();
        assert!(execute_with_slot(&mut s, "spell", "sp", "use", "", false, 3).is_err());
        assert_eq!(s, before);
    }
    /// Ритуал: ячейка не тратится, в ответе есть эффект ритуала, круг каста — 0.
    #[test] fn ritual_cast_needs_no_slot() {
        let mut s = spell_sheet(2, true, false, json!({"2": {"max": 1, "used": 0}}), json!([]));
        let r = execute_with_slot(&mut s, "spell", "sp", "use", "", false, 0).unwrap();
        assert_eq!(s["spells"]["slots"]["2"]["used"], 0);
        assert_eq!(r["cast"]["level"], 0);
        assert!(r["effects"].as_array().unwrap().iter().any(|e| e["kind"] == "ritual"));
    }
    /// Ритуал пропускает и старый блок с фиксированным кругом: ячейка не тратится.
    #[test] fn ritual_skips_a_fixed_slot_block() {
        let mechanics = mech(vec![
            node("p", "action.program", json!({"program_id": "use", "name": "Сотворить", "trigger": "use"})),
            node("s", "action.slot", json!({"block_id": "s", "level": 2, "amount": 1})),
        ], vec![link("p", "s")]);
        let mut s = json!({"edition": "2014", "level": 5, "hp": {"max": 10, "current": 10, "temp": 0},
            "spells": {"ability": "int", "slots": {"2": {"max": 1, "used": 0}}, "known": [{
                "uid": "sp", "name": "Ритуал", "level": 2, "ritual": true, "mechanics": mechanics}]},
            "conditions": []});
        let r = execute_with_slot(&mut s, "spell", "sp", "use", "", false, 0).unwrap();
        assert_eq!(s["spells"]["slots"]["2"]["used"], 0);
        assert_eq!(r["cast"]["level"], 0);
        assert!(r["effects"].as_array().unwrap().iter().any(|e| e["kind"] == "ritual"));
    }
    /// Концентрация ставится после каста и заменяет прежнюю запись, чужие состояния не трогая.
    #[test] fn concentration_replaces_the_previous_spell() {
        let mut s = spell_sheet(2, false, true, json!({"2": {"max": 1, "used": 0}}), json!(["Концентрация: Старое", "Отравленный"]));
        execute_with_slot(&mut s, "spell", "sp", "use", "", false, 2).unwrap();
        assert_eq!(s["conditions"], json!(["Отравленный", "Концентрация: Огненный шар"]));
    }
    /// Заклинание без концентрации не трогает состояния.
    #[test] fn non_concentration_spell_keeps_conditions() {
        let mut s = spell_sheet(2, false, false, json!({"2": {"max": 1, "used": 0}}), json!(["Концентрация: Старое"]));
        execute_with_slot(&mut s, "spell", "sp", "use", "", false, 2).unwrap();
        assert_eq!(s["conditions"], json!(["Концентрация: Старое"]));
    }
}
