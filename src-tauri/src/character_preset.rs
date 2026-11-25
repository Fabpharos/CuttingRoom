//! Character cards: NovelAI character prompt presets, each saved as a small
//! PNG (the image it was made from, at full size) in a folder the user
//! picks. The card itself is JSON, base64-encoded, in a `cutting-room-character`
//! tEXt chunk. The frontend owns the card's fields; Rust only checks that it's
//! a JSON object and stores it.
//!
//! Cards can be sorted into subfolders of the card folder (up to
//! `MAX_DEPTH` deep). The library's own folders (`LIBRARY_DIRS`) and hidden
//! ones are never card folders. Moving a card never overwrites another, and
//! only an empty folder can be removed.

use crate::novelai;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;
use std::io::Cursor;
use std::path::{Path, PathBuf};

pub const CARD_KEY: &str = "cutting-room-character";
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

/// Folders in the card folder that belong to the library, not to cards.
const LIBRARY_DIRS: [&str; 4] = ["prompts", "plans", "artists", "vibes"];
/// How deep card subfolders go.
const MAX_DEPTH: usize = 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFile {
    pub path: String,
    pub card: Value,
    /// The subfolder it's in, relative to the card folder ("" for the card
    /// folder itself, "Outfits/Summer" for a nested one).
    pub folder: String,
}

/// The subfolders of `dir` that can hold cards, with their relative paths.
fn card_subfolders(dir: &Path, rel: &str, depth: usize) -> Vec<(PathBuf, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if name.starts_with('.') || (depth == 0 && LIBRARY_DIRS.iter().any(|l| l.eq_ignore_ascii_case(&name))) {
            continue;
        }
        let sub = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        if depth + 1 < MAX_DEPTH {
            out.extend(card_subfolders(&path, &sub, depth + 1));
        }
        out.push((path, sub));
    }
    out
}

/// Every card in `folder` and its card subfolders. PNGs without a card are skipped.
pub fn list(folder: &str) -> Result<Vec<CardFile>, String> {
    let root = Path::new(folder);
    if !root.is_dir() {
        return Err("couldn't read the card folder: it doesn't exist".into());
    }
    let mut dirs = vec![(root.to_path_buf(), String::new())];
    dirs.extend(card_subfolders(root, "", 0));
    let mut cards = Vec::new();
    for (dir, rel) in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_png = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("png"));
            if !is_png || !path.is_file() {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if let Some(card) = read_card(&bytes) {
                cards.push(CardFile { path: path.to_string_lossy().into_owned(), card, folder: rel.clone() });
            }
        }
    }
    Ok(cards)
}

/// Every card subfolder of `folder` (empty ones too), as relative paths.
pub fn list_folders(folder: &str) -> Result<Vec<String>, String> {
    let root = Path::new(folder);
    if !root.is_dir() {
        return Err("couldn't read the card folder: it doesn't exist".into());
    }
    let mut out: Vec<String> = card_subfolders(root, "", 0).into_iter().map(|(_, rel)| rel).collect();
    out.sort_by_key(|r| r.to_lowercase());
    Ok(out)
}

/// The directory for a relative card subfolder ("" is the card folder),
/// after checking every part of it.
fn subfolder_path(folder: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(folder);
    if !root.is_dir() {
        return Err("The card folder doesn't exist any more. Choose it again.".into());
    }
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > MAX_DEPTH {
        return Err(format!("Folders can be at most {MAX_DEPTH} deep."));
    }
    let mut path = root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        let name = check_name(part).map_err(|e| e.replace("Card names", "Folder names").replace("the card", "the folder"))?;
        if name != *part || name.starts_with('.') {
            return Err(format!("\"{part}\" isn't a usable folder name."));
        }
        if i == 0 && LIBRARY_DIRS.iter().any(|l| l.eq_ignore_ascii_case(name)) {
            return Err(format!("\"{name}\" is used by the library; pick another name."));
        }
        path.push(name);
    }
    Ok(path)
}

/// Makes the card subfolder `rel` (and any missing parents).
pub fn create_folder(folder: &str, rel: &str) -> Result<(), String> {
    let path = subfolder_path(folder, rel)?;
    if rel.trim_matches('/').is_empty() {
        return Err("Give the folder a name.".into());
    }
    if path.exists() {
        return Err(format!("A folder named \"{rel}\" already exists."));
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("couldn't make the folder: {e}"))
}

