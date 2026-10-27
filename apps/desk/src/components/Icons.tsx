import type { ReactNode } from "react";

const P: Record<string, ReactNode> = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.2v.1" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.1" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17v.1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" />,
  shield: <><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></>,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  plug: <><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0zM12 16v5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 118 0v3" /></>,
  wrench: <path d="M14.5 6.5a4 4 0 005 5L21 13l-8 8-3-3 8-8zM9 18l-5 3 3-5" />,
  hand: <path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1-5.5-3L4 13.5a1.5 1.5 0 012.5-1.5L8 14" />,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  sliders: <path d="M5 7h9M18 7h1M5 17h1M10 17h9M14 5v4M6 15v4" />,
  inbox: <><path d="M4 13l3-8h10l3 8v6H4z" /><path d="M4 13h5l1 2h4l1-2h5" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2M12 15h5" /></>,
  users: <><circle cx="9" cy="9" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 6a3.5 3.5 0 010 7M18 14c2 .6 3 2.5 3 6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  bell: <path d="M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20a2 2 0 004 0" />,
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  download: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14" />,
  upload: <path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 20h14" />,
  refresh: <path d="M20 11a8 8 0 00-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0014 4.5L20 15M20 20v-5h-5" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />,
  image: <><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="M5 18l5-5 4 4 2-2 3 3" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
};

export type IconKey = keyof typeof P;

export function Icon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      {P[name] ?? P.dot}
    </svg>
  );
}
