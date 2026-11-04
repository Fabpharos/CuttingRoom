//! Character cards (SillyTavern / Tavern format) stored in PNG images: the
//! card's JSON, base64-encoded, in a `chara` text chunk (spec V2) and a
//! `ccv3` chunk (spec V3). Reading prefers `ccv3`; writing stores the same
//! card data under both, as SillyTavern does.
//!
//! Writing a PNG copies every other chunk byte for byte, so AI generation
//! metadata in it is kept. Other image types are re-encoded as PNG, which
//! loses whatever metadata they had.

use base64::{engine::general_purpose::STANDARD, Engine};
use crate::novelai;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::Path;

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
const CARD_KEYS: [&str; 2] = ["chara", "ccv3"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    /// The card's `data` object, or null when the image has no card.
    pub data: Option<Value>,
    /// "chara_card_v3", "chara_card_v2", or "v1" for a card without a spec.
    pub spec: Option<String>,
    /// AI generation metadata found in the image, e.g. "NovelAI".
    pub ai_metadata: Vec<String>,
    pub is_png: bool,
}

pub fn read(path: &str) -> Result<CardInfo, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("couldn't read the image: {e}"))?;
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Ok(CardInfo { data: None, spec: None, ai_metadata: Vec::new(), is_png: false });
    }
    let chunks = novelai::png_text_chunks(&bytes)?;
    let card = ["ccv3", "chara"].iter().find_map(|key| {
        let (_, text) = chunks.iter().find(|(k, _)| k == key)?;
        parse_card(text)
    });
    let (spec, data) = match card {
        Some((spec, data)) => (Some(spec), Some(data)),
        None => (None, None),
    };
    Ok(CardInfo { data, spec, ai_metadata: ai_metadata(&chunks), is_png: true })
}

/// The spec name and `data` object of a base64 card chunk.
fn parse_card(text: &str) -> Option<(String, Value)> {
    let decoded = STANDARD.decode(text.trim()).ok()?;
    let card: Value = serde_json::from_slice(&decoded).ok()?;
    match card.get("spec").and_then(Value::as_str) {
        Some(spec) => Some((spec.to_string(), card.get("data")?.clone())),
        // V1 cards are the bare fields.
        None if card.get("name").is_some() => Some(("v1".into(), card)),
        None => None,
    }
}

fn ai_metadata(chunks: &[(String, String)]) -> Vec<String> {
    let has = |key: &str| chunks.iter().any(|(k, _)| k == key);
    let mut found = Vec::new();
    if novelai::parse_settings(chunks).is_ok() {
        found.push("NovelAI".to_string());
    }
    if has("prompt") || has("workflow") {
        found.push("ComfyUI".to_string());
    }
    if has("parameters") {
        found.push("Stable Diffusion WebUI (A1111 / Forge)".to_string());
    }
    found
}

/// Writes `source` to `dest` as a PNG with `data` as its character card.
/// `dest` may be `source` itself; it is replaced only once the new file is
/// fully written.
pub fn write(source: &str, dest: &str, data: Value) -> Result<(), String> {
    if !dest.to_lowercase().ends_with(".png") {
        return Err("Character cards can only be saved as PNG images.".into());
    }
    let Value::Object(data) = data else {
        return Err("The card data isn't an object.".into());
    };
    let bytes = std::fs::read(source).map_err(|e| format!("couldn't read the image: {e}"))?;
    let png = if bytes.starts_with(&PNG_SIGNATURE) {
        bytes
    } else {
        let img = image::load_from_memory(&bytes).map_err(|e| format!("couldn't read the image: {e}"))?;
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| format!("couldn't convert the image to PNG: {e}"))?;
        out.into_inner()
    };
    let with_card = replace_card(&png, &data)?;

    let tmp = format!("{dest}.cutting-room-tmp");
    std::fs::write(&tmp, &with_card).map_err(|e| format!("couldn't write the image: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("couldn't save the image: {e}")
    })
}

