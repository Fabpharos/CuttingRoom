// Converts prompts between NovelAI and Anima (ComfyUI) syntax.
//
//                 NovelAI                          Anima
//   weight        1.2::tag::  {tag} x1.05          (tag:1.2)  (tag) x1.1
//                 [tag] /1.05                      [tag] /1.1
//   artist        artist:name                      @name
//   parentheses   stelle (honkai: star rail)       stelle \(honkai: star rail\)
//   characters    separate character prompts       one line each at the end:
//                                                  "1girl: tags." / "name: tags."
//
// Both directions parse into runs of text with a weight, then write the
// other syntax, so nesting and mixed weights carry over as numbers.

import { invoke } from "@tauri-apps/api/core";
import type { ImportedSettings } from "./novelai";

/** The prompt read from an image: NovelAI's settings or a ComfyUI graph's text. */
export type ScannedPrompt =
  | { source: "novelai"; settings: ImportedSettings }
  | { source: "comfyui"; positive: string; negative: string };

export function scanImagePrompt(path: string): Promise<ScannedPrompt> {
  return invoke("scan_image_prompt", { path });
}

/** A NovelAI prompt as settings for the Generate tab; everything else stays as it is there. */
export function toImportedSettings(nai: NaiPrompt): ImportedSettings {
  const characters = nai.characters.filter((c) => c.prompt.trim() !== "");
  return {
    prompt: nai.prompt,
    negativePrompt: nai.negative,
    characters: characters.map((c) => c.prompt),
    characterNegatives: characters.map((c) => c.negative),
    characterPositions: null,
    width: null,
    height: null,
    steps: null,
    scale: null,
    seed: null,
    model: null,
    source: null,
  };
}

export type NaiCharacter = { prompt: string; negative: string };
export type NaiPrompt = { prompt: string; negative: string; characters: NaiCharacter[] };
export type AnimaPrompt = { prompt: string; negative: string };
export type Converted<T> = { result: T; notes: string[] };

type Run = { text: string; weight: number };

const round = (w: number) => Math.round(w * 100) / 100;
const fmt = (w: number) => String(round(w));

// Writes runs, merging neighbours of equal weight and keeping separators
// (commas, spaces) outside the weighted part.
function writeRuns(runs: Run[], weighted: (text: string, weight: string) => string): string {
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && round(last.weight) === round(r.weight)) last.text += r.text;
    else merged.push({ ...r });
  }
  return merged
    .map(({ text, weight }) => {
      if (round(weight) === 1) return text;
      const m = /^([\s,]*)([\s\S]*?)([\s,]*)$/.exec(text)!;
      return m[2] ? `${m[1]}${weighted(m[2], fmt(weight))}${m[3]}` : text;
    })
    .join("");
}

const tidy = (text: string) =>
  text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*,\s*(,\s*)+/g, ", ")
    .replace(/ ,/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "");

// ---- NovelAI -> Anima ----

// NovelAI syntax: `N::text::` (to the end of the prompt if unclosed), {}, [].
function parseNai(text: string): Run[] {
  const runs: Run[] = [];
  let i = 0;
  let base = 1; // from an open N:: group
  let braces = 0;
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ text: buf, weight: base * 1.05 ** braces });
    buf = "";
  };
  while (i < text.length) {
    const num = /^(-?(?:\d+(?:\.\d+)?|\.\d+))::/.exec(text.slice(i));
    if (num && base === 1 && (i === 0 || !/[\w.]/.test(text[i - 1]))) {
      flush();
      base = Number(num[1]);
      i += num[0].length;
    } else if (text.startsWith("::", i) && base !== 1) {
      flush();
      base = 1;
      i += 2;
    } else if (text[i] === "{" || text[i] === "}") {
      flush();
      braces += text[i] === "{" ? 1 : -1;
      i++;
    } else if (text[i] === "[" || text[i] === "]") {
      flush();
      braces += text[i] === "[" ? -1 : 1;
      i++;
    } else {
      buf += text[i++];
    }
  }
  flush();
  return runs;
}

