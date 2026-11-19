// Precise Reference: a reference image for a character's look, a style, or
// both (V4.5 only for now). NovelAI charges 5 Anlas per image for each
// reference, so it's never free: the frontend confirms the price first and
// the Anlas guard expects exactly that charge.
//
// The request fields follow NovelAI's web client:
//   director_reference_images                    padded PNGs, base64
//   director_reference_descriptions              {caption: {base_caption: type}}
//   director_reference_information_extracted    always 1
//   director_reference_strength_values           strength
//   director_reference_secondary_strength_values from fidelity
// UNVERIFIED until checked against a request captured from novelai.net: how
// fidelity maps to the secondary strength (`FIDELITY_INVERTED`).

use super::*;

/// Anlas NovelAI charges per reference, per image.
pub const PRECISE_REFERENCE_COST: i64 = 5;
/// At most this many references in one request (each one costs more).
pub const MAX_PRECISE_REFERENCES: usize = 4;
/// Whether the site sends `1 - fidelity` as the secondary strength.
pub const FIDELITY_INVERTED: bool = true;
pub const PRECISE_REFERENCE_VERIFIED: bool = false;

/// Models that take Precise Reference. V5 will get it later (NovelAI's
/// launch post); add it here when it does.
pub fn supports_precise_reference(model: &str) -> bool {
    model.starts_with("nai-diffusion-4-5")
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreciseReference {
    pub path: String,
    /// "character", "style" or "character&style".
    pub kind: String,
    pub strength: f64,
    pub fidelity: f64,
}

const KINDS: [&str; 3] = ["character", "style", "character&style"];

/// The size NovelAI sends a reference at, by its shape: portrait, landscape
/// or square, padded rather than cropped.
pub fn reference_canvas(width: u32, height: u32) -> (u32, u32) {
    let ratio = width as f64 / height.max(1) as f64;
    if ratio < 0.85 {
        (1024, 1536)
    } else if ratio > 1.18 {
        (1536, 1024)
    } else {
        (1472, 1472)
    }
}

/// The image at `path` scaled to fit its canvas, centred on black, as a PNG
/// (no metadata), base64.
pub(crate) fn reference_base64(path: &str) -> Result<String, String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("couldn't open the reference image ({path}): {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("couldn't open the reference image ({path}): {e}"))?
        .decode()
        .map_err(|e| format!("couldn't read the reference image ({path}): {e}"))?
        .to_rgb8();
    let (cw, ch) = reference_canvas(img.width(), img.height());
    let scale = (cw as f64 / img.width() as f64).min(ch as f64 / img.height() as f64);
    let (w, h) = (
        ((img.width() as f64 * scale).round() as u32).clamp(1, cw),
        ((img.height() as f64 * scale).round() as u32).clamp(1, ch),
    );
    let resized = image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3);
    let mut canvas = image::RgbImage::new(cw, ch);
    image::imageops::overlay(&mut canvas, &resized, ((cw - w) / 2) as i64, ((ch - h) / 2) as i64);
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't prepare the reference image: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Checks a request's references (model, count, values, no vibes alongside).
pub(crate) fn check_references(req: &GenerateRequest) -> Result<(), String> {
    let refs = &req.precise_references;
    if refs.is_empty() {
        return Ok(());
    }
    if !supports_precise_reference(&req.model) {
        return Err(format!("{} doesn't support Precise Reference yet.", model_family(&req.model)));
    }
    if refs.len() > MAX_PRECISE_REFERENCES {
        return Err(format!("At most {MAX_PRECISE_REFERENCES} Precise References at once."));
    }
    if !req.vibes.is_empty() {
        return Err("Precise Reference and Vibe Transfer can't be used together.".into());
    }
    for r in refs {
        if !KINDS.contains(&r.kind.as_str()) {
            return Err(format!("Unknown reference type: {}", r.kind));
        }
        if !(0.0..=1.0).contains(&r.strength) || !(0.0..=1.0).contains(&r.fidelity) {
            return Err("Reference strength and fidelity must be between 0 and 1.".into());
        }
    }
    Ok(())
}

/// Adds the references to a request body; `images` are lined up with them.
pub(crate) fn add_references(body: &mut serde_json::Value, refs: &[PreciseReference], images: &[String]) {
    if refs.is_empty() {
        return;
    }
    let p = &mut body["parameters"];
    p["director_reference_images"] = json!(images);
    p["director_reference_descriptions"] = json!(refs
        .iter()
        .map(|r| json!({ "caption": { "base_caption": r.kind, "char_captions": [] }, "legacy_uc": false }))
        .collect::<Vec<_>>());
    p["director_reference_information_extracted"] = json!(refs.iter().map(|_| 1).collect::<Vec<_>>());
    p["director_reference_strength_values"] = json!(refs.iter().map(|r| r.strength).collect::<Vec<_>>());
    p["director_reference_secondary_strength_values"] = json!(refs
        .iter()
        .map(|r| if FIDELITY_INVERTED { ((1.0 - r.fidelity) * 1000.0).round() / 1000.0 } else { r.fidelity })
        .collect::<Vec<_>>());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_canvas_by_shape() {
        assert_eq!(reference_canvas(832, 1216), (1024, 1536));
        assert_eq!(reference_canvas(1216, 832), (1536, 1024));
        assert_eq!(reference_canvas(1000, 1000), (1472, 1472));
    }

    #[test]
    fn checks_and_builds_references() {
        let mut r = GenerateRequest { model: "nai-diffusion-4-5-full".into(), ..Default::default() };
        r.precise_references = vec![PreciseReference { path: "x.png".into(), kind: "character".into(), strength: 1.0, fidelity: 0.75 }];
        assert!(check_references(&r).is_ok());
        let mut body = json!({ "parameters": {} });
        add_references(&mut body, &r.precise_references, &["AAAA".into()]);
        let p = &body["parameters"];
        assert_eq!(p["director_reference_images"][0], "AAAA");
        assert_eq!(p["director_reference_descriptions"][0]["caption"]["base_caption"], "character");
        assert_eq!(p["director_reference_information_extracted"][0], 1);
        assert_eq!(p["director_reference_secondary_strength_values"][0], 0.25);

        r.model = "nai-diffusion-5-full".into();
        assert!(check_references(&r).is_err());
        r.model = "nai-diffusion-4-5-curated".into();
        r.precise_references[0].kind = "face".into();
        assert!(check_references(&r).is_err());
    }

    #[test]
    fn costs_five_per_reference_and_the_guard_expects_it() {
        let mut r = GenerateRequest { model: "nai-diffusion-4-5-full".into(), width: 1024, height: 1024, steps: 28, ..Default::default() };
        r.precise_references = vec![
            PreciseReference { path: "a.png".into(), kind: "character".into(), strength: 1.0, fidelity: 1.0 },
            PreciseReference { path: "b.png".into(), kind: "style".into(), strength: 1.0, fidelity: 1.0 },
        ];
        assert_eq!(known_charge(&r), 10);
        let e = estimate_cost(&r, None);
        assert!(!e.free);
        assert_eq!(e.anlas, Some(10));
    }
}
