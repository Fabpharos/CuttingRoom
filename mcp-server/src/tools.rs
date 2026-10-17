//! The two tools this server offers. Generation goes through the same
//! novelai-core code as the Cutting Room app, so its free-generation limits,
//! request spacing, and Anlas guard all apply here too.

use crate::protocol::{ToolResult, Tools};
use base64::Engine;
use novelai_core::{
    account_status, generate_batch, is_usage_limited, AccountStatus, GenerateRequest,
    MAX_CHARACTERS, MAX_GUIDANCE, MAX_STEPS, MEDIUM_MODEL, MEDIUM_STEPS, MODELS,
};
use serde_json::{json, Value};

const DEFAULT_MODEL: &str = "nai-diffusion-4-5-full";
const DEFAULT_STEPS: u32 = 28;
const DEFAULT_GUIDANCE: f64 = 5.0;
const SIZES: [(&str, u32, u32); 3] =
    [("portrait", 832, 1216), ("landscape", 1216, 832), ("square", 1024, 1024)];
// The image returned to the client is a downscaled JPEG: plenty for judging
// a result, and far smaller than the original PNG (which is kept on disk).
const PREVIEW_MAX_EDGE: u32 = 1024;
const DIALOG_FIELD_LIMIT: usize = 700;

#[derive(Debug, PartialEq)]
pub struct GenerateArgs {
    pub prompt: String,
    pub negative_prompt: String,
    pub characters: Vec<String>,
    pub model: String,
    pub size: &'static str,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub guidance: f64,
    pub seed: Option<u32>,
}

/// Checks arguments up front so a bad request is rejected with a clear
/// message before the user is ever asked to approve it.
pub fn parse_generate_args(args: &Value) -> Result<GenerateArgs, String> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();

    let prompt = text("prompt");
    if prompt.is_empty() {
        return Err("`prompt` is required.".into());
    }

    let model = match args.get("model").and_then(Value::as_str) {
        None => DEFAULT_MODEL.to_string(),
        Some(m) if MODELS.contains(&m) => m.to_string(),
        Some(m) => return Err(format!("Unknown model `{m}`. Use one of: {}.", MODELS.join(", "))),
    };

    let size_name = args.get("size").and_then(Value::as_str).unwrap_or("portrait");
    let Some(&(size, width, height)) = SIZES.iter().find(|(n, _, _)| *n == size_name) else {
        return Err("`size` must be portrait (832x1216), landscape (1216x832), or square (1024x1024).".into());
    };

    let steps = if model == MEDIUM_MODEL {
        MEDIUM_STEPS
    } else {
        match args.get("steps") {
            None => DEFAULT_STEPS,
            Some(v) => match v.as_u64() {
                Some(n) if (1..=MAX_STEPS as u64).contains(&n) => n as u32,
                _ => {
                    return Err(format!(
                        "`steps` must be a whole number from 1 to {MAX_STEPS}; more steps would cost Anlas."
                    ))
                }
            },
        }
    };

    let guidance = match args.get("guidance") {
        None => DEFAULT_GUIDANCE,
        Some(v) => match v.as_f64() {
            Some(g) if (0.0..=MAX_GUIDANCE).contains(&g) => g,
            _ => return Err(format!("`guidance` must be a number from 0 to {MAX_GUIDANCE}.")),
        },
    };

    let characters: Vec<String> = match args.get("characters") {
        None => vec![],
        Some(Value::Array(items)) => {
            let mut out = vec![];
            for item in items {
                let Some(s) = item.as_str() else {
                    return Err("`characters` must be a list of strings.".into());
                };
                if !s.trim().is_empty() {
                    out.push(s.trim().to_string());
                }
            }
            out
        }
        Some(_) => return Err("`characters` must be a list of strings.".into()),
    };
    if characters.len() > MAX_CHARACTERS {
        return Err(format!("At most {MAX_CHARACTERS} character prompts are allowed."));
    }

    let seed = match args.get("seed") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64() {
            Some(n) if n <= u32::MAX as u64 => Some(n as u32),
            _ => return Err("`seed` must be a whole number from 0 to 4294967295.".into()),
        },
    };

    Ok(GenerateArgs {
        prompt,
        negative_prompt: text("negative_prompt"),
        characters,
        model,
        size,
        width,
        height,
        steps,
        guidance,
        seed,
    })
}

