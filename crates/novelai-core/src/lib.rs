use base64::Engine;
use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const API_BASE: &str = "https://image.novelai.net";
const KEYRING_SERVICE: &str = "CuttingRoom.NovelAI";
const KEYRING_USER: &str = "api-token";
// NovelAI subscription tiers: 0 Paper, 1 Tablet, 2 Scroll, 3 Opus. Only
// Opus generates small, default-settings images without spending Anlas.
const OPUS_TIER: i64 = 3;

// Windows Credential Manager doesn't reliably sequence operations on the
// same entry issued from different threads, so every token read/write goes
// through this one lock.
static TOKEN_LOCK: Mutex<()> = Mutex::new(());
static STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(reqwest::Client::new)
}

fn entry() -> Result<Entry, String> {
    STORE_INIT
        .get_or_init(|| {
            windows_native_keyring_store::Store::new()
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|e| format!("couldn't open Windows Credential Manager: {e}"))
        })
        .clone()?;
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn read_token() -> Result<Option<String>, String> {
    let _guard = TOKEN_LOCK.lock().unwrap();
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("couldn't read the saved token: {e}")),
    }
}

fn write_token(token: &str) -> Result<(), String> {
    let _guard = TOKEN_LOCK.lock().unwrap();
    entry()?
        .set_password(token)
        .map_err(|e| format!("couldn't save the token: {e}"))
}

fn delete_token() -> Result<(), String> {
    let _guard = TOKEN_LOCK.lock().unwrap();
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("couldn't remove the saved token: {e}")),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct TrainingStepsLeft {
    fixed_training_steps_left: i64,
    purchased_training_steps: i64,
}

// Opus's quota for usage-limited models (V5): a refilling percentage
// rather than a count. V4/V4.5 don't draw from it.
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageStatus {
    /// True once the quota is used up.
    pub is_negative: bool,
    pub percent: i64,
    pub purchased_percent: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionResponse {
    #[serde(default)]
    tier: i64,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    training_steps_left: TrainingStepsLeft,
    #[serde(default)]
    usage: Option<UsageStatus>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub tier: i64,
    pub tier_name: String,
    pub active: bool,
    pub is_opus: bool,
    pub anlas: i64,
    pub usage: Option<UsageStatus>,
}

fn tier_name(tier: i64) -> String {
    match tier {
        0 => "Paper",
        1 => "Tablet",
        2 => "Scroll",
        3 => "Opus",
        _ => "Unknown",
    }
    .to_string()
}

async fn fetch_status(token: &str) -> Result<AccountStatus, String> {
    let resp = http()
        .get(format!("{API_BASE}/user/subscription"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("couldn't reach NovelAI: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("NovelAI rejected this token. Check that it's a valid API token.".into());
    }
    if !status.is_success() {
        let message = resp
            .json::<ApiError>()
            .await
            .ok()
            .and_then(|e| e.message)
            .unwrap_or_default();
        return Err(format!("NovelAI returned {status}: {message}"));
    }

    let sub: SubscriptionResponse = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response from NovelAI: {e}"))?;
    Ok(AccountStatus {
        tier: sub.tier,
        tier_name: tier_name(sub.tier),
        active: sub.active,
        is_opus: sub.active && sub.tier == OPUS_TIER,
        anlas: sub.training_steps_left.fixed_training_steps_left
            + sub.training_steps_left.purchased_training_steps,
        usage: sub.usage,
    })
}

/// Account status for the saved token, or `None` when no token is saved.
pub async fn account_status() -> Result<Option<AccountStatus>, String> {
    let token = tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())??;
    match token {
        Some(token) => fetch_status(&token).await.map(Some),
        None => Ok(None),
    }
}

/// Validates the token against NovelAI before saving it, so a typo never
/// replaces a working token.
pub async fn set_token(token: String) -> Result<AccountStatus, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Enter an API token.".into());
    }
    let status = fetch_status(&token).await?;
    tokio::task::spawn_blocking(move || write_token(&token))
        .await
        .map_err(|e| e.to_string())??;
    Ok(status)
}

pub async fn clear_token() -> Result<(), String> {
    tokio::task::spawn_blocking(delete_token)
        .await
        .map_err(|e| e.to_string())?
}

// NovelAI's own rule for a free Opus generation (from its web client):
// at most 1024x1024 worth of pixels and at most 28 steps, one image per
// request. The sizes and step cap below keep every request inside it;
// guidance doesn't affect cost.
pub const ALLOWED_SIZES: [(u32, u32); 3] = [(832, 1216), (1216, 832), (1024, 1024)];
pub const MAX_STEPS: u32 = 28;
pub const MAX_GUIDANCE: f64 = 10.0;
pub const MAX_CHARACTERS: usize = 4;

// All supported models are V4-family: character prompts go through
// `v4_prompt`.
pub const MODELS: [&str; 7] = [
    "nai-diffusion-5-full",
    "nai-diffusion-5-full-medium",
    "nai-diffusion-5-curated",
    "nai-diffusion-4-5-full",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-full",
    "nai-diffusion-4-curated-preview",
];
/// V5 models draw from Opus's refilling quota instead of being unlimited.
pub fn is_usage_limited(model: &str) -> bool {
    model.starts_with("nai-diffusion-5")
}

// V5 Full (Medium Effort) only runs at a fixed step count.
pub const MEDIUM_MODEL: &str = "nai-diffusion-5-full-medium";
pub const MEDIUM_STEPS: u32 = 14;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub characters: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub scale: f64,
    pub seed: u32,
    pub file_stem: String,
    #[serde(default)]
    pub vibes: Vec<VibeRef>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub path: String,
    pub seed: u32,
}

#[derive(Deserialize)]
struct ImageJson {
    image: String,
}

#[derive(Deserialize)]
struct ImageGenerationJsonResponse {
    images: Vec<ImageJson>,
}

