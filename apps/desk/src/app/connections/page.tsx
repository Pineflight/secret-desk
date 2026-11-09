"use client";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { signInParam } from "@/lib/renewal-warning";
import type { SecretView, VariableView } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, Pill, Skeleton } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { ConnectionCheckPanel, type CheckResult } from "@/components/ConnectionCheck";
import type { AutomationInfo } from "@/components/BrowserAutomationPanel";
import { FacadeCheckContext } from "@/components/ProviderFacade";
import { CategorySection, ProviderPageCard } from "@/components/ProviderCards";
import { ConnectionLinesList } from "@/components/ConnectionLines";
import type { FacadeInfo } from "@/lib/facade";
import { buildCards, connectionInfo, connectionLines, groupByCategory, stripeAccounts, isInUse, showsLegacyHint, signInPrompts, type ProviderCard, type VendorsResponse } from "@/lib/provider-cards";
import { ConnectionDefaultsSummary } from "@/components/ConnectionResources";
import { daysLabel, formatDate } from "@/lib/format";
import { allExpanded, cardKey, collapseAll, connectionKey, expandAll, readExpanded, toggled, writeExpanded } from "@/lib/card-state";
import { createCheckQueue, type CheckPhase, type CheckQueue } from "@/lib/check-queue";
import { checkBodyOf, checkHostsOf, checkIdOf, checkPathOf, outcomeOf, outcomeOfError, outcomeProblem, signInStatus, signedInIds, splitCheckId, type CheckOutcome, type CheckResponse, type SignInStatus } from "@/lib/sign-in-check";
import { daysSince, expiryLevel, staleWithoutExpiry } from "@/lib/connection-health";
import { collapsedBadge, collapsedMeta } from "@/lib/card-collapsed";
import { hasFailedTest, isCardBusy, lastCardResult, lastResult } from "@/lib/card-activity";
import { CardActivityProvider, useCardActivity, useCardActivityState } from "@/lib/use-card-activity";
import { SOURCE_KEYS, connectionLabel, labelOf, signInHeadingKey, signInSentence, type Connection, type Picking, type Provider } from "@/lib/connections-shared";
import { useMutation, useQuery } from "@/lib/hooks";
import { useI18n, useT } from "@/lib/i18n";

// The dialogs are heavy and only open on a click: they load as their own chunks, not with the page.
const IntegrationPicker = dynamic(() => import("@/components/IntegrationDialogs").then((m) => m.IntegrationPicker), { ssr: false });
const AddProviderDialog = dynamic(() => import("@/components/IntegrationDialogs").then((m) => m.AddProviderDialog), { ssr: false });

