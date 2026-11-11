"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { SegmentSwitch } from "@/components/ListTable";
import { SecretForm } from "@/components/SecretForm";
import { VariableForm } from "@/components/VariableDialogs";
import type { SourceDef } from "@/lib/variable-source";
import type { Prefill } from "@/lib/prefill";
import type { EntryKind } from "@/lib/entries-list";
import { useT } from "@/lib/i18n";

/** One "New" action for both kinds: the kind is chosen at the top (preselected from the kind filter), the matching form follows. */
export function NewEntryDialog({ initialKind, sources, prefill, onClose, onCreated }: { initialKind: EntryKind; sources: SourceDef[]; prefill: Prefill | null; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<EntryKind>(initialKind);
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  return (
    <Dialog title={t("entries.newTitle")} description={kind === "secret" ? t("secrets.dialogDesc") : t("variables.newDesc")} onClose={onClose} wide footer={<div ref={setFooterHost} className="contents" />}>
      <div className="mb-3">
        <SegmentSwitch
          label={t("entries.kind")}
          value={kind}
          onChange={setKind}
          options={[{ id: "secret", label: t("entries.kindSecret") }, { id: "variable", label: t("entries.kindVariable") }]}
        />
      </div>
      {kind === "secret" ? <SecretForm key="secret" footerHost={footerHost} initial={prefill} onClose={onClose} onCreated={onCreated} /> : <VariableForm key="variable" footerHost={footerHost} sources={sources} initial={prefill} onClose={onClose} onCreated={onCreated} />}
    </Dialog>
  );
}
