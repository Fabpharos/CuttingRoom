import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { isImageFile, naturalCompare } from "../lib/images";
import { getThumbnailUrl } from "../lib/thumbnails";
import {
  findImageMatches,
  cancelMatch,
  copyFilesToFolder,
  matchConfidenceLabel,
  type MatchProgress,
} from "../lib/matching";
import type { ImageEntry } from "./ImageGrid";

type ReviewRow = {
  albumName: string;
  albumSrc: string;
  matchPath: string | null;
  matchSrc: string | null;
  distance: number | null;
  included: boolean;
};

type Phase = "pickLeft" | "idle" | "loading" | "review" | "copying" | "done";

export default function MatchingTab() {
  const [leftFolder, setLeftFolder] = useState<string | null>(null);
  const [leftImages, setLeftImages] = useState<ImageEntry[]>([]);
  const [phase, setPhase] = useState<Phase>("pickLeft");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [copiedCount, setCopiedCount] = useState(0);
  const [progress, setProgress] = useState<MatchProgress | null>(null);
  const runIdRef = useRef<string | null>(null);

  async function chooseLeftFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setError(null);
    try {
      const entries = await readDir(dir);
      const names = entries
        .filter((e) => e.isFile && isImageFile(e.name))
        .map((e) => e.name)
        .sort(naturalCompare);
      const withThumbs = await Promise.all(
        names.map(async (name) => ({
          name,
          src: await getThumbnailUrl(await join(dir, name)),
        })),
      );
      setLeftFolder(dir);
      setLeftImages(withThumbs);
      setPhase("idle");
      setRows([]);
    } catch (err) {
      setError(`Couldn't open folder: ${String(err)}`);
    }
  }

  async function chooseSourceAndCompare() {
    if (!leftFolder) return;
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setError(null);
    setProgress(null);
    setPhase("loading");
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    try {
      const entries = await readDir(dir);
      const sourceNames = entries
        .filter((e) => e.isFile && isImageFile(e.name))
        .map((e) => e.name);
      const sourcePaths = await Promise.all(sourceNames.map((n) => join(dir, n)));
      const albumPaths = await Promise.all(
        leftImages.map((img) => join(leftFolder, img.name)),
      );

      const matches = await findImageMatches(runId, albumPaths, sourcePaths, setProgress);
      // Cancelling doesn't reject this promise — the Rust side just returns
      // an empty result — so without this check, a cancelled run's success
      // path would still fire afterward and stomp the "idle" state the
      // cancel button just set, with an empty review list.
      if (runIdRef.current !== runId) return;

      const withThumbs = await Promise.all(
        matches.map(async (m, i) => ({
          albumName: leftImages[i].name,
          albumSrc: leftImages[i].src,
          matchPath: m.matchPath,
          matchSrc: m.matchPath ? await getThumbnailUrl(m.matchPath) : null,
          distance: m.distance,
          included: m.matchPath !== null,
        })),
      );
      setRows(withThumbs);
      setPhase("review");
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(`Couldn't compare images: ${String(err)}`);
      setPhase("idle");
    }
  }

  function toggleIncluded(i: number) {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, included: !r.included } : r)),
    );
  }

  async function chooseDestAndCopy() {
    const dest = await open({ directory: true, multiple: false });
    if (typeof dest !== "string") return;
    const toCopy = rows
      .filter((r) => r.included && r.matchPath)
      .map((r) => r.matchPath as string);
    if (toCopy.length === 0) return;
    setPhase("copying");
    setError(null);
    try {
      await copyFilesToFolder(toCopy, dest);
      setDestDir(dest);
      setCopiedCount(toCopy.length);
      setPhase("done");
    } catch (err) {
      setError(`Couldn't copy files: ${String(err)}`);
      setPhase("review");
    }
  }

  function cancelIfBusy() {
    if (phase === "loading" && runIdRef.current) {
      void cancelMatch(runIdRef.current);
      runIdRef.current = null;
    }
  }

  const includedCount = rows.filter((r) => r.included && r.matchPath).length;
  const isBusy = phase === "loading" || phase === "copying";

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Matching</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          Compares every photo in a folder against a second folder and finds each one's
          closest visual match — even at a different resolution (handy for tracking down
          the original, un-upscaled file). Review the matches, then copy the ones you
          want into a destination folder.
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

      {phase === "pickLeft" && (
        <button
          onClick={() => void chooseLeftFolder()}
          style={{
            padding: "9px 18px",
            border: "none",
            borderRadius: 999,
            background: "var(--accent)",
            color: "var(--accent-contrast)",
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Choose Folder to Match…
        </button>
      )}

      {phase !== "pickLeft" && leftFolder && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "8px 12px",
              marginBottom: 16,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontFamily: "system-ui, sans-serif",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={leftFolder}
            >
              {leftFolder}
            </span>
            <span
              style={{
                fontSize: 11.5,
                color: "var(--muted)",
                fontFamily: "'IBM Plex Mono', monospace",
                whiteSpace: "nowrap",
              }}
            >
              {leftImages.length} PHOTO{leftImages.length === 1 ? "" : "S"}
            </span>
            {!isBusy && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPhase("pickLeft");
                  setLeftFolder(null);
                  setLeftImages([]);
                  setRows([]);
                }}
                style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                Change
              </a>
            )}
          </div>

          {phase === "idle" && (
            <button
              onClick={() => void chooseSourceAndCompare()}
              style={{
                padding: "9px 18px",
                border: "none",
                borderRadius: 999,
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Choose Folder to Compare…
            </button>
          )}

          {phase === "loading" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, color: "var(--muted)" }}>
                {progress
                  ? `Hashing ${progress.done} / ${progress.total}…`
                  : "Starting…"}
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
                  setPhase("idle");
                }}
                style={{ fontSize: 12.5, alignSelf: "flex-start" }}
              >
                Cancel
              </a>
            </div>
          )}

          {phase === "copying" && (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Copying files…</div>
          )}

          {phase === "done" && (
            <div style={{ fontSize: 13.5 }}>
              Copied {copiedCount} file{copiedCount === 1 ? "" : "s"} to
              <div
                style={{
                  marginTop: 6,
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 12,
                  color: "var(--muted)",
                  wordBreak: "break-all",
                }}
              >
                {destDir}
              </div>
            </div>
          )}

          {phase === "review" && rows.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              No photos to compare — the folder you chose had no images in it.
            </div>
          )}

          {phase === "review" && rows.length > 0 && (
            <div>
              <div
                style={{
                  maxHeight: "55vh",
                  overflowY: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "0 14px",
                }}
              >
                {rows.map((r, i) => (
                  <div
                    key={r.albumName}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 0",
                      borderBottom:
                        i < rows.length - 1 ? "1px solid var(--border)" : "none",
                      opacity: r.matchPath ? 1 : 0.5,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={r.included}
                      disabled={!r.matchPath}
                      onChange={() => toggleIncluded(i)}
                    />
                    <img
                      src={r.albumSrc}
                      alt={r.albumName}
                      style={{
                        width: 52,
                        height: 52,
                        objectFit: "cover",
                        borderRadius: 6,
                        flexShrink: 0,
                      }}
                    />
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      style={{ stroke: "var(--muted)", flexShrink: 0 }}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                    {r.matchSrc ? (
                      <img
                        src={r.matchSrc}
                        alt=""
                        style={{
                          width: 52,
                          height: 52,
                          objectFit: "cover",
                          borderRadius: 6,
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: 6,
                          background: "var(--bg-card)",
                          border: "1px solid var(--border)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={r.albumName}
                      >
                        {r.albumName}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--muted)",
                          fontFamily: "'IBM Plex Mono', monospace",
                        }}
                      >
                        {r.matchPath
                          ? `${matchConfidenceLabel(r.distance)} · distance ${r.distance}`
                          : "No match found"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 14,
                }}
              >
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {includedCount} selected
                </span>
                <button
                  onClick={() => void chooseDestAndCopy()}
                  disabled={includedCount === 0}
                  style={{
                    padding: "8px 18px",
                    border: "none",
                    borderRadius: 999,
                    background: "var(--accent)",
                    color: "var(--accent-contrast)",
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: includedCount === 0 ? "default" : "pointer",
                    opacity: includedCount === 0 ? 0.5 : 1,
                  }}
                >
                  Copy to Folder…
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
