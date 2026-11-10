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

export type CharacterCard = {
  version: 1;
  name: string;
  /** The character's prompt, tag by tag, in order. */
  tags: CardTag[];
  /** The character's undesired content. */
  negative: string;
};

export type CardFile = { path: string; card: CharacterCard };

const isPart = (v: unknown): v is Part => PARTS.some((p) => p.key === v);

/** A card read from disk, or null if it isn't one this version understands. */
function parseCard(raw: unknown): CharacterCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.name !== "string" || !Array.isArray(r.tags)) return null;
  const tags = r.tags.flatMap((t) => {
    const o = t as Record<string, unknown> | null;
    return o && typeof o.text === "string" && isPart(o.part) ? [{ text: o.text, part: o.part }] : [];
  });
  return { version: 1, name: r.name, tags, negative: typeof r.negative === "string" ? r.negative : "" };
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
