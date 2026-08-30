use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageEncoder, ImageFormat};
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

// Decoding and re-encoding a photo naturally drops whatever metadata it
// carried — the `image` crate's encoders only include EXIF/ICC data when a
// caller explicitly attaches it, which nothing here does. JPEGs are routed
// through the encoder directly at a high quality instead of the plain
// `save()` default (75), since this operation is meant to remove metadata,
// not visibly recompress people's photos.
fn strip_one(path: &Path) -> Result<(), String> {
    let img = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
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
