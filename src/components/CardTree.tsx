// The Character Cards list as a folder tree: the card folder at the top,
// each subfolder expanding in place when clicked, and cards that can be
// dragged onto a folder (or the top row) to move them there. Uses pointer
// dragging (dnd-kit) because Tauri's own file-drop handling swallows the
// browser's drag events on Windows.

import { useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import RefMarker from "./RefMarker";
import type { CardFile } from "../lib/characterCards";

const parentOf = (rel: string) => rel.split("/").slice(0, -1).join("/");
const nameOf = (rel: string) => rel.split("/").pop() ?? rel;

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {open ? (
        <path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v1H7.5a1 1 0 0 0-.95.68L4 18V7Zm1 11 2.7-7.3a1 1 0 0 1 .94-.7H21l-2.6 7.3a1 1 0 0 1-.94.7H4Z" />
      ) : (
        <path d="M3 6.5a1 1 0 0 1 1-1h5l2 2.2h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5Z" />
      )}
    </svg>
  );
}

/** A row cards can be dropped on: the card folder ("") or a subfolder. */
function FolderRow({
  rel,
  depth,
  label,
  count,
  expanded,
  selected,
  onClick,
}: {
  rel: string;
  depth: number;
  label: string;
  count: number;
  expanded: boolean | null;
  selected: boolean;
  onClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${rel}` });
  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      title={rel ? `${rel} · click to ${expanded ? "collapse" : "expand"}; drop a card here to move it` : "Drop a card here to move it out of its folder"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px",
        paddingLeft: 6 + depth * 14,
        border: `1px solid ${isOver ? "var(--accent)" : "transparent"}`,
        borderRadius: 6,
        background: isOver ? "var(--bg-page)" : selected ? "var(--bg-page)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 13,
        width: "100%",
      }}
    >
      <span style={{ width: 10, color: "var(--muted)", fontSize: 10, flexShrink: 0 }}>{expanded === null ? "" : expanded ? "▾" : "▸"}</span>
      <span style={{ color: selected ? "var(--accent)" : "var(--muted)", display: "flex" }}>
        <FolderGlyph open={!!expanded} />
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'IBM Plex Mono', monospace" }}>{count}</span>
    </button>
  );
}

function CardRow({
  card,
  depth,
  open,
  version,
  onOpen,
}: {
  card: CardFile;
  depth: number;
  open: boolean;
  version: number;
  onOpen: () => void;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: `card:${card.path}` });
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      title={`${card.card.name} · drag onto a folder to move it`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 5,
        marginLeft: depth * 14,
        border: `1px solid ${open ? "var(--accent)" : "transparent"}`,
        borderRadius: 8,
        background: open ? "var(--bg-page)" : "transparent",
        color: "var(--text)",
        cursor: "grab",
        textAlign: "left",
        opacity: isDragging ? 0.4 : 1,
        touchAction: "none",
      }}
    >
      <CardThumb card={card} version={version} />
      <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.card.name}</span>
    </button>
  );
}

function CardThumb({ card, version }: { card: CardFile; version: number }) {
  return (
    <span style={{ position: "relative", width: 40, height: 40, flexShrink: 0 }}>
      <img
        src={`${convertFileSrc(card.path)}?v=${version}`}
        alt=""
        draggable={false}
        style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, display: "block" }}
      />
      <RefMarker reference={card.card.reference} />
    </span>
  );
}

export default function CardTree({
  cards,
  folders,
  selected,
  openPath,
  version,
  onSelect,
  onOpenCard,
  onMove,
  onNewFolder,
  onRename,
  onRemove,
  onReveal,
}: {
  cards: CardFile[];
  folders: string[];
  /** The selected folder ("" for the card folder): new cards and folders go there. */
  selected: string;
  /** The card open in the editor. */
  openPath: string | null;
  version: number;
  onSelect: (rel: string) => void;
  onOpenCard: (card: CardFile) => void;
  onMove: (card: CardFile, to: string) => void;
  onNewFolder: () => void;
  onRename: () => void;
  onRemove: () => void;
  /** Shows the selected folder in File Explorer. */
  onReveal: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<CardFile | null>(null);
  // A small move first, so a click still opens the card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Cards per folder, counting subfolders' cards too.
  const counts = new Map<string, number>();
  for (const c of cards) {
    const parts = c.folder ? c.folder.split("/") : [];
    for (let i = 0; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const childFolders = (rel: string) =>
    folders.filter((f) => parentOf(f) === rel && f !== rel).sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }));
  const cardsIn = (rel: string) => cards.filter((c) => c.folder === rel);

  function clickFolder(rel: string) {
    onSelect(rel);
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const card = dragging;
    setDragging(null);
    const over = e.over?.id;
    if (!card || typeof over !== "string" || !over.startsWith("folder:")) return;
    const to = over.slice("folder:".length);
    if (to === card.folder) return;
    onMove(card, to);
    // Show where it went.
    setExpanded((x) => {
      const next = new Set(x);
      const parts = to.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }

  const render = (rel: string, depth: number): React.ReactNode => (
    <>
      {childFolders(rel).map((f) => {
        const open = expanded.has(f);
        return (
          <div key={f} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <FolderRow
              rel={f}
              depth={depth}
              label={nameOf(f)}
              count={counts.get(f) ?? 0}
              expanded={open}
              selected={selected === f}
              onClick={() => clickFolder(f)}
            />
            {open && render(f, depth + 1)}
          </div>
        );
      })}
      {cardsIn(rel).map((c) => (
        <CardRow key={c.path} card={c} depth={depth} open={openPath === c.path} version={version} onOpen={() => onOpenCard(c)} />
      ))}
      {depth > 0 && childFolders(rel).length === 0 && cardsIn(rel).length === 0 && (
        <span style={{ fontSize: 12, color: "var(--muted)", paddingLeft: 6 + depth * 14 + 16 }}>Empty</span>
      )}
    </>
  );

  const link: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
  const act = (label: string, fn: () => void, title?: string) => (
    <a
      href="#"
      title={title}
      onClick={(e) => {
        e.preventDefault();
        fn();
      }}
      style={link}
    >
      {label}
    </a>
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDragging(cards.find((c) => `card:${c.path}` === e.active.id) ?? null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
        {act("+ New folder", onNewFolder, selected ? `Make a folder inside ${selected}` : "Make a folder in the card folder")}
        {selected && act("Rename", onRename, `Rename ${selected}`)}
        {selected && act("Remove", onRemove, "Remove this folder (only when it's empty)")}
        {act("Show in Explorer", onReveal, selected ? `Show ${selected} in File Explorer` : "Show the card folder in File Explorer")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <FolderRow rel="" depth={0} label="All cards" count={cards.length} expanded={null} selected={selected === ""} onClick={() => onSelect("")} />
        {render("", 0)}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: 5,
              borderRadius: 8,
              border: "1px solid var(--accent)",
              background: "var(--bg-card)",
              boxShadow: "0 6px 16px rgba(0,0,0,.3)",
              cursor: "grabbing",
            }}
          >
            <CardThumb card={dragging} version={version} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{dragging.card.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
