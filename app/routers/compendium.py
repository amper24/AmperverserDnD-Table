from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import CompendiumEntry, User
from .campaigns import get_member, require_gm

router = APIRouter(prefix="/api/compendium", tags=["compendium"])

CATEGORIES = ["race", "class", "background", "item", "spell", "monster", "feat", "condition"]


def out(e: CompendiumEntry):
    return {"id": e.id, "category": e.category, "slug": e.slug, "name": e.name, "source": e.source, "campaign_id": e.campaign_id, "data": e.data}


@router.get("/categories")
async def categories():
    return CATEGORIES


@router.get("")
async def search(
    category: str | None = None,
    q: str | None = None,
    campaign_id: str | None = None,
    limit: int = Query(200, le=1000),
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    conds = [CompendiumEntry.campaign_id.is_(None)]
    if campaign_id:
        await get_member(db, campaign_id, user.id)
        conds.append(CompendiumEntry.campaign_id == campaign_id)
    stmt = select(CompendiumEntry).where(or_(*conds))
    if category:
        stmt = stmt.where(CompendiumEntry.category == category)
    if q:
        stmt = stmt.where(CompendiumEntry.name.ilike(f"%{q}%"))
    stmt = stmt.order_by(CompendiumEntry.category, CompendiumEntry.name).limit(limit)
    res = await db.execute(stmt)
    return [out(e) for e in res.scalars()]


@router.get("/{eid}")
async def get_entry(eid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    e = await db.get(CompendiumEntry, eid)
    if not e:
        raise HTTPException(404)
    return out(e)


class EntryIn(BaseModel):
    category: str
    name: str
    data: dict = {}
    campaign_id: str


@router.post("")
async def create_entry(body: EntryIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Собственные записи (homebrew) в рамках кампании — создаёт мастер."""
    await require_gm(db, body.campaign_id, user.id)
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Неизвестная категория")
    e = CompendiumEntry(category=body.category, slug=body.name.lower().replace(" ", "-")[:64], name=body.name[:128],
                        source="Homebrew", campaign_id=body.campaign_id, data=body.data)
    db.add(e)
    await db.commit()
    return out(e)


@router.patch("/{eid}")
async def update_entry(eid: str, body: EntryIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    e = await db.get(CompendiumEntry, eid)
    if not e or not e.campaign_id:
        raise HTTPException(404)
    await require_gm(db, e.campaign_id, user.id)
    e.name, e.data, e.category = body.name[:128], body.data, body.category
    await db.commit()
    return out(e)


@router.delete("/{eid}")
async def delete_entry(eid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    e = await db.get(CompendiumEntry, eid)
    if not e or not e.campaign_id:
        raise HTTPException(404)
    await require_gm(db, e.campaign_id, user.id)
    await db.delete(e)
    await db.commit()
    return {"ok": True}
