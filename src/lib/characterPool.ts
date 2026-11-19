// Characters that change through a batch: a slot set to Next, Random or
// Shuffle takes a card from a pool (cards filtered by label) every N images.
// Decided per image index when the batch is built, so the preview shows the
// order; the pool's place is saved, like a sequential prompt file's, so the
// next batch carries on.

import { linkFor, type CardFile, type CardLink, type Gender } from "./characterCards";
import { seededRng, type Rng } from "./promptEngine";

export type AdvanceMode = "fixed" | "next" | "random" | "shuffle";

export type PoolFilter = {
  /** Labels a card needs (comma-separated). */
  include: string;
  /** Labels that rule a card out. */
  exclude: string;
  /** Needs all the include labels, or any of them. */
  matchAll: boolean;
  /** Only cards of this gender (null: any). */
  gender: Gender | null;
};

export type SlotAdvance = {
  mode: AdvanceMode;
  pool: PoolFilter;
  /** A new card every this many images. */
  every: number;
};

export const DEFAULT_ADVANCE: SlotAdvance = {
  mode: "fixed",
  pool: { include: "", exclude: "", matchAll: false, gender: null },
  every: 1,
};

const labelsOf = (text: string) =>
  text
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

/** The cards a pool takes from, in name order. */
export function poolCards(cards: CardFile[], f: PoolFilter): CardFile[] {
  const inc = labelsOf(f.include);
  const exc = labelsOf(f.exclude);
  return cards
    .filter((c) => {
      const l = c.card.labels;
      if (exc.some((x) => l.includes(x))) return false;
      if (f.gender && c.card.gender !== f.gender) return false;
      if (inc.length === 0) return true;
      return f.matchAll ? inc.every((x) => l.includes(x)) : inc.some((x) => l.includes(x));
    })
    .sort((a, b) => a.card.name.localeCompare(b.card.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** A key for saving a pool's place: the same filter carries on between batches. */
export function poolKey(f: PoolFilter, mode: AdvanceMode): string {
  return `pool:${mode}:${labelsOf(f.include).sort().join("+")}|${labelsOf(f.exclude).sort().join("+")}|${f.matchAll ? "all" : "any"}|${f.gender ?? ""}`;
}

/** A pool's saved place: how far along it is, and the shuffle it's working through. */
export type PoolState = { position: number; seed: number };

function permutation(n: number, seed: number): number[] {
  const rng = seededRng(seed);
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/**
 * The card a slot uses for image `index`: a new one every `every` images.
 * Random picks are drawn from `rng` once per group of images, so a group
 * shares its card.
 */
export function cardForImage(
  advance: SlotAdvance,
  pool: CardFile[],
  state: PoolState,
  index: number,
  groupRng: (group: number) => Rng,
): CardFile | null {
  if (advance.mode === "fixed" || pool.length === 0) return null;
  const group = Math.floor(index / Math.max(1, advance.every));
  const n = pool.length;
  if (advance.mode === "next") return pool[(state.position + group) % n];
  if (advance.mode === "random") return pool[Math.floor(groupRng(group)() * n)];
  // Shuffle: no repeats until every card has come up; then a new order.
  const step = state.position + group;
  const round = Math.floor(step / n);
  return pool[permutation(n, (state.seed + round * 0x9e3779b1) >>> 0)[step % n]];
}

/** How far a pool moved after `made` images. */
export function advancedState(advance: SlotAdvance, state: PoolState, made: number): PoolState {
  if (advance.mode === "fixed" || advance.mode === "random" || made <= 0) return state;
  const groups = Math.ceil(made / Math.max(1, advance.every));
  return { ...state, position: state.position + groups };
}

export function linkOf(file: CardFile): CardLink {
  return linkFor(file.card, file.path);
}

/** A slot's advance settings read back from saved settings. */
export function parseAdvance(raw: unknown): SlotAdvance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "next" || r.mode === "random" || r.mode === "shuffle" ? r.mode : "fixed";
  if (mode === "fixed") return null;
  const p = (r.pool ?? {}) as Record<string, unknown>;
  const g = p.gender;
  return {
    mode,
    pool: {
      include: typeof p.include === "string" ? p.include : "",
      exclude: typeof p.exclude === "string" ? p.exclude : "",
      matchAll: p.matchAll === true,
      gender: g === "female" || g === "male" || g === "other" ? g : null,
    },
    every: typeof r.every === "number" && Number.isInteger(r.every) && r.every >= 1 && r.every <= 1000 ? r.every : 1,
  };
}
