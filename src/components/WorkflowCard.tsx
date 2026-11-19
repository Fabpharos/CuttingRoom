import { useEffect, useState } from "react";
import HelpTip from "./HelpTip";
import { EMOTIONS, DEFRY_LABELS } from "../lib/director";
import { libraryFileName, listLibrary, readLibrary, writeLibrary } from "../lib/library";

/** What happens to each generated image, in order. */
export type PlanStep =
  | { kind: "emotion"; emotion: string; prompt: string; defry: number }
  | { kind: "colorize"; prompt: string; defry: number }
  | { kind: "upscale" }
  | { kind: "strip" };

export type WorkflowPlan = {
  name: string;
  /** Images per set. */
  loops: number;
  /** How many sets. */
  sets: number;
  /** What moves on once per set rather than once per image. */
  perSet: { characters: boolean; artists: boolean; vibes: boolean; files: boolean };
  steps: PlanStep[];
  /** Subfolders of the output folder: none, one per set, or one per character card. */
  subfolders: "none" | "set" | "character";
};

export const DEFAULT_PLAN: WorkflowPlan = {
  name: "",
  loops: 10,
  sets: 1,
  perSet: { characters: true, artists: true, vibes: true, files: true },
  steps: [],
  subfolders: "set",
};

export function parsePlan(raw: unknown): WorkflowPlan {
  if (typeof raw !== "object" || raw === null) return DEFAULT_PLAN;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, f: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : f);
  const ps = (r.perSet ?? {}) as Record<string, unknown>;
  const steps = (Array.isArray(r.steps) ? r.steps : []).flatMap((x): PlanStep[] => {
    const o = x as Record<string, unknown> | null;
    if (!o) return [];
    const defry = int(o.defry, 0, 5, 0);
    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    if (o.kind === "emotion" && typeof o.emotion === "string" && (EMOTIONS as readonly string[]).includes(o.emotion))
      return [{ kind: "emotion", emotion: o.emotion, prompt, defry }];
    if (o.kind === "colorize") return [{ kind: "colorize", prompt, defry }];
    if (o.kind === "upscale") return [{ kind: "upscale" }];
    if (o.kind === "strip") return [{ kind: "strip" }];
    return [];
  });
  return {
    name: typeof r.name === "string" ? r.name : "",
    loops: int(r.loops, 1, 1000, 10),
    sets: int(r.sets, 1, 1000, 1),
    perSet: { characters: ps.characters !== false, artists: ps.artists !== false, vibes: ps.vibes !== false, files: ps.files !== false },
    steps,
    subfolders: r.subfolders === "none" || r.subfolders === "character" ? r.subfolders : "set",
  };
}

/** Requests one image makes: the generation plus each step. */
export const requestsPerImage = (p: WorkflowPlan) => 1 + p.steps.length;
/** At most 25 requests per click; at most 10 upscales, like the Upscale tab. */
export function chunkImages(p: WorkflowPlan): number {
  const byRequests = Math.max(1, Math.floor(25 / requestsPerImage(p)));
  return p.steps.some((s) => s.kind === "upscale") ? Math.min(byRequests, 10) : byRequests;
}

const sel: React.CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12,
};
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };

/**
 * A workflow plan: sets of images from the form, then steps for each image
 * (Emotion, Colorize, Upscale, Strip metadata). It runs at most 25 requests
 * per click and waits for Continue, so a person starts every part of it.
 */
