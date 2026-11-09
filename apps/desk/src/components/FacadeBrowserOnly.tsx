"use client";

import { Stepper } from "@/components/SignInRun";
import { Button, Notice } from "@/components/ui";
import type { FacadeState } from "@/lib/facade";
import { useI18n } from "@/lib/i18n";

/**
 * Result of a guided sign-in whose provider cannot create the integration key for this account (an Anthropic individual
 * account has no admin keys). The sign-in worked, nothing is stored, and the browser is ready to create the keys. Only the
 * sign-in steps are listed: no key was created and no connection exists, so those steps must not show a tick.
 */
export function FacadeBrowserOnly({ run, onDone }: { run: FacadeState; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4 text-sm">
      <Notice tone="success" title={t("facade.browserOnlyTitle")}>
        <p>{t("facade.browserOnlyText")}</p>
      </Notice>
      <Stepper state={run} signInOnly />
      <div className="flex justify-end"><Button variant="primary" onClick={onDone}>{t("facade.done")}</Button></div>
    </div>
  );
}
