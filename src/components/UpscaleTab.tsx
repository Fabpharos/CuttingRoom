import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAccountStatus, type AccountStatus } from "../lib/novelai";
import {
  scanForUpscale,
  upscaleBatch,
  cancelUpscale,
  loadUpscaleOutputDir,
  saveUpscaleOutputDir,
  UPSCALE_BATCH,
  UPSCALE_COST,
  type UpscaleScan,
  type UpscaledImage,
} from "../lib/upscale";
import { revealFilesInExplorer } from "../lib/nativeOps";
import ConfirmModal from "./ConfirmModal";

type Source = { path: string; isFolder: boolean };
type AccountPhase = "unchecked" | "checking" | "loggedOut" | "loggedIn";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const cardStyle: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "14px 16px",
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted)",
  marginBottom: 10,
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

const warningBoxStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  background: "rgba(200,140,40,.12)",
  border: "1px solid rgba(200,140,40,.4)",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
  lineHeight: 1.5,
};

const monoStyle: React.CSSProperties = {
  fontSize: 12.5,
  fontFamily: "'IBM Plex Mono', monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export default function UpscaleTab({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<AccountPhase>("unchecked");
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [scan, setScan] = useState<UpscaleScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  // Index of the next eligible file to upscale.
  const [position, setPosition] = useState(0);
  // The batch waiting for the user's go-ahead: eligible[from, to).
  const [confirm, setConfirm] = useState<{ from: number; to: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<UpscaledImage[]>([]);
  const [spent, setSpent] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const checkedRef = useRef(false);

  useEffect(() => {
    loadUpscaleOutputDir()
      .then((dir) => dir && setOutputDir(dir))
      .catch(() => {});
  }, []);

  // Every tab stays mounted from launch; only contact NovelAI once this tab
  // is first shown.
  useEffect(() => {
    if (!active || checkedRef.current) return;
    checkedRef.current = true;
    void refreshStatus();
  }, [active]);

  async function refreshStatus(): Promise<AccountStatus | null> {
    setPhase((p) => (p === "loggedIn" ? p : "checking"));
    try {
      const s = await getAccountStatus();
      setStatus(s);
      setPhase(s ? "loggedIn" : "loggedOut");
      return s;
    } catch (err) {
      setError(String(err));
      setStatus(null);
      setPhase("loggedOut");
      return null;
    }
  }

  async function chooseSource(isFolder: boolean) {
    const picked = await open(
      isFolder
        ? { directory: true, multiple: false }
        : {
            directory: false,
            multiple: false,
            filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
          },
    );
    if (typeof picked !== "string") return;
    setError(null);
    setNotice(null);
    setSource({ path: picked, isFolder });
    setScan(null);
    setPosition(0);
    setResults([]);
    setSpent(0);
    setScanning(true);
    try {
      setScan(await scanForUpscale(picked, isFolder));
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  async function chooseOutputDir() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setOutputDir(dir);
    void saveUpscaleOutputDir(dir).catch(() => {});
  }

  const eligible = scan?.eligible ?? [];
  const remaining = eligible.length - position;
  const canStart = phase === "loggedIn" && !running && !scanning && remaining > 0 && outputDir !== null;

  function askForNextBatch(from: number) {
    setConfirm({ from, to: Math.min(from + UPSCALE_BATCH, eligible.length) });
  }

  async function runBatch(from: number, to: number) {
    if (!outputDir) return;
    const paths = eligible.slice(from, to).map((c) => c.path);
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(true);
    setError(null);
    setNotice(null);
    setProgress({ done: 0, total: paths.length });
    let next = from;
    let keepGoing = false;
    try {
      const summary = await upscaleBatch(runId, paths, outputDir, (p) => {
        setProgress({ done: p.done, total: p.total });
        const image = p.image;
        if (image) setResults((prev) => [...prev, image]);
      });
      next = from + summary.images.length;
      setSpent((s) => s + summary.anlasSpent);
      // The summary is the full record; progress events only show them sooner.
      setResults((prev) => [...prev, ...summary.images.filter((i) => !prev.some((p) => p.path === i.path))]);
      if (summary.stoppedReason) {
        setNotice(`Stopped after ${summary.images.length} of ${paths.length}. ${summary.stoppedReason}`);
      } else if (summary.cancelled) {
        setNotice(`Cancelled after ${summary.images.length} of ${paths.length}.`);
      } else {
        keepGoing = next < eligible.length;
      }
    } catch (err) {
      setError(String(err));
    } finally {
      if (runIdRef.current === runId) {
        runIdRef.current = null;
        setRunning(false);
        setProgress(null);
        setPosition(next);
      }
    }
    // Fresh balance for the next confirmation (and the account card).
    await refreshStatus();
    if (keepGoing) askForNextBatch(next);
  }

  function cancelRun() {
    if (runIdRef.current) void cancelUpscale(runIdRef.current);
  }

  const confirmCount = confirm ? confirm.to - confirm.from : 0;
  const confirmCost = confirmCount * UPSCALE_COST;
  const lastResult = results.length > 0 ? results[results.length - 1] : null;

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 21, fontWeight: 700, marginBottom: 4 }}>Upscale</div>
        <div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
          Double an image's size with NovelAI's upscaler. Each upscale costs {UPSCALE_COST} Anlas on every
          subscription, so only images up to 1 megapixel (1024×1024) are upscaled; larger ones are skipped.
        </div>
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
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{error}</span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setError(null);
            }}
            style={{ whiteSpace: "nowrap" }}
          >
            Dismiss
          </a>
        </div>
      )}

      <div style={cardStyle}>
        <div style={cardTitleStyle}>NOVELAI ACCOUNT</div>
        {(phase === "unchecked" || phase === "checking") && (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Checking saved token…</div>
        )}
        {phase === "loggedOut" && (
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            Not logged in. Log in with your API token on the Generate tab, then{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void refreshStatus();
              }}
              style={{ fontWeight: 600 }}
            >
              check again
            </a>
            .
          </div>
        )}
        {phase === "loggedIn" && status && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13.5 }}>
            <span style={{ fontWeight: 700 }}>{status.tierName}</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "var(--muted)", flex: 1 }}>
              {status.anlas.toLocaleString()} ANLAS
            </span>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (!running) void refreshStatus();
              }}
              style={{ fontSize: 13, fontWeight: 600 }}
            >
              Refresh
            </a>
          </div>
        )}
      </div>

      <div style={{ ...cardStyle, marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...cardTitleStyle, marginBottom: 0 }}>IMAGES</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ ...monoStyle, flex: 1, minWidth: 0, color: source ? "var(--text)" : "var(--muted)" }} title={source?.path}>
            {source ? source.path : "No file or folder chosen"}
          </span>
          <button onClick={() => void chooseSource(false)} disabled={running} style={secondaryButtonStyle}>
            Choose file…
          </button>
          <button onClick={() => void chooseSource(true)} disabled={running} style={secondaryButtonStyle}>
            Choose folder…
          </button>
        </div>

        {scanning && <div style={{ fontSize: 13, color: "var(--muted)" }}>Checking image sizes…</div>}

        {scan && (
          <div style={{ fontSize: 13, fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
            <div>
              <span style={{ fontWeight: 700 }}>{scan.eligible.length}</span>{" "}
              {scan.eligible.length === 1 ? "image" : "images"} can be upscaled
              {scan.eligible.length > 0 && ` (${scan.eligible.length * UPSCALE_COST} Anlas in total)`}
              {source?.isFolder && " · subfolders aren't included"}
              {position > 0 && remaining > 0 && ` · ${remaining} left`}
            </div>
            {scan.skipped.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", color: "var(--muted)" }}>
                  {scan.skipped.length} skipped
                </summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, maxHeight: 180, overflowY: "auto" }}>
                  {scan.skipped.map((s) => (
                    <div key={s.path} style={{ fontSize: 12 }}>
                      <span style={{ fontWeight: 600 }}>{fileName(s.path)}</span>
                      <span style={{ color: "var(--muted)" }}>: {s.reason}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)" }}>Save upscaled images to</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ ...monoStyle, flex: 1, minWidth: 0, color: outputDir ? "var(--text)" : "var(--muted)" }} title={outputDir ?? undefined}>
              {outputDir ?? "No folder chosen"}
            </span>
            <button onClick={() => void chooseOutputDir()} disabled={running} style={secondaryButtonStyle}>
              Choose…
            </button>
          </div>
          <span style={{ fontSize: 12, color: "var(--muted)", fontFamily: "system-ui, sans-serif" }}>
            Saved as <code>name_upscaled.png</code>; existing files are never overwritten.
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {running ? (
            <button onClick={cancelRun} style={secondaryButtonStyle}>
              Cancel
            </button>
          ) : (
            <button
              onClick={() => askForNextBatch(position)}
              disabled={!canStart}
              style={{ ...primaryButtonStyle, opacity: canStart ? 1 : 0.5, cursor: canStart ? "pointer" : "default" }}
            >
              {position > 0 && remaining > 0
                ? `Continue (${remaining} left)`
                : remaining === 1
                  ? "Upscale 1 image"
                  : remaining > 1
                    ? `Upscale ${remaining} images`
                    : position > 0
                      ? "All done"
                      : "Upscale"}
            </button>
          )}
          {!outputDir && !running && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Choose where to save first.</span>}
          {spent > 0 && (
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {spent} Anlas spent this session
            </span>
          )}
        </div>

        {progress && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {progress.done < progress.total ? `Upscaling ${progress.done + 1} of ${progress.total}…` : "Finishing…"}
            </div>
            <div style={{ height: 8, borderRadius: 999, background: "var(--bg-page)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                  background: "var(--accent)",
                  transition: "width .15s ease",
                }}
              />
            </div>
          </div>
        )}

        {notice && <div style={warningBoxStyle}>{notice}</div>}
      </div>

      {lastResult && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <div style={cardTitleStyle}>UPSCALED ({results.length})</div>
          <img
            src={convertFileSrc(lastResult.path)}
            alt="Upscaled image"
            style={{ display: "block", maxWidth: "100%", maxHeight: 520, borderRadius: 8 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10, maxHeight: 200, overflowY: "auto" }}>
            {[...results].reverse().map((r) => (
              <div key={r.path} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }}>
                <span style={{ ...monoStyle, flex: 1, minWidth: 0 }} title={r.path}>
                  {fileName(r.source)} → {fileName(r.path)}
                </span>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void revealFilesInExplorer([r.path]).catch((err) => setError(`Couldn't open Explorer: ${String(err)}`));
                  }}
                  style={{ fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  Show in Explorer
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirm && status && (
        <ConfirmModal
          title={eligible.length === 1 ? "Upscale this image?" : `Upscale images ${confirm.from + 1}–${confirm.to} of ${eligible.length}?`}
          message={
            `This costs ${confirmCost} Anlas (${UPSCALE_COST} per image). You have ${status.anlas.toLocaleString()} Anlas.` +
            (status.anlas < confirmCost ? " That isn't enough for all of them; the batch stops when it runs out." : "") +
            (confirm.to < eligible.length ? ` You'll be asked again before the next ${Math.min(UPSCALE_BATCH, eligible.length - confirm.to)}.` : "")
          }
          confirmLabel="Upscale"
          cancelLabel="Not now"
          onConfirm={() => {
            const { from, to } = confirm;
            setConfirm(null);
            void runBatch(from, to);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
