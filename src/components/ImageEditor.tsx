// The Edit tab's editor for one image. Four layers at the image's own size:
//   base     — the image as edited so far
//   pix      — base pixelated at the chosen cell size (offscreen)
//   mask     — the selection (offscreen; white = selected, soft brush edges)
//   overlay  — pix cut to the mask, drawn over base: the live preview
// plus an SVG on top for the lasso path and the brush outline. Pixelate
// commits the overlay into base; Save writes what's shown.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { pixelate, saveFormat, MIN_CELL, MAX_CELL, clampCell } from "../lib/pixelate";
import { MIN_BRUSH, MAX_BRUSH, saveEditedImage, type EditSettings, type EditTool } from "../lib/editSettings";
import ConfirmModal from "./ConfirmModal";

const MAX_HISTORY = 20;

type Snapshot = { image?: HTMLCanvasElement; mask?: HTMLCanvasElement; maskEmpty?: boolean };

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext("2d", { willReadFrequently: true })!;
}

export type ImageEditorHandle = { dirty: () => boolean };

type Props = {
  path: string;
  name: string;
  settings: EditSettings;
  onSettings: (patch: Partial<EditSettings>) => void;
  /** Called after a save with the file written (and whether it replaced the original). */
  onSaved: (writtenPath: string, overwrote: boolean) => void;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  active: boolean;
};

