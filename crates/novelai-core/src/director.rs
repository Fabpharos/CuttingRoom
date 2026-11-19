// Director tools: Emotion (change a character's expression) and Colorize,
// through NovelAI's /ai/augment-image. A NovelAI developer said these are
// free on Opus up to 1024x1024 worth of pixels (Remove Background always
// costs, so it isn't offered). Bigger images are handled by cropping an area
// of at most that size, augmenting the crop and blending it back, so even a
// large manga page stays free. The balance is checked before and after, in
// case NovelAI's rules have changed since.
//
// Request: { req_type, prompt, defry (0-5), width, height, image (base64) }.
// Emotion's prompt is "<emotion>;;<extra tags>". Results are saved as new
// files (name_emotion-happy.png, name_colorized.png); nothing is overwritten.

use super::*;
use image::{imageops, RgbaImage};

/// NovelAI's emotions, as its site lists them.
pub const EMOTIONS: [&str; 24] = [
    "neutral", "happy", "sad", "angry", "scared", "surprised", "tired", "excited", "nervous", "thinking", "confused",
    "shy", "disgusted", "smug", "bored", "laughing", "irritated", "aroused", "embarrassed", "worried", "love",
    "determined", "hurt", "playful",
];
/// Defry: 0 keeps the most of the change, 5 the least (NovelAI's "Strength"
/// levels from Normal to Weakest).
pub const MAX_DEFRY: u32 = 5;
/// The free size for augmenting, the same as generation.
pub const DIRECTOR_FREE_PIXELS: u64 = 1_048_576;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorTool {
    Emotion,
    Colorize,
}

/// An area of the image, in its own pixels.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorRequest {
    pub path: String,
    pub tool: DirectorTool,
    /// One of EMOTIONS (Emotion only).
    #[serde(default)]
    pub emotion: String,
    /// Extra tags (Emotion), or the colouring prompt (Colorize).
    #[serde(default)]
    pub prompt: String,
    pub defry: u32,
    /// The part of the image to change; None means the whole image (which
    /// must then be within the free size).
    #[serde(default)]
    pub area: Option<Area>,
}

/// What will be sent, before anything is.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorPlan {
    pub image_width: u32,
    pub image_height: u32,
    /// The part changed (the whole image when no area was given).
    pub area: Area,
    /// The size sent to NovelAI (multiples of 64, within the free size).
    pub send_width: u32,
    pub send_height: u32,
    /// Whether the area was shrunk to fit the free size (and scaled back up).
    pub scaled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectorOutcome {
    pub path: String,
    pub plan: DirectorPlan,
    /// Set when NovelAI charged for it.
    pub anlas_warning: Option<String>,
}

fn round64(v: f64) -> u32 {
    (((v / 64.0).round() as u32).max(1) * 64).min(MAX_SIDE)
}

/// The size an area is sent at: its own size rounded to steps of 64, scaled
/// down when that's over the free pixel count.
pub fn director_send_size(width: u32, height: u32) -> (u32, u32, bool) {
    let px = width as f64 * height as f64;
    let scale = if px > DIRECTOR_FREE_PIXELS as f64 { (DIRECTOR_FREE_PIXELS as f64 / px).sqrt() } else { 1.0 };
    let (mut w, mut h) = (round64(width as f64 * scale), round64(height as f64 * scale));
    while w as u64 * h as u64 > DIRECTOR_FREE_PIXELS {
        if w >= h {
            w -= 64;
        } else {
            h -= 64;
        }
    }
    (w, h, scale < 1.0)
}

/// Checks the request and works out the plan for an image of this size.
pub fn plan_director(req: &DirectorRequest, image_width: u32, image_height: u32) -> Result<DirectorPlan, String> {
    if req.defry > MAX_DEFRY {
        return Err(format!("Strength (defry) must be between 0 and {MAX_DEFRY}."));
    }
    if req.tool == DirectorTool::Emotion && !EMOTIONS.contains(&req.emotion.as_str()) {
        return Err(format!("Unknown emotion: {}", req.emotion));
    }
    if req.prompt.len() > 2000 {
        return Err("The prompt is too long.".into());
    }
    let area = match req.area {
        Some(a) => {
            if a.width < 64 || a.height < 64 {
                return Err("The area must be at least 64×64 pixels.".into());
            }
            if a.x.checked_add(a.width).is_none_or(|r| r > image_width) || a.y.checked_add(a.height).is_none_or(|b| b > image_height) {
                return Err("The area goes outside the image.".into());
            }
            a
        }
        None => Area { x: 0, y: 0, width: image_width, height: image_height },
    };
    let (send_width, send_height, scaled) = director_send_size(area.width, area.height);
    Ok(DirectorPlan { image_width, image_height, area, send_width, send_height, scaled })
}