/// Renames the card subfolder `from` to `to` (both relative). Refuses to
/// replace an existing folder.
pub fn rename_folder(folder: &str, from: &str, to: &str) -> Result<(), String> {
    let src = subfolder_path(folder, from)?;
    let dest = subfolder_path(folder, to)?;
    if from.trim_matches('/').is_empty() || to.trim_matches('/').is_empty() {
        return Err("The card folder itself can't be renamed here.".into());
    }
    if !src.is_dir() {
        return Err(format!("\"{from}\" doesn't exist any more."));
    }
    if dest.exists() && src.to_string_lossy().to_lowercase() != dest.to_string_lossy().to_lowercase() {
        return Err(format!("A folder named \"{to}\" already exists."));
    }
    if dest.starts_with(&src) && dest != src {
        return Err("A folder can't be moved inside itself.".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't rename the folder: {e}"))?;
    }
    std::fs::rename(&src, &dest).map_err(|e| format!("couldn't rename the folder: {e}"))
}

/// Removes the card subfolder `rel`, only when it's empty.
pub fn remove_folder(folder: &str, rel: &str) -> Result<(), String> {
    if rel.trim_matches('/').is_empty() {
        return Err("The card folder itself can't be removed here.".into());
    }
    let path = subfolder_path(folder, rel)?;
    let empty = std::fs::read_dir(&path).map_err(|e| format!("couldn't read the folder: {e}"))?.next().is_none();
    if !empty {
        return Err("Only an empty folder can be removed. Move its cards out first.".into());
    }
    std::fs::remove_dir(&path).map_err(|e| format!("couldn't remove the folder: {e}"))
}

/// Moves the card at `card` into the card subfolder `to`. Returns its new
/// path. The card must be in the card folder, and nothing is overwritten.
pub fn move_card(folder: &str, card: &str, to: &str) -> Result<String, String> {
    let root = std::fs::canonicalize(folder).map_err(|_| "The card folder doesn't exist any more.".to_string())?;
    let src = std::fs::canonicalize(card).map_err(|_| "That card doesn't exist any more.".to_string())?;
    if !src.starts_with(&root) || src.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) != Some("png".into()) {
        return Err("That isn't a card in the card folder.".into());
    }
    let bytes = std::fs::read(&src).map_err(|e| format!("couldn't read the card: {e}"))?;
    if read_card(&bytes).is_none() {
        return Err("That file isn't a character card.".into());
    }
    let dir = subfolder_path(folder, to)?;
    if !dir.is_dir() {
        return Err(format!("The folder \"{to}\" doesn't exist."));
    }
    let dest = dir.join(src.file_name().ok_or("The card has no file name.")?);
    if dest.exists() {
        let same = std::fs::canonicalize(&dest).map(|d| d == src).unwrap_or(false);
        if same {
            return Ok(dest.to_string_lossy().into_owned());
        }
        return Err(format!("A card with that name is already in \"{}\".", if to.is_empty() { "the card folder" } else { to }));
    }
    std::fs::rename(&src, &dest).map_err(|e| format!("couldn't move the card: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

fn read_card(png: &[u8]) -> Option<Value> {
    let chunks = novelai::png_text_chunks(png).ok()?;
    let (_, text) = chunks.iter().find(|(k, _)| k == CARD_KEY)?;
    let card: Value = serde_json::from_slice(&STANDARD.decode(text.trim()).ok()?).ok()?;
    card.is_object().then_some(card)
}

/// Saves `card` as `<name>.png` in `folder` and returns its path.
///
/// A new card takes its picture from `image` at full size, re-encoded as a
/// PNG (so none of the image's metadata comes along), so the card itself can
/// be a Precise Reference. An edited card passes its current file as
/// `existing`: its picture is kept unless `image` replaces it, and the file
/// is renamed when the name changed. Never overwrites a different card.
pub fn save(
    folder: &str,
    name: &str,
    card: Value,
    image: Option<&str>,
    existing: Option<&str>,
) -> Result<String, String> {
    if !card.is_object() {
        return Err("The card isn't a JSON object.".into());
    }
    let name = check_name(name)?;
    let folder = Path::new(folder);
    if !folder.is_dir() {
        return Err("The card folder doesn't exist any more. Choose it again.".into());
    }
    let dest = folder.join(format!("{name}.png"));
    let existing = existing.map(PathBuf::from);
    let same_file = |a: &Path, b: &Path| a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase();
    let renaming_onto_itself = existing.as_deref().is_some_and(|e| same_file(e, &dest));
    if dest.exists() && !renaming_onto_itself {
        return Err(format!("A card named \"{name}\" already exists in this folder."));
    }

    let png = match (image, existing.as_deref()) {
        (Some(image), _) => picture_png(image)?,
        (None, Some(existing)) => std::fs::read(existing).map_err(|e| format!("couldn't read the card: {e}"))?,
        (None, None) => return Err("A new card needs an image.".into()),
    };
    let out = with_card(&png, &card)?;

    // Write next to the target and rename into place, so a failed write
    // never leaves a half-written card.
    let target = existing.clone().unwrap_or_else(|| dest.clone());
    let tmp = folder.join(format!(".{name}.png.tmp"));
    std::fs::write(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("couldn't save the card: {e}")
    })?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("couldn't save the card: {e}")
    })?;
    if existing.is_some() && target != dest {
        std::fs::rename(&target, &dest).map_err(|e| format!("Saved, but couldn't rename the card to \"{name}\": {e}"))?;
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// The trimmed name, if Windows accepts it as a file name.
fn check_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the card a name.".into());
    }
    if name.chars().count() > 100 {
        return Err("Card names can be at most 100 characters.".into());
    }
    if let Some(c) = name.chars().find(|c| r#"<>:"/\|?*"#.contains(*c) || c.is_control()) {
        return Err(format!("Card names can't contain \"{c}\"."));
    }
    if name.ends_with('.') {
        return Err("Card names can't end with a full stop.".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("Windows doesn't allow \"{name}\" as a file name."));
    }
    Ok(name)
}

