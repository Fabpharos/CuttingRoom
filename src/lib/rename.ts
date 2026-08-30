import { rename as fsRename } from "@tauri-apps/plugin-fs";
import { dirname, join } from "@tauri-apps/api/path";
import { extensionOf } from "./images";

export async function renameFolder(folderPath: string, newName: string): Promise<string> {
  const parent = await dirname(folderPath);
  const newPath = await join(parent, newName);
  await fsRename(folderPath, newPath);
  return newPath;
}

export type PhotoRenamePlan = { oldName: string; newName: string };

export function buildRenamePlan(albumName: string, orderedNames: string[]): PhotoRenamePlan[] {
  return orderedNames.map((oldName, i) => ({
    oldName,
    newName: `${albumName} (${i + 1})${extensionOf(oldName)}`,
  }));
}

// Renamed in two passes (old -> temp -> new) so that a target name matching
// another photo's current name never overwrites it mid-sequence.
export async function renamePhotos(
  folderPath: string,
  plan: PhotoRenamePlan[],
): Promise<void> {
  const tempNames = plan.map((_, i) => `.__contact_tmp_${Date.now()}_${i}`);

  for (let i = 0; i < plan.length; i++) {
    await fsRename(
      await join(folderPath, plan[i].oldName),
      await join(folderPath, tempNames[i]),
    );
  }
  for (let i = 0; i < plan.length; i++) {
    await fsRename(
      await join(folderPath, tempNames[i]),
      await join(folderPath, plan[i].newName),
    );
  }
}