/// The plan for a file on disk, without contacting NovelAI.
pub async fn plan_director_file(req: DirectorRequest) -> Result<DirectorPlan, String> {
    tokio::task::spawn_blocking(move || {
        let (w, h) = image::image_dimensions(&req.path).map_err(|e| format!("couldn't read {}: {e}", req.path))?;
        plan_director(&req, w, h)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn body(req: &DirectorRequest, plan: &DirectorPlan, image_b64: &str) -> serde_json::Value {
    let (req_type, prompt) = match req.tool {
        DirectorTool::Emotion => ("emotion", format!("{};;{}", req.emotion, req.prompt.trim())),
        DirectorTool::Colorize => ("colorize", req.prompt.trim().to_string()),
    };
    json!({
        "req_type": req_type,
        "prompt": prompt,
        "defry": req.defry,
        "width": plan.send_width,
        "height": plan.send_height,
        "image": image_b64,
    })
}

/// The file name a result is saved under.
pub fn director_stem(req: &DirectorRequest) -> String {
    let stem = Path::new(&req.path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    match req.tool {
        DirectorTool::Emotion => format!("{stem}_emotion-{}", req.emotion),
        DirectorTool::Colorize => format!("{stem}_colorized"),
    }
}

/// Blends `patch` (the area's new pixels, already at the area's size) into
/// `image`, feathering the edges where the area is inside the picture.
fn blend_back(image: &mut RgbaImage, patch: &RgbaImage, area: Area) {
    let feather = (area.width.min(area.height) / 16).clamp(4, 32) as f32;
    for y in 0..area.height {
        for x in 0..area.width {
            // Distance to the nearest edge that isn't also the image's edge.
            let mut d = f32::MAX;
            if area.x > 0 {
                d = d.min(x as f32);
            }
            if area.y > 0 {
                d = d.min(y as f32);
            }
            if area.x + area.width < image.width() {
                d = d.min((area.width - 1 - x) as f32);
            }
            if area.y + area.height < image.height() {
                d = d.min((area.height - 1 - y) as f32);
            }
            let a = (d / feather).clamp(0.0, 1.0);
            let (ix, iy) = (area.x + x, area.y + y);
            let src = patch.get_pixel(x, y);
            let dst = image.get_pixel_mut(ix, iy);
            for c in 0..3 {
                dst[c] = (src[c] as f32 * a + dst[c] as f32 * (1.0 - a)).round() as u8;
            }
        }
    }
}

/// Changes one image with Emotion or Colorize and saves the result next to
/// `output_dir`. With `guard_anlas`, a charge is reported (the caller decides
/// whether to go on); paid runs are confirmed before this is called.
pub async fn run_director(
    run_id: String,
    req: DirectorRequest,
    output_dir: String,
    guard_anlas: bool,
) -> Result<DirectorOutcome, String> {
    let (source, plan, image_b64) = {
        let req = req.clone();
        tokio::task::spawn_blocking(move || {
            let img = image::ImageReader::open(&req.path)
                .map_err(|e| format!("couldn't open {}: {e}", req.path))?
                .with_guessed_format()
                .map_err(|e| format!("couldn't open {}: {e}", req.path))?
                .decode()
                .map_err(|e| format!("couldn't read {}: {e}", req.path))?
                .to_rgba8();
            let plan = plan_director(&req, img.width(), img.height())?;
            let a = plan.area;
            let crop = imageops::crop_imm(&img, a.x, a.y, a.width, a.height).to_image();
            let sent = imageops::resize(&crop, plan.send_width, plan.send_height, imageops::FilterType::Lanczos3);
            let mut png = Vec::new();
            image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(sent).to_rgb8())
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|e| format!("couldn't prepare the image: {e}"))?;
            Ok::<_, String>((img, plan, base64::engine::general_purpose::STANDARD.encode(png)))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let token = tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())??
        .ok_or("Log in to NovelAI on the Generate tab first.")?;
    let before = if guard_anlas { Some(fetch_status(&token).await?.anlas) } else { None };

    let request_body = body(&req, &plan, &image_b64);
    let result = send_in_turn(&run_id, || post_for_image(&token, "/ai/augment-image", &request_body)).await;
    cancelled_set().lock().unwrap().remove(&run_id);
    let bytes = result?.ok_or("Cancelled.")?;

    let (plan2, dir, stem) = (plan.clone(), PathBuf::from(output_dir), director_stem(&req));
    let path = tokio::task::spawn_blocking(move || {
        let returned = image::load_from_memory(&bytes)
            .map_err(|e| format!("couldn't read the image NovelAI returned: {e}"))?
            .to_rgba8();
        let a = plan2.area;
        let patch = imageops::resize(&returned, a.width, a.height, imageops::FilterType::Lanczos3);
        let whole = a.width == plan2.image_width && a.height == plan2.image_height;
        let out = if whole && !plan2.scaled {
            returned
        } else {
            let mut img = source;
            blend_back(&mut img, &patch, a);
            img
        };
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(out)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| format!("couldn't save the result: {e}"))?;
        save_png(&dir, &stem, &png)
    })
    .await
    .map_err(|e| e.to_string())??;

    let anlas_warning = match before {
        None => None,
        Some(before) => match fetch_status(&token).await {
            Ok(s) if s.anlas < before => Some(format!(
                "NovelAI charged {} Anlas for that. Director tools may no longer be free at this size.",
                before - s.anlas
            )),
            Ok(_) => None,
            Err(e) => Some(format!("Couldn't confirm the Anlas balance afterwards: {e}")),
        },
    };
    Ok(DirectorOutcome { path: path.to_string_lossy().into_owned(), plan, anlas_warning })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(tool: DirectorTool) -> DirectorRequest {
        DirectorRequest { path: "C:/x/page.png".into(), tool, emotion: "happy".into(), prompt: "blush".into(), defry: 0, area: None }
    }

    #[test]
    fn small_images_go_whole_and_big_ones_need_an_area_that_fits() {
        let p = plan_director(&req(DirectorTool::Emotion), 832, 1216).unwrap();
        assert_eq!((p.send_width, p.send_height, p.scaled), (832, 1216, false));
        // A big page without an area is shrunk to the free size and scaled back.
        let p = plan_director(&req(DirectorTool::Colorize), 2480, 3508).unwrap();
        assert!(p.scaled);
        assert!(p.send_width as u64 * p.send_height as u64 <= DIRECTOR_FREE_PIXELS);
        assert_eq!(p.send_width % 64, 0);
        // An area of a big page goes at its own size when it fits.
        let mut r = req(DirectorTool::Emotion);
        r.area = Some(Area { x: 1000, y: 400, width: 640, height: 768 });
        let p = plan_director(&r, 2480, 3508).unwrap();
        assert_eq!((p.send_width, p.send_height, p.scaled), (640, 768, false));
        r.area = Some(Area { x: 2400, y: 0, width: 640, height: 640 });
        assert!(plan_director(&r, 2480, 3508).is_err());
    }

    #[test]
    fn builds_the_request_like_novelais_site() {
        let r = req(DirectorTool::Emotion);
        let p = plan_director(&r, 1024, 1024).unwrap();
        let b = body(&r, &p, "AAAA");
        assert_eq!(b["req_type"], "emotion");
        assert_eq!(b["prompt"], "happy;;blush");
        assert_eq!(b["defry"], 0);
        assert_eq!(b["width"], 1024);
        let mut c = req(DirectorTool::Colorize);
        c.prompt = "red hair".into();
        assert_eq!(body(&c, &p, "AAAA")["prompt"], "red hair");
        let mut bad = req(DirectorTool::Emotion);
        bad.emotion = "furious".into();
        assert!(plan_director(&bad, 512, 512).is_err());
        bad = req(DirectorTool::Emotion);
        bad.defry = 6;
        assert!(plan_director(&bad, 512, 512).is_err());
        assert_eq!(director_stem(&r), "page_emotion-happy");
    }

    #[test]
    fn blends_an_area_back_with_soft_edges() {
        let mut img = RgbaImage::from_pixel(200, 200, image::Rgba([0, 0, 0, 255]));
        let patch = RgbaImage::from_pixel(100, 100, image::Rgba([255, 255, 255, 255]));
        blend_back(&mut img, &patch, Area { x: 50, y: 50, width: 100, height: 100 });
        assert_eq!(img.get_pixel(100, 100)[0], 255);
        assert!(img.get_pixel(50, 100)[0] < 64);
        assert_eq!(img.get_pixel(10, 10)[0], 0);
    }
}
