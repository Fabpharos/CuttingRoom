// Encoding an image as a vibe: the one paid part of Vibe Transfer. NovelAI's
// web client prices /ai/encode-vibe at 2 Anlas per image and Information
// Extracted value, once. The encoding is saved as a normal .naiv4vibe file,
// so the free loader uses it from then on and the same image, model and
// Information Extracted are never encoded twice: a file already made for
// them is reused without asking NovelAI.

use super::*;

pub const VIBE_ENCODE_COST: i64 = 2;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodedVibe {
    pub path: String,
    /// True when an earlier encoding was reused (nothing was sent or spent).
    pub reused: bool,
    pub anlas_warning: Option<String>,
}

/// FNV-1a over the image's pixels as sent, for the cache's file name.
fn content_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Where an encoding for this image, model and Information Extracted lives.
pub fn encoded_vibe_path(dir: &Path, source: &str, png: &[u8], model: &str, information_extracted: f64) -> Option<PathBuf> {
    let key = vibe_encoding_key(model)?;
    let stem = Path::new(source).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let ie = format!("{:.2}", information_extracted).replace('.', "_");
    Some(dir.join(format!("{stem}.{key}.ie{ie}.{:016x}.naiv4vibe", content_hash(png))))
}

fn prepared_png(path: &str) -> Result<(Vec<u8>, image::DynamicImage), String> {
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("couldn't open {path}: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("couldn't open {path}: {e}"))?
        .decode()
        .map_err(|e| format!("couldn't read {path}: {e}"))?;
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut png = Vec::new();
    rgb.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("couldn't prepare the image: {e}"))?;
    Ok((png, rgb))
}

fn thumbnail_data_url(img: &image::DynamicImage) -> String {
    let t = img.thumbnail(256, 256);
    let mut jpg = Vec::new();
    let _ = t.write_to(&mut std::io::Cursor::new(&mut jpg), image::ImageFormat::Jpeg);
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpg))
}

/// The .naiv4vibe file NovelAI's web client would write for this encoding.
pub fn vibe_file_json(name: &str, model: &str, information_extracted: f64, encoding_b64: &str, thumbnail: &str, id: &str) -> serde_json::Value {
    let key = vibe_encoding_key(model).unwrap_or("v4-5full");
    json!({
        "identifier": "novelai-vibe-transfer",
        "version": 1,
        "type": "encoding",
        "id": id,
        "name": name,
        "thumbnail": thumbnail,
        "createdAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        "importInfo": { "model": model, "information_extracted": information_extracted, "strength": DEFAULT_VIBE_STRENGTH },
        "encodings": { key: { id: { "encoding": encoding_b64, "params": { "information_extracted": information_extracted } } } }
    })
}

