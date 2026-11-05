//! Сжатие изображений для хранения в БД.
//! Пайплайн: исходник -> decode -> ресайз -> JPEG (без альфы) / PNG (с альфой) -> zlib(deflate) -> base64.
//! Клиент: base64 -> DecompressionStream('deflate') -> Blob(mime) -> <img>.
use std::io::{Cursor, Write};

use base64::Engine;
use flate2::{write::ZlibEncoder, Compression};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct Compressed {
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub encoding: String,
    pub data_b64: String,
    pub raw_size: usize,
    pub stored_size: usize,
}

pub fn compress_image(raw: &[u8], max_side: u32, quality: u8) -> anyhow::Result<Compressed> {
    let img = image::load_from_memory(raw)?;
    let format = image::guess_format(raw).unwrap_or(ImageFormat::Png);
    let (w, h) = img.dimensions();
    let img = if w.max(h) > max_side { img.resize(max_side, max_side, FilterType::Lanczos3) } else { img };
    let (w2, h2) = img.dimensions();

    // GIF сохраняем в исходном формате, чтобы не потерять анимацию.
    let mut encoded = Vec::new();
    let mime = if format == ImageFormat::Gif {
        img.write_to(&mut Cursor::new(&mut encoded), ImageFormat::Gif)?;
        "image/gif".to_string()
    } else {
        let has_alpha = img.color().has_alpha() && image_has_transparency(&img);
        if has_alpha {
            img.to_rgba8().write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)?;
            "image/png".to_string()
        } else {
            let rgb = img.to_rgb8();
            let mut cursor = Cursor::new(&mut encoded);
            let enc = JpegEncoder::new_with_quality(&mut cursor, quality);
            rgb.write_with_encoder(enc)?;
            "image/jpeg".to_string()
        }
    };

    let mut z = ZlibEncoder::new(Vec::new(), Compression::best());
    z.write_all(&encoded)?;
    let packed = z.finish()?;
    Ok(Compressed {
        mime,
        width: w2 as i64,
        height: h2 as i64,
        encoding: "deflate".into(),
        data_b64: base64::engine::general_purpose::STANDARD.encode(&packed),
        raw_size: raw.len(),
        stored_size: packed.len(),
    })
}

/// Есть ли в картинке реально прозрачные пиксели (иначе JPEG выгоднее).
fn image_has_transparency(img: &DynamicImage) -> bool {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let step = ((w * h) / 20_000).max(1) as usize;
    rgba.pixels().step_by(step).any(|p| p[3] < 250)
}
