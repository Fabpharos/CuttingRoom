use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

// Pairs the file to actually copy with the name it should be given in the
// destination — matching always copies photo *content* from whichever
// file won the match, but the caller wants the result named after the
// source photo, not whatever the matched target photo happened to be
// called.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyJob {
    pub src: String,
    pub file_name: String,
}

// The full pairwise distance matrix, rather than just each album image's
// single best match — resolving matches down to a one-to-one assignment
// (see `computeAssignment` on the frontend) needs every candidate's
// distance, not just the winner, and both the max-distance threshold and
// the allow-duplicates toggle can then be re-applied instantly without
// re-hashing anything.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatchMatrix {
    pub album_paths: Vec<String>,
    pub source_paths: Vec<String>,
    /// distances[i][j] is the Hamming distance between album_paths[i] and
    /// source_paths[j], or None if either image failed to hash.
    pub distances: Vec<Vec<Option<u32>>>,
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
) -> MatchMatrix {
    let total = album_paths.len() + source_paths.len();
    let mut done = 0usize;
    on_progress(done, total);

    let empty = || MatchMatrix {
        album_paths: Vec::new(),
        source_paths: Vec::new(),
        distances: Vec::new(),
    };

    let mut source_hashes: Vec<Option<u64>> = Vec::with_capacity(source_paths.len());
    for p in &source_paths {
        if is_cancelled(&run_id) {
            clear_cancelled(&run_id);
            return empty();
        }
        source_hashes.push(compute_dhash(p).ok());
        done += 1;
        on_progress(done, total);
    }

    let mut distances = Vec::with_capacity(album_paths.len());
    for album_path in &album_paths {
        if is_cancelled(&run_id) {
            clear_cancelled(&run_id);
            return empty();
        }

        let album_hash = compute_dhash(album_path).ok();
        let row: Vec<Option<u32>> = source_hashes
            .iter()
            .map(|source_hash| match (album_hash, source_hash) {
                (Some(a), Some(b)) => Some(hamming_distance(a, *b)),
                _ => None,
            })
            .collect();
        distances.push(row);
        done += 1;
        on_progress(done, total);
    }

    clear_cancelled(&run_id);
    MatchMatrix {
        album_paths,
        source_paths,
        distances,
    }
}

pub fn copy_files_to_folder(jobs: Vec<CopyJob>, dest_dir: String) -> Result<(), String> {
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    // A copy batch can mix matched target photos with fallback copies of
    // the source photos themselves, and several rows can independently
    // want the same destination name, so two entries landing on the same
    // filename is a real possibility, not just a theoretical edge case —
    // number the later one instead of silently overwriting the first.
    let mut used: HashSet<String> = HashSet::new();
    for job in jobs {
        let file_name = job.file_name;
        let stem = Path::new(&file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());
        let ext = Path::new(&file_name)
            .extension()
            .map(|s| s.to_string_lossy().to_string());

        let mut candidate = file_name.clone();
        let mut n = 1u32;
        while used.contains(&candidate) || Path::new(&dest_dir).join(&candidate).exists() {
            candidate = match &ext {
                Some(e) => format!("{stem} ({n}).{e}"),
                None => format!("{stem} ({n})"),
            };
            n += 1;
        }
        used.insert(candidate.clone());

        let dest = Path::new(&dest_dir).join(&candidate);
        std::fs::copy(&job.src, &dest).map_err(|e| format!("{}: {e}", job.src))?;
    }
    Ok(())
}
