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
  /** Subscription and purchased Anlas together. */
  anlas: number;
  /** The subscription's monthly Anlas left (10,000 a month on Opus). */
  subscriptionAnlas: number;
  /** Anlas bought separately; they don't expire. */
  purchasedAnlas: number;
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
  /** How many character prompts NovelAI takes: 22 on V5, 6 on V4/V4.5. */
  maxCharacters: number;
  /** Supports Precise Reference (V4.5 only so far; V5 later). */
  preciseReference: boolean;
};

// Mirrors the Rust-side allowlist; the backend validates these again.
// When NovelAI adds a feature to a model, flip its flag here and in
// novelai-core.
const V5 = { usageLimited: true, vibes: false, maxCharacters: 22, preciseReference: false };
const V45 = { usageLimited: false, vibes: true, maxCharacters: 6, preciseReference: true };
const V4 = { usageLimited: false, vibes: true, maxCharacters: 6, preciseReference: false };
export const MODELS: ModelInfo[] = [
  { id: "nai-diffusion-5-full", label: "NAI Diffusion V5 Full", ...V5 },
  { id: "nai-diffusion-5-full-medium", label: "NAI Diffusion V5 Full (Medium Effort)", ...V5, fixedSteps: 14 },
  { id: "nai-diffusion-5-curated", label: "NAI Diffusion V5 Curated", ...V5 },
  { id: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 Full", ...V45 },
  { id: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 Curated", ...V45 },
  { id: "nai-diffusion-4-full", label: "NAI Diffusion V4 Full", ...V4 },
  { id: "nai-diffusion-4-curated-preview", label: "NAI Diffusion V4 Curated", ...V4 },
];

export function modelInfo(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

/** "V5", "V4.5" or "V4", for messages. */
export function modelFamily(id: string): string {
  return id.startsWith("nai-diffusion-5") ? "V5" : id.startsWith("nai-diffusion-4-5") ? "V4.5" : "V4";
}

/** Character prompts `model` takes (22 on V5, 6 on V4/V4.5). */
export function maxCharactersFor(model: string): number {
  return modelInfo(model)?.maxCharacters ?? 6;
}
/** The most any model takes. */
export const MAX_CHARACTERS_ANY = 22;

/** Samplers NovelAI's web client offers; Rust checks the same list. */
export const SAMPLERS: { id: string; label: string }[] = [
  { id: "k_euler_ancestral", label: "Euler Ancestral" },
  { id: "k_euler", label: "Euler" },
  { id: "k_dpmpp_2s_ancestral", label: "DPM++ 2S Ancestral" },
  { id: "k_dpmpp_2m_sde", label: "DPM++ 2M SDE" },
  { id: "k_dpmpp_2m", label: "DPM++ 2M" },
  { id: "k_dpmpp_sde", label: "DPM++ SDE" },
];
export const DEFAULT_SAMPLER = "k_euler_ancestral";
export const NOISE_SCHEDULES: { id: string; label: string }[] = [
  { id: "karras", label: "Karras" },
  { id: "exponential", label: "Exponential" },
  { id: "polyexponential", label: "Polyexponential" },
];
export const DEFAULT_NOISE_SCHEDULE = "karras";

/**
 * The value NovelAI's site sends as `skip_cfg_above_sigma` with Variety+ on:
 * 58 at 832×1216, scaled with the square root of the pixel count. Mirrors
 * `variety_plus_sigma` in novelai-core. Not yet checked against images made
 * on novelai.net with Variety+ (VARIETY_PLUS_VERIFIED).
 */
export function varietyPlusSigma(_model: string, width: number, height: number): number {
  const latent = 4 * (width / 8) * (height / 8);
  return Math.round(58 * Math.sqrt(latent / 63232) * 1e6) / 1e6;
}
export const VARIETY_PLUS_VERIFIED = false;

/** Whether a model takes Variety+. V5 doesn't; Rust refuses it there too. */
export function supportsVarietyPlus(model: string): boolean {
  return !model.startsWith("nai-diffusion-5");
}

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

// Any size is free on Opus up to 1024×1024 worth of pixels, in steps of 64
// (Rust checks the same rule before sending).
export const MAX_FREE_PIXELS = 1_048_576;
export const SIZE_STEP = 64;
export const MAX_SIDE = 2048;
/** The `sizeIndex` that means "use the custom width and height". */
export const CUSTOM_SIZE = SIZES.length;

/** Why width × height can't be generated for free, or null when it can. */
export function sizeProblem(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % SIZE_STEP || height % SIZE_STEP)
    return `Width and height must be multiples of ${SIZE_STEP}.`;
  if (width < SIZE_STEP || height < SIZE_STEP || width > MAX_SIDE || height > MAX_SIDE)
    return `Each side must be between ${SIZE_STEP} and ${MAX_SIDE}.`;
  if (width * height > MAX_FREE_PIXELS)
    return `${(width * height).toLocaleString()} pixels is over 1,048,576 (1024×1024), which would cost Anlas.`;
  return null;
}

/**
 * The free size closest to width × height with the same shape: the size
 * itself when it's free, else scaled down (an upscaled image) and rounded to
 * steps of 64.
 */
export function fitFreeSize(width: number | null, height: number | null): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  if (sizeProblem(width, height) === null) return { width, height };
  const scale = Math.min(1, Math.sqrt(MAX_FREE_PIXELS / (width * height)));
  const snap = (v: number) => Math.min(MAX_SIDE, Math.max(SIZE_STEP, Math.round((v * scale) / SIZE_STEP) * SIZE_STEP));
  let w = snap(width);
  let h = snap(height);
  // Rounding up can tip it over; trim whichever side rounded up the most.
  while (w * h > MAX_FREE_PIXELS) {
    if (w / (width * scale) >= h / (height * scale)) w -= SIZE_STEP;
    else h -= SIZE_STEP;
  }
  return { width: w, height: h };
}

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
  /** Image to image: the picture to start from and how much may change (0–1). */
  sourceImage?: { path: string; strength: number } | null;
  /** Null or absent: NovelAI's defaults (Euler Ancestral, Karras). */
  sampler?: string | null;
  noiseSchedule?: string | null;
  /** Variety+: set to `varietyPlusSigma(...)`; null leaves it off. */
  skipCfgAboveSigma?: number | null;
  /** Precise Reference images (V4.5; NovelAI charges 5 Anlas each per image). */
  preciseReferences?: PreciseReference[];
};

