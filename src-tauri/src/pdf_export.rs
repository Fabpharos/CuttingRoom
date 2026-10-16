use image::{ColorType, GenericImageView};
use miniz_oxide::deflate::{compress_to_vec_zlib, CompressionLevel};
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
}

// Fixed frame width, in points (1pt = 1/72in) — every photo is scaled to
// this width. US Letter's width is a reasonable default "slideshow" frame.
const PAGE_WIDTH_PT: f32 = 612.0;
// Safety cap against the PDF spec's maximum page size — only relevant for
// a pathologically tall/narrow source image, since every photo otherwise
// gets its own page sized to fit exactly.
const MAX_PAGE_HEIGHT_PT: f32 = 14_000.0;

struct PreparedImage {
    filter: Filter,
    encoded: Vec<u8>,
    mask: Option<Vec<u8>>,
    width: u32,
    height: u32,
}

// Decoding and (re-)encoding is the only way to get a plain, self-contained
// pixel stream to embed: a JPEG's own bytes are already valid DCTDecode
// data and are reused as-is (no quality loss, no extra work); anything else
// is normalized to raw RGB(+alpha) samples and Deflate-compressed, mirroring
// how PDF viewers expect PNG-like data to arrive.
fn prepare_image(path: &Path) -> Result<PreparedImage, String> {
    let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let format = image::guess_format(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    let dynamic = image::load_from_memory(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    let width = dynamic.width();
    let height = dynamic.height();

    if format == image::ImageFormat::Jpeg && dynamic.color() == ColorType::Rgb8 {
        return Ok(PreparedImage {
            filter: Filter::DctDecode,
            encoded: data,
            mask: None,
            width,
            height,
        });
    }

    let level = CompressionLevel::DefaultLevel as u8;
    let encoded = compress_to_vec_zlib(dynamic.to_rgb8().as_raw(), level);
    let mask = dynamic.color().has_alpha().then(|| {
        let alphas: Vec<u8> = dynamic.pixels().map(|p| (p.2).0[3]).collect();
        compress_to_vec_zlib(&alphas, level)
    });

    Ok(PreparedImage {
        filter: Filter::FlateDecode,
        encoded,
        mask,
        width,
        height,
    })
}

struct Placement {
    page_index: usize,
    x: f32,
    top: f32,
    w: f32,
    h: f32,
    image_index: usize,
}

// One page per photo, each photo scaled to fill the page's fixed width
// (preserving aspect ratio, and additionally shrunk to fit if that alone
// would exceed the safety cap) with no margin — the page is sized to fit
// the photo exactly.
fn plan_layout(images: &[PreparedImage]) -> (Vec<f32>, Vec<Placement>) {
    let mut placements = Vec::with_capacity(images.len());
    let mut page_heights = Vec::with_capacity(images.len());

    for (i, img) in images.iter().enumerate() {
        let aspect = img.height as f32 / img.width.max(1) as f32;
        let mut w = PAGE_WIDTH_PT;
        let mut h = w * aspect;
        if h > MAX_PAGE_HEIGHT_PT {
            h = MAX_PAGE_HEIGHT_PT;
            w = h / aspect.max(0.0001);
        }

        placements.push(Placement {
            page_index: i,
            x: (PAGE_WIDTH_PT - w) / 2.0,
            top: 0.0,
            w,
            h,
            image_index: i,
        });
        page_heights.push(h);
    }

    (page_heights, placements)
}

pub fn export_images_to_pdf(
    run_id: String,
    image_paths: Vec<String>,
    output_path: String,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<bool, String> {
    let total = image_paths.len();
    let mut done = 0usize;
    on_progress(done, total);

    let mut prepared = Vec::with_capacity(image_paths.len());
    for p in &image_paths {
        if is_cancelled(&run_id) {
            clear_cancelled(&run_id);
            return Ok(false);
        }
        prepared.push(prepare_image(Path::new(p))?);
        done += 1;
        on_progress(done, total);
    }

    if prepared.is_empty() {
        return Err("no images to export".to_string());
    }

    let (page_heights, placements) = plan_layout(&prepared);
    let page_count = page_heights.len();

    let mut next_id: i32 = 0;
    macro_rules! alloc {
        () => {{
            next_id += 1;
            Ref::new(next_id)
        }};
    }

    let mut pdf = Pdf::new();
    let catalog_id = alloc!();
    let page_tree_id = alloc!();
    let image_ids: Vec<(Ref, Option<Ref>)> = prepared
        .iter()
        .map(|img| {
            let id = alloc!();
            let mask_id = if img.mask.is_some() { Some(alloc!()) } else { None };
            (id, mask_id)
        })
        .collect();
    let page_ids: Vec<Ref> = (0..page_count).map(|_| alloc!()).collect();
    let content_ids: Vec<Ref> = (0..page_count).map(|_| alloc!()).collect();

    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id)
        .kids(page_ids.iter().copied())
        .count(page_ids.len() as i32);

    let mut by_page: Vec<Vec<&Placement>> = (0..page_count).map(|_| Vec::new()).collect();
    for p in &placements {
        by_page[p.page_index].push(p);
    }

    for (page_i, page_id) in page_ids.iter().enumerate() {
        let page_height = page_heights[page_i];
        let mut page = pdf.page(*page_id);
        page.media_box(Rect::new(0.0, 0.0, PAGE_WIDTH_PT, page_height));
        page.parent(page_tree_id);
        page.contents(content_ids[page_i]);
        {
            let mut resources = page.resources();
            let mut x_objects = resources.x_objects();
            for placement in &by_page[page_i] {
                let name = format!("Im{}", placement.image_index);
                x_objects.pair(Name(name.as_bytes()), image_ids[placement.image_index].0);
            }
        }
        page.finish();

        let mut content = Content::new();
        for placement in &by_page[page_i] {
            let name = format!("Im{}", placement.image_index);
            let y = page_height - placement.top - placement.h;
            content.save_state();
            content.transform([placement.w, 0.0, 0.0, placement.h, placement.x, y]);
            content.x_object(Name(name.as_bytes()));
            content.restore_state();
        }
        pdf.stream(content_ids[page_i], &content.finish());
    }

    for (i, img) in prepared.iter().enumerate() {
        let (image_id, mask_id) = image_ids[i];
        let mut xobj = pdf.image_xobject(image_id, &img.encoded);
        xobj.filter(img.filter);
        xobj.width(img.width as i32);
        xobj.height(img.height as i32);
        xobj.color_space().device_rgb();
        xobj.bits_per_component(8);
        if let Some(mid) = mask_id {
            xobj.s_mask(mid);
        }
        xobj.finish();

        if let (Some(mask_data), Some(mid)) = (&img.mask, mask_id) {
            let mut s_mask = pdf.image_xobject(mid, mask_data);
            s_mask.filter(img.filter);
            s_mask.width(img.width as i32);
            s_mask.height(img.height as i32);
            s_mask.color_space().device_gray();
            s_mask.bits_per_component(8);
        }
    }

    std::fs::write(&output_path, pdf.finish()).map_err(|e| e.to_string())?;
    clear_cancelled(&run_id);
    Ok(true)
}
