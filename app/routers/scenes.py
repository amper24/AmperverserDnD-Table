from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import Campaign, Scene, SceneItem, User
from ..realtime import hub, item_out
from .campaigns import get_member, require_gm

router = APIRouter(prefix="/api/campaigns/{cid}/scenes", tags=["scenes"])


class SceneIn(BaseModel):
    name: str = "Новая сцена"
    grid: dict | None = None


def scene_out(s: Scene):
    return {"id": s.id, "campaign_id": s.campaign_id, "name": s.name, "grid": s.grid, "fog": s.fog}


@router.get("")
async def list_scenes(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await get_member(db, cid, user.id)
    res = await db.execute(select(Scene).where(Scene.campaign_id == cid).order_by(Scene.created_at))
    return [scene_out(s) for s in res.scalars()]


@router.post("")
async def create_scene(cid: str, body: SceneIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    s = Scene(campaign_id=cid, name=body.name)
    if body.grid:
        s.grid = body.grid
    db.add(s)
    await db.commit()
    return scene_out(s)


@router.get("/{sid}")
async def get_scene(cid: str, sid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    m = await get_member(db, cid, user.id)
    s = await db.get(Scene, sid)
    if not s or s.campaign_id != cid:
        raise HTTPException(404)
    items = (await db.execute(select(SceneItem).where(SceneItem.scene_id == sid).order_by(SceneItem.z))).scalars().all()
    if m.role != "gm":
        items = [i for i in items if not (i.data or {}).get("hidden")]
    out = scene_out(s)
    out["items"] = [item_out(i) for i in items]
    if m.role != "gm":
        # игрокам отдаём только карту тумана без деталей "вырезов" не нужно — они всё равно получают геометрию для отрисовки
        pass
    return out


@router.patch("/{sid}")
async def update_scene(cid: str, sid: str, body: SceneIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    s = await db.get(Scene, sid)
    if not s or s.campaign_id != cid:
        raise HTTPException(404)
    s.name = body.name
    if body.grid:
        s.grid = body.grid
    await db.commit()
    await hub.broadcast(cid, {"type": "scene_update", "scene_id": sid, "grid": s.grid, "name": s.name})
    return scene_out(s)


@router.delete("/{sid}")
async def delete_scene(cid: str, sid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    s = await db.get(Scene, sid)
    if not s or s.campaign_id != cid:
        raise HTTPException(404)
    c = await db.get(Campaign, cid)
    if c.active_scene_id == sid:
        c.active_scene_id = None
    await db.delete(s)
    await db.commit()
    return {"ok": True}


@router.post("/{sid}/duplicate")
async def duplicate_scene(cid: str, sid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    await require_gm(db, cid, user.id)
    s = await db.get(Scene, sid)
    if not s or s.campaign_id != cid:
        raise HTTPException(404)
    n = Scene(campaign_id=cid, name=f"{s.name} (копия)", grid=s.grid, fog=s.fog)
    db.add(n)
    await db.flush()
    items = (await db.execute(select(SceneItem).where(SceneItem.scene_id == sid))).scalars().all()
    for i in items:
        db.add(SceneItem(scene_id=n.id, layer=i.layer, z=i.z, data=dict(i.data)))
    await db.commit()
    return scene_out(n)
