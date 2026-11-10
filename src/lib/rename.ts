import { readDir, rename as fsRename } from "@tauri-apps/plugin-fs";
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

/** Marks the temporary names a rename uses, so leftovers can be recognised. */
export const TEMP_MARKER = ".__cutting_room_tmp_";
/** The temporary names older versions used (no extension, so hidden from the album). */
export const LEGACY_TEMP_MARKER = ".__contact_tmp_";

/**
 * A temporary name that still ends in the photo's own name (and so its
 * extension): if a rename is ever interrupted, the file still opens and
 * shows up in the album, and the original name can be read off it.
 */
function tempName(stamp: number, i: number, oldName: string) {
  return `${TEMP_MARKER}${stamp}_${i}__${oldName}`;
}

export class RenameError extends Error {}

/**
 * Renames every photo in `plan`, or none of them.
 *
 * Checks first that every photo is still there and that no new name belongs
 * to a file outside the plan, so nothing starts when it can't finish. Then
 * renames in two passes (old -> temp -> new) so a new name matching another
 * photo's current name never overwrites it mid-sequence. If any step still
 * fails, everything already renamed is put back.
 */
export async function renamePhotos(folderPath: string, plan: PhotoRenamePlan[]): Promise<void> {
  // Windows names are case-insensitive.
  const key = (n: string) => n.toLowerCase();
  const present = new Set(
    (await readDir(folderPath)).filter((e) => e.isFile).map((e) => key(e.name)),
  );
  const missing = plan.filter((p) => !present.has(key(p.oldName))).map((p) => p.oldName);
  if (missing.length > 0) {
    const list = missing.slice(0, 5).join(", ") + (missing.length > 5 ? `, and ${missing.length - 5} more` : "");
    throw new RenameError(
      `${missing.length === 1 ? "A photo is" : `${missing.length} photos are`} no longer in the folder (${list}). ` +
        "Nothing was renamed. Press Refresh to drop missing photos from the album, then rename again.",
    );
  }
  const planned = new Set(plan.map((p) => key(p.oldName)));
  const clashes = plan.filter((p) => present.has(key(p.newName)) && !planned.has(key(p.newName)));
  if (clashes.length > 0) {
    throw new RenameError(
      `${clashes[0].newName} already belongs to a file that isn't in this album, so it would be overwritten. ` +
        "Nothing was renamed.",
    );
  }

  const stamp = Date.now();
  const at = (name: string) => join(folderPath, name);
  const temps = plan.map((p, i) => tempName(stamp, i, p.oldName));
  const toTemp: number[] = []; // indices now at their temp name
  const toNew: number[] = []; // indices now at their new name
  try {
    for (let i = 0; i < plan.length; i++) {
      await fsRename(await at(plan[i].oldName), await at(temps[i]));
      toTemp.push(i);
    }
    for (let i = 0; i < plan.length; i++) {
      await fsRename(await at(temps[i]), await at(plan[i].newName));
      toNew.push(i);
    }
  } catch (err) {
    // Undo: new names back to temps first (a new name can be another
    // photo's old name), then every temp back to its old name.
    const stuck: string[] = [];
    for (const i of toNew.reverse()) {
      try {
        await fsRename(await at(plan[i].newName), await at(temps[i]));
      } catch {
        stuck.push(plan[i].newName);
        toTemp.splice(toTemp.indexOf(i), 1);
      }
    }
    for (const i of toTemp.reverse()) {
      try {
        await fsRename(await at(temps[i]), await at(plan[i].oldName));
      } catch {
        stuck.push(temps[i]);
      }
    }
    if (stuck.length > 0) {
      throw new RenameError(
        `Renaming failed (${String(err)}) and ${stuck.length} file(s) couldn't be put back: ${stuck.join(", ")}. ` +
          "Temporary names end with the photo's original name.",
      );
    }
    throw new RenameError(`Renaming failed, so every photo was put back under its old name. (${String(err)})`);
  }
}
