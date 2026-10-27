"use client";
import { useId, useMemo, useState } from "react";
import { buildSuggestions, filterSuggestions, type RepoSource } from "@/lib/repos";
import { useRepoList } from "@/lib/repo-list";
import { useT } from "@/lib/i18n";
import { inputClass } from "./ui";

const SOURCE_KEYS: Record<RepoSource, string> = { inventory: "repos.srcInventory", github: "repos.srcGithub", linked: "repos.srcLinked" };

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Sichtbare Beschriftung fehlt (zum Beispiel in einer Tabellenzeile): dann aria-label. */
  ariaLabel?: string;
  id?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

/** Eingabefeld mit Vorschlagsliste (ARIA-Combobox). Freie Eingabe bleibt immer moeglich. */
export function RepoPicker({ value, onChange, ariaLabel, id, placeholder, required, className = "" }: Props) {
  const t = useT();
  const list = useRepoList();
  const all = useMemo(() => buildSuggestions(list.data), [list.data]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const uid = useId();
  const listId = `${uid}-list`;
  const shown = useMemo(() => filterSuggestions(all, value), [all, value]);
  const expanded = open && shown.length > 0;

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : shown.length - 1);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + shown.length) % shown.length);
    } else if (e.key === "Enter" && expanded && active >= 0) {
      e.preventDefault();
      pick(shown[active]!.name);
    } else if (e.key === "Escape" && expanded) {
      // Die Liste schliesst zuerst, ein umgebender Dialog bleibt offen.
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? `${uid}-o${active}` : undefined}
        aria-label={ariaLabel}
        placeholder={placeholder}
        required={required}
        value={value}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClass} ${className}`}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={t("repos.suggestions")}
        hidden={!expanded}
        className="absolute left-0 right-0 z-50 mt-1 max-h-60 overflow-auto rounded-xl border border-line bg-card py-1 text-sm shadow-lg"
      >
        {shown.map((s, i) => (
          <li
            key={s.name}
            id={`${uid}-o${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown statt click: sonst schliesst das Blur-Ereignis die Liste vor der Auswahl.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(s.name);
            }}
            onMouseEnter={() => setActive(i)}
            className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 ${i === active ? "bg-primary-light text-primary" : ""}`}
          >
            <span className="truncate">{s.name}</span>
            <span className="shrink-0 text-[11px] text-muted">{s.sources.map((x) => t(SOURCE_KEYS[x])).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
