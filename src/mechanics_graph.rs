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
// Стили кнопок действия (параметр style узла «Начало действия»); совпадает с BUTTON_STYLES в node-params-form.js.
const BUTTON_STYLES: &[&str] = &["default", "attack", "spell", "heal", "damage", "item", "defense"];
// Виды блоков плана (внутренний IR): их исполняет src/mechanics.rs. Имена узлов v3 отличаются —
// action.spend компилируется в consume, action.field — в condition/adjust/passive.
// require остаётся только в старых сохранённых планах (src/mechanics.rs); граф v3 его не создаёт.
const ACTIONS: &[&str] = &["consume", "attack", "damage", "heal", "temp_hp", "roll", "grant_item", "condition", "adjust", "manual", "passive", "setvar"];
// Виды узлов действия (action.*, кроме action.program) — как ACTION_KINDS в static/node-registry.js.
const ACTION_NODES: &[&str] = &["roll", "field", "spend", "slot", "grant_item", "manual", "setvar"];
// Области переменных (action.setvar / data.var) — как VAR_SCOPES в static/node-registry.js:
// action живёт до конца выполнения, sheet сохраняет значение в sheet.vars.
const VAR_SCOPES: &[&str] = &["action", "sheet"];
// Операции узла «Математика» (data.mathfun) — как MATHFUN_OPS в static/node-registry.js.
const MATHFUN_OPS: &[&str] = &["min", "max", "clamp", "abs", "round", "floor", "ceil", "sign"];
/// Имя переменной: 1–32 символа из [a-z0-9_] (та же проверка на клиенте).
pub(crate) fn valid_var_name(value: &str) -> bool {
    !value.is_empty() && utf16_len(value) <= 32 && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
/// Область переменной: действие (до конца выполнения) или лист (сохраняется в sheet.vars).
pub(crate) fn valid_var_scope(value: &str) -> bool { VAR_SCOPES.contains(&value) }
/// Таблица операций data.mathfun (как mathfunValue в static/node-registry.js).
/// a обязателен; min/max нужен b, clamp — b и c.
fn mathfun_value(op: &str, a: f64, b: Option<f64>, c: Option<f64>) -> Option<f64> {
    Some(match op {
        "abs" => a.abs(),
        // Как Math.floor(a + 0.5): округление половины вверх.
        "round" => (a + 0.5).floor(),
        "floor" => a.floor(),
        "ceil" => a.ceil(),
        "sign" => if a > 0.0 { 1.0 } else if a < 0.0 { -1.0 } else { 0.0 },
        "min" => a.min(b?),
        "max" => a.max(b?),
        "clamp" => a.max(b?).min(c?),
        _ => return None,
    })
}
// Виды узла «Изменить поле» и их блоки плана — как FIELD_KINDS / FIELD_BLOCKS в static/node-registry.js.
const FIELD_KINDS: &[&str] = &["status", "value", "formula"];
const FIELD_BLOCKS: &[(&str, &str)] = &[("status", "condition"), ("value", "adjust"), ("formula", "passive")];
// Допустимые поля листа: те же списки, что в static/node-registry.js (FIELD_VALUE_FIELDS / FIELD_FORMULA_FIELDS).
const VALUE_FIELDS: &[&str] = &["speed", "initiative_bonus", "currency.gp", "currency.sp", "hp.max", "abilities.str", "abilities.dex", "abilities.con", "abilities.int", "abilities.wis", "abilities.cha"];
const FORMULA_FIELDS: &[&str] = &["speed", "hit_die", "spellcasting", "saves", "skills", "languages", "armor", "weapons", "unarmored_defense", "asi.str", "asi.dex", "asi.con", "asi.int", "asi.wis", "asi.cha"];
// Все виды бросков собраны в одном настраиваемом узле «Бросок»: параметр kind выбирает смысл броска.
const ROLL_KINDS: &[&str] = &["roll", "attack", "damage", "heal", "temp_hp"];
// Операции настраиваемого узла «Логика» (logic.op, параметр op) — как LOGIC_OPS в static/node-registry.js.
// Порты «a»/«b» нужны всем операциям, кроме «НЕ» (ports_for).
const LOGIC_OPS: &[&str] = &["and", "or", "not", "xor", "nand", "nor", "xnor", "implies"];
// Закрытые списки параметров условий листа (condition.status/item/hp/slot) — как STATUS_MODES /
// ITEM_MODES / HP_OPS / SLOT_OPS в static/node-registry.js.
const STATUS_MODES: &[&str] = &["present", "absent"];
const ITEM_MODES: &[&str] = &["owned", "equipped"];
const HP_OPS: &[&str] = &["lt", "le", "gt", "ge"];
const SLOT_OPS: &[&str] = &["gte", "lt"];
// Условия листа считаются только в рантайме и подключаются только ко входу condition блока
// (там появляется condition_src) — как SHEET_CONDITIONS в static/node-registry.js.
const SHEET_CONDITIONS: &[&str] = &["condition.status", "condition.item", "condition.hp", "condition.slot"];
// Действия с костью: их вход «dice» принимает кость проводом (как в static/node-registry.js DICE_KINDS).
const DICE_ACTIONS: &[&str] = &["roll", "attack", "damage", "heal", "temp_hp"];
// Навыки (как SKILLS в static/common.js): идентификаторы для узла «Характеристика / навык».
const SKILL_IDS: &[&str] = &["acrobatics", "animal", "arcana", "athletics", "deception", "history", "insight", "intimidation", "investigation", "medicine", "nature", "perception", "performance", "persuasion", "religion", "sleight", "stealth", "survival"];
const SOCKET_TYPES: &[&str] = &["flow", "bool", "number", "dice", "ability", "text", "list", "table", "choice", "effect"];
// Поля результата действия (data.result). hit хранится как 0/1, остальные — числа.
const RESULT_FIELDS: &[&str] = &["total", "hit", "applied", "spent"];
// Поле листа (data.sheet): непустой путь вида hp.current, level, abilities.str.
fn valid_sheet_field(value: &str) -> bool {
    !value.is_empty() && utf16_len(value) <= 100 && value.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
}

type Ports = (HashMap<String, String>, HashMap<String, String>);
fn ports_for(kind: &str, params: &Value, groups: &[Value], owner_group: Option<&Value>) -> Ports {
    let mut inputs = HashMap::new();
    let mut outputs = HashMap::new();
    match kind {
        "data.number" => { outputs.insert("value".into(), "number".into()); }
        "data.dice" => { outputs.insert("value".into(), "dice".into()); }
        "data.stat" => { outputs.insert("value".into(), "dice".into()); }
        // Значения, которые знает только рантайм: результат действия, поле листа и круг каста.
        "data.result" | "data.sheet" | "data.cast" => { outputs.insert("value".into(), "number".into()); }
        // Переменная действия или листа: число, без состояния выполнения — 0.
        "data.var" => { outputs.insert("value".into(), "number".into()); }
        // Ссылка на числовой узел этого же графа (значение цели).
        "data.ref" => { outputs.insert("value".into(), "number".into()); }
        // Математика одного числа: a обязателен, b — min/max, b и c — clamp.
        "data.mathfun" => {
            inputs.insert("a".into(), "number".into()); inputs.insert("b".into(), "number".into()); inputs.insert("c".into(), "number".into());
            outputs.insert("value".into(), "number".into());
        }
        "data.boolean" => { outputs.insert("value".into(), "bool".into()); }
        "data.math" => { inputs.insert("a".into(), "number".into()); inputs.insert("b".into(), "number".into()); outputs.insert("value".into(), "number".into()); }
        "dice.combine" => { inputs.insert("a".into(), "dice".into()); inputs.insert("b".into(), "dice".into()); outputs.insert("value".into(), "dice".into()); }
        "data.compare" => { inputs.insert("a".into(), "number".into()); inputs.insert("b".into(), "number".into()); outputs.insert("value".into(), "bool".into()); }
        // Логика: «НЕ» использует только вход «a», остальные операции — «a» и «b».
        "logic.op" => {
            inputs.insert("a".into(), "bool".into());
            if params["op"].as_str() != Some("not") { inputs.insert("b".into(), "bool".into()); }
            outputs.insert("value".into(), "bool".into());
        }
        // Условия листа (состояние, предмет, хиты, ячейки): читаются в рантайме, без листа — false.
        "condition.context" | "condition.hit" | "condition.status" | "condition.item" | "condition.hp" | "condition.slot" => { outputs.insert("value".into(), "bool".into()); }
        "flow.if" => { inputs.insert("exec".into(), "flow".into()); inputs.insert("condition".into(), "bool".into()); outputs.insert("then".into(), "flow".into()); outputs.insert("else".into(), "flow".into()); }
        "rule.class" => { inputs.insert("enabled".into(), "bool".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.value" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("amount".into(), "number".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.list" => { inputs.insert("enabled".into(), "bool".into()); inputs.insert("amount".into(), "number".into()); outputs.insert("effect".into(), "effect".into()); }
        "rule.manual" => { inputs.insert("enabled".into(), "bool".into()); outputs.insert("effect".into(), "effect".into()); }
        "flow.end" => { inputs.insert("exec".into(), "flow".into()); }
        "action.program" => { outputs.insert("exec".into(), "flow".into()); }
        x if x.starts_with("action.") && ACTION_NODES.contains(&&x[7..]) => {
            // Условие блока: enabled — статическое, condition — динамическое bool-значение.
            inputs.insert("exec".into(), "flow".into()); inputs.insert("enabled".into(), "bool".into()); inputs.insert("condition".into(), "bool".into()); outputs.insert("exec".into(), "flow".into());
            if DICE_ACTIONS.contains(&&x[7..]) { inputs.insert("dice".into(), "dice".into()); }
            // Записать переменную: значение приходит числом по проводу (иначе 0).
            if x == "action.setvar" { inputs.insert("value".into(), "number".into()); }
        }
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
// Снаряжение: предмет с названием (до 120) и количеством (1–1000, необязательно).
fn valid_equipment_item(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false; };
    let name_ok = o.get("name").and_then(|n| n.as_str()).map(|n| !n.trim().is_empty() && utf16_len(n) <= 120).unwrap_or(false);
    let qty_ok = o.get("qty").map(|q| json_integer(q).map(|n| (1..=1000).contains(&n)).unwrap_or(false)).unwrap_or(true);
    name_ok && qty_ok
}
fn valid_equipment_items(value: &Value) -> bool {
    value.as_array().map(|items| items.len() <= 100 && items.iter().all(valid_equipment_item)).unwrap_or(false)
}
fn valid_equipment_choice(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false; };
    let id_ok = o.get("id").map(|v| v.as_str().map(|s| utf16_len(s) <= 100).unwrap_or(false)).unwrap_or(true);
    let title_ok = o.get("title").map(|v| v.as_str().map(|s| utf16_len(s) <= 120).unwrap_or(false)).unwrap_or(true);
    let options_ok = o.get("options").map(|v| v.as_array().map(|opts| {
        opts.len() >= 1 && opts.len() <= 50 && opts.iter().all(|opt| {
            let Some(oo) = opt.as_object() else { return false; };
            let name_ok = oo.get("name").and_then(|n| n.as_str()).map(|n| !n.trim().is_empty() && utf16_len(n) <= 120).unwrap_or(false);
            let items_ok = oo.get("items").map(valid_equipment_items).unwrap_or(false);
            let gold_ok = oo.get("gold").map(|g| json_integer(g).map(|n| (0..=1_000_000).contains(&n)).unwrap_or(false)).unwrap_or(true);
            name_ok && items_ok && gold_ok
        })
    }).unwrap_or(false)).unwrap_or(false);
    id_ok && title_ok && options_ok
}
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
fn validate_node_params(n: &Value, programs: &HashSet<String>, nodes: &[Value]) -> ApiResult<()> {
    let p = &n["params"];
    let kind = n["type"].as_str().unwrap_or("");
    match kind {
        // Переменная: имя из [a-z0-9_] (1–32) и область action или sheet. У action.setvar и data.var
        // один контракт параметров — как в static/nodes/actions/setvar.js и static/nodes/data/var.js.
        "action.setvar" | "data.var" => {
            if !valid_var_name(p["name"].as_str().unwrap_or("")) { return Err(bad("Переменная: имя из латинских букв, цифр и «_» (1–32).")); }
            if !VAR_SCOPES.contains(&p["scope"].as_str().unwrap_or("")) { return Err(bad("Переменная: область action или sheet.")); }
        }
        // Ссылка: цель — числовой узел этого же графа; себя и циклы ссылок граф запрещает.
        "data.ref" => {
            let target_id = p["node"].as_str().unwrap_or("");
            if target_id.is_empty() || utf16_len(target_id) > 100 { return Err(bad("Ссылка: выберите узел графа.")); }
            if target_id == n["id"].as_str().unwrap_or("") { return Err(bad("Ссылка: узел не может ссылаться на себя.")); }
            let mut current = match nodes.iter().find(|item| item["id"].as_str() == Some(target_id)) {
                Some(target) => target,
                None => return Err(bad("Ссылка: узел не найден в этом графе.")),
            };
            let (_, outs) = ports_for(current["type"].as_str().unwrap_or(""), &current["params"], &[], None);
            if outs.get("value").map(String::as_str) != Some("number") { return Err(bad("Ссылка: выберите числовой узел графа.")); }
            let mut seen: HashSet<String> = HashSet::new();
            seen.insert(n["id"].as_str().unwrap_or("").to_string());
            while current["type"] == "data.ref" {
                let id = current["id"].as_str().unwrap_or("");
                if !seen.insert(id.to_string()) { return Err(bad("Циклическая ссылка")); }
                let next_id = current["params"]["node"].as_str().unwrap_or("");
                current = match nodes.iter().find(|item| item["id"].as_str() == Some(next_id)) {
                    Some(next) => next,
                    None => return Err(bad("Ссылка: узел не найден в этом графе.")),
                };
            }
        }
        // Математика: закрытый список операций; clamp без входов b и c не считается (провод — в validate_graph).
        "data.mathfun" if !MATHFUN_OPS.contains(&p["op"].as_str().unwrap_or("")) => {
            return Err(bad("Математика: допустимы min, max, clamp, abs, round, floor, ceil и sign."));
        }
        "data.boolean" if !p["value"].is_boolean() => return Err(bad("Логическая константа: значение true или false.")),
        "data.math" if !["add", "sub", "mul", "div", "min", "max"].contains(&p["op"].as_str().unwrap_or("")) => return Err(bad("Вычисление: неизвестная операция.")),
        "data.number" if !p["value"].as_f64().map(|number| number.is_finite()).unwrap_or(false) => return Err(bad("Числовой узел должен содержать конечное число.")),
        "data.dice" => {
            let value = &p["value"];
            let count = json_integer(&value["count"]).unwrap_or(-1); let sides = json_integer(&value["sides"]).unwrap_or(-1);
            let bonus = match value.get("bonus") { None | Some(Value::Null) => 0, Some(value) => json_integer(value).unwrap_or(i64::MAX) };
            let stat = match value.get("stat") { None | Some(Value::Null) => "", Some(value) => value.as_str().unwrap_or("\0") };
            if !value.is_object() || !(0..=100).contains(&count) || !(1..=1000).contains(&sides) || !(-1_000_000..=1_000_000).contains(&bonus) || !["", "str", "dex", "con", "int", "wis", "cha", "best", "prof", "atk", "atk_str", "atk_dex", "spell", "spell_mod", "level", "dc"].contains(&stat) { return Err(bad("Узел кости должен содержать количество и грани.")); }
        }

        "condition.context" => {
            match p["kind"].as_str().unwrap_or("") {
                "edition" => {
                    let editions = p["editions"].as_array().filter(|a| !a.is_empty()).ok_or_else(|| bad("Условие редакции: один или несколько допустимых SRD."))?;
                    if editions.iter().any(|x| !["2014", "2024"].contains(&x.as_str().unwrap_or(""))) { return Err(bad("Условие редакции: один или несколько допустимых SRD.")); }
                }
                "level" => {
                    let min = json_integer(&p["min"]).unwrap_or(0); let max = json_integer(&p["max"]).unwrap_or(0);
                    if min < 1 || max > 20 || min > max { return Err(bad("Условие уровня: диапазон 1–20.")); }
                }
                "subclass" => { if !valid_id(&p["id"], 100) { return Err(bad("Укажите ID подкласса в условии.")); } }
                "choice" => { if !valid_id(&p["id"], 100) || p.get("value").is_none() { return Err(bad("Укажите ID группы и сравниваемый выбор.")); } }
                _ => return Err(bad("Условие: неизвестный вид.")),
            }
        }
        // Условие состояния: название состояния листа и режим «наложено / не наложено».
        "condition.status" => {
            let name = p["name"].as_str().unwrap_or("");
            if name.trim().is_empty() || utf16_len(name) > 120 { return Err(bad("Состояние: название от 1 до 120 символов.")); }
            if !STATUS_MODES.contains(&p["mode"].as_str().unwrap_or("")) { return Err(bad("Состояние: режим present или absent.")); }
        }
        // Условие предмета: имя в снаряжении листа и режим «в сумке / надето».
        "condition.item" => {
            let name = p["name"].as_str().unwrap_or("");
            if name.trim().is_empty() || utf16_len(name) > 120 { return Err(bad("Предмет: название от 1 до 120 символов.")); }
            if !ITEM_MODES.contains(&p["mode"].as_str().unwrap_or("")) { return Err(bad("Предмет: режим owned или equipped.")); }
        }
        // Условие хитов: текущие хиты или процент от максимума (0–100) против числа.
        "condition.hp" => {
            if !HP_OPS.contains(&p["op"].as_str().unwrap_or("")) { return Err(bad("Хиты: операция lt, le, gt или ge.")); }
            let percent = p["percent"].as_bool().unwrap_or(false);
            let limit = if percent { 100 } else { 1_000_000 };
            match json_integer(&p["value"]) {
                Some(value) if (0..=limit).contains(&value) => {}
                _ => return Err(bad(if percent { "Хиты: процент от 0 до 100." } else { "Хиты: целое число от 0 до 1000000." })),
            }
        }
        // Условие ячеек: круг 1–9, остаток ячеек (с учётом пула Договора) и сравнение с числом 0–20.
        "condition.slot" => {
            match json_integer(&p["level"]) { Some(level) if (1..=9).contains(&level) => {} _ => return Err(bad("Ячейки: круг от 1 до 9.")) }
            if !SLOT_OPS.contains(&p["op"].as_str().unwrap_or("")) { return Err(bad("Ячейки: операция gte или lt.")); }
            match json_integer(&p["value"]) { Some(value) if (0..=20).contains(&value) => {} _ => return Err(bad("Ячейки: значение от 0 до 20.")) }
        }
        "data.stat" if !(ABILITIES.contains(&p["id"].as_str().unwrap_or("")) || SKILL_IDS.contains(&p["id"].as_str().unwrap_or(""))) || !(["bonus", "score"].contains(&p["mode"].as_str().unwrap_or(""))) => return Err(bad("Выберите характеристику или навык и режим: бонус или значение.")),
        "data.compare" if !([">=", "<=", ">", "<", "=", "!="].contains(&p["op"].as_str().unwrap_or(""))) => return Err(bad("Сравнение: допустимы >=, <=, >, <, = и !=.")),
        // Результат действия читается из листа в рантайме: источник — «последнее действие» или программа графа.
        "data.result" => {
            let source = p["source"].as_str().unwrap_or("");
            if source != "last" && !programs.contains(source) { return Err(bad("Результат: выберите последнее действие или программу этого графа.")); }
            if !RESULT_FIELDS.contains(&p["field"].as_str().unwrap_or("")) { return Err(bad("Результат действия: поле total, hit, applied или spent.")); }
        }
        // Поле листа: путь по вложенным ключам листа (hp.current, level, abilities.str).
        "data.sheet" if !valid_sheet_field(p["field"].as_str().unwrap_or("")) => return Err(bad("Поле листа: непустой путь из латинских букв, цифр, «_» и «.».")),
        // Круг каста: уровень выбранной ячейки, базовый круг заклинания и число лишних кругов.
        "data.cast" if !["level", "base", "extra"].contains(&p["field"].as_str().unwrap_or("")) => return Err(bad("Круг каста: поле level, base или extra.")),
        "logic.op" if p.get("op").is_some() && !LOGIC_OPS.contains(&p["op"].as_str().unwrap_or("")) => return Err(bad("Логический узел: операция and, or, not, xor, nand, nor, xnor или implies.")),
        "action.roll" if p.get("kind").is_some() && !ROLL_KINDS.contains(&p["kind"].as_str().unwrap_or("")) => return Err(bad("Настраиваемый бросок: тип roll, attack, damage, heal или temp_hp.")),
        // Повышение круга: сколько костей добавляется за каждый круг выше базового (только урон и лечение).
        "action.roll" if p.get("upcast").is_some() => {
            let upcast = &p["upcast"];
            let count = json_integer(&upcast["count"]).unwrap_or(-1);
            let sides = json_integer(&upcast["sides"]).unwrap_or(-1);
            if !upcast.is_object() || !(0..=100).contains(&count) || !(1..=1000).contains(&sides) {
                return Err(bad("Повышение круга: количество костей 0–100 и грани 1–1000."));
            }
        }
        "action.field" => {
            let field_kind = p["kind"].as_str().unwrap_or("");
            if !FIELD_KINDS.contains(&field_kind) { return Err(bad("Изменить поле: вид status, value или formula.")); }
            if field_kind == "status" {
                let name = p["condition"].as_str().unwrap_or("");
                let operation = p["operation"].as_str().unwrap_or("");
                // «Концентрация» не задаёт название вручную: сервер подставляет имя заклинания.
                if !["add", "remove", "concentration"].contains(&operation) { return Err(bad("Состояние: операция add, remove или concentration.")); }
                if operation != "concentration" && (name.trim().is_empty() || utf16_len(name) > 200) { return Err(bad("Состояние: название до 200 символов.")); }
                if operation == "concentration" && utf16_len(name) > 200 { return Err(bad("Состояние: название до 200 символов.")); }
            }
            if field_kind == "value" {
                if !VALUE_FIELDS.contains(&p["field"].as_str().unwrap_or("")) { return Err(bad("Недоступный показатель.")); }
                if json_integer(&p["amount"]).map(|number| !(-10_000..=10_000).contains(&number)).unwrap_or(true) { return Err(bad("Показатель: целое от −10000 до 10000.")); }
            }
            if field_kind == "formula" {
                if !FORMULA_FIELDS.contains(&p["field"].as_str().unwrap_or("")) { return Err(bad("Параметр доступен только в пассивной программе.")); }
                if p.get("value").is_none() || utf16_len(&p["value"].to_string()) > 100_000 { return Err(bad("Значение параметра: ограниченное JSON-значение.")); }
            }
        }
        "action.spend" => {
            // Тот же контракт, что у блока consume в src/mechanics.rs: вид ресурса, источник и количество.
            // Ячейка заклинания — отдельный узел action.slot; здесь остаются предметы и умения.
            let resource = p["resource"].as_str().unwrap_or("");
            let source = p["source"].as_str().unwrap_or("");
            if !["quantity", "charges", "uses"].contains(&resource) || !["self", "item", "tag"].contains(&source) || !["use", "attack"].contains(&p["trigger"].as_str().unwrap_or("")) {
                return Err(bad("Неизвестный способ расхода."));
            }
            if json_integer(&p["amount"]).map(|number| !(1..=10_000).contains(&number)).unwrap_or(true) { return Err(bad("Количество расхода: целое от 1 до 10000.")); }
            if source == "item" && p["item_uid"].as_str().unwrap_or("").is_empty() { return Err(bad("Не задан источник расхода.")); }
            if source == "tag" && p["tag"].as_str().unwrap_or("").trim().is_empty() { return Err(bad("Не задан источник расхода.")); }
        }
        // Расход ячейки заклинания: level 0 — круг, выбранный при касте, 1–9 — фиксированный.
        "action.slot" => {
            if json_integer(&p["level"]).map(|number| !(0..=9).contains(&number)).unwrap_or(true) { return Err(bad("Круг ячейки: целое от 0 до 9.")); }
            if json_integer(&p["amount"]).map(|number| !(1..=10_000).contains(&number)).unwrap_or(true) { return Err(bad("Количество ячеек: целое от 1 до 10000.")); }
        }
        "flow.if" if p.as_object().map(|object| object.len() > 8).unwrap_or(false) => return Err(bad("Условный узел содержит лишние параметры.")),
        "action.program" => {
            if !valid_id(&p["program_id"], 100) || p["name"].as_str().unwrap_or("").trim().is_empty() || utf16_len(p["name"].as_str().unwrap_or("")) > 120 || !["use", "passive"].contains(&p["trigger"].as_str().unwrap_or("")) {
                return Err(bad("Программе нужны ID, название и допустимый триггер."));
            }
            if let Some(style) = p.get("style") {
                if !BUTTON_STYLES.contains(&style.as_str().unwrap_or("")) {
                    return Err(bad("Неизвестный стиль кнопки."));
                }
            }
        }
        "group.instance" if !valid_id(&p["group_id"], 64) => return Err(bad("Узел группы требует ID группы.")),
        "group.input" | "group.output" if !valid_id(&p["socket_id"], 64) => return Err(bad("Узел границы группы должен ссылаться на сокет интерфейса.")),
        "rule.list" => {
            match p["kind"].as_str().unwrap_or("") {
                "languages" => { if p.get("value").is_some() && !valid_string_list(&p["value"], 100, 200) { return Err(bad("Языки должны быть списком текстовых значений.")); } }
                "proficiencies" => { if (p.get("value").is_some() && !valid_string_list(&p["value"], 100, 200)) || (p.get("label").is_some() && (p["label"].as_str().is_none() || utf16_len(p["label"].as_str().unwrap_or("")) > 120)) { return Err(bad("Владения должны быть списком и иметь короткую метку.")); } }
                "skill_proficiency" => { if p.get("value").is_some() && !valid_string_list(&p["value"], 18, 200) { return Err(bad("Владение навыком: список названий (до 18).")); } }
                "saving_throws" => { if p.get("value").is_some() && !p["value"].as_array().map(|values| values.len() <= 6 && values.iter().all(|value| ABILITIES.contains(&value.as_str().unwrap_or("")))).unwrap_or(false) { return Err(bad("Спасброски должны быть списком характеристик.")); } }
                "skills" => { if !valid_id(&p["id"], 100) || json_integer(&p["count"]).map(|n| !(0..=18).contains(&n)).unwrap_or(true) || !valid_string_list(&p["options"], 18, 200) { return Err(bad("Выбор навыков: ID, список до 18 и количество от 0 до 18.")); } }
                "spell_list" => { if !["known", "prepared", "book"].contains(&p["mode"].as_str().unwrap_or("")) || (p.get("ability").is_some() && !ABILITIES.contains(&p["ability"].as_str().unwrap_or(""))) || !valid_string_list(&p["spells"], 100, 200) { return Err(bad("Список заклинаний: режим, список и характеристика должны быть допустимы.")); } }
                "feature" => { if p["name"].as_str().unwrap_or("").trim().is_empty() || utf16_len(p["name"].as_str().unwrap_or("")) > 120 || (p.get("text").is_some() && (p["text"].as_str().is_none() || utf16_len(p["text"].as_str().unwrap_or("")) > 4000)) { return Err(bad("Умение: название до 120 и текст до 4000 символов.")); } }
                "class_features" => { if p.get("table").is_some() && !valid_json_object(&p["table"], 100_000) { return Err(bad("Табличное правило должно содержать ограниченный JSON-объект.")); } }
                "equipment" => { if !valid_equipment_items(&p["items"]) { return Err(bad("Снаряжение: список предметов с названием (до 120) и количеством (1–1000).")); } }
                "equipment_choice" => { if !valid_equipment_choice(&p) { return Err(bad("Выбор снаряжения: ID, название и варианты со списком предметов.")); } }
                _ => return Err(bad("Список: неизвестный вид.")),
            }
        }
        "rule.class" => {
            match p["kind"].as_str().unwrap_or("") {
                "class_progression" | "class_rules" | "spell_slots" => { if p.get("table").is_some() && !valid_json_object(&p["table"], 100_000) { return Err(bad("Табличное правило должно содержать ограниченный JSON-объект.")); } }
                "spellcasting" => { if !ABILITIES.contains(&p["ability"].as_str().unwrap_or("")) { return Err(bad("Выберите заклинательную характеристику из закрытого списка.")); } }
                _ => return Err(bad("Класс: неизвестный вид.")),
            }
        }
        "rule.value" => {
            match p["kind"].as_str().unwrap_or("") {
                "ability" => { if !ABILITIES.contains(&p["ability"].as_str().unwrap_or("")) || p.get("amount").map(|value| value.as_f64().map(|number| number.is_finite() && number.abs() <= 1000.0).unwrap_or(false) == false).unwrap_or(false) { return Err(bad("Бонус характеристики требует существующий ключ характеристики и конечную величину.")); } }
                "speed" => { if p.get("amount").is_some() && json_integer(&p["amount"]).map(|value| !(0..=1000).contains(&value)).unwrap_or(true) { return Err(bad("Скорость должна быть целым числом от 0 до 1000.")); } }
                "hp" => { if p.get("amount").is_some() && json_integer(&p["amount"]).map(|n| n < -1000 || n > 1000).unwrap_or(true) { return Err(bad("Бонус хитов: целое от −1000 до 1000.")); } }
                "hit_die" => { if p.get("value").is_some() && !["d6", "d8", "d10", "d12"].contains(&p["value"].as_str().unwrap_or("")) { return Err(bad("Кость хитов: d6, d8, d10 или d12.")); } }
                "asi" => { if p.get("table").is_some() && !valid_json_object(&p["table"], 100_000) { return Err(bad("Табличное правило должно содержать ограниченный JSON-объект.")); } }
                "armor_formula" => { let formula = p["formula"].as_str().unwrap_or(""); if formula.is_empty() || utf16_len(formula) > 100 || !formula.chars().all(|c| c.is_ascii_alphanumeric() || "+-*@_(), . \t\r\n".contains(c)) { return Err(bad("Формула защиты без доспехов содержит только числа, характеристики, min/max и арифметические символы.")); } if p.get("name").is_some() && (p["name"].as_str().is_none() || utf16_len(p["name"].as_str().unwrap_or("")) > 120) { return Err(bad("Название защиты без доспехов: строка до 120 символов.")); } if p.get("no_shield").is_some() && !p["no_shield"].is_boolean() { return Err(bad("Запрет щита: логическое значение.")); } }
                _ => return Err(bad("Правило-значение: неизвестный вид.")),
            }
        }
        "rule.manual" if p["text"].as_str().is_none() || utf16_len(p["text"].as_str().unwrap_or("")) > 4000 => return Err(bad("Ручное правило: до 4000 символов.")),
        _ => {}
    }
    if kind.starts_with("action.") && kind != "action.program" {
        if !valid_id(&p["block_id"], 100) { return Err(bad("Узел действия должен иметь стабильный block_id.")); }
    }
    Ok(())
}
// Смысловые проблемы связей пишутся в problems (сохранение их не блокирует, исполнение пропускает граф).
const FLOW_END_UNWIRED: &str = "«Конец» ни к чему не подключён";
const FLOW_BRANCH_UNFINISHED: &str = "Ветка не завершается узлом «Конец»";
const MATHFUN_CLAMP_UNWIRED: &str = "Математика: для clamp нужны провода на входы b и c";
fn flow_action_unfinished(name: &str) -> String { format!("Действие «{}» не завершается узлом «Конец»", name) }
/// Выходы узла с типом flow (exec у действий, then/else у «Если», flow-порты групп) — как flowPorts в JS.
fn flow_output_names(outs: &HashMap<String, String>) -> Vec<String> {
    let mut names: Vec<String> = outs.iter().filter(|(_, kind)| kind.as_str() == "flow").map(|(socket, _)| socket.clone()).collect();
    names.sort();
    names
}
struct FlowCtx<'a> {
    ports: &'a HashMap<String, Ports>,
    types: &'a HashMap<String, String>,
    outgoing: &'a HashMap<(String, String), Vec<String>>,
    visiting: HashSet<String>,
    finished: HashSet<String>,
    reported: HashSet<String>,
    problems: Vec<String>,
}
impl<'a> FlowCtx<'a> {
    fn report(&mut self, message: String) { if self.reported.insert(message.clone()) { self.problems.push(message); } }
    /// true — все продолжения потока узла заканчиваются «Концом»; у «Если» проверяются обе ветви.
    fn terminates(&mut self, id: &str, in_branch: bool, action: &str) -> bool {
        if self.visiting.contains(id) || self.finished.contains(id) { return true; }
        if self.types.get(id).map(|kind| kind.as_str()) == Some("flow.end") { self.finished.insert(id.to_string()); return true; }
        let Some((_, outs)) = self.ports.get(id) else { return true; };
        let sockets = flow_output_names(outs);
        let branch_node = self.types.get(id).map(|kind| kind.as_str()) == Some("flow.if");
        self.visiting.insert(id.to_string());
        let mut ok = true;
        if sockets.is_empty() { ok = false; self.report(if in_branch { FLOW_BRANCH_UNFINISHED.to_string() } else { flow_action_unfinished(action) }); }
        for socket in &sockets {
            let targets = self.outgoing.get(&(id.to_string(), socket.clone())).cloned().unwrap_or_default();
            if targets.is_empty() {
                ok = false;
                self.report(if branch_node || in_branch { FLOW_BRANCH_UNFINISHED.to_string() } else { flow_action_unfinished(action) });
                continue;
            }
            for target in targets { if !self.terminates(&target, in_branch || branch_node, action) { ok = false; } }
        }
        self.visiting.remove(id);
        if ok { self.finished.insert(id.to_string()); }
        ok
    }
}
/// Правило «начало → конец»: поток каждого action.program (вместе с обеими ветвями flow.if) обязан
/// доходить до flow.end, а «Конец» без входящего потока — проблема (как addFlowProblems в JS).
fn flow_problems(nodes: &[Value], links: &[Value], groups: &[Value], owner_group: Option<&Value>, problems: &mut Vec<String>) {
    let mut ports: HashMap<String, Ports> = HashMap::new();
    let mut types: HashMap<String, String> = HashMap::new();
    for node in nodes {
        let Some(id) = node["id"].as_str() else { continue };
        types.insert(id.to_string(), node["type"].as_str().unwrap_or("").to_string());
        ports.insert(id.to_string(), ports_for(node["type"].as_str().unwrap_or(""), &node["params"], groups, owner_group));
    }
    let mut outgoing: HashMap<(String, String), Vec<String>> = HashMap::new();
    let mut incoming: HashSet<String> = HashSet::new();
    for link in links {
        let (from, to) = (&link["from"], &link["to"]);
        let (Some(source), Some(target), Some(from_socket), Some(to_socket)) = (from["node"].as_str(), to["node"].as_str(), from["socket"].as_str(), to["socket"].as_str()) else { continue };
        let Some((_, outs)) = ports.get(source) else { continue };
        if outs.get(from_socket).map(|kind| kind.as_str()) != Some("flow") { continue; }
        let Some((ins, _)) = ports.get(target) else { continue };
        if ins.get(to_socket).map(|kind| kind.as_str()) != Some("flow") { continue; }
        outgoing.entry((source.to_string(), from_socket.to_string())).or_default().push(target.to_string());
        incoming.insert(target.to_string());
    }
    let mut ctx = FlowCtx { ports: &ports, types: &types, outgoing: &outgoing, visiting: HashSet::new(), finished: HashSet::new(), reported: HashSet::new(), problems: Vec::new() };
    for node in nodes {
        let kind = node["type"].as_str().unwrap_or("");
        let id = node["id"].as_str().unwrap_or("");
        if kind == "flow.end" { if !incoming.contains(id) { ctx.report(FLOW_END_UNWIRED.to_string()); } continue; }
        if kind != "action.program" { continue; }
        let name = node["params"]["name"].as_str().filter(|name| !name.is_empty())
            .or_else(|| node["params"]["program_id"].as_str().filter(|name| !name.is_empty()))
            .unwrap_or(id).to_string();
        let sockets = ctx.ports.get(id).map(|(_, outs)| flow_output_names(outs)).unwrap_or_default();
        let mut started = false;
        for socket in &sockets {
            for target in ctx.outgoing.get(&(id.to_string(), socket.clone())).cloned().unwrap_or_default() {
                started = true;
                ctx.terminates(&target, false, &name);
            }
        }
        if !started { ctx.report(flow_action_unfinished(&name)); }
    }
    problems.append(&mut ctx.problems);
}
fn validate_graph(graph: &Value, groups: &[Value], nested: bool, owner_group: Option<&Value>, problems: &mut Vec<String>, programs: &HashSet<String>) -> ApiResult<()> {
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
    }
    // Параметры проверяются после сбора ID: ссылка data.ref может указывать на узел, объявленный ниже.
    for n in nodes {
        let kind = n["type"].as_str().unwrap_or("");
        if let Some(p) = n.get("params") { if !p.is_object() || utf16_len(&p.to_string()) > 100_000 { return Err(bad("Параметры узла должны быть ограниченным JSON-объектом.")); } }
        if let Some(pos) = n.get("position") { if !pos["x"].as_f64().map(|x| x.is_finite() && x.abs() <= 100_000.0).unwrap_or(false) || !pos["y"].as_f64().map(|x| x.is_finite() && x.abs() <= 100_000.0).unwrap_or(false) { return Err(bad("Координаты узла вне допустимых пределов.")); } }
        if kind == "group.instance" && !groups.iter().any(|g| g["id"] == n["params"]["group_id"]) { return Err(bad("Узел ссылается на отсутствующую группу.")); }
        if ["group.input", "group.output"].contains(&kind) && (!nested || owner_group.is_none()) { return Err(bad("Узлы интерфейса группы разрешены только внутри повторно используемой группы.")); }
        validate_node_params(n, programs, nodes)?;
    }
    let mut indegree: HashMap<String, usize> = node_ids.iter().map(|x| (x.clone(), 0)).collect();
    let mut adjacency: HashMap<String, Vec<String>> = node_ids.iter().map(|x| (x.clone(), Vec::new())).collect();
    let mut incoming = HashSet::new(); let mut edge_ids = HashSet::new();
    for link in links {
        let from = &link["from"]; let to = &link["to"];
        let source = from["node"].as_str().unwrap_or(""); let target = to["node"].as_str().unwrap_or("");
        let out_socket = from["socket"].as_str().unwrap_or(""); let in_socket = to["socket"].as_str().unwrap_or("");
        if !node_ids.contains(source) || !node_ids.contains(target) { problems.push("Провод указывает на отсутствующий узел.".to_string()); continue; }
        let from_node = nodes.iter().find(|n| n["id"] == source).unwrap(); let to_node = nodes.iter().find(|n| n["id"] == target).unwrap();
        let (_, outs) = ports_for(from_node["type"].as_str().unwrap_or(""), &from_node["params"], groups, owner_group);
        let (ins, _) = ports_for(to_node["type"].as_str().unwrap_or(""), &to_node["params"], groups, owner_group);
        let (out_type, in_type) = match (outs.get(out_socket), ins.get(in_socket)) {
            (Some(out), Some(input)) => (out, input),
            _ => { problems.push("Провод подключён к отсутствующему сокету.".to_string()); continue; }
        };
        if out_type != in_type { problems.push("Типы сокетов провода не совпадают.".to_string()); continue; }
        if from_node["type"] == "condition.hit" && !(to_node["type"] == "flow.if" && in_socket == "condition") { problems.push("Условие попадания подключается только ко входу «Если».".to_string()); continue; }
        // Условия листа считаются только в рантайме: провод допустим только ко входу condition блока.
        if SHEET_CONDITIONS.contains(&from_node["type"].as_str().unwrap_or("")) && !(to_node["type"].as_str().unwrap_or("").starts_with("action.") && in_socket == "condition") {
            problems.push("Условие листа подключается только ко входу «condition» блока действия.".to_string()); continue;
        }
        let key = format!("{target}:{in_socket}");
        // В конец («Конец») может прийти несколько проводов; у остальных входов — один.
        if to_node["type"] != "flow.end" && !incoming.insert(key) { problems.push("К каждому входному сокету подключается только один провод.".to_string()); continue; }
        let edge_key = format!("{source}:{out_socket}>{target}:{in_socket}");
        if !edge_ids.insert(edge_key) { problems.push("Повторяющийся провод.".to_string()); continue; }
        adjacency.get_mut(source).unwrap().push(target.to_string()); *indegree.get_mut(target).unwrap() += 1;
    }
    for node in nodes { if node["type"] == "flow.if" && !incoming.contains(&format!("{}:condition", node["id"].as_str().unwrap_or(""))) { problems.push("Условному узлу требуется типизированное логическое условие.".to_string()); } }
    // Математика: clamp ограничивает значение обоими пределами, поэтому нужны провода на b и c.
    for node in nodes {
        if node["type"] != "data.mathfun" || node["params"]["op"].as_str() != Some("clamp") { continue; }
        let id = node["id"].as_str().unwrap_or("");
        if ["b", "c"].iter().any(|socket| !incoming.contains(&format!("{id}:{socket}"))) { problems.push(MATHFUN_CLAMP_UNWIRED.to_string()); }
    }
    let mut queue: VecDeque<String> = indegree.iter().filter(|(_, d)| **d == 0).map(|(id, _)| id.clone()).collect(); let mut visited = 0;
    while let Some(current) = queue.pop_front() { visited += 1; for target in adjacency.get(&current).into_iter().flatten() { let d = indegree.get_mut(target).unwrap(); *d -= 1; if *d == 0 { queue.push_back(target.clone()); } } }
    if visited != node_ids.len() { problems.push("Цикл в графе запрещён.".to_string()); }
    if gated_hit_nesting(nodes, links) { problems.push("Ветвление по попаданию нельзя вкладывать в другое ветвление по попаданию.".to_string()); }
    // Завершённость потока («Начало → Конец») — смысловая проблема: запись сохраняется, граф не исполняется.
    flow_problems(nodes, links, groups, owner_group, problems);
    let mut frame_ids = HashSet::new(); let mut framed_nodes = HashSet::new();
    for frame in frames {
        let id = frame["id"].as_str().unwrap_or(""); let title = frame["title"].as_str().unwrap_or("");
        let members = frame["nodes"].as_array().filter(|a| a.len() <= 100).ok_or_else(|| bad("Некорректная рамка графа."))?;
        if id.is_empty() || utf16_len(id) > 64 || !frame_ids.insert(id.to_string()) || title.trim().is_empty() || utf16_len(title) > 120 { return Err(bad("Некорректная рамка графа."));}
        for member in members { let node = member.as_str().unwrap_or(""); if !node_ids.contains(node) || !framed_nodes.insert(node.to_string()) { return Err(bad("Рамка содержит отсутствующий или повторный узел.")); } }
    }
    Ok(())
}
/// Ветвление по попаданию внутри ветви другого (см. gatedHitNesting в static/mechanics-graph.js).
fn gated_hit_nesting(nodes: &[Value], links: &[Value]) -> bool {
    let kind_of = |id: &str| -> String { nodes.iter().find(|n| n["id"].as_str() == Some(id)).and_then(|n| n["type"].as_str()).unwrap_or("").to_string() };
    let edges: Vec<(String, String, String, String)> = links.iter().map(|l| (
        l["from"]["node"].as_str().unwrap_or("").to_string(), l["from"]["socket"].as_str().unwrap_or("").to_string(),
        l["to"]["node"].as_str().unwrap_or("").to_string(), l["to"]["socket"].as_str().unwrap_or("").to_string(),
    )).collect();
    let hit_flows: HashSet<String> = nodes.iter()
        .filter(|n| n["type"].as_str() == Some("flow.if"))
        .filter_map(|n| n["id"].as_str().map(|id| id.to_string()))
        .filter(|id| edges.iter().any(|(from, _, to, socket)| to.as_str() == id.as_str() && socket.as_str() == "condition" && kind_of(from.as_str()) == "condition.hit"))
        .collect();
    let targets = |id: &str| -> Vec<String> {
        edges.iter().filter(|(from, out, _, _)| from.as_str() == id && (out.as_str() == "then" || out.as_str() == "else")).map(|(_, _, to, _)| to.clone()).collect()
    };
    for id in &hit_flows {
        let mut stack = targets(id.as_str());
        let mut seen: HashSet<String> = HashSet::new();
        while let Some(current) = stack.pop() {
            if !seen.insert(current.clone()) { continue; }
            if hit_flows.contains(&current) { return true; }
            if kind_of(current.as_str()) == "flow.if" { stack.extend(targets(current.as_str())); }
        }
    }
    false
}
const NODE_TYPES: &[&str] = &[
    "data.number", "data.dice", "data.boolean", "data.math", "data.stat", "data.compare", "dice.combine", "data.result", "data.sheet", "data.cast",
    "data.var", "data.ref", "data.mathfun",
    "condition.context", "condition.hit", "condition.status", "condition.item", "condition.hp", "condition.slot",
    "logic.op", "flow.if", "flow.end",
    "rule.value", "rule.list", "rule.class", "rule.manual",
    "action.program", "action.roll", "action.field", "action.spend", "action.slot", "action.grant_item", "action.manual", "action.setvar", "group.instance", "group.input", "group.output",
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

/// Сохранение: проверяется только структура; смысловые проблемы связей сюда не входят.
pub fn validate(mechanics: &Value) -> ApiResult<()> { check(mechanics, &mut Vec::new()) }
/// Все проблемы графа (структура с ошибкой вернётся через Err). Пустой список значит, что граф исполняется.
pub fn problems(mechanics: &Value) -> ApiResult<Vec<String>> { let mut list = Vec::new(); check(mechanics, &mut list)?; Ok(list) }
pub fn is_executable(mechanics: &Value) -> bool { matches!(problems(mechanics), Ok(list) if list.is_empty()) }
/// Проблема правила «начало → конец» (цепочка/ветвь без «Конца» или «Конец» без входа).
pub fn is_completion_problem(message: &str) -> bool {
    message == FLOW_END_UNWIRED || message == FLOW_BRANCH_UNFINISHED || message.ends_with("не завершается узлом «Конец»")
}
/// Проверять ли план блоков: незавершённый поток не отменяет проверку плана (как validate в JS),
/// иначе незакрытая цепочка скрыла бы ошибки в параметрах блоков.
pub fn plan_checks_apply(mechanics: &Value) -> bool {
    matches!(problems(mechanics), Ok(list) if list.iter().all(|message| is_completion_problem(message)))
}
fn check(mechanics: &Value, problems: &mut Vec<String>) -> ApiResult<()> {
    if mechanics["version"] != 2 || utf16_len(&mechanics.to_string()) > 1_000_000 { return Err(bad("Неподдерживаемая или слишком большая схема механик.")); }
    let graph = &mechanics["graph"];
    let groups = graph["groups"].as_array().filter(|a| a.len() <= 50).ok_or_else(|| bad("Не более 50 групп повторного использования."))?;
    // Программы всего графа (в том числе внутри групп): на них ссылается источник data.result.
    let mut programs = HashSet::new();
    for node in graph["nodes"].as_array().into_iter().flatten().chain(groups.iter().flat_map(|group| group["nodes"].as_array().into_iter().flatten())) {
        if node["type"] != "action.program" { continue; }
        if let Some(id) = node["params"]["program_id"].as_str().filter(|id| !id.is_empty()).or_else(|| node["id"].as_str()) { programs.insert(id.to_string()); }
    }
    let mut group_ids = HashSet::new();
    for g in groups {
        let id = g["id"].as_str().unwrap_or(""); let name = g["name"].as_str().unwrap_or("");
        if id.is_empty() || utf16_len(id) > 64 || !group_ids.insert(id.to_string()) || name.trim().is_empty() || utf16_len(name) > 120 { return Err(bad("Некорректная группа повторного использования.")); }
        check_interface(&g["inputs"])?; check_interface(&g["outputs"])?;
        if !g["nodes"].is_array() || !g["links"].is_array() { return Err(bad("У группы должны быть свои nodes и links.")); }
        let mut inner = json!({"nodes":g["nodes"],"links":g["links"],"frames":g.get("frames").cloned().unwrap_or(json!([]))});
        if inner["frames"].is_null() { inner["frames"] = json!([]); }
        validate_graph(&inner, groups, true, Some(g), problems, &programs)?;
        if !group_boundaries_match(g) { return Err(bad("Порты группы должны иметь по одному соответствующему узлу входа/выхода.")); }
    }
    if !group_cycle(groups) { return Err(bad("Рекурсивная ссылка или цикл между группами запрещён.")); }
    validate_graph(graph, groups, false, None, problems, &programs)
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

// Характеристика / навык: bonus — модификатор (навык — с владением), score — показатель (навык — пассивное 10 + бонус).
// Формулы те же, что в statDice (static/mechanics-graph.js); переменные *_score считает inventory::resolve.
fn stat_dice(params: &Value) -> Value {
    let id = params["id"].as_str().unwrap_or("");
    let score = params["mode"].as_str() == Some("score");
    let term = if ABILITIES.contains(&id) { if score { format!("@{id}_score") } else { format!("@{id}") } } else if score { format!("10+@{id}") } else { format!("@{id}") };
    json!({"count": 0, "sides": 6, "bonus": 0, "stat": "", "advanced": term})
}
// Текст формулы кости: как NodeRegistry.diceTerm → Mechanics.expression на клиенте (нулевой бонус не пишется).
fn dice_term(d: &Value) -> Option<String> {
    if let Some(s) = d["advanced"].as_str().filter(|s| !s.is_empty()) { return Some(s.to_string()); }
    let count = json_integer(&d["count"])?; let sides = json_integer(&d["sides"])?;
    let bonus = json_integer(&d["bonus"]).unwrap_or(0); let stat = d["stat"].as_str().unwrap_or("");
    let mut out = if count > 0 { format!("{count}d{sides}") } else { String::new() };
    if bonus != 0 { out.push_str(&if out.is_empty() { bonus.to_string() } else { format!("{bonus:+}") }); }
    if !stat.is_empty() { if out.is_empty() { out.push('@'); out.push_str(&stat); } else { out.push_str(&format!("+@{stat}")); } }
    if out.is_empty() { out = "0".into(); }
    Some(out)
}
fn bool_input(node: &Value, socket: &str, incoming: &HashMap<(String, String), Endpoint>, nodes: &HashMap<String, &Value>, context: &Value, depth: usize) -> Option<bool> {
    graph_input_value(node, socket, incoming, nodes, context, None, depth).and_then(|value| value.as_bool())
}
/// Лист исполнения из контекста: `{"runtime": {"sheet": <лист>}}`; в редакторе и предпросмотре его нет.
fn runtime_sheet(context: &Value) -> Option<&Value> { context.get("runtime").and_then(|runtime| runtime.get("sheet")) }
fn sheet_number(value: Option<&Value>) -> Option<f64> { value.and_then(|value| value.as_f64()).filter(|number| number.is_finite()) }
fn compare_numbers(op: &str, left: f64, right: f64) -> bool {
    match op { "lt" => left < right, "le" => left <= right, "gt" => left > right, "ge" => left >= right, _ => false }
}
/// Остаток ячеек круга: пул Договора (pact_slots), если его круг совпадает, иначе slots[level] (max − used).
fn slot_remaining(spells: &Value, level: i64) -> f64 {
    let pact = spells.get("pact_slots");
    let pact_level = pact.and_then(|pact| pact.get("level")).and_then(Value::as_i64);
    let pact_max = pact.and_then(|pact| sheet_number(pact.get("max"))).unwrap_or(0.0);
    if pact_max > 0.0 && pact_level == Some(level) {
        return pact_max - pact.and_then(|pact| sheet_number(pact.get("used"))).unwrap_or(0.0);
    }
    let slot = spells.get("slots").and_then(|slots| slots.get(level.to_string()));
    slot.and_then(|slot| sheet_number(slot.get("max"))).unwrap_or(0.0)
        - slot.and_then(|slot| sheet_number(slot.get("used"))).unwrap_or(0.0)
}
/// Таблица истинности узла «Логика». Неизвестный вход — None, кроме случаев, где значение
/// операции уже определено одним входом (И с ложью, ИЛИ с истиной, И-НЕ, ИЛИ-НЕ, импликация).
fn logic_value(params: &Value, node: &Value, incoming: &HashMap<(String, String), Endpoint>, nodes: &HashMap<String, &Value>, context: &Value, depth: usize) -> Option<Value> {
    let a = bool_input(node, "a", incoming, nodes, context, depth);
    let b = bool_input(node, "b", incoming, nodes, context, depth);
    let value = match params["op"].as_str()? {
        "not" => !a?,
        "and" => match (a, b) { (Some(false), _) | (_, Some(false)) => false, (Some(true), Some(true)) => true, _ => return None },
        "or" => match (a, b) { (Some(true), _) | (_, Some(true)) => true, (Some(false), Some(false)) => false, _ => return None },
        "nand" => match (a, b) { (Some(false), _) | (_, Some(false)) => true, (Some(true), Some(true)) => false, _ => return None },
        "nor" => match (a, b) { (Some(true), _) | (_, Some(true)) => false, (Some(false), Some(false)) => true, _ => return None },
        "xor" => a? != b?,
        "xnor" => a? == b?,
        "implies" => match (a, b) { (Some(false), _) | (_, Some(true)) => true, (Some(true), Some(false)) => false, _ => return None },
        _ => return None,
    };
    Some(json!(value))
}
/// Предел вложенности вычисления значений: защищает от цикла ссылок data.ref→data.ref,
/// а также от петли «ссылка → узел → ссылка», которую проверка параметров не обходит.
const MAX_VALUE_DEPTH: usize = 64;
/// Цель ссылки с префиксом экземпляра группы: `data.ref` хранит локальный ID, а развёрнутые
/// узлы групп адресуются с префиксом. В корневом графе префикса нет.
fn ref_node_id(current: &str, local: &str) -> String {
    match current.rfind('/') { Some(index) => format!("{}{}", &current[..=index], local), None => local.to_string() }
}
fn graph_output_value(endpoint: &Endpoint, nodes: &HashMap<String, &Value>, incoming: &HashMap<(String, String), Endpoint>, context: &Value, depth: usize) -> Option<Value> {
    if depth > MAX_VALUE_DEPTH { return None; }
    let node = nodes.get(&endpoint.0)?; let params = &node["params"];
    match node["type"].as_str().unwrap_or("") {
        "data.boolean" => params.get("value").and_then(Value::as_bool).map(|value| json!(value)),
        "data.math" => {
            let a = graph_input_value(node, "a", incoming, nodes, context, None, depth)?.as_f64()?;
            let b = graph_input_value(node, "b", incoming, nodes, context, None, depth)?.as_f64()?;
            let value = match params["op"].as_str()? {
                "add" => a + b, "sub" => a - b, "mul" => a * b, "div" if b != 0.0 => a / b,
                "min" => a.min(b), "max" => a.max(b), _ => return None,
            };
            Some(json!(value))
        }
        "data.stat" => Some(stat_dice(params)),
        "dice.combine" => {
            let a = dice_term(&graph_input_value(node, "a", incoming, nodes, context, None, depth)?)?;
            let b = dice_term(&graph_input_value(node, "b", incoming, nodes, context, None, depth)?)?;
            Some(json!({"count": 0, "sides": 6, "bonus": 0, "stat": "", "advanced": format!("{a}+{b}")}))
        }
        "data.compare" => {
            let a = graph_input_value(node, "a", incoming, nodes, context, None, depth)?.as_f64()?;
            let b = graph_input_value(node, "b", incoming, nodes, context, None, depth)?.as_f64()?;
            let result = match params["op"].as_str()? { ">=" => a >= b, "<=" => a <= b, ">" => a > b, "<" => a < b, "=" => a == b, "!=" => a != b, _ => return None };
            Some(json!(result))
        }
        // Рантайм-значения: результат действия из листа и поле листа. Без контекста исполнения
        // (редактор, предпросмотр, статический план) значение — 0.
        "data.result" => {
            let source = params["source"].as_str().unwrap_or("last");
            let field = params["field"].as_str().unwrap_or("total");
            let results = context.get("runtime").and_then(|runtime| runtime.get("results"));
            let entry = if source == "last" {
                results.and_then(|results| results.get("last"))
            } else {
                results.and_then(|results| results.get("by_program")).and_then(|programs| programs.get(source))
            };
            Some(match entry.and_then(|entry| entry.get(field)) {
                Some(Value::Bool(hit)) => json!(if *hit { 1 } else { 0 }),
                Some(Value::Number(number)) => Value::Number(number.clone()),
                _ => json!(0),
            })
        }
        "data.sheet" => {
            let field = params["field"].as_str().unwrap_or("");
            let pointer = format!("/{}", field.replace('.', "/"));
            let value = context.get("runtime").and_then(|runtime| runtime.get("sheet")).and_then(|sheet| sheet.pointer(&pointer));
            Some(match value {
                Some(Value::Number(number)) => Value::Number(number.clone()),
                _ => json!(0),
            })
        }
        // Круг каста: уровень выбранной ячейки, базовый круг заклинания и число лишних кругов.
        // Без контекста исполнения (редактор, предпросмотр) — 0.
        "data.cast" => {
            let cast = context.get("cast");
            let key = match params["field"].as_str().unwrap_or("level") { "base" => "base", "extra" => "extra", _ => "level" };
            Some(cast.and_then(|cast| cast.get(key)).and_then(Value::as_i64).map(|value| json!(value)).unwrap_or(json!(0)))
        }
        // Переменная выполнения: `runtime.vars` — числа листа плюс записанные действием.
        // Область sheet дополнительно проверяет лист: в рантайме обе карты синхронны.
        // Без контекста выполнения (редактор, предпросмотр) — 0.
        "data.var" => {
            let name = params["name"].as_str().unwrap_or("");
            let runtime = context.get("runtime");
            let vars = runtime.and_then(|runtime| runtime.get("vars"));
            let sheet_vars = runtime.and_then(|runtime| runtime.get("sheet")).and_then(|sheet| sheet.get("vars"));
            let map = if params["scope"].as_str() == Some("sheet") { sheet_vars.or(vars) } else { vars.or(sheet_vars) };
            Some(json!(map.and_then(|map| map.get(name)).and_then(Value::as_f64).unwrap_or(0.0)))
        }
        // Ссылка на числовой узел этого же графа (или группы): значение цели в том же контексте.
        // Цепочку ref→ref ведём явно, чтобы не зациклиться на испорченной записи.
        "data.ref" => {
            // ID цели локальный, а развёрнутые узлы группы адресуются с префиксом экземпляра.
            let mut target = ref_node_id(node["id"].as_str()?, params["node"].as_str()?);
            let mut seen: HashSet<String> = HashSet::new();
            loop {
                if !seen.insert(target.clone()) || seen.len() > MAX_VALUE_DEPTH { return None; }
                let target_node = nodes.get(&target)?;
                if target_node["type"] != "data.ref" {
                    return graph_output_value(&(target, "value".to_string()), nodes, incoming, context, depth + 1);
                }
                let local = target_node["params"]["node"].as_str()?;
                target = ref_node_id(&target, local);
            }
        }
        // Математика одного числа и диапазона (та же таблица, что mathfunValue на клиенте).
        "data.mathfun" => {
            let a = graph_input_value(node, "a", incoming, nodes, context, None, depth)?.as_f64()?;
            let b = graph_input_value(node, "b", incoming, nodes, context, None, depth).and_then(|value| value.as_f64());
            let c = graph_input_value(node, "c", incoming, nodes, context, None, depth).and_then(|value| value.as_f64());
            mathfun_value(params["op"].as_str()?, a, b, c).map(|value| json!(value))
        }
        // Логика: таблица истинности всех восьми операций (как compute в static/nodes/logic/op.js).
        // Неизвестный вход даёт None, кроме случаев, где значение уже определено одним входом.
        "logic.op" => logic_value(params, node, incoming, nodes, context, depth),
        // Условия листа: читают runtime-лист (context["runtime"]["sheet"]). Без листа — false.
        "condition.status" => {
            let name = params["name"].as_str()?;
            let present = runtime_sheet(context).and_then(|sheet| sheet.get("conditions")).and_then(Value::as_array)
                .map(|items| items.iter().any(|item| item.as_str() == Some(name))).unwrap_or(false);
            Some(json!(if params["mode"].as_str() == Some("absent") { !present } else { present }))
        }
        "condition.item" => {
            let name = params["name"].as_str()?;
            let equipped = params["mode"].as_str() == Some("equipped");
            let found = runtime_sheet(context).and_then(|sheet| sheet.get("inventory")).and_then(Value::as_array)
                .map(|items| items.iter().any(|item| item["name"].as_str() == Some(name) && (!equipped || item["equipped"].as_bool() == Some(true))))
                .unwrap_or(false);
            Some(json!(found))
        }
        "condition.hp" => {
            let op = params["op"].as_str()?;
            let value = params["value"].as_f64()?;
            let hp = runtime_sheet(context).and_then(|sheet| sheet.get("hp"));
            let current = hp.and_then(|hp| sheet_number(hp.get("current")));
            let left = match current {
                None => None,
                Some(current) if params["percent"].as_bool() == Some(true) => {
                    let max = hp.and_then(|hp| sheet_number(hp.get("max"))).unwrap_or(0.0);
                    Some(if max > 0.0 { current * 100.0 / max } else { 0.0 })
                }
                Some(current) => Some(current),
            };
            Some(json!(left.map(|left| compare_numbers(op, left, value)).unwrap_or(false)))
        }
        "condition.slot" => {
            let level = json_integer(&params["level"])?;
            let op = params["op"].as_str()?;
            let value = params["value"].as_f64()?;
            let remaining = runtime_sheet(context).and_then(|sheet| sheet.get("spells")).map(|spells| slot_remaining(spells, level));
            let matched = remaining.map(|remaining| if op == "lt" { remaining < value } else { remaining >= value }).unwrap_or(false);
            Some(json!(matched))
        }
        kind if kind.starts_with("data.") => params.get("value").cloned(),

        "condition.context" => match params["kind"].as_str()? {
            "edition" => {
                let edition = context.get("edition")?.as_str()?;
                Some(json!(params["editions"].as_array().into_iter().flatten().any(|item| item.as_str() == Some(edition))))
            }
            "level" => {
                let level = context.get("level")?.as_i64()?;
                Some(json!(level >= params["min"].as_i64()? && level <= params["max"].as_i64()?))
            }
            "subclass" => Some(json!(context.get("subclass")? == &params["id"])),
            "choice" => {
                let choices = context.get("choices")?.as_object()?;
                let id = params["id"].as_str()?;
                Some(json!(choices.get(id).map(|value| value == &params["value"]).unwrap_or(false)))
            }
            _ => None,
        },
        _ => None,
    }
}
fn graph_input_value(node: &Value, socket: &str, incoming: &HashMap<(String, String), Endpoint>, nodes: &HashMap<String, &Value>, context: &Value, fallback: Option<Value>, depth: usize) -> Option<Value> {
    let key = (node["id"].as_str().unwrap_or("").to_string(), socket.to_string());
    if let Some(source) = incoming.get(&key) { graph_output_value(source, nodes, incoming, context, depth + 1) } else { fallback }
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
        // Очередь хранит [конечная точка, гейт]. Гейт «hit»/«miss» ставит ветка «Если» по условию «Попадание атаки»
        // и действует только на узел у выхода ветки (как when в v1); продолжение цепочки — без гейта.
        let mut pending: Vec<(Endpoint, Option<String>)> = outgoing.get(&start).cloned().unwrap_or_default().into_iter().rev().map(|endpoint| (endpoint, None)).collect();
        let mut visited = HashSet::new(); let mut blocks = Vec::new();
        while let Some(((node_id, _input_socket), gate)) = pending.pop() {
            if !visited.insert(node_id.clone()) { continue; }
            let Some(current) = nodes.get(&node_id).copied() else { continue; };
            if current["type"] == "flow.if" {
                let hit_gate = incoming.get(&(node_id.clone(), "condition".to_string())).and_then(|source| nodes.get(&source.0).copied()).is_some_and(|source| source["type"] == "condition.hit");
                let condition = if hit_gate { None } else { graph_input_value(current, "condition", &incoming, &nodes, context, None, 0).and_then(|value| value.as_bool()) };
                let sockets: &[&str] = match condition { Some(true) => &["then"], Some(false) => &["else"], None => &["then", "else"] };
                for socket in sockets.iter().rev() {
                    let branch: Option<String> = if hit_gate { Some(if *socket == "then" { "hit".to_string() } else { "miss".to_string() }) } else { gate.clone() };
                    let key = (node_id.clone(), (*socket).to_string());
                    for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push((target, branch.clone())); }
                }
                continue;
            }
            let mut block = current["params"].as_object().cloned().unwrap_or_default();
            let mut kind = current["type"].as_str().unwrap_or("").strip_prefix("action.").unwrap_or("").to_string();
            // Вид блока плана: у «Броска» и «Изменить поле» — параметр kind,
            // «Расход ресурса» компилируется в прежний блок consume (как blockKindOf в клиенте).
            if kind == "roll" {
                if let Some(requested) = block.remove("kind").and_then(|requested| requested.as_str().map(str::to_string)) {
                    if ROLL_KINDS.contains(&requested.as_str()) { kind = requested; }
                }
            } else if kind == "spend" {
                kind = "consume".into();
            } else if kind == "slot" {
                // Отдельный узел «Расход ячейки»: в плане это прежний блок consume с resource=slot.
                // level 0 означает «круг, выбранный при касте»: сервер подставит его из контекста.
                kind = "consume".into();
                let level = block.remove("level").unwrap_or(json!(0));
                block.insert("slot_level".into(), level);
                block.insert("resource".into(), json!("slot"));
                block.insert("source".into(), json!("self"));
                block.insert("trigger".into(), json!("use"));
                if block.get("amount").is_none() { block.insert("amount".into(), json!(1)); }
            } else if kind == "field" {
                let field_kind = block.remove("kind").and_then(|requested| requested.as_str().map(str::to_string)).unwrap_or_default();
                kind = FIELD_BLOCKS.iter().find(|(node_kind, _)| *node_kind == field_kind).map(|(_, block_kind)| (*block_kind).to_string()).unwrap_or_default();
                // В блок плана попадают только поля выбранного вида; остальные остаются в узле.
                match field_kind.as_str() {
                    "status" => { block.remove("field"); block.remove("amount"); block.remove("value"); }
                    "value" => { block.remove("condition"); block.remove("operation"); block.remove("value"); }
                    "formula" => { block.remove("condition"); block.remove("operation"); block.remove("amount"); }
                    _ => {}
                }
            }
            if !ACTIONS.contains(&kind.as_str()) { continue; }
            if let Some(g) = &gate { if block.get("when").map_or(true, |w| *w == "always") { block.insert("when".into(), json!(g)); } }
            // Кость, поданная проводом на вход «dice», заменяет поле блока (как в v2ToV1 клиента).
            if let Some(value) = graph_input_value(current, "dice", &incoming, &nodes, context, None, 0) { block.insert("dice".into(), value); }
            // Записать переменную: имя и область остаются в блоке, значение — с провода value.
            // Исполнитель считает провод в рантайме по value_src (как condition_src); рядом
            // лежит статическая оценка для предпросмотра.
            if kind == "setvar" {
                match incoming.get(&(node_id.clone(), "value".to_string())).cloned() {
                    Some((source, _)) => {
                        if let Some(value) = graph_input_value(current, "value", &incoming, &nodes, context, None, 0) { block.insert("value".into(), value); }
                        block.insert("value_src".into(), json!(source));
                    }
                    None => { if block.get("value").is_none() { block.insert("value".into(), json!(0)); } }
                }
            }
            let enabled = graph_input_value(current, "enabled", &incoming, &nodes, context, block.get("enabled").cloned(), 0);
            if enabled.as_ref().is_some_and(|value| value == &json!(false)) {
                let key = (node_id.clone(), "exec".to_string());
                for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push((target, None)); }
                continue;
            }
            if let Some(value) = enabled { block.insert("enabled".into(), value); }
            // Условие блока: если ко входу condition подведён провод, значение зависит от листа и
            // результатов действий и вычисляется исполнителем в рантайме. В план кладётся id
            // узла-источника (condition_src); статическая проверка остаётся только без провода.
            match incoming.get(&(node_id.clone(), "condition".to_string())).cloned() {
                Some((source, _)) => { block.insert("condition_src".into(), json!(source)); }
                None => if graph_input_value(current, "condition", &incoming, &nodes, context, None, 0).and_then(|value| value.as_bool()) == Some(false) {
                    let key = (node_id.clone(), "exec".to_string());
                    for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push((target, None)); }
                    continue;
                },
            }
            let block_id = block.remove("block_id").unwrap_or(json!(node_id));
            block.insert("id".into(), block_id); block.insert("kind".into(), json!(kind)); blocks.push(Value::Object(block));
            let key = (node_id, "exec".to_string());
            for target in outgoing.get(&key).cloned().unwrap_or_default().into_iter().rev() { pending.push((target, None)); }
        }
        program.insert("blocks".into(), json!(blocks)); programs.push(Value::Object(program));
    }
    let mut out = json!({"version":1,"programs":programs});
    // Граф нужен исполнителю: по condition_src он вычисляет условие блока в рантайме.
    if let Some(graph) = mechanics.get("graph") { out["graph"] = graph.clone(); }
    for key in ["origin", "item_defaults"] { if let Some(value) = mechanics.get(key) { out[key] = value.clone(); } }
    out
}
fn from_endpoint(link: &Value) -> Endpoint { (link["from"]["node"].as_str().unwrap_or("").to_string(), link["from"]["socket"].as_str().unwrap_or("").to_string()) }

