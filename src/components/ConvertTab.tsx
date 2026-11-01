import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ImportedSettings } from "../lib/novelai";
import {
  animaToNai,
  naiToAnima,
  scanImagePrompt,
  toImportedSettings,
  type NaiCharacter,
} from "../lib/promptConvert";

const textareaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.45,
  resize: "vertical",
};

const cardStyle: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minWidth: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 18px",
  border: "none",
  borderRadius: 999,
  background: "var(--accent)",
  color: "var(--accent-contrast)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  border: "1px solid var(--border)",
  borderRadius: 999,
  background: "transparent",
  color: "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const smallLinkStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  padding: 0,
  color: "var(--accent)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function Field({
  label,
  text,
  children,
}: {
  label: string;
  /** Shows a Copy link for this text. */
  text?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (text === undefined) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{label}</span>
        {text !== undefined && (
          <button style={smallLinkStyle} onClick={() => void copy()} disabled={text === ""}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export default function ConvertTab({
  active,
  onSendToGenerate,
}: {
  active: boolean;
  onSendToGenerate: (settings: ImportedSettings) => void;
}) {
  const [naiPrompt, setNaiPrompt] = useState("");
  const [naiNegative, setNaiNegative] = useState("");
  const [characters, setCharacters] = useState<NaiCharacter[]>([]);
  const [animaPrompt, setAnimaPrompt] = useState("");
  const [animaNegative, setAnimaNegative] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function toAnima(nai = { prompt: naiPrompt, negative: naiNegative, characters }) {
    const { result, notes } = naiToAnima(nai);
    setAnimaPrompt(result.prompt);
    setAnimaNegative(result.negative);
    setNotes(notes);
  }

  function toNai(anima = { prompt: animaPrompt, negative: animaNegative }) {
    const { result, notes } = animaToNai(anima);
    setNaiPrompt(result.prompt);
    setNaiNegative(result.negative);
    setCharacters(result.characters);
    setNotes(notes);
  }

  // An image's prompt fills the side it was written in, then is converted
  // to the other.
  async function scan(path: string) {
    setError(null);
    try {
      const scanned = await scanImagePrompt(path);
      if (scanned.source === "novelai") {
        const s = scanned.settings;
        const nai = {
          prompt: s.prompt,
          negative: s.negativePrompt,
          characters: s.characters.map((prompt, i) => ({ prompt, negative: s.characterNegatives[i] ?? "" })),
        };
        setNaiPrompt(nai.prompt);
        setNaiNegative(nai.negative);
        setCharacters(nai.characters);
        toAnima(nai);
        if (s.characterPositions) {
          setNotes((n) => [...n, "The image's character positions were dropped; Anima has no equivalent."]);
        }
        setSource(`NovelAI image: ${fileName(path)}`);
      } else {
        const anima = { prompt: scanned.positive, negative: scanned.negative };
        setAnimaPrompt(anima.prompt);
        setAnimaNegative(anima.negative);
        toNai(anima);
        setSource(`ComfyUI image: ${fileName(path)}`);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function chooseImage() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (typeof file === "string") void scan(file);
  }

  // Drops are delivered window-wide, so only act on them while this tab is
  // the one showing.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // not running inside Tauri (e.g. a plain browser preview)
    }
    webview
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (!activeRef.current) {
          setDragging(false);
          return;
        }
        if (p.type === "enter") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const png = p.paths.find((path) => path.toLowerCase().endsWith(".png"));
          if (png) void scan(png);
          else if (p.paths.length > 0) setError("Drop a PNG image made with NovelAI or ComfyUI.");
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearAll() {
    setNaiPrompt("");
    setNaiNegative("");
    setCharacters([]);
    setAnimaPrompt("");
    setAnimaNegative("");
    setNotes([]);
    setSource(null);
    setError(null);
  }

  const updateCharacter = (i: number, patch: Partial<NaiCharacter>) =>
    setCharacters((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const naiEmpty = !naiPrompt.trim() && characters.every((c) => !c.prompt.trim());

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Convert Prompt</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          Converts a prompt between NovelAI and Anima syntax: weights, artist tags and escaped
          parentheses, and NovelAI's character prompts to and from Anima's character lines. Open
          or drop a PNG made with NovelAI or ComfyUI to read its prompt, or paste a prompt into
          either side.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <button style={primaryButtonStyle} onClick={() => void chooseImage()}>
          Open Image…
        </button>
        <button style={secondaryButtonStyle} onClick={clearAll}>
          Clear
        </button>
        {source && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>From {source}</span>}
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(200,60,50,.12)",
            border: "1px solid rgba(200,60,50,.35)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>NovelAI</div>
          <Field label="Prompt" text={naiPrompt}>
            <textarea rows={5} value={naiPrompt} onChange={(e) => setNaiPrompt(e.target.value)} style={textareaStyle} />
          </Field>
          <Field label="Undesired content" text={naiNegative}>
            <textarea rows={3} value={naiNegative} onChange={(e) => setNaiNegative(e.target.value)} style={textareaStyle} />
          </Field>
          {characters.map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                paddingLeft: 10,
                borderLeft: "2px solid var(--border)",
              }}
            >
              <Field label={`Character ${i + 1}`} text={c.prompt}>
                <textarea
                  rows={2}
                  value={c.prompt}
                  onChange={(e) => updateCharacter(i, { prompt: e.target.value })}
                  style={textareaStyle}
                />
              </Field>
              <Field label={`Character ${i + 1} undesired content`} text={c.negative}>
                <textarea
                  rows={1}
                  value={c.negative}
                  onChange={(e) => updateCharacter(i, { negative: e.target.value })}
                  style={textareaStyle}
                />
              </Field>
              <button
                style={{ ...smallLinkStyle, alignSelf: "flex-start", color: "var(--muted)" }}
                onClick={() => setCharacters((prev) => prev.filter((_, j) => j !== i))}
              >
                Remove character
              </button>
            </div>
          ))}
          <button
            style={{ ...smallLinkStyle, alignSelf: "flex-start" }}
            onClick={() => setCharacters((prev) => [...prev, { prompt: "", negative: "" }])}
          >
            + Add character
          </button>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={primaryButtonStyle} onClick={() => toAnima()} disabled={naiEmpty}>
              Convert to Anima →
            </button>
            <button
              style={secondaryButtonStyle}
              disabled={naiEmpty}
              onClick={() =>
                onSendToGenerate(toImportedSettings({ prompt: naiPrompt, negative: naiNegative, characters }))
              }
            >
              Send to Generate
            </button>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Anima</div>
          <Field label="Prompt" text={animaPrompt}>
            <textarea rows={8} value={animaPrompt} onChange={(e) => setAnimaPrompt(e.target.value)} style={textareaStyle} />
          </Field>
          <Field label="Negative prompt" text={animaNegative}>
            <textarea rows={3} value={animaNegative} onChange={(e) => setAnimaNegative(e.target.value)} style={textareaStyle} />
          </Field>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={primaryButtonStyle} onClick={() => toNai()} disabled={!animaPrompt.trim()}>
              ← Convert to NovelAI
            </button>
            <button
              style={secondaryButtonStyle}
              disabled={!animaPrompt.trim()}
              onClick={() => onSendToGenerate(toImportedSettings(animaToNai({ prompt: animaPrompt, negative: animaNegative }).result))}
            >
              Send to Generate
            </button>
          </div>
        </div>
      </div>

      {notes.length > 0 && (
        <ul
          style={{
            marginTop: 16,
            paddingLeft: 18,
            fontSize: 12.5,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {dragging && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 250,
            background: "rgba(0,0,0,.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            color: "#fff",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Drop a PNG to read its prompt
        </div>
      )}
    </div>
  );
}
