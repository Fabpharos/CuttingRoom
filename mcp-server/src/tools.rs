//! The tools this server offers. Generation goes through the same
//! novelai-core code as the Cutting Room app, so its free-generation limits,
//! request spacing, and Anlas guard all apply here too.

use crate::protocol::{ToolResult, Tools};
use base64::Engine;
use novelai_core::{
    account_status, generate_batch, is_usage_limited, read_vibe_file, vibe_encoding_for,
    vibe_encoding_key, AccountStatus, GenerateRequest, VibeInfo, VibeRef, DEFAULT_VIBE_STRENGTH,
    MAX_CHARACTERS, MAX_FREE_VIBES, MAX_GUIDANCE, MAX_STEPS, MEDIUM_MODEL, MEDIUM_STEPS, MODELS,
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

/// A vibe as the client asked for it; settings it leaves out come from the
/// file once it's read.
#[derive(Debug, PartialEq)]
pub struct VibeSpec {
    pub path: String,
    pub index: Option<usize>,
    pub strength: Option<f64>,
    pub information_extracted: Option<f64>,
}

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
    pub vibes: Vec<VibeSpec>,
    /// Where to save, if the client chose; otherwise the server's default.
    pub output_dir: Option<String>,
}

/// The client picks the folder, so only accept a plain absolute path on a
/// local drive (like `D:\Art\tests`): no relative paths, no `..` steps that
/// would make the dialog misleading, and no network shares or device paths.
/// The folder is created if needed; existing files are never overwritten.
pub fn validate_output_dir(dir: &str) -> Result<String, String> {
    const RULE: &str = "`output_dir` must be a full folder path on a local drive, like C:\\Users\\you\\Pictures\\NovelAI.";
    let dir = dir.trim();
    let b = dir.as_bytes();
    let drive_rooted = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if !drive_rooted {
        return Err(RULE.into());
    }
    let rest = &dir[2..];
    if rest.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err(format!("{RULE} It contains characters Windows doesn't allow in folder names."));
    }
    if rest.split(['\\', '/']).any(|part| part == "..") {
        return Err(format!("{RULE} `..` isn't allowed."));
    }
    Ok(dir.to_string())
}

fn parse_vibe_spec(item: &Value) -> Result<VibeSpec, String> {
    const SHAPE: &str = "Each entry in `vibes` must be an object with a `path`.";
    let obj = item.as_object().ok_or(SHAPE)?;
    let path = obj.get("path").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if path.is_empty() {
        return Err(SHAPE.into());
    }
    let unit = |key: &str| -> Result<Option<f64>, String> {
        match obj.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => match v.as_f64() {
                Some(x) if (0.0..=1.0).contains(&x) => Ok(Some(x)),
                _ => Err(format!("A vibe's `{key}` must be a number from 0 to 1.")),
            },
        }
    };
    let index = match obj.get("index") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .ok_or("A vibe's `index` must be a whole number (0 for the first vibe in a file).")?
                as usize,
        ),
    };
    Ok(VibeSpec {
        path: path.to_string(),
        index,
        strength: unit("strength")?,
        information_extracted: unit("information_extracted")?,
    })
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

    let vibes = match args.get("vibes") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => items.iter().map(parse_vibe_spec).collect::<Result<_, _>>()?,
        Some(_) => return Err("`vibes` must be a list of objects.".into()),
    };
    if vibes.len() > MAX_FREE_VIBES {
        return Err(format!(
            "At most {MAX_FREE_VIBES} vibes can be used at once; each one past the fourth costs Anlas."
        ));
    }
    if !vibes.is_empty() && vibe_encoding_key(&model).is_none() {
        return Err(format!("{model} doesn't support Vibe Transfer. Use a V4 or V4.5 model with vibes."));
    }

    let output_dir = match args.get("output_dir") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if d.trim().is_empty() => None,
        Some(Value::String(d)) => Some(validate_output_dir(d)?),
        Some(_) => return Err("`output_dir` must be a string.".into()),
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
        vibes,
        output_dir,
    })
}

/// A vibe checked against its file, ready to send.
#[derive(Debug, PartialEq)]
pub struct PreparedVibe {
    pub reference: VibeRef,
    pub name: String,
}

fn encoded_for(info: &VibeInfo) -> String {
    let mut models: Vec<&str> = info.encodings.iter().map(|e| e.model.as_str()).collect();
    models.dedup();
    if models.is_empty() {
        "no model this server can use".into()
    } else {
        models.join(", ")
    }
}

