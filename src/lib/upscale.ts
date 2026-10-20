import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

// Mirror the Rust-side limits, which are what actually enforce them.
/** NovelAI charges 1 Anlas per upscale up to this many pixels, more above. */
export const UPSCALE_MAX_PIXELS = 1_048_576;
export const UPSCALE_COST = 1;
/** Images per confirmation. */
export const UPSCALE_BATCH = 10;

export type UpscaleCandidate = { path: string; width: number; height: number };
export type SkippedFile = { path: string; reason: string };
export type UpscaleScan = { eligible: UpscaleCandidate[]; skipped: SkippedFile[] };

/** Checks one file, or every image directly inside a folder (not subfolders). */
export async function scanForUpscale(path: string, isFolder: boolean): Promise<UpscaleScan> {
  return invoke("nai_scan_upscale", { path, isFolder });
}

export type UpscaledImage = { source: string; path: string };

export type UpscaleProgress = {
  runId: string;
  done: number;
  total: number;
  image: UpscaledImage | null;
};

export type UpscaleSummary = {
  images: UpscaledImage[];
  cancelled: boolean;
  /** Set when the batch stopped early for a reason other than cancelling. */
  stoppedReason: string | null;
  anlasSpent: number;
};

/** Upscales up to UPSCALE_BATCH files, saving `<name>_upscaled.png` in `outputDir`. */
export async function upscaleBatch(
  runId: string,
  paths: string[],
  outputDir: string,
  onProgress?: (progress: UpscaleProgress) => void,
): Promise<UpscaleSummary> {
  // Progress events are broadcast globally; only this run's are ours.
  const unlisten = onProgress
    ? await listen<UpscaleProgress>("nai-upscale-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    return await invoke("nai_upscale_batch", { runId, paths, outputDir });
  } finally {
    unlisten?.();
  }
}

// Uses the same cancel registry as generation batches; run ids never collide.
export async function cancelUpscale(runId: string): Promise<void> {
  await invoke("nai_cancel_batch", { runId });
}

const store = new LazyStore("upscale-settings.json");

export async function loadUpscaleOutputDir(): Promise<string | null> {
  const dir = await store.get<unknown>("outputDir");
  return typeof dir === "string" ? dir : null;
}

export async function saveUpscaleOutputDir(dir: string): Promise<void> {
  await store.set("outputDir", dir);
}
