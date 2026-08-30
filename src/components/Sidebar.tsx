import ThemeSwitch from "./ThemeSwitch";

export type TabId = "album" | "matching" | "detection";

type Theme = "light" | "dark";

function FolderTabIcon({ color }: { color: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      style={{ stroke: color }}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6.5a1 1 0 0 1 1-1h5l2 2.2h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5Z" />
    </svg>
  );
}

function MatchingTabIcon({ color }: { color: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      style={{ stroke: color }}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="8" height="8" rx="1.5" />
      <rect x="13" y="11" width="8" height="8" rx="1.5" />
      <path d="M11 9l6 6" />
    </svg>
  );
}

function DetectionTabIcon({ color }: { color: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      style={{ stroke: color }}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <rect x="9" y="9" width="6" height="6" rx="0.5" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      style={{ stroke: "var(--muted)" }}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

function NavItem({
  icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      title={collapsed ? label : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: collapsed ? "10px 0" : "9px 12px",
        justifyContent: collapsed ? "center" : "flex-start",
        borderRadius: 8,
        cursor: "pointer",
        background: active ? "var(--bg-card)" : "transparent",
        marginBottom: 2,
      }}
    >
      {icon}
      {!collapsed && (
        <span
          style={{
            fontSize: 13,
            fontWeight: active ? 700 : 500,
            fontFamily: "'Space Grotesk', sans-serif",
            color: active ? "var(--text)" : "var(--muted)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

export default function Sidebar({
  collapsed,
  onToggleCollapsed,
  activeTab,
  onSelectTab,
  theme,
  onToggleTheme,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const iconColorFor = (tab: TabId) =>
    activeTab === tab ? "var(--accent)" : "var(--muted)";

  return (
    <div
      style={{
        width: collapsed ? 56 : 200,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--border)",
        transition: "width .15s ease",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          padding: "16px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {!collapsed && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "var(--accent)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontWeight: 700,
                fontSize: 15,
                letterSpacing: ".2px",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              Cutting Room
            </span>
          </div>
        )}
        <div
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            flexShrink: 0,
          }}
        >
          <ChevronIcon collapsed={collapsed} />
        </div>
      </div>

      <nav style={{ flex: 1, padding: 8 }}>
        <NavItem
          icon={<FolderTabIcon color={iconColorFor("album")} />}
          label="Album"
          active={activeTab === "album"}
          collapsed={collapsed}
          onClick={() => onSelectTab("album")}
        />
        <NavItem
          icon={<MatchingTabIcon color={iconColorFor("matching")} />}
          label="Matching"
          active={activeTab === "matching"}
          collapsed={collapsed}
          onClick={() => onSelectTab("matching")}
        />
        <NavItem
          icon={<DetectionTabIcon color={iconColorFor("detection")} />}
          label="Detection"
          active={activeTab === "detection"}
          collapsed={collapsed}
          onClick={() => onSelectTab("detection")}
        />
      </nav>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          padding: "12px",
          borderTop: "1px solid var(--border)",
        }}
      >
        {!collapsed && (
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            v0.1
          </span>
        )}
        <ThemeSwitch theme={theme} onToggle={onToggleTheme} />
      </div>
    </div>
  );
}