export default function ConnectionsPage() {
  const { t, locale } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const activity = useCardActivityState();
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [picking, setPicking] = useState<Picking>(false);
  // "Sign in" on a renewal warning leads here with ?signin=<provider>: open that provider's sign-in dialog once, then clean the address.
  const params = useSearchParams();
  const router = useRouter();
  const signinParam = signInParam(params.get("signin"));
  const [adding, setAdding] = useState(false);
  // Which cards (and keys) are open. Read after mounting so the server render and the first client render agree.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [openReady, setOpenReady] = useState(false);
  useEffect(() => { setOpen(readExpanded()); setOpenReady(true); }, []);
  useEffect(() => { if (openReady) writeExpanded(open); }, [open, openReady]);
  // Sign-in checks share the one remote browser: they run one after the other, a click checks one provider only.
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, CheckOutcome>>>({});
  const [phases, setPhases] = useState<ReadonlyMap<string, CheckPhase>>(new Map());
  const queue = useRef<CheckQueue<CheckOutcome> | null>(null);
  // The check route depends on the card (its guided sign-in or its recipe): the queue reads the latest cards and reloads the
  // server's sign-in memory afterwards, so the badge follows the new answer.
  const cardsRef = useRef<ProviderCard[] | null>(null);
  const reloadAutomation = useRef<(() => void) | null>(null);
  if (queue.current === null) {
    queue.current = createCheckQueue<CheckOutcome>(async (id) => {
      // A provider with several portals is checked per portal: the key names the host.
      const { cardId, host } = splitCheckId(id);
      const card = cardsRef.current!.find((c) => c.id === cardId)!;
      const portal = host ? card.signIn.checkHosts?.find((h) => h.host === host)?.value : undefined;
      const name = portal ? `${card.label} ${portal}` : card.label;
      const outcome = await activityRef.current.track<CheckOutcome>({
        card: cardId,
        kind: "signin",
        ...(host ? { line: host } : {}),
        name,
        work: async () => {
          let result: CheckOutcome;
          try {
            result = outcomeOf(await api<CheckResponse>("POST", checkPathOf(card)!, checkBodyOf(host)));
          } catch (e) {
            result = outcomeOfError(e);
          }
          setOutcomes((o) => ({ ...o, [id]: result }));
          reloadAutomation.current?.();
          return result;
        },
        judge: (r) => ({ ok: r.signedIn === true, detail: outcomeProblem(r, localeRef.current, tRef.current) }),
      });
      // `work` catches its own errors, so `track` always has a result.
      return outcome!;
    }, setPhases);
  }
  const signedIn = useMemo(() => signedInIds(outcomes), [outcomes]);
  // The connect dialog runs its sign-in check through the same queue, so it never overlaps another check in the one browser.
  const checkContext = useMemo(() => ({ check: (id: string) => queue.current!.enqueue(id) }), []);
  const conns = useQuery<Connection[]>("connections", () => api<Connection[]>("GET", "connections"));
  const provs = useQuery<Provider[]>("providers-full", () => api<Provider[]>("GET", "providers"));
  const auto = useQuery<AutomationInfo>("automation", () => api<AutomationInfo>("GET", "automation"));
  const vendors = useQuery<VendorsResponse>("vendors", () => api<VendorsResponse>("GET", "vendors"));
  // Providers with a guided sign-in. Failing to load them only hides the sign-in way.
  const facades = useQuery<FacadeInfo[]>("facades", () => api<FacadeInfo[]>("GET", "facades"));
  // Counts of what depends on a provider. Failing to load them only hides the counts.
  const secrets = useQuery<SecretView[]>("overview-secrets", () => api<SecretView[]>("GET", "secrets"));
  const vars = useQuery<VariableView[]>("overview-variables", () => api<VariableView[]>("GET", "variables"));
  const [removingId, setRemovingId] = useState<string | null>(null);
  const remove = async (id: string, name: string, cardId: string) => {
    setRemovingId(id);
    try {
      const done = await activity.track({ card: cardId, kind: "remove", line: id, name, work: () => api<Connection>("DELETE", `connections/${enc(id)}/token`), judge: () => ({ ok: true }) });
      if (done) { conns.reload(); facades.reload(); }
    } finally {
      setRemovingId(null);
    }
  };
  reloadAutomation.current = auto.reload;
  const cards = useMemo(
    () =>
      vendors.data && conns.data
        ? buildCards({
            catalog: vendors.data,
            connections: conns.data,
            providers: provs.data ?? [],
            recipes: auto.data?.recipes ?? [],
            facades: facades.data ?? [],
            secrets: secrets.data ?? [],
            variables: vars.data ?? [],
            signedIn,
            automationEnabled: auto.data?.enabled ?? false,
            signInChecks: auto.data?.signInChecks ?? [],
            ...(auto.data ? { signInFreshHours: auto.data.signInFreshHours, signInLifetimes: auto.data.signInLifetimes ?? [] } : {}),
            now: new Date(),
          })
        : null,
    [vendors.data, conns.data, provs.data, auto.data, facades.data, secrets.data, vars.data, signedIn],
  );
  cardsRef.current = cards;
  useEffect(() => {
    if (!signinParam || !cards) return;
    if (cards.some((c) => c.id === signinParam)) setPicking({ vendor: signinParam, signIn: true, renewal: true });
    router.replace("/connections");
  }, [signinParam, cards, router]);
  const used = (cards ?? []).filter(isInUse);
  const groups = cards && vendors.data ? groupByCategory(used, vendors.data.categories) : [];
  const reloadAll = () => { conns.reload(); facades.reload(); auto.reload(); };
  return (
    <CardActivityProvider value={activity}>
    <FacadeCheckContext.Provider value={checkContext}>
      <PageHeader
        title={t("connections.title")}
        subtitle={t("connections.subtitle")}
        actions={<Button variant="primary" onClick={() => setPicking({ vendor: null })}><Icon name="plus" className="h-4 w-4" />{t("connections.add")}</Button>}
      />
      {conns.error ? <ErrorState error={conns.error} onRetry={conns.reload} /> : null}
      {vendors.error ? <ErrorState error={vendors.error} onRetry={vendors.reload} /> : null}
      {facades.error ? <div className="mb-3"><Notice tone="warn">{t("providers.page.facadesFailed")} <button type="button" className="underline" onClick={facades.reload}>{t("common.retry")}</button></Notice></div> : null}
      {(conns.loading || vendors.loading) && !cards ? <ListSkeleton rows={2} /> : null}
      {cards && used.length === 0 ? (
        <EmptyState title={t("connections.emptyTitle")} icon="plug">
          <p className="mb-3 text-sm text-muted">{t("providers.page.emptyHint")}</p>
          <Button variant="primary" onClick={() => setPicking({ vendor: null })}>{t("connections.add")}</Button>
        </EmptyState>
      ) : null}
      {used.length > 0 ? (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setOpen(allExpanded(open, used.map((c) => c.id)) ? collapseAll() : expandAll(open, used.map((c) => c.id)))}>
            {allExpanded(open, used.map((c) => c.id)) ? t("providers.collapseAll") : t("providers.expandAll")}
          </Button>
        </div>
      ) : null}
      {groups.map((g) => (
        <CategorySection key={g.category} category={g.category} grid="cards" level="h2">
          {g.cards.map((card) => {
            const phase = phases.get(card.id);
            const outcome = outcomes[card.id];
            const problem = outcomeProblem(outcome, locale, t);
            const signIn = signInStatus(card, phase, outcome);
            const collapsedInput = { signIn, testFailed: hasFailedTest(activity.state, card.id) };
            return (
              <li key={card.id} className="flex min-w-0">
                <ProviderPageCard
                  card={card}
                  view={{ badge: collapsedBadge(card, collapsedInput), meta: collapsedMeta(card, collapsedInput) }}
                  open={open.has(cardKey(card.id))}
                  onToggle={() => setOpen((o) => toggled(o, cardKey(card.id)))}
                  busy={isCardBusy(activity.state, card.id)}
                  last={lastCardResult(activity.state, card.id)}
                  results={(line) => lastResult(activity.state, card.id, line)}
                  setUp={() => setPicking({ vendor: card.id })}
                  signIn={signIn}
                  hostPhases={phases}
                  signInPrompts={signInPrompts(card)}
                  onSignIn={(portal) => setPicking({ vendor: card.id, signIn: true, portal })}
                  actions={
                    <>
                      {card.signIn.facade ? (
                        <Button variant="primary" disabled={!card.signIn.facade.available} onClick={() => setPicking({ vendor: card.id, signIn: true })}>{card.signIn.facade.connected ? t("facade.reconnect") : t("facade.connectWith")}</Button>
                      ) : null}
                      {card.signIn.facade || card.signIn.checkRecipe ? (
                        checkHostsOf(card).length > 0 ? (
                          // One button per portal: each has its own account, so each is checked on its own. A queued check is a
                          // status next to the line (see the card summary), the button keeps naming its action.
                          checkHostsOf(card).map((h) => {
                            const hostPhase = phases.get(checkIdOf(card.id, h.host));
                            return (
                              <Button key={h.host} disabled={!card.signIn.available || hostPhase !== undefined} loading={hostPhase === "checking"} onClick={() => void queue.current?.enqueue(checkIdOf(card.id, h.host))}>
                                {t("providers.signIn.hostCheck", { portal: h.value })}
                              </Button>
                            );
                          })
                        ) : (
                          <Button disabled={!card.signIn.available || phase !== undefined} loading={phase === "checking"} onClick={() => void queue.current?.enqueue(card.id)}>
                            {t("facade.checkSignin")}
                          </Button>
                        )
                      ) : null}
                      <Button onClick={() => setPicking({ vendor: card.id })}>{t("providers.page.manage")}</Button>
                    </>
                  }
                >
                  <SignInLine card={card} status={signIn} problem={problem} outcomes={outcomes} locale={locale} />
                  <CardKeys card={card} conns={conns.data!} open={open} setOpen={setOpen} setPicking={setPicking} removingId={removingId} remove={remove} disconnecting={removingId !== null} />
                </ProviderPageCard>
              </li>
            );
          })}
        </CategorySection>
      ))}
      {picking !== false && cards && vendors.data ? (
        <IntegrationPicker
          initial={picking}
          cards={cards}
          conns={conns.data!}
          facades={facades.data ?? []}
          categories={vendors.data.categories}
          signedIn={signedIn}
          onClose={() => setPicking(false)}
          onChanged={(vendor, kind) => { reloadAll(); if (kind) activity.note({ card: vendor, kind }, cards.find((c) => c.id === vendor)!.label, true); }}
          onNewProvider={() => { setPicking(false); setAdding(true); }}
        />
      ) : null}
      {adding ? <AddProviderDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); provs.reload(); setPicking({ vendor: null }); }} /> : null}
    </FacadeCheckContext.Provider>
    </CardActivityProvider>
  );
}

