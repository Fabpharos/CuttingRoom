import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ConfirmModal from "./ConfirmModal";
import { readImageMetadata } from "../lib/novelai";
import { moveFilesToTrash } from "../lib/nativeOps";
import { guessName } from "../lib/characterTags";
import {
  PARTS,
  listCards,
  loadCardFolder,
  promptOf,
  saveCard,
  saveCardFolder,
  tagsFromPrompt,
  type CardFile,
  type CardTag,
  type Part,
} from "../lib/characterCards";

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

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A prompt the image offers to make the card from. */
type PromptChoice = { label: string; prompt: string; negative: string };

type Draft = {
  /** The card's file when editing one; null for a new card. */
  path: string | null;
  /** The image a new card is made from. */
  image: string | null;
  name: string;
  text: string;
  tags: CardTag[];
  negative: string;
  /** The prompts the source image has (new cards only). */
  choices: PromptChoice[];
  choice: number;
};

export default function CharacterCardTab({ active }: { active: boolean }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [cards, setCards] = useState<CardFile[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CardFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState(0);

  const activeRef = useRef(active);
  activeRef.current = active;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // The folder is remembered; its cards are read the first time the tab opens.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      const f = await loadCardFolder().catch(() => null);
      if (f) {
        setFolder(f);
        await refresh(f);
      }
    })();
  }, [active]);

  async function refresh(f = folder) {
    if (!f) return;
    try {
      setCards(await listCards(f));
      setVersion((v) => v + 1);
    } catch (err) {
      setError(String(err));
      setCards([]);
    }
  }

  /** Runs `action` now, or after asking when there are unsaved changes. */
  function guard(action: () => void) {
    if (dirtyRef.current) setPendingDiscard(() => action);
    else action();
  }

  async function chooseFolder(): Promise<string | null> {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return null;
    setFolder(picked);
    setDraft(null);
    setDirty(false);
    setError(null);
    setMessage(null);
    await saveCardFolder(picked).catch((err) => setError(`Couldn't remember the folder: ${String(err)}`));
    await refresh(picked);
    return picked;
  }

  function openCard(file: CardFile) {
    guard(() => {
      setError(null);
      setMessage(null);
      setSelected(new Set());
      setDraft({
        path: file.path,
        image: null,
        name: file.card.name,
        text: promptOf(file.card.tags),
        tags: file.card.tags,
        negative: file.card.negative,
        choices: [],
        choice: 0,
      });
      setDirty(false);
    });
  }

  async function startFromImage(image: string) {
    setError(null);
    setMessage(null);
    const choices: PromptChoice[] = [];
    try {
      const s = await readImageMetadata(image);
      s.characters.forEach((c, i) => {
        if (c.trim()) choices.push({ label: `Character ${i + 1}`, prompt: c, negative: s.characterNegatives[i] ?? "" });
      });
      if (s.prompt.trim()) choices.push({ label: "Main prompt", prompt: s.prompt, negative: "" });
    } catch {
      // No NovelAI prompt: the user types one.
    }
    const first = choices[0];
    const tags = first ? tagsFromPrompt(first.prompt) : [];
    setSelected(new Set());
    setDraft({
      path: null,
      image,
      name: guessName(tags.map((t) => t.text)),
      text: first?.prompt ?? "",
      tags,
      negative: first?.negative ?? "",
      choices,
      choice: 0,
    });
    setDirty(true);
  }

  async function chooseImage() {
    const file = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
    });
    if (typeof file === "string") guard(() => void startFromImage(file));
  }

  // Drops are delivered window-wide, so only act on them while this tab is showing.
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
          if (image) guard(() => void startFromImage(image));
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

  function edit(change: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...change } : d));
    setDirty(true);
    setMessage(null);
  }

  function setText(text: string) {
    if (!draft) return;
    setSelected(new Set());
    edit({ text, tags: tagsFromPrompt(text, draft.tags) });
  }

  function pickChoice(i: number) {
    if (!draft) return;
    const c = draft.choices[i];
    const tags = tagsFromPrompt(c.prompt);
    setSelected(new Set());
    edit({ choice: i, text: c.prompt, tags, negative: c.negative, name: draft.name || guessName(tags.map((t) => t.text)) });
  }

  function moveSelected(part: Part) {
    if (!draft || selected.size === 0) return;
    edit({ tags: draft.tags.map((t, i) => (selected.has(i) ? { ...t, part } : t)) });
    setSelected(new Set());
  }

  // Keys 1–6 move the selected tags to that part.
  const moveRef = useRef(moveSelected);
  moveRef.current = moveSelected;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!activeRef.current || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= PARTS.length) {
        moveRef.current(PARTS[n - 1].key);
        e.preventDefault();
      } else if (e.key === "Escape") setSelected(new Set());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function runSave() {
    if (!draft) return;
    let f = folder;
    if (!f) {
      f = await chooseFolder();
      if (!f) return;
    }
    setSaving(true);
    setError(null);
    try {
      const card = { version: 1 as const, name: draft.name.trim(), tags: draft.tags, negative: draft.negative };
      const path = await saveCard(f, card, draft.path ? { existing: draft.path } : { image: draft.image! });
      await refresh(f);
      setDraft({ ...draft, path, image: null, name: card.name, choices: [], choice: 0 });
      setDirty(false);
      setMessage(`Saved ${fileName(path)}.`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function runDelete(file: CardFile) {
    setPendingDelete(null);
    try {
      await moveFilesToTrash([file.path]);
      if (draft?.path === file.path) {
        setDraft(null);
        setDirty(false);
      }
      await refresh();
      setMessage(`Moved ${fileName(file.path)} to the Recycle Bin.`);
    } catch (err) {
      setError(String(err));
    }
  }

  const imageSrc = draft
    ? draft.image
      ? convertFileSrc(draft.image)
      : draft.path
        ? `${convertFileSrc(draft.path)}?v=${version}`
        : null
    : null;

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Character Cards</div>
        <div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
          Character prompt presets for NovelAI. Make a card from a NovelAI image (open or drop one): its character
          prompt is split into tags, with eye and hair tags sorted automatically, and you sort the rest into face,
          upper body and lower body. In Generate, <b>Load character card</b> fills a character with it and can leave
          out what won't be seen (facing away, closed eyes, upper or lower body). Cards are saved as small PNGs in
          the folder you choose.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <button style={secondaryButtonStyle} onClick={() => guard(() => void chooseFolder())}>
          {folder ? "Change Folder…" : "Choose Card Folder…"}
        </button>
        {folder && (
          <>
            <span style={{ fontSize: 12.5, color: "var(--muted)", wordBreak: "break-all" }}>{folder}</span>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void refresh();
              }}
              style={{ fontSize: 12.5, fontWeight: 600 }}
            >
              Refresh
            </a>
          </>
        )}
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

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ ...cardStyle, width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <button style={primaryButtonStyle} onClick={() => void chooseImage()}>
            New Card from Image…
          </button>
          <div
            style={{
              fontSize: 12,
              color: dragging ? "var(--accent)" : "var(--muted)",
              textAlign: "center",
              padding: "6px 0",
              border: `1px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8,
            }}
          >
            {dragging ? "Drop to make a card" : "or drop an image here"}
          </div>
          {!folder && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
              Choose a folder to keep your cards in.
            </div>
          )}
          {folder && cards.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>No cards in this folder yet.</div>
          )}
          {cards.map((c) => {
            const isOpen = draft?.path === c.path;
            return (
              <button
                key={c.path}
                onClick={() => openCard(c)}
                title={fileName(c.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: 6,
                  border: `1px solid ${isOpen ? "var(--accent)" : "transparent"}`,
                  borderRadius: 8,
                  background: isOpen ? "var(--bg-page)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <img
                  src={`${convertFileSrc(c.path)}?v=${version}`}
                  alt=""
                  style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.card.name}
                </span>
              </button>
            );
          })}
        </div>

        {draft && (
          <div style={{ ...cardStyle, flex: 1, minWidth: 360, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              {imageSrc && (
                <img
                  src={imageSrc}
                  alt=""
                  style={{ width: 150, maxHeight: 220, objectFit: "contain", borderRadius: 6, flexShrink: 0 }}
                />
              )}
              <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={labelStyle}>Name</span>
                  <input
                    value={draft.name}
                    onChange={(e) => edit({ name: e.target.value })}
                    placeholder="e.g. Sparkle"
                    style={{ ...textareaStyle, resize: "none" }}
                  />
                </label>
                {draft.image && draft.choices.length > 1 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={labelStyle}>Read the prompt from</span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {draft.choices.map((c, i) => (
                        <button
                          key={i}
                          onClick={() => pickChoice(i)}
                          title={c.prompt}
                          style={{
                            ...secondaryButtonStyle,
                            padding: "4px 12px",
                            fontSize: 12,
                            background: draft.choice === i ? "var(--accent)" : "transparent",
                            color: draft.choice === i ? "var(--accent-contrast)" : "var(--text)",
                            borderColor: draft.choice === i ? "var(--accent)" : "var(--border)",
                          }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {draft.image && draft.choices.length === 0 && (
                  <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
                    No NovelAI prompt found in {fileName(draft.image)}. Type or paste the character's prompt below.
                  </div>
                )}
              </div>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelStyle}>Character prompt</span>
              <textarea rows={4} value={draft.text} onChange={(e) => setText(e.target.value)} style={textareaStyle} />
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
                Click tags to select them, then press a part's <b>Move here</b> (or its number key). Eye and hair tags
                were sorted for you; check them.
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
                {PARTS.map((p, n) => {
                  const tags = draft.tags.map((t, i) => ({ t, i })).filter(({ t }) => t.part === p.key);
                  return (
                    <div
                      key={p.key}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        minHeight: 70,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>
                          {n + 1}. {p.label}
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--muted)", flex: 1 }}>{p.hint}</span>
                        {selected.size > 0 && (
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              moveSelected(p.key);
                            }}
                            style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}
                          >
                            Move here
                          </a>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {tags.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>—</span>}
                        {tags.map(({ t, i }) => {
                          const on = selected.has(i);
                          return (
                            <button
                              key={i}
                              onClick={() =>
                                setSelected((s) => {
                                  const next = new Set(s);
                                  if (next.has(i)) next.delete(i);
                                  else next.add(i);
                                  return next;
                                })
                              }
                              style={{
                                padding: "2px 9px",
                                borderRadius: 999,
                                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                                background: on ? "var(--accent)" : "var(--bg-page)",
                                color: on ? "var(--accent-contrast)" : "var(--text)",
                                fontSize: 12.5,
                                fontFamily: "system-ui, sans-serif",
                                cursor: "pointer",
                              }}
                            >
                              {t.text}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={labelStyle}>Undesired content for this character</span>
              <textarea
                rows={2}
                value={draft.negative}
                onChange={(e) => edit({ negative: e.target.value })}
                style={textareaStyle}
              />
            </label>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                style={{ ...primaryButtonStyle, opacity: saving || !dirty || !draft.name.trim() ? 0.5 : 1 }}
                disabled={saving || !dirty || !draft.name.trim()}
                onClick={() => void runSave()}
              >
                {saving ? "Saving…" : draft.path ? "Save Changes" : "Save Card"}
              </button>
              {dirty && (
                <button
                  style={secondaryButtonStyle}
                  onClick={() => {
                    const file = cards.find((c) => c.path === draft.path);
                    setDirty(false);
                    dirtyRef.current = false;
                    if (file) openCard(file);
                    else setDraft(null);
                  }}
                >
                  Discard Changes
                </button>
              )}
              {draft.path && (
                <button
                  style={secondaryButtonStyle}
                  onClick={() => {
                    const file = cards.find((c) => c.path === draft.path);
                    if (file) setPendingDelete(file);
                  }}
                >
                  Delete Card
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {pendingDiscard && (
        <ConfirmModal
          title="Discard unsaved changes?"
          message="The card you're editing has changes that aren't saved."
          confirmLabel="Discard"
          cancelLabel="Cancel"
          onConfirm={() => {
            const action = pendingDiscard;
            setPendingDiscard(null);
            setDirty(false);
            dirtyRef.current = false;
            action();
          }}
          onCancel={() => setPendingDiscard(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Delete this card?"
          message={`${fileName(pendingDelete.path)} will be moved to the Recycle Bin.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={() => void runDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
