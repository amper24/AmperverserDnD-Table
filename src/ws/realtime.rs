//! WebSocket-хаб: комната на кампанию. Стол (элементы сцены, туман, сетка), чат, броски, эфемерные события.
use std::{
    collections::HashMap,
    sync::{atomic::{AtomicU64, Ordering}, Arc, OnceLock},
};

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use rand::Rng;
use regex::Regex;
use serde_json::{json, Value};
use sqlx::Row;
use tokio::sync::{mpsc, RwLock};

use crate::{access, auth, campaigns::get_member, util, AppState};

#[derive(Clone)]
struct Client {
    tx: mpsc::UnboundedSender<String>,
    user_id: String,
    name: String,
    role: String,
}

#[derive(Clone, Default)]
pub struct Hub {
    rooms: Arc<RwLock<HashMap<String, HashMap<u64, Client>>>>,
    counter: Arc<AtomicU64>,
}

impl Hub {
    /// Разослать сообщение клиентам комнаты, отобранным предикатом (id соединения, клиент).
    async fn send_where(&self, cid: &str, msg: &Value, keep: impl Fn(u64, &Client) -> bool) {
        let text = msg.to_string();
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(cid) {
            for (id, client) in room {
                if keep(*id, client) {
                    let _ = client.tx.send(text.clone());
                }
            }
        }
    }
    pub async fn broadcast(&self, cid: &str, msg: &Value, exclude: Option<u64>) {
        self.send_where(cid, msg, |id, _| Some(id) != exclude).await;
    }
    pub(crate) async fn send_to_role(&self, cid: &str, role: &str, msg: &Value) {
        self.send_where(cid, msg, |_, client| client.role == role).await;
    }
    async fn send_to_user(&self, cid: &str, user_id: &str, msg: &Value) {
        self.send_where(cid, msg, |_, client| client.user_id == user_id).await;
    }
    /// Сообщение одному соединению комнаты (ответ на его сообщение).
    async fn send_to_connection(&self, cid: &str, conn_id: u64, msg: Value) {
        let rooms = self.rooms.read().await;
        if let Some(client) = rooms.get(cid).and_then(|room| room.get(&conn_id)) {
            let _ = client.tx.send(msg.to_string());
        }
    }
    async fn roll_error(&self, cid: &str, conn_id: u64, request_id: &Value, message: &str) {
        self.send_to_connection(cid, conn_id, json!({ "type": "roll_error", "request_id": request_id, "message": message })).await;
    }
    /// Отказ по правам — только тому соединению, которое нарушило правило.
    async fn forbidden(&self, cid: &str, conn_id: u64, message: &str) {
        self.send_to_connection(cid, conn_id, json!({ "type": "error", "code": "forbidden", "message": message })).await;
    }
    /// Присутствие: один участник — одна запись, даже если у него открыто несколько
    /// вкладок (счётчик `connections`). Порядок стабилен — по времени подключения.
    async fn presence(&self, cid: &str) -> Value {
        let rooms = self.rooms.read().await;
        let mut users: Vec<Value> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        if let Some(room) = rooms.get(cid) {
            let mut clients: Vec<(u64, &Client)> = room.iter().map(|(id, c)| (*id, c)).collect();
            clients.sort_by_key(|(id, _)| *id);
            for (_, c) in clients {
                if let Some(&i) = index.get(&c.user_id) {
                    let n = users[i]["connections"].as_u64().unwrap_or(1) + 1;
                    users[i]["connections"] = json!(n);
                } else {
                    index.insert(c.user_id.clone(), users.len());
                    users.push(json!({ "user_id": c.user_id, "name": c.name, "role": c.role, "connections": 1 }));
                }
            }
        }
        json!({ "type": "presence", "users": users })
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/ws/:cid", get(ws_handler))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    Path(cid): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let token = q.get("token").cloned().or_else(|| auth::session_token(&headers));
    let user = match token {
        Some(t) => auth::user_by_token(&st, &t).await.ok().flatten(),
        None => None,
    };
    let Some(user) = user else { return (StatusCode::UNAUTHORIZED, "auth").into_response(); };
    let Ok(member) = get_member(&st, &cid, &user.id).await else { return (StatusCode::FORBIDDEN, "not a member").into_response(); };
    if !access::allows(&member.role, access::TABLE_READ) {
        return (StatusCode::FORBIDDEN, "no table access").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, st, cid, user, member.role))
}

async fn handle_socket(socket: WebSocket, st: AppState, cid: String, user: auth::AuthUser, role: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn_id = st.hub.counter.fetch_add(1, Ordering::Relaxed);
    {
        let mut rooms = st.hub.rooms.write().await;
        rooms.entry(cid.clone()).or_default().insert(conn_id, Client { tx, user_id: user.id.clone(), name: user.name.clone(), role: role.clone() });
    }
    let presence = st.hub.presence(&cid).await;
    st.hub.broadcast(&cid, &presence, None).await;

    // исходящие
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // входящие
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    handle_message(&st, &cid, conn_id, &user, &role, v).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    writer.abort();
    {
        let mut rooms = st.hub.rooms.write().await;
        if let Some(room) = rooms.get_mut(&cid) {
            room.remove(&conn_id);
            if room.is_empty() {
                rooms.remove(&cid);
            }
        }
    }
    let presence = st.hub.presence(&cid).await;
    st.hub.broadcast(&cid, &presence, None).await;
}

