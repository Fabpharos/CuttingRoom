export default function ConfirmModal({
  title,
  message,
  confirmLabel = "Yes",
  cancelLabel = "No",
  middleLabel,
  onConfirm,
  onCancel,
  onMiddle,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  middleLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onMiddle?: () => void;
}) {
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
          width: 360,
          maxWidth: "90vw",
          boxShadow: "0 12px 32px rgba(0,0,0,.28)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          {title}
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.5,
            marginBottom: 20,
          }}
        >
          {message}
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
            {cancelLabel}
          </button>
          {middleLabel && onMiddle && (
            <button
              onClick={onMiddle}
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
              {middleLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            style={{
              padding: "8px 18px",
              border: "none",
              borderRadius: 999,
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
