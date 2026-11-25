import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  CUSTOM_SIZE,
  SIZE_STEP,
  MAX_SIDE,
  sizeProblem,
  fitFreeSize,
  modelFamily,
  SAMPLERS,
  NOISE_SCHEDULES,
  DEFAULT_SAMPLER,
  DEFAULT_NOISE_SCHEDULE,
  varietyPlusSigma,
  supportsVarietyPlus,
  VARIETY_PLUS_VERIFIED,
  estimateCosts,
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
  type CostEstimate,
  type GenerateRequest,
  type PreciseReference,
  type ReferenceKind,
  PRECISE_REFERENCE_COST,
  MAX_PRECISE_REFERENCES,
  REFERENCE_KIND_LABELS,
  referenceKinds,
  maxReferenceStrength,
  takesPreferSameOutfit,
  type ImportPlan,
  type ImportedSettings,
  type VibeInfo,
  type VibeRef,
} from "../lib/novelai";
import ConfirmModal from "./ConfirmModal";
import HelpTip from "./HelpTip";
import AccountBars from "./AccountBars";
import CharacterSlots, { roughTokens, spreadPositions, tokenLimit, type SlotSummary } from "./CharacterSlots";
import CharacterCardDialog from "./CharacterCardDialog";
import { PARTS, adaptCardCharacter, linkFor, listCards, loadCardFolder, type CardFile, type CardLink } from "../lib/characterCards";
import AutomationCard, { DEFAULT_AUTOMATION, type AutomationSettings } from "./AutomationCard";
import BatchPreview, { type PreviewImage } from "./BatchPreview";
import PromptFileEditor from "./PromptFileEditor";
import DirectorDialog from "./DirectorDialog";
import CreepCard from "./CreepCard";
import SavedPromptsDialog from "./SavedPromptsDialog";
import ArtistLibraryCard from "./ArtistLibraryCard";
import WorkflowCard, { DEFAULT_PLAN, chunkImages, type WorkflowPlan } from "./WorkflowCard";
import { runDirector } from "../lib/director";
import { upscaleBatch } from "../lib/upscale";
import {
  DEFAULT_ARTISTS,
  artistsForImage,
  insertArtists,
  loadArtists,
  saveArtists,
  usableArtists,
  type ArtistLibrary,
  type ModelFamily,
  type PromptSnapshot,
  type SavedPrompt,
} from "../lib/savedPrompts";
import { DEFAULT_CREEP, listAt, numberAt, seedAt, type CreepSettings } from "../lib/creep";
import type { DirectorTool } from "../lib/director";
import { buildImage, findLoops, imageRng, seededRng, swapGender, type EngineFile, type EngineSettings, type Slot } from "../lib/promptEngine";
import { helpFor } from "../lib/syntaxHelp";
import { CONTROL_HELP } from "../lib/syntaxHelp";
import {
  DEFAULT_GENDER_PAIRS,
  loadAssociations,
  loadGenderPairs,
  saveGenderPairs,
  type Association,
  type CardChoice,
} from "../lib/library";
import {
  DEFAULT_ADVANCE,
  advancedState,
  cardForImage,
  linkOf,
  poolCards,
  poolKey,
  type PoolState,
  type SlotAdvance,
} from "../lib/characterPool";
import TagSuggestions from "./TagSuggestions";
import {
  openPromptFile,
  openWildcardsDir,
  wildcardsDir,
  listWildcardFiles,
  readPromptFile,
  savePosition,
  type PromptFile,
  type PromptFileMode,
} from "../lib/promptFile";
import { fileTokenName, fillTokens, folderTokenName, tokenFile, tokenFor, tokenPart, tokensIn } from "../lib/promptTokens";
import {
  generateStore,
  loadGenerateSettings,
  saveGenerateSettings,
  type SavedVibe,
  type VibeRotation,
} from "../lib/generateSettings";
import { invoke } from "@tauri-apps/api/core";
import { revealFilesInExplorer } from "../lib/nativeOps";
import type { RemixItem } from "../lib/remix";

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

// An image file's pixel size, read through the webview.
function imageSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`Couldn't read ${path}`));
    img.src = convertFileSrc(path);
  });
}