// ---------- броски кубиков ----------
/// Регулярные выражения бросков неизменны — компилируем их один раз на процесс,
/// а не на каждый бросок (roll_expression вызывается на каждый блок действия).
static ROLL_GRAMMAR: OnceLock<Regex> = OnceLock::new();
static ROLL_TERM: OnceLock<Regex> = OnceLock::new();
static ROLL_DICE: OnceLock<Regex> = OnceLock::new();
static MODE_TERMS: OnceLock<Regex> = OnceLock::new();
static MODE_DIE: OnceLock<Regex> = OnceLock::new();
static DOUBLE_DICE_RE: OnceLock<Regex> = OnceLock::new();

/// Те же замены без удаления пробелов: удвоение костей не переписывает разметку выражения.
fn fold_expr_chars(expr: &str) -> String {
    expr.to_lowercase().replace('к', "d").replace('−', "-").replace('–', "-").replace('—', "-")
}

/// Выражение броска в каноничном виде: без пробелов, «к» → «d», типографские минусы → «-».
fn normalize_expr(expr: &str) -> String {
    fold_expr_chars(&expr.chars().filter(|c| !c.is_whitespace()).collect::<String>())
}

pub fn roll_expression(expr: &str) -> Option<Value> {
    let expr = normalize_expr(expr);
    // Match the WHOLE expression: the old token scan silently accepted d20++5 or trailing signs.
    let grammar = ROLL_GRAMMAR.get_or_init(|| Regex::new(r"^[+-]?(?:[0-9]*d[0-9]+(?:k[hl][0-9]+)?|[0-9]+)(?:[+-](?:[0-9]*d[0-9]+(?:k[hl][0-9]+)?|[0-9]+))*$").unwrap());
    if expr.is_empty() || expr.len() > 64 || !grammar.is_match(&expr) { return None; }
    let term_re = ROLL_TERM.get_or_init(|| Regex::new(r"([+-]?)([^+-]+)").unwrap());
    let dice_re = ROLL_DICE.get_or_init(|| Regex::new(r"^([0-9]*)d([0-9]+)(k[hl][0-9]+)?$").unwrap());
    let mut rng = rand::thread_rng();
    let mut total: i64 = 0;
    let mut dice_count: usize = 0;
    let mut parts = Vec::new();
    for cap in term_re.captures_iter(&expr) {
        if parts.len() >= 32 { return None; }
        let sign = if &cap[1] == "-" { -1 } else { 1 };
        let term = &cap[2];
        if let Some(d) = dice_re.captures(term) {
            let n: usize = if d[1].is_empty() { 1 } else { d[1].parse().ok()? };
            let sides: i64 = d[2].parse().ok()?;
            if n < 1 || n > 100 || !(1..=1000).contains(&sides) { return None; }
            dice_count += n;
            if dice_count > 100 { return None; }
            let count: usize = match d.get(3) { Some(k) => k.as_str()[2..].parse().ok()?, None => n };
            if count < 1 || count > n { return None; }
            let rolls: Vec<i64> = (0..n).map(|_| rng.gen_range(1..=sides)).collect();
            let mut kept_indices: Vec<usize> = (0..n).collect();
            if let Some(k) = d.get(3) {
                if &k.as_str()[1..2] == "h" { kept_indices.sort_by_key(|&i| -rolls[i]); }
                else { kept_indices.sort_by_key(|&i| rolls[i]); }
            }
            kept_indices.truncate(count);
            kept_indices.sort_unstable();
            let kept: Vec<i64> = kept_indices.iter().map(|&i| rolls[i]).collect();
            total += sign * kept.iter().sum::<i64>();
            parts.push(json!({ "term": format!("{}{}", &cap[1], term), "rolls": rolls, "kept": kept, "kept_indices": kept_indices, "sides": sides }));
        } else {
            let v: i64 = term.parse().ok()?;
            if v > 1_000_000 { return None; }
            total += sign * v;
            parts.push(json!({ "term": format!("{}{}", &cap[1], term), "value": sign * v }));
        }
    }
    Some(json!({ "expr": expr, "parts": parts, "total": total }))
}

