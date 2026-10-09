//! Validation and compatibility compilation for the closed mechanics graph v2 schema.
//! No user supplied expression is executed. This mirrors static/mechanics-graph.js.
use crate::{error::ApiResult, AppError};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

fn bad(message: &str) -> AppError { AppError::bad(message) }
fn utf16_len(value: &str) -> usize { value.encode_utf16().count() }
fn json_integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0 && *number >= i64::MIN as f64 && *number <= i64::MAX as f64).map(|number| number as i64))
}
const ABILITIES: &[&str] = &["str", "dex", "con", "int", "wis", "cha"];
const ACTIONS: &[&str] = &["consume", "attack", "damage", "heal", "temp_hp", "roll", "grant_item", "condition", "adjust", "require", "manual", "passive"];
const SOCKET_TYPES: &[&str] = &["flow", "bool", "number", "dice", "ability", "text", "list", "table", "choice", "effect"];

type Ports = (HashMap<String, String>, HashMap<String, String>);
fn ports_for(kind: &str, params: &Value, groups: &[Value], owner_group: Option<&Value>) -> Ports {
    let mut inputs = HashMap::new();
    let mut outputs = HashMap::new();
    match kind {
        "data.number" => { outputs.insert("value".into(), "number".into()); }
        "data.dice" => { outputs.insert("value".into(), "dice".into()); }
        "data.ability" => { outputs.insert("value".into(), "ability".into()); }
        "data.table" => { outputs.insert("value".into(), "table".into()); }
        "data.choice" => { outputs.insert("value".into(), "choice".into()); }
        "data.text" => { outputs.insert("value".into(), "text".into()); }
        "condition.edition" | "condition.level" | "condition.subclass" | "condition.choice" => { outputs.insert("value".into(), "bool".into()); }
        "flow.if" => { inputs.insert("exec".into(), "flow".into()); inputs.insert("condition".into(), "bool".into()); outputs.insert("then".into(), "flow".into()); outputs.insert("else".into(), "flow".into()); }
        "rule.ability_bonus" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("amount".into(), "number".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.speed" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("value".into(), "number".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.languages" | "rule.proficiencies" | "rule.saving_throws" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("value".into(), "list".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.hit_die" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("value".into(), "text".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.feature" => { inputs.insert("enabled".into(), "bool".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.skills" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("options".into(), "list".into()); inputs.insert("count".into(), "number".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.spell_list" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("spells".into(), "list".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.spell_slots" | "rule.asi" | "rule.class_progression" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("table".into(), "table".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.armor_formula" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("formula".into(), "text".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.hp_bonus" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("amount".into(), "number".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.manual" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("text".into(), "text".into()); outputs.insert("effect".into(), "effect".into()); }
        "action.program" => { outputs.insert("exec".into(), "flow".into()); }
        x if x.starts_with("action.") && ACTIONS.contains(&&x[7..]) => { inputs.insert("exec".into(), "flow".into()); inputs.insert("enabled".into(), "bool".into()); outputs.insert("exec".into(), "flow".into()); }
        "group.instance" => {
            let id = params["group_id"].as_str().unwrap_or("");
            if let Some(g) = groups.iter().find(|g| g["id"] == id) {
                for s in g["inputs"].as_array().into_iter().flatten() { if let (Some(id), Some(t)) = (s["id"].as_str(), s["type"].as_str()) { inputs.insert(id.into(), t.into()); } }
                for s in g["outputs"].as_array().into_iter().flatten() { if let (Some(id), Some(t)) = (s["id"].as_str(), s["type"].as_str()) { outputs.insert(id.into(), t.into()); } }
            }
        }
        "group.input" => {
            let socket_id = params["socket_id"].as_str().unwrap_or("");
            if let Some(socket) = owner_group.and_then(|g| g["inputs"].as_array()).into_iter().flatten().find(|s| s["id"] == socket_id) {
                if let Some(t) = socket["type"].as_str() { outputs.insert("value".into(), t.into()); }
            }
        }
        "group.output" => {
            let socket_id = params["socket_id"].as_str().unwrap_or("");
            if let Some(socket) = owner_group.and_then(|g| g["outputs"].as_array()).into_iter().flatten().find(|s| s["id"] == socket_id) {
                if let Some(t) = socket["type"].as_str() { inputs.insert("value".into(), t.into()); }
            }
        }
        _ => {}
    }
    (inputs, outputs)
}
fn valid_id(v: &Value, limit: usize) -> bool { v.as_str().map(|s| !s.is_empty() && utf16_len(s) <= limit).unwrap_or(false) }
fn valid_string_list(value: &Value, max_items: usize, max_length: usize) -> bool {
    value.as_array().map(|items| items.len() <= max_items && items.iter().all(|item| item.as_str().map(|text| utf16_len(text) <= max_length).unwrap_or(false))).unwrap_or(false)
}
fn valid_json_object(value: &Value, max_length: usize) -> bool { value.is_object() && utf16_len(&value.to_string()) <= max_length }
fn check_interface(value: &Value) -> ApiResult<()> {
    let items = value.as_array().filter(|xs| xs.len() <= 16).ok_or_else(|| bad("Интерфейс группы: не более 16 сокетов."))?;
    let mut ids = HashSet::new();
    for s in items {
        let id = s["id"].as_str().unwrap_or("");
        let kind = s["type"].as_str().unwrap_or("");
        if id.is_empty() || utf16_len(id) > 64 || !ids.insert(id.to_string()) || s["name"].as_str().unwrap_or("").trim().is_empty() || utf16_len(s["name"].as_str().unwrap_or("")) > 100 || !SOCKET_TYPES.contains(&kind) {
            return Err(bad("Некорректный типизированный сокет группы."));
        }
    }
    Ok(())
}
fn validate_node_params(n: &Value) -> ApiResult<()> {
    let p = &n["params"];
    let kind = n["type"].as_str().unwrap_or("");
    match kind {
        "data.number" if !p["value"].as_f64().map(|number| number.is_finite()).unwrap_or(false) => return Err(bad("Числовой узел должен содержать конечное число.")),
        "data.dice" => {
            let value = &p["value"];
            let count = json_integer(&value["count"]).unwrap_or(-1); let sides = json_integer(&value["sides"]).unwrap_or(-1);
            let bonus = match value.get("bonus") { None | Some(Value::Null) => 0, Some(value) => json_integer(value).unwrap_or(i64::MAX) };
            let stat = match value.get("stat") { None | Some(Value::Null) => "", Some(value) => value.as_str().unwrap_or("\0") };
            if !value.is_object() || !(0..=100).contains(&count) || !(1..=1000).contains(&sides) || !(-1_000_000..=1_000_000).contains(&bonus) || !["", "str", "dex", "con", "int", "wis", "cha", "best", "prof", "atk", "atk_str", "atk_dex", "spell", "spell_mod", "level", "dc"].contains(&stat) { return Err(bad("Узел кости должен содержать количество и грани.")); }
        }
        "data.ability" if !ABILITIES.contains(&p["value"].as_str().unwrap_or("")) => return Err(bad("Выберите характеристику из закрытого списка.")),
        "data.table" | "data.choice" if !p["value"].is_object() => return Err(bad("Табличный или выборный узел должен содержать JSON-объект.")),
        "data.text" if p["value"].as_str().is_none() || utf16_len(p["value"].as_str().unwrap_or("")) > 4000 => return Err(bad("Текстовый узел: до 4000 символов.")),
        "condition.edition" => {
            let editions = p["editions"].as_array().filter(|a| !a.is_empty()).ok_or_else(|| bad("Условие редакции: один или несколько допустимых SRD."))?;
            if editions.iter().any(|x| !["2014", "2024"].contains(&x.as_str().unwrap_or(""))) { return Err(bad("Условие редакции: один или несколько допустимых SRD.")); }
        }
        "condition.level" => {
            let min = json_integer(&p["min"]).unwrap_or(0); let max = json_integer(&p["max"]).unwrap_or(0);
            if min < 1 || max > 20 || min > max { return Err(bad("Условие уровня: диапазон 1–20.")); }
        }
        "condition.subclass" if !valid_id(&p["id"], 100) => return Err(bad("Укажите ID подкласса в условии.")),
        "condition.choice" if !valid_id(&p["id"], 100) || p.get("value").is_none() => return Err(bad("Укажите ID группы и сравниваемый выбор.")),
        "flow.if" if p.as_object().map(|object| object.len() > 8).unwrap_or(false) => return Err(bad("Условный узел содержит лишние параметры.")),
        "action.program" => {
            if !valid_id(&p["program_id"], 100) || p["name"].as_str().unwrap_or("").trim().is_empty() || utf16_len(p["name"].as_str().unwrap_or("")) > 120 || !["use", "passive"].contains(&p["trigger"].as_str().unwrap_or("")) {
                return Err(bad("Программе нужны ID, название и допустимый триггер."));
            }
        }
        "group.instance" if !valid_id(&p["group_id"], 64) => return Err(bad("Узел группы требует ID группы.")),
        "group.input" | "group.output" if !valid_id(&p["socket_id"], 64) => return Err(bad("Узел границы группы должен ссылаться на сокет интерфейса.")),
        "rule.ability_bonus" => {
            if !ABILITIES.contains(&p["ability"].as_str().unwrap_or("")) || p.get("amount").map(|value| value.as_f64().map(|number| number.is_finite() && number.abs() <= 1000.0).unwrap_or(false) == false).unwrap_or(false) { return Err(bad("Бонус характеристики требует существующий ключ характеристики и конечную величину.")); }
        }
        "rule.speed" if p.get("value").is_some() && json_integer(&p["value"]).map(|value| !(0..=1000).contains(&value)).unwrap_or(true) => return Err(bad("Скорость должна быть целым числом от 0 до 1000.")),
        "rule.languages" if p.get("value").is_some() && !valid_string_list(&p["value"], 100, 200) => return Err(bad("Языки должны быть списком текстовых значений.")),
        "rule.proficiencies" if (p.get("value").is_some() && !valid_string_list(&p["value"], 100, 200)) || (p.get("kind").is_some() && (p["kind"].as_str().is_none() || utf16_len(p["kind"].as_str().unwrap_or("")) > 120)) => return Err(bad("Владения должны быть списком и иметь короткий тип.")),
        "rule.hit_die" if p.get("value").is_some() && !["d6", "d8", "d10", "d12"].contains(&p["value"].as_str().unwrap_or("")) => return Err(bad("Кость хитов: d6, d8, d10 или d12.")),
        "rule.saving_throws" => {
            if p.get("value").is_some() && (!p["value"].as_array().map(|values| values.len() <= 6 && values.iter().all(|value| ABILITIES.contains(&value.as_str().unwrap_or("")))).unwrap_or(false)) { return Err(bad("Спасброски должны быть списком характеристик.")); }
        }
        "rule.feature" if p["name"].as_str().unwrap_or("").trim().is_empty() || utf16_len(p["name"].as_str().unwrap_or("")) > 120 || (p.get("text").is_some() && (p["text"].as_str().is_none() || utf16_len(p["text"].as_str().unwrap_or("")) > 4000)) => return Err(bad("Умение: название до 120 и текст до 4000 символов.")),
        "rule.skills" => {
            if !valid_id(&p["id"], 100) || json_integer(&p["count"]).map(|n| !(0..=18).contains(&n)).unwrap_or(true) || !valid_string_list(&p["options"], 18, 200) { return Err(bad("Выбор навыков: ID, список до 18 и количество от 0 до 18.")); }
        }
        "rule.spell_list" => {
            if !["known", "prepared", "book"].contains(&p["mode"].as_str().unwrap_or("")) || (p.get("ability").is_some() && !ABILITIES.contains(&p["ability"].as_str().unwrap_or(""))) || !valid_string_list(&p["spells"], 100, 200) { return Err(bad("Список заклинаний: режим, список и характеристика должны быть допустимы.")); }
        }
        "rule.spell_slots" | "rule.asi" | "rule.class_progression" if p.get("table").is_some() && !valid_json_object(&p["table"], 100_000) => return Err(bad("Табличное правило должно содержать ограниченный JSON-объект.")),
        "rule.armor_formula" => {
            let formula = p["formula"].as_str().unwrap_or("");
            if formula.is_empty() || utf16_len(formula) > 100 || !formula.chars().all(|c| c.is_ascii_alphanumeric() || "+-*@_(), . \t\r\n".contains(c)) { return Err(bad("Формула защиты без доспехов содержит только числа, характеристики, min/max и арифметические символы.")); }
            if p.get("name").is_some() && (p["name"].as_str().is_none() || utf16_len(p["name"].as_str().unwrap_or("")) > 120) { return Err(bad("Название защиты без доспехов: строка до 120 символов.")); }
            if p.get("no_shield").is_some() && !p["no_shield"].is_boolean() { return Err(bad("Запрет щита: логическое значение.")); }
        }
        "rule.hp_bonus" if p.get("amount").is_some() && json_integer(&p["amount"]).map(|n| n < -1000 || n > 1000).unwrap_or(true) => return Err(bad("Бонус хитов: целое от −1000 до 1000.")),
        "rule.manual" if p["text"].as_str().is_none() || utf16_len(p["text"].as_str().unwrap_or("")) > 4000 => return Err(bad("Ручное правило: до 4000 символов.")),
        _ => {}
    }
    if kind.starts_with("action.") && kind != "action.program" {
        if !valid_id(&p["block_id"], 100) { return Err(bad("Узел действия должен иметь стабильный block_id.")); }
    }
    Ok(())
}
fn validate_graph(graph: &Value, groups: &[Value], nested: bool, owner_group: Option<&Value>) -> ApiResult<()> {
    if !graph.is_object() { return Err(bad("Граф должен быть объектом.")); }
    let nodes = graph["nodes"].as_array().filter(|a| a.len() <= 500).ok_or_else(|| bad("Размер графа вне допустимых пределов."))?;
    let links = graph["links"].as_array().filter(|a| a.len() <= 2000).ok_or_else(|| bad("Размер графа вне допустимых пределов."))?;
    let frames = match graph.get("frames") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Vec::new(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => Vec::new(),
        Some(Value::String(value)) if value.is_empty() => Vec::new(),
        Some(Value::Array(values)) => values.clone(),
        Some(_) => return Err(bad("Размер графа вне допустимых пределов.")),
    };
    if frames.len() > 100 { return Err(bad("Размер графа вне допустимых пределов.")); }
    let mut node_ids = HashSet::new();
    for n in nodes {
        let id = n["id"].as_str().unwrap_or(""); let kind = n["type"].as_str().unwrap_or("");
        if id.is_empty() || utf16_len(id) > 100 || !node_ids.insert(id.to_string()) || !NODE_TYPES.contains(&kind) { return Err(bad("Неизвестный узел или повторяющийся ID.")); }
        if let Some(p) = n.get("params") { if !p.is_object() || utf16_len(&p.to_string()) > 100_000 { return Err(bad("Параметры узла должны быть ограниченным JSON-объектом.")); } }
        if let Some(pos) = n.get("position") { if !pos["x"].as_f64().map(|x| x.is_finite() && x.abs() <= 100_000.0).unwrap_or(false) || !pos["y"].as_f64().map(|x| x.is_finite() && x.abs() <= 100_000.0).unwrap_or(false) { return Err(bad("Координаты узла вне допустимых пределов.")); } }
        if kind == "group.instance" && !groups.iter().any(|g| g["id"] == n["params"]["group_id"]) { return Err(bad("Узел ссылается на отсутствующую группу.")); }
        if ["group.input", "group.output"].contains(&kind) && (!nested || owner_group.is_none()) { return Err(bad("Узлы интерфейса группы разрешены только внутри повторно используемой группы.")); }
        validate_node_params(n)?;
    }
    let mut indegree: HashMap<String, usize> = node_ids.iter().map(|x| (x.clone(), 0)).collect();
    let mut adjacency: HashMap<String, Vec<String>> = node_ids.iter().map(|x| (x.clone(), Vec::new())).collect();
    let mut incoming = HashSet::new(); let mut edge_ids = HashSet::new();
    for link in links {
        let from = &link["from"]; let to = &link["to"];
        let source = from["node"].as_str().unwrap_or(""); let target = to["node"].as_str().unwrap_or("");
        let out_socket = from["socket"].as_str().unwrap_or(""); let in_socket = to["socket"].as_str().unwrap_or("");
        if !node_ids.contains(source) || !node_ids.contains(target) { return Err(bad("Провод указывает на отсутствующий узел.")); }
        let from_node = nodes.iter().find(|n| n["id"] == source).unwrap(); let to_node = nodes.iter().find(|n| n["id"] == target).unwrap();
        let (_, outs) = ports_for(from_node["type"].as_str().unwrap_or(""), &from_node["params"], groups, owner_group);
        let (ins, _) = ports_for(to_node["type"].as_str().unwrap_or(""), &to_node["params"], groups, owner_group);
        let out_type = outs.get(out_socket).ok_or_else(|| bad("Провод подключён к отсутствующему сокету."))?;
        let in_type = ins.get(in_socket).ok_or_else(|| bad("Провод подключён к отсутствующему сокету."))?;
        if out_type != in_type { return Err(bad("Типы сокетов провода не совпадают.")); }
        let key = format!("{target}:{in_socket}");
        if !incoming.insert(key) { return Err(bad("К каждому входному сокету подключается только один провод.")); }
        let edge_key = format!("{source}:{out_socket}>{target}:{in_socket}");
        if !edge_ids.insert(edge_key) { return Err(bad("Повторяющийся провод.")); }
        adjacency.get_mut(source).unwrap().push(target.to_string()); *indegree.get_mut(target).unwrap() += 1;
    }
    for node in nodes { if node["type"] == "flow.if" && !incoming.contains(&format!("{}:condition", node["id"].as_str().unwrap_or(""))) { return Err(bad("Условному узлу требуется типизированное логическое условие.")); } }
    let mut queue: VecDeque<String> = indegree.iter().filter(|(_, d)| **d == 0).map(|(id, _)| id.clone()).collect(); let mut visited = 0;
    while let Some(current) = queue.pop_front() { visited += 1; for target in adjacency.get(&current).into_iter().flatten() { let d = indegree.get_mut(target).unwrap(); *d -= 1; if *d == 0 { queue.push_back(target.clone()); } } }
    if visited != node_ids.len() { return Err(bad("Цикл в графе запрещён.")); }
    let mut frame_ids = HashSet::new(); let mut framed_nodes = HashSet::new();
    for frame in frames {
        let id = frame["id"].as_str().unwrap_or(""); let title = frame["title"].as_str().unwrap_or("");
        let members = frame["nodes"].as_array().filter(|a| a.len() <= 100).ok_or_else(|| bad("Некорректная рамка графа."))?;
        if id.is_empty() || utf16_len(id) > 64 || !frame_ids.insert(id.to_string()) || title.trim().is_empty() || utf16_len(title) > 120 { return Err(bad("Некорректная рамка графа."));}
        for member in members { let node = member.as_str().unwrap_or(""); if !node_ids.contains(node) || !framed_nodes.insert(node.to_string()) { return Err(bad("Рамка содержит отсутствующий или повторный узел.")); } }
    }
    Ok(())
}
const NODE_TYPES: &[&str] = &[
    "data.number", "data.dice", "data.ability", "data.table", "data.choice", "data.text",
    "condition.edition", "condition.level", "condition.subclass", "condition.choice", "flow.if",
    "rule.ability_bonus", "rule.speed", "rule.languages", "rule.proficiencies", "rule.hit_die", "rule.saving_throws", "rule.feature", "rule.skills", "rule.spell_list", "rule.spell_slots", "rule.asi", "rule.class_progression", "rule.armor_formula", "rule.hp_bonus", "rule.manual",
    "action.program", "action.consume", "action.attack", "action.damage", "action.heal", "action.temp_hp", "action.roll", "action.grant_item", "action.condition", "action.adjust", "action.require", "action.manual", "action.passive", "group.instance", "group.input", "group.output",
];

fn group_boundaries_match(group: &Value) -> bool {
    for (interface_key, node_kind) in [("inputs", "group.input"), ("outputs", "group.output")] {
        let mut expected: Vec<String> = group[interface_key].as_array().into_iter().flatten().filter_map(|s| s["id"].as_str().map(str::to_string)).collect();
        let mut actual: Vec<String> = group["nodes"].as_array().into_iter().flatten().filter(|n| n["type"] == node_kind).filter_map(|n| n["params"]["socket_id"].as_str().map(str::to_string)).collect();
        expected.sort(); actual.sort();
        if expected != actual { return false; }
    }
    true
}
fn group_cycle(groups: &[Value]) -> bool {
    let mut refs: HashMap<String, Vec<String>> = HashMap::new();
    for g in groups {
        let id = g["id"].as_str().unwrap_or("").to_string();
        let ids = g["nodes"].as_array().into_iter().flatten().filter(|n| n["type"] == "group.instance").map(|n| n["params"]["group_id"].as_str().unwrap_or("").to_string()).collect();
        refs.insert(id, ids);
    }
    fn visit(id: &str, refs: &HashMap<String, Vec<String>>, visiting: &mut HashSet<String>, done: &mut HashSet<String>) -> bool {
        if visiting.contains(id) { return false; }
        if done.contains(id) { return true; }
        visiting.insert(id.to_string());
        for next in refs.get(id).into_iter().flatten() { if !refs.contains_key(next) || !visit(next, refs, visiting, done) { return false; } }
        visiting.remove(id); done.insert(id.to_string()); true
    }
    let mut visiting = HashSet::new(); let mut done = HashSet::new();
    refs.keys().all(|id| visit(id, &refs, &mut visiting, &mut done))
}

pub fn validate(mechanics: &Value) -> ApiResult<()> {
    if mechanics["version"] != 2 || utf16_len(&mechanics.to_string()) > 1_000_000 { return Err(bad("Неподдерживаемая или слишком большая схема механик.")); }
    let graph = &mechanics["graph"];
    let groups = graph["groups"].as_array().filter(|a| a.len() <= 50).ok_or_else(|| bad("Не более 50 групп повторного использования."))?;
    let mut group_ids = HashSet::new();
    for g in groups {
        let id = g["id"].as_str().unwrap_or(""); let name = g["name"].as_str().unwrap_or("");
        if id.is_empty() || utf16_len(id) > 64 || !group_ids.insert(id.to_string()) || name.trim().is_empty() || utf16_len(name) > 120 { return Err(bad("Некорректная группа повторного использования.")); }
        check_interface(&g["inputs"])?; check_interface(&g["outputs"])?;
        if !g["nodes"].is_array() || !g["links"].is_array() { return Err(bad("У группы должны быть свои nodes и links.")); }
        let mut inner = json!({"nodes":g["nodes"],"links":g["links"],"frames":g.get("frames").cloned().unwrap_or(json!([]))});
        if inner["frames"].is_null() { inner["frames"] = json!([]); }
        validate_graph(&inner, groups, true, Some(g))?;
        if !group_boundaries_match(g) { return Err(bad("Порты группы должны иметь по одному соответствующему узлу входа/выхода.")); }
    }
    if !group_cycle(groups) { return Err(bad("Рекурсивная ссылка или цикл между группами запрещён.")); }
    validate_graph(graph, groups, false, None)
}

struct GraphContext {
    nodes: Vec<Value>,
    links: Vec<Value>,
    prefix: String,
    owner_instance: Option<String>,
    children: HashMap<String, Box<GraphContext>>,
}
type Endpoint = (String, String);
fn build_context(graph: &Value, groups: &[Value], prefix: String, owner_instance: Option<String>, stack: &mut Vec<String>) -> GraphContext {
    let nodes = graph["nodes"].as_array().cloned().unwrap_or_default();
    let links = graph["links"].as_array().cloned().unwrap_or_default();
    let mut children = HashMap::new();
    for node in &nodes {
        if node["type"] != "group.instance" { continue; }
        let group_id = node["params"]["group_id"].as_str().unwrap_or("");
        if stack.iter().any(|item| item == group_id) { continue; }
        let Some(group) = groups.iter().find(|group| group["id"] == group_id) else { continue; };
        let instance_id = node["id"].as_str().unwrap_or("").to_string();
        stack.push(group_id.to_string());
        let child = build_context(group, groups, format!("{}{}/", prefix, instance_id), Some(instance_id.clone()), stack);
        stack.pop();
        children.insert(instance_id, Box::new(child));
    }
    GraphContext { nodes, links, prefix, owner_instance, children }
}
fn resolve_source(path: &[&GraphContext], node_id: &str, socket: &str, depth: usize) -> Vec<Endpoint> {
    if depth > 100 { return Vec::new(); }
    let Some(ctx) = path.last().copied() else { return Vec::new(); };
    let Some(node) = ctx.nodes.iter().find(|node| node["id"] == node_id) else { return Vec::new(); };
    match node["type"].as_str().unwrap_or("") {
        "group.input" => {
            if path.len() < 2 { return Vec::new(); }
            let parent = path[path.len() - 2];
            let socket_id = node["params"]["socket_id"].as_str().unwrap_or("");
            let instance_id = ctx.owner_instance.as_deref().unwrap_or("");
            let outer = parent.links.iter().find(|link| link["to"]["node"] == instance_id && link["to"]["socket"] == socket_id);
            if let Some(link) = outer { resolve_source(&path[..path.len() - 1], link["from"]["node"].as_str().unwrap_or(""), link["from"]["socket"].as_str().unwrap_or(""), depth + 1) } else { Vec::new() }
        }
        "group.instance" => {
            let Some(child) = ctx.children.get(node_id).map(Box::as_ref) else { return Vec::new(); };
            let Some(output) = child.nodes.iter().find(|item| item["type"] == "group.output" && item["params"]["socket_id"] == socket) else { return Vec::new(); };
            let output_id = output["id"].as_str().unwrap_or("");
            let Some(inner) = child.links.iter().find(|link| link["to"]["node"] == output_id && link["to"]["socket"] == "value") else { return Vec::new(); };
            let mut child_path = path.to_vec(); child_path.push(child);
            resolve_source(&child_path, inner["from"]["node"].as_str().unwrap_or(""), inner["from"]["socket"].as_str().unwrap_or(""), depth + 1)
        }
        "group.output" => Vec::new(),
        _ => vec![(format!("{}{}", ctx.prefix, node_id), socket.to_string())],
    }
}
fn resolve_target(path: &[&GraphContext], node_id: &str, socket: &str, depth: usize) -> Vec<Endpoint> {
    if depth > 100 { return Vec::new(); }
    let Some(ctx) = path.last().copied() else { return Vec::new(); };
    let Some(node) = ctx.nodes.iter().find(|node| node["id"] == node_id) else { return Vec::new(); };
    match node["type"].as_str().unwrap_or("") {
        "group.output" => {
            if path.len() < 2 { return Vec::new(); }
            let parent = path[path.len() - 2];
            let socket_id = node["params"]["socket_id"].as_str().unwrap_or("");
            let instance_id = ctx.owner_instance.as_deref().unwrap_or("");
            let outer = parent.links.iter().find(|link| link["from"]["node"] == instance_id && link["from"]["socket"] == socket_id);
            if let Some(link) = outer { resolve_target(&path[..path.len() - 1], link["to"]["node"].as_str().unwrap_or(""), link["to"]["socket"].as_str().unwrap_or(""), depth + 1) } else { Vec::new() }
        }
        "group.instance" => {
            let Some(child) = ctx.children.get(node_id).map(Box::as_ref) else { return Vec::new(); };
            let Some(input) = child.nodes.iter().find(|item| item["type"] == "group.input" && item["params"]["socket_id"] == socket) else { return Vec::new(); };
            let input_id = input["id"].as_str().unwrap_or("");
            let mut result = Vec::new();
            let mut child_path = path.to_vec(); child_path.push(child);
            for inner in child.links.iter().filter(|link| link["from"]["node"] == input_id && link["from"]["socket"] == "value") {
                result.extend(resolve_target(&child_path, inner["to"]["node"].as_str().unwrap_or(""), inner["to"]["socket"].as_str().unwrap_or(""), depth + 1));
            }
            result
        }
        "group.input" => Vec::new(),
        _ => vec![(format!("{}{}", ctx.prefix, node_id), socket.to_string())],
    }
}
fn collect_context(ctx: &GraphContext, path: &[&GraphContext], out_nodes: &mut Vec<Value>, out_links: &mut Vec<Value>) {
    for node in &ctx.nodes {
        match node["type"].as_str().unwrap_or("") {
            "group.instance" => { if let Some(child) = ctx.children.get(node["id"].as_str().unwrap_or("")) { let child = child.as_ref(); let mut child_path = path.to_vec(); child_path.push(child); collect_context(child, &child_path, out_nodes, out_links); } }
            "group.input" | "group.output" => {}
            _ => { let mut expanded = node.clone(); if let Some(object) = expanded.as_object_mut() { object.insert("id".into(), json!(format!("{}{}", ctx.prefix, node["id"].as_str().unwrap_or("")))); } out_nodes.push(expanded); }
        }
    }
    for link in &ctx.links {
        let from_id = link["from"]["node"].as_str().unwrap_or(""); let to_id = link["to"]["node"].as_str().unwrap_or("");
        let from_kind = ctx.nodes.iter().find(|node| node["id"] == from_id).map(|node| node["type"].as_str().unwrap_or(""));
        let to_kind = ctx.nodes.iter().find(|node| node["id"] == to_id).map(|node| node["type"].as_str().unwrap_or(""));
        if matches!(from_kind, Some("group.input" | "group.output")) || matches!(to_kind, Some("group.input" | "group.output")) { continue; }
        let sources = resolve_source(path, from_id, link["from"]["socket"].as_str().unwrap_or(""), 0);
        let targets = resolve_target(path, to_id, link["to"]["socket"].as_str().unwrap_or(""), 0);
        for (source_id, source_socket) in &sources { for (target_id, target_socket) in &targets {
            out_links.push(json!({"from":{"node":source_id,"socket":source_socket},"to":{"node":target_id,"socket":target_socket}}));
        }}
    }
}
fn expand_graph(graph: &Value, groups: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let root = build_context(graph, groups, String::new(), None, &mut Vec::new());
    let mut nodes = Vec::new(); let mut links = Vec::new();
    collect_context(&root, &[&root], &mut nodes, &mut links);
    (nodes, links)
}

fn graph_output_value(endpoint: &Endpoint, nodes: &HashMap<String, &Value>, context: &Value) -> Option<Value> {
    let node = nodes.get(&endpoint.0)?; let params = &node["params"];
    match node["type"].as_str().unwrap_or("") {
        kind if kind.starts_with("data.") => params.get("value").cloned(),
        "condition.edition" => {
            let edition = context.get("edition")?.as_str()?;
            Some(json!(params["editions"].as_array().into_iter().flatten().any(|item| item.as_str() == Some(edition))))
        }
        "condition.level" => {
            let level = context.get("level")?.as_i64()?;
            Some(json!(level >= params["min"].as_i64()? && level <= params["max"].as_i64()?))
        }
        "condition.subclass" => Some(json!(context.get("subclass")? == &params["id"])),
        "condition.choice" => {
            let choices = context.get("choices")?.as_object()?;
            let id = params["id"].as_str()?;
            Some(json!(choices.get(id).map(|value| value == &params["value"]).unwrap_or(false)))
        }
        _ => None,
    }
}
fn graph_input_value(node: &Value, socket: &str, incoming: &HashMap<(String, String), Endpoint>, nodes: &HashMap<String, &Value>, context: &Value, fallback: Option<Value>) -> Option<Value> {
    let key = (node["id"].as_str().unwrap_or("").to_string(), socket.to_string());
    if let Some(source) = incoming.get(&key) { graph_output_value(source, nodes, context) } else { fallback }
}
pub fn to_v1(mechanics: &Value) -> Value { to_v1_with_context(mechanics, &Value::Null) }
pub fn to_v1_with_context(mechanics: &Value, context: &Value) -> Value {
    if mechanics["version"] != 2 { return mechanics.clone(); }
    let graph = &mechanics["graph"];
    let groups = graph["groups"].as_array().cloned().unwrap_or_default();
    let (expanded_nodes, links) = expand_graph(graph, &groups);
    let nodes: HashMap<String, &Value> = expanded_nodes.iter().filter_map(|node| node["id"].as_str().map(|id| (id.to_string(), node))).collect();
    let mut outgoing: HashMap<(String, String), Vec<Endpoint>> = HashMap::new();
    let mut incoming: HashMap<(String, String), Endpoint> = HashMap::new();
    for link in &links {
        let from = (link["from"]["node"].as_str().unwrap_or("").to_string(), link["from"]["socket"].as_str().unwrap_or("").to_string());
        let to = (link["to"]["node"].as_str().unwrap_or("").to_string(), link["to"]["socket"].as_str().unwrap_or("").to_string());
        outgoing.entry(from).or_default().push(to.clone()); incoming.insert(to, from_endpoint(link));
    }
    let mut programs = Vec::new();
    for node in expanded_nodes.iter().filter(|node| node["type"] == "action.program") {
        let params = &node["params"]; let id = params["program_id"].as_str().unwrap_or(node["id"].as_str().unwrap_or("program")).to_string();
        let mut program = Map::new();
        program.insert("id".into(), json!(id)); program.insert("name".into(), json!(params["name"].as_str().unwrap_or("Действие")));
        program.insert("trigger".into(), json!(if params["trigger"] == "passive" { "passive" } else { "use" }));
        for key in ["feature_name", "group", "roll_only"] { if let Some(value) = params.get(key) { program.insert(key.into(), value.clone()); } }
        let start = (node["id"].as_str().unwrap_or("").to_string(), "exec".to_string());
        let mut pending: Vec<Endpoint> = outgoing.get(&start).cloned().unwrap_or_default().into_iter().rev().collect();
        let mut visited = HashSet::new(); let mut blocks = Vec::new();
        while let Some((node_id, _input_socket)) = pending.pop() {
            if !visited.insert(node_id.clone()) { continue; }
            let Some(current) = nodes.get(&node_id).copied() else { continue; };
            if current["type"] == "flow.if" {
                let condition = graph_input_value(current, "condition", &incoming, &nodes, context, None).and_then(|value| value.as_bool());
                let sockets: &[&str] = match condition { Some(true) => &["then"], Some(false) => &["else"], None => &["then", "else"] };
                for socket in sockets.iter().rev() {
                    let key = (node_id.clone(), (*socket).to_string());
                    for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push(target); }
                }
                continue;
            }
            let kind = current["type"].as_str().unwrap_or("").strip_prefix("action.").unwrap_or("");
            if !ACTIONS.contains(&kind) { continue; }
            let mut block = current["params"].as_object().cloned().unwrap_or_default();
            let enabled = graph_input_value(current, "enabled", &incoming, &nodes, context, block.get("enabled").cloned());
            if enabled.as_ref().is_some_and(|value| value == &json!(false)) {
                let key = (node_id.clone(), "exec".to_string());
                for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push(target); }
                continue;
            }
            if let Some(value) = enabled { block.insert("enabled".into(), value); }
            let block_id = block.remove("block_id").unwrap_or(json!(node_id));
            block.insert("id".into(), block_id); block.insert("kind".into(), json!(kind)); blocks.push(Value::Object(block));
            let key = (node_id, "exec".to_string());
            for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push(target); }
        }
        program.insert("blocks".into(), json!(blocks)); programs.push(Value::Object(program));
    }
    let mut out = json!({"version":1,"programs":programs});
    for key in ["origin", "item_defaults"] { if let Some(value) = mechanics.get(key) { out[key] = value.clone(); } }
    out
}
fn from_endpoint(link: &Value) -> Endpoint { (link["from"]["node"].as_str().unwrap_or("").to_string(), link["from"]["socket"].as_str().unwrap_or("").to_string()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_matches_the_shared_graph_contract_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/mechanics-graph.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = validate(&case["mechanics"]).is_ok();
            assert_eq!(actual, case["valid"].as_bool().unwrap(), "{}", case["name"].as_str().unwrap());
        }
    }
    #[test]
    fn reusable_group_boundaries_compile_into_the_legacy_action_chain() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/mechanics-graph.json")).unwrap();
        let graph = fixture["cases"].as_array().unwrap().iter().find(|case| case["name"] == "reusable-group-boundary").unwrap();
        let compiled = to_v1(&graph["mechanics"]);
        let blocks = compiled["programs"][0]["blocks"].as_array().unwrap();
        assert_eq!(blocks.iter().map(|block| block["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["inner-manual", "root-roll"]);
    }
}
