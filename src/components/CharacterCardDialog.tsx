import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import RefMarker from "./RefMarker";
import {
  PARTS,
  SHOW_OPTIONS,
  buildCharacterPrompt,
  hiddenParts,
  linkFor,
  listCards,
  loadCardFolder,
  saveCardFolder,
  type CardExtra,
  type CardFile,
  type CardLink,
  type Part,
  type ShowOption,
} from "../lib/characterCards";

const buttonBase: React.CSSProperties = {
  padding: "8px 18px",
  borderRadius: 999,
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const primaryButtonStyle: React.CSSProperties = {
  ...buttonBase,
  border: "none",
  background: "var(--accent)",
  color: "var(--accent-contrast)",
};
const secondaryButtonStyle: React.CSSProperties = {
  ...buttonBase,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
};
const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };
const selectStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 13,
};

const chip = (on: boolean): React.CSSProperties => ({
  padding: "4px 12px",
  borderRadius: 999,
  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
  background: on ? "var(--accent)" : "transparent",
  color: on ? "var(--accent-contrast)" : "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
});

/** Where the picked card goes: a new character, in place of one, or added to one that has a card. */
type Target = { kind: "new" } | { kind: "replace"; slot: number } | { kind: "add"; slot: number; mode: CardExtra["mode"] };

const targetValue = (t: Target) => (t.kind === "new" ? "new" : t.kind === "replace" ? `replace:${t.slot}` : `${t.mode}:${t.slot}`);
function parseTarget(v: string): Target {
  if (v === "new") return { kind: "new" };
  const [k, n] = v.split(":");
  const slot = Number(n);
  return k === "replace" ? { kind: "replace", slot } : { kind: "add", slot, mode: k === "all" ? "all" : "outfit" };
}

/**
 * Picks a character card and fills a character with its prompt, leaving out
 * the parts the chosen view won't show, or adds it to a character that
 * already has a card (an outfit, say), linking both cards to that character.
 */
