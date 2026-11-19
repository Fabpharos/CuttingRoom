import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import HelpTip from "./HelpTip";
import ConfirmModal from "./ConfirmModal";
import { getAccountStatus, cancelBatch, type AccountStatus } from "../lib/novelai";
import {
  DEFRY_LABELS,
  EMOTIONS,
  planDirector,
  runDirector,
  type Area,
  type DirectorOutcome,
  type DirectorPlan,
  type DirectorTool,
} from "../lib/director";

const input: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12.5,
};
const btn = (primary: boolean, off = false): React.CSSProperties => ({
  padding: "7px 16px",
  borderRadius: 999,
  border: primary ? "none" : "1px solid var(--border)",
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "var(--accent-contrast)" : "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: off ? "default" : "pointer",
  opacity: off ? 0.5 : 1,
});
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

/**
 * Change an image's expression (Emotion) or colour it (Colorize) with
 * NovelAI. Free on Opus up to 1024×1024 worth of pixels; on a bigger image,
 * drag out the area to change (it's cropped, changed and blended back).
 */
export default function DirectorDialog({
  path,
  initialTool,
  outputDir,
  onDone,
  onClose,
}: {
  path: string;
  initialTool: DirectorTool;
  /** Where results go; the image's own folder when null. */
  outputDir: string | null;
  onDone: (outcome: DirectorOutcome) => void;
  onClose: () => void;
}) {
  const [tool, setTool] = useState<DirectorTool>(initialTool);
  const [emotion, setEmotion] = useState("happy");
  const [prompt, setPrompt] = useState("");
  const [defry, setDefry] = useState(0);
  const [area, setArea] = useState<Area | null>(null);
  const [plan, setPlan] = useState<DirectorPlan | null>(null);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [result, setResult] = useState<DirectorOutcome | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const request = { path, tool, emotion, prompt, defry, area };
  useEffect(() => {
    planDirector(request)
      .then((p) => {
        setPlan(p);
        setError(null);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tool, emotion, defry, area]);
  useEffect(() => {
    getAccountStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // Free on Opus within the free size (always the case for what's sent).
  const paid = !status?.isOpus;

  // Drawing the area, in the image's own pixels.
  function toImage(e: React.PointerEvent) {
    const el = imgRef.current;
    if (!el || !plan) return null;
    const r = el.getBoundingClientRect();
    const sx = plan.imageWidth / r.width;
    const sy = plan.imageHeight / r.height;
    return {
      x: Math.min(plan.imageWidth, Math.max(0, Math.round((e.clientX - r.left) * sx))),
      y: Math.min(plan.imageHeight, Math.max(0, Math.round((e.clientY - r.top) * sy))),
    };
  }

  async function run() {
    setConfirmPaid(false);
    const runId = crypto.randomUUID();
    setRunning(runId);
    setError(null);
    try {
      const out = await runDirector(runId, request, outputDir ?? folderOf(path), !paid);
      setResult(out);
      onDone(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }

  const shown = area ?? plan?.area ?? null;
  return (
    <div
      onClick={() => !running && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "18px 20px",
          width: "min(900px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          color: "var(--text)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>
            {tool === "emotion" ? "Change expression" : "Colorize"} · {fileName(path)}
            <HelpTip
              lines={[
                { text: "NovelAI's Director tools. Free on Opus up to 1024×1024 worth of pixels; the balance is checked before and after." },
                { text: "On a bigger image, drag a box around the area to change (a face, say): only that is sent, then blended back." },
                { text: "The result is saved as a new file; the original isn't touched." },
              ]}
            />
          </div>
          {(["emotion", "colorize"] as const).map((t) => (
            <button key={t} onClick={() => setTool(t)} disabled={!!running} style={{ ...btn(tool === t), padding: "4px 12px", fontSize: 12 }}>
              {t === "emotion" ? "Emotion" : "Colorize"}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div
            style={{ position: "relative", flex: "1 1 360px", minWidth: 0, userSelect: "none", touchAction: "none" }}
            onPointerDown={(e) => {
              const p = toImage(e);
              if (!p || running) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = p;
            }}
            onPointerMove={(e) => {
              const start = dragRef.current;
              const p = toImage(e);
              if (!start || !p) return;
              const x = Math.min(start.x, p.x);
              const y = Math.min(start.y, p.y);
              const w = Math.abs(p.x - start.x);
              const h = Math.abs(p.y - start.y);
              if (w >= 64 && h >= 64) setArea({ x, y, width: w, height: h });
            }}
            onPointerUp={() => (dragRef.current = null)}
          >
            <img
              ref={imgRef}
              src={convertFileSrc(result?.path ?? path)}
              alt=""
              draggable={false}
              style={{ display: "block", maxWidth: "100%", maxHeight: 520, borderRadius: 6, cursor: "crosshair" }}
            />
            {plan && shown && !result && (
              <div
                style={{
                  position: "absolute",
                  left: `${(shown.x / plan.imageWidth) * 100}%`,
                  top: `${(shown.y / plan.imageHeight) * 100}%`,
                  width: `${(shown.width / plan.imageWidth) * 100}%`,
                  height: `${(shown.height / plan.imageHeight) * 100}%`,
                  outline: "2px solid var(--accent)",
                  boxShadow: "0 0 0 9999px rgba(0,0,0,.35)",
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
          <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 10, fontSize: 12.5 }}>
            {tool === "emotion" && (
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontWeight: 600, color: "var(--muted)" }}>Emotion</span>
                <select value={emotion} onChange={(e) => setEmotion(e.target.value)} disabled={!!running} style={input}>
                  {EMOTIONS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600, color: "var(--muted)" }}>{tool === "emotion" ? "Extra tags (optional)" : "Prompt (optional)"}</span>
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={!!running}
                placeholder={tool === "emotion" ? "e.g. blush, tears" : "e.g. red hair, blue eyes"}
                style={input}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600, color: "var(--muted)" }}>Strength: {DEFRY_LABELS[defry]}</span>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={defry}
                disabled={!!running}
                onChange={(e) => setDefry(Number(e.target.value))}
                style={{ accentColor: "var(--accent)" }}
              />
            </label>
            {plan && (
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.6 }}>
                Image {plan.imageWidth}×{plan.imageHeight}
                <br />
                Area {plan.area.width}×{plan.area.height} at {plan.area.x},{plan.area.y}
                <br />
                Sent at {plan.sendWidth}×{plan.sendHeight}
                {plan.scaled && <span style={{ color: "rgb(200,140,40)" }}> (shrunk to stay free; drag a smaller area for full detail)</span>}
              </div>
            )}
            {area && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setArea(null);
                }}
                style={{ fontWeight: 600 }}
              >
                Use the whole image
              </a>
            )}
            <div style={{ color: paid ? "rgb(200,140,40)" : "var(--muted)" }}>
              {status === null ? "Checking the account…" : paid ? `Your ${status.tierName} account pays for this.` : "Free on Opus at this size."}
            </div>
            {error && <div style={{ color: "#c9482f" }}>{error}</div>}
            {result && (
              <div>
                Saved {fileName(result.path)}.{result.anlasWarning && <span style={{ color: "rgb(200,140,40)" }}> {result.anlasWarning}</span>}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          {running ? (
            <button onClick={() => void cancelBatch(running)} style={btn(false)}>
              Cancel
            </button>
          ) : (
            <button onClick={onClose} style={btn(false)}>
              {result ? "Close" : "Cancel"}
            </button>
          )}
          <button
            disabled={!plan || !!running || status === null}
            onClick={() => (paid ? setConfirmPaid(true) : void run())}
            style={btn(true, !plan || !!running || status === null)}
          >
            {running ? "Working…" : result ? "Again" : tool === "emotion" ? "Change expression" : "Colorize"}
          </button>
        </div>
      </div>
      {confirmPaid && status && (
        <ConfirmModal
          title="This will cost Anlas"
          message={`Your ${status.tierName} subscription doesn't include free Director tools. You have ${status.anlas.toLocaleString()} Anlas. Go ahead?`}
          confirmLabel="Go ahead"
          cancelLabel="Cancel"
          onConfirm={() => void run()}
          onCancel={() => setConfirmPaid(false)}
        />
      )}
    </div>
  );
}
