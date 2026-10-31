//! Focused inpainting ("crop and stitch"), done the way NovelAI's web client
//! does it: cut a region out of an image of any size, enlarge it to about one
//! megapixel, inpaint the masked part, then blend that part back in with a
//! soft edge. Only the crop is ever sent, so each request is priced like a
//! one-megapixel image: free on Opus at 28 steps or fewer.
//!
//! All coordinates are pixels of the source image, origin top-left.

use super::*;
use image::{imageops, GrayImage, Luma, Rgba, RgbaImage};

/// Crop sides are multiples of this, up to `MAX_CROP_SIDE`.
pub const CROP_MULTIPLE: u32 = 64;
pub const MAX_CROP_SIDE: u32 = 1024;
// NovelAI's free rule: at most this many pixels per request.
const FREE_PIXELS: u64 = 1_048_576;
/// NovelAI's mask grid: the mask is painted, and sent, in 8×8-pixel cells.
pub const MASK_CELL: u32 = 8;
/// Bounds the work a request can cause; also why the source is capped.
const MAX_SHAPES: usize = 64;
const MAX_STROKE_POINTS: usize = 2000;
const MAX_SOURCE_PIXELS: u64 = 100_000_000;
// Context left around the mask when the crop is chosen automatically.
const AUTO_CROP_MARGIN: f64 = 128.0;
const AUTO_CROP_MIN_SIDE: u32 = 512;
// The blend NovelAI's web client uses: grow the mask by 4 cells, then soften
// its edge, so the replaced area fades into the original with no seam.
const BLEND_GROW_CELLS: i64 = 4;
const BLEND_BLUR_SIGMA: f32 = 10.0;
const MIN_STRENGTH: f64 = 0.01;

/// The inpainting model NovelAI's web client uses for each model.
pub fn inpainting_model(model: &str) -> Option<&'static str> {
    Some(match model {
        "nai-diffusion-4-5-full" => "nai-diffusion-4-5-full-inpainting",
        "nai-diffusion-4-5-curated" => "nai-diffusion-4-5-curated-inpainting",
        "nai-diffusion-4-full" => "nai-diffusion-4-full-inpainting",
        "nai-diffusion-4-curated-preview" => "nai-diffusion-4-curated-inpainting",
        "nai-diffusion-5-full" => "nai-diffusion-5-full-inpainting",
        "nai-diffusion-5-full-medium" => "nai-diffusion-5-full-medium-inpainting",
        // NovelAI has no V5 Curated inpainting model; its site uses V4.5 Curated's.
        "nai-diffusion-5-curated" => "nai-diffusion-4-5-curated-inpainting",
        _ => return None,
    })
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CropSpec {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaskRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaskEllipse {
    pub cx: f64,
    pub cy: f64,
    pub rx: f64,
    pub ry: f64,
}

/// A brush stroke: a line through `points`, `radius` pixels thick on each side.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaskStroke {
    pub points: Vec<[f64; 2]>,
    pub radius: f64,
}

/// What to inpaint. Shapes are combined; `image_path` is a mask image the
/// size of the source where white (opaque) areas are inpainted.
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaskSpec {
    #[serde(default)]
    pub rects: Vec<MaskRect>,
    #[serde(default)]
    pub ellipses: Vec<MaskEllipse>,
    #[serde(default)]
    pub strokes: Vec<MaskStroke>,
    #[serde(default)]
    pub image_path: Option<String>,
}

/// Pixel bounds, x0/y0 inclusive, x1/y1 exclusive.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Bounds {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Bounds {
    fn union(self, o: Bounds) -> Bounds {
        Bounds { x0: self.x0.min(o.x0), y0: self.y0.min(o.y0), x1: self.x1.max(o.x1), y1: self.y1.max(o.y1) }
    }
}

fn finite(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite())
}

impl MaskSpec {
    fn validate(&self) -> Result<(), String> {
        let shapes = self.rects.len() + self.ellipses.len() + self.strokes.len();
        if shapes == 0 && self.image_path.is_none() {
            return Err("The mask is empty: give at least one rect, ellipse or stroke, or a mask image.".into());
        }
        if shapes > MAX_SHAPES {
            return Err(format!("The mask can have at most {MAX_SHAPES} shapes."));
        }
        for r in &self.rects {
            if !finite(&[r.x, r.y, r.width, r.height]) || r.width <= 0.0 || r.height <= 0.0 {
                return Err("Each mask rect needs a positive width and height.".into());
            }
        }
        for e in &self.ellipses {
            if !finite(&[e.cx, e.cy, e.rx, e.ry]) || e.rx <= 0.0 || e.ry <= 0.0 {
                return Err("Each mask ellipse needs positive rx and ry.".into());
            }
        }
        for s in &self.strokes {
            if s.points.is_empty() || s.points.len() > MAX_STROKE_POINTS {
                return Err(format!("Each mask stroke needs 1 to {MAX_STROKE_POINTS} points."));
            }
            if !s.radius.is_finite() || s.radius <= 0.0 || !s.points.iter().all(|p| finite(p)) {
                return Err("Each mask stroke needs a positive radius and numeric points.".into());
            }
        }
        Ok(())
    }