/// Applies advantage/disadvantage to the first d20 pool, or to every dice pool
/// when the formula has no d20. Modifiers remain untouched. Canonical
/// 2dSkh1/kl1 formulas can switch modes without adding dice a second time.
pub(crate) fn with_dice_mode(expr: &str, mode: &str) -> String {
    if !["adv", "dis"].contains(&mode) { return expr.to_string(); }
    let expr = normalize_expr(expr);
    let terms = MODE_TERMS.get_or_init(|| Regex::new(r"([+-]?)([^+\-]+)").unwrap());
    let die = MODE_DIE.get_or_init(|| Regex::new(r"^([+-]?)([0-9]*)d([0-9]+)(?:k([hl])([0-9]+))?$").unwrap());
    let matches: Vec<_> = terms.captures_iter(&expr).filter_map(|c| {
        let whole = c.get(0).unwrap();
        let d = die.captures(whole.as_str())?;
        Some((whole.start(), whole.end(), d[1].to_string(), d[2].to_string(), d[3].to_string(),
            d.get(4).map(|v| v.as_str().to_string()), d.get(5).map(|v| v.as_str().to_string())))
    }).collect();
    let targets: Vec<_> = if let Some(d20) = matches.iter().find(|m| m.4.parse::<u32>().ok() == Some(20)) {
        vec![d20]
    } else { matches.iter().collect() };
    if targets.is_empty() { return expr; }
    let mut replacements = Vec::with_capacity(targets.len());
    for target in targets {
        let (start, end, sign, n, sides, prior_mode, prior_keep) = target;
        let keep_mode = if (mode == "adv") != (sign.as_str() == "-") { "h" } else { "l" };
        let count = n.parse::<usize>().unwrap_or(1);
        let kept = prior_keep.as_deref().and_then(|v| v.parse::<usize>().ok()).unwrap_or(count);
        // Keep malformed base formulas malformed; mode must not legitimize khK where K > N.
        if prior_mode.is_some() && kept > count { return expr; }
        let canonical_mode = prior_mode.is_some() && count == 2 && kept == 1;
        let custom_keep = prior_mode.is_some() && kept < count;
        let (dice, keep) = if canonical_mode { (2, 1) } else {
            (count.saturating_mul(2), if custom_keep { kept } else { count })
        };
        replacements.push((*start, *end, format!("{}{}d{}k{}{}", sign, dice, sides, keep_mode, keep)));
    }
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = expr;
    for (start, end, replacement) in replacements { out.replace_range(start..end, &replacement); }
    out
}

/// Удваивает количество костей в выражении (критический удар): 1d8+3 → 2d8+3.
pub(crate) fn double_dice(expr: &str) -> String {
    let expr = fold_expr_chars(expr);
    let re = DOUBLE_DICE_RE.get_or_init(|| Regex::new(r"(\d*)(d)(\d+)(?:k([hl])(\d+))?").unwrap());
    re.replace_all(&expr, |c: &regex::Captures| {
        let n: i64 = if c[1].is_empty() { 1 } else {
            match c[1].parse() { Ok(n) => n, Err(_) => return c[0].to_string() }
        };
        let keep = c.get(5).and_then(|v| v.as_str().parse::<i64>().ok()).map(|v| v.saturating_mul(2));
        let keep_suffix = match (c.get(4), keep) { (Some(mode), Some(keep)) => format!("k{}{}", mode.as_str(), keep), _ => String::new() };
        format!("{}{}{}{}", n.saturating_mul(2), &c[2], &c[3], keep_suffix)
    }).into_owned()
}

/// Есть ли среди оставленных костей d20 естественная 20 / 1 (по первому d20-терму).
pub(crate) fn nat_d20(r: &Value) -> (bool, bool) {
    if let Some(parts) = r["parts"].as_array() {
        for p in parts {
            if p["sides"].as_i64() == Some(20) {
                let kept: Vec<i64> = p["kept"].as_array().map(|a| a.iter().filter_map(|v| v.as_i64()).collect()).unwrap_or_default();
                return (kept.contains(&20), kept.contains(&1));
            }
        }
    }
    (false, false)
}

