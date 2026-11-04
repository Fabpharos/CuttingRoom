// Character cards (SillyTavern / Tavern format) stored in PNG images. Rust
// reads and writes the chunks; see src-tauri/src/character_card.rs.

import { invoke } from "@tauri-apps/api/core";

/** A card's `data` object. Fields this tab doesn't edit (extensions, V3 extras) are kept as they are. */
export type CardData = Record<string, unknown>;

export type CardInfo = {
  data: CardData | null;
  /** "chara_card_v3", "chara_card_v2" or "v1"; null when there's no card. */
  spec: string | null;
  /** AI generation metadata found in the image, e.g. "NovelAI". */
  aiMetadata: string[];
  isPng: boolean;
};

export function readCharacterCard(path: string): Promise<CardInfo> {
  return invoke("read_character_card", { path });
}

/** Saves `source` as the PNG `dest` (which may be `source`) with `data` as its card. */
export function writeCharacterCard(source: string, dest: string, data: CardData): Promise<void> {
  return invoke("write_character_card", { source, dest, data });
}

export function suggestCardOutput(source: string): Promise<string> {
  return invoke("suggest_card_output", { source });
}

/** The text fields the tab edits, in the order SillyTavern shows them. */
export const TEXT_FIELDS = [
  { key: "name", label: "Name", rows: 1 },
  { key: "description", label: "Description", rows: 8 },
  { key: "personality", label: "Personality", rows: 3 },
  { key: "scenario", label: "Scenario", rows: 3 },
  { key: "first_mes", label: "First message", rows: 6 },
  { key: "mes_example", label: "Example messages", rows: 6 },
  { key: "creator_notes", label: "Creator notes", rows: 3 },
  { key: "system_prompt", label: "System prompt", rows: 2 },
  { key: "post_history_instructions", label: "Post-history instructions", rows: 2 },
  { key: "creator", label: "Creator", rows: 1 },
  { key: "character_version", label: "Character version", rows: 1 },
] as const;

/** A new card with every V2 field present and empty. */
export function emptyCard(): CardData {
  const card: CardData = {};
  for (const f of TEXT_FIELDS) card[f.key] = "";
  card.alternate_greetings = [];
  card.tags = [];
  card.extensions = {};
  return card;
}

export const textOf = (card: CardData, key: string) => (typeof card[key] === "string" ? (card[key] as string) : "");
export const listOf = (card: CardData, key: string) =>
  Array.isArray(card[key]) ? (card[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
