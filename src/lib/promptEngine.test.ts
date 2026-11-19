import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildImage,
  cleanUp,
  DEFAULT_ENGINE_SETTINGS,
  findLoops,
  hasTag,
  isTagLike,
  normalizeTag,
  randomWeights,
  scramble,
  seededRng,
  splitSegments,
  swapGender,
  type EngineFile,
  type EngineSettings,
  type ImageContext,
  type Slot,
} from "./promptEngine";
import { parseEntries, weightedIndex } from "./promptFile";
import { tokensIn, folderTokenName } from "./promptTokens";
import { DEFAULT_GENDER_PAIRS, type Association } from "./library";
import type { CardLink } from "./characterCards";

const file = (name: string, lines: string[], mode: "random" | "sequential" = "random", position = 0): EngineFile => {
  const e = parseEntries(lines);
  return { name, ...e, mode, position };
};

const slot = (text: string, link: CardLink | null = null, negative = ""): Slot => ({
  text,
  negative,
  position: { x: 0.5, y: 0.5 },
  link,
  present: true,
});

function ctx(files: EngineFile[], over: Partial<EngineSettings> = {}, index = 0, extra: Partial<ImageContext> = {}): ImageContext {
  return {
    index,
    rng: seededRng(42 + index),
    files: new Map(files.map((f) => [f.name, f])),
    maxSlots: 22,
    settings: { ...DEFAULT_ENGINE_SETTINGS, ...over },
    ...extra,
  };
}

const card = (name: string, tags: [string, string][], extra: Partial<CardLink> = {}): CardLink => ({
  name,
  tags: tags.map(([text, part]) => ({ text, part: part as never })),
  ...extra,
});

// ---- segments ----

test("splits at top-level commas only", () => {
  assert.deepEqual(splitSegments("a, 1.2::b, c::, {d, e}, $c1 has x: y, z$, f").map((s) => s.trim()), [
    "a",
    "1.2::b, c::",
    "{d, e}",
    "$c1 has x: y, z$",
    "f",
  ]);
  assert.deepEqual(splitSegments("0.6~1.4::red dress, frills::, x").map((s) => s.trim()), ["0.6~1.4::red dress, frills::", "x"]);
  assert.deepEqual(splitSegments("artist:foo, bar").map((s) => s.trim()), ["artist:foo", "bar"]);
});

test("normalizes and tells tags from sentences", () => {
  assert.equal(normalizeTag("1.2::Long_Hair::"), "long hair");
  assert.equal(normalizeTag("!glasses"), "glasses");
  assert.ok(isTagLike("red dress"));
  assert.ok(!isTagLike("A girl stands on the beach."));
  assert.ok(!isTagLike("she looks at the sea while the sun sets slowly"));
  assert.ok(!isTagLike("text: Hello"));
});

// ---- tokens ----

test("tokens: one pick per file per image, nesting, separate picks", () => {
  const colour = file("colour", ["red", "blue", "green", "white"]);
  const outfit = file("outfit", ["__colour__ dress"]);
  const out = buildImage({ prompt: "__outfit__, __colour__ eyes", negative: "", slots: [] }, ctx([colour, outfit]));
  const m = /^(\w+) dress, (\w+) eyes$/.exec(out.prompt);
  assert.ok(m, out.prompt);
  assert.equal(m![1], m![2], "the same file gives the same line everywhere in an image");
  assert.deepEqual([...out.usedFiles].sort(), ["colour", "outfit"]);

  // "!" picks again at each place; over many images they differ at least once.
  let differed = false;
  for (let i = 0; i < 20; i++) {
    const o = buildImage({ prompt: "__colour!__ shirt, __colour!__ skirt", negative: "", slots: [] }, ctx([colour], {}, i));
    const [a, b] = o.prompt.split(", ").map((x) => x.split(" ")[0]);
    if (a !== b) differed = true;
  }
  assert.ok(differed);
});

test("tokens: sequential files follow the image index; loops stay as typed", () => {
  const seq = file("seq", ["one", "two", "three"], "sequential", 1);
  const outs = [0, 1, 2].map((i) => buildImage({ prompt: "__seq__", negative: "", slots: [] }, ctx([seq], {}, i)).prompt);
  assert.deepEqual(outs, ["two", "three", "one"]);

  const a = file("a", ["x __b__"]);
  const b = file("b", ["y __a__"]);
  assert.deepEqual([...findLoops([a, b]).keys()].sort(), ["a", "b"]);
  const out = buildImage({ prompt: "__a__", negative: "", slots: [] }, ctx([a, b]));
  assert.equal(out.prompt, "x y __a__");
  assert.ok(out.warnings.length > 0);
});

