import type { NextConfig } from "next";

const dev = process.env.NODE_ENV === "development";
// Next.js braucht Inline-Skripte; im Entwicklungsmodus zusaetzlich eval (Fast Refresh).
const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  serverExternalPackages: ["libsodium-wrappers", "libsodium", "@secret-desk/automation", "playwright-core"],
  poweredByHeader: false,
  reactStrictMode: true,
  // Secrets and variables share one list at /entries; the old list routes keep working and carry the query string over
  // (the detail route /secrets/:id stays). Next.js appends the incoming query to the destination.
  // Old German routes (before the English naming migration) keep working; the query string is carried over.
  async redirects() {
    return [
      { source: "/einstellungen", destination: "/settings", permanent: true },
      { source: "/freigaben", destination: "/approvals", permanent: true },
      { source: "/pruefen", destination: "/reviews", permanent: true },
      { source: "/pruefen/:id", destination: "/reviews/:id", permanent: true },
      { source: "/variablen", destination: "/entries?kind=variable", permanent: true },
      { source: "/verbindungen", destination: "/connections", permanent: true },
      { source: "/vergleich", destination: "/compare", permanent: true },
      { source: "/secrets", destination: "/entries?kind=secret", permanent: true },
      { source: "/variables", destination: "/entries?kind=variable", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
