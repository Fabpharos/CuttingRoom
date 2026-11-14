// Danbooru tag suggestions for prompt boxes: the tag index, search, and
// editing the prompt text. Ported from the NovelAI Krita plugin (nai_krita
// tags.py), which built the tag list.
//
// The list (src/data/tags.tsv.gz, bundled with the app, so no network) has
// one line per tag: name, category, post count, aliases ("|"-separated),
// already in NovelAI form (spaces, not underscores), most used first.
//
// Search matches the start of a tag ("long h" → long hair), the start of an
// alias ("twin tails" → twintails), and the start of any later word in a tag
// ("hair" → long hair, after the direct matches). Results are ranked exact
// match first, then by post count, a later-word match counting a tenth.

import tagsUrl from "../data/tags.tsv.gz?url";

export const MIN_QUERY = 2;
export const MAX_RESULTS = 12;
const WORD_WEIGHT = 0.1;

// match kinds, best first
const EXACT = 0;
const PREFIX = 1;
const ALIAS = 2;
const WORD = 3;

const SEPARATORS = [",", "\n", "|"];
const OPENERS = "{[(";
const CLOSERS = "}])";
const WEIGHT_PREFIX = /^-?\d*\.?\d+::/;

export type TagMatch = {
  name: string;
  category: string;
  count: number;
  /** The alias that matched, if any. */
  alias: string;
};

export const normalize = (text: string) => text.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n ? String(n) : "";
}

export class TagIndex {
  private names: string[] = [];
  private categories: string[] = [];
  private counts: number[] = [];
  private keys: string[] = [];
  /** Lined up with `keys`: [tag index, kind, alias]. */
  private entries: [number, number, string][] = [];

  /** rows: [name, category, count, aliases], most used first. */
  constructor(rows: [string, string, number, string[]][]) {
    const keyed: [string, number, number, string][] = [];
    rows.forEach(([name, category, count, aliases], i) => {
      this.names.push(name);
      this.categories.push(category);
      this.counts.push(count);
      const low = name.toLowerCase();
      keyed.push([low, i, PREFIX, ""]);
      for (const a of aliases) keyed.push([a.toLowerCase(), i, ALIAS, a]);
      for (const m of low.matchAll(/[ (]+/g)) {
        const rest = low.slice(m.index! + m[0].length);
        if (rest.length >= MIN_QUERY) keyed.push([rest, i, WORD, ""]);
      }
    });
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    this.keys = keyed.map((k) => k[0]);
    this.entries = keyed.map((k) => [k[1], k[2], k[3]]);
  }

  get size() {
    return this.names.length;
  }

  static parse(text: string): TagIndex {
    const rows: [string, string, number, string[]][] = [];
    for (const line of text.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const parts = line.replace(/\r$/, "").split("\t");
      if (parts.length < 3) continue;
      rows.push([parts[0], parts[1], Number(parts[2]) || 0, parts[3] ? parts[3].split("|") : []]);
    }
    return new TagIndex(rows);
  }

  private lowerBound(q: string): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < q) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  search(query: string, exclude: Set<string> = new Set(), minimum = MIN_QUERY, limit = MAX_RESULTS): TagMatch[] {
    const q = normalize(query);
    if (q.length < Math.max(1, minimum)) return [];
    const best = new Map<number, [number, string]>();
    for (let k = this.lowerBound(q); k < this.keys.length && this.keys[k].startsWith(q); k++) {
      const [i, kind0, alias] = this.entries[k];
      const kind = kind0 === PREFIX && this.keys[k] === q ? EXACT : kind0;
      const prev = best.get(i);
      if (!prev || kind < prev[0]) best.set(i, [kind, alias]);
    }
    const score = (i: number, kind: number) => this.counts[i] * (kind === WORD ? WORD_WEIGHT : 1);
    const ranked = [...best.entries()].sort(([i, [ka]], [j, [kb]]) => {
      if ((ka === EXACT) !== (kb === EXACT)) return ka === EXACT ? -1 : 1;
      return score(j, kb) - score(i, ka) || i - j;
    });
    const out: TagMatch[] = [];
    for (const [i, [, alias]] of ranked) {
      if (exclude.has(this.names[i].toLowerCase())) continue;
      out.push({ name: this.names[i], category: this.categories[i], count: this.counts[i], alias });
      if (out.length >= limit) break;
    }
    return out;
  }
}

