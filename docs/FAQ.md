# FAQ

## Does secret-desk store my secrets?

No. A newly created value exists in the portal's memory for at most 15 minutes, while you review it, and is passed on in exactly two places: the provider API and, encrypted with the target's public key, GitHub. Reports and logs carry only a short fingerprint. The inventory holds metadata only. See [SECURITY-MODEL.md](SECURITY-MODEL.md).

## What *is* stored on disk?

Your inventory (metadata), review reports and attachments, folder links, the agent token, optionally the encrypted vault with your **integration tokens** (not the managed values), the browser profile for recipes, and `.env` files you export. See [CONFIGURATION.md](CONFIGURATION.md#files-secret-desk-writes).

## Is it a secret manager like Vault or 1Password?

No. GitHub's secret store stays the place where values live. secret-desk is the control desk around it: expiry overview, creation at the provider, review, confirmation, comparison across stages. It can read an access token from 1Password (`op://` references), but it does not replace a vault.

## Can I use it without GitHub?

No. GitHub (secrets, variables, environments) is the target of every write.

## Can the portal be reached from another machine?

No. It binds to `127.0.0.1` and accepts only local host names. That is a design decision.

## Why the launch URL with a secret?

Any local program could otherwise ask the portal for a session. The secret is printed only in the terminal that started it. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#launch-required-401-and-the-launch-secret).

## What can an AI agent do, and what never?

It can read metadata, maintain the inventory, query status and **request** renewals. It never sees a value, never confirms a review, never sets connections. Outside `policy.agentStages` its requests become approvals a human grants. See [AGENTS.md](AGENTS.md) and [AGENT-API.md](AGENT-API.md).

## Who confirms a new value, and why?

A human, always. The review report shows what the portal verified (function test, permissions, expiry, targets) and a checklist of what only you can judge. Only after you confirm is the value written and the old one revoked.

## Which providers are supported?

Cloudflare tokens and Turnstile secrets, Supabase API keys, Stripe webhook secrets, Resend API keys, Grafana service-account tokens, random values, plus guides for providers without an API and browser recipes. How well each endpoint is verified is stated in [PROVIDERS.md](PROVIDERS.md); several are only tested against mocks.

## A provider I use is not listed.

Add a guide-only provider to the inventory (`providers:`), then entries with `provider: <id>`: the portal shows your steps and verifies the pasted value. For an API integration, register a `Provider` in `packages/providers/src`; contributions are welcome ([CONTRIBUTING.md](../CONTRIBUTING.md)). For web-only providers, write a [recipe](RECIPES.md).

## Do variables have expiry?

No, variables are configuration (`vars.*`). They have an expected value that the portal compares with GitHub and can apply. Secret-looking values are refused.

## What is the difference between a stage and a GitHub environment?

A stage is secret-desk's notion of a place in your delivery path with a behavior (`kind`). A GitHub environment is where GitHub stores environment secrets. A stage usually maps to one environment; the mapping is in the stage definition ([STAGES.md](STAGES.md)).

## How do I add a stage like `qa`?

Settings, *Add stage*, or in the YAML: `{ id: qa, kind: test, environment: qa }`. Behavior follows `kind`.

## Why does Compare show something as missing that exists in GitHub?

Check the environment name the stage derives, the token's access to the repository, and whether the value lives at repository level instead of the environment ("level-mismatch"). See [COMPARE.md](COMPARE.md).

## Does it work on Windows and Linux?

It is built for macOS, Linux and Windows 10/11, with tests on simulated platforms and a manual cross-platform CI workflow. Real-world use so far happened on macOS. See the platform table in the [README](../README.md#platforms).

## Why is the CLI output German?

The CLI's own text (help and messages) is currently German; the portal and the documentation are available in English. Command names and options are as in [CLI.md](CLI.md).

## Is the browser automation allowed by the providers?

That is the provider's terms of use, and a decision for your team per provider. secret-desk never types credentials, never solves CAPTCHAs and uses no stealth tooling. The bundled recipes have not been verified against the live pages. See [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md).

## Is it production-ready?

It is an early version (0.1.0). The GitHub write path was exercised against the real GitHub in a throwaway repository; several provider endpoints and all browser recipes were not verified against the live services. Start with the [trial run](TRIAL-RUN.md).

## How do I report a security problem?

Privately, through GitHub's *Report a vulnerability* on the repository's Security tab. See [SECURITY.md](../SECURITY.md).
