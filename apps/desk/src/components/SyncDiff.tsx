"use client";
import { useT } from "@/lib/i18n";
import { SECTIONS, type BundleDiff } from "@/lib/team-sync";

/** Zeigt Ids je Bereich: neu, geaendert, nur lokal. Nie Werte. */
export function SyncDiff({ diff }: { diff: BundleDiff }) {
  const t = useT();
  if (diff.empty) return <p className="text-sm text-muted-text">{t("teamSync.diff.none")}</p>;
  return (
    <div className="space-y-3">
      {SECTIONS.map((s) => {
        const d = diff.sections[s];
        if (!d.added.length && !d.changed.length && !d.removed.length) return null;
        return (
          <div key={s}>
            <h3 className="text-sm font-medium">{t(`teamSync.section.${s}`)}</h3>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {d.added.map((id) => <li key={`a${id}`} className="text-success">+ {id} <span className="text-muted-text">({t("teamSync.diff.added")})</span></li>)}
              {d.changed.map((id) => <li key={`c${id}`} className="text-warn">~ {id} <span className="text-muted-text">({t("teamSync.diff.changed")})</span></li>)}
              {d.removed.map((id) => <li key={`r${id}`} className="text-danger">− {id} <span className="text-muted-text">({t("teamSync.diff.removed")})</span></li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
