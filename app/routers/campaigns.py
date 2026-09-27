from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..auth import current_user
from ..db import get_db
from ..models import Campaign, CampaignMember, ChatMessage, Invite, Scene, User

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


# ---------- helpers ----------
async def get_member(db: AsyncSession, campaign_id: str, user_id: str) -> CampaignMember:
    m = (
        await db.execute(
            select(CampaignMember).where(CampaignMember.campaign_id == campaign_id, CampaignMember.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not m:
        raise HTTPException(403, "Вы не участник этой кампании")
    return m


async def require_gm(db: AsyncSession, campaign_id: str, user_id: str) -> CampaignMember:
    m = await get_member(db, campaign_id, user_id)
    if m.role != "gm":
        raise HTTPException(403, "Только мастер может это делать")
    return m


def campaign_out(c: Campaign, role: str | None = None):
    return {
        "id": c.id,
        "name": c.name,
        "description": c.description,
        "owner_id": c.owner_id,
        "active_scene_id": c.active_scene_id,
        "role": role,
        "created_at": c.created_at.isoformat(),
    }


# ---------- schemas ----------
class CampaignIn(BaseModel):
    name: str
    description: str = ""


class InviteIn(BaseModel):
    role: str = "player"
    max_uses: int = 0


class RoleIn(BaseModel):
    role: str


class ActiveSceneIn(BaseModel):
    scene_id: str | None


# ---------- endpoints ----------
@router.get("")
async def list_campaigns(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(Campaign, CampaignMember.role)
        .join(CampaignMember, CampaignMember.campaign_id == Campaign.id)
        .where(CampaignMember.user_id == user.id)
        .order_by(Campaign.created_at.desc())
    )
    return [campaign_out(c, role) for c, role in res.all()]


@router.post("")
async def create_campaign(body: CampaignIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    c = Campaign(name=body.name.strip()[:128] or "Новая кампания", description=body.description, owner_id=user.id)
    db.add(c)
    await db.flush()
    db.add(CampaignMember(campaign_id=c.id, user_id=user.id, role="gm"))
    scene = Scene(campaign_id=c.id, name="Первая сцена")
    db.add(scene)
    await db.flush()
    c.active_scene_id = scene.id
    await db.commit()
    return campaign_out(c, "gm")


@router.get("/{cid}")
async def get_campaign(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    m = await get_member(db, cid, user.id)
    c = await db.get(Campaign, cid)
    members = (
        await db.execute(select(CampaignMember).options(selectinload(CampaignMember.user)).where(CampaignMember.campaign_id == cid))
    ).scalars().all()
    out = campaign_out(c, m.role)
    out["members"] = [{"user_id": x.user_id, "name": x.user.name, "email": x.user.email if m.role == "gm" else None, "role": x.role} for x in members]
    return out


@router.patch("/{cid}")
async def update_campaign(cid: str, body: CampaignIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    c = await db.get(Campaign, cid)
    c.name, c.description = body.name.strip()[:128], body.description
    await db.commit()
    return campaign_out(c, "gm")


@router.delete("/{cid}")
async def delete_campaign(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    c = await db.get(Campaign, cid)
    if not c or c.owner_id != user.id:
        raise HTTPException(403, "Удалить может только владелец")
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.post("/{cid}/active-scene")
async def set_active_scene(cid: str, body: ActiveSceneIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    c = await db.get(Campaign, cid)
    c.active_scene_id = body.scene_id
    await db.commit()
    from ..realtime import hub
    await hub.broadcast(cid, {"type": "active_scene", "scene_id": body.scene_id})
    return {"ok": True}


# ---- приглашения ----
@router.post("/{cid}/invites")
async def create_invite(cid: str, body: InviteIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    inv = Invite(campaign_id=cid, role=body.role if body.role in ("gm", "player") else "player", max_uses=body.max_uses)
    db.add(inv)
    await db.commit()
    return {"code": inv.code, "role": inv.role, "url": f"/join/{inv.code}"}


@router.get("/{cid}/invites")
async def list_invites(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    res = await db.execute(select(Invite).where(Invite.campaign_id == cid))
    return [{"code": i.code, "role": i.role, "uses": i.uses, "max_uses": i.max_uses, "url": f"/join/{i.code}"} for i in res.scalars()]


@router.delete("/{cid}/invites/{code}")
async def delete_invite(cid: str, code: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    await db.execute(delete(Invite).where(Invite.code == code, Invite.campaign_id == cid))
    await db.commit()
    return {"ok": True}


@router.patch("/{cid}/members/{uid}")
async def set_role(cid: str, uid: str, body: RoleIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    c = await db.get(Campaign, cid)
    if uid == c.owner_id and body.role != "gm":
        raise HTTPException(400, "Владелец всегда мастер")
    m = await get_member(db, cid, uid)
    m.role = body.role if body.role in ("gm", "player") else "player"
    await db.commit()
    return {"ok": True}


@router.delete("/{cid}/members/{uid}")
async def kick(cid: str, uid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    if uid != user.id:
        await require_gm(db, cid, user.id)
    c = await db.get(Campaign, cid)
    if uid == c.owner_id:
        raise HTTPException(400, "Владельца нельзя исключить")
    await db.execute(delete(CampaignMember).where(CampaignMember.campaign_id == cid, CampaignMember.user_id == uid))
    await db.commit()
    return {"ok": True}


@router.get("/{cid}/chat")
async def chat_history(cid: str, limit: int = 100, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await get_member(db, cid, user.id)
    res = await db.execute(
        select(ChatMessage, User.name).join(User, User.id == ChatMessage.user_id)
        .where(ChatMessage.campaign_id == cid).order_by(ChatMessage.id.desc()).limit(limit)
    )
    rows = [{"id": m.id, "user_id": m.user_id, "name": n, "kind": m.kind, "payload": m.payload, "at": m.created_at.isoformat()} for m, n in res.all()]
    return list(reversed(rows))


# ---- присоединение по ссылке ----
join_router = APIRouter(prefix="/api/join", tags=["campaigns"])


@join_router.get("/{code}")
async def invite_info(code: str, db: AsyncSession = Depends(get_db)):
    inv = await db.get(Invite, code)
    if not inv:
        raise HTTPException(404, "Приглашение не найдено")
    c = await db.get(Campaign, inv.campaign_id)
    return {"campaign": {"id": c.id, "name": c.name, "description": c.description}, "role": inv.role}


@join_router.post("/{code}")
async def join(code: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    inv = await db.get(Invite, code)
    if not inv:
        raise HTTPException(404, "Приглашение не найдено")
    if inv.max_uses and inv.uses >= inv.max_uses:
        raise HTTPException(400, "Приглашение исчерпано")
    existing = (
        await db.execute(select(CampaignMember).where(CampaignMember.campaign_id == inv.campaign_id, CampaignMember.user_id == user.id))
    ).scalar_one_or_none()
    if not existing:
        db.add(CampaignMember(campaign_id=inv.campaign_id, user_id=user.id, role=inv.role))
        inv.uses += 1
        await db.commit()
    return {"ok": True, "campaign_id": inv.campaign_id}
