use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// Lets the frontend cancel an in-progress strip by id, same pattern as
// matching/detection — closing the tab or navigating away mid-run doesn't
// stop the Rust-side work on its own.
static CANCELLED_RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_set() -> &'static Mutex<HashSet<String>> {
    CANCELLED_RUNS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn cancel_run(run_id: &str) {
    cancelled_set().lock().unwrap().insert(run_id.to_string());
}

fn is_cancelled(run_id: &str) -> bool {
    cancelled_set().lock().unwrap().contains(run_id)
}

fn clear_cancelled(run_id: &str) {
    cancelled_set().lock().unwrap().remove(run_id);
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StripSummary {
    pub stripped: usize,
    pub failed: usize,
    pub cancelled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StripProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
}

fn is_image_file(path: &Path) -> bool {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_ascii_lowercase(),
        None => return false,
    };
    matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp")
}

// Recursively collects every image file under `root` so the total is known
// up front, before any file is touched.
fn collect_images(root: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, out);
        } else if is_image_file(&path) {
            out.push(path);
        }
    }
}

// Alpha at or above this counts as opaque: hidden data only ever nudges
// opaque pixels a step or two below 255.
const OPAQUE_ALPHA: u8 = 250;

// NovelAI hides a second copy of an image's prompt and settings in the
// lowest bit of every pixel's alpha value ("stealth" metadata), which a
// lossless re-save would carry over untouched. An image that's opaque apart
// from that loses its alpha channel entirely; a genuinely transparent one
// keeps it with the lowest bit cleared, a change too small to see.
fn scrub_alpha(img: DynamicImage) -> DynamicImage {
    match img {
        DynamicImage::ImageRgba8(mut buf) => {
            if buf.pixels().all(|p| p[3] >= OPAQUE_ALPHA) {
                DynamicImage::ImageRgba8(buf).to_rgb8().into()
            } else {
                buf.pixels_mut().for_each(|p| p[3] &= !1);
                DynamicImage::ImageRgba8(buf)
            }
        }
        DynamicImage::ImageLumaA8(mut buf) => {
            if buf.pixels().all(|p| p[1] >= OPAQUE_ALPHA) {
                DynamicImage::ImageLumaA8(buf).to_luma8().into()
            } else {
                buf.pixels_mut().for_each(|p| p[1] &= !1);
                DynamicImage::ImageLumaA8(buf)
            }
        }
        // 16-bit and float images aren't what generators hide data in.
        other => other,
    }
}

