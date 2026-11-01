//! Reads the prompt an image was made with, for the Convert tab: NovelAI's
//! settings, or the positive and negative text of a ComfyUI graph. Forge /
//! A1111 "parameters" text isn't read.

use crate::novelai;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum ScannedPrompt {
    #[serde(rename = "novelai")]
    NovelAi { settings: novelai::ImportedSettings },
    #[serde(rename = "comfyui", rename_all = "camelCase")]
    ComfyUi { positive: String, negative: String },
}

pub fn scan(path: &str) -> Result<ScannedPrompt, String> {
    let data = std::fs::read(path).map_err(|e| format!("couldn't read the image: {e}"))?;
    let chunks = novelai::png_text_chunks(&data)?;
    if let Ok(settings) = novelai::parse_settings(&chunks) {
        return Ok(ScannedPrompt::NovelAi { settings });
    }
    let graph = chunks
        .iter()
        .find(|(k, _)| k == "prompt")
        .and_then(|(_, v)| serde_json::from_str::<Value>(v).ok());
    if let Some((positive, negative)) = graph.as_ref().and_then(comfy_prompts) {
        return Ok(ScannedPrompt::ComfyUi { positive, negative });
    }
    Err("This image has no NovelAI or ComfyUI prompt in it.".into())
}

/// The positive and negative text of the first sampler in a ComfyUI API
/// graph ("prompt" chunk): any node with both `positive` and `negative`
/// inputs, followed back through conditioning nodes to their text.
fn comfy_prompts(graph: &Value) -> Option<(String, String)> {
    let nodes = graph.as_object()?;
    let mut ids: Vec<&String> = nodes.keys().collect();
    ids.sort_by_key(|id| id.parse::<u64>().unwrap_or(u64::MAX));
    for id in ids {
        let inputs = &nodes[id]["inputs"];
        if let (Some(p), Some(n)) = (inputs.get("positive"), inputs.get("negative")) {
            if let Some(positive) = resolve_text(nodes, p, 0) {
                return Some((positive, resolve_text(nodes, n, 0).unwrap_or_default()));
            }
        }
    }
    None
}

// Inputs that carry text, or lead towards it, in common nodes
// (CLIPTextEncode, string primitives, conditioning combiners).
const TEXT_INPUTS: [&str; 10] =
    ["text", "text_g", "string", "value", "prompt", "conditioning", "conditioning_1", "positive", "clip_l", "t5xxl"];

fn resolve_text(nodes: &serde_json::Map<String, Value>, v: &Value, depth: u8) -> Option<String> {
    if depth > 16 {
        return None;
    }
    match v {
        Value::String(s) => Some(s.clone()),
        // A link: [node id, output index].
        Value::Array(link) => {
            let node = nodes.get(&link.first()?.as_str().map(str::to_string).or_else(|| link[0].as_u64().map(|n| n.to_string()))?)?;
            let inputs = node.get("inputs")?;
            TEXT_INPUTS.iter().find_map(|k| resolve_text(nodes, inputs.get(*k)?, depth + 1))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_comfyui_graph() {
        let graph = json!({
            "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "anima.safetensors" } },
            "6": { "class_type": "CLIPTextEncode", "inputs": { "text": ["10", 0], "clip": ["4", 1] } },
            "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "lowres, bad hands", "clip": ["4", 1] } },
            "10": { "class_type": "PrimitiveString", "inputs": { "value": "masterpiece, 1girl, @artist" } },
            "3": { "class_type": "KSampler", "inputs": { "positive": ["6", 0], "negative": ["7", 0], "seed": 1 } }
        });
        assert_eq!(
            comfy_prompts(&graph),
            Some(("masterpiece, 1girl, @artist".into(), "lowres, bad hands".into()))
        );
        assert_eq!(comfy_prompts(&json!({ "1": { "inputs": { "ckpt_name": "x" } } })), None);
    }
}
