import { useState } from "react";
import HelpTip from "./HelpTip";
import { CONTROL_HELP } from "../lib/syntaxHelp";
import type { GenderSwapMode, ScrambleSettings } from "../lib/promptEngine";

/** What the automation card controls, as saved with the form. */
export type AutomationSettings = {
  scramble: ScrambleSettings;
  genderSwap: { mode: GenderSwapMode; slot: number; pronouns: boolean };
  weightStep: number;
  useAssociations: boolean;
};

export const DEFAULT_AUTOMATION: AutomationSettings = {
  scramble: { main: false, mainNegative: false, characters: false, characterNegatives: false, keepFirst: 1 },
  genderSwap: { mode: "off", slot: 1, pronouns: false },
  weightStep: 0.05,
  useAssociations: true,
};

export function parseAutomation(raw: unknown): AutomationSettings {
  const d = DEFAULT_AUTOMATION;
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const sc = (r.scramble ?? {}) as Record<string, unknown>;
  const gs = (r.genderSwap ?? {}) as Record<string, unknown>;
  const modes: GenderSwapMode[] = ["off", "all", "girlsToBoys", "boysToGirls", "slot"];
  const int = (v: unknown, lo: number, hi: number, f: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : f;
  return {
    scramble: {
      main: sc.main === true,
      mainNegative: sc.mainNegative === true,
      characters: sc.characters === true,
      characterNegatives: sc.characterNegatives === true,
      keepFirst: int(sc.keepFirst, 0, 50, 1),
    },
    genderSwap: {
      mode: modes.includes(gs.mode as GenderSwapMode) ? (gs.mode as GenderSwapMode) : "off",
      slot: int(gs.slot, 1, 22, 1),
      pronouns: gs.pronouns === true,
    },
    weightStep: r.weightStep === 0.1 ? 0.1 : 0.05,
    useAssociations: r.useAssociations !== false,
  };
}

const chip = (on: boolean): React.CSSProperties => ({
  padding: "3px 10px",
  borderRadius: 999,
  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
  background: on ? "var(--accent)" : "transparent",
  color: on ? "var(--accent-contrast)" : "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
});
const select: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12.5,
};
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)", minWidth: 110 };

