import { useEffect, useRef, useState } from "react";
import {
  applyCompletion,
  findSuggestions,
  formatCount,
  loadTagIndex,
  type TagIndex,
  type TagMatch,
} from "../lib/tagAutocomplete";

// Danbooru's tag categories, as small dots in muted tones that sit with the
// app's warm palette in both themes.
const CATEGORY_COLOURS: Record<string, string> = {
  general: "#6f8fb5",
  character: "#6a9a5b",
  copyright: "#a173b0",
  artist: "#c0604a",
  meta: "#c9963a",
  nai: "#4f9e98",
};
const CATEGORY_NAMES: Record<string, string> = {
  general: "General tag",
  character: "Character",
  copyright: "Copyright",
  artist: "Artist",
  meta: "Meta tag",
  nai: "NovelAI quality/aesthetic tag",
};

const MAX_ROWS = 10;
const ROW_HEIGHT = 28;
const WIDTH = 320;

type Open = {
  el: HTMLTextAreaElement;
  start: number;
  end: number;
  matches: TagMatch[];
  active: number;
  left: number;
  top: number;
  /** Shown above the caret when there's no room below. */
  above: boolean;
};

/** Where the caret of `el` is on screen (its line's top and bottom), via a hidden copy of the box. */
function caretRect(el: HTMLTextAreaElement, pos: number): { left: number; top: number; bottom: number } {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
    "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "fontWeight",
    "fontStyle", "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "tabSize",
  ] as const) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    overflow: "hidden",
    top: "0",
    left: "0",
  });
  mirror.textContent = el.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(pos) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
  const box = el.getBoundingClientRect();
  const left = box.left + marker.offsetLeft - el.scrollLeft;
  const top = box.top + marker.offsetTop - el.scrollTop;
  document.body.removeChild(mirror);
  return { left, top, bottom: top + lineHeight };
}

/** Replaces el's text [start, end) with `text` the way typing would, so Ctrl+Z undoes it and React sees it. */
function insertText(el: HTMLTextAreaElement, start: number, end: number, text: string) {
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(start + text.length, start + text.length);
  }
}

/**
 * Danbooru tag suggestions under the caret, for every `<textarea data-tags>`
 * inside `root`. Typing opens them; Up/Down (Page Up/Down) choose, Tab or
 * Enter inserts, Escape closes, a click inserts, Ctrl+Space opens them on
 * demand. Text the user didn't accept is never changed.
 */
