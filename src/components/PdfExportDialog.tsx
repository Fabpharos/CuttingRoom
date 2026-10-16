import { useEffect, useRef, useState } from "react";
import { join } from "@tauri-apps/api/path";
import { exportImagesToPdf, cancelPdfExport, type PdfExportProgress } from "../lib/pdfExport";
import { revealFilesInExplorer } from "../lib/nativeOps";
import type { ImageEntry } from "./ImageGrid";

type Phase = "running" | "done";

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
  outputPath,
  images,
  onClose,
}: {
  folderPath: string;
  outputPath: string;
  images: ImageEntry[];
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("running");
  const [progress, setProgress] = useState<PdfExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    (async () => {
      try {
        const paths = await Promise.all(images.map((img) => join(folderPath, img.name)));
        const completed = await exportImagesToPdf(runId, paths, outputPath, setProgress);
        if (runIdRef.current !== runId) return;
        if (completed) {
          setPhase("done");
        } else {
          onClose();
        }
      } catch (err) {
        if (runIdRef.current !== runId) return;
        setError(`Couldn't export PDF: ${String(err)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancel() {
    if (runIdRef.current) {
      void cancelPdfExport(runIdRef.current);
      runIdRef.current = null;
    }
    onClose();
  }

  return (
    <div
      onClick={phase === "running" && !error ? undefined : onClose}
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

        {error ? (
          <>
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(200,60,50,.12)",
                border: "1px solid rgba(200,60,50,.35)",
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
              <button onClick={onClose} style={primaryButtonStyle}>
                Close
              </button>
            </div>
          </>
        ) : phase === "running" ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
              <button onClick={cancel} style={cancelButtonStyle}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
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
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button
                onClick={() => void revealFilesInExplorer([outputPath])}
                style={cancelButtonStyle}
              >
                View in Explorer
              </button>
              <button onClick={onClose} style={primaryButtonStyle}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
