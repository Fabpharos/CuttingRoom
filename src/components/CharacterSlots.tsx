import { useState, type ReactNode } from "react";
import { DndContext, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TagAwarePointerSensor } from "../lib/dndSensors";
import { freeCharacterPositions, gridLabel, positionForModel, type CharacterPosition } from "../lib/novelai";

/** What a collapsed character row shows. */
export type SlotSummary = {
  key: string;
  text: string;
  negative: string;
  position: CharacterPosition;
  cardName: string | null;
  hasReference: boolean;
  /** Switched off: kept in the list, not sent. */
  off?: boolean;
};

// A short summary of a prompt: its first few tags.
function firstTags(text: string, n = 4): string {
  const tags = text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.slice(0, n).join(", ") + (tags.length > n ? ", …" : "");
}

function Row({
  id,
  header,
  body,
  expanded,
  off,
}: {
  id: string;
  header: (handle: Record<string, unknown>) => ReactNode;
  body: ReactNode;
  expanded: boolean;
  off?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: expanded ? "8px 10px 10px" : "5px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: off ? "var(--bg-page)" : "var(--bg-card)",
        borderStyle: off ? "dashed" : "solid",
      }}
    >
      {header({ ...attributes, ...listeners })}
      {expanded && body}
    </div>
  );
}

/**
 * The character list: rows that collapse to one line, drag to reorder (order
 * matters to NovelAI: top to bottom, left to right), and expand to their
 * editors. Collapsed rows don't render their editors, so 22 stay quick.
 */
export default function CharacterSlots({
  slots,
  model,
  disabled,
  expanded,
  onToggle,
  onReorder,
  renderBody,
  renderActions,
  hovered,
  onHover,
}: {
  slots: SlotSummary[];
  model: string;
  disabled: boolean;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onReorder: (from: number, to: number) => void;
  renderBody: (index: number) => ReactNode;
  renderActions: (index: number) => ReactNode;
  hovered: number | null;
  onHover: (index: number | null) => void;
}) {
  const sensors = useSensors(useSensor(TagAwarePointerSensor, { activationConstraint: { distance: 4 } }));
  const [dragging, setDragging] = useState(false);
  const free = freeCharacterPositions(model);

  function end(e: DragEndEvent) {
    setDragging(false);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = slots.findIndex((s) => s.key === active.id);
    const to = slots.findIndex((s) => s.key === over.id);
    if (from >= 0 && to >= 0) onReorder(from, to);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => setDragging(true)}
      onDragEnd={end}
      onDragCancel={() => setDragging(false)}
    >
      <SortableContext items={slots.map((s) => s.key)} strategy={verticalListSortingStrategy}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {slots.map((s, i) => {
            const open = expanded.has(s.key);
            const at = positionForModel(model, s.position);
            return (
              <Row
                key={s.key}
                id={s.key}
                expanded={open}
                header={(handle) => (
                  <div
                    onMouseEnter={() => onHover(i)}
                    onMouseLeave={() => onHover(null)}
                    style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
                  >
                    <span
                      {...(disabled ? {} : handle)}
                      title={disabled ? undefined : "Drag to reorder"}
                      style={{
                        cursor: disabled ? "default" : dragging ? "grabbing" : "grab",
                        color: "var(--muted)",
                        fontSize: 13,
                        lineHeight: 1,
                        userSelect: "none",
                        padding: "0 2px",
                      }}
                    >
                      ⋮⋮
                    </span>
                    <span
                      style={{
                        minWidth: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: hovered === i ? "var(--accent)" : "var(--bg-page)",
                        color: hovered === i ? "var(--accent-contrast)" : "var(--text)",
                        border: "1px solid var(--border)",
                        fontSize: 11,
                        fontWeight: 700,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {i + 1}
                    </span>
                    <button
                      data-no-dnd="true"
                      onClick={() => onToggle(s.key)}
                      title={open ? "Collapse" : "Expand"}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: 0,
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                      }}
                    >
                      <span style={{ color: "var(--muted)", fontSize: 10 }}>{open ? "▾" : "▸"}</span>
                      <span style={{ fontWeight: 600, whiteSpace: "nowrap", opacity: s.off ? 0.5 : 1 }}>
                        {s.cardName ?? `Character ${i + 1}`}
                        {s.off && <span style={{ fontWeight: 500, color: "var(--muted)" }}> · off</span>}
                      </span>
                      {!open && (
                        <span
                          style={{
                            color: "var(--muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            minWidth: 0,
                            flex: 1,
                            fontFamily: "system-ui, sans-serif",
                          }}
                        >
                          {firstTags(s.text) || "(empty)"}
                        </span>
                      )}
                    </button>
                    <span
                      title="Position"
                      style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}
                    >
                      {free ? `${Math.round(at.x * 100)},${Math.round(at.y * 100)}` : gridLabel(at)}
                    </span>
                    {s.negative.trim() && (
                      <span title="Has undesired content" style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700 }}>
                        UC
                      </span>
                    )}
                    {s.hasReference && (
                      <span title="Has a Precise Reference image" style={{ fontSize: 10.5, color: "var(--accent)", fontWeight: 700 }}>
                        REF
                      </span>
                    )}
                    <span data-no-dnd="true" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {renderActions(i)}
                    </span>
                  </div>
                )}
                body={open ? renderBody(i) : null}
                off={s.off}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** Positions for `n` characters spread over the picture in a grid (a row up to 4). */
export function spreadPositions(n: number, model: string): CharacterPosition[] {
  if (n <= 0) return [];
  const cols = n <= 4 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const c = i - r * cols;
    return positionForModel(model, { x: (c + 0.5) / inRow, y: (r + 0.5) / rows });
  });
}

/**
 * A rough T5 token count for a prompt (about one token per 3.5 characters of
 * tags). NovelAI's own counter is exact; this only warns when it's close.
 */
export function roughTokens(text: string): number {
  const t = text.trim();
  return t ? Math.ceil(t.length / 3.5) : 0;
}
/** Approximate shared token limit of the base prompt and all characters. */
export function tokenLimit(model: string): number {
  return model.startsWith("nai-diffusion-5") ? 1024 : 512;
}
