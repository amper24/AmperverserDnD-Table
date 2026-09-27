import asyncio
import logging
import secrets
import smtplib
from datetime import datetime, timedelta
from email.message import EmailMessage

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import get_db
from .models import AuthCode, Session, User

log = logging.getLogger("auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE = "dnd_session"
CODE_TTL_MIN = 10


# ---------- отправка почты ----------
def _send_sync(to: str, code: str):
    msg = EmailMessage()
    msg["Subject"] = f"Код входа: {code}"
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg.set_content(f"Ваш код подтверждения для DnD Table: {code}\nКод действует {CODE_TTL_MIN} минут.")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as s:
        s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)


async def send_code(email: str, code: str) -> bool:
    """Возвращает True если письмо реально отправлено, False если dev-режим (код в логе)."""
    if not settings.smtp_host:
        log.warning("SMTP не настроен. Код для %s: %s", email, code)
        print(f"\n===== КОД ПОДТВЕРЖДЕНИЯ для {email}: {code} =====\n", flush=True)
        return False
    try:
        await asyncio.to_thread(_send_sync, email, code)
        return True
    except Exception as e:  # noqa
        log.error("Ошибка отправки письма: %s. Код: %s", e, code)
        print(f"\n===== (SMTP error) КОД для {email}: {code} =====\n", flush=True)
        return False


# ---------- зависимости ----------
async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE) or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Требуется вход")
    res = await db.execute(select(User).join(Session, Session.user_id == User.id).where(Session.token == token))
    user = res.scalar_one_or_none()
    if not user:
        raise HTTPException(401, "Сессия недействительна")
    return user


async def optional_user(request: Request, db: AsyncSession = Depends(get_db)) -> User | None:
    try:
        return await current_user(request, db)
    except HTTPException:
        return None


# ---------- схемы ----------
class RequestCodeIn(BaseModel):
    email: EmailStr


class VerifyIn(BaseModel):
    email: EmailStr
    code: str
    name: str | None = None


# ---------- эндпоинты ----------
@router.post("/request-code")
async def request_code(body: RequestCodeIn, db: AsyncSession = Depends(get_db)):
    email = body.email.lower()
    code = f"{secrets.randbelow(1_000_000):06d}"
    await db.execute(update(AuthCode).where(AuthCode.email == email, AuthCode.used.is_(False)).values(used=True))
    db.add(AuthCode(email=email, code=code, expires_at=datetime.utcnow() + timedelta(minutes=CODE_TTL_MIN)))
    await db.commit()
    sent = await send_code(email, code)
    out = {"ok": True, "sent": sent, "ttl_min": CODE_TTL_MIN}
    if not sent and settings.dev_show_code:
        out["dev_code"] = code
    return out


@router.post("/verify")
async def verify(body: VerifyIn, response: Response, db: AsyncSession = Depends(get_db)):
    email = body.email.lower()
    res = await db.execute(
        select(AuthCode).where(AuthCode.email == email, AuthCode.used.is_(False)).order_by(AuthCode.id.desc()).limit(1)
    )
    ac = res.scalar_one_or_none()
    if not ac or ac.expires_at < datetime.utcnow():
        raise HTTPException(400, "Код не запрошен или истёк")
    if ac.attempts >= 5:
        ac.used = True
        await db.commit()
        raise HTTPException(400, "Слишком много попыток, запросите новый код")
    if not secrets.compare_digest(ac.code, body.code.strip()):
        ac.attempts += 1
        await db.commit()
        raise HTTPException(400, "Неверный код")
    ac.used = True

    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not user:
        user = User(email=email, name=body.name or email.split("@")[0])
        db.add(user)
        await db.flush()
    elif body.name:
        user.name = body.name
    sess = Session(user_id=user.id)
    db.add(sess)
    await db.commit()
    response.set_cookie(COOKIE, sess.token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 30)
    return {"ok": True, "token": sess.token, "user": {"id": user.id, "email": user.email, "name": user.name}}


@router.post("/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token = request.cookies.get(COOKIE)
    if token:
        s = await db.get(Session, token)
        if s:
            await db.delete(s)
            await db.commit()
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return {"id": user.id, "email": user.email, "name": user.name}


class ProfileIn(BaseModel):
    name: str


@router.patch("/me")
async def update_me(body: ProfileIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    user.name = body.name.strip()[:64]
    db.add(user)
    await db.commit()
    return {"ok": True}


# Задел под Google OAuth: сюда позже добавится /google/start и /google/callback,
# который найдёт/создаст User по google_sub и выдаст такую же Session.
