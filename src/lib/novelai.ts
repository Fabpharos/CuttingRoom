import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Opus's refilling quota for usage-limited models (V5). */
export type UsageStatus = {
  isNegative: boolean;
  percent: number;
  purchasedPercent: number;
};

export type AccountStatus = {
  tier: number;
  tierName: string;
  active: boolean;
  isOpus: boolean;
  anlas: number;
  usage: UsageStatus | null;
};

// The token itself never comes back to the frontend — it lives only in
// Windows Credential Manager, and only the Rust side reads it.

/** Status for the saved token, or null when no token is saved. */
export async function getAccountStatus(): Promise<AccountStatus | null> {
  return invoke("nai_account_status");
}

/** Validates the token with NovelAI, then saves it. */
export async function setApiToken(token: string): Promise<AccountStatus> {
  return invoke("nai_set_token", { token });
}

export async function clearApiToken(): Promise<void> {
  await invoke("nai_clear_token");
}

export type ModelInfo = {
  id: string;
  label: string;
  /** Draws from Opus's refilling quota rather than being unlimited. */
  usageLimited: boolean;
  /** Models that only run at one step count. */
  fixedSteps?: number;
  /** Supports Vibe Transfer (V5 doesn't yet). */
  vibes: boolean;
};

// Mirrors the Rust-side allowlist; the backend validates these again.
export const MODELS: ModelInfo[] = [
  { id: "nai-diffusion-5-full", label: "NAI Diffusion V5 Full", usageLimited: true, vibes: false },
  {
    id: "nai-diffusion-5-full-medium",
    label: "NAI Diffusion V5 Full (Medium Effort)",
    usageLimited: true,
    fixedSteps: 14,
    vibes: false,
  },
  { id: "nai-diffusion-5-curated", label: "NAI Diffusion V5 Curated", usageLimited: true, vibes: false },
  { id: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 Full", usageLimited: false, vibes: true },
  { id: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 Curated", usageLimited: false, vibes: true },
  { id: "nai-diffusion-4-full", label: "NAI Diffusion V4 Full", usageLimited: false, vibes: true },
  { id: "nai-diffusion-4-curated-preview", label: "NAI Diffusion V4 Curated", usageLimited: false, vibes: true },
];

export const DEFAULT_STEPS = 28;
// More than 28 steps costs Anlas even on Opus.
export const MAX_STEPS = 28;
export const DEFAULT_SCALE = 5;
export const MAX_SCALE = 10;

export const SIZES: { width: number; height: number; label: string }[] = [
  { width: 832, height: 1216, label: "Portrait" },
  { width: 1216, height: 832, label: "Landscape" },
  { width: 1024, height: 1024, label: "Square" },
];

export const MAX_CHARACTERS = 4;

/** Where a character sits, as fractions of the image from its top-left corner. */
export type CharacterPosition = { x: number; y: number };
export const CENTER: CharacterPosition = { x: 0.5, y: 0.5 };

// Character placement, mirroring novelai-core (which enforces it): V5 places
// characters anywhere, even a lone one; V4 and V4.5 snap to NovelAI's 5x5
// grid and only place characters when there are two or more.
export function freeCharacterPositions(model: string): boolean {
  return model.startsWith("nai-diffusion-5");
}

export function positionsApply(model: string, count: number): boolean {
  return count >= 2 || (count === 1 && freeCharacterPositions(model));
}

export function snapToGrid(v: number): number {
  const k = Math.min(4, Math.max(0, Math.round((v - 0.1) / 0.2)));
  return Math.round((0.1 + 0.2 * k) * 10) / 10;
}

export function positionForModel(model: string, p: CharacterPosition): CharacterPosition {
  return freeCharacterPositions(model)
    ? { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }
    : { x: snapToGrid(p.x), y: snapToGrid(p.y) };
}

/** A grid cell's name as NovelAI's site shows it: column A-E, row 1-5. */
export function gridLabel(p: CharacterPosition): string {
  const index = (v: number) => Math.min(4, Math.round((snapToGrid(v) - 0.1) / 0.2));
  return `${"ABCDE"[index(p.x)]}${index(p.y) + 1}`;
}

// Each vibe past the fourth costs Anlas, so the Rust side refuses a fifth.
export const MAX_VIBES = 4;
export const DEFAULT_VIBE_STRENGTH = 0.6;

/** A vibe to send: which file, which vibe in it, and how strongly. */
export type VibeRef = {
  path: string;
  index: number;
  /** Picks between encodings when the file has several for the model. */
  informationExtracted: number | null;
  strength: number;
};

export type VibeEncodingInfo = { model: string; informationExtracted: number | null };

/** One vibe in a file. The encodings themselves never leave Rust. */
export type VibeInfo = {
  index: number;
  name: string;
  /** A data: URL, when the file has one. */
  thumbnail: string | null;
  /** In the order generation picks from them. */
  encodings: VibeEncodingInfo[];
  /** The settings it was exported with, if recorded. */
  strength: number | null;
  informationExtracted: number | null;
};

/** Reads a .naiv4vibe / .naiv4vibebundle file, or a PNG with vibes embedded. */
export async function readVibeFile(path: string): Promise<VibeInfo[]> {
  return invoke("nai_read_vibe_file", { path });
}

/**
 * The encoding a vibe would use with `model`, or null when it has none —
 * using it would mean a paid encode, so it's left out. Rust picks the same
 * way (resolve_vibes).
 */
export function vibeEncodingFor(
  info: VibeInfo,
  model: string,
  informationExtracted: number | null,
): VibeEncodingInfo | null {
  const options = info.encodings.filter((e) => e.model === model);
  return options.find((e) => e.informationExtracted === informationExtracted) ?? options[0] ?? null;
}

export type GenerateRequest = {
  model: string;
  prompt: string;
  negativePrompt: string;
  characters: string[];
  /** Each character's undesired content, by position. */
  characterNegatives: string[];
  /** Where each character goes; null lets the model place them. */
  characterPositions: CharacterPosition[] | null;
  width: number;
  height: number;
  steps: number;
  scale: number;
  seed: number;
  fileStem: string;
  vibes: VibeRef[];
};

/** Settings read from a NovelAI image's metadata, before deciding what applies. */
export type ImportedSettings = {
  prompt: string;
  negativePrompt: string;
  characters: string[];
  /** Lined up with `characters`; empty where the image had none. */
  characterNegatives: string[];
  /** Set when the image placed its characters itself. */
  characterPositions: CharacterPosition[] | null;
  width: number | null;
  height: number | null;
  steps: number | null;
  scale: number | null;
  seed: number | null;
  /** Our model ID, or null if the image's model isn't one this tab offers. */
  model: string | null;
  source: string | null;
};

export async function readImageMetadata(path: string): Promise<ImportedSettings> {
  return invoke("nai_read_image_metadata", { path });
}

/** The parts of the form an import can change; absent keys stay as they are. */
export type FormValues = {
  model?: string;
  sizeIndex?: number;
  prompt: string;
  negativePrompt: string;
  characters: string[];
  characterNegatives: string[];
  /** Null means "AI's choice". */
  characterPositions: CharacterPosition[] | null;
  steps?: number;
  scale?: number;
};

export type ImportPlan = {
  /** What will change, for the confirmation dialog. */
  applied: { label: string; value: string }[];
  /** What can't be applied here, and why. */
  skipped: string[];
  values: FormValues;
};

// Works out which of an image's settings this tab can apply, clamping or
// skipping anything outside its limits instead of failing the whole import.
export function buildImportPlan(s: ImportedSettings): ImportPlan {
  const applied: ImportPlan["applied"] = [];
  const skipped: string[] = [];
  const values: FormValues = {
    prompt: s.prompt,
    negativePrompt: s.negativePrompt,
    characters: s.characters.slice(0, MAX_CHARACTERS),
    characterNegatives: s.characters.slice(0, MAX_CHARACTERS).map((_, i) => s.characterNegatives[i] ?? ""),
    characterPositions: s.characterPositions
      ? s.characters.slice(0, MAX_CHARACTERS).map((_, i) => s.characterPositions?.[i] ?? CENTER)
      : null,
  };
  const shorten = (t: string) => (t.length > 90 ? t.slice(0, 90) + "…" : t || "(empty)");

  const model = MODELS.find((m) => m.id === s.model);
  if (model) {
    values.model = model.id;
    applied.push({ label: "Model", value: model.label });
  } else {
    skipped.push(
      `Model: ${s.source ?? "unknown"} isn't available here, so the current model is kept.`,
    );
  }

  applied.push({ label: "Prompt", value: shorten(s.prompt) });
  applied.push({ label: "Undesired content", value: shorten(s.negativePrompt) });
  if (s.characters.length > 0) {
    applied.push({
      label: "Characters",
      value: values.characters
        .map((c, i) => {
          const uc = values.characterNegatives[i];
          return `${i + 1}. ${shorten(c)}${uc ? ` (undesired: ${shorten(uc)})` : ""}`;
        })
        .join("  "),
    });
  }
  if (s.characters.length > 0) {
    const positions = values.characterPositions;
    applied.push({
      label: "Character positions",
      value: positions
        ? positions
            .map((p, i) =>
              freeCharacterPositions(values.model ?? "")
                ? `${i + 1}. x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)}`
                : `${i + 1}. ${gridLabel(p)}`,
            )
            .join("  ")
        : "AI's choice",
    });
  }
  if (s.characters.length > MAX_CHARACTERS) {
    skipped.push(
      `Characters: only the first ${MAX_CHARACTERS} of ${s.characters.length} are imported.`,
    );
  }

  if (s.width !== null && s.height !== null) {
    const sizeIndex = SIZES.findIndex((z) => z.width === s.width && z.height === s.height);
    if (sizeIndex >= 0) {
      values.sizeIndex = sizeIndex;
      applied.push({ label: "Resolution", value: `${SIZES[sizeIndex].label} ${s.width}×${s.height}` });
    } else {
      skipped.push(
        `Resolution: ${s.width}×${s.height} isn't one of the three allowed sizes, so the current one is kept.`,
      );
    }
  }

  const fixedSteps = (model ?? null)?.fixedSteps;
  if (s.steps !== null && fixedSteps === undefined) {
    const steps = Math.min(Math.max(Math.round(s.steps), 1), MAX_STEPS);
    values.steps = steps;
    applied.push({ label: "Steps", value: String(steps) });
    if (steps !== s.steps) {
      skipped.push(`Steps: ${s.steps} is above the ${MAX_STEPS}-step limit, so it's set to ${steps}.`);
    }
  }

  if (s.scale !== null) {
    const scale = Math.min(Math.max(s.scale, 0), MAX_SCALE);
    values.scale = Math.round(scale * 10) / 10;
    applied.push({ label: "Guidance", value: String(values.scale) });
    if (scale !== s.scale) {
      skipped.push(`Guidance: ${s.scale} is outside 0–${MAX_SCALE}, so it's set to ${values.scale}.`);
    }
  }

  if (s.seed !== null) {
    skipped.push(`Seed ${s.seed}: not imported, since every generation here uses a random seed.`);
  }

  return { applied, skipped, values };
}

export type GeneratedImage = { path: string; seed: number };

export type BatchProgress = {
  runId: string;
  done: number;
  total: number;
  image: GeneratedImage | null;
};

export type BatchSummary = {
  images: GeneratedImage[];
  cancelled: boolean;
  /** Set when the batch stopped early for a reason other than cancelling. */
  stoppedReason: string | null;
};

// Mirrors the Rust-side cap, which is what actually enforces it.
export const MAX_BATCH = 25;

/**
 * Runs `requests` in order, at least 2 seconds apart (enforced in Rust).
 * With `guardAnlas`, the batch stops the moment the account is charged.
 */
export async function generateBatch(
  runId: string,
  requests: GenerateRequest[],
  outputDir: string,
  guardAnlas: boolean,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchSummary> {
  // Progress events are broadcast globally; only this run's are ours.
  const unlisten = onProgress
    ? await listen<BatchProgress>("nai-batch-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    return await invoke("nai_generate_batch", { runId, requests, outputDir, guardAnlas });
  } finally {
    unlisten?.();
  }
}

export async function cancelBatch(runId: string): Promise<void> {
  await invoke("nai_cancel_batch", { runId });
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

// Local-time "2026-10-16_14-03-27_03_<seed>": the batch's start time, then the
// image's position in it, so files sort in the order they were made.
export function fileStemFor(seed: number, index: number, batchStart: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = `${batchStart.getFullYear()}-${pad(batchStart.getMonth() + 1)}-${pad(batchStart.getDate())}`;
  const t = `${pad(batchStart.getHours())}-${pad(batchStart.getMinutes())}-${pad(batchStart.getSeconds())}`;
  return `${d}_${t}_${pad(index + 1)}_${seed}`;
}
