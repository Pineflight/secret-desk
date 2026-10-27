export const INVENTORY_YAML = `# Kommentar bleibt erhalten
version: 1
thresholds: [30, 14, 7]
secrets:
  - id: cf-deploy-wakemiles
    name: CLOUDFLARE_API_TOKEN
    product: wakemiles
    stage: shared
    service: cloudflare
    provider: cloudflare-token
    ttlDays: 90
    expiry: possible
    expires: "2027-01-21"
    externalId: old-token-id
    places:
      - { repo: wake-miles, scope: repository }
      - { repo: wake-miles-landingpage, scope: repository }
  - id: stripe-webhook-leitfaden-staging
    name: STRIPE_WEBHOOK_SECRET
    stage: staging
    service: stripe
    provider: manual
    expiry: none
    places:
      - { repo: leitfaden, scope: environment, environment: staging }
  - id: lead-token-dev
    name: LEAD_INTAKE_TOKEN
    stage: dev
    service: intern
    provider: random-hex
    expiry: none
envTemplates:
  - id: web-studio-dev
    repo: web-studio
    stage: dev
    entries:
      - { key: NEXT_PUBLIC_SITE_URL, from: { type: default, value: "http://localhost:3000" } }
      - { key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }
      - { key: STRIPE_SECRET_KEY, from: { type: prompt, hint: Sandbox-Key } }
`;
