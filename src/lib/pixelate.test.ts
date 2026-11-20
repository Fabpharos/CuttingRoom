import { test } from "node:test";
import assert from "node:assert/strict";
import { clampCell, pixelate, saveFormat } from "./pixelate";

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4);
  return d;
}

test("each cell takes its average colour, on a grid from the top-left", () => {
  // 4×2: left half black, right half white; cells of 2 keep them apart.
  const src = image(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const out = pixelate(src, 4, 2, 2);
  assert.deepEqual([...out.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...out.slice(12, 16)], [255, 255, 255, 255]);
  // Cells of 4 mix them.
  const mixed = pixelate(src, 4, 2, 4);
  assert.deepEqual([...mixed.slice(0, 4)], [128, 128, 128, 255]);
});

test("partial cells at the edges are averaged over what's there", () => {
  const src = image(3, 1, (x) => (x === 2 ? [90, 90, 90, 255] : [0, 0, 0, 255]));
  const out = pixelate(src, 3, 1, 2);
  assert.deepEqual([...out.slice(8, 12)], [90, 90, 90, 255]);
});

test("transparent pixels don't darken a cell", () => {
  const src = image(2, 1, (x) => (x === 0 ? [200, 100, 50, 255] : [0, 0, 0, 0]));
  const out = pixelate(src, 2, 1, 2);
  assert.deepEqual([...out.slice(0, 4)], [200, 100, 50, 128]);
});

test("cell sizes are clamped", () => {
  assert.equal(clampCell(0), 2);
  assert.equal(clampCell(1000), 100);
  assert.equal(clampCell(7.4), 7);
});

test("save formats keep the file's own where possible", () => {
  assert.deepEqual(saveFormat("a.JPG"), { ext: "jpg", mime: "image/jpeg", canOverwrite: true });
  assert.deepEqual(saveFormat("a.png"), { ext: "png", mime: "image/png", canOverwrite: true });
  assert.deepEqual(saveFormat("a.gif"), { ext: "png", mime: "image/png", canOverwrite: false });
});
