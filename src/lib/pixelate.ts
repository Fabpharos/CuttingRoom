// Pixelation for the Edit tab, the way Paint.NET's Pixelate effect works:
// the image is cut into square cells on a grid starting at its top-left
// corner, and every pixel takes its cell's average colour. Pure, so it can be
// unit-tested; the editor shows the result only inside the selection.

/** The smallest and largest cell size the settings allow, in image pixels. */
export const MIN_CELL = 2;
export const MAX_CELL = 100;

export function clampCell(n: number): number {
  return Math.min(MAX_CELL, Math.max(MIN_CELL, Math.round(n) || MIN_CELL));
}

/**
 * The whole image pixelated with `cell`-pixel cells (RGBA, row-major).
 * Colours are averaged by alpha, so transparent pixels don't darken a cell;
 * the cell's alpha is the plain average.
 */
export function pixelate(src: Uint8ClampedArray, width: number, height: number, cell: number): Uint8ClampedArray<ArrayBuffer> {
  const size = clampCell(cell);
  const out = new Uint8ClampedArray(src.length);
  for (let y0 = 0; y0 < height; y0 += size) {
    const y1 = Math.min(height, y0 + size);
    for (let x0 = 0; x0 < width; x0 += size) {
      const x1 = Math.min(width, x0 + size);
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const al = src[i + 3];
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      const cr = a ? r / a : 0;
      const cg = a ? g / a : 0;
      const cb = a ? b / a : 0;
      const ca = a / count;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          out[i] = cr;
          out[i + 1] = cg;
          out[i + 2] = cb;
          out[i + 3] = ca;
        }
      }
    }
  }
  return out;
}

/** How an edited image is saved: its own format when the browser can write it, else PNG. */
export function saveFormat(fileName: string): { ext: string; mime: string; canOverwrite: boolean } {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return { ext, mime: "image/jpeg", canOverwrite: true };
  if (ext === "webp") return { ext, mime: "image/webp", canOverwrite: true };
  return { ext: "png", mime: "image/png", canOverwrite: ext === "png" };
}
