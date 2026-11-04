"use client";
import { useId, type ReactNode } from "react";
import { Badge, Card } from "@/components/ui";
import { BRAND_ICONS } from "@/lib/brand-icons.generated";
import { brandFill, monogram } from "@/lib/brand-color";
import { Icon } from "@/components/Icons";
import { browserNote, managedExpiry, connectedKeyCount, type CardStatus, type ProviderCard } from "@/lib/provider-cards";
import type { AgeParts } from "@/lib/browser-ready";
import type { ExpiryLevel } from "@/lib/connection-health";
import { daysLabel, formatDate } from "@/lib/format";
import type { SignInStatus } from "@/lib/sign-in-check";
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

const EXPIRY_TEXT: Record<ExpiryLevel, string> = {
  ok: "providers.card.expiresIn",
  soon: "providers.card.expiryWarn",
  critical: "providers.card.expiryCritical",
  expired: "providers.card.expiryExpired",
};

/** The expiry sentence of a collapsed card: the key that runs out first, or why there is nothing to say. */
export function expiryLine(card: Pick<ProviderCard, "keys" | "browser">, t: (key: string, vars?: Record<string, string | number>) => string, now: Date = new Date()): { text: string; level: ExpiryLevel | null } | null {
  const managed = card.browser?.secrets ?? 0;
  if (connectedKeyCount(card) === 0 && managed === 0) return null;
  const e = managedExpiry(card);
  if (e) {
    const date = e.expires ?? new Date(now.getTime() + e.daysLeft * 86_400_000).toISOString().slice(0, 10);
    return { text: t(EXPIRY_TEXT[e.level], { date: formatDate(date), days: daysLabel(e.daysLeft) }), level: e.level };
  }
  const connected = card.keys.filter((k) => k.connected);
  return { text: t(connected.length > 0 && connected.every((k) => k.expires === null) ? "providers.card.neverExpires" : "providers.card.expiryUnknown"), level: null };
}

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

/** What a collapsed card says: counts, earliest expiry, sign-in state. Plain text lines, no controls. */
export function CardSummary({ card, signIn }: { card: ProviderCard; signIn: SignInStatus | null }) {
  const t = useT();
  const expiry = expiryLine(card, t);
  const keys = connectedKeyCount(card);
  const managed = card.browser?.secrets ?? 0;
  const note = browserNote(card);
  const bad = expiry?.level === "critical" || expiry?.level === "expired";
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
      <span>{card.secrets + card.variables > 0 ? t("providers.counts", { secrets: card.secrets, variables: card.variables }) : t("providers.countsNone")}</span>
      {managed > 0 && keys === 0 ? <span>{t("providers.card.browserSecrets", { count: managed })}</span> : <span>{keys > 0 ? t("providers.card.keysConnected", { count: keys }) : t("providers.card.noKeys")}</span>}
      {expiry ? <span className={bad ? "font-medium text-danger" : expiry.level === "soon" ? "font-medium text-warn-text" : ""}>{expiry.text}</span> : null}
      {note ? <span>{t(note.key, { when: note.age ? ageText(note.age, t) : "" })}</span> : null}
      {card.browser?.sessionHours ? <span>{t("providers.card.sessionLasts", { hours: card.browser.sessionHours })}</span> : null}
      {signIn ? <span role={signIn === "waiting" || signIn === "checking" ? "status" : undefined}>{t(SIGN_IN_TEXT[signIn])}</span> : null}
    </span>
  );
}

/**
 * The provider on the page. Collapsed it shows logo, name, purpose, status and the summary; the header is one button that opens
 * the details (the ways in, as given by the caller). The controls inside the details are never part of that button.
 */
export function ProviderPageCard({ card, open, onToggle, signIn, actions, children }: { card: ProviderCard; open: boolean; onToggle: () => void; signIn: SignInStatus | null; actions?: ReactNode; children?: ReactNode }) {
  const t = useT();
  const purposeOf = usePurpose();
  const bodyId = useId();
  return (
    <Card>
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
              <CardStatusBadge status={card.status} />
            </span>
            <span className="block text-xs text-muted">{purposeOf(card)}</span>
            <CardSummary card={card} signIn={signIn} />
          </span>
          <Icon name="chevron" className={`mt-1 h-4 w-4 shrink-0 text-muted-text transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      </h4>
      <div id={bodyId} hidden={!open}>
        {open ? (
          <>
            {children}
            {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
