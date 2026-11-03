"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SecretView, VariableView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, Checkbox, PageHeader, Pill, SelectField, TextAreaField, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { ConnectionCheckPanel, type CheckResult } from "@/components/ConnectionCheck";
import type { AutomationInfo } from "@/components/BrowserAutomationPanel";
import { FacadeCheckContext, FacadeFlow } from "@/components/ProviderFacade";
import { CategorySection, ProviderLogo, ProviderPageCard, ProviderTile, CardStatusBadge, usePurpose } from "@/components/ProviderCards";
import type { FacadeInfo } from "@/lib/facade";
import { buildCards, cardMatches, groupByCategory, isInUse, showsLegacyHint, type ProviderCard, type VendorsResponse } from "@/lib/provider-cards";
import { ConnectionDefaultsSummary, ConnectionResourcesPanel } from "@/components/ConnectionResources";
import { daysLabel, formatDate } from "@/lib/format";
import { allExpanded, cardKey, collapseAll, connectionKey, expandAll, readExpanded, toggled, writeExpanded } from "@/lib/card-state";
import { createCheckQueue, type CheckPhase, type CheckQueue } from "@/lib/check-queue";
import { checkPathOf, outcomeOf, outcomeOfError, outcomeProblem, signInStatus, signedInIds, type CheckOutcome, type CheckResponse, type SignInStatus } from "@/lib/sign-in-check";
import { daysSince, expiryLevel, staleWithoutExpiry, stripePrefixMismatch } from "@/lib/connection-health";
import { useMutation, useQuery } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useI18n, useT } from "@/lib/i18n";
import type { ReactNode } from "react";

interface Connection {
  id: string;
  connected: boolean;
  source: "session" | "env" | "op" | "none" | string;
  hint?: string;
  expires?: string | null;
  daysLeft?: number | null;
  savedAt?: string | null;
  fingerprint?: string;
  canRemember?: boolean;
  label: string;
  vendor: string | null;
  role: "primary" | "legacy" | "optional";
  description: string | null;
  url: string | null;
  openUrl: string | null;
  steps: string[];
  permissions: string[];
}
interface Provider {
  id: string;
  label: string;
  kind: string;
  browser: boolean;
  vendor: string | null;
  connection: string | null;
  guide: { url: string; steps: string[] } | null;
}

const NAMES: Record<string, string> = { github: "GitHub", cloudflare: "Cloudflare", supabase: "Supabase", stripe: "Stripe", resend: "Resend", revenuecat: "RevenueCat", grafana: "Grafana" };
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_KEYS: Record<string, string> = { session: "connections.srcSession", env: "connections.srcEnv", op: "connections.srcOp", vault: "connections.srcVault", github: "connections.srcGithub", none: "connections.srcNone" };

/** Where the picker opens: a provider (or the full list), optionally straight into one of its ways in. */
type Picking = false | { vendor: string | null; key?: string; signIn?: boolean };