// A textarea that grows with its text, from `minRows` up to `maxHeight`
// pixels, then scrolls.
function GrowingTextarea({
  minRows,
  maxHeight,
  style,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows: number; maxHeight: number; "data-tags"?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, maxHeight)}px`;
  }, [props.value, minRows, maxHeight, width]);
  // Rewrapping at a new width changes the height too.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} rows={minRows} {...props} style={{ ...style, resize: "none", overflowY: "auto" }} />;
}

function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>
        {label}
        {help}
      </span>
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
  highlight = null,
  onChange,
}: {
  index: number;
  positions: CharacterPosition[];
  model: string;
  aspect: number;
  disabled: boolean;
  /** A character whose row is hovered, shown outlined. */
  highlight?: number | null;
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
          const lit = !mine && j === highlight;
          // With many characters, the others shrink so the board stays readable.
          const small = positions.length > 8;
          return (
            <span
              key={j}
              style={{
                position: "absolute",
                left: `${at.x * 100}%`,
                top: `${at.y * 100}%`,
                transform: "translate(-50%, -50%)",
                width: mine ? 16 : small ? 8 : 11,
                height: mine ? 16 : small ? 8 : 11,
                borderRadius: "50%",
                background: mine ? "var(--accent)" : "var(--muted)",
                color: mine ? "var(--accent-contrast)" : "var(--bg-card)",
                opacity: mine || lit ? 1 : 0.45,
                outline: lit ? "2px solid var(--accent)" : "none",
                fontSize: mine ? 10 : small ? 0 : 7,
                fontWeight: 700,
                lineHeight: mine ? "16px" : small ? "8px" : "11px",
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

/** A note when some references are set above what this model takes (V4.5 caps at 1). */
function r5Note(max: number, refs: PreciseReference[]): string {
  return refs.some((r) => r.strength > max) ? ` Strength above ${max} is sent as ${max} on this model.` : "";
}

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

/** Settings sent from another tab (Convert); `id` changes with every send. */
export type IncomingSettings = { id: number; settings: ImportedSettings };

/** Per-image prompts sent from the Remix tab; `id` changes with every send. */
export type RemixJob = { id: number; folder: string; items: RemixItem[] };

/** A width or height box: free typing, snapped to steps of 64 on blur. */
function SideInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      title={label}
      min={SIZE_STEP}
      max={MAX_SIDE}
      step={SIZE_STEP}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => {
        const n = Number(text);
        const snapped = Number.isFinite(n) && n > 0
          ? Math.min(MAX_SIDE, Math.max(SIZE_STEP, Math.round(n / SIZE_STEP) * SIZE_STEP))
          : value;
        onChange(snapped);
        setText(String(snapped));
      }}
      style={{
        width: 76,
        padding: "5px 8px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--bg-page)",
        color: "var(--text)",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 12.5,
      }}
    />
  );
}

export default function GenerateTab({
  active,
  incoming,
  remix,
}: {
  active: boolean;
  incoming: IncomingSettings | null;
  remix: RemixJob | null;
}) {
  const [phase, setPhase] = useState<AccountPhase>("unchecked");
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkedRef = useRef(false);

  const [model, setModel] = useState(MODELS[0].id);
  const [sizeIndex, setSizeIndex] = useState(0);
  const [customWidth, setCustomWidth] = useState(1024);
  const [customHeight, setCustomHeight] = useState(1024);
  const size = sizeIndex === CUSTOM_SIZE ? { width: customWidth, height: customHeight } : SIZES[sizeIndex];
  const sizeError = sizeProblem(size.width, size.height);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [characters, setCharacters] = useState<string[]>([]);
  // Each character's undesired content, kept the same length as `characters`.
  const [characterNegatives, setCharacterNegatives] = useState<string[]>([]);
  // "Custom" placement, and each character's position (kept the same length).
  const [useCoords, setUseCoords] = useState(false);
  const [characterPositions, setCharacterPositions] = useState<CharacterPosition[]>([]);
  // The character card each character was loaded from, if any. Read through
  // `cardLinks` below, which is always the same length as `characters`.
  const [characterCardLinks, setCharacterCardLinks] = useState<(CardLink | null)[]>([]);
  const cardLinks = characters.map((_, i) => characterCardLinks[i] ?? null);
  const [showCardDialog, setShowCardDialog] = useState(false);
  // Image to image: the picture to start from (null is text to image).
  const [sourceImage, setSourceImage] = useState<{ path: string; width: number; height: number } | null>(null);
  const [img2imgStrength, setImg2imgStrength] = useState(0.7);
  // Prompt boxes marked data-tags get Danbooru tag suggestions.
  const rootRef = useRef<HTMLDivElement>(null);
  // Two columns once the tab is wide enough.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 1060));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Narrowing a long list of prompt files.
  const [fileFilter, setFileFilter] = useState("");
  const [usedOnly, setUsedOnly] = useState(false);
  const [steps, setSteps] = useState(DEFAULT_STEPS);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [sampler, setSampler] = useState(DEFAULT_SAMPLER);
  const [noiseSchedule, setNoiseSchedule] = useState(DEFAULT_NOISE_SCHEDULE);
  const [varietyPlus, setVarietyPlus] = useState(false);
  // Stable ids for the character rows (kept the same length as `characters`),
  // so a row keeps its expanded state and editor when rows are reordered.
  const [characterKeys, setCharacterKeys] = useState<string[]>([]);
  const [expandedChars, setExpandedChars] = useState<Set<string>>(new Set());
  const [oneOpen, setOneOpen] = useState(false);
  const [hoveredChar, setHoveredChar] = useState<number | null>(null);
  // Switching to a model that takes fewer characters: asked before anything goes.
  const [modelSwitch, setModelSwitch] = useState<{ to: string; choosing: boolean; keep: Set<number> } | null>(null);
  // Characters a model switch removed, kept until the next generation so
  // switching back restores them.
  const [stashedChars, setStashedChars] = useState<
    { from: string; items: { index: number; text: string; negative: string; position: CharacterPosition; link: CardLink | null }[] } | null
  >(null);
  const [runEstimate, setRunEstimate] = useState<CostEstimate | null>(null);
  // Prompt automation: scramble, gender swap, random weights, associations.
  const [automation, setAutomation] = useState<AutomationSettings>(DEFAULT_AUTOMATION);
  const [associations, setAssociations] = useState<Association[]>([]);
  const [genderPairs, setGenderPairs] = useState<[string, string][]>(DEFAULT_GENDER_PAIRS);
  const [cardFolder, setCardFolder] = useState<string | null>(null);
  const [cards, setCards] = useState<CardFile[]>([]);
  // The form before "Apply to the form" rewrote it, for Undo.
  const [swapUndo, setSwapUndo] = useState<{ prompt: string; negative: string; characters: string[]; negatives: string[] } | null>(null);
  // Each character's auto-advance (null: fixed), kept the same length as `characters`.
  const [characterAdvance, setCharacterAdvance] = useState<(SlotAdvance | null)[]>([]);
  const advanceOf = (i: number) => characterAdvance[i] ?? null;
  const [poolStates, setPoolStates] = useState<Record<string, PoolState>>({});
  // Every .txt in a wildcards folder, usable without adding it.
  const [wildcardFolder, setWildcardFolder] = useState<{ enabled: boolean; dir: string | null }>({ enabled: false, dir: null });
  const [folderFiles, setFolderFiles] = useState<PromptFile[]>([]);
  const [folderModes, setFolderModes] = useState<Record<string, PromptFileMode>>({});
  const [folderScanError, setFolderScanError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [editingFile, setEditingFile] = useState<{ file: PromptFile; raw: string[] } | null>(null);
  // The batch's random picks come from this, so a preview matches the run.
  const [batchSeed, setBatchSeed] = useState(() => randomSeed());
  const [previewImages, setPreviewImages] = useState<PreviewImage[] | null>(null);
  const [director, setDirector] = useState<{ path: string; tool: DirectorTool } | null>(null);
  // Precise Reference: a style reference here, plus each loaded card's own.
  const [references, setReferences] = useState<PreciseReference[]>([]);
  const [useCardReferences, setUseCardReferences] = useState(true);
  const [creep, setCreep] = useState<CreepSettings>(DEFAULT_CREEP);
  const [artists, setArtists] = useState<ArtistLibrary>(DEFAULT_ARTISTS);
  const artistsLoadedRef = useRef(false);
  const [showSavedPrompts, setShowSavedPrompts] = useState(false);
  // A saved prompt waiting on the import confirmation.
  const [pendingSnapshot, setPendingSnapshot] = useState<PromptSnapshot | null>(null);
  const [vibeRotation, setVibeRotation] = useState<VibeRotation>({ mode: "fixed", k: 2, every: 1 });
  // A workflow plan, and the one being run (built up front, run a click at a time).
  const [workflow, setWorkflow] = useState<WorkflowPlan>(DEFAULT_PLAN);
  const [planRun, setPlanRun] = useState<{
    images: PreviewImage[];
    dirs: string[];
    done: number;
    plan: WorkflowPlan;
    usedFiles: Set<string>;
    advancing: { adv: SlotAdvance; key: string }[];
  } | null>(null);
  const [planConfirm, setPlanConfirm] = useState<{ start: boolean } | null>(null);
  const [vibeLibraryDir, setVibeLibraryDir] = useState<string | null>(null);
  const [vibeLibrary, setVibeLibrary] = useState<string[] | null>(null);
  // Encoding an image as a vibe (2 Anlas, once).
  const [encoding, setEncoding] = useState<{ path: string; ie: number; busy: boolean; error: string | null } | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // Which run a cost confirmation is for: the form's, or the next remix batch.
  const [confirmCost, setConfirmCost] = useState<"form" | "remix" | null>(null);
  // A remix runs MAX_BATCH images at a time; `next` is the first not yet made.
  const [remixQueue, setRemixQueue] = useState<{ folder: string; items: RemixItem[]; next: number } | null>(null);
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
        setCustomWidth(s.customWidth);
        setCustomHeight(s.customHeight);
        setPrompt(s.prompt);
        setNegativePrompt(s.negativePrompt);
        setSteps(s.steps);
        setScale(s.scale);
        setSampler(s.sampler);
        setNoiseSchedule(s.noiseSchedule);
        setVarietyPlus(s.varietyPlus);
        setAutomation(s.automation);
        setCharacterAdvance(s.characterAdvance);
        setWildcardFolder(s.wildcardFolder);
        setFolderModes(s.folderModes);
        setReferences(s.references);
        setUseCardReferences(s.useCardReferences);
        setCreep(s.creep);
        setVibeRotation(s.vibeRotation);
        setVibeLibraryDir(s.vibeLibraryDir);
        setWorkflow(s.workflow);
        setPoolStates((await generateStore.get<Record<string, PoolState>>("poolStates")) ?? {});
        setCount(s.count);
        setOutputDir(s.outputDir);
        setCharacters(s.characters);
        setCharacterNegatives(s.characterNegatives);
        setUseCoords(s.useCoords);
        setCharacterPositions(s.characterPositions);
        setCharacterCardLinks(s.characterCardLinks);
        setImg2imgStrength(s.img2imgStrength);
        if (s.sourceImage) {
          const path = s.sourceImage;
          // A picture that's gone since last time is just dropped.
          void imageSize(path).then((d) => setSourceImage({ path, ...d }), () => {});
        }
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
        customWidth,
        customHeight,
        prompt,
        negativePrompt,
        characters,
        characterNegatives,
        useCoords,
        characterPositions,
        characterCardLinks: cardLinks,
        sourceImage: sourceImage?.path ?? null,
        img2imgStrength,
        steps,
        scale,
        sampler,
        noiseSchedule,
        varietyPlus,
        automation,
        characterAdvance: characters.map((_, i) => advanceOf(i)),
        wildcardFolder,
        folderModes,
        references,
        useCardReferences,
        creep,
        vibeRotation,
        vibeLibraryDir,
        workflow,
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
    customWidth,
    customHeight,
    prompt,
    negativePrompt,
    characters,
    characterNegatives,
    useCoords,
    characterPositions,
    characterCardLinks,
    sourceImage,
    img2imgStrength,
    steps,
    scale,
    sampler,
    noiseSchedule,
    varietyPlus,
    automation,
    characterAdvance,
    wildcardFolder,
    folderModes,
    references,
    useCardReferences,
    creep,
    vibeRotation,
    vibeLibraryDir,
    workflow,
    count,
    outputDir,
    promptFiles,
    vibes,
  ]);

  // The card folder holds the cards (for auto-advance and associations), the
  // tag associations and the gender swap table. All local files.
  async function loadLibrary() {
    const folder = await loadCardFolder().catch(() => null);
    setCardFolder(folder);
    setGenderPairs(await loadGenderPairs(folder).catch(() => DEFAULT_GENDER_PAIRS));
    if (!folder) {
      setAssociations([]);
      setCards([]);
      return;
    }
    const [rules, list] = await Promise.all([
      loadAssociations(folder).catch((e) => {
        setError(`Couldn't read the tag associations: ${String(e)}`);
        return [] as Association[];
      }),
      listCards(folder).catch(() => [] as CardFile[]),
    ]);
    setAssociations(rules);
    setCards(list);
    setArtists(await loadArtists(folder).catch(() => DEFAULT_ARTISTS));
    artistsLoadedRef.current = true;
  }
  // The artist library is saved in the card folder as it changes.
  useEffect(() => {
    if (!artistsLoadedRef.current || !cardFolder) return;
    const timer = setTimeout(() => void saveArtists(cardFolder, artists).catch((e) => setError(String(e))), 500);
    return () => clearTimeout(timer);
  }, [artists, cardFolder]);
  const libraryLoadedRef = useRef(false);
  useEffect(() => {
    if (!active || libraryLoadedRef.current) return;
    libraryLoadedRef.current = true;
    void loadLibrary();
  }, [active]);

  // ---- The wildcards folder ----
  async function scanFolder(dir: string | null = wildcardFolder.dir) {
    const d = dir ?? (await wildcardsDir().catch(() => null));
    if (!d) return;
    try {
      const list = await listWildcardFiles(d);
      const files = await Promise.all(
        list.map(async (f) => ({ ...(await openPromptFile(f.path, folderTokenName(f.relative), folderModes[f.path] ?? "random")), fromFolder: true })),
      );
      setFolderFiles(files);
      setFolderScanError(null);
    } catch (e) {
      setFolderFiles([]);
      setFolderScanError(String(e));
    }
  }
  useEffect(() => {
    if (!settingsLoaded || !wildcardFolder.enabled) {
      setFolderFiles([]);
      return;
    }
    void scanFolder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, wildcardFolder.enabled, wildcardFolder.dir]);
  // Files edited elsewhere are picked up when the window comes back.
  useEffect(() => {
    if (!active || !wildcardFolder.enabled) return;
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 2000 || generating) return;
      last = Date.now();
      void scanFolder();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, wildcardFolder.enabled, wildcardFolder.dir, generating, folderModes]);

  async function chooseWildcardFolder() {
    const dir = await open({ directory: true, multiple: false, defaultPath: await wildcardsDir().catch(() => undefined) });
    if (typeof dir === "string") setWildcardFolder({ enabled: true, dir });
  }

  // Keep a row id per character; new characters open expanded.
  useEffect(() => {
    if (characterKeys.length === characters.length) return;
    if (characterKeys.length > characters.length) {
      setCharacterKeys((k) => k.slice(0, characters.length));
      return;
    }
    const fresh = Array.from({ length: characters.length - characterKeys.length }, () => crypto.randomUUID());
    setCharacterKeys((k) => [...k, ...fresh]);
    // Opening every new row would bury a long list; open them while it's short.
    if (characters.length <= 4 || fresh.length === 1) {
      setExpandedChars((prev) => (oneOpen && fresh.length === 1 ? new Set(fresh) : new Set([...prev, ...fresh])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters.length, characterKeys.length]);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [dragging, setDragging] = useState(false);

  const modelInfo = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const maxChars = modelInfo.maxCharacters;
  // Variety+ is only sent where the model takes it (not V5).
  const varietyOn = varietyPlus && supportsVarietyPlus(model);
  const effectiveSteps = modelInfo.fixedSteps ?? steps;
  const vibesOn = vibes.filter((v) => v.enabled).length;
  const rotating = vibeRotation.mode !== "fixed";
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
  // Files added by hand win over a folder file of the same name.
  const handNames = new Set(promptFiles.map((f) => f.name));
  const folderNameCounts = new Map<string, number>();
  folderFiles.forEach((f) => folderNameCounts.set(f.name, (folderNameCounts.get(f.name) ?? 0) + 1));
  const duplicateNames = [...folderNameCounts].filter(([n, c]) => c > 1 || handNames.has(n)).map(([n]) => n);
  const allFiles: PromptFile[] = [
    ...promptFiles,
    ...folderFiles.filter((f, i) => !handNames.has(f.name) && folderFiles.findIndex((g) => g.name === f.name) === i),
  ];
  const engineFiles = new Map<string, EngineFile>(
    allFiles
      .filter((f) => f.lines.length > 0)
      .map((f) => [f.name, { name: f.name, lines: f.lines, parts: f.parts, weights: f.weights, mode: f.mode, position: f.position }]),
  );
  const loops = findLoops([...engineFiles.values()]);
  // Prompt file tokens used anywhere in the form (and inside the files they
  // use), and any that can't be filled.
  const formTokens = new Set([prompt, negativePrompt, ...characters, ...characterNegatives].flatMap(tokensIn));
  const usedTokens = new Set(formTokens);
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of [...usedTokens]) {
      const f = engineFiles.get(tokenFile(key));
      if (!f) continue;
      for (const t of [...f.lines, ...f.parts.flatMap((p) => Object.values(p))].flatMap(tokensIn)) {
        if (!usedTokens.has(t)) {
          usedTokens.add(t);
          changed = true;
        }
      }
    }
  }
  const usedNames = new Set([...usedTokens].map(tokenFile));
  const usedFiles = allFiles.filter((f) => usedNames.has(f.name));
  const unknownTokens = [...formTokens].filter(
    (key) => !allFiles.some((f) => f.name === tokenFile(key)) && !(key === "artists" && artists.enabled),
  );
  const missingParts = [...formTokens].filter((key) => {
    const part = tokenPart(key);
    const file = allFiles.find((f) => f.name === tokenFile(key));
    return part !== null && file !== undefined && file.lines.length > 0 && !file.partNames.includes(part);
  });
  const unreadable = usedFiles.filter((f) => f.lines.length === 0);
  const tokenProblem =
    unknownTokens.length > 0
      ? `No prompt file is named ${unknownTokens.map((k) => tokenFor(tokenFile(k))).join(", ")}. Add the file or fix the token.`
      : missingParts.length > 0
        ? missingParts
            .map((k) => `${tokenFor(k)}: ${tokenFile(k)} has no "${tokenPart(k)}:" lines.`)
            .join(" ")
        : unreadable.length > 0
          ? `${unreadable.map((f) => tokenFor(f.name)).join(", ")} couldn't be read, so it can't be used.`
          : null;
  // A file's values for one entry: its main line and each labelled part. A
  // part the entry has no line for is `ABSENT`, which leaves its character
  // out; a part line with nothing after the label is just empty.
  const ABSENT = "\u0000absent";
  const entryValues = (f: PromptFile, index: number): [string, string][] => [
    [f.name, f.lines[index]],
    ...f.partNames.map((p): [string, string] => [`${f.name}:${p}`, f.parts[index][p] ?? ABSENT]),
  ];
  // Absent parts read as empty anywhere they're used.
  const present = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === ABSENT ? "" : v]));
  // What each token becomes for the next image: the actual next line in
  // sequential mode, a placeholder in random mode.
  const nextValues = Object.fromEntries(
    allFiles
      .filter((f) => f.lines.length > 0)
      .flatMap((f) =>
        f.mode === "sequential"
          ? entryValues(f, f.position % f.lines.length)
          : [[f.name, `‹random ${f.name}›`], ...f.partNames.map((p) => [`${f.name}:${p}`, `‹random ${f.name}:${p}›`])],
      ),
  );
  // A character using a paired file's part sits out any image whose entry
  // has no line for that part (its undesired content and position go too).
  const missingPart = (text: string, values: Record<string, string>) =>
    tokensIn(text).some((k) => tokenPart(k) !== null && values[k] === ABSENT);
  const preview = (text: string, character = false) =>
    tokensIn(text).length === 0 ? null : character && missingPart(text, nextValues) ? (
      <TokenPreview text="(left out of the next image: its entry has no line for this character)" />
    ) : (
      <TokenPreview text={fillTokens(text, present(nextValues))} />
    );
  // Under a character loaded from a card: which card, and what the next image
  // leaves out because of its view tags.
  const cardNote = (i: number, text: string) => {
    const link = cardLinks[i];
    if (!link) return null;
    const values = present(nextValues);
    const next = adaptCardCharacter(fillTokens(text, values), link, fillTokens(prompt, values));
    const parts = next.hidden.map((p) => PARTS.find((q) => q.key === p)!.label.toLowerCase());
    return (
      <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
        From card <strong style={{ color: "var(--text)" }}>{link.name}</strong>
        {parts.length > 0
          ? ` · the next image leaves out its ${parts.join(", ")} tags (${next.views.join(", ")})`
          : " · leaves out what an image's view tags hide (facing away, closed eyes, upper body, lower body, POV…)"}
        {" · "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (!generating) unlinkCard(i);
          }}
          title="Stop adapting this character to view tags; its prompt stays as it is"
          style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}
        >
          Unlink
        </a>
      </div>
    );
  };
  const canGenerate =
    phase === "loggedIn" &&
    !generating &&
    prompt.trim() !== "" &&
    tokenProblem === null &&
    sizeError === null &&
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

  // Image to image: picks the starting picture and sets the size to the
  // nearest free size of the same shape (NovelAI resizes it to that).
  async function chooseSourceImage() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof file !== "string") return;
    try {
      const d = await imageSize(file);
      setSourceImage({ path: file, ...d });
      matchSourceSize(d);
    } catch (err) {
      setError(String(err));
    }
  }

  function matchSourceSize(d: { width: number; height: number }) {
    const fit = fitFreeSize(d.width, d.height);
    if (!fit) return;
    const preset = SIZES.findIndex((s) => s.width === fit.width && s.height === fit.height);
    if (preset >= 0) setSizeIndex(preset);
    else {
      setSizeIndex(CUSTOM_SIZE);
      setCustomWidth(fit.width);
      setCustomHeight(fit.height);
    }
  }

  const snapshot = (): PromptSnapshot => ({
    model,
    sizeIndex,
    customWidth,
    customHeight,
    prompt,
    negativePrompt,
    characters,
    characterNegatives,
    useCoords,
    characterPositions,
    characterCardLinks: cardLinks,
    steps,
    scale,
    sampler,
    noiseSchedule,
    varietyPlus,
    vibes: vibes.map(({ path, index, strength, informationExtracted, enabled }) => ({ path, index, strength, informationExtracted, enabled })),
    references,
    seed: lastResult?.seed ?? null,
  });

  // A saved prompt goes through the same confirmation as an import.
  function startLoadSaved(saved: SavedPrompt) {
    const s = saved.snapshot;
    const plan = buildImportPlan(
      {
        prompt: s.prompt,
        negativePrompt: s.negativePrompt,
        characters: s.characters,
        characterNegatives: s.characterNegatives,
        characterPositions: s.useCoords ? s.characterPositions : null,
        width: null,
        height: null,
        steps: s.steps,
        scale: s.scale,
        seed: s.seed,
        model: s.model,
        source: null,
        sampler: s.sampler,
        noiseSchedule: s.noiseSchedule,
        skipCfgAboveSigma: s.varietyPlus ? 1 : null,
      },
      model,
    );
    plan.applied.unshift({ label: "Saved prompt", value: saved.name });
    plan.skipped = plan.skipped.filter((x) => !x.startsWith("Seed"));
    if (s.seed !== null) plan.applied.push({ label: "Seed", value: `${s.seed} (shown in Preview; images still use random seeds unless creep fixes one)` });
    setShowSavedPrompts(false);
    setPendingSnapshot(s);
    setImportPlan(plan);
  }

  function applySnapshot(s: PromptSnapshot) {
    setModel(s.model);
    setSizeIndex(s.sizeIndex);
    setCustomWidth(s.customWidth);
    setCustomHeight(s.customHeight);
    setPrompt(s.prompt);
    setNegativePrompt(s.negativePrompt);
    setCharacters(s.characters);
    setCharacterNegatives(s.characterNegatives);
    setUseCoords(s.useCoords);
    setCharacterPositions(s.characterPositions);
    setCharacterCardLinks(s.characterCardLinks);
    setCharacterAdvance([]);
    setSteps(s.steps);
    setScale(s.scale);
    setSampler(s.sampler);
    setNoiseSchedule(s.noiseSchedule);
    setVarietyPlus(s.varietyPlus);
    setReferences(s.references ?? []);
    if (s.vibes.length > 0) void loadVibeEntries(s.vibes).then(setVibes);
    else setVibes([]);
    setPendingSnapshot(null);
    setImportPlan(null);
  }

  async function snapshotFromImage(): Promise<PromptSnapshot | null> {
    const file = await open({ directory: false, multiple: false, filters: [{ name: "PNG image", extensions: ["png"] }] });
    if (typeof file !== "string") return null;
    const meta = await readImageMetadata(file);
    const v = buildImportPlan(meta, model).values;
    const custom = v.customSize;
    return {
      ...snapshot(),
      model: v.model ?? model,
      sizeIndex: v.sizeIndex ?? sizeIndex,
      customWidth: custom?.width ?? customWidth,
      customHeight: custom?.height ?? customHeight,
      prompt: v.prompt,
      negativePrompt: v.negativePrompt,
      characters: v.characters,
      characterNegatives: v.characterNegatives,
      useCoords: v.characterPositions !== null,
      characterPositions: v.characterPositions ?? v.characters.map(() => CENTER),
      characterCardLinks: v.characters.map(() => null),
      steps: v.steps ?? steps,
      scale: v.scale ?? scale,
      sampler: v.sampler ?? sampler,
      noiseSchedule: v.noiseSchedule ?? noiseSchedule,
      varietyPlus: v.varietyPlus ?? false,
      vibes: [],
      references: [],
      seed: meta.seed !== null && meta.seed <= 0xffff_ffff ? meta.seed : null,
    };
  }

  async function startImport(path: string) {
    setError(null);
    try {
      setImportPlan(buildImportPlan(await readImageMetadata(path), model));
    } catch (err) {
      setError(String(err));
    }
  }

  // A prompt sent from the Convert tab goes through the same confirmation
  // as importing an image.
  useEffect(() => {
    if (!incoming) return;
    if (generating) {
      setError("Wait for the current generation to finish, then send the prompt again.");
      return;
    }
    setError(null);
    setImportPlan(buildImportPlan(incoming.settings, model));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  function applyImport(plan: ImportPlan) {
    const v = plan.values;
    if (v.model) setModel(v.model);
    if (v.sizeIndex !== undefined) setSizeIndex(v.sizeIndex);
    if (v.customSize) {
      setCustomWidth(v.customSize.width);
      setCustomHeight(v.customSize.height);
    }
    if (v.steps !== undefined) setSteps(v.steps);
    if (v.scale !== undefined) setScale(v.scale);
    if (v.sampler !== undefined) setSampler(v.sampler);
    if (v.noiseSchedule !== undefined) setNoiseSchedule(v.noiseSchedule);
    if (v.varietyPlus !== undefined) setVarietyPlus(v.varietyPlus);
    setPrompt(v.prompt);
    setNegativePrompt(v.negativePrompt);
    setCharacters(v.characters);
    setCharacterNegatives(v.characterNegatives);
    setCharacterCardLinks([]);
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

  // The vibe library: the chosen folder, else "vibes" in the card folder.
  const vibeDir = () => vibeLibraryDir ?? (cardFolder ? `${cardFolder}\\vibes` : null);

  async function openVibeLibrary() {
    const dir = vibeDir();
    if (!dir) {
      await chooseVibeLibrary();
      return;
    }
    try {
      setVibeLibrary(await invoke<string[]>("list_vibe_files", { dir }));
    } catch {
      setVibeLibrary([]);
    }
  }

  async function chooseVibeLibrary() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setVibeLibraryDir(dir);
    try {
      setVibeLibrary(await invoke<string[]>("list_vibe_files", { dir }));
    } catch {
      setVibeLibrary([]);
    }
  }

  async function startEncode() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof file === "string") setEncoding({ path: file, ie: 1, busy: false, error: null });
  }

  async function runEncode() {
    if (!encoding) return;
    const dir = vibeDir() ?? encoding.path.replace(/[\\/][^\\/]*$/, "");
    setEncoding({ ...encoding, busy: true, error: null });
    try {
      const out = await invoke<{ path: string; reused: boolean; anlasWarning: string | null }>("nai_encode_vibe", {
        runId: crypto.randomUUID(),
        path: encoding.path,
        model,
        informationExtracted: encoding.ie,
        outDir: dir,
      });
      setEncoding(null);
      await addVibeFiles([out.path]);
      setBatchNotice(
        (out.reused ? `This image was already encoded for ${modelInfo.label} at ${encoding.ie}, so the saved file was reused (no Anlas). ` : `Encoded and saved ${fileName(out.path)}. `) +
          (out.anlasWarning ?? ""),
      );
      getAccountStatus().then((s) => s && setStatus(s)).catch(() => {});
      if (vibeLibrary) void openVibeLibrary();
    } catch (err) {
      setEncoding((e) => (e ? { ...e, busy: false, error: String(err) } : e));
    }
  }

  function updateVibe(key: string, change: Partial<SavedVibe>) {
    setVibes((prev) => prev.map((v) => (v.key === key ? { ...v, ...change } : v)));
  }

  async function chooseOutputDir() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setOutputDir(dir);
  }

  // The references an image sends: the form's, then each present carded
  // character's own, up to the limit. None on models without it; types the
  // model doesn't take (outfit on V4.5) are left out, and strength is capped
  // at the model's highest (1 on V4.5).
  const referencesFor = (links: (CardLink | null)[]): PreciseReference[] => {
    if (!modelInfo.preciseReference) return [];
    const kinds = referenceKinds(model);
    const max = maxReferenceStrength(model);
    const fit = (r: PreciseReference): PreciseReference => ({
      ...r,
      strength: Math.min(r.strength, max),
      preferSameOutfit: takesPreferSameOutfit(model, r.kind) && r.preferSameOutfit === true,
    });
    const refs: PreciseReference[] = references.filter((r) => kinds.includes(r.kind)).map(fit);
    if (useCardReferences) {
      for (const l of links) {
        const r = l?.reference;
        if (r) refs.push(fit({ path: r.path, kind: r.type, strength: r.strength, fidelity: r.fidelity, preferSameOutfit: r.preferSameOutfit }));
      }
    }
    return refs.slice(0, MAX_PRECISE_REFERENCES);
  };
  const formReferences = referencesFor(cardLinks);

  // The cost of one image as the form stands. Prompts don't change the
  // price, so a request without tokens filled is enough.
  const sampleRequest = (): GenerateRequest => ({
    model,
    prompt,
    negativePrompt,
    characters,
    characterNegatives,
    characterPositions: useCoords ? characterPositions : null,
    width: size.width,
    height: size.height,
    steps: effectiveSteps,
    scale,
    seed: 0,
    fileStem: "estimate",
    vibes: rotating ? vibeRefs.slice(0, Math.min(vibeRotation.k, MAX_VIBES)) : vibeRefs,
    sampler,
    noiseSchedule,
    skipCfgAboveSigma: varietyOn ? varietyPlusSigma(model, size.width, size.height) : null,
    preciseReferences: formReferences,
  });
  const estimateKey = JSON.stringify([model, size, effectiveSteps, vibeRefs.length, vibeRotation.mode, vibeRotation.k, formReferences.length, status?.isOpus, status?.usage?.isNegative]);
  useEffect(() => {
    if (phase !== "loggedIn") return;
    let stale = false;
    estimateCosts([sampleRequest()], status)
      .then(([e]) => !stale && setRunEstimate(e ?? null))
      .catch(() => !stale && setRunEstimate(null));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey, phase]);
  // Anything not free is confirmed first; a known price (Precise Reference)
  // keeps the Anlas guard on, expecting that much and no more.
  const needsConfirm = costsAnlas || (runEstimate !== null && !runEstimate.free);
  const guardAnlas = !costsAnlas && runEstimate?.anlas !== null;

  function requestGenerate() {
    if (!canGenerate || !status) return;
    if (needsConfirm) setConfirmCost("form");
    else void runGenerate();
  }

  const remixBatch = remixQueue ? remixQueue.items.slice(remixQueue.next, remixQueue.next + MAX_BATCH) : [];
  // Images without a size of their own use this tab's, so it must be valid then.
  const canRemix =
    phase === "loggedIn" &&
    !generating &&
    outputDir !== null &&
    remixBatch.length > 0 &&
    (sizeError === null || remixBatch.every((item) => item.size !== null));

  function requestRemix() {
    if (!canRemix || !status) return;
    if (needsConfirm) setConfirmCost("remix");
    else void runGenerate(true);
  }

  // A remix sent from the Remix tab waits here until the user starts it.
  useEffect(() => {
    if (!remix) return;
    if (generating) {
      setError("Wait for the current generation to finish, then send the remix again.");
      return;
    }
    setError(null);
    setRemixQueue({ folder: remix.folder, items: remix.items, next: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remix]);

  const engineSettings = (): EngineSettings => ({
    scramble: automation.scramble,
    genderSwap: { ...automation.genderSwap, pairs: genderPairs },
    weightStep: automation.weightStep,
    associations: automation.useAssociations ? associations : [],
  });

  /**
   * Every image of a run, decided up front from `batchSeed`: prompt files,
   * slot syntax, gender swap, associations, auto-advanced characters, view
   * tags, random weights and scramble. The preview shows exactly this.
   */
  const family = modelFamily(model) as ModelFamily;
  type BuildOptions = { total: number; setSize: number; perSet: WorkflowPlan["perSet"] };
  function buildBatch(fromRemix: boolean, seedBase = batchSeed, opts?: BuildOptions) {
    const setOf = (i: number) => (opts ? Math.floor(i / opts.setSize) : i);
    const setRng = (i: number, salt: number) => seededRng((seedBase + Math.imul(setOf(i) + 1, 0x27d4eb2f) + salt) >>> 0);
    const sendSettings = (w: number, h: number) => ({
      sampler,
      noiseSchedule,
      skipCfgAboveSigma: varietyOn ? varietyPlusSigma(model, w, h) : null,
    });
    const settings = engineSettings();
    const rows = fromRemix
      ? remixBatch.map((item) => ({
          prompt: item.prompt,
          negative: item.negativePrompt,
          // The Remix tab keeps up to 22; this model may take fewer.
          slots: item.characters.slice(0, maxChars).map(
            (c, j): Slot => ({
              text: c,
              negative: item.characterNegatives[j] ?? "",
              position: item.characterPositions?.[j] ?? CENTER,
              link: null,
              present: true,
            }),
          ),
          placed: item.characterPositions !== null,
          item,
        }))
      : Array.from({ length: opts?.total ?? count }, () => ({
          prompt,
          negative: negativePrompt,
          slots: characters.map(
            (c, j): Slot => ({
              text: c,
              negative: characterNegatives[j] ?? "",
              position: characterPositions[j] ?? CENTER,
              link: cardLinks[j],
              present: true,
            }),
          ),
          placed: useCoords,
          item: null,
        }));
    const usedFiles = new Set<string>();
    // "Next card with label" associations count through the batch.
    const assocNext = new Map<string, number>();
    // A step creep set to "stop" ends the batch at the first image past its end.
    let stopAt = rows.length;
    const creepRng = (i: number) => seededRng((seedBase ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0);
    const creepFor = (i: number, w: number, h: number) => {
      if (!creep.enabled) return null;
      const r = creepRng(i);
      const st = modelInfo.fixedSteps !== undefined
        ? { value: effectiveSteps, stop: false, capped: false }
        : numberAt(creep.steps, i, r, effectiveSteps, { min: 1, max: MAX_STEPS, decimals: 0 });
      const gd = numberAt(creep.guidance, i, r, scale, { min: 0, max: MAX_SCALE, decimals: 1 });
      const sg = varietyOn
        ? numberAt(creep.sigma, i, r, varietyPlusSigma(model, w, h), { min: 0, max: 1000, decimals: 2 })
        : null;
      if (st.stop || gd.stop || sg?.stop) stopAt = Math.min(stopAt, i);
      return {
        steps: st.value,
        scale: gd.value,
        sigma: sg ? sg.value : null,
        sampler: listAt(creep.sampler, i, r) ?? sampler,
        noiseSchedule: listAt(creep.schedule, i, r) ?? noiseSchedule,
      };
    };
    const images: PreviewImage[] = rows.map((row, i) => {
      const rng = imageRng(seedBase, i);
      const batchRandom = Math.floor(seededRng((seedBase ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0)() * 0x1_0000_0000);
      const seed = row.item?.seed ?? (creep.enabled ? seedAt(creep.seed, i, batchRandom) : batchRandom);
      const slots = row.slots.map((s, j): Slot => {
        const own = fromRemix ? null : advanceOf(j);
        if (!own || own.mode === "fixed") return s;
        // In a plan, a character can move on once per set.
        const adv = opts?.perSet.characters ? { ...own, every: opts.setSize } : own;
        const pool = poolCards(cards, adv.pool);
        const key = poolKey(adv.pool, adv.mode);
        const st = poolStates[key] ?? { position: 0, seed: 1 };
        const file = cardForImage(adv, pool, st, i, (g) => seededRng((seedBase + Math.imul(g + 1, 104729) + j * 31) >>> 0));
        if (!file) return s;
        const link = linkOf(file);
        return { ...s, text: link.tags.map((t) => t.text).join(", "), negative: file.card.negative, link };
      });
      const pickCard = (choice: CardChoice): CardLink | null => {
        if (choice.mode === "named") {
          const f = cards.find((c) => c.card.name.toLowerCase() === choice.name.toLowerCase());
          return f ? linkOf(f) : null;
        }
        const pool = poolCards(cards, { include: choice.label, exclude: "", matchAll: false, gender: null });
        if (pool.length === 0) return null;
        if (choice.mode === "random") return linkOf(pool[Math.floor(rng() * pool.length)]);
        const key = `assoc-next:${choice.label.toLowerCase()}`;
        const k = assocNext.get(key) ?? 0;
        assocNext.set(key, k + 1);
        return linkOf(pool[((poolStates[key]?.position ?? 0) + k) % pool.length]);
      };
      const artistLine = fromRemix
        ? ""
        : opts?.perSet.artists
          ? artistsForImage({ ...artists, every: 1 }, family, setOf(i), setRng(i, 11), poolStates["artists-next"]?.position ?? 0)
          : artistsForImage(artists, family, i, rng, poolStates["artists-next"]?.position ?? 0);
      const res = buildImage(
        { prompt: fromRemix ? row.prompt : insertArtists(row.prompt, artistLine), negative: row.negative, slots },
        {
          index: i,
          rng,
          files: engineFiles,
          maxSlots: maxChars,
          settings,
          pickCard,
          ...(opts?.perSet.files ? { fileIndex: setOf(i), fileRng: setRng(i, 23) } : {}),
        },
      );
      res.usedFiles.forEach((f) => usedFiles.add(f));
      const w = row.item?.size?.width ?? size.width;
      const h = row.item?.size?.height ?? size.height;
      const cv = creepFor(i, w, h);
      const request: GenerateRequest = {
        ...sendSettings(w, h),
        ...(cv ? { sampler: cv.sampler, noiseSchedule: cv.noiseSchedule, skipCfgAboveSigma: cv.sigma } : {}),
        model,
        prompt: res.prompt,
        negativePrompt: res.negative,
        characters: res.slots.map((s) => (s.present ? s.text : "")),
        characterNegatives: res.slots.map((s) => (s.present ? s.negative : "")),
        characterPositions: row.placed ? res.slots.map((s) => s.position) : null,
        width: w,
        height: h,
        steps: cv?.steps ?? effectiveSteps,
        scale: cv?.scale ?? scale,
        seed,
        fileStem: "",
        vibes: vibeRefs,
        sourceImage: !fromRemix && sourceImage ? { path: sourceImage.path, strength: img2imgStrength } : null,
      };
      // Rotating vibes: K of the ticked ones per image, random or in turn.
      if (rotating && vibeRefs.length > 0) {
        const k = Math.min(vibeRotation.k, MAX_VIBES, vibeRefs.length);
        if (vibeRotation.mode === "random") {
          const pool = [...vibeRefs];
          const vr = opts?.perSet.vibes ? setRng(i, 37) : rng;
          request.vibes = Array.from({ length: k }, () => pool.splice(Math.floor(vr() * pool.length), 1)[0]);
        } else {
          const group = opts?.perSet.vibes ? setOf(i) : Math.floor(i / Math.max(1, vibeRotation.every));
          const start = ((poolStates["vibes-next"]?.position ?? 0) + group * k) % vibeRefs.length;
          request.vibes = Array.from({ length: k }, (_, n) => vibeRefs[(start + n) % vibeRefs.length]);
        }
      } else request.vibes = vibeRefs.slice(0, MAX_VIBES);
      const refs = referencesFor(res.slots.map((s) => (s.present ? s.link : null)));
      if (refs.length > 0) {
        // NovelAI won't take both; references win, and the card says so.
        request.preciseReferences = refs;
        request.vibes = [];
      }
      return { request, log: res.log, warnings: res.warnings, cardNames: res.slots.map((s) => s.link?.name ?? null) };
    });
    return { images: images.slice(0, stopAt), usedFiles, assocNext, stopped: stopAt < rows.length };
  }

  function showPreview(seedBase = batchSeed) {
    try {
      setPreviewImages(buildBatch(remixQueue !== null && remixBatch.length > 0, seedBase).images);
    } catch (err) {
      setError(String(err));
    }
  }

  /**
   * After images were made: sequential files, character pools, artists,
   * vibes and "next card" associations carry on from where they stopped.
   * In a plan, things that moved once per set move by the sets made.
   */
  function advanceAfter(
    usedFiles: Set<string>,
    made: number,
    planned: number,
    assocNext: Map<string, number>,
    advancing: { adv: SlotAdvance; key: string }[],
    plan: { setSize: number; perSet: WorkflowPlan["perSet"] } | null,
  ) {
    const sets = plan ? Math.ceil(made / plan.setSize) : made;
    const fileSteps = plan?.perSet.files ? sets : made;
    const advanced = new Map(
      allFiles
        .filter((f) => f.mode === "sequential" && usedFiles.has(f.name) && f.lines.length > 0)
        .map((f) => [f.path, (f.position + fileSteps) % f.lines.length]),
    );
    advanced.forEach((next, path) => void savePosition(path, next));
    const move = (prev: PromptFile[]) => prev.map((f) => (advanced.has(f.path) ? { ...f, position: advanced.get(f.path)! } : f));
    setPromptFiles(move);
    setFolderFiles(move);
    const states = { ...poolStates };
    for (const { adv, key } of advancing) {
      const a = plan?.perSet.characters ? { ...adv, every: plan.setSize } : adv;
      states[key] = advancedState(a, states[key] ?? { position: 0, seed: randomSeed() }, made);
    }
    if (vibeRotation.mode === "next" && vibeRefs.length > 0) {
      const st = states["vibes-next"] ?? { position: 0, seed: 1 };
      const k = Math.min(vibeRotation.k, MAX_VIBES, vibeRefs.length);
      const groups = plan?.perSet.vibes ? sets : Math.ceil(made / Math.max(1, vibeRotation.every));
      states["vibes-next"] = { ...st, position: st.position + k * groups };
    }
    if (artists.enabled && artists.mode === "next" && usableArtists(artists, family).length > 0) {
      const st = states["artists-next"] ?? { position: 0, seed: 1 };
      const groups = plan?.perSet.artists ? sets : Math.ceil(made / Math.max(1, artists.every));
      states["artists-next"] = { ...st, position: st.position + groups };
    }
    assocNext.forEach((k, key) => {
      // Only the images actually made moved the association on.
      const share = Math.round((k * made) / Math.max(1, planned));
      states[key] = { position: (states[key]?.position ?? 0) + share, seed: 1 };
    });
    setPoolStates(states);
    void generateStore.set("poolStates", states).catch(() => {});
  }

  // ---- Workflow plans ----

  const advancingNow = () =>
    characters.flatMap((_, j) => {
      const adv = advanceOf(j);
      return adv && adv.mode !== "fixed" ? [{ adv, key: poolKey(adv.pool, adv.mode) }] : [];
    });

  /** Builds the whole plan up front and asks before the first part runs. */
  function startPlan() {
    if (!outputDir || !canGenerate) return;
    const p = workflow;
    let built: ReturnType<typeof buildBatch>;
    try {
      built = buildBatch(false, batchSeed, { total: p.loops * p.sets, setSize: p.loops, perSet: p.perSet });
    } catch (err) {
      setError(String(err));
      return;
    }
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const clean = (t: string) => t.replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 60) || "untitled";
    const base = p.subfolders === "none" ? outputDir : `${outputDir}\\${clean(p.name || "Plan")} ${stamp}`;
    const dirs = built.images.map((img, i) =>
      p.subfolders === "set"
        ? `${base}\\set ${pad(Math.floor(i / p.loops) + 1)}`
        : p.subfolders === "character"
          ? `${base}\\${clean(img.cardNames.find((n) => n) ?? "no card")}`
          : base,
    );
    setPlanRun({ images: built.images, dirs, done: 0, plan: p, usedFiles: built.usedFiles, advancing: advancingNow() });
    setPlanConfirm({ start: true });
  }

  /** Runs the next part of the plan: at most 25 requests (10 upscales). */
  async function runPlanChunk() {
    setPlanConfirm(null);
    if (!planRun) return;
    const { plan, images, dirs } = planRun;
    const start = planRun.done;
    const end = Math.min(images.length, start + chunkImages(plan));
    const batchStart = new Date();
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setGenerating(true);
    setError(null);
    setBatchNotice(null);
    setBatchImages([]);
    setProgress({ done: 0, total: end - start });
    let made = 0;
    let stop: string | null = null;
    const show = (path: string, seed: number) => {
      const shown = { path, seed, src: convertFileSrc(path) };
      setLastResult(shown);
      setBatchImages((prev) => [...prev, shown]);
    };
    try {
      // Generate, one folder at a time.
      const made_: { path: string; seed: number; dir: string }[] = [];
      for (let a = start; a < end && !stop; ) {
        let b = a;
        while (b < end && dirs[b] === dirs[a]) b++;
        const requests = images.slice(a, b).map((img, k) => ({ ...img.request, fileStem: fileStemFor(img.request.seed, a + k, batchStart) }));
        const summary = await generateBatch(runId, requests, dirs[a], guardAnlas, (p) => {
          if (p.account) setStatus(p.account);
          if (p.image) {
            setProgress((pr) => (pr ? { ...pr, done: Math.min(pr.total, made_.length + 1) } : pr));
            show(p.image.path, p.image.seed);
          }
        });
        summary.images.forEach((im) => made_.push({ ...im, dir: dirs[a] }));
        if (summary.stoppedReason) stop = summary.stoppedReason;
        else if (summary.cancelled) stop = "Cancelled.";
        a = b;
      }
      made = made_.length;
      // Then each image's steps, each on the previous step's result.
      for (const im of made_) {
        let path = im.path;
        for (const step of plan.steps) {
          if (stop || runIdRef.current !== runId) break;
          if (step.kind === "emotion" || step.kind === "colorize") {
            const out = await runDirector(
              crypto.randomUUID(),
              { path, tool: step.kind, emotion: step.kind === "emotion" ? step.emotion : "", prompt: step.prompt, defry: step.defry, area: null },
              im.dir,
              !!status?.isOpus,
            );
            if (out.anlasWarning) stop = out.anlasWarning;
            path = out.path;
          } else if (step.kind === "upscale") {
            const up = await upscaleBatch(crypto.randomUUID(), [path], im.dir);
            if (up.stoppedReason) stop = up.stoppedReason;
            if (up.images[0]) path = up.images[0].path;
          } else {
            await invoke("strip_metadata_files", { paths: [path] });
          }
          show(path, im.seed);
        }
      }
    } catch (err) {
      stop = String(err);
    } finally {
      if (runIdRef.current === runId) {
        runIdRef.current = null;
        setGenerating(false);
        setProgress(null);
      }
    }
    const done = start + made;
    const finished = done >= images.length || stop !== null;
    if (made > 0) {
      advanceAfter(planRun.usedFiles, made, images.length, new Map(), planRun.advancing, { setSize: plan.loops, perSet: plan.perSet });
    }
    setPlanRun(finished ? null : { ...planRun, done });
    setBatchNotice(
      stop
        ? `The plan stopped after ${done} of ${images.length} images. ${stop}`
        : finished
          ? `The plan is done: ${images.length} image${images.length === 1 ? "" : "s"} in ${dirs[0].replace(/\\set \d+$/, "")}.`
          : `${done} of ${images.length} done. Press Continue for the next part.`,
    );
    if (finished) setBatchSeed(randomSeed());
    getAccountStatus().then((s) => s && setStatus(s)).catch(() => {});
  }

  async function runGenerate(fromRemix = false) {
    if (!outputDir) return;
    const batchStart = new Date();
    const remixStart = remixQueue?.next ?? 0;
    let built: ReturnType<typeof buildBatch>;
    try {
      built = buildBatch(fromRemix);
    } catch (err) {
      setError(String(err));
      return;
    }
    if (built.images.length === 0) {
      setError("Parameter creep stops before the first image; check its range.");
      return;
    }
    const requests: GenerateRequest[] = built.images.map((img, i) => ({
      ...img.request,
      fileStem: fileStemFor(img.request.seed, i, batchStart),
    }));
    const advancing = fromRemix
      ? []
      : characters.flatMap((_, j) => {
          const adv = advanceOf(j);
          return adv && adv.mode !== "fixed" ? [{ adv, key: poolKey(adv.pool, adv.mode) }] : [];
        });

    // Characters a model switch set aside are let go once something is made.
    setStashedChars(null);
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setGenerating(true);
    setError(null);
    setBatchNotice(
      fromRemix && remixBatch.some((item) => item.characters.length > maxChars)
        ? `${modelFamily(model)} takes ${maxChars} characters, so images with more use only their first ${maxChars}.`
        : built.stopped
          ? `Parameter creep reached the end of its range, so this batch is ${requests.length} image${requests.length === 1 ? "" : "s"}.`
          : null,
    );
    setBatchImages([]);
    setProgress({ done: 0, total: requests.length });
    try {
      const summary = await generateBatch(
        runId,
        requests,
        outputDir,
        // Guard whenever the cost is known (free, or a fixed price); otherwise
        // the user has already confirmed an open-ended spend.
        guardAnlas,
        (p) => {
          if (p.account) setStatus(p.account);
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
      if (fromRemix) {
        setRemixQueue((q) => {
          if (!q) return q;
          const next = remixStart + made;
          return next >= q.items.length ? null : { ...q, next };
        });
      } else if (made > 0) {
        advanceAfter(built.usedFiles, made, requests.length, built.assocNext, advancing, null);
      }
      setBatchSeed(randomSeed());
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
      // Opens in the project's wildcards folder; any other folder works too.
      defaultPath: await wildcardsDir().catch(() => undefined),
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
    setFolderFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...change } : f)));
    if (change.mode && folderFiles.some((f) => f.path === path)) {
      setFolderModes((m) => {
        const next = { ...m };
        if (change.mode === "sequential") next[path] = "sequential";
        else delete next[path];
        return next;
      });
    }
  }

  async function editFile(f: PromptFile) {
    try {
      setEditingFile({ file: f, raw: await readPromptFile(f.path) });
    } catch (err) {
      setError(String(err));
    }
  }

  async function reloadFile(f: PromptFile) {
    const fresh = await openPromptFile(f.path, f.name, f.mode);
    const put = (prev: PromptFile[]) => prev.map((x) => (x.path === f.path ? { ...fresh, fromFolder: x.fromFolder } : x));
    setPromptFiles(put);
    setFolderFiles(put);
  }

  // Gender swap, written into the form (with Undo) instead of only per batch.
  // A carded character's opposite-gender variant: a card with the same name
  // and the other gender, or one labelled "variant-of:<name>".
  function variantFor(link: CardLink | null): CardFile | null {
    if (!link?.gender || link.gender === "other") return null;
    const want = link.gender === "female" ? "male" : "female";
    const name = link.name.toLowerCase();
    return (
      cards.find(
        (c) =>
          c.card.gender === want &&
          (c.card.name.toLowerCase() === name || c.card.labels.includes(`variant-of:${name}`) ||
            (link.labels ?? []).includes(`variant-of:${c.card.name.toLowerCase()}`)),
      ) ?? null
    );
  }

  function applySwapToForm() {
    const gs = { ...automation.genderSwap, pairs: genderPairs };
    setSwapUndo({ prompt, negative: negativePrompt, characters, negatives: characterNegatives });
    const inScope = (j: number) => gs.mode !== "slot" || j === gs.slot - 1;
    // A carded character with a variant card loads that card instead of
    // having its tags rewritten.
    const variants = characters.map((_, j) => (inScope(j) ? variantFor(cardLinks[j]) : null));
    const swapChar = (c: string, j: number) => {
      const v = variants[j];
      return v ? v.card.tags.map((t) => t.text).join(", ") : inScope(j) ? swapGender(c, gs) : c;
    };
    const swapNeg = (c: string, j: number) => {
      const v = variants[j];
      return v ? v.card.negative : inScope(j) ? swapGender(c, gs) : c;
    };
    if (gs.mode !== "slot") {
      setPrompt(swapGender(prompt, gs));
      setNegativePrompt(swapGender(negativePrompt, gs));
    }
    setCharacters((prev) => prev.map(swapChar));
    setCharacterNegatives((prev) => prev.map(swapNeg));
    if (variants.some(Boolean)) {
      setCharacterCardLinks(cardLinks.map((l, j) => (variants[j] ? linkFor(variants[j]!.card, variants[j]!.path) : l)));
      setBatchNotice(`Loaded the variant card${variants.filter(Boolean).length === 1 ? "" : "s"} ${variants.filter(Boolean).map((v) => v!.card.name).join(", ")} instead of rewriting their tags.`);
    }
    // The form now says it, so the batch shouldn't swap it back.
    setAutomation((a) => ({ ...a, genderSwap: { ...a.genderSwap, mode: "off" } }));
  }

  function undoSwap() {
    if (!swapUndo) return;
    setPrompt(swapUndo.prompt);
    setNegativePrompt(swapUndo.negative);
    setCharacters(swapUndo.characters);
    setCharacterNegatives(swapUndo.negatives);
    setSwapUndo(null);
  }

  // `line` is 1-based, as shown; out-of-range or non-numbers are ignored.
  function setPosition(file: PromptFile, line: number) {
    if (!Number.isInteger(line) || line < 1 || line > file.lines.length) return;
    updatePromptFile(file.path, { position: line - 1 });
    void savePosition(file.path, line - 1);
  }

  function resetPosition(file: PromptFile) {
    setPosition(file, 1);
  }

  // Puts `__name__` at the cursor in the prompt field last typed in, or at
  // the end of the main prompt if none has been.
  // Sets a paired file up in one go: its main token at the end of the main
  // prompt, and each part in the character named for it (whose prompt
  // starts with the label, like "girl, …"), else an empty character, else a
  // new one that starts with the label.
  function usePairedFile(f: PromptFile) {
    const append = (text: string, token: string) => {
      const base = text.replace(/[\s,]+$/, "");
      return base ? `${base}, ${token}` : token;
    };
    if (![prompt, negativePrompt].some((t) => tokensIn(t).includes(f.name))) setPrompt((p) => append(p, tokenFor(f.name)));
    const chars = [...characters];
    const negatives = [...characterNegatives];
    const positions = [...characterPositions];
    const noRoom: string[] = [];
    for (const part of f.partNames) {
      const key = `${f.name}:${part}`;
      if (chars.some((c) => tokensIn(c).includes(key))) continue;
      const firstTag = (c: string) => c.split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const usesFile = (c: string) => tokensIn(c).some((k) => tokenFile(k) === f.name);
      let i = chars.findIndex((c) => firstTag(c) === part && !usesFile(c));
      if (i < 0) i = chars.findIndex((c) => c.trim() === "");
      if (i < 0) {
        if (chars.length >= maxChars) {
          noRoom.push(part);
          continue;
        }
        chars.push(part.replace(/-/g, " "));
        negatives.push("");
        positions.push(CENTER);
        i = chars.length - 1;
      }
      chars[i] = append(chars[i], tokenFor(f.name, part));
    }
    setCharacters(chars);
    setCharacterNegatives(negatives);
    setCharacterPositions(positions);
    if (noRoom.length > 0) {
      setError(
        `There's room for ${maxChars} characters, so ${noRoom.map((p) => tokenFor(f.name, p)).join(", ")} wasn't placed. Put it in a character yourself.`,
      );
    }
  }

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

  // Fills a character from a character card: a new one, or replaces one.
  // The character keeps a link to the card, so each image can leave out the
  // card's tags for whatever its view tags hide.
  function loadCharacterCard(prompt: string, negative: string, slot: number | null, link: CardLink) {
    setShowCardDialog(false);
    const index = slot ?? characters.length;
    if (slot === null) {
      if (characters.length >= maxChars) return;
      setCharacters((prev) => [...prev, prompt]);
      setCharacterNegatives((prev) => [...prev, negative]);
      setCharacterPositions((prev) => [...prev, CENTER]);
    } else {
      setCharacters((prev) => prev.map((c, j) => (j === slot ? prompt : c)));
      setCharacterNegatives((prev) => prev.map((c, j) => (j === slot ? negative : c)));
    }
    setCharacterCardLinks(characters.map((_, i) => cardLinks[i]).concat([null]).map((l, i) => (i === index ? link : l)));
  }

  function loadManyCards(items: { prompt: string; negative: string; link: CardLink }[]) {
    setShowCardDialog(false);
    const room = Math.max(0, maxChars - characters.length);
    const take = items.slice(0, room);
    if (take.length === 0) return;
    setCharacters((prev) => [...prev, ...take.map((t) => t.prompt)]);
    setCharacterNegatives((prev) => [...prev, ...take.map((t) => t.negative)]);
    setCharacterPositions((prev) => [...prev, ...take.map(() => CENTER)]);
    setCharacterCardLinks([...characters.map((_, i) => cardLinks[i]), ...take.map((t) => t.link)]);
    if (items.length > room) setError(`There's room for ${room} more character${room === 1 ? "" : "s"}, so only the first ${room} were added.`);
  }

  function unlinkCard(index: number) {
    setCharacterCardLinks(cardLinks.map((l, i) => (i === index ? null : l)));
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
    setCharacterCardLinks(cardLinks.filter((_, j) => j !== index));
    setCharacterAdvance(characters.map((_, i) => advanceOf(i)).filter((_, j) => j !== index));
    setCharacterKeys((prev) => prev.filter((_, j) => j !== index));
    if (typeof lastFieldRef.current?.field === "object") lastFieldRef.current = null;
  }

  // Applies the same reordering (new index -> old index) to every per-character list.
  function permuteCharacters(order: number[]) {
    const pick = <T,>(list: T[], fill: T) => order.map((i) => list[i] ?? fill);
    setCharacters((prev) => pick(prev, ""));
    setCharacterNegatives((prev) => pick(prev, ""));
    setCharacterPositions((prev) => pick(prev, CENTER));
    setCharacterCardLinks(pick(cardLinks, null));
    setCharacterAdvance(pick(characters.map((_, i) => advanceOf(i)), null));
    setCharacterKeys((prev) => pick(prev, ""));
    if (typeof lastFieldRef.current?.field === "object") lastFieldRef.current = null;
  }

  function moveCharacter(from: number, to: number) {
    const order = characters.map((_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    permuteCharacters(order);
  }

  function toggleExpanded(key: string) {
    setExpandedChars((prev) => {
      if (prev.has(key)) {
        const next = new Set(prev);
        next.delete(key);
        return next;
      }
      return oneOpen ? new Set([key]) : new Set([...prev, key]);
    });
  }

  // Switching models: one that takes fewer characters asks first.
  function chooseModel(next: string) {
    const max = MODELS.find((m) => m.id === next)?.maxCharacters ?? 6;
    if (characters.length > max) {
      setModelSwitch({ to: next, choosing: false, keep: new Set(characters.map((_, i) => i).slice(0, max)) });
      return;
    }
    setModel(next);
    // Characters an earlier switch set aside come back when there's room.
    if (stashedChars && stashedChars.from === next) restoreStash(max);
  }

  function applyModelSwitch(keep: Set<number>) {
    if (!modelSwitch) return;
    const kept = characters.map((_, i) => i).filter((i) => keep.has(i));
    const removed = characters.map((_, i) => i).filter((i) => !keep.has(i));
    setStashedChars({
      from: model,
      items: removed.map((i) => ({
        index: i,
        text: characters[i],
        negative: characterNegatives[i] ?? "",
        position: characterPositions[i] ?? CENTER,
        link: cardLinks[i],
      })),
    });
    permuteCharacters(kept);
    setModel(modelSwitch.to);
    setModelSwitch(null);
  }

  function restoreStash(max: number) {
    if (!stashedChars) return;
    const rows = characters.map((text, i) => ({
      text,
      negative: characterNegatives[i] ?? "",
      position: characterPositions[i] ?? CENTER,
      link: cardLinks[i],
      key: characterKeys[i] ?? crypto.randomUUID(),
    }));
    // Put each back where it was, as far as the list allows.
    for (const item of [...stashedChars.items].sort((a, b) => a.index - b.index)) {
      if (rows.length >= max) break;
      rows.splice(Math.min(item.index, rows.length), 0, { ...item, key: crypto.randomUUID() });
    }
    setCharacters(rows.map((r) => r.text));
    setCharacterNegatives(rows.map((r) => r.negative));
    setCharacterPositions(rows.map((r) => r.position));
    setCharacterCardLinks(rows.map((r) => r.link));
    setCharacterKeys(rows.map((r) => r.key));
    setStashedChars(null);
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

  // While the tab is showing, keep the balance and quota current.
  useEffect(() => {
    if (!active || phase !== "loggedIn" || generating) return;
    const timer = setInterval(() => {
      getAccountStatus()
        .then((s) => s && setStatus(s))
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [active, phase, generating]);

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

  const lastCard = lastResult && (
    <div style={cardStyle}>
      <div style={cardTitleStyle}>LAST IMAGE</div>
      <img
        src={lastResult.src}
        alt="Generated image"
        style={{ display: "block", maxWidth: "100%", maxHeight: 560, borderRadius: 8 }}
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
        </a>{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setDirector({ path: lastResult.path, tool: "emotion" });
          }}
          style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, whiteSpace: "nowrap" }}
        >
          Change expression…
        </a>{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setDirector({ path: lastResult.path, tool: "colorize" });
          }}
          style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, whiteSpace: "nowrap" }}
        >
          Colorize…
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
  );

  // The layout: everything scrolls except the bar at the bottom (output
  // folder, image count, Generate). A wide window gets two columns, with the
  // characters on the right.
  const settingsCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ ...cardTitleStyle, marginBottom: 0 }}>SETTINGS</div>
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
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (generating) return;
            if (!cardFolder) setError("Choose a card folder in the Character Cards tab first; saved prompts are kept there.");
            else setShowSavedPrompts(true);
          }}
          title="Save the form under a name, or load one you saved"
          style={{ fontSize: 13, fontWeight: 600, marginLeft: 14 }}
        >
          Saved prompts…
        </a>
      </div>
      <div style={{ display: "flex", gap: "14px 28px", flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px" }}>
              <Field label="Model">
                <select
                  value={model}
                  onChange={(e) => chooseModel(e.target.value)}
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
                <button
                  onClick={() => setSizeIndex(CUSTOM_SIZE)}
                  disabled={generating}
                  title="Any size up to 1024×1024 worth of pixels, in steps of 64"
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: sizeIndex === CUSTOM_SIZE ? "none" : "1px solid var(--border)",
                    background: sizeIndex === CUSTOM_SIZE ? "var(--accent)" : "transparent",
                    color: sizeIndex === CUSTOM_SIZE ? "var(--accent-contrast)" : "var(--text)",
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 600,
                    fontSize: 12.5,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Custom
                </button>
              </div>
              {sizeIndex === CUSTOM_SIZE && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <SideInput label="Width" value={customWidth} onChange={setCustomWidth} disabled={generating} />
                    <span style={{ color: "var(--muted)" }}>×</span>
                    <SideInput label="Height" value={customHeight} onChange={setCustomHeight} disabled={generating} />
                    <button
                      onClick={() => {
                        setCustomWidth(customHeight);
                        setCustomHeight(customWidth);
                      }}
                      disabled={generating}
                      title="Swap width and height"
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      ⇄
                    </button>
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 11.5,
                      fontFamily: "'IBM Plex Mono', monospace",
                      color: sizeError ? "#c9482f" : "var(--muted)",
                    }}
                  >
                    {sizeError ??
                      `${(customWidth * customHeight).toLocaleString()} of 1,048,576 pixels · free on Opus`}
                  </div>
                </div>
              )}
            </Field>
          </div>
        </div>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
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
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
            <Field label="Sampler">
              <select
                value={sampler}
                onChange={(e) => setSampler(e.target.value)}
                disabled={generating}
                style={{ ...inputStyle, background: "var(--bg-page)", padding: "5px 8px" }}
              >
                {SAMPLERS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Noise schedule">
              <select
                value={noiseSchedule}
                onChange={(e) => setNoiseSchedule(e.target.value)}
                disabled={generating}
                style={{ ...inputStyle, background: "var(--bg-page)", padding: "5px 8px" }}
              >
                {NOISE_SCHEDULES.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, paddingBottom: 6 }}>
              <input
                type="checkbox"
                checked={varietyOn}
                onChange={(e) => setVarietyPlus(e.target.checked)}
                disabled={generating || !supportsVarietyPlus(model)}
                title={supportsVarietyPlus(model) ? undefined : "V5 doesn't take Variety+"}
                style={{ accentColor: "var(--accent)" }}
              />
              Variety+
              <HelpTip
                title="Variety+"
                lines={[
                  {
                    text: "Skips guidance in the first, noisiest steps, so images vary more in composition. Free.",
                  },
                  {
                    text: VARIETY_PLUS_VERIFIED
                      ? `Sends skip_cfg_above_sigma ${varietyPlusSigma(model, size.width, size.height).toFixed(2)} at this size.`
                      : `Sends skip_cfg_above_sigma ${varietyPlusSigma(model, size.width, size.height).toFixed(2)} at this size (matches a V4.5 image made on novelai.net, 58 at 832×1216; other sizes scale by NovelAI's rule). V5 doesn't take Variety+.`,
                  },
                ]}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );

  const promptCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Prompt" help={<HelpTip title="Prompt syntax" lines={helpFor("prompt")} />}>
        <GrowingTextarea
          minRows={wide ? 9 : 6}
          maxHeight={560}
          value={prompt}
          data-tags
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={(e) => (lastFieldRef.current = { field: "prompt", el: e.currentTarget })}
          readOnly={generating}
          style={textareaStyle}
        />
        {preview(prompt)}
      </Field>
      <Field label="Undesired content" help={<HelpTip title="Undesired content syntax" lines={helpFor("negative")} />}>
        <GrowingTextarea
          minRows={wide ? 5 : 3}
          maxHeight={360}
          value={negativePrompt}
          data-tags
          onChange={(e) => setNegativePrompt(e.target.value)}
          onFocus={(e) => (lastFieldRef.current = { field: "negative", el: e.currentTarget })}
          readOnly={generating}
          style={textareaStyle}
        />
        {preview(negativePrompt)}
      </Field>
    </div>
  );

  const slots: SlotSummary[] = characters.map((c, i) => ({
    key: characterKeys[i] ?? String(i),
    text: c,
    negative: characterNegatives[i] ?? "",
    position: characterPositions[i] ?? CENTER,
    cardName: advanceOf(i) ? `${{ next: "Next", random: "Random", shuffle: "Shuffle" }[advanceOf(i)!.mode as "next"]} card` : (cardLinks[i]?.name ?? null),
    hasReference: !!cardLinks[i]?.reference,
  }));
  const tokensUsed = [prompt, ...characters].reduce((n, t) => n + roughTokens(t), 0);
  const tokenMax = tokenLimit(model);
  const setAdvance = (i: number, a: SlotAdvance | null) =>
    setCharacterAdvance(characters.map((_, j) => (j === i ? a : advanceOf(j))));
  const advanceRow = (i: number) => {
    const a = advanceOf(i);
    const mode = a?.mode ?? "fixed";
    const pool = a ? poolCards(cards, a.pool) : [];
    const sel: React.CSSProperties = { ...inputStyle, padding: "3px 6px", fontSize: 12, background: "var(--bg-page)" };
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ fontWeight: 600, color: "var(--muted)" }}>
          Auto-advance
          <HelpTip
            lines={[
              { text: "Fixed keeps this prompt. Next, Random or Shuffle (no repeats until every card is used) puts a card from a pool in this slot, a new one every N images." },
              { text: "Pools are your character cards filtered by label (set labels in the Character Cards tab). The pool's place is saved, so the next batch carries on." },
            ]}
          />
        </span>
        <select
          value={mode}
          disabled={generating}
          onChange={(e) => {
            const m = e.target.value as SlotAdvance["mode"];
            setAdvance(i, m === "fixed" ? null : { ...(a ?? DEFAULT_ADVANCE), mode: m });
          }}
          style={sel}
        >
          <option value="fixed">Fixed</option>
          <option value="next">Next card</option>
          <option value="random">Random card</option>
          <option value="shuffle">Shuffle cards</option>
        </select>
        {a && (
          <>
            <input
              value={a.pool.include}
              disabled={generating}
              placeholder="labels (any card)"
              onChange={(e) => setAdvance(i, { ...a, pool: { ...a.pool, include: e.target.value } })}
              style={{ ...sel, width: 120 }}
            />
            <select
              value={a.pool.matchAll ? "all" : "any"}
              disabled={generating}
              onChange={(e) => setAdvance(i, { ...a, pool: { ...a.pool, matchAll: e.target.value === "all" } })}
              style={sel}
            >
              <option value="any">any label</option>
              <option value="all">all labels</option>
            </select>
            <input
              value={a.pool.exclude}
              disabled={generating}
              placeholder="not labels"
              onChange={(e) => setAdvance(i, { ...a, pool: { ...a.pool, exclude: e.target.value } })}
              style={{ ...sel, width: 100 }}
            />
            <select
              value={a.pool.gender ?? ""}
              disabled={generating}
              onChange={(e) => setAdvance(i, { ...a, pool: { ...a.pool, gender: (e.target.value || null) as SlotAdvance["pool"]["gender"] } })}
              style={sel}
            >
              <option value="">any gender</option>
              <option value="female">female</option>
              <option value="male">male</option>
              <option value="other">other</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              every
              <input
                type="number"
                min={1}
                max={1000}
                value={a.every}
                disabled={generating}
                onChange={(e) => setAdvance(i, { ...a, every: Math.max(1, Math.min(1000, Math.round(Number(e.target.value)) || 1)) })}
                style={{ ...sel, width: 52 }}
              />
              images
            </label>
            <span style={{ color: pool.length === 0 ? "rgb(200,140,40)" : "var(--muted)" }}>
              {cardFolder === null ? "Choose a card folder in Character Cards." : `${pool.length} card${pool.length === 1 ? "" : "s"} in the pool`}
            </span>
          </>
        )}
      </div>
    );
  };
  const characterBody = (i: number) => {
    const c = characters[i];
    return (
      <>
        {advanceRow(i)}
        {cardNote(i, c)}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <GrowingTextarea
              minRows={wide ? 4 : 3}
              maxHeight={360}
              value={c}
              placeholder={`Character ${i + 1}`}
              data-tags
              onChange={(e) => setCharacters((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
              onFocus={(e) => (lastFieldRef.current = { field: { character: i, negative: false }, el: e.currentTarget })}
              readOnly={generating}
              style={textareaStyle}
            />
            {preview(c, true)}
            <GrowingTextarea
              minRows={1}
              maxHeight={200}
              value={characterNegatives[i] ?? ""}
              placeholder={`Undesired for character ${i + 1}`}
              data-tags
              onChange={(e) => setCharacterNegatives((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
              onFocus={(e) => (lastFieldRef.current = { field: { character: i, negative: true }, el: e.currentTarget })}
              readOnly={generating}
              style={{ ...textareaStyle, fontSize: 12.5, padding: "6px 10px" }}
            />
            {preview(characterNegatives[i] ?? "")}
          </div>
          {useCoords && (
            <PositionPicker
              index={i}
              positions={characterPositions}
              model={model}
              aspect={size.width / size.height}
              disabled={generating}
              highlight={hoveredChar}
              onChange={(p) => setCharacterPositions((prev) => prev.map((q, j) => (j === i ? p : q)))}
            />
          )}
        </div>
      </>
    );
  };
  const charactersCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>
          CHARACTERS ({characters.length}/{maxChars})
          <HelpTip
            title="Characters"
            lines={[
              { text: `${modelFamily(model)} takes up to ${maxChars} character prompts (22 on V5, 6 on V4/V4.5).` },
              { text: "Order matters to the model: top to bottom, left to right. Drag a row by its ⋮⋮ to move it." },
            ]}
          />
        </div>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (!generating) setShowCardDialog(true);
          }}
          title="Fill a character from one of your character cards"
          style={{ fontSize: 13, fontWeight: 600 }}
        >
          Load character card…
        </a>
        {characters.length < maxChars && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (!generating) addCharacter();
            }}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            + Add character
          </a>
        )}
      </div>
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
          {useCoords && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!generating) setCharacterPositions(spreadPositions(characters.length, model));
              }}
              title="Place the characters evenly: a row, or a grid for many"
              style={{ fontWeight: 600 }}
            >
              Spread evenly
            </a>
          )}
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
      {characters.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setExpandedChars(new Set());
            }}
            style={{ fontWeight: 600 }}
          >
            Collapse all
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setExpandedChars(new Set(characterKeys));
            }}
            style={{ fontWeight: 600 }}
          >
            Expand all
          </a>
          <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <input
              type="checkbox"
              checked={oneOpen}
              onChange={(e) => setOneOpen(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            One open at a time
          </label>
          <span
            title={`A rough count. ${modelFamily(model)} reads about ${tokenMax} tokens of the prompt and all characters together; text past that is ignored.`}
            style={{
              marginLeft: "auto",
              fontFamily: "'IBM Plex Mono', monospace",
              color: tokensUsed > tokenMax * 0.9 ? "rgb(200,140,40)" : "var(--muted)",
            }}
          >
            ≈{tokensUsed}/{tokenMax} tokens
          </span>
        </div>
      )}
      {characters.length === 0 && (
        <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
          No characters. Each character gets its own prompt and undesired content, and can be placed in the
          picture. Add one, or load one of your character cards.
        </div>
      )}
      {characters.length > 0 && (
        <CharacterSlots
          slots={slots}
          model={model}
          disabled={generating}
          expanded={expandedChars}
          onToggle={toggleExpanded}
          onReorder={moveCharacter}
          hovered={hoveredChar}
          onHover={setHoveredChar}
          renderBody={characterBody}
          renderActions={(i) => (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!generating) removeCharacter(i);
              }}
              title="Remove character"
              style={{ fontSize: 12.5, fontWeight: 600 }}
            >
              Remove
            </a>
          )}
        />
      )}
      {stashedChars && (
        <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
          {stashedChars.items.length} character{stashedChars.items.length === 1 ? "" : "s"} set aside by the model switch
          {" · "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (!generating) chooseModel(stashedChars.from);
            }}
            style={{ fontWeight: 600 }}
          >
            Switch back to {modelFamily(stashedChars.from)} and restore
          </a>
        </div>
      )}
      {showCardDialog && (
        <CharacterCardDialog
          characterCount={characters.length}
          maxCharacters={maxChars}
          onLoad={loadCharacterCard}
          onLoadMany={loadManyCards}
          onClose={() => setShowCardDialog(false)}
        />
      )}
    </div>
  );

  // Prompt files can number in the hundreds, so the list scrolls and can be filtered.
  const filterText = fileFilter.trim().toLowerCase();
  const shownFiles = promptFiles.filter(
    (f) => (!usedOnly || usedNames.has(f.name)) && (filterText === "" || f.name.toLowerCase().includes(filterText)),
  );
  const unusedCount = promptFiles.filter((f) => !usedNames.has(f.name)).length;
  // Folder files, filtered the same way, grouped by subfolder.
  const shownFolder = folderFiles.filter(
    (f) => (!usedOnly || usedNames.has(f.name)) && (filterText === "" || f.name.toLowerCase().includes(filterText)),
  );
  const folderGroups = [...new Map<string, PromptFile[]>(
    shownFolder.reduce((m, f) => {
      const g = f.name.includes("/") ? f.name.slice(0, f.name.lastIndexOf("/")) : "";
      m.set(g, [...(m.get(g) ?? []), f]);
      return m;
    }, new Map<string, PromptFile[]>()),
  )].sort(([a], [b]) => a.localeCompare(b));
  const fileRow = (f: PromptFile) => (
              <div key={f.path} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
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
                    : loops.has(f.name)
                      ? `Refers back to itself: ${loops.get(f.name)!.join(" → ")}`
                      : duplicateNames.includes(f.name) && f.fromFolder
                        ? `Another file is also ${tokenFor(f.name)}; ${handNames.has(f.name) ? "the one added by hand" : "the first"} is used`
                        : `${f.lines.length} ${f.partNames.length > 0 ? "entr" + (f.lines.length === 1 ? "y" : "ies") : "line" + (f.lines.length === 1 ? "" : "s")}${f.weights.some((w) => w !== 1) ? " · weighted" : ""}${usedNames.has(f.name) ? "" : " · not used yet"}`}
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
                        next{" "}
                        <input
                          type="number"
                          min={1}
                          max={f.lines.length}
                          value={f.position + 1}
                          onChange={(e) => setPosition(f, Math.round(Number(e.target.value)))}
                          disabled={generating}
                          title={`Which ${f.partNames.length > 0 ? "entry" : "line"} the next image uses (1–${f.lines.length})`}
                          style={{
                            width: `${String(f.lines.length).length + 3}ch`,
                            padding: "1px 4px",
                            borderRadius: 5,
                            border: "1px solid var(--border)",
                            background: "var(--bg-page)",
                            color: "var(--text)",
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 11.5,
                          }}
                        />
                        /{f.lines.length}
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
                    if (!generating) void editFile(f);
                  }}
                  title="Edit this file's lines and weights"
                  style={{ fontWeight: 600 }}
                >
                  Edit
                </a>
                {!f.fromFolder && (
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
                )}
              </div>
              {f.partNames.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 12, fontSize: 12 }}>
                  <span style={{ color: "var(--muted)" }}>Parts</span>
                  {f.partNames.map((p) => (
                    <button
                      key={p}
                      onClick={() => insertToken(`${f.name}:${p}`)}
                      disabled={generating}
                      title={`Click to insert ${tokenFor(f.name, p)}: each entry's "${p}:" line`}
                      style={{
                        padding: "1px 7px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--bg-page)",
                        color: "var(--text)",
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 11.5,
                        cursor: "pointer",
                      }}
                    >
                      :{p}
                    </button>
                  ))}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (!generating) usePairedFile(f);
                    }}
                    title="Put the main token in the prompt and each part in its character"
                    style={{ fontWeight: 600, marginLeft: 4 }}
                  >
                    Use in prompts
                  </a>
                </div>
              )}
              </div>
  );

  const promptFilesCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>
          PROMPT FILES
          {promptFiles.length > 0 && (
            <span style={{ fontWeight: 500 }}>
              {" "}
              · {promptFiles.length} loaded, {promptFiles.length - unusedCount} in use
            </span>
          )}
        </span>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void openWildcardsDir().catch((err) => setError(String(err)));
          }}
          title="Open the project's wildcards folder, where prompt files live by default"
          style={{ fontSize: 13, fontWeight: 600 }}
        >
          Open folder
        </a>
        <button
          onClick={() => void addPromptFiles()}
          disabled={generating}
          style={{ ...secondaryButtonStyle, padding: "5px 14px" }}
        >
          Add .txt files…
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={wildcardFolder.enabled}
            disabled={generating}
            onChange={(e) => setWildcardFolder((w) => ({ ...w, enabled: e.target.checked }))}
            style={{ accentColor: "var(--accent)" }}
          />
          Use whole folder
          <HelpTip lines={[{ text: CONTROL_HELP.wholeFolder }, ...helpFor("promptFiles")]} />
        </label>
        {wildcardFolder.enabled && (
          <>
            <span
              title={wildcardFolder.dir ?? "The project's wildcards folder"}
              style={{ flex: 1, minWidth: 0, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {wildcardFolder.dir ?? "wildcards (default)"} · {folderFiles.length} file{folderFiles.length === 1 ? "" : "s"}
            </span>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!generating) void chooseWildcardFolder();
              }}
              style={{ fontWeight: 600 }}
            >
              Change…
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!generating) void scanFolder();
              }}
              style={{ fontWeight: 600 }}
            >
              Refresh
            </a>
          </>
        )}
      </div>
      {folderScanError && <div style={{ ...warningBoxStyle, marginTop: 0, fontSize: 12.5 }}>{folderScanError}</div>}
      {promptFiles.length === 0 && folderFiles.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
          Text files with one prompt per line, kept in the project's <code>wildcards</code>{" "}
          folder. Each file gets a token like <code>__hair__</code>; put it in any prompt,
          undesired content or character, and every image fills it with a line from that file.
        </div>
      ) : (
        <>
          {promptFiles.length + folderFiles.length > 5 && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12.5 }}>
              <input
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                placeholder="Filter files…"
                spellCheck={false}
                style={{ ...inputStyle, background: "var(--bg-page)", flex: "1 1 160px", padding: "5px 10px", fontSize: 12.5 }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={usedOnly}
                  onChange={(e) => setUsedOnly(e.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                In use only
              </label>
              {unusedCount > 0 && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!generating) setPromptFiles((prev) => prev.filter((x) => usedNames.has(x.name)));
                  }}
                  title="Take every file whose token isn't in any prompt off this list (the files stay on disk)"
                  style={{ fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  Remove {unusedCount} unused
                </a>
              )}
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              maxHeight: 340,
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            {shownFiles.length === 0 && shownFolder.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No files match.</div>
            )}
            {shownFiles.map(fileRow)}
            {folderGroups.map(([group, files]) => {
              const isOpen = openGroups.has(group) || filterText !== "";
              return (
                <div key={group} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    onClick={() =>
                      setOpenGroups((g) => {
                        const next = new Set(g);
                        if (next.has(group)) next.delete(group);
                        else next.add(group);
                        return next;
                      })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 0",
                      border: "none",
                      background: "transparent",
                      color: "var(--muted)",
                      fontFamily: "'Space Grotesk', sans-serif",
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {isOpen ? "▾" : "▸"} {group === "" ? "Wildcards folder" : `${group}/`}
                    <span style={{ fontWeight: 500 }}>· {files.length}</span>
                  </button>
                  {isOpen && files.map(fileRow)}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
            Click a token to insert it where you're typing. Each image uses one entry per file, so a
            paired file's parts always match its main line.
          </div>
        </>
      )}
    </div>
  );

  // Image to image: a starting picture and how much of it may change.
  const sourceShapeOff =
    sourceImage !== null &&
    Math.abs(sourceImage.width / sourceImage.height - size.width / size.height) > 0.03;
  const img2imgCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>IMAGE TO IMAGE</span>
        {sourceImage && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (!generating) setSourceImage(null);
            }}
            title="Go back to text to image"
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            Remove
          </a>
        )}
        <button
          onClick={() => void chooseSourceImage()}
          disabled={generating}
          style={{ ...secondaryButtonStyle, padding: "6px 14px" }}
        >
          {sourceImage ? "Change image…" : "Choose image…"}
        </button>
      </div>
      {!sourceImage ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
          Start from a picture instead of noise. The prompt, characters and settings above still apply; strength
          sets how much of the picture may change.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <img
            src={convertFileSrc(sourceImage.path)}
            alt=""
            style={{ width: 96, height: 96, objectFit: "contain", borderRadius: 6, flexShrink: 0, background: "var(--bg-page)" }}
          />
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              title={sourceImage.path}
              style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {fileName(sourceImage.path)}
            </div>
            <div style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color: "var(--muted)" }}>
              {sourceImage.width}×{sourceImage.height} → sent at {size.width}×{size.height}
              {sourceShapeOff && (
                <>
                  {" "}
                  <span style={{ color: "rgb(200,140,40)" }}>(stretched)</span>{" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (!generating) matchSourceSize(sourceImage);
                    }}
                    title="Set the resolution to the nearest free size of the picture's shape"
                    style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}
                  >
                    Match shape
                  </a>
                </>
              )}
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span style={{ fontWeight: 600, color: "var(--muted)" }}>Strength: {img2imgStrength.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={img2imgStrength}
                onChange={(e) => setImg2imgStrength(Number(e.target.value))}
                disabled={generating}
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: 11.5 }}>
                <span>0 · keep the picture</span>
                <span>1 · change everything</span>
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  );

  async function addReference(kind: ReferenceKind) {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof file !== "string") return;
    setReferences((rs) => [...rs, { path: file, kind, strength: 1, fidelity: 1, preferSameOutfit: false }]);
  }
  const updateReference = (i: number, patch: Partial<PreciseReference>) =>
    setReferences((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cardRefCount = cardLinks.filter((l) => l?.reference).length;
  const modelKinds = referenceKinds(model);
  const maxStrength = maxReferenceStrength(model);
  const isV5References = maxStrength > 1;
  const leftOutKinds = [...new Set(references.filter((r) => !modelKinds.includes(r.kind)).map((r) => REFERENCE_KIND_LABELS[r.kind]))];
  const wantedReferences = references.filter((r) => modelKinds.includes(r.kind)).length + (useCardReferences ? cardRefCount : 0);
  const chip = (on: boolean): React.CSSProperties => ({
    padding: "3px 10px",
    borderRadius: 999,
    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
    background: on ? "var(--accent)" : "transparent",
    color: on ? "var(--accent-contrast)" : "var(--text)",
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
  });
  const referenceCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>
          PRECISE REFERENCE
          <HelpTip
            lines={[
              { text: "Reference images for a character's look, a style, or both, and on V5 an outfit too. Add as many as you need (up to " + MAX_PRECISE_REFERENCES + "). Character cards can carry their own (set in Character Cards)." },
              { text: `NovelAI charges ${PRECISE_REFERENCE_COST} Anlas per image for each reference; Generate shows the run's price and asks first.` },
              { text: "V5: strength goes up to 5 (raise it first if a reference isn't picked up enough), there's no fidelity, and Character references can prefer the same outfit." },
              { text: "V4.5: strength 0–1 plus fidelity. Can't be used with Vibe Transfer, so vibes are left out while references are on." },
            ]}
          />
          {formReferences.length > 0 && (
            <span style={{ fontWeight: 500, color: "rgb(200,140,40)" }}>
              {" "}
              · {formReferences.length} × {PRECISE_REFERENCE_COST} Anlas per image
            </span>
          )}
        </span>
        {modelKinds
          .filter((k) => k !== "character&style")
          .map((k) => (
            <button
              key={k}
              onClick={() => void addReference(k)}
              disabled={generating}
              style={{ ...secondaryButtonStyle, padding: "6px 12px" }}
              title={`Add a${k === "outfit" ? "n" : ""} ${REFERENCE_KIND_LABELS[k].toLowerCase()} reference image`}
            >
              + {REFERENCE_KIND_LABELS[k]}
            </button>
          ))}
      </div>
      {!modelInfo.preciseReference && (references.length > 0 || cardRefCount > 0) && (
        <div style={{ ...warningBoxStyle, marginTop: 0 }}>
          {modelFamily(model)} doesn't support Precise Reference, so no references are sent. Switch to V5 or V4.5 to use them.
        </div>
      )}
      {modelInfo.preciseReference && leftOutKinds.length > 0 && (
        <div style={{ ...warningBoxStyle, marginTop: 0 }}>
          {modelFamily(model)} doesn't take {leftOutKinds.join(" or ")} references, so they're left out. They work on V5.
        </div>
      )}
      {modelInfo.preciseReference && wantedReferences > MAX_PRECISE_REFERENCES && (
        <div style={{ ...warningBoxStyle, marginTop: 0 }}>
          Only the first {MAX_PRECISE_REFERENCES} references are sent ({wantedReferences} set, counting the cards').
        </div>
      )}
      {modelInfo.preciseReference && formReferences.length > 0 && vibeRefs.length > 0 && (
        <div style={{ ...warningBoxStyle, marginTop: 0 }}>Vibe Transfer can't be used with Precise Reference, so the vibes are left out.</div>
      )}
      {references.map((r, i) => {
        const usable = modelKinds.includes(r.kind);
        return (
          <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start", opacity: usable ? 1 : 0.55 }}>
            <img
              src={convertFileSrc(r.path)}
              alt=""
              title={r.path}
              style={{ width: 80, height: 80, objectFit: "contain", borderRadius: 6, background: "var(--bg-page)", flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {(usable ? modelKinds : [...modelKinds, r.kind]).map((k) => (
                  <button key={k} disabled={generating} onClick={() => updateReference(i, { kind: k })} style={chip(r.kind === k)}>
                    {REFERENCE_KIND_LABELS[k]}
                  </button>
                ))}
              {takesPreferSameOutfit(model, r.kind) && (
                <label style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 4 }}>
                  <input
                    type="checkbox"
                    checked={r.preferSameOutfit === true}
                    disabled={generating}
                    onChange={(e) => updateReference(i, { preferSameOutfit: e.target.checked })}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  Prefer same outfit
                </label>
              )}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!generating) setReferences((rs) => rs.filter((_, j) => j !== i));
                  }}
                  style={{ fontWeight: 600, marginLeft: "auto" }}
                >
                  Remove
                </a>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 92 }}>Strength {Math.min(r.strength, maxStrength).toFixed(2)}</span>
                <input
                  type="range"
                  min={0}
                  max={maxStrength}
                  step={0.05}
                  value={Math.min(r.strength, maxStrength)}
                  disabled={generating}
                  onChange={(e) => updateReference(i, { strength: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: "var(--accent)" }}
                />
              </label>
              {!isV5References && (
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ minWidth: 92 }}>Fidelity {r.fidelity.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={r.fidelity}
                    disabled={generating}
                    onChange={(e) => updateReference(i, { fidelity: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: "var(--accent)" }}
                  />
                </label>
              )}
            </div>
          </div>
        );
      })}
      {references.length > 0 && (
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Each image is sent padded to 1024×1536, 1536×1024 or 1472×1472, whichever fits its shape.
          {r5Note(maxStrength, references)}
        </div>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={useCardReferences}
          disabled={generating}
          onChange={(e) => setUseCardReferences(e.target.checked)}
          style={{ accentColor: "var(--accent)" }}
        />
        Send the references that come with character cards
        <span style={{ color: "var(--muted)" }}>
          ({cardRefCount} loaded card{cardRefCount === 1 ? " has" : "s have"} one)
        </span>
      </label>
    </div>
  );

  const vibesCard = (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>
          VIBE TRANSFER
          {vibes.length > 0 && modelInfo.vibes && (
            <span style={{ fontWeight: 500 }}>
              {" "}
              · {rotating ? `${Math.min(vibeRotation.k, MAX_VIBES)} per image from ${vibeRefs.length}` : `${vibeRefs.length} of ${MAX_VIBES} in use`}
            </span>
          )}
        </span>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (!generating) void openVibeLibrary();
          }}
          title="The vibe files in your vibe library folder"
          style={{ fontSize: 13, fontWeight: 600 }}
        >
          Library…
        </a>
        {modelInfo.vibes && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (!generating) void startEncode();
            }}
            title="Encode a plain image as a vibe (2 Anlas, once; saved as a .naiv4vibe file and reused after)"
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            Encode image…
          </a>
        )}
        <button
          onClick={() => void chooseVibeFiles()}
          disabled={generating}
          style={{ ...secondaryButtonStyle, padding: "6px 14px" }}
        >
          Add vibe file…
        </button>
      </div>

      {vibes.length > 0 && modelInfo.vibes && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
          <span style={{ fontWeight: 600, color: "var(--muted)" }}>
            Use
            <HelpTip
              lines={[
                { text: "Fixed sends every ticked vibe (up to 4, so it stays free)." },
                { text: "Random or Next sends K of the ticked vibes per image (at most 4), picked at random or in turn every N images; tick as many as you like." },
              ]}
            />
          </span>
          <select
            value={vibeRotation.mode}
            disabled={generating}
            onChange={(e) => setVibeRotation({ ...vibeRotation, mode: e.target.value as VibeRotation["mode"] })}
            style={{ ...inputStyle, padding: "3px 6px", fontSize: 12, background: "var(--bg-page)" }}
          >
            <option value="fixed">every ticked vibe</option>
            <option value="random">K at random per image</option>
            <option value="next">the next K every N images</option>
          </select>
          {rotating && (
            <>
              K
              <input
                type="number"
                min={1}
                max={MAX_VIBES}
                value={vibeRotation.k}
                disabled={generating}
                onChange={(e) => setVibeRotation({ ...vibeRotation, k: Math.max(1, Math.min(MAX_VIBES, Math.round(Number(e.target.value)) || 1)) })}
                style={{ ...inputStyle, width: 48, padding: "3px 6px", background: "var(--bg-page)" }}
              />
            </>
          )}
          {vibeRotation.mode === "next" && (
            <>
              every
              <input
                type="number"
                min={1}
                value={vibeRotation.every}
                disabled={generating}
                onChange={(e) => setVibeRotation({ ...vibeRotation, every: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                style={{ ...inputStyle, width: 48, padding: "3px 6px", background: "var(--bg-page)" }}
              />
              images
            </>
          )}
        </div>
      )}

      {vibeLibrary && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={vibeDir() ?? ""}>
              Vibe library · {vibeLibrary.length} file{vibeLibrary.length === 1 ? "" : "s"}
            </span>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void chooseVibeLibrary();
              }}
              style={{ fontWeight: 600 }}
            >
              Change folder…
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setVibeLibrary(null);
              }}
              style={{ fontWeight: 600 }}
            >
              Close
            </a>
          </div>
          {vibeLibrary.length === 0 && <div style={{ color: "var(--muted)" }}>No vibe files here yet; encoded images are saved here.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 180, overflowY: "auto" }}>
            {vibeLibrary.map((p) => {
              const listed = vibes.some((v) => v.path === p);
              return (
                <div key={p} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p}>
                    {fileName(p)}
                  </span>
                  {listed ? (
                    <span style={{ color: "var(--muted)" }}>in the list</span>
                  ) : (
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        void addVibeFiles([p]);
                      }}
                      style={{ fontWeight: 600 }}
                    >
                      Add
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

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
              disabled={generating || (!rotating && !v.enabled && vibesOn >= MAX_VIBES)}
              title={
                !rotating && !v.enabled && vibesOn >= MAX_VIBES
                  ? `Up to ${MAX_VIBES} vibes at once; more would cost Anlas (or rotate them, below)`
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
  );

  const artistCard = (
    <ArtistLibraryCard
      value={artists}
      onChange={setArtists}
      family={family}
      disabled={generating}
      hasFolder={cardFolder !== null}
      cardStyle={cardStyle}
      titleStyle={cardTitleStyle}
    />
  );

  const workflowCard = (
    <WorkflowCard
      value={workflow}
      onChange={setWorkflow}
      disabled={generating || (!canGenerate && !planRun)}
      folder={cardFolder}
      run={planRun ? { done: planRun.done, total: planRun.images.length } : null}
      onStart={startPlan}
      onContinue={() => setPlanConfirm({ start: false })}
      onStop={() => {
        setPlanRun(null);
        setBatchNotice("The plan was ended.");
      }}
      cardStyle={cardStyle}
      titleStyle={cardTitleStyle}
    />
  );

  const creepCard = (
    <CreepCard
      value={creep}
      onChange={setCreep}
      disabled={generating}
      maxSteps={MAX_STEPS}
      stepsFixed={modelInfo.fixedSteps !== undefined}
      varietyPlus={varietyOn}
      samplers={SAMPLERS}
      schedules={NOISE_SCHEDULES}
      cardStyle={cardStyle}
      titleStyle={cardTitleStyle}
    />
  );

  const automationCard = (
    <AutomationCard
      value={automation}
      onChange={setAutomation}
      disabled={generating}
      characterCount={characters.length}
      genderPairs={genderPairs}
      onEditPairs={(pairs) => {
        setGenderPairs(pairs);
        if (cardFolder) void saveGenderPairs(cardFolder, pairs).catch((e) => setError(String(e)));
        else setError("Choose a card folder in the Character Cards tab to keep the swap table.");
      }}
      associationCount={cardFolder ? associations.length : null}
      onReloadAssociations={() => void loadLibrary()}
      onApplySwapToForm={applySwapToForm}
      canUndoSwap={swapUndo !== null}
      onUndoSwap={undoSwap}
      cardStyle={cardStyle}
      titleStyle={cardTitleStyle}
    />
  );

  // Pinned to the bottom of the window; the strip under it hides what scrolls past.
  const bottomBar = (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 20,
        marginTop: 16,
        paddingBottom: 12,
        background: "var(--bg-page)",
      }}
    >
      <div
        style={{
          ...cardStyle,
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          boxShadow: "0 -4px 24px rgba(0,0,0,.14)",
        }}
      >
        {remixQueue && (
          <div style={{ ...warningBoxStyle, marginTop: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <strong>Remix of {fileName(remixQueue.folder)}</strong>: {remixQueue.items.length} image
              {remixQueue.items.length === 1 ? "" : "s"}
              {remixQueue.next > 0 && `, ${remixQueue.next} done`}. Each image uses its remixed prompt
              (and its own seed and size where kept) with this tab's other settings.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={requestRemix}
                disabled={!canRemix}
                style={{ ...primaryButtonStyle, opacity: canRemix ? 1 : 0.5, cursor: canRemix ? "pointer" : "default" }}
              >
                Generate {remixQueue.next + 1}–{remixQueue.next + remixBatch.length} of {remixQueue.items.length}
              </button>
              <button onClick={() => setRemixQueue(null)} disabled={generating} style={secondaryButtonStyle}>
                Cancel Remix
              </button>
            </div>
          </div>
        )}
        {batchNotice && <div style={{ ...warningBoxStyle, marginTop: 0 }}>{batchNotice}</div>}
        {/* Why Generate is off, wherever on the page the problem is. */}
        {!generating && (tokenProblem || (sizeIndex === CUSTOM_SIZE && sizeError)) && (
          <div style={{ ...warningBoxStyle, marginTop: 0, fontSize: 12.5 }}>{tokenProblem ?? sizeError}</div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ ...cardTitleStyle, marginBottom: 0, whiteSpace: "nowrap" }}>SAVE TO</span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                fontFamily: "'IBM Plex Mono', monospace",
                color: outputDir ? "var(--text)" : "rgb(200,140,40)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                // keep the end of a long path (the folder's own name) in view
                direction: outputDir ? "rtl" : undefined,
                textAlign: "left",
              }}
              title={outputDir ?? undefined}
            >
              {outputDir ? <bdi>{outputDir}</bdi> : "Choose an output folder first"}
            </span>
            <button
              onClick={() => void chooseOutputDir()}
              disabled={generating}
              style={{ ...secondaryButtonStyle, padding: "6px 14px" }}
            >
              Choose…
            </button>
          </div>
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
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (!generating) showPreview();
            }}
            title="See every image's prompts before anything is sent"
            style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}
          >
            Preview batch
          </a>
          {runEstimate && (
            <span
              title={runEstimate.reasons.join(" ") || "Every image in this run should be free."}
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 12,
                color: runEstimate.free ? "var(--muted)" : "rgb(200,140,40)",
                whiteSpace: "nowrap",
              }}
            >
              {runEstimate.free
                ? "Free"
                : runEstimate.anlas !== null
                  ? `~${(runEstimate.anlas * count).toLocaleString()} Anlas`
                  : "Costs Anlas"}
            </span>
          )}
          {generating ? (
            <button onClick={cancelGenerate} style={{ ...secondaryButtonStyle, minWidth: 130 }}>
              Cancel
            </button>
          ) : (
            <button
              onClick={requestGenerate}
              disabled={!canGenerate}
              title="Ctrl+Enter"
              style={{
                ...primaryButtonStyle,
                minWidth: 130,
                opacity: canGenerate ? 1 : 0.5,
                cursor: canGenerate ? "pointer" : "default",
              }}
            >
              {(count === 1 ? "Generate" : `Generate ${count}`) + (sourceImage ? " from image" : "")}
            </button>
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
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      onKeyDown={(e) => {
        if (phase === "loggedIn" && e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.repeat) {
          e.preventDefault();
          requestGenerate();
        }
      }}
      style={{ padding: "24px 24px 0" }}
    >
      <TagSuggestions root={rootRef} active={active} />
      <div style={{ maxWidth: wide ? 1560 : 760 }}>
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: wide ? "flex-start" : "stretch",
            flexDirection: wide ? "row" : "column",
            marginBottom: 16,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Generate</div>
            <div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
              Text-to-image generation through your NovelAI account, limited to settings that are free on Opus: up
              to 28 steps and 1024×1024 worth of pixels.
            </div>
          </div>
          <div style={{ flex: wide ? "0 1 600px" : undefined, minWidth: 0 }}>
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

                  <AccountBars status={status} />
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

        {phase === "loggedIn" && (
          <>
            {settingsCard}
            {wide ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)",
                  gap: 16,
                  alignItems: "start",
                  marginTop: 16,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {promptCard}
                  {promptFilesCard}
                  {automationCard}
                  {artistCard}
                  {creepCard}
                  {workflowCard}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {charactersCard}
                  {img2imgCard}
                  {referenceCard}
                  {vibesCard}
                  {lastCard}
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
                {promptCard}
                {charactersCard}
                {img2imgCard}
                {referenceCard}
                {promptFilesCard}
                {automationCard}
                {artistCard}
                {creepCard}
                {workflowCard}
                {vibesCard}
                {lastCard}
              </div>
            )}
            {bottomBar}
          </>
        )}
        {phase !== "loggedIn" && lastCard && <div style={{ marginTop: 16 }}>{lastCard}</div>}
      </div>

      {confirmCost && status && (() => {
        const n = confirmCost === "remix" ? remixBatch.length : count;
        return (
        <ConfirmModal
          title={quotaExhausted ? "V5 quota used up" : "This will cost Anlas"}
          message={
            (quotaExhausted
              ? `Your Opus quota for V5 models is used up, so this may cost Anlas. V4.5 models stay free. `
              : !status.isOpus
                ? `Your ${status.tierName} subscription doesn't include free generations. `
                : "") +
            (runEstimate && runEstimate.reasons.length > 0 ? runEstimate.reasons.join(" ") + " " : "") +
            (runEstimate?.anlas
              ? `${n} image${n === 1 ? "" : "s"} × ${runEstimate.anlas} = ${n * runEstimate.anlas} Anlas. `
              : "") +
            `You have ${status.anlas.toLocaleString()} Anlas. Generate ${n === 1 ? "1 image" : `${n} images`}?`
          }
          confirmLabel="Generate"
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmCost(null);
            void runGenerate(confirmCost === "remix");
          }}
          onCancel={() => setConfirmCost(null)}
        />
        );
      })()}

      {modelSwitch && !modelSwitch.choosing && (
        <ConfirmModal
          title={`${modelFamily(modelSwitch.to)} takes ${MODELS.find((m) => m.id === modelSwitch.to)?.maxCharacters ?? 6} characters`}
          message={`There are ${characters.length} characters. Which should stay? The others are set aside until the next generation, so switching back restores them.`}
          confirmLabel={`Keep the first ${MODELS.find((m) => m.id === modelSwitch.to)?.maxCharacters ?? 6}`}
          middleLabel="Choose which"
          cancelLabel={`Stay on ${modelFamily(model)}`}
          onConfirm={() => applyModelSwitch(modelSwitch.keep)}
          onMiddle={() => setModelSwitch({ ...modelSwitch, choosing: true })}
          onCancel={() => setModelSwitch(null)}
        />
      )}
      {modelSwitch && modelSwitch.choosing && (() => {
        const max = MODELS.find((m) => m.id === modelSwitch.to)?.maxCharacters ?? 6;
        const n = modelSwitch.keep.size;
        return (
          <div
            onClick={() => setModelSwitch(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ ...cardStyle, width: 520, maxWidth: "90vw", maxHeight: "80vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ fontSize: 16, fontWeight: 700 }}>Choose {max} characters to keep</div>
              {characters.map((c, i) => (
                <label key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={modelSwitch.keep.has(i)}
                    disabled={!modelSwitch.keep.has(i) && n >= max}
                    onChange={(e) => {
                      const keep = new Set(modelSwitch.keep);
                      if (e.target.checked) keep.add(i);
                      else keep.delete(i);
                      setModelSwitch({ ...modelSwitch, keep });
                    }}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span style={{ fontWeight: 600 }}>{i + 1}.</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cardLinks[i]?.name ?? (c || "(empty)")}
                  </span>
                </label>
              ))}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button onClick={() => setModelSwitch(null)} style={secondaryButtonStyle}>
                  Stay on {modelFamily(model)}
                </button>
                <button onClick={() => applyModelSwitch(modelSwitch.keep)} style={primaryButtonStyle}>
                  Keep {n}, switch
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {director && (
        <DirectorDialog
          path={director.path}
          initialTool={director.tool}
          outputDir={outputDir}
          onDone={(out) => {
            const shown = { path: out.path, seed: lastResult?.seed ?? 0, src: convertFileSrc(out.path) };
            setLastResult(shown);
            setBatchImages((prev) => [...prev, shown]);
            getAccountStatus().then((s) => s && setStatus(s)).catch(() => {});
          }}
          onClose={() => setDirector(null)}
        />
      )}
      {encoding && status && (
        <div
          onClick={() => !encoding.busy && setEncoding(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ ...cardStyle, width: 460, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Encode a vibe</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <img src={convertFileSrc(encoding.path)} alt="" style={{ width: 72, height: 72, objectFit: "contain", borderRadius: 6, background: "var(--bg-page)" }} />
              <div style={{ fontSize: 13, wordBreak: "break-all" }}>{fileName(encoding.path)}</div>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, color: "var(--muted)" }}>Information extracted: {encoding.ie.toFixed(2)}</span>
              <input
                type="range"
                min={0.01}
                max={1}
                step={0.01}
                value={encoding.ie}
                disabled={encoding.busy}
                onChange={(e) => setEncoding({ ...encoding, ie: Number(e.target.value) })}
                style={{ accentColor: "var(--accent)" }}
              />
            </label>
            <div style={{ ...warningBoxStyle, marginTop: 0 }}>
              Encoding costs 2 Anlas (one time) for {modelInfo.label} at {encoding.ie.toFixed(2)}. You have {status.anlas.toLocaleString()} Anlas.
              The result is saved as a .naiv4vibe file and reused after, so the same image, model and setting are never paid for twice.
            </div>
            {encoding.error && <div style={{ fontSize: 12.5, color: "#c9482f" }}>{encoding.error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setEncoding(null)} disabled={encoding.busy} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button onClick={() => void runEncode()} disabled={encoding.busy} style={{ ...primaryButtonStyle, opacity: encoding.busy ? 0.5 : 1 }}>
                {encoding.busy ? "Encoding…" : "Encode (2 Anlas)"}
              </button>
            </div>
          </div>
        </div>
      )}
      {planConfirm && planRun && status && (() => {
        const p = planRun.plan;
        const chunk = chunkImages(p);
        const n = Math.min(planRun.images.length - planRun.done, chunk);
        const upscales = p.steps.filter((x) => x.kind === "upscale").length;
        const directors = p.steps.filter((x) => x.kind === "emotion" || x.kind === "colorize").length;
        const genCost = needsConfirm && runEstimate?.anlas ? runEstimate.anlas * n : 0;
        const lines = [
          planConfirm.start
            ? `${planRun.images.length} images in ${p.sets} set${p.sets === 1 ? "" : "s"} of ${p.loops}, ${chunk} per click.`
            : `Images ${planRun.done + 1}–${planRun.done + n} of ${planRun.images.length}.`,
          `This part: ${n} generation${n === 1 ? "" : "s"}${directors ? `, ${n * directors} Director step${n * directors === 1 ? "" : "s"}` : ""}${upscales ? `, ${n * upscales} upscale${n * upscales === 1 ? "" : "s"} (${n * upscales} Anlas)` : ""}.`,
          needsConfirm ? `Generations ${runEstimate?.anlas ? `cost ${genCost} Anlas` : "cost Anlas"}: ${(runEstimate?.reasons ?? []).join(" ")}` : "Generations are free.",
          directors && !status.isOpus ? "Director steps cost Anlas on this account." : "",
          `You have ${status.anlas.toLocaleString()} Anlas.`,
        ].filter(Boolean);
        return (
          <ConfirmModal
            title={planConfirm.start ? "Start the plan?" : "Run the next part?"}
            message={lines.join(" ")}
            confirmLabel={planConfirm.start ? "Start" : "Continue"}
            cancelLabel="Not now"
            onConfirm={() => void runPlanChunk()}
            onCancel={() => {
              setPlanConfirm(null);
              if (planConfirm.start) setPlanRun(null);
            }}
          />
        );
      })()}
      {showSavedPrompts && cardFolder && (
        <SavedPromptsDialog
          folder={cardFolder}
          current={snapshot()}
          onLoad={startLoadSaved}
          onSaveFromImage={snapshotFromImage}
          onClose={() => setShowSavedPrompts(false)}
        />
      )}
      {previewImages && (
        <BatchPreview
          images={previewImages}
          onClose={() => setPreviewImages(null)}
          onReroll={() => {
            const seed = randomSeed();
            setBatchSeed(seed);
            showPreview(seed);
          }}
        />
      )}
      {editingFile && (
        <PromptFileEditor
          path={editingFile.file.path}
          name={editingFile.file.name}
          initial={editingFile.raw}
          knownNames={new Set(allFiles.map((f) => f.name))}
          loop={loops.get(editingFile.file.name) ?? null}
          onSaved={() => void reloadFile(editingFile.file)}
          onClose={() => setEditingFile(null)}
        />
      )}

      {importPlan && (
        <ImportConfirmModal
          plan={importPlan}
          onConfirm={() => (pendingSnapshot ? applySnapshot(pendingSnapshot) : applyImport(importPlan))}
          onCancel={() => {
            setImportPlan(null);
            setPendingSnapshot(null);
          }}
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
