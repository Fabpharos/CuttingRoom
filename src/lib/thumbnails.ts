import { readFile } from "@tauri-apps/plugin-fs";

const THUMB_MAX_EDGE = 320;

// Decoding and repainting full-resolution photos on every hover/drag frame is
// what made the grid laggy — this downscales each image once (via the
// browser's native decode+resize path) and caches a small object URL per
// absolute file path, so the DOM only ever holds cheap-to-paint thumbnails.
const cache = new Map<string, Promise<string>>();

async function generate(path: string): Promise<string> {
  const bytes = await readFile(path);
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: THUMB_MAX_EDGE,
    resizeQuality: "medium",
  });

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const thumbBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("thumbnail encode failed"))),
      "image/jpeg",
      0.82,
    );
  });

  return URL.createObjectURL(thumbBlob);
}

export function getThumbnailUrl(path: string): Promise<string> {
  let entry = cache.get(path);
  if (!entry) {
    entry = generate(path);
    cache.set(path, entry);
  }
  return entry;
}

// A folder/photo rename doesn't change the image bytes, just its path — move
// the cached thumbnail rather than re-reading and re-decoding the file.
//
// Takes the whole batch of moves at once rather than one pair at a time: a
// reorder-then-rename can produce a genuine swap (one photo's new path is
// another photo's old path), and applying moves one at a time would let a
// later move silently overwrite or delete an earlier one's freshly-written
// entry before it's ever read back out. Reading every old entry first, then
// writing every new one, makes the whole batch atomic with respect to that
// collision.
export function moveThumbnailCache(pairs: { oldPath: string; newPath: string }[]): void {
  const carried = pairs.map(({ oldPath }) => cache.get(oldPath));
  for (const { oldPath } of pairs) {
    cache.delete(oldPath);
  }
  pairs.forEach(({ newPath }, i) => {
    const entry = carried[i];
    if (entry) cache.set(newPath, entry);
  });
}
