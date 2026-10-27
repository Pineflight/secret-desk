"use client";
import { GROUP_LABELS, SORT_LABELS, type GroupKey, type SortKey } from "@/lib/browse";
import { SelectField } from "./ui";

export interface BrowseState {
  repo: string;
  product: string;
  sort: SortKey;
  group: GroupKey;
}

export const BROWSE_DEFAULT: BrowseState = { repo: "", product: "", sort: "name", group: "none" };

export function BrowseControls({ value, onChange, repos, products, sorts = ["name", "expires", "repo", "stage", "product"] }: { value: BrowseState; onChange: (v: BrowseState) => void; repos: string[]; products: string[]; sorts?: SortKey[] }) {
  const set = <K extends keyof BrowseState>(k: K, v: BrowseState[K]) => onChange({ ...value, [k]: v });
  return (
    <>
      <div className="w-52">
        <SelectField label="Repository" value={value.repo} onChange={(e) => set("repo", e.target.value)}>
          <option value="">Alle</option>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </SelectField>
      </div>
      <div className="w-44">
        <SelectField label="Produkt" value={value.product} onChange={(e) => set("product", e.target.value)}>
          <option value="">Alle</option>
          {products.map((p) => <option key={p} value={p}>{p}</option>)}
        </SelectField>
      </div>
      <div className="w-40">
        <SelectField label="Gruppieren" value={value.group} onChange={(e) => set("group", e.target.value as GroupKey)}>
          {(Object.keys(GROUP_LABELS) as GroupKey[]).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
        </SelectField>
      </div>
      <div className="w-40">
        <SelectField label="Sortieren" value={value.sort} onChange={(e) => set("sort", e.target.value as SortKey)}>
          {sorts.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
        </SelectField>
      </div>
    </>
  );
}

export function GroupHeading({ label, count }: { label: string; count: number }) {
  return <p className="mb-2 mt-6 flex items-baseline gap-2 text-sm font-semibold first:mt-0">{label}<span className="text-xs font-normal text-muted">{count}</span></p>;
}
