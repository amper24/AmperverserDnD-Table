import secrets
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def uid() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.utcnow()


# LONGTEXT в MySQL для больших base64 изображений
from sqlalchemy.dialects.mysql import LONGTEXT

LongText = Text().with_variant(LONGTEXT(), "mysql")


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    google_sub: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)  # для будущего входа через Google
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class AuthCode(Base):
    """Одноразовый код подтверждения, отправляемый на почту."""
    __tablename__ = "auth_codes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), index=True)
    code: Mapped[str] = mapped_column(String(8))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class Session(Base):
    __tablename__ = "sessions"
    token: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: secrets.token_urlsafe(32))
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Campaign(Base):
    __tablename__ = "campaigns"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    owner_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id"))
    active_scene_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    members: Mapped[list["CampaignMember"]] = relationship(back_populates="campaign", cascade="all, delete-orphan")


class CampaignMember(Base):
    __tablename__ = "campaign_members"
    __table_args__ = (UniqueConstraint("campaign_id", "user_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    campaign_id: Mapped[str] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default="player")  # gm | player
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    campaign: Mapped[Campaign] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class Invite(Base):
    """Ссылка-приглашение в кампанию."""
    __tablename__ = "invites"
    code: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: secrets.token_urlsafe(12))
    campaign_id: Mapped[str] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default="player")
    max_uses: Mapped[int] = mapped_column(Integer, default=0)  # 0 = без ограничений
    uses: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Asset(Base):
    """Изображение: сжато (WebP/JPEG) + zlib, хранится как base64. Клиент распаковывает сам."""
    __tablename__ = "assets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    campaign_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=True, index=True)
    owner_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("users.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16), default="token")  # map | token | prop | portrait | item
    mime: Mapped[str] = mapped_column(String(32), default="image/webp")
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    encoding: Mapped[str] = mapped_column(String(16), default="deflate")  # алгоритм сжатия поверх картинки
    data_b64: Mapped[str] = mapped_column(LongText)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)  # заготовленный ассет
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Scene(Base):
    """Сцена (как в Owlbear Rodeo): бесконечный холст с картой, сеткой и предметами."""
    __tablename__ = "scenes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    campaign_id: Mapped[str] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    grid: Mapped[dict] = mapped_column(JSON, default=lambda: {"size": 70, "type": "square", "visible": True, "color": "#00000055", "scale": "5 фт"})
    fog: Mapped[dict] = mapped_column(JSON, default=lambda: {"enabled": False, "shapes": []})
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class SceneItem(Base):
    """Элемент сцены: карта, токен, рисунок, текст, линейка и т.п. Все свойства в JSON."""
    __tablename__ = "scene_items"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    scene_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenes.id", ondelete="CASCADE"), index=True)
    layer: Mapped[str] = mapped_column(String(16), default="character")  # map | prop | mount | character | attachment | drawing | text | note | fog
    z: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Character(Base):
    __tablename__ = "characters"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    campaign_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="SET NULL"), nullable=True, index=True)
    owner_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    portrait_asset_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sheet: Mapped[dict] = mapped_column(JSON, default=dict)  # полный лист персонажа
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    campaign_id: Mapped[str] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(16), default="text")  # text | roll | system
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class CompendiumEntry(Base):
    """Справочник: расы, классы, предметы, заклинания, монстры, предыстории. Базовый набор + свои (в кампании)."""
    __tablename__ = "compendium"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    campaign_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=True, index=True)
    category: Mapped[str] = mapped_column(String(24), index=True)  # race | class | item | spell | monster | background | feat
    slug: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(128))
    source: Mapped[str] = mapped_column(String(32), default="SRD")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
