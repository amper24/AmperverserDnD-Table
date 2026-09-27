from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..images import compress_image
from ..models import Asset, User
from .campaigns import get_member

router = APIRouter(prefix="/api/assets", tags=["assets"])

MAX_UPLOAD = 25 * 1024 * 1024


def meta(a: Asset):
    return {
        "id": a.id, "name": a.name, "kind": a.kind, "mime": a.mime, "width": a.width, "height": a.height,
        "encoding": a.encoding, "builtin": a.builtin, "campaign_id": a.campaign_id, "size": len(a.data_b64),
    }


@router.get("")
async def list_assets(campaign_id: str | None = None, kind: str | None = None, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Список ассетов: заготовленные (builtin) + свои + кампании."""
    conds = [Asset.builtin.is_(True), Asset.owner_id == user.id]
    if campaign_id:
        await get_member(db, campaign_id, user.id)
        conds.append(Asset.campaign_id == campaign_id)
    q = select(Asset.id, Asset.name, Asset.kind, Asset.mime, Asset.width, Asset.height, Asset.encoding, Asset.builtin, Asset.campaign_id).where(or_(*conds))
    if kind:
        q = q.where(Asset.kind == kind)
    q = q.order_by(Asset.builtin.desc(), Asset.created_at.desc())
    rows = (await db.execute(q)).all()
    return [dict(r._mapping) for r in rows]


@router.post("")
async def upload(
    file: UploadFile = File(...),
    name: str = Form(""),
    kind: str = Form("token"),
    campaign_id: str | None = Form(None),
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    raw = await file.read()
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "Файл слишком большой")
    if campaign_id:
        await get_member(db, campaign_id, user.id)
    try:
        info = compress_image(raw, max_side=4096 if kind == "map" else 1024)
    except Exception:
        raise HTTPException(400, "Не удалось прочитать изображение")
    a = Asset(
        campaign_id=campaign_id, owner_id=user.id, name=(name or file.filename or "image")[:128], kind=kind,
        mime=info["mime"], width=info["width"], height=info["height"], encoding=info["encoding"], data_b64=info["data_b64"],
    )
    db.add(a)
    await db.commit()
    return {**meta(a), "raw_size": info["raw_size"], "stored_size": info["stored_size"]}


@router.get("/{aid}")
async def get_asset(aid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Отдаёт base64 сжатых данных; распаковка на клиенте."""
    a = await db.get(Asset, aid)
    if not a:
        raise HTTPException(404)
    if not a.builtin and a.owner_id != user.id and a.campaign_id:
        await get_member(db, a.campaign_id, user.id)
    return JSONResponse({**meta(a), "data_b64": a.data_b64}, headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.delete("/{aid}")
async def delete_asset(aid: str, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    a = await db.get(Asset, aid)
    if not a or a.builtin:
        raise HTTPException(404)
    if a.owner_id != user.id:
        if a.campaign_id:
            m = await get_member(db, a.campaign_id, user.id)
            if m.role != "gm":
                raise HTTPException(403)
        else:
            raise HTTPException(403)
    await db.delete(a)
    await db.commit()
    return {"ok": True}