    /// Bounds of the shapes (not the mask image).
    fn shape_bounds(&self) -> Option<Bounds> {
        let rects = self.rects.iter().map(|r| Bounds { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
        let ellipses =
            self.ellipses.iter().map(|e| Bounds { x0: e.cx - e.rx, y0: e.cy - e.ry, x1: e.cx + e.rx, y1: e.cy + e.ry });
        let strokes = self.strokes.iter().map(|s| {
            let xs = s.points.iter().map(|p| p[0]);
            let ys = s.points.iter().map(|p| p[1]);
            Bounds {
                x0: xs.clone().fold(f64::INFINITY, f64::min) - s.radius,
                x1: xs.fold(f64::NEG_INFINITY, f64::max) + s.radius,
                y0: ys.clone().fold(f64::INFINITY, f64::min) - s.radius,
                y1: ys.fold(f64::NEG_INFINITY, f64::max) + s.radius,
            }
        });
        rects.chain(ellipses).chain(strokes).reduce(Bounds::union)
    }
}

// A mask image pixel is "inpaint" when it's opaque and light.
fn mask_image_marks(p: &Rgba<u8>) -> bool {
    p[3] > 127 && p[0].max(p[1]).max(p[2]) > 127
}

fn mask_image_bounds(mask: &RgbaImage) -> Option<Bounds> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, p) in mask.enumerate_pixels() {
        if mask_image_marks(p) {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
    }
    (x0 != u32::MAX).then_some(Bounds { x0: x0 as f64, y0: y0 as f64, x1: x1 as f64, y1: y1 as f64 })
}

fn floor_to(n: u32, multiple: u32) -> u32 {
    n / multiple * multiple
}

fn check_crop(c: &CropSpec, image_w: u32, image_h: u32) -> Result<(), String> {
    for (name, side) in [("width", c.width), ("height", c.height)] {
        if side == 0 || side % CROP_MULTIPLE != 0 || side > MAX_CROP_SIDE {
            return Err(format!(
                "The crop's {name} must be a multiple of {CROP_MULTIPLE} from {CROP_MULTIPLE} to {MAX_CROP_SIDE} (got {side})."
            ));
        }
    }
    if c.x as u64 + c.width as u64 > image_w as u64 || c.y as u64 + c.height as u64 > image_h as u64 {
        return Err(format!(
            "The crop ({}, {}, {}×{}) goes past the image's edge ({image_w}×{image_h}).",
            c.x, c.y, c.width, c.height
        ));
    }
    Ok(())
}

/// A crop centred on the mask, with room for context, as square as the image allows.
fn auto_crop(b: Bounds, image_w: u32, image_h: u32) -> Result<CropSpec, String> {
    let (max_w, max_h) = (floor_to(image_w, CROP_MULTIPLE).min(MAX_CROP_SIDE), floor_to(image_h, CROP_MULTIPLE).min(MAX_CROP_SIDE));
    let (bw, bh) = (b.x1 - b.x0, b.y1 - b.y0);
    if bw > max_w as f64 || bh > max_h as f64 {
        return Err(format!(
            "The mask spans {:.0}×{:.0} pixels, more than one crop can cover (at most {max_w}×{max_h} here). \
             Inpaint it in parts, each with its own `crop`.",
            bw, bh
        ));
    }
    let want = (bw.max(bh) + 2.0 * AUTO_CROP_MARGIN).ceil() as u32;
    let side = want.div_ceil(CROP_MULTIPLE) * CROP_MULTIPLE;
    let side = side.clamp(AUTO_CROP_MIN_SIDE, MAX_CROP_SIDE);
    let (w, h) = (side.min(max_w), side.min(max_h));
    // Starts on NovelAI's 8-pixel grid, like a selection on its site.
    let place = |center: f64, size: u32, limit: u32| -> u32 {
        let start = (center - size as f64 / 2.0).round().max(0.0) as u32;
        floor_to(start, MASK_CELL).min(limit - size)
    };
    Ok(CropSpec {
        x: place((b.x0 + b.x1) / 2.0, w, image_w),
        y: place((b.y0 + b.y1) / 2.0, h, image_h),
        width: w,
        height: h,
    })
}

/// The size the crop is sent at: enlarged to the largest multiple-of-64 size
/// within the free pixel count, keeping its shape, the way NovelAI's site
/// does. More pixels for the area means more detail in it.
pub fn send_size(width: u32, height: u32, enlarge: bool) -> (u32, u32) {
    if !enlarge {
        return (width, height);
    }
    let scale = (FREE_PIXELS as f64 / (width as f64 * height as f64)).sqrt();
    let fit = |side: u32| {
        let scaled = ((side as f64 * scale) / CROP_MULTIPLE as f64).floor() as u32 * CROP_MULTIPLE;
        scaled.max(side)
    };
    (fit(width), fit(height))
}

/// Marks the crop's pixels covered by `mask`, in crop-local coordinates.
fn rasterize(mask: &MaskSpec, mask_image: Option<&RgbaImage>, crop: &CropSpec) -> Vec<bool> {
    let (cw, ch) = (crop.width as i64, crop.height as i64);
    let mut px = vec![false; (cw * ch) as usize];
    // Visits crop pixels whose centres fall in a source-space box.
    let mut fill = |b: Bounds, test: &dyn Fn(f64, f64) -> bool| {
        let lx0 = ((b.x0 - crop.x as f64 - 0.5).floor() as i64).max(0);
        let ly0 = ((b.y0 - crop.y as f64 - 0.5).floor() as i64).max(0);
        let lx1 = ((b.x1 - crop.x as f64 + 0.5).ceil() as i64).min(cw);
        let ly1 = ((b.y1 - crop.y as f64 + 0.5).ceil() as i64).min(ch);
        for ly in ly0..ly1 {
            for lx in lx0..lx1 {
                let (sx, sy) = (crop.x as f64 + lx as f64 + 0.5, crop.y as f64 + ly as f64 + 0.5);
                if test(sx, sy) {
                    px[(ly * cw + lx) as usize] = true;
                }
            }
        }
    };
    for r in &mask.rects {
        let b = Bounds { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
        fill(b, &|x, y| x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1);
    }
    for e in &mask.ellipses {
        let b = Bounds { x0: e.cx - e.rx, y0: e.cy - e.ry, x1: e.cx + e.rx, y1: e.cy + e.ry };
        fill(b, &|x, y| ((x - e.cx) / e.rx).powi(2) + ((y - e.cy) / e.ry).powi(2) <= 1.0);
    }
    for s in &mask.strokes {
        let r = s.radius;
        // One capsule per segment (or a dot for a single point).
        let segments: Vec<([f64; 2], [f64; 2])> = if s.points.len() == 1 {
            vec![(s.points[0], s.points[0])]
        } else {
            s.points.windows(2).map(|w| (w[0], w[1])).collect()
        };
        for (a, b) in segments {
            let bounds = Bounds { x0: a[0].min(b[0]) - r, y0: a[1].min(b[1]) - r, x1: a[0].max(b[0]) + r, y1: a[1].max(b[1]) + r };
            fill(bounds, &|x, y| {
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let len2 = dx * dx + dy * dy;
                let t = if len2 == 0.0 { 0.0 } else { (((x - a[0]) * dx + (y - a[1]) * dy) / len2).clamp(0.0, 1.0) };
                let (qx, qy) = (a[0] + t * dx - x, a[1] + t * dy - y);
                qx * qx + qy * qy <= r * r
            });
        }
    }
    if let Some(img) = mask_image {
        for ly in 0..ch {
            for lx in 0..cw {
                if mask_image_marks(img.get_pixel(crop.x + lx as u32, crop.y + ly as u32)) {
                    px[(ly * cw + lx) as usize] = true;
                }
            }
        }
    }
    px
}

/// Snaps a pixel mask to NovelAI's 8×8 grid: a cell is masked if any of its
/// pixels is, like painting with NovelAI's brush.
fn to_grid(px: &[bool], width: u32, height: u32) -> Vec<bool> {
    let (gw, gh) = (width / MASK_CELL, height / MASK_CELL);
    let mut grid = vec![false; (gw * gh) as usize];
    for y in 0..height {
        for x in 0..width {
            if px[(y * width + x) as usize] {
                grid[((y / MASK_CELL) * gw + x / MASK_CELL) as usize] = true;
            }
        }
    }
    grid
}

/// Everything decided before anything is sent: the crop, the size it goes
/// out at, and the mask on NovelAI's grid. Shown to the user for approval.
pub struct InpaintPlan {
    pub source_path: String,
    pub image_width: u32,
    pub image_height: u32,
    pub crop: CropSpec,
    /// True when the crop was chosen from the mask rather than given.
    pub crop_was_auto: bool,
    pub send_width: u32,
    pub send_height: u32,
    pub masked_cells: usize,
    pub total_cells: usize,
    pub warnings: Vec<String>,
    source: RgbaImage,
    /// Crop-local, (crop.width / 8) × (crop.height / 8).
    grid: Vec<bool>,
}

impl InpaintPlan {
    pub fn coverage_percent(&self) -> f64 {
        self.masked_cells as f64 * 100.0 / self.total_cells.max(1) as f64
    }
}

fn load_rgba(path: &str, what: &str) -> Result<RgbaImage, String> {
    let (w, h) = image::image_dimensions(path).map_err(|e| format!("couldn't read the {what} ({path}): {e}"))?;
    if w as u64 * h as u64 > MAX_SOURCE_PIXELS {
        return Err(format!("The {what} is {w}×{h}; images over 100 megapixels aren't supported."));
    }
    Ok(image::open(path).map_err(|e| format!("couldn't read the {what} ({path}): {e}"))?.to_rgba8())
}

/// Works out the crop and mask for an inpaint. Reads files but sends nothing.
pub fn plan_inpaint(
    image_path: &str,
    crop: Option<CropSpec>,
    mask: &MaskSpec,
    enlarge: bool,
) -> Result<InpaintPlan, String> {
    mask.validate()?;
    let source = load_rgba(image_path, "image")?;
    let (iw, ih) = source.dimensions();
    if iw < CROP_MULTIPLE || ih < CROP_MULTIPLE {
        return Err(format!("The image is {iw}×{ih}; it needs to be at least {CROP_MULTIPLE}×{CROP_MULTIPLE}."));
    }
    let mask_image = match &mask.image_path {
        None => None,
        Some(p) => {
            let m = load_rgba(p, "mask image")?;
            if m.dimensions() != (iw, ih) {
                return Err(format!(
                    "The mask image is {}×{} but the image is {iw}×{ih}; they must match.",
                    m.width(),
                    m.height()
                ));
            }
            Some(m)
        }
    };

    let image_bounds = mask_image.as_ref().map(mask_image_bounds);
    if let Some(None) = image_bounds {
        return Err("The mask image has no white areas to inpaint.".into());
    }
    let mask_bounds = match (mask.shape_bounds(), image_bounds.flatten()) {
        (Some(a), Some(b)) => a.union(b),
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => unreachable!("validated: shapes or an image"),
    };
    let image_box = Bounds { x0: 0.0, y0: 0.0, x1: iw as f64, y1: ih as f64 };
    let clipped = Bounds {
        x0: mask_bounds.x0.max(0.0),
        y0: mask_bounds.y0.max(0.0),
        x1: mask_bounds.x1.min(image_box.x1),
        y1: mask_bounds.y1.min(image_box.y1),
    };
    if clipped.x0 >= clipped.x1 || clipped.y0 >= clipped.y1 {
        return Err(format!("The mask is entirely outside the image ({iw}×{ih})."));
    }

    let crop_was_auto = crop.is_none();
    let crop = match crop {
        Some(c) => {
            check_crop(&c, iw, ih)?;
            c
        }
        None => auto_crop(clipped, iw, ih)?,
    };

    let mut warnings = Vec::new();
    let crop_box = Bounds { x0: crop.x as f64, y0: crop.y as f64, x1: (crop.x + crop.width) as f64, y1: (crop.y + crop.height) as f64 };
    if clipped.x0 < crop_box.x0 || clipped.y0 < crop_box.y0 || clipped.x1 > crop_box.x1 || clipped.y1 > crop_box.y1 {
        warnings.push("Part of the mask is outside the crop; only the part inside is inpainted.".to_string());
    }
    if mask_bounds != clipped {
        warnings.push("Part of the mask is outside the image and was ignored.".to_string());
    }

    let px = rasterize(mask, mask_image.as_ref(), &crop);
    let grid = to_grid(&px, crop.width, crop.height);
    let masked_cells = grid.iter().filter(|&&m| m).count();
    if masked_cells == 0 {
        return Err("The mask doesn't cover any part of the crop.".into());
    }
    let (send_width, send_height) = send_size(crop.width, crop.height, enlarge);
    Ok(InpaintPlan {
        source_path: image_path.to_string(),
        image_width: iw,
        image_height: ih,
        crop,
        crop_was_auto,
        send_width,
        send_height,
        masked_cells,
        total_cells: grid.len(),
        warnings,
        source,
        grid,
    })
}

/// Resamples a cell grid to another grid size (nearest cell).
fn resample_grid(grid: &[bool], gw: u32, gh: u32, tw: u32, th: u32) -> Vec<bool> {
    let mut out = vec![false; (tw * th) as usize];
    for y in 0..th {
        for x in 0..tw {
            let (sx, sy) = ((x as u64 * gw as u64 / tw as u64) as u32, (y as u64 * gh as u64 / th as u64) as u32);
            out[(y * tw + x) as usize] = grid[(sy * gw + sx) as usize];
        }
    }
    out
}

fn encode_png(img: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't encode an image: {e}"))?;
    Ok(out)
}

/// What gets sent, matching NovelAI's site: the crop (transparency flattened
/// onto white) at the send size, and the mask at the same size, scaled up
/// from the 8-pixel grid without smoothing and fully opaque: white to
/// inpaint, black to keep. (A grid-sized mask with transparency left NovelAI
/// to scale it, and the soft, half-transparent edge came back as a grey
/// outline around the inpainted area.)
struct Prepared {
    image_png: Vec<u8>,
    mask_png: Vec<u8>,
    send_grid: Vec<bool>,
}

fn prepare(plan: &InpaintPlan) -> Result<Prepared, String> {
    let c = plan.crop;
    let mut crop = imageops::crop_imm(&plan.source, c.x, c.y, c.width, c.height).to_image();
    for p in crop.pixels_mut() {
        let a = p[3] as f32 / 255.0;
        for i in 0..3 {
            p[i] = (p[i] as f32 * a + 255.0 * (1.0 - a)).round() as u8;
        }
        p[3] = 255;
    }
    let crop = image::DynamicImage::ImageRgba8(crop).to_rgb8();
    let sent = if (plan.send_width, plan.send_height) == (c.width, c.height) {
        crop
    } else {
        imageops::resize(&crop, plan.send_width, plan.send_height, imageops::FilterType::Lanczos3)
    };

    let (gw, gh) = (c.width / MASK_CELL, c.height / MASK_CELL);
    let (sw, sh) = (plan.send_width / MASK_CELL, plan.send_height / MASK_CELL);
    let send_grid = resample_grid(&plan.grid, gw, gh, sw, sh);
    let mask = RgbaImage::from_fn(plan.send_width, plan.send_height, |x, y| {
        if send_grid[((y / MASK_CELL) * sw + x / MASK_CELL) as usize] {
            Rgba([255, 255, 255, 255])
        } else {
            Rgba([0, 0, 0, 255])
        }
    });
    Ok(Prepared {
        image_png: encode_png(&image::DynamicImage::ImageRgb8(sent))?,
        mask_png: encode_png(&image::DynamicImage::ImageRgba8(mask))?,
        send_grid,
    })
}

/// How much of the returned image to use at each pixel (send size): the mask
/// grown by 4 cells, then blurred, as NovelAI's site does.
fn blend_alpha(send_grid: &[bool], sw: u32, sh: u32) -> GrayImage {
    let n = BLEND_GROW_CELLS;
    let grown: Vec<bool> = (0..sh as i64)
        .flat_map(|y| (0..sw as i64).map(move |x| (x, y)))
        .map(|(x, y)| {
            (-n..=n).any(|dy| {
                (-n..=n).any(|dx| {
                    let (nx, ny) = (x + dx, y + dy);
                    nx >= 0 && ny >= 0 && nx < sw as i64 && ny < sh as i64 && send_grid[(ny * sw as i64 + nx) as usize]
                })
            })
        })
        .collect();
    let alpha = GrayImage::from_fn(sw * MASK_CELL, sh * MASK_CELL, |x, y| {
        Luma([if grown[((y / MASK_CELL) * sw + x / MASK_CELL) as usize] { 255 } else { 0 }])
    });
    imageops::blur(&alpha, BLEND_BLUR_SIGMA)
}

/// Blends the returned image back into the source where the mask (softened)
/// says to. Pixels outside the crop are never touched; the source's own
/// transparency is kept.
fn stitch(plan: &InpaintPlan, returned: &RgbaImage, send_grid: &[bool]) -> RgbaImage {
    let c = plan.crop;
    let (sw, sh) = (plan.send_width / MASK_CELL, plan.send_height / MASK_CELL);
    let alpha = blend_alpha(send_grid, sw, sh);
    let fit = |w: u32, h: u32| (w, h) != (c.width, c.height);
    let returned = if fit(returned.width(), returned.height()) {
        imageops::resize(returned, c.width, c.height, imageops::FilterType::Lanczos3)
    } else {
        returned.clone()
    };
    let alpha = if fit(alpha.width(), alpha.height()) {
        imageops::resize(&alpha, c.width, c.height, imageops::FilterType::Triangle)
    } else {
        alpha
    };
    let mut out = plan.source.clone();
    for y in 0..c.height {
        for x in 0..c.width {
            let a = alpha.get_pixel(x, y)[0] as f32 / 255.0;
            if a == 0.0 {
                continue;
            }
            let r = returned.get_pixel(x, y);
            let p = out.get_pixel_mut(c.x + x, c.y + y);
            for i in 0..3 {
                p[i] = (p[i] as f32 * (1.0 - a) + r[i] as f32 * a).round() as u8;
            }
        }
    }
    out
}

/// The generation settings for an inpaint; the model is the normal one and
/// is swapped for its inpainting version.
#[derive(Clone)]
pub struct InpaintSettings {
    pub model: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub characters: Vec<String>,
    /// Each character's undesired content, by position.
    pub character_negatives: Vec<String>,
    /// Where each character goes within the crop; None lets the model decide.
    pub character_positions: Option<Vec<CharacterPosition>>,
    pub steps: u32,
    pub scale: f64,
    pub seed: u32,
    /// 1 inpaints normally; lower keeps more of the original pixels.
    pub strength: f64,
}

fn inpaint_body(plan: &InpaintPlan, s: &InpaintSettings, prepared: &Prepared) -> Result<serde_json::Value, String> {
    let (w, h) = (plan.send_width, plan.send_height);
    if w % CROP_MULTIPLE != 0 || h % CROP_MULTIPLE != 0 || w as u64 * h as u64 > FREE_PIXELS {
        return Err(format!("{w}×{h} is outside the free size for inpainting."));
    }
    if !(MIN_STRENGTH..=1.0).contains(&s.strength) {
        return Err(format!("Inpaint strength must be between {MIN_STRENGTH} and 1."));
    }
    let inpaint_model = inpainting_model(&s.model).ok_or_else(|| format!("Unknown model: {}", s.model))?;
    let req = GenerateRequest {
        model: s.model.clone(),
        prompt: s.prompt.clone(),
        negative_prompt: s.negative_prompt.clone(),
        characters: s.characters.clone(),
        character_negatives: s.character_negatives.clone(),
        character_positions: match &s.character_positions {
            // V5 Curated inpaints with V4.5 Curated's model, so it follows the grid rules.
            Some(p) if !inpaint_model.starts_with("nai-diffusion-5") && free_character_positions(&s.model) => {
                let named = s.characters.iter().filter(|c| !c.trim().is_empty()).count();
                positions_apply("nai-diffusion-4-5-curated", named)
                    .then(|| p.iter().map(|&at| position_for_model("nai-diffusion-4-5-curated", at)).collect())
            }
            other => other.clone(),
        },
        width: w,
        height: h,
        steps: s.steps,
        scale: s.scale,
        seed: s.seed,
        file_stem: "inpaint".into(),
        vibes: Vec::new(),
    };
    // Checks steps, guidance, characters and the model like any generation.
    let mut body = request_body(&req, &[])?;
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    body["model"] = json!(inpaint_model);
    body["action"] = json!("infill");
    let p = &mut body["parameters"];
    p["image"] = json!(b64(&prepared.image_png));
    p["mask"] = json!(b64(&prepared.mask_png));
    // The blending happens here, not on NovelAI's side.
    p["add_original_image"] = json!(false);
    // NovelAI's defaults for these; inpaint strength goes in `img2img`.
    p["strength"] = json!(0.7);
    p["noise"] = json!(0);
    // NovelAI's site sets this for every request with an input image.
    p["extra_noise_seed"] = json!(s.seed.saturating_sub(1));
    if s.strength < 1.0 {
        p["img2img"] = json!({ "strength": s.strength, "color_correct": true });
    }
    Ok(body)
}

/// `<name>_inpainted`, from the source file's name.
pub fn inpainted_stem(source: &str) -> String {
    let stem = Path::new(source).file_stem().unwrap_or_default().to_string_lossy().into_owned();
    format!("{}_inpainted", if stem.is_empty() { "image" } else { &stem })
}

pub struct InpaintOutcome {
    pub path: String,
    pub seed: u32,
    pub inpaint_model: String,
    /// The crop before and after, at crop size, for comparing.
    pub crop_before: RgbaImage,
    pub crop_after: RgbaImage,
    /// The whole stitched image.
    pub result: RgbaImage,
    /// Set when the Anlas guard saw the balance drop.
    pub anlas_warning: Option<String>,
    /// Where NovelAI's unblended crop was saved, when asked for.
    pub raw_path: Option<String>,
}

/// NovelAI hides metadata in the lowest bits of an image's alpha channel,
/// so its "opaque" images have alpha values just under 255. Treat those as
/// opaque, as NovelAI's site does, rather than carrying stale hidden data
/// and faint transparency into the result.
fn effectively_opaque(img: &RgbaImage) -> bool {
    img.pixels().all(|p| p[3] >= 250)
}

/// Sends the planned inpaint, stitches the result in, and saves it as a new
/// `<name>_inpainted.png` in `output_dir`. Shares the global request spacing
/// with generation. With `guard_anlas`, reports any drop in the balance.
pub async fn run_inpaint(
    run_id: String,
    plan: InpaintPlan,
    settings: InpaintSettings,
    output_dir: String,
    guard_anlas: bool,
    keep_raw: bool,
) -> Result<InpaintOutcome, String> {
    let plan = std::sync::Arc::new(plan);
    // Everything is checked and encoded before anything is sent.
    let (prepared, body) = {
        let (plan, settings) = (plan.clone(), settings.clone());
        tokio::task::spawn_blocking(move || {
            let prepared = prepare(&plan)?;
            let body = inpaint_body(&plan, &settings, &prepared)?;
            Ok::<_, String>((prepared, body))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let token = tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())??
        .ok_or("Log in to NovelAI in Cutting Room's Generate tab first.")?;
    let before = if guard_anlas { Some(fetch_status(&token).await?.anlas) } else { None };

    if !wait_for_turn(&run_id).await {
        cancelled_set().lock().unwrap().remove(&run_id);
        return Err("Cancelled.".into());
    }
    let result = post_for_image(&token, "/ai/generate-image", &body).await;
    *LAST_GENERATION.lock().unwrap() = Some(Instant::now());
    cancelled_set().lock().unwrap().remove(&run_id);
    let bytes = result?;

    let (plan2, dir, stem) = (plan.clone(), PathBuf::from(output_dir), inpainted_stem(&plan.source_path));
    let (path, raw_path, crop_before, crop_after, result) = tokio::task::spawn_blocking(move || {
        let returned = image::load_from_memory(&bytes)
            .map_err(|e| format!("couldn't read the image NovelAI returned: {e}"))?
            .to_rgba8();
        let raw_path = if keep_raw {
            Some(save_png(&dir, &format!("{stem}_raw"), &bytes)?.to_string_lossy().into_owned())
        } else {
            None
        };
        let stitched = stitch(&plan2, &returned, &prepared.send_grid);
        let c = plan2.crop;
        let crop_before = imageops::crop_imm(&plan2.source, c.x, c.y, c.width, c.height).to_image();
        let crop_after = imageops::crop_imm(&stitched, c.x, c.y, c.width, c.height).to_image();
        let out = if effectively_opaque(&plan2.source) {
            image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(stitched.clone()).to_rgb8())
        } else {
            image::DynamicImage::ImageRgba8(stitched.clone())
        };
        let path = save_png(&dir, &stem, &encode_png(&out)?)?;
        Ok::<_, String>((path, raw_path, crop_before, crop_after, stitched))
    })
    .await
    .map_err(|e| e.to_string())??;

    let anlas_warning = match before {
        None => None,
        Some(before) => match fetch_status(&token).await {
            Ok(s) if s.anlas < before => Some(format!(
                "NovelAI charged {} Anlas for that inpaint. If you're using a V5 model, the Opus V5 quota may have run out.",
                before - s.anlas
            )),
            Ok(_) => None,
            Err(e) => Some(format!("Couldn't confirm the Anlas balance afterwards: {e}")),
        },
    };
    Ok(InpaintOutcome {
        path: path.to_string_lossy().into_owned(),
        seed: settings.seed,
        inpaint_model: inpainting_model(&settings.model).unwrap_or_default().to_string(),
        crop_before,
        crop_after,
        result,
        anlas_warning,
        raw_path,
    })
}

// ---- Previews (no network) ----

fn fit_within(img: &RgbaImage, max_edge: u32) -> (RgbaImage, f64) {
    let (w, h) = img.dimensions();
    if w.max(h) <= max_edge {
        return (img.clone(), 1.0);
    }
    let scale = max_edge as f64 / w.max(h) as f64;
    let (nw, nh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    (imageops::resize(img, nw, nh, imageops::FilterType::Triangle), scale)
}

fn tint(p: &mut Rgba<u8>, color: [u8; 3], amount: f32) {
    for i in 0..3 {
        p[i] = (p[i] as f32 * (1.0 - amount) + color[i] as f32 * amount).round() as u8;
    }
}

// Magenta rarely appears in artwork, so the mask stays visible over skin,
// hair and the warm colours anime images are full of.
const MASK_COLOR: [u8; 3] = [255, 0, 255];
const CROP_OUTLINE: [u8; 3] = [255, 176, 32];

/// Tints a view's masked pixels and outlines the mask's edge solidly.
fn draw_mask(view: &mut RgbaImage, is_masked: impl Fn(u32, u32) -> bool) {
    let (w, h) = view.dimensions();
    let m: Vec<bool> = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| is_masked(x, y)).collect();
    let at = |x: i64, y: i64| x >= 0 && y >= 0 && x < w as i64 && y < h as i64 && m[(y as u64 * w as u64 + x as u64) as usize];
    for (x, y, p) in view.enumerate_pixels_mut() {
        p[3] = 255;
        let (xi, yi) = (x as i64, y as i64);
        if !at(xi, yi) {
            continue;
        }
        let edge = [(-2, 0), (2, 0), (0, -2), (0, 2)].iter().any(|(dx, dy)| !at(xi + dx, yi + dy));
        if edge {
            *p = Rgba([MASK_COLOR[0], MASK_COLOR[1], MASK_COLOR[2], 255]);
        } else {
            tint(p, MASK_COLOR, 0.35);
        }
    }
}

/// Two views for checking a plan before sending it: the whole image (at most
/// `max_edge` on its long side) with the crop outlined in orange and the
/// mask in magenta, and the crop itself with the mask.
pub fn preview_plan(plan: &InpaintPlan, max_edge: u32) -> (RgbaImage, RgbaImage) {
    let c = plan.crop;
    let gw = c.width / MASK_CELL;
    let masked = |sx: u32, sy: u32| -> bool {
        sx >= c.x && sy >= c.y && sx < c.x + c.width && sy < c.y + c.height && {
            let (lx, ly) = (sx - c.x, sy - c.y);
            plan.grid[((ly / MASK_CELL) * gw + lx / MASK_CELL) as usize]
        }
    };

    let (mut crop_view, crop_scale) =
        fit_within(&imageops::crop_imm(&plan.source, c.x, c.y, c.width, c.height).to_image(), max_edge);
    let crop_to_source = |v: u32| ((v as f64 + 0.5) / crop_scale) as u32;
    draw_mask(&mut crop_view, |x, y| masked(c.x + crop_to_source(x), c.y + crop_to_source(y)));

    let (mut full, scale) = fit_within(&plan.source, max_edge);
    let (fw, fh) = full.dimensions();
    let to_source = |v: u32| ((v as f64 + 0.5) / scale) as u32;
    draw_mask(&mut full, |x, y| {
        masked(to_source(x).min(plan.image_width - 1), to_source(y).min(plan.image_height - 1))
    });
    let (x0, y0) = ((c.x as f64 * scale) as i64, (c.y as f64 * scale) as i64);
    let (x1, y1) = (((c.x + c.width) as f64 * scale) as i64 - 1, ((c.y + c.height) as f64 * scale) as i64 - 1);
    let line = 3i64;
    for y in y0.max(0)..=y1.min(fh as i64 - 1) {
        for x in x0.max(0)..=x1.min(fw as i64 - 1) {
            let edge = x - x0 < line || x1 - x < line || y - y0 < line || y1 - y < line;
            if edge {
                let p = full.get_pixel_mut(x as u32, y as u32);
                *p = Rgba([CROP_OUTLINE[0], CROP_OUTLINE[1], CROP_OUTLINE[2], 255]);
            }
        }
    }
    (full, crop_view)
}

/// `before` and `after` next to each other, each scaled to at most
/// `max_height`, with a gap between.
pub fn side_by_side(before: &RgbaImage, after: &RgbaImage, max_height: u32) -> RgbaImage {
    let (b, _) = fit_within(before, max_height);
    let (a, _) = fit_within(after, max_height);
    let gap = 12;
    let mut out = RgbaImage::from_pixel(b.width() + gap + a.width(), b.height().max(a.height()), Rgba([40, 40, 40, 255]));
    imageops::overlay(&mut out, &b, 0, 0);
    imageops::overlay(&mut out, &a, (b.width() + gap) as i64, 0);
    for p in out.pixels_mut() {
        p[3] = 255;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_png(name: &str, img: &RgbaImage) -> String {
        let dir = std::env::temp_dir().join(format!("novelai-core-inpaint-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        img.save_with_format(&path, image::ImageFormat::Png).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn gradient(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]))
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> MaskSpec {
        MaskSpec { rects: vec![MaskRect { x, y, width: w, height: h }], ..Default::default() }
    }

    fn settings(model: &str, strength: f64) -> InpaintSettings {
        InpaintSettings {
            model: model.into(),
            prompt: "1girl, smile".into(),
            negative_prompt: "lowres".into(),
            characters: vec![],
            character_negatives: vec![],
            character_positions: None,
            steps: 28,
            scale: 5.0,
            seed: 7,
            strength,
        }
    }

    #[test]
    fn maps_every_model_to_an_inpainting_model() {
        for m in MODELS {
            assert!(inpainting_model(m).is_some(), "{m}");
        }
        assert_eq!(inpainting_model("nai-diffusion-5-curated"), Some("nai-diffusion-4-5-curated-inpainting"));
        assert_eq!(inpainting_model("nai-diffusion-3"), None);
    }

    #[test]
    fn enlarges_crops_to_the_free_size_keeping_their_shape() {
        assert_eq!(send_size(256, 256, true), (1024, 1024));
        assert_eq!(send_size(1024, 1024, true), (1024, 1024));
        assert_eq!(send_size(640, 448, true), (1216, 832));
        assert_eq!(send_size(512, 1024, true), (704, 1408));
        assert_eq!(send_size(256, 256, false), (256, 256));
        for (w, h) in [(64, 64), (320, 960), (1024, 64), (576, 832)] {
            let (sw, sh) = send_size(w, h, true);
            assert!(sw as u64 * sh as u64 <= FREE_PIXELS && sw % 64 == 0 && sh % 64 == 0 && sw >= w && sh >= h, "{w}x{h}");
        }
    }

    #[test]
    fn checks_crops_and_picks_one_around_the_mask() {
        assert!(check_crop(&CropSpec { x: 0, y: 0, width: 1024, height: 1024 }, 2000, 2000).is_ok());
        for bad in [
            CropSpec { x: 0, y: 0, width: 1000, height: 512 },
            CropSpec { x: 0, y: 0, width: 1088, height: 512 },
            CropSpec { x: 1500, y: 0, width: 512, height: 512 },
            CropSpec { x: 0, y: 0, width: 0, height: 512 },
        ] {
            assert!(check_crop(&bad, 1800, 1800).is_err(), "{bad:?}");
        }
        // A small mask gets the minimum square, centred, inside the image.
        let c = auto_crop(Bounds { x0: 100.0, y0: 100.0, x1: 160.0, y1: 160.0 }, 5000, 5000).unwrap();
        assert_eq!((c.x, c.y, c.width, c.height), (0, 0, 512, 512));
        let c = auto_crop(Bounds { x0: 2400.0, y0: 2400.0, x1: 2700.0, y1: 2600.0 }, 5000, 5000).unwrap();
        assert_eq!((c.width, c.height), (576, 576));
        assert!(c.x as f64 <= 2400.0 && (c.x + c.width) as f64 >= 2700.0);
        // Near an edge, the crop is pushed back inside.
        let c = auto_crop(Bounds { x0: 4950.0, y0: 10.0, x1: 5000.0, y1: 40.0 }, 5000, 3000).unwrap();
        assert_eq!((c.x + c.width, c.y), (5000, 0));
        // Too big for one crop.
        assert!(auto_crop(Bounds { x0: 0.0, y0: 0.0, x1: 1500.0, y1: 100.0 }, 5000, 5000).is_err());
        // A small image limits the crop to what fits.
        let c = auto_crop(Bounds { x0: 10.0, y0: 10.0, x1: 50.0, y1: 50.0 }, 300, 200).unwrap();
        assert_eq!((c.width, c.height), (256, 192));
    }

    #[test]
    fn rasterizes_shapes_onto_the_8px_grid() {
        let crop = CropSpec { x: 64, y: 64, width: 128, height: 128 };
        // A rect covering crop-local x 4..20, y 0..8 touches cells x 0..2 of row 0.
        let px = rasterize(&rect(68.0, 64.0, 16.0, 8.0), None, &crop);
        let grid = to_grid(&px, 128, 128);
        let row0: Vec<bool> = grid[..16].to_vec();
        assert_eq!(&row0[..4], &[true, true, true, false]);
        assert_eq!(grid.iter().filter(|&&m| m).count(), 3);

        // Ellipse and stroke.
        let mask = MaskSpec {
            ellipses: vec![MaskEllipse { cx: 128.0, cy: 128.0, rx: 20.0, ry: 10.0 }],
            strokes: vec![MaskStroke { points: vec![[70.0, 180.0], [180.0, 180.0]], radius: 3.0 }],
            ..Default::default()
        };
        let px = rasterize(&mask, None, &crop);
        let at = |x: u32, y: u32| px[((y - 64) * 128 + (x - 64)) as usize];
        assert!(at(128, 128) && at(146, 128) && !at(150, 128) && !at(128, 140));
        assert!(at(100, 180) && at(100, 182) && !at(100, 185) && !at(60 + 128, 100));
    }

    #[test]
    fn plans_from_a_mask_image_and_reports_problems() {
        let src = temp_png("src.png", &gradient(800, 600));
        let mut m = RgbaImage::from_pixel(800, 600, Rgba([0, 0, 0, 255]));
        for y in 304..344 {
            for x in 400..460 {
                m.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let mask_path = temp_png("mask.png", &m);
        let spec = MaskSpec { image_path: Some(mask_path), ..Default::default() };
        let plan = plan_inpaint(&src, None, &spec, true).unwrap();
        assert!(plan.crop_was_auto);
        assert_eq!((plan.crop.width, plan.crop.height), (512, 512));
        assert_eq!((plan.send_width, plan.send_height), (1024, 1024));
        // 60×40 pixels at an 8-aligned spot: 8×5 cells.
        assert_eq!(plan.masked_cells, 40);
        assert!(plan.warnings.is_empty());

        // Mask image of the wrong size, an empty one, and an empty spec.
        let small = temp_png("small.png", &RgbaImage::new(10, 10));
        assert!(plan_inpaint(&src, None, &MaskSpec { image_path: Some(small), ..Default::default() }, true).is_err());
        let black = temp_png("black.png", &RgbaImage::from_pixel(800, 600, Rgba([0, 0, 0, 255])));
        assert!(plan_inpaint(&src, None, &MaskSpec { image_path: Some(black), ..Default::default() }, true).is_err());
        assert!(plan_inpaint(&src, None, &MaskSpec::default(), true).is_err());
        // Mask outside the crop; mask partly outside the image.
        let crop = Some(CropSpec { x: 0, y: 0, width: 256, height: 256 });
        assert!(plan_inpaint(&src, crop, &rect(500.0, 500.0, 20.0, 20.0), true).is_err());
        let plan = plan_inpaint(&src, crop, &rect(200.0, 200.0, 100.0, 20.0), true).unwrap();
        assert_eq!(plan.warnings.len(), 1);
        let plan = plan_inpaint(&src, None, &rect(-20.0, 10.0, 40.0, 20.0), true).unwrap();
        assert!(plan.warnings.iter().any(|w| w.contains("outside the image")));
    }

    #[test]
    fn builds_an_infill_request_with_a_grid_sized_mask() {
        let src = temp_png("body.png", &gradient(1200, 900));
        let plan = plan_inpaint(&src, Some(CropSpec { x: 64, y: 64, width: 512, height: 256 }), &rect(100.0, 100.0, 40.0, 40.0), true).unwrap();
        assert_eq!((plan.send_width, plan.send_height), (1408, 704));
        let prepared = prepare(&plan).unwrap();
        let body = inpaint_body(&plan, &settings("nai-diffusion-4-5-full", 1.0), &prepared).unwrap();
        assert_eq!(body["action"], "infill");
        assert_eq!(body["model"], "nai-diffusion-4-5-full-inpainting");
        let p = &body["parameters"];
        assert_eq!((p["width"].as_u64(), p["height"].as_u64()), (Some(1408), Some(704)));
        assert_eq!(p["add_original_image"], false);
        assert_eq!(p["n_samples"], 1);
        assert!(p.get("img2img").is_none(), "full strength sends no img2img");
        let decode = |key: &str| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(p[key].as_str().unwrap()).unwrap();
            image::load_from_memory(&bytes).unwrap()
        };
        assert_eq!((decode("image").width(), decode("image").height()), (1408, 704));
        // Full size, opaque, hard-edged: white in whole 8x8 blocks, black elsewhere.
        let mask = decode("mask").to_rgba8();
        assert_eq!(mask.dimensions(), (1408, 704));
        let white = mask.pixels().filter(|p| p.0 == [255, 255, 255, 255]).count();
        let black = mask.pixels().filter(|p| p.0 == [0, 0, 0, 255]).count();
        assert_eq!(white + black, 1408 * 704);
        assert!(white > 0 && white % 64 == 0);
        assert_eq!(p["extra_noise_seed"], 6);

        let lower = inpaint_body(&plan, &settings("nai-diffusion-5-curated", 0.5), &prepared).unwrap();
        assert_eq!(lower["model"], "nai-diffusion-4-5-curated-inpainting");
        assert_eq!(lower["parameters"]["img2img"]["strength"], 0.5);
        assert!(inpaint_body(&plan, &settings("nai-diffusion-4-5-full", 0.0), &prepared).is_err());
        let mut too_many = settings("nai-diffusion-4-5-full", 1.0);
        too_many.steps = 29;
        assert!(inpaint_body(&plan, &too_many, &prepared).is_err());
    }

    #[test]
    fn stitches_only_the_softened_mask_area_back() {
        let src_img = gradient(1000, 800);
        let src = temp_png("stitch.png", &src_img);
        let crop = CropSpec { x: 200, y: 200, width: 512, height: 512 };
        let plan = plan_inpaint(&src, Some(crop), &rect(400.0, 400.0, 64.0, 64.0), true).unwrap();
        let prepared = prepare(&plan).unwrap();
        // Pretend NovelAI painted the whole crop solid blue.
        let returned = RgbaImage::from_pixel(plan.send_width, plan.send_height, Rgba([0, 0, 255, 255]));
        let out = stitch(&plan, &returned, &prepared.send_grid);
        assert_eq!(out.dimensions(), (1000, 800));
        // Inside the mask: replaced.
        assert_eq!(out.get_pixel(432, 432).0[..3], [0, 0, 255]);
        // Well outside the mask, and outside the crop: untouched.
        assert_eq!(out.get_pixel(250, 250), src_img.get_pixel(250, 250));
        assert_eq!(out.get_pixel(100, 100), src_img.get_pixel(100, 100));
        assert_eq!(out.get_pixel(800, 750), src_img.get_pixel(800, 750));
        // In between: a blend, not a hard edge.
        let edge = out.get_pixel(480, 432);
        assert!(edge[2] > src_img.get_pixel(480, 432)[2] && edge[2] < 255, "{edge:?}");
    }

    #[test]
    fn previews_show_the_crop_and_mask() {
        let src = temp_png("preview.png", &gradient(2000, 1000));
        let plan = plan_inpaint(&src, Some(CropSpec { x: 1000, y: 200, width: 512, height: 512 }), &rect(1100.0, 300.0, 50.0, 50.0), true).unwrap();
        let (full, crop) = preview_plan(&plan, 1000);
        assert_eq!(full.dimensions(), (1000, 500));
        assert_eq!(crop.dimensions(), (512, 512));
        // The crop's outline is drawn at half scale.
        assert_eq!(full.get_pixel(500, 150).0[..3], CROP_OUTLINE);
        // The mask is outlined in magenta and tinted inside, in the crop view.
        // The rect starts at crop-local x 100; the grid snaps its edge out to 96.
        assert_eq!(crop.get_pixel(96, 120).0[..3], MASK_COLOR);
        let inside = crop.get_pixel(120, 120);
        assert!(inside.0[..3] != MASK_COLOR && inside[1] < 120, "{inside:?}");
        let both = side_by_side(&crop, &crop, 256);
        assert_eq!(both.dimensions(), (256 + 12 + 256, 256));
    }

    #[test]
    fn treats_novelai_hidden_alpha_metadata_as_opaque() {
        let mut img = RgbaImage::from_pixel(4, 4, Rgba([10, 20, 30, 255]));
        img.put_pixel(1, 1, Rgba([10, 20, 30, 252]));
        assert!(effectively_opaque(&img));
        img.put_pixel(2, 2, Rgba([10, 20, 30, 128]));
        assert!(!effectively_opaque(&img));
    }

    #[test]
    fn names_outputs_after_their_source() {
        assert_eq!(inpainted_stem(r"C:\art\scene.final.png"), "scene.final_inpainted");
    }
}
