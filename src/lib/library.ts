// The user's library: JSON files kept in the character card folder (Rust
// checks every name; see src-tauri/src/library.rs).
//
//   associations.json    tag associations
//   artists.json         the artist library
//   gender-swaps.json    the gender swap table
//   prompts/<name>.json  saved prompts
//   plans/<name>.json    workflow plans

import { invoke } from "@tauri-apps/api/core";
import type { CharacterPosition } from "./novelai";

export type LibrarySub = "" | "prompts" | "plans" | "artists";

export async function readLibrary<T = unknown>(folder: string, sub: LibrarySub, name: string): Promise<T | null> {
  return invoke("library_read", { folder, sub, name });
}

export async function writeLibrary(folder: string, sub: LibrarySub, name: string, value: unknown): Promise<string> {
  return invoke("library_write", { folder, sub, name, value });
}

export async function listLibrary(folder: string, sub: LibrarySub): Promise<string[]> {
  return invoke("library_list", { folder, sub });
}

/** A file name for a saved item: "Beach day" -> "Beach day.json". */
export function libraryFileName(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} \-_.()]/gu, "").trim().slice(0, 100) || "untitled";
  return `${clean}.json`;
}

// ---- Tag associations ----

/** Which card a "put a character in" rule uses. */
export type CardChoice =
  | { mode: "named"; name: string }
  | { mode: "random" | "next"; label: string };

export type AssociationAction =
  | {
      kind: "tags";
      /** Comma-separated tags to add. */
      tags: string;
      target: "positive" | "negative";
      /** 1 adds them as typed; anything else wraps them as `w::tags::`. */
      weight: number;
      removeTrigger: boolean;
    }
  | {
      kind: "character";
      card: CardChoice;
      /** "first empty" slot, or a fixed slot number (1-based). */
      slot: "firstEmpty" | number;
      /** Skip when a card of this gender is already loaded. */
      skipIfGender: "female" | "male" | "other" | null;
      position: CharacterPosition | null;
    };

/** When `when` is present, do `action`. */
export type Association = {
  id: string;
  enabled: boolean;
  when: string;
  /** Where to look for the trigger. */
  scope: "any" | "main" | "characters";
  /** Only characters whose card has this label ("" for any). */
  label: string;
  /** Only when none of these tags are present (comma-separated). */
  unless: string;
  action: AssociationAction;
};

export function newAssociation(): Association {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    when: "",
    scope: "any",
    label: "",
    unless: "",
    action: { kind: "tags", tags: "", target: "positive", weight: 1, removeTrigger: false },
  };
}

function parseAssociation(raw: unknown): Association | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const a = r.action as Record<string, unknown> | undefined;
  if (typeof r.when !== "string" || !a) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let action: AssociationAction;
  if (a.kind === "character") {
    const c = a.card as Record<string, unknown> | undefined;
    const card: CardChoice =
      c?.mode === "named"
        ? { mode: "named", name: str(c.name) }
        : { mode: c?.mode === "next" ? "next" : "random", label: str(c?.label) };
    const p = a.position as Record<string, unknown> | null | undefined;
    const unit = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 1 ? v : 0.5);
    action = {
      kind: "character",
      card,
      slot: typeof a.slot === "number" && Number.isInteger(a.slot) && a.slot >= 1 ? a.slot : "firstEmpty",
      skipIfGender: a.skipIfGender === "female" || a.skipIfGender === "male" || a.skipIfGender === "other" ? a.skipIfGender : null,
      position: p && typeof p === "object" ? { x: unit(p.x), y: unit(p.y) } : null,
    };
  } else {
    action = {
      kind: "tags",
      tags: str(a.tags),
      target: a.target === "negative" ? "negative" : "positive",
      weight: typeof a.weight === "number" && Number.isFinite(a.weight) ? a.weight : 1,
      removeTrigger: a.removeTrigger === true,
    };
  }
  return {
    id: typeof r.id === "string" ? r.id : crypto.randomUUID(),
    enabled: r.enabled !== false,
    when: r.when,
    scope: r.scope === "main" || r.scope === "characters" ? r.scope : "any",
    label: str(r.label),
    unless: str(r.unless),
    action,
  };
}

export async function loadAssociations(folder: string): Promise<Association[]> {
  const raw = await readLibrary<{ rules?: unknown[] }>(folder, "", "associations.json");
  return (raw?.rules ?? []).flatMap((r) => {
    const a = parseAssociation(r);
    return a ? [a] : [];
  });
}

export async function saveAssociations(folder: string, rules: Association[]): Promise<void> {
  await writeLibrary(folder, "", "associations.json", { version: 1, rules });
}

// ---- Gender swap table ----

export const DEFAULT_GENDER_PAIRS: [string, string][] = [
  ["1girl", "1boy"],
  ["2girls", "2boys"],
  ["3girls", "3boys"],
  ["multiple girls", "multiple boys"],
  ["girl", "boy"],
  ["female", "male"],
  ["woman", "man"],
  ["yuri", "yaoi"],
];

export async function loadGenderPairs(folder: string | null): Promise<[string, string][]> {
  if (!folder) return DEFAULT_GENDER_PAIRS;
  const raw = await readLibrary<{ pairs?: unknown[] }>(folder, "", "gender-swaps.json").catch(() => null);
  const pairs = (raw?.pairs ?? []).flatMap((p) =>
    Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" && p[0].trim() && p[1].trim()
      ? [[p[0].trim(), p[1].trim()] as [string, string]]
      : [],
  );
  return pairs.length > 0 ? pairs : DEFAULT_GENDER_PAIRS;
}

export async function saveGenderPairs(folder: string, pairs: [string, string][]): Promise<void> {
  await writeLibrary(folder, "", "gender-swaps.json", { version: 1, pairs });
}
