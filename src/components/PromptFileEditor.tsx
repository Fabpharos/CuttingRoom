import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import HelpTip from "./HelpTip";
import { readPromptFile } from "../lib/promptFile";
import { TOKEN } from "../lib/promptTokens";
import { helpFor } from "../lib/syntaxHelp";

type Line = { weight: number; text: string };

const input: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12.5,
  fontFamily: "'IBM Plex Mono', monospace",
};

function parse(raw: string[]): Line[] {
  return raw.map((l) => {
    const m = /^%(\d+(?:\.\d+)?)\s+(.*)$/.exec(l);
    return m ? { weight: Number(m[1]), text: m[2] } : { weight: 1, text: l };
  });
}

/**
 * Edits a prompt file's lines and their weights, and shows tokens that name
 * no file and files that refer back to themselves. Saves the same .txt
 * format, so the file stays editable in any text editor.
 */
export default function PromptFileEditor({
  path,
  name,
  initial,
  knownNames,
  loop,
  onSaved,
  onClose,
}: {
  path: string;
  name: string;
  initial: string[];
  /** Every file name tokens can use. */
  knownNames: Set<string>;
  /** The chain if this file refers back to itself. */
  loop: string[] | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<Line[]>(() => parse(initial));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloaded, setReloaded] = useState(false);

  // The file as typed: comments and part lines are kept as they are.
  const missing = [
    ...new Set(
      lines.flatMap((l) => [...l.text.matchAll(TOKEN)].map((m) => m[1].toLowerCase()).filter((n) => !knownNames.has(n))),
    ),
  ];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const out = lines
        .filter((l) => l.text.trim() !== "")
        .map((l) => (l.weight !== 1 && !/^[A-Za-z][A-Za-z0-9 _-]{0,29}:/.test(l.text) && !l.text.startsWith("#") ? `%${l.weight} ${l.text}` : l.text));
      await invoke("write_prompt_file", { path, lines: out });
      onSaved();
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
          padding: "18px 20px",
          width: "min(760px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          color: "var(--text)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          __{name}__
          <HelpTip lines={helpFor("promptFiles")} />
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>{path}</div>
        {loop && (
          <div style={{ fontSize: 12.5, color: "rgb(200,140,40)" }}>
            This file refers back to itself ({loop.join(" → ")}); the token where the loop closes is left as typed.
          </div>
        )}
        {missing.length > 0 && (
          <div style={{ fontSize: 12.5, color: "rgb(200,140,40)" }}>
            No file is named {missing.map((n) => `__${n}__`).join(", ")}; those tokens are left as typed.
          </div>
        )}
        {error && <div style={{ fontSize: 12.5, color: "#c9482f" }}>{error}</div>}
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 4 }}>
          {lines.map((l, i) => {
            const isPart = /^[A-Za-z][A-Za-z0-9 _-]{0,29}:(\s|$)/.test(l.text) && !/^text:/i.test(l.text);
            const isComment = l.text.startsWith("#");
            return (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="number"
                  min={0.1}
                  step={1}
                  value={l.weight}
                  disabled={isPart || isComment}
                  title={isPart ? "Part lines take their entry's weight" : "How often this line comes up in random mode (1 is normal)"}
                  onChange={(e) => {
                    const w = Number(e.target.value);
                    setLines(lines.map((x, j) => (j === i ? { ...x, weight: Number.isFinite(w) && w > 0 ? w : 1 } : x)));
                  }}
                  style={{ ...input, width: 56, opacity: isPart || isComment ? 0.4 : 1 }}
                />
                <input
                  value={l.text}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  style={{ ...input, flex: 1, paddingLeft: isPart ? 22 : 8, color: isComment ? "var(--muted)" : "var(--text)" }}
                />
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setLines(lines.filter((_, j) => j !== i));
                  }}
                  style={{ fontSize: 12, fontWeight: 600 }}
                >
                  Remove
                </a>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setLines([...lines, { weight: 1, text: "" }]);
            }}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            + Add line
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void readPromptFile(path).then((raw) => {
                setLines(parse(raw));
                setReloaded(true);
              }, (err) => setError(String(err)));
            }}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            {reloaded ? "Reloaded" : "Reload from disk"}
          </a>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ padding: "7px 16px", borderRadius: 999, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontWeight: 600, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            style={{ padding: "7px 16px", borderRadius: 999, border: "none", background: "var(--accent)", color: "var(--accent-contrast)", fontWeight: 600, cursor: "pointer", opacity: saving ? 0.5 : 1 }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