export default function ConnectionsPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [picking, setPicking] = useState<Picking>(false);
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
  const reloadAutomation = useRef<() => void>(() => undefined);
  if (queue.current === null) {
    queue.current = createCheckQueue<CheckOutcome>(async (id) => {
      let outcome: CheckOutcome;
      try {
        const card = cardsRef.current?.find((c) => c.id === id);
        const path = card ? checkPathOf(card) : null;
        if (!path) throw new Error("");
        outcome = outcomeOf(await api<CheckResponse>("POST", path));
      } catch (e) {
        outcome = outcomeOfError(e);
      }
      setOutcomes((o) => ({ ...o, [id]: outcome }));
      reloadAutomation.current();
      return outcome;
    }, setPhases);
  }
  const signedIn = useMemo(() => signedInIds(outcomes), [outcomes]);
  // The connect dialog runs its sign-in check through the same queue, so it never overlaps another check in the one browser.
  const checkContext = useMemo(() => ({ check: (id: string) => queue.current?.enqueue(id) ?? Promise.resolve(undefined) }), []);
  const conns = useQuery<Connection[]>("connections", () => api<Connection[]>("GET", "connections"));
  const provs = useQuery<Provider[]>("providers-full", () => api<Provider[]>("GET", "providers"));
  const auto = useQuery<AutomationInfo>("automation", () => api<AutomationInfo>("GET", "automation"));
  const vendors = useQuery<VendorsResponse>("vendors", () => api<VendorsResponse>("GET", "vendors"));
  // Providers with a guided sign-in. Failing to load them only hides the sign-in way.
  const facades = useQuery<FacadeInfo[]>("facades", () => api<FacadeInfo[]>("GET", "facades"));
  // Counts of what depends on a provider. Failing to load them only hides the counts.
  const secrets = useQuery<SecretView[]>("overview-secrets", () => api<SecretView[]>("GET", "secrets"));
  const vars = useQuery<VariableView[]>("overview-variables", () => api<VariableView[]>("GET", "variables"));
  const del = useMutation(async (id: string) => api<Connection>("DELETE", `connections/${enc(id)}/token`));
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
            ...(auto.data ? { signInFreshHours: auto.data.signInFreshHours } : {}),
            now: new Date(),
          })
        : null,
    [vendors.data, conns.data, provs.data, auto.data, facades.data, secrets.data, vars.data, signedIn],
  );
  cardsRef.current = cards;
  const used = (cards ?? []).filter(isInUse);
  const groups = cards && vendors.data ? groupByCategory(used, vendors.data.categories) : [];
  const reloadAll = () => { conns.reload(); facades.reload(); };
  return (
    <FacadeCheckContext.Provider value={checkContext}>
      <PageHeader
        title={t("connections.title")}
        subtitle={t("connections.subtitle")}
        actions={<Button variant="primary" onClick={() => setPicking({ vendor: null })}><Icon name="plus" className="h-4 w-4" />{t("connections.add")}</Button>}
      />
      {conns.error ? <ErrorState error={conns.error} onRetry={conns.reload} /> : null}
      {vendors.error ? <ErrorState error={vendors.error} onRetry={vendors.reload} /> : null}
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
            return (
              <li key={card.id}>
                <ProviderPageCard
                  card={card}
                  open={open.has(cardKey(card.id))}
                  onToggle={() => setOpen((o) => toggled(o, cardKey(card.id)))}
                  signIn={signInStatus(card, phase, outcome)}
                  actions={
                    <>
                      {card.signIn.facade ? (
                        <Button variant="primary" disabled={!card.signIn.facade.available} onClick={() => setPicking({ vendor: card.id, signIn: true })}>{card.signIn.facade.connected ? t("facade.reconnect") : t("facade.connectWith")}</Button>
                      ) : null}
                      {card.signIn.facade || card.signIn.checkRecipe ? (
                        <Button disabled={!card.signIn.available || phase !== undefined} loading={phase === "checking"} onClick={() => void queue.current?.enqueue(card.id)}>
                          {phase === "checking" ? t("facade.checking") : phase === "waiting" ? t("facade.checkWaiting") : t("facade.checkSignin")}
                        </Button>
                      ) : null}
                      <Button onClick={() => setPicking({ vendor: card.id })}>{t("providers.page.manage")}</Button>
                    </>
                  }
                >
                  <SignInLine card={card} status={signInStatus(card, phase, outcome)} problem={problem} />
                  <div className="mt-3 space-y-2">
                    {card.keys.filter((k) => k.connected).map((k) => {
                      const c = (conns.data ?? []).find((x) => x.id === k.id);
                      return c ? <ConnectionCard key={c.id} c={c} nested open={open.has(connectionKey(c.id))} onToggle={() => setOpen((o) => toggled(o, connectionKey(c.id)))} onGuide={() => setPicking({ vendor: card.id, key: c.id })} onDisconnect={async () => { if (await del.run(c.id)) { toast.success(t("connections.disconnected", { name: labelOf(c) })); conns.reload(); } }} disconnecting={del.pending} /> : null;
                    })}
                    {showsLegacyHint(card) ? <Notice tone="info">{t("providers.keys.legacyHint")}</Notice> : null}
                  </div>
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
          conns={conns.data ?? []}
          facades={facades.data ?? []}
          categories={vendors.data.categories}
          signedIn={signedIn}
          onClose={() => setPicking(false)}
          onChanged={reloadAll}
          onNewProvider={() => { setPicking(false); setAdding(true); }}
        />
      ) : null}
      {adding ? <AddProviderDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); provs.reload(); setPicking({ vendor: null }); }} /> : null}
    </FacadeCheckContext.Provider>
  );
}

