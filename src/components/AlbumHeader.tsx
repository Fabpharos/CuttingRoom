import { useEffect, useState } from "react";

export default function AlbumHeader({
  albumName,
  folderPath,
  photoCount,
  totalCount,
  onChangeFolder,
  onCommitName,
  onRefresh,
  onRenameFiles,
  onExportPdf,
  revertToken,
}: {
  albumName: string;
  folderPath: string;
  photoCount: number;
  totalCount: number;
  onChangeFolder: () => void;
  onCommitName: (newName: string) => void;
  onRefresh: () => void;
  onRenameFiles: () => void;
  onExportPdf: () => void;
  // Bumped by the parent whenever a commit attempt fails, so the field
  // resyncs to `albumName` even though that string itself didn't change.
  revertToken?: number;
}) {
  const [value, setValue] = useState(albumName);
  const [focused, setFocused] = useState(false);

  useEffect(() => setValue(albumName), [albumName, revertToken]);

  function commit() {
    const trimmed = value.trim();
    if (!trimmed) {
      setValue(albumName);
      return;
    }
    if (trimmed !== albumName) {
      onCommitName(trimmed);
    } else {
      setValue(albumName);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setValue(albumName);
              (e.target as HTMLInputElement).blur();
            }
          }}
          style={{
            fontSize: 21,
            fontWeight: 700,
            fontFamily: "'Space Grotesk', sans-serif",
            background: "transparent",
            border: "none",
            borderBottom: focused
              ? "1.5px solid var(--accent)"
              : "1.5px solid transparent",
            color: "var(--text)",
            padding: "2px 0",
            outline: "none",
            minWidth: 80,
            flex: "1 1 auto",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 11.5,
              color: "var(--muted)",
              fontFamily: "'IBM Plex Mono', monospace",
              whiteSpace: "nowrap",
            }}
          >
            {photoCount === totalCount
              ? `${photoCount} PHOTO${photoCount === 1 ? "" : "S"}`
              : `${photoCount} OF ${totalCount} PHOTOS`}
          </span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onRefresh();
            }}
            title="Look for newly added photos"
            style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
          >
            Refresh
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onRenameFiles();
            }}
            title="Rename the photo files to match the album's order"
            style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
          >
            Rename Files
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onExportPdf();
            }}
            title="Save every photo as a single PDF, in album order"
            style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
          >
            Export as PDF
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onChangeFolder();
            }}
            style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
          >
            Change folder
          </a>
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--muted)",
          fontFamily: "system-ui, sans-serif",
          marginTop: 2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={folderPath}
      >
        {folderPath}
      </div>
    </div>
  );
}
