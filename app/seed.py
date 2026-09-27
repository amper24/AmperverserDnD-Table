"""Заполнение базы стартовыми данными: справочник и заготовленные ассеты."""
import io
import logging
import math
import random

from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import func, select

from .db import SessionLocal
from .images import compress_image
from .models import Asset, CompendiumEntry
from .seed_data import all_entries

log = logging.getLogger("seed")


def _font(size: int):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def token_image(letter: str, color: str, ring: str = "#222", size: int = 256) -> bytes:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, size - 4, size - 4), fill=color, outline=ring, width=10)
    f = _font(int(size * 0.5))
    bbox = d.textbbox((0, 0), letter, font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), letter, font=f, fill="white")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def prop_image(kind: str, size: int = 256) -> bytes:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == "chest":
        d.rounded_rectangle((30, 90, 226, 210), 14, fill="#8b5a2b", outline="#3b2412", width=8)
        d.rectangle((30, 120, 226, 134), fill="#d4af37")
        d.rectangle((112, 110, 144, 150), fill="#d4af37", outline="#3b2412", width=4)
    elif kind == "door":
        d.rectangle((70, 20, 186, 236), fill="#7a4a1e", outline="#2b1a0a", width=8)
        d.ellipse((150, 120, 170, 140), fill="#d4af37")
    elif kind == "tree":
        d.rectangle((112, 150, 144, 240), fill="#5b3a1a")
        d.ellipse((30, 30, 226, 190), fill="#2f7d32", outline="#1b4d1e", width=6)
    elif kind == "rock":
        d.polygon([(40, 200), (80, 90), (140, 60), (210, 110), (220, 200)], fill="#7d7d7d", outline="#3d3d3d", width=6)
    elif kind == "fire":
        d.polygon([(128, 20), (190, 120), (170, 220), (86, 220), (66, 120)], fill="#ff7a00", outline="#c43e00", width=5)
        d.polygon([(128, 90), (160, 150), (150, 215), (106, 215), (96, 150)], fill="#ffd54f")
    elif kind == "barrel":
        d.rounded_rectangle((70, 30, 186, 226), 30, fill="#8b5a2b", outline="#3b2412", width=8)
        for y in (70, 128, 186):
            d.line((70, y, 186, y), fill="#3b2412", width=6)
    elif kind == "pillar":
        d.ellipse((48, 48, 208, 208), fill="#a8a8a8", outline="#4a4a4a", width=8)
        d.ellipse((90, 90, 166, 166), fill="#c8c8c8")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def map_image(kind: str, cells: int = 20, cell: int = 70) -> bytes:
    size = cells * cell
    palette = {"grass": ("#4f7a3a", "#3f6a2e"), "stone": ("#6f6a63", "#5c5750"), "cave": ("#3a332e", "#2d2723"), "sand": ("#c9b07a", "#b89e68"), "water": ("#2d6a8f", "#255a7a")}
    a, b = palette.get(kind, palette["grass"])
    img = Image.new("RGB", (size, size), a)
    d = ImageDraw.Draw(img)
    rnd = random.Random(kind)
    for _ in range(cells * cells // 2):
        x, y = rnd.randrange(size), rnd.randrange(size)
        r = rnd.randrange(8, 40)
        d.ellipse((x - r, y - r, x + r, y + r), fill=b)
    if kind == "stone":
        for i in range(0, size, cell * 2):
            d.line((i, 0, i, size), fill="#4a4540", width=3)
            d.line((0, i, size, i), fill="#4a4540", width=3)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


BUILTIN_TOKENS = [
    ("Воин", "В", "#b23a3a"), ("Маг", "М", "#3a4fb2"), ("Плут", "П", "#3a8a3a"), ("Жрец", "Ж", "#c9a227"), ("Следопыт", "С", "#2e7d5b"), ("Бард", "Б", "#a23ab2"),
    ("Гоблин", "Г", "#6b8e23"), ("Орк", "О", "#556b2f"), ("Скелет", "Ск", "#bdbdbd"), ("Зомби", "З", "#6d8b74"), ("Волк", "Вл", "#5c5c5c"), ("Дракон", "Д", "#8b0000"),
    ("Бандит", "Бн", "#7f5539"), ("Огр", "Ог", "#8d6e63"), ("Паук", "Пк", "#37474f"), ("Тролль", "Т", "#33691e"), ("NPC", "N", "#607d8b"), ("Босс", "!", "#000000"),
]
BUILTIN_PROPS = [("Сундук", "chest"), ("Дверь", "door"), ("Дерево", "tree"), ("Камень", "rock"), ("Костёр", "fire"), ("Бочка", "barrel"), ("Колонна", "pillar")]
BUILTIN_MAPS = [("Поляна 20x20", "grass"), ("Каменный пол 20x20", "stone"), ("Пещера 20x20", "cave"), ("Пустыня 20x20", "sand"), ("Вода 20x20", "water")]


async def seed():
    async with SessionLocal() as db:
        n = (await db.execute(select(func.count()).select_from(CompendiumEntry).where(CompendiumEntry.campaign_id.is_(None)))).scalar()
        if n == 0:
            entries = all_entries()
            for cat, slug, name, data in entries:
                db.add(CompendiumEntry(category=cat, slug=slug, name=name, source="SRD", data=data))
            await db.commit()
            log.info("Справочник: добавлено %d записей", len(entries))

        n = (await db.execute(select(func.count()).select_from(Asset).where(Asset.builtin.is_(True)))).scalar()
        if n == 0:
            count = 0
            for name, letter, color in BUILTIN_TOKENS:
                info = compress_image(token_image(letter, color), 512)
                db.add(Asset(name=name, kind="token", builtin=True, **{k: info[k] for k in ("mime", "width", "height", "encoding", "data_b64")}))
                count += 1
            for name, kind in BUILTIN_PROPS:
                info = compress_image(prop_image(kind), 512)
                db.add(Asset(name=name, kind="prop", builtin=True, **{k: info[k] for k in ("mime", "width", "height", "encoding", "data_b64")}))
                count += 1
            for name, kind in BUILTIN_MAPS:
                info = compress_image(map_image(kind), 2048)
                db.add(Asset(name=name, kind="map", builtin=True, **{k: info[k] for k in ("mime", "width", "height", "encoding", "data_b64")}))
                count += 1
            await db.commit()
            log.info("Ассеты: добавлено %d встроенных", count)