/** One plain sentence about the provider's browser sign-in, and the result of the last check. */
function SignInLine({ card, status, problem }: { card: ProviderCard; status: SignInStatus | null; problem: string | null }) {
  const t = useT();
  const s = card.signIn;
  if (s.state === "none") return null;
  return (
    <div className="mt-3 rounded-xl bg-page p-3 text-xs text-muted">
      <p className="font-medium text-ink">{t("providers.way.signIn")}</p>
      <p className="mt-0.5">{signInSentence(card, t)}</p>
      {status === "yes" || status === "no" ? <p className="mt-1" role="status">{t(status === "yes" ? "providers.signIn.signedInYes" : "providers.signIn.signedInNo")}</p> : null}
      {problem ? <p className="mt-1 text-danger-text" role="alert">{problem}</p> : null}
    </div>
  );
}

function signInSentence(card: ProviderCard, t: (k: string, v?: Record<string, string | number>) => string): string {
  const s = card.signIn;
  if (s.state === "facade") return t(s.facade && s.facade.id === "stripe" ? "providers.signIn.facadeScoped" : "providers.signIn.facade");
  if (s.state === "recipe") return t(s.available ? "providers.signIn.recipe" : "providers.signIn.recipeOff", { name: card.label });
  return t("providers.signIn.coming", { name: card.label });
}

