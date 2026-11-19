import { invoke } from "@tauri-apps/api/core";

// Director tools (Emotion, Colorize) through NovelAI; see
// crates/novelai-core/src/director.rs.

export const EMOTIONS = [
  "neutral", "happy", "sad", "angry", "scared", "surprised", "tired", "excited", "nervous", "thinking", "confused",
  "shy", "disgusted", "smug", "bored", "laughing", "irritated", "aroused", "embarrassed", "worried", "love",
  "determined", "hurt", "playful",
] as const;

/** NovelAI's strength levels, from defry 0 to 5. */
export const DEFRY_LABELS = ["Normal", "Slightly weak", "Weak", "Even weaker", "Very weak", "Weakest"];

export type DirectorTool = "emotion" | "colorize";
export type Area = { x: number; y: number; width: number; height: number };

export type DirectorRequest = {
  path: string;
  tool: DirectorTool;
  emotion: string;
  prompt: string;
  defry: number;
  area: Area | null;
};

export type DirectorPlan = {
  imageWidth: number;
  imageHeight: number;
  area: Area;
  sendWidth: number;
  sendHeight: number;
  scaled: boolean;
};

export type DirectorOutcome = { path: string; plan: DirectorPlan; anlasWarning: string | null };

export function planDirector(request: DirectorRequest): Promise<DirectorPlan> {
  return invoke("nai_plan_director", { request });
}

export function runDirector(runId: string, request: DirectorRequest, outputDir: string, guardAnlas: boolean): Promise<DirectorOutcome> {
  return invoke("nai_run_director", { runId, request, outputDir, guardAnlas });
}
