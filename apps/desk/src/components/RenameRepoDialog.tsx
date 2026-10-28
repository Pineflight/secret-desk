"use client";
import { Dialog } from "@/components/Dialog";
import { Button, Notice } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { invalidateRepoList } from "@/lib/repo-list";
import { useToast } from "@/lib/toast";

/** Benennt ein Repository im Inventar um (GitHub hat es umbenannt). Aendert nichts in GitHub. */
export function RenameRepoDialog({ from, to, onClose, onDone }: { from: string; to: string; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const rename = useMutation(() => api<{ from: string; to: string; changed: number }>("POST", `repos/${enc(from)}/rename`, { to }));
  const submit = async () => {
    const res = await rename.run();
    if (!res) return;
    invalidateRepoList();
    toast.success(t("repos.renameDone", { from: res.from, to: res.to, count: res.changed }));
    onDone();
  };
  return (
    <Dialog title={t("repos.renameInventory")} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">{t("repos.renameConfirm", { from, to })}</p>
        {rename.error ? <Notice tone="danger">{rename.error.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("repos.cancel")}</Button>
          <Button variant="primary" loading={rename.pending} data-autofocus onClick={() => void submit()}>{t("repos.renameInventory")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
