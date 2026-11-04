"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Checkbox, Notice, Pill, SelectField, TextAreaField, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { ConnectionCheckPanel } from "@/components/ConnectionCheck";
import { FacadeFlow } from "@/components/ProviderFacade";
import { CategorySection, ProviderTile, usePurpose } from "@/components/ProviderCards";
import { RecipeSignInFlow } from "@/components/RecipeSignIn";
import { recipeSignInSubject, type FacadeInfo } from "@/lib/facade";
import { cardMatches, detailKeys, groupByCategory, showsLegacyHint, signInPrompts, signInRecipeOf, type ProviderCard } from "@/lib/provider-cards";
import { ConnectionResourcesPanel } from "@/components/ConnectionResources";
import { daysLabel, formatDate } from "@/lib/format";
import { stripePrefixMismatch } from "@/lib/connection-health";
import { useMutation } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { labelOf, signInSentence, type Connection, type Provider } from "@/lib/connections-shared";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

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

/** The picker: all providers as tiles by category; a provider opens its ways in. */
export function IntegrationPicker({ initial, cards, conns, facades, categories, signedIn, onClose, onChanged, onNewProvider }: { initial: { vendor: string | null; key?: string; signIn?: boolean; portal?: string | null; inputs?: Record<string, string>; renewal?: boolean }; cards: ProviderCard[]; conns: Connection[]; facades: FacadeInfo[]; categories: string[]; signedIn: ReadonlySet<string>; onClose: () => void; onChanged: (vendor: string, kind: "reconnect" | "renewal" | null) => void; onNewProvider: () => void }) {
  const t = useT();
  const purposeOf = usePurpose();
  const [vendor, setVendor] = useState<string | null>(initial.vendor);
  const [sub, setSub] = useState<Sub>(initial.key ? { kind: "key", id: initial.key } : initial.signIn ? { kind: "signin", portal: initial.portal ?? null, ...(initial.inputs ? { inputs: initial.inputs } : {}) } : null);
  const [q, setQ] = useState("");
  const card = vendor ? (cards.find((c) => c.id === vendor) ?? null) : null;

  if (card) {
    return (
      <Dialog title={card.label} description={purposeOf(card)} onClose={onClose} size="xl">
        <button type="button" onClick={() => (sub ? setSub(null) : setVendor(null))} className="mb-4 inline-flex items-center gap-1 text-sm text-primary">{sub ? t("connections.back") : t("providers.back")}</button>
        <VendorDetail card={card} conns={conns} facades={facades} signedIn={signedIn} sub={sub} setSub={setSub} onChanged={() => onChanged(card.id, null)} onSignedIn={() => onChanged(card.id, initial.renewal ? "renewal" : "reconnect")} onDone={onClose} />
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

type Sub = null | { kind: "key"; id: string } | { kind: "hand"; id: string } | { kind: "signin"; portal?: string | null; inputs?: Record<string, string> };

/** A provider's ways in, each with one plain sentence. */
function VendorDetail({ card, conns, facades, signedIn, sub, setSub, onChanged, onSignedIn, onDone }: { card: ProviderCard; conns: Connection[]; facades: FacadeInfo[]; signedIn: ReadonlySet<string>; sub: Sub; setSub: (s: Sub) => void; onChanged: () => void; onSignedIn: () => void; onDone: () => void }) {
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
    return <FacadeFlow facade={facade} onChanged={onSignedIn} onDone={onDone} {...(fallback ? { fallback } : {})} {...(sub.inputs ? { initialInputs: sub.inputs } : {})} />;
  }
  const signInRecipe = signInRecipeOf(card);
  if (sub?.kind === "signin" && signInRecipe) {
    // A browser-only vendor: the same sign-in, without creating a key. The portal that needs it is preselected.
    const subject = recipeSignInSubject(signInRecipe, card.signIn.available);
    const portal = sub.portal ?? signInPrompts(card)[0]?.portal ?? null;
    return <RecipeSignInFlow subject={subject} name={card.label} portal={portal} onChanged={onSignedIn} onDone={onDone} />;
  }
  const keys = detailKeys(card);
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
          ) : signInRecipe ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={!card.signIn.available} onClick={() => setSub({ kind: "signin", portal: null })}>{t("providers.signIn.button")}</Button>
            </div>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby={`way-keys-${card.id}`} className="rounded-xl border border-line p-4">
        <h4 id={`way-keys-${card.id}`} className="font-medium">{t("providers.way.keys")}</h4>
        <p className="mt-1 text-muted">{card.signIn.facade ? t(keys.some((k) => k.action === "paste") ? "providers.keys.hintFacadeMixed" : "providers.keys.hintFacade") : t("providers.keys.hint", { name: card.label })}</p>
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
                  {k.action === "paste" ? <Button onClick={() => setSub({ kind: "key", id: k.id })}>{k.connected ? t("providers.keys.edit") : t("providers.keys.setUp")}</Button> : null}
                  {k.action === "signin" && facade ? <Button disabled={!facade.available} onClick={() => setSub({ kind: "signin" })}>{t("providers.signIn.start")}</Button> : null}
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
        <ConnectionCheckPanel id={c.id} name={name} {...(c.vendor ? { cardId: c.vendor } : {})} onResult={() => undefined} />
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

export function AddProviderDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
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
