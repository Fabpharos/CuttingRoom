import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  PARTS,
  SHOW_OPTIONS,
  buildCharacterPrompt,
  hiddenParts,
  listCards,
  loadCardFolder,
  saveCardFolder,
  type CardFile,
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

/**
 * Picks a character card and fills a character with its prompt, leaving out
 * the parts the chosen view won't show.
 */
export default function CharacterCardDialog({
  characterCount,
  maxCharacters,
  onLoad,
  onClose,
}: {
  characterCount: number;
  maxCharacters: number;
  /** `slot` is the character to replace, or null to add a new one. */
  onLoad: (prompt: string, negative: string, slot: number | null) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [cards, setCards] = useState<CardFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [options, setOptions] = useState<Set<ShowOption>>(new Set());
  const [hidden, setHidden] = useState<Set<Part>>(new Set());
  const canAdd = characterCount < maxCharacters;
  const [slot, setSlot] = useState<number | null>(canAdd ? null : 0);

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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
              {cards.map((c) => {
                const on = c.path === picked;
                return (
                  <button
                    key={c.path}
                    onClick={() => setPicked(c.path)}
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
                    <img
                      src={convertFileSrc(c.path)}
                      alt=""
                      style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6 }}
                    />
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
              <select
                value={slot === null ? "new" : String(slot)}
                onChange={(e) => setSlot(e.target.value === "new" ? null : Number(e.target.value))}
                style={{
                  padding: "5px 8px",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  background: "var(--bg-page)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              >
                {canAdd && <option value="new">A new character</option>}
                {Array.from({ length: characterCount }, (_, i) => (
                  <option key={i} value={i}>
                    Character {i + 1} (replace)
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={secondaryButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{ ...primaryButtonStyle, opacity: card && (canAdd || slot !== null) ? 1 : 0.5 }}
            disabled={!card || (!canAdd && slot === null)}
            onClick={() => card && onLoad(prompt, card.negative, slot)}
          >
            Load
          </button>
        </div>
      </div>
    </div>
  );
}
