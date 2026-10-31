import { LazyStore } from "@tauri-apps/plugin-store";
import {
  MODELS,
  SIZES,
  MAX_CHARACTERS,
  MAX_STEPS,
  MAX_SCALE,
  MAX_BATCH,
  MAX_VIBES,
  DEFAULT_VIBE_STRENGTH,
  DEFAULT_STEPS,
  DEFAULT_SCALE,
  CENTER,
  type CharacterPosition,
} from "./novelai";
import type { PromptFileMode } from "./promptFile";
import { fileTokenName, isValidTokenName, tokenFor } from "./promptTokens";

// One store for everything the Generate tab saves, shared with the prompt
// file's sequential positions. The API token is never stored here — it
// lives only in Windows Credential Manager.
export const generateStore = new LazyStore("generate-settings.json");

/** A vibe as remembered between sessions; the file is read again on load. */
export type SavedVibe = {
  path: string;
  index: number;
  strength: number;
  informationExtracted: number | null;
  enabled: boolean;
};

/** A prompt file as remembered between sessions; it's read again on load. */
export type SavedPromptFile = {
  path: string;
  name: string;
  mode: PromptFileMode;
};

export type GenerateSettings = {
  model: string;
  sizeIndex: number;
  prompt: string;
  negativePrompt: string;
  characters: string[];
  /** Each character's undesired content, the same length as `characters`. */
  characterNegatives: string[];
  /** On: characters go where `characterPositions` says ("Custom"); off: "AI's choice". */
  useCoords: boolean;
  /** Each character's position, the same length as `characters`. */
  characterPositions: CharacterPosition[];
  steps: number;
  scale: number;
  count: number;
  outputDir: string | null;
  promptFiles: SavedPromptFile[];
  vibes: SavedVibe[];
};

export const DEFAULT_SETTINGS: GenerateSettings = {
  model: MODELS[0].id,
  sizeIndex: 0,
  prompt: "",
  negativePrompt: "",
  characters: [],
  characterNegatives: [],
  useCoords: false,
  characterPositions: [],
  steps: DEFAULT_STEPS,
  scale: DEFAULT_SCALE,
  count: 1,
  outputDir: null,
  promptFiles: [],
  vibes: [],
};

const SETTINGS_KEY = "form";

const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

// A list the user builds by hand stays small; this only guards against a
// corrupted file.
const MAX_SAVED_VIBES = 32;

function sanitizeVibes(raw: unknown): SavedVibe[] {
  if (!Array.isArray(raw)) return [];
  const vibes: SavedVibe[] = [];
  for (const v of raw.slice(0, MAX_SAVED_VIBES)) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.path !== "string" || typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0) {
      continue;
    }
    const ie = r.informationExtracted;
    vibes.push({
      path: r.path,
      index: r.index,
      strength: clamp(r.strength, 0, 1, DEFAULT_VIBE_STRENGTH),
      informationExtracted: typeof ie === "number" && Number.isFinite(ie) ? ie : null,
      enabled: r.enabled === true,
    });
  }
  // Never come back with more switched on than can be sent for free.
  let on = 0;
  return vibes.map((v) => (v.enabled && ++on > MAX_VIBES ? { ...v, enabled: false } : v));
}

const MAX_PROMPT_FILES = 32;

function sanitizePromptFiles(raw: unknown): SavedPromptFile[] {
  if (!Array.isArray(raw)) return [];
  const files: SavedPromptFile[] = [];
  for (const f of raw.slice(0, MAX_PROMPT_FILES)) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    if (typeof r.path !== "string" || files.some((x) => x.path === r.path)) continue;
    const taken = files.map((x) => x.name);
    const name =
      typeof r.name === "string" && isValidTokenName(r.name) && !taken.includes(r.name)
        ? r.name
        : fileTokenName(r.path, taken);
    files.push({ path: r.path, name, mode: r.mode === "sequential" ? "sequential" : "random" });
  }
  return files;
}