async fn save_chat(st: &AppState, cid: &str, user: &auth::AuthUser, kind: &str, payload: &Value) -> Option<Value> {
    let now = util::now();
    let res = sqlx::query("INSERT INTO chat_messages (campaign_id, user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(cid).bind(&user.id).bind(kind).bind(payload.to_string()).bind(&now).execute(&st.db).await.ok()?;
    let id = res.last_insert_id().unwrap_or(0);
    Some(json!({ "type": "chat", "id": id, "user_id": user.id, "name": user.name, "kind": kind, "payload": payload, "at": now }))
}

/// Системное сообщение в чат (сохраняется в историю).
pub async fn system_message(st: &AppState, cid: &str, user: &auth::AuthUser, text: &str) -> Option<Value> {
    save_chat(st, cid, user, "system", &json!({ "text": text })).await
}

/// Персонаж принадлежит этому игроку: ставить чужие листы токенами игрок не может.
async fn character_owned_by(st: &AppState, character_id: &str, user_id: &str) -> bool {
    sqlx::query("SELECT owner_id FROM characters WHERE id = ?")
        .bind(character_id).fetch_optional(&st.db).await.ok().flatten()
        .map(|r| r.get::<String, _>("owner_id") == user_id)
        .unwrap_or(false)
}

async fn handle_message(st: &AppState, cid: &str, conn_id: u64, user: &auth::AuthUser, role: &str, msg: Value) {
    let role = access::role_of(role);
    let is_gm = access::is_gm(role);
    let t = msg["type"].as_str().unwrap_or("");
    if matches!(t, "roll" | "multi") && msg["gm_only"].as_bool().unwrap_or(false) && !is_gm {
        st.hub.roll_error(cid, conn_id, &msg["request_id"], "Скрытые броски доступны только мастеру. Бросок не отправлен.").await;
        return;
    }
    match t {
        "chat" => handle_chat(st, cid, user, &msg).await,
        "card" => handle_card(st, cid, user, &msg).await,
        "roll" => handle_roll(st, cid, conn_id, user, is_gm, &msg).await,
        "multi" => handle_multi_roll(st, cid, conn_id, user, is_gm, &msg).await,
        // эфемерные события стола
        "pointer" | "ruler" | "cursor" | "ping" => {
            let mut out = msg.clone();
            out["user_id"] = json!(user.id);
            out["name"] = json!(user.name);
            st.hub.broadcast(cid, &out, Some(conn_id)).await;
        }
        "item_upsert" | "item_delete" | "items_bulk" => handle_scene_items(st, cid, conn_id, user, role, t, &msg).await,
        "scene_update" => handle_scene_update(st, cid, conn_id, role, &msg).await,
        "initiative" => {
            if is_gm {
                st.hub.broadcast(cid, &msg, None).await;
            }
        }
        _ => {}
    }
}

/// Цвет костей по умолчанию — как на клиенте.
const DEFAULT_DICE_COLOR: &str = "#a881e8";
/// Цвет костей из сообщения: только #rrggbb, иначе цвет по умолчанию.
fn dice_color(msg: &Value) -> &str {
    msg["dice_color"].as_str().filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or(DEFAULT_DICE_COLOR)
}

/// request_id клиента (до 64 символов): по нему клиент сопоставляет ответ и ошибку броска.
fn request_id_of(msg: &Value) -> String { msg["request_id"].as_str().unwrap_or("").chars().take(64).collect() }

/// Видимость броска: скрытый (только мастера), приватный (только автор) или общий.
/// Скрытым бросок считается, только если его запросил мастер.
fn roll_visibility(msg: &Value, is_gm: bool) -> (bool, bool) {
    let gm_only = msg["gm_only"].as_bool().unwrap_or(false) && is_gm;
    let private = !gm_only && msg["visibility"].as_str() == Some("private");
    (gm_only, private)
}

/// Сохранить сообщение в историю и разослать его адресатам. В базе приватные броски хранятся
/// отдельным видом (private_roll/private_multi) и в общий чат не попадают, а подключённым вкладкам
/// владельца уходит обычный вид (roll/multi).
async fn save_chat_and_send(
    st: &AppState, cid: &str, user: &auth::AuthUser,
    visible_kind: &str, storage_kind: &str, payload: &Value, gm_only: bool, private: bool,
) {
    let Some(mut out) = save_chat(st, cid, user, storage_kind, payload).await else { return };
    out["kind"] = json!(visible_kind);
    if gm_only { st.hub.send_to_role(cid, "gm", &out).await; }
    else if private { st.hub.send_to_user(cid, &user.id, &out).await; }
    else { st.hub.broadcast(cid, &out, None).await; }
}

/// Чат: текст или бросок, начатый командой «/r ».
async fn handle_chat(st: &AppState, cid: &str, user: &auth::AuthUser, msg: &Value) {
    let text: String = msg["text"].as_str().unwrap_or("").chars().take(2000).collect::<String>().trim().to_string();
    if text.is_empty() { return; }
    let (kind, payload) = if let Some(rest) = text.strip_prefix("/r ").or_else(|| text.strip_prefix("/roll ")) {
        match roll_expression(rest) {
            Some(mut r) => { r["label"] = msg["label"].clone(); ("roll", r) }
            None => ("text", json!({ "text": "Неверное выражение броска" })),
        }
    } else {
        ("text", json!({ "text": text, "whisper": msg["whisper"] }))
    };
    if let Some(out) = save_chat(st, cid, user, kind, &payload).await {
        st.hub.broadcast(cid, &out, None).await;
    }
}

/// Карточка предмета/заклинания в чат (кнопки бросков рисует клиент).
async fn handle_card(st: &AppState, cid: &str, user: &auth::AuthUser, msg: &Value) {
    let mut card = msg["card"].clone();
    if !card.is_object() { return; }
    if let Some(o) = card.as_object_mut() { o.retain(|k, _| ["name", "kind", "desc", "actions", "meta", "icon", "asset_id", "owner", "item_ref"].contains(&k.as_str())); }
    if let Some(out) = save_chat(st, cid, user, "card", &card).await {
        st.hub.broadcast(cid, &out, None).await;
    }
}

/// Один бросок: формула, ярлык, цвет и видимость.
async fn handle_roll(st: &AppState, cid: &str, conn_id: u64, user: &auth::AuthUser, is_gm: bool, msg: &Value) {
    let Some(mut r) = roll_expression(msg["expr"].as_str().unwrap_or("d20")) else {
        st.hub.roll_error(cid, conn_id, &msg["request_id"], "Неверная формула или превышен лимит кубиков.").await; return;
    };
    let (gm_only, private) = roll_visibility(msg, is_gm);
    r["label"] = msg["label"].clone();
    r["gm_only"] = json!(gm_only);
    r["visibility"] = json!(if private { "private" } else { "campaign" });
    r["dice_color"] = json!(dice_color(msg));
    r["request_id"] = json!(request_id_of(msg));
    r["kind"] = msg["kind"].clone();
    save_chat_and_send(st, cid, user, "roll", if private { "private_roll" } else { "roll" }, &r, gm_only, private).await;
}

/// Связка бросков одним сообщением: атака + урон (+ что угодно). Крит по атаке удваивает кости урона.
async fn handle_multi_roll(st: &AppState, cid: &str, conn_id: u64, user: &auth::AuthUser, is_gm: bool, msg: &Value) {
    let Some(list) = msg["rolls"].as_array().filter(|l| !l.is_empty() && l.len() <= 8) else {
        st.hub.roll_error(cid, conn_id, &msg["request_id"], "Связка должна содержать 1–8 бросков.").await; return;
    };
    let (gm_only, private) = roll_visibility(msg, is_gm);
    let mut out_rolls = Vec::new();
    let mut crit = false;
    for r in list.iter().take(8) {
        let kind = r["kind"].as_str().unwrap_or("other").to_string();
        let mut expr = r["expr"].as_str().unwrap_or("").to_string();
        let mut doubled = false;
        if crit && kind == "damage" {
            expr = double_dice(&expr);
            doubled = true;
        }
        let Some(mut rolled) = roll_expression(&expr) else {
            st.hub.roll_error(cid, conn_id, &msg["request_id"], "Неверная формула в связке. Вся связка отменена.").await; return;
        };
        let (nat20, nat1) = nat_d20(&rolled);
        if kind == "attack" { crit = nat20; }
        rolled["name"] = r["name"].clone();
        rolled["kind"] = json!(kind);
        rolled["dtype"] = r["dtype"].clone();
        rolled["crit"] = json!(nat20 && kind != "damage" && kind != "heal");
        rolled["fumble"] = json!(nat1 && kind != "damage" && kind != "heal");
        rolled["doubled"] = json!(doubled);
        rolled["base_expr"] = r["expr"].clone();
        out_rolls.push(rolled);
    }
    if out_rolls.is_empty() { return; }
    let payload = json!({ "label": msg["label"], "gm_only": gm_only, "visibility": if private { "private" } else { "campaign" }, "dice_color": dice_color(msg), "request_id": request_id_of(msg), "rolls": out_rolls });
    save_chat_and_send(st, cid, user, "multi", if private { "private_multi" } else { "multi" }, &payload, gm_only, private).await;
}

/// Элементы сцены по WS: создание/правка (item_upsert), удаление (item_delete), раскладка (items_bulk).
async fn handle_scene_items(st: &AppState, cid: &str, conn_id: u64, user: &auth::AuthUser, role: &str, kind: &str, msg: &Value) {
    let Some(scene_id) = msg["scene_id"].as_str() else { return };
    let ok = sqlx::query("SELECT id FROM scenes WHERE id = ? AND campaign_id = ?").bind(scene_id).bind(cid).fetch_optional(&st.db).await.ok().flatten().is_some();
    if !ok {
        return;
    }
    match kind {
        "item_upsert" => item_upsert(st, cid, conn_id, scene_id, user, role, &msg["item"]).await,
        "item_delete" => {
            let Some(id) = msg["id"].as_str() else { return };
            let row = sqlx::query("SELECT data, layer FROM scene_items WHERE id = ? AND scene_id = ?").bind(id).bind(scene_id).fetch_optional(&st.db).await.ok().flatten();
            if let Some(row) = row {
                let data = util::json_value(&util::text(&row, "data"));
                if access::item_write(role, &data, &user.id) == access::ItemWrite::Deny {
                    st.hub.forbidden(cid, conn_id, "Нет прав удалять этот элемент стола").await;
                    return;
                }
                let _ = sqlx::query("DELETE FROM scene_items WHERE id = ?").bind(id).execute(&st.db).await;
                // Удалённая карта больше не активная: клиенты выберут оставшуюся (или ни одну).
                if row.get::<String, _>("layer") == "map" {
                    let _ = sqlx::query("UPDATE scenes SET active_map_id = NULL WHERE id = ? AND active_map_id = ?").bind(scene_id).bind(id).execute(&st.db).await;
                }
                st.hub.broadcast(cid, &json!({ "type": "item_delete", "scene_id": scene_id, "id": id }), None).await;
            }
        }
        _ => {
            if !access::allows(role, access::TABLE_MOVE_ANY_TOKEN) {
                st.hub.forbidden(cid, conn_id, "Раскладку слоёв меняет только мастер").await;
                return;
            }
            let items = msg["items"].as_array().cloned().unwrap_or_default();
            for it in &items {
                let Some(id) = it["id"].as_str() else { continue };
                let row = sqlx::query("SELECT layer, z, data FROM scene_items WHERE id = ? AND scene_id = ?").bind(id).bind(scene_id).fetch_optional(&st.db).await.ok().flatten();
                let Some(row) = row else { continue };
                let mut data = util::json_value(&util::text(&row, "data"));
                if let (Some(dst), Some(src)) = (data.as_object_mut(), it["data"].as_object()) {
                    for (k, v) in src { if dst.get("managed_loot") != Some(&json!(true)) || PLAYER_FIELDS.contains(&k.as_str()) { dst.insert(k.clone(), v.clone()); } }
                }
                let z = it["z"].as_i64().unwrap_or_else(|| row.get::<i64, _>("z"));
                let layer = it["layer"].as_str().map(|s| s.to_string()).unwrap_or_else(|| row.get::<String, _>("layer"));
                let _ = sqlx::query("UPDATE scene_items SET data = ?, z = ?, layer = ?, updated_at = ? WHERE id = ?")
                    .bind(data.to_string()).bind(z).bind(&layer).bind(util::now()).bind(id).execute(&st.db).await;
            }
            st.hub.broadcast(cid, &json!({ "type": "items_bulk", "scene_id": scene_id, "items": items }), None).await;
        }
    }
}

/// Сцена по WS: сетка, имя, туман войны, слои и активная карта.
async fn handle_scene_update(st: &AppState, cid: &str, conn_id: u64, role: &str, msg: &Value) {
    if !access::allows(role, access::TABLE_MANAGE_SCENE) {
        st.hub.forbidden(cid, conn_id, "Сцены, сетку и слои меняет только мастер").await;
        return;
    }
    let Some(scene_id) = msg["scene_id"].as_str() else { return };
    let row = sqlx::query("SELECT grid, fog, name, layers, active_map_id FROM scenes WHERE id = ? AND campaign_id = ?").bind(scene_id).bind(cid).fetch_optional(&st.db).await.ok().flatten();
    let Some(row) = row else { return };
    let grid = if msg["grid"].is_object() { msg["grid"].to_string() } else { util::text(&row, "grid") };
    // Туман — маска на карту (scene.fog.by_map): валидируем, оставляем только существующие карты.
    // Старый глобальный shapes сервер не принимает — клиент переносит его при загрузке.
    let fog_out = if msg["fog"].is_object() {
        // Туман войны — отдельная возможность: без неё поле просто игнорируется.
        if !access::allows(role, access::TABLE_MANAGE_FOG) {
            st.hub.forbidden(cid, conn_id, "Туман войны меняет только мастер").await;
            None
        } else {
            let map_ids: Vec<String> = sqlx::query("SELECT id FROM scene_items WHERE scene_id = ? AND layer = 'map'")
                .bind(scene_id).fetch_all(&st.db).await.ok()
                .map(|rows| rows.iter().map(|r| r.get::<String, _>("id")).collect())
                .unwrap_or_default();
            crate::scenes::normalize_fog(&msg["fog"]).map(|f| crate::scenes::restrict_fog_to_maps(&f, &map_ids))
        }
    } else {
        None
    };
    let fog = fog_out.as_ref().map(|v| v.to_string()).unwrap_or_else(|| util::text(&row, "fog"));
    let name = msg["name"].as_str().map(|s| util::truncate(s, 128)).unwrap_or_else(|| row.get::<String, _>("name"));
    // Слои — часть сцены: валидный массив заменяет список, битый игнорируется.
    let layers_out = msg.get("layers").and_then(crate::scenes::normalize_layers);
    let layers = layers_out.as_ref().map(|v| v.to_string()).unwrap_or_else(|| util::text(&row, "layers"));
    // Активная карта: null очищает, строка (до 32 символов) задаёт, иначе — без изменений.
    let current_map = util::text(&row, "active_map_id");
    let active_map_id: Option<String> = match msg.get("active_map_id") {
        Some(v) if v.is_null() => None,
        Some(v) => v.as_str().filter(|s| util::short_id(s)).map(|s| s.to_string())
            .or_else(|| if current_map.is_empty() { None } else { Some(current_map.clone()) }),
        None => if current_map.is_empty() { None } else { Some(current_map.clone()) },
    };
    let _ = sqlx::query("UPDATE scenes SET grid = ?, fog = ?, name = ?, layers = ?, active_map_id = ? WHERE id = ?")
        .bind(&grid).bind(&fog).bind(&name).bind(&layers).bind(&active_map_id).bind(scene_id).execute(&st.db).await;
    let mut out = json!({ "type": "scene_update", "scene_id": scene_id });
    for key in ["grid", "name"] {
        if msg.get(key).is_some() { out[key] = msg[key].clone(); }
    }
    // Туман отдаём всегда — текущий из сцены, чтобы клиенты не теряли маску,
    // когда scene_update приходит без поля fog (имя, сетка, слои).
    out["fog"] = serde_json::from_str::<Value>(&fog).unwrap_or_else(|_| crate::scenes::default_fog());
    if let Some(v) = layers_out { out["layers"] = v; }
    if msg.get("active_map_id").is_some() { out["active_map_id"] = json!(active_map_id); }
    st.hub.broadcast(cid, &out, None).await;
}

const PLAYER_FIELDS: &[&str] = &["x", "y", "rotation", "hp", "conditions", "attachments", "dead"];

async fn item_upsert(st: &AppState, cid: &str, conn_id: u64, scene_id: &str, user: &auth::AuthUser, role: &str, item: &Value) {
    let id = item["id"].as_str().map(|s| s.to_string());
    let mut data = if item["data"].is_object() { item["data"].clone() } else { json!({}) };
    let layer_in = item["layer"].as_str().map(|s| s.to_string());
    let z_in = item["z"].as_i64();

    let existing = match &id {
        Some(id) => sqlx::query("SELECT layer, z, data FROM scene_items WHERE id = ? AND scene_id = ?").bind(id).bind(scene_id).fetch_optional(&st.db).await.ok().flatten(),
        None => None,
    };

    // A delayed move must never resurrect a picked-up/deleted token.
    if id.is_some() && existing.is_none() { return; }
    if id.is_none() && data["managed_loot"] == true { return; }
    let (final_id, layer, z, data) = match existing {
        Some(row) => {
            let old = util::json_value(&util::text(&row, "data"));
            let mut layer: String = row.get("layer");
            let mut z: i64 = row.get("z");
            let mode = access::item_write(role, &old, &user.id);
            if mode == access::ItemWrite::Deny {
                st.hub.forbidden(cid, conn_id, "Нет прав менять этот элемент стола").await;
                return;
            }
            let merged = if mode == access::ItemWrite::Full {
                layer = layer_in.unwrap_or(layer);
                z = z_in.unwrap_or(z);
                data
            } else {
                // владельцу токена разрешено менять только позицию/поворот/хиты/состояния
                let mut m = old.clone();
                if let (Some(dst), Some(src)) = (m.as_object_mut(), data.as_object()) {
                    for k in PLAYER_FIELDS {
                        if let Some(v) = src.get(*k) { dst.insert(k.to_string(), v.clone()); }
                    }
                }
                m
            };
            let id = id.unwrap();
            let updated = sqlx::query("UPDATE scene_items SET layer = ?, z = ?, data = ?, updated_at = ? WHERE id = ?")
                .bind(&layer).bind(z).bind(merged.to_string()).bind(util::now()).bind(&id).execute(&st.db).await;
            if !updated.is_ok_and(|r| r.rows_affected() > 0) { return; }
            (id, layer, z, merged)
        }
        None => {
            let layer = layer_in.unwrap_or_else(|| "character".into());
            if !access::can_create_item(role, &layer, &data, &user.id) {
                st.hub.forbidden(cid, conn_id, "Игрок ставит на стол только своих персонажей").await;
                return;
            }
            // Токен игрока не может ссылаться на чужой лист персонажа.
            if let Some(character_id) = data["character_id"].as_str() {
                if !access::allows(role, access::CHARACTER_EDIT_ANY) && !character_owned_by(st, character_id, &user.id).await {
                    st.hub.forbidden(cid, conn_id, "Чужого персонажа нельзя поставить на стол").await;
                    return;
                }
            }
            if data.get("owner_id").map(|v| v.is_null()).unwrap_or(true) {
                data["owner_id"] = json!(user.id);
            }
            let id = id.filter(|s| util::short_id(s)).unwrap_or_else(util::uid);
            let z = z_in.unwrap_or(0);
            let _ = sqlx::query("INSERT INTO scene_items (id, scene_id, layer, z, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&id).bind(scene_id).bind(&layer).bind(z).bind(data.to_string()).bind(util::now()).execute(&st.db).await;
            (id, layer, z, data)
        }
    };
    st.hub.broadcast(cid, &json!({ "type": "item_upsert", "scene_id": scene_id, "item": { "id": final_id, "scene_id": scene_id, "layer": layer, "z": z, "data": data } }), None).await;
}

#[cfg(test)]
mod dice_tests {
    use super::*;
    #[test]
    fn strict_expressions_and_limits() {
        for expr in ["", "+", "d20+", "d20++5", "d20--2", "2garbage", "0d6", "d0", "101d6", "60d6+41d6", "2d6kh0", "2d6kh3", "d1001", "1000001", "999999999999999999999999d6"] {
            assert!(roll_expression(expr).is_none(), "accepted {expr}");
        }
        for expr in ["d20", "-d4+5", "4d6kh3", "2d20kl1", "2К6 + 3", "d100", "0", "100d1", "d1000"] {
            assert!(roll_expression(expr).is_some(), "rejected {expr}");
        }
    }
    #[test]
    fn duplicate_faces_keep_exact_indices() {
        let r = roll_expression("4d1kh3+2").unwrap();
        assert_eq!(r["total"], 5);
        assert_eq!(r["parts"][0]["kept_indices"], json!([0, 1, 2]));
        assert_eq!(r["parts"][0]["kept"], json!([1, 1, 1]));
    }
    #[test]
    fn totals_and_critical_dice() {
        assert_eq!(roll_expression("2d1-3+d1").unwrap()["total"], 0);
        assert_eq!(double_dice("1d8+2d6+3"), "2d8+4d6+3");
        assert_eq!(double_dice("4d6kh3+1d8kl1+5"), "8d6kh6+2d8kl2+5");
        assert_eq!(roll_expression("−d6+2").unwrap()["expr"], "-d6+2");
        assert_eq!(nat_d20(&json!({"parts":[{"sides":20,"kept":[20]}]})), (true, false));
    }
    #[test]
    fn advantage_and_disadvantage_work_with_any_die_and_preserve_d20_priority() {
        assert_eq!(with_dice_mode("1d20+5+2d6", "adv"), "2d20kh1+5+2d6");
        assert_eq!(with_dice_mode("d6+1d20-2d20", "dis"), "d6+2d20kl1-2d20");
        assert_eq!(with_dice_mode("d4+3", "adv"), "2d4kh1+3");
        assert_eq!(with_dice_mode("2d6+3", "dis"), "4d6kl2+3");
        assert_eq!(with_dice_mode("-d6+5", "adv"), "-2d6kl1+5");
        assert_eq!(with_dice_mode("-d6+5", "dis"), "-2d6kh1+5");
        assert_eq!(with_dice_mode("d8+1d6+2", "adv"), "2d8kh1+2d6kh1+2");
        assert_eq!(with_dice_mode("d100+3", "adv"), "2d100kh1+3");
        assert_eq!(with_dice_mode("d200+3", "dis"), "2d200kl1+3");
        assert_eq!(with_dice_mode("2d20kh1+3", "dis"), "2d20kl1+3");
        assert_eq!(with_dice_mode("2d20kl1-2", "adv"), "2d20kh1-2");
        assert_eq!(with_dice_mode("d20kh1+5", "adv"), "2d20kh1+5");
        assert_eq!(with_dice_mode("4d20kh3+3", "adv"), "8d20kh3+3");
        assert_eq!(with_dice_mode("4d6kh3+3", "dis"), "8d6kl3+3");
        assert_eq!(with_dice_mode("4d6kh5+3", "adv"), "4d6kh5+3");
    }
}

/// Присутствие в комнате: одна запись на участника, сколько бы вкладок у него ни было.
#[cfg(test)]
mod presence_tests {
    use super::*;

    fn connect(hub: &Hub, cid: &str, conn: u64, user_id: &str, role: &str) {
        let (tx, _rx) = mpsc::unbounded_channel::<String>();
        let client = Client { tx, user_id: user_id.into(), name: format!("{user_id}-name"), role: role.into() };
        let mut rooms = futures::executor::block_on(hub.rooms.write());
        rooms.entry(cid.to_string()).or_default().insert(conn, client);
    }

    fn disconnect(hub: &Hub, cid: &str, conn: u64) {
        let mut rooms = futures::executor::block_on(hub.rooms.write());
        if let Some(room) = rooms.get_mut(cid) {
            room.remove(&conn);
            if room.is_empty() {
                rooms.remove(cid);
            }
        }
    }

    fn users(hub: &Hub, cid: &str) -> Vec<Value> {
        let presence = futures::executor::block_on(hub.presence(cid));
        presence["users"].as_array().cloned().unwrap_or_default()
    }

    fn user_entry<'a>(list: &'a [Value], user_id: &str) -> Option<&'a Value> {
        list.iter().find(|u| u["user_id"] == user_id)
    }

    #[test]
    fn presence_keeps_one_entry_per_user_and_counts_connections() {
        let hub = Hub::default();
        connect(&hub, "c1", 0, "gm1", "gm");
        connect(&hub, "c1", 1, "pl1", "player");
        connect(&hub, "c1", 2, "pl1", "player"); // вторая вкладка того же игрока

        let list = users(&hub, "c1");
        assert_eq!(list.len(), 2, "два участника, а не три соединения");
        let player = user_entry(&list, "pl1").expect("игрок в присутствии");
        assert_eq!(player["connections"], 2);
        assert_eq!(player["role"], "player");
        assert_eq!(player["name"], "pl1-name");

        // Закрытие одной вкладки: участник остаётся, счётчик уменьшается.
        disconnect(&hub, "c1", 2);
        let list = users(&hub, "c1");
        assert_eq!(list.len(), 2);
        assert_eq!(user_entry(&list, "pl1").unwrap()["connections"], 1);

        // Reconnect (старая вкладка закрылась, открылась новая) запись не множит.
        disconnect(&hub, "c1", 1);
        connect(&hub, "c1", 3, "pl1", "player");
        let list = users(&hub, "c1");
        assert_eq!(list.len(), 2, "после reconnect по-прежнему один игрок");
        assert_eq!(user_entry(&list, "pl1").unwrap()["connections"], 1);

        // Закрытие последней вкладки убирает участника из списка.
        disconnect(&hub, "c1", 3);
        let list = users(&hub, "c1");
        assert_eq!(list.len(), 1);
        assert!(user_entry(&list, "pl1").is_none(), "игрок ушёл со стола");

        disconnect(&hub, "c1", 0);
        assert!(users(&hub, "c1").is_empty());
    }

    #[test]
    fn presence_is_scoped_to_the_campaign_room() {
        let hub = Hub::default();
        connect(&hub, "c1", 0, "u1", "gm");
        connect(&hub, "c2", 1, "u2", "player");
        let first = users(&hub, "c1");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["user_id"], "u1");
        let second = users(&hub, "c2");
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["user_id"], "u2");
    }
}
