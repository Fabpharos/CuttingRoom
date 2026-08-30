import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageEntry } from "./ImageGrid";

const HEART_PATH =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z";

export default function ImageViewer({
  images,
  folderPath,
  index,
  tags,
  favorites,
  onClose,
  onNavigate,
  onToggleTag,
  onToggleFavorite,
}: {
  images: ImageEntry[];
  folderPath: string;
  index: number;
  tags: Record<string, boolean>;
  favorites: Record<string, boolean>;
  onClose: () => void;
  onNavigate: (newIndex: number) => void;
  onToggleTag: (name: string) => void;
  onToggleFavorite: (name: string) => void;
}) {
  const [fullSrc, setFullSrc] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const current = images[index];

  useEffect(() => {
    getCurrentWindow()
      .isFullscreen()
      .then(setIsFullscreen)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFullSrc(null);
    (async () => {
      const path = await join(folderPath, current.name);
      if (!cancelled) setFullSrc(convertFileSrc(path));
    })();
    return () => {
      cancelled = true;
    };
  }, [folderPath, current.name]);

  async function closeAndRestore() {
    if (isFullscreen) {
      await getCurrentWindow().setFullscreen(false);
    }
    onClose();
  }

  async function toggleFullscreen() {
    const next = !isFullscreen;
    await getCurrentWindow().setFullscreen(next);
    setIsFullscreen(next);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          onNavigate((index - 1 + images.length) % images.length);
          break;
        case "ArrowRight":
          e.preventDefault();
          onNavigate((index + 1) % images.length);
          break;
        case "F11":
          e.preventDefault();
          void toggleFullscreen();
          break;
        case "x":
        case "X":
          e.preventDefault();
          onToggleTag(current.name);
          break;
        case "Escape":
          e.preventDefault();
          void closeAndRestore();
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images.length, isFullscreen, current.name, onNavigate, onToggleTag, onClose]);

  const needsEdit = !!tags[current.name];
  const favorite = !!favorites[current.name];

  return (
    <div
      onClick={() => void closeAndRestore()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,8,6,0.96)",
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            color: "#c9bfae",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
          }}
        >
          {index + 1} / {images.length} &middot; {current.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(current.name);
            }}
            title={favorite ? "Favorited" : "Mark as favorite"}
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              background: favorite ? "var(--accent)" : "rgba(255,255,255,.12)",
              border: favorite ? "none" : "1px solid rgba(255,255,255,.4)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill={favorite ? "var(--accent-contrast)" : "none"}
              style={{ stroke: favorite ? "var(--accent-contrast)" : "#fff" }}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={HEART_PATH} />
            </svg>
          </div>
          <div
            onClick={(e) => {
              e.stopPropagation();
              onToggleTag(current.name);
            }}
            title={needsEdit ? "Marked as needs editing" : "Mark as needs editing"}
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              background: needsEdit ? "var(--accent)" : "rgba(255,255,255,.12)",
              border: needsEdit ? "none" : "1px solid rgba(255,255,255,.4)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              style={{ stroke: needsEdit ? "var(--accent-contrast)" : "#fff" }}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </div>
          <div
            onClick={(e) => {
              e.stopPropagation();
              void closeAndRestore();
            }}
            title="Close (Esc)"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              background: "rgba(255,255,255,.12)",
              border: "1px solid rgba(255,255,255,.4)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              style={{ stroke: "#fff" }}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 40px 40px 40px",
        }}
      >
        {fullSrc && (
          <img
            src={fullSrc}
            alt={current.name}
            onClick={(e) => e.stopPropagation()}
            draggable={false}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              borderRadius: 4,
            }}
          />
        )}
      </div>
    </div>
  );
}
