import type { PhotoRenamePlan } from "../lib/rename";

// Renaming photos is the one destructive, hard-to-reverse operation in this
// app's core workflow — this always shows the full old-name -> new-name
// mapping before anything touches disk, rather than just a "are you sure?"
// prompt.
export default function RenamePreviewModal({
  plan,
  onConfirm,
  onCancel,
}: {
  plan: PhotoRenamePlan[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const changed = plan.filter((p) => p.oldName !== p.newName);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "20px 22px",
          width: 480,
          maxWidth: "90vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 32px rgba(0,0,0,.28)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          Rename {changed.length} photo{changed.length === 1 ? "" : "s"}?
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.5,
            marginBottom: 14,
          }}
        >
          Files are renamed on disk to match the album's current order. This can't be
          undone.
        </div>

        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 8,
            marginBottom: 20,
          }}
        >
          {changed.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--muted)" }}>
              Every file already matches the album's order.
            </div>
          ) : (
            changed.map((p, i) => (
              <div
                key={p.oldName}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 12px",
                  borderBottom: i < changed.length - 1 ? "1px solid var(--border)" : "none",
                  fontSize: 12.5,
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={p.oldName}
                >
                  {p.oldName}
                </span>
                <span style={{ color: "var(--muted)", flexShrink: 0 }}>→</span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={p.newName}
                >
                  {p.newName}
                </span>
              </div>
            ))
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              border: "1px solid var(--border)",
              borderRadius: 999,
              background: "transparent",
              color: "var(--text)",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={changed.length === 0}
            style={{
              padding: "8px 18px",
              border: "none",
              borderRadius: 999,
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: 13,
              cursor: changed.length === 0 ? "default" : "pointer",
              opacity: changed.length === 0 ? 0.5 : 1,
            }}
          >
            Rename Files
          </button>
        </div>
      </div>
    </div>
  );
}
