mod detection;
mod matching;

use detection::{DetectionOutput, DetectionProgress, PixelateJob};
use matching::{CopyJob, MatchMatrix, MatchProgress};
use tauri::{Emitter, Manager};

#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let mut result = Ok(());
    clipboard_win::with_clipboard_attempts(10, || {
        result = clipboard_win::raw::set_file_list_with(&paths, clipboard_win::options::DoClear);
        if result.is_ok() {
            // Windows Explorer's Paste button checks this format to decide
            // whether the clipboard holds a copy vs. a cut; without it,
            // Explorer's ribbon/command-bar Paste can stay disabled even
            // though the file list itself is genuinely on the clipboard.
            if let Some(format) = clipboard_win::raw::register_format("Preferred DropEffect") {
                const DROPEFFECT_COPY: u32 = 5;
                let _ = clipboard_win::raw::set_without_clear(
                    format.get(),
                    &DROPEFFECT_COPY.to_le_bytes(),
                );
            }
        }
    })
    .map_err(|e| e.to_string())?;
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn move_files_to_trash(paths: Vec<String>) -> Result<(), String> {
    trash::delete_all(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
async fn find_image_matches(
    app: tauri::AppHandle,
    run_id: String,
    album_paths: Vec<String>,
    source_paths: Vec<String>,
) -> MatchMatrix {
    // Explicitly off the main thread regardless of how the IPC call itself
    // was dispatched: hashing hundreds of images is CPU-bound work that
    // would otherwise make the window appear to hang.
    let progress_run_id = run_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        matching::find_matches(run_id, album_paths, source_paths, |done, total| {
            let _ = app.emit(
                "match-progress",
                MatchProgress {
                    run_id: progress_run_id.clone(),
                    done,
                    total,
                },
            );
        })
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn cancel_match(run_id: String) {
    matching::cancel_run(&run_id);
}

#[tauri::command]
async fn copy_files_to_folder(jobs: Vec<CopyJob>, dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || matching::copy_files_to_folder(jobs, dest_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn detect_bulk_images(
    app: tauri::AppHandle,
    run_id: String,
    python_path: String,
    input_dir: String,
    model_path: String,
    conf: f32,
) -> Result<DetectionOutput, String> {
    let script_path = app
        .path()
        .resolve("resources/detect.py", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("couldn't locate bundled detect.py: {e}"))?
        .to_string_lossy()
        .to_string();

    let progress_run_id = run_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        detection::run_detection(
            python_path,
            script_path,
            input_dir,
            model_path,
            conf,
            run_id,
            |stage, done, total| {
                let _ = app.emit(
                    "detection-progress",
                    DetectionProgress {
                        run_id: progress_run_id.clone(),
                        stage: stage.to_string(),
                        done,
                        total,
                    },
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_detection(run_id: String) {
    detection::cancel_detection(&run_id);
}

#[tauri::command]
async fn apply_pixelation(
    app: tauri::AppHandle,
    run_id: String,
    jobs: Vec<PixelateJob>,
    output_dir: String,
    block_size: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        detection::apply_pixelation(jobs, output_dir, block_size, |done, total| {
            let _ = app.emit(
                "pixelate-progress",
                DetectionProgress {
                    run_id: run_id.clone(),
                    stage: "applying".to_string(),
                    done,
                    total,
                },
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            copy_files_to_clipboard,
            move_files_to_trash,
            find_image_matches,
            cancel_match,
            copy_files_to_folder,
            detect_bulk_images,
            cancel_detection,
            apply_pixelation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
