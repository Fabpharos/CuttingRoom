import { useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const HEART_PATH =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z";

export default function Thumbnail({
  id,
  src,
  name,
  needsEdit,
  favorite,
  selected,
  dimmed,
  onToggleTag,
  onToggleFavorite,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  id: string;
  src: string;
  name: string;
  needsEdit: boolean;
  favorite: boolean;
  selected: boolean;
  dimmed?: boolean;
  onToggleTag: () => void;
  onToggleFavorite: () => void;
  onSelect: (shiftKey: boolean, ctrlKey: boolean) => void;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setNodeRef}
      className="thumb"
      {...attributes}
      {...listeners}
      onPointerDownCapture={(e) => {
        pointerDownPos.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        e.stopPropagation();
        const start = pointerDownPos.current;
        const dx = start ? Math.abs(e.clientX - start.x) : 0;
        const dy = start ? Math.abs(e.clientY - start.y) : 0;
        // A real drag (pointer moved) shouldn't also collapse the selection
        // down to just this one item once it's dropped.
        if (dx > 5 || dy > 5) return;
        onSelect(e.shiftKey, e.ctrlKey || e.metaKey);
      }}
      onDoubleClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : dimmed ? 0.55 : 1,
        cursor: "grab",
        outline: selected ? "2px solid var(--accent)" : "none",
        outlineOffset: selected ? -2 : 0,
      }}
    >
      {src ? (
        <img src={src} alt={name} loading="lazy" draggable={false} />
      ) : (
        <div style={{ width: "100%", height: "100%", background: "var(--bg-card)" }} />
      )}
      {selected && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--accent)",
            opacity: 0.22,
            pointerEvents: "none",
          }}
        />
      )}
      <div className="thumb-label">{name}</div>

      <div
        data-no-dnd="true"
        onPointerDown={(e) => {
          // Prevent the browser's default click behavior of shifting focus
          // to the nearest focusable ancestor (the sortable tile itself,
          // which dnd-kit makes tabbable for keyboard drag support) — that
          // default focus-outline is the "blue ring jumping to another
          // photo" effect.
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        title={favorite ? "Favorited" : "Mark as favorite"}
        style={{
          position: "absolute",
          top: 6,
          right: 36,
          width: 24,
          height: 24,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          background: favorite ? "var(--accent)" : "rgba(0,0,0,.4)",
          border: favorite ? "none" : "1px solid rgba(255,255,255,.5)",
          boxShadow: favorite ? "0 1px 4px rgba(0,0,0,.35)" : "none",
        }}
      >
        <svg
          width="12"
          height="12"
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
        data-no-dnd="true"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleTag();
        }}
        title={needsEdit ? "Marked as needs editing" : "Mark as needs editing"}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 24,
          height: 24,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          background: needsEdit ? "var(--accent)" : "rgba(0,0,0,.4)",
          border: needsEdit ? "none" : "1px solid rgba(255,255,255,.5)",
          boxShadow: needsEdit ? "0 1px 4px rgba(0,0,0,.35)" : "none",
        }}
      >
        <svg
          width="12"
          height="12"
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
    </div>
  );
}