/// Whether this generation will cost Anlas, and a line saying so for the
/// approval dialog.
pub fn cost_line(status: &AccountStatus, model: &str) -> (bool, String) {
    if !status.is_opus {
        let why = if status.active {
            format!("your {} subscription doesn't include free generations", status.tier_name)
        } else {
            "your subscription is inactive".to_string()
        };
        return (true, format!("COSTS ANLAS: {why} (you have {} Anlas).", status.anlas));
    }
    if is_usage_limited(model) {
        return match &status.usage {
            Some(u) if u.is_negative => (
                true,
                format!(
                    "MAY COST ANLAS: your Opus V5 quota is used up (you have {} Anlas). V4.5 models are still free.",
                    status.anlas
                ),
            ),
            Some(u) => (false, format!("Free: uses your Opus V5 quota ({}% left).", u.percent + u.purchased_percent)),
            None => (false, "Free: uses your Opus V5 quota.".to_string()),
        };
    }
    (false, "Free: included with your Opus subscription.".to_string())
}

fn clip(s: &str) -> String {
    if s.chars().count() <= DIALOG_FIELD_LIMIT {
        s.to_string()
    } else {
        s.chars().take(DIALOG_FIELD_LIMIT).collect::<String>() + "…"
    }
}

pub fn approval_text(a: &GenerateArgs, cost: &str) -> String {
    let mut t = String::from("An AI assistant is asking to generate this image with your NovelAI account.\n\n");
    t += &format!("Model: {}\n", a.model);
    t += &format!(
        "Size: {} {}x{} · {} steps · guidance {}\n",
        a.size, a.width, a.height, a.steps, a.guidance
    );
    t += &format!("Seed: {}\n\n", a.seed.map_or("random".to_string(), |s| s.to_string()));
    t += &format!("Prompt:\n{}\n\n", clip(&a.prompt));
    if !a.negative_prompt.is_empty() {
        t += &format!("Undesired content:\n{}\n\n", clip(&a.negative_prompt));
    }
    for (i, c) in a.characters.iter().enumerate() {
        t += &format!("Character {}:\n{}\n\n", i + 1, clip(c));
    }
    t += cost;
    t += "\n\nGenerate this image?";
    t
}

