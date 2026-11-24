// Precise Reference: a reference image for a character's look, a style, or
// both, and on V5 an outfit too. NovelAI charges 5 Anlas per image for each
// reference on V4.5 and V5 alike, so it's never free: the frontend confirms
// the price first and the Anlas guard expects exactly that charge.
//
// The request fields follow NovelAI's web client:
//   director_reference_images                    padded PNGs, base64
//   director_reference_descriptions              {caption: {base_caption: type}}
//   director_reference_information_extracted    always 1
//   director_reference_strengths                 strength
//   director_reference_secondary_strengths       from fidelity
// The names and the description's shape are checked against an image made on
// novelai.net, which records them in its metadata. NovelAI's API spec names
// the strengths `…_strength_values`, so both spellings are sent. The
// secondary strength is 1 - fidelity: a sample made at strength 0.8 and
// fidelity 0.3 records 0.8 and 0.7.
//
// V5 (NovelAI's release post, 2026-11-24): Character, Style and Outfit
// references in any combination, strength up to 5, no fidelity slider, and a
// "Prefer same outfit" switch on Character and Character & Style references.
// Checked against V5 samples made on novelai.net (2026-11-24): the same
// fields as V4.5; an outfit reference's caption is "costume"; Character,
// Style and "character&style" captions are as on V4.5; every secondary
// strength is 0; a strength of 1.2 is recorded as 1.2; a Character reference
// with "Prefer same outfit" is "character_mainoutfit". A Character & Style
// reference made with "Prefer same outfit" ticked is recorded as plain
// "character&style", so the switch changes nothing there and the app only
// offers it on Character references.

use super::*;

/// Anlas NovelAI charges per reference, per image.
pub const PRECISE_REFERENCE_COST: i64 = 5;
/// At most this many references in one request (each one costs more).
pub const MAX_PRECISE_REFERENCES: usize = 6;
/// Whether the site sends `1 - fidelity` as the secondary strength.
pub const FIDELITY_INVERTED: bool = true;
pub const PRECISE_REFERENCE_VERIFIED: bool = true;
/// The secondary strength V5 is sent (no fidelity slider): 0, as recorded in
/// V5 samples.
pub const V5_SECONDARY_STRENGTH: f64 = 0.0;

/// Models that take Precise Reference: V4.5 and V5 (not inpainting models).
pub fn supports_precise_reference(model: &str) -> bool {
    (model.starts_with("nai-diffusion-4-5") || model.starts_with("nai-diffusion-5")) && !model.contains("inpainting")
}

fn is_v5(model: &str) -> bool {
    model.starts_with("nai-diffusion-5")
}

/// The reference types a model takes.
pub fn reference_kinds(model: &str) -> &'static [&'static str] {
    if is_v5(model) {
        &["character", "style", "outfit", "character&style"]
    } else {
        &["character", "style", "character&style"]
    }
}

/// The highest strength a model takes: 1 on V4.5, 5 on V5.
pub fn max_reference_strength(model: &str) -> f64 {
    if is_v5(model) {
        5.0
    } else {
        1.0
    }
}

