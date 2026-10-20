import { useState } from "react";
import { useStore } from "../state/store";
import { CostTab } from "./review/CostTab";
import { Overview } from "./review/Overview";
import { ArchitectureTab, FilesTab, SizingTab } from "./review/ResultTabs";

const TABS = ["Overview", "Architecture", "Sizing", "Files", "Cost"] as const;
type Tab = (typeof TABS)[number];

export function ReviewStep() {
  const { resolved } = useStore();
  // ?tab=Files etc. opens a tab directly
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return TABS.find((x) => x.toLowerCase() === t?.toLowerCase()) ?? "Overview";
  });
  return (
    <>
      <div className="tabs result-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Overview" && <Overview cfg={resolved} />}
      {tab === "Architecture" && <ArchitectureTab cfg={resolved} />}
      {tab === "Sizing" && <SizingTab cfg={resolved} />}
      {tab === "Files" && <FilesTab cfg={resolved} />}
      {tab === "Cost" && <CostTab cfg={resolved} />}
    </>
  );
}

