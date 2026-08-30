type Theme = "light" | "dark";

export default function ThemeSwitch({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  const isDark = theme === "dark";

  return (
    <div
      onClick={onToggle}
      title="Toggle light / dark"
      role="button"
      style={{
        position: "relative",
        width: 50,
        height: 27,
        borderRadius: 999,
        background: "var(--switch-track)",
        border: "1px solid var(--border)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: isDark ? 26 : 2,
          width: 21,
          height: 21,
          borderRadius: "50%",
          background: "var(--accent)",
          transition: "left .18s ease",
          boxShadow: "0 1px 3px rgba(0,0,0,.3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isDark ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            style={{ stroke: "var(--accent-contrast)" }}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          </svg>
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            style={{ stroke: "var(--accent-contrast)" }}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
      </div>
    </div>
  );
}
