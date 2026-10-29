import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

/** Liest <option>-Kinder (auch in Fragmenten und Listen) als Optionen. Texte aus {t("...")} sind Strings. */
export function optionsFromChildren(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  const walk = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const el = child as ReactElement<{ value?: string | number; children?: ReactNode }>;
      if (el.type === "option") {
        const label = Children.toArray(el.props.children).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : "")).join("");
        out.push({ value: el.props.value === undefined ? label : String(el.props.value), label });
      } else walk(el.props.children);
    });
  };
  walk(children);
  return out;
}

/** Ab so vielen Optionen ist das Suchfeld von Anfang an vorgesehen (kuerzere Listen zeigen es nur im Aufklappen). */
export const SEARCH_FROM = 6;

/**
 * Ob die aufgeklappte Liste ein Suchfeld zeigt. Ausdruecklich gesetztes `searchable` gewinnt;
 * sonst bei jeder Liste mit mehr als einer Option, damit Tippen immer sichtbar filtert.
 */
export function showSearchField(optionCount: number, searchable?: boolean): boolean {
  return searchable ?? optionCount > 1;
}

/**
 * Type-ahead: das Zeichen, das eine Taste auf dem Ausloeser als Suchanfrage liefert, sonst null.
 * Leerzeichen zaehlt nicht (es oeffnet die Liste), ebenso Tasten mit Strg/Cmd/Alt und Sondertasten.
 */
export function typeaheadChar(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  if ([...e.key].length !== 1 || e.key.trim() === "") return null;
  return e.key;
}

export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(q)) : options;
}

