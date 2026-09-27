from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import CampaignMember, Character, User
from ..realtime import hub
from .campaigns import get_member

router = APIRouter(prefix="/api/characters", tags=["characters"])


def default_sheet(name: str = "") -> dict:
    return {
        "name": name, "race": "", "class": "", "subclass": "", "level": 1, "background": "", "alignment": "", "xp": 0,
        "abilities": {"str": 10, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10},
        "proficiency_bonus": 2,
        "saving_throws": [], "skills": [], "expertise": [],
        "hp": {"max": 10, "current": 10, "temp": 0, "hit_dice": "1d8"},
        "ac": 10, "speed": 30, "initiative_bonus": 0, "inspiration": False,
        "attacks": [], "inventory": [], "spells": {"slots": {}, "known": [], "ability": ""},
        "features": [], "traits": {"personality": "", "ideals": "", "bonds": "", "flaws": ""},
        "notes": "", "currency": {"cp": 0, "sp": 0, "ep": 0, "gp": 0, "pp": 0},
        "conditions": [], "death_saves": {"success": 0, "fail": 0},
    }


def out(c: Character):
    return {"id": c.id, "campaign_id": c.campaign_id, "owner_id": c.owner_id, "name": c.name,
            "portrait_asset_id": c.portrait_asset_id, "sheet": c.sheet, "updated_at": c.updated_at.isoformat()}


class CharIn(BaseModel):
    name: str = "Новый персонаж"
    campaign_id: str | None = None
    sheet: dict | None = None
    portrait_asset_id: str | None = None


class CharPatch(BaseModel):
    name: str | None = None
    campaign_id: str | None = None
    sheet: dict | None = None
    portrait_asset_id: str | None = None
    detach_campaign: bool = False


@router.get("")
async def list_chars(campaign_id: str | None = None, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    if campaign_id:
        m = await get_member(db, campaign_id, user.id)
        q = select(Character).where(Character.campaign_id == campaign_id)
        if m.role != "gm":
            q = q.where(or_(Character.owner_id == user.id, Character.sheet["shared"].as_boolean() == True))  # noqa: E712
    else:
        q = select(Character).where(Character.owner_id == user.id)
    res = await db.execute(q.order_by(Character.updated_at.desc()))
    return [out(c) for c in res.scalars()]


@router.post("")
async def create_char(body: CharIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    if body.campaign_id:
        await get_member(db, body.campaign_id, user.id)
    sheet = {**default_sheet(body.name), **(body.sheet or {})}
    c = Character(owner_id=user.id, name=body.name[:128], campaign_id=body.campaign_id, sheet=sheet, portrait_asset_id=body.portrait_asset_id)
    db.add(c)
    await db.commit()
    return out(c)


async def _load(db: AsyncSession, cid: str, user: User, write: bool = False) -> Character:
    c = await db.get(Character, cid)
    if not c:
        raise HTTPException(404)
    if c.owner_id == user.id:
        return c
    if c.campaign_id:
        m = (await db.execute(select(CampaignMember).where(CampaignMember.campaign_id == c.campaign_id, CampaignMember.user_id == user.id))).scalar_one_or_none()
        if m and (m.role == "gm" or (not write and c.sheet.get("shared"))):
            return c
    raise HTTPException(403, "Нет доступа к персонажу")


@router.get("/{cid}")
async def get_char(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    return out(await _load(db, cid, user))


@router.patch("/{cid}")
async def patch_char(cid: str, body: CharPatch, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    c = await _load(db, cid, user, write=True)
    if body.name is not None:
        c.name = body.name[:128]
    if body.sheet is not None:
        c.sheet = body.sheet
        c.name = body.sheet.get("name") or c.name
    if body.portrait_asset_id is not None:
        c.portrait_asset_id = body.portrait_asset_id
    if body.detach_campaign:
        c.campaign_id = None
    elif body.campaign_id:
        await get_member(db, body.campaign_id, user.id)
        c.campaign_id = body.campaign_id
    await db.commit()
    if c.campaign_id:
        await hub.broadcast(c.campaign_id, {"type": "character_update", "character": out(c)})
    return out(c)


@router.delete("/{cid}")
async def delete_char(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    c = await _load(db, cid, user, write=True)
    await db.delete(c)
    await db.commit()
    return {"ok": True}
