import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReferences } from "./generateSettings";
import { maxReferenceStrength, referenceKinds, takesPreferSameOutfit } from "./novelai";

test("saved references are read, clamped and given defaults", () => {
  const refs = parseReferences([
    { path: "a.png", kind: "outfit", strength: 9, fidelity: 0.4, preferSameOutfit: true },
    { path: "b.png", kind: "nonsense" },
    { kind: "style" },
  ]);
  assert.deepEqual(refs, [
    { path: "a.png", kind: "outfit", strength: 5, fidelity: 0.4, preferSameOutfit: true },
    { path: "b.png", kind: "style", strength: 1, fidelity: 1, preferSameOutfit: false },
  ]);
  assert.deepEqual(parseReferences(null), []);
});

test("outfit references, strength above 1 and Prefer same outfit are V5 only", () => {
  assert.ok(referenceKinds("nai-diffusion-5-curated").includes("outfit"));
  assert.ok(!referenceKinds("nai-diffusion-4-5-full").includes("outfit"));
  assert.equal(maxReferenceStrength("nai-diffusion-5-full"), 5);
  assert.equal(maxReferenceStrength("nai-diffusion-4-5-full"), 1);
  assert.ok(takesPreferSameOutfit("nai-diffusion-5-full", "character"));
  // NovelAI records Character & Style the same with or without it.
  assert.ok(!takesPreferSameOutfit("nai-diffusion-5-full", "character&style"));
  assert.ok(!takesPreferSameOutfit("nai-diffusion-5-full", "outfit"));
  assert.ok(!takesPreferSameOutfit("nai-diffusion-4-5-full", "character"));
});