/// Значение узла графа в рантайме — та же функция, что считает значения при компиляции,
/// но с контекстом исполнения: `{"runtime": {"sheet": <лист>, "results": <action_results>}}`.
/// Узлы групп разворачиваются так же, как в плане, поэтому id из condition_src совпадает.
/// Неизвестный узел — ошибка; невычислимое значение — `null` (исполнитель не пропускает блок).
pub fn node_value(graph: &Value, node_id: &str, context: &Value) -> ApiResult<Value> {
    let groups = graph["groups"].as_array().cloned().unwrap_or_default();
    let (expanded_nodes, links) = expand_graph(graph, &groups);
    let nodes: HashMap<String, &Value> = expanded_nodes.iter().filter_map(|node| node["id"].as_str().map(|id| (id.to_string(), node))).collect();
    if !nodes.contains_key(node_id) { return Err(bad("Узел условия не найден в графе.")); }
    let mut incoming: HashMap<(String, String), Endpoint> = HashMap::new();
    for link in &links {
        let to = (link["to"]["node"].as_str().unwrap_or("").to_string(), link["to"]["socket"].as_str().unwrap_or("").to_string());
        incoming.insert(to, from_endpoint(link));
    }
    let endpoint = (node_id.to_string(), "value".to_string());
    Ok(graph_output_value(&endpoint, &nodes, &incoming, context, 0).unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_matches_the_shared_graph_contract_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/mechanics-graph.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = validate(&case["mechanics"]).is_ok();
            assert_eq!(actual, case["valid"].as_bool().unwrap(), "saves: {}", case["name"].as_str().unwrap());
            assert_eq!(is_executable(&case["mechanics"]), case["executable"].as_bool().unwrap(), "executes: {}", case["name"].as_str().unwrap());
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
    /// Ссылка внутри повторно используемой группы: локальный ID цели получает префикс экземпляра.
    #[test]
    fn data_ref_inside_a_group_resolves_with_the_instance_prefix() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/mechanics-graph.json")).unwrap();
        let graph = fixture["cases"].as_array().unwrap().iter().find(|case| case["name"] == "data-ref-inside-a-group").unwrap();
        let compiled = to_v1(&graph["mechanics"]);
        let blocks = compiled["programs"][0]["blocks"].as_array().unwrap();
        assert_eq!(blocks[0]["value"].as_f64(), Some(9.0));
    }
}

