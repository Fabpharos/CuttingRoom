// Character cards: NovelAI character prompt presets kept as small PNGs in a
// folder the user picks (Rust reads and writes them; see
// src-tauri/src/character_preset.rs). Each tag of the character's prompt is
// assigned to a body part, so Generate can leave out what won't be seen.

import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { splitTags } from "./promptConvert";
import { autoPart, bareTag } from "./characterTags";

export type Part = "eyes" | "face" | "hair" | "upperBody" | "lowerBody" | "other";

export const PARTS: { key: Part; label: string; hint: string }[] = [
  { key: "eyes", label: "Eyes", hint: "colour, pupils, eye shape" },
  { key: "face", label: "Face", hint: "facial features, makeup, glasses" },
  { key: "hair", label: "Hair", hint: "colour, style, length, hair accessories" },
  { key: "upperBody", label: "Upper body", hint: "tops, sleeves, chest, arms" },
  { key: "lowerBody", label: "Lower body", hint: "skirts, legwear, shoes" },
  { key: "other", label: "Always included", hint: "gender, name, anything else" },
];

export type CardTag = { text: string; part: Part };

export type Gender = "female" | "male" | "other";
export const GENDERS: { key: Gender; label: string }[] = [
  { key: "female", label: "Female" },
  { key: "male", label: "Male" },
  { key: "other", label: "Other" },
];

/** A tag swap the card asks for: `$c1 swap: from$` becomes `to`. */
export type CardSwap = { from: string; to: string };

/** A Precise Reference image that comes with the card (V4.5 for now). */
export type CardReference = {
  path: string;
  type: "character" | "character&style";
  /** 0–1. */
  strength: number;
  /** 0–1. */
  fidelity: number;
};

export type CharacterCard = {
  version: 2;
  name: string;
  /** The character's prompt, tag by tag, in order. */
  tags: CardTag[];
  /** The character's undesired content. */
  negative: string;
  gender: Gender;
  /** The user's own groups ("pokemon", "oc"), for pools and associations. */
  labels: string[];
  swaps: CardSwap[];
  reference: CardReference | null;
};

/** A new, empty card's extra fields. */
export const CARD_V2_DEFAULTS = { gender: "other" as Gender, labels: [] as string[], swaps: [] as CardSwap[], reference: null };

/** Best guess at a card's gender from its tags, for v1 cards and new ones. */
export function guessGender(tags: { text: string }[]): Gender {
  const t = new Set(tags.map((x) => bareTag(x.text)));
  const female = ["1girl", "girl", "female", "woman", "2girls", "multiple girls"].some((g) => t.has(g));
  const male = ["1boy", "boy", "male", "man", "2boys", "multiple boys"].some((g) => t.has(g));
  return female && !male ? "female" : male && !female ? "male" : "other";
}

/** Labels as typed: lowercased, trimmed, unique, no empty ones. */
export function cleanLabels(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean))];
}

export type CardFile = { path: string; card: CharacterCard };

const isPart = (v: unknown): v is Part => PARTS.some((p) => p.key === v);

const isGender = (v: unknown): v is Gender => GENDERS.some((g) => g.key === v);
const unit = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

function parseReference(raw: unknown): CardReference | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || !r.path) return null;
  return {
    path: r.path,
    type: r.type === "character&style" ? "character&style" : "character",
    strength: unit(r.strength, 1),
    fidelity: unit(r.fidelity, 1),
  };
}

/**
 * A card read from disk, or null if it isn't one. Version 1 cards (name,
 * tags, negative) are read as version 2 with their gender guessed from tags.
 */
export function parseCard(raw: unknown): CharacterCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if ((r.version !== 1 && r.version !== 2) || typeof r.name !== "string" || !Array.isArray(r.tags)) return null;
  const tags = r.tags.flatMap((t) => {
    const o = t as Record<string, unknown> | null;
    return o && typeof o.text === "string" && isPart(o.part) ? [{ text: o.text, part: o.part }] : [];
  });
  const swaps = Array.isArray(r.swaps)
    ? r.swaps.flatMap((x) => {
        const o = x as Record<string, unknown> | null;
        return o && typeof o.from === "string" && typeof o.to === "string" && o.from.trim()
          ? [{ from: o.from.trim(), to: o.to.trim() }]
          : [];
      })
    : [];
  return {
    version: 2,
    name: r.name,
    tags,
    negative: typeof r.negative === "string" ? r.negative : "",
    gender: isGender(r.gender) ? r.gender : guessGender(tags),
    labels: Array.isArray(r.labels) ? cleanLabels(r.labels.filter((l): l is string => typeof l === "string")) : [],
    swaps,
    reference: parseReference(r.reference),
  };
}

