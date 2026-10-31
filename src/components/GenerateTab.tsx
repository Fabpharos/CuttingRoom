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
  readVibeFile,
  vibeEncodingFor,
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
  MAX_VIBES,
  DEFAULT_VIBE_STRENGTH,
  CENTER,
  freeCharacterPositions,
  positionsApply,
  positionForModel,
  gridLabel,
  type CharacterPosition,
  type AccountStatus,
  type GenerateRequest,
  type ImportPlan,
  type VibeInfo,
  type VibeRef,
} from "../lib/novelai";
import ConfirmModal from "./ConfirmModal";
import {
  openPromptFile,
  pickLineIndices,
  savePosition,
  type PromptFile,
  type PromptFileMode,
} from "../lib/promptFile";
import { fileTokenName, fillTokens, tokenFor, tokensIn } from "../lib/promptTokens";
import {
  loadGenerateSettings,
  saveGenerateSettings,
  type SavedVibe,
} from "../lib/generateSettings";
import { revealFilesInExplorer } from "../lib/nativeOps";

type AccountPhase = "unchecked" | "checking" | "loggedOut" | "loggedIn";

type LastResult = { path: string; seed: number; src: string };

/** A vibe in the list: what's saved, plus what was read from its file. */
type VibeEntry = SavedVibe & { key: string; info: VibeInfo | null; error: string | null };

const VIBE_EXTENSIONS = ["naiv4vibe", "naiv4vibebundle"];
const isVibeFile = (path: string) =>
  VIBE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(`.${ext}`));
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

// Reads each saved vibe's file again (once per file), so the list shows
// what's on disk now. A vibe whose file is gone stays listed with the error.
async function loadVibeEntries(saved: SavedVibe[]): Promise<VibeEntry[]> {
  const files = new Map<string, Promise<VibeInfo[]>>();
  return Promise.all(
    saved.map(async (v) => {
      if (!files.has(v.path)) files.set(v.path, readVibeFile(v.path));
      const key = crypto.randomUUID();
      try {
        const info = (await files.get(v.path)!)[v.index] ?? null;
        return { ...v, key, info, error: info ? null : "This vibe is no longer in its file." };
      } catch (err) {
        return { ...v, key, info: null, error: String(err) };
      }
    }),
  );
}

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
          This replaces the current prompt, undesired content and characters (with their undesired content).
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

