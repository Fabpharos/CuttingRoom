use base64::Engine;
use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

mod inpaint;
pub use inpaint::*;
mod turns;
use turns::*;

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
#[derive(Deserialize, Serialize, Clone, Default, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub tier: i64,
    pub tier_name: String,
    pub active: bool,
    pub is_opus: bool,
    /// Subscription and purchased Anlas together.
    pub anlas: i64,
    /// The subscription's Anlas left this month.
    #[serde(default)]
    pub subscription_anlas: i64,
    /// Anlas bought separately.
    #[serde(default)]
    pub purchased_anlas: i64,
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
        subscription_anlas: sub.training_steps_left.fixed_training_steps_left,
        purchased_anlas: sub.training_steps_left.purchased_training_steps,
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
// request. The size and step checks below keep every request inside it;
// guidance doesn't affect cost.
pub const MAX_FREE_PIXELS: u64 = 1_048_576;
/// NovelAI sizes go in steps of 64 pixels.
pub const SIZE_STEP: u32 = 64;
/// Keeps custom shapes sensible (2048x512 at the extreme).
pub const MAX_SIDE: u32 = 2048;
pub const MAX_STEPS: u32 = 28;
pub const MAX_GUIDANCE: f64 = 10.0;
/// The most character prompts any model takes (V5); see `max_characters`.
pub const MAX_CHARACTERS_ANY: usize = 22;

/// NovelAI's limit on character prompts: 22 on V5, 6 on V4 and V4.5.
pub fn max_characters(model: &str) -> usize {
    if model.starts_with("nai-diffusion-5") {
        22
    } else {
        6
    }
}

/// A model's short name for messages ("V5", "V4.5", "V4").
pub fn model_family(model: &str) -> &'static str {
    if model.starts_with("nai-diffusion-5") {
        "V5"
    } else if model.starts_with("nai-diffusion-4-5") {
        "V4.5"
    } else {
        "V4"
    }
}

/// Samplers NovelAI's web client offers for V4-family and V5 models.
pub const SAMPLERS: [&str; 6] = [
    "k_euler_ancestral",
    "k_euler",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m_sde",
    "k_dpmpp_2m",
    "k_dpmpp_sde",
];
pub const DEFAULT_SAMPLER: &str = "k_euler_ancestral";
pub const NOISE_SCHEDULES: [&str; 3] = ["karras", "exponential", "polyexponential"];
pub const DEFAULT_NOISE_SCHEDULE: &str = "karras";

/// The `skip_cfg_above_sigma` NovelAI's web client sends when Variety+ is
/// on: 58 at 832x1216, scaled with the square root of the pixel count.
/// UNVERIFIED for V5 and V4.5 until checked against images made on
/// novelai.net with Variety+ on (see `VARIETY_PLUS_VERIFIED`).
pub fn variety_plus_sigma(_model: &str, width: u32, height: u32) -> f64 {
    let latent = 4.0 * (width as f64 / 8.0) * (height as f64 / 8.0);
    let v = 58.0 * (latent / 63232.0).sqrt();
    (v * 1e6).round() / 1e6
}
/// Whether `variety_plus_sigma` has been confirmed against real images.
pub const VARIETY_PLUS_VERIFIED: bool = false;
/// Upper bound for a hand-set Variety+ sigma (creep can raise it).
pub const MAX_VARIETY_SIGMA: f64 = 1000.0;

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

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub characters: Vec<String>,
    /// Each character's undesired content, by position; missing ones are empty.
    #[serde(default)]
    pub character_negatives: Vec<String>,
    /// Where each character goes, lined up with `characters`; missing ones
    /// are centred. None leaves placement to the model ("AI's choice").
    #[serde(default)]
    pub character_positions: Option<Vec<CharacterPosition>>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub scale: f64,
    pub seed: u32,
    pub file_stem: String,
    #[serde(default)]
    pub vibes: Vec<VibeRef>,
    /// Image to image: the picture to start from. None is plain text to image.
    #[serde(default)]
    pub source_image: Option<SourceImage>,
    /// One of `SAMPLERS`; None is `DEFAULT_SAMPLER`.
    #[serde(default)]
    pub sampler: Option<String>,
    /// One of `NOISE_SCHEDULES`; None is `DEFAULT_NOISE_SCHEDULE`.
    #[serde(default)]
    pub noise_schedule: Option<String>,
    /// Variety+: guidance is skipped above this noise level. None leaves it off.
    #[serde(default)]
    pub skip_cfg_above_sigma: Option<f64>,
}

/// The starting picture for image to image, read from disk when the batch
/// starts and resized to the request's size.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceImage {
    pub path: String,
    /// How much may change, 0 (keep the picture) to 1 (ignore it).
    pub strength: f64,
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

/// Where a character sits, as fractions of the image's width and height
/// from its top-left corner.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct CharacterPosition {
    pub x: f64,
    pub y: f64,
}

const CENTER: CharacterPosition = CharacterPosition { x: 0.5, y: 0.5 };

/// V5 places characters anywhere, and even a lone character; V4 and V4.5
/// snap to a 5x5 grid and only place characters when there are two or more.
/// Both rules are NovelAI's web client's.
pub fn free_character_positions(model: &str) -> bool {
    model.starts_with("nai-diffusion-5")
}

/// The nearest point on NovelAI's 5x5 grid: 0.1, 0.3, 0.5, 0.7 or 0.9.
pub fn snap_to_grid(v: f64) -> f64 {
    let k = ((v - 0.1) / 0.2).round().clamp(0.0, 4.0);
    ((0.1 + 0.2 * k) * 10.0).round() / 10.0
}

/// A grid position's name as NovelAI's site shows it: column letter A-E,
/// row number 1-5 (C3 is the centre).
pub fn grid_label(p: CharacterPosition) -> String {
    let index = |v: f64| (((snap_to_grid(v) - 0.1) / 0.2).round() as u8).min(4);
    format!("{}{}", (b'A' + index(p.x)) as char, index(p.y) + 1)
}

