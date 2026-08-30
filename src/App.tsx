import { useEffect, useState } from "react";
import "./theme.css";
import Sidebar, { type TabId } from "./components/Sidebar";
import AlbumTab from "./components/AlbumTab";
import MatchingTab from "./components/MatchingTab";
import DetectionTab from "./components/DetectionTab";
import StripMetadataTab from "./components/StripMetadataTab";

type Theme = "light" | "dark";

function getSystemTheme(): Theme {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// Each tab panel stays mounted at all times (just hidden via CSS when
// inactive) so its folder selection, filters, and in-progress work survive
// switching away and back — nothing resets just because you looked at a
// different tab.
function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div style={{ display: active ? "contents" : "none" }}>{children}</div>;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getSystemTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("album");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? "dark" : "light");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  return (
    <div
      className="app-root"
      data-theme={theme}
      style={{ display: "flex", flexDirection: "row", height: "100%" }}
    >
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <TabPanel active={activeTab === "album"}>
          <AlbumTab />
        </TabPanel>
        <TabPanel active={activeTab === "matching"}>
          <MatchingTab />
        </TabPanel>
        <TabPanel active={activeTab === "detection"}>
          <DetectionTab />
        </TabPanel>
        <TabPanel active={activeTab === "stripMetadata"}>
          <StripMetadataTab />
        </TabPanel>
      </div>
    </div>
  );
}
