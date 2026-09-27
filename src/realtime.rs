//! WebSocket-хаб: комната на кампанию. Стол (элементы сцены, туман, сетка), чат, броски, эфемерные события.
use std::{
    collections::HashMap,
    sync::{atomic::{AtomicU64, Ordering}, Arc},
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

use crate::{auth, campaigns::get_member, util, AppState};

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
    pub async fn broadcast(&self, cid: &str, msg: &Value, exclude: Option<u64>) {
        let text = msg.to_string();
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(cid) {
            for (id, c) in room {
                if Some(*id) != exclude {
                    let _ = c.tx.send(text.clone());
                }
            }
        }
    }
    async fn send_to_role(&self, cid: &str, role: &str, msg: &Value) {
        let text = msg.to_string();
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(cid) {
            for c in room.values() {
                if c.role == role {
                    let _ = c.tx.send(text.clone());
                }
            }
        }
    }
    async fn presence(&self, cid: &str) -> Value {
        let rooms = self.rooms.read().await;
        let users: Vec<Value> = rooms.get(cid).map(|r| r.values().map(|c| json!({ "user_id": c.user_id, "name": c.name, "role": c.role })).collect()).unwrap_or_default();
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
    let token = q.get("token").cloned().or_else(|| util::cookie(&headers, auth::COOKIE));
    let user = match token {
        Some(t) => auth::user_by_token(&st, &t).await.ok().flatten(),
        None => None,
    };
    let Some(user) = user else { return (StatusCode::UNAUTHORIZED, "auth").into_response(); };
    let Ok(member) = get_member(&st, &cid, &user.id).await else { return (StatusCode::FORBIDDEN, "not a member").into_response(); };
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
pub fn roll_expression(expr: &str) -> Option<Value> {
    let expr: String = expr.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase().replace('к', "d");
    if expr.is_empty() || expr.len() > 64 || !expr.chars().all(|c| c.is_ascii_digit() || "d+-khl".contains(c)) {
        return None;
    }
    let term_re = Regex::new(r"([+-]?)([^+-]+)").ok()?;
    let dice_re = Regex::new(r"^(\d*)d(\d+)(k[hl]\d+)?$").ok()?;
    let mut rng = rand::thread_rng();
    let mut total: i64 = 0;
    let mut parts = Vec::new();
    for cap in term_re.captures_iter(&expr) {
        let sign = if &cap[1] == "-" { -1 } else { 1 };
        let term = &cap[2];
        if let Some(d) = dice_re.captures(term) {
            let n: i64 = d.get(1).map(|m| m.as_str()).filter(|s| !s.is_empty()).and_then(|s| s.parse().ok()).unwrap_or(1);
            let sides: i64 = d[2].parse().ok()?;
            if n > 100 || sides > 1000 || sides < 1 || n < 1 {
                return None;
            }
            let rolls: Vec<i64> = (0..n).map(|_| rng.gen_range(1..=sides)).collect();
            let mut kept = rolls.clone();
            if let Some(k) = d.get(3) {
                let ks = k.as_str();
                let count: usize = ks[2..].parse().ok()?;
                let mut sorted = rolls.clone();
                if &ks[1..2] == "h" { sorted.sort_by(|a, b| b.cmp(a)); } else { sorted.sort(); }
                kept = sorted.into_iter().take(count).collect();
            }
            total += sign * kept.iter().sum::<i64>();
            parts.push(json!({ "term": format!("{}{}", &cap[1], term), "rolls": rolls, "kept": kept, "sides": sides }));
        } else {
            let v: i64 = term.parse().ok()?;
            total += sign * v;
            parts.push(json!({ "term": format!("{}{}", &cap[1], term), "value": sign * v }));
        }
    }
    Some(json!({ "expr": expr, "parts": parts, "total": total }))
}

async fn save_chat(st: &AppState, cid: &str, user: &auth::AuthUser, kind: &str, payload: &Value) -> Option<Value> {
    let now = util::now();
    let res = sqlx::query("INSERT INTO chat_messages (campaign_id, user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(cid).bind(&user.id).bind(kind).bind(payload.to_string()).bind(&now).execute(&st.db).await.ok()?;
    let id = res.last_insert_id().unwrap_or(0);
    Some(json!({ "type": "chat", "id": id, "user_id": user.id, "name": user.name, "kind": kind, "payload": payload, "at": now }))
}

fn player_can_edit(data: &Value, user_id: &str) -> bool {
    data["owner_id"] == user_id || data["editors"].as_array().map(|a| a.iter().any(|e| e == user_id)).unwrap_or(false)
}

async fn handle_message(st: &AppState, cid: &str, conn_id: u64, user: &auth::AuthUser, role: &str, msg: Value) {
    let is_gm = role == "gm";
    let t = msg["type"].as_str().unwrap_or("");
    match t {
        "chat" => {
            let text: String = msg["text"].as_str().unwrap_or("").chars().take(2000).collect::<String>().trim().to_string();
            if text.is_empty() {
                return;
            }
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
        "roll" => {
            let Some(mut r) = roll_expression(msg["expr"].as_str().unwrap_or("d20")) else { return };
            let gm_only = msg["gm_only"].as_bool().unwrap_or(false) && is_gm;
            r["label"] = msg["label"].clone();
            r["gm_only"] = json!(gm_only);
            if let Some(out) = save_chat(st, cid, user, "roll", &r).await {
                if gm_only { st.hub.send_to_role(cid, "gm", &out).await; } else { st.hub.broadcast(cid, &out, None).await; }
            }
        }
        // эфемерные события стола
        "pointer" | "ruler" | "cursor" | "ping" => {
            let mut out = msg.clone();
            out["user_id"] = json!(user.id);
            out["name"] = json!(user.name);
            st.hub.broadcast(cid, &out, Some(conn_id)).await;
        }
        "item_upsert" | "item_delete" | "items_bulk" => {
            let Some(scene_id) = msg["scene_id"].as_str() else { return };
            let ok = sqlx::query("SELECT id FROM scenes WHERE id = ? AND campaign_id = ?").bind(scene_id).bind(cid).fetch_optional(&st.db).await.ok().flatten().is_some();
            if !ok {
                return;
            }
            match t {
                "item_upsert" => item_upsert(st, cid, scene_id, user, is_gm, &msg["item"]).await,
                "item_delete" => {
                    let Some(id) = msg["id"].as_str() else { return };
                    let row = sqlx::query("SELECT data FROM scene_items WHERE id = ? AND scene_id = ?").bind(id).bind(scene_id).fetch_optional(&st.db).await.ok().flatten();
                    if let Some(row) = row {
                        let data = util::json_value(&row.get::<String, _>("data"));
                        if is_gm || player_can_edit(&data, &user.id) {
                            let _ = sqlx::query("DELETE FROM scene_items WHERE id = ?").bind(id).execute(&st.db).await;
                            st.hub.broadcast(cid, &json!({ "type": "item_delete", "scene_id": scene_id, "id": id }), None).await;
                        }
                    }
                }
                _ => {
                    if !is_gm { return; }
                    let items = msg["items"].as_array().cloned().unwrap_or_default();
                    for it in &items {
                        let Some(id) = it["id"].as_str() else { continue };
                        let row = sqlx::query("SELECT layer, z, data FROM scene_items WHERE id = ? AND scene_id = ?").bind(id).bind(scene_id).fetch_optional(&st.db).await.ok().flatten();
                        let Some(row) = row else { continue };
                        let mut data = util::json_value(&row.get::<String, _>("data"));
                        if let (Some(dst), Some(src)) = (data.as_object_mut(), it["data"].as_object()) {
                            for (k, v) in src { dst.insert(k.clone(), v.clone()); }
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
        "scene_update" => {
            if !is_gm { return; }
            let Some(scene_id) = msg["scene_id"].as_str() else { return };
            let row = sqlx::query("SELECT grid, fog, name FROM scenes WHERE id = ? AND campaign_id = ?").bind(scene_id).bind(cid).fetch_optional(&st.db).await.ok().flatten();
            let Some(row) = row else { return };
            let grid = if msg["grid"].is_object() { msg["grid"].to_string() } else { row.get::<String, _>("grid") };
            let fog = if msg["fog"].is_object() { msg["fog"].to_string() } else { row.get::<String, _>("fog") };
            let name = msg["name"].as_str().map(|s| util::truncate(s, 128)).unwrap_or_else(|| row.get::<String, _>("name"));
            let _ = sqlx::query("UPDATE scenes SET grid = ?, fog = ?, name = ? WHERE id = ?").bind(&grid).bind(&fog).bind(&name).bind(scene_id).execute(&st.db).await;
            st.hub.broadcast(cid, &json!({ "type": "scene_update", "scene_id": scene_id, "grid": msg["grid"], "fog": msg["fog"], "name": msg["name"] }), None).await;
        }
        "initiative" => {
            if is_gm {
                st.hub.broadcast(cid, &msg, None).await;
            }
        }
        _ => {}
    }
}

const PLAYER_FIELDS: &[&str] = &["x", "y", "rotation", "hp", "conditions", "attachments", "dead"];
const PLAYER_LAYERS: &[&str] = &["character", "drawing", "text", "ruler"];

async fn item_upsert(st: &AppState, cid: &str, scene_id: &str, user: &auth::AuthUser, is_gm: bool, item: &Value) {
    let id = item["id"].as_str().map(|s| s.to_string());
    let mut data = if item["data"].is_object() { item["data"].clone() } else { json!({}) };
    let layer_in = item["layer"].as_str().map(|s| s.to_string());
    let z_in = item["z"].as_i64();

    let existing = match &id {
        Some(id) => sqlx::query("SELECT layer, z, data FROM scene_items WHERE id = ? AND scene_id = ?").bind(id).bind(scene_id).fetch_optional(&st.db).await.ok().flatten(),
        None => None,
    };

    let (final_id, layer, z, data) = match existing {
        Some(row) => {
            let old = util::json_value(&row.get::<String, _>("data"));
            let mut layer: String = row.get("layer");
            let mut z: i64 = row.get("z");
            let merged = if is_gm {
                layer = layer_in.unwrap_or(layer);
                z = z_in.unwrap_or(z);
                data
            } else {
                if !player_can_edit(&old, &user.id) {
                    return;
                }
                // игроку разрешено менять только позицию/поворот/хиты/состояния своего токена
                let mut m = old.clone();
                if let (Some(dst), Some(src)) = (m.as_object_mut(), data.as_object()) {
                    for k in PLAYER_FIELDS {
                        if let Some(v) = src.get(*k) { dst.insert(k.to_string(), v.clone()); }
                    }
                }
                m
            };
            let id = id.unwrap();
            let _ = sqlx::query("UPDATE scene_items SET layer = ?, z = ?, data = ?, updated_at = ? WHERE id = ?")
                .bind(&layer).bind(z).bind(merged.to_string()).bind(util::now()).bind(&id).execute(&st.db).await;
            (id, layer, z, merged)
        }
        None => {
            let layer = layer_in.unwrap_or_else(|| "character".into());
            if !is_gm && !PLAYER_LAYERS.contains(&layer.as_str()) {
                return;
            }
            if data.get("owner_id").map(|v| v.is_null()).unwrap_or(true) {
                data["owner_id"] = json!(user.id);
            }
            let id = id.filter(|s| !s.is_empty() && s.len() <= 32).unwrap_or_else(util::uid);
            let z = z_in.unwrap_or(0);
            let _ = sqlx::query("INSERT INTO scene_items (id, scene_id, layer, z, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&id).bind(scene_id).bind(&layer).bind(z).bind(data.to_string()).bind(util::now()).execute(&st.db).await;
            (id, layer, z, data)
        }
    };
    st.hub.broadcast(cid, &json!({ "type": "item_upsert", "scene_id": scene_id, "item": { "id": final_id, "scene_id": scene_id, "layer": layer, "z": z, "data": data } }), None).await;
}
