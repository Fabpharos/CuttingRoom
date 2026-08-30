use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Lets the frontend actually kill an in-progress detection run (YOLO
// inference can run for a while and burn real GPU/CPU time — abandoning it
// without killing the process would leave it running pointlessly).
static RUNNING_CHILDREN: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();

fn running_children() -> &'static Mutex<HashMap<String, Child>> {
    RUNNING_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cancel_detection(run_id: &str) {
    if let Some(mut child) = running_children().lock().unwrap().remove(run_id) {
        let _ = child.kill();
    }
}

#[derive(Deserialize)]
struct RawManifest {
    #[serde(rename = "classNames")]
    class_names: std::collections::HashMap<String, String>,
    results: Vec<RawResult>,
}

#[derive(Deserialize)]
struct RawResult {
    path: String,
    width: u32,
    height: u32,
    boxes: Vec<DetectedBox>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub cls: i32,
    pub conf: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub boxes: Vec<DetectedBox>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionOutput {
    pub class_names: std::collections::HashMap<String, String>,
    pub images: Vec<DetectionImage>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectionProgress {
    pub run_id: String,
    pub stage: String, // "loading" | "detecting"
    pub done: usize,
    pub total: usize,
}

pub fn run_detection(
    python_path: String,
    script_path: String,
    input_dir: String,
    model_path: String,
    conf: f32,
    run_id: String,
    mut on_progress: impl FnMut(&str, usize, usize),
) -> Result<DetectionOutput, String> {
    let json_out = std::env::temp_dir().join(format!("cutting-room-detect-{run_id}.json"));

    on_progress("loading", 0, 0);

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path)
        .arg(&input_dir)
        .arg("--model")
        .arg(&model_path)
        .arg("--conf")
        .arg(conf.to_string())
        .arg("--json-out")
        .arg(&json_out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start Python ({python_path}): {e}"))?;

    let stdout = child.stdout.take();
    running_children()
        .lock()
        .unwrap()
        .insert(run_id.clone(), child);

    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("PROGRESS ") {
                let mut parts = rest.split_whitespace();
                if let (Some(done), Some(total)) = (parts.next(), parts.next()) {
                    if let (Ok(done), Ok(total)) = (done.parse(), total.parse()) {
                        on_progress("detecting", done, total);
                    }
                }
            } else if line.trim() == "MODEL_LOADED" {
                on_progress("detecting", 0, 0);
            }
        }
    }

    // If it's gone, cancel_detection already removed and killed it — treat
    // that as a quiet, empty result rather than an error.
    let mut child = match running_children().lock().unwrap().remove(&run_id) {
        Some(child) => child,
        None => {
            let _ = std::fs::remove_file(&json_out);
            return Ok(DetectionOutput {
                class_names: Default::default(),
                images: Vec::new(),
            });
        }
    };

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for Python process: {e}"))?;

    if !status.success() {
        let stderr = child
            .stderr
            .take()
            .map(|s| {
                BufReader::new(s)
                    .lines()
                    .map_while(Result::ok)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let _ = std::fs::remove_file(&json_out);
        return Err(format!("detection script failed: {stderr}"));
    }

    let raw = std::fs::read_to_string(&json_out)
        .map_err(|e| format!("couldn't read detection output: {e}"))?;
    let _ = std::fs::remove_file(&json_out);
    let manifest: RawManifest =
        serde_json::from_str(&raw).map_err(|e| format!("couldn't parse detection output: {e}"))?;

    Ok(DetectionOutput {
        class_names: manifest.class_names,
        images: manifest
            .results
            .into_iter()
            .map(|r| DetectionImage {
                path: r.path,
                width: r.width,
                height: r.height,
                boxes: r.boxes,
            })
            .collect(),
    })
}

#[derive(Deserialize)]
pub struct PixelateBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

#[derive(Deserialize)]
pub struct PixelateJob {
    pub path: String,
    pub boxes: Vec<PixelateBox>,
}

fn pixelate_region(img: &mut image::RgbaImage, x1: u32, y1: u32, x2: u32, y2: u32, block_size: u32) {
    let (img_w, img_h) = img.dimensions();
    let x2 = x2.min(img_w);
    let y2 = y2.min(img_h);
    if x2 <= x1 || y2 <= y1 {
        return;
    }
    let w = x2 - x1;
    let h = y2 - y1;
    let small_w = (w / block_size.max(1)).max(1);
    let small_h = (h / block_size.max(1)).max(1);

    let region = image::imageops::crop(img, x1, y1, w, h).to_image();
    let small = image::imageops::resize(&region, small_w, small_h, FilterType::Triangle);
    let blocky = image::imageops::resize(&small, w, h, FilterType::Nearest);
    image::imageops::replace(img, &blocky, x1 as i64, y1 as i64);
}

pub fn apply_pixelation(
    jobs: Vec<PixelateJob>,
    output_dir: String,
    block_size: u32,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<(), String> {
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let total = jobs.len();

    for (i, job) in jobs.into_iter().enumerate() {
        let file_name = Path::new(&job.path)
            .file_name()
            .ok_or_else(|| format!("invalid path: {}", job.path))?;
        let dest = Path::new(&output_dir).join(file_name);

        if job.boxes.is_empty() {
            std::fs::copy(&job.path, &dest).map_err(|e| format!("{}: {e}", job.path))?;
        } else {
            let img = image::open(&job.path).map_err(|e| format!("{}: {e}", job.path))?;
            let mut rgba = img.to_rgba8();
            for b in &job.boxes {
                pixelate_region(
                    &mut rgba,
                    b.x1.max(0.0) as u32,
                    b.y1.max(0.0) as u32,
                    b.x2.max(0.0) as u32,
                    b.y2.max(0.0) as u32,
                    block_size,
                );
            }
            image::DynamicImage::ImageRgba8(rgba)
                .save(&dest)
                .map_err(|e| format!("{}: {e}", job.path))?;
        }

        on_progress(i + 1, total);
    }

    Ok(())
}
