"use client";
import { Badge, Card, ErrorState, ListSkeleton, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { shortHash } from "@/lib/connection-health";
import { useT } from "@/lib/i18n";

export interface AutomationInfo {
  enabled: boolean;
  browser: { mode: "local" | "remote"; endpoint: string | null; reachable: boolean | null; browser: string | null; detail: string | null; viewerUrl: string | null };
  chrome: { found: boolean; path: string | null; hint: string | null };
  profileDir: string;
  loginTimeoutMinutes: number;
  allowExternalRecipes: boolean;
  recipes: { id: string; providerId: string; label: string; host: string; status: string; sha256: string; allowHosts: string[]; bundled: boolean }[];
  problems: { file: string; message: string }[];
}
/** Chrome status, profile folder, recipes and problems of the browser automation. For people who build integrations: shown under Settings, Developer. */
export function BrowserAutomationSection({ q }: { q: { data: AutomationInfo | undefined; error: Error | null; loading: boolean; reload: () => void } }) {
  const t = useT();
  const a = q.data;
  return (
    <section className="sd-section" aria-labelledby="browser-automation-title">
      <h2 id="browser-automation-title" className="text-lg font-semibold tracking-tight">{t("connections.browserTitle")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t(a?.browser.mode === "remote" ? "connections.browserSubtitleRemote" : "connections.browserSubtitle")}</p>
      {q.error ? <div className="mt-4"><ErrorState error={q.error} onRetry={q.reload} /></div> : null}
      {q.loading && !a ? <div className="mt-4"><ListSkeleton rows={1} /></div> : null}
      {a && !a.enabled ? <div className="mt-4"><Notice tone="info">{t("connections.browserOff")}</Notice></div> : null}
      {a && a.enabled ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <dl className="divide-y divide-line text-sm">
              {a.browser.mode === "remote" ? (
                <>
                  <div className="flex justify-between gap-4 py-2"><dt className="shrink-0 text-muted-text">{t("connections.browserRemote")}</dt><dd className="min-w-0 text-right font-medium">{a.browser.reachable ? <Badge info={{ label: t("connections.browserRemoteOk"), tone: "success", icon: "check" }} /> : <Badge info={{ label: t("connections.browserRemoteDown"), tone: "warn", icon: "alert" }} />}<span className="mt-1 block break-all font-mono text-xs font-normal text-muted-text">{a.browser.endpoint ?? ""}</span></dd></div>
                  <div className="py-2 text-xs text-muted">{a.browser.detail ?? t("connections.browserRemoteHint")}</div>
                  {a.browser.viewerUrl ? <div className="flex justify-between gap-4 py-2"><dt className="text-muted-text">{t("connections.browserViewer")}</dt><dd className="text-right"><a className="font-medium text-primary underline-offset-2 hover:underline" href={a.browser.viewerUrl} target="_blank" rel="noopener noreferrer">{t("connections.browserViewerOpen")}</a></dd></div> : <div className="py-2 text-xs text-muted">{t("connections.browserViewerMissing")}</div>}
                </>
              ) : (
                <>
              <div className="flex justify-between gap-4 py-2"><dt className="shrink-0 text-muted-text">{t("connections.browserChrome")}</dt><dd className="min-w-0 text-right font-medium">{a.chrome.found ? <><Badge info={{ label: t("connections.browserChromeFoundShort"), tone: "success", icon: "check" }} /><span className="mt-1 block break-all font-mono text-xs font-normal text-muted-text" title={a.chrome.path ?? ""}>{a.chrome.path ?? ""}</span></> : <Badge info={{ label: t("connections.browserChromeMissing"), tone: "warn", icon: "alert" }} />}</dd></div>
              {!a.chrome.found && a.chrome.hint ? <div className="py-2 text-xs text-muted">{a.chrome.hint}</div> : null}
                </>
              )}
              {a.browser.mode === "local" ? <div className="flex justify-between gap-4 py-2"><dt className="text-muted-text">{t("connections.browserProfile")}</dt><dd className="break-all text-right font-mono text-xs">{a.profileDir}</dd></div> : null}
              <div className="flex justify-between gap-4 py-2"><dt className="text-muted-text">{t("connections.browserTimeout")}</dt><dd className="text-right font-medium">{t("connections.browserMinutes", { count: a.loginTimeoutMinutes })}</dd></div>
            </dl>
          </Card>
          <Card>
            <p className="text-sm font-medium">{t("connections.browserRecipes")}</p>
            <p className="mt-2 text-xs text-muted">{a.allowExternalRecipes ? t("connections.recipeExternalOn") : t("connections.recipeExternalOff")}</p>
            {a.recipes.length === 0 ? <p className="mt-2 text-sm text-muted">{t("connections.browserNoRecipes")}</p> : (
              <ul className="mt-2 divide-y divide-line text-sm">
                {a.recipes.map((r) => (
                  <li key={r.providerId} className="py-2">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{r.label} <span className="font-mono text-xs font-normal text-muted">{r.providerId}</span> <Badge info={r.bundled ? { label: t("connections.recipeBundled"), tone: "success", icon: "shield" } : { label: t("connections.recipeExternal"), tone: "warn", icon: "alert" }} /></p>
                    <p className="text-xs text-muted">{r.host}: {r.status}</p>
                    <p className="text-xs text-muted">{t("connections.recipeHosts", { hosts: r.allowHosts.length > 0 ? r.allowHosts.join(", ") : t("connections.recipeHostsNone") })}</p>
                    <p className="font-mono text-xs text-muted" title={t("connections.recipeShaTitle", { sha: r.sha256 })}>{t("connections.recipeSha", { sha: shortHash(r.sha256) })}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="md:col-span-2">
            <p className="text-sm font-medium">{t("connections.browserProblems")}</p>
            {a.problems.length === 0 ? <p className="mt-2 text-sm text-muted">{t("connections.browserNoProblems")}</p> : (
              <ul className="mt-2 space-y-2 text-sm">
                {a.problems.map((p, i) => <li key={i}><Notice tone="warn"><span className="font-mono text-xs">{p.file}</span><br />{p.message}</Notice></li>)}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </section>
  );
}

const DOCS = "https://github.com/Pineflight/secret-desk/blob/main/docs";

/** Settings, Developer: the guide for building integrations and the state of the remote browser and its recipes. */
export function DeveloperPanel() {
  const t = useT();
  const auto = useQuery<AutomationInfo>("automation", () => api<AutomationInfo>("GET", "automation"));
  return (
    <div className="space-y-8">
      <section aria-labelledby="developer-title">
        <h2 id="developer-title" className="text-lg font-semibold tracking-tight">{t("settings.developer.title")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{t("settings.developer.intro")}</p>
        <Card className="mt-4">
          <p className="text-sm font-medium"><a className="text-primary underline-offset-2 hover:underline" href={`${DOCS}/DEVELOPING-INTEGRATIONS.md`} target="_blank" rel="noopener noreferrer">{t("settings.developer.docs")}</a></p>
          <p className="mt-1 text-xs text-muted">{t("settings.developer.docsHint")}</p>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a className="text-primary underline-offset-2 hover:underline" href={`${DOCS}/RECIPES.md`} target="_blank" rel="noopener noreferrer">{t("settings.developer.recipesDocs")}</a>
            <a className="text-primary underline-offset-2 hover:underline" href={`${DOCS}/BROWSER-AUTOMATION.md`} target="_blank" rel="noopener noreferrer">{t("settings.developer.browserDocs")}</a>
          </p>
        </Card>
      </section>
      <BrowserAutomationSection q={auto} />
    </div>
  );
}
