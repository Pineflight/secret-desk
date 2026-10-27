import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { I18nProvider } from "@/lib/i18n";
import { ToastProvider } from "@/lib/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "secret-desk",
  description: "Local portal for secrets, variables and reviews. Lokales Portal für Secrets, Variablen und Prüfungen.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <I18nProvider>
          <ToastProvider>
            <Suspense fallback={null}>
              <Shell>{children}</Shell>
            </Suspense>
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
