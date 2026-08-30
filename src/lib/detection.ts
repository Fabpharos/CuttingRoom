import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DetectedBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cls: number;
  conf: number;
};

export type DetectionImage = {
  path: string;
  width: number;
  height: number;
  boxes: DetectedBox[];
};

export type DetectionOutput = {
  classNames: Record<string, string>;
  images: DetectionImage[];
};

export type DetectionProgress = {
  runId: string;
  stage: "loading" | "detecting" | "applying";
  done: number;
  total: number;
};

export async function detectBulkImages(
  runId: string,
  pythonPath: string,
  inputDir: string,
  modelPath: string,
  conf: number,
  onProgress?: (progress: DetectionProgress) => void,
): Promise<DetectionOutput> {
  const unlisten = onProgress
    ? await listen<DetectionProgress>("detection-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    return await invoke("detect_bulk_images", {
      runId,
      pythonPath,
      inputDir,
      modelPath,
      conf,
    });
  } finally {
    unlisten?.();
  }
}

export async function cancelDetection(runId: string): Promise<void> {
  await invoke("cancel_detection", { runId });
}

export type PixelateJob = {
  path: string;
  boxes: { x1: number; y1: number; x2: number; y2: number }[];
};

export async function applyPixelation(
  runId: string,
  jobs: PixelateJob[],
  outputDir: string,
  blockSize: number,
  onProgress?: (progress: DetectionProgress) => void,
): Promise<void> {
  const unlisten = onProgress
    ? await listen<DetectionProgress>("pixelate-progress", (e) => {
        if (e.payload.runId === runId) onProgress(e.payload);
      })
    : undefined;
  try {
    await invoke("apply_pixelation", { runId, jobs, outputDir, blockSize });
  } finally {
    unlisten?.();
  }
}
