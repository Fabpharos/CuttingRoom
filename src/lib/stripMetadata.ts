import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type StripProgress = {
  runId: string;
  done: number;
  total: number;
};

export type StripSummary = {
  stripped: number;
  failed: number;
  cancelled: boolean;
};

export async function stripMetadata(
  runId: string,
  rootDir: string,
  onProgress?: (progress: StripProgress) => void,
): Promise<StripSummary> {
  const unlisten = onProgress
    ? await listen<StripProgress>("strip-metadata-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    return await invoke("strip_metadata", { runId, rootDir });
  } finally {
    unlisten?.();
  }
}

export async function cancelStripMetadata(runId: string): Promise<void> {
  await invoke("cancel_strip_metadata", { runId });
}
