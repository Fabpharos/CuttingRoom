use image::imageops::FilterType;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub album_path: String,
    pub match_path: Option<String>,
    pub distance: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchProgress {
    pub run_id: String,
    pub done: usize,
    pub total: usize,
}

// Lets the frontend cancel an in-progress match by id — closing the review
// modal mid-run doesn't stop the Rust-side work on its own, so without this
// an abandoned run keeps hashing (and keeps emitting progress events that a
// later run's listener would otherwise also pick up).
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

// Difference hash (dHash): shrink to a fixed 9x8 grayscale grid and record
// which way each pixel's brightness steps relative to its right neighbor.
// Because the image is resized to the same tiny grid regardless of its
// original size, the hash is inherently resolution-independent — an
// upscaled or downscaled copy of the same photo hashes almost identically.
fn compute_dhash(path: &str) -> Result<u64, String> {
    let img = image::open(path).map_err(|e| format!("{path}: {e}"))?;
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();

    let mut hash: u64 = 0;
    let mut bit = 0u32;
    for y in 0..8 {
        for x in 0..8 {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            if left > right {
                hash |= 1 << bit;
            }
            bit += 1;
        }
    }
    Ok(hash)
}

fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

pub fn find_matches(
    run_id: String,
    album_paths: Vec<String>,
    source_paths: Vec<String>,
    mut on_progress: impl FnMut(usize, usize),
) -> Vec<MatchResult> {
    let total = album_paths.len() + source_paths.len();
    let mut done = 0usize;
    on_progress(done, total);

    let mut source_hashes: Vec<(String, u64)> = Vec::new();
    for p in source_paths {
        if is_cancelled(&run_id) {
            clear_cancelled(&run_id);
            return Vec::new();
        }
        if let Ok(h) = compute_dhash(&p) {
            source_hashes.push((p, h));
        }
        done += 1;
        on_progress(done, total);
    }

    let mut results = Vec::new();
    for album_path in album_paths {
        if is_cancelled(&run_id) {
            clear_cancelled(&run_id);
            return Vec::new();
        }

        let album_hash = compute_dhash(&album_path).ok();
        done += 1;
        on_progress(done, total);

        let result = match album_hash {
            None => MatchResult {
                album_path,
                match_path: None,
                distance: None,
            },
            Some(album_hash) => {
                let best = source_hashes
                    .iter()
                    .map(|(p, h)| (p, hamming_distance(album_hash, *h)))
                    .min_by_key(|(_, d)| *d);
                match best {
                    Some((p, d)) => MatchResult {
                        album_path,
                        match_path: Some(p.clone()),
                        distance: Some(d),
                    },
                    None => MatchResult {
                        album_path,
                        match_path: None,
                        distance: None,
                    },
                }
            }
        };
        results.push(result);
    }

    clear_cancelled(&run_id);
    results
}

pub fn copy_files_to_folder(paths: Vec<String>, dest_dir: String) -> Result<(), String> {
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    for p in paths {
        let file_name = Path::new(&p)
            .file_name()
            .ok_or_else(|| format!("invalid path: {p}"))?;
        let dest = Path::new(&dest_dir).join(file_name);
        std::fs::copy(&p, &dest).map_err(|e| format!("{p}: {e}"))?;
    }
    Ok(())
}
