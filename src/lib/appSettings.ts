import { LazyStore } from "@tauri-apps/plugin-store";

// Small app-wide preferences that don't belong to any one tab.
const store = new LazyStore("app-settings.json");

const LAST_TAB_KEY = "lastTab";

export async function loadLastTab(): Promise<string | null> {
  const v = await store.get<unknown>(LAST_TAB_KEY);
  return typeof v === "string" ? v : null;
}

export async function saveLastTab(tab: string): Promise<void> {
  await store.set(LAST_TAB_KEY, tab);
  await store.save();
}