export default function TagSuggestions({ root, active }: { root: React.RefObject<HTMLElement | null>; active: boolean }) {
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const indexRef = useRef<TagIndex | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<(row: number) => void>(() => {});

  // The tag list loads the first time the tab is shown, not at launch.
  useEffect(() => {
    if (!active || indexRef.current) return;
    const t = setTimeout(() => {
      loadTagIndex()
        .then((idx) => (indexRef.current = idx))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [active]);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const isPromptBox = (t: EventTarget | null): t is HTMLTextAreaElement =>
      t instanceof HTMLTextAreaElement && t.dataset.tags !== undefined && !t.readOnly;
    let composing = false;

    function update(el: HTMLTextAreaElement, openIt: boolean, force = false) {
      const idx = indexRef.current;
      const cur = openRef.current;
      if (!idx || el.selectionStart !== el.selectionEnd || (!openIt && !cur)) {
        // Still loading: show suggestions once it's ready, if the user is still in this box.
        if (!idx && openIt)
          void loadTagIndex().then(
            (i) => {
              indexRef.current = i;
              if (document.activeElement === el) update(el, true, force);
            },
            () => {},
          );
        setOpen(null);
        return;
      }
      const found = findSuggestions(idx, el.value, el.selectionStart, force);
      if (!found) {
        setOpen(null);
        return;
      }
      const caret = caretRect(el, found.start);
      const rows = Math.min(found.matches.length, MAX_ROWS);
      const height = rows * ROW_HEIGHT + 32;
      const above = caret.bottom + height + 8 > window.innerHeight && caret.top - height - 8 > 0;
      const left = Math.max(8, Math.min(caret.left - 10, window.innerWidth - WIDTH - 8));
      const keep = cur && cur.el === el && cur.start === found.start ? cur.matches[cur.active]?.name : undefined;
      const activeRow = Math.max(0, found.matches.findIndex((m) => m.name === keep));
      setOpen({ el, ...found, active: activeRow, left, top: above ? caret.top - 4 : caret.bottom + 4, above });
    }

    function accept(row: number) {
      const cur = openRef.current;
      if (!cur) return;
      const m = cur.matches[row];
      setOpen(null);
      if (!m) return;
      const old = cur.el.value;
      const [next, cursor] = applyCompletion(old, cur.start, cur.end, m.name);
      // Trailing spaces at the very end are replaced along with the tag.
      const replaceEnd = /^[ \t]*$/.test(old.slice(cur.end)) ? old.length : cur.end;
      insertText(cur.el, cur.start, replaceEnd, next.slice(cur.start, cursor));
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!isPromptBox(e.target)) return;
      const el = e.target;
      const cur = openRef.current;
      if (cur && cur.el === el) {
        const n = cur.matches.length;
        const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -MAX_ROWS, PageDown: MAX_ROWS }[e.key];
        if (step !== undefined) {
          e.preventDefault();
          setOpen({ ...cur, active: Math.max(0, Math.min(n - 1, cur.active + step)) });
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          accept(cur.active);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(null);
          return;
        }
      }
      if (e.key === " " && e.ctrlKey) {
        e.preventDefault();
        setTimeout(() => update(el, true, true), 0);
        return;
      }
      // Moving the caret refreshes an open list (or closes it once off the tag).
      if (cur && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) setTimeout(() => update(el, false), 0);
    }

    function onInput(e: Event) {
      if (!isPromptBox(e.target) || composing) return;
      const el = e.target;
      const typed = e instanceof InputEvent && (e.inputType === "insertText" || e.inputType.startsWith("delete"));
      if (e instanceof InputEvent && e.inputType === "insertText" && /[,|]/.test(e.data ?? "")) {
        setOpen(null);
        return;
      }
      update(el, typed);
    }

    const close = () => setOpen(null);
    const onFocusOut = (e: FocusEvent) => {
      if (isPromptBox(e.target)) setTimeout(() => document.activeElement !== openRef.current?.el && close(), 150);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (openRef.current && !listRef.current?.contains(e.target as Node)) close();
    };
    const onCompStart = () => (composing = true);
    const onCompEnd = (e: Event) => {
      composing = false;
      if (isPromptBox(e.target)) update(e.target, true);
    };

    host.addEventListener("keydown", onKeyDown, true);
    host.addEventListener("input", onInput, true);
    host.addEventListener("focusout", onFocusOut, true);
    host.addEventListener("compositionstart", onCompStart, true);
    host.addEventListener("compositionend", onCompEnd, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    // accept() is used by the list's clicks too
    acceptRef.current = accept;
    return () => {
      host.removeEventListener("keydown", onKeyDown, true);
      host.removeEventListener("input", onInput, true);
      host.removeEventListener("focusout", onFocusOut, true);
      host.removeEventListener("compositionstart", onCompStart, true);
      host.removeEventListener("compositionend", onCompEnd, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [root]);

  // Keep the chosen row in view.
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const row = list.children[open.active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [open]);

  if (!open || !active) return null;

  // Rendered in place (not portalled to <body>) so it inherits the theme's colours; it's fixed-positioned anyway.
  return (
    <div
      onMouseDown={(e) => e.preventDefault()} // keep focus (and the caret) in the prompt box
      style={{
        position: "fixed",
        left: open.left,
        top: open.top,
        transform: open.above ? "translateY(-100%)" : undefined,
        width: WIDTH,
        zIndex: 400,
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,.18)",
        overflow: "hidden",
        fontFamily: "system-ui, sans-serif",
        color: "var(--text)",
      }}
    >
      <div ref={listRef} role="listbox" style={{ maxHeight: MAX_ROWS * ROW_HEIGHT, overflowY: "auto", padding: "3px 0" }}>
        {open.matches.map((m, i) => (
          <div
            key={m.name}
            role="option"
            aria-selected={i === open.active}
            title={`${CATEGORY_NAMES[m.category] ?? m.category}${m.count ? `, ${m.count.toLocaleString()} Danbooru posts` : ""}`}
            onClick={() => acceptRef.current(i)}
            onMouseMove={() => i !== open.active && setOpen({ ...open, active: i })}
            style={{
              height: ROW_HEIGHT,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              fontSize: 12.5,
              cursor: "pointer",
              background: i === open.active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                flexShrink: 0,
                background: CATEGORY_COLOURS[m.category] ?? "var(--muted)",
              }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.alias && <span style={{ color: "var(--muted)" }}>{m.alias} → </span>}
              {m.name}
            </span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "var(--muted)" }}>
              {formatCount(m.count)}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: "1px solid var(--border)",
          padding: "4px 10px",
          fontSize: 11,
          color: "var(--muted)",
          fontFamily: "'Space Grotesk', sans-serif",
        }}
      >
        Tab or Enter to insert · Esc to close
      </div>
    </div>
  );
}