// --- shared, loaded the first time a prompt box needs it

let loading: Promise<TagIndex> | null = null;

export function loadTagIndex(): Promise<TagIndex> {
  loading ??= (async () => {
    const bytes = new Uint8Array(await (await fetch(tagsUrl)).arrayBuffer());
    // gzip, unless something on the way already unpacked it
    const text =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
        : new TextDecoder().decode(bytes);
    return TagIndex.parse(text);
  })();
  loading.catch(() => (loading = null));
  return loading;
}

// --- text editing

/**
 * [start, end] of the tag being typed at `cursor`. It starts after the last
 * separator (comma, newline, |), skipping spaces, emphasis brackets and a
 * weight like "1.3::", and ends at the cursor: text after the cursor is never
 * replaced.
 */
export function currentToken(text: string, cursor: number): [number, number] {
  if (cursor <= 0) return [0, 0];
  let start = Math.max(...SEPARATORS.map((s) => text.lastIndexOf(s, cursor - 1))) + 1;
  const k = cursor >= 2 ? text.lastIndexOf("::", cursor - 2) : -1;
  if (k >= start) start = k + 2; // "1.3::tag" or "tag::" closing a weight
  while (start < cursor && (" \t" + OPENERS).includes(text[start])) start++;
  const m = WEIGHT_PREFIX.exec(text.slice(start, cursor));
  if (m) start += m[0].length;
  return [start, cursor];
}

const SENTENCE_END = ".!?";

/**
 * `start`, then the start of each later word that follows the end of a
 * sentence ("A girl in the rain. lo" → "lo"): where a tag could begin when the
 * text before it has no comma. Not every word, or a phrase that isn't a tag
 * would restart suggestions at each word.
 */
function wordStarts(text: string, start: number, cursor: number): number[] {
  const out = [start];
  for (let i = start + 1; i < cursor; i++) {
    if (" \t".includes(text[i - 1]) && !" \t".includes(text[i])) {
      const before = text.slice(start, i).trimEnd();
      if (before && SENTENCE_END.includes(before[before.length - 1])) out.push(i);
    }
  }
  return out;
}

/** Lower-case tags already in a prompt, to leave out of suggestions. */
export function tagsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (let part of text.split(/[,\n|]/)) {
    part = part.replace(/^[\s{}[\]()]+|[\s{}[\]()]+$/g, "").replace(WEIGHT_PREFIX, "");
    part = part.replace(/::/g, "").replace(/^[\s{}[\]()]+|[\s{}[\]()]+$/g, "");
    if (part) out.add(normalize(part));
  }
  return out;
}

/**
 * Suggestions for the tag being typed: the stretch since the last comma first
 * ("school un" → school uniform), then what follows a sentence end. Null when
 * nothing matches.
 */
export function findSuggestions(
  index: TagIndex,
  text: string,
  cursor: number,
  force = false,
): { start: number; end: number; matches: TagMatch[] } | null {
  const [segStart, end] = currentToken(text, cursor);
  const minimum = force ? 1 : MIN_QUERY;
  for (const start of wordStarts(text, segStart, cursor)) {
    const query = normalize(text.slice(start, cursor));
    if (query.length < minimum) break;
    const matches = index.search(query, tagsIn(text.slice(0, start) + text.slice(end)), minimum);
    if (matches.length > 0) return { start, end, matches };
  }
  return null;
}

/**
 * Replaces text[start, end) (the tag being typed) with `tag` and a comma that
 * fits what follows; everything after it stays. Returns the new text and cursor.
 */
export function applyCompletion(text: string, start: number, end: number, tag: string): [string, number] {
  const before = text.slice(0, start);
  let after = text.slice(end);
  let insert: string;
  if (after.replace(/[ \t]/g, "") === "") {
    insert = `${tag}, `;
    after = "";
  } else if (("," + CLOSERS).includes(after[0]) || after.startsWith("::")) insert = tag;
  else if (" \t\n".includes(after[0])) insert = `${tag},`;
  else insert = `${tag}, `;
  return [before + insert + after, before.length + insert.length];
}
