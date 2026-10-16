import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export async function copyFilesToClipboard(paths: string[]): Promise<void> {
  await invoke("copy_files_to_clipboard", { paths });
}

export async function moveFilesToTrash(paths: string[]): Promise<void> {
  await invoke("move_files_to_trash", { paths });
}

export async function revealFilesInExplorer(paths: string[]): Promise<void> {
  await revealItemInDir(paths);
}

// Sizes in bytes, index-aligned with `paths`; a file that can't be read
// reports 0 rather than failing the whole batch.
export async function getFileSizes(paths: string[]): Promise<number[]> {
  return invoke("get_file_sizes", { paths });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
