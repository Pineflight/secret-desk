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

/** Ab so vielen Optionen erscheint ein Suchfeld. */
export const SEARCH_FROM = 6;

export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(q)) : options;
}