/**
 * The connected keys inside a provider card. A vendor with keys per account (a connection prefix) gets one compact line per
 * connection, with Test, Reconnect and Remove; other keys stay the collapsible rows.
 */
function CardKeys({ card, conns, open, setOpen, setPicking, removingId, remove, disconnecting }: { card: ProviderCard; conns: Connection[]; open: ReadonlySet<string>; setOpen: (f: (o: ReadonlySet<string>) => ReadonlySet<string>) => void; setPicking: (p: Picking) => void; removingId: string | null; remove: (id: string, name: string, cardId: string) => Promise<void>; disconnecting: boolean }) {
  const t = useT();
  const lines = connectionLines(card);
  const facade = card.signIn.facade;
  // The guided sign-in knows the modes sandbox and live; an older `test` line reconnects as sandbox.
  const accountInputs = (line: { accountId: string; mode: string | null }): Record<string, string> => ({ account: line.accountId, ...(line.mode ? { mode: line.mode === "test" ? "sandbox" : line.mode } : {}) });
  return (
    <div className="mt-3 space-y-2">
      {lines.accounts.length > 0 || lines.legacy || card.prefixes.length > 0 ? (
        <ConnectionLinesList
          lines={lines}
          blocks={stripeAccounts(card)}
          removingId={removingId}
          onOpen={(id) => setPicking({ vendor: card.id, key: id })}
          cardId={card.id}
          onRemove={(id) => remove(id, labelOf(conns.find((c) => c.id === id)!), card.id)}
          {...(facade ? { onReconnect: (l) => setPicking({ vendor: card.id, signIn: true, inputs: accountInputs(l) }), onConnectMode: (accountId, mode) => setPicking({ vendor: card.id, signIn: true, inputs: { account: accountId, mode } }), onConnectAnother: () => setPicking({ vendor: card.id, signIn: true }) } : {})}
        />
      ) : null}
      {lines.others.map((k) => {
        const c = conns.find((x) => x.id === k.id)!;
        return <ConnectionCard key={c.id} c={c} open={open.has(connectionKey(c.id))} onToggle={() => setOpen((o) => toggled(o, connectionKey(c.id)))} onGuide={() => setPicking({ vendor: card.id, key: c.id })} onDisconnect={() => void remove(c.id, labelOf(c), card.id)} cardId={card.id} disconnecting={disconnecting} />;
      })}
      {lines.accounts.length === 0 && !lines.legacy && showsLegacyHint(card) ? <Notice tone="info">{t("providers.keys.legacyHint")}</Notice> : null}
      {card.produces.length > 0 ? (
        <div className="rounded-xl bg-page p-3 text-xs text-muted">
          <p className="font-medium text-ink">{t("providers.produces.title")}</p>
          <ul className="mt-1 space-y-0.5">
            {card.produces.map((p) => <li key={p.provider}>{t("providers.produces.row", { label: p.label, count: p.count })}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** One plain sentence about the provider's browser sign-in, and the result of the last check. */
function SignInLine({ card, status, problem, outcomes, locale }: { card: ProviderCard; status: SignInStatus | null; problem: string | null; outcomes: Readonly<Record<string, CheckOutcome>>; locale: "de" | "en" }) {
  const t = useT();
  const s = card.signIn;
  if (s.state === "none") return null;
  const hosts = checkHostsOf(card);
  return (
    <div className="mt-3 rounded-xl bg-page p-3 text-xs text-muted">
      <p className="font-medium text-ink">{t(signInHeadingKey(card))}</p>
      <p className="mt-0.5">{signInSentence(card, t)}</p>
      {status === "yes" || status === "no" ? <p className="mt-1" role="status">{t(status === "yes" ? "providers.signIn.signedInYes" : "providers.signIn.signedInNo")}</p> : null}
      {hosts.map((h) => {
        const o = outcomes[checkIdOf(card.id, h.host)];
        const failed = outcomeProblem(o, locale, t);
        if (!o) return null;
        return failed
          ? <p key={h.host} className="mt-1 text-danger-text" role="alert">{t("providers.signIn.hostFailed", { name: card.label, portal: h.value })} {failed}</p>
          : <p key={h.host} className="mt-1" role="status">{t(o.signedIn ? "providers.signIn.hostYes" : "providers.signIn.hostNo", { name: card.label, portal: h.value })}</p>;
      })}
      {problem ? <p className="mt-1 text-danger-text" role="alert">{problem}</p> : null}
    </div>
  );
}


/** One connected key, a compact row inside its provider card (name, expiry, source) that opens to its details and actions. */
function ConnectionCard({ c, cardId, onGuide, onDisconnect, disconnecting, open, onToggle }: { c: Connection; cardId: string; onGuide: () => void; onDisconnect: () => void; disconnecting: boolean; open: boolean; onToggle: () => void }) {
  const t = useT();
  const [checked, setChecked] = useState<CheckResult | null>(null);
  // The expiry date the provider reports replaces the manual one while the test result is visible.
  const expires = checked && checked.expires !== undefined ? checked.expires : c.expires;
  const daysLeft = typeof expires === "string" ? Math.ceil((Date.parse(`${expires}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
  const level = expiryLevel(daysLeft);
  const saved = daysSince(c.savedAt);
  const stale = staleWithoutExpiry(expires, c.savedAt);
  const levelBadge = level === "ok" ? { label: t("connections.expOk"), tone: "success" as const, icon: "check" as const }
    : level === "soon" ? { label: t("connections.expSoon"), tone: "warn" as const, icon: "clock" as const }
    : level === "critical" ? { label: t("connections.expCritical"), tone: "danger" as const, icon: "alert" as const }
    : level === "expired" ? { label: t("connections.expExpired"), tone: "danger" as const, icon: "x" as const }
    : null;
  const bodyId = useId();
  const purposeId = useId();
  const purposeKey = connectionInfo(c.id)?.purpose ?? null;
  const name = (
    <>
      {connectionLabel(c, t)}
      {c.role === "optional" ? <> <Pill>{t("providers.keys.optional")}</Pill></> : null}
      {c.role === "legacy" ? <> <Pill>{t("providers.keys.legacy")}</Pill></> : null}
    </>
  );
  const sourceBadge = <Badge info={{ label: t("connections.connectedBadge", { source: SOURCE_KEYS[c.source] ? t(SOURCE_KEYS[c.source]!) : c.source }), tone: "success", icon: "check" }} />;
  return (
    <NestedShell>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} {...(purposeKey ? { "aria-describedby": purposeId } : {})} aria-label={t(open ? "providers.key.hide" : "providers.key.show", { name: labelOf(c) })} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
        <Icon name="chevron" className={`h-4 w-4 shrink-0 text-muted-text transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 text-sm font-medium">{name}</span>
        {levelBadge ? <Badge info={levelBadge} /> : null}
        {sourceBadge}
      </button>
      {purposeKey ? <p id={purposeId} className="mt-0.5 pl-7 text-xs text-muted">{t(purposeKey)}</p> : null}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <>
            {c.description ? <p className="mt-1 text-sm text-muted">{c.description}</p> : null}
            {c.fingerprint ? <p className="mt-1 text-xs text-muted">{t("connections.fingerprint", { fp: c.fingerprint })}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className={`text-sm ${level === "critical" || level === "expired" ? "font-medium text-danger" : "text-muted"}`}>
                {expires === undefined ? t("connections.expiryUnknown") : expires === null ? t("connections.neverExpires") : t("connections.validUntil", { date: formatDate(expires), days: daysLabel(daysLeft) })}
              </p>
            </div>
            {level === "expired" ? <div className="mt-2"><Notice tone="danger">{t("connections.expExpiredHint")}</Notice></div> : null}
            {saved !== null ? <p className="mt-1 text-xs text-muted">{saved === 0 ? t("connections.savedToday") : t("connections.savedDaysAgo", { count: saved })}</p> : null}
            {stale !== null ? <div className="mt-2"><Notice tone="warn">{t("connections.staleNoExpiry", { days: stale })}</Notice></div> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={onGuide}>{t("connections.guide")}</Button>
              {c.source === "session" || c.source === "vault" ? <Button loading={disconnecting} onClick={onDisconnect}>{t("connections.disconnect")}</Button> : null}
            </div>
            <ConnectionDefaultsSummary id={c.id} />
            <ConnectionCheckPanel id={c.id} name={labelOf(c)} cardId={cardId} onResult={setChecked} />
          </>
        ) : null}
      </div>
    </NestedShell>
  );
}

/** A key inside its provider card: a bordered block instead of a card of its own. */
function NestedShell({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-line p-3">{children}</div>;
}
