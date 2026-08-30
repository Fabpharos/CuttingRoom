import type { ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import AlbumHeader from "./AlbumHeader";
import Thumbnail from "./Thumbnail";
import { TagAwarePointerSensor } from "../lib/dndSensors";

export type ImageEntry = {
  name: string;
  src: string;
};

function FilterChip({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px 5px 9px",
        borderRadius: 999,
        border: active ? "none" : "1px solid var(--border)",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--accent-contrast)" : "var(--muted)",
        fontFamily: "'Space Grotesk', sans-serif",
        fontWeight: 600,
        fontSize: 12.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
      {label}
    </button>
  );
}

const HEART_PATH =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z";

export default function ImageGrid({
  folderPath,
  albumName,
  images,
  totalCount,
  tags,
  favorites,
  selectedNames,
  needsEditFilterOn,
  favoritesFilterOn,
  onChangeFolder,
  onCommitName,
  onReorder,
  onToggleTag,
  onToggleFavorite,
  onSelect,
  onClearSelection,
  onOpenViewer,
  onToggleNeedsEditFilter,
  onToggleFavoritesFilter,
  nameRevertToken,
}: {
  folderPath: string;
  albumName: string;
  images: ImageEntry[];
  totalCount: number;
  tags: Record<string, boolean>;
  favorites: Record<string, boolean>;
  selectedNames: Set<string>;
  needsEditFilterOn: boolean;
  favoritesFilterOn: boolean;
  onChangeFolder: () => void;
  onCommitName: (newName: string) => void;
  onReorder: (newOrder: string[]) => void;
  onToggleTag: (name: string) => void;
  onToggleFavorite: (name: string) => void;
  onSelect: (index: number, shiftKey: boolean, ctrlKey: boolean) => void;
  onClearSelection: () => void;
  onOpenViewer: (index: number) => void;
  onToggleNeedsEditFilter: () => void;
  onToggleFavoritesFilter: () => void;
  nameRevertToken?: number;
}) {
  // Distance-based activation: the drag starts the instant the pointer moves
  // past a small threshold, so there's no perceptible lag when picking up a
  // photo. Clicks on the tag badge are excluded at the source (see
  // TagAwarePointerSensor / data-no-dnd), so a short distance here is safe —
  // it no longer has to also double as click-vs-drag disambiguation.
  const sensors = useSensors(
    useSensor(TagAwarePointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = images.findIndex((img) => img.name === active.id);
    const newIndex = images.findIndex((img) => img.name === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(images, oldIndex, newIndex).map((img) => img.name));
  }

  return (
    <div style={{ padding: "20px 24px 24px 24px" }}>
      <AlbumHeader
        albumName={albumName}
        folderPath={folderPath}
        photoCount={images.length}
        totalCount={totalCount}
        onChangeFolder={onChangeFolder}
        onCommitName={onCommitName}
        revertToken={nameRevertToken}
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <FilterChip
          active={needsEditFilterOn}
          onClick={onToggleNeedsEditFilter}
          label="Needs editing"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            style={{ stroke: needsEditFilterOn ? "var(--accent-contrast)" : "var(--muted)" }}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </FilterChip>
        <FilterChip
          active={favoritesFilterOn}
          onClick={onToggleFavoritesFilter}
          label="Favorites"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill={favoritesFilterOn ? "var(--accent-contrast)" : "none"}
            style={{ stroke: favoritesFilterOn ? "var(--accent-contrast)" : "var(--muted)" }}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={HEART_PATH} />
          </svg>
        </FilterChip>
      </div>

      {images.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          {needsEditFilterOn || favoritesFilterOn
            ? "No photos match the active filter."
            : "No images found in this folder."}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={images.map((img) => img.name)}
            strategy={rectSortingStrategy}
          >
            <div
              onClick={onClearSelection}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: 12,
              }}
            >
              {images.map((img, i) => (
                <Thumbnail
                  key={img.name}
                  id={img.name}
                  src={img.src}
                  name={img.name}
                  needsEdit={!!tags[img.name]}
                  favorite={!!favorites[img.name]}
                  selected={selectedNames.has(img.name)}
                  onToggleTag={() => onToggleTag(img.name)}
                  onToggleFavorite={() => onToggleFavorite(img.name)}
                  onSelect={(shiftKey, ctrlKey) => onSelect(i, shiftKey, ctrlKey)}
                  onOpen={() => onOpenViewer(i)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
