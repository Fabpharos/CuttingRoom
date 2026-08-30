export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
};

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 400 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: x,
          top: y,
          minWidth: 190,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 6,
          boxShadow: "0 12px 32px rgba(0,0,0,.28)",
        }}
      >
        {items.map((item) => (
          <div
            key={item.label}
            className="context-menu-item"
            onClick={() => {
              item.onClick();
              onClose();
            }}
            style={{ color: item.danger ? "#c9482f" : "var(--text)" }}
          >
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}