/// What a position becomes for `model`: snapped to the grid on V4 and V4.5,
/// rounded to 0.001 (as NovelAI's site places them) on V5.
pub fn position_for_model(model: &str, p: CharacterPosition) -> CharacterPosition {
    if free_character_positions(model) {
        let r = |v: f64| (v * 1000.0).round() / 1000.0;
        CharacterPosition { x: r(p.x), y: r(p.y) }
    } else {
        CharacterPosition { x: snap_to_grid(p.x), y: snap_to_grid(p.y) }
    }
}

/// Whether positions are used for `count` characters on `model`.
pub fn positions_apply(model: &str, count: usize) -> bool {
    count >= 2 || (count == 1 && free_character_positions(model))
}

fn build_body(req: &GenerateRequest, vibes: &[ResolvedVibe]) -> Result<serde_json::Value, String> {
    check_free_size(req.width, req.height)?;
    request_body(req, vibes)
}

/// Any size in steps of 64, each side 64–2048, with at most 1,048,576
/// pixels (1024x1024) in all: the most an Opus generation can be for free.
pub fn check_free_size(width: u32, height: u32) -> Result<(), String> {
    if width % SIZE_STEP != 0 || height % SIZE_STEP != 0 {
        return Err(format!("{width}x{height}: width and height must be multiples of {SIZE_STEP}."));
    }
    if !(SIZE_STEP..=MAX_SIDE).contains(&width) || !(SIZE_STEP..=MAX_SIDE).contains(&height) {
        return Err(format!("{width}x{height}: each side must be between {SIZE_STEP} and {MAX_SIDE}."));
    }
    if width as u64 * height as u64 > MAX_FREE_PIXELS {
        return Err(format!(
            "{width}x{height} is over 1,048,576 pixels (1024x1024), so it would cost Anlas."
        ));
    }
    Ok(())
}

/// Everything `build_body` checks except the size, which inpainting checks
/// its own way (any multiple of 64 within the free pixel count).
fn request_body(req: &GenerateRequest, vibes: &[ResolvedVibe]) -> Result<serde_json::Value, String> {
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
    if let Some(positions) = &req.character_positions {
        if positions.iter().any(|p| !(0.0..=1.0).contains(&p.x) || !(0.0..=1.0).contains(&p.y)) {
            return Err("Character positions must be between 0 and 1.".into());
        }
    }
    // A character left blank is dropped together with its undesired content
    // and position, so the lists stay lined up.
    let characters: Vec<(&str, &str, CharacterPosition)> = req
        .characters
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let uc = req.character_negatives.get(i).map_or("", |n| n.trim());
            let at = req.character_positions.as_ref().and_then(|p| p.get(i)).copied().unwrap_or(CENTER);
            (c.trim(), uc, at)
        })
        .filter(|(c, _, _)| !c.is_empty())
        .collect();
    let max = max_characters(&req.model);
    if characters.len() > max {
        return Err(format!("{} allows at most {max} character prompts.", model_family(&req.model)));
    }
    let sampler = req.sampler.as_deref().unwrap_or(DEFAULT_SAMPLER);
    if !SAMPLERS.contains(&sampler) {
        return Err(format!("Unknown sampler: {sampler}"));
    }
    let noise_schedule = req.noise_schedule.as_deref().unwrap_or(DEFAULT_NOISE_SCHEDULE);
    if !NOISE_SCHEDULES.contains(&noise_schedule) {
        return Err(format!("Unknown noise schedule: {noise_schedule}"));
    }
    if let Some(sigma) = req.skip_cfg_above_sigma {
        if !(0.0..=MAX_VARIETY_SIGMA).contains(&sigma) || sigma.is_nan() {
            return Err(format!("The Variety+ value must be between 0 and {MAX_VARIETY_SIGMA}."));
        }
    }

    // Without positions the model places everyone (use_coords: false); the
    // centre is still required by the schema.
    let use_coords = req.character_positions.is_some() && positions_apply(&req.model, characters.len());
    let center = |p: CharacterPosition| {
        let p = if use_coords { position_for_model(&req.model, p) } else { CENTER };
        json!([{ "x": p.x, "y": p.y }])
    };
    let char_captions: Vec<_> = characters
        .iter()
        .map(|(c, _, at)| json!({ "char_caption": c, "centers": center(*at) }))
        .collect();
    let neg_char_captions: Vec<_> = characters
        .iter()
        .map(|(_, uc, at)| json!({ "char_caption": uc, "centers": center(*at) }))
        .collect();

    let mut parameters = json!({
        "params_version": 4,
        "width": req.width,
        "height": req.height,
        "steps": steps,
        "scale": req.scale,
        "n_samples": 1,
        "seed": req.seed,
        "sampler": sampler,
        "noise_schedule": noise_schedule,
        "negative_prompt": req.negative_prompt,
        // NovelAI's web app appends its own quality tags when this is on;
        // keep it off so the prompt sent is exactly what was typed.
        "qualityToggle": false,
        "v4_prompt": {
            "caption": { "base_caption": req.prompt, "char_captions": char_captions },
            "use_coords": use_coords,
            "use_order": true,
        },
        "v4_negative_prompt": {
            "caption": { "base_caption": req.negative_prompt, "char_captions": neg_char_captions },
            "legacy_uc": false,
        },
    });
    if let Some(sigma) = req.skip_cfg_above_sigma {
        parameters["skip_cfg_above_sigma"] = json!(sigma);
    }
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
        429 => RATE_LIMITED.into(),
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

// ---- Cost ----

/// What a request should cost: free, a known number of Anlas, or a charge
/// NovelAI makes that can't be priced here (`anlas: None`).
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub free: bool,
    /// The known charge; None when something costs an amount we can't price.
    pub anlas: Option<i64>,
    /// Why it isn't free, one line each.
    pub reasons: Vec<String>,
}

/// Anlas NovelAI is known to charge for a request no matter the account
/// (Precise Reference). The Anlas guard expects this much and no more.
/// Precise Reference's charge for one image: 5 Anlas per reference.
fn precise_reference_cost(_req: &GenerateRequest) -> i64 {
    0
}

pub fn known_charge(req: &GenerateRequest) -> i64 {
    precise_reference_cost(req)
}