/** One connected key. Nested in a provider card it is a compact row (name, expiry, source) that opens to its details and actions. */
function ConnectionCard({ c, onGuide, onDisconnect, disconnecting, open = true, onToggle, nested = false }: { c: Connection; onGuide: () => void; onDisconnect: () => void; disconnecting: boolean; open?: boolean; onToggle?: () => void; nested?: boolean }) {
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
  const Shell = nested ? NestedShell : Card;
  const bodyId = useId();
  const name = (
    <>
      {labelOf(c)}
      {c.role === "optional" ? <> <Pill>{t("providers.keys.optional")}</Pill></> : null}
      {c.role === "legacy" ? <> <Pill>{t("providers.keys.legacy")}</Pill></> : null}
    </>
  );
  const sourceBadge = <Badge info={{ label: t("connections.connectedBadge", { source: SOURCE_KEYS[c.source] ? t(SOURCE_KEYS[c.source]!) : c.source }), tone: "success", icon: "check" }} />;
  return (
    <Shell>
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} aria-label={t(open ? "providers.key.hide" : "providers.key.show", { name: labelOf(c) })} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
          <Icon name="chevron" className={`h-4 w-4 shrink-0 text-muted-text transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 text-sm font-medium">{name}</span>
          {levelBadge ? <Badge info={levelBadge} /> : null}
          {sourceBadge}
        </button>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p className="font-medium">{name}</p>
          {sourceBadge}
        </div>
      )}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <>
            {c.description ? <p className="mt-1 text-sm text-muted">{c.description}</p> : null}
            {c.fingerprint ? <p className="mt-1 text-xs text-muted">{t("connections.fingerprint", { fp: c.fingerprint })}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className={`text-sm ${level === "critical" || level === "expired" ? "font-medium text-danger" : "text-muted"}`}>
                {expires === undefined ? t("connections.expiryUnknown") : expires === null ? t("connections.neverExpires") : t("connections.validUntil", { date: formatDate(expires), days: daysLabel(daysLeft) })}
              </p>
              {!onToggle && levelBadge ? <Badge info={levelBadge} /> : null}
            </div>
            {level === "expired" ? <div className="mt-2"><Notice tone="danger">{t("connections.expExpiredHint")}</Notice></div> : null}
            {saved !== null ? <p className="mt-1 text-xs text-muted">{saved === 0 ? t("connections.savedToday") : t("connections.savedDaysAgo", { count: saved })}</p> : null}
            {stale !== null ? <div className="mt-2"><Notice tone="warn">{t("connections.staleNoExpiry", { days: stale })}</Notice></div> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={onGuide}>{t("connections.guide")}</Button>
              {c.source === "session" || c.source === "vault" ? <Button loading={disconnecting} onClick={onDisconnect}>{t("connections.disconnect")}</Button> : null}
            </div>
            <ConnectionDefaultsSummary id={c.id} />
            <ConnectionCheckPanel id={c.id} onResult={setChecked} />
          </>
        ) : null}
      </div>
    </Shell>
  );
}

/** A key inside its provider card: a bordered block instead of a card of its own. */
function NestedShell({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-line p-3">{children}</div>;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Setzt die Laufzeit im Anbieter-Link, falls dieser expires_in kennt (GitHub: 1 bis 366 Tage oder none). */
function withExpiry(url: string, days: number | null): string {
  const u = new URL(url);
  if (!u.searchParams.has("expires_in")) return url;
  u.searchParams.set("expires_in", days === null ? "none" : String(Math.min(366, days)));
  return u.toString();
}

const labelOf = (c: Connection) => c.label || NAMES[c.id] || c.id;

/** The picker: all providers as tiles by category; a provider opens its ways in. */
function IntegrationPicker({ initial, cards, conns, facades, categories, signedIn, onClose, onChanged, onNewProvider }: { initial: { vendor: string | null; key?: string; signIn?: boolean }; cards: ProviderCard[]; conns: Connection[]; facades: FacadeInfo[]; categories: string[]; signedIn: ReadonlySet<string>; onClose: () => void; onChanged: () => void; onNewProvider: () => void }) {
  const t = useT();
  const purposeOf = usePurpose();
  const [vendor, setVendor] = useState<string | null>(initial.vendor);
  const [sub, setSub] = useState<Sub>(initial.key ? { kind: "key", id: initial.key } : initial.signIn ? { kind: "signin" } : null);
  const [q, setQ] = useState("");
  const card = vendor ? (cards.find((c) => c.id === vendor) ?? null) : null;

  if (card) {
    return (
      <Dialog title={card.label} description={purposeOf(card)} onClose={onClose} size="xl">
        <button type="button" onClick={() => (sub ? setSub(null) : setVendor(null))} className="mb-4 inline-flex items-center gap-1 text-sm text-primary">{sub ? t("connections.back") : t("providers.back")}</button>
        <VendorDetail card={card} conns={conns} facades={facades} signedIn={signedIn} sub={sub} setSub={setSub} onChanged={onChanged} onDone={onClose} />
      </Dialog>
    );
  }
  const needle = q.trim();
  const shown = cards.filter((c) => cardMatches(c, needle, { purpose: purposeOf(c), category: t(`category.${c.category}`) }));
  const groups = groupByCategory(shown, categories);
  return (
    <Dialog title={t("providers.pickTitle")} description={t("providers.pickDesc")} onClose={onClose} size="xl">
      <input type="search" autoComplete="off" placeholder={t("providers.search")} aria-label={t("providers.search")} data-autofocus value={q} onChange={(e) => setQ(e.target.value)} className={`${inputClass} mb-5 w-full`} />
      {groups.map((g) => (
        <CategorySection key={g.category} category={g.category}>
          {g.cards.map((c) => (
            <li key={c.id}><ProviderTile card={c} onOpen={() => { setVendor(c.id); setSub(null); }} /></li>
          ))}
        </CategorySection>
      ))}
      {groups.length === 0 ? <p className="rounded-xl border border-line px-4 py-3 text-sm text-muted" role="status">{t("providers.noMatches")}</p> : null}
      <button type="button" onClick={onNewProvider} className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary"><Icon name="plus" className="h-4 w-4" />{t("connections.addCustom")}</button>
    </Dialog>
  );
}

type Sub = null | { kind: "key"; id: string } | { kind: "hand"; id: string } | { kind: "signin" };

/** A provider's ways in, each with one plain sentence. */
function VendorDetail({ card, conns, facades, signedIn, sub, setSub, onChanged, onDone }: { card: ProviderCard; conns: Connection[]; facades: FacadeInfo[]; signedIn: ReadonlySet<string>; sub: Sub; setSub: (s: Sub) => void; onChanged: () => void; onDone: () => void }) {
  const t = useT();
  const facade = card.signIn.facade ? facades.find((f) => f.id === card.signIn.facade!.id) : undefined;
  const paste = facade ? conns.find((c) => c.id === facade.connectionId) : undefined;
  const fallback = paste ? <ConnectionDetail c={paste} onChanged={onChanged} onDone={onDone} noExpiry /> : undefined;

  if (sub?.kind === "key") {
    const c = conns.find((x) => x.id === sub.id);
    return c ? <ConnectionDetail c={c} onChanged={onChanged} onDone={onDone} /> : null;
  }
  if (sub?.kind === "hand") {
    const p = card.byHand.find((x) => x.id === sub.id);
    return p ? <ProviderDetail p={p} /> : null;
  }
  if (sub?.kind === "signin" && facade) {
    // The guided sign-in: pasting a key is only the collapsed way out.
    return <FacadeFlow facade={facade} onChanged={onChanged} onDone={onDone} {...(fallback ? { fallback } : {})} />;
  }
  const keys = card.keys.filter((k) => k.connected || (k.role !== "legacy" && !card.signIn.facade));
  return (
    <div className="space-y-5 text-sm">
      <h3 className="sr-only">{t("providers.ways")}</h3>
      {card.signIn.state !== "none" ? (
        <section aria-labelledby={`way-signin-${card.id}`} className="rounded-xl border border-line p-4">
          <h4 id={`way-signin-${card.id}`} className="font-medium">{t("providers.way.signIn")}</h4>
          <p className="mt-1 text-muted">{signInSentence(card, t)}</p>
          {card.signIn.recipes.length > 0 ? <p className="mt-1 text-xs text-muted">{t("providers.signIn.recipes", { names: card.signIn.recipes.map((r) => r.label).join(", ") })}</p> : null}
          {facade ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={!facade.available} onClick={() => setSub({ kind: "signin" })}>{facade.connected ? t("facade.reconnect") : t("providers.signIn.start")}</Button>
              {signedIn.has(card.id) ? <span className="text-xs text-muted" role="status">{t("providers.signIn.signedInYes")}</span> : null}
              {!facade.available ? <span className="text-xs text-warn-text">{t("facade.unavailable", { reason: facade.reason ?? "" })}</span> : null}
            </div>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby={`way-keys-${card.id}`} className="rounded-xl border border-line p-4">
        <h4 id={`way-keys-${card.id}`} className="font-medium">{t("providers.way.keys")}</h4>
        <p className="mt-1 text-muted">{card.signIn.facade ? t("providers.keys.hintFacade") : t("providers.keys.hint", { name: card.label })}</p>
        {keys.length === 0 ? <p className="mt-2 text-xs text-muted">{t("providers.keys.none")}</p> : (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="text-sm font-medium">{k.label}</span>
                  {k.role === "optional" ? <> <Pill>{t("providers.keys.optional")}</Pill></> : null}
                  {k.role === "legacy" ? <> <Pill>{t("providers.keys.legacy")}</Pill></> : null}
                </span>
                <span className="flex items-center gap-2">
                  {k.connected ? <Badge info={{ label: t("connections.connected"), tone: "success", icon: "check" }} /> : null}
                  {!card.signIn.facade ? <Button onClick={() => setSub({ kind: "key", id: k.id })}>{k.connected ? t("providers.keys.edit") : t("providers.keys.setUp")}</Button> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {showsLegacyHint(card) ? <div className="mt-3"><Notice tone="info">{t("providers.keys.legacyHint")}</Notice></div> : null}
      </section>
      {card.byHand.length > 0 ? (
        <section aria-labelledby={`way-hand-${card.id}`} className="rounded-xl border border-line p-4">
          <h4 id={`way-hand-${card.id}`} className="font-medium">{t("providers.way.byHand")}</h4>
          <p className="mt-1 text-muted">{t("providers.byHand.hint")}</p>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
            {card.byHand.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setSub({ kind: "hand", id: p.id })} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-page">
                  <span className="font-medium">{p.label}</span><Icon name="external" className="h-4 w-4 shrink-0 text-muted" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ProviderDetail({ p }: { p: Pick<Provider, "guide"> }) {
  const t = useT();
  return (
    <div className="text-sm">
      <a href={p.guide!.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline">{t("connections.openProvider")}<Icon name="external" className="h-3.5 w-3.5" /></a>
      {p.guide!.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">{p.guide!.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      <p className="mt-4 text-xs text-muted">{t("connections.providerHint")}</p>
    </div>
  );
}

/** noExpiry: the provider's keys do not expire, so no lifetime is asked for (RevenueCat). */
function ConnectionDetail({ c, onChanged, onDone, noExpiry = false }: { c: Connection; onChanged: () => void; onDone: () => void; noExpiry?: boolean }) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [preset, setPreset] = useState("90");
  const [custom, setCustom] = useState("");
  const [remember, setRemember] = useState(Boolean(c.canRemember));
  // Nach dem Verbinden bleibt der Dialog offen: Test, entdeckte Ressourcen und Standardwerte.
  const [connectedNow, setConnectedNow] = useState(false);
  const set = useMutation(async (body: unknown) => api<Connection>("POST", `connections/${enc(c.id)}/token`, body));
  const name = labelOf(c);
  const today = new Date().toISOString().slice(0, 10);
  const never = noExpiry || preset === "never";
  const expires = never ? "" : preset === "custom" ? custom : addDays(today, Number(preset));
  const days = never ? null : Math.max(1, Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
  const link = c.openUrl ? withExpiry(c.openUrl, days) : null;
  const mismatch = stripePrefixMismatch(c.id, value);
  const valid = Boolean(value) && !mismatch && (never || (expires !== "" && expires >= today));
  const submit = async () => {
    const v = value;
    if (!valid) return;
    setValue("");
    if (await set.run({ token: v, ...(remember ? { remember: true } : {}), ...(never ? { neverExpires: true } : { expires }) })) {
      toast.success(t(remember ? "connections.connectedVault" : "connections.connectedSession", { name }));
      onChanged();
      setConnectedNow(true);
    }
  };
  if (connectedNow) {
    return (
      <div className="space-y-4 text-sm">
        <Notice tone="success">{t("params.conn.afterConnect")}</Notice>
        <ConnectionCheckPanel id={c.id} onResult={() => undefined} />
        <ConnectionResourcesPanel id={c.id} />
        <div className="flex justify-end"><Button variant="primary" onClick={onDone}>{t("params.conn.done")}</Button></div>
      </div>
    );
  }
  return (
    <div className="text-sm">
      {c.description ? <p className="text-muted">{c.description}</p> : null}
      {noExpiry ? null : <div className="mt-4 grid gap-3 rounded-xl bg-page p-4 sm:grid-cols-2">
        <SelectField label={t("connections.step1")} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{t("connections.days", { count: d })}</option>)}
          <option value="custom">{t("connections.customDate")}</option>
          <option value="never">{t("connections.neverExpires")}</option>
        </SelectField>
        {preset === "custom" ? (
          <div className="space-y-1">
            <label htmlFor={`exp-${c.id}`} className="block text-sm font-medium">{t("connections.validUntilLabel")}</label>
            <input id={`exp-${c.id}`} type="date" min={today} value={custom} onChange={(e) => setCustom(e.target.value)} className={inputClass} />
          </div>
        ) : (
          <p className="self-end pb-2 text-sm text-muted">{never ? t("connections.noExpiryNotRecommended") : t("connections.validUntilShort", { date: formatDate(expires) })}</p>
        )}
        <p className="text-xs text-muted sm:col-span-2">{t("connections.expiryHint")}</p>
      </div>}
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 font-medium text-primary underline">
          {noExpiry ? t("connections.openKeyPage") : c.openUrl !== c.url ? t("connections.step2Prefilled") : t("connections.step2")}<Icon name="external" className="h-3.5 w-3.5" />
        </a>
      ) : null}
      {c.permissions.length > 0 ? <ul className="mt-3 flex flex-wrap gap-1.5">{c.permissions.map((r) => <li key={r} className="rounded-full bg-page px-2.5 py-0.5 text-xs text-muted">{r}</li>)}</ul> : null}
      {c.steps.length > 0 ? <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
      {!c.connected && c.hint ? <p className="mt-3 text-xs text-muted">{c.hint}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-5 space-y-2 border-t border-line pt-5">
        <label htmlFor={`tok-${c.id}`} className="block font-medium">{noExpiry ? t("connections.pasteKey") : t("connections.step3")}</label>
        <input id={`tok-${c.id}`} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} className={`${inputClass} font-mono`} />
        {mismatch ? <Notice tone="warn">{t(mismatch === "live" ? "connections.prefixLive" : "connections.prefixTest")}</Notice> : null}
        <p className="text-xs text-muted">{t("connections.memoryOnly")}</p>
        {c.canRemember ? (
          <div className="pt-1">
            <Checkbox checked={remember} onChange={setRemember}>{t("connections.remember")}</Checkbox>
            <p className="ml-8 mt-1 text-xs text-muted">{t("connections.rememberHint")}</p>
          </div>
        ) : null}
        {set.error ? <Notice tone="danger">{set.error.message}</Notice> : null}
        <Button type="submit" variant="primary" loading={set.pending} disabled={!valid}>{t("connections.connect")}</Button>
      </form>
    </div>
  );
}

function AddProviderDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const toast = useToast();
  const [f, setF] = useState({ id: "", label: "", url: "", steps: "" });
  const [localError, setLocalError] = useState<string | null>(null);
  const add = useMutation(async (body: unknown) => api<{ id: string; label: string }>("POST", "providers", body));
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const submit = async () => {
    setLocalError(null);
    if (!SLUG.test(f.id.trim())) return setLocalError(t("connections.slugError"));
    try {
      new URL(f.url.trim());
    } catch {
      return setLocalError(t("connections.urlError"));
    }
    const res = await add.run({ id: f.id.trim(), label: f.label.trim(), url: f.url.trim(), steps: f.steps.split("\n").map((s) => s.trim()).filter(Boolean) });
    if (res) {
      toast.success(t("connections.providerAdded", { label: res.label }));
      onAdded();
    }
  };
  return (
    <Dialog title={t("connections.addProviderTitle")} description={t("connections.addProviderDesc")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <TextField label={t("connections.fieldName")} required value={f.label} onChange={(e) => set("label", e.target.value)} autoComplete="off" data-autofocus />
        <TextField label={t("connections.fieldId")} hint={t("connections.fieldIdHint")} required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" />
        <TextField label={t("connections.fieldUrl")} hint={t("connections.fieldUrlHint")} required type="url" value={f.url} onChange={(e) => set("url", e.target.value)} autoComplete="off" />
        <TextAreaField label={t("connections.fieldSteps")} hint={t("connections.fieldStepsHint")} rows={5} value={f.steps} onChange={(e) => set("steps", e.target.value)} />
        {localError || add.error ? <Notice tone="danger">{localError ?? add.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("connections.cancel")}</Button>
          <Button type="submit" variant="primary" loading={add.pending} disabled={!f.label.trim() || !f.id.trim() || !f.url.trim()}>{t("connections.addProvider")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