fn build_body(req: &GenerateRequest, vibes: &[ResolvedVibe]) -> Result<serde_json::Value, String> {
    if !ALLOWED_SIZES.contains(&(req.width, req.height)) {
        return Err(format!(
            "{}x{} isn't one of the allowed sizes (832x1216, 1216x832, 1024x1024).",
            req.width, req.height
        ));
    }
    if !MODELS.contains(&req.model.as_str()) {
        return Err(format!("Unknown model: {}", req.model));
    }
    let steps = if req.model == MEDIUM_MODEL { MEDIUM_STEPS } else { req.steps };
    if !(1..=MAX_STEPS).contains(&steps) {
        return Err(format!(
            "Steps must be between 1 and {MAX_STEPS}; more than {MAX_STEPS} costs Anlas."
        ));
    }
    if !(0.0..=MAX_GUIDANCE).contains(&req.scale) || req.scale.is_nan() {
        return Err(format!("Guidance must be between 0 and {MAX_GUIDANCE}."));
    }
    let characters: Vec<&str> = req
        .characters
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();
    if characters.len() > MAX_CHARACTERS {
        return Err(format!("At most {MAX_CHARACTERS} character prompts are allowed."));
    }

    // Character positions are left to the model (use_coords: false); the
    // center is still required by the schema.
    let center = json!([{ "x": 0.5, "y": 0.5 }]);
    let char_captions: Vec<_> = characters
        .iter()
        .map(|c| json!({ "char_caption": c, "centers": center }))
        .collect();
    let neg_char_captions: Vec<_> = characters
        .iter()
        .map(|_| json!({ "char_caption": "", "centers": center }))
        .collect();

    let mut parameters = json!({
        "params_version": 4,
        "width": req.width,
        "height": req.height,
        "steps": steps,
        "scale": req.scale,
        "n_samples": 1,
        "seed": req.seed,
        "sampler": "k_euler_ancestral",
        "noise_schedule": "karras",
        "negative_prompt": req.negative_prompt,
        // NovelAI's web app appends its own quality tags when this is on;
        // keep it off so the prompt sent is exactly what was typed.
        "qualityToggle": false,
        "v4_prompt": {
            "caption": { "base_caption": req.prompt, "char_captions": char_captions },
            "use_coords": false,
            "use_order": true,
        },
        "v4_negative_prompt": {
            "caption": { "base_caption": req.negative_prompt, "char_captions": neg_char_captions },
            "legacy_uc": false,
        },
    });
    // Pre-encoded vibes go in as-is, the way NovelAI's web client sends
    // them; there's nothing for NovelAI to encode (or charge for).
    if !vibes.is_empty() {
        parameters["reference_image_multiple"] =
            json!(vibes.iter().map(|v| v.encoding.as_str()).collect::<Vec<_>>());
        parameters["reference_strength_multiple"] =
            json!(vibes.iter().map(|v| v.strength).collect::<Vec<_>>());
    }

    Ok(json!({
        "input": req.prompt,
        "model": req.model,
        "action": "generate",
        "parameters": parameters,
    }))
}

fn error_for_status(status: reqwest::StatusCode, message: &str) -> String {
    match status.as_u16() {
        401 => "NovelAI rejected the saved token. Log out and log in again.".into(),
        402 => "NovelAI says this would cost more Anlas than the account has.".into(),
        429 => "NovelAI is rate-limiting requests. Wait a moment and try again.".into(),
        _ if message.is_empty() => format!("NovelAI returned {status}."),
        _ => format!("NovelAI returned {status}: {message}"),
    }
}

