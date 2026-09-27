"""Сжатие изображений для хранения в БД.

Пайплайн: исходник -> PIL (ресайз, WebP) -> zlib(deflate) -> base64.
Клиент: base64 -> DecompressionStream('deflate') -> Blob(image/webp) -> <img>.
"""
import base64
import io
import zlib

from PIL import Image

from .config import settings


def compress_image(raw: bytes, max_side: int | None = None) -> dict:
    max_side = max_side or settings.image_max_side
    img = Image.open(io.BytesIO(raw))
    img.load()
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=settings.image_quality, method=4)
    webp = buf.getvalue()
    packed = zlib.compress(webp, 9)
    return {
        "mime": "image/webp",
        "width": img.width,
        "height": img.height,
        "encoding": "deflate",
        "data_b64": base64.b64encode(packed).decode("ascii"),
        "raw_size": len(raw),
        "stored_size": len(packed),
    }
