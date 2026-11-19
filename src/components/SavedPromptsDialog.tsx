import { useEffect, useState } from "react";
import HelpTip from "./HelpTip";
import { listSavedPrompts, readSavedPrompt, savePrompt, type PromptSnapshot, type SavedPrompt } from "../lib/savedPrompts";

const btn = (primary: boolean, off = false): React.CSSProperties => ({
  padding: "6px 14px",
  borderRadius: 999,
  border: primary ? "none" : "1px solid var(--border)",
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "var(--accent-contrast)" : "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 12.5,
  cursor: off ? "default" : "pointer",
  opacity: off ? 0.5 : 1,
  whiteSpace: "nowrap",
});
const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, lineHeight: 1.5, wordBreak: "break-word" };

/**
 * Named snapshots of the Generate form, kept as JSON in the library (card)
 * folder. Loading goes through the usual import confirmation.
 */
export default function SavedPromptsDialog({
  folder,
  current,
  onLoad,
  onSaveFromImage,
  onClose,
}: {
  folder: string;
  /** The form as it stands, to save. */
  current: PromptSnapshot;
  onLoad: (saved: SavedPrompt) => void;
  /** Reads an image's settings into a snapshot (null: cancelled). */
  onSaveFromImage: () => Promise<PromptSnapshot | null>;
  onClose: () => void;
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<SavedPrompt | null>(null);
  const [name, setName] = useState("");
  const [keepSeed, setKeepSeed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<PromptSnapshot | null>(null);

  async function refresh() {
    try {
      setNames(await listSavedPrompts(folder));
    } catch (e) {
      setError(String(e));
      setNames([]);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  async function doSave(snapshot: PromptSnapshot, force = false) {
    const n = name.trim();
    if (!n) return;
    if (!force && names?.some((x) => x.toLowerCase() === n.toLowerCase())) {
      setConfirmReplace(snapshot);
      return;
    }
    setConfirmReplace(null);
    try {
      const saved = await savePrompt(folder, n, snapshot);
      setMessage(`Saved “${saved}”.`);
      setName("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const s = picked?.snapshot;
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
          width: "min(820px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          color: "var(--text)",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700 }}>
          Saved prompts
          <HelpTip
            lines={[
              { text: "A saved prompt keeps the prompt, undesired content, characters (with their cards and positions), model, size, steps, guidance, sampler, Variety+, vibes and reference. The seed only if you tick it." },
              { text: "Files go in the prompts folder inside your card folder." },
            ]}
          />
        </div>
        {error && <div style={{ color: "#c9482f", fontSize: 13 }}>{error}</div>}
        {message && <div style={{ fontSize: 13 }}>{message}</div>}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name for the current form"
            style={{ flex: "1 1 220px", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-page)", color: "var(--text)", fontSize: 13 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
            <input type="checkbox" checked={keepSeed} onChange={(e) => setKeepSeed(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
            keep the seed
          </label>
          <button
            disabled={!name.trim()}
            onClick={() => void doSave({ ...current, seed: keepSeed ? current.seed : null })}
            style={btn(true, !name.trim())}
          >
            Save current
          </button>
          <button
            disabled={!name.trim()}
            title="Read a NovelAI image's settings and save them under this name"
            onClick={() =>
              void onSaveFromImage().then((snap) => snap && doSave({ ...snap, seed: keepSeed ? snap.seed : null }), (e) => setError(String(e)))
            }
            style={btn(false, !name.trim())}
          >
            Save from image…
          </button>
        </div>
        <div style={{ display: "flex", gap: 14, minHeight: 0, flex: 1 }}>
          <div style={{ width: 240, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, maxHeight: "55vh" }}>
            {names === null && <div style={{ fontSize: 13, color: "var(--muted)" }}>Reading…</div>}
            {names?.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)" }}>Nothing saved yet.</div>}
            {names?.map((n) => (
              <button
                key={n}
                onClick={() =>
                  void readSavedPrompt(folder, n).then(
                    (p) => (p ? setPicked(p) : setError(`${n} isn't a saved prompt.`)),
                    (e) => setError(String(e)),
                  )
                }
                style={{
                  textAlign: "left",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: `1px solid ${picked?.name === n ? "var(--accent)" : "transparent"}`,
                  background: picked?.name === n ? "var(--bg-page)" : "transparent",
                  color: "var(--text)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {n}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", maxHeight: "55vh", display: "flex", flexDirection: "column", gap: 6 }}>
            {s ? (
              <>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {s.model} · {s.steps} steps · guidance {s.scale}
                  {s.varietyPlus ? " · Variety+" : ""}
                  {s.seed !== null ? ` · seed ${s.seed}` : ""} · saved {new Date(picked!.savedAt).toLocaleString()}
                </div>
                <div style={mono}>{s.prompt || "(empty prompt)"}</div>
                {s.negativePrompt && <div style={{ ...mono, color: "var(--muted)" }}>Undesired: {s.negativePrompt}</div>}
                {s.characters.map((c, i) => (
                  <div key={i} style={mono}>
                    <b>
                      {i + 1}
                      {s.characterCardLinks[i] ? ` · ${s.characterCardLinks[i]!.name}` : ""}:
                    </b>{" "}
                    {c}
                  </div>
                ))}
              </>
            ) : (
              <div style={{ fontSize: 13, color: "var(--muted)" }}>Pick a saved prompt to see it.</div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={btn(false)}>
            Close
          </button>
          <button disabled={!picked} onClick={() => picked && onLoad(picked)} style={btn(true, !picked)}>
            Load…
          </button>
        </div>
        {confirmReplace && (
          <div style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(200,140,40,.12)", border: "1px solid rgba(200,140,40,.4)", fontSize: 13, display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ flex: 1 }}>“{name.trim()}” is already saved. Replace it?</span>
            <button onClick={() => setConfirmReplace(null)} style={btn(false)}>
              Cancel
            </button>
            <button onClick={() => void doSave(confirmReplace, true)} style={btn(true)}>
              Replace
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
