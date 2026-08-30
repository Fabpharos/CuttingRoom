import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { isImageFile } from "../lib/images";
import { getThumbnailUrl } from "../lib/thumbnails";
import {
  detectBulkImages,
  cancelDetection,
  applyPixelation,
  type DetectionImage,
  type DetectionProgress,
} from "../lib/detection";
import { loadDetectionSettings, saveDetectionSettings } from "../lib/detectionSettings";

type ReviewBox = { box: DetectionImage["boxes"][number]; included: boolean };
type ReviewImage = {
  path: string;
  src: string;
  width: number;
  height: number;
  boxes: ReviewBox[];
};

type Phase = "setup" | "detecting" | "review" | "applying" | "done";

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{label}</span>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "9px 18px",
  border: "none",
  borderRadius: 999,
  background: "var(--accent)",
  color: "var(--accent-contrast)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};

export default function DetectionTab() {
  const [pythonPath, setPythonPath] = useState("");
  const [modelsFolder, setModelsFolder] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [conf, setConf] = useState(0.3);
  const [blockSize, setBlockSize] = useState(20);

  const [inputDir, setInputDir] = useState<string | null>(null);
  const [inputCount, setInputCount] = useState(0);

  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState<DetectionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [classNames, setClassNames] = useState<Record<string, string>>({});
  const [allImages, setAllImages] = useState<DetectionImage[]>([]);
  const [reviewImages, setReviewImages] = useState<ReviewImage[]>([]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [showPixelateDialog, setShowPixelateDialog] = useState(false);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    loadDetectionSettings().then((s) => {
      setPythonPath(s.pythonPath);
      setModelsFolder(s.modelsFolder);
      setSelectedModel(s.selectedModel);
      setConf(s.conf);
      setBlockSize(s.blockSize);
      if (s.modelsFolder) void scanModelsFolder(s.modelsFolder);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persistSettings(overrides: Partial<Parameters<typeof saveDetectionSettings>[0]> = {}) {
    void saveDetectionSettings({
      pythonPath,
      modelsFolder,
      selectedModel,
      conf,
      blockSize,
      ...overrides,
    });
  }

  async function scanModelsFolder(dir: string) {
    try {
      const entries = await readDir(dir);
      const models = await Promise.all(
        entries
          .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".pt"))
          .map((e) => join(dir, e.name)),
      );
      setAvailableModels(models);
    } catch (err) {
      setError(`Couldn't read models folder: ${String(err)}`);
    }
  }

  async function choosePythonPath() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Python executable", extensions: ["exe"] }],
    });
    if (typeof file === "string") {
      setPythonPath(file);
      persistSettings({ pythonPath: file });
    }
  }

  async function chooseModelsFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setModelsFolder(dir);
    setSelectedModel("");
    persistSettings({ modelsFolder: dir, selectedModel: "" });
    await scanModelsFolder(dir);
  }

  async function chooseInputFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      const entries = await readDir(dir);
      const count = entries.filter((e) => e.isFile && isImageFile(e.name)).length;
      setInputDir(dir);
      setInputCount(count);
      setPhase("setup");
    } catch (err) {
      setError(`Couldn't open folder: ${String(err)}`);
    }
  }

  async function runDetection() {
    if (!inputDir || !pythonPath || !selectedModel) return;
    setError(null);
    setProgress(null);
    setPhase("detecting");
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    try {
      const result = await detectBulkImages(
        runId,
        pythonPath,
        inputDir,
        selectedModel,
        conf,
        setProgress,
      );
      // Cancelling doesn't reject this promise — the Rust side just returns
      // an empty result — so without this check, a cancelled run's success
      // path would still fire afterward and stomp whatever phase the cancel
      // button just set, with an empty review list.
      if (runIdRef.current !== runId) return;

      setClassNames(result.classNames);
      setAllImages(result.images);

      const withBoxes = result.images.filter((img) => img.boxes.length > 0);
      const withThumbs = await Promise.all(
        withBoxes.map(async (img) => ({
          path: img.path,
          src: await getThumbnailUrl(img.path),
          width: img.width,
          height: img.height,
          boxes: img.boxes.map((box) => ({ box, included: true })),
        })),
      );
      setReviewImages(withThumbs);
      setPhase("review");
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(`Detection failed: ${String(err)}`);
      setPhase("setup");
    }
  }

  function cancelIfBusy() {
    if (phase === "detecting" && runIdRef.current) {
      void cancelDetection(runIdRef.current);
      runIdRef.current = null;
    }
  }

  function isClassFullyIncluded(cls: number): boolean {
    return reviewImages.every((img) =>
      img.boxes.every((b) => b.box.cls !== cls || b.included),
    );
  }

  function toggleClass(cls: number) {
    const nextIncluded = !isClassFullyIncluded(cls);
    setReviewImages((prev) =>
      prev.map((img) => ({
        ...img,
        boxes: img.boxes.map((b) =>
          b.box.cls === cls ? { ...b, included: nextIncluded } : b,
        ),
      })),
    );
  }

  function toggleBox(imgIndex: number, boxIndex: number) {
    setReviewImages((prev) =>
      prev.map((img, i) =>
        i === imgIndex
          ? {
              ...img,
              boxes: img.boxes.map((b, bi) =>
                bi === boxIndex ? { ...b, included: !b.included } : b,
              ),
            }
          : img,
      ),
    );
  }

  async function chooseOutputAndApply() {
    const dest = await open({ directory: true, multiple: false });
    if (typeof dest !== "string") return;

    const reviewByPath = new Map(reviewImages.map((r) => [r.path, r]));
    const jobs = allImages.map((img) => {
      const review = reviewByPath.get(img.path);
      const boxes = review
        ? review.boxes
            .filter((b) => b.included)
            .map((b) => ({ x1: b.box.x1, y1: b.box.y1, x2: b.box.x2, y2: b.box.y2 }))
        : [];
      return { path: img.path, boxes };
    });

    setPhase("applying");
    setError(null);
    setProgress(null);
    const runId = crypto.randomUUID();
    try {
      await applyPixelation(runId, jobs, dest, blockSize, setProgress);
      setOutputDir(dest);
      setAppliedCount(jobs.length);
      setPhase("done");
    } catch (err) {
      setError(`Couldn't apply pixelation: ${String(err)}`);
      setPhase("review");
    }
  }

  const totalIncludedBoxes = reviewImages.reduce(
    (sum, img) => sum + img.boxes.filter((b) => b.included).length,
    0,
  );

  const classCounts = new Map<number, number>();
  for (const img of reviewImages) {
    for (const b of img.boxes) {
      classCounts.set(b.box.cls, (classCounts.get(b.box.cls) ?? 0) + 1);
    }
  }
  const classSummary = [...classCounts.entries()]
    .map(([cls, count]) => ({ cls, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Detection</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          Runs a YOLO model over every photo in a folder, then lets you review what it
          found — highlighted region by region — before pixelating the ones you confirm
          into a separate output folder. Originals are never touched.
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

      {phase === "setup" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="Folder to scan">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => void chooseInputFolder()} style={primaryButtonStyle}>
                Choose Folder…
              </button>
              {inputDir && (
                <span
                  style={{
                    fontSize: 12.5,
                    color: "var(--muted)",
                    fontFamily: "'IBM Plex Mono', monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={inputDir}
                >
                  {inputDir} · {inputCount} photo{inputCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </Field>

          <Field label="Python executable">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                value={pythonPath}
                onChange={(e) => setPythonPath(e.target.value)}
                onBlur={() => persistSettings()}
                placeholder="C:\path\to\venv\Scripts\python.exe"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <button
                onClick={() => void choosePythonPath()}
                style={{
                  padding: "7px 14px",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 12.5,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Browse…
              </button>
            </div>
          </Field>

          <Field label="Models folder (.pt files)">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => void chooseModelsFolder()}
                style={{
                  padding: "7px 14px",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 12.5,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Choose Folder…
              </button>
              {modelsFolder && (
                <>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--muted)",
                      fontFamily: "'IBM Plex Mono', monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                    }}
                    title={modelsFolder}
                  >
                    {modelsFolder}
                  </span>
                  <div
                    onClick={() => void scanModelsFolder(modelsFolder)}
                    title="Refresh model list"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      style={{ stroke: "var(--muted)" }}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 4v5h-5" />
                    </svg>
                  </div>
                </>
              )}
            </div>
            {modelsFolder && (
              <select
                value={selectedModel}
                onChange={(e) => {
                  setSelectedModel(e.target.value);
                  persistSettings({ selectedModel: e.target.value });
                }}
                style={{ ...inputStyle, marginTop: 4 }}
              >
                <option value="">
                  {availableModels.length === 0
                    ? "No .pt files found in this folder"
                    : "Select a model…"}
                </option>
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {basenameOf(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div style={{ display: "flex", gap: 24 }}>
            <Field label="Confidence threshold">
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={conf}
                onChange={(e) => setConf(Number(e.target.value))}
                onBlur={() => persistSettings()}
                style={{ ...inputStyle, width: 100 }}
              />
            </Field>
            <Field label="Block size">
              <input
                type="number"
                min={2}
                step={1}
                value={blockSize}
                onChange={(e) => setBlockSize(Number(e.target.value))}
                onBlur={() => persistSettings()}
                style={{ ...inputStyle, width: 100 }}
              />
            </Field>
          </div>

          <button
            onClick={() => void runDetection()}
            disabled={!inputDir || !pythonPath || !selectedModel}
            style={{
              ...primaryButtonStyle,
              alignSelf: "flex-start",
              opacity: !inputDir || !pythonPath || !selectedModel ? 0.5 : 1,
              cursor: !inputDir || !pythonPath || !selectedModel ? "default" : "pointer",
            }}
          >
            Run Detection
          </button>
        </div>
      )}

      {phase === "detecting" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            {!progress || progress.stage === "loading"
              ? "Loading model…"
              : `Detecting ${progress.done} / ${progress.total}…`}
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
                width:
                  progress && progress.stage === "detecting"
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
              setPhase("setup");
            }}
            style={{ fontSize: 12.5, alignSelf: "flex-start" }}
          >
            Cancel
          </a>
        </div>
      )}

      {phase === "applying" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            Applying {progress?.done ?? 0} / {progress?.total ?? allImages.length}…
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
          Wrote {appliedCount} photo{appliedCount === 1 ? "" : "s"} to
          <div
            style={{
              marginTop: 6,
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              color: "var(--muted)",
              wordBreak: "break-all",
            }}
          >
            {outputDir}
          </div>
          <button
            onClick={() => setPhase("setup")}
            style={{ ...primaryButtonStyle, marginTop: 16 }}
          >
            Start Over
          </button>
        </div>
      )}

      {phase === "review" && (
        <div>
          {reviewImages.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 16,
                padding: 14,
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--bg-card)",
              }}
            >
              {classSummary.map(({ cls, count }) => {
                const active = isClassFullyIncluded(cls);
                return (
                  <button
                    key={cls}
                    onClick={() => toggleClass(cls)}
                    title="Toggle every detection of this class"
                    style={{
                      padding: "6px 14px",
                      borderRadius: 999,
                      border: active ? "none" : "1px solid var(--border)",
                      background: active ? "var(--accent)" : "transparent",
                      color: active ? "var(--accent-contrast)" : "var(--text)",
                      fontFamily: "'Space Grotesk', sans-serif",
                      fontWeight: 600,
                      fontSize: 12.5,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {classNames[String(cls)] ?? `class ${cls}`} · {count}
                  </button>
                );
              })}
            </div>
          )}

          {reviewImages.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>
              No detections above the confidence threshold — nothing to pixelate.{" "}
              {allImages.length} photo{allImages.length === 1 ? "" : "s"} will be copied
              through unchanged.
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                maxHeight: "60vh",
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 16,
                marginBottom: 16,
              }}
            >
              {reviewImages.map((img, imgIdx) => (
                <div
                  key={img.path}
                  style={{ display: "flex", gap: 14, alignItems: "flex-start" }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: 220,
                      aspectRatio: `${img.width} / ${img.height}`,
                      borderRadius: 8,
                      overflow: "hidden",
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      flexShrink: 0,
                    }}
                  >
                    <img
                      src={img.src}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "fill" }}
                    />
                    {img.boxes.map((b, bi) => (
                      <div
                        key={bi}
                        style={{
                          position: "absolute",
                          left: `${(b.box.x1 / img.width) * 100}%`,
                          top: `${(b.box.y1 / img.height) * 100}%`,
                          width: `${((b.box.x2 - b.box.x1) / img.width) * 100}%`,
                          height: `${((b.box.y2 - b.box.y1) / img.height) * 100}%`,
                          border: b.included
                            ? "2px solid var(--accent)"
                            : "2px dashed var(--muted)",
                          opacity: b.included ? 1 : 0.5,
                          boxSizing: "border-box",
                          pointerEvents: "none",
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        marginBottom: 8,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={img.path}
                    >
                      {basenameOf(img.path)}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {img.boxes.map((b, bi) => (
                        <button
                          key={bi}
                          onClick={() => toggleBox(imgIdx, bi)}
                          style={{
                            padding: "3px 10px",
                            borderRadius: 999,
                            border: b.included ? "none" : "1px solid var(--border)",
                            background: b.included ? "var(--accent)" : "transparent",
                            color: b.included ? "var(--accent-contrast)" : "var(--muted)",
                            fontSize: 11.5,
                            fontFamily: "'IBM Plex Mono', monospace",
                            cursor: "pointer",
                          }}
                        >
                          {classNames[String(b.box.cls)] ?? `class ${b.box.cls}`}{" "}
                          {b.box.conf.toFixed(2)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {totalIncludedBoxes} region{totalIncludedBoxes === 1 ? "" : "s"} selected
              across {allImages.length} photo{allImages.length === 1 ? "" : "s"}
            </span>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setPhase("setup")}
                style={{
                  padding: "9px 18px",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text)",
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Rescan
              </button>
              <button onClick={() => setShowPixelateDialog(true)} style={primaryButtonStyle}>
                Apply to Folder…
              </button>
            </div>
          </div>
        </div>
      )}

      {showPixelateDialog && (
        <div
          onClick={() => setShowPixelateDialog(false)}
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
              width: 320,
              maxWidth: "90vw",
              padding: 20,
              boxShadow: "0 20px 50px rgba(0,0,0,.35)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Pixelate</div>
            <Field label="Pixel size">
              <input
                type="number"
                min={2}
                step={1}
                value={blockSize}
                onChange={(e) => setBlockSize(Number(e.target.value))}
                onBlur={() => persistSettings()}
                autoFocus
                style={{ ...inputStyle, width: "100%" }}
              />
            </Field>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                marginTop: 18,
              }}
            >
              <button
                onClick={() => setShowPixelateDialog(false)}
                style={{
                  padding: "8px 16px",
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
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowPixelateDialog(false);
                  void chooseOutputAndApply();
                }}
                style={primaryButtonStyle}
              >
                Continue…
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