export default function WorkflowCard({
  value,
  onChange,
  disabled,
  folder,
  run,
  onStart,
  onContinue,
  onStop,
  cardStyle,
  titleStyle,
}: {
  value: WorkflowPlan;
  onChange: (p: WorkflowPlan) => void;
  disabled: boolean;
  /** The library (card) folder plans are saved in. */
  folder: string | null;
  /** The plan being run: images done of the total. */
  run: { done: number; total: number } | null;
  onStart: () => void;
  onContinue: () => void;
  onStop: () => void;
  cardStyle: React.CSSProperties;
  titleStyle: React.CSSProperties;
}) {
  const [saved, setSaved] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const set = (c: Partial<WorkflowPlan>) => onChange({ ...value, ...c });
  const total = value.loops * value.sets;
  const perImage = requestsPerImage(value);
  const upscales = value.steps.filter((s) => s.kind === "upscale").length;
  const chunk = chunkImages(value);

  useEffect(() => {
    if (!folder) return;
    listLibrary(folder, "plans")
      .then((n) => setSaved(n.map((x) => x.replace(/\.json$/, ""))))
      .catch(() => setSaved([]));
  }, [folder, message]);

  function updateStep(i: number, s: PlanStep) {
    set({ steps: value.steps.map((x, j) => (j === i ? s : x)) });
  }

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...titleStyle, marginBottom: 0 }}>
        WORKFLOW PLAN
        <HelpTip
          lines={[
            { text: "Sets × images per set from this form (\"10 images of each of 6 characters\": 10 per set, 6 sets, characters moving on once per set)." },
            { text: "Then each image goes through the steps in order; each step works on the previous step's result, saved as a new file." },
            { text: "It runs at most 25 requests per click and waits for Continue, so you start every part. Upscale costs 1 Anlas per image and is confirmed each time." },
          ]}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={label}>Sets</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={value.sets}
          disabled={disabled}
          onChange={(e) => set({ sets: Math.max(1, Math.min(1000, Math.round(Number(e.target.value)) || 1)) })}
          style={{ ...sel, width: 56 }}
        />
        <span style={label}>× images per set</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={value.loops}
          disabled={disabled}
          onChange={(e) => set({ loops: Math.max(1, Math.min(1000, Math.round(Number(e.target.value)) || 1)) })}
          style={{ ...sel, width: 56 }}
        />
        <span style={{ color: "var(--muted)" }}>= {total} images</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
        <span style={label}>Once per set:</span>
        {(
          [
            ["characters", "characters"],
            ["artists", "artists"],
            ["vibes", "vibes"],
            ["files", "prompt files"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={value.perSet[k]}
              disabled={disabled}
              onChange={(e) => set({ perSet: { ...value.perSet, [k]: e.target.checked } })}
              style={{ accentColor: "var(--accent)" }}
            />
            {l}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={label}>Then, for each image</span>
        {value.steps.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>No steps: just the images.</span>}
        {value.steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ fontWeight: 700 }}>{i + 1}.</span>
            {s.kind === "emotion" && (
              <>
                Emotion
                <select value={s.emotion} disabled={disabled} onChange={(e) => updateStep(i, { ...s, emotion: e.target.value })} style={sel}>
                  {EMOTIONS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </>
            )}
            {s.kind === "colorize" && <>Colorize</>}
            {(s.kind === "emotion" || s.kind === "colorize") && (
              <>
                <input
                  value={s.prompt}
                  disabled={disabled}
                  placeholder={s.kind === "emotion" ? "extra tags" : "prompt"}
                  onChange={(e) => updateStep(i, { ...s, prompt: e.target.value })}
                  style={{ ...sel, width: 140 }}
                />
                <select value={s.defry} disabled={disabled} onChange={(e) => updateStep(i, { ...s, defry: Number(e.target.value) })} style={sel}>
                  {DEFRY_LABELS.map((l, d) => (
                    <option key={d} value={d}>
                      {l}
                    </option>
                  ))}
                </select>
              </>
            )}
            {s.kind === "upscale" && <span>Upscale ×2 (1 Anlas each)</span>}
            {s.kind === "strip" && <span>Strip metadata (removes the prompt from the final file)</span>}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!disabled) set({ steps: value.steps.filter((_, j) => j !== i) });
              }}
              style={{ fontWeight: 600, marginLeft: "auto" }}
            >
              Remove
            </a>
          </div>
        ))}
        <div style={{ display: "flex", gap: 10, fontSize: 12.5 }}>
          {(
            [
              ["emotion", "+ Emotion"],
              ["colorize", "+ Colorize"],
              ["upscale", "+ Upscale"],
              ["strip", "+ Strip metadata"],
            ] as const
          ).map(([k, l]) => (
            <a
              key={k}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (disabled) return;
                const step: PlanStep =
                  k === "emotion"
                    ? { kind: "emotion", emotion: "happy", prompt: "", defry: 0 }
                    : k === "colorize"
                      ? { kind: "colorize", prompt: "", defry: 0 }
                      : { kind: k };
                set({ steps: [...value.steps, step] });
              }}
              style={{ fontWeight: 600 }}
            >
              {l}
            </a>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={label}>Save into</span>
        <select value={value.subfolders} disabled={disabled} onChange={(e) => set({ subfolders: e.target.value as WorkflowPlan["subfolders"] })} style={sel}>
          <option value="none">the output folder</option>
          <option value="set">a subfolder per set</option>
          <option value="character">a subfolder per character card</option>
        </select>
        <span style={{ color: "var(--muted)" }}>(under a dated folder for the run)</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        {total} images × {perImage} request{perImage === 1 ? "" : "s"} = {total * perImage} requests, {chunk} image{chunk === 1 ? "" : "s"} per click
        {upscales > 0 && <span style={{ color: "rgb(200,140,40)" }}> · upscaling costs {total * upscales} Anlas in all</span>}.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {run ? (
          <>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>
              {run.done} of {run.total} done
            </span>
            <button
              disabled={disabled || run.done >= run.total}
              onClick={onContinue}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                border: "none",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                fontWeight: 600,
                cursor: "pointer",
                opacity: disabled ? 0.5 : 1,
              }}
            >
              Continue: images {run.done + 1}–{Math.min(run.total, run.done + chunk)}
            </button>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!disabled) onStop();
              }}
              style={{ fontSize: 12.5, fontWeight: 600 }}
            >
              End the plan
            </a>
          </>
        ) : (
          <button
            disabled={disabled}
            onClick={onStart}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              fontWeight: 600,
              cursor: "pointer",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            Start plan…
          </button>
        )}
        <span style={{ flex: 1 }} />
        {folder && (
          <>
            <input value={value.name} disabled={disabled} placeholder="plan name" onChange={(e) => set({ name: e.target.value })} style={{ ...sel, width: 120 }} />
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!value.name.trim() || disabled) return;
                void writeLibrary(folder, "plans", libraryFileName(value.name), { version: 1, ...value }).then(
                  () => setMessage(`Saved “${value.name.trim()}”.`),
                  (err) => setMessage(String(err)),
                );
              }}
              style={{ fontSize: 12.5, fontWeight: 600 }}
            >
              Save
            </a>
            {saved.length > 0 && (
              <select
                value=""
                disabled={disabled}
                onChange={(e) => {
                  const n = e.target.value;
                  if (!n) return;
                  void readLibrary(folder, "plans", `${n}.json`).then((raw) => onChange({ ...parsePlan(raw), name: n }), (err) => setMessage(String(err)));
                }}
                style={sel}
              >
                <option value="">Load…</option>
                {saved.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      {message && <div style={{ fontSize: 12, color: "var(--muted)" }}>{message}</div>}
    </div>
  );
}
