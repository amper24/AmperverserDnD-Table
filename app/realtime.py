"""WebSocket-хаб: одна комната на кампанию, рассылка событий стола/чата."""
import asyncio
import json
import random
import re
from collections import defaultdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from .db import SessionLocal
from .models import CampaignMember, ChatMessage, Scene, SceneItem, Session, User

router = APIRouter()


class Hub:
    def __init__(self):
        self.rooms: dict[str, dict[WebSocket, dict]] = defaultdict(dict)

    async def broadcast(self, cid: str, msg: dict, exclude: WebSocket | None = None):
        dead = []
        data = json.dumps(msg, ensure_ascii=False)
        for ws in list(self.rooms.get(cid, {})):
            if ws is exclude:
                continue
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.rooms[cid].pop(ws, None)

    def presence(self, cid: str):
        return [{"user_id": m["user_id"], "name": m["name"], "role": m["role"]} for m in self.rooms.get(cid, {}).values()]


hub = Hub()

DICE_RE = re.compile(r"(\d*)d(\d+)(kh\d+|kl\d+)?", re.I)


def roll_expression(expr: str) -> dict:
    """Парсер бросков: 2d20kh1+5, d8+1d6-2, 4d6kl3 и т.п."""
    expr = expr.replace(" ", "").lower()
    if not re.fullmatch(r"[0-9d+\-khl]+", expr) or len(expr) > 64:
        raise ValueError("bad expression")
    total, parts = 0, []
    for sign, term in re.findall(r"([+-]?)([^+-]+)", expr):
        mult = -1 if sign == "-" else 1
        m = DICE_RE.fullmatch(term)
        if m:
            n = int(m.group(1) or 1)
            sides = int(m.group(2))
            if n > 100 or sides > 1000:
                raise ValueError("too big")
            rolls = [random.randint(1, sides) for _ in range(n)]
            kept = rolls
            if m.group(3):
                k = int(m.group(3)[2:])
                kept = sorted(rolls, reverse=m.group(3)[1] == "h")[:k]
            s = sum(kept) * mult
            parts.append({"term": f"{sign}{term}", "rolls": rolls, "kept": kept, "sides": sides})
            total += s
        else:
            v = int(term) * mult
            parts.append({"term": f"{sign}{term}", "value": v})
            total += v
    return {"expr": expr, "parts": parts, "total": total}


@router.websocket("/ws/{cid}")
async def ws_endpoint(ws: WebSocket, cid: str):
    token = ws.query_params.get("token") or ws.cookies.get("dnd_session")
    async with SessionLocal() as db:
        user = (await db.execute(select(User).join(Session, Session.user_id == User.id).where(Session.token == token))).scalar_one_or_none()
        member = None
        if user:
            member = (await db.execute(select(CampaignMember).where(CampaignMember.campaign_id == cid, CampaignMember.user_id == user.id))).scalar_one_or_none()
    if not user or not member:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.rooms[cid][ws] = {"user_id": user.id, "name": user.name, "role": member.role}
    await hub.broadcast(cid, {"type": "presence", "users": hub.presence(cid)})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            await handle(ws, cid, user, member.role, msg)
    except WebSocketDisconnect:
        pass
    finally:
        hub.rooms[cid].pop(ws, None)
        await hub.broadcast(cid, {"type": "presence", "users": hub.presence(cid)})