// Writes `bytes` as `<stem>.png` in `dir`, numbering the name instead of
// overwriting if it's taken.
fn save_png(dir: &Path, stem: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create the output folder: {e}"))?;
    let mut path = dir.join(format!("{stem}.png"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).png"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("couldn't save the image: {e}"))?;
    Ok(path)
}

// ---- Batches ----

pub const MAX_BATCH: usize = 25;
// Minimum gap between the end of one generation request and the start of the
// next, across every batch and single generation, so nothing this app does
// can hammer NovelAI's servers.
const MIN_INTERVAL: Duration = Duration::from_secs(2);
static LAST_GENERATION: Mutex<Option<Instant>> = Mutex::new(None);
static CANCELLED_BATCHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_set() -> &'static Mutex<HashSet<String>> {
    CANCELLED_BATCHES.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn cancel_batch(run_id: &str) {
    cancelled_set().lock().unwrap().insert(run_id.to_string());
}

fn is_cancelled(run_id: &str) -> bool {
    cancelled_set().lock().unwrap().contains(run_id)
}

/// Waits until the minimum interval since the last generation has passed.
/// Returns false if the batch was cancelled while waiting.
async fn wait_for_turn(run_id: &str) -> bool {
    loop {
        if is_cancelled(run_id) {
            return false;
        }
        let remaining = LAST_GENERATION
            .lock()
            .unwrap()
            .map(|t| MIN_INTERVAL.saturating_sub(t.elapsed()))
            .unwrap_or(Duration::ZERO);
        if remaining.is_zero() {
            return true;
        }
        // Short naps so a cancel during the wait takes effect promptly.
        tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
    pub image: Option<GeneratedImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub images: Vec<GeneratedImage>,
    pub cancelled: bool,
    /// Set when the batch stopped early for a reason other than cancelling.
    pub stopped_reason: Option<String>,
}

fn validate_file_stem(stem: &str) -> Result<(), String> {
    // The stem comes from the frontend; refuse anything that could steer
    // the file outside the chosen folder.
    if stem.is_empty()
        || stem.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || stem.contains("..")
    {
        return Err("Invalid output file name.".into());
    }
    Ok(())
}

/// Checks the whole batch before anything is sent, so a bad request at
/// position 7 can't fail the batch after six images were already made.
/// Reads any vibe files the requests use, so call it off the async runtime.
fn validate_batch(requests: &[GenerateRequest]) -> Result<Vec<serde_json::Value>, String> {
    if requests.is_empty() {
        return Err("Nothing to generate.".into());
    }
    if requests.len() > MAX_BATCH {
        return Err(format!("A batch can be at most {MAX_BATCH} images."));
    }
    let mut files = VibeFiles::new();
    requests
        .iter()
        .map(|r| {
            validate_file_stem(&r.file_stem)?;
            let vibes = resolve_vibes(&r.model, &r.vibes, &mut files)?;
            build_body(r, &vibes)
        })
        .collect()
}

/// Generates each request in order, at least `MIN_INTERVAL` apart.
///
/// With `guard_anlas`, the balance is checked before the batch and after
/// every image, and the batch stops the moment it drops. That's for accounts
/// where every request should be free: it catches an unexpected charge, such
/// as Opus's V5 quota running out mid-batch, after at most one image.
pub async fn generate_batch(
    run_id: String,
    requests: Vec<GenerateRequest>,
    output_dir: String,
    guard_anlas: bool,
    mut on_progress: impl FnMut(BatchProgress),
) -> Result<BatchSummary, String> {
    let requests = std::sync::Arc::new(requests);
    let bodies = {
        let requests = requests.clone();
        tokio::task::spawn_blocking(move || validate_batch(&requests))
            .await
            .map_err(|e| e.to_string())??
    };
    let token = tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())??
        .ok_or("Log in to NovelAI first.")?;

    let mut anlas = if guard_anlas {
        Some(fetch_status(&token).await?.anlas)
    } else {
        None
    };

    let total = requests.len();
    let dir = PathBuf::from(output_dir);
    let mut images = Vec::new();
    let mut cancelled = false;
    let mut stopped_reason = None;
    on_progress(BatchProgress { run_id: run_id.clone(), done: 0, total, image: None });

    for (req, body) in requests.iter().zip(&bodies) {
        if !wait_for_turn(&run_id).await {
            cancelled = true;
            break;
        }
        let result = generate_one(&token, body, req, &dir).await;
        *LAST_GENERATION.lock().unwrap() = Some(Instant::now());

        match result {
            Ok(image) => {
                images.push(image.clone());
                on_progress(BatchProgress {
                    run_id: run_id.clone(),
                    done: images.len(),
                    total,
                    image: Some(image),
                });
            }
            Err(e) => {
                stopped_reason = Some(e);
                break;
            }
        }

        if let Some(before) = anlas {
            match fetch_status(&token).await {
                Ok(s) if s.anlas < before => {
                    stopped_reason = Some(format!(
                        "NovelAI charged {} Anlas for that image, so the batch stopped. \
                         If you're using a V5 model, the Opus V5 quota may have run out.",
                        before - s.anlas
                    ));
                    break;
                }
                Ok(s) => anlas = Some(s.anlas),
                Err(e) => {
                    stopped_reason =
                        Some(format!("Couldn't confirm the Anlas balance, so the batch stopped: {e}"));
                    break;
                }
            }
        }
    }

    cancelled_set().lock().unwrap().remove(&run_id);
    Ok(BatchSummary { images, cancelled, stopped_reason })
}

async fn generate_one(
    token: &str,
    body: &serde_json::Value,
    req: &GenerateRequest,
    dir: &Path,
) -> Result<GeneratedImage, String> {
    let resp = http()
        .post(format!("{API_BASE}/ai/generate-image"))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach NovelAI: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let message = resp
            .json::<ApiError>()
            .await
            .ok()
            .and_then(|e| e.message)
            .unwrap_or_default();
        return Err(error_for_status(status, &message));
    }

    let parsed: ImageGenerationJsonResponse = resp
        .json()
        .await
        .map_err(|e| format!("unexpected response from NovelAI: {e}"))?;
    let first = parsed
        .images
        .into_iter()
        .next()
        .ok_or("NovelAI returned no image.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(first.image)
        .map_err(|e| format!("couldn't decode the returned image: {e}"))?;

    let dir = dir.to_path_buf();
    let stem = req.file_stem.clone();
    let path = tokio::task::spawn_blocking(move || save_png(&dir, &stem, &bytes))
        .await
        .map_err(|e| e.to_string())??;

    Ok(GeneratedImage {
        path: path.to_string_lossy().into_owned(),
        seed: req.seed,
    })
}

// ---- Importing settings from a NovelAI image's metadata ----
//
// NovelAI stamps generated PNGs with text chunks: "Software" ("NovelAI"),
// "Source" (model name + hash), "Description" (prompt), and "Comment" (the
// full request parameters as JSON).

/// Settings read from an image. Fields are what the image says; the
/// frontend decides which of them this tab can actually apply.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSettings {
    pub prompt: String,
    pub negative_prompt: String,
    pub characters: Vec<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub steps: Option<u32>,
    pub scale: Option<f64>,
    pub seed: Option<u64>,
    /// Our model ID, if the image's model is one this tab supports.
    pub model: Option<String>,
    /// The image's own model description, e.g. "NovelAI Diffusion V5 DB276663".
    pub source: Option<String>,
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

// tEXt is Latin-1 by spec, but encoders commonly write UTF-8 into it.
fn decode_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    miniz_oxide::inflate::decompress_to_vec_zlib(bytes).ok()
}

/// Every tEXt / zTXt / iTXt chunk in a PNG as (keyword, text).
fn png_text_chunks(data: &[u8]) -> Result<Vec<(String, String)>, String> {
    if data.len() < 8 || data[..8] != PNG_SIGNATURE {
        return Err("That file isn't a PNG.".into());
    }
    let mut out = Vec::new();
    let mut pos = 8;
    while pos + 8 <= data.len() {
        let len = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        let kind = &data[pos + 4..pos + 8];
        let start = pos + 8;
        let Some(end) = start.checked_add(len).filter(|&e| e <= data.len()) else {
            break; // truncated file; keep whatever was read
        };
        let body = &data[start..end];
        let keyword_end = body.iter().position(|&b| b == 0);
        match (kind, keyword_end) {
            (b"tEXt", Some(k)) => {
                out.push((decode_text(&body[..k]), decode_text(&body[k + 1..])));
            }
            (b"zTXt", Some(k)) if body.len() > k + 2 => {
                if let Some(text) = inflate(&body[k + 2..]) {
                    out.push((decode_text(&body[..k]), decode_text(&text)));
                }
            }
            (b"iTXt", Some(k)) if body.len() > k + 3 => {
                let compressed = body[k + 1] == 1;
                // Skip language tag and translated keyword (both NUL-terminated).
                let rest = &body[k + 3..];
                let mut nul = rest.iter().enumerate().filter(|(_, &b)| b == 0).map(|(i, _)| i);
                if let (Some(_), Some(second)) = (nul.next(), nul.next()) {
                    let text = &rest[second + 1..];
                    let text = if compressed { inflate(text) } else { Some(text.to_vec()) };
                    if let Some(text) = text {
                        out.push((decode_text(&body[..k]), decode_text(&text)));
                    }
                }
            }
            (b"IEND", _) => break,
            _ => {}
        }
        pos = end + 4; // skip CRC
    }
    Ok(out)
}

/// Maps a "Source" string to one of our model IDs, mirroring NovelAI's own
/// web client. Returns None for models this tab doesn't offer (V3 and older).
fn model_from_source(source: &str) -> Option<&'static str> {
    let hash = source.rsplit(' ').next().unwrap_or("");
    if source.contains("NovelAI Diffusion V5") {
        return Some(match hash {
            "657484A5" | "0ADF9AB7" => "nai-diffusion-5-full",
            "93F4BD30" | "70AB5786" => "nai-diffusion-5-full-medium",
            _ => "nai-diffusion-5-curated",
        });
    }
    if source.contains("NovelAI Diffusion V4") || source.contains("DiffusionModelMetaName.NAIv4next") {
        return Some(match hash {
            "4BDE2A90" | "1229B44F" | "B9F340FD" | "F3D95188" => "nai-diffusion-4-5-full",
            "C02D4F98" | "5AB81C7C" | "B5A2A797" => "nai-diffusion-4-5-curated",
            "37442FCA" | "4F49EC75" | "CA4B7203" | "79F47848" | "F6302A9D" => "nai-diffusion-4-full",
            "7ABFFA2A" | "C1CCBA86" | "770A9E12" => "nai-diffusion-4-curated-preview",
            _ if source.contains("V4.5") => "nai-diffusion-4-5-curated",
            _ => "nai-diffusion-4-curated-preview",
        });
    }
    None
}

