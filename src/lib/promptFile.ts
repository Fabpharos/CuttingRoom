import { invoke } from "@tauri-apps/api/core";
import { generateStore } from "./generateSettings";
import { partName } from "./promptTokens";

export type PromptFileMode = "random" | "sequential";

/** A prompt file in use: its entries, its token name, and how entries are picked. */
export type PromptFile = {
  path: string;
  /** Used in prompts as `__name__` (and `__name:part__` for a paired file's parts). */
  name: string;
  /** Each entry's main line. */
  lines: string[];
  /** Each entry's labelled parts ("girl" -> "smile, blush"), lined up with `lines`. */
  parts: Record<string, string>[];
  /** Every label used in the file, in first-seen order; empty for a plain file. */
  partNames: string[];
  mode: PromptFileMode;
  /** The next line in sequential mode. */
  position: number;
  /** Set when the file couldn't be read; it stays listed so its token isn't silently dropped. */
  error: string | null;
};

/** The project's `wildcards` folder, where prompt files live by default. */
export async function wildcardsDir(): Promise<string> {
  return invoke("wildcards_dir");
}

export async function openWildcardsDir(): Promise<void> {
  await invoke("open_wildcards_dir");
}

// A paired file's part line: a label of up to 30 characters starting with a
// letter, one colon, then a space and its text ("girl: smile, blush") or
// nothing ("boy:", a character with no extra tags). Needing the space keeps
// NovelAI tags like "artist:name" from looking like labels, and "Text:" is
// never a label: that's NovelAI's syntax for writing in images.
const PART_LINE = /^([A-Za-z][A-Za-z0-9 _-]{0,29}):(?:\s+(.*))?$/;

/**
 * Splits a file's lines into entries. A line starts a new entry unless it's
 * a labelled part line following one, so a plain file (one prompt per line)
 * is every line an entry, and a paired file is
 *
 *     # an optional comment, ignored
 *     main prompt
 *     girl: tags for the girl
 *     boy: tags for the boy
 *
 * Lines starting with `#` are comments in any file.
 */
export function parseEntries(rawLines: string[]): Pick<PromptFile, "lines" | "parts" | "partNames"> {
  const lines: string[] = [];
  const parts: Record<string, string>[] = [];
  const partNames: string[] = [];
  for (const raw of rawLines) {
    if (raw.startsWith("#")) continue;
    const m = PART_LINE.exec(raw);
    const label = m ? partName(m[1]) : "";
    if (m && label && label !== "text" && lines.length > 0) {
      parts[parts.length - 1][label] = (m[2] ?? "").trim();
      if (!partNames.includes(label)) partNames.push(label);
    } else {
      lines.push(raw);
      parts.push({});
    }
  }
  return { lines, parts, partNames };
}

/** One prompt segment per non-blank line, as parsed in Rust. */
export async function readPromptFile(path: string): Promise<string[]> {
  return invoke("nai_read_prompt_file", { path });
}

/** Reads a file and its saved sequential position. Never throws. */
export async function openPromptFile(path: string, name: string, mode: PromptFileMode): Promise<PromptFile> {
  let entries: Pick<PromptFile, "lines" | "parts" | "partNames">;
  try {
    entries = parseEntries(await readPromptFile(path));
  } catch (err) {
    return { path, name, lines: [], parts: [], partNames: [], mode, position: 0, error: String(err) };
  }
  // The file may have been edited since; keep the saved position in range.
  // A position that can't be read just means starting from the first entry.
  const position = await loadPosition(path).then((p) => p % entries.lines.length, () => 0);
  return { path, name, ...entries, mode, position, error: null };
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
