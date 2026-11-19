import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CREEP, listAt, numberAt, seedAt, type NumberCreep } from "./creep";
import { seededRng } from "./promptEngine";
import { advancedState, cardForImage, poolCards, type SlotAdvance } from "./characterPool";
import type { CardFile } from "./characterCards";

const steps = { min: 1, max: 28, decimals: 0 };

test("step creep: every N, wrap, hold, stop, and the free limit", () => {
  const c: NumberCreep = { mode: "step", from: 20, step: 2, to: 26, every: 2, atMax: "wrap" };
  const rng = seededRng(1);
  const vals = Array.from({ length: 10 }, (_, i) => numberAt(c, i, rng, 28, steps).value);
  assert.deepEqual(vals, [20, 20, 22, 22, 24, 24, 26, 26, 20, 20]);
  assert.equal(numberAt({ ...c, atMax: "hold" }, 9, rng, 28, steps).value, 26);
  assert.equal(numberAt({ ...c, atMax: "stop" }, 8, rng, 28, steps).stop, true);
  const over = numberAt({ ...c, from: 26, to: 40, every: 1 }, 3, rng, 28, steps);
  assert.equal(over.value, 28);
  assert.equal(over.capped, true);
});

test("random creep stays in range on the unit", () => {
  const rng = seededRng(5);
  for (let i = 0; i < 200; i++) {
    const v = numberAt({ mode: "random", from: 4, to: 7, step: 0, every: 1, atMax: "hold" }, i, rng, 5, { min: 0, max: 10, decimals: 1 }).value;
    assert.ok(v >= 4 && v <= 7 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, String(v));
  }
});

test("fixed keeps the form's value; lists cycle; seeds step", () => {
  assert.equal(numberAt(DEFAULT_CREEP.steps, 3, seededRng(1), 23, steps).value, 23);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => listAt({ mode: "cycle", values: ["a", "b"], every: 2 }, i, seededRng(1))),
    ["a", "a", "b", "b", "a"],
  );
  assert.equal(listAt({ mode: "fixed", values: ["a"], every: 1 }, 0, seededRng(1)), null);
  assert.deepEqual([0, 1, 2].map((i) => seedAt({ mode: "step", base: 100, step: 5, every: 1 }, i, 7)), [100, 105, 110]);
  assert.equal(seedAt({ mode: "random", base: 0, step: 1, every: 1 }, 2, 7), 7);
  assert.equal(seedAt({ mode: "step", base: 0xffff_ffff, step: 1, every: 1 }, 1, 0), 0);
});

const cardFile = (name: string, labels: string[], gender: "female" | "male" | "other" = "female"): CardFile => ({
  path: `C:/cards/${name}.png`,
  card: { version: 2, name, tags: [{ text: name.toLowerCase(), part: "other" }], negative: "", gender, labels, swaps: [], reference: null },
});

test("character pools: filters, next every N, shuffle without repeats", () => {
  const cards = [cardFile("Ana", ["oc"]), cardFile("Bo", ["oc", "pokemon"], "male"), cardFile("Cy", ["pokemon"]), cardFile("Di", ["oc", "nsfw-only"])];
  assert.deepEqual(poolCards(cards, { include: "oc", exclude: "nsfw-only", matchAll: false, gender: null }).map((c) => c.card.name), ["Ana", "Bo"]);
  assert.deepEqual(poolCards(cards, { include: "oc, pokemon", exclude: "", matchAll: true, gender: null }).map((c) => c.card.name), ["Bo"]);
  assert.deepEqual(poolCards(cards, { include: "", exclude: "", matchAll: false, gender: "male" }).map((c) => c.card.name), ["Bo"]);

  const next: SlotAdvance = { mode: "next", pool: { include: "", exclude: "", matchAll: false, gender: null }, every: 5 };
  const names = Array.from({ length: 25 }, (_, i) => cardForImage(next, cards, { position: 0, seed: 1 }, i, () => seededRng(1))!.card.name);
  assert.deepEqual([...new Set(names)], ["Ana", "Bo", "Cy", "Di"]);
  assert.equal(names.filter((n) => n === "Ana").length, 10);
  assert.deepEqual(advancedState(next, { position: 0, seed: 1 }, 25), { position: 5, seed: 1 });

  const shuffle: SlotAdvance = { ...next, mode: "shuffle", every: 1 };
  const firstRound = Array.from({ length: 4 }, (_, i) => cardForImage(shuffle, cards, { position: 0, seed: 9 }, i, () => seededRng(1))!.card.name);
  assert.equal(new Set(firstRound).size, 4);
});