/// The base caption V5 is sent for a reference, as V5 samples record them:
/// an outfit reference is "costume", and a Character reference with "Prefer
/// same outfit" is "character_mainoutfit". Other types ignore the switch (a
/// Character & Style sample made with it ticked records "character&style").
pub fn v5_caption(kind: &str, prefer_same_outfit: bool) -> String {
    match kind {
        "outfit" => "costume".into(),
        "character" if prefer_same_outfit => "character_mainoutfit".into(),
        _ => kind.to_string(),
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreciseReference {
    pub path: String,
    /// "character", "style" or "character&style".
    pub kind: String,
    pub strength: f64,
    /// V4.5 only; V5 has no fidelity.
    pub fidelity: f64,
    /// V5: follow the reference character's outfit more closely (Character
    /// and Character & Style references).
    #[serde(default)]
    pub prefer_same_outfit: bool,
}

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
    let max = max_reference_strength(&req.model);
    for r in refs {
        if !reference_kinds(&req.model).contains(&r.kind.as_str()) {
            return Err(format!("{} doesn't take a reference of type \"{}\".", model_family(&req.model), r.kind));
        }
        if !(0.0..=max).contains(&r.strength) {
            return Err(format!("Reference strength must be between 0 and {max} on {}.", model_family(&req.model)));
        }
        if !(0.0..=1.0).contains(&r.fidelity) {
            return Err("Reference fidelity must be between 0 and 1.".into());
        }
    }
    Ok(())
}

/// Adds the references to a request body; `images` are lined up with them.
pub(crate) fn add_references(body: &mut serde_json::Value, model: &str, refs: &[PreciseReference], images: &[String]) {
    if refs.is_empty() {
        return;
    }
    let v5 = is_v5(model);
    let p = &mut body["parameters"];
    p["director_reference_images"] = json!(images);
    p["director_reference_descriptions"] = json!(refs
        .iter()
        .map(|r| {
            json!({
                "caption": {
                    "base_caption": if v5 { v5_caption(&r.kind, r.prefer_same_outfit) } else { r.kind.clone() },
                    "char_captions": []
                },
                "use_coords": false,
                "use_order": false,
                "legacy_uc": false
            })
        })
        .collect::<Vec<_>>());
    p["director_reference_information_extracted"] = json!(refs.iter().map(|_| 1).collect::<Vec<_>>());
    let strengths = json!(refs.iter().map(|r| r.strength).collect::<Vec<_>>());
    let secondary = json!(refs
        .iter()
        .map(|r| {
            if v5 {
                V5_SECONDARY_STRENGTH
            } else if FIDELITY_INVERTED {
                ((1.0 - r.fidelity) * 1000.0).round() / 1000.0
            } else {
                r.fidelity
            }
        })
        .collect::<Vec<_>>());
    p["director_reference_strengths"] = strengths.clone();
    p["director_reference_secondary_strengths"] = secondary.clone();
    p["director_reference_strength_values"] = strengths;
    p["director_reference_secondary_strength_values"] = secondary;
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
        r.precise_references = vec![PreciseReference {
            path: "x.png".into(),
            kind: "character".into(),
            strength: 1.0,
            fidelity: 0.75,
            prefer_same_outfit: false,
        }];
        assert!(check_references(&r).is_ok());
        let mut body = json!({ "parameters": {} });
        add_references(&mut body, &r.model, &r.precise_references, &["AAAA".into()]);
        let p = &body["parameters"];
        assert_eq!(p["director_reference_images"][0], "AAAA");
        assert_eq!(p["director_reference_descriptions"][0]["caption"]["base_caption"], "character");
        assert_eq!(p["director_reference_information_extracted"][0], 1);
        assert_eq!(p["director_reference_secondary_strengths"][0], 0.25);
        assert_eq!(p["director_reference_strengths"][0], 1.0);
        assert_eq!(p["director_reference_descriptions"][0]["use_coords"], false);
        assert_eq!(p["director_reference_descriptions"][0]["use_order"], false);

        r.model = "nai-diffusion-4-5-curated".into();
        r.precise_references[0].kind = "face".into();
        assert!(check_references(&r).is_err());
        // No outfit references and no strength above 1 on V4.5.
        r.precise_references[0].kind = "outfit".into();
        assert!(check_references(&r).is_err());
        r.precise_references[0].kind = "style".into();
        r.precise_references[0].strength = 2.0;
        assert!(check_references(&r).is_err());
    }

    #[test]
    fn v5_takes_outfits_and_strength_up_to_five() {
        let mut r = GenerateRequest { model: "nai-diffusion-5-full".into(), ..Default::default() };
        let reference = |kind: &str, strength: f64, prefer: bool| PreciseReference {
            path: "x.png".into(),
            kind: kind.into(),
            strength,
            fidelity: 1.0,
            prefer_same_outfit: prefer,
        };
        r.precise_references = vec![reference("character", 3.5, true), reference("outfit", 1.0, false), reference("style", 5.0, false)];
        assert!(check_references(&r).is_ok());
        for model in ["nai-diffusion-5-curated", "nai-diffusion-5-full-medium"] {
            r.model = model.into();
            assert!(check_references(&r).is_ok(), "{model}");
        }
        let mut body = json!({ "parameters": {} });
        add_references(&mut body, &r.model, &r.precise_references, &["A".into(), "B".into(), "C".into()]);
        let p = &body["parameters"];
        // As V5 samples made on novelai.net record them.
        assert_eq!(p["director_reference_descriptions"][0]["caption"]["base_caption"], "character_mainoutfit");
        // As a V5 sample made on novelai.net records an outfit reference.
        assert_eq!(p["director_reference_descriptions"][1]["caption"]["base_caption"], "costume");
        assert_eq!(p["director_reference_descriptions"][2]["caption"]["base_caption"], "style");
        assert_eq!(p["director_reference_strengths"], json!([3.5, 1.0, 5.0]));
        assert_eq!(p["director_reference_secondary_strengths"], json!(vec![V5_SECONDARY_STRENGTH; 3]));

        assert_eq!(v5_caption("character", false), "character");
        assert_eq!(v5_caption("character&style", true), "character&style");
        assert_eq!(v5_caption("style", true), "style");

        r.precise_references[2].strength = 5.5;
        assert!(check_references(&r).is_err());
        r.precise_references[2].strength = 1.0;
        r.model = "nai-diffusion-5-full-inpainting".into();
        assert!(check_references(&r).is_err());
    }

    #[test]
    fn costs_five_per_reference_and_the_guard_expects_it() {
        let mut r = GenerateRequest { model: "nai-diffusion-4-5-full".into(), width: 1024, height: 1024, steps: 28, ..Default::default() };
        r.precise_references = vec![
            PreciseReference { path: "a.png".into(), kind: "character".into(), strength: 1.0, fidelity: 1.0, prefer_same_outfit: false },
            PreciseReference { path: "b.png".into(), kind: "style".into(), strength: 1.0, fidelity: 1.0, prefer_same_outfit: false },
        ];
        assert_eq!(known_charge(&r), 10);
        let e = estimate_cost(&r, None);
        assert!(!e.free);
        assert_eq!(e.anlas, Some(10));
    }
}
