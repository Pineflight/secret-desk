"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { LanguagePanel, PolicyPanel, StoragePanel } from "@/components/settings/InfoPanels";
import { StagesPanel } from "@/components/settings/StagesPanel";
import { ListSkeleton, PageHeader, Tabs } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { parseTab } from "@/lib/tabs";
import { useStages } from "@/lib/use-stages";

const TAB_IDS = ["stages", "policy", "storage", "language"] as const;
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
    router.replace(q.toString() ? `/einstellungen?${q}` : "/einstellungen", { scroll: false });
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
      </div>
    </>
  );
}
