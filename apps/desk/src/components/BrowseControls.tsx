"use client";
import { type GroupKey, type SortKey } from "@/lib/browse";
import { useT } from "@/lib/i18n";
import { SelectField } from "./ui";

export interface BrowseState {
  repo: string;
  sort: SortKey;
  group: GroupKey;
}

const GROUP_KEYS: GroupKey[] = ["none", "repo", "stage"];

export const BROWSE_DEFAULT: BrowseState = { repo: "", sort: "name", group: "none" };

/** Repository-Filter: steht in der Filterzeile vor Stage. */
export function RepoFilter({ value, onChange, repos }: { value: BrowseState; onChange: (v: BrowseState) => void; repos: string[] }) {
  const t = useT();
  return (
    <div className="w-52">
      <SelectField label={t("meta.filterRepo")} value={value.repo} onChange={(e) => onChange({ ...value, repo: e.target.value })}>
        <option value="">{t("meta.all")}</option>
        {repos.map((r) => <option key={r} value={r}>{r}</option>)}
      </SelectField>
    </div>
  );
}

export function BrowseControls({ value, onChange, sorts = ["name", "expires", "repo", "stage"] }: { value: BrowseState; onChange: (v: BrowseState) => void; sorts?: SortKey[] }) {
  const t = useT();
  const set = <K extends keyof BrowseState>(k: K, v: BrowseState[K]) => onChange({ ...value, [k]: v });
  return (
    <>
      <div className="w-40">
        <SelectField label={t("meta.group")} value={value.group} onChange={(e) => set("group", e.target.value as GroupKey)}>
          {GROUP_KEYS.map((g) => <option key={g} value={g}>{t(`meta.group${g[0]!.toUpperCase()}${g.slice(1)}`)}</option>)}
        </SelectField>
      </div>
      <div className="w-40">
        <SelectField label={t("meta.sort")} value={value.sort} onChange={(e) => set("sort", e.target.value as SortKey)}>
          {sorts.map((s) => <option key={s} value={s}>{t(`meta.sort${s[0]!.toUpperCase()}${s.slice(1)}`)}</option>)}
        </SelectField>
      </div>
    </>
  );
}

export function GroupHeading({ label, count }: { label: string; count: number }) {
  return <p className="mb-2 mt-6 flex items-baseline gap-2 text-sm font-semibold first:mt-0">{label}<span className="text-xs font-normal text-muted">{count}</span></p>;
}