#[cfg(test)]
mod hit_gate_tests {
    use super::*;

    /// Атака → «Если» по условию «Попадание атаки» → урон. Бросок атаки детерминирован (без костей, +5).
    /// Обе ветви и хвост цепочки сходятся в «Конце»: поток действия завершён.
    fn hit_chain() -> Value {
        json!({"version": 2, "origin": "test", "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Удар", "trigger": "use"}},
            {"id": "a", "type": "action.roll", "params": {"block_id": "atk", "kind": "attack", "enabled": true, "dice": {"count": 0, "sides": 20, "bonus": 5, "stat": ""}, "dc": 3}},
            {"id": "h", "type": "condition.hit", "params": {}},
            {"id": "f", "type": "flow.if", "params": {}},
            {"id": "d", "type": "action.roll", "params": {"block_id": "dmg", "kind": "damage", "enabled": true, "dice": {"count": 0, "sides": 6, "bonus": 2, "stat": ""}}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "a", "socket": "exec"}},
            {"from": {"node": "a", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}},
            {"from": {"node": "h", "socket": "value"}, "to": {"node": "f", "socket": "condition"}},
            {"from": {"node": "f", "socket": "then"}, "to": {"node": "d", "socket": "exec"}},
            {"from": {"node": "f", "socket": "else"}, "to": {"node": "e", "socket": "exec"}},
            {"from": {"node": "d", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}})
    }

    /// Настраиваемый узел «Бросок»: kind задаёт вид блока v1 и не остаётся лишним параметром.
    #[test]
    fn configurable_roll_node_compiles_kind_param_into_the_block_kind() {
        let graph = json!({"version": 2, "origin": "test", "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Удар", "trigger": "use"}},
            {"id": "a", "type": "action.roll", "params": {"block_id": "atk", "kind": "attack", "enabled": true, "dice": {"count": 0, "sides": 20, "bonus": 5, "stat": ""}}},
            {"id": "d", "type": "action.roll", "params": {"block_id": "dmg", "kind": "damage", "enabled": true, "dice": {"count": 1, "sides": 6, "bonus": 0, "stat": ""}}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "a", "socket": "exec"}},
            {"from": {"node": "a", "socket": "exec"}, "to": {"node": "d", "socket": "exec"}},
            {"from": {"node": "d", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        assert!(problems(&graph).unwrap().is_empty());
        let v1 = to_v1(&graph);
        let blocks = v1["programs"][0]["blocks"].as_array().unwrap();
        assert_eq!(blocks[0]["kind"], "attack");
        assert_eq!(blocks[1]["kind"], "damage");
        assert!(blocks.iter().all(|block| block.get("dice").is_some()));
        // Неизвестный вид броска отклоняется при сохранении.
        let mut bad_graph = graph.clone();
        bad_graph["graph"]["nodes"][1]["params"]["kind"] = json!("save");
        assert!(validate(&bad_graph).is_err());
    }

    /// Настраиваемый узел «Логика»: op выбирает одну из восьми операций, неизвестное значение отклоняется.
    #[test]
    fn configurable_logic_node_validates_and_evaluates_ops() {
        let make = |op: &str| json!({"version": 2, "origin": "test", "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "lv", "type": "condition.context", "params": {"kind": "level", "min": 1, "max": 10}},
            {"id": "ed", "type": "condition.context", "params": {"kind": "edition", "editions": ["2014"]}},
            {"id": "op", "type": "logic.op", "params": {"op": op}},
            {"id": "f", "type": "flow.if", "params": {}},
            {"id": "m", "type": "action.manual", "params": {"block_id": "m", "text": "then", "when": "always"}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "lv", "socket": "value"}, "to": {"node": "op", "socket": "a"}},
            {"from": {"node": "ed", "socket": "value"}, "to": {"node": "op", "socket": "b"}},
            {"from": {"node": "op", "socket": "value"}, "to": {"node": "f", "socket": "condition"}},
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}},
            {"from": {"node": "f", "socket": "then"}, "to": {"node": "m", "socket": "exec"}},
            {"from": {"node": "f", "socket": "else"}, "to": {"node": "e", "socket": "exec"}},
            {"from": {"node": "m", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        let graph = make("and");
        assert!(problems(&graph).unwrap().is_empty());
        let context = json!({"edition": "2014", "level": 5});
        let v1 = to_v1_with_context(&graph, &context);
        assert_eq!(v1["programs"][0]["blocks"].as_array().unwrap().len(), 1, "И с истинными входами оставляет ветвь «да»");
        let missed = to_v1_with_context(&make("not"), &json!({"edition": "2014", "level": 5}));
        assert_eq!(missed["programs"][0]["blocks"].as_array().unwrap().len(), 0, "НЕ по истинному входу отсекает ветвь «да»");
        assert!(validate(&make("nimp")).is_err());
    }

    /// Таблица истинности всех восьми операций узла «Логика» — та же, что compute в static/nodes/logic/op.js.
    #[test]
    fn logic_ops_follow_the_truth_table() {
        let expected = |op: &str, a: bool, b: bool| match op {
            "and" => a && b, "or" => a || b, "not" => !a,
            "xor" => a != b, "nand" => !(a && b), "nor" => !(a || b), "xnor" => a == b, "implies" => !a || b,
            other => panic!("неизвестная операция {other}"),
        };
        // Граф из булевых констант: узел «Логика» читает их без листа.
        let graph = |op: &str, a: bool, b: bool| {
            let mut nodes = vec![
                json!({"id": "a", "type": "data.boolean", "params": {"value": a}}),
                json!({"id": "op", "type": "logic.op", "params": {"op": op}}),
            ];
            let mut links = vec![json!({"from": {"node": "a", "socket": "value"}, "to": {"node": "op", "socket": "a"}})];
            if op != "not" {
                nodes.push(json!({"id": "b", "type": "data.boolean", "params": {"value": b}}));
                links.push(json!({"from": {"node": "b", "socket": "value"}, "to": {"node": "op", "socket": "b"}}));
            }
            json!({"version": 2, "graph": {"nodes": nodes, "links": links, "frames": [], "groups": []}})
        };
        for op in LOGIC_OPS {
            let (inputs, _) = ports_for("logic.op", &json!({"op": op}), &[], None);
            assert_eq!(inputs.contains_key("b"), *op != "not", "{op}: вход «b» только у операций с двумя входами");
            for a in [true, false] {
                for b in [true, false] {
                    let mechanics = graph(op, a, b);
                    assert!(validate(&mechanics).is_ok(), "{op}: граф допустим");
                    assert_eq!(node_value(&mechanics["graph"], "op", &Value::Null).unwrap(), json!(expected(op, a, b)), "{op}: a={a}, b={b}");
                }
            }
        }
    }

    /// Один узел «Условие» с видом: редакция, уровень, подкласс и выбор читают контекст листа.
    #[test]
    fn context_condition_uses_edition_level_subclass_and_choices() {
        let branch = |params: Value, context: &Value| -> usize {
            let graph = json!({"version": 2, "origin": "test", "graph": {"nodes": [
                {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
                {"id": "c", "type": "condition.context", "params": params},
                {"id": "f", "type": "flow.if", "params": {}},
                {"id": "m", "type": "action.manual", "params": {"block_id": "m", "text": "then", "when": "always"}},
                {"id": "e", "type": "flow.end", "params": {}}
            ], "links": [
                {"from": {"node": "c", "socket": "value"}, "to": {"node": "f", "socket": "condition"}},
                {"from": {"node": "p", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}},
                {"from": {"node": "f", "socket": "then"}, "to": {"node": "m", "socket": "exec"}},
                {"from": {"node": "m", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}},
                {"from": {"node": "f", "socket": "else"}, "to": {"node": "e", "socket": "exec"}}
            ], "frames": [], "groups": []}});
            assert!(problems(&graph).unwrap().is_empty());
            let v1 = to_v1_with_context(&graph, context);
            v1["programs"][0]["blocks"].as_array().unwrap().len()
        };
        let base = json!({"edition": "2014", "level": 5, "subclass": "champion", "choices": {"style": "duelist"}});
        assert_eq!(branch(json!({"kind": "edition", "editions": ["2014"]}), &base), 1);
        assert_eq!(branch(json!({"kind": "edition", "editions": ["2024"]}), &base), 0);
        assert_eq!(branch(json!({"kind": "level", "min": 1, "max": 20}), &base), 1);
        assert_eq!(branch(json!({"kind": "level", "min": 6, "max": 20}), &base), 0);
        assert_eq!(branch(json!({"kind": "subclass", "id": "champion"}), &base), 1);
        assert_eq!(branch(json!({"kind": "subclass", "id": "battlemaster"}), &base), 0);
        assert_eq!(branch(json!({"kind": "choice", "id": "style", "value": "duelist"}), &base), 1);
        assert_eq!(branch(json!({"kind": "choice", "id": "style", "value": "archery"}), &base), 0);
        assert!(validate(&json!({"version": 2, "graph": {"nodes": [
            {"id": "c", "type": "condition.context", "params": {"kind": "unknown"}}
        ], "links": [], "frames": [], "groups": []}})).is_err());
    }

    #[test]
    fn hit_branch_compiles_to_a_gated_block() {
        let graph = hit_chain();
        assert!(problems(&graph).unwrap().is_empty());
        let v1 = to_v1(&graph);
        let blocks = v1["programs"][0]["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["kind"], "attack");
        assert_eq!(blocks[1]["kind"], "damage");
        assert_eq!(blocks[1]["when"], "hit");
    }

    #[test]
    fn hit_condition_only_feeds_a_branch() {
        let mut graph = hit_chain();
        // Условие попадания подключено к узлу, который не является «Если»: сохранение и исполнение отклоняют граф.
        graph["graph"]["links"].as_array_mut().unwrap().push(json!({"from": {"node": "h", "socket": "value"}, "to": {"node": "d", "socket": "enabled"}}));
        let list = problems(&graph).unwrap();
        assert!(list.iter().any(|message| message.contains("только ко входу")), "{list:?}");
    }

    #[test]
    fn dice_term_skips_zero_bonus() { // Как NodeRegistry.diceTerm → Mechanics.expression на клиенте.
        assert_eq!(dice_term(&json!({"count": 1, "sides": 8, "bonus": 0, "stat": "str"})).unwrap(), "1d8+@str");
        assert_eq!(dice_term(&json!({"count": 0, "sides": 6, "bonus": 0, "stat": "dex"})).unwrap(), "@dex");
        assert_eq!(dice_term(&json!({"count": 0, "sides": 6, "bonus": 5, "stat": ""})).unwrap(), "5");
        assert_eq!(dice_term(&json!({"count": 2, "sides": 6, "bonus": 3, "stat": ""})).unwrap(), "2d6+3");
        assert_eq!(dice_term(&json!({"advanced": "2d20kh1+@prof"})).unwrap(), "2d20kh1+@prof");
    }

    #[test]
    fn nested_hit_branches_are_problems() {
        let mut graph = hit_chain();
        let nodes = graph["graph"]["nodes"].as_array_mut().unwrap();
        nodes.push(json!({"id": "h2", "type": "condition.hit", "params": {}}));
        nodes.push(json!({"id": "f2", "type": "flow.if", "params": {}}));
        let links = graph["graph"]["links"].as_array_mut().unwrap();
        links.push(json!({"from": {"node": "h2", "socket": "value"}, "to": {"node": "f2", "socket": "condition"}}));
        links.push(json!({"from": {"node": "f", "socket": "then"}, "to": {"node": "f2", "socket": "exec"}}));
        let list = problems(&graph).unwrap();
        assert!(list.iter().any(|message| message.contains("вкладывать")), "{list:?}");
    }

    /// «Начало → Конец»: цепочка без «Конца» не исполняется, но сохраняется; «Конец» без входа и
    /// незавершённая ветвь — тоже проблемы. Сама схема при этом структурно корректна.
    #[test]
    fn flow_must_reach_the_end_node() {
        // Цепочка «Начало» → ручное правило без «Конца».
        let open_chain = json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Обрыв", "trigger": "use"}},
            {"id": "m", "type": "action.manual", "params": {"block_id": "m", "text": "Правило", "when": "always"}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "m", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        assert!(validate(&open_chain).is_ok(), "запись сохраняется");
        let list = problems(&open_chain).unwrap();
        assert!(list.contains(&"Действие «Обрыв» не завершается узлом «Конец»".to_string()), "{list:?}");

        // Та же цепочка с «Концом» — исполняется.
        let mut closed_chain = open_chain.clone();
        closed_chain["graph"]["nodes"].as_array_mut().unwrap().push(json!({"id": "e", "type": "flow.end", "params": {}}));
        closed_chain["graph"]["links"].as_array_mut().unwrap().push(json!({"from": {"node": "m", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}));
        assert!(problems(&closed_chain).unwrap().is_empty());

        // «Конец» без входящего потока — проблема, даже если цепочка действия завершена.
        let mut stray_end = closed_chain.clone();
        stray_end["graph"]["nodes"].as_array_mut().unwrap().push(json!({"id": "e2", "type": "flow.end", "params": {}}));
        let list = problems(&stray_end).unwrap();
        assert!(list.contains(&"«Конец» ни к чему не подключён".to_string()), "{list:?}");

        // Ветвь «Если» без продолжения — проблема ветви, а не всего действия.
        let mut branch = hit_chain();
        let links = branch["graph"]["links"].as_array_mut().unwrap();
        links.retain(|link| link["from"]["socket"] != "else");
        let list = problems(&branch).unwrap();
        assert!(list.contains(&"Ветка не завершается узлом «Конец»".to_string()), "{list:?}");
    }
}

#[cfg(test)]
mod action_node_tests {
    use super::*;

    /// Действие: «Начало» → блок → ручное правило → «Конец». К входу condition блока подключена
    /// логическая константа; `None` — вход не подключён.
    fn chain(params: Value, condition: Option<bool>) -> Value {
        let mut nodes = vec![
            json!({"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}}),
            json!({"id": "f", "type": "action.field", "params": params}),
            json!({"id": "m", "type": "action.manual", "params": {"block_id": "m", "text": "Правило", "when": "always"}}),
            json!({"id": "e", "type": "flow.end", "params": {}}),
        ];
        let mut links = vec![
            json!({"from": {"node": "p", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}}),
            json!({"from": {"node": "f", "socket": "exec"}, "to": {"node": "m", "socket": "exec"}}),
            json!({"from": {"node": "m", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}),
        ];
        if let Some(value) = condition {
            nodes.push(json!({"id": "c", "type": "data.boolean", "params": {"value": value}}));
            links.push(json!({"from": {"node": "c", "socket": "value"}, "to": {"node": "f", "socket": "condition"}}));
        }
        json!({"version": 2, "origin": "test", "graph": {"nodes": nodes, "links": links, "frames": [], "groups": []}})
    }
    fn value_field() -> Value { json!({"block_id": "f", "kind": "value", "field": "speed", "amount": 5, "enabled": true, "when": "always"}) }

    /// У каждого узла действия есть входы enabled и condition: условие пропускает блок, но не поток.
    #[test]
    fn every_action_node_has_enabled_and_condition_inputs() {
        for kind in NODE_TYPES.iter().filter(|kind| kind.starts_with("action.") && **kind != "action.program") {
            let (inputs, _) = ports_for(kind, &json!({}), &[], None);
            assert_eq!(inputs.get("enabled").map(String::as_str), Some("bool"), "{kind}: enabled");
            assert_eq!(inputs.get("condition").map(String::as_str), Some("bool"), "{kind}: condition");
        }
    }

    /// Провод на вход condition откладывает условие до рантайма: в план попадает блок
    /// с condition_src (id узла-источника), а не результат статической проверки.
    #[test]
    fn block_condition_is_deferred_to_the_runtime_source_node() {
        let graph = chain(value_field(), Some(false));
        assert!(problems(&graph).unwrap().is_empty());
        let compiled = to_v1(&graph);
        let blocks = compiled["programs"][0]["blocks"].as_array().unwrap();
        assert_eq!(blocks.iter().map(|block| block["kind"].as_str().unwrap()).collect::<Vec<_>>(), vec!["adjust", "manual"], "блок с проводом на condition остаётся в плане");
        assert_eq!(blocks[0]["condition_src"], "c");
        assert_eq!(compiled["graph"]["nodes"].as_array().unwrap().len(), 5, "план несёт граф для рантайма");
        // Без провода на condition блок выполняется как раньше и condition_src не появляется.
        let plain = to_v1(&chain(value_field(), None));
        let plain_blocks = plain["programs"][0]["blocks"].as_array().unwrap();
        assert_eq!(plain_blocks.len(), 2);
        assert!(plain_blocks[0].get("condition_src").is_none());
    }

    /// Виды «Изменить поле» компилируются в прежние блоки плана: status → condition, value → adjust,
    /// formula → passive. «Расход ресурса» — в consume. Старых имён узлов в графе нет.
    #[test]
    fn field_kinds_and_spend_compile_into_legacy_block_kinds() {
        let field = |kind: &str, params: Value| {
            let trigger = if kind == "formula" { "passive" } else { "use" };
            json!({"version": 2, "graph": {"nodes": [
                {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": trigger}},
                {"id": "f", "type": "action.field", "params": params},
                {"id": "e", "type": "flow.end", "params": {}}
            ], "links": [
                {"from": {"node": "p", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}},
                {"from": {"node": "f", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
            ], "frames": [], "groups": []}})
        };
        let status = to_v1(&field("status", json!({"block_id": "f", "kind": "status", "condition": "Отравленный", "operation": "add"})));
        let block = &status["programs"][0]["blocks"][0];
        assert_eq!(block["kind"], "condition");
        assert_eq!(block["condition"], "Отравленный");
        assert_eq!(block["operation"], "add");
        assert!(block.get("field").is_none());
        let value = to_v1(&field("value", json!({"block_id": "f", "kind": "value", "field": "speed", "amount": 5})));
        let block = &value["programs"][0]["blocks"][0];
        assert_eq!(block["kind"], "adjust");
        assert_eq!(block["field"], "speed");
        assert_eq!(block["amount"], 5);
        let formula = to_v1(&field("formula", json!({"block_id": "f", "kind": "formula", "field": "asi.str", "value": 2})));
        let block = &formula["programs"][0]["blocks"][0];
        assert_eq!(block["kind"], "passive");
        assert_eq!(block["field"], "asi.str");
        assert_eq!(block["value"], 2);
        let spend_graph = json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "s", "type": "action.spend", "params": {"block_id": "s", "resource": "charges", "source": "self", "amount": 1, "trigger": "use"}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "s", "socket": "exec"}},
            {"from": {"node": "s", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        let compiled = to_v1(&spend_graph);
        assert_eq!(compiled["programs"][0]["blocks"][0]["kind"], "consume");
        assert_eq!(compiled["programs"][0]["blocks"][0]["resource"], "charges");
        // «Расход ячейки» — отдельный узел: level 0 означает круг, выбранный при касте.
        let slot_graph = json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "s", "type": "action.slot", "params": {"block_id": "s", "level": 0, "amount": 1}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "s", "socket": "exec"}},
            {"from": {"node": "s", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        let compiled = to_v1(&slot_graph);
        let block = &compiled["programs"][0]["blocks"][0];
        assert_eq!(block["kind"], "consume");
        assert_eq!(block["resource"], "slot");
        assert_eq!(block["source"], "self");
        assert_eq!(block["slot_level"], 0);
        assert_eq!(block["amount"], 1);
    }

    /// Неизвестный вид «Изменить поле» и неизвестный ресурс расхода отклоняются при сохранении.
    #[test]
    fn unknown_field_kind_and_spend_resource_are_rejected() {
        assert!(validate(&chain(json!({"block_id": "f", "kind": "unknown", "field": "speed"}), None)).is_err());
        let spend = |params: Value| json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "s", "type": "action.spend", "params": params},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "s", "socket": "exec"}},
            {"from": {"node": "s", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        assert!(validate(&spend(json!({"block_id": "s", "resource": "gold", "source": "self", "amount": 1, "trigger": "use"}))).is_err());
        assert!(validate(&spend(json!({"block_id": "s", "resource": "quantity", "source": "tag", "amount": 1, "trigger": "use"}))).is_err(), "метка обязательна");
        assert!(validate(&spend(json!({"block_id": "s", "resource": "slot", "source": "self", "amount": 1, "trigger": "use", "slot_level": 1}))).is_err(), "ячейка — отдельный узел action.slot");
        let slot = |params: Value| json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "s", "type": "action.slot", "params": params},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "s", "socket": "exec"}},
            {"from": {"node": "s", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}
        ], "frames": [], "groups": []}});
        assert!(validate(&slot(json!({"block_id": "s", "level": 0, "amount": 1}))).is_ok());
        assert!(validate(&slot(json!({"block_id": "s", "level": 10, "amount": 1}))).is_err());
        assert!(validate(&slot(json!({"block_id": "s", "level": 1, "amount": 0}))).is_err());
    }
}

#[cfg(test)]
mod data_runtime_tests {
    use super::*;

    /// Программа с блоком, условие которого читает data.result/data.sheet через data.compare.
    fn gate(sensor: Value) -> Value {
        json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            sensor,
            {"id": "n", "type": "data.number", "params": {"value": 5}},
            {"id": "cmp", "type": "data.compare", "params": {"op": ">"}},
            {"id": "f", "type": "action.field", "params": {"block_id": "f", "kind": "value", "field": "speed", "amount": 1}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "f", "socket": "exec"}},
            {"from": {"node": "f", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}},
            {"from": {"node": "src", "socket": "value"}, "to": {"node": "cmp", "socket": "a"}},
            {"from": {"node": "n", "socket": "value"}, "to": {"node": "cmp", "socket": "b"}},
            {"from": {"node": "cmp", "socket": "value"}, "to": {"node": "f", "socket": "condition"}}
        ], "frames": [], "groups": []}})
    }
    fn runtime(results: Value, sheet: Value) -> Value { json!({"runtime": {"results": results, "sheet": sheet}}) }

    /// data.result: last и конкретная программа; hit хранится bool, а узел отдаёт 0/1.
    #[test]
    fn data_result_reads_the_last_action_and_a_named_program() {
        let graph = gate(json!({"id": "src", "type": "data.result", "params": {"source": "last", "field": "total"}}));
        assert!(validate(&graph).is_ok());
        let plan = to_v1(&graph);
        assert_eq!(plan["programs"][0]["blocks"][0]["condition_src"], "cmp", "источник условия — узел, подключённый к condition");
        let value = |results: Value| node_value(&graph["graph"], "src", &runtime(results, json!({}))).unwrap();
        assert_eq!(value(json!({"last": {"total": 9}, "by_program": {}})), json!(9));
        assert_eq!(value(json!({"last": {"total": 2}, "by_program": {}})), json!(2));
        let hit = gate(json!({"id": "src", "type": "data.result", "params": {"source": "last", "field": "hit"}}));
        assert_eq!(node_value(&hit["graph"], "src", &runtime(json!({"last": {"hit": true}}), json!({}))).unwrap(), json!(1));
        assert_eq!(node_value(&hit["graph"], "src", &runtime(json!({"last": {"hit": false}}), json!({}))).unwrap(), json!(0));
        // Конкретная программа читается из by_program, а не из last.
        let named = gate(json!({"id": "src", "type": "data.result", "params": {"source": "use", "field": "total"}}));
        assert!(validate(&named).is_ok(), "источник — программа этого графа");
        let results = json!({"last": {"total": 9}, "by_program": {"use": {"total": 3}}});
        assert_eq!(node_value(&named["graph"], "src", &runtime(results, json!({}))).unwrap(), json!(3));
        // Без рантайма (редактор/предпросмотр) значение — 0.
        assert_eq!(node_value(&graph["graph"], "src", &Value::Null).unwrap(), json!(0));
        // Неизвестный узел — ошибка исполнения.
        assert!(node_value(&graph["graph"], "missing", &Value::Null).is_err());
    }

    /// data.sheet: вложенный путь листа; отсутствующее или нечисловое поле — 0.
    #[test]
    fn data_sheet_reads_a_nested_sheet_field_and_defaults_to_zero() {
        let graph = gate(json!({"id": "src", "type": "data.sheet", "params": {"field": "hp.current"}}));
        assert!(validate(&graph).is_ok());
        let value = |sheet: Value| node_value(&graph["graph"], "src", &runtime(json!({}), sheet)).unwrap();
        assert_eq!(value(json!({"hp": {"current": 7}})), json!(7));
        assert_eq!(value(json!({"hp": {"current": 0}})), json!(0));
        assert_eq!(value(json!({"hp": {}})), json!(0), "отсутствующее поле — 0");
        assert_eq!(value(json!({"hp": {"current": "7"}})), json!(0), "нечисловое значение — 0");
        assert_eq!(node_value(&graph["graph"], "src", &Value::Null).unwrap(), json!(0));
    }

    /// data.cast: круг выбранной ячейки, базовый круг и число лишних кругов; без каста — 0.
    #[test]
    fn data_cast_reads_the_execution_cast_context() {
        let level = gate(json!({"id": "src", "type": "data.cast", "params": {"field": "level"}}));
        assert!(validate(&level).is_ok());
        let cast = json!({"level": 3, "base": 2, "extra": 1});
        assert_eq!(node_value(&level["graph"], "src", &json!({"cast": cast})).unwrap(), json!(3));
        let base = gate(json!({"id": "src", "type": "data.cast", "params": {"field": "base"}}));
        assert_eq!(node_value(&base["graph"], "src", &json!({"cast": cast})).unwrap(), json!(2));
        let extra = gate(json!({"id": "src", "type": "data.cast", "params": {"field": "extra"}}));
        assert_eq!(node_value(&extra["graph"], "src", &json!({"cast": cast})).unwrap(), json!(1));
        // В редакторе без каста значение — 0.
        assert_eq!(node_value(&level["graph"], "src", &Value::Null).unwrap(), json!(0));
        let bad = gate(json!({"id": "src", "type": "data.cast", "params": {"field": "slot"}}));
        assert!(validate(&bad).is_err());
    }

    /// Параметры узлов проверяются при сохранении: источник результата и путь поля листа.
    #[test]
    fn data_result_and_sheet_parameters_are_validated() {
        let result = |source: &str, field: &str| json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "src", "type": "data.result", "params": {"source": source, "field": field}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [{"from": {"node": "p", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}}], "frames": [], "groups": []}});
        assert!(validate(&result("last", "total")).is_ok());
        assert!(validate(&result("use", "spent")).is_ok());
        assert!(validate(&result("other", "total")).is_err(), "источник — только last или программа графа");
        assert!(validate(&result("last", "nat20")).is_err(), "поля nat20 нет в схеме результатов");
        let sheet = |field: &str| json!({"version": 2, "graph": {"nodes": [
            {"id": "src", "type": "data.sheet", "params": {"field": field}}
        ], "links": [], "frames": [], "groups": []}});
        assert!(validate(&sheet("hp.current")).is_ok());
        assert!(validate(&sheet("abilities.str")).is_ok());
        assert!(validate(&sheet("")).is_err());
        assert!(validate(&sheet("HP.current")).is_err());
        assert!(validate(&sheet("hp..current")).is_err());
    }
}

