import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** One line of help: the syntax (shown in a monospace font) and what it does. */
export type HelpLine = { syntax?: string; text: string };

/**
 * A small circled question mark. Hovering or focusing it shows the help;
 * clicking pins it open until Esc or a click elsewhere. The bubble stays
 * inside the window, flipping above or below and left or right as needed.
 */
export default function HelpTip({
  lines,
  title,
  children,
  label = "Help",
}: {
  lines?: HelpLine[];
  title?: string;
  children?: ReactNode;
  label?: string;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = hover || focus || pinned;

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !bubbleRef.current?.contains(t)) setPinned(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [pinned]);

  // Place the bubble below the icon if it fits, else above; keep it on screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchorRef.current?.getBoundingClientRect();
    const b = bubbleRef.current?.getBoundingClientRect();
    if (!a || !b) return;
    const margin = 8;
    let top = a.bottom + 6;
    if (top + b.height > window.innerHeight - margin) top = Math.max(margin, a.top - 6 - b.height);
    let left = a.left + a.width / 2 - b.width / 2;
    left = Math.min(Math.max(margin, left), window.innerWidth - margin - b.width);
    setPos({ left, top });
  }, [open]);

  return (
    <span style={{ display: "inline-flex", verticalAlign: "middle" }}>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={pinned}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        style={{
          width: 16,
          height: 16,
          padding: 0,
          marginLeft: 4,
          border: "none",
          background: "transparent",
          color: pinned ? "var(--accent)" : "var(--muted)",
          cursor: "help",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      </button>
      {open && (
        <div
          ref={bubbleRef}
          id={id}
          role="tooltip"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            position: "fixed",
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            zIndex: 400,
            maxWidth: 380,
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--bg-card)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px rgba(0,0,0,.25)",
            fontFamily: "system-ui, sans-serif",
            fontSize: 12.5,
            fontWeight: 400,
            lineHeight: 1.5,
            textAlign: "left",
            textTransform: "none",
            letterSpacing: "normal",
            whiteSpace: "normal",
          }}
        >
          {title && <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>}
          {lines && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {lines.map((l, i) => (
                <div key={i}>
                  {l.syntax && (
                    <code
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 11.5,
                        padding: "1px 5px",
                        borderRadius: 4,
                        background: "var(--bg-page)",
                        border: "1px solid var(--border)",
                        marginRight: 6,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {l.syntax}
                    </code>
                  )}
                  {l.text}
                </div>
              ))}
            </div>
          )}
          {children}
        </div>
      )}
    </span>
  );
}