/// The image at full size as a plain PNG (no metadata).
fn picture_png(path: &str) -> Result<Vec<u8>, String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("couldn't open the image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("couldn't open the image: {e}"))?
        .decode()
        .map_err(|e| format!("couldn't read the image: {e}"))?;
    let img = if img.color().has_alpha() {
        image::DynamicImage::ImageRgba8(img.to_rgba8())
    } else {
        image::DynamicImage::ImageRgb8(img.to_rgb8())
    };
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't save the picture: {e}"))?;
    Ok(out)
}

/// The PNG with any old card chunk removed and the new one added just before
/// IEND; every other chunk is copied unchanged.
fn with_card(png: &[u8], card: &Value) -> Result<Vec<u8>, String> {
    if !png.starts_with(&PNG_SIGNATURE) {
        return Err("The card file isn't a PNG.".into());
    }
    let text = STANDARD.encode(serde_json::to_vec(card).map_err(|e| e.to_string())?);
    let mut out = PNG_SIGNATURE.to_vec();
    let mut pos = 8;
    loop {
        if pos + 12 > png.len() {
            return Err("The card's PNG is damaged (it ends early).".into());
        }
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        let end = pos + 12 + len;
        if end > png.len() {
            return Err("The card's PNG is damaged (a chunk runs past the end).".into());
        }
        let kind = &png[pos + 4..pos + 8];
        let body = &png[pos + 8..pos + 8 + len];
        if kind == b"IEND" {
            out.extend(chunk(b"tEXt", &[CARD_KEY.as_bytes(), &[0], text.as_bytes()].concat()));
            out.extend_from_slice(&png[pos..end]);
            return Ok(out);
        }
        let is_card = matches!(kind, b"tEXt" | b"zTXt" | b"iTXt")
            && body.iter().position(|&b| b == 0).is_some_and(|k| &body[..k] == CARD_KEY.as_bytes());
        if !is_card {
            out.extend_from_slice(&png[pos..end]);
        }
        pos = end;
    }
}

fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut c = Vec::with_capacity(body.len() + 12);
    c.extend_from_slice(&(body.len() as u32).to_be_bytes());
    c.extend_from_slice(kind);
    c.extend_from_slice(body);
    c.extend_from_slice(&crc32(&[kind.as_slice(), body].concat()).to_be_bytes());
    c
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cutting-room-cards-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_image(dir: &Path, w: u32, h: u32) -> String {
        let path = dir.join("source.png");
        image::RgbImage::from_pixel(w, h, image::Rgb([200, 100, 50])).save(&path).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn saves_lists_and_renames_cards() {
        let dir = temp_dir("roundtrip");
        let folder = dir.to_str().unwrap();
        let image = write_image(&dir, 1216, 832);
        let card = json!({ "name": "Sparkle", "tags": [{ "text": "red eyes", "part": "eyes" }] });

        let path = save(folder, "Sparkle", card.clone(), Some(&image), None).unwrap();
        assert!(path.ends_with("Sparkle.png"));
        // Full size, so the card can be a Precise Reference itself.
        let picture = image::open(&path).unwrap();
        assert_eq!((picture.width(), picture.height()), (1216, 832));

        // Only cards are listed; the source image has no card.
        let cards = list(folder).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].card, card);

        // Same name again is refused; editing in place and renaming work.
        assert!(save(folder, "Sparkle", card.clone(), Some(&image), None).is_err());
        let edited = json!({ "name": "Sparkle 2", "tags": [] });
        let renamed = save(folder, "Sparkle 2", edited.clone(), None, Some(&path)).unwrap();
        assert!(!Path::new(&path).exists());
        let cards = list(folder).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].path, renamed);
        assert_eq!(cards[0].card, edited);
        assert_eq!(image::open(&renamed).unwrap().width(), 1216);

        // A new picture replaces the old one and keeps the card.
        let bigger = dir.join("bigger.png");
        image::RgbImage::from_pixel(832, 1216, image::Rgb([1, 2, 3])).save(&bigger).unwrap();
        let replaced = save(folder, "Sparkle 2", edited.clone(), Some(bigger.to_str().unwrap()), Some(&renamed)).unwrap();
        assert_eq!(replaced, renamed);
        assert_eq!(image::open(&replaced).unwrap().width(), 832);
        assert_eq!(list(folder).unwrap()[0].card, edited);

        // Renaming onto another card is refused.
        save(folder, "Other", card.clone(), Some(&image), None).unwrap();
        assert!(save(folder, "Other", edited, None, Some(&renamed)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sorts_cards_into_folders() {
        let dir = temp_dir("folders");
        let folder = dir.to_str().unwrap();
        let image = write_image(&dir, 300, 300);
        let card = json!({ "name": "Mika", "tags": [] });
        let path = save(folder, "Mika", card.clone(), Some(&image), None).unwrap();

        create_folder(folder, "Outfits/Summer").unwrap();
        assert!(create_folder(folder, "Outfits/Summer").is_err(), "already exists");
        assert!(create_folder(folder, "prompts").is_err(), "library folder");
        assert!(create_folder(folder, "a/../b").is_err());
        assert!(create_folder(folder, "bad:name").is_err());
        std::fs::create_dir_all(dir.join("plans")).unwrap();
        assert_eq!(list_folders(folder).unwrap(), vec!["Outfits", "Outfits/Summer"]);

        // Moving a card, and never onto another.
        let moved = move_card(folder, &path, "Outfits/Summer").unwrap();
        assert!(Path::new(&moved).exists() && !Path::new(&path).exists());
        let cards = list(folder).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].folder, "Outfits/Summer");
        save(folder, "Mika", card, Some(&image), None).unwrap();
        assert!(move_card(folder, &moved, "").is_err(), "a Mika is already there");
        assert!(move_card(folder, &image, "Outfits").is_err(), "not a card");

        // Only empty folders go; renaming keeps the cards.
        assert!(remove_folder(folder, "Outfits/Summer").is_err());
        rename_folder(folder, "Outfits", "Clothes").unwrap();
        assert!(list(folder).unwrap().iter().any(|c| c.folder == "Clothes/Summer"));
        create_folder(folder, "Empty").unwrap();
        remove_folder(folder, "Empty").unwrap();
        assert!(!dir.join("Empty").exists());
        assert!(remove_folder(folder, "").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_images_keep_their_size() {
        let dir = temp_dir("small");
        let image = write_image(&dir, 200, 300);
        let path = save(dir.to_str().unwrap(), "Small", json!({}), Some(&image), None).unwrap();
        let thumb = image::open(&path).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (200, 300));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_bad_names() {
        for bad in ["", "  ", "a/b", "a:b", "what?", "dot.", "CON", "com1", "LPT9.txt"] {
            assert!(check_name(bad).is_err(), "{bad:?} should be refused");
        }
        for good in ["Sparkle", "Sparkle (Honkai: Star Rail)".replace(':', "").as_str(), "Con Artist", "COM10"] {
            assert!(check_name(good).is_ok(), "{good:?} should be allowed");
        }
    }
}