#[cfg(test)]
mod condition_node_tests {
    use super::*;

    /// Один узел условия; значение считается в рантайме по листу из `context["runtime"]["sheet"]`.
    fn value_of(node: Value, sheet: Value) -> Value {
        let graph = json!({"version": 2, "graph": {"nodes": [node], "links": [], "frames": [], "groups": []}});
        assert!(validate(&graph).is_ok(), "параметры узла допустимы: {graph}");
        node_value(&graph["graph"], "c", &json!({"runtime": {"sheet": sheet}})).unwrap()
    }
    fn single(node: Value) -> Value {
        json!({"version": 2, "graph": {"nodes": [node], "links": [], "frames": [], "groups": []}})
    }
    fn status(name: &str, mode: &str) -> Value { json!({"id": "c", "type": "condition.status", "params": {"name": name, "mode": mode}}) }
    fn item(name: &str, mode: &str) -> Value { json!({"id": "c", "type": "condition.item", "params": {"name": name, "mode": mode}}) }
    fn hp(op: &str, value: i64, percent: bool) -> Value { json!({"id": "c", "type": "condition.hp", "params": {"op": op, "value": value, "percent": percent}}) }
    fn slot(level: i64, op: &str, value: i64) -> Value { json!({"id": "c", "type": "condition.slot", "params": {"level": level, "op": op, "value": value}}) }

