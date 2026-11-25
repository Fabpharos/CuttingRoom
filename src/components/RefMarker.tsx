import { CARD_REFERENCE_TYPES, type CardReference } from "../lib/characterCards";

/**
 * A small badge on a card's thumbnail saying what its Precise Reference is
 * for: C (character), S (style), O (outfit) or C+S. Nothing when the card has
 * no reference. Place it inside a `position: relative` box.
 */
export default function RefMarker({ reference, size = "small" }: { reference: CardReference | null; size?: "small" | "large" }) {
  if (!reference) return null;
  const type = CARD_REFERENCE_TYPES.find((t) => t.key === reference.type) ?? CARD_REFERENCE_TYPES[0];
  return (
    <span
      title={`Precise Reference: ${type.label}`}
      aria-label={`Precise Reference: ${type.label}`}
      style={{
        position: "absolute",
        right: 2,
        bottom: 2,
        minWidth: size === "large" ? 20 : 16,
        height: size === "large" ? 18 : 15,
        padding: "0 4px",
        borderRadius: 999,
        background: "var(--accent)",
        color: "var(--accent-contrast)",
        fontSize: size === "large" ? 10.5 : 9,
        fontWeight: 700,
        lineHeight: size === "large" ? "18px" : "15px",
        textAlign: "center",
        fontFamily: "'IBM Plex Mono', monospace",
        boxShadow: "0 1px 3px rgba(0,0,0,.35)",
        pointerEvents: "auto",
      }}
    >
      {type.short}
    </span>
  );
}