/** Scramble, gender swap, random weights and tag associations. */
export default function AutomationCard({
  value,
  onChange,
  disabled,
  characterCount,
  genderPairs,
  onEditPairs,
  associationCount,
  onReloadAssociations,
  onApplySwapToForm,
  canUndoSwap,
  onUndoSwap,
  cardStyle,
  titleStyle,
}: {
  value: AutomationSettings;
  onChange: (v: AutomationSettings) => void;
  disabled: boolean;
  characterCount: number;
  genderPairs: [string, string][];
  onEditPairs: (pairs: [string, string][]) => void;
  associationCount: number | null;
  onReloadAssociations: () => void;
  onApplySwapToForm: () => void;
  canUndoSwap: boolean;
  onUndoSwap: () => void;
  cardStyle: React.CSSProperties;
  titleStyle: React.CSSProperties;
}) {
  const [editingPairs, setEditingPairs] = useState<[string, string][] | null>(null);
  const sc = value.scramble;
  const gs = value.genderSwap;
  const setSc = (c: Partial<ScrambleSettings>) => onChange({ ...value, scramble: { ...sc, ...c } });
  const setGs = (c: Partial<AutomationSettings["genderSwap"]>) => onChange({ ...value, genderSwap: { ...gs, ...c } });
  const anyOn = sc.main || sc.mainNegative || sc.characters || sc.characterNegatives || gs.mode !== "off";

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...titleStyle, marginBottom: 0 }}>
        PROMPT AUTOMATION
        {anyOn && <span style={{ fontWeight: 500 }}> · on</span>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={label}>
          Scramble
          <HelpTip lines={[{ text: CONTROL_HELP.scramble }]} />
        </span>
        {(
          [
            ["main", "Prompt"],
            ["mainNegative", "Undesired"],
            ["characters", "Characters"],
            ["characterNegatives", "Character undesired"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} disabled={disabled} onClick={() => setSc({ [k]: !sc[k] })} style={chip(sc[k])}>
            {l}
          </button>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          keep first
          <input
            type="number"
            min={0}
            max={50}
            value={sc.keepFirst}
            disabled={disabled}
            onChange={(e) => setSc({ keepFirst: Math.max(0, Math.min(50, Math.round(Number(e.target.value)) || 0)) })}
            style={{ ...select, width: 52 }}
          />
          tags
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={label}>
          Gender swap
          <HelpTip lines={[{ text: CONTROL_HELP.genderSwap }, { text: "“This batch” changes what's sent; the form stays as it is." }]} />
        </span>
        <select
          value={gs.mode}
          disabled={disabled}
          onChange={(e) => setGs({ mode: e.target.value as GenderSwapMode })}
          style={select}
        >
          <option value="off">Off</option>
          <option value="all">All (this batch)</option>
          <option value="girlsToBoys">Girls → boys (this batch)</option>
          <option value="boysToGirls">Boys → girls (this batch)</option>
          <option value="slot" disabled={characterCount === 0}>
            One character (this batch)
          </option>
        </select>
        {gs.mode === "slot" && (
          <select value={gs.slot} disabled={disabled} onChange={(e) => setGs({ slot: Number(e.target.value) })} style={select}>
            {Array.from({ length: Math.max(1, characterCount) }, (_, i) => (
              <option key={i} value={i + 1}>
                Character {i + 1}
              </option>
            ))}
          </select>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={gs.pronouns}
            disabled={disabled}
            onChange={(e) => setGs({ pronouns: e.target.checked })}
            style={{ accentColor: "var(--accent)" }}
          />
          pronouns in sentences
          <HelpTip lines={[{ text: "she ↔ he, her → his. Off by default: “her” can't always be mapped correctly." }]} />
        </label>
        <span style={{ display: "flex", gap: 10, fontSize: 12.5 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (!disabled && gs.mode !== "off") onApplySwapToForm();
            }}
            title="Rewrite the prompt boxes now instead of only for the batch"
            style={{ fontWeight: 600, opacity: gs.mode === "off" ? 0.5 : 1 }}
          >
            Apply to the form
          </a>
          {canUndoSwap && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!disabled) onUndoSwap();
              }}
              style={{ fontWeight: 600 }}
            >
              Undo
            </a>
          )}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setEditingPairs(genderPairs);
            }}
            style={{ fontWeight: 600 }}
          >
            Edit table…
          </a>
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={label}>
          Random weights
          <HelpTip lines={[{ syntax: "0.6~1.4::tag::", text: "A random strength between the two numbers for each image, rounded to this step." }]} />
        </span>
        {[0.05, 0.1].map((s) => (
          <button key={s} disabled={disabled} onClick={() => onChange({ ...value, weightStep: s })} style={chip(value.weightStep === s)}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
        <span style={label}>
          Associations
          <HelpTip lines={[{ text: CONTROL_HELP.associations }]} />
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <input
            type="checkbox"
            checked={value.useAssociations}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, useAssociations: e.target.checked })}
            style={{ accentColor: "var(--accent)" }}
          />
          Use them
        </label>
        <span style={{ color: "var(--muted)" }}>
          {associationCount === null
            ? "No card folder chosen (Character Cards tab)."
            : `${associationCount} rule${associationCount === 1 ? "" : "s"} in the card folder`}
        </span>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onReloadAssociations();
          }}
          style={{ fontWeight: 600 }}
        >
          Reload
        </a>
      </div>

      {editingPairs && (
        <div
          onClick={() => setEditingPairs(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ ...cardStyle, width: 460, maxWidth: "90vw", maxHeight: "80vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}
          >
            <div style={{ fontSize: 16, fontWeight: 700 }}>Gender swap table</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Each pair swaps both ways. Tags are matched whole, never inside another word.</div>
            {editingPairs.map(([f, m], i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input value={f} onChange={(e) => setEditingPairs(editingPairs.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} style={{ ...select, flex: 1 }} />
                <span>↔</span>
                <input value={m} onChange={(e) => setEditingPairs(editingPairs.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} style={{ ...select, flex: 1 }} />
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setEditingPairs(editingPairs.filter((_, j) => j !== i));
                  }}
                  style={{ fontSize: 12, fontWeight: 600 }}
                >
                  Remove
                </a>
              </div>
            ))}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setEditingPairs([...editingPairs, ["", ""]]);
              }}
              style={{ fontSize: 12.5, fontWeight: 600 }}
            >
              + Add pair
            </a>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setEditingPairs(null)} style={chip(false)}>
                Cancel
              </button>
              <button
                onClick={() => {
                  onEditPairs(editingPairs.filter(([f, m]) => f.trim() && m.trim()));
                  setEditingPairs(null);
                }}
                style={chip(true)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