/// Reads each vibe's file and settles the details the client left out, so
/// the approval dialog shows exactly what will be sent and a vibe that can't
/// be used for free is refused before the user is asked. Generation checks
/// the files again.
pub fn prepare_vibes(
    specs: &[VibeSpec],
    model: &str,
    read: impl Fn(&str) -> Result<Vec<VibeInfo>, String>,
) -> Result<Vec<PreparedVibe>, String> {
    specs
        .iter()
        .map(|s| {
            let infos = read(&s.path).map_err(|e| format!("{}: {e}", s.path))?;
            let index = match s.index {
                Some(i) => i,
                None if infos.len() == 1 => 0,
                None => {
                    return Err(format!(
                        "{} holds {} vibes; pass `index` (0 to {}) to pick one. novelai_list_vibes shows them.",
                        s.path,
                        infos.len(),
                        infos.len() - 1
                    ))
                }
            };
            let info = infos
                .get(index)
                .ok_or_else(|| format!("{} has no vibe at index {index}.", s.path))?;
            let wanted = s.information_extracted.or(info.information_extracted);
            let encoding = vibe_encoding_for(info, model, wanted).ok_or_else(|| {
                format!(
                    "The vibe \"{}\" isn't encoded for {model}, and encoding it would cost Anlas. \
                     It's encoded for: {}.",
                    info.name,
                    encoded_for(info)
                )
            })?;
            if let Some(ie) = s.information_extracted {
                if encoding.information_extracted != Some(ie) {
                    return Err(format!(
                        "The vibe \"{}\" has no {model} encoding with information_extracted {ie}; \
                         novelai_list_vibes shows the ones it has.",
                        info.name
                    ));
                }
            }
            Ok(PreparedVibe {
                reference: VibeRef {
                    path: s.path.clone(),
                    index,
                    information_extracted: encoding.information_extracted,
                    strength: s.strength.or(info.strength).unwrap_or(DEFAULT_VIBE_STRENGTH),
                },
                name: info.name.clone(),
            })
        })
        .collect()
}

fn describe_ie(ie: Option<f64>) -> String {
    ie.map_or("unknown".into(), |x| x.to_string())
}

