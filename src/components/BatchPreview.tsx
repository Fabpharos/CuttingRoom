import type { GenerateRequest } from "../lib/novelai";

/** One image of a batch as it will be sent, and what changed it. */
export type PreviewImage = {
  request: GenerateRequest;
  log: string[];
  warnings: string[];
  /** Card names per character slot, where known. */
  cardNames: (string | null)[];
};

const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, lineHeight: 1.5, wordBreak: "break-word" };

/** Every image's resolved prompts, before anything is sent. */
export default function BatchPreview({
  images,
  onClose,
  onReroll,
}: {
  images: PreviewImage[];
  onClose: () => void;
  onReroll: () => void;
}) {
  const warnings = [...new Set(images.flatMap((i) => i.warnings))];
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "18px 20px",
          width: "min(980px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          color: "var(--text)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>
            Batch preview · {images.length} image{images.length === 1 ? "" : "s"}
          </div>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onReroll();
            }}
            title="Draw new random picks for the whole batch"
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            New random picks
          </a>
          <button
            onClick={onClose}
            style={{
              padding: "6px 16px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
          This is exactly what Generate will send, image by image, until something in the form changes.
        </div>
        {warnings.length > 0 && (
          <div style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(200,140,40,.12)", border: "1px solid rgba(200,140,40,.4)", fontSize: 12.5 }}>
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
          {images.map((img, i) => {
            const r = img.request;
            return (
              <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--muted)", fontWeight: 600, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--text)" }}>Image {i + 1}</span>
                  <span>seed {r.seed}</span>
                  <span>
                    {r.width}×{r.height}
                  </span>
                  <span>{r.steps} steps</span>
                  <span>guidance {r.scale}</span>
                  {r.sampler && <span>{r.sampler}</span>}
                  {r.noiseSchedule && <span>{r.noiseSchedule}</span>}
                  {r.skipCfgAboveSigma != null && <span>Variety+ {r.skipCfgAboveSigma}</span>}
                </div>
                <div style={mono}>{r.prompt || "(empty prompt)"}</div>
                {r.negativePrompt && <div style={{ ...mono, color: "var(--muted)" }}>Undesired: {r.negativePrompt}</div>}
                {r.characters.map((c, j) =>
                  c.trim() ? (
                    <div key={j} style={mono}>
                      <b>
                        {j + 1}
                        {img.cardNames[j] ? ` · ${img.cardNames[j]}` : ""}:
                      </b>{" "}
                      {c}
                      {r.characterNegatives[j] && <span style={{ color: "var(--muted)" }}> · undesired: {r.characterNegatives[j]}</span>}
                    </div>
                  ) : (
                    <div key={j} style={{ ...mono, color: "var(--muted)" }}>
                      {j + 1}: (left out of this image)
                    </div>
                  ),
                )}
                {img.log.length > 0 && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{img.log.join(" · ")}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