    /// condition.status: точное название в sheet.conditions; режим absent — обратное значение.
    #[test]
    fn status_condition_reads_the_sheet_conditions_list() {
        assert_eq!(value_of(status("Отравленный", "present"), json!({"conditions": ["Отравленный", "Испуганный"]})), json!(true));
        assert_eq!(value_of(status("Отравленный", "present"), json!({"conditions": ["Испуганный"]})), json!(false));
        assert_eq!(value_of(status("Отравленный", "absent"), json!({"conditions": ["Испуганный"]})), json!(true));
        assert_eq!(value_of(status("Отравленный", "absent"), json!({"conditions": ["Отравленный"]})), json!(false));
        assert_eq!(value_of(status("Отравленный", "present"), json!({})), json!(false), "нет списка состояний — false");
        // Без контекста исполнения (редактор, предпросмотр) — false, а не ошибка.
        let graph = single(status("Отравленный", "present"));
        assert_eq!(node_value(&graph["graph"], "c", &Value::Null).unwrap(), json!(false));
    }

    /// condition.item: поиск по имени в sheet.inventory; equipped учитывает флаг предмета.
    #[test]
    fn item_condition_reads_the_sheet_inventory() {
        let bag = json!({"inventory": [{"name": "Кинжал", "equipped": false}, {"name": "Верёвка", "equipped": true}]});
        assert_eq!(value_of(item("Кинжал", "owned"), bag.clone()), json!(true));
        assert_eq!(value_of(item("Кинжал", "equipped"), bag.clone()), json!(false));
        assert_eq!(value_of(item("Верёвка", "equipped"), bag.clone()), json!(true));
        assert_eq!(value_of(item("Меч", "owned"), bag.clone()), json!(false));
        assert_eq!(value_of(item("кинжал", "owned"), bag.clone()), json!(false), "сравнение по строке — регистр важен");
        assert_eq!(value_of(item("Кинжал", "equipped"), json!({})), json!(false), "нет снаряжения — false");
    }

