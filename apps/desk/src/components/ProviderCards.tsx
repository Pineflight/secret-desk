"use client";
import { useId, type ReactNode } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { clockTime, type ActivityResult } from "@/lib/card-activity";
import type { BadgeKind, CollapsedMeta } from "@/lib/card-collapsed";
import { daysLabel, formatDate } from "@/lib/format";
import { BRAND_ICONS } from "@/lib/brand-icons";
import { brandFill, monogram } from "@/lib/brand-color";
import { Icon } from "@/components/Icons";
import { browserNote, capitalized, expiryLine, hostLineNote, hostLinePhaseKey, managedExpiry, connectedKeyCount, type CardStatus, type ProviderCard, type SignInPrompt } from "@/lib/provider-cards";
import type { AgeParts } from "@/lib/browser-ready";
import type { CheckPhase } from "@/lib/check-queue";
import { checkIdOf as checkKey, type SignInStatus } from "@/lib/sign-in-check";
import { useT } from "@/lib/i18n";

/** The provider's logo from the bundled icon set, or a neutral monogram. Decorative: the name is always next to it. */
export function ProviderLogo({ icon, label, size = 40 }: { icon: string | null; label: string; size?: number }) {
  const brand = icon ? BRAND_ICONS[icon] : undefined;
  const box = { width: size, height: size };
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-xl bg-page text-ink ring-1 ring-inset ring-line" style={box} aria-hidden="true">
      {brand ? (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill={brandFill(brand.hex)} focusable="false">
          <path d={brand.path} />
        </svg>
      ) : (
        <span className="text-xs font-semibold tracking-tight text-muted-text" style={{ fontSize: size * 0.3 }}>{monogram(label)}</span>
      )}
    </span>
  );
}

const STATUS: Record<CardStatus, { key: string; tone: "success" | "primary" | "neutral" | "warn"; icon: "check" | "plug" | "alert" }> = {
  connected: { key: "providers.status.connected", tone: "success", icon: "check" },
  ready: { key: "providers.status.ready", tone: "success", icon: "check" },
  signout: { key: "providers.status.signout", tone: "warn", icon: "alert" },
  unknown: { key: "providers.status.unknown", tone: "neutral", icon: "plug" },
  signin: { key: "providers.status.signin", tone: "primary", icon: "plug" },
  none: { key: "providers.status.none", tone: "neutral", icon: "plug" },
};

export function CardStatusBadge({ status }: { status: CardStatus }) {
  const t = useT();
  const s = STATUS[status];
  return <Badge info={{ label: t(s.key), tone: s.tone, icon: s.icon }} />;
}

const COLLAPSED_BADGE: Record<BadgeKind, { key: string; tone: "success" | "primary" | "neutral" | "warn" | "danger"; icon: "check" | "plug" | "alert" | "clock" | "x" }> = {
  connected: { key: "providers.status.connected", tone: "success", icon: "check" },
  ready: { key: "providers.status.ready", tone: "success", icon: "check" },
  "signin-needed": { key: "providers.status.signout", tone: "warn", icon: "alert" },
  none: { key: "providers.status.none", tone: "neutral", icon: "plug" },
  expiring: { key: "providers.status.expiring", tone: "warn", icon: "clock" },
  expired: { key: "providers.status.expired", tone: "danger", icon: "x" },
};

/** The one badge of a collapsed card. */
export function CollapsedBadge({ kind }: { kind: BadgeKind }) {
  const t = useT();
  const b = COLLAPSED_BADGE[kind];
  return <Badge info={{ label: t(b.key), tone: b.tone, icon: b.icon }} />;
}

