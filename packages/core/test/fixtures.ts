export const INVENTORY_YAML = `# Kommentar bleibt erhalten
version: 1
thresholds: [30, 14, 7]
secrets:
  - id: cf-deploy-acme-app
    name: CLOUDFLARE_API_TOKEN
    product: acme-app
    stage: shared
    service: cloudflare
    provider: cloudflare-token
    ttlDays: 90
    expiry: possible
    expires: "2027-01-21"
    externalId: old-token-id
    places:
      - { repo: acme-app, scope: repository }
      - { repo: acme-app-landing, scope: repository }
  - id: stripe-webhook-acme-docs-staging
    name: STRIPE_WEBHOOK_SECRET
    stage: staging
    service: stripe
    provider: manual
    expiry: none
    places:
      - { repo: acme-docs, scope: environment, environment: staging }
  - id: lead-token-dev
    name: LEAD_INTAKE_TOKEN
    stage: dev
    service: intern
    provider: random-hex
    expiry: none
envTemplates:
  - id: acme-web-dev
    repo: acme-web
    stage: dev
    entries:
      - { key: NEXT_PUBLIC_SITE_URL, from: { type: default, value: "http://localhost:3000" } }
      - { key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }
      - { key: STRIPE_SECRET_KEY, from: { type: prompt, hint: Sandbox-Key } }
`;
