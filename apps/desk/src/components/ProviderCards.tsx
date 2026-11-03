"use client";
import { useId, type ReactNode } from "react";
import { Badge, Card } from "@/components/ui";
import { BRAND_ICONS } from "@/lib/brand-icons.generated";
import { brandFill, monogram } from "@/lib/brand-color";
import type { CardStatus, ProviderCard } from "@/lib/provider-cards";
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

const STATUS: Record<CardStatus, { key: string; tone: "success" | "primary" | "neutral"; icon: "check" | "plug" }> = {
  connected: { key: "providers.status.connected", tone: "success", icon: "check" },
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

/** The provider on the page: header, ways in as given by the caller. */
export function ProviderPageCard({ card, actions, children }: { card: ProviderCard; actions?: ReactNode; children?: ReactNode }) {
  const t = useT();
  const purposeOf = usePurpose();
  return (
    <Card>
      <div className="flex items-start gap-3">
        <ProviderLogo icon={card.icon} label={card.label} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-medium">{card.label}</h4>
            <CardStatusBadge status={card.status} />
          </div>
          <p className="text-xs text-muted">{purposeOf(card)}</p>
          <p className="mt-1 text-xs text-muted">{card.secrets + card.variables > 0 ? t("providers.counts", { secrets: card.secrets, variables: card.variables }) : t("providers.countsNone")}</p>
        </div>
      </div>
      {children}
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </Card>
  );
}
