import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { isImageFile } from "../lib/images";
import { stripMetadata, cancelStripMetadata, type StripProgress, type StripSummary } from "../lib/stripMetadata";
import ConfirmModal from "./ConfirmModal";

type Phase = "idle" | "counting" | "confirm" | "running" | "done";

async function countImagesRecursive(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory) {
      count += await countImagesRecursive(await join(dir, entry.name));
    } else if (entry.isFile && isImageFile(entry.name)) {
      count += 1;
    }
  }
  return count;
}

export default function StripMetadataTab() {
  const [folder, setFolder] = useState<string | null>(null);
  const [imageCount, setImageCount] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<StripProgress | null>(null);
  const [summary, setSummary] = useState<StripSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  async function chooseFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setError(null);
    setFolder(dir);
    setPhase("counting");
    const count = await countImagesRecursive(dir);
    setImageCount(count);
    setPhase(count > 0 ? "confirm" : "done");
    setSummary(count > 0 ? null : { stripped: 0, failed: 0, cancelled: false });
  }

  async function runStrip() {
    if (!folder) return;
    setPhase("running");
    setProgress(null);
    setError(null);
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    try {
      const result = await stripMetadata(runId, folder, setProgress);
      if (runIdRef.current !== runId) return;
      setSummary(result);
      setPhase("done");
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(`Couldn't strip metadata: ${String(err)}`);
      setPhase("done");
      setSummary(null);
    }
  }

  function cancelIfBusy() {
    if (phase === "running" && runIdRef.current) {
      void cancelStripMetadata(runIdRef.current);
      runIdRef.current = null;
    }
  }

  function reset() {
    setFolder(null);
    setImageCount(0);
    setProgress(null);
    setSummary(null);
    setError(null);
    setPhase("idle");
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Strip Metadata</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          Removes EXIF, location, camera, and other metadata from every photo in a folder
          and all of its subfolders. Photos are rewritten in place — there's no undo, so
          review the folder before you start.
        </div>
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

      {(phase === "idle" || phase === "counting") && (
        <button
          onClick={() => void chooseFolder()}
          disabled={phase === "counting"}
          style={{
            padding: "9px 18px",
            border: "none",
            borderRadius: 999,
            background: "var(--accent)",
            color: "var(--accent-contrast)",
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 600,
            fontSize: 13,
            cursor: phase === "counting" ? "default" : "pointer",
            opacity: phase === "counting" ? 0.6 : 1,
          }}
        >
          {phase === "counting" ? "Scanning…" : "Choose Folder…"}
        </button>
      )}

      {phase === "running" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            {progress
              ? `Stripping ${progress.done} / ${progress.total}…`
              : "Scanning folder…"}
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
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              cancelIfBusy();
            }}
            style={{ fontSize: 12.5, alignSelf: "flex-start" }}
          >
            Cancel
          </a>
        </div>
      )}

      {phase === "done" && (
        <div>
          <div style={{ fontSize: 13.5, marginBottom: 12 }}>
            {summary === null ? (
              "The last run didn't complete."
            ) : summary.cancelled ? (
              <>Cancelled — {summary.stripped} photo{summary.stripped === 1 ? "" : "s"} stripped before stopping.</>
            ) : imageCount === 0 ? (
              "No images found in that folder or its subfolders."
            ) : (
              <>
                Stripped metadata from {summary.stripped} photo{summary.stripped === 1 ? "" : "s"}
                {summary.failed > 0 && (
                  <>
                    {" "}— {summary.failed} photo{summary.failed === 1 ? "" : "s"} couldn't be
                    processed and were left unchanged
                  </>
                )}
                .
              </>
            )}
          </div>
          <button
            onClick={reset}
            style={{
              padding: "8px 18px",
              border: "1px solid var(--border)",
              borderRadius: 999,
              background: "transparent",
              color: "var(--text)",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Choose Another Folder…
          </button>
        </div>
      )}

      {phase === "confirm" && folder && (
        <ConfirmModal
          title="Strip metadata from this folder?"
          message={`This will rewrite ${imageCount} photo${imageCount === 1 ? "" : "s"} in "${folder}" and all of its subfolders, removing EXIF, location, and camera metadata. The original files are overwritten — this cannot be undone.`}
          confirmLabel="Strip Metadata"
          cancelLabel="Cancel"
          onConfirm={() => void runStrip()}
          onCancel={reset}
        />
      )}
    </div>
  );
}