/// The cost of one request on `account` (None: not logged in, so the account
/// rules can't be checked).
pub fn estimate_cost(req: &GenerateRequest, account: Option<&AccountStatus>) -> CostEstimate {
    let mut reasons = Vec::new();
    let mut priced = 0i64;
    let mut unpriced = false;
    if let Err(e) = check_free_size(req.width, req.height) {
        reasons.push(e);
        unpriced = true;
    }
    let steps = if req.model == MEDIUM_MODEL { MEDIUM_STEPS } else { req.steps };
    if steps > MAX_STEPS {
        reasons.push(format!("More than {MAX_STEPS} steps."));
        unpriced = true;
    }
    if req.vibes.len() > MAX_FREE_VIBES {
        let extra = (req.vibes.len() - MAX_FREE_VIBES) as i64 * 2;
        reasons.push(format!("{} vibes: each past the fourth costs 2 Anlas.", req.vibes.len()));
        priced += extra;
    }
    let refs = precise_reference_cost(req);
    if refs > 0 {
        reasons.push(format!("Precise Reference: {refs} Anlas per image."));
        priced += refs;
    }
    if let Some(a) = account {
        if !a.is_opus {
            reasons.push(format!("{} account: generations aren't free.", a.tier_name));
            unpriced = true;
        } else if is_usage_limited(&req.model) && a.usage.as_ref().is_some_and(|u| u.is_negative) {
            reasons.push("The Opus V5 quota is used up, so V5 costs Anlas until it refills.".into());
            unpriced = true;
        }
    }
    CostEstimate { free: reasons.is_empty(), anlas: if unpriced { None } else { Some(priced) }, reasons }
}

// ---- Batches ----

pub const MAX_BATCH: usize = 25;
// Request spacing and the lock shared with other processes live in turns.rs.
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
    pub image: Option<GeneratedImage>,
    /// The account after an image, when the Anlas guard checked it.
    pub account: Option<AccountStatus>,
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
    let mut sources: HashMap<(String, u32, u32), String> = HashMap::new();
    requests
        .iter()
        .map(|r| {
            validate_file_stem(&r.file_stem)?;
            let vibes = resolve_vibes(&r.model, &r.vibes, &mut files)?;
            let mut body = build_body(r, &vibes)?;
            if let Some(src) = &r.source_image {
                let key = (src.path.clone(), r.width, r.height);
                if !sources.contains_key(&key) {
                    sources.insert(key.clone(), source_image_base64(&src.path, r.width, r.height)?);
                }
                add_source_image(&mut body, r, src, &sources[&key])?;
            }
            Ok(body)
        })
        .collect()
}

