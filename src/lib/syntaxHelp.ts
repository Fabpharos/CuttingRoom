// The help shown on each prompt box's circled question mark. Kept in one
// place so a syntax change updates every tooltip; a test checks that every
// syntax the prompt engine reads is described here.

import type { HelpLine } from "../components/HelpTip";

export type SyntaxKey =
  | "__name__"
  | "__folder/name__"
  | "__name:part__"
  | "__name!__"
  | "%3 line"
  | "0.6~1.4::tag::"
  | "1.2::tag::"
  | "$c1$"
  | "$c1 has tag: tags$"
  | "$c1 lacks tag: tags$"
  | "$any has tag: tags$"
  | "$c1 swap: tag$"
  | "!tag"
  | "text: …";

export const SYNTAX_HELP: Record<SyntaxKey, HelpLine> = {
  "__name__": {
    syntax: "__name__",
    text: "A line from the prompt file `name`. One pick per image: the same file gives the same line everywhere in that image.",
  },
  "__folder/name__": { syntax: "__folder/name__", text: "A file in a subfolder of the wildcards folder." },
  "__name:part__": { syntax: "__name:part__", text: "One part of a paired file's entry, e.g. __scenes:girl__." },
  "__name!__": { syntax: "__name!__", text: "A separate pick each time it appears (__colour!__ shirt, __colour!__ skirt)." },
  "%3 line": {
    syntax: "%3 line",
    text: "In a prompt file: this line is picked 3 times as often as a line with no weight (random mode only).",
  },
  "0.6~1.4::tag::": { syntax: "0.6~1.4::tag::", text: "A random strength between 0.6 and 1.4 for each image. Works on groups too." },
  "1.2::tag::": { syntax: "1.2::tag::", text: "NovelAI's normal tag strength, for reference." },
  "$c1$": { syntax: "$c1$", text: "The name of the card in character slot 1 (c1–c22 on V5, c1–c6 on V4/V4.5)." },
  "$c1 has tag: tags$": { syntax: "$c1 has male: shorts$", text: "Adds the tags only if character 1 has that tag." },
  "$c1 lacks tag: tags$": { syntax: "$c1 lacks glasses: …$", text: "Adds the tags only if character 1 doesn't have that tag." },
  "$any has tag: tags$": { syntax: "$any has … / $all has …", text: "Checks every character slot: any of them, or all of them." },
  "$c1 swap: tag$": { syntax: "$c1 swap: boy$", text: "Swaps the tag using character 1's card swap rules; kept as is without one." },
  "!tag": {
    syntax: "!tag",
    text: "Protects the tag: associations and gender swap leave it alone. The ! isn't sent.",
  },
  "text: …": { syntax: "text: …", text: "NovelAI's text in the image; always moved to the end." },
};

export type HelpBox = "prompt" | "negative" | "character" | "characterNegative" | "promptFiles" | "remix";

const BOXES: Record<HelpBox, SyntaxKey[]> = {
  prompt: [
    "__name__",
    "__folder/name__",
    "__name:part__",
    "__name!__",
    "0.6~1.4::tag::",
    "1.2::tag::",
    "$c1$",
    "$c1 has tag: tags$",
    "$c1 lacks tag: tags$",
    "$any has tag: tags$",
    "$c1 swap: tag$",
    "!tag",
    "text: …",
  ],
  negative: ["__name__", "__folder/name__", "__name!__", "0.6~1.4::tag::", "1.2::tag::", "$c1 has tag: tags$", "$any has tag: tags$", "!tag"],
  character: [
    "__name__",
    "__name:part__",
    "__name!__",
    "0.6~1.4::tag::",
    "1.2::tag::",
    "$c1$",
    "$c1 has tag: tags$",
    "$c1 lacks tag: tags$",
    "$any has tag: tags$",
    "$c1 swap: tag$",
    "!tag",
  ],
  characterNegative: ["__name__", "__name!__", "0.6~1.4::tag::", "1.2::tag::", "$c1 has tag: tags$", "!tag"],
  promptFiles: ["__name__", "__folder/name__", "__name:part__", "__name!__", "%3 line"],
  remix: ["__name__", "__name!__", "0.6~1.4::tag::", "1.2::tag::", "!tag"],
};

/** The help lines for one kind of box. */
export function helpFor(box: HelpBox): HelpLine[] {
  return BOXES[box].map((k) => SYNTAX_HELP[k]);
}

/** One-line help for the automation controls. */
export const CONTROL_HELP = {
  scramble: "Shuffles each image's tags. The first few tags, sentences, weighted groups and text: stay where they are.",
  genderSwap: "Swaps gendered tags (1girl ↔ 1boy, girl ↔ boy …) from the swap table, for this batch or in the form.",
  associations: "Rules from Character Cards → Tag associations: when a tag is present, add tags or put a character in.",
  wholeFolder: "Every .txt in the folder (and its subfolders) can be used without adding it first; subfolders are written __folder/name__.",
  creep: "Changes a setting a little from image to image: a step each time, a random value in a range, or through a list.",
  varietyPlus: "Skips guidance in the first, noisiest steps, so images vary more in composition. Free.",
} as const;