fn parse_settings(chunks: &[(String, String)]) -> Result<ImportedSettings, String> {
    let get = |key: &str| chunks.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());

    let comment = get("Comment")
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .filter(|_| get("Software") == Some("NovelAI") || get("Source").is_some());
    let Some(c) = comment else {
        return Err("This image doesn't have NovelAI generation settings in it.".into());
    };

    let caption = |key: &str| c.get(key).and_then(|p| p.get("caption"));
    let str_at = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_string);

    let prompt = str_at(caption("v4_prompt").and_then(|cap| cap.get("base_caption")))
        .or_else(|| str_at(c.get("prompt")))
        .or_else(|| get("Description").map(str::to_string))
        .unwrap_or_default();
    let negative_prompt = str_at(caption("v4_negative_prompt").and_then(|cap| cap.get("base_caption")))
        .or_else(|| str_at(c.get("uc")))
        .unwrap_or_default();
    let characters = caption("v4_prompt")
        .and_then(|cap| cap.get("char_captions"))
        .and_then(|cc| cc.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ch| ch.get("char_caption").and_then(|s| s.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let num = |key: &str| c.get(key).and_then(|v| v.as_f64());
    let source = get("Source").map(str::to_string);
    Ok(ImportedSettings {
        prompt,
        negative_prompt,
        characters,
        width: num("width").map(|v| v as u32),
        height: num("height").map(|v| v as u32),
        steps: num("steps").map(|v| v as u32),
        scale: num("scale"),
        seed: c.get("seed").and_then(|v| v.as_u64()),
        model: source.as_deref().and_then(model_from_source).map(str::to_string),
        source,
    })
}

pub async fn read_image_metadata(path: String) -> Result<ImportedSettings, String> {
    tokio::task::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| format!("couldn't read the image: {e}"))?;
        parse_settings(&png_text_chunks(&data)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Prompt files ----

/// One prompt segment per line; blank lines are skipped. Handles Windows
/// line endings and a leading byte-order mark, which Notepad adds.
fn parse_prompt_lines(text: &str) -> Vec<String> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

pub async fn read_prompt_file(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("couldn't read the file: {e}"))?;
        let lines = parse_prompt_lines(&String::from_utf8_lossy(&bytes));
        if lines.is_empty() {
            return Err("That file has no prompts in it (it's empty or only blank lines).".into());
        }
        Ok(lines)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Vibe Transfer ----
//
// Only vibes that are already encoded are used: `.naiv4vibe` and
// `.naiv4vibebundle` files exported from NovelAI, or a PNG with vibes
// embedded in it. NovelAI's web client prices encoding an image at 2 Anlas
// and every vibe past the fourth at 2 more, so this never asks NovelAI to
// encode anything and never sends more than four vibes.

pub const MAX_FREE_VIBES: usize = 4;
/// NovelAI's own default for a vibe with no strength recorded.
pub const DEFAULT_VIBE_STRENGTH: f64 = 0.6;

/// The key a vibe file keeps a model's encodings under, as NovelAI's web
/// client names them. V5 doesn't support Vibe Transfer yet, so it has none.
pub fn vibe_encoding_key(model: &str) -> Option<&'static str> {
    match model {
        "nai-diffusion-4-5-full" => Some("v4-5full"),
        "nai-diffusion-4-5-curated" => Some("v4-5curated"),
        "nai-diffusion-4-full" => Some("v4full"),
        "nai-diffusion-4-curated-preview" => Some("v4curated"),
        _ => None,
    }
}

fn model_for_encoding_key(key: &str) -> Option<&'static str> {
    MODELS.iter().copied().find(|m| vibe_encoding_key(m) == Some(key))
}

/// A vibe the user picked: which file, which vibe in it, and how to use it.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VibeRef {
    pub path: String,
    /// Position in the file; a bundle holds several vibes.
    pub index: usize,
    /// Picks between encodings when the file has several for the model.
    pub information_extracted: Option<f64>,
    pub strength: f64,
}

// The JSON NovelAI's web client writes, trimmed to the fields used here.
#[derive(Deserialize)]
struct VibeParamsJson {
    information_extracted: Option<f64>,
}

#[derive(Deserialize)]
struct VibeEncodingJson {
    encoding: String,
    params: Option<VibeParamsJson>,
}

#[derive(Deserialize)]
struct VibeImportInfoJson {
    model: Option<String>,
    information_extracted: Option<f64>,
    strength: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VibeJson {
    name: Option<String>,
    thumbnail: Option<String>,
    /// Encoding key ("v4-5full") -> one entry per set of encode settings.
    #[serde(default)]
    encodings: BTreeMap<String, BTreeMap<String, VibeEncodingJson>>,
    import_info: Option<VibeImportInfoJson>,
}

#[derive(Deserialize)]
struct VibeBundleJson {
    vibes: Vec<VibeJson>,
}

impl VibeJson {
    fn display_name(&self, index: usize) -> String {
        match self.name.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => format!("Vibe {}", index + 1),
        }
    }

    // An encoding made from an image records its settings; one exported as
    // a bare encoding doesn't, but the file's import info says what it was.
    fn information_extracted(&self, key: &str, entry: &VibeEncodingJson) -> Option<f64> {
        entry.params.as_ref().and_then(|p| p.information_extracted).or_else(|| {
            let info = self.import_info.as_ref()?;
            let model = info.model.as_deref()?;
            (vibe_encoding_key(model) == Some(key)).then_some(info.information_extracted)?
        })
    }
}

const NOT_A_VIBE_FILE: &str = "That isn't a NovelAI vibe file (.naiv4vibe or .naiv4vibebundle).";

