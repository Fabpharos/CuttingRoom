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
} from "./novelai";
import type { PromptFileMode, PromptFileTarget } from "./promptFile";

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

export type GenerateSettings = {
  model: string;
  sizeIndex: number;
  prompt: string;
  negativePrompt: string;
  characters: string[];
  steps: number;
  scale: number;
  count: number;
  outputDir: string | null;
  promptFilePath: string | null;
  fileTarget: PromptFileTarget;
  fileMode: PromptFileMode;
  fileBefore: string;
  fileAfter: string;
  vibes: SavedVibe[];
};

export const DEFAULT_SETTINGS: GenerateSettings = {
  model: MODELS[0].id,
  sizeIndex: 0,
  prompt: "",
  negativePrompt: "",
  characters: [],
  steps: DEFAULT_STEPS,
  scale: DEFAULT_SCALE,
  count: 1,
  outputDir: null,
  promptFilePath: null,
  fileTarget: "main",
  fileMode: "random",
  fileBefore: "",
  fileAfter: "",
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

// Saved settings come from a file on disk that an older version of the app
// (or a hand edit) may have written, so each field is checked rather than
// trusted: anything unusable falls back to its default.
function sanitize(raw: Partial<Record<keyof GenerateSettings, unknown>>): GenerateSettings {
  const d = DEFAULT_SETTINGS;
  const characters = Array.isArray(raw.characters)
    ? raw.characters.filter((c): c is string => typeof c === "string").slice(0, MAX_CHARACTERS)
    : d.characters;
  const target = raw.fileTarget;
  return {
    model: MODELS.some((m) => m.id === raw.model) ? (raw.model as string) : d.model,
    sizeIndex: Math.round(clamp(raw.sizeIndex, 0, SIZES.length - 1, d.sizeIndex)),
    prompt: str(raw.prompt, d.prompt),
    negativePrompt: str(raw.negativePrompt, d.negativePrompt),
    characters,
    steps: Math.round(clamp(raw.steps, 1, MAX_STEPS, d.steps)),
    scale: clamp(raw.scale, 0, MAX_SCALE, d.scale),
    count: Math.round(clamp(raw.count, 1, MAX_BATCH, d.count)),
    outputDir: typeof raw.outputDir === "string" ? raw.outputDir : d.outputDir,
    promptFilePath: typeof raw.promptFilePath === "string" ? raw.promptFilePath : d.promptFilePath,
    fileTarget:
      typeof target === "number" && Number.isInteger(target) && target >= 0 && target < MAX_CHARACTERS
        ? target
        : d.fileTarget,
    fileMode: raw.fileMode === "sequential" ? "sequential" : d.fileMode,
    fileBefore: str(raw.fileBefore, d.fileBefore),
    fileAfter: str(raw.fileAfter, d.fileAfter),
    vibes: sanitizeVibes(raw.vibes),
  };
}

export async function loadGenerateSettings(): Promise<GenerateSettings> {
  const raw = await generateStore.get<Partial<Record<keyof GenerateSettings, unknown>>>(SETTINGS_KEY);
  return raw ? sanitize(raw) : DEFAULT_SETTINGS;
}

export async function saveGenerateSettings(settings: GenerateSettings): Promise<void> {
  await generateStore.set(SETTINGS_KEY, settings);
}