/// The picture at `path` as NovelAI takes it for image to image: resized to
/// exactly the request's size (which the frontend picks to match its shape)
/// and re-encoded as a plain RGB PNG, so none of the file's metadata is sent.
fn source_image_base64(path: &str, width: u32, height: u32) -> Result<String, String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("couldn't open the source image ({path}): {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("couldn't open the source image ({path}): {e}"))?
        .decode()
        .map_err(|e| format!("couldn't read the source image ({path}): {e}"))?;
    let img = if (img.width(), img.height()) == (width, height) {
        img
    } else {
        img.resize_exact(width, height, image::imageops::FilterType::Lanczos3)
    };
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut png = Vec::new();
    rgb.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't prepare the source image: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Turns a text-to-image body into image to image, the way NovelAI's web
/// client sends it: same model and size, `action: "img2img"`, the picture,
/// its strength, no added noise.
fn add_source_image(
    body: &mut serde_json::Value,
    req: &GenerateRequest,
    src: &SourceImage,
    image_b64: &str,
) -> Result<(), String> {
    if !(0.0..=1.0).contains(&src.strength) || src.strength.is_nan() {
        return Err("Image to image strength must be between 0 and 1.".into());
    }
    body["action"] = json!("img2img");
    let p = &mut body["parameters"];
    p["image"] = json!(image_b64);
    p["strength"] = json!(src.strength);
    p["noise"] = json!(0);
    // NovelAI's site sets this for every request with an input image.
    p["extra_noise_seed"] = json!(req.seed.saturating_sub(1));
    Ok(())
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
    on_progress(BatchProgress { run_id: run_id.clone(), done: 0, total, image: None, account: None });

    for (req, body) in requests.iter().zip(&bodies) {
        let result = send_in_turn(&run_id, || post_for_image(&token, "/ai/generate-image", body)).await;
        let result = match result {
            Ok(None) => {
                cancelled = true;
                break;
            }
            Ok(Some(bytes)) => save_generated(bytes, req, &dir).await,
            Err(e) => Err(e),
        };

        match result {
            Ok(image) => {
                images.push(image.clone());
                on_progress(BatchProgress {
                    run_id: run_id.clone(),
                    done: images.len(),
                    total,
                    image: Some(image),
                    account: None,
                });
            }
            Err(e) => {
                stopped_reason = Some(e);
                break;
            }
        }

        if let Some(before) = anlas {
            // A charge NovelAI is known to make (a Precise Reference, say)
            // is expected; anything beyond it stops the batch.
            let expected = known_charge(req);
            let checked = fetch_status(&token).await;
            if let Ok(s) = &checked {
                on_progress(BatchProgress {
                    run_id: run_id.clone(),
                    done: images.len(),
                    total,
                    image: None,
                    account: Some(s.clone()),
                });
            }
            match checked {
                Ok(s) if before - s.anlas > expected => {
                    stopped_reason = Some(format!(
                        "NovelAI charged {} Anlas for that image{}, so the batch stopped. \
                         If you're using a V5 model, the Opus V5 quota may have run out.",
                        before - s.anlas,
                        if expected > 0 { format!(" (expected {expected})") } else { String::new() }
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

/// Sends `body` to an image endpoint (generate-image, upscale) and returns
/// the first image's bytes. Asks for JSON so the image comes back as base64
/// rather than in a zip.
async fn post_for_image(token: &str, endpoint: &str, body: &serde_json::Value) -> Result<Vec<u8>, String> {
    let resp = http()
        .post(format!("{API_BASE}{endpoint}"))
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
    base64::engine::general_purpose::STANDARD
        .decode(first.image)
        .map_err(|e| format!("couldn't decode the returned image: {e}"))
}

async fn save_generated(bytes: Vec<u8>, req: &GenerateRequest, dir: &Path) -> Result<GeneratedImage, String> {
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
    /// Lined up with `characters`; empty where the image had none.
    pub character_negatives: Vec<String>,
    /// Set when the image placed its characters itself.
    pub character_positions: Option<Vec<CharacterPosition>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub steps: Option<u32>,
    pub scale: Option<f64>,
    pub seed: Option<u64>,
    /// Our model ID, if the image's model is one this tab supports.
    pub model: Option<String>,
    /// The image's own model description, e.g. "NovelAI Diffusion V5 DB276663".
    pub source: Option<String>,
    pub sampler: Option<String>,
    pub noise_schedule: Option<String>,
    /// Set when the image was made with Variety+.
    pub skip_cfg_above_sigma: Option<f64>,
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
pub fn png_text_chunks(data: &[u8]) -> Result<Vec<(String, String)>, String> {
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

/// NovelAI's settings from an image's text chunks.
pub fn parse_settings(chunks: &[(String, String)]) -> Result<ImportedSettings, String> {
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
    let char_entries = |key: &str| {
        caption(key)
            .and_then(|cap| cap.get("char_captions"))
            .and_then(|cc| cc.as_array())
            .cloned()
            .unwrap_or_default()
    };
    // Each character's undesired content sits at the same position in
    // v4_negative_prompt.
    let negatives = char_entries("v4_negative_prompt");
    let mut characters = Vec::new();
    let mut character_negatives = Vec::new();
    let mut positions = Vec::new();
    for (i, ch) in char_entries("v4_prompt").iter().enumerate() {
        let Some(text) = ch.get("char_caption").and_then(|s| s.as_str()) else { continue };
        characters.push(text.to_string());
        character_negatives.push(
            negatives.get(i).and_then(|n| n.get("char_caption")).and_then(|s| s.as_str()).unwrap_or("").to_string(),
        );
        let at = ch.get("centers").and_then(|c| c.get(0));
        let coord = |k: &str| at.and_then(|a| a.get(k)).and_then(|v| v.as_f64()).filter(|v| (0.0..=1.0).contains(v));
        positions.push(CharacterPosition { x: coord("x").unwrap_or(0.5), y: coord("y").unwrap_or(0.5) });
    }
    let placed = c.get("v4_prompt").and_then(|v| v.get("use_coords")).and_then(|v| v.as_bool()) == Some(true);
    let character_positions = (placed && !characters.is_empty()).then_some(positions);

    let num = |key: &str| c.get(key).and_then(|v| v.as_f64());
    let source = get("Source").map(str::to_string);
    Ok(ImportedSettings {
        prompt,
        negative_prompt,
        characters,
        character_negatives,
        character_positions,
        width: num("width").map(|v| v as u32),
        height: num("height").map(|v| v as u32),
        steps: num("steps").map(|v| v as u32),
        scale: num("scale"),
        seed: c.get("seed").and_then(|v| v.as_u64()),
        model: source.as_deref().and_then(model_from_source).map(str::to_string),
        source,
        sampler: c.get("sampler").and_then(|v| v.as_str()).filter(|v| SAMPLERS.contains(v)).map(str::to_string),
        noise_schedule: c
            .get("noise_schedule")
            .and_then(|v| v.as_str())
            .filter(|v| NOISE_SCHEDULES.contains(v))
            .map(str::to_string),
        skip_cfg_above_sigma: num("skip_cfg_above_sigma").filter(|v| *v > 0.0),
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

// ---- Upscaling ----
//
// NovelAI's upscaler doubles an image's width and height. Unlike generation
// it's never free, even on Opus: NovelAI's web client prices it at 1 Anlas
// for an image of up to 1,048,576 pixels and more above that (and won't
// upscale bigger images at all). So only images at or under that size are
// sent, at most ten per confirmation, and a batch stops the moment one
// upscale costs more than 1 Anlas.

pub const UPSCALE_MAX_PIXELS: u64 = 1_048_576;
pub const UPSCALE_COST: i64 = 1;
/// Images per confirmation; the frontend asks again before each batch.
pub const MAX_UPSCALE_BATCH: usize = 10;
// What NovelAI's web client sends with every upscale.
const UPSCALE_MODEL: &str = "nai-diffusion-5-curated";
const UPSCALE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleCandidate {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleScan {
    /// In the order they'll be upscaled.
    pub eligible: Vec<UpscaleCandidate>,
    pub skipped: Vec<SkippedFile>,
}

fn has_upscale_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| UPSCALE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn check_upscale_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("it has no pixels".into());
    }
    if width as u64 * height as u64 > UPSCALE_MAX_PIXELS {
        return Err(format!(
            "{width}×{height} is over 1 megapixel (1024×1024), so upscaling it would cost more than 1 Anlas"
        ));
    }
    Ok(())
}

// Sorts file names the way Explorer and the Album tab do: "img2" before "img10".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut n = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        n.push(c);
                        it.next();
                    }
                    n
                };
                let (na, nb) = (take(&mut a), take(&mut b));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

// Reads only each file's header, so scanning a big folder is quick.
fn scan_paths(paths: &[PathBuf]) -> UpscaleScan {
    let mut scan = UpscaleScan::default();
    for p in paths {
        let path = p.to_string_lossy().into_owned();
        match image::image_dimensions(p) {
            Ok((width, height)) => match check_upscale_size(width, height) {
                Ok(()) => scan.eligible.push(UpscaleCandidate { path, width, height }),
                Err(reason) => scan.skipped.push(SkippedFile { path, reason }),
            },
            Err(e) => scan.skipped.push(SkippedFile { path, reason: format!("couldn't read it as an image: {e}") }),
        }
    }
    scan
}

/// Checks one file, or every image directly inside a folder (not subfolders).
pub async fn scan_for_upscale(path: String, is_folder: bool) -> Result<UpscaleScan, String> {
    tokio::task::spawn_blocking(move || {
        if !is_folder {
            return Ok(scan_paths(&[PathBuf::from(path)]));
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&path)
            .map_err(|e| format!("couldn't read the folder: {e}"))?
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.path())
            .filter(|p| has_upscale_extension(p))
            .collect();
        files.sort_by(|a, b| {
            natural_cmp(&a.file_name().unwrap_or_default().to_string_lossy(), &b.file_name().unwrap_or_default().to_string_lossy())
        });
        Ok(scan_paths(&files))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-reads and re-checks a file just before sending it, so nothing over the
/// size limit gets through even if it changed since the scan. Re-encoding as
/// PNG also keeps the original's metadata from being uploaded.
fn prepare_upscale_image(path: &str) -> Result<String, String> {
    let name = Path::new(path).file_name().unwrap_or_default().to_string_lossy().into_owned();
    let img = image::open(path).map_err(|e| format!("{name}: couldn't read it as an image: {e}"))?;
    check_upscale_size(img.width(), img.height()).map_err(|e| format!("{name}: {e}."))?;
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("{name}: couldn't prepare it for upload: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

fn upscale_body(image_base64: &str) -> serde_json::Value {
    json!({ "image": image_base64, "model": UPSCALE_MODEL, "declared_blur_sigma": 0 })
}

/// `<name>_upscaled`, from the source file's name.
pub fn upscaled_stem(source: &str) -> String {
    let stem = Path::new(source).file_stem().unwrap_or_default().to_string_lossy().into_owned();
    format!("{}_upscaled", if stem.is_empty() { "image" } else { &stem })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpscaledImage {
    pub source: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
    pub image: Option<UpscaledImage>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleSummary {
    pub images: Vec<UpscaledImage>,
    pub cancelled: bool,
    /// Set when the batch stopped early for a reason other than cancelling.
    pub stopped_reason: Option<String>,
    /// What the balance dropped by over the batch, as measured.
    pub anlas_spent: i64,
}

/// Upscales up to `MAX_UPSCALE_BATCH` files in order, at least `MIN_INTERVAL`
/// apart (shared with generation), saving `<name>_upscaled.png` in
/// `output_dir` without overwriting anything. The balance is checked before
/// and after every image; the batch stops if one costs more than 1 Anlas.
pub async fn upscale_batch(
    run_id: String,
    paths: Vec<String>,
    output_dir: String,
    mut on_progress: impl FnMut(UpscaleProgress),
) -> Result<UpscaleSummary, String> {
    if paths.is_empty() {
        return Err("Nothing to upscale.".into());
    }
    if paths.len() > MAX_UPSCALE_BATCH {
        return Err(format!("Upscale at most {MAX_UPSCALE_BATCH} images per confirmation."));
    }
    // Check every file before spending anything.
    let images = {
        let paths = paths.clone();
        tokio::task::spawn_blocking(move || paths.iter().map(|p| prepare_upscale_image(p)).collect::<Result<Vec<_>, _>>())
            .await
            .map_err(|e| e.to_string())??
    };
    let token = tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())??
        .ok_or("Log in to NovelAI on the Generate tab first.")?;
    let mut anlas = fetch_status(&token).await?.anlas;
    if anlas < UPSCALE_COST {
        return Err(format!("Upscaling costs {UPSCALE_COST} Anlas per image, and the account has {anlas}."));
    }

    let total = paths.len();
    let dir = PathBuf::from(output_dir);
    let mut done = Vec::new();
    let mut cancelled = false;
    let mut stopped_reason = None;
    let mut anlas_spent = 0;
    on_progress(UpscaleProgress { run_id: run_id.clone(), done: 0, total, image: None });

    for (source, image) in paths.iter().zip(&images) {
        let result = send_in_turn(&run_id, || upscale_one(&token, image)).await;
        let bytes = match result {
            Ok(None) => {
                cancelled = true;
                break;
            }
            Ok(Some(b)) => b,
            Err(e) => {
                stopped_reason = Some(e);
                break;
            }
        };
        let (d, stem) = (dir.clone(), upscaled_stem(source));
        let saved = tokio::task::spawn_blocking(move || save_png(&d, &stem, &bytes))
            .await
            .map_err(|e| e.to_string())?;
        // Measure the charge even if saving failed: the Anlas are spent.
        let after = fetch_status(&token).await;
        match saved {
            Ok(path) => {
                let image = UpscaledImage { source: source.clone(), path: path.to_string_lossy().into_owned() };
                done.push(image.clone());
                on_progress(UpscaleProgress { run_id: run_id.clone(), done: done.len(), total, image: Some(image) });
            }
            Err(e) => {
                stopped_reason = Some(e);
            }
        }
        match after {
            Ok(s) => {
                let charged = anlas - s.anlas;
                anlas_spent += charged.max(0);
                anlas = s.anlas;
                if charged > UPSCALE_COST {
                    stopped_reason = Some(format!(
                        "NovelAI charged {charged} Anlas for one upscale, more than the expected {UPSCALE_COST}, so the batch stopped."
                    ));
                }
            }
            Err(e) => {
                stopped_reason.get_or_insert(format!("Couldn't confirm the Anlas balance, so the batch stopped: {e}"));
            }
        }
        if stopped_reason.is_some() {
            break;
        }
    }

    cancelled_set().lock().unwrap().remove(&run_id);
    Ok(UpscaleSummary { images: done, cancelled, stopped_reason, anlas_spent })
}

async fn upscale_one(token: &str, image_base64: &str) -> Result<Vec<u8>, String> {
    post_for_image(token, "/ai/upscale", &upscale_body(image_base64)).await
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
            character_negatives: vec![],
            character_positions: None,
            width,
            height,
            steps: 28,
            scale: 5.0,
            seed: 42,
            file_stem: "out".into(),
            vibes: vec![],
            source_image: None,
            ..Default::default()
        }
    }

    #[test]
    fn image_to_image_sends_the_source_at_the_request_size() {
        let dir = std::env::temp_dir().join(format!("nai-img2img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("source.png");
        image::RgbaImage::from_pixel(300, 450, image::Rgba([10, 20, 30, 255])).save(&path).unwrap();
        let path = path.to_string_lossy().into_owned();

        let mut req = request("nai-diffusion-4-5-full", 832, 1216, &[]);
        req.source_image = Some(SourceImage { path: path.clone(), strength: 0.55 });
        let bodies = validate_batch(&[req.clone(), req.clone()]).unwrap();
        let body = &bodies[0];
        assert_eq!(body["action"], "img2img");
        assert_eq!(body["model"], "nai-diffusion-4-5-full");
        let p = &body["parameters"];
        assert_eq!(p["strength"], 0.55);
        assert_eq!(p["noise"], 0);
        assert_eq!(p["n_samples"], 1);
        assert_eq!(p["extra_noise_seed"], 41);
        let png = base64::engine::general_purpose::STANDARD.decode(p["image"].as_str().unwrap()).unwrap();
        let sent = image::load_from_memory(&png).unwrap();
        assert_eq!((sent.width(), sent.height()), (832, 1216));
        assert!(png_text_chunks(&png).unwrap().is_empty(), "no metadata goes with the image");

        // Still held to the free size, and strength must be 0–1.
        let mut big = req.clone();
        (big.width, big.height) = (1024, 1536);
        assert!(validate_batch(&[big]).is_err());
        let mut bad = req.clone();
        bad.source_image = Some(SourceImage { path: path.clone(), strength: 1.5 });
        assert!(validate_batch(&[bad]).is_err());
        let mut missing = req;
        missing.source_image = Some(SourceImage { path: dir.join("nope.png").to_string_lossy().into_owned(), strength: 0.5 });
        assert!(validate_batch(&[missing]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
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
    fn accepts_any_free_size_and_rejects_the_rest() {
        for (w, h) in [(832, 1216), (1216, 832), (1024, 1024), (1472, 704), (640, 640), (2048, 512)] {
            assert!(body_of(&request("nai-diffusion-4-5-full", w, h, &[])).is_ok(), "{w}x{h}");
        }
        // Over 1 megapixel, not a multiple of 64, a side out of range.
        for (w, h) in [(1024, 1536), (2048, 2048), (1088, 1024), (1000, 1000), (832, 1215), (0, 1024), (2112, 448)] {
            assert!(body_of(&request("nai-diffusion-4-5-full", w, h, &[])).is_err(), "{w}x{h}");
        }
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
    fn sends_each_characters_undesired_content_lined_up_with_it() {
        let mut req = request("nai-diffusion-4-5-full", 832, 1216, &["girl, red hair", " ", "boy, glasses"]);
        req.character_negatives = vec!["blue hair".into(), "dropped with its blank character".into()];
        let body = body_of(&req).unwrap();
        let caps = |key: &str| -> Vec<String> {
            body["parameters"][key]["caption"]["char_captions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["char_caption"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(caps("v4_prompt"), vec!["girl, red hair", "boy, glasses"]);
        // The third character had none: sent empty.
        assert_eq!(caps("v4_negative_prompt"), vec!["blue hair", ""]);
    }

    fn centers_of(body: &serde_json::Value, key: &str) -> Vec<(f64, f64)> {
        body["parameters"][key]["caption"]["char_captions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["centers"][0]["x"].as_f64().unwrap(), c["centers"][0]["y"].as_f64().unwrap()))
            .collect()
    }

    #[test]
    fn leaves_placement_to_the_model_by_default() {
        let body = body_of(&request("nai-diffusion-5-full", 832, 1216, &["a", "b"])).unwrap();
        assert_eq!(body["parameters"]["v4_prompt"]["use_coords"], false);
        assert_eq!(centers_of(&body, "v4_prompt"), vec![(0.5, 0.5), (0.5, 0.5)]);
    }

    #[test]
    fn places_characters_anywhere_on_v5_even_alone() {
        let mut req = request("nai-diffusion-5-full", 832, 1216, &["girl"]);
        req.character_positions = Some(vec![CharacterPosition { x: 0.12345, y: 0.8 }]);
        let body = body_of(&req).unwrap();
        assert_eq!(body["parameters"]["v4_prompt"]["use_coords"], true);
        assert_eq!(centers_of(&body, "v4_prompt"), vec![(0.123, 0.8)]);
        // Undesired content carries the same centre.
        assert_eq!(centers_of(&body, "v4_negative_prompt"), vec![(0.123, 0.8)]);
    }

    #[test]
    fn snaps_to_the_grid_on_v4_and_needs_two_characters() {
        let mut req = request("nai-diffusion-4-5-full", 832, 1216, &["girl", " ", "boy"]);
        req.character_positions = Some(vec![
            CharacterPosition { x: 0.04, y: 0.62 },
            CharacterPosition { x: 0.9, y: 0.9 }, // dropped with its blank character
            CharacterPosition { x: 0.81, y: 0.33 },
        ]);
        let body = body_of(&req).unwrap();
        assert_eq!(body["parameters"]["v4_prompt"]["use_coords"], true);
        assert_eq!(centers_of(&body, "v4_prompt"), vec![(0.1, 0.7), (0.9, 0.3)]);

        // A lone character can't be placed on V4.5: the model decides.
        let mut one = request("nai-diffusion-4-5-full", 832, 1216, &["girl"]);
        one.character_positions = Some(vec![CharacterPosition { x: 0.1, y: 0.1 }]);
        let body = body_of(&one).unwrap();
        assert_eq!(body["parameters"]["v4_prompt"]["use_coords"], false);
        assert_eq!(centers_of(&body, "v4_prompt"), vec![(0.5, 0.5)]);

        // Missing positions are centred; out-of-range ones are refused.
        let mut short = request("nai-diffusion-4-full", 832, 1216, &["a", "b"]);
        short.character_positions = Some(vec![CharacterPosition { x: 0.3, y: 0.3 }]);
        assert_eq!(centers_of(&body_of(&short).unwrap(), "v4_prompt"), vec![(0.3, 0.3), (0.5, 0.5)]);
        short.character_positions = Some(vec![CharacterPosition { x: 1.2, y: 0.3 }]);
        assert!(body_of(&short).is_err());
    }

    #[test]
    fn names_grid_cells_like_novelais_site() {
        assert_eq!(grid_label(CharacterPosition { x: 0.5, y: 0.5 }), "C3");
        assert_eq!(grid_label(CharacterPosition { x: 0.0, y: 1.0 }), "A5");
        assert_eq!(grid_label(CharacterPosition { x: 0.71, y: 0.29 }), "D2");
        assert_eq!(snap_to_grid(0.2), 0.3);
        assert_eq!(snap_to_grid(0.19), 0.1);
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

    // One test, because both halves share the global last-generation time
    // and the lock file.
    #[test]
    fn spaces_generations_and_cancels_promptly() {
        use std::time::{Duration, Instant};
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
            *LAST_GENERATION.lock().unwrap() = Some(Instant::now());
            let start = Instant::now();
            let turn = wait_for_turn("spacing-test").await.expect("a turn");
            assert!(start.elapsed() >= Duration::from_millis(1900), "waited {:?}", start.elapsed());
            turn.finish();

            // The lock file carries the time to other processes: forget this
            // process's own clock and the gap is still kept.
            *LAST_GENERATION.lock().unwrap() = None;
            let start = Instant::now();
            drop(wait_for_turn("shared-test").await.expect("a turn"));
            assert!(start.elapsed() >= Duration::from_millis(1800), "waited {:?}", start.elapsed());

            *LAST_GENERATION.lock().unwrap() = Some(Instant::now());
            cancel_batch("cancel-test");
            let start = Instant::now();
            assert!(wait_for_turn("cancel-test").await.is_none());
            assert!(start.elapsed() < Duration::from_millis(500));
        });
    }

    #[test]
    fn character_limit_follows_the_model() {
        assert_eq!(max_characters("nai-diffusion-5-full"), 22);
        assert_eq!(max_characters("nai-diffusion-5-full-medium"), 22);
        assert_eq!(max_characters("nai-diffusion-5-curated"), 22);
        for m in ["nai-diffusion-4-5-full", "nai-diffusion-4-5-curated", "nai-diffusion-4-full", "nai-diffusion-4-curated-preview"] {
            assert_eq!(max_characters(m), 6, "{m}");
        }
        let names: Vec<String> = (0..22).map(|i| format!("girl {i}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        assert!(build_body(&request("nai-diffusion-5-full", 1024, 1024, &refs), &[]).is_ok());
        let err = build_body(&request("nai-diffusion-4-5-full", 1024, 1024, &refs[..7]), &[]).unwrap_err();
        assert!(err.contains("V4.5") && err.contains('6'), "{err}");
        assert!(build_body(&request("nai-diffusion-4-5-full", 1024, 1024, &refs[..6]), &[]).is_ok());
        let mut too_many = refs.clone();
        too_many.push("one more");
        assert!(build_body(&request("nai-diffusion-5-full", 1024, 1024, &too_many), &[]).is_err());
    }

    #[test]
    fn sampler_schedule_and_variety_plus_are_sent() {
        let r = request("nai-diffusion-4-5-full", 832, 1216, &[]);
        let p = &build_body(&r, &[]).unwrap()["parameters"];
        assert_eq!(p["sampler"], "k_euler_ancestral");
        assert_eq!(p["noise_schedule"], "karras");
        assert!(p.get("skip_cfg_above_sigma").is_none());

        let mut r = r;
        r.sampler = Some("k_dpmpp_2m_sde".into());
        r.noise_schedule = Some("exponential".into());
        r.skip_cfg_above_sigma = Some(variety_plus_sigma(&r.model, 832, 1216));
        let p = &build_body(&r, &[]).unwrap()["parameters"];
        assert_eq!(p["sampler"], "k_dpmpp_2m_sde");
        assert_eq!(p["noise_schedule"], "exponential");
        assert_eq!(p["skip_cfg_above_sigma"], 58.0);

        r.sampler = Some("ddim".into());
        assert!(build_body(&r, &[]).is_err());
        r.sampler = None;
        r.noise_schedule = Some("native".into());
        assert!(build_body(&r, &[]).is_err());
        r.noise_schedule = None;
        r.skip_cfg_above_sigma = Some(-1.0);
        assert!(build_body(&r, &[]).is_err());
    }

    #[test]
    fn variety_plus_scales_with_size() {
        assert_eq!(variety_plus_sigma("nai-diffusion-5-full", 832, 1216), 58.0);
        let square = variety_plus_sigma("nai-diffusion-5-full", 1024, 1024);
        assert!((square - 58.0 * (1_048_576f64 / 1_011_712f64).sqrt()).abs() < 1e-5, "{square}");
    }

    #[test]
    fn estimates_cost() {
        let opus = |negative: bool| AccountStatus {
            tier: 3,
            tier_name: "Opus".into(),
            active: true,
            is_opus: true,
            anlas: 100,
            subscription_anlas: 100,
            purchased_anlas: 0,
            usage: Some(UsageStatus { is_negative: negative, percent: 50, purchased_percent: 0 }),
        };
        let r = request("nai-diffusion-5-full", 1024, 1024, &[]);
        let e = estimate_cost(&r, Some(&opus(false)));
        assert!(e.free && e.anlas == Some(0) && e.reasons.is_empty(), "{e:?}");
        let e = estimate_cost(&r, Some(&opus(true)));
        assert!(!e.free && e.anlas.is_none(), "{e:?}");
        // V4.5 doesn't draw from the V5 quota.
        let r45 = request("nai-diffusion-4-5-full", 1024, 1024, &[]);
        assert!(estimate_cost(&r45, Some(&opus(true))).free);
        let mut scroll = opus(false);
        scroll.is_opus = false;
        scroll.tier_name = "Scroll".into();
        assert!(!estimate_cost(&r45, Some(&scroll)).free);
        let big = request("nai-diffusion-4-5-full", 1216, 1216, &[]);
        assert!(!estimate_cost(&big, None).free);
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
        assert_eq!(s.character_negatives, vec![""]);
        assert_eq!((s.width, s.height), (Some(832), Some(1216)));
        assert_eq!((s.steps, s.scale, s.seed), (Some(23), Some(7.0), Some(3216798432)));
        assert_eq!(s.model.as_deref(), Some("nai-diffusion-5-curated"));
    }

    #[test]
    fn reads_character_positions_when_the_image_placed_them() {
        let png = png_with(&[text_chunk("Software", "NovelAI"), text_chunk("Comment", V5_COMMENT)]);
        assert_eq!(parse_settings(&png_text_chunks(&png).unwrap()).unwrap().character_positions, None);
        let placed = V5_COMMENT
            .replace(r#""use_coords": false"#, r#""use_coords": true"#)
            .replacen(r#""centers": [{"x": 0.5, "y": 0.5}]"#, r#""centers": [{"x": 0.3, "y": 0.7}]"#, 1);
        let png = png_with(&[text_chunk("Software", "NovelAI"), text_chunk("Comment", &placed)]);
        let s = parse_settings(&png_text_chunks(&png).unwrap()).unwrap();
        assert_eq!(s.character_positions, Some(vec![CharacterPosition { x: 0.3, y: 0.7 }]));
    }

    #[test]
    fn reads_each_characters_undesired_content() {
        let comment = V5_COMMENT.replace(
            r#""base_caption": "lowres, bad quality", "char_captions": [{"char_caption": """#,
            r#""base_caption": "lowres, bad quality", "char_captions": [{"char_caption": "blue hair""#,
        );
        let png = png_with(&[text_chunk("Software", "NovelAI"), text_chunk("Comment", &comment)]);
        let s = parse_settings(&png_text_chunks(&png).unwrap()).unwrap();
        assert_eq!(s.characters, vec!["girl, red hair"]);
        assert_eq!(s.character_negatives, vec!["blue hair"]);
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

    // ---- upscaling ----

    fn write_image(name: &str, width: u32, height: u32, format: image::ImageFormat) -> String {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([200, 40, 40]));
        let dir = std::env::temp_dir().join(format!("novelai-core-upscale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        img.save_with_format(&path, format).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn only_images_up_to_one_megapixel_qualify() {
        assert!(check_upscale_size(1024, 1024).is_ok());
        assert!(check_upscale_size(832, 1216).is_ok());
        assert!(check_upscale_size(1216, 832).is_ok());
        assert!(check_upscale_size(1025, 1024).is_err());
        assert!(check_upscale_size(1664, 2432).is_err());
        assert!(check_upscale_size(0, 10).is_err());
    }

    #[test]
    fn scanning_sorts_naturally_and_explains_skips() {
        let dir = std::env::temp_dir().join(format!("novelai-core-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let save = |name: &str, w, h| {
            image::RgbImage::new(w, h).save_with_format(dir.join(name), image::ImageFormat::Png).unwrap()
        };
        save("img10.png", 64, 64);
        save("img2.png", 64, 64);
        save("big.png", 1100, 1000);
        save("sub/inner.png", 64, 64); // subfolders aren't included
        std::fs::write(dir.join("broken.png"), b"not an image").unwrap();
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();

        let scan = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(scan_for_upscale(dir.to_string_lossy().into_owned(), true))
            .unwrap();
        let names: Vec<_> = scan
            .eligible
            .iter()
            .map(|c| Path::new(&c.path).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["img2.png", "img10.png"]);
        assert_eq!((scan.eligible[0].width, scan.eligible[0].height), (64, 64));
        let skipped: Vec<_> = scan.skipped.iter().map(|s| (Path::new(&s.path).file_name().unwrap().to_string_lossy().into_owned(), s.reason.clone())).collect();
        assert_eq!(skipped.len(), 2);
        assert!(skipped.iter().any(|(n, r)| n == "big.png" && r.contains("over 1 megapixel")));
        assert!(skipped.iter().any(|(n, r)| n == "broken.png" && r.contains("couldn't read")));
    }

    #[test]
    fn sends_a_png_and_refuses_an_oversized_file() {
        let jpg = write_image("photo.jpg", 100, 80, image::ImageFormat::Jpeg);
        let b64 = prepare_upscale_image(&jpg).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(&b64).unwrap();
        assert!(bytes.starts_with(&PNG_SIGNATURE), "re-encoded as PNG");
        let body = upscale_body(&b64);
        assert_eq!(body["model"], UPSCALE_MODEL);
        assert_eq!(body["declared_blur_sigma"], 0);

        let big = write_image("big.png", 1100, 1000, image::ImageFormat::Png);
        assert!(prepare_upscale_image(&big).unwrap_err().contains("over 1 megapixel"));
    }

    #[test]
    fn upscale_batches_are_capped_before_anything_is_read() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert!(rt.block_on(upscale_batch("r1".into(), vec![], "C:\\out".into(), |_| {})).is_err());
        let eleven = vec!["a.png".to_string(); MAX_UPSCALE_BATCH + 1];
        let err = rt.block_on(upscale_batch("r2".into(), eleven, "C:\\out".into(), |_| {})).unwrap_err();
        assert!(err.contains("at most"), "{err}");
        // A file over the limit fails the batch before any request.
        let big = write_image("big2.png", 1100, 1000, image::ImageFormat::Png);
        let err = rt.block_on(upscale_batch("r3".into(), vec![big], "C:\\out".into(), |_| {})).unwrap_err();
        assert!(err.contains("over 1 megapixel"), "{err}");
    }

    #[test]
    fn names_outputs_after_their_source() {
        assert_eq!(upscaled_stem(r"C:\pics\2026-10-16_17-01-40_135940740.png"), "2026-10-16_17-01-40_135940740_upscaled");
        assert_eq!(upscaled_stem("photo.final.jpg"), "photo.final_upscaled");
    }

    #[test]
    fn natural_sort_puts_numbers_in_order() {
        let mut names = vec!["img10.png", "IMG2.png", "img1.png", "img01b.png", "a.png"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["a.png", "img1.png", "img01b.png", "IMG2.png", "img10.png"]);
    }
}
