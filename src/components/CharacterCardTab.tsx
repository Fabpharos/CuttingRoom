import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ConfirmModal from "./ConfirmModal";
import {
  TEXT_FIELDS,
  emptyCard,
  listOf,
  readCharacterCard,
  suggestCardOutput,
  textOf,
  writeCharacterCard,
  type CardData,
  type CardInfo,
} from "../lib/characterCard";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

const textareaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-page)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.45,
  resize: "vertical",
};

const cardStyle: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "14px 16px",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 18px",
  border: "none",
  borderRadius: 999,
  background: "var(--accent)",
  color: "var(--accent-contrast)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  border: "1px solid var(--border)",
  borderRadius: 999,
  background: "transparent",
  color: "var(--text)",
  fontFamily: "'Space Grotesk', sans-serif",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };

const SPEC_LABELS: Record<string, string> = {
  chara_card_v3: "Character card V3",
  chara_card_v2: "Character card V2",
  v1: "Character card V1",
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

type PendingSave = { dest: string; inPlace: boolean };

export default function CharacterCardTab({ active }: { active: boolean }) {
  const [path, setPath] = useState<string | null>(null);
  const [info, setInfo] = useState<CardInfo | null>(null);
  // The card being edited; null while the image has none and none is being made.
  const [card, setCard] = useState<CardData | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);

  async function load(p: string) {
    setError(null);
    setMessage(null);
    try {
      const read = await readCharacterCard(p);
      setPath(p);
      setInfo(read);
      setCard(read.data);
      setDirty(false);
      setImageVersion((v) => v + 1);
    } catch (err) {
      setError(String(err));
    }
  }

  // Opening another image drops unsaved edits, so ask first.
  function requestOpen(p: string) {
    if (dirtyRef.current) setPendingOpen(p);
    else void load(p);
  }

  async function chooseImage() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
    });
    if (typeof file === "string") requestOpen(file);
  }

  // Drops are delivered window-wide, so only act on them while this tab is
  // the one showing.
  const activeRef = useRef(active);
  activeRef.current = active;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // not running inside Tauri (e.g. a plain browser preview)
    }
    webview
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (!activeRef.current) {
          setDragging(false);
          return;
        }
        if (p.type === "enter") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const image = p.paths.find((f) => IMAGE_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(`.${ext}`)));
          if (image) requestOpen(image);
          else if (p.paths.length > 0) setError("Drop a PNG, JPEG or WebP image.");
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(key: string, value: unknown) {
    setCard((c) => (c ? { ...c, [key]: value } : c));
    setDirty(true);
    setMessage(null);
  }

  async function saveAs() {
    if (!path) return;
    const dest = await save({
      defaultPath: await suggestCardOutput(path),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (dest) setPendingSave({ dest, inPlace: dest.toLowerCase() === path.toLowerCase() });
  }

  async function runSave({ dest }: PendingSave) {
    if (!path || !card) return;
    setPendingSave(null);
    setSaving(true);
    setError(null);
    try {
      await writeCharacterCard(path, dest, card);
      await load(dest);
      setMessage(`Saved the character card to ${fileName(dest)}.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  function saveWarning({ dest, inPlace }: PendingSave): string {
    const lines = ["Existing AI image metadata might be overwritten."];
    if (info?.aiMetadata.length) {
      lines.push(
        `This image has ${info.aiMetadata.join(", ")} generation metadata. Cutting Room keeps it in the PNG, but other apps that read or edit character cards may replace or remove it.`,
      );
    }
    if (info && !info.isPng) {
      lines.push("The image isn't a PNG, so it's converted to one; its own metadata (such as EXIF) is not carried over.");
    }
    if (info?.data && inPlace) lines.push("The character card already in this image will be replaced.");
    lines.push(inPlace ? `${fileName(dest)} is changed in place.` : `The card is saved in a new image: ${fileName(dest)}.`);
    return lines.join("\n\n");
  }

  const tags = card ? listOf(card, "tags") : [];
  const greetings = card ? listOf(card, "alternate_greetings") : [];

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Character Card</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.6,
          }}
        >
          Views and edits the character card (SillyTavern / Tavern V1–V3 format) stored in a PNG,
          or makes a new one. Open or drop an image to start. Saving writes a V2 and a V3 card into
          the PNG, as SillyTavern does.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <button style={primaryButtonStyle} onClick={() => void chooseImage()}>
          Open Image…
        </button>
        {path && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{fileName(path)}</span>}
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(200,60,50,.12)",
            border: "1px solid rgba(200,60,50,.35)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      {message && <div style={{ marginBottom: 14, fontSize: 13 }}>{message}</div>}

      {path && info && (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ ...cardStyle, width: 260, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <img
              src={`${convertFileSrc(path)}?v=${imageVersion}`}
              alt=""
              style={{ width: "100%", borderRadius: 6, display: "block" }}
            />
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {info.spec ? (SPEC_LABELS[info.spec] ?? info.spec) : "No character card"}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
              {info.isPng
                ? info.aiMetadata.length > 0
                  ? `AI metadata: ${info.aiMetadata.join(", ")}`
                  : "No AI generation metadata found."
                : "Not a PNG: a card can be saved into a PNG copy."}
            </div>
            {!card && (
              <button
                style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}
                onClick={() => {
                  setCard(emptyCard());
                  setDirty(true);
                }}
              >
                Create Card
              </button>
            )}
          </div>

          {card && (
            <div style={{ ...cardStyle, flex: 1, minWidth: 320, display: "flex", flexDirection: "column", gap: 12 }}>
              {TEXT_FIELDS.map((f) => (
                <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={labelStyle}>{f.label}</span>
                  <textarea
                    rows={f.rows}
                    value={textOf(card, f.key)}
                    onChange={(e) => update(f.key, e.target.value)}
                    style={{ ...textareaStyle, resize: f.rows === 1 ? "none" : "vertical" }}
                  />
                </label>
              ))}

              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={labelStyle}>Tags (comma-separated)</span>
                <textarea
                  rows={1}
                  value={tags.join(", ")}
                  onChange={(e) =>
                    update(
                      "tags",
                      e.target.value.split(",").map((t, i, all) => (i < all.length - 1 ? t.trim() : t.trimStart())),
                    )
                  }
                  onBlur={() => update("tags", tags.map((t) => t.trim()).filter((t) => t !== ""))}
                  style={{ ...textareaStyle, resize: "none" }}
                />
              </label>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={labelStyle}>Alternate greetings ({greetings.length})</span>
                {greetings.map((g, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <textarea
                      rows={4}
                      value={g}
                      onChange={(e) => update("alternate_greetings", greetings.map((x, j) => (j === i ? e.target.value : x)))}
                      style={textareaStyle}
                    />
                    <button
                      onClick={() => update("alternate_greetings", greetings.filter((_, j) => j !== i))}
                      style={{ alignSelf: "flex-start", border: "none", background: "none", padding: 0, color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    >
                      Remove greeting
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => update("alternate_greetings", [...greetings, ""])}
                  style={{ alignSelf: "flex-start", border: "none", background: "none", padding: 0, color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                >
                  + Add greeting
                </button>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
                {info.isPng && (
                  <button
                    style={primaryButtonStyle}
                    disabled={saving}
                    onClick={() => setPendingSave({ dest: path, inPlace: true })}
                  >
                    Save to This Image
                  </button>
                )}
                <button style={secondaryButtonStyle} disabled={saving} onClick={() => void saveAs()}>
                  Save as New PNG…
                </button>
                {dirty && (
                  <button
                    style={secondaryButtonStyle}
                    disabled={saving}
                    onClick={() => {
                      setCard(info.data);
                      setDirty(false);
                    }}
                  >
                    Discard Changes
                  </button>
                )}
                {saving && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Saving…</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {pendingSave && (
        <ConfirmModal
          title={info?.data ? "Save the character card?" : "Add a character card?"}
          message={saveWarning(pendingSave)}
          confirmLabel="Save"
          cancelLabel="Cancel"
          onConfirm={() => void runSave(pendingSave)}
          onCancel={() => setPendingSave(null)}
        />
      )}

      {pendingOpen && (
        <ConfirmModal
          title="Discard unsaved changes?"
          message={`The card you're editing has changes that aren't saved. Open ${fileName(pendingOpen)} anyway?`}
          confirmLabel="Discard and Open"
          cancelLabel="Cancel"
          onConfirm={() => {
            const p = pendingOpen;
            setPendingOpen(null);
            void load(p);
          }}
          onCancel={() => setPendingOpen(null)}
        />
      )}

      {dragging && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 250,
            background: "rgba(0,0,0,.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            color: "#fff",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Drop an image to open its character card
        </div>
      )}
    </div>
  );
}