// Tags only NovelAI understands, removed in Anima: "Text:" (writing in the
// image) and `||a|b||` random choices (the first option is kept).
function dropNaiOnly(text: string, notes: Set<string>): string {
  let out = text.replace(/\|\|([^|]*)(?:\|[^|]*)*\|\|/g, (_, first: string) => {
    notes.add("NovelAI random choices (||a|b||) were reduced to their first option.");
    return first;
  });
  out = out
    .split(",")
    .filter((tag) => {
      const drop = /^\s*text\s*:/i.test(tag);
      if (drop) notes.add('NovelAI "Text:" tags were dropped.');
      return !drop;
    })
    .join(",");
  return out;
}

function naiTextToAnima(text: string, notes: Set<string>): string {
  const cleaned = dropNaiOnly(text, notes)
    .replace(/(?<!\\)\(/g, "\\(")
    .replace(/(?<!\\)\)/g, "\\)")
    .replace(/\bartist:\s*/gi, "@");
  return tidy(writeRuns(parseNai(cleaned), (t, w) => `(${t}:${w})`));
}

/** Splits a prompt at commas, keeping `N::…::` groups and brackets whole. */
export function splitTags(text: string): string[] {
  const tags: string[] = [];
  let depth = 0;
  let inGroup = false;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (text.startsWith("::", i)) {
      // "1.2::" opens a weight group, the next "::" closes it.
      inGroup = !inGroup && /(^|[^\w.])-?(\d+(\.\d+)?|\.\d+)$/.test(buf);
      buf += "::";
      i++;
      continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0 && !inGroup) {
      tags.push(buf.trim());
      buf = "";
    } else buf += c;
  }
  tags.push(buf.trim());
  return tags.filter((t) => t !== "");
}

const ACTION = /^(source|target|mutual)#\s*(.+)$/i;
const GENDER = /^1?(girl|boy)$/i;

export function naiToAnima(nai: NaiPrompt): Converted<AnimaPrompt> {
  const notes = new Set<string>();
  const mainTags = splitTags(nai.prompt);
  const mutual: string[] = [];
  // Action tags in the main prompt keep their action without the prefix.
  const main = mainTags.map((t) => {
    const m = ACTION.exec(t);
    if (m) notes.add("NovelAI action prefixes (source#, target#, mutual#) were removed.");
    return m ? m[2] : t;
  });

  const chars = nai.characters
    .filter((c) => c.prompt.trim() !== "")
    .map((c) => {
      const kept: string[] = [];
      for (const tag of splitTags(c.prompt)) {
        const m = ACTION.exec(tag);
        if (!m) kept.push(tag);
        else {
          notes.add("NovelAI action prefixes (source#, target#, mutual#) were removed.");
          const kind = m[1].toLowerCase();
          // The doer keeps the action; the receiver's copy goes; a mutual
          // action belongs to the whole scene.
          if (kind === "source") kept.push(m[2]);
          else if (kind === "mutual" && !mutual.includes(m[2])) mutual.push(m[2]);
        }
      }
      const g = GENDER.exec(kept[0] ?? "");
      return { gender: g ? g[1].toLowerCase() : null, tags: g ? kept.slice(1) : kept, negative: c.negative };
    });

  let lines: string[] = [];
  if (chars.length === 1) {
    // One character: its tags simply join the main prompt.
    main.push(...chars[0].tags);
  } else if (chars.length > 1) {
    const count = (g: string | null) => chars.filter((c) => c.gender === g).length;
    lines = chars.map((c) => {
      const named = c.gender === null || count(c.gender) > 1;
      const label = named ? c.tags[0] ?? "character" : `1${c.gender}`;
      const body = named ? c.tags.slice(1) : c.tags;
      const text = naiTextToAnima(body.join(", "), notes);
      return `${naiTextToAnima(label, notes)}:${text ? ` ${text}` : ""}.`;
    });
  }
  main.push(...mutual);

  const prompt = [naiTextToAnima(main.join(", "), notes), ...lines].filter((l) => l !== "").join("\n");
  const negatives = [nai.negative, ...chars.map((c) => c.negative)].filter((n) => n.trim() !== "");
  if (chars.some((c) => c.negative.trim() !== "")) notes.add("Each character's undesired content was merged into the negative prompt.");
  return { result: { prompt, negative: naiTextToAnima(negatives.join(", "), notes) }, notes: [...notes] };
}

// ---- Anima -> NovelAI ----

