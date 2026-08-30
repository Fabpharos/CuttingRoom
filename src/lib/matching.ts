import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type MatchMatrix = {
  albumPaths: string[];
  sourcePaths: string[];
  // distances[i][j] is the distance between albumPaths[i] and
  // sourcePaths[j], or null if either image failed to hash.
  distances: (number | null)[][];
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
): Promise<MatchMatrix> {
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

export type CopyJob = {
  src: string;
  fileName: string;
};

export async function copyFilesToFolder(jobs: CopyJob[], destDir: string): Promise<void> {
  await invoke("copy_files_to_folder", { jobs, destDir });
}

export function matchConfidenceLabel(distance: number | null): string {
  if (distance === null) return "";
  if (distance <= 8) return "Strong match";
  if (distance <= 16) return "Likely match";
  return "Weak match";
}

// Resolves each album (query) image to at most one source (target) image.
// A pair is eligible only within maxDistance; when duplicates aren't
// allowed, a one-to-one constraint is enforced by greedily claiming
// eligible pairs in order of increasing distance. That's not a globally
// optimal assignment in adversarial cases, but it's effectively exact for
// photo-matching distances, which cluster tightly around a handful of very
// low values with a big gap to the next-best candidate.
export function computeAssignment(
  distances: (number | null)[][],
  maxDistance: number,
  allowDuplicates: boolean,
): (number | null)[] {
  const albumCount = distances.length;
  const assignment: (number | null)[] = new Array(albumCount).fill(null);

  if (allowDuplicates) {
    for (let i = 0; i < albumCount; i++) {
      let best: number | null = null;
      let bestDist = Infinity;
      const row = distances[i];
      for (let j = 0; j < row.length; j++) {
        const d = row[j];
        if (d !== null && d <= maxDistance && d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      assignment[i] = best;
    }
    return assignment;
  }

  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < albumCount; i++) {
    const row = distances[i];
    for (let j = 0; j < row.length; j++) {
      const d = row[j];
      if (d !== null && d <= maxDistance) pairs.push({ i, j, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);

  const usedSource = new Set<number>();
  const usedAlbum = new Set<number>();
  for (const { i, j } of pairs) {
    if (usedAlbum.has(i) || usedSource.has(j)) continue;
    assignment[i] = j;
    usedAlbum.add(i);
    usedSource.add(j);
  }
  return assignment;
}