    /// condition.hp: текущие хиты или процент от максимума; без максимума процент считается нулевым.
    #[test]
    fn hp_condition_compares_current_hp_or_percent() {
        let sheet = json!({"hp": {"max": 40, "current": 10}});
        assert_eq!(value_of(hp("lt", 50, true), sheet.clone()), json!(true), "25% < 50%");
        assert_eq!(value_of(hp("ge", 25, true), sheet.clone()), json!(true), "25% ≥ 25%");
        assert_eq!(value_of(hp("gt", 50, true), sheet.clone()), json!(false));
        assert_eq!(value_of(hp("le", 10, false), sheet.clone()), json!(true));
        assert_eq!(value_of(hp("gt", 10, false), sheet.clone()), json!(false));
        assert_eq!(value_of(hp("lt", 50, true), json!({"hp": {"max": 0, "current": 0}})), json!(true), "нулевой максимум — процент 0");
        assert_eq!(value_of(hp("lt", 5, false), json!({"hp": {}})), json!(false), "нет хитов — false");
    }

    /// condition.slot: остаток ячеек круга (max − used); круг Договора берёт пул pact_slots.
    #[test]
    fn slot_condition_compares_the_remaining_slots() {
        let sheet = json!({"spells": {"slots": {"1": {"max": 2, "used": 1}, "2": {"max": 3, "used": 3}}}});
        assert_eq!(value_of(slot(1, "gte", 1), sheet.clone()), json!(true), "1 круг: остаток 1");
        assert_eq!(value_of(slot(1, "lt", 1), sheet.clone()), json!(false));
        assert_eq!(value_of(slot(2, "gte", 1), sheet.clone()), json!(false), "2 круг исчерпан");
        assert_eq!(value_of(slot(2, "lt", 1), sheet.clone()), json!(true));
        assert_eq!(value_of(slot(3, "gte", 1), sheet.clone()), json!(false), "круга нет — остаток 0");
        // Ячейки Договора круга 3: остаток берётся из pact_slots, а не из slots[3].
        let pact = json!({"spells": {"pact_slots": {"level": 3, "max": 2, "used": 0}, "slots": {"3": {"max": 2, "used": 2}}}});
        assert_eq!(value_of(slot(3, "gte", 2), pact), json!(true));
        assert_eq!(value_of(slot(1, "gte", 1), json!({})), json!(false), "нет заклинаний — false");
    }