// Before tokens, one file at a time replaced a whole field (the main prompt
// or one character), with optional text before and after its line. That
// becomes a file whose token stands in that field between the same text, so
// an existing setup keeps generating exactly what it did.
type Legacy = { promptFilePath?: unknown; fileTarget?: unknown; fileMode?: unknown; fileBefore?: unknown; fileAfter?: unknown };

function migrateLegacyFile(raw: Legacy, prompt: string, characters: string[]) {
  if (typeof raw.promptFilePath !== "string") return null;
  const file: SavedPromptFile = {
    path: raw.promptFilePath,
    name: fileTokenName(raw.promptFilePath, []),
    mode: raw.fileMode === "sequential" ? "sequential" : "random",
  };
  const field = str(raw.fileBefore, "") + tokenFor(file.name) + str(raw.fileAfter, "");
  const t = raw.fileTarget;
  if (typeof t === "number" && Number.isInteger(t) && t >= 0 && t < MAX_CHARACTERS) {
    const chars = [...characters, ...Array(Math.max(0, t + 1 - characters.length)).fill("")];
    chars[t] = field;
    return { file, prompt, characters: chars };
  }
  return { file, prompt: field, characters };
}

// Saved settings come from a file on disk that an older version of the app
// (or a hand edit) may have written, so each field is checked rather than
// trusted: anything unusable falls back to its default.
function sanitize(raw: Partial<Record<keyof GenerateSettings, unknown>> & Legacy): GenerateSettings {
  const d = DEFAULT_SETTINGS;
  let characters = Array.isArray(raw.characters)
    ? raw.characters.filter((c): c is string => typeof c === "string").slice(0, MAX_CHARACTERS)
    : d.characters;
  let prompt = str(raw.prompt, d.prompt);
  let promptFiles = sanitizePromptFiles(raw.promptFiles);
  const legacy = Array.isArray(raw.promptFiles) ? null : migrateLegacyFile(raw, prompt, characters);
  if (legacy) {
    ({ prompt, characters } = legacy);
    promptFiles = [legacy.file];
  }
  return {
    model: MODELS.some((m) => m.id === raw.model) ? (raw.model as string) : d.model,
    sizeIndex: Math.round(clamp(raw.sizeIndex, 0, SIZES.length - 1, d.sizeIndex)),
    prompt,
    negativePrompt: str(raw.negativePrompt, d.negativePrompt),
    characters,
    // Older settings had none; keep one per character either way.
    characterNegatives: characters.map((_, i) =>
      Array.isArray(raw.characterNegatives) && typeof raw.characterNegatives[i] === "string"
        ? (raw.characterNegatives[i] as string)
        : "",
    ),
    useCoords: raw.useCoords === true,
    characterPositions: characters.map((_, i) => {
      const p = Array.isArray(raw.characterPositions) ? (raw.characterPositions[i] as Record<string, unknown> | null) : null;
      return p && typeof p === "object" ? { x: clamp(p.x, 0, 1, 0.5), y: clamp(p.y, 0, 1, 0.5) } : CENTER;
    }),
    steps: Math.round(clamp(raw.steps, 1, MAX_STEPS, d.steps)),
    scale: clamp(raw.scale, 0, MAX_SCALE, d.scale),
    count: Math.round(clamp(raw.count, 1, MAX_BATCH, d.count)),
    outputDir: typeof raw.outputDir === "string" ? raw.outputDir : d.outputDir,
    promptFiles,
    vibes: sanitizeVibes(raw.vibes),
  };
}

export async function loadGenerateSettings(): Promise<GenerateSettings> {
  const raw = await generateStore.get<Partial<Record<keyof GenerateSettings, unknown>> & Legacy>(SETTINGS_KEY);
  return raw ? sanitize(raw) : DEFAULT_SETTINGS;
}

export async function saveGenerateSettings(settings: GenerateSettings): Promise<void> {
  await generateStore.set(SETTINGS_KEY, settings);
}