fn parse_vibes(text: &str) -> Result<Vec<VibeJson>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| NOT_A_VIBE_FILE)?;
    let damaged = |e: serde_json::Error| format!("That vibe file is damaged: {e}");
    let vibes = match value.get("identifier").and_then(|v| v.as_str()) {
        Some("novelai-vibe-transfer") => vec![serde_json::from_value(value).map_err(damaged)?],
        Some("novelai-vibe-transfer-bundle") => {
            serde_json::from_value::<VibeBundleJson>(value).map_err(damaged)?.vibes
        }
        _ => return Err(NOT_A_VIBE_FILE.into()),
    };
    if vibes.is_empty() {
        return Err("That vibe bundle is empty.".into());
    }
    Ok(vibes)
}

fn load_vibe_file(path: &str) -> Result<Vec<VibeJson>, String> {
    let data = std::fs::read(path).map_err(|e| format!("couldn't read the vibe file: {e}"))?;
    if data.starts_with(&PNG_SIGNATURE) {
        // NovelAI can embed the vibes an image used in its metadata.
        let naidata = png_text_chunks(&data)?
            .into_iter()
            .find(|(k, _)| k == "naidata")
            .ok_or("This image doesn't have any vibes embedded in it.")?;
        let json = base64::engine::general_purpose::STANDARD
            .decode(naidata.1.trim())
            .map_err(|_| "This image's embedded vibes are damaged.")?;
        return parse_vibes(&String::from_utf8_lossy(&json));
    }
    parse_vibes(&String::from_utf8_lossy(&data))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VibeEncodingInfo {
    /// Our model ID.
    pub model: String,
    pub information_extracted: Option<f64>,
}

/// What the frontend shows for one vibe. The encodings themselves stay in
/// Rust: generation reads them from the file again, so nothing but a file's
/// own encodings can ever be sent.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VibeInfo {
    pub index: usize,
    pub name: String,
    /// A data: URL, when the file has a reasonably small one.
    pub thumbnail: Option<String>,
    /// Usable encodings, in the order generation picks from them.
    pub encodings: Vec<VibeEncodingInfo>,
    /// The settings the vibe was exported with, if recorded.
    pub strength: Option<f64>,
    pub information_extracted: Option<f64>,
}

const MAX_THUMBNAIL_LEN: usize = 512 * 1024;

fn vibe_info(index: usize, vibe: &VibeJson) -> VibeInfo {
    let encodings = vibe
        .encodings
        .iter()
        .filter_map(|(key, entries)| model_for_encoding_key(key).map(|model| (key, model, entries)))
        .flat_map(|(key, model, entries)| {
            entries.values().map(move |e| VibeEncodingInfo {
                model: model.to_string(),
                information_extracted: vibe.information_extracted(key, e),
            })
        })
        .collect();
    let thumbnail = vibe
        .thumbnail
        .clone()
        .filter(|t| t.starts_with("data:image/") && t.contains(";base64,") && t.len() <= MAX_THUMBNAIL_LEN);
    let info = vibe.import_info.as_ref();
    VibeInfo {
        index,
        name: vibe.display_name(index),
        thumbnail,
        encodings,
        strength: info.and_then(|i| i.strength).filter(|s| (0.0..=1.0).contains(s)),
        information_extracted: info.and_then(|i| i.information_extracted),
    }
}

/// The encoding a vibe would use with `model`: the one with the requested
/// information extracted, else the first. None when it has no encoding for
/// the model, since using it would mean a paid encode. Picks the same way as
/// `resolve_vibes` and the app's `vibeEncodingFor`.
pub fn vibe_encoding_for<'a>(
    info: &'a VibeInfo,
    model: &str,
    information_extracted: Option<f64>,
) -> Option<&'a VibeEncodingInfo> {
    let mut options = info.encodings.iter().filter(|e| e.model == model);
    let first = options.clone().next();
    options
        .find(|e| match (e.information_extracted, information_extracted) {
            (Some(a), Some(b)) => (a - b).abs() < 1e-6,
            (None, None) => true,
            _ => false,
        })
        .or(first)
}

pub async fn read_vibe_file(path: String) -> Result<Vec<VibeInfo>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(load_vibe_file(&path)?.iter().enumerate().map(|(i, v)| vibe_info(i, v)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

struct ResolvedVibe {
    encoding: String,
    strength: f64,
}

/// Vibe files read so far in a batch, by path.
type VibeFiles = HashMap<String, Vec<VibeJson>>;

// An encoding is opaque model data. If a file's "encoding" were really an
// image, NovelAI would encode it and charge for that, so refuse it.
fn check_encoding(encoding: &str, name: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoding.trim())
        .map_err(|_| format!("The vibe \"{name}\" has a damaged encoding."))?;
    let is_image = bytes.starts_with(&PNG_SIGNATURE)
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"GIF8")
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP");
    if bytes.is_empty() || is_image {
        return Err(format!(
            "The vibe \"{name}\" holds an image rather than an encoding. Encoding it would cost Anlas."
        ));
    }
    Ok(())
}

