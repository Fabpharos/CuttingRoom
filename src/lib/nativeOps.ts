import { invoke } from "@tauri-apps/api/core";

export async function copyFilesToClipboard(paths: string[]): Promise<void> {
  await invoke("copy_files_to_clipboard", { paths });
}

export async function moveFilesToTrash(paths: string[]): Promise<void> {
  await invoke("move_files_to_trash", { paths });
}
