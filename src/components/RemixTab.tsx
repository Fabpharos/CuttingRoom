import { useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { readImageMetadata } from "../lib/novelai";
import {
  findShared,
  remixItems,
  type FieldKey,
  type RemixItem,
  type RemixSource,
  type Swap,
} from "../lib/remix";

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
  display: "flex",
  flexDirection: "column",
  gap: 10,
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

const linkStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  padding: 0,
  color: "var(--accent)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const THRESHOLDS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
const PREVIEW_LIMIT = 100;

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

type FieldSwap = { remove: Set<string>; replacement: string };

export default function RemixTab({
  onSendToGenerate,
}: {
  onSendToGenerate: (folder: string, items: RemixItem[]) => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [sources, setSources] = useState<RemixSource[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [scanning, setScanning] = useState<{ done: number; total: number } | null>(null);
  const [threshold, setThreshold] = useState(0.8);
  const [reuseSeeds, setReuseSeeds] = useState(true);
  const [swaps, setSwaps] = useState<Partial<Record<FieldKey, FieldSwap>>>({});
  const [error, setError] = useState<string | null>(null);
  const scanIdRef = useRef(0);

  async function chooseFolder() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    const scanId = ++scanIdRef.current;
    setError(null);
    setFolder(dir);
    setSources([]);
    setSkipped([]);
    setSwaps({});
    try {
      const names = (await readDir(dir))
        .filter((e) => e.isFile && e.name.toLowerCase().endsWith(".png"))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      setScanning({ done: 0, total: names.length });
      const found: RemixSource[] = [];
      const missed: string[] = [];
      for (const [i, name] of names.entries()) {
        if (scanIdRef.current !== scanId) return; // another folder was chosen
        const path = await join(dir, name);
        try {
          found.push({ path, settings: await readImageMetadata(path) });
        } catch {
          missed.push(name);
        }
        setScanning({ done: i + 1, total: names.length });
      }
      setSources(found);
      setSkipped(missed);
    } catch (err) {
      setError(`Couldn't read the folder: ${String(err)}`);
    } finally {
      if (scanIdRef.current === scanId) setScanning(null);
    }
  }

  const blocks = useMemo(() => findShared(sources, threshold), [sources, threshold]);

  const swapFor = (key: FieldKey): FieldSwap => swaps[key] ?? { remove: new Set(), replacement: "" };
  function updateSwap(key: FieldKey, change: Partial<FieldSwap>) {
    setSwaps((prev) => ({ ...prev, [key]: { ...swapFor(key), ...change } }));
  }
  function toggleTag(key: FieldKey, norm: string) {
    const remove = new Set(swapFor(key).remove);
    if (remove.has(norm)) remove.delete(norm);
    else remove.add(norm);
    updateSwap(key, { remove });
  }

  const items = useMemo(() => remixItems(sources, swaps as Partial<Record<FieldKey, Swap>>, reuseSeeds), [
    sources,
    swaps,
    reuseSeeds,
  ]);
  const changed = items.filter((item, i) => {
    const s = sources[i].settings;
    return item.prompt !== s.prompt || item.negativePrompt !== s.negativePrompt || item.characters.some((c, j) => c !== s.characters[j]);
  }).length;
  const seedsKept = items.filter((i) => i.seed !== null).length;
  const sizesKept = items.filter((i) => i.size !== null).length;

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Remix</div>
        <div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
          Reads the NovelAI prompts of every PNG in a folder and finds the tags they share — usually a
          style block, or the same character in a character slot. Pick the shared tags to swap out,
          type what replaces them, check the preview, then send the new prompts to the Generate tab,
          which makes them in batches of 25 with its own model and settings.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <button style={primaryButtonStyle} onClick={() => void chooseFolder()} disabled={scanning !== null}>
          Choose Folder…
        </button>
        {folder && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{folder}</span>}
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

      {scanning && (
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>
          Reading prompts: {scanning.done} / {scanning.total}…
        </div>
      )}

      {folder && !scanning && (
        <div style={{ fontSize: 13, marginBottom: 14 }}>
          {sources.length} image{sources.length === 1 ? "" : "s"} with a NovelAI prompt
          {skipped.length > 0 && (
            <span style={{ color: "var(--muted)" }} title={skipped.join("\n")}>
              {" "}
              ({skipped.length} PNG{skipped.length === 1 ? "" : "s"} without one skipped)
            </span>
          )}
          .
        </div>
      )}

      {sources.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              Shared by at least
              <select
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                style={{
                  padding: "5px 8px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-card)",
                  color: "var(--text)",
                }}
              >
                {THRESHOLDS.map((t) => (
                  <option key={t} value={t}>
                    {Math.round(t * 100)}%
                  </option>
                ))}
              </select>
              of the images
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={reuseSeeds} onChange={(e) => setReuseSeeds(e.target.checked)} />
              Reuse each image's seed
            </label>
          </div>

          {blocks.map((block) => {
            const swap = swapFor(block.key);
            return (
              <div key={block.key} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{block.label}</span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    {block.shared.length} shared tag{block.shared.length === 1 ? "" : "s"} across {block.images} image
                    {block.images === 1 ? "" : "s"}
                  </span>
                </div>
                {block.shared.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No tags shared at this threshold.</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      Click the tags to swap out.{" "}
                      <button style={linkStyle} onClick={() => updateSwap(block.key, { remove: new Set(block.shared.map((t) => t.norm)) })}>
                        All
                      </button>{" "}
                      ·{" "}
                      <button style={linkStyle} onClick={() => updateSwap(block.key, { remove: new Set() })}>
                        None
                      </button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {block.shared.map((tag) => {
                        const on = swap.remove.has(tag.norm);
                        return (
                          <button
                            key={tag.norm}
                            onClick={() => toggleTag(block.key, tag.norm)}
                            title={`In ${tag.count} of ${block.images}`}
                            style={{
                              padding: "4px 10px",
                              borderRadius: 999,
                              border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                              background: on ? "var(--accent)" : "transparent",
                              color: on ? "var(--accent-contrast)" : "var(--text)",
                              fontSize: 12.5,
                              fontFamily: "system-ui, sans-serif",
                              textDecoration: on ? "line-through" : "none",
                              cursor: "pointer",
                            }}
                          >
                            {tag.text}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>
                    Replace with (goes where the first swapped tag was)
                  </span>
                  <textarea
                    rows={2}
                    value={swap.replacement}
                    onChange={(e) => updateSwap(block.key, { replacement: e.target.value })}
                    style={textareaStyle}
                  />
                </label>
              </div>
            );
          })}

          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Preview</span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {changed} of {items.length} prompts changed · {seedsKept} seeds reused · {sizesKept} sizes kept
                {sizesKept < items.length && " (the rest use Generate's size)"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 520, overflowY: "auto" }}>
              {items.slice(0, PREVIEW_LIMIT).map((item) => (
                <div
                  key={item.source}
                  style={{
                    fontSize: 12.5,
                    fontFamily: "system-ui, sans-serif",
                    lineHeight: 1.5,
                    paddingBottom: 8,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>
                    {fileName(item.source)}
                    <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                      {" "}
                      · {item.seed !== null ? `seed ${item.seed}` : "random seed"}
                      {item.size && ` · ${item.size.width}×${item.size.height}`}
                    </span>
                  </div>
                  <div>{item.prompt}</div>
                  {item.characters.map((c, i) => (
                    <div key={i} style={{ color: "var(--muted)" }}>
                      Character {i + 1}: <span style={{ color: "var(--text)" }}>{c}</span>
                    </div>
                  ))}
                  {item.negativePrompt && (
                    <div style={{ color: "var(--muted)" }}>Undesired: {item.negativePrompt}</div>
                  )}
                </div>
              ))}
              {items.length > PREVIEW_LIMIT && (
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>…and {items.length - PREVIEW_LIMIT} more.</div>
              )}
            </div>
            <button
              style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}
              onClick={() => folder && onSendToGenerate(folder, items)}
            >
              Send {items.length} to Generate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
