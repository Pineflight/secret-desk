"use client";
import { useId, useState } from "react";
import { Dialog } from "./Dialog";
import { Icon } from "./Icons";
import { Button, Notice, TextAreaField, TextField, inputClass } from "./ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { MAX_DESCRIPTION, addTags, isHttpUrl } from "@/lib/tags";
import { useToast } from "@/lib/toast";
import { translate, useT } from "@/lib/i18n";

export interface MetaValues {
  description: string;
  owner: string;
  link: string;
  tags: string[];
}

export const metaFrom = (v: { description?: string | null; owner?: string | null; link?: string | null; tags?: string[] }): MetaValues => ({
  description: v.description ?? "",
  owner: v.owner ?? "",
  link: v.link ?? "",
  tags: v.tags ?? [],
});

/** Nur befüllte Felder, für das Anlegen. */
export function metaBody(m: MetaValues): Record<string, unknown> {
  return {
    ...(m.description.trim() ? { description: m.description.trim() } : {}),
    ...(m.owner.trim() ? { owner: m.owner.trim() } : {}),
    ...(m.link.trim() ? { link: m.link.trim() } : {}),
    ...(m.tags.length ? { tags: m.tags } : {}),
  };
}

/** Für PATCH: leere Felder werden als null gesendet und entfernen den Eintrag. */
export function metaPatch(m: MetaValues): Record<string, unknown> {
  return { description: m.description.trim() || null, owner: m.owner.trim() || null, link: m.link.trim() || null, tags: m.tags.length ? m.tags : [] };
}

export function validateMeta(m: MetaValues): string | null {
  if (m.description.length > MAX_DESCRIPTION) return translate("meta.descTooLong", { max: MAX_DESCRIPTION });
  if (m.link.trim() && !isHttpUrl(m.link.trim())) return translate("meta.linkInvalid");
  return null;
}

export function TagPills({ tags, onPick, active }: { tags: string[]; onPick?: (t: string) => void; active?: string }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) =>
        onPick ? (
          <button key={t} type="button" onClick={() => onPick(t)} aria-pressed={active === t} className={`rounded-full px-2 py-px text-[11px] ring-1 ring-inset ${active === t ? "bg-primary-light text-primary ring-primary" : "bg-page text-muted-text ring-line hover:text-ink"}`}>#{t}</button>
        ) : (
          <span key={t} className="rounded-full bg-page px-2 py-px text-[11px] text-muted-text ring-1 ring-inset ring-line">#{t}</span>
        ),
      )}
    </span>
  );
}

export function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const commit = (value: string) => {
    if (!value.trim()) return true;
    const r = addTags(tags, value);
    setError(r.error);
    if (!r.error) {
      onChange(r.tags);
      setText("");
    }
    return !r.error;
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">{t("meta.tags")}</label>
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <li key={tag} className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2 py-0.5 text-xs text-primary">
              #{tag}
              <button type="button" onClick={() => onChange(tags.filter((x) => x !== tag))} aria-label={t("meta.tagRemove", { tag })} className="rounded-full hover:bg-white/60"><Icon name="x" className="h-3 w-3" /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={id}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) commit(v.slice(0, -1));
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            commit(text);
          }
        }}
        onBlur={() => commit(text)}
        placeholder={t("meta.tagPlaceholder")}
        className={inputClass}
        autoComplete="off"
      />
      {error ? <p role="alert" className="text-xs text-danger-text">{error}</p> : <p className="text-xs text-muted">{t("meta.tagHint")}</p>}
    </div>
  );
}

/** Felder fürs Beschreiben, Beschreibung zuerst und als empfohlen markiert. */
export function MetaFields({ value, onChange }: { value: MetaValues; onChange: (v: MetaValues) => void }) {
  const t = useT();
  const set = <K extends keyof MetaValues>(k: K, v: MetaValues[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-4 rounded-xl bg-primary-light/50 p-4 ring-1 ring-inset ring-primary/20">
      <div>
        <TextAreaField
          label={t("meta.description")}
          hint={<span className="flex justify-between"><span>{t("meta.descriptionHint")}</span><span className={`tabular ${value.description.length > MAX_DESCRIPTION ? "text-danger-text" : ""}`}>{value.description.length}/{MAX_DESCRIPTION}</span></span>}
          rows={3}
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label={t("meta.owner")} value={value.owner} onChange={(e) => set("owner", e.target.value)} autoComplete="off" />
        <TextField label={t("meta.link")} type="url" placeholder="https://" value={value.link} onChange={(e) => set("link", e.target.value)} autoComplete="off" />
      </div>
      <TagInput tags={value.tags} onChange={(t) => set("tags", t)} />
    </div>
  );
}

/** Dialog zum Bearbeiten der beschreibenden Angaben. `path` ist `secrets/<id>` oder `variables/<id>`. */
export function EditMetaDialog({ path, initial, notes, onClose, onSaved }: { path: string; initial: MetaValues; notes?: string | null | undefined; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [m, setM] = useState(initial);
  const [n, setN] = useState(notes ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useMutation(async (body: unknown) => api("PATCH", path, body));
  const submit = async () => {
    const err = validateMeta(m);
    setLocalError(err);
    if (err) return;
    const body = { ...metaPatch(m), ...(notes !== undefined ? { notes: n.trim() || null } : {}) };
    if (await save.run(body)) {
      toast.success(t("meta.saved"));
      onSaved();
    }
  };
  return (
    <Dialog title={t("meta.editTitle")} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <MetaFields value={m} onChange={setM} />
        {notes !== undefined ? <TextAreaField label={t("meta.notes")} rows={2} value={n} onChange={(e) => setN(e.target.value)} /> : null}
        {localError || save.error ? <Notice tone="danger">{localError ?? save.error?.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("meta.cancel")}</Button>
          <Button type="submit" variant="primary" loading={save.pending}>{t("meta.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ExternalLink({ href }: { href: string }) {
  if (!isHttpUrl(href)) return <span className="break-all">{href}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary underline">
      {href}<Icon name="external" className="h-3.5 w-3.5 shrink-0" />
    </a>
  );
}
