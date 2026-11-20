import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { clampCell } from "./pixelate";

export type EditTool = "brush" | "lasso";

export type EditSettings = {
  tool: EditTool;
  /** Brush diameter in image pixels. */
  brushSize: number;
  /** Pixelate cell size in image pixels. */
  pixelSize: number;
  /** Tint the selection so it shows even where pixelating changes little. */
  highlight: boolean;
  recentFolders: string[];
};

export const MIN_BRUSH = 2;
export const MAX_BRUSH = 500;

export const DEFAULT_EDIT_SETTINGS: EditSettings = { tool: "brush", brushSize: 60, pixelSize: 12, highlight: true, recentFolders: [] };

const store = new LazyStore("edit-settings.json");

export async function loadEditSettings(): Promise<EditSettings> {
  const saved = (await store.get<Partial<EditSettings>>("settings")) ?? {};
  const s = { ...DEFAULT_EDIT_SETTINGS, ...saved };
  return {
    tool: s.tool === "lasso" ? "lasso" : "brush",
    brushSize: Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, Math.round(Number(s.brushSize)) || DEFAULT_EDIT_SETTINGS.brushSize)),
    pixelSize: clampCell(Number(s.pixelSize) || DEFAULT_EDIT_SETTINGS.pixelSize),
    highlight: s.highlight !== false,
    recentFolders: Array.isArray(s.recentFolders) ? s.recentFolders.filter((f): f is string => typeof f === "string").slice(0, 8) : [],
  };
}

export async function saveEditSettings(settings: EditSettings): Promise<void> {
  await store.set("settings", settings);
}

/**
 * Writes an edited image: a new `<name>_edited` file next to `path`, or —
 * with `overwrite` — `path` itself after the original has gone to the
 * Recycle Bin. Returns the path written.
 */
export async function saveEditedImage(path: string, ext: string, overwrite: boolean, data: Uint8Array): Promise<string> {
  return invoke<string>("edit_save_image", data, {
    headers: { "x-path": encodeURIComponent(path), "x-ext": ext, "x-overwrite": overwrite ? "1" : "0" },
  });
}
