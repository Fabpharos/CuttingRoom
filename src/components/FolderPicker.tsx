import { useState } from "react";
import FolderIcon from "./FolderIcon";

export default function FolderPicker({
  onChoose,
  recentFolders,
  onOpenRecent,
}: {
  onChoose: () => void;
  recentFolders: string[];
  onOpenRecent: (path: string) => void;
}) {
  const [showRecent, setShowRecent] = useState(false);

  return (
    <div style={{ padding: "24px" }}>
      <div style={{ maxWidth: 480 }}>
        <div
          style={{
            border: "1.5px dashed var(--dashed)",
            borderRadius: 10,
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "var(--bg-card)",
          }}
        >
          <FolderIcon size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              No folder selected
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--muted)",
                fontFamily: "system-ui, sans-serif",
              }}
            >
              Choose a folder of photos to review, tag, and arrange.
            </div>
          </div>

          {recentFolders.length > 0 && (
            <button
              onClick={() => setShowRecent((v) => !v)}
              style={{
                padding: "7px 14px",
                border: "1px solid var(--border)",
                borderRadius: 999,
                background: "transparent",
                color: "var(--text)",
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Open Recent
            </button>
          )}

          <button
            onClick={onChoose}
            style={{
              padding: "7px 16px",
              border: "none",
              borderRadius: 999,
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Choose Folder
          </button>
        </div>

        {showRecent && recentFolders.length > 0 && (
          <div
            style={{
              marginTop: 8,
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--bg-card)",
              overflow: "hidden",
            }}
          >
            {recentFolders.map((path, i) => (
              <div
                key={path}
                onClick={() => {
                  setShowRecent(false);
                  onOpenRecent(path);
                }}
                title={path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 14px",
                  cursor: "pointer",
                  borderBottom:
                    i < recentFolders.length - 1 ? "1px solid var(--border)" : "none",
                  fontSize: 12.5,
                  fontFamily: "system-ui, sans-serif",
                  color: "var(--text)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <FolderIcon size={14} color="var(--muted)" />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {path}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
