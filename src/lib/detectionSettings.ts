import { LazyStore } from "@tauri-apps/plugin-store";

export type DetectionSettings = {
  pythonPath: string;
  modelsFolder: string;
  selectedModel: string;
  conf: number;
  blockSize: number;
};

const DEFAULTS: DetectionSettings = {
  pythonPath: "",
  modelsFolder: "",
  selectedModel: "",
  conf: 0.3,
  blockSize: 20,
};

const store = new LazyStore("detection-settings.json");

export async function loadDetectionSettings(): Promise<DetectionSettings> {
  const saved = await store.get<Partial<DetectionSettings>>("settings");
  return { ...DEFAULTS, ...saved };
}

export async function saveDetectionSettings(settings: DetectionSettings): Promise<void> {
  await store.set("settings", settings);
}
