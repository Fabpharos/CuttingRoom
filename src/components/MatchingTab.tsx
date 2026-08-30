import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { extensionOf, isImageFile, naturalCompare } from "../lib/images";
import { getThumbnailUrl } from "../lib/thumbnails";
import {
  findImageMatches,
  cancelMatch,
  copyFilesToFolder,
  matchConfidenceLabel,
  computeAssignment,
  type CopyJob,
  type MatchMatrix,
  type MatchProgress,
} from "../lib/matching";
import type { ImageEntry } from "./ImageGrid";

type ReviewRow = {
  albumName: string;
  albumPath: string;
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
  const [matrix, setMatrix] = useState<MatchMatrix | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [copiedCount, setCopiedCount] = useState(0);
  const [progress, setProgress] = useState<MatchProgress | null>(null);
  // Hamming distance over a 64-bit hash tops out at 64; matches farther
  // apart than this are visually unrelated, not just a weak match.
  const [maxDistance, setMaxDistance] = useState(20);
  // Off by default: each target photo is claimed by at most one source
  // photo. Turning this on restores the simpler "closest match, ties and
  // reuse allowed" behavior.
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const rowsRef = useRef<ReviewRow[]>([]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Re-derives the assignment (and, only for rows whose match actually
  // changed, their thumbnail) whenever the matrix, threshold, or
  // duplicates setting changes — so both settings can be tuned instantly
  // after the scan completes, with no re-hashing.
  useEffect(() => {
    if (!matrix) return;
    let cancelled = false;
    const assignment = computeAssignment(matrix.distances, maxDistance, allowDuplicates);
    (async () => {
      const prev = rowsRef.current;
      const nextRows = await Promise.all(
        matrix.albumPaths.map(async (albumPath, i) => {
          const sourceIndex = assignment[i];
          const matchPath = sourceIndex !== null ? matrix.sourcePaths[sourceIndex] : null;
          const distance = sourceIndex !== null ? matrix.distances[i][sourceIndex] : null;
          const albumImg = leftImages[i] as ImageEntry | undefined;
          const prevRow = prev[i];
          const unchanged = !!prevRow && prevRow.matchPath === matchPath;
          const matchSrc = unchanged
            ? prevRow.matchSrc
            : matchPath
              ? await getThumbnailUrl(matchPath)
              : (albumImg?.src ?? null);
          return {
            albumName: albumImg?.name ?? "",
            albumPath,
            albumSrc: albumImg?.src ?? "",
            matchPath,
            matchSrc,
            distance,
            included: unchanged ? prevRow.included : true,
          };
        }),
      );
      if (!cancelled) setRows(nextRows);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix, maxDistance, allowDuplicates]);

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
      setMatrix(null);
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

      const result = await findImageMatches(runId, albumPaths, sourcePaths, setProgress);
      // Cancelling doesn't reject this promise — the Rust side just returns
      // an empty result — so without this check, a cancelled run's success
      // path would still fire afterward and stomp the "idle" state the
      // cancel button just set, with an empty review list.
      if (runIdRef.current !== runId) return;

      setMatrix(result);
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

  // The copied file's content comes from whichever photo won the match,
  // but its name should read as the source photo — only borrowing the
  // matched file's extension when it actually differs (e.g. the match was
  // a PNG re-save of a photo the source folder has as a JPEG).
  function destinationNameFor(row: ReviewRow): string {
    const sourcePath = row.matchPath ?? row.albumPath;
    const sourceBaseName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
    const sourceExt = extensionOf(sourceBaseName);
    const albumExt = extensionOf(row.albumName);
    if (!sourceExt || sourceExt === albumExt) return row.albumName;
    const stem = albumExt ? row.albumName.slice(0, -albumExt.length) : row.albumName;
    return `${stem}${sourceExt}`;
  }

  async function chooseDestAndCopy() {
    const dest = await open({ directory: true, multiple: false });
    if (typeof dest !== "string") return;
    // Every included row contributes something now — its matched target
    // photo if it has one, otherwise a copy of the source photo itself —
    // but always named after the source photo.
    const jobs: CopyJob[] = rows
      .filter((r) => r.included)
      .map((r) => ({ src: r.matchPath ?? r.albumPath, fileName: destinationNameFor(r) }));
    if (jobs.length === 0) return;
    setPhase("copying");
    setError(null);
    try {
      await copyFilesToFolder(jobs, dest);
      setDestDir(dest);
      setCopiedCount(jobs.length);
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

  const includedCount = rows.filter((r) => r.included).length;
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
          want into a destination folder. A photo with no acceptable match copies over
          as-is instead of being skipped.
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
                  setMatrix(null);
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
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  marginBottom: 12,
                  padding: "10px 14px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowDuplicates}
                    onChange={(e) => setAllowDuplicates(e.target.checked)}
                  />
                  Allow duplicates
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--muted)",
                      fontWeight: 400,
                      fontFamily: "system-ui, sans-serif",
                    }}
                  >
                    — let the same target photo match more than one source photo
                  </span>
                </label>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Max distance to keep
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={64}
                    value={maxDistance}
                    onChange={(e) => setMaxDistance(Number(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--accent)" }}
                  />
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--muted)",
                      fontFamily: "'IBM Plex Mono', monospace",
                      whiteSpace: "nowrap",
                      minWidth: 130,
                      textAlign: "right",
                    }}
                  >
                    {maxDistance} · up to “{matchConfidenceLabel(maxDistance)}”
                  </span>
                </div>
              </div>

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
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={r.included}
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
                          outline: r.matchPath ? "none" : "1px dashed var(--dashed)",
                          outlineOffset: -1,
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
                          : "No match within threshold — copying original"}
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
                  {includedCount} of {rows.length} selected
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
