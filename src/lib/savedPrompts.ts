// Saved prompts and the artist library, kept in the library (card) folder.

import { libraryFileName, listLibrary, readLibrary, writeLibrary } from "./library";
import { parseReferences, type GenerateSettings } from "./generateSettings";
import type { Rng } from "./promptEngine";

/** The parts of the Generate form a saved prompt keeps. */
export type PromptSnapshot = Pick<
  GenerateSettings,
  | "model"
  | "sizeIndex"
  | "customWidth"
  | "customHeight"
  | "prompt"
  | "negativePrompt"
  | "characters"
  | "characterNegatives"
  | "useCoords"
  | "characterPositions"
  | "characterCardLinks"
  | "steps"
  | "scale"
  | "sampler"
  | "noiseSchedule"
  | "varietyPlus"
  | "vibes"
  | "references"
> & { seed: number | null };

export type SavedPrompt = { version: 1; name: string; savedAt: string; snapshot: PromptSnapshot };

export async function listSavedPrompts(folder: string): Promise<string[]> {
  return (await listLibrary(folder, "prompts")).map((f) => f.replace(/\.json$/, ""));
}

export async function readSavedPrompt(folder: string, name: string): Promise<SavedPrompt | null> {
  const raw = await readLibrary<SavedPrompt>(folder, "prompts", `${name}.json`);
  if (!(raw && typeof raw === "object" && raw.snapshot && typeof raw.snapshot.prompt === "string")) return null;
  // Saved before several references: one `styleReference`.
  const old = (raw.snapshot as { styleReference?: unknown }).styleReference;
  raw.snapshot.references = parseReferences(raw.snapshot.references ?? (old ? [old] : []));
  return raw;
}

/** Saves under `name` (an existing one of that name is replaced; the caller asks first). */
export async function savePrompt(folder: string, name: string, snapshot: PromptSnapshot): Promise<string> {
  const file = libraryFileName(name);
  const saved: SavedPrompt = { version: 1, name: name.trim(), savedAt: new Date().toISOString(), snapshot };
  await writeLibrary(folder, "prompts", file, saved);
  return file.replace(/\.json$/, "");
}

// ---- Artist library ----

export type ModelFamily = "V5" | "V4.5" | "V4";

export type ArtistEntry = {
  id: string;
  /** An artist tag ("name"), or a whole style block when `block` is set. */
  tag: string;
  block: boolean;
  /** Model families it's good on (empty: all). */
  families: ModelFamily[];
  /** NovelAI weight; 1 is plain. */
  strength: number;
  labels: string[];
};

export type ArtistLibrary = {
  enabled: boolean;
  /** Fixed: every selected entry. Random: K of them per image. Next: one at a time, every N images. */
  mode: "fixed" | "random" | "next";
  k: number;
  every: number;
  /** Only entries with this label ("" for any). */
  label: string;
  selected: string[];
  entries: ArtistEntry[];
};

export const DEFAULT_ARTISTS: ArtistLibrary = { enabled: false, mode: "fixed", k: 2, every: 1, label: "", selected: [], entries: [] };

export function parseArtists(raw: unknown): ArtistLibrary {
  if (typeof raw !== "object" || raw === null) return DEFAULT_ARTISTS;
  const r = raw as Record<string, unknown>;
  const fams: ModelFamily[] = ["V5", "V4.5", "V4"];
  const entries = (Array.isArray(r.entries) ? r.entries : []).flatMap((e): ArtistEntry[] => {
    const o = e as Record<string, unknown> | null;
    if (!o || typeof o.tag !== "string" || !o.tag.trim()) return [];
    return [
      {
        id: typeof o.id === "string" ? o.id : crypto.randomUUID(),
        tag: o.tag.trim(),
        block: o.block === true,
        families: Array.isArray(o.families) ? o.families.filter((f): f is ModelFamily => fams.includes(f as ModelFamily)) : [],
        strength: typeof o.strength === "number" && Number.isFinite(o.strength) ? o.strength : 1,
        labels: Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === "string") : [],
      },
    ];
  });
  const int = (v: unknown, lo: number, hi: number, f: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : f);
  return {
    enabled: r.enabled === true,
    mode: r.mode === "random" || r.mode === "next" ? r.mode : "fixed",
    k: int(r.k, 1, 20, 2),
    every: int(r.every, 1, 1000, 1),
    label: typeof r.label === "string" ? r.label : "",
    selected: Array.isArray(r.selected) ? r.selected.filter((s): s is string => typeof s === "string") : [],
    entries,
  };
}

export async function loadArtists(folder: string): Promise<ArtistLibrary> {
  return parseArtists(await readLibrary(folder, "", "artists.json"));
}

export async function saveArtists(folder: string, lib: ArtistLibrary): Promise<void> {
  await writeLibrary(folder, "", "artists.json", { version: 1, ...lib });
}

/** How an entry goes into a prompt: `artist:name`, `1.2::artist:name::`, or the block as written. */
export function artistText(e: ArtistEntry): string {
  if (e.block) return e.tag;
  const tag = e.tag.startsWith("artist:") ? e.tag : `artist:${e.tag}`;
  return e.strength === 1 ? tag : `${Math.round(e.strength * 100) / 100}::${tag}::`;
}

/** The entries usable with `family` under the library's label filter, in order. */
export function usableArtists(lib: ArtistLibrary, family: ModelFamily): ArtistEntry[] {
  const label = lib.label.trim().toLowerCase();
  return lib.entries.filter(
    (e) =>
      lib.selected.includes(e.id) &&
      (e.families.length === 0 || e.families.includes(family)) &&
      (!label || e.labels.map((l) => l.toLowerCase()).includes(label)),
  );
}

/** The artist text for image `index` (empty when the library is off or nothing fits). */
export function artistsForImage(lib: ArtistLibrary, family: ModelFamily, index: number, rng: Rng, position: number): string {
  if (!lib.enabled) return "";
  const usable = usableArtists(lib, family);
  if (usable.length === 0) return "";
  if (lib.mode === "fixed") return usable.map(artistText).join(", ");
  if (lib.mode === "next") {
    const group = Math.floor(index / Math.max(1, lib.every));
    return artistText(usable[(position + group) % usable.length]);
  }
  const pool = [...usable];
  const out: ArtistEntry[] = [];
  for (let i = 0; i < Math.min(lib.k, pool.length); i++) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out.map(artistText).join(", ");
}

/** Puts the artists where `__artists__` is, or at the end of the prompt. */
export function insertArtists(prompt: string, text: string): string {
  if (/__artists__/i.test(prompt)) return prompt.replace(/__artists__/gi, text);
  if (!text) return prompt;
  const base = prompt.replace(/[\s,]+$/, "");
  return base ? `${base}, ${text}` : text;
}