// Decoding and re-encoding a photo drops whatever metadata it carried in
// its file structure (EXIF, PNG text chunks such as NovelAI's prompt and
// settings) — the `image` crate's encoders only include EXIF/ICC data when a
// caller explicitly attaches it, which nothing here does. Data hidden in the
// pixels themselves is handled by `scrub_alpha`. JPEGs are routed
// through the encoder directly at a high quality instead of the plain
// `save()` default (75), since this operation is meant to remove metadata,
// not visibly recompress people's photos.
fn strip_one(path: &Path) -> Result<(), String> {
    let img = scrub_alpha(image::open(path).map_err(|e| format!("{}: {e}", path.display()))?);
    let format = ImageFormat::from_path(path).map_err(|e| format!("{}: {e}", path.display()))?;

    if format == ImageFormat::Jpeg {
        let rgb = img.to_rgb8();
        let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let writer = std::io::BufWriter::new(file);
        JpegEncoder::new_with_quality(writer, 95)
            .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .map_err(|e| format!("{}: {e}", path.display()))?;
    } else {
        img.save(path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

pub fn strip_metadata_recursive(
    run_id: String,
    root_dir: String,
    mut on_progress: impl FnMut(usize, usize),
) -> StripSummary {
    let mut images = Vec::new();
    collect_images(Path::new(&root_dir), &mut images);

    let total = images.len();
    let mut done = 0usize;
    let mut stripped = 0usize;
    let mut failed = 0usize;
    on_progress(done, total);

    for path in images {
        if is_cancelled(&run_id) {
            clear_cancelled(&run_id);
            return StripSummary {
                stripped,
                failed,
                cancelled: true,
            };
        }

        match strip_one(&path) {
            Ok(()) => stripped += 1,
            Err(_) => failed += 1,
        }
        done += 1;
        on_progress(done, total);
    }

    clear_cancelled(&run_id);
    StripSummary {
        stripped,
        failed,
        cancelled: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgba, RgbaImage};

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in bytes {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut c = (body.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(body);
        let crc = crc32(&[kind.as_slice(), body].concat());
        c.extend_from_slice(&crc.to_be_bytes());
        c
    }

    // Chunk types in a PNG file, in order.
    fn chunk_types(png: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        let mut pos = 8;
        while pos + 8 <= png.len() {
            let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
            out.push(String::from_utf8_lossy(&png[pos + 4..pos + 8]).into_owned());
            pos += 12 + len;
        }
        out
    }

    // A PNG shaped like a NovelAI image: prompt and settings in text chunks
    // after IHDR, plus a pattern in the alpha channel's lowest bits.
    fn novelai_like_png(img: &RgbaImage) -> Vec<u8> {
        let mut encoded = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut encoded), ImageFormat::Png).unwrap();
        let ihdr_end = 8 + 12 + 13;
        let mut png = encoded[..ihdr_end].to_vec();
        png.extend(chunk(b"tEXt", b"Software\0NovelAI"));
        png.extend(chunk(b"tEXt", b"Comment\0{\"prompt\": \"1girl, secret prompt\", \"seed\": 42}"));
        png.extend_from_slice(&encoded[ihdr_end..]);
        png
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cutting-room-strip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn removes_novelai_text_chunks_and_hidden_alpha_data() {
        let img = RgbaImage::from_fn(32, 32, |x, y| Rgba([x as u8 * 8, y as u8 * 8, 77, 254 | ((x ^ y) & 1) as u8]));
        let path = temp_path("novelai.png");
        std::fs::write(&path, novelai_like_png(&img)).unwrap();
        assert!(chunk_types(&std::fs::read(&path).unwrap()).contains(&"tEXt".to_string()));

        strip_one(&path).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let types = chunk_types(&bytes);
        assert!(!types.iter().any(|t| matches!(t.as_str(), "tEXt" | "zTXt" | "iTXt")), "{types:?}");
        let out = image::load_from_memory(&bytes).unwrap();
        // The alpha channel, and the data hidden in it, is gone; the picture isn't.
        assert!(!out.color().has_alpha(), "{:?}", out.color());
        assert_eq!(out.dimensions(), (32, 32));
        for (x, y, p) in out.to_rgba8().enumerate_pixels() {
            assert_eq!(p.0[..3], img.get_pixel(x, y).0[..3]);
        }
    }

    #[test]
    fn keeps_real_transparency_but_clears_its_lowest_bit() {
        let img = RgbaImage::from_fn(16, 16, |x, y| Rgba([200, 100, 50, (x * 16 + y) as u8]));
        let path = temp_path("transparent.png");
        img.save(&path).unwrap();

        strip_one(&path).unwrap();

        let out = image::open(&path).unwrap();
        assert!(out.color().has_alpha());
        for (x, y, p) in out.to_rgba8().enumerate_pixels() {
            let before = img.get_pixel(x, y)[3];
            assert_eq!(p[3] & 1, 0, "lowest bit cleared");
            assert!(before - p[3] <= 1, "{before} -> {}", p[3]);
            assert_eq!(p.0[..3], [200, 100, 50]);
        }
    }

    #[test]
    fn scrubs_grey_alpha_images_too() {
        let opaque = image::GrayAlphaImage::from_pixel(4, 4, image::LumaA([90, 255]));
        assert!(!scrub_alpha(opaque.into()).color().has_alpha());
        let clear = image::GrayAlphaImage::from_pixel(4, 4, image::LumaA([90, 131]));
        assert_eq!(scrub_alpha(clear.into()).to_luma_alpha8().get_pixel(0, 0)[1], 130);
    }
}
