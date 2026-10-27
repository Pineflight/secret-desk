import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { ToastProvider } from "@/lib/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "secret-desk",
  description: "Lokales Portal für Secrets, Variablen und Prüfungen.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <ToastProvider>
          <Suspense fallback={null}>
            <Shell>{children}</Shell>
          </Suspense>
        </ToastProvider>
      </body>
    </html>
  );
}
