import { invoke } from "@tauri-apps/api/core";
import { generateStore } from "./generateSettings";

export type PromptFileMode = "random" | "sequential";

/** A prompt file in use: its lines, its token name, and how lines are picked. */
export type PromptFile = {
  path: string;
  /** Used in prompts as `__name__`. */
  name: string;
  lines: string[];
  mode: PromptFileMode;
  /** The next line in sequential mode. */
  position: number;
  /** Set when the file couldn't be read; it stays listed so its token isn't silently dropped. */
  error: string | null;
};

/** One prompt segment per non-blank line, as parsed in Rust. */
export async function readPromptFile(path: string): Promise<string[]> {
  return invoke("nai_read_prompt_file", { path });
}

/** Reads a file and its saved sequential position. Never throws. */
export async function openPromptFile(path: string, name: string, mode: PromptFileMode): Promise<PromptFile> {
  let lines: string[];
  try {
    lines = await readPromptFile(path);
  } catch (err) {
    return { path, name, lines: [], mode, position: 0, error: String(err) };
  }
  // The file may have been edited since; keep the saved position in range.
  // A position that can't be read just means starting from the first line.
  const position = await loadPosition(path).then((p) => p % lines.length, () => 0);
  return { path, name, lines, mode, position, error: null };
}

/**
 * Line indices for the next `count` generations. Sequential continues from
 * `position` and wraps at the end of the file; random picks independently
 * for each image.
 */
export function pickLineIndices(
  lineCount: number,
  mode: PromptFileMode,
  position: number,
  count: number,
  random: () => number = Math.random,
): number[] {
  return Array.from({ length: count }, (_, i) =>
    mode === "sequential"
      ? (position + i) % lineCount
      : Math.floor(random() * lineCount),
  );
}

// Sequential positions are kept per file path, so removing and re-adding a
// file (or restarting the app) picks it up where it left off.
const store = generateStore;
const POSITIONS_KEY = "promptFilePositions";

export async function loadPosition(path: string): Promise<number> {
  const positions = (await store.get<Record<string, number>>(POSITIONS_KEY)) ?? {};
  return positions[path] ?? 0;
}

export async function savePosition(path: string, position: number): Promise<void> {
  const positions = (await store.get<Record<string, number>>(POSITIONS_KEY)) ?? {};
  positions[path] = position;
  await store.set(POSITIONS_KEY, positions);
}
