import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  getAccountStatus,
  setApiToken,
  clearApiToken,
  generateBatch,
  cancelBatch,
  readImageMetadata,
  buildImportPlan,
  randomSeed,
  fileStemFor,
  MODELS,
  SIZES,
  MAX_CHARACTERS,
  DEFAULT_STEPS,
  MAX_STEPS,
  DEFAULT_SCALE,
  MAX_SCALE,
  MAX_BATCH,
  type AccountStatus,
  type GenerateRequest,
  type ImportPlan,
} from "../lib/novelai";
import ConfirmModal from "./ConfirmModal";
import {
  readPromptFile,
  pickLineIndices,
  composeSegment,
  loadPosition,
  savePosition,
  type PromptFileMode,
  type PromptFileTarget,
} from "../lib/promptFile";
import { loadGenerateSettings, saveGenerateSettings } from "../lib/generateSettings";
import { revealFilesInExplorer } from "../lib/nativeOps";

type AccountPhase = "unchecked" | "checking" | "loggedOut" | "loggedIn";

type LastResult = { path: string; seed: number; src: string };

// Shows exactly what an import will change and what it has to skip, before
// anything in the form is overwritten.
function ImportConfirmModal({
  plan,
  onConfirm,
  onCancel,
}: {
  plan: ImportPlan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "20px 22px",
          width: 520,
          maxWidth: "90vw",
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "0 12px 32px rgba(0,0,0,.28)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Import settings?</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            marginBottom: 12,
          }}
        >
          This replaces the current prompt, undesired content and characters.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {plan.applied.map((a) => (
            <div key={a.label} style={{ fontSize: 12.5, fontFamily: "system-ui, sans-serif" }}>
              <span style={{ fontWeight: 700 }}>{a.label}:</span>{" "}
              <span style={{ color: "var(--muted)", wordBreak: "break-word" }}>{a.value}</span>
            </div>
          ))}
        </div>
        {plan.skipped.length > 0 && (
          <div style={{ ...warningBoxStyle, marginTop: 0, marginBottom: 16, fontSize: 12.5 }}>
            {plan.skipped.map((s) => (
              <div key={s}>{s}</div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onCancel} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button onClick={onConfirm} style={primaryButtonStyle}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>{label}</span>
      {children}
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
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
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted)",
  marginBottom: 10,
};

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

const warningBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 14px",
  borderRadius: 8,
  background: "rgba(200,140,40,.12)",
  border: "1px solid rgba(200,140,40,.4)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.5,
};

export default function GenerateTab({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<AccountPhase>("unchecked");
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkedRef = useRef(false);

  const [model, setModel] = useState(MODELS[0].id);
  const [sizeIndex, setSizeIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [characters, setCharacters] = useState<string[]>([]);
  const [steps, setSteps] = useState(DEFAULT_STEPS);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirmCost, setConfirmCost] = useState(false);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [count, setCount] = useState(1);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchImages, setBatchImages] = useState<LastResult[]>([]);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  const [promptFile, setPromptFile] = useState<{ path: string; lines: string[] } | null>(null);
  const [fileTarget, setFileTarget] = useState<PromptFileTarget>("main");
  const [fileMode, setFileMode] = useState<PromptFileMode>("random");
  const [fileBefore, setFileBefore] = useState("");
  const [fileAfter, setFileAfter] = useState("");
  const [filePosition, setFilePosition] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Restores the form from the last session. It's a local file, so unlike
  // the account check this is fine to do at launch.
  useEffect(() => {
    void (async () => {
      try {
        const s = await loadGenerateSettings();
        setModel(s.model);
        setSizeIndex(s.sizeIndex);
        setPrompt(s.prompt);
        setNegativePrompt(s.negativePrompt);
        setSteps(s.steps);
        setScale(s.scale);
        setCount(s.count);
        setOutputDir(s.outputDir);
        setFileMode(s.fileMode);
        setFileBefore(s.fileBefore);
        setFileAfter(s.fileAfter);
        // A saved target character needs its slot to exist.
        const characters =
          s.fileTarget !== "main" && s.characters.length <= s.fileTarget
            ? [...s.characters, ...Array(s.fileTarget + 1 - s.characters.length).fill("")]
            : s.characters;
        setCharacters(characters);
        setFileTarget(s.fileTarget);
        if (s.promptFilePath) {
          try {
            const lines = await readPromptFile(s.promptFilePath);
            setPromptFile({ path: s.promptFilePath, lines });
            setFilePosition((await loadPosition(s.promptFilePath)) % lines.length);
          } catch (err) {
            setError(`Couldn't reopen the prompt file from last time: ${String(err)}`);
          }
        }
      } catch {
        // Unreadable settings just mean starting from the defaults.
      } finally {
        setSettingsLoaded(true);
      }
    })();
  }, []);

  // Saves shortly after edits settle. Waits for the load above so the
  // defaults never overwrite the saved settings during startup.
  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = setTimeout(() => {
      void saveGenerateSettings({
        model,
        sizeIndex,
        prompt,
        negativePrompt,
        characters,
        steps,
        scale,
        count,
        outputDir,
        promptFilePath: promptFile?.path ?? null,
        fileTarget,
        fileMode,
        fileBefore,
        fileAfter,
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [
    settingsLoaded,
    model,
    sizeIndex,
    prompt,
    negativePrompt,
    characters,
    steps,
    scale,
    count,
    outputDir,
    promptFile,
    fileTarget,
    fileMode,
    fileBefore,
    fileAfter,
  ]);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [dragging, setDragging] = useState(false);

  const modelInfo = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const effectiveSteps = modelInfo.fixedSteps ?? steps;
  // A file aimed at the main prompt supplies it, so the box can be empty.
  const fileFillsPrompt = promptFile !== null && fileTarget === "main";
  const canGenerate =
    phase === "loggedIn" &&
    !generating &&
    (prompt.trim() !== "" || fileFillsPrompt) &&
    outputDir !== null;

  // What the file will put in its target field next: the actual next line in
  // sequential mode, a placeholder in random mode.
  const filePreview = promptFile
    ? composeSegment(
        fileBefore,
        fileMode === "sequential"
          ? promptFile.lines[filePosition % promptFile.lines.length]
          : "‹random line from file›",
        fileAfter,
      )
    : "";
  // V5 is free on Opus only while its refilling quota lasts.
  const quotaExhausted =
    !!status?.isOpus && modelInfo.usageLimited && !!status.usage?.isNegative;
  const costsAnlas = !!status && (!status.isOpus || quotaExhausted);

  // Drops are delivered window-wide, so only act on them while this tab is
  // the one showing and can take an import.
  const acceptDropsRef = useRef(false);
  useEffect(() => {
    acceptDropsRef.current = active && phase === "loggedIn" && !generating;
  });

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
        if (!acceptDropsRef.current) {
          setDragging(false);
          return;
        }
        if (p.type === "enter") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const png = p.paths.find((path) => path.toLowerCase().endsWith(".png"));
          if (png) void startImport(png);
          else if (p.paths.length > 0) setError("Drop a PNG image generated by NovelAI.");
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

  async function chooseImportImage() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (typeof file === "string") void startImport(file);
  }

  async function startImport(path: string) {
    setError(null);
    try {
      setImportPlan(buildImportPlan(await readImageMetadata(path)));
    } catch (err) {
      setError(String(err));
    }
  }

  function applyImport(plan: ImportPlan) {
    const v = plan.values;
    if (v.model) setModel(v.model);
    if (v.sizeIndex !== undefined) setSizeIndex(v.sizeIndex);
    if (v.steps !== undefined) setSteps(v.steps);
    if (v.scale !== undefined) setScale(v.scale);
    setPrompt(v.prompt);
    setNegativePrompt(v.negativePrompt);
    setCharacters(v.characters);
    setImportPlan(null);
  }

  async function chooseOutputDir() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  }

  function requestGenerate() {
    if (!canGenerate || !status) return;
    if (costsAnlas) setConfirmCost(true);
    else void runGenerate();
  }

  async function runGenerate() {
    if (!outputDir) return;
    const size = SIZES[sizeIndex];
    const batchStart = new Date();
    const file = promptFile;
    const lineIndices = file
      ? pickLineIndices(file.lines.length, fileMode, filePosition, count)
      : [];
    const requests: GenerateRequest[] = Array.from({ length: count }, (_, i) => {
      const seed = randomSeed();
      let imagePrompt = prompt;
      let imageCharacters = characters;
      if (file) {
        const segment = composeSegment(fileBefore, file.lines[lineIndices[i]], fileAfter);
        if (fileTarget === "main") imagePrompt = segment;
        else imageCharacters = characters.map((c, j) => (j === fileTarget ? segment : c));
      }
      return {
        model,
        prompt: imagePrompt,
        negativePrompt,
        characters: imageCharacters,
        width: size.width,
        height: size.height,
        steps: effectiveSteps,
        scale,
        seed,
        fileStem: fileStemFor(seed, i, batchStart),
      };
    });

    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setGenerating(true);
    setError(null);
    setBatchNotice(null);
    setBatchImages([]);
    setProgress({ done: 0, total: requests.length });
    try {
      const summary = await generateBatch(
        runId,
        requests,
        outputDir,
        // Only guard when every image should be free; otherwise the user has
        // already confirmed the spend.
        !costsAnlas,
        (p) => {
          setProgress({ done: p.done, total: p.total });
          if (p.image) {
            const shown = { ...p.image, src: convertFileSrc(p.image.path) };
            setLastResult(shown);
            setBatchImages((prev) => [...prev, shown]);
          }
        },
      );
      if (runIdRef.current !== runId) return;
      const made = summary.images.length;
      // Advance only past lines that actually produced an image, so a
      // cancelled or stopped batch doesn't skip the rest of its lines.
      if (file && fileMode === "sequential" && made > 0) {
        const next = (filePosition + made) % file.lines.length;
        setFilePosition(next);
        void savePosition(file.path, next);
      }
      if (summary.stoppedReason) {
        setBatchNotice(
          `Stopped after ${made} of ${requests.length}. ${summary.stoppedReason}`,
        );
      } else if (summary.cancelled) {
        setBatchNotice(`Cancelled after ${made} of ${requests.length}.`);
      }
      // Keep the Anlas figure current without disturbing the form.
      getAccountStatus()
        .then((s) => s && setStatus(s))
        .catch(() => {});
    } catch (err) {
      setError(String(err));
    } finally {
      if (runIdRef.current === runId) {
        runIdRef.current = null;
        setGenerating(false);
        setProgress(null);
      }
    }
  }

  async function choosePromptFile() {
    const path = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Text file", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    setError(null);
    try {
      const lines = await readPromptFile(path);
      const saved = await loadPosition(path);
      setPromptFile({ path, lines });
      // The file may have been edited since; keep the saved position in range.
      setFilePosition(saved % lines.length);
    } catch (err) {
      setError(String(err));
    }
  }

  function choosePromptTarget(target: PromptFileTarget) {
    setFileTarget(target);
    // Aiming at a character that doesn't exist yet adds the slots up to it.
    if (target !== "main") {
      setCharacters((prev) =>
        prev.length > target ? prev : [...prev, ...Array(target + 1 - prev.length).fill("")],
      );
    }
  }

  function removeCharacter(index: number) {
    setCharacters((prev) => prev.filter((_, j) => j !== index));
    // Keep the file aimed at the same character, or back at the main prompt
    // if that character is the one removed.
    if (fileTarget !== "main") {
      if (fileTarget === index) setFileTarget("main");
      else if (fileTarget > index) setFileTarget(fileTarget - 1);
    }
  }

  function resetPosition() {
    setFilePosition(0);
    if (promptFile) void savePosition(promptFile.path, 0);
  }

  function cancelGenerate() {
    if (runIdRef.current) void cancelBatch(runIdRef.current);
  }

  // Every tab stays mounted from launch, so checking on mount would contact
  // NovelAI each time the app opens — wait until this tab is first shown.
  useEffect(() => {
    if (!active || checkedRef.current) return;
    checkedRef.current = true;
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function refreshStatus() {
    setPhase((p) => (p === "loggedIn" ? p : "checking"));
    setError(null);
    try {
      const s = await getAccountStatus();
      setStatus(s);
      setPhase(s ? "loggedIn" : "loggedOut");
    } catch (err) {
      // A saved token that NovelAI now rejects (revoked, expired) lands
      // here; fall back to the login form so it can be replaced.
      setError(String(err));
      setStatus(null);
      setPhase("loggedOut");
    }
  }

  async function logIn() {
    setBusy(true);
    setError(null);
    try {
      const s = await setApiToken(tokenInput);
      setStatus(s);
      setTokenInput("");
      setPhase("loggedIn");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function logOut() {
    setBusy(true);
    setError(null);
    try {
      await clearApiToken();
      setStatus(null);
      setPhase("loggedOut");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Generate</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          Text-to-image generation through your NovelAI account, limited to default
          settings and the three standard resolutions.
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
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{error}</span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setError(null);
            }}
            style={{ whiteSpace: "nowrap" }}
          >
            Dismiss
          </a>
        </div>
      )}

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "14px 16px",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 10 }}>
          NOVELAI ACCOUNT
        </div>

        {(phase === "unchecked" || phase === "checking") && (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Checking saved token…</div>
        )}

        {phase === "loggedOut" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && tokenInput.trim()) void logIn();
            }}
            style={{ display: "flex", gap: 10 }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Persistent API token (pst-…)"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              disabled={busy}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="submit"
              disabled={busy || !tokenInput.trim()}
              style={{
                ...primaryButtonStyle,
                opacity: busy || !tokenInput.trim() ? 0.5 : 1,
                cursor: busy || !tokenInput.trim() ? "default" : "pointer",
              }}
            >
              {busy ? "Checking…" : "Log in"}
            </button>
          </form>
        )}

        {phase === "loggedIn" && status && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, fontSize: 13.5 }}>
                <span style={{ fontWeight: 700 }}>{status.tierName}</span>
                {!status.active && <span style={{ color: "var(--muted)" }}> (inactive)</span>}
                <span
                  style={{
                    marginLeft: 10,
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                >
                  {status.anlas.toLocaleString()} ANLAS
                </span>
                {status.isOpus && status.usage && (
                  <span
                    title="Opus generations with V5 models draw from this refilling quota. V4 and V4.5 are unlimited."
                    style={{
                      marginLeft: 10,
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 12,
                      color: status.usage.isNegative ? "rgb(200,140,40)" : "var(--muted)",
                    }}
                  >
                    V5 QUOTA{" "}
                    {status.usage.isNegative
                      ? "USED UP"
                      : `${status.usage.percent + status.usage.purchasedPercent}%`}
                  </span>
                )}
              </div>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void refreshStatus();
                }}
                style={{ fontSize: 13, fontWeight: 600 }}
              >
                Refresh
              </a>
              <button
                onClick={() => void logOut()}
                disabled={busy}
                style={{ ...secondaryButtonStyle, opacity: busy ? 0.5 : 1 }}
              >
                Log out
              </button>
            </div>

            {!status.isOpus && (
              <div style={warningBoxStyle}>
                {status.active
                  ? `Your ${status.tierName} subscription isn't Opus, so every image generated here will cost Anlas.`
                  : "Your subscription is inactive, so every image generated here will cost Anlas."}
              </div>
            )}
          </>
        )}
      </div>

      {phase === "loggedIn" && (
        <div
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.repeat) {
              e.preventDefault();
              requestGenerate();
            }
          }}
          title="Ctrl+Enter to generate"
          style={{ ...cardStyle, marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ ...cardTitleStyle, marginBottom: 0 }}>GENERATION</div>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!generating) void chooseImportImage();
              }}
              title="Fill these settings from a NovelAI image (or drag one onto this tab)"
              style={{ fontSize: 13, fontWeight: 600 }}
            >
              Import from image…
            </a>
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px" }}>
              <Field label="Model">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={generating}
                  style={{ ...inputStyle, background: "var(--bg-page)" }}
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Resolution">
              <div style={{ display: "flex", gap: 6 }}>
                {SIZES.map((s, i) => (
                  <button
                    key={s.label}
                    onClick={() => setSizeIndex(i)}
                    disabled={generating}
                    title={`${s.width} × ${s.height}`}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: i === sizeIndex ? "none" : "1px solid var(--border)",
                      background: i === sizeIndex ? "var(--accent)" : "transparent",
                      color: i === sizeIndex ? "var(--accent-contrast)" : "var(--text)",
                      fontFamily: "'Space Grotesk', sans-serif",
                      fontWeight: 600,
                      fontSize: 12.5,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.label}
                    <span style={{ opacity: 0.7, fontWeight: 500, marginLeft: 6 }}>
                      {s.width}×{s.height}
                    </span>
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px" }}>
              <Field
                label={
                  modelInfo.fixedSteps
                    ? `Steps: ${effectiveSteps} (fixed for this model)`
                    : `Steps: ${effectiveSteps} (max ${MAX_STEPS})`
                }
              >
                <input
                  type="range"
                  min={1}
                  max={MAX_STEPS}
                  step={1}
                  value={effectiveSteps}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  disabled={generating || modelInfo.fixedSteps !== undefined}
                  style={{ accentColor: "var(--accent)" }}
                />
              </Field>
            </div>
            <div style={{ flex: "1 1 220px" }}>
              <Field label={`Guidance: ${scale.toFixed(1)}`}>
                <input
                  type="range"
                  min={0}
                  max={MAX_SCALE}
                  step={0.1}
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                  disabled={generating}
                  style={{ accentColor: "var(--accent)" }}
                />
              </Field>
            </div>
          </div>

          <Field label={fileFillsPrompt ? "Prompt (from file)" : "Prompt"}>
            <textarea
              rows={4}
              value={fileFillsPrompt ? filePreview : prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={generating || fileFillsPrompt}
              style={textareaStyle}
            />
          </Field>

          <Field label="Undesired content">
            <textarea
              rows={2}
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              disabled={generating}
              style={textareaStyle}
            />
          </Field>

          <Field label={`Characters (${characters.length}/${MAX_CHARACTERS})`}>
            {characters.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <textarea
                  rows={2}
                  value={promptFile && fileTarget === i ? filePreview : c}
                  placeholder={`Character ${i + 1}`}
                  title={promptFile && fileTarget === i ? "Filled from the prompt file" : undefined}
                  onChange={(e) =>
                    setCharacters((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                  }
                  disabled={generating || (promptFile !== null && fileTarget === i)}
                  style={{ ...textareaStyle, flex: 1 }}
                />
                <button
                  onClick={() => removeCharacter(i)}
                  disabled={generating}
                  title="Remove character"
                  style={{ ...secondaryButtonStyle, padding: "6px 12px" }}
                >
                  Remove
                </button>
              </div>
            ))}
            {characters.length < MAX_CHARACTERS && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (!generating) setCharacters((prev) => [...prev, ""]);
                }}
                style={{ fontSize: 13, fontWeight: 600, alignSelf: "flex-start" }}
              >
                + Add character
              </a>
            )}
          </Field>

          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", flex: 1 }}>
                PROMPT FROM FILE
              </span>
              {promptFile && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!generating) setPromptFile(null);
                  }}
                  style={{ fontSize: 13, fontWeight: 600 }}
                >
                  Stop using file
                </a>
              )}
              <button
                onClick={() => void choosePromptFile()}
                disabled={generating}
                style={{ ...secondaryButtonStyle, padding: "6px 14px" }}
              >
                {promptFile ? "Change…" : "Choose .txt…"}
              </button>
            </div>

            {!promptFile && (
              <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
                Use a text file with one prompt per line. Each image takes one line and puts it
                into the main prompt or a character prompt.
              </div>
            )}

            {promptFile && (
              <>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: "'IBM Plex Mono', monospace",
                    color: "var(--muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={promptFile.path}
                >
                  {promptFile.lines.length} prompts · {promptFile.path}
                </div>

                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <Field label="Put the line in">
                    <select
                      value={String(fileTarget)}
                      onChange={(e) =>
                        choosePromptTarget(e.target.value === "main" ? "main" : Number(e.target.value))
                      }
                      disabled={generating}
                      style={{ ...inputStyle, background: "var(--bg-page)" }}
                    >
                      <option value="main">Main prompt</option>
                      {Array.from({ length: MAX_CHARACTERS }, (_, i) => (
                        <option key={i} value={i}>
                          Character {i + 1}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Order">
                    <div style={{ display: "flex", gap: 6 }}>
                      {(["random", "sequential"] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => setFileMode(m)}
                          disabled={generating}
                          style={{
                            padding: "6px 12px",
                            borderRadius: 8,
                            border: fileMode === m ? "none" : "1px solid var(--border)",
                            background: fileMode === m ? "var(--accent)" : "transparent",
                            color: fileMode === m ? "var(--accent-contrast)" : "var(--text)",
                            fontFamily: "'Space Grotesk', sans-serif",
                            fontWeight: 600,
                            fontSize: 12.5,
                            cursor: "pointer",
                          }}
                        >
                          {m === "random" ? "Random" : "Sequential"}
                        </button>
                      ))}
                    </div>
                  </Field>
                  {fileMode === "sequential" && (
                    <Field label="Position">
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 31 }}>
                        <span style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace" }}>
                          Next: line {filePosition + 1} of {promptFile.lines.length}
                        </span>
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            if (!generating) resetPosition();
                          }}
                          style={{ fontSize: 13, fontWeight: 600 }}
                        >
                          Reset
                        </a>
                      </div>
                    </Field>
                  )}
                </div>

                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 220px" }}>
                    <Field label="Text before the line">
                      <textarea
                        rows={2}
                        value={fileBefore}
                        onChange={(e) => setFileBefore(e.target.value)}
                        disabled={generating}
                        style={textareaStyle}
                      />
                    </Field>
                  </div>
                  <div style={{ flex: "1 1 220px" }}>
                    <Field label="Text after the line">
                      <textarea
                        rows={2}
                        value={fileAfter}
                        onChange={(e) => setFileAfter(e.target.value)}
                        disabled={generating}
                        style={textareaStyle}
                      />
                    </Field>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
                  Joined exactly as written, so include any commas or spaces you want between
                  them.
                </div>
              </>
            )}
          </div>

          <Field label="Output folder">
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: outputDir ? "var(--text)" : "var(--muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={outputDir ?? undefined}
              >
                {outputDir ?? "No folder chosen"}
              </span>
              <button
                onClick={() => void chooseOutputDir()}
                disabled={generating}
                style={secondaryButtonStyle}
              >
                Choose…
              </button>
            </div>
          </Field>

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600 }}
              title={`Up to ${MAX_BATCH} per batch, generated at least 2 seconds apart`}
            >
              Images
              <input
                type="number"
                min={1}
                max={MAX_BATCH}
                value={count}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  setCount(Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_BATCH) : 1);
                }}
                disabled={generating}
                style={{ ...inputStyle, width: 64, background: "var(--bg-page)" }}
              />
            </label>
            {generating ? (
              <button onClick={cancelGenerate} style={secondaryButtonStyle}>
                Cancel
              </button>
            ) : (
              <button
                onClick={requestGenerate}
                disabled={!canGenerate}
                style={{
                  ...primaryButtonStyle,
                  opacity: canGenerate ? 1 : 0.5,
                  cursor: canGenerate ? "pointer" : "default",
                }}
              >
                {count === 1 ? "Generate" : `Generate ${count}`}
              </button>
            )}
            {!outputDir && !generating && (
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                Choose an output folder first.
              </span>
            )}
          </div>

          {progress && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {progress.done < progress.total
                  ? `Generating ${progress.done + 1} of ${progress.total}…`
                  : "Finishing…"}
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 999,
                  background: "var(--bg-page)",
                  border: "1px solid var(--border)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                    background: "var(--accent)",
                    transition: "width .15s ease",
                  }}
                />
              </div>
            </div>
          )}

          {batchNotice && (
            <div style={{ ...warningBoxStyle, marginTop: 0 }}>{batchNotice}</div>
          )}
        </div>
      )}

      {lastResult && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <div style={cardTitleStyle}>LAST IMAGE</div>
          <img
            src={lastResult.src}
            alt="Generated image"
            style={{ display: "block", maxWidth: "100%", maxHeight: 520, borderRadius: 8 }}
          />
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              fontFamily: "'IBM Plex Mono', monospace",
              color: "var(--muted)",
              wordBreak: "break-all",
            }}
          >
            Seed {lastResult.seed} · {lastResult.path}{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void revealFilesInExplorer([lastResult.path]).catch((err) =>
                  setError(`Couldn't open Explorer: ${String(err)}`),
                );
              }}
              style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, whiteSpace: "nowrap" }}
            >
              Show in Explorer
            </a>
          </div>
          {batchImages.length > 1 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
              {batchImages.map((img) => (
                <img
                  key={img.path}
                  src={img.src}
                  alt=""
                  title={`Seed ${img.seed}`}
                  onClick={() => setLastResult(img)}
                  style={{
                    width: 64,
                    height: 64,
                    objectFit: "cover",
                    borderRadius: 6,
                    cursor: "pointer",
                    outline: img.path === lastResult.path ? "2px solid var(--accent)" : "none",
                    outlineOffset: 1,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {confirmCost && status && (
        <ConfirmModal
          title={quotaExhausted ? "V5 quota used up" : "This will cost Anlas"}
          message={
            quotaExhausted
              ? `Your Opus quota for V5 models is used up, so this may cost Anlas. You have ${status.anlas.toLocaleString()} Anlas. V4.5 models stay free. Generate ${count === 1 ? "1 image" : `${count} images`}?`
              : `Your ${status.tierName} subscription doesn't include free generations. You have ${status.anlas.toLocaleString()} Anlas. Generate ${count === 1 ? "1 image" : `${count} images`}?`
          }
          confirmLabel="Generate"
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmCost(false);
            void runGenerate();
          }}
          onCancel={() => setConfirmCost(false)}
        />
      )}

      {importPlan && (
        <ImportConfirmModal
          plan={importPlan}
          onConfirm={() => applyImport(importPlan)}
          onCancel={() => setImportPlan(null)}
        />
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
          }}
        >
          <div
            style={{
              padding: "28px 40px",
              borderRadius: 14,
              border: "2px dashed var(--accent)",
              background: "var(--bg-card)",
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            Drop a NovelAI image to import its settings
          </div>
        </div>
      )}
    </div>
  );
}
