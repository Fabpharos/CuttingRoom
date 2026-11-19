// The prompt engine: turns the Generate form into each image's prompts.
//
// Everything is decided before a batch starts, image by image, from a seeded
// random function, so the batch can be previewed and comes out the same way
// when it runs. Passes, in order, for each image:
//
//   1. tokens        prompt files / wildcards, nested, `__name!__` picks apart
//   2. slots         `$c1$`, `$c1 has tag: …$`, `$any lacks …$`, `$c1 swap: …$`
//   3. gender swap   whole tags, from the swap table
//   4. associations  "when this tag, add these tags / put in this character"
//   5. view tags     a carded character drops what the image hides
//   6. weights       `0.6~1.4::tag::` becomes `1.1::tag::`
//   7. scramble      shuffles tags, keeping the first few, sentences and text:
//   8. clean-up      empty segments, `!` markers, text: moved to the end
//
// Tag passes (3, 4, 7) only touch segments that look like tags (at most four
// words, no full stop), so V5's natural-language sentences pass through.
// No Tauri calls here, so it can be unit-tested.

import { adaptCardCharacter, type CardLink } from "./characterCards";
import { CENTER, type CharacterPosition } from "./novelai";
import { weightedIndex, type PromptFileMode } from "./promptFile";
import { TOKEN } from "./promptTokens";
import type { Association, CardChoice } from "./library";

// ---- Randomness ----

export type Rng = () => number;

