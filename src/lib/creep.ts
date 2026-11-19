// Parameter creep: a setting that changes a little from image to image.
// Each image's values are worked out when the batch is built, so they show
// in the preview (and NovelAI writes them into each PNG's metadata).

import type { Rng } from "./promptEngine";

export type NumberCreep = {
  mode: "fixed" | "step" | "random";
  /** Step: the first value. Random: the low end. */
  from: number;
  /** Step: added each time. */
  step: number;
  /** Step: the last value. Random: the high end. */
  to: number;
  /** A new value every this many images. */
  every: number;
  /** Step past `to`: start again from `from`, stop the batch, or stay at `to`. */
  atMax: "wrap" | "stop" | "hold";
};

export type ListCreep = {
  mode: "fixed" | "cycle" | "random";
  values: string[];
  every: number;
};

export type SeedCreep = {
  mode: "random" | "fixed" | "step";
  base: number;
  step: number;
  every: number;
};

export type CreepSettings = {
  enabled: boolean;
  seed: SeedCreep;
  steps: NumberCreep;
  guidance: NumberCreep;
  /** Variety+'s value (only when Variety+ is on). */
  sigma: NumberCreep;
  sampler: ListCreep;
  schedule: ListCreep;
};

const fixedNumber = (from: number, to: number, step: number): NumberCreep => ({ mode: "fixed", from, step, to, every: 1, atMax: "hold" });

export const DEFAULT_CREEP: CreepSettings = {
  enabled: false,
  seed: { mode: "random", base: 0, step: 1, every: 1 },
  steps: fixedNumber(20, 28, 2),
  guidance: fixedNumber(4, 7, 0.5),
  sigma: fixedNumber(40, 70, 5),
  sampler: { mode: "fixed", values: [], every: 1 },
  schedule: { mode: "fixed", values: [], every: 1 },
};

/** Limits a value must stay within; the creep is capped, never the rule. */
export type Limits = { min: number; max: number; decimals: number };

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The value for image `index`, or `stop` when a step creep with "stop" has
 * run past its end (the batch ends before this image). `capped` says the
 * free limits cut the value.
 */
export function numberAt(
  c: NumberCreep,
  index: number,
  rng: Rng,
  current: number,
  limits: Limits,
): { value: number; stop: boolean; capped: boolean } {
  const clamp = (v: number) => {
    const out = Math.min(limits.max, Math.max(limits.min, round(v, limits.decimals)));
    return { value: out, capped: out !== round(v, limits.decimals) };
  };
  if (c.mode === "fixed") return { ...clamp(current), stop: false, capped: false };
  const group = Math.floor(index / Math.max(1, c.every));
  if (c.mode === "random") {
    const lo = Math.min(c.from, c.to);
    const hi = Math.max(c.from, c.to);
    const unit = 10 ** -limits.decimals;
    const v = lo + Math.floor(rng() * (Math.round((hi - lo) / unit) + 1)) * unit;
    return { ...clamp(v), stop: false };
  }
  const step = c.step === 0 ? 0 : c.step;
  let v = c.from + step * group;
  const past = step >= 0 ? v > c.to + 1e-9 : v < c.to - 1e-9;
  if (past) {
    if (c.atMax === "stop") return { value: c.to, stop: true, capped: false };
    if (c.atMax === "hold") v = c.to;
    else {
      const span = Math.floor((c.to - c.from) / (step || 1)) + 1;
      v = c.from + step * (group % Math.max(1, span));
    }
  }
  return { ...clamp(v), stop: false };
}

/** A list setting's value for image `index` (null: keep the form's). */
export function listAt(c: ListCreep, index: number, rng: Rng): string | null {
  const values = c.values.filter(Boolean);
  if (c.mode === "fixed" || values.length === 0) return null;
  const group = Math.floor(index / Math.max(1, c.every));
  return c.mode === "cycle" ? values[group % values.length] : values[Math.floor(rng() * values.length)];
}

/** The seed for image `index`; `random` is the batch's own pick. */
export function seedAt(c: SeedCreep, index: number, random: number): number {
  if (c.mode === "random") return random;
  if (c.mode === "fixed") return c.base >>> 0;
  const group = Math.floor(index / Math.max(1, c.every));
  return (c.base + c.step * group) >>> 0;
}

function parseNumber(raw: unknown, d: NumberCreep): NumberCreep {
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  return {
    mode: r.mode === "step" || r.mode === "random" ? r.mode : "fixed",
    from: num(r.from, d.from),
    step: num(r.step, d.step),
    to: num(r.to, d.to),
    every: Math.max(1, Math.min(1000, Math.round(num(r.every, 1)))),
    atMax: r.atMax === "wrap" || r.atMax === "stop" ? r.atMax : "hold",
  };
}

function parseList(raw: unknown, allowed: string[]): ListCreep {
  if (typeof raw !== "object" || raw === null) return { mode: "fixed", values: [], every: 1 };
  const r = raw as Record<string, unknown>;
  return {
    mode: r.mode === "cycle" || r.mode === "random" ? r.mode : "fixed",
    values: Array.isArray(r.values) ? r.values.filter((v): v is string => typeof v === "string" && allowed.includes(v)) : [],
    every: typeof r.every === "number" && r.every >= 1 ? Math.min(1000, Math.round(r.every)) : 1,
  };
}

export function parseCreep(raw: unknown, samplers: string[], schedules: string[]): CreepSettings {
  const d = DEFAULT_CREEP;
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const sd = (r.seed ?? {}) as Record<string, unknown>;
  const n = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  return {
    enabled: r.enabled === true,
    seed: {
      mode: sd.mode === "fixed" || sd.mode === "step" ? sd.mode : "random",
      base: Math.max(0, Math.min(0xffff_ffff, Math.round(n(sd.base, 0)))),
      step: Math.round(n(sd.step, 1)),
      every: Math.max(1, Math.round(n(sd.every, 1))),
    },
    steps: parseNumber(r.steps, d.steps),
    guidance: parseNumber(r.guidance, d.guidance),
    sigma: parseNumber(r.sigma, d.sigma),
    sampler: parseList(r.sampler, samplers),
    schedule: parseList(r.schedule, schedules),
  };
}