export async function listCards(folder: string): Promise<CardFile[]> {
  const raw = await invoke<{ path: string; card: unknown }[]>("list_character_cards", { folder });
  return raw
    .flatMap((f) => {
      const card = parseCard(f.card);
      return card ? [{ path: f.path, card }] : [];
    })
    .sort((a, b) => a.card.name.localeCompare(b.card.name, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Saves a card as `<name>.png` in `folder`. A new card passes the `image` it
 * was made from (a thumbnail of it becomes the card); an edited one passes
 * its current file as `existing`. Returns the card's path.
 */
export function saveCard(
  folder: string,
  card: CharacterCard,
  source: { image: string } | { existing: string },
): Promise<string> {
  return invoke("save_character_card", {
    folder,
    name: card.name,
    card,
    image: "image" in source ? source.image : null,
    existing: "existing" in source ? source.existing : null,
  });
}

// The card folder is shared by the Character Cards tab and Generate.
const store = new LazyStore("character-cards.json");

export async function loadCardFolder(): Promise<string | null> {
  const folder = await store.get<string>("folder");
  return typeof folder === "string" ? folder : null;
}

export async function saveCardFolder(folder: string): Promise<void> {
  await store.set("folder", folder);
  await store.save();
}

/**
 * The tags of `text` in order. A tag that was already there keeps its part;
 * a new one is sorted into eyes or hair when it's clearly about them, else
 * goes to "other".
 */
export function tagsFromPrompt(text: string, previous: CardTag[] = []): CardTag[] {
  const known = new Map<string, Part[]>();
  for (const t of previous) {
    const k = bareTag(t.text);
    known.set(k, [...(known.get(k) ?? []), t.part]);
  }
  return splitTags(text).flatMap(ungroup).map((tag) => {
    const k = bareTag(tag);
    const part = known.get(k)?.shift() ?? autoPart(tag) ?? "other";
    return { text: tag, part };
  });
}

/**
 * A weighted group of several tags (`1.2::red eyes, black hair::`,
 * `{red eyes, black hair}`) as one weighted tag each, so each can go to its
 * own part. NovelAI weighs them the same either way.
 */
function ungroup(tag: string): string[] {
  const weight = /^(-?(?:\d+(?:\.\d+)?|\.\d+))::(.*?)(?:::)?$/s.exec(tag);
  if (weight) {
    const inner = splitTags(weight[2]);
    return inner.length > 1 ? inner.map((t) => `${weight[1]}::${t}::`) : [tag];
  }
  const brackets = /^([{[]+)(.*?)([}\]]+)$/s.exec(tag);
  if (brackets && brackets[1].length === brackets[3].length && !/[{}[\]]/.test(brackets[2])) {
    const inner = splitTags(brackets[2]);
    return inner.length > 1 ? inner.map((t) => `${brackets[1]}${t}${brackets[3]}`) : [tag];
  }
  return [tag];
}

export const promptOf =(tags: CardTag[]) => tags.map((t) => t.text).join(", ");

// --- Loading a card into Generate ---

export type ShowOption = "facingAway" | "closedEyes" | "upperBody" | "lowerBody";

export const SHOW_OPTIONS: { key: ShowOption; label: string; tag: string; hides: Part[]; excludes?: ShowOption }[] = [
  { key: "facingAway", label: "Facing away", tag: "facing away", hides: ["eyes", "face"] },
  { key: "closedEyes", label: "Closed eyes", tag: "closed eyes", hides: ["eyes"] },
  { key: "upperBody", label: "Upper body", tag: "upper body", hides: ["lowerBody"], excludes: "lowerBody" },
  { key: "lowerBody", label: "Lower body", tag: "lower body", hides: ["eyes", "face", "hair"], excludes: "upperBody" },
];

/** The parts the chosen options leave out of the picture. */
export function hiddenParts(options: Set<ShowOption>): Set<Part> {
  return new Set(SHOW_OPTIONS.filter((o) => options.has(o.key)).flatMap((o) => o.hides));
}

/** The card's prompt with the hidden parts left out and the options' tags added. */
export function buildCharacterPrompt(card: CharacterCard, hidden: Set<Part>, options: Set<ShowOption>): string {
  const tags = card.tags.filter((t) => t.part === "other" || !hidden.has(t.part)).map((t) => t.text);
  const present = new Set(tags.map(bareTag));
  for (const o of SHOW_OPTIONS) {
    if (options.has(o.key) && !present.has(o.tag)) tags.push(o.tag);
  }
  return tags.join(", ");
}

// --- A card in Generate that adapts to each image's view tags

/**
 * The card a Generate character was filled from, kept so each image can drop
 * what it won't show, and so `$c1$`, swaps and the reference image work.
 */
export type CardLink = {
  name: string;
  tags: CardTag[];
  gender?: Gender;
  labels?: string[];
  swaps?: CardSwap[];
  reference?: CardReference | null;
  /** The card's undesired content. */
  negative?: string;
  /** The card's file, when known. */
  path?: string;
};

/** The link a character keeps to `card`. */
export function linkFor(card: CharacterCard, path?: string): CardLink {
  return {
    name: card.name,
    tags: card.tags,
    gender: card.gender,
    labels: card.labels,
    swaps: card.swaps,
    reference: card.reference,
    negative: card.negative,
    path,
  };
}

/**
 * View tags that put parts of a carded character out of sight: the four
 * options of the Load dialog, a few common equivalents, and POV (taken to mean
 * the character is the one looking, so their own face and hair aren't seen).
 */
export const VIEW_TAGS: Record<string, Part[]> = {
  ...Object.fromEntries(SHOW_OPTIONS.map((o) => [o.tag, o.hides])),
  "from behind": ["eyes", "face"],
  "eyes closed": ["eyes"],
  portrait: ["lowerBody"],
  "head out of frame": ["eyes", "face", "hair"],
  pov: ["eyes", "face", "hair"],
};

/** The view tags in `text` (weighted ones too, but not negatively weighted ones). */
export function viewTagsIn(text: string): string[] {
  const found: string[] = [];
  for (const tag of splitTags(text).flatMap(ungroup)) {
    if (/^\s*-/.test(tag)) continue; // "-1::pov::" asks for less of it
    const t = bareTag(tag);
    if (t in VIEW_TAGS && !found.includes(t)) found.push(t);
  }
  return found;
}

/**
 * A carded character's prompt for one image: the card's tags for every part
 * the image's view tags hide (found in `scene`, the image's main prompt, and in
 * the character's own prompt) are left out. Each image starts from the full
 * prompt, so the tags come back as soon as an image doesn't hide them.
 */
export function adaptCardCharacter(
  text: string,
  link: CardLink,
  scene: string,
): { text: string; views: string[]; hidden: Part[] } {
  const views = [...new Set([...viewTagsIn(scene), ...viewTagsIn(text)])];
  const hidden = new Set(views.flatMap((v) => VIEW_TAGS[v]));
  if (hidden.size === 0) return { text, views, hidden: [] };
  // How many of each card tag belong to a hidden part.
  const drop = new Map<string, number>();
  for (const t of link.tags) {
    if (t.part !== "other" && hidden.has(t.part)) drop.set(bareTag(t.text), (drop.get(bareTag(t.text)) ?? 0) + 1);
  }
  const kept = splitTags(text).flatMap(ungroup).filter((tag) => {
    const k = bareTag(tag);
    const n = drop.get(k) ?? 0;
    if (n === 0) return true;
    drop.set(k, n - 1);
    return false;
  });
  return { text: kept.join(", "), views, hidden: PARTS.map((p) => p.key).filter((p) => hidden.has(p)) };
}

/** A link read back from saved settings, or null if it isn't one. */
export function parseCardLink(raw: unknown): CardLink | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !Array.isArray(r.tags)) return null;
  const tags = r.tags.flatMap((t) => {
    const o = t as Record<string, unknown> | null;
    return o && typeof o.text === "string" && isPart(o.part) ? [{ text: o.text, part: o.part }] : [];
  });
  // The rest is what the card said when it was loaded; parseCard checks it the same way.
  const full = parseCard({ ...r, version: 2 });
  return {
    name: r.name,
    tags,
    gender: full?.gender,
    labels: full?.labels ?? [],
    swaps: full?.swaps ?? [],
    reference: full?.reference ?? null,
    negative: typeof r.negative === "string" ? r.negative : undefined,
    path: typeof r.path === "string" ? r.path : undefined,
  };
}