    /// Параметры условий проверяются при сохранении: пустое имя, чужой режим, значение вне диапазона.
    #[test]
    fn condition_parameters_are_validated() {
        assert!(validate(&single(status("Отравленный", "present"))).is_ok());
        assert!(validate(&single(status("  ", "present"))).is_err(), "пустое имя состояния");
        assert!(validate(&single(status("Отравленный", "maybe"))).is_err(), "неизвестный режим состояния");
        assert!(validate(&single(item("Кинжал", "equipped"))).is_ok());
        assert!(validate(&single(item("", "owned"))).is_err(), "пустое имя предмета");
        assert!(validate(&single(item("Кинжал", "worn"))).is_err(), "неизвестный режим предмета");
        assert!(validate(&single(hp("lt", 50, true))).is_ok());
        assert!(validate(&single(hp("eq", 50, false))).is_err(), "неизвестная операция хитов");
        assert!(validate(&single(hp("lt", 150, true))).is_err(), "процент вне 0–100");
        assert!(validate(&single(hp("lt", -1, false))).is_err(), "отрицательные хиты");
        assert!(validate(&single(slot(1, "gte", 1))).is_ok());
        assert!(validate(&single(slot(0, "gte", 1))).is_err(), "круг 0");
        assert!(validate(&single(slot(10, "gte", 1))).is_err(), "круг 10");
        assert!(validate(&single(slot(1, "gt", 1))).is_err(), "неизвестная операция ячеек");
        assert!(validate(&single(slot(1, "gte", 21))).is_err(), "значение вне 0–20");
    }

