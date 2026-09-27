import os
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    pass


url = settings.database_url
if url.startswith("sqlite"):
    os.makedirs("data", exist_ok=True)
    engine = create_async_engine(url, echo=False)
else:
    engine = create_async_engine(url, echo=False, pool_pre_ping=True, pool_recycle=1800, pool_size=10)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db():
    async with SessionLocal() as session:
        yield session
