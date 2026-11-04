"use client";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { ListSkeleton, PageHeader, Tabs } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { parseTab } from "@/lib/tabs";
import { useStages } from "@/lib/use-stages";

// One chunk per tab: only the open tab is loaded, with a skeleton of the same kind while it arrives.
const panelLoading = () => <ListSkeleton rows={4} />;
const DeveloperPanel = dynamic(() => import("@/components/BrowserAutomationPanel").then((m) => m.DeveloperPanel), { loading: panelLoading });
const LanguagePanel = dynamic(() => import("@/components/settings/InfoPanels").then((m) => m.LanguagePanel), { loading: panelLoading });
const PolicyPanel = dynamic(() => import("@/components/settings/InfoPanels").then((m) => m.PolicyPanel), { loading: panelLoading });
const StoragePanel = dynamic(() => import("@/components/settings/InfoPanels").then((m) => m.StoragePanel), { loading: panelLoading });
const StagesPanel = dynamic(() => import("@/components/settings/StagesPanel").then((m) => m.StagesPanel), { loading: panelLoading });

const TAB_IDS = ["stages", "policy", "storage", "language", "developer"] as const;
type TabId = (typeof TAB_IDS)[number];

export default function SettingsPage() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const tab = parseTab(TAB_IDS, params.get("tab"));
  const { stages } = useStages();
  const select = (next: TabId) => {
    const q = new URLSearchParams(params.toString());
    if (next === TAB_IDS[0]) q.delete("tab");
    else q.set("tab", next);
    router.replace(q.toString() ? `/settings?${q}` : "/settings", { scroll: false });
  };
  const tabs = TAB_IDS.map((id) => ({ id, label: t(`settings.tab.${id}`) }));
  return (
    <>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />
      <div className="mb-4"><Tabs label={t("settings.tabsLabel")} tabs={tabs} value={tab} onChange={select} idPrefix="settings" /></div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} tabIndex={0} className="outline-none">
        {tab === "stages" ? (stages === undefined ? <ListSkeleton rows={4} /> : <StagesPanel stages={stages} />) : null}
        {tab === "policy" ? <PolicyPanel /> : null}
        {tab === "storage" ? <StoragePanel /> : null}
        {tab === "language" ? <LanguagePanel /> : null}
        {tab === "developer" ? <DeveloperPanel /> : null}
      </div>
    </>
  );
}
