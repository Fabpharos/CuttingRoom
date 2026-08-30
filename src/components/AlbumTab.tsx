import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { basename, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getThumbnailUrl, moveThumbnailCache } from "../lib/thumbnails";
import {
  copyFilesToClipboard,
  moveFilesToTrash,
  revealFilesInExplorer,
} from "../lib/nativeOps";
import FolderPicker from "./FolderPicker";
import ImageGrid, { type ImageEntry } from "./ImageGrid";
import ImageViewer from "./ImageViewer";
import ConfirmModal from "./ConfirmModal";
import ContextMenu from "./ContextMenu";
import { isImageFile, naturalCompare } from "../lib/images";
import {
  loadAlbum,
  saveAlbum,
  moveAlbum,
  getRecentFolders,
  addRecentFolder,
  renameRecentFolder,
  removeRecentFolder,
  type AlbumData,
} from "../lib/albumStore";
import { renameFolder, buildRenamePlan, renamePhotos } from "../lib/rename";

type PendingPhotoRename = {
  folderPath: string;
  albumName: string;
  order: string[];
};

export default function AlbumTab() {
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [albumName, setAlbumName] = useState("");
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [tags, setTags] = useState<Record<string, boolean>>({});
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const [pendingRename, setPendingRename] = useState<PendingPhotoRename | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameRevertToken, setNameRevertToken] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [needsEditFilterOn, setNeedsEditFilterOn] = useState(false);
  const [favoritesFilterOn, setFavoritesFilterOn] = useState(false);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targets: Set<string>;
  } | null>(null);
  // Bumped on every loadFolder call so in-flight thumbnail decodes from a
  // folder the user has since navigated away from don't write into the
  // current one.
  const loadTokenRef = useRef(0);

  const visibleImages = useMemo(() => {
    if (!needsEditFilterOn && !favoritesFilterOn) return images;
    return images.filter(
      (img) =>
        (needsEditFilterOn && tags[img.name]) || (favoritesFilterOn && favorites[img.name]),
    );
  }, [images, tags, favorites, needsEditFilterOn, favoritesFilterOn]);

  // Read by keyboard-shortcut and window-close listeners below, which are
  // registered once and would otherwise close over stale state.
  const latestRef = useRef({
    isDirty,
    albumName,
    images,
    tags,
    favorites,
    folderPath,
    selectedNames,
    viewerOpen: viewerIndex !== null,
  });
  useEffect(() => {
    latestRef.current = {
      isDirty,
      albumName,
      images,
      tags,
      favorites,
      folderPath,
      selectedNames,
      viewerOpen: viewerIndex !== null,
    };
  });

  useEffect(() => {
    getRecentFolders().then(setRecentFolders);
  }, []);

  useEffect(() => {
    // Block the webview's own native clipboard "copy" handling so it can
    // never race with / overwrite the native file-list clipboard write
    // triggered by our own Ctrl+C handler below.
    function handleCopy(e: ClipboardEvent) {
      e.preventDefault();
    }
    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, []);

  async function copySelectedToClipboard(
    fp: string,
    imgs: ImageEntry[],
    sel: Set<string>,
  ) {
    const selected = imgs.filter((img) => sel.has(img.name));
    if (selected.length === 0) return;
    try {
      const paths = await Promise.all(selected.map((img) => join(fp, img.name)));
      await copyFilesToClipboard(paths);
    } catch (err) {
      setError(`Couldn't copy photos: ${String(err)}`);
    }
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isTyping =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

      if ((e.ctrlKey || e.metaKey) && !e.repeat && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const {
          folderPath: fp,
          isDirty: dirty,
          albumName: name,
          images: imgs,
          tags: currentTags,
          favorites: currentFavorites,
        } = latestRef.current;
        if (fp && dirty) {
          void renamePhotosToMatch(
            fp,
            name,
            imgs.map((i) => i.name),
            currentTags,
            currentFavorites,
          );
        }
        return;
      }

      if (isTyping) return;

      if ((e.ctrlKey || e.metaKey) && !e.repeat && e.key.toLowerCase() === "c") {
        const { folderPath: fp, images: imgs, selectedNames: sel, viewerOpen } =
          latestRef.current;
        if (fp && sel.size > 0 && !viewerOpen) {
          e.preventDefault();
          void copySelectedToClipboard(fp, imgs, sel);
        }
        return;
      }

      if (e.key === "Delete" && !e.repeat) {
        const { selectedNames: sel, viewerOpen } = latestRef.current;
        if (sel.size > 0 && !viewerOpen) {
          e.preventDefault();
          setPendingDelete(true);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Guards against the effect unmounting before the async subscription
    // resolves: without this, a listener registered just after cleanup ran
    // would be orphaned instead of removed.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested((event) => {
        if (!latestRef.current.isDirty) return;
        event.preventDefault();
        setViewerIndex(null);
        setShowCloseConfirm(true);
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function loadFolder(dir: string) {
    let entries;
    try {
      entries = await readDir(dir);
    } catch (err) {
      setError(`Couldn't open folder: ${String(err)}`);
      setRecentFolders(await removeRecentFolder(dir));
      return;
    }
    const imageNames = entries
      .filter((e) => e.isFile && isImageFile(e.name))
      .map((e) => e.name);

    const stored = await loadAlbum(dir);
    const storedOrder = (stored?.order ?? []).filter((n) => imageNames.includes(n));
    const remaining = imageNames
      .filter((n) => !storedOrder.includes(n))
      .sort(naturalCompare);
    const finalOrder = [...storedOrder, ...remaining];

    const name = stored?.name ?? (await basename(dir));
    const albumTags = stored?.tags ?? {};
    const albumFavorites = stored?.favorites ?? {};

    // Show the grid immediately with placeholders, then fill thumbnails in
    // as each one decodes — waiting for the whole folder to finish before
    // showing anything made switching folders feel laggy.
    const myLoad = ++loadTokenRef.current;
    setImages(finalOrder.map((imgName) => ({ name: imgName, src: "" })));

    setFolderPath(dir);
    setAlbumName(name);
    setTags(albumTags);
    setFavorites(albumFavorites);
    setPendingRename(null);
    setError(null);
    setViewerIndex(null);
    setIsDirty(false);
    setNeedsEditFilterOn(false);
    setFavoritesFilterOn(false);
    setSelectedNames(new Set());
    setSelectionAnchor(null);
    await saveAlbum(dir, {
      name,
      order: finalOrder,
      tags: albumTags,
      favorites: albumFavorites,
    });
    setRecentFolders(await addRecentFolder(dir));

    for (const imgName of finalOrder) {
      (async () => {
        const src = await getThumbnailUrl(await join(dir, imgName));
        if (loadTokenRef.current !== myLoad) return; // a different folder loaded meanwhile
        setImages((prev) =>
          prev.map((img) => (img.name === imgName ? { ...img, src } : img)),
        );
      })();
    }
  }

  async function chooseFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      await loadFolder(dir);
    }
  }

  async function persist(overrides: Partial<AlbumData> = {}) {
    if (!folderPath) return;
    const data: AlbumData = {
      name: albumName,
      order: images.map((i) => i.name),
      tags,
      favorites,
      ...overrides,
    };
    await saveAlbum(folderPath, data);
  }

  async function handleReorder(newVisibleOrder: string[]) {
    // newVisibleOrder is the reordered VISIBLE subset (a filter may be
    // active); merge it back into the full list, leaving any hidden images
    // exactly where they were.
    const visibleSet = new Set(newVisibleOrder);
    const queue = [...newVisibleOrder];
    const mergedOrder = images.map((img) =>
      visibleSet.has(img.name) ? queue.shift()! : img.name,
    );
    const byName = new Map(images.map((img) => [img.name, img]));
    const reordered = mergedOrder.map((name) => byName.get(name)!).filter(Boolean);
    setImages(reordered);
    setIsDirty(true);
    if (folderPath) {
      await saveAlbum(folderPath, { name: albumName, order: mergedOrder, tags, favorites });
    }
  }

  async function handleToggleTag(name: string) {
    const newTags = { ...tags, [name]: !tags[name] };
    setTags(newTags);
    await persist({ tags: newTags });
  }

  async function handleToggleFavorite(name: string) {
    const newFavorites = { ...favorites, [name]: !favorites[name] };
    setFavorites(newFavorites);
    await persist({ favorites: newFavorites });
  }

  function handleSelect(index: number, shiftKey: boolean, ctrlKey: boolean) {
    const name = visibleImages[index]?.name;
    if (!name) return;
    if (shiftKey && selectionAnchor !== null) {
      const lo = Math.min(selectionAnchor, index);
      const hi = Math.max(selectionAnchor, index);
      setSelectedNames(new Set(visibleImages.slice(lo, hi + 1).map((i) => i.name)));
    } else if (ctrlKey) {
      setSelectedNames((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      setSelectionAnchor(index);
    } else {
      setSelectedNames(new Set([name]));
      setSelectionAnchor(index);
    }
  }

  function handleContextMenu(index: number, x: number, y: number) {
    const name = visibleImages[index]?.name;
    if (!name) return;
    // Right-clicking a photo that's already part of a multi-selection acts
    // on the whole selection; right-clicking outside it starts a fresh
    // single-photo selection instead.
    let targets = selectedNames;
    if (!selectedNames.has(name)) {
      targets = new Set([name]);
      setSelectedNames(targets);
      setSelectionAnchor(index);
    }
    setContextMenu({ x, y, targets });
  }

  async function handleRefresh() {
    if (!folderPath) return;
    let entries;
    try {
      entries = await readDir(folderPath);
    } catch (err) {
      setError(`Couldn't refresh folder: ${String(err)}`);
      return;
    }
    const currentNames = new Set(images.map((i) => i.name));
    const newNames = entries
      .filter((e) => e.isFile && isImageFile(e.name) && !currentNames.has(e.name))
      .map((e) => e.name)
      .sort(naturalCompare);
    if (newNames.length === 0) return;

    const newImages = [...images, ...newNames.map((name) => ({ name, src: "" }))];
    setImages(newImages);
    setIsDirty(true);
    await saveAlbum(folderPath, {
      name: albumName,
      order: newImages.map((i) => i.name),
      tags,
      favorites,
    });

    const myLoad = loadTokenRef.current;
    for (const name of newNames) {
      (async () => {
        const src = await getThumbnailUrl(await join(folderPath, name));
        if (loadTokenRef.current !== myLoad) return;
        setImages((prev) =>
          prev.map((img) => (img.name === name ? { ...img, src } : img)),
        );
      })();
    }
  }

  async function doDeleteSelected() {
    setPendingDelete(false);
    if (!folderPath || selectedNames.size === 0) return;
    const toDelete = images.filter((img) => selectedNames.has(img.name));
    const paths = await Promise.all(toDelete.map((img) => join(folderPath, img.name)));
    try {
      await moveFilesToTrash(paths);
    } catch (err) {
      setError(`Couldn't delete photos: ${String(err)}`);
      return;
    }
    const remaining = images.filter((img) => !selectedNames.has(img.name));
    const newTags = { ...tags };
    const newFavorites = { ...favorites };
    for (const img of toDelete) {
      delete newTags[img.name];
      delete newFavorites[img.name];
    }
    setImages(remaining);
    setTags(newTags);
    setFavorites(newFavorites);
    setSelectedNames(new Set());
    setSelectionAnchor(null);
    await saveAlbum(folderPath, {
      name: albumName,
      order: remaining.map((i) => i.name),
      tags: newTags,
      favorites: newFavorites,
    });
  }

  async function handleCommitName(newName: string) {
    if (!folderPath) return;
    try {
      const newPath = await renameFolder(folderPath, newName);
      await moveAlbum(folderPath, newPath);
      setRecentFolders(await renameRecentFolder(folderPath, newPath));

      const paths = await Promise.all(
        images.map(async (img) => ({
          oldPath: await join(folderPath, img.name),
          newPath: await join(newPath, img.name),
        })),
      );
      moveThumbnailCache(paths);
      const updatedImages = await Promise.all(
        images.map(async (img, i) => ({
          name: img.name,
          src: await getThumbnailUrl(paths[i].newPath),
        })),
      );

      setFolderPath(newPath);
      setAlbumName(newName);
      setImages(updatedImages);
      setIsDirty(true);
      await saveAlbum(newPath, {
        name: newName,
        order: updatedImages.map((i) => i.name),
        tags,
        favorites,
      });

      setPendingRename({
        folderPath: newPath,
        albumName: newName,
        order: updatedImages.map((i) => i.name),
      });
    } catch (err) {
      setError(`Couldn't rename folder: ${String(err)}`);
      setNameRevertToken((t) => t + 1);
    }
  }

  // Shared by the "rename photos too?" prompt, the Ctrl+S shortcut, and the
  // unsaved-changes-on-close prompt. Takes every value it needs as a
  // parameter (rather than closing over component state) so it behaves
  // correctly even when called from a handler registered once on mount.
  async function renamePhotosToMatch(
    dir: string,
    name: string,
    order: string[],
    currentTags: Record<string, boolean>,
    currentFavorites: Record<string, boolean>,
  ): Promise<boolean> {
    const plan = buildRenamePlan(name, order);
    try {
      await renamePhotos(dir, plan);
      const paths = await Promise.all(
        plan.map(async (p) => ({
          oldPath: await join(dir, p.oldName),
          newPath: await join(dir, p.newName),
        })),
      );
      moveThumbnailCache(paths);
      const newImages = await Promise.all(
        plan.map(async (p, i) => ({
          name: p.newName,
          src: await getThumbnailUrl(paths[i].newPath),
        })),
      );
      const newTags: Record<string, boolean> = {};
      const newFavorites: Record<string, boolean> = {};
      for (const p of plan) {
        if (currentTags[p.oldName]) newTags[p.newName] = true;
        if (currentFavorites[p.oldName]) newFavorites[p.newName] = true;
      }
      setImages(newImages);
      setTags(newTags);
      setFavorites(newFavorites);
      setIsDirty(false);
      await saveAlbum(dir, {
        name,
        order: newImages.map((i) => i.name),
        tags: newTags,
        favorites: newFavorites,
      });
      return true;
    } catch (err) {
      setError(`Couldn't rename photos: ${String(err)}`);
      return false;
    }
  }

  async function confirmPhotoRename() {
    if (!pendingRename) return;
    const { folderPath: dir, albumName: name, order } = pendingRename;
    await renamePhotosToMatch(dir, name, order, tags, favorites);
    setPendingRename(null);
  }

  async function handleCloseSaveAndExit() {
    const {
      folderPath: fp,
      albumName: name,
      images: imgs,
      tags: currentTags,
      favorites: currentFavorites,
    } = latestRef.current;
    const ok = fp
      ? await renamePhotosToMatch(fp, name, imgs.map((i) => i.name), currentTags, currentFavorites)
      : true;
    setShowCloseConfirm(false);
    if (ok) {
      await getCurrentWindow().destroy();
    }
  }

  async function handleCloseDiscard() {
    setShowCloseConfirm(false);
    await getCurrentWindow().destroy();
  }

  return (
    <>
      {error && (
        <div
          style={{
            margin: "12px 24px 0 24px",
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(200,60,50,.12)",
            border: "1px solid rgba(200,60,50,.35)",
            color: "var(--text)",
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{error}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); setError(null); }}>
            Dismiss
          </a>
        </div>
      )}

      {folderPath ? (
        <ImageGrid
          folderPath={folderPath}
          albumName={albumName}
          images={visibleImages}
          totalCount={images.length}
          tags={tags}
          favorites={favorites}
          selectedNames={selectedNames}
          needsEditFilterOn={needsEditFilterOn}
          favoritesFilterOn={favoritesFilterOn}
          onChangeFolder={chooseFolder}
          onRefresh={() => void handleRefresh()}
          onCommitName={handleCommitName}
          onReorder={handleReorder}
          onToggleTag={handleToggleTag}
          onToggleFavorite={handleToggleFavorite}
          onSelect={handleSelect}
          onClearSelection={() => setSelectedNames(new Set())}
          onOpenViewer={setViewerIndex}
          onToggleNeedsEditFilter={() => setNeedsEditFilterOn((v) => !v)}
          onToggleFavoritesFilter={() => setFavoritesFilterOn((v) => !v)}
          onContextMenu={handleContextMenu}
          nameRevertToken={nameRevertToken}
        />
      ) : (
        <FolderPicker
          onChoose={chooseFolder}
          recentFolders={recentFolders}
          onOpenRecent={loadFolder}
        />
      )}

      {folderPath && viewerIndex !== null && (
        <ImageViewer
          images={visibleImages}
          folderPath={folderPath}
          index={viewerIndex}
          tags={tags}
          favorites={favorites}
          onClose={() => setViewerIndex(null)}
          onNavigate={setViewerIndex}
          onToggleTag={handleToggleTag}
          onToggleFavorite={handleToggleFavorite}
        />
      )}

      {pendingRename && (
        <ConfirmModal
          title="Rename photos too?"
          message={`Rename every photo in this folder to match "${pendingRename.albumName}" and its album order?`}
          confirmLabel="Rename photos"
          cancelLabel="Not now"
          onConfirm={confirmPhotoRename}
          onCancel={() => setPendingRename(null)}
        />
      )}

      {showCloseConfirm && (
        <ConfirmModal
          title="Unsaved changes"
          message="The album order doesn't match the photo filenames yet. Rename the photos to match before closing?"
          confirmLabel="Save & Close"
          middleLabel="Don't Save"
          cancelLabel="Cancel"
          onConfirm={() => void handleCloseSaveAndExit()}
          onMiddle={() => void handleCloseDiscard()}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}

      {contextMenu && folderPath && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: contextMenu.targets.size === 1 ? "Copy" : "Copy photos",
              onClick: () => void copySelectedToClipboard(folderPath, images, contextMenu.targets),
            },
            {
              label: "View in Explorer",
              onClick: () => {
                void (async () => {
                  const toReveal = images.filter((img) => contextMenu.targets.has(img.name));
                  const paths = await Promise.all(
                    toReveal.map((img) => join(folderPath, img.name)),
                  );
                  try {
                    await revealFilesInExplorer(paths);
                  } catch (err) {
                    setError(`Couldn't open Explorer: ${String(err)}`);
                  }
                })();
              },
            },
            {
              label: contextMenu.targets.size === 1 ? "Delete" : "Delete photos",
              danger: true,
              onClick: () => setPendingDelete(true),
            },
          ]}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete photos?"
          message={`Move ${selectedNames.size} photo${selectedNames.size === 1 ? "" : "s"} to the Recycle Bin?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={() => void doDeleteSelected()}
          onCancel={() => setPendingDelete(false)}
        />
      )}
    </>
  );
}
