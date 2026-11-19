import { useState } from "react";
import HelpTip from "./HelpTip";
import { usableArtists, artistText, type ArtistEntry, type ArtistLibrary, type ModelFamily } from "../lib/savedPrompts";

const sel: React.CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12,
};
const FAMILIES: ModelFamily[] = ["V5", "V4.5", "V4"];

/**
 * The artist library: artist tags (or whole style blocks) with the models
 * they suit, used fixed, K at random, or one after another. They go where
 * `__artists__` is in the prompt, or at its end.
 */
export default function ArtistLibraryCard({
  value,
  onChange,
  family,
  disabled,
  hasFolder,
  cardStyle,
  titleStyle,
}: {
  value: ArtistLibrary;
  onChange: (v: ArtistLibrary) => void;
  family: ModelFamily;
  disabled: boolean;
  hasFolder: boolean;
  cardStyle: React.CSSProperties;
  titleStyle: React.CSSProperties;
}) {
  const [adding, setAdding] = useState<ArtistEntry | null>(null);
  const usable = usableArtists(value, family);
  const set = (c: Partial<ArtistLibrary>) => onChange({ ...value, ...c });
  const toggle = (id: string) =>
    set({ selected: value.selected.includes(id) ? value.selected.filter((x) => x !== id) : [...value.selected, id] });

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ ...titleStyle, marginBottom: 0, flex: 1 }}>
          ARTIST LIBRARY
          {value.enabled && <span style={{ fontWeight: 500 }}> · {usable.length} in use</span>}
          <HelpTip
            lines={[
              { syntax: "__artists__", text: "Where the artists go in the main prompt; without it they're added at the end." },
              { text: "Fixed uses every ticked entry; Random picks K of them per image; Next uses one at a time, a new one every N images." },
              { text: "Entries marked for other models are greyed out and skipped (a V4.5-only artist on V5, say). A style block is a tested mix of weighted tags kept as one entry." },
            ]}
          />
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={disabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            style={{ accentColor: "var(--accent)" }}
          />
          On
        </label>
      </div>
      {!hasFolder && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Choose a card folder in the Character Cards tab; the library is kept there.</div>}
      {value.enabled && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
          <select value={value.mode} disabled={disabled} onChange={(e) => set({ mode: e.target.value as ArtistLibrary["mode"] })} style={sel}>
            <option value="fixed">Fixed: all ticked</option>
            <option value="random">Random: K per image</option>
            <option value="next">Next: one every N images</option>
          </select>
          {value.mode === "random" && (
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              K
              <input
                type="number"
                min={1}
                max={20}
                value={value.k}
                disabled={disabled}
                onChange={(e) => set({ k: Math.max(1, Math.min(20, Math.round(Number(e.target.value)) || 1)) })}
                style={{ ...sel, width: 48 }}
              />
            </label>
          )}
          {value.mode === "next" && (
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              every
              <input
                type="number"
                min={1}
                value={value.every}
                disabled={disabled}
                onChange={(e) => set({ every: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                style={{ ...sel, width: 48 }}
              />
              images
            </label>
          )}
          <input value={value.label} disabled={disabled} placeholder="only label…" onChange={(e) => set({ label: e.target.value })} style={{ ...sel, width: 110 }} />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
        {value.entries.map((e) => {
          const fits = e.families.length === 0 || e.families.includes(family);
          return (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, opacity: fits ? 1 : 0.45 }}>
              <input
                type="checkbox"
                checked={value.selected.includes(e.id)}
                disabled={disabled}
                onChange={() => toggle(e.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              <span
                title={artistText(e)}
                style={{ flex: 1, minWidth: 0, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {artistText(e)}
              </span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>
                {e.families.length ? e.families.join("/") : "all"}
                {e.labels.length ? ` · ${e.labels.join(", ")}` : ""}
              </span>
              <a
                href="#"
                onClick={(ev) => {
                  ev.preventDefault();
                  if (!disabled) setAdding(e);
                }}
                style={{ fontWeight: 600 }}
              >
                Edit
              </a>
              <a
                href="#"
                onClick={(ev) => {
                  ev.preventDefault();
                  if (!disabled) set({ entries: value.entries.filter((x) => x.id !== e.id), selected: value.selected.filter((x) => x !== e.id) });
                }}
                style={{ fontWeight: 600 }}
              >
                Remove
              </a>
            </div>
          );
        })}
      </div>
      {hasFolder && !adding && (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (!disabled) setAdding({ id: crypto.randomUUID(), tag: "", block: false, families: [], strength: 1, labels: [] });
          }}
          style={{ fontSize: 12.5, fontWeight: 600, alignSelf: "flex-start" }}
        >
          + Add artist or style block
        </a>
      )}
      {adding && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={adding.block} onChange={(e) => setAdding({ ...adding, block: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
              style block
            </label>
            <input
              value={adding.tag}
              autoFocus
              placeholder={adding.block ? "1.2::artist:a::, 0.8::artist:b::, …" : "artist name"}
              onChange={(e) => setAdding({ ...adding, tag: e.target.value })}
              style={{ ...sel, flex: "1 1 200px", fontFamily: "'IBM Plex Mono', monospace" }}
            />
            {!adding.block && (
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                strength
                <input
                  type="number"
                  step={0.05}
                  value={adding.strength}
                  onChange={(e) => setAdding({ ...adding, strength: Number(e.target.value) || 1 })}
                  style={{ ...sel, width: 60 }}
                />
              </label>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            good on
            {FAMILIES.map((f) => (
              <label key={f} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <input
                  type="checkbox"
                  checked={adding.families.includes(f)}
                  onChange={(e) =>
                    setAdding({ ...adding, families: e.target.checked ? [...adding.families, f] : adding.families.filter((x) => x !== f) })
                  }
                  style={{ accentColor: "var(--accent)" }}
                />
                {f}
              </label>
            ))}
            <input
              value={adding.labels.join(", ")}
              placeholder="labels"
              onChange={(e) => setAdding({ ...adding, labels: e.target.value.split(",").map((l) => l.trim()).filter(Boolean) })}
              style={{ ...sel, width: 140 }}
            />
            <span style={{ flex: 1 }} />
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setAdding(null);
              }}
              style={{ fontWeight: 600 }}
            >
              Cancel
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!adding.tag.trim()) return;
                const exists = value.entries.some((x) => x.id === adding.id);
                set({
                  entries: exists ? value.entries.map((x) => (x.id === adding.id ? adding : x)) : [...value.entries, adding],
                  selected: exists || value.selected.includes(adding.id) ? value.selected : [...value.selected, adding.id],
                });
                setAdding(null);
              }}
              style={{ fontWeight: 600 }}
            >
              Save
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