/** A small, fast seeded generator (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A different stream per image of a batch. */
export function imageRng(batchSeed: number, index: number): Rng {
  return seededRng((batchSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

// ---- Segments ----

/**
 * Splits a prompt at its top-level commas. Weight groups (`1.2::a, b::`,
 * `0.6~1.4::a, b::`), brackets and `$…$` slot syntax stay whole. Segments are
 * returned as typed (not trimmed).
 */
export function splitSegments(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inWeight = false;
  let inDollar = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "$") {
      inDollar = !inDollar;
      cur += ch;
      continue;
    }
    if (!inDollar) {
      if (ch === ":" && text[i + 1] === ":") {
        if (inWeight) inWeight = false;
        else if (/(^|[^\w.])-?(\d+(\.\d+)?|\.\d+)(\s*~\s*-?(\d+(\.\d+)?|\.\d+))?\s*$/.test(cur)) inWeight = true;
        cur += "::";
        i++;
        continue;
      }
      if ("{[(".includes(ch)) depth++;
      else if ("}])".includes(ch) && depth > 0) depth--;
      else if (ch === "," && depth === 0 && !inWeight) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const join = (segs: string[]) =>
  segs
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join(", ");

/** A tag compared loosely: no case, underscores, weights, brackets or `!`. */
export function normalizeTag(tag: string): string {
  let t = tag.trim();
  const w = /^-?(\d+(\.\d+)?|\.\d+)(\s*~\s*-?(\d+(\.\d+)?|\.\d+))?::([\s\S]*?)(::)?$/.exec(t);
  if (w) t = w[6];
  t = t.replace(/^[{[(]+/, "").replace(/[}\])]+$/, "");
  if (/^![A-Za-z0-9]/.test(t)) t = t.slice(1);
  return t.replace(/\\([()])/g, "$1").replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The tags in one segment, normalized; a weighted group gives each tag inside. */
function segmentTags(seg: string): string[] {
  const w = /^\s*-?(\d+(\.\d+)?|\.\d+)(\s*~\s*-?(\d+(\.\d+)?|\.\d+))?::([\s\S]*?)(::)?\s*$/.exec(seg);
  const inner = w ? splitSegments(w[6]) : [seg];
  return inner.map(normalizeTag).filter(Boolean);
}

/** Every tag in a prompt, normalized; weighted groups count each tag inside. */
export function tagsOf(text: string): string[] {
  return splitSegments(text).flatMap(segmentTags);
}

/** Whether a segment is a tag rather than a sentence: up to 4 words, no full stop. */
export function isTagLike(seg: string): boolean {
  const t = normalizeTag(seg);
  if (!t) return false;
  if (/^text:/i.test(seg.trim())) return false;
  if (/[.?]\s*$/.test(t) || /\.\s/.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

/** `!tag`: protected from associations and gender swap. A lone `!` or `!?` is a real tag. */
export function isProtected(seg: string): boolean {
  const t = seg.trim().replace(/^-?(\d+(\.\d+)?|\.\d+)::/, "");
  return /^![A-Za-z0-9]/.test(t);
}

const isText = (seg: string) => /^\s*text:/i.test(seg);

// ---- Files ----

export type EngineFile = {
  name: string;
  lines: string[];
  parts: Record<string, string>[];
  weights: number[];
  mode: PromptFileMode;
  position: number;
};

/** How deep nested tokens are expanded. */
export const MAX_NESTING = 16;

/** The tokens a file's lines use, by file name. */
function referencedNames(file: EngineFile): Set<string> {
  const names = new Set<string>();
  const scan = (t: string) => {
    for (const m of t.matchAll(TOKEN)) names.add(m[1].toLowerCase());
  };
  file.lines.forEach(scan);
  file.parts.forEach((p) => Object.values(p).forEach(scan));
  return names;
}

/**
 * Files that refer back to themselves, directly or through others. Their
 * tokens are left as typed where the loop closes.
 */
export function findLoops(files: EngineFile[]): Map<string, string[]> {
  const byName = new Map(files.map((f) => [f.name, f]));
  const refs = new Map(files.map((f) => [f.name, [...referencedNames(f)].filter((n) => byName.has(n))]));
  const loops = new Map<string, string[]>();
  for (const start of byName.keys()) {
    const stack: { name: string; path: string[] }[] = [{ name: start, path: [start] }];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const { name, path } = stack.pop()!;
      for (const next of refs.get(name) ?? []) {
        if (next === start) {
          loops.set(start, [...path, start]);
          stack.length = 0;
          break;
        }
        if (!seen.has(next)) {
          seen.add(next);
          stack.push({ name: next, path: [...path, next] });
        }
      }
    }
  }
  return loops;
}

// ---- Slots ----

/** What the engine knows about one character slot. */
export type Slot = {
  text: string;
  negative: string;
  position: CharacterPosition;
  link: CardLink | null;
  /** False when a paired file left this character out of the image. */
  present: boolean;
};

// ---- Settings ----

export type ScrambleSettings = {
  main: boolean;
  mainNegative: boolean;
  characters: boolean;
  characterNegatives: boolean;
  /** Segments at the start that stay put (1 keeps `1girl` / `2girls` first). */
  keepFirst: number;
};

export type GenderSwapMode = "off" | "all" | "girlsToBoys" | "boysToGirls" | "slot";

export type GenderSwapSettings = {
  mode: GenderSwapMode;
  /** 1-based, for mode "slot". */
  slot: number;
  /** Also swap she/he, her/his in sentences (off by default: "her" is ambiguous). */
  pronouns: boolean;
  /** [female, male] pairs. */
  pairs: [string, string][];
};

export type EngineSettings = {
  scramble: ScrambleSettings;
  genderSwap: GenderSwapSettings;
  /** Random weights round to this (0.05 or 0.1). */
  weightStep: number;
  associations: Association[];
};

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  scramble: { main: false, mainNegative: false, characters: false, characterNegatives: false, keepFirst: 1 },
  genderSwap: { mode: "off", slot: 1, pronouns: false, pairs: [] },
  weightStep: 0.05,
  associations: [],
};

// ---- One image ----

export type ImageInput = {
  prompt: string;
  negative: string;
  slots: Slot[];
};

export type ImageContext = {
  index: number;
  rng: Rng;
  files: Map<string, EngineFile>;
  /** Character slots the model takes (22 on V5, 6 on V4/V4.5). */
  maxSlots: number;
  settings: EngineSettings;
  /** Picks a card for an "add a character" association (null: none fits). */
  pickCard?: (choice: CardChoice) => CardLink | null;
};

export type ImageOutput = {
  prompt: string;
  negative: string;
  slots: Slot[];
  /** What each pass changed, for the batch preview. */
  log: string[];
  /** Problems worth showing (a slot the model doesn't have, a loop). */
  warnings: string[];
  /** Every prompt file used, nested ones included. */
  usedFiles: Set<string>;
};

/** Runs every pass for one image. */
export function buildImage(input: ImageInput, ctx: ImageContext): ImageOutput {
  const log: string[] = [];
  const warnings = new Set<string>();
  const usedFiles = new Set<string>();
  const picks = new Map<string, number>();

  // 1. Tokens.
  const pick = (f: EngineFile) => {
    let i = picks.get(f.name);
    if (i === undefined) {
      i = f.mode === "sequential" ? (f.position + ctx.index) % f.lines.length : weightedIndex(f.lines.length, ctx.rng, f.weights);
      picks.set(f.name, i);
    }
    return i;
  };
  const expand = (text: string, stack: string[], absent: { hit: boolean }): string =>
    text.replace(TOKEN, (whole: string, rawName: string, part: string | undefined, bang: string | undefined) => {
      const name = rawName.toLowerCase();
      const f = ctx.files.get(name);
      if (!f || f.lines.length === 0) return whole;
      if (stack.includes(name)) {
        warnings.add(`${whole} refers back to itself (${[...stack, name].join(" → ")}), so it's left as typed.`);
        return whole;
      }
      if (stack.length >= MAX_NESTING) return whole;
      usedFiles.add(name);
      const i = bang ? weightedIndex(f.lines.length, ctx.rng, f.weights) : pick(f);
      const value = part ? f.parts[i]?.[part.toLowerCase()] : f.lines[i];
      if (value === undefined) {
        absent.hit = true;
        return "";
      }
      return expand(value, [...stack, name], absent);
    });
  const fill = (text: string) => expand(text, [], { hit: false });

  let prompt = fill(input.prompt);
  let negative = fill(input.negative);
  let slots: Slot[] = input.slots.map((s) => {
    if (!s.present) return { ...s };
    const absent = { hit: false };
    const text = expand(s.text, [], absent);
    // A character using a paired file's part sits out an entry without it.
    if (absent.hit) {
      log.push(`A character was left out: its entry has no line for its part.`);
      return { ...s, text: "", negative: "", present: false };
    }
    return { ...s, text, negative: fill(s.negative) };
  });

  // 2. Slot references and conditionals.
  const slotFn = (text: string) => resolveSlots(text, slots, ctx.maxSlots, warnings);
  prompt = slotFn(prompt);
  negative = slotFn(negative);
  slots = slots.map((s) => (s.present ? { ...s, text: slotFn(s.text), negative: slotFn(s.negative) } : s));

  // 3. Gender swap.
  const gs = ctx.settings.genderSwap;
  if (gs.mode !== "off" && gs.pairs.length > 0) {
    const swap = (t: string) => swapGender(t, gs);
    if (gs.mode === "slot") {
      const i = gs.slot - 1;
      if (slots[i]?.present) {
        const before = slots[i].text;
        slots = slots.map((s, j) => (j === i ? { ...s, text: swap(s.text), negative: swap(s.negative) } : s));
        if (slots[i].text !== before) log.push(`Gender swap: character ${gs.slot}.`);
      }
    } else {
      const before = prompt + slots.map((s) => s.text).join("|");
      prompt = swap(prompt);
      negative = swap(negative);
      slots = slots.map((s) => (s.present ? { ...s, text: swap(s.text), negative: swap(s.negative) } : s));
      if (prompt + slots.map((s) => s.text).join("|") !== before) log.push("Gender swap applied.");
    }
  }

  // 4. Associations (each rule once, looking at the text before any rule ran).
  ({ prompt, negative, slots } = applyAssociations({ prompt, negative, slots }, ctx, log));

  // 5. Character cards follow the image's view tags.
  slots = slots.map((s) => {
    if (!s.present || !s.link) return s;
    const a = adaptCardCharacter(s.text, s.link, prompt);
    if (a.hidden.length > 0) log.push(`${s.link.name}: leaves out ${a.hidden.join(", ")} (${a.views.join(", ")}).`);
    return { ...s, text: a.text };
  });

  // 6. Random weights.
  const step = ctx.settings.weightStep > 0 ? ctx.settings.weightStep : 0.05;
  const rw = (t: string) => randomWeights(t, ctx.rng, step);
  prompt = rw(prompt);
  negative = rw(negative);
  slots = slots.map((s) => (s.present ? { ...s, text: rw(s.text), negative: rw(s.negative) } : s));

  // 7. Scramble.
  const sc = ctx.settings.scramble;
  const shuffle = (t: string) => scramble(t, sc.keepFirst, ctx.rng);
  if (sc.main) prompt = shuffle(prompt);
  if (sc.mainNegative) negative = shuffle(negative);
  if (sc.characters || sc.characterNegatives) {
    slots = slots.map((s) =>
      s.present
        ? { ...s, text: sc.characters ? shuffle(s.text) : s.text, negative: sc.characterNegatives ? shuffle(s.negative) : s.negative }
        : s,
    );
  }
  if (sc.main || sc.mainNegative || sc.characters || sc.characterNegatives) log.push("Scrambled.");

  // 8. Clean-up.
  prompt = cleanUp(prompt);
  negative = cleanUp(negative);
  slots = slots.map((s) => ({ ...s, text: cleanUp(s.text), negative: cleanUp(s.negative) }));

  return { prompt, negative, slots, log, warnings: [...warnings], usedFiles };
}

// ---- Pass 2: slots ----

const SLOT = /\$([^$\n]+)\$/g;

/** The slot number a `$…$` refers to, or null for any/all. */
function slotIndex(ref: string): number | null {
  const m = /^c(\d{1,2})$/i.exec(ref);
  return m ? Number(m[1]) : null;
}

export function resolveSlots(text: string, slots: Slot[], maxSlots: number, warnings: Set<string>): string {
  if (!text.includes("$")) return text;
  return text.replace(SLOT, (whole: string, body: string) => {
    const b = body.trim();
    const plain = /^c(\d{1,2})$/i.exec(b);
    const cond = /^(c\d{1,2}|any|all)\s+(has|lacks)\s+([^:]+?)\s*:\s*([\s\S]*)$/i.exec(b);
    const swap = /^(c\d{1,2})\s+swap\s*:\s*([\s\S]+)$/i.exec(b);
    const ref = plain ? `c${plain[1]}` : cond ? cond[1] : swap ? swap[1] : null;
    if (!ref) return whole;
    const n = slotIndex(ref);
    if (n !== null && (n < 1 || n > maxSlots)) {
      warnings.add(`${whole}: this model has character slots 1–${maxSlots}, so it's left as typed.`);
      return whole;
    }
    const slot = n !== null ? slots[n - 1] : undefined;
    if (plain) return slot?.present ? (slot.link?.name ?? "") : "";
    if (swap) {
      const tag = swap[2].trim();
      const rule = slot?.present ? slot.link?.swaps?.find((s) => normalizeTag(s.from) === normalizeTag(tag)) : undefined;
      return rule ? rule.to : tag;
    }
    const [, , verb, tagText, insert] = cond!;
    const target = normalizeTag(tagText);
    const has = (s: Slot | undefined) => !!s?.present && tagsOf(s.text).includes(target);
    const present = slots.filter((s) => s.present);
    const result =
      ref.toLowerCase() === "any"
        ? present.some(has)
        : ref.toLowerCase() === "all"
          ? present.length > 0 && present.every(has)
          : has(slot);
    const wanted = verb.toLowerCase() === "has" ? result : !result;
    return wanted ? insert.trim() : "";
  });
}

// ---- Pass 3: gender swap ----

const PRONOUNS: [string, string][] = [
  ["she", "he"],
  ["herself", "himself"],
  ["her", "his"],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word replacer for `pairs` in the directions `mode` asks for. */
function swapper(pairs: [string, string][], mode: GenderSwapMode): ((t: string) => string) | null {
  const map = new Map<string, string>();
  for (const [f, m] of pairs) {
    if (mode !== "boysToGirls") map.set(f.toLowerCase(), m);
    if (mode !== "girlsToBoys") map.set(m.toLowerCase(), f);
  }
  if (map.size === 0) return null;
  // A space in a key also matches an underscore ("multiple_girls").
  const keys = [...map.keys()].sort((a, b) => b.length - a.length).map((k) => escapeRe(k).replace(/ /g, "[ _]"));
  const re = new RegExp(`(?<![\\w])(${keys.join("|")})(?![\\w])`, "gi");
  return (t) =>
    t.replace(re, (w: string) => {
      let out = map.get(w.toLowerCase().replace(/_/g, " ")) ?? w;
      if (w.includes("_")) out = out.replace(/ /g, "_");
      return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? out[0].toUpperCase() + out.slice(1) : out;
    });
}

export function swapGender(text: string, s: GenderSwapSettings): string {
  const tags = swapper(
    s.pairs.map(([f, m]) => [f.replace(/_/g, " "), m.replace(/_/g, " ")]),
    s.mode === "slot" ? "all" : s.mode,
  );
  const words = s.pronouns ? swapper(PRONOUNS, s.mode === "slot" ? "all" : s.mode) : null;
  if (!tags) return text;
  const segs = splitSegments(text);
  const changed = segs.map((seg) => {
    if (isProtected(seg)) return seg;
    if (isTagLike(seg)) return tags(seg);
    return words ? words(seg) : seg;
  });
  return changed.join(",");
}

// ---- Pass 4: associations ----

type Fields = { prompt: string; negative: string; slots: Slot[] };

function addTags(text: string, tags: string, weight: number): string {
  const t = tags.trim();
  if (!t) return text;
  const piece = weight === 1 ? t : `${Math.round(weight * 100) / 100}::${t}::`;
  const base = text.replace(/[\s,]+$/, "");
  return base ? `${base}, ${piece}` : piece;
}

function removeTag(text: string, tag: string): string {
  const target = normalizeTag(tag);
  let removed = false;
  return splitSegments(text)
    .filter((seg) => {
      if (removed || isProtected(seg) || normalizeTag(seg) !== target) return true;
      removed = true;
      return false;
    })
    .join(",");
}

/** Whether `tag` is in `text` as an unprotected tag (a protected one never sets a rule off). */
export function hasTag(text: string, tag: string): boolean {
  const target = normalizeTag(tag);
  return splitSegments(text).some((seg) => !isProtected(seg) && segmentTags(seg).includes(target));
}

export function applyAssociations(f: Fields, ctx: ImageContext, log: string[]): Fields {
  const rules = ctx.settings.associations.filter((r) => r.enabled && r.when.trim());
  if (rules.length === 0) return f;
  // Triggers are looked for in the text as it was before any rule ran, so
  // one rule's additions never set off another.
  const orig = { prompt: f.prompt, slots: f.slots.map((s) => s.text) };
  let { prompt, negative } = f;
  let slots = f.slots.map((s) => ({ ...s }));
  for (const r of rules) {
    const unless = r.unless.split(",").map((t) => t.trim()).filter(Boolean);
    const blocked = (text: string) => unless.some((u) => hasTag(text, u));
    const where: ("main" | number)[] = [];
    if (r.scope !== "characters" && !r.label && hasTag(orig.prompt, r.when) && !blocked(orig.prompt)) where.push("main");
    if (r.scope !== "main") {
      orig.slots.forEach((t, i) => {
        const s = slots[i];
        if (!s?.present) return;
        if (r.label && !s.link?.labels?.includes(r.label.toLowerCase())) return;
        if (hasTag(t, r.when) && !blocked(t)) where.push(i);
      });
    }
    if (where.length === 0) continue;
    const a = r.action;
    if (a.kind === "tags") {
      for (const w of where) {
        if (w === "main") {
          if (a.removeTrigger) prompt = removeTag(prompt, r.when);
          if (a.target === "positive") prompt = addTags(prompt, a.tags, a.weight);
          else negative = addTags(negative, a.tags, a.weight);
        } else {
          const s = slots[w];
          let text = a.removeTrigger ? removeTag(s.text, r.when) : s.text;
          let neg = s.negative;
          if (a.target === "positive") text = addTags(text, a.tags, a.weight);
          else neg = addTags(neg, a.tags, a.weight);
          slots[w] = { ...s, text, negative: neg };
        }
      }
      log.push(`“${r.when}” → added ${a.target === "negative" ? "undesired " : ""}${a.tags.trim()}${where.length > 1 ? ` (${where.length}×)` : ""}.`);
    } else {
      if (a.skipIfGender && slots.some((s) => s.present && s.link?.gender === a.skipIfGender)) continue;
      const card = ctx.pickCard?.(a.card) ?? null;
      if (!card) {
        log.push(`“${r.when}” → no card to add.`);
        continue;
      }
      const filled: Slot = {
        text: card.tags.map((t) => t.text).join(", "),
        negative: card.negative ?? "",
        position: a.position ?? CENTER,
        link: card,
        present: true,
      };
      let at: number;
      if (a.slot === "firstEmpty") {
        at = slots.findIndex((s) => !s.present || s.text.trim() === "");
        if (at < 0) at = slots.length;
      } else at = a.slot - 1;
      if (at >= ctx.maxSlots) {
        log.push(`“${r.when}” → no free character slot for ${card.name}.`);
        continue;
      }
      while (slots.length < at) slots.push({ text: "", negative: "", position: CENTER, link: null, present: false });
      if (at < slots.length) slots[at] = { ...filled, position: a.position ?? slots[at].position };
      else slots.push(filled);
      log.push(`“${r.when}” → ${card.name} in character ${at + 1}.`);
    }
  }
  return { prompt, negative, slots };
}

// ---- Pass 6: random weights ----

const RANDOM_WEIGHT = /(-?(?:\d+(?:\.\d+)?|\.\d+))\s*~\s*(-?(?:\d+(?:\.\d+)?|\.\d+))::/g;

export function randomWeights(text: string, rng: Rng, step: number): string {
  return text.replace(RANDOM_WEIGHT, (_w, a: string, b: string) => {
    const lo = Math.min(Number(a), Number(b));
    const hi = Math.max(Number(a), Number(b));
    const v = Math.round((lo + rng() * (hi - lo)) / step) * step;
    return `${Number(Math.min(hi, Math.max(lo, v)).toFixed(2))}::`;
  });
}

// ---- Pass 7: scramble ----

export function scramble(text: string, keepFirst: number, rng: Rng): string {
  const segs = splitSegments(text).filter((s) => s.trim() !== "");
  const movable = segs.map((s, i) => i >= keepFirst && !isText(s) && isTagLike(s));
  const values = segs.filter((_, i) => movable[i]);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  let k = 0;
  return join(segs.map((s, i) => (movable[i] ? values[k++] : s)));
}

// ---- Pass 8: clean-up ----

/**
 * Drops empty segments, takes the `!` off protected tags and moves `text:`
 * segments to the end. A prompt with none of those is left exactly as typed.
 */
export function cleanUp(text: string): string {
  const segs = splitSegments(text);
  const needs = segs.some((s, i) => s.trim() === "" && (segs.length > 1 || i > 0)) || segs.some(isProtected) || (() => {
    const t = segs.findIndex(isText);
    return t >= 0 && segs.slice(t + 1).some((s) => s.trim() !== "" && !isText(s));
  })();
  if (!needs) return text.trim();
  const unprotect = (s: string) => s.replace(/^(\s*(?:-?(?:\d+(?:\.\d+)?|\.\d+)::)?\s*)!(?=[A-Za-z0-9])/, "$1");
  const kept = segs.filter((s) => s.trim() !== "").map(unprotect);
  return join([...kept.filter((s) => !isText(s)), ...kept.filter(isText)]);
}

// ---- Help ----

/** Everything the engine reads specially, for the syntax help test. */
export const ENGINE_SYNTAX = [
  "__name__",
  "__folder/name__",
  "__name:part__",
  "__name!__",
  "%3 line",
  "0.6~1.4::tag::",
  "$c1$",
  "$c1 has tag: tags$",
  "$c1 lacks tag: tags$",
  "$any has tag: tags$",
  "$c1 swap: tag$",
  "!tag",
  "text: …",
] as const;
