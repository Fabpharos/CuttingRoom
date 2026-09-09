import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { exportImagesToPdf, cancelPdfExport, type PdfExportProgress } from "../lib/pdfExport";
import { revealFilesInExplorer } from "../lib/nativeOps";
import type { ImageEntry } from "./ImageGrid";

type Phase = "input" | "running" | "done";

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  width: "100%",
};

const cancelButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  border: "1px solid var(--border)",
  borderRadius: 999,
  background: "transparent",
  color: "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
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
};

export default function PdfExportDialog({
  folderPath,
  albumName,
  images,
  onClose,
}: {
  folderPath: string;
  albumName: string;
  images: ImageEntry[];
  onClose: () => void;
}) {
  const [borderPx, setBorderPx] = useState(20);
  const [phase, setPhase] = useState<Phase>("input");
  const [progress, setProgress] = useState<PdfExportProgress | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  async function chooseDestAndExport() {
    const dest = await save({
      defaultPath: `${albumName}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof dest !== "string") return;

    setError(null);
    setProgress(null);
    setPhase("running");
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    try {
      const paths = await Promise.all(images.map((img) => join(folderPath, img.name)));
      const completed = await exportImagesToPdf(runId, paths, dest, borderPx, setProgress);
      if (runIdRef.current !== runId) return;
      if (completed) {
        setOutputPath(dest);
        setPhase("done");
      } else {
        onClose();
      }
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(`Couldn't export PDF: ${String(err)}`);
      setPhase("input");
    }
  }

  function cancel() {
    if (phase === "running" && runIdRef.current) {
      void cancelPdfExport(runIdRef.current);
      runIdRef.current = null;
    }
    onClose();
  }

  return (
    <div
      onClick={cancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.5)",
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-page)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          width: 340,
          maxWidth: "90vw",
          padding: 20,
          boxShadow: "0 20px 50px rgba(0,0,0,.35)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Export as PDF</div>

        {error && (
          <div
            style={{
              marginBottom: 12,
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(200,60,50,.12)",
              border: "1px solid rgba(200,60,50,.35)",
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}

        {phase !== "done" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>
              Border between photos (pixels)
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={borderPx}
              disabled={phase === "running"}
              onChange={(e) => setBorderPx(Number(e.target.value))}
              autoFocus
              style={inputStyle}
            />
          </div>
        )}

        {phase === "running" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {progress ? `Preparing ${progress.done} / ${progress.total}…` : "Starting…"}
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: progress
                    ? `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%`
                    : "0%",
                  background: "var(--accent)",
                  transition: "width .15s ease",
                }}
              />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div style={{ fontSize: 13.5 }}>
            Saved {images.length} photo{images.length === 1 ? "" : "s"} to
            <div
              style={{
                marginTop: 6,
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 12,
                color: "var(--muted)",
                wordBreak: "break-all",
              }}
            >
              {outputPath}
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          {phase === "done" ? (
            <>
              <button
                onClick={() => outputPath && void revealFilesInExplorer([outputPath])}
                style={cancelButtonStyle}
              >
                View in Explorer
              </button>
              <button onClick={onClose} style={primaryButtonStyle}>
                Done
              </button>
            </>
          ) : (
            <>
              <button onClick={cancel} style={cancelButtonStyle}>
                Cancel
              </button>
              <button
                onClick={() => void chooseDestAndExport()}
                disabled={phase === "running"}
                style={{
                  ...primaryButtonStyle,
                  opacity: phase === "running" ? 0.6 : 1,
                  cursor: phase === "running" ? "default" : "pointer",
                }}
              >
                {phase === "running" ? "Exporting…" : "Choose Location…"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
