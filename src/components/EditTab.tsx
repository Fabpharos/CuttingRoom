// Edit: pick a folder, see its images, click one to edit it. The only edit so
// far is pixelating a brushed or lassoed selection (ImageEditor). Edits are
// saved as a new "<name>_edited" file, or over the original after it has gone
// to the Recycle Bin — never without the user clicking Save.

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { isImageFile, naturalCompare } from "../lib/images";
import { getThumbnailUrl, notifyFileChanged } from "../lib/thumbnails";
import { loadAlbum } from "../lib/albumStore";
import { DEFAULT_EDIT_SETTINGS, loadEditSettings, saveEditSettings, type EditSettings } from "../lib/editSettings";
import FolderPicker from "./FolderPicker";
import ImageEditor, { type ImageEditorHandle } from "./ImageEditor";
import ConfirmModal from "./ConfirmModal";

/** A folder (and optionally one image in it) sent from another tab. */
export type EditRequest = { id: number; folder: string; file: string | null };

type Entry = { name: string; src: string };

export default function EditTab({ active, request }: { active: boolean; request: EditRequest | null }) {
  const [settings, setSettings] = useState<EditSettings | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [images, setImages] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Something waiting on "discard your edits?".
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const editorRef = useRef<ImageEditorHandle>(null);
  const loadToken = useRef(0);
  const handledRequest = useRef<number | null>(null);

  // Settings load the first time the tab is shown, not at launch.
  useEffect(() => {
    if (active && !settings) loadEditSettings().then(setSettings).catch(() => setSettings(DEFAULT_EDIT_SETTINGS));
  }, [active, settings]);

  const updateSettings = useCallback((patch: Partial<EditSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void saveEditSettings(next).catch(() => {});
      return next;
    });
  }, []);

  const loadFolder = useCallback(
    async (dir: string, openFile: string | null = null) => {
      let entries;
      try {
        entries = await readDir(dir);
      } catch (err) {
        setError(`Couldn't open folder: ${String(err)}`);
        return;
      }
      const names = entries.filter((e) => e.isFile && isImageFile(e.name)).map((e) => e.name);
      // Album order when the folder is an album, so both tabs list it the same way.
      const stored = await loadAlbum(dir).catch(() => null);
      const ordered = (stored?.order ?? []).filter((n) => names.includes(n));
      const rest = names.filter((n) => !ordered.includes(n)).sort(naturalCompare);
      const order = [...ordered, ...rest];

      const token = ++loadToken.current;
      setError(null);
      setFolder(dir);
      setImages(order.map((name) => ({ name, src: "" })));
      setCurrent(openFile && order.includes(openFile) ? openFile : null);
      setSettings((prev) => {
        if (!prev) return prev;
        const next = { ...prev, recentFolders: [dir, ...prev.recentFolders.filter((f) => f !== dir)].slice(0, 8) };
        void saveEditSettings(next).catch(() => {});
        return next;
      });
      for (const name of order) {
        void (async () => {
          const src = await getThumbnailUrl(await join(dir, name)).catch(() => "");
          if (loadToken.current !== token) return;
          setImages((prev) => prev.map((img) => (img.name === name ? { ...img, src } : img)));
        })();
      }
    },
    [],
  );

  /** Runs `action` now, or after the user agrees to drop unsaved edits. */
  const guard = useCallback(
    (action: () => void) => {
      if (current && editorRef.current?.dirty()) setPendingLeave(() => action);
      else action();
    },
    [current],
  );

  // A folder or image sent from Album.
  useEffect(() => {
    if (!request || handledRequest.current === request.id || !settings) return;
    handledRequest.current = request.id;
    guard(() => void loadFolder(request.folder, request.file));
  }, [request, settings, guard, loadFolder]);

  async function chooseFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") guard(() => void loadFolder(dir));
  }

  async function handleSaved(written: string, overwrote: boolean) {
    if (!folder) return;
    const name = written.split(/[\\/]/).pop()!;
    notifyFileChanged(folder, name, written);
    const src = await getThumbnailUrl(written).catch(() => "");
    setImages((prev) => {
      if (overwrote || prev.some((i) => i.name === name)) return prev.map((i) => (i.name === name ? { ...i, src } : i));
      // A new copy goes right after the image it came from.
      const at = prev.findIndex((i) => i.name === current);
      const next = [...prev];
      next.splice(at + 1, 0, { name, src });
      return next;
    });
  }

  if (!settings) return <div style={{ padding: 24 }} />;

  const index = current ? images.findIndex((i) => i.name === current) : -1;

  if (folder && current) {
    const go = (i: number) => () => guard(() => setCurrent(images[i].name));
    return (
      <>
        <ImageEditor
          key={current}
          ref={editorRef}
          path={pathIn(folder, current)}
          name={current}
          settings={settings}
          onSettings={updateSettings}
          onSaved={(w, o) => void handleSaved(w, o)}
          onBack={() => guard(() => setCurrent(null))}
          onPrev={index > 0 ? go(index - 1) : null}
          onNext={index >= 0 && index < images.length - 1 ? go(index + 1) : null}
          active={active}
        />
        {pendingLeave && (
          <ConfirmModal
            title="Discard your edits?"
            message={`${current} has edits that aren't saved.`}
            confirmLabel="Discard"
            cancelLabel="Keep editing"
            onConfirm={() => {
              const action = pendingLeave;
              setPendingLeave(null);
              action();
            }}
            onCancel={() => setPendingLeave(null)}
          />
        )}
      </>
    );
  }

  return (
    <div>
      {error && (
        <div
          style={{
            margin: "12px 24px 0 24px",
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(200,60,50,.12)",
            border: "1px solid rgba(200,60,50,.35)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      {!folder ? (
        <FolderPicker
          onChoose={() => void chooseFolder()}
          recentFolders={settings.recentFolders}
          onOpenRecent={(dir) => void loadFolder(dir)}
          description="Choose a folder of images, then click one to edit it."
        />
      ) : (
        <div style={{ padding: "20px 24px 24px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 4 }}>
            <div style={{ fontSize: 21, fontWeight: 700 }}>Edit</div>
            <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
              <span className="edit-mono">
                {images.length} IMAGE{images.length === 1 ? "" : "S"}
              </span>
              <a href="#" onClick={(e) => { e.preventDefault(); void loadFolder(folder); }} style={{ fontSize: 13, fontWeight: 600 }}>
                Refresh
              </a>
              <a href="#" onClick={(e) => { e.preventDefault(); void chooseFolder(); }} style={{ fontSize: 13, fontWeight: 600 }}>
                Change folder
              </a>
            </div>
          </div>
          <div
            style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={folder}
          >
            {folder} · click an image to edit it
          </div>
          {images.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>No images in this folder.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
              {images.map((img) => (
                <div key={img.name} className="thumb" onClick={() => setCurrent(img.name)} style={{ cursor: "pointer" }} title={img.name}>
                  {img.src ? (
                    <img src={img.src} alt={img.name} loading="lazy" draggable={false} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", background: "var(--bg-card)" }} />
                  )}
                  <div className="thumb-label">{img.name}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** `name` inside `folder`, with the folder's own separator. */
function pathIn(folder: string, name: string): string {
  const sep = folder.includes("\\") || !folder.includes("/") ? "\\" : "/";
  return folder.endsWith(sep) ? folder + name : folder + sep + name;
}