async def handle(ws: WebSocket, cid: str, user: User, role: str, msg: dict):
    t = msg.get("type")
    is_gm = role == "gm"

    if t == "chat":
        text = str(msg.get("text", ""))[:2000].strip()
        if not text:
            return
        kind, payload = "text", {"text": text, "whisper": msg.get("whisper")}
        if text.startswith("/r ") or text.startswith("/roll "):
            try:
                r = roll_expression(text.split(" ", 1)[1])
                kind, payload = "roll", {**r, "label": msg.get("label")}
            except ValueError:
                payload = {"text": "Неверное выражение броска"}
        async with SessionLocal() as db:
            m = ChatMessage(campaign_id=cid, user_id=user.id, kind=kind, payload=payload)
            db.add(m)
            await db.commit()
            out = {"type": "chat", "id": m.id, "user_id": user.id, "name": user.name, "kind": kind, "payload": payload, "at": m.created_at.isoformat()}
        await hub.broadcast(cid, out)
        return

    if t == "roll":
        try:
            r = roll_expression(str(msg.get("expr", "d20")))
        except ValueError:
            return
        payload = {**r, "label": msg.get("label"), "gm_only": bool(msg.get("gm_only")) and is_gm}
        async with SessionLocal() as db:
            m = ChatMessage(campaign_id=cid, user_id=user.id, kind="roll", payload=payload)
            db.add(m)
            await db.commit()
            out = {"type": "chat", "id": m.id, "user_id": user.id, "name": user.name, "kind": "roll", "payload": payload, "at": m.created_at.isoformat()}
        if payload["gm_only"]:
            for sock, meta in hub.rooms[cid].items():
                if meta["role"] == "gm":
                    await sock.send_text(json.dumps(out, ensure_ascii=False))
        else:
            await hub.broadcast(cid, out)
        return

    # --- эфемерные события стола (не сохраняются) ---
    if t in ("pointer", "ruler", "cursor", "ping"):
        await hub.broadcast(cid, {**msg, "user_id": user.id, "name": user.name}, exclude=ws)
        return

    # --- элементы сцены ---
    if t in ("item_upsert", "item_delete", "items_bulk"):
        scene_id = msg.get("scene_id")
        async with SessionLocal() as db:
            scene = await db.get(Scene, scene_id)
            if not scene or scene.campaign_id != cid:
                return
            if t == "item_upsert":
                it = msg.get("item") or {}
                iid = it.get("id")
                row = await db.get(SceneItem, iid) if iid else None
                data = it.get("data", {})
                if row:
                    # игрок может двигать только токены, которыми владеет
                    if not is_gm and not _player_can_edit(row, user.id):
                        return
                    if not is_gm:
                        # игроку разрешено менять только позицию/поворот и hp-данные своего токена
                        allowed = {k: data[k] for k in ("x", "y", "rotation", "hp", "conditions", "attachments") if k in data}
                        row.data = {**row.data, **allowed}
                    else:
                        row.data = data
                        row.layer = it.get("layer", row.layer)
                        row.z = it.get("z", row.z)
                else:
                    if not is_gm and it.get("layer", "character") not in ("character", "drawing", "text", "ruler"):
                        return
                    data.setdefault("owner_id", user.id)
                    row = SceneItem(id=iid or None, scene_id=scene_id, layer=it.get("layer", "character"), z=it.get("z", 0), data=data)
                    db.add(row)
                await db.commit()
                await db.refresh(row)
                await hub.broadcast(cid, {"type": "item_upsert", "scene_id": scene_id, "item": item_out(row)})
            elif t == "item_delete":
                row = await db.get(SceneItem, msg.get("id"))
                if row and row.scene_id == scene_id and (is_gm or _player_can_edit(row, user.id)):
                    await db.delete(row)
                    await db.commit()
                    await hub.broadcast(cid, {"type": "item_delete", "scene_id": scene_id, "id": msg.get("id")})
            elif t == "items_bulk" and is_gm:
                for it in msg.get("items", []):
                    row = await db.get(SceneItem, it.get("id"))
                    if row and row.scene_id == scene_id:
                        row.data = {**row.data, **it.get("data", {})}
                        if "z" in it:
                            row.z = it["z"]
                        if "layer" in it:
                            row.layer = it["layer"]
                await db.commit()
                await hub.broadcast(cid, {"type": "items_bulk", "scene_id": scene_id, "items": msg.get("items", [])})
        return

    if t == "scene_update" and is_gm:
        async with SessionLocal() as db:
            scene = await db.get(Scene, msg.get("scene_id"))
            if not scene or scene.campaign_id != cid:
                return
            if "grid" in msg:
                scene.grid = msg["grid"]
            if "fog" in msg:
                scene.fog = msg["fog"]
            if "name" in msg:
                scene.name = msg["name"]
            await db.commit()
        await hub.broadcast(cid, {"type": "scene_update", "scene_id": msg.get("scene_id"), "grid": msg.get("grid"), "fog": msg.get("fog"), "name": msg.get("name")})
        return

    if t == "initiative" and is_gm:
        await hub.broadcast(cid, msg)
        return


def _player_can_edit(row: SceneItem, user_id: str) -> bool:
    d = row.data or {}
    return d.get("owner_id") == user_id or user_id in (d.get("editors") or [])


def item_out(row: SceneItem):
    return {"id": row.id, "scene_id": row.scene_id, "layer": row.layer, "z": row.z, "data": row.data}
