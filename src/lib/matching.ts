import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type MatchResult = {
  albumPath: string;
  matchPath: string | null;
  distance: number | null;
};

export type MatchProgress = {
  runId: string;
  done: number;
  total: number;
};

export async function findImageMatches(
  runId: string,
  albumPaths: string[],
  sourcePaths: string[],
  onProgress?: (progress: MatchProgress) => void,
): Promise<MatchResult[]> {
  // Progress events are broadcast globally, not scoped to this call, so a
  // stale run's events (e.g. one abandoned by closing the modal) must be
  // filtered out by matching runId rather than assumed to belong to us.
  const unlisten = onProgress
    ? await listen<MatchProgress>("match-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    return await invoke("find_image_matches", { runId, albumPaths, sourcePaths });
  } finally {
    unlisten?.();
  }
}

export async function cancelMatch(runId: string): Promise<void> {
  await invoke("cancel_match", { runId });
}

export async function copyFilesToFolder(paths: string[], destDir: string): Promise<void> {
  await invoke("copy_files_to_folder", { paths, destDir });
}

export function matchConfidenceLabel(distance: number | null): string {
  if (distance === null) return "";
  if (distance <= 8) return "Strong match";
  if (distance <= 16) return "Likely match";
  return "Weak match";
}
