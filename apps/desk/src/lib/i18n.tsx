"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { messages } from "@/messages";

export type Locale = "de" | "en";
export const LOCALES: Locale[] = ["de", "en"];
export const LOCALE_NAMES: Record<Locale, string> = { de: "Deutsch", en: "English" };
const STORAGE_KEY = "sd-locale";

let current: Locale = "de";

export function getLocale(): Locale {
  return current;
}

export function isLocale(v: unknown): v is Locale {
  return v === "de" || v === "en";
}

export type Vars = Record<string, string | number>;

/**
 * Uebersetzt einen Schluessel. Fehlt er in der Sprache, gilt Deutsch, sonst der Schluessel selbst.
 * `{name}` wird ersetzt. Mit `count` waehlt `key.one` bzw. `key.other` die Pluralform, falls vorhanden.
 */
export function translate(key: string, vars?: Vars, locale: Locale = current): string {
  let k = key;
  if (vars && typeof vars["count"] === "number") {
    const form = new Intl.PluralRules(locale).select(vars["count"]);
    const plural = `${key}.${form === "one" ? "one" : "other"}`;
    if (messages[locale][plural] !== undefined || messages.de[plural] !== undefined) k = plural;
  }
  const text = messages[locale][k] ?? messages.de[k] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] !== undefined ? String(vars[name]) : m)) : text;
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Vars) => string;
}

const Ctx = createContext<I18nValue>({ locale: "de", setLocale: () => undefined, t: (k, v) => translate(k, v, "de") });

function detect(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* Speicher gesperrt */
  }
  return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("de");
  useEffect(() => {
    const l = detect();
    current = l;
    setLocaleState(l);
  }, []);
  useEffect(() => {
    current = locale;
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    current = l;
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* egal */
    }
  }, []);
  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (k, v) => translate(k, v, locale) }), [locale, setLocale]);
  /* key erzwingt beim Wechsel ein neues Rendern aller Seiten, auch wo Texte ohne Hook gebildet werden. */
  return <Ctx.Provider value={value}><div key={locale} className="contents">{children}</div></Ctx.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(Ctx);
}

/** Kurzform: const t = useT(); */
export function useT(): I18nValue["t"] {
  return useContext(Ctx).t;
}
