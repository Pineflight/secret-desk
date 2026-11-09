import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
import { ToastProvider } from "@/lib/toast";

/** The providers of `src/app/layout.tsx` without the Shell: i18n and toasts. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>{children}</ToastProvider>
    </I18nProvider>
  );
}

/**
 * Renders with the app providers. Language is German (setup-dom.ts stores `sd-locale=de`); a test may store `en` before rendering.
 * Returns the usual RTL result plus a ready `user` (user-event).
 */
export function renderApp(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">): RenderResult & { user: UserEvent } {
  return { user: userEvent.setup(), ...render(ui, { wrapper: Providers, ...options }) };
}
