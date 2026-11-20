import { useEffect, useState } from "react";
import "./theme.css";
import Sidebar, { TAB_IDS, type TabId } from "./components/Sidebar";
import { loadLastTab, saveLastTab } from "./lib/appSettings";
import AlbumTab from "./components/AlbumTab";
import MatchingTab from "./components/MatchingTab";
import EditTab, { type EditRequest } from "./components/EditTab";
import DetectionTab from "./components/DetectionTab";
import StripMetadataTab from "./components/StripMetadataTab";
import GenerateTab, { type IncomingSettings, type RemixJob } from "./components/GenerateTab";
import UpscaleTab from "./components/UpscaleTab";
import ConvertTab from "./components/ConvertTab";
import CharacterCardTab from "./components/CharacterCardTab";
import RemixTab from "./components/RemixTab";

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
  // Generate until the saved tab has loaded, so Album never flashes first.
  const [activeTab, setActiveTab] = useState<TabId>("generate");
  const [tabLoaded, setTabLoaded] = useState(false);
  // A prompt sent from Convert to Generate; the id makes each send new.
  const [sentToGenerate, setSentToGenerate] = useState<IncomingSettings | null>(null);
  const [remixJob, setRemixJob] = useState<RemixJob | null>(null);
  // A folder (and maybe one image) sent from Album to Edit.
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);

  // Reopen the tab that was showing last time; Generate on a first launch.
  useEffect(() => {
    loadLastTab()
      .then((t) => {
        if (t && (TAB_IDS as readonly string[]).includes(t)) setActiveTab(t as TabId);
      })
      .catch(() => {})
      .finally(() => setTabLoaded(true));
  }, []);
  useEffect(() => {
    if (tabLoaded) saveLastTab(activeTab).catch(() => {});
  }, [activeTab, tabLoaded]);

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
        <TabPanel active={activeTab === "generate"}>
          <GenerateTab active={activeTab === "generate"} incoming={sentToGenerate} remix={remixJob} />
        </TabPanel>
        <TabPanel active={activeTab === "album"}>
          <AlbumTab
            active={activeTab === "album"}
            onOpenInEdit={(folder, file) => {
              setEditRequest((prev) => ({ id: (prev?.id ?? 0) + 1, folder, file }));
              setActiveTab("edit");
            }}
          />
        </TabPanel>
        <TabPanel active={activeTab === "edit"}>
          <EditTab active={activeTab === "edit"} request={editRequest} />
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
        <TabPanel active={activeTab === "upscale"}>
          <UpscaleTab active={activeTab === "upscale"} />
        </TabPanel>
        <TabPanel active={activeTab === "remix"}>
          <RemixTab
            onSendToGenerate={(folder, items) => {
              setRemixJob((prev) => ({ id: (prev?.id ?? 0) + 1, folder, items }));
              setActiveTab("generate");
            }}
          />
        </TabPanel>
        <TabPanel active={activeTab === "convert"}>
          <ConvertTab
            active={activeTab === "convert"}
            onSendToGenerate={(settings) => {
              setSentToGenerate((prev) => ({ id: (prev?.id ?? 0) + 1, settings }));
              setActiveTab("generate");
            }}
          />
        </TabPanel>
        <TabPanel active={activeTab === "characterCard"}>
          <CharacterCardTab active={activeTab === "characterCard"} />
        </TabPanel>
      </div>
    </div>
  );
}