export type ReferenceKind = "character" | "style" | "character&style";
export type PreciseReference = { path: string; kind: ReferenceKind; strength: number; fidelity: number };
/** NovelAI's charge per reference per image. */
export const PRECISE_REFERENCE_COST = 5;
export const MAX_PRECISE_REFERENCES = 4;

/** What a request should cost; `anlas` is null when it can't be priced. */
export type CostEstimate = { free: boolean; anlas: number | null; reasons: string[] };

/** Rust's cost estimate for each request, against `account` (null: unknown). */
export async function estimateCosts(
  requests: GenerateRequest[],
  account: AccountStatus | null,
): Promise<CostEstimate[]> {
  return invoke("nai_estimate_costs", { requests, account });
}

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
  sampler: string | null;
  noiseSchedule: string | null;
  /** Set when the image was made with Variety+. */
  skipCfgAboveSigma: number | null;
};

export async function readImageMetadata(path: string): Promise<ImportedSettings> {
  return invoke("nai_read_image_metadata", { path });
}

/** The parts of the form an import can change; absent keys stay as they are. */
export type FormValues = {
  model?: string;
  sizeIndex?: number;
  /** Set with `sizeIndex: CUSTOM_SIZE`. */
  customSize?: { width: number; height: number };
  prompt: string;
  negativePrompt: string;
  characters: string[];
  characterNegatives: string[];
  /** Null means "AI's choice". */
  characterPositions: CharacterPosition[] | null;
  steps?: number;
  scale?: number;
  sampler?: string;
  noiseSchedule?: string;
  varietyPlus?: boolean;
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
// `currentModel` is the form's model, kept when the image's isn't offered.
export function buildImportPlan(s: ImportedSettings, currentModel?: string): ImportPlan {
  const applied: ImportPlan["applied"] = [];
  const skipped: string[] = [];
  const model = MODELS.find((m) => m.id === s.model);
  // The model the characters will be used with decides how many fit.
  const max = maxCharactersFor(model?.id ?? currentModel ?? "");
  const kept = s.characters.slice(0, max);
  const values: FormValues = {
    prompt: s.prompt,
    negativePrompt: s.negativePrompt,
    characters: kept,
    characterNegatives: kept.map((_, i) => s.characterNegatives[i] ?? ""),
    characterPositions: s.characterPositions ? kept.map((_, i) => s.characterPositions?.[i] ?? CENTER) : null,
  };
  const shorten = (t: string) => (t.length > 90 ? t.slice(0, 90) + "…" : t || "(empty)");

  if (model) {
    values.model = model.id;
    applied.push({ label: "Model", value: model.label });
  } else if (s.model !== null || s.source !== null) {
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
  if (s.characters.length > max) {
    skipped.push(
      `Characters: ${modelFamily(model?.id ?? currentModel ?? "")} takes ${max}, so only the first ${max} of ${s.characters.length} are imported.`,
    );
  }

  if (s.width !== null && s.height !== null) {
    const sizeIndex = SIZES.findIndex((z) => z.width === s.width && z.height === s.height);
    if (sizeIndex >= 0) {
      values.sizeIndex = sizeIndex;
      applied.push({ label: "Resolution", value: `${SIZES[sizeIndex].label} ${s.width}×${s.height}` });
    } else if (sizeProblem(s.width, s.height) === null) {
      values.sizeIndex = CUSTOM_SIZE;
      values.customSize = { width: s.width, height: s.height };
      applied.push({ label: "Resolution", value: `Custom ${s.width}×${s.height}` });
    } else {
      skipped.push(
        `Resolution: ${s.width}×${s.height} can't be made for free (${sizeProblem(s.width, s.height)}), so the current size is kept.`,
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

  if (s.sampler && SAMPLERS.some((x) => x.id === s.sampler)) {
    values.sampler = s.sampler;
    applied.push({ label: "Sampler", value: SAMPLERS.find((x) => x.id === s.sampler)!.label });
  }
  if (s.noiseSchedule && NOISE_SCHEDULES.some((x) => x.id === s.noiseSchedule)) {
    values.noiseSchedule = s.noiseSchedule;
    applied.push({ label: "Noise schedule", value: NOISE_SCHEDULES.find((x) => x.id === s.noiseSchedule)!.label });
  }
  const usesVariety = s.skipCfgAboveSigma !== null && s.skipCfgAboveSigma > 0;
  values.varietyPlus = usesVariety && supportsVarietyPlus(model?.id ?? currentModel ?? "");
  applied.push({ label: "Variety+", value: values.varietyPlus ? "On" : "Off" });
  if (usesVariety && !values.varietyPlus) skipped.push("Variety+: V5 doesn't take it, so it's left off.");

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
  /** The account after an image, when the Anlas guard checked it. */
  account: AccountStatus | null;
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