/** A small spinner for a check that is running. The words are for screen readers; the card shows only the movement. */
export function BusySpinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** ✓ or ✗ with the time the last check ended. */
export function ResultMark({ result, label }: { result: ActivityResult; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${result.ok ? "text-success-text" : "text-danger-text"}`} title={label}>
      <Icon name={result.ok ? "check" : "x"} className="h-3.5 w-3.5" />
      <span className="tabular" aria-label={label}>{clockTime(result.at)}</span>
    </span>
  );
}

/** The text that says what a provider is for. Providers added by hand have no catalog text. */
export function usePurpose(): (card: Pick<ProviderCard, "id" | "custom">) => string {
  const t = useT();
  return (card) => (card.custom ? t("providers.custom.purpose") : t(`vendor.${card.id}.purpose`));
}

/** A tile in the picker: logo, name, one-line purpose, status. One button, reachable and operable by keyboard. */
export function ProviderTile({ card, onOpen }: { card: ProviderCard; onOpen: () => void }) {
  const t = useT();
  const purposeOf = usePurpose();
  const describedBy = useId();
  const categoryLabel = t(`category.${card.category}`);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("providers.tileLabel", { name: card.label, category: categoryLabel, status: t(STATUS[card.status].key) })}
      aria-describedby={describedBy}
      className="flex h-full w-full items-start gap-3 rounded-xl border border-line bg-card p-3 text-left hover:border-primary hover:bg-page"
    >
      <ProviderLogo icon={card.icon} label={card.label} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium">{card.label}</span>
          <CardStatusBadge status={card.status} />
        </span>
        <span id={describedBy} className="mt-0.5 block text-xs text-muted">{purposeOf(card)}</span>
      </span>
    </button>
  );
}

/** A category section: heading plus its tiles or cards. */
export function CategorySection({ category, children, grid = "tiles", level = "h3" }: { category: string; children: ReactNode; grid?: "tiles" | "cards"; level?: "h2" | "h3" }) {
  const t = useT();
  const id = useId();
  const Heading = level;
  return (
    <section aria-labelledby={id} className="mt-6 first:mt-0">
      <Heading id={id} className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t(`category.${category}`)}</Heading>
      <ul className={`grid gap-3 ${grid === "tiles" ? "sm:grid-cols-2 lg:grid-cols-3" : "md:grid-cols-2"}`}>{children}</ul>
    </section>
  );
}

const SIGN_IN_TEXT: Record<SignInStatus, string> = {
  waiting: "providers.card.signInWaiting",
  checking: "providers.card.signInChecking",
  yes: "providers.card.signedIn",
  no: "providers.card.signedOut",
  failed: "providers.card.signInFailed",
  unchecked: "providers.card.signInUnchecked",
};

const TIME_TEXT: Record<AgeParts["unit"], string> = {
  now: "providers.time.now",
  minutes: "providers.time.minutes",
  hours: "providers.time.hours",
  days: "providers.time.days",
};

/** "3 hours ago" in the interface language. */
export function ageText(age: AgeParts, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return age.unit === "now" ? t(TIME_TEXT.now) : t(TIME_TEXT[age.unit], { count: age.count });
}

/**
 * What an expanded card says about the provider: counts, expiry, how the keys arrive, the sign-in state and one line per portal.
 * A check that runs shows a spinner on its line; a finished one shows ✓ or ✗ with the time.
 */
export function CardDetails({ card, signIn, hostPhases, results }: { card: ProviderCard; signIn: SignInStatus | null; hostPhases?: ReadonlyMap<string, CheckPhase>; results?: (line: string) => ActivityResult | undefined }) {
  const t = useT();
  const expiry = expiryLine(card, t);
  const keys = connectedKeyCount(card);
  const managed = card.browser?.secrets ?? 0;
  const note = browserNote(card);
  // Several portals (live and test): one sign-in line each instead of one note for the provider.
  const lines = card.status === "connected" ? [] : (card.browser?.hostLines ?? []);
  const bad = expiry?.level === "critical" || expiry?.level === "expired";
  const resultLabel = (r: ActivityResult): string => t(r.ok ? "activity.lastOk" : "activity.lastFail", { time: clockTime(r.at) });
  return (
    <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span>{card.secrets + card.variables > 0 ? t("providers.counts", { secrets: card.secrets, variables: card.variables }) : t("providers.countsNone")}</span>
      {managed > 0 && keys === 0 ? <span>{t("providers.card.browserSecrets", { count: managed })}</span> : <span>{keys > 0 ? t("providers.card.keysConnected", { count: keys }) : t("providers.card.noKeys")}</span>}
      {expiry ? <span className={bad ? "font-medium text-danger" : expiry.level === "soon" ? "font-medium text-warn-text" : ""}>{expiry.text}</span> : null}
      {lines.length > 0 ? lines.map((l) => {
        // A queued or running check is a status of this portal: a spinner, not a sentence.
        const pending = hostLinePhaseKey(hostPhases?.get(checkKey(card.id, l.host)));
        const last = results?.(l.host);
        if (pending) return <span key={l.host} className="inline-flex items-center gap-1.5"><BusySpinner label={t(pending, { portal: capitalized(l.value) })} /><span aria-hidden="true">{capitalized(l.value)}</span></span>;
        const n = hostLineNote(l);
        return (
          <span key={l.host} className="inline-flex items-center gap-1.5">
            {t(n.key, { name: card.label, portal: l.value, when: n.age ? ageText(n.age, t) : "" })}
            {last ? <ResultMark result={last} label={resultLabel(last)} /> : null}
          </span>
        );
      }) : note ? <span>{t(note.key, { when: note.age ? ageText(note.age, t) : "" })}</span> : null}
      {card.browser?.sessionHours ? <span>{t("providers.card.sessionLasts", { hours: card.browser.sessionHours })}</span> : null}
      {signIn && signIn !== "unchecked" ? (
        signIn === "waiting" || signIn === "checking" ? <BusySpinner label={t(SIGN_IN_TEXT[signIn])} /> : <span>{t(SIGN_IN_TEXT[signIn])}</span>
      ) : null}
    </span>
  );
}

/** What a collapsed card needs from its page; computed by `lib/card-collapsed`. */
export interface CollapsedView {
  badge: BadgeKind;
  meta: CollapsedMeta | null;
}

/**
 * The provider on the page. Collapsed it is logo, name, one short purpose line, one badge and at most one meta line; the header is
 * one button that opens the details. The controls inside the details are never part of that button.
 */
export function ProviderPageCard({ card, view, open, onToggle, signIn, hostPhases, signInPrompts = [], onSignIn, setUp, busy = false, last, results, actions, children }: { card: ProviderCard; view: CollapsedView; open: boolean; onToggle: () => void; signIn: SignInStatus | null; hostPhases?: ReadonlyMap<string, CheckPhase>; signInPrompts?: readonly SignInPrompt[]; onSignIn?: (portal: string | null) => void; setUp?: () => void; busy?: boolean; last?: ActivityResult | undefined; results?: (line: string) => ActivityResult | undefined; actions?: ReactNode; children?: ReactNode }) {
  const t = useT();
  const purposeOf = usePurpose();
  const bodyId = useId();
  const metaText = view.meta ? t(view.meta.key, { ...view.meta.vars, ...(view.meta.date ? { date: formatDate(view.meta.date) } : {}), ...(view.meta.days !== undefined ? { days: daysLabel(view.meta.days) } : {}) }) : "";
  return (
    <Card className="flex h-full w-full min-w-0 flex-col break-words">
      <h4>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={t(open ? "providers.card.hide" : "providers.card.show", { name: card.label })}
          className="flex w-full items-start gap-3 rounded-xl text-left"
        >
          <ProviderLogo icon={card.icon} label={card.label} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{card.label}</span>
              <span className="inline-flex items-center gap-2">
                {busy ? <BusySpinner label={t("activity.running", { name: card.label })} /> : last ? <ResultMark result={last} label={t(last.ok ? "activity.lastOk" : "activity.lastFail", { time: clockTime(last.at) })} /> : null}
                <CollapsedBadge kind={view.badge} />
              </span>
            </span>
            <span className="block text-xs text-muted">{purposeOf(card)}</span>
            {metaText ? <span className={`mt-1 block text-xs ${view.meta?.problem ? "font-medium text-warn-text" : "text-muted"}`}>{metaText}</span> : null}
          </span>
          <Icon name="chevron" className={`mt-1 h-4 w-4 shrink-0 text-muted-text transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      </h4>
      {/* Beside the header, not in it: a button inside the header button would be invalid. */}
      {(onSignIn && signInPrompts.length > 0) || (setUp && view.badge === "none") ? (
        <div className="mt-2 flex flex-wrap gap-2 pl-[3.25rem]">
          {setUp && view.badge === "none" ? <Button variant="primary" onClick={setUp} aria-label={t("providers.setUpLabel", { name: card.label })}>{t("providers.setUp")}</Button> : null}
          {onSignIn ? signInPrompts.map((p) => (
            <Button key={p.portal ?? "all"} onClick={() => onSignIn(p.portal)} aria-label={p.portal ? t("providers.signIn.buttonLabelAt", { name: card.label, portal: p.portal }) : t("providers.signIn.buttonLabel", { name: card.label })}>
              {p.portal ? t("providers.signIn.buttonAt", { portal: p.portal }) : t("providers.signIn.button")}
            </Button>
          )) : null}
        </div>
      ) : null}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <>
            <CardDetails card={card} signIn={signIn} {...(hostPhases ? { hostPhases } : {})} {...(results ? { results } : {})} />
            {children}
            {actions ? <div className="mt-4 flex min-w-0 flex-wrap gap-2">{actions}</div> : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
