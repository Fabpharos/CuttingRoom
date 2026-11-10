import { LazyStore } from "@tauri-apps/plugin-store";

export type AlbumData = {
  name: string;
  order: string[];
  tags: Record<string, boolean>;
  favorites: Record<string, boolean>;
};

const store = new LazyStore("albums.json");

// Written to disk on every change rather than left to the plugin's
// auto-save: album order, tags and recent folders were found unsaved for
// months while the other settings files kept updating.
async function persist() {
  await store.save();
}

export async function loadAlbum(folderPath: string): Promise<AlbumData | undefined> {
  return store.get<AlbumData>(folderPath);
}

export async function saveAlbum(folderPath: string, data: AlbumData): Promise<void> {
  await store.set(folderPath, data);
  await persist();
}

export async function moveAlbum(oldFolderPath: string, newFolderPath: string): Promise<void> {
  const data = await store.get<AlbumData>(oldFolderPath);
  if (data) {
    await store.delete(oldFolderPath);
    await store.set(newFolderPath, data);
    await persist();
  }
}

// Keyed separately from per-folder album entries so it can't collide with a
// real folder path.
const RECENT_KEY = "__recent__";
const MAX_RECENT = 5;

export async function getRecentFolders(): Promise<string[]> {
  return (await store.get<string[]>(RECENT_KEY)) ?? [];
}

export async function addRecentFolder(path: string): Promise<string[]> {
  const current = await getRecentFolders();
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT);
  await store.set(RECENT_KEY, next);
  await persist();
  return next;
}

// A folder rename doesn't lose its "recent" standing — it just moves under
// its new path.
export async function renameRecentFolder(oldPath: string, newPath: string): Promise<string[]> {
  const current = await getRecentFolders();
  const next = [newPath, ...current.filter((p) => p !== oldPath && p !== newPath)].slice(
    0,
    MAX_RECENT,
  );
  await store.set(RECENT_KEY, next);
  await persist();
  return next;
}

export async function removeRecentFolder(path: string): Promise<string[]> {
  const current = await getRecentFolders();
  const next = current.filter((p) => p !== path);
  await store.set(RECENT_KEY, next);
  await persist();
  return next;
}