/// What novelai_list_vibes reports for a file.
pub fn describe_vibes(path: &str, infos: &[VibeInfo]) -> String {
    let mut t = format!("{path} holds {} vibe(s):\n", infos.len());
    for info in infos {
        t += &format!(
            "\n[index {}] {}: saved strength {}, saved information_extracted {}.\n",
            info.index,
            info.name,
            info.strength.map_or("none (0.6 is used)".into(), |x| x.to_string()),
            describe_ie(info.information_extracted),
        );
        if info.encodings.is_empty() {
            t += "  Not encoded for any V4 or V4.5 model, so it can't be used here for free.\n";
        }
        for e in &info.encodings {
            t += &format!(
                "  Encoded for {} (information_extracted {}).\n",
                e.model,
                describe_ie(e.information_extracted)
            );
        }
    }
    t
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

pub fn approval_text(a: &GenerateArgs, vibes: &[PreparedVibe], save_to: &str, cost: &str) -> String {
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
    if !vibes.is_empty() {
        t += "Vibes (already encoded, no Anlas):\n";
        for v in vibes {
            t += &format!(
                "  - {}: strength {}, information extracted {}\n    {}\n",
                v.name,
                v.reference.strength,
                describe_ie(v.reference.information_extracted),
                clip(&v.reference.path)
            );
        }
        t += "\n";
    }
    t += &format!("Save to: {}\n\n", clip(save_to));
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

    fn list_vibes_tool(&self, arguments: &Value) -> ToolResult {
        let path = arguments.get("path").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if path.is_empty() {
            return ToolResult::error("`path` is required.");
        }
        match self.runtime.block_on(read_vibe_file(path.to_string())) {
            Ok(infos) => ToolResult::text(describe_vibes(path, &infos)),
            Err(e) => ToolResult::error(format!("{path}: {e}")),
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
        let vibes = match prepare_vibes(&a.vibes, &a.model, |path| {
            self.runtime.block_on(read_vibe_file(path.to_string()))
        }) {
            Ok(v) => v,
            Err(e) => return ToolResult::error(e),
        };
        let (costs, cost) = cost_line(&status, &a.model);
        let save_to = a.output_dir.clone().unwrap_or_else(|| self.output_dir.clone());

        if !(self.approve)("NovelAI generation request", &approval_text(&a, &vibes, &save_to, &cost)) {
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
            vibes: vibes.iter().map(|v| v.reference.clone()).collect(),
        };
        let summary = match self.runtime.block_on(generate_batch(
            format!("mcp-{seed}"),
            vec![request],
            save_to,
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
        if !vibes.is_empty() {
            let used: Vec<String> = vibes
                .iter()
                .map(|v| {
                    format!(
                        "{} (strength {}, information extracted {})",
                        v.name,
                        v.reference.strength,
                        describe_ie(v.reference.information_extracted)
                    )
                })
                .collect();
            text += &format!("\nVibes: {}.", used.join("; "));
        }
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
                                  "description": "Fix the seed to compare prompt changes fairly; random if omitted." },
                        "output_dir": { "type": "string",
                                        "description": "Folder to save the PNG in (full local path, e.g. D:\\Art\\tests); created if missing. \
                                            Defaults to the server's output folder. Existing files are never overwritten." },
                        "vibes": {
                            "type": "array", "maxItems": MAX_FREE_VIBES,
                            "description": "Vibe Transfer, V4/V4.5 models only: up to 4 vibe files the user already \
                                encoded on NovelAI (.naiv4vibe, .naiv4vibebundle, or a NovelAI PNG with vibes embedded). \
                                A vibe not encoded for the chosen model is refused, since encoding it costs Anlas. \
                                novelai_list_vibes shows what a file holds.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": { "type": "string", "description": "Full path to the vibe file." },
                                    "index": { "type": "integer", "minimum": 0,
                                               "description": "Which vibe in a bundle (0-based). Optional for single-vibe files." },
                                    "strength": { "type": "number", "minimum": 0, "maximum": 1,
                                                  "description": "Defaults to the strength saved in the file, else 0.6." },
                                    "information_extracted": { "type": "number", "minimum": 0, "maximum": 1,
                                                               "description": "Picks between encodings when the file has several for the model." }
                                },
                                "required": ["path"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["prompt"],
                    "additionalProperties": false
                },
            }),
            json!({
                "name": "novelai_list_vibes",
                "description": "List the vibes in a NovelAI vibe file (.naiv4vibe, .naiv4vibebundle, or a NovelAI PNG \
                    with vibes embedded): each vibe's index, name, saved settings, and which models it's encoded for. \
                    Read-only; nothing is sent to NovelAI.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "path": { "type": "string", "description": "Full path to the vibe file." } },
                    "required": ["path"],
                    "additionalProperties": false
                },
            }),
        ]
    }

    fn call(&mut self, name: &str, arguments: &Value) -> Option<ToolResult> {
        match name {
            "novelai_account_status" => Some(self.account_status_tool()),
            "novelai_generate_image" => Some(self.generate_tool(arguments)),
            "novelai_list_vibes" => Some(self.list_vibes_tool(arguments)),
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
        let t = approval_text(&a, &[], "C:\\out", "Free: included with your Opus subscription.");
        for part in ["1girl, beach", "lowres", "Character 1:", "girl, red hair", "Seed: 7", "832x1216", "Save to: C:\\out", "Free:"] {
            assert!(t.contains(part), "missing {part:?} in:\n{t}");
        }
    }

    // ---- vibes ----

    use novelai_core::VibeEncodingInfo;

    fn vibe(index: usize, name: &str, strength: Option<f64>, encodings: &[(&str, Option<f64>)]) -> VibeInfo {
        VibeInfo {
            index,
            name: name.into(),
            thumbnail: None,
            encodings: encodings
                .iter()
                .map(|(m, ie)| VibeEncodingInfo { model: m.to_string(), information_extracted: *ie })
                .collect(),
            strength,
            information_extracted: Some(0.7),
        }
    }

    // A stand-in for reading files: one single-vibe file and one bundle.
    fn read(path: &str) -> Result<Vec<VibeInfo>, String> {
        let v45 = "nai-diffusion-4-5-full";
        match path {
            "one.naiv4vibe" => Ok(vec![vibe(0, "Watercolor", Some(0.45), &[(v45, Some(0.7)), (v45, Some(1.0))])]),
            "two.naiv4vibebundle" => Ok(vec![
                vibe(0, "Ink", None, &[(v45, None)]),
                vibe(1, "Old V4", None, &[("nai-diffusion-4-full", Some(1.0))]),
            ]),
            _ => Err("couldn't read the vibe file".into()),
        }
    }

    fn specs(args: Value) -> Vec<VibeSpec> {
        parse_generate_args(&args).unwrap().vibes
    }

    #[test]
    fn parses_vibes_and_rejects_bad_ones() {
        let v = specs(json!({ "prompt": "x", "vibes": [{ "path": "a.naiv4vibe", "strength": 0.3, "index": 2 }] }));
        assert_eq!(
            v,
            vec![VibeSpec { path: "a.naiv4vibe".into(), index: Some(2), strength: Some(0.3), information_extracted: None }]
        );
        let five: Vec<_> = (0..5).map(|_| json!({ "path": "a" })).collect();
        for bad in [
            json!({ "prompt": "x", "vibes": "a.naiv4vibe" }),
            json!({ "prompt": "x", "vibes": [{}] }),
            json!({ "prompt": "x", "vibes": [{ "path": " " }] }),
            json!({ "prompt": "x", "vibes": [{ "path": "a", "strength": 1.5 }] }),
            json!({ "prompt": "x", "vibes": [{ "path": "a", "index": -1 }] }),
            json!({ "prompt": "x", "vibes": five }),
            // V5 has no Vibe Transfer.
            json!({ "prompt": "x", "model": "nai-diffusion-5-full", "vibes": [{ "path": "a" }] }),
        ] {
            assert!(parse_generate_args(&bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn fills_in_vibe_settings_from_the_file() {
        let model = "nai-diffusion-4-5-full";
        let v = prepare_vibes(
            &specs(json!({ "prompt": "x", "vibes": [
                { "path": "one.naiv4vibe" },
                { "path": "one.naiv4vibe", "information_extracted": 1.0, "strength": 0.2 },
                { "path": "two.naiv4vibebundle", "index": 0 }
            ] })),
            model,
            read,
        )
        .unwrap();
        let got: Vec<_> = v.iter().map(|p| (p.name.as_str(), p.reference.index, p.reference.information_extracted, p.reference.strength)).collect();
        assert_eq!(
            got,
            vec![
                // Saved strength and information extracted.
                ("Watercolor", 0, Some(0.7), 0.45),
                ("Watercolor", 0, Some(1.0), 0.2),
                // Nothing saved: NovelAI's default strength.
                ("Ink", 0, None, DEFAULT_VIBE_STRENGTH),
            ]
        );
    }

    #[test]
    fn refuses_vibes_it_cant_use_for_free_before_asking() {
        let model = "nai-diffusion-4-5-full";
        let prep = |vibes: Value| prepare_vibes(&specs(json!({ "prompt": "x", "vibes": vibes })), model, read);
        // A bundle needs an index.
        assert!(prep(json!([{ "path": "two.naiv4vibebundle" }])).unwrap_err().contains("index"));
        // Only encoded for V4: using it would need a paid encode.
        let e = prep(json!([{ "path": "two.naiv4vibebundle", "index": 1 }])).unwrap_err();
        assert!(e.contains("nai-diffusion-4-full"), "{e}");
        // No encoding at that information extracted.
        assert!(prep(json!([{ "path": "one.naiv4vibe", "information_extracted": 0.3 }])).is_err());
        assert!(prep(json!([{ "path": "two.naiv4vibebundle", "index": 5 }])).is_err());
        assert!(prep(json!([{ "path": "missing.naiv4vibe" }])).is_err());
    }

    #[test]
    fn approval_text_lists_the_vibes() {
        let a = parse_generate_args(&json!({ "prompt": "x", "vibes": [{ "path": "one.naiv4vibe" }] })).unwrap();
        let vibes = prepare_vibes(&a.vibes, &a.model, read).unwrap();
        let t = approval_text(&a, &vibes, "C:\\out", "Free: included with your Opus subscription.");
        for part in ["Vibes", "Watercolor", "strength 0.45", "information extracted 0.7", "one.naiv4vibe"] {
            assert!(t.contains(part), "missing {part:?} in:\n{t}");
        }
    }

    #[test]
    fn lists_what_a_vibe_file_holds() {
        let t = describe_vibes("two.naiv4vibebundle", &read("two.naiv4vibebundle").unwrap());
        for part in ["2 vibe(s)", "[index 0] Ink", "[index 1] Old V4", "Encoded for nai-diffusion-4-full"] {
            assert!(t.contains(part), "missing {part:?} in:\n{t}");
        }
    }

    // ---- output folder ----

    #[test]
    fn accepts_a_chosen_output_folder() {
        let a = parse_generate_args(&json!({ "prompt": "x", "output_dir": "  D:\\Art\\NovelAI tests " })).unwrap();
        assert_eq!(a.output_dir.as_deref(), Some("D:\\Art\\NovelAI tests"));
        assert_eq!(validate_output_dir("c:/pics/out").as_deref(), Ok("c:/pics/out"));
        // Absent or blank means the server's default.
        assert_eq!(parse_generate_args(&json!({ "prompt": "x" })).unwrap().output_dir, None);
        assert_eq!(parse_generate_args(&json!({ "prompt": "x", "output_dir": " " })).unwrap().output_dir, None);
    }

    #[test]
    fn refuses_output_folders_that_arent_plain_local_paths() {
        for bad in [
            "pictures\\out",
            "\\out",
            "C:out",
            "\\\\server\\share\\out",
            "\\\\?\\C:\\out",
            "C:\\Users\\..\\Windows",
            "C:\\out\\a:b",
            "C:\\out\\what?",
        ] {
            assert!(validate_output_dir(bad).is_err(), "accepted {bad:?}");
        }
        assert!(parse_generate_args(&json!({ "prompt": "x", "output_dir": 5 })).is_err());
    }
}