fn resolve_vibes(
    model: &str,
    refs: &[VibeRef],
    files: &mut VibeFiles,
) -> Result<Vec<ResolvedVibe>, String> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let key = vibe_encoding_key(model)
        .ok_or_else(|| format!("{model} doesn't support Vibe Transfer."))?;
    if refs.len() > MAX_FREE_VIBES {
        return Err(format!(
            "At most {MAX_FREE_VIBES} vibes can be used at once; each one past the fourth costs Anlas."
        ));
    }
    refs.iter()
        .map(|r| {
            if !(0.0..=1.0).contains(&r.strength) {
                return Err("Vibe strength must be between 0 and 1.".to_string());
            }
            if !files.contains_key(&r.path) {
                files.insert(r.path.clone(), load_vibe_file(&r.path)?);
            }
            let vibe = files[&r.path]
                .get(r.index)
                .ok_or_else(|| format!("{} doesn't have a vibe #{}.", r.path, r.index + 1))?;
            let name = vibe.display_name(r.index);
            let entries = vibe.encodings.get(key).filter(|e| !e.is_empty()).ok_or_else(|| {
                format!(
                    "The vibe \"{name}\" isn't encoded for {model}. Encoding it would cost Anlas, \
                     so it can't be used with this model."
                )
            })?;
            // Mirrors vibeEncodingFor on the frontend, so the encoding sent is
            // the one shown.
            let entry = match r.information_extracted {
                None => entries
                    .values()
                    .find(|e| vibe.information_extracted(key, e).is_none())
                    .or_else(|| entries.values().next()),
                Some(ie) => entries.values().find(|e| {
                    vibe.information_extracted(key, e).is_some_and(|x| (x - ie).abs() < 1e-6)
                }),
            }
            .ok_or_else(|| {
                format!("The vibe \"{name}\" has no {model} encoding with that information extracted.")
            })?;
            check_encoding(&entry.encoding, &name)?;
            Ok(ResolvedVibe { encoding: entry.encoding.trim().to_string(), strength: r.strength })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(model: &str, width: u32, height: u32, characters: &[&str]) -> GenerateRequest {
        GenerateRequest {
            model: model.into(),
            prompt: "1girl".into(),
            negative_prompt: "lowres".into(),
            characters: characters.iter().map(|c| c.to_string()).collect(),
            width,
            height,
            steps: 28,
            scale: 5.0,
            seed: 42,
            file_stem: "out".into(),
            vibes: vec![],
        }
    }

    fn body_of(req: &GenerateRequest) -> Result<serde_json::Value, String> {
        build_body(req, &[])
    }

    #[test]
    fn sends_requested_steps_and_guidance_with_one_sample() {
        let mut req = request("nai-diffusion-5-full", 1216, 832, &[]);
        req.steps = 20;
        req.scale = 6.5;
        let body = body_of(&req).unwrap();
        let p = &body["parameters"];
        assert_eq!(p["steps"], 20);
        assert_eq!(p["scale"], 6.5);
        assert_eq!(p["n_samples"], 1);
        assert_eq!((p["width"].as_u64(), p["height"].as_u64()), (Some(1216), Some(832)));
        assert_eq!(body["action"], "generate");
    }

    #[test]
    fn rejects_steps_above_the_free_limit() {
        let mut req = request("nai-diffusion-4-5-full", 1024, 1024, &[]);
        req.steps = 29;
        assert!(body_of(&req).is_err());
        req.steps = 0;
        assert!(body_of(&req).is_err());
    }

    #[test]
    fn rejects_guidance_out_of_range() {
        let mut req = request("nai-diffusion-4-5-full", 1024, 1024, &[]);
        req.scale = 10.5;
        assert!(body_of(&req).is_err());
        req.scale = -1.0;
        assert!(body_of(&req).is_err());
    }

    #[test]
    fn medium_effort_always_runs_at_its_fixed_steps() {
        let body = body_of(&request("nai-diffusion-5-full-medium", 1024, 1024, &[])).unwrap();
        assert_eq!(body["parameters"]["steps"], 14);
    }

    #[test]
    fn rejects_sizes_outside_the_allowed_three() {
        assert!(body_of(&request("nai-diffusion-4-5-full", 1024, 1536, &[])).is_err());
        assert!(body_of(&request("nai-diffusion-4-5-full", 2048, 2048, &[])).is_err());
    }

    #[test]
    fn rejects_unknown_and_removed_models() {
        assert!(body_of(&request("some-other-model", 1024, 1024, &[])).is_err());
        assert!(body_of(&request("nai-diffusion-3", 1024, 1024, &[])).is_err());
    }

    #[test]
    fn characters_go_in_v4_prompt_with_blank_ones_dropped() {
        let body =
            body_of(&request("nai-diffusion-5-full", 832, 1216, &["girl, red hair", "  "]))
                .unwrap();
        let chars = body["parameters"]["v4_prompt"]["caption"]["char_captions"]
            .as_array()
            .unwrap();
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0]["char_caption"], "girl, red hair");
        let neg = body["parameters"]["v4_negative_prompt"]["caption"]["char_captions"]
            .as_array()
            .unwrap();
        assert_eq!(neg.len(), 1);
    }

    #[test]
    fn caps_characters_at_four() {
        let five = ["a", "b", "c", "d", "e"];
        assert!(body_of(&request("nai-diffusion-4-5-full", 1024, 1024, &five)).is_err());
    }

    // ---- batches ----

    #[test]
    fn batch_size_must_be_between_one_and_the_cap() {
        assert!(validate_batch(&[]).is_err());
        let ok: Vec<_> = (0..MAX_BATCH)
            .map(|_| request("nai-diffusion-4-5-full", 1024, 1024, &[]))
            .collect();
        assert_eq!(validate_batch(&ok).unwrap().len(), MAX_BATCH);
        let too_many: Vec<_> = (0..=MAX_BATCH)
            .map(|_| request("nai-diffusion-4-5-full", 1024, 1024, &[]))
            .collect();
        assert!(validate_batch(&too_many).is_err());
    }

    #[test]
    fn one_bad_request_rejects_the_whole_batch_up_front() {
        let mut reqs: Vec<_> = (0..5)
            .map(|_| request("nai-diffusion-4-5-full", 1024, 1024, &[]))
            .collect();
        reqs[3].steps = 40;
        assert!(validate_batch(&reqs).is_err());
    }

    #[test]
    fn rejects_file_names_that_could_escape_the_folder() {
        for stem in ["", "../x", "a/b", r"a\b", "C:x"] {
            let mut r = request("nai-diffusion-4-5-full", 1024, 1024, &[]);
            r.file_stem = stem.into();
            assert!(validate_batch(&[r]).is_err(), "accepted {stem:?}");
        }
    }

    // One test, because both halves share the global last-generation time.
    #[test]
    fn spaces_generations_and_cancels_promptly() {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
            *LAST_GENERATION.lock().unwrap() = Some(Instant::now());
            let start = Instant::now();
            assert!(wait_for_turn("spacing-test").await);
            assert!(start.elapsed() >= Duration::from_millis(1900), "waited {:?}", start.elapsed());

            *LAST_GENERATION.lock().unwrap() = Some(Instant::now());
            cancel_batch("cancel-test");
            let start = Instant::now();
            assert!(!wait_for_turn("cancel-test").await);
            assert!(start.elapsed() < Duration::from_millis(500));
        });
    }

    // ---- prompt files ----

    #[test]
    fn splits_prompt_files_into_lines() {
        let text = "\u{feff}1girl, red hair\r\n\r\n  2girls, beach  \r\n\n\t\nsolo\n";
        assert_eq!(parse_prompt_lines(text), vec!["1girl, red hair", "2girls, beach", "solo"]);
        assert!(parse_prompt_lines("\n \r\n").is_empty());
    }

    // ---- metadata import ----

    fn chunk(kind: &[u8], body: &[u8]) -> Vec<u8> {
        let mut c = (body.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(body);
        c.extend_from_slice(&[0, 0, 0, 0]); // CRC isn't checked by the reader
        c
    }

    fn text_chunk(key: &str, value: &str) -> Vec<u8> {
        chunk(b"tEXt", &[key.as_bytes(), &[0], value.as_bytes()].concat())
    }

    fn png_with(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend(chunk(b"IHDR", &[0; 13]));
        for c in chunks {
            png.extend_from_slice(c);
        }
        png.extend(chunk(b"IEND", &[]));
        png
    }

    // Shape copied from a real V5 image's metadata.
    const V5_COMMENT: &str = r#"{"prompt": "1girl, bed, candles", "steps": 23, "height": 1216, "width": 832, "scale": 7.0, "seed": 3216798432, "n_samples": 1, "v4_prompt": {"caption": {"base_caption": "1girl, bed, candles", "char_captions": [{"char_caption": "girl, red hair", "centers": [{"x": 0.5, "y": 0.5}]}]}, "use_coords": false, "use_order": true}, "v4_negative_prompt": {"caption": {"base_caption": "lowres, bad quality", "char_captions": [{"char_caption": "", "centers": [{"x": 0.5, "y": 0.5}]}]}, "legacy_uc": false}, "uc": "lowres, bad quality"}"#;

    #[test]
    fn reads_settings_from_a_novelai_png() {
        let png = png_with(&[
            text_chunk("Software", "NovelAI"),
            text_chunk("Source", "NovelAI Diffusion V5 DB276663"),
            text_chunk("Comment", V5_COMMENT),
        ]);
        let s = parse_settings(&png_text_chunks(&png).unwrap()).unwrap();
        assert_eq!(s.prompt, "1girl, bed, candles");
        assert_eq!(s.negative_prompt, "lowres, bad quality");
        assert_eq!(s.characters, vec!["girl, red hair"]);
        assert_eq!((s.width, s.height), (Some(832), Some(1216)));
        assert_eq!((s.steps, s.scale, s.seed), (Some(23), Some(7.0), Some(3216798432)));
        assert_eq!(s.model.as_deref(), Some("nai-diffusion-5-curated"));
    }

    #[test]
    fn reads_compressed_itxt_chunks() {
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(V5_COMMENT.as_bytes(), 6);
        // keyword \0 compression-flag compression-method lang \0 translated-keyword \0 text
        let body = [b"Comment".as_slice(), &[0, 1, 0], b"en", &[0], &[0], &compressed].concat();
        let png = png_with(&[text_chunk("Software", "NovelAI"), chunk(b"iTXt", &body)]);
        let s = parse_settings(&png_text_chunks(&png).unwrap()).unwrap();
        assert_eq!(s.prompt, "1girl, bed, candles");
    }

    #[test]
    fn maps_model_hashes_like_novelais_site() {
        assert_eq!(model_from_source("NovelAI Diffusion V5 0ADF9AB7"), Some("nai-diffusion-5-full"));
        assert_eq!(model_from_source("NovelAI Diffusion V5 70AB5786"), Some("nai-diffusion-5-full-medium"));
        assert_eq!(model_from_source("NovelAI Diffusion V4.5 4BDE2A90"), Some("nai-diffusion-4-5-full"));
        assert_eq!(model_from_source("NovelAI Diffusion V4.5 5AB81C7C"), Some("nai-diffusion-4-5-curated"));
        assert_eq!(model_from_source("NovelAI Diffusion V4 37442FCA"), Some("nai-diffusion-4-full"));
        assert_eq!(model_from_source("NovelAI Diffusion V4.5 FFFFFFFF"), Some("nai-diffusion-4-5-curated"));
        assert_eq!(model_from_source("Stable Diffusion XL 9CC2F394"), None);
    }

    #[test]
    fn rejects_images_without_novelai_metadata() {
        let png = png_with(&[text_chunk("Software", "Photoshop")]);
        assert!(parse_settings(&png_text_chunks(&png).unwrap()).is_err());
        assert!(png_text_chunks(b"not a png at all").is_err());
    }

    // ---- vibe transfer ----

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    // Shapes follow what NovelAI's web client exports: an image-type vibe
    // keeps one entry per encode setting, an encoding-type vibe a single
    // "unknown" entry described by its import info.
    fn image_vibe(name: &str) -> String {
        json!({
            "identifier": "novelai-vibe-transfer",
            "version": 1,
            "type": "image",
            "id": "ab",
            "name": name,
            "thumbnail": "data:image/png;base64,AAAA",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "encodings": {
                "v4-5full": {
                    "h1": { "encoding": b64(b"enc-45-ie07"), "params": { "information_extracted": 0.7 } },
                    "h2": { "encoding": b64(b"enc-45-ie10"), "params": { "information_extracted": 1.0 } }
                },
                "v5full": { "h3": { "encoding": b64(b"enc-v5"), "params": { "information_extracted": 1.0 } } }
            },
            "importInfo": { "model": "nai-diffusion-4-5-full", "information_extracted": 0.7, "strength": 0.45 }
        })
        .to_string()
    }

    fn encoding_vibe() -> serde_json::Value {
        json!({
            "identifier": "novelai-vibe-transfer",
            "version": 1,
            "type": "encoding",
            "id": "cd",
            "encodings": { "v4full": { "unknown": { "encoding": b64(b"enc-v4") } } },
            "importInfo": { "model": "nai-diffusion-4-full", "information_extracted": 0.5, "strength": 0.6 }
        })
    }

    fn temp_file(name: &str, contents: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("novelai-core-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn vibe_ref(path: &str, index: usize, ie: Option<f64>, strength: f64) -> VibeRef {
        VibeRef { path: path.into(), index, information_extracted: ie, strength }
    }

    #[test]
    fn maps_models_to_vibe_encoding_keys() {
        assert_eq!(vibe_encoding_key("nai-diffusion-4-5-full"), Some("v4-5full"));
        assert_eq!(vibe_encoding_key("nai-diffusion-4-curated-preview"), Some("v4curated"));
        assert_eq!(vibe_encoding_key("nai-diffusion-5-full"), None);
        assert_eq!(model_for_encoding_key("v4-5curated"), Some("nai-diffusion-4-5-curated"));
        assert_eq!(model_for_encoding_key("v5full"), None);
    }

    #[test]
    fn describes_a_vibe_file_without_its_encodings() {
        let vibes = parse_vibes(&image_vibe("Watercolor")).unwrap();
        let info = vibe_info(0, &vibes[0]);
        assert_eq!(info.name, "Watercolor");
        assert_eq!(info.thumbnail.as_deref(), Some("data:image/png;base64,AAAA"));
        assert_eq!((info.strength, info.information_extracted), (Some(0.45), Some(0.7)));
        // V5's encoding is left out: this tab can't use it.
        assert_eq!(
            info.encodings,
            vec![
                VibeEncodingInfo { model: "nai-diffusion-4-5-full".into(), information_extracted: Some(0.7) },
                VibeEncodingInfo { model: "nai-diffusion-4-5-full".into(), information_extracted: Some(1.0) },
            ]
        );
    }

    #[test]
    fn picks_encodings_like_generation_does() {
        let info = vibe_info(0, &parse_vibes(&image_vibe("A")).unwrap()[0]);
        let pick = |ie| vibe_encoding_for(&info, "nai-diffusion-4-5-full", ie).map(|e| e.information_extracted);
        assert_eq!(pick(Some(1.0)), Some(Some(1.0)));
        assert_eq!(pick(None), Some(Some(0.7)));
        // An unavailable choice falls back to the first, as the app shows it.
        assert_eq!(pick(Some(0.3)), Some(Some(0.7)));
        assert!(vibe_encoding_for(&info, "nai-diffusion-4-full", None).is_none());
    }

    #[test]
    fn reads_bundles_and_vibes_embedded_in_pngs() {
        let bundle = json!({
            "identifier": "novelai-vibe-transfer-bundle",
            "version": 1,
            "vibes": [serde_json::from_str::<serde_json::Value>(&image_vibe("A")).unwrap(), encoding_vibe()]
        })
        .to_string();
        let vibes = parse_vibes(&bundle).unwrap();
        assert_eq!(vibes.len(), 2);
        // A bare encoding's information extracted comes from its import info.
        let second = vibe_info(1, &vibes[1]);
        assert_eq!(second.name, "Vibe 2");
        assert_eq!(second.encodings[0].information_extracted, Some(0.5));

        let png = png_with(&[text_chunk("naidata", &b64(bundle.as_bytes()))]);
        assert_eq!(load_vibe_file(&temp_file("embedded.png", &png)).unwrap().len(), 2);
        let plain = png_with(&[text_chunk("Software", "NovelAI")]);
        assert!(load_vibe_file(&temp_file("plain.png", &plain)).is_err());
    }

    #[test]
    fn rejects_files_that_are_not_vibes() {
        assert!(parse_vibes("not json").is_err());
        assert!(parse_vibes(r#"{"identifier": "something-else"}"#).is_err());
        assert!(parse_vibes(r#"{"identifier": "novelai-vibe-transfer-bundle", "vibes": []}"#).is_err());
    }

    #[test]
    fn sends_the_chosen_encodings_with_their_strengths() {
        let a = temp_file("a.naiv4vibe", image_vibe("A").as_bytes());
        let b = temp_file("b.naiv4vibe", encoding_vibe().to_string().as_bytes());
        let mut files = VibeFiles::new();

        let refs = [vibe_ref(&a, 0, Some(1.0), 0.6), vibe_ref(&a, 0, None, 0.3)];
        let vibes = resolve_vibes("nai-diffusion-4-5-full", &refs, &mut files).unwrap();
        let mut req = request("nai-diffusion-4-5-full", 832, 1216, &[]);
        req.vibes = refs.to_vec();
        let body = build_body(&req, &vibes).unwrap();
        let p = &body["parameters"];
        // An explicit choice picks that encoding; none picks the first.
        assert_eq!(p["reference_image_multiple"], json!([b64(b"enc-45-ie10"), b64(b"enc-45-ie07")]));
        assert_eq!(p["reference_strength_multiple"], json!([0.6, 0.3]));

        let vibes = resolve_vibes("nai-diffusion-4-full", &[vibe_ref(&b, 0, Some(0.5), 0.6)], &mut files);
        assert_eq!(vibes.unwrap()[0].encoding, b64(b"enc-v4"));

        // No vibes, no reference fields.
        let body = body_of(&request("nai-diffusion-4-5-full", 832, 1216, &[])).unwrap();
        assert!(body["parameters"].get("reference_image_multiple").is_none());
    }

    #[test]
    fn refuses_vibes_that_would_cost_anlas_or_cant_apply() {
        let a = temp_file("c.naiv4vibe", image_vibe("A").as_bytes());
        let mut files = VibeFiles::new();
        let one = |ie, strength| [vibe_ref(&a, 0, ie, strength)];
        // Not encoded for this model: using it would mean a paid encode.
        assert!(resolve_vibes("nai-diffusion-4-full", &one(None, 0.6), &mut files).is_err());
        // V5 has no Vibe Transfer.
        assert!(resolve_vibes("nai-diffusion-5-full", &one(None, 0.6), &mut files).is_err());
        // No encoding at that information extracted.
        assert!(resolve_vibes("nai-diffusion-4-5-full", &one(Some(0.3), 0.6), &mut files).is_err());
        // Strength out of range.
        assert!(resolve_vibes("nai-diffusion-4-5-full", &one(None, 1.5), &mut files).is_err());
        assert!(resolve_vibes("nai-diffusion-4-5-full", &one(None, f64::NAN), &mut files).is_err());
        // No such vibe in the file.
        assert!(resolve_vibes("nai-diffusion-4-5-full", &[vibe_ref(&a, 3, None, 0.6)], &mut files).is_err());
        // A fifth vibe costs Anlas.
        let five: Vec<_> = (0..5).map(|_| vibe_ref(&a, 0, None, 0.5)).collect();
        assert!(resolve_vibes("nai-diffusion-4-5-full", &five[..4], &mut files).is_ok());
        assert!(resolve_vibes("nai-diffusion-4-5-full", &five, &mut files).is_err());
    }

    #[test]
    fn refuses_an_image_posing_as_an_encoding() {
        let png = png_with(&[]);
        let mut vibe: serde_json::Value = serde_json::from_str(&image_vibe("Sneaky")).unwrap();
        vibe["encodings"]["v4-5full"]["h1"]["encoding"] = json!(b64(&png));
        let path = temp_file("sneaky.naiv4vibe", vibe.to_string().as_bytes());
        let refs = [vibe_ref(&path, 0, Some(0.7), 0.6)];
        assert!(resolve_vibes("nai-diffusion-4-5-full", &refs, &mut VibeFiles::new()).is_err());
        assert!(check_encoding("not base64!!", "x").is_err());
        assert!(check_encoding(&b64(b"\xFF\xD8\xFF\xE0jpeg"), "x").is_err());
    }

    #[test]
    fn a_missing_vibe_file_fails_the_batch_before_anything_is_sent() {
        let mut req = request("nai-diffusion-4-5-full", 1024, 1024, &[]);
        req.vibes = vec![vibe_ref("Z:/definitely/not/here.naiv4vibe", 0, None, 0.6)];
        assert!(validate_batch(&[req]).is_err());
    }
}