test("tokens: folder names and weights", () => {
  assert.equal(folderTokenName("Outfits/Summer Day"), "outfits/summer-day");
  assert.deepEqual(tokensIn("__outfits/summer-day__, __colour!__"), ["outfits/summer-day", "colour"]);
  const e = parseEntries(["school uniform", "%3 casual clothes", "swimsuit"]);
  assert.deepEqual(e.lines, ["school uniform", "casual clothes", "swimsuit"]);
  assert.deepEqual(e.weights, [1, 3, 1]);
  const rng = seededRng(7);
  const counts = [0, 0, 0];
  for (let i = 0; i < 5000; i++) counts[weightedIndex(3, rng, e.weights)]++;
  assert.ok(counts[1] > counts[0] * 2.4 && counts[1] < counts[0] * 3.6, String(counts));
});

test("tokens: a character whose paired part is missing sits out", () => {
  const pair = file("scene", ["beach", "girl: swimsuit", "park"]);
  const outs = [0, 1].map((i) =>
    buildImage({ prompt: "__scene__", negative: "", slots: [slot("girl, __scene:girl__")] }, { ...ctx([{ ...pair, mode: "sequential" }], {}, i) }),
  );
  assert.equal(outs[0].slots[0].present, true);
  assert.equal(outs[0].slots[0].text, "girl, swimsuit");
  assert.equal(outs[1].slots[0].present, false);
});

// ---- slots ----

test("slot names and conditionals", () => {
  const hiro = card("Hiro", [["1boy", "other"], ["male", "other"]], { swaps: [{ from: "boy", to: "man" }] });
  const input = {
    prompt: "$c1$ and $c2$, $c1 has male: shorts, underwear peek$, $c2 lacks glasses: looking over eyewear$, $any has male: tall$, $all has male: crowd$, $c1 swap: boy$, $c9$",
    negative: "",
    slots: [slot("1boy, 1.2::Male::", hiro), slot("1girl, glasses")],
  };
  const out = buildImage(input, ctx([], {}, 0, { maxSlots: 6 }));
  assert.equal(out.prompt, "Hiro and, shorts, underwear peek, tall, man, $c9$");
  assert.ok(out.warnings.some((w) => w.includes("$c9$")));
  // $c12$ is slot 12, not slot 1 followed by "2".
  const many = Array.from({ length: 12 }, (_, i) => slot(`x${i}`, i === 11 ? card("Twelve", []) : null));
  assert.equal(buildImage({ prompt: "$c12$", negative: "", slots: many }, ctx([])).prompt, "Twelve");
});

// ---- gender swap ----

test("gender swap: whole tags, directions, protection, pronouns", () => {
  const pairs = DEFAULT_GENDER_PAIRS;
  const all = { mode: "all" as const, slot: 1, pronouns: false, pairs };
  assert.equal(swapGender("1girl, 1boy, girlfriend, multiple_girls, cute girl", all), "1boy, 1girl, girlfriend, multiple_boys, cute boy");
  assert.equal(swapGender("1girl, 1boy", { ...all, mode: "girlsToBoys" }), "1boy, 1boy");
  assert.equal(swapGender("!1girl, 1girl", all), "!1girl, 1boy");
  assert.equal(swapGender("She smiles at her friend.", all), "She smiles at her friend.");
  assert.equal(swapGender("She smiles at her friend.", { ...all, pronouns: true }), "He smiles at his friend.");
  const out = buildImage(
    { prompt: "2girls", negative: "", slots: [slot("girl, red hair"), slot("girl, blue hair")] },
    ctx([], { genderSwap: { mode: "slot", slot: 2, pronouns: false, pairs } }),
  );
  assert.deepEqual(out.slots.map((s) => s.text), ["girl, red hair", "boy, blue hair"]);
  assert.equal(out.prompt, "2girls");
});

// ---- associations ----

test("associations add tags, respect unless, labels and protection", () => {
  const rules: Association[] = [
    { id: "1", enabled: true, when: "beach", scope: "any", label: "", unless: "indoors", action: { kind: "tags", tags: "ocean, sand", target: "positive", weight: 1, removeTrigger: false } },
    { id: "2", enabled: true, when: "wings", scope: "characters", label: "angel", unless: "", action: { kind: "tags", tags: "feathers", target: "positive", weight: 1.2, removeTrigger: false } },
    { id: "3", enabled: true, when: "blood", scope: "main", label: "", unless: "", action: { kind: "tags", tags: "gore", target: "negative", weight: 1, removeTrigger: true } },
  ];
  const angel = card("Ana", [["wings", "upperBody"]], { labels: ["angel"] });
  const out = buildImage(
    { prompt: "beach, blood", negative: "lowres", slots: [slot("wings", angel), slot("wings")] },
    ctx([], { associations: rules }),
  );
  assert.equal(out.prompt, "beach, ocean, sand");
  assert.equal(out.negative, "lowres, gore");
  assert.deepEqual(out.slots.map((s) => s.text), ["wings, 1.2::feathers::", "wings"]);
  assert.equal(buildImage({ prompt: "beach, indoors", negative: "", slots: [] }, ctx([], { associations: rules })).prompt, "beach, indoors");
  assert.equal(buildImage({ prompt: "!beach", negative: "", slots: [] }, ctx([], { associations: rules })).prompt, "beach");
});

