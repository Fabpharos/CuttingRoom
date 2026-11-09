// Remix: find the tags a folder of NovelAI images share (a style block, a
// character), swap them for new text, and hand each image's new prompt to
// the Generate tab. Pure helpers; the tab reads the images.

import { splitTags } from "./promptConvert";
import { MAX_CHARACTERS, SIZES, type CharacterPosition, type ImportedSettings } from "./novelai";

export type RemixSource = { path: string; settings: ImportedSettings };

/** A field the shared tags can come from: the prompt, undesired content, or a character slot. */
export type FieldKey = "prompt" | "negative" | `character-${number}`;

export type SharedTag = {
  /** Lowercased, trimmed: how tags are matched. */
  norm: string;
  /** As first written. */
  text: string;
  /** How many of the field's images have it. */
  count: number;
};

export type FieldBlock = {
  key: FieldKey;
  label: string;
  /** Images that have this field at all (a character slot may be missing). */
  images: number;
  shared: SharedTag[];
};

/** One image's prompt for Generate, after the swap. */
export type RemixItem = {
  source: string;
  prompt: string;
  negativePrompt: string;
  characters: string[];
  characterNegatives: string[];
  characterPositions: CharacterPosition[] | null;
  /** The original seed when reused, else null for a random one. */
  seed: number | null;
  /** The original size when it's one of the free sizes, else null for Generate's size. */
  size: { width: number; height: number } | null;
};

const norm = (tag: string) => tag.trim().toLowerCase().replace(/\s+/g, " ");

export function fieldText(s: ImportedSettings, key: FieldKey): string | null {
  if (key === "prompt") return s.prompt;
  if (key === "negative") return s.negativePrompt;
  const i = Number(key.slice("character-".length));
  return i < s.characters.length ? s.characters[i] : null;
}

/**
 * The tags at least `threshold` (0–1) of the images share, per field, in the
 * order the first image that has them writes them.
 */
export function findShared(sources: RemixSource[], threshold: number): FieldBlock[] {
  const slots = Math.min(MAX_CHARACTERS, Math.max(0, ...sources.map((s) => s.settings.characters.length)));
  const keys: FieldKey[] = ["prompt", "negative", ...Array.from({ length: slots }, (_, i) => `character-${i}` as FieldKey)];
  return keys.map((key) => {
    const texts = sources.map((s) => fieldText(s.settings, key)).filter((t): t is string => t !== null);
    const counts = new Map<string, SharedTag & { order: number }>();
    let order = 0;
    for (const text of texts) {
      // Count each tag once per image.
      for (const tag of new Set(splitTags(text).map((t) => t.trim()))) {
        const n = norm(tag);
        const seen = counts.get(n);
        if (seen) seen.count++;
        else counts.set(n, { norm: n, text: tag, count: 1, order: order++ });
      }
    }
    const needed = Math.max(1, Math.ceil(texts.length * threshold));
    const shared = [...counts.values()]
      .filter((t) => t.count >= needed)
      .sort((a, b) => a.order - b.order)
      .map(({ norm, text, count }) => ({ norm, text, count }));
    const label =
      key === "prompt" ? "Prompt" : key === "negative" ? "Undesired content" : `Character ${Number(key.slice(10)) + 1}`;
    return { key, label, images: texts.length, shared };
  });
}

/**
 * Removes the `remove` tags from `text` and puts `replacement` where the
 * first of them was (at the end if the text had none). An empty
 * replacement just removes them.
 */
export function swapTags(text: string, remove: Set<string>, replacement: string): string {
  const tags = splitTags(text);
  const kept: string[] = [];
  let at = -1;
  for (const tag of tags) {
    if (remove.has(norm(tag))) {
      if (at < 0) at = kept.length;
    } else kept.push(tag.trim());
  }
  const insert = replacement.trim().replace(/^[\s,]+|[\s,]+$/g, "");
  if (insert) kept.splice(at < 0 ? kept.length : at, 0, insert);
  return kept.join(", ");
}

export type Swap = { remove: Set<string>; replacement: string };

export function remixItems(
  sources: RemixSource[],
  swaps: Partial<Record<FieldKey, Swap>>,
  reuseSeeds: boolean,
): RemixItem[] {
  const apply = (key: FieldKey, text: string) => {
    const swap = swaps[key];
    return swap && (swap.remove.size > 0 || swap.replacement.trim()) ? swapTags(text, swap.remove, swap.replacement) : text;
  };
  return sources.map(({ path, settings: s }) => {
    const characters = s.characters.slice(0, MAX_CHARACTERS);
    const free = SIZES.some((z) => z.width === s.width && z.height === s.height);
    const seedOk = s.seed !== null && Number.isInteger(s.seed) && s.seed >= 0 && s.seed <= 0xffff_ffff;
    return {
      source: path,
      prompt: apply("prompt", s.prompt),
      negativePrompt: apply("negative", s.negativePrompt),
      characters: characters.map((c, i) => apply(`character-${i}`, c)),
      characterNegatives: characters.map((_, i) => s.characterNegatives[i] ?? ""),
      characterPositions: s.characterPositions?.slice(0, characters.length) ?? null,
      seed: reuseSeeds && seedOk ? s.seed : null,
      size: free ? { width: s.width!, height: s.height! } : null,
    };
  });
}
