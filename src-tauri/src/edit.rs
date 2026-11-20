// Saving an image edited in the Edit tab. The webview does the editing on a
// canvas and sends the encoded file; this only decides where it goes:
// a new "<name>_edited" file next to the original (never overwriting
// anything), or the original's own name after the original has gone to the
// Recycle Bin, so an overwrite can always be undone from there.

use std::path::{Path, PathBuf};

const SAVE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

fn extension(path: &Path) -> Option<String> {
    path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase())
}

/// The original must be an existing image file given by an absolute path.
fn check_original(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("The image path must be absolute.".into());
    }
    if !path.is_file() {
        return Err(format!("{} no longer exists.", path.display()));
    }
    Ok(())
}

/// `<stem>_edited.<ext>` next to the original, or `_edited 2`, `_edited 3` …
/// if that's taken.
pub fn copy_path(original: &Path, ext: &str) -> Result<PathBuf, String> {
    let dir = original.parent().ok_or("The image has no folder.")?;
    let stem = original.file_stem().and_then(|s| s.to_str()).ok_or("The file name isn't readable.")?;
    for n in 1..10_000 {
        let name = if n == 1 { format!("{stem}_edited.{ext}") } else { format!("{stem}_edited {n}.{ext}") };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Couldn't find a free file name.".into())
}

/// Saves `bytes` (an image encoded as `ext`) for `original`. Returns the
/// path written.
pub fn save(original: &Path, ext: &str, overwrite: bool, bytes: &[u8]) -> Result<PathBuf, String> {
    check_original(original)?;
    let ext = ext.to_ascii_lowercase();
    if !SAVE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("Can't save as .{ext}."));
    }
    if bytes.is_empty() {
        return Err("The edited image is empty.".into());
    }
    // Make sure what's written really is an image before anything is moved.
    image::load_from_memory(bytes).map_err(|e| format!("The edited image isn't readable: {e}"))?;

    if overwrite {
        if extension(original).as_deref() != Some(ext.as_str()) {
            return Err("An overwrite has to keep the file's format.".into());
        }
        trash::delete(original).map_err(|e| format!("Couldn't move the original to the Recycle Bin: {e}"))?;
        std::fs::write(original, bytes).map_err(|e| {
            format!("The original is in the Recycle Bin, but the edit couldn't be written: {e}")
        })?;
        Ok(original.to_path_buf())
    } else {
        let dest = copy_path(original, &ext)?;
        // create_new: never replace a file that appeared in the meantime.
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
            .map_err(|e| format!("Couldn't create {}: {e}", dest.display()))?;
        f.write_all(bytes).map_err(|e| format!("Couldn't write {}: {e}", dest.display()))?;
        Ok(dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([10, 20, 30, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cutting-room-edit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_never_overwrite() {
        let dir = temp_dir("copy");
        let original = dir.join("photo.png");
        std::fs::write(&original, png_bytes()).unwrap();
        let first = save(&original, "png", false, &png_bytes()).unwrap();
        assert_eq!(first.file_name().unwrap(), "photo_edited.png");
        let second = save(&original, "png", false, &png_bytes()).unwrap();
        assert_eq!(second.file_name().unwrap(), "photo_edited 2.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_bad_input() {
        let dir = temp_dir("bad");
        let original = dir.join("photo.png");
        std::fs::write(&original, png_bytes()).unwrap();
        assert!(save(&original, "exe", false, &png_bytes()).is_err());
        assert!(save(&original, "png", false, b"not an image").is_err());
        assert!(save(&original, "jpg", true, &png_bytes()).is_err());
        assert!(save(Path::new("relative.png"), "png", false, &png_bytes()).is_err());
        assert!(save(&dir.join("missing.png"), "png", false, &png_bytes()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
