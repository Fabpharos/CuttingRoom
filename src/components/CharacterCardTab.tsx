import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ConfirmModal from "./ConfirmModal";
import TagSuggestions from "./TagSuggestions";
import { readImageMetadata } from "../lib/novelai";
import { moveFilesToTrash } from "../lib/nativeOps";
import { guessName } from "../lib/characterTags";
import {
  PARTS,
  CARD_REFERENCE_TYPES,
  createCardFolder,
  folderPath,
  listCardFolders,
  moveCard,
  removeCardFolder,
  renameCardFolder,
  listCards,
  loadCardFolder,
  promptOf,
  saveCard,
  saveCardFolder,
  tagsFromPrompt,
  GENDERS,
  CARD_V2_DEFAULTS,
  cleanLabels,
  guessGender,
  type CardFile,
  type CardReference,
  type CardSwap,
  type CardTag,
  type Gender,
  type Part,
} from "../lib/characterCards";
import HelpTip from "./HelpTip";
import AssociationsDialog from "./AssociationsDialog";
import RefMarker from "./RefMarker";

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
  /** The subfolder it's saved in ("" for the card folder itself). */
  folder: string;
  /** The image a new card is made from. */
  image: string | null;
  name: string;
  text: string;
  tags: CardTag[];
  negative: string;
  gender: Gender;
  /** Comma-separated, as typed. */
  labels: string;
  swaps: CardSwap[];
  reference: CardReference | null;
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
  const [showAssociations, setShowAssociations] = useState(false);
  // Subfolders of the card folder, and the one the list shows.
  const [folders, setFolders] = useState<string[]>([]);
  const [subfolder, setSubfolder] = useState("");
  const [folderPrompt, setFolderPrompt] = useState<{ mode: "new" | "rename"; value: string } | null>(null);

  // Prompt boxes marked data-tags get Danbooru tag suggestions.
  const rootRef = useRef<HTMLDivElement>(null);
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
      const [list, subs] = await Promise.all([listCards(f), listCardFolders(f).catch(() => [] as string[])]);
      setCards(list);
      setFolders(subs);
      setSubfolder((s) => (s === "" || subs.includes(s) ? s : ""));
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
    setSubfolder("");
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
        folder: file.folder,
        image: null,
        name: file.card.name,
        text: promptOf(file.card.tags),
        tags: file.card.tags,
        negative: file.card.negative,
        gender: file.card.gender,
        labels: file.card.labels.join(", "),
        swaps: file.card.swaps,
        reference: file.card.reference,
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
      folder: subfolder,
      image,
      name: guessName(tags.map((t) => t.text)),
      text: first?.prompt ?? "",
      tags,
      negative: first?.negative ?? "",
      ...CARD_V2_DEFAULTS,
      gender: guessGender(tags),
      labels: "",
      // The image the card is made from is its reference unless the user
      // removes it or picks another (it only costs anything when Generate
      // sends it, which shows the price and asks first).
      reference: { path: image, type: "character", strength: 1, fidelity: 1, preferSameOutfit: false },
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
      const card = {
        version: 2 as const,
        name: draft.name.trim(),
        tags: draft.tags,
        negative: draft.negative,
        gender: draft.gender,
        labels: cleanLabels(draft.labels.split(",")),
        swaps: draft.swaps.filter((x) => x.from.trim()),
        reference: draft.reference,
      };
      const path = await saveCard(folderPath(f, draft.folder), card, draft.path ? { existing: draft.path } : { image: draft.image! });
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

  /** Uses the card's own picture as its reference: the source image of a new card, or the saved card's thumbnail. */
  function useOwnImage() {
    const path = draft?.image ?? draft?.path;
    if (!draft || !path) return;
    edit({ reference: { type: "character", strength: 1, fidelity: 1, preferSameOutfit: false, ...draft.reference, path } });
  }

  async function chooseReference() {
    const picked = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string" || !draft) return;
    edit({ reference: { type: "character", strength: 1, fidelity: 1, preferSameOutfit: false, ...draft.reference, path: picked } });
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

  // The cards in the open folder, and how many cards each folder holds (its subfolders' too).
  const shownCards = cards.filter((c) => c.folder === subfolder);
  const folderCounts = new Map<string, number>();
  for (const c of cards) {
    const parts = c.folder ? c.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("/");
      folderCounts.set(key, (folderCounts.get(key) ?? 0) + 1);
    }
  }

  async function runFolderPrompt() {
    if (!folder || !folderPrompt) return;
    const name = folderPrompt.value.trim();
    if (!name) return;
    if (/[\\/]/.test(name)) {
      setError("A folder name can't contain / or \\. Open a folder first to make one inside it.");
      return;
    }
    const parent = folderPrompt.mode === "new" ? subfolder : subfolder.split("/").slice(0, -1).join("/");
    const rel = parent ? `${parent}/${name}` : name;
    try {
      if (folderPrompt.mode === "new") await createCardFolder(folder, rel);
      else await renameCardFolder(folder, subfolder, rel);
      setFolderPrompt(null);
      setError(null);
      // The open card's file moves with a renamed folder.
      if (folderPrompt.mode === "rename" && draft?.path && (draft.folder === subfolder || draft.folder.startsWith(`${subfolder}/`))) {
        guard(() => setDraft(null));
      }
      await refresh(folder);
      setSubfolder(rel);
    } catch (err) {
      setError(String(err));
    }
  }

  async function runRemoveFolder() {
    if (!folder || !subfolder) return;
    try {
      await removeCardFolder(folder, subfolder);
      const parent = subfolder.split("/").slice(0, -1).join("/");
      setSubfolder(parent);
      setError(null);
      await refresh(folder);
    } catch (err) {
      setError(String(err));
    }
  }

  /** Moves the open card to another folder (a new one just records where it'll be saved). */
  async function moveDraft(to: string) {
    if (!draft || !folder || to === draft.folder) return;
    if (!draft.path) {
      setDraft({ ...draft, folder: to });
      return;
    }
    try {
      const path = await moveCard(folder, draft.path, to);
      setDraft({ ...draft, path, folder: to });
      setMessage(`Moved ${draft.name || fileName(path)} to ${to || "the card folder"}.`);
      setError(null);
      await refresh(folder);
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
    <div ref={rootRef} style={{ padding: 24, maxWidth: 1200 }}>
      <TagSuggestions root={rootRef} active={active} />
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
            <button style={{ ...secondaryButtonStyle, marginLeft: "auto" }} onClick={() => setShowAssociations(true)}>
              Tag associations…
            </button>
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
          {folder && (
            <FolderNav
              current={subfolder}
              folders={folders}
              counts={folderCounts}
              onOpen={setSubfolder}
              onNew={() => setFolderPrompt({ mode: "new", value: "" })}
              onRename={() => setFolderPrompt({ mode: "rename", value: subfolder.split("/").pop() ?? "" })}
              onRemove={() => void runRemoveFolder()}
            />
          )}
          {folder && shownCards.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
              {subfolder ? "No cards in this folder yet." : cards.length === 0 ? "No cards in this folder yet." : "No cards here; open a folder above."}
            </div>
          )}
          {shownCards.map((c) => {
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
                <span style={{ position: "relative", width: 44, height: 44, flexShrink: 0 }}>
                  <img
                    src={`${convertFileSrc(c.path)}?v=${version}`}
                    alt=""
                    style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, display: "block" }}
                  />
                  <RefMarker reference={c.card.reference} />
                </span>
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
                {folder && (folders.length > 0 || draft.folder) && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={labelStyle}>Folder</span>
                    <select
                      value={draft.folder}
                      onChange={(e) => void moveDraft(e.target.value)}
                      title={draft.path ? "Moves the card to this folder now" : "Where the card will be saved"}
                      style={{ ...textareaStyle, resize: "none", padding: "5px 8px", flex: 1, minWidth: 0 }}
                    >
                      <option value="">(card folder)</option>
                      {folders.map((f) => (
                        <option key={f} value={f}>
                          {f.replace(/\//g, " › ")}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
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
              <textarea
                rows={4}
                value={draft.text}
                data-tags
                onChange={(e) => setText(e.target.value)}
                style={textareaStyle}
              />
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
                data-tags
                onChange={(e) => edit({ negative: e.target.value })}
                style={textareaStyle}
              />
            </label>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={labelStyle}>
                  Gender
                  <HelpTip lines={[{ text: "Used by Generate's gender swap and to filter character pools." }]} />
                </span>
                <select
                  value={draft.gender}
                  onChange={(e) => edit({ gender: e.target.value as Gender })}
                  style={{ ...textareaStyle, resize: "none", padding: "6px 8px" }}
                >
                  {GENDERS.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, flex: "1 1 240px" }}>
                <span style={labelStyle}>
                  Labels
                  <HelpTip
                    lines={[
                      { text: "Your own groups, separated by commas (e.g. pokemon, oc, manga-cast)." },
                      { text: "Generate can pick the next or a random card from a label, and tag associations can apply only to cards with a label." },
                    ]}
                  />
                </span>
                <input
                  value={draft.labels}
                  onChange={(e) => edit({ labels: e.target.value })}
                  placeholder="e.g. oc, manga-cast"
                  style={{ ...textareaStyle, resize: "none" }}
                />
              </label>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>
                Swaps
                <HelpTip
                  lines={[
                    { syntax: "$c1 swap: boy$", text: "In Generate, becomes this card's replacement for “boy” (when it's in slot 1)." },
                    { text: "e.g. boy → girl, so one prompt works whichever card is in the slot." },
                  ]}
                />
              </span>
              {draft.swaps.map((sw, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    value={sw.from}
                    onChange={(e) => edit({ swaps: draft.swaps.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })}
                    placeholder="tag"
                    style={{ ...textareaStyle, resize: "none", padding: "4px 8px", flex: 1 }}
                  />
                  <span style={{ color: "var(--muted)" }}>→</span>
                  <input
                    value={sw.to}
                    onChange={(e) => edit({ swaps: draft.swaps.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })}
                    placeholder="becomes"
                    style={{ ...textareaStyle, resize: "none", padding: "4px 8px", flex: 1 }}
                  />
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      edit({ swaps: draft.swaps.filter((_, j) => j !== i) });
                    }}
                    style={{ fontSize: 12, fontWeight: 600 }}
                  >
                    Remove
                  </a>
                </div>
              ))}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  edit({ swaps: [...draft.swaps, { from: "", to: "" }] });
                }}
                style={{ fontSize: 12.5, fontWeight: 600, alignSelf: "flex-start" }}
              >
                + Add swap
              </a>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>
                Precise Reference
                <HelpTip
                  lines={[
                    { text: "A reference image that comes with the card, so the character stays the same across images. A new card uses the image it's made from; Remove it to make a card without one." },
                    { text: "V5 and V4.5. NovelAI charges 5 Anlas per image for each reference; Generate shows the price and asks first." },
                  ]}
                />
              </span>
              {draft.reference ? (
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <img
                    src={convertFileSrc(draft.reference.path)}
                    alt=""
                    style={{ width: 72, height: 72, objectFit: "contain", borderRadius: 6, background: "var(--bg-page)" }}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, flex: 1, minWidth: 220 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      {CARD_REFERENCE_TYPES.map(({ key: t, label }) => (
                        <button
                          key={t}
                          onClick={() => edit({ reference: { ...draft.reference!, type: t } })}
                          title={t === "outfit" ? "Outfit references are V5 only; on V4.5 they're left out" : undefined}
                          style={{
                            ...secondaryButtonStyle,
                            padding: "3px 10px",
                            fontSize: 12,
                            background: draft.reference!.type === t ? "var(--accent)" : "transparent",
                            color: draft.reference!.type === t ? "var(--accent-contrast)" : "var(--text)",
                            borderColor: draft.reference!.type === t ? "var(--accent)" : "var(--border)",
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {(["strength", "fidelity"] as const).map((k) => (
                      <label key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ minWidth: 128 }}>
                          {k === "strength" ? "Strength" : "Fidelity (V4.5)"} {draft.reference![k].toFixed(2)}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={k === "strength" ? 5 : 1}
                          step={0.05}
                          value={draft.reference![k]}
                          onChange={(e) => edit({ reference: { ...draft.reference!, [k]: Number(e.target.value) } })}
                          style={{ flex: 1, accentColor: "var(--accent)" }}
                        />
                      </label>
                    ))}
                    {(draft.reference.type === "character" || draft.reference.type === "character&style") && (
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={draft.reference.preferSameOutfit}
                        onChange={(e) => edit({ reference: { ...draft.reference!, preferSameOutfit: e.target.checked } })}
                        style={{ accentColor: "var(--accent)" }}
                      />
                      Prefer same outfit (V5)
                    </label>
                    )}
                    <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                      Strength above 1 is for V5; V4.5 uses at most 1. Fidelity is V4.5 only.
                    </div>
                    <div style={{ display: "flex", gap: 12 }}>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void chooseReference();
                        }}
                        style={{ fontWeight: 600 }}
                      >
                        Change image…
                      </a>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          edit({ reference: null });
                        }}
                        style={{ fontWeight: 600 }}
                      >
                        Remove
                      </a>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 14, fontSize: 12.5, flexWrap: "wrap" }}>
                  {(draft.image ?? draft.path) && (
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        useOwnImage();
                      }}
                      title={draft.image ? "Use the image this card is made from" : "Use this card's picture (its saved thumbnail, up to 512 pixels)"}
                      style={{ fontWeight: 600 }}
                    >
                      {draft.image ? "Use this image" : "Use the card's picture"}
                    </a>
                  )}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void chooseReference();
                    }}
                    style={{ fontWeight: 600 }}
                  >
                    Choose reference image…
                  </a>
                </div>
              )}
            </div>

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

      {showAssociations && folder && (
        <AssociationsDialog folder={folder} cards={cards} onClose={() => setShowAssociations(false)} />
      )}

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

      {folderPrompt && (
        <div
          onClick={() => setFolderPrompt(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void runFolderPrompt();
            }}
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "20px 22px",
              width: 360,
              maxWidth: "90vw",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {folderPrompt.mode === "new" ? `New folder${subfolder ? ` in ${subfolder.replace(/\//g, " › ")}` : ""}` : "Rename folder"}
            </div>
            <input
              autoFocus
              value={folderPrompt.value}
              onChange={(e) => setFolderPrompt({ ...folderPrompt, value: e.target.value })}
              placeholder="e.g. Outfits"
              style={{ ...textareaStyle, resize: "none" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setFolderPrompt(null)}>
                Cancel
              </button>
              <button type="submit" style={{ ...primaryButtonStyle, opacity: folderPrompt.value.trim() ? 1 : 0.5 }} disabled={!folderPrompt.value.trim()}>
                {folderPrompt.mode === "new" ? "Make folder" : "Rename"}
              </button>
            </div>
          </form>
        </div>
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

function FolderIconSmall() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M3 6.5a1 1 0 0 1 1-1h5l2 2.2h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5Z" />
    </svg>
  );
}

/**
 * The card list's folder bar: where you are (each step clickable), the
 * folders inside it, and small New / Rename / Remove links.
 */
function FolderNav({
  current,
  folders,
  counts,
  onOpen,
  onNew,
  onRename,
  onRemove,
}: {
  current: string;
  folders: string[];
  counts: Map<string, number>;
  onOpen: (rel: string) => void;
  onNew: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const steps = current ? current.split("/") : [];
  const children = folders.filter((f) => {
    if (current === "") return !f.includes("/");
    return f.startsWith(`${current}/`) && !f.slice(current.length + 1).includes("/");
  });
  const link: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", fontSize: 12, minHeight: 22 }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onOpen("");
          }}
          style={{ ...link, color: current ? "var(--accent)" : "var(--text)" }}
        >
          All cards
        </a>
        {steps.map((s, i) => {
          const rel = steps.slice(0, i + 1).join("/");
          const last = i === steps.length - 1;
          return (
            <span key={rel} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--muted)" }}>›</span>
              {last ? (
                <span style={{ fontWeight: 600 }}>{s}</span>
              ) : (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(rel);
                  }}
                  style={link}
                >
                  {s}
                </a>
              )}
            </span>
          );
        })}
      </div>
      {children.map((f) => (
        <button
          key={f}
          onClick={() => onOpen(f)}
          title={f}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 6px",
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--muted)", display: "flex" }}>
            <FolderIconSmall />
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
            {f.split("/").pop()}
          </span>
          <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'IBM Plex Mono', monospace" }}>{counts.get(f) ?? 0}</span>
        </button>
      ))}
      <div style={{ display: "flex", gap: 12, paddingTop: 2 }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onNew();
          }}
          style={link}
        >
          + New folder
        </a>
        {current && (
          <>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onRename();
              }}
              style={link}
            >
              Rename
            </a>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onRemove();
              }}
              title="Remove this folder (only when it's empty)"
              style={link}
            >
              Remove
            </a>
          </>
        )}
      </div>
    </div>
  );
}
