import { invoke } from "@tauri-apps/api/core";
import { generateStore } from "./generateSettings";

export type PromptFileMode = "random" | "sequential";

/** Where a file's line goes: the main prompt, or character 0–3. */
export type PromptFileTarget = "main" | number;

/** One prompt segment per non-blank line, as parsed in Rust. */
export async function readPromptFile(path: string): Promise<string[]> {
  return invoke("nai_read_prompt_file", { path });
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

export function composeSegment(before: string, line: string, after: string): string {
  return before + line + after;
}

// Sequential positions are kept per file path, so switching between files
// (or restarting the app) picks each one up where it left off.
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
