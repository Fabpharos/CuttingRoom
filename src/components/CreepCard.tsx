import HelpTip from "./HelpTip";
import { CONTROL_HELP } from "../lib/syntaxHelp";
import type { CreepSettings, ListCreep, NumberCreep, SeedCreep } from "../lib/creep";

const sel: React.CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 12,
};
const num = (w = 64): React.CSSProperties => ({ ...sel, width: w, fontFamily: "'IBM Plex Mono', monospace" });
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)", minWidth: 96 };

function NumberRow({
  name,
  c,
  onChange,
  disabled,
  limit,
  unit,
}: {
  name: string;
  c: NumberCreep;
  onChange: (c: NumberCreep) => void;
  disabled: boolean;
  limit: string;
  unit: number;
}) {
  const field = (k: "from" | "to" | "step", title: string) => (
    <input
      type="number"
      step={unit}
      value={c[k]}
      title={title}
      disabled={disabled}
      onChange={(e) => onChange({ ...c, [k]: Number(e.target.value) })}
      style={num()}
    />
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
      <span style={label}>{name}</span>
      <select value={c.mode} disabled={disabled} onChange={(e) => onChange({ ...c, mode: e.target.value as NumberCreep["mode"] })} style={sel}>
        <option value="fixed">Fixed (the form's)</option>
        <option value="step">Step</option>
        <option value="random">Random in range</option>
      </select>
      {c.mode === "step" && (
        <>
          from {field("from", "First value")} by {field("step", "Added each time")} to {field("to", "Last value")}
          <select value={c.atMax} disabled={disabled} onChange={(e) => onChange({ ...c, atMax: e.target.value as NumberCreep["atMax"] })} style={sel}>
            <option value="wrap">then wrap</option>
            <option value="hold">then hold</option>
            <option value="stop">then stop the batch</option>
          </select>
        </>
      )}
      {c.mode === "random" && (
        <>
          {field("from", "Low end")} to {field("to", "High end")}
        </>
      )}
      {c.mode !== "fixed" && (
        <>
          every
          <input
            type="number"
            min={1}
            value={c.every}
            disabled={disabled}
            onChange={(e) => onChange({ ...c, every: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
            style={num(48)}
          />
          images
          <span style={{ color: "var(--muted)" }}>({limit})</span>
        </>
      )}
    </div>
  );
}

function ListRow({
  name,
  c,
  options,
  onChange,
  disabled,
}: {
  name: string;
  c: ListCreep;
  options: { id: string; label: string }[];
  onChange: (c: ListCreep) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
      <span style={label}>{name}</span>
      <select value={c.mode} disabled={disabled} onChange={(e) => onChange({ ...c, mode: e.target.value as ListCreep["mode"] })} style={sel}>
        <option value="fixed">Fixed (the form's)</option>
        <option value="cycle">Cycle through</option>
        <option value="random">Random from</option>
      </select>
      {c.mode !== "fixed" && (
        <>
          {options.map((o) => (
            <label key={o.id} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <input
                type="checkbox"
                checked={c.values.includes(o.id)}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...c, values: e.target.checked ? [...c.values, o.id] : c.values.filter((v) => v !== o.id) })
                }
                style={{ accentColor: "var(--accent)" }}
              />
              {o.label}
            </label>
          ))}
          every
          <input
            type="number"
            min={1}
            value={c.every}
            disabled={disabled}
            onChange={(e) => onChange({ ...c, every: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
            style={num(48)}
          />
          images
        </>
      )}
    </div>
  );
}

/** Seed, steps, guidance, Variety+, sampler and schedule changing through a batch. */
export default function CreepCard({
  value,
  onChange,
  disabled,
  maxSteps,
  stepsFixed,
  varietyPlus,
  samplers,
  schedules,
  cardStyle,
  titleStyle,
}: {
  value: CreepSettings;
  onChange: (v: CreepSettings) => void;
  disabled: boolean;
  maxSteps: number;
  stepsFixed: boolean;
  varietyPlus: boolean;
  samplers: { id: string; label: string }[];
  schedules: { id: string; label: string }[];
  cardStyle: React.CSSProperties;
  titleStyle: React.CSSProperties;
}) {
  const set = <K extends keyof CreepSettings>(k: K, v: CreepSettings[K]) => onChange({ ...value, [k]: v });
  const seed = value.seed;
  const setSeed = (c: Partial<SeedCreep>) => set("seed", { ...seed, ...c });
  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ ...titleStyle, marginBottom: 0, flex: 1 }}>
          PARAMETER CREEP
          <HelpTip
            lines={[
              { text: CONTROL_HELP.creep },
              { text: "Free limits always win: steps stay at 28 or fewer (Medium Effort stays at 14) and guidance at 10 or less." },
              { text: "Every image's values show in Preview batch, and NovelAI writes them into each image." },
            ]}
          />
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={disabled}
            onChange={(e) => set("enabled", e.target.checked)}
            style={{ accentColor: "var(--accent)" }}
          />
          On
        </label>
      </div>
      {value.enabled && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
            <span style={label}>Seed</span>
            <select value={seed.mode} disabled={disabled} onChange={(e) => setSeed({ mode: e.target.value as SeedCreep["mode"] })} style={sel}>
              <option value="random">Random</option>
              <option value="fixed">Fixed</option>
              <option value="step">Step from</option>
            </select>
            {seed.mode !== "random" && (
              <input
                type="number"
                min={0}
                max={4294967295}
                value={seed.base}
                disabled={disabled}
                onChange={(e) => setSeed({ base: Math.max(0, Math.min(4294967295, Math.round(Number(e.target.value)) || 0)) })}
                style={num(110)}
              />
            )}
            {seed.mode === "step" && (
              <>
                by
                <input type="number" value={seed.step} disabled={disabled} onChange={(e) => setSeed({ step: Math.round(Number(e.target.value)) || 0 })} style={num(56)} />
                every
                <input
                  type="number"
                  min={1}
                  value={seed.every}
                  disabled={disabled}
                  onChange={(e) => setSeed({ every: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                  style={num(48)}
                />
                images
              </>
            )}
            <span style={{ color: "var(--muted)" }}>(a Remix image that kept its seed keeps it)</span>
          </div>
          {stepsFixed ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Steps: fixed for this model.</div>
          ) : (
            <NumberRow name="Steps" c={value.steps} onChange={(c) => set("steps", c)} disabled={disabled} limit={`capped at ${maxSteps}`} unit={1} />
          )}
          <NumberRow name="Guidance" c={value.guidance} onChange={(c) => set("guidance", c)} disabled={disabled} limit="0–10" unit={0.1} />
          {varietyPlus && (
            <NumberRow name="Variety+ value" c={value.sigma} onChange={(c) => set("sigma", c)} disabled={disabled} limit="skip_cfg_above_sigma" unit={0.5} />
          )}
          <ListRow name="Sampler" c={value.sampler} options={samplers} onChange={(c) => set("sampler", c)} disabled={disabled} />
          <ListRow name="Noise schedule" c={value.schedule} options={schedules} onChange={(c) => set("schedule", c)} disabled={disabled} />
        </>
      )}
    </div>
  );
}