export default function CharacterCardDialog({
  characterCount,
  maxCharacters,
  cardNames = [],
  onLoad,
  onAdd,
  onLoadMany,
  onClose,
}: {
  characterCount: number;
  maxCharacters: number;
  /** The card each character has now (null: none), so cards can be added to it. */
  cardNames?: (string | null)[];
  /** `slot` is the character to replace, or null to add a new one. */
  onLoad: (prompt: string, negative: string, slot: number | null, link: CardLink) => void;
  /** Adds the card to character `slot`, as its outfit or with all its tags. */
  onAdd?: (slot: number, link: CardLink, mode: CardExtra["mode"], hidden: Set<Part>) => void;
  /** Several cards (Ctrl+click) go into the next free slots. */
  onLoadMany?: (items: { prompt: string; negative: string; link: CardLink }[]) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [cards, setCards] = useState<CardFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // Ctrl+click adds more cards to load at once.
  const [extra, setExtra] = useState<string[]>([]);
  const [options, setOptions] = useState<Set<ShowOption>>(new Set());
  const [hidden, setHidden] = useState<Set<Part>>(new Set());
  const canAdd = characterCount < maxCharacters;
  const [target, setTarget] = useState<Target>(canAdd ? { kind: "new" } : { kind: "replace", slot: 0 });
  const slot = target.kind === "new" ? null : target.slot;
  // "*" shows every folder's cards.
  const [inFolder, setInFolder] = useState("*");

  async function load(f: string) {
    try {
      const list = await listCards(f);
      setCards(list);
      setPicked((p) => (p && list.some((c) => c.path === p) ? p : (list[0]?.path ?? null)));
      setError(null);
    } catch (err) {
      setCards([]);
      setError(String(err));
    }
  }

  useEffect(() => {
    void (async () => {
      const f = await loadCardFolder().catch(() => null);
      setFolder(f);
      if (f) await load(f);
      else setCards([]);
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function chooseFolder() {
    const f = await open({ directory: true, multiple: false });
    if (typeof f !== "string") return;
    setFolder(f);
    await saveCardFolder(f).catch(() => {});
    await load(f);
  }

  function toggleOption(key: ShowOption) {
    setOptions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        const ex = SHOW_OPTIONS.find((o) => o.key === key)?.excludes;
        if (ex) next.delete(ex);
      }
      return next;
    });
  }

  // Choosing a view resets the parts to what it shows; they can then be ticked by hand.
  useEffect(() => setHidden(hiddenParts(options)), [options]);

  function togglePart(part: Part) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(part)) next.delete(part);
      else next.add(part);
      return next;
    });
  }

  const card = cards?.find((c) => c.path === picked)?.card ?? null;
  const cardFolders = [...new Set((cards ?? []).map((c) => c.folder))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const shown = (cards ?? []).filter((c) => inFolder === "*" || c.folder === inFolder);
  const many = extra.length > 0;
  const room = maxCharacters - characterCount;
  const prompt = card ? buildCharacterPrompt(card, hidden, options) : "";
  const used = (part: Part) => card?.tags.some((t) => t.part === part) ?? false;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "20px 22px",
          width: "min(720px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          color: "var(--text)",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700 }}>Load character card</div>
        {onLoadMany && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -8 }}>
            Ctrl+click to add several cards at once; they fill the next free slots ({Math.max(0, room)} free).
          </div>
        )}

        {error && <div style={{ fontSize: 13, color: "#c9482f" }}>{error}</div>}

        {cards === null ? (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Reading cards…</div>
        ) : !folder || cards.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              {folder
                ? "No character cards in this folder. Make them in the Character Cards tab."
                : "Choose the folder your character cards are in. Make cards in the Character Cards tab."}
            </div>
            <button style={secondaryButtonStyle} onClick={() => void chooseFolder()}>
              Choose Card Folder…
            </button>
          </div>
        ) : (
          <>
            {cardFolders.length > 0 && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <span style={labelStyle}>Folder</span>
                <select value={inFolder} onChange={(e) => setInFolder(e.target.value)} style={selectStyle}>
                  <option value="*">All folders</option>
                  <option value="">(card folder)</option>
                  {cardFolders.map((f) => (
                    <option key={f} value={f}>
                      {f.replace(/\//g, " › ")}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
              {shown.map((c) => {
                const on = c.path === picked || extra.includes(c.path);
                return (
                  <button
                    key={c.path}
                    onClick={(e) => {
                      if ((e.ctrlKey || e.metaKey) && onLoadMany && picked && picked !== c.path) {
                        setExtra((x) => (x.includes(c.path) ? x.filter((p) => p !== c.path) : [...x, c.path]));
                      } else {
                        setPicked(c.path);
                        setExtra([]);
                      }
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 5,
                      padding: 6,
                      borderRadius: 8,
                      border: `2px solid ${on ? "var(--accent)" : "transparent"}`,
                      background: on ? "var(--bg-page)" : "transparent",
                      color: "var(--text)",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ position: "relative", width: 80, height: 80 }}>
                      <img
                        src={convertFileSrc(c.path)}
                        alt=""
                        style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, display: "block" }}
                      />
                      <RefMarker reference={c.card.reference} size="large" />
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        maxWidth: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.card.name}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>View</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SHOW_OPTIONS.map((o) => (
                  <button key={o.key} onClick={() => toggleOption(o.key)} style={chip(options.has(o.key))}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Include</span>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
                {PARTS.filter((p) => p.key !== "other").map((p) => (
                  <label
                    key={p.key}
                    style={{ display: "flex", gap: 5, alignItems: "center", opacity: used(p.key) ? 1 : 0.5 }}
                    title={used(p.key) ? undefined : "This card has no tags here"}
                  >
                    <input type="checkbox" checked={!hidden.has(p.key)} onChange={() => togglePart(p.key)} />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelStyle}>Character prompt</span>
              <div
                style={{
                  fontSize: 12.5,
                  fontFamily: "'IBM Plex Mono', monospace",
                  lineHeight: 1.5,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--bg-page)",
                  border: "1px solid var(--border)",
                  minHeight: 40,
                  wordBreak: "break-word",
                }}
              >
                {prompt || "—"}
              </div>
              {card?.negative && (
                <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                  Undesired: {card.negative}
                </div>
              )}
            </div>

            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <span style={labelStyle}>Put it in</span>
              <select value={targetValue(target)} onChange={(e) => setTarget(parseTarget(e.target.value))} style={selectStyle}>
                {canAdd && <option value="new">A new character</option>}
                {Array.from({ length: characterCount }, (_, i) => (
                  <option key={`r${i}`} value={`replace:${i}`}>
                    Character {i + 1} (replace{cardNames[i] ? ` ${cardNames[i]}` : ""})
                  </option>
                ))}
                {onAdd &&
                  cardNames.map((n, i) =>
                    n ? (
                      <optgroup key={`a${i}`} label={`Add to character ${i + 1} (${n})`}>
                        <option value={`outfit:${i}`}>As its outfit (replaces its upper and lower body tags)</option>
                        <option value={`all:${i}`}>With all its tags</option>
                      </optgroup>
                    ) : null,
                  )}
              </select>
            </label>
            {target.kind === "add" && (
              <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginTop: -6 }}>
                {target.mode === "outfit"
                  ? "Only this card's upper and lower body tags go in, replacing the character's own outfit. "
                  : "Every tag of this card that the character doesn't have yet goes in. "}
                Both cards stay linked to the character, so view tags and references keep working.
                {card?.reference?.type === "character" || card?.reference?.type === "character&style"
                  ? target.mode === "outfit"
                    ? " This card's Character reference isn't sent as an outfit."
                    : ""
                  : ""}
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={secondaryButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{ ...primaryButtonStyle, opacity: card && (canAdd || slot !== null) ? 1 : 0.5 }}
            disabled={!card || (!canAdd && slot === null)}
            onClick={() => {
              if (!card || !picked) return;
              if (target.kind === "add" && onAdd) {
                onAdd(target.slot, linkFor(card, picked), target.mode, hidden);
                return;
              }
              if (many && onLoadMany) {
                const files = [picked, ...extra].map((p) => cards!.find((c) => c.path === p)!).slice(0, room);
                onLoadMany(
                  files.map((f) => ({
                    prompt: buildCharacterPrompt(f.card, hidden, options),
                    negative: f.card.negative,
                    link: linkFor(f.card, f.path),
                  })),
                );
              } else onLoad(prompt, card.negative, slot, linkFor(card, picked));
            }}
          >
            {target.kind === "add" ? `Add to character ${target.slot + 1}` : many ? `Add ${Math.min(room, extra.length + 1)} characters` : "Load"}
          </button>
        </div>
      </div>
    </div>
  );
}