/// The PNG with any old card chunks removed and the new ones added just
/// before IEND; every other chunk is copied unchanged.
fn replace_card(png: &[u8], data: &Map<String, Value>) -> Result<Vec<u8>, String> {
    let v2 = json!({ "spec": "chara_card_v2", "spec_version": "2.0", "data": data });
    let mut v3_data = data.clone();
    v3_data.entry("group_only_greetings").or_insert_with(|| json!([]));
    let v3 = json!({ "spec": "chara_card_v3", "spec_version": "3.0", "data": v3_data });

    let mut out = PNG_SIGNATURE.to_vec();
    let mut pos = 8;
    loop {
        if pos + 12 > png.len() {
            return Err("The PNG is damaged (it ends early).".into());
        }
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        let end = pos + 12 + len;
        if end > png.len() {
            return Err("The PNG is damaged (a chunk runs past the end).".into());
        }
        let kind = &png[pos + 4..pos + 8];
        let body = &png[pos + 8..pos + 8 + len];
        if kind == b"IEND" {
            for (key, card) in [("chara", &v2), ("ccv3", &v3)] {
                let text = STANDARD.encode(serde_json::to_vec(card).map_err(|e| e.to_string())?);
                out.extend(chunk(b"tEXt", &[key.as_bytes(), &[0], text.as_bytes()].concat()));
            }
            out.extend_from_slice(&png[pos..end]);
            return Ok(out);
        }
        let is_card = matches!(kind, b"tEXt" | b"zTXt" | b"iTXt")
            && body
                .iter()
                .position(|&b| b == 0)
                .is_some_and(|k| CARD_KEYS.iter().any(|c| c.as_bytes() == &body[..k]));
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

/// A sibling path that doesn't exist yet: `name_card.png`, `name_card-2.png`, …
pub fn suggest_output(source: &str) -> String {
    let p = Path::new(source);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("card");
    let dir = p.parent().unwrap_or(Path::new(""));
    let mut n = 1;
    loop {
        let name = if n == 1 { format!("{stem}_card.png") } else { format!("{stem}_card-{n}.png") };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("cutting-room-card-{}-{name}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    fn png_with_text(chunks: &[(&str, &str)]) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([10, 20, 30, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img).write_to(&mut out, image::ImageFormat::Png).unwrap();
        let png = out.into_inner();
        let iend = png.len() - 12;
        let mut with = png[..iend].to_vec();
        for (k, v) in chunks {
            with.extend(chunk(b"tEXt", &[k.as_bytes(), &[0], v.as_bytes()].concat()));
        }
        with.extend_from_slice(&png[iend..]);
        with
    }

    #[test]
    fn writes_a_card_and_keeps_other_metadata() {
        let old = STANDARD.encode(r#"{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Old"}}"#);
        let src = temp_path("src.png");
        std::fs::write(&src, png_with_text(&[("parameters", "1girl, Steps: 20"), ("chara", &old)])).unwrap();

        let before = read(&src).unwrap();
        assert_eq!(before.spec.as_deref(), Some("chara_card_v2"));
        assert_eq!(before.data.unwrap()["name"], "Old");
        assert_eq!(before.ai_metadata, vec!["Stable Diffusion WebUI (A1111 / Forge)".to_string()]);

        write(&src, &src, json!({ "name": "New", "extensions": { "fav": true } })).unwrap();
        let after = read(&src).unwrap();
        assert_eq!(after.spec.as_deref(), Some("chara_card_v3"));
        let data = after.data.unwrap();
        assert_eq!(data["name"], "New");
        assert_eq!(data["extensions"]["fav"], true);
        assert_eq!(data["group_only_greetings"], json!([]));
        assert_eq!(after.ai_metadata.len(), 1, "the A1111 parameters chunk is kept");

        let chunks = novelai::png_text_chunks(&std::fs::read(&src).unwrap()).unwrap();
        let keys: Vec<&str> = chunks.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["parameters", "chara", "ccv3"], "one card of each version");
        assert!(image::open(&src).is_ok(), "still a valid PNG");
        std::fs::remove_file(&src).unwrap();
    }

    #[test]
    fn reads_v1_cards_and_images_without_one() {
        let v1 = STANDARD.encode(r#"{"name":"Plain","description":"d"}"#);
        let src = temp_path("v1.png");
        std::fs::write(&src, png_with_text(&[("chara", &v1)])).unwrap();
        let info = read(&src).unwrap();
        assert_eq!(info.spec.as_deref(), Some("v1"));
        assert_eq!(info.data.unwrap()["description"], "d");

        std::fs::write(&src, png_with_text(&[])).unwrap();
        let none = read(&src).unwrap();
        assert!(none.data.is_none() && none.ai_metadata.is_empty() && none.is_png);
        std::fs::remove_file(&src).unwrap();
    }

    #[test]
    fn refuses_non_png_destinations() {
        assert!(write("x.png", "x.jpg", json!({})).is_err());
    }
}