test("associations can put a character in the first empty slot, per image", () => {
  const hiro = card("Hiro", [["1boy", "other"], ["black hair", "hair"]], { gender: "male", negative: "girl" });
  const rule: Association = {
    id: "c",
    enabled: true,
    when: "1boy",
    scope: "main",
    label: "",
    unless: "",
    action: { kind: "character", card: { mode: "named", name: "Hiro" }, slot: "firstEmpty", skipIfGender: "male", position: null },
  };
  const scene = file("scene", ["1girl, solo", "1girl, 1boy"], "sequential");
  const outs = [0, 1].map((i) =>
    buildImage({ prompt: "__scene__", negative: "", slots: [slot("1girl, red hair")] }, ctx([scene], { associations: [rule] }, i, { pickCard: () => hiro })),
  );
  assert.equal(outs[0].slots.length, 1);
  assert.equal(outs[1].slots.length, 2);
  assert.equal(outs[1].slots[1].text, "1boy, black hair");
  assert.equal(outs[1].slots[1].negative, "girl");
  // Not when a boy's card is already there.
  const already = buildImage(
    { prompt: "1boy", negative: "", slots: [slot("1boy", hiro)] },
    ctx([], { associations: [rule] }, 0, { pickCard: () => hiro }),
  );
  assert.equal(already.slots.length, 1);
  // No room: noted, not added.
  const full = buildImage(
    { prompt: "1boy", negative: "", slots: [slot("a"), slot("b")] },
    ctx([], { associations: [{ ...rule, action: { ...rule.action, skipIfGender: null } as Association["action"] }] }, 0, { pickCard: () => hiro, maxSlots: 2 }),
  );
  assert.equal(full.slots.length, 2);
  assert.ok(full.log.some((l) => l.includes("no free")));
});

test("view tags still filter carded characters after the other passes", () => {
  const ana = card("Ana", [["1girl", "other"], ["blue eyes", "eyes"], ["smile", "face"], ["red dress", "upperBody"]]);
  const out = buildImage({ prompt: "from behind", negative: "", slots: [slot("1girl, blue eyes, smile, red dress", ana)] }, ctx([]));
  assert.equal(out.slots[0].text, "1girl, red dress");
});

// ---- weights, scramble, clean-up ----

test("random weights land in range on the step", () => {
  const rng = seededRng(1);
  for (let i = 0; i < 200; i++) {
    const out = randomWeights("0.6~1.4::red dress, frills::", rng, 0.05);
    const v = Number(/^([\d.]+)::/.exec(out)![1]);
    assert.ok(v >= 0.6 && v <= 1.4, out);
    assert.ok(Math.abs(v * 20 - Math.round(v * 20)) < 1e-9, out);
    assert.ok(out.endsWith("::red dress, frills::"));
  }
});

test("scramble keeps the first tags, sentences and text: in place", () => {
  const rng = seededRng(3);
  const text = "1girl, a, b, c, d, e, A girl waves at the camera., text: hi";
  const out = scramble(text, 1, rng).split(", ");
  assert.equal(out[0], "1girl");
  assert.equal(out[6], "A girl waves at the camera.");
  assert.equal(out[7], "text: hi");
  assert.deepEqual(out.slice(1, 6).sort(), ["a", "b", "c", "d", "e"]);
});

test("clean-up drops empties, unprotects and moves text: last, else leaves the text alone", () => {
  assert.equal(cleanUp("a, , !b, text: hi, c"), "a, b, c, text: hi");
  assert.equal(cleanUp("a,b"), "a,b");
  assert.equal(cleanUp("!?, !, solo"), "!?, !, solo");
  assert.ok(hasTag("1.1::glasses::", "glasses"));
});

test("a whole batch is the same when built twice", () => {
  const colour = file("colour", ["red", "blue", "green"]);
  const build = () =>
    Array.from({ length: 5 }, (_, i) =>
      buildImage({ prompt: "__colour__, 0.5~1.5::x::", negative: "", slots: [] }, ctx([colour], { scramble: { ...DEFAULT_ENGINE_SETTINGS.scramble, main: true } }, i)).prompt,
    );
  assert.deepEqual(build(), build());
});

// ---- help ----

import { ENGINE_SYNTAX } from "./promptEngine";
import { SYNTAX_HELP } from "./syntaxHelp";

test("every syntax the engine reads has help", () => {
  for (const key of ENGINE_SYNTAX) {
    assert.ok(key in SYNTAX_HELP, `no help for ${key}`);
  }
});