async fn post_for_bytes(token: &str, endpoint: &str, body: &serde_json::Value) -> Result<Vec<u8>, String> {
    let resp = http()
        .post(format!("{API_BASE}{endpoint}"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach NovelAI: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let message = resp.json::<ApiError>().await.ok().and_then(|e| e.message).unwrap_or_default();
        return Err(error_for_status(status, &message));
    }
    Ok(resp.bytes().await.map_err(|e| format!("couldn't read NovelAI's response: {e}"))?.to_vec())
}

/// Encodes `path` for `model` (or reuses an earlier encoding) and saves it as
/// a .naiv4vibe file in `out_dir`. Costs 2 Anlas when it encodes; the caller
/// confirms that first. The balance is checked before and after.
pub async fn encode_vibe(
    run_id: String,
    path: String,
    model: String,
    information_extracted: f64,
    out_dir: String,
) -> Result<EncodedVibe, String> {
    if vibe_encoding_key(&model).is_none() {
        return Err(format!("{} doesn't support Vibe Transfer.", model_family(&model)));
    }
    if !(0.01..=1.0).contains(&information_extracted) {
        return Err("Information Extracted must be between 0.01 and 1.".into());
    }
    let (png, img) = {
        let p = path.clone();
        tokio::task::spawn_blocking(move || prepared_png(&p)).await.map_err(|e| e.to_string())??
    };
    let dir = PathBuf::from(&out_dir);
    let target = encoded_vibe_path(&dir, &path, &png, &model, information_extracted).ok_or("No vibe key for this model.")?;
    if target.is_file() && load_vibe_file(&target.to_string_lossy()).is_ok() {
        return Ok(EncodedVibe { path: target.to_string_lossy().into_owned(), reused: true, anlas_warning: None });
    }

    let token = tokio::task::spawn_blocking(read_token)
        .await
        .map_err(|e| e.to_string())??
        .ok_or("Log in to NovelAI on the Generate tab first.")?;
    let before = fetch_status(&token).await?.anlas;
    if before < VIBE_ENCODE_COST {
        return Err(format!("Encoding costs {VIBE_ENCODE_COST} Anlas and the account has {before}."));
    }
    let body = json!({
        "image": base64::engine::general_purpose::STANDARD.encode(&png),
        "information_extracted": information_extracted,
        "model": model,
    });
    let result = send_in_turn(&run_id, || post_for_bytes(&token, "/ai/encode-vibe", &body)).await;
    cancelled_set().lock().unwrap().remove(&run_id);
    let bytes = result?.ok_or("Cancelled.")?;
    let encoding = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "vibe".into());
    // An "encoding" that's really an image would be charged again on use.
    check_encoding(&encoding, &name)?;

    let file = vibe_file_json(&name, &model, information_extracted, &encoding, &thumbnail_data_url(&img), &format!("{:016x}", content_hash(&png)));
    let t = target.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(t.parent().unwrap_or(Path::new("."))).map_err(|e| format!("couldn't create the folder: {e}"))?;
        std::fs::write(&t, serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?).map_err(|e| format!("couldn't save the vibe: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;

    let anlas_warning = match fetch_status(&token).await {
        Ok(s) if before - s.anlas > VIBE_ENCODE_COST => Some(format!(
            "NovelAI charged {} Anlas for the encode, more than the expected {VIBE_ENCODE_COST}.",
            before - s.anlas
        )),
        Ok(_) => None,
        Err(e) => Some(format!("Couldn't confirm the Anlas balance afterwards: {e}")),
    };
    Ok(EncodedVibe { path: target.to_string_lossy().into_owned(), reused: false, anlas_warning })
}

/// The vibe files (.naiv4vibe, .naiv4vibebundle) directly in `dir`.
pub fn list_vibe_files(dir: &str) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("couldn't read {dir}: {e}"))?;
    let mut out: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("naiv4vibe") || x.eq_ignore_ascii_case("naiv4vibebundle"))
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort_by_key(|p| p.to_lowercase());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_vibe_file_reads_back_as_free_to_use() {
        let enc = base64::engine::general_purpose::STANDARD.encode([7u8; 64]);
        let json = vibe_file_json("cat", "nai-diffusion-4-5-full", 0.8, &enc, "data:image/jpeg;base64,AA==", "abc");
        let vibes = parse_vibes(&json.to_string()).unwrap();
        let info = vibe_info(0, &vibes[0]);
        assert_eq!(info.name, "cat");
        assert_eq!(info.encodings.len(), 1);
        assert_eq!(info.encodings[0].model, "nai-diffusion-4-5-full");
        assert_eq!(info.encodings[0].information_extracted, Some(0.8));
        let mut files = VibeFiles::new();
        files.insert("x".into(), vibes);
        let r = VibeRef { path: "x".into(), index: 0, information_extracted: Some(0.8), strength: 0.6 };
        let resolved = resolve_vibes("nai-diffusion-4-5-full", &[r], &mut files).unwrap();
        assert_eq!(resolved[0].encoding, enc);
    }

    #[test]
    fn the_cache_name_depends_on_image_model_and_information_extracted() {
        let d = Path::new("C:/v");
        let a = encoded_vibe_path(d, "C:/x/cat.png", b"one", "nai-diffusion-4-5-full", 1.0).unwrap();
        assert_eq!(a, encoded_vibe_path(d, "C:/y/cat.png", b"one", "nai-diffusion-4-5-full", 1.0).unwrap());
        assert_ne!(a, encoded_vibe_path(d, "C:/x/cat.png", b"two", "nai-diffusion-4-5-full", 1.0).unwrap());
        assert_ne!(a, encoded_vibe_path(d, "C:/x/cat.png", b"one", "nai-diffusion-4-full", 1.0).unwrap());
        assert_ne!(a, encoded_vibe_path(d, "C:/x/cat.png", b"one", "nai-diffusion-4-5-full", 0.5).unwrap());
        assert!(encoded_vibe_path(d, "C:/x/cat.png", b"one", "nai-diffusion-5-full", 1.0).is_none());
    }
}
