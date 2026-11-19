import { useEffect, useState } from "react";
import HelpTip from "./HelpTip";
import type { CardFile } from "../lib/characterCards";
import { loadAssociations, newAssociation, saveAssociations, type Association, type AssociationAction } from "../lib/library";

const input: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12.5,
  fontFamily: "system-ui, sans-serif",
};
const button = (primary: boolean): React.CSSProperties => ({
  padding: "7px 16px",
  borderRadius: 999,
  border: primary ? "none" : "1px solid var(--border)",
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "var(--accent-contrast)" : "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
});
const small: React.CSSProperties = { fontSize: 12, color: "var(--muted)", fontWeight: 600 };

/**
 * Tag associations: "when this tag is present, add these tags" (or "put this
 * character in"). Saved as associations.json in the card folder; Generate
 * applies them to every image.
 */
export default function AssociationsDialog({
  folder,
  cards,
  onClose,
}: {
  folder: string;
  cards: CardFile[];
  onClose: () => void;
}) {
  const [rules, setRules] = useState<Association[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadAssociations(folder)
      .then(setRules)
      .catch((e) => {
        setError(String(e));
        setRules([]);
      });
  }, [folder]);

  const labels = [...new Set(cards.flatMap((c) => c.card.labels))].sort();

  function update(id: string, change: Partial<Association>) {
    setRules((rs) => rs?.map((r) => (r.id === id ? { ...r, ...change } : r)) ?? rs);
    setDirty(true);
  }
  function updateAction(r: Association, change: Partial<AssociationAction>) {
    update(r.id, { action: { ...r.action, ...change } as AssociationAction });
  }
  function move(i: number, d: number) {
    setRules((rs) => {
      if (!rs || i + d < 0 || i + d >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
    setDirty(true);
  }

  async function save() {
    if (!rules) return;
    setSaving(true);
    try {
      await saveAssociations(folder, rules);
      setDirty(false);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "20px 22px",
          width: "min(880px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          color: "var(--text)",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700 }}>
          Tag associations
          <HelpTip
            lines={[
              { text: "When a tag is in an image's prompt, add more tags (to the prompt or undesired content), or put a character card in a slot." },
              { text: "Rules run once per prompt, in order, after prompt files; one rule's additions don't set off another." },
              { syntax: "!tag", text: "A protected tag never sets a rule off." },
            ]}
          />
        </div>
        {error && <div style={{ color: "#c9482f", fontSize: 13 }}>{error}</div>}
        {rules === null && <div style={{ fontSize: 13, color: "var(--muted)" }}>Reading…</div>}
        {rules?.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            No rules yet. Example: when <b>beach</b> is present, add <b>ocean, sand</b>.
          </div>
        )}
        {rules?.map((r, i) => (
          <div
            key={r.id}
            style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, opacity: r.enabled ? 1 : 0.6 }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
              <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
              <span style={small}>When</span>
              <input value={r.when} onChange={(e) => update(r.id, { when: e.target.value })} placeholder="tag" style={{ ...input, width: 150 }} />
              <span style={small}>is in</span>
              <select value={r.scope} onChange={(e) => update(r.id, { scope: e.target.value as Association["scope"] })} style={input}>
                <option value="any">any prompt</option>
                <option value="main">the main prompt</option>
                <option value="characters">a character</option>
              </select>
              {r.scope !== "main" && (
                <>
                  <span style={small}>with label</span>
                  <input
                    value={r.label}
                    list="association-labels"
                    onChange={(e) => update(r.id, { label: e.target.value })}
                    placeholder="any"
                    style={{ ...input, width: 100 }}
                  />
                </>
              )}
              <span style={small}>unless</span>
              <input value={r.unless} onChange={(e) => update(r.id, { unless: e.target.value })} placeholder="tags" style={{ ...input, width: 130 }} />
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); move(i, -1); }} title="Run earlier">↑</a>
                <a href="#" onClick={(e) => { e.preventDefault(); move(i, 1); }} title="Run later">↓</a>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setRules((rs) => rs?.filter((x) => x.id !== r.id) ?? rs);
                    setDirty(true);
                  }}
                  style={{ fontWeight: 600 }}
                >
                  Remove
                </a>
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
              <select
                value={r.action.kind}
                onChange={(e) =>
                  update(r.id, {
                    action:
                      e.target.value === "character"
                        ? { kind: "character", card: { mode: "named", name: cards[0]?.card.name ?? "" }, slot: "firstEmpty", skipIfGender: null, position: null }
                        : { kind: "tags", tags: "", target: "positive", weight: 1, removeTrigger: false },
                  })
                }
                style={input}
              >
                <option value="tags">Add tags</option>
                <option value="character">Put a character in</option>
              </select>
              {r.action.kind === "tags" ? (
                <>
                  <input
                    value={r.action.tags}
                    onChange={(e) => updateAction(r, { tags: e.target.value })}
                    placeholder="tags to add"
                    style={{ ...input, flex: "1 1 200px" }}
                  />
                  <select value={r.action.target} onChange={(e) => updateAction(r, { target: e.target.value as "positive" | "negative" })} style={input}>
                    <option value="positive">to the prompt</option>
                    <option value="negative">to undesired content</option>
                  </select>
                  <span style={small}>weight</span>
                  <input
                    type="number"
                    step={0.05}
                    value={r.action.weight}
                    onChange={(e) => updateAction(r, { weight: Number(e.target.value) || 1 })}
                    style={{ ...input, width: 64 }}
                  />
                  <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={r.action.removeTrigger}
                      onChange={(e) => updateAction(r, { removeTrigger: e.target.checked })}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    remove “{r.when || "tag"}”
                  </label>
                </>
              ) : (
                <>
                  <select
                    value={r.action.card.mode === "named" ? `named:${r.action.card.name}` : r.action.card.mode}
                    onChange={(e) => {
                      const v = e.target.value;
                      const card = v.startsWith("named:")
                        ? { mode: "named" as const, name: v.slice(6) }
                        : { mode: v as "random" | "next", label: r.action.kind === "character" && r.action.card.mode !== "named" ? r.action.card.label : (labels[0] ?? "") };
                      updateAction(r, { card });
                    }}
                    style={input}
                  >
                    {cards.map((c) => (
                      <option key={c.path} value={`named:${c.card.name}`}>
                        {c.card.name}
                      </option>
                    ))}
                    <option value="random">a random card with label…</option>
                    <option value="next">the next card with label…</option>
                  </select>
                  {r.action.card.mode !== "named" && (
                    <input
                      value={r.action.card.label}
                      list="association-labels"
                      onChange={(e) => updateAction(r, { card: { mode: (r.action as { card: { mode: "random" | "next" } }).card.mode, label: e.target.value } })}
                      placeholder="label"
                      style={{ ...input, width: 110 }}
                    />
                  )}
                  <span style={small}>in</span>
                  <select
                    value={String(r.action.slot)}
                    onChange={(e) => updateAction(r, { slot: e.target.value === "firstEmpty" ? "firstEmpty" : Number(e.target.value) })}
                    style={input}
                  >
                    <option value="firstEmpty">the first empty slot</option>
                    {Array.from({ length: 22 }, (_, k) => (
                      <option key={k} value={k + 1}>
                        slot {k + 1}
                      </option>
                    ))}
                  </select>
                  <span style={small}>skip if a</span>
                  <select
                    value={r.action.skipIfGender ?? ""}
                    onChange={(e) => updateAction(r, { skipIfGender: (e.target.value || null) as "female" | "male" | "other" | null })}
                    style={input}
                  >
                    <option value="">(never skip)</option>
                    <option value="female">female</option>
                    <option value="male">male</option>
                    <option value="other">other</option>
                  </select>
                  <span style={small}>card is loaded</span>
                </>
              )}
            </div>
          </div>
        ))}
        <datalist id="association-labels">
          {labels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setRules((rs) => [...(rs ?? []), newAssociation()]);
              setDirty(true);
            }}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            + Add rule
          </a>
          <span style={{ flex: 1 }} />
          <button style={button(false)} onClick={onClose}>
            Cancel
          </button>
          <button style={{ ...button(true), opacity: dirty && !saving ? 1 : 0.5 }} disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