    /// Условие листа управляет блоком через condition_src: false пропускает блок, true выполняет.
    #[test]
    fn sheet_condition_gates_a_block_in_the_runtime() {
        let graph = json!({"version": 2, "graph": {"nodes": [
            {"id": "p", "type": "action.program", "params": {"program_id": "use", "name": "Тест", "trigger": "use"}},
            {"id": "c", "type": "condition.item", "params": {"name": "Кинжал", "mode": "equipped"}},
            {"id": "m", "type": "action.manual", "params": {"block_id": "m", "text": "Правило", "when": "always"}},
            {"id": "e", "type": "flow.end", "params": {}}
        ], "links": [
            {"from": {"node": "p", "socket": "exec"}, "to": {"node": "m", "socket": "exec"}},
            {"from": {"node": "m", "socket": "exec"}, "to": {"node": "e", "socket": "exec"}},
            {"from": {"node": "c", "socket": "value"}, "to": {"node": "m", "socket": "condition"}}
        ], "frames": [], "groups": []}});
        assert!(problems(&graph).unwrap().is_empty());
        let plan = to_v1(&graph);
        assert_eq!(plan["programs"][0]["blocks"][0]["condition_src"], "c", "условие отложено до рантайма");
        let armed = node_value(&graph["graph"], "c", &json!({"runtime": {"sheet": {"inventory": [{"name": "Кинжал", "equipped": true}]}}})).unwrap();
        let disarmed = node_value(&graph["graph"], "c", &json!({"runtime": {"sheet": {"inventory": [{"name": "Кинжал", "equipped": false}]}}})).unwrap();
        assert_eq!((armed, disarmed), (json!(true), json!(false)));
    }
}