fn jpeg_preview(png_path: &str) -> Result<Vec<u8>, String> {
    let img = image::open(png_path).map_err(|e| format!("couldn't read the saved image: {e}"))?;
    let img = if img.width().max(img.height()) > PREVIEW_MAX_EDGE {
        img.resize(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&img.to_rgb8())
        .map_err(|e| format!("couldn't encode the preview: {e}"))?;
    Ok(out)
}

pub struct NovelAiTools {
    pub output_dir: String,
    pub runtime: tokio::runtime::Runtime,
    /// Set once NovelAI unexpectedly charges for a should-be-free image;
    /// further generations are refused until the server restarts.
    pub paused: Option<String>,
    pub approve: fn(&str, &str) -> bool,
    pub timestamp: fn() -> String,
}

impl NovelAiTools {
    fn status(&self) -> Result<AccountStatus, String> {
        self.runtime
            .block_on(account_status())?
            .ok_or_else(|| "No NovelAI token is saved. Log in once in Cutting Room's Generate tab.".to_string())
    }

    fn account_status_tool(&self) -> ToolResult {
        match self.status() {
            Ok(s) => {
                let quota = match &s.usage {
                    Some(u) if u.is_negative => "used up".to_string(),
                    Some(u) => format!("{}% remaining", u.percent + u.purchased_percent),
                    None => "not reported".to_string(),
                };
                ToolResult::text(format!(
                    "Tier: {}{}. Anlas: {}. Opus V5 quota: {}.\n\
                     On Opus, V4 and V4.5 generations are free and unlimited; V5 draws from the quota.",
                    s.tier_name,
                    if s.active { "" } else { " (inactive)" },
                    s.anlas,
                    quota
                ))
            }
            Err(e) => ToolResult::error(e),
        }
    }

    fn generate_tool(&mut self, arguments: &Value) -> ToolResult {
        if let Some(reason) = &self.paused {
            return ToolResult::error(format!(
                "Generation is paused for this session: {reason} Restart the MCP server to resume."
            ));
        }
        let a = match parse_generate_args(arguments) {
            Ok(a) => a,
            Err(e) => return ToolResult::error(e),
        };
        let status = match self.status() {
            Ok(s) => s,
            Err(e) => return ToolResult::error(e),
        };
        let (costs, cost) = cost_line(&status, &a.model);

        if !(self.approve)("NovelAI generation request", &approval_text(&a, &cost)) {
            return ToolResult::error(
                "The user declined this generation. Don't retry it unless they ask you to.",
            );
        }

        let seed = a.seed.unwrap_or_else(|| {
            use std::hash::{BuildHasher, Hasher};
            // RandomState is seeded from OS randomness; good enough for a seed.
            std::collections::hash_map::RandomState::new().build_hasher().finish() as u32
        });
        let request = GenerateRequest {
            model: a.model.clone(),
            prompt: a.prompt.clone(),
            negative_prompt: a.negative_prompt.clone(),
            characters: a.characters.clone(),
            width: a.width,
            height: a.height,
            steps: a.steps,
            scale: a.guidance,
            seed,
            file_stem: format!("{}_mcp_{seed}", (self.timestamp)()),
        };
        let summary = match self.runtime.block_on(generate_batch(
            format!("mcp-{seed}"),
            vec![request],
            self.output_dir.clone(),
            // Guard whenever the image should be free; a paid one was just
            // approved with its cost shown.
            !costs,
            |_| {},
        )) {
            Ok(s) => s,
            Err(e) => return ToolResult::error(e),
        };
        let Some(image) = summary.images.first() else {
            return ToolResult::error(
                summary.stopped_reason.unwrap_or_else(|| "NovelAI returned no image.".to_string()),
            );
        };

        let mut text = format!(
            "Generated with {} ({} {}x{}, {} steps, guidance {}, seed {}). Original PNG saved to {}. \
             The image below is a downscaled JPEG preview.",
            a.model, a.size, a.width, a.height, a.steps, a.guidance, image.seed, image.path
        );
        if let Some(reason) = summary.stopped_reason {
            text += &format!("\n\nWARNING: {reason} Further generations are paused for this session.");
            self.paused = Some(reason);
        }
        let mut content = vec![json!({ "type": "text", "text": text })];
        match jpeg_preview(&image.path) {
            Ok(jpeg) => content.push(json!({
                "type": "image",
                "data": base64::engine::general_purpose::STANDARD.encode(jpeg),
                "mimeType": "image/jpeg",
            })),
            Err(e) => content.push(json!({ "type": "text", "text": format!("(No preview: {e})") })),
        }
        ToolResult { content, is_error: false }
    }
}

impl Tools for NovelAiTools {
    fn list(&self) -> Vec<Value> {
        vec![
            json!({
                "name": "novelai_account_status",
                "description": "Show the NovelAI account's subscription tier, Anlas balance, and Opus V5 quota. Read-only; never costs anything.",
                "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            }),
            json!({
                "name": "novelai_generate_image",
                "description": "Generate ONE image with NovelAI and return it so you can look at it. \
                    Every call shows the user a Windows approval dialog with the full request; they may decline, \
                    in which case don't retry unless asked. Limited to free settings: three sizes, at most 28 steps, \
                    one image per call. On Opus, V4/V4.5 models are free and unlimited; V5 models use a limited quota. \
                    The full PNG is saved to disk; the returned image is a downscaled preview.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "Main prompt (NovelAI tags and/or natural language)." },
                        "negative_prompt": { "type": "string", "description": "Undesired content." },
                        "characters": {
                            "type": "array", "items": { "type": "string" }, "maxItems": MAX_CHARACTERS,
                            "description": "Up to 4 character prompts."
                        },
                        "model": { "type": "string", "enum": MODELS, "default": DEFAULT_MODEL },
                        "size": { "type": "string", "enum": ["portrait", "landscape", "square"], "default": "portrait",
                                  "description": "portrait 832x1216, landscape 1216x832, square 1024x1024." },
                        "steps": { "type": "integer", "minimum": 1, "maximum": MAX_STEPS, "default": DEFAULT_STEPS,
                                   "description": "Ignored for nai-diffusion-5-full-medium, which always uses 14." },
                        "guidance": { "type": "number", "minimum": 0, "maximum": MAX_GUIDANCE, "default": DEFAULT_GUIDANCE },
                        "seed": { "type": "integer", "minimum": 0, "maximum": 4294967295u64,
                                  "description": "Fix the seed to compare prompt changes fairly; random if omitted." }
                    },
                    "required": ["prompt"],
                    "additionalProperties": false
                },
            }),
        ]
    }

    fn call(&mut self, name: &str, arguments: &Value) -> Option<ToolResult> {
        match name {
            "novelai_account_status" => Some(self.account_status_tool()),
            "novelai_generate_image" => Some(self.generate_tool(arguments)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use novelai_core::UsageStatus;

    #[test]
    fn applies_defaults() {
        let a = parse_generate_args(&json!({ "prompt": "1girl" })).unwrap();
        assert_eq!(a.model, DEFAULT_MODEL);
        assert_eq!((a.size, a.width, a.height), ("portrait", 832, 1216));
        assert_eq!((a.steps, a.guidance, a.seed), (28, 5.0, None));
    }

    #[test]
    fn rejects_anything_that_would_cost_anlas_or_is_invalid() {
        for bad in [
            json!({}),
            json!({ "prompt": "  " }),
            json!({ "prompt": "x", "steps": 29 }),
            json!({ "prompt": "x", "steps": 0 }),
            json!({ "prompt": "x", "steps": 20.5 }),
            json!({ "prompt": "x", "guidance": 11 }),
            json!({ "prompt": "x", "size": "huge" }),
            json!({ "prompt": "x", "model": "nai-diffusion-3" }),
            json!({ "prompt": "x", "characters": ["a", "b", "c", "d", "e"] }),
            json!({ "prompt": "x", "characters": "a" }),
            json!({ "prompt": "x", "seed": -1 }),
        ] {
            assert!(parse_generate_args(&bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn medium_effort_ignores_requested_steps() {
        let a = parse_generate_args(&json!({ "prompt": "x", "model": MEDIUM_MODEL, "steps": 28 })).unwrap();
        assert_eq!(a.steps, MEDIUM_STEPS);
    }

    #[test]
    fn keeps_blank_characters_out_and_reads_seed() {
        let a = parse_generate_args(&json!({ "prompt": "x", "characters": ["girl", " "], "seed": 42, "size": "square" })).unwrap();
        assert_eq!(a.characters, vec!["girl"]);
        assert_eq!((a.seed, a.width, a.height), (Some(42), 1024, 1024));
    }

    fn status(is_opus: bool, usage: Option<UsageStatus>) -> AccountStatus {
        AccountStatus {
            tier: if is_opus { 3 } else { 2 },
            tier_name: if is_opus { "Opus" } else { "Scroll" }.into(),
            active: true,
            is_opus,
            anlas: 500,
            usage,
        }
    }

    #[test]
    fn says_when_a_generation_costs_anlas() {
        let quota = |neg| Some(UsageStatus { is_negative: neg, percent: 40, purchased_percent: 0 });
        assert!(!cost_line(&status(true, None), "nai-diffusion-4-5-full").0);
        assert!(!cost_line(&status(true, quota(false)), "nai-diffusion-5-full").0);
        assert!(cost_line(&status(true, quota(true)), "nai-diffusion-5-full").0);
        assert!(!cost_line(&status(true, quota(true)), "nai-diffusion-4-5-full").0);
        assert!(cost_line(&status(false, None), "nai-diffusion-4-5-full").0);
    }

    #[test]
    fn approval_text_shows_the_whole_request() {
        let a = parse_generate_args(&json!({
            "prompt": "1girl, beach", "negative_prompt": "lowres", "characters": ["girl, red hair"], "seed": 7
        }))
        .unwrap();
        let t = approval_text(&a, "Free: included with your Opus subscription.");
        for part in ["1girl, beach", "lowres", "Character 1:", "girl, red hair", "Seed: 7", "832x1216", "Free:"] {
            assert!(t.contains(part), "missing {part:?} in:\n{t}");
        }
    }
}