// The field as the next image would get it, shown under fields that use
// prompt file tokens.
function TokenPreview({ text }: { text: string }) {
  return (
    <div
      title={text}
      style={{
        fontSize: 11.5,
        fontFamily: "'IBM Plex Mono', monospace",
        color: "var(--muted)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      → {text}
    </div>
  );
}

// A small board for placing one character, shaped like the image. Other
// characters show faintly for reference. On V4 and V4.5 it shows NovelAI's
// 5x5 grid and places on it.
function PositionPicker({
  index,
  positions,
  model,
  aspect,
  disabled,
  onChange,
}: {
  index: number;
  positions: CharacterPosition[];
  model: string;
  aspect: number;
  disabled: boolean;
  onChange: (p: CharacterPosition) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const free = freeCharacterPositions(model);
  const width = aspect >= 1 ? 84 : Math.round(84 * aspect);
  const height = aspect >= 1 ? Math.round(84 / aspect) : 84;
  function place(e: React.PointerEvent) {
    const r = ref.current?.getBoundingClientRect();
    if (!r || disabled) return;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    onChange(positionForModel(model, { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }));
  }
  const shown = (p: CharacterPosition) => positionForModel(model, p);
  const own = shown(positions[index] ?? CENTER);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
      <div
        ref={ref}
        role="slider"
        aria-label={`Position of character ${index + 1}`}
        title="Click or drag to place this character"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          place(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) place(e);
        }}
        style={{
          position: "relative",
          width,
          height,
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg-page)",
          cursor: disabled ? "default" : "crosshair",
          opacity: disabled ? 0.6 : 1,
          touchAction: "none",
          backgroundImage: free
            ? "none"
            : "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: free ? undefined : `${width / 5}px ${height / 5}px`,
        }}
      >
        {positions.map((p, j) => {
          const at = shown(p);
          const mine = j === index;
          return (
            <span
              key={j}
              style={{
                position: "absolute",
                left: `${at.x * 100}%`,
                top: `${at.y * 100}%`,
                transform: "translate(-50%, -50%)",
                width: mine ? 16 : 11,
                height: mine ? 16 : 11,
                borderRadius: "50%",
                background: mine ? "var(--accent)" : "var(--muted)",
                color: mine ? "var(--accent-contrast)" : "var(--bg-card)",
                opacity: mine ? 1 : 0.45,
                fontSize: mine ? 10 : 7,
                fontWeight: 700,
                lineHeight: mine ? "16px" : "11px",
                textAlign: "center",
                pointerEvents: "none",
                zIndex: mine ? 1 : 0,
              }}
            >
              {j + 1}
            </span>
          );
        })}
      </div>
      <span style={{ fontSize: 10.5, fontFamily: "'IBM Plex Mono', monospace", color: "var(--muted)" }}>
        {free ? `${Math.round(own.x * 100)}%, ${Math.round(own.y * 100)}%` : gridLabel(own)}
      </span>
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
  // Each character's undesired content, kept the same length as `characters`.
  const [characterNegatives, setCharacterNegatives] = useState<string[]>([]);
  // "Custom" placement, and each character's position (kept the same length).
  const [useCoords, setUseCoords] = useState(false);
  const [characterPositions, setCharacterPositions] = useState<CharacterPosition[]>([]);
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

  const [promptFiles, setPromptFiles] = useState<PromptFile[]>([]);
  // The prompt field last typed in, so clicking a file's token inserts it there.
  type PromptField = "prompt" | "negative" | { character: number; negative: boolean };
  const lastFieldRef = useRef<{ field: PromptField; el: HTMLTextAreaElement } | null>(null);
  const [vibes, setVibes] = useState<VibeEntry[]>([]);
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
        setCharacters(s.characters);
        setCharacterNegatives(s.characterNegatives);
        setUseCoords(s.useCoords);
        setCharacterPositions(s.characterPositions);
        if (s.vibes.length > 0) setVibes(await loadVibeEntries(s.vibes));
        // A file that can't be read now stays listed with its error.
        setPromptFiles(await Promise.all(s.promptFiles.map((f) => openPromptFile(f.path, f.name, f.mode))));
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
        characterNegatives,
        useCoords,
        characterPositions,
        steps,
        scale,
        count,
        outputDir,
        promptFiles: promptFiles.map(({ path, name, mode }) => ({ path, name, mode })),
        vibes: vibes.map(({ path, index, strength, informationExtracted, enabled }) => ({
          path,
          index,
          strength,
          informationExtracted,
          enabled,
        })),
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
    characterNegatives,
    useCoords,
    characterPositions,
    steps,
    scale,
    count,
    outputDir,
    promptFiles,
    vibes,
  ]);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [dragging, setDragging] = useState(false);

  const modelInfo = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const effectiveSteps = modelInfo.fixedSteps ?? steps;
  const vibesOn = vibes.filter((v) => v.enabled).length;
  // Only vibes already encoded for this model are sent; anything else would
  // need a paid encode. Rust checks this again against the files.
  const vibeRefs: VibeRef[] = modelInfo.vibes
    ? vibes.flatMap((v) => {
        const encoding = v.enabled && v.info && vibeEncodingFor(v.info, model, v.informationExtracted);
        return encoding
          ? [
              {
                path: v.path,
                index: v.index,
                informationExtracted: encoding.informationExtracted,
                strength: v.strength,
              },
            ]
          : [];
      })
    : [];
  // Prompt file tokens used anywhere in the form, and any that can't be filled.
  const usedTokens = new Set([prompt, negativePrompt, ...characters, ...characterNegatives].flatMap(tokensIn));
  const usedFiles = promptFiles.filter((f) => usedTokens.has(f.name));
  const unknownTokens = [...usedTokens].filter((name) => !promptFiles.some((f) => f.name === name));
  const unreadable = usedFiles.filter((f) => f.lines.length === 0);
  const tokenProblem =
    unknownTokens.length > 0
      ? `No prompt file is named ${unknownTokens.map(tokenFor).join(", ")}. Add the file or fix the token.`
      : unreadable.length > 0
        ? `${unreadable.map((f) => tokenFor(f.name)).join(", ")} couldn't be read, so it can't be used.`
        : null;
  // What each token becomes for the next image: the actual next line in
  // sequential mode, a placeholder in random mode.
  const nextValues = Object.fromEntries(
    promptFiles
      .filter((f) => f.lines.length > 0)
      .map((f) => [f.name, f.mode === "sequential" ? f.lines[f.position % f.lines.length] : `‹random ${f.name}›`]),
  );
  const preview = (text: string) => (tokensIn(text).length > 0 ? <TokenPreview text={fillTokens(text, nextValues)} /> : null);
  const canGenerate =
    phase === "loggedIn" &&
    !generating &&
    prompt.trim() !== "" &&
    tokenProblem === null &&
    outputDir !== null;
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
          const vibeFiles = p.paths.filter(isVibeFile);
          const png = p.paths.find((path) => path.toLowerCase().endsWith(".png"));
          if (vibeFiles.length > 0) void addVibeFiles(vibeFiles);
          else if (png) void startImport(png);
          else if (p.paths.length > 0) {
            setError("Drop a PNG image generated by NovelAI, or a .naiv4vibe file.");
          }
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
    setCharacterNegatives(v.characterNegatives);
    setUseCoords(v.characterPositions !== null);
    setCharacterPositions(v.characterPositions ?? v.characters.map(() => CENTER));
    setImportPlan(null);
  }

  async function chooseVibeFiles() {
    const files = await open({
      directory: false,
      multiple: true,
      filters: [
        { name: "NovelAI vibe", extensions: VIBE_EXTENSIONS },
        { name: "PNG with embedded vibes", extensions: ["png"] },
      ],
    });
    if (Array.isArray(files) && files.length > 0) void addVibeFiles(files);
  }

  // Adds every vibe in the files, switched on while there's room under the
  // free limit. Uses functional updates: drops call this from a listener
  // that was set up once.
  async function addVibeFiles(paths: string[]) {
    setError(null);
    const added: VibeEntry[] = [];
    const failures: string[] = [];
    for (const path of paths) {
      try {
        for (const info of await readVibeFile(path)) {
          added.push({
            key: crypto.randomUUID(),
            path,
            index: info.index,
            strength: info.strength ?? DEFAULT_VIBE_STRENGTH,
            informationExtracted: info.informationExtracted,
            enabled: false,
            info,
            error: null,
          });
        }
      } catch (err) {
        failures.push(`${fileName(path)}: ${String(err)}`);
      }
    }
    if (failures.length > 0) setError(failures.join(" "));
    setVibes((prev) => {
      const fresh = added.filter((a) => !prev.some((v) => v.path === a.path && v.index === a.index));
      let on = prev.filter((v) => v.enabled).length;
      const switched = fresh.map((v) => {
        const enabled = on < MAX_VIBES;
        if (enabled) on++;
        return { ...v, enabled };
      });
      return [...prev, ...switched];
    });
  }

  function updateVibe(key: string, change: Partial<SavedVibe>) {
    setVibes((prev) => prev.map((v) => (v.key === key ? { ...v, ...change } : v)));
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
    // One line per file per image: a token used in several fields gets the
    // same line in each, so they stay consistent within an image.
    const files = usedFiles;
    const picks = files.map((f) => pickLineIndices(f.lines.length, f.mode, f.position, count));
    const requests: GenerateRequest[] = Array.from({ length: count }, (_, i) => {
      const seed = randomSeed();
      const values = Object.fromEntries(files.map((f, k) => [f.name, f.lines[picks[k][i]]]));
      return {
        model,
        prompt: fillTokens(prompt, values),
        negativePrompt: fillTokens(negativePrompt, values),
        characters: characters.map((c) => fillTokens(c, values)),
        characterNegatives: characterNegatives.map((c) => fillTokens(c, values)),
        characterPositions: useCoords ? characterPositions : null,
        width: size.width,
        height: size.height,
        steps: effectiveSteps,
        scale,
        seed,
        fileStem: fileStemFor(seed, i, batchStart),
        vibes: vibeRefs,
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
      if (made > 0) {
        const advanced = new Map(
          files.filter((f) => f.mode === "sequential").map((f) => [f.path, (f.position + made) % f.lines.length]),
        );
        advanced.forEach((next, path) => void savePosition(path, next));
        setPromptFiles((prev) => prev.map((f) => (advanced.has(f.path) ? { ...f, position: advanced.get(f.path)! } : f)));
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

  async function addPromptFiles() {
    const picked = await open({
      directory: false,
      multiple: true,
      filters: [{ name: "Text file", extensions: ["txt"] }],
    });
    if (!Array.isArray(picked) || picked.length === 0) return;
    setError(null);
    const taken = promptFiles.map((f) => f.name);
    const added: PromptFile[] = [];
    for (const path of picked) {
      if (promptFiles.some((f) => f.path === path)) continue;
      const name = fileTokenName(path, taken);
      taken.push(name);
      added.push(await openPromptFile(path, name, "random"));
    }
    const failed = added.filter((f) => f.error);
    if (failed.length > 0) setError(failed.map((f) => `${f.path}: ${f.error}`).join(" "));
    const ok = added.filter((f) => !f.error);
    setPromptFiles((prev) => [...prev, ...ok]);
    // A single new file goes straight into the field last typed in.
    if (ok.length === 1 && promptFiles.length === 0) insertToken(ok[0].name);
  }

  function updatePromptFile(path: string, change: Partial<PromptFile>) {
    setPromptFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...change } : f)));
  }

  function resetPosition(file: PromptFile) {
    updatePromptFile(file.path, { position: 0 });
    void savePosition(file.path, 0);
  }

  // Puts `__name__` at the cursor in the prompt field last typed in, or at
  // the end of the main prompt if none has been.
  function insertToken(name: string) {
    const token = tokenFor(name);
    const last = lastFieldRef.current;
    const field = last?.field ?? "prompt";
    const current =
      field === "prompt"
        ? prompt
        : field === "negative"
          ? negativePrompt
          : ((field.negative ? characterNegatives : characters)[field.character] ?? "");
    const el = last?.el.isConnected ? last.el : null;
    let next: string;
    let caret: number;
    if (el) {
      const [start, end] = [el.selectionStart ?? current.length, el.selectionEnd ?? current.length];
      next = current.slice(0, start) + token + current.slice(end);
      caret = start + token.length;
    } else {
      const base = current.replace(/[\s,]+$/, "");
      next = base ? `${base}, ${token}` : token;
      caret = next.length;
    }
    if (field === "prompt") setPrompt(next);
    else if (field === "negative") setNegativePrompt(next);
    else {
      const set = field.negative ? setCharacterNegatives : setCharacters;
      set((prev) => prev.map((c, j) => (j === field.character ? next : c)));
    }
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }
  }

  function addCharacter() {
    setCharacters((prev) => [...prev, ""]);
    setCharacterNegatives((prev) => [...prev, ""]);
    setCharacterPositions((prev) => [...prev, CENTER]);
  }

  function removeCharacter(index: number) {
    setCharacters((prev) => prev.filter((_, j) => j !== index));
    setCharacterNegatives((prev) => prev.filter((_, j) => j !== index));
    setCharacterPositions((prev) => prev.filter((_, j) => j !== index));
    if (typeof lastFieldRef.current?.field === "object") lastFieldRef.current = null;
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

          <Field label="Prompt">
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onFocus={(e) => (lastFieldRef.current = { field: "prompt", el: e.currentTarget })}
              disabled={generating}
              style={textareaStyle}
            />
            {preview(prompt)}
          </Field>

          <Field label="Undesired content">
            <textarea
              rows={2}
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              onFocus={(e) => (lastFieldRef.current = { field: "negative", el: e.currentTarget })}
              disabled={generating}
              style={textareaStyle}
            />
            {preview(negativePrompt)}
          </Field>

          <Field label={`Characters (${characters.length}/${MAX_CHARACTERS})`}>
            {characters.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
                <span style={{ color: "var(--muted)", fontWeight: 600, fontSize: 12 }}>Placement</span>
                <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
                  {([false, true] as const).map((custom) => (
                    <button
                      key={String(custom)}
                      onClick={() => setUseCoords(custom)}
                      disabled={generating}
                      style={{
                        padding: "3px 10px",
                        border: "none",
                        background: useCoords === custom ? "var(--accent)" : "transparent",
                        color: useCoords === custom ? "var(--accent-contrast)" : "var(--text)",
                        fontFamily: "'Space Grotesk', sans-serif",
                        fontWeight: 600,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {custom ? "Custom" : "AI's choice"}
                    </button>
                  ))}
                </div>
                {useCoords && !positionsApply(model, characters.filter((c) => c.trim() !== "").length) && (
                  <span style={{ color: "rgb(200,140,40)", fontFamily: "system-ui, sans-serif" }}>
                    V4 and V4.5 place characters only when there are two or more; until then the model decides.
                  </span>
                )}
                {useCoords && positionsApply(model, characters.filter((c) => c.trim() !== "").length) && (
                  <span style={{ color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
                    {freeCharacterPositions(model) ? "V5: place anywhere." : "V4/V4.5: snaps to NovelAI's 5×5 grid."}
                  </span>
                )}
              </div>
            )}
            {characters.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <textarea
                    rows={2}
                    value={c}
                    placeholder={`Character ${i + 1}`}
                    onChange={(e) =>
                      setCharacters((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                    }
                    onFocus={(e) =>
                      (lastFieldRef.current = { field: { character: i, negative: false }, el: e.currentTarget })
                    }
                    disabled={generating}
                    style={textareaStyle}
                  />
                  {preview(c)}
                  <textarea
                    rows={1}
                    value={characterNegatives[i] ?? ""}
                    placeholder={`Undesired for character ${i + 1}`}
                    onChange={(e) =>
                      setCharacterNegatives((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                    }
                    onFocus={(e) =>
                      (lastFieldRef.current = { field: { character: i, negative: true }, el: e.currentTarget })
                    }
                    disabled={generating}
                    style={{ ...textareaStyle, fontSize: 12.5, padding: "6px 10px" }}
                  />
                  {preview(characterNegatives[i] ?? "")}
                </div>
                {useCoords && (
                  <PositionPicker
                    index={i}
                    positions={characterPositions}
                    model={model}
                    aspect={SIZES[sizeIndex].width / SIZES[sizeIndex].height}
                    disabled={generating}
                    onChange={(p) => setCharacterPositions((prev) => prev.map((q, j) => (j === i ? p : q)))}
                  />
                )}
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
                  if (!generating) addCharacter();
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
              padding: "10px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", flex: 1 }}>
                PROMPT FILES
              </span>
              <button
                onClick={() => void addPromptFiles()}
                disabled={generating}
                style={{ ...secondaryButtonStyle, padding: "5px 14px" }}
              >
                Add .txt files…
              </button>
            </div>

            {promptFiles.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
                Text files with one prompt per line. Each file gets a token like{" "}
                <code>__hair__</code>; put it in any prompt, undesired content or character, and every
                image fills it with a line from that file.
              </div>
            ) : (
              <>
                {promptFiles.map((f) => (
                  <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                    <button
                      onClick={() => insertToken(f.name)}
                      disabled={generating || f.lines.length === 0}
                      title={`${f.path}\nClick to insert ${tokenFor(f.name)} where you're typing`}
                      style={{
                        padding: "3px 8px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg-page)",
                        color: "var(--text)",
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 12,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tokenFor(f.name)}
                    </button>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: f.error ? "rgb(200,140,40)" : "var(--muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={f.error ?? f.path}
                    >
                      {f.error
                        ? f.error
                        : `${f.lines.length} line${f.lines.length === 1 ? "" : "s"}${usedTokens.has(f.name) ? "" : " · not used yet"}`}
                    </span>
                    {!f.error && (
                      <>
                        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
                          {(["random", "sequential"] as const).map((m: PromptFileMode) => (
                            <button
                              key={m}
                              onClick={() => updatePromptFile(f.path, { mode: m })}
                              disabled={generating}
                              style={{
                                padding: "3px 9px",
                                border: "none",
                                background: f.mode === m ? "var(--accent)" : "transparent",
                                color: f.mode === m ? "var(--accent-contrast)" : "var(--text)",
                                fontFamily: "'Space Grotesk', sans-serif",
                                fontWeight: 600,
                                fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              {m === "random" ? "Random" : "Sequential"}
                            </button>
                          ))}
                        </div>
                        {f.mode === "sequential" && (
                          <span style={{ whiteSpace: "nowrap", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5 }}>
                            next {f.position + 1}/{f.lines.length}
                            {f.position > 0 && (
                              <a
                                href="#"
                                onClick={(e) => {
                                  e.preventDefault();
                                  if (!generating) resetPosition(f);
                                }}
                                title="Start again from the first line"
                                style={{ marginLeft: 6, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}
                              >
                                Reset
                              </a>
                            )}
                          </span>
                        )}
                      </>
                    )}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (!generating) setPromptFiles((prev) => prev.filter((x) => x.path !== f.path));
                      }}
                      title="Remove this file (its token is left in the prompt)"
                      style={{ fontWeight: 600 }}
                    >
                      Remove
                    </a>
                  </div>
                ))}
                <div style={{ fontSize: 11.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
                  Click a token to insert it where you're typing. Each image uses one line per file.
                </div>
              </>
            )}
            {tokenProblem && <div style={{ ...warningBoxStyle, marginTop: 0, fontSize: 12.5 }}>{tokenProblem}</div>}
          </div>

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
                VIBE TRANSFER
                {vibes.length > 0 && modelInfo.vibes && (
                  <span style={{ fontWeight: 500 }}>
                    {" "}
                    · {vibeRefs.length} of {MAX_VIBES} in use
                  </span>
                )}
              </span>
              <button
                onClick={() => void chooseVibeFiles()}
                disabled={generating}
                style={{ ...secondaryButtonStyle, padding: "6px 14px" }}
              >
                Add vibe file…
              </button>
            </div>

            {vibes.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
                Use .naiv4vibe or .naiv4vibebundle files exported from NovelAI, or a NovelAI PNG
                with vibes embedded. Only vibes already encoded for the selected model are used,
                so they stay free — up to {MAX_VIBES} at a time.
              </div>
            )}

            {vibes.length > 0 && !modelInfo.vibes && (
              <div style={{ ...warningBoxStyle, marginTop: 0 }}>
                V5 models don't support Vibe Transfer yet, so these vibes are ignored. Switch to a
                V4 or V4.5 model to use them.
              </div>
            )}

            {vibes.map((v) => {
              const options = v.info ? v.info.encodings.filter((e) => e.model === model) : [];
              const encoding = v.info && vibeEncodingFor(v.info, model, v.informationExtracted);
              const status = v.error
                ? v.error
                : !modelInfo.vibes
                  ? null
                  : encoding
                    ? null
                    : `Not encoded for ${modelInfo.label}, so it isn't used. Encoding it would cost Anlas.`;
              return (
                <div key={v.key} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={v.enabled}
                    onChange={(e) => updateVibe(v.key, { enabled: e.target.checked })}
                    disabled={generating || (!v.enabled && vibesOn >= MAX_VIBES)}
                    title={
                      !v.enabled && vibesOn >= MAX_VIBES
                        ? `Up to ${MAX_VIBES} vibes at once; more would cost Anlas`
                        : "Use this vibe"
                    }
                    style={{ accentColor: "var(--accent)" }}
                  />
                  {v.info?.thumbnail ? (
                    <img
                      src={v.info.thumbnail}
                      alt=""
                      style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, flexShrink: 0 }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 6,
                        flexShrink: 0,
                        background: "var(--bg-page)",
                        border: "1px solid var(--border)",
                      }}
                    />
                  )}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      opacity: v.enabled ? 1 : 0.6,
                    }}
                  >
                    <div
                      title={v.path}
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {v.info?.name ?? fileName(v.path)}
                    </div>
                    {status ? (
                      <div style={{ fontSize: 12, color: "rgb(200,140,40)", fontFamily: "system-ui, sans-serif" }}>
                        {status}
                      </div>
                    ) : (
                      v.info && (
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <label
                            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flex: "1 1 180px" }}
                          >
                            <span style={{ whiteSpace: "nowrap", minWidth: 86 }}>
                              Strength {v.strength.toFixed(2)}
                            </span>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.01}
                              value={v.strength}
                              onChange={(e) => updateVibe(v.key, { strength: Number(e.target.value) })}
                              disabled={generating}
                              style={{ flex: 1, minWidth: 80, accentColor: "var(--accent)" }}
                            />
                          </label>
                          {encoding && options.length > 1 ? (
                            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                              Info extracted
                              <select
                                value={options.indexOf(encoding)}
                                onChange={(e) =>
                                  updateVibe(v.key, {
                                    informationExtracted:
                                      options[Number(e.target.value)].informationExtracted,
                                  })
                                }
                                disabled={generating}
                                style={{ ...inputStyle, padding: "3px 6px", background: "var(--bg-page)" }}
                              >
                                {options.map((o, i) => (
                                  <option key={i} value={i}>
                                    {o.informationExtracted ?? "unknown"}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            encoding?.informationExtracted != null && (
                              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                                Info extracted {encoding.informationExtracted}
                              </span>
                            )
                          )}
                        </div>
                      )
                    )}
                  </div>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (!generating) setVibes((prev) => prev.filter((x) => x.key !== v.key));
                    }}
                    style={{ fontSize: 13, fontWeight: 600 }}
                  >
                    Remove
                  </a>
                </div>
              );
            })}
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
            Drop a NovelAI image to import its settings, or a vibe file to add it
          </div>
        </div>
      )}
    </div>
  );
}
