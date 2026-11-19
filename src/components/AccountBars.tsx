import type { AccountStatus } from "../lib/novelai";
import HelpTip from "./HelpTip";

const AMBER = "rgb(200,140,40)";
/** Opus's monthly Anlas. */
const OPUS_MONTHLY = 10_000;

function Bar({
  segments,
  label,
  value,
  warn,
  help,
}: {
  segments: { fraction: number; color: string; title: string }[];
  label: string;
  value: string;
  warn?: boolean;
  help: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: "1 1 160px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
        <span style={{ fontWeight: 600, color: "var(--muted)" }}>{label}</span>
        {help}
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "'IBM Plex Mono', monospace",
            color: warn ? AMBER : "var(--text)",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </span>
      </div>
      <div
        style={{
          height: 7,
          borderRadius: 999,
          background: "var(--bg-page)",
          border: "1px solid var(--border)",
          overflow: "hidden",
          display: "flex",
        }}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            title={s.title}
            style={{ width: `${Math.max(0, Math.min(1, s.fraction)) * 100}%`, background: s.color, transition: "width .2s ease" }}
          />
        ))}
      </div>
    </div>
  );
}

/** The account's Anlas and, on Opus, the V5 quota, as bars. */
export default function AccountBars({ status }: { status: AccountStatus }) {
  const sub = status.subscriptionAnlas ?? status.anlas;
  const bought = status.purchasedAnlas ?? 0;
  const scaleMax = Math.max(OPUS_MONTHLY, sub + bought);
  const usage = status.usage;
  const quotaLow = !!usage && !usage.isNegative && usage.percent + usage.purchasedPercent < 15;
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}>
      <Bar
        label="ANLAS"
        value={status.anlas.toLocaleString()}
        segments={[
          { fraction: sub / scaleMax, color: "var(--accent)", title: `Subscription: ${sub.toLocaleString()}` },
          { fraction: bought / scaleMax, color: "var(--muted)", title: `Purchased: ${bought.toLocaleString()}` },
        ]}
        help={
          <HelpTip
            title="Anlas"
            lines={[
              { text: `Subscription Anlas: ${sub.toLocaleString()} (Opus gets ${OPUS_MONTHLY.toLocaleString()} a month).` },
              { text: `Purchased Anlas: ${bought.toLocaleString()} (they don't expire).` },
              { text: "Free generations don't use either." },
            ]}
          />
        }
      />
      {status.isOpus && usage && (
        <Bar
          label="V5 QUOTA"
          value={usage.isNegative ? "used up — V5 costs Anlas" : `${usage.percent + usage.purchasedPercent}%`}
          warn={usage.isNegative || quotaLow}
          segments={
            usage.isNegative
              ? []
              : [
                  { fraction: usage.percent / 100, color: quotaLow ? AMBER : "var(--accent)", title: `Quota: ${usage.percent}%` },
                  { fraction: usage.purchasedPercent / 100, color: "var(--muted)", title: `Purchased: ${usage.purchasedPercent}%` },
                ]
          }
          help={
            <HelpTip
              title="V5 quota"
              lines={[
                { text: "On Opus, V5 models draw from this quota, which refills over time." },
                { text: "When it's used up, V5 costs Anlas until it refills. V4 and V4.5 are unlimited." },
              ]}
            />
          }
        />
      )}
    </div>
  );
}
