import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, realtime
from .config import settings
from .db import Base, engine
from .routers import assets, campaigns, characters, compendium, scenes
from .seed import seed

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
STATIC = os.path.join(os.path.dirname(__file__), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from . import models  # noqa: F401  регистрация таблиц
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await seed()
    logging.getLogger("app").info("DnD Table запущен: http://%s:%s  (БД: %s)", settings.host, settings.port, settings.database_url.split("@")[-1])
    yield
    await engine.dispose()


app = FastAPI(title="Amperverser DnD Table", version="0.1.0", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(campaigns.router)
app.include_router(campaigns.join_router)
app.include_router(scenes.router)
app.include_router(assets.router)
app.include_router(characters.router)
app.include_router(compendium.router)
app.include_router(realtime.router)


@app.get("/api/health")
async def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# SPA-маршруты
@app.get("/sheet/{cid}")
async def sheet_page(cid: str):
    return FileResponse(os.path.join(STATIC, "sheet.html"))


@app.get("/{path:path}")
async def spa(path: str):
    return FileResponse(os.path.join(STATIC, "index.html"))


def run():
    import uvicorn
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False, ws_ping_interval=20)


if __name__ == "__main__":
    run()