// Anima (A1111/ComfyUI) syntax: (text:w), (text) x1.1, [text] /1.1, \( \)
// literal. Scheduling and alternation ([a:b:0.5], [a|b]) have no NovelAI
// equivalent: their options are all kept, at the surrounding weight.
function parseAnima(text: string, notes: Set<string>): Run[] {
  let i = 0;
  function group(weight: number, close: string | null): Run[] {
    const runs: Run[] = [];
    let buf = "";
    const flush = () => {
      if (buf) runs.push({ text: buf, weight });
      buf = "";
    };
    while (i < text.length) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length) {
        buf += text[i + 1];
        i += 2;
      } else if (c === "(" || c === "[") {
        flush();
        i++;
        const inner = group(weight, c === "(" ? ")" : "]");
        const joined = inner.map((r) => r.text).join("");
        const explicit = /:\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/.exec(inner[inner.length - 1]?.text ?? "");
        if (c === "[" && (joined.includes("|") || explicit)) {
          notes.add("Anima prompt scheduling and alternation ([a:b:0.5], [a|b]) have no NovelAI equivalent; all their options were kept.");
          const options = joined.replace(/:\s*-?\d*\.?\d+\s*$/, "").split(/[|:]/).filter((o) => o.trim() !== "");
          runs.push({ text: options.join(", "), weight });
        } else if (explicit) {
          const last = inner[inner.length - 1];
          last.text = last.text.slice(0, explicit.index);
          runs.push(...inner.map((r) => ({ text: r.text, weight: r.weight * Number(explicit[1]) })));
        } else {
          const f = c === "(" ? 1.1 : 1 / 1.1;
          runs.push(...inner.map((r) => ({ text: r.text, weight: r.weight * f })));
        }
      } else if (close && c === close) {
        i++;
        flush();
        return runs;
      } else {
        buf += c;
        i++;
      }
    }
    flush();
    return runs;
  }
  return group(1, null);
}

function animaTextToNai(text: string, notes: Set<string>): string {
  const nai = writeRuns(parseAnima(text, notes), (t, w) => `${w}::${t}::`);
  return tidy(nai.replace(/(^|[\s,{[]|::)@\s*/g, "$1artist:"));
}

// A character line: "label: tags." where the label has no commas outside
// escaped parentheses ("stelle \(honkai: star rail\): …").
function characterLine(line: string): { label: string; body: string } | null {
  const trimmed = line.trim();
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    // Escaped parentheses count too: the colon in "\(honkai: star rail\)"
    // is part of the name.
    const c = trimmed[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) return null;
    else if (c === ":" && depth === 0) {
      const label = trimmed.slice(0, i).trim();
      if (!label) return null;
      return { label, body: trimmed.slice(i + 1).trim().replace(/\.\s*$/, "") };
    }
  }
  return null;
}

export function animaToNai(anima: AnimaPrompt): Converted<NaiPrompt> {
  const notes = new Set<string>();
  const mainLines: string[] = [];
  const found: { label: string; body: string }[] = [];
  anima.prompt.split(/\r?\n/).forEach((line, index) => {
    const c = index > 0 ? characterLine(line) : null;
    if (c) found.push(c);
    else if (line.trim()) mainLines.push(line.trim().replace(/,\s*$/, ""));
  });
  const main = mainLines.join(", ");
  // A named line's gender comes from the count tags: "2girls" alone means
  // the named characters are girls; with both or neither, it's left out.
  const plural = (g: string) => new RegExp(`(^|[,\\s])\\d+${g}s\\b`, "i").test(main);
  const namedGender = plural("girl") && !plural("boy") ? "girl" : plural("boy") && !plural("girl") ? "boy" : null;
  const characters = found.map(({ label, body }) => {
    const g = /^1(girl|boy)$/i.exec(label);
    const head = g ? [g[1].toLowerCase()] : [namedGender ?? "", animaTextToNai(label, notes)];
    const prompt = [...head, animaTextToNai(body, notes)].filter((p) => p !== "").join(", ");
    return { prompt, negative: "" };
  });
  if (characters.some((c) => !/^(girl|boy)\b/.test(c.prompt))) {
    notes.add("Some characters' gender couldn't be told from the count tags; add girl or boy to them.");
  }
  if (characters.length > 0) notes.add("Anima has one negative prompt, so it all went to the main undesired content.");
  return {
    result: { prompt: animaTextToNai(main, notes), negative: animaTextToNai(anima.negative, notes), characters },
    notes: [...notes],
  };
}