const ImageEditor = forwardRef<ImageEditorHandle, Props>(function ImageEditor(
  { path, name, settings, onSettings, onSaved, onBack, onPrev, onNext, active },
  ref,
) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [maskEmpty, setMaskEmpty] = useState(true);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [lasso, setLasso] = useState<{ x: number; y: number }[] | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [removing, setRemoving] = useState(false);

  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const tintRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pixRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const strokeRef = useRef<{ last: { x: number; y: number }; remove: boolean } | null>(null);
  const lassoRemoveRef = useRef(false);
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const spaceRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingBitmapRef = useRef<ImageBitmap | null>(null);

  // A selection not yet pixelated counts too: Save would have kept it.
  useImperativeHandle(ref, () => ({ dirty: () => dirty || !maskEmpty }), [dirty, maskEmpty]);

  const format = saveFormat(name);
  const cell = settings.pixelSize;

  // ---- Rendering ----

  const renderOverlay = useCallback(() => {
    frameRef.current = null;
    const overlay = overlayRef.current;
    const tint = tintRef.current;
    const pix = pixRef.current;
    const mask = maskRef.current;
    if (!overlay || !pix || !mask) return;
    const o = overlay.getContext("2d")!;
    o.globalCompositeOperation = "source-over";
    o.clearRect(0, 0, overlay.width, overlay.height);
    o.drawImage(pix, 0, 0);
    o.globalCompositeOperation = "destination-in";
    o.drawImage(mask, 0, 0);
    o.globalCompositeOperation = "source-over";
    if (tint) {
      const t = tint.getContext("2d")!;
      t.globalCompositeOperation = "source-over";
      t.clearRect(0, 0, tint.width, tint.height);
      t.fillStyle = getComputedStyle(tint).getPropertyValue("--accent").trim() || "#c9762f";
      t.fillRect(0, 0, tint.width, tint.height);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(mask, 0, 0);
      t.globalCompositeOperation = "source-over";
    }
  }, []);

  const scheduleRender = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(renderOverlay);
  }, [renderOverlay]);

  /** Recomputes the pixelated layer from base. */
  const rebuildPix = useCallback(() => {
    const base = baseRef.current;
    if (!base || !base.width) return;
    const w = base.width;
    const h = base.height;
    const data = ctx2d(base).getImageData(0, 0, w, h);
    const out = pixelate(data.data, w, h, cell);
    if (!pixRef.current || pixRef.current.width !== w || pixRef.current.height !== h) pixRef.current = makeCanvas(w, h);
    ctx2d(pixRef.current).putImageData(new ImageData(out, w, h), 0, 0);
    scheduleRender();
  }, [cell, scheduleRender]);

  // ---- Loading ----

  useEffect(() => {
    let cancelled = false;
    setSize(null);
    setLoadError(null);
    setNotice(null);
    setDirty(false);
    setMaskEmpty(true);
    setLasso(null);
    undoRef.current = [];
    redoRef.current = [];
    setUndoCount(0);
    setRedoCount(0);
    setFit(true);
    (async () => {
      try {
        const bytes = await readFile(path);
        const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        if (cancelled) {
          bitmap.close();
          return;
        }
        const w = bitmap.width;
        const h = bitmap.height;
        maskRef.current = makeCanvas(w, h);
        pixRef.current = makeCanvas(w, h);
        // Drawn by the layout effect below once the canvas exists at this size.
        pendingBitmapRef.current = bitmap;
        setSize({ w, h });
      } catch (err) {
        if (!cancelled) setLoadError(`Couldn't open ${name}: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // rebuildPix changes with the cell size; that's handled below, not by reloading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useLayoutEffect(() => {
    const bitmap = pendingBitmapRef.current;
    const base = baseRef.current;
    if (!size || !bitmap || !base) return;
    pendingBitmapRef.current = null;
    ctx2d(base).drawImage(bitmap, 0, 0);
    bitmap.close();
    rebuildPix();
  }, [size, rebuildPix]);

  // Cell size changes rebuild the preview (debounced while dragging the slider).
  useEffect(() => {
    if (!size) return;
    const t = window.setTimeout(rebuildPix, 60);
    return () => window.clearTimeout(t);
  }, [cell, size, rebuildPix]);

  // ---- Zoom ----

  const fitZoom = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !size) return 1;
    return Math.min(1, (vp.clientWidth - 32) / size.w, (vp.clientHeight - 32) / size.h);
  }, [size]);

  useLayoutEffect(() => {
    if (!fit || !size) return;
    const apply = () => setZoom(Math.max(0.02, fitZoom()));
    apply();
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(apply);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [fit, size, fitZoom]);

  function zoomTo(next: number, anchor?: { clientX: number; clientY: number }) {
    const vp = viewportRef.current;
    const stage = stageRef.current;
    const z = Math.min(16, Math.max(0.02, next));
    if (!vp || !stage) {
      setZoom(z);
      return;
    }
    // Keep the point under the cursor (or the middle) where it is.
    const vr = vp.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const ax = anchor ? anchor.clientX : vr.left + vr.width / 2;
    const ay = anchor ? anchor.clientY : vr.top + vr.height / 2;
    const ix = (ax - sr.left) / zoom;
    const iy = (ay - sr.top) / zoom;
    setFit(false);
    setZoom(z);
    requestAnimationFrame(() => {
      const sr2 = stage.getBoundingClientRect();
      vp.scrollLeft += sr2.left + ix * z - ax;
      vp.scrollTop += sr2.top + iy * z - ay;
    });
  }

  // ---- History ----

  function pushHistory(snap: Snapshot) {
    undoRef.current.push(snap);
    if (undoRef.current.length > MAX_HISTORY) undoRef.current.shift();
    redoRef.current = [];
    setUndoCount(undoRef.current.length);
    setRedoCount(0);
  }

  function snapshot(image: boolean, mask: boolean): Snapshot {
    return {
      image: image && baseRef.current ? copyCanvas(baseRef.current) : undefined,
      mask: mask && maskRef.current ? copyCanvas(maskRef.current) : undefined,
      maskEmpty: mask ? maskEmpty : undefined,
    };
  }

  function restore(snap: Snapshot): Snapshot {
    const current = snapshot(!!snap.image, !!snap.mask);
    if (snap.image && baseRef.current) {
      const c = ctx2d(baseRef.current);
      c.clearRect(0, 0, baseRef.current.width, baseRef.current.height);
      c.drawImage(snap.image, 0, 0);
      rebuildPix();
      setDirty(true);
    }
    if (snap.mask && maskRef.current) {
      const c = ctx2d(maskRef.current);
      c.clearRect(0, 0, maskRef.current.width, maskRef.current.height);
      c.drawImage(snap.mask, 0, 0);
      setMaskEmpty(!!snap.maskEmpty);
      scheduleRender();
    }
    return current;
  }

  function undo() {
    const snap = undoRef.current.pop();
    if (!snap) return;
    redoRef.current.push(restore(snap));
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }

  function redo() {
    const snap = redoRef.current.pop();
    if (!snap) return;
    undoRef.current.push(restore(snap));
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }

  // ---- Selection ----

  function maskCtx(remove: boolean) {
    const c = ctx2d(maskRef.current!);
    c.globalCompositeOperation = remove ? "destination-out" : "source-over";
    c.fillStyle = "#fff";
    c.strokeStyle = "#fff";
    return c;
  }

  function selectAll() {
    if (!maskRef.current) return;
    pushHistory(snapshot(false, true));
    const c = maskCtx(false);
    c.fillRect(0, 0, maskRef.current.width, maskRef.current.height);
    setMaskEmpty(false);
    scheduleRender();
  }

  function clearSelection() {
    if (!maskRef.current || maskEmpty) return;
    pushHistory(snapshot(false, true));
    ctx2d(maskRef.current).clearRect(0, 0, maskRef.current.width, maskRef.current.height);
    setMaskEmpty(true);
    scheduleRender();
  }

  function invertSelection() {
    const mask = maskRef.current;
    if (!mask) return;
    pushHistory(snapshot(false, true));
    const old = copyCanvas(mask);
    const c = ctx2d(mask);
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, mask.width, mask.height);
    c.fillStyle = "#fff";
    c.fillRect(0, 0, mask.width, mask.height);
    c.globalCompositeOperation = "destination-out";
    c.drawImage(old, 0, 0);
    c.globalCompositeOperation = "source-over";
    setMaskEmpty(false);
    scheduleRender();
  }

  function toImage(e: { clientX: number; clientY: number }) {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size!.w, y: ((e.clientY - r.top) / r.height) * size!.h };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!size || !maskRef.current) return;
    const vp = viewportRef.current!;
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.preventDefault();
      panRef.current = { x: e.clientX, y: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const remove = e.button === 2 || e.altKey;
    setRemoving(remove);
    const p = toImage(e);
    pushHistory(snapshot(false, true));
    if (settings.tool === "brush") {
      strokeRef.current = { last: p, remove };
      const c = maskCtx(remove);
      c.beginPath();
      c.arc(p.x, p.y, settings.brushSize / 2, 0, Math.PI * 2);
      c.fill();
      c.globalCompositeOperation = "source-over";
      if (!remove) setMaskEmpty(false);
      scheduleRender();
    } else {
      lassoRemoveRef.current = remove;
      setLasso([p]);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (panRef.current) {
      const vp = viewportRef.current!;
      vp.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.x);
      vp.scrollTop = panRef.current.st - (e.clientY - panRef.current.y);
      return;
    }
    if (!size) return;
    const p = toImage(e);
    setCursor(p);
    const stroke = strokeRef.current;
    if (stroke) {
      const c = maskCtx(stroke.remove);
      c.lineWidth = settings.brushSize;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      c.moveTo(stroke.last.x, stroke.last.y);
      c.lineTo(p.x, p.y);
      c.stroke();
      c.globalCompositeOperation = "source-over";
      stroke.last = p;
      scheduleRender();
    } else if (lasso) {
      const last = lasso[lasso.length - 1];
      // Skip points closer than a screen pixel or so.
      if (Math.hypot(p.x - last.x, p.y - last.y) * zoom >= 2) setLasso([...lasso, p]);
    }
  }

  function onPointerUp() {
    if (panRef.current) {
      panRef.current = null;
      return;
    }
    if (strokeRef.current) {
      strokeRef.current = null;
    } else if (lasso) {
      if (lasso.length >= 3) {
        const c = maskCtx(lassoRemoveRef.current);
        c.beginPath();
        c.moveTo(lasso[0].x, lasso[0].y);
        for (const p of lasso.slice(1)) c.lineTo(p.x, p.y);
        c.closePath();
        c.fill();
        c.globalCompositeOperation = "source-over";
        if (!lassoRemoveRef.current) setMaskEmpty(false);
        scheduleRender();
      } else {
        // A click without a drag: nothing to select, so drop the history entry.
        undoRef.current.pop();
        setUndoCount(undoRef.current.length);
      }
      setLasso(null);
    }
    setRemoving(false);
  }

  // ---- Pixelate and save ----

  function applyPixelate() {
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay || maskEmpty) return;
    renderOverlay();
    pushHistory(snapshot(true, true));
    ctx2d(base).drawImage(overlay, 0, 0);
    ctx2d(maskRef.current!).clearRect(0, 0, base.width, base.height);
    setMaskEmpty(true);
    setDirty(true);
    rebuildPix();
  }

  async function save(overwrite: boolean) {
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (!base || !overlay || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      // What's shown: the image plus any selection not yet pixelated.
      renderOverlay();
      const out = copyCanvas(base);
      if (!maskEmpty) out.getContext("2d")!.drawImage(overlay, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("encoding failed"))), format.mime, 0.95),
      );
      const written = await saveEditedImage(path, format.ext, overwrite, new Uint8Array(await blob.arrayBuffer()));
      if (!maskEmpty) {
        // The pending selection is part of the file now.
        pushHistory(snapshot(true, true));
        ctx2d(base).drawImage(overlay, 0, 0);
        ctx2d(maskRef.current!).clearRect(0, 0, base.width, base.height);
        setMaskEmpty(true);
        rebuildPix();
      }
      setDirty(false);
      const file = written.split(/[\\/]/).pop();
      setNotice(overwrite ? `Saved over ${file}. The original is in the Recycle Bin.` : `Saved as ${file}.`);
      onSaved(written, overwrite);
    } catch (err) {
      setNotice(`Couldn't save: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // ---- Keyboard ----

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (confirmOverwrite) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === " ") {
      spaceRef.current = true;
      e.preventDefault();
    } else if (ctrl && k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (ctrl && k === "a") {
      e.preventDefault();
      selectAll();
    } else if (ctrl && k === "d") {
      e.preventDefault();
      clearSelection();
    } else if (ctrl && k === "i") {
      e.preventDefault();
      invertSelection();
    } else if (ctrl && k === "s") {
      e.preventDefault();
      void save(false);
    } else if (ctrl) {
      return;
    } else if (e.key === "Escape") {
      if (lasso) setLasso(null);
      else clearSelection();
    } else if (e.key === "Enter") {
      applyPixelate();
    } else if (k === "b") {
      onSettings({ tool: "brush" });
    } else if (k === "l") {
      onSettings({ tool: "lasso" });
    } else if (k === "h") {
      onSettings({ highlight: !settings.highlight });
    } else if (e.key === "[" || e.key === "]") {
      const step = Math.max(1, Math.round(settings.brushSize * 0.15));
      const next = settings.brushSize + (e.key === "]" ? step : -step);
      onSettings({ brushSize: Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, next)) });
    } else if (e.key === "+" || e.key === "=") {
      zoomTo(zoom * 1.25);
    } else if (e.key === "-") {
      zoomTo(zoom / 1.25);
    } else if (e.key === "0") {
      setFit(true);
    } else if (e.key === "1") {
      zoomTo(1);
    }
  };

  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [active]);

  // Ctrl+wheel zooms; a plain wheel scrolls. Registered by hand so it can
  // preventDefault (React's wheel listener is passive).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  });

  // ---- UI ----

  const stageW = size ? size.w * zoom : 0;
  const stageH = size ? size.h * zoom : 0;
  const canvasStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    imageRendering: zoom >= 2 ? "pixelated" : "auto",
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          padding: "12px 24px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <button className="edit-btn" onClick={onBack} title="Back to the folder">
          ← Folder
        </button>
        <button className="edit-btn" onClick={onPrev ?? undefined} disabled={!onPrev} title="Previous image">
          ‹
        </button>
        <button className="edit-btn" onClick={onNext ?? undefined} disabled={!onNext} title="Next image">
          ›
        </button>
        <div style={{ minWidth: 0, flex: "1 1 160px" }}>
          <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={path}>
            {name}
            {dirty && <span style={{ color: "var(--accent)" }}> •</span>}
          </div>
          {size && (
            <div className="edit-mono">
              {size.w} × {size.h} · {Math.round(zoom * 100)}%
            </div>
          )}
        </div>
        <button className="edit-btn" onClick={undo} disabled={undoCount === 0} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button className="edit-btn" onClick={redo} disabled={redoCount === 0} title="Redo (Ctrl+Y)">
          Redo
        </button>
        <button className="edit-btn" onClick={() => void save(false)} disabled={busy || !size} title={`Save as a new file next to this one (Ctrl+S)`}>
          {busy ? "Saving…" : "Save copy"}
        </button>
        <button
          className="edit-btn"
          onClick={() => setConfirmOverwrite(true)}
          disabled={busy || !size || !format.canOverwrite}
          title={format.canOverwrite ? "Replace this file; the original goes to the Recycle Bin" : "This format can only be saved as a PNG copy"}
        >
          Overwrite…
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            overflowY: "auto",
          }}
        >
          <section>
            <div className="edit-label">Select with</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["brush", "lasso"] as EditTool[]).map((t) => (
                <button
                  key={t}
                  className={`edit-btn${settings.tool === t ? " edit-btn-on" : ""}`}
                  onClick={() => onSettings({ tool: t })}
                  title={t === "brush" ? "Paint the selection (B)" : "Draw around the area (L)"}
                  style={{ flex: 1 }}
                >
                  {t === "brush" ? "Brush" : "Lasso"}
                </button>
              ))}
            </div>
            <div className="edit-hint">Left drag adds. Right drag or Alt+drag removes.</div>
          </section>

          {settings.tool === "brush" && (
            <section>
              <div className="edit-label">
                Brush size <span className="edit-mono">{settings.brushSize}px</span>
              </div>
              <input
                type="range"
                min={MIN_BRUSH}
                max={MAX_BRUSH}
                value={settings.brushSize}
                onChange={(e) => onSettings({ brushSize: Number(e.target.value) })}
                style={{ width: "100%", accentColor: "var(--accent)" }}
              />
              <div className="edit-hint">[ and ] change it.</div>
            </section>
          )}

          <section>
            <div className="edit-label">Pixelate</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Cell size</span>
              <input
                type="number"
                min={MIN_CELL}
                max={MAX_CELL}
                value={cell}
                onChange={(e) => onSettings({ pixelSize: clampCell(Number(e.target.value)) })}
                className="edit-number"
              />
              <span className="edit-mono">px</span>
            </div>
            <input
              type="range"
              min={MIN_CELL}
              max={MAX_CELL}
              value={cell}
              onChange={(e) => onSettings({ pixelSize: Number(e.target.value) })}
              style={{ width: "100%", accentColor: "var(--accent)", marginTop: 6 }}
            />
            <button
              className="edit-btn edit-btn-primary"
              onClick={applyPixelate}
              disabled={maskEmpty}
              style={{ width: "100%", marginTop: 8 }}
              title="Pixelate the selection (Enter)"
            >
              Pixelate selection
            </button>
            <div className="edit-hint">
              The selection previews pixelated. Pixelate fixes it in place so you can select more with another cell size; saving
              also keeps what's shown.
            </div>
          </section>

          <section>
            <div className="edit-label">Selection</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <button className="edit-btn" onClick={selectAll} title="Select all (Ctrl+A)">
                All
              </button>
              <button className="edit-btn" onClick={clearSelection} disabled={maskEmpty} title="Deselect (Ctrl+D or Esc)">
                None
              </button>
              <button className="edit-btn" onClick={invertSelection} title="Invert (Ctrl+I)" style={{ gridColumn: "1 / -1" }}>
                Invert
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={settings.highlight}
                onChange={(e) => onSettings({ highlight: e.target.checked })}
                style={{ accentColor: "var(--accent)" }}
              />
              Highlight selection (H)
            </label>
          </section>

          <section>
            <div className="edit-label">View</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className={`edit-btn${fit ? " edit-btn-on" : ""}`} onClick={() => setFit(true)} title="Fit to window (0)" style={{ flex: 1 }}>
                Fit
              </button>
              <button className="edit-btn" onClick={() => zoomTo(1)} title="Actual size (1)" style={{ flex: 1 }}>
                100%
              </button>
            </div>
            <div className="edit-hint">Ctrl+wheel zooms. Space+drag or middle drag pans.</div>
          </section>
        </div>

        <div
          ref={viewportRef}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            background: "var(--bg-card)",
            display: "grid",
            placeItems: fit ? "center" : undefined,
            padding: 16,
          }}
        >
          {loadError && <div style={{ color: "var(--text)", fontSize: 13 }}>{loadError}</div>}
          {size && (
            <div
              ref={stageRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => setCursor(null)}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                position: "relative",
                width: stageW,
                height: stageH,
                flexShrink: 0,
                margin: fit ? undefined : "auto",
                cursor: spaceRef.current ? "grab" : settings.tool === "brush" ? "none" : "crosshair",
                boxShadow: "0 2px 12px rgba(0,0,0,.18)",
                backgroundImage:
                  "repeating-conic-gradient(rgba(128,128,128,.25) 0% 25%, transparent 0% 50%)",
                backgroundSize: "16px 16px",
                touchAction: "none",
              }}
            >
              <canvas ref={baseRef} width={size.w} height={size.h} style={canvasStyle} />
              <canvas ref={overlayRef} width={size.w} height={size.h} style={canvasStyle} />
              <canvas
                ref={tintRef}
                width={size.w}
                height={size.h}
                style={{ ...canvasStyle, opacity: settings.highlight ? 0.3 : 0, pointerEvents: "none" }}
              />
              <svg
                viewBox={`0 0 ${size.w} ${size.h}`}
                preserveAspectRatio="none"
                style={{ ...canvasStyle, overflow: "visible", pointerEvents: "none" }}
              >
                {lasso && lasso.length > 1 && (
                  <>
                    <polyline
                      points={lasso.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill={removing ? "rgba(0,0,0,.15)" : "rgba(255,255,255,.15)"}
                      stroke="#000"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                    <polyline
                      points={lasso.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke="#fff"
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                )}
                {cursor && settings.tool === "brush" && !panRef.current && (
                  <>
                    <circle cx={cursor.x} cy={cursor.y} r={settings.brushSize / 2} fill="none" stroke="#000" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                    <circle
                      cx={cursor.x}
                      cy={cursor.y}
                      r={settings.brushSize / 2}
                      fill="none"
                      stroke="#fff"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                )}
              </svg>
            </div>
          )}
        </div>
      </div>

      {notice && (
        <div
          style={{
            padding: "8px 24px",
            borderTop: "1px solid var(--border)",
            fontSize: 12.5,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{notice}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); setNotice(null); }}>
            Dismiss
          </a>
        </div>
      )}

      {confirmOverwrite && (
        <ConfirmModal
          title="Overwrite the original?"
          message={`Replace ${name} with the edited image? The original goes to the Recycle Bin, so you can restore it from there.${
            format.ext === "jpg" || format.ext === "jpeg" ? "\n\nJPEG is saved again at 95% quality." : ""
          }`}
          confirmLabel="Overwrite"
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmOverwrite(false);
            void save(true);
          }}
          onCancel={() => setConfirmOverwrite(false)}
        />
      )}
    </div>
  );
});

export default ImageEditor;
