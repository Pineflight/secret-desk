# secret-desk architecture documentation (arc42)

*Purpose: index of the arc42 documentation of secret-desk · Audience: contributors, reviewers, operators · As of 2026-11-07 · Sources: [`../../README.md`](../../README.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../SECURITY-MODEL.md`](../SECURITY-MODEL.md), [`../../package.json`](../../package.json)*

secret-desk is a local-first portal that shows which tokens and secrets expire when, issues new values at the
providers, lets a human review and confirm each new value, and only then writes it encrypted into GitHub. Secret
values are never stored.

This documentation follows [arc42](https://arc42.org) (12 chapters) with the [Q42 quality model](https://quality.arc42.org)
in chapter 10. It is a **map** over the existing documents in [`docs/`](..) and over the code: it links instead of
repeating, and it adds only what exists nowhere else (context, decisions, quality scenarios, risks).

## Chapters

| # | Chapter | As of |
|---|---|---|
| 1 | [Introduction and goals](01-introduction-and-goals.md) | 2026-11-07 |
| 2 | [Constraints](02-constraints.md) | 2026-11-07 |
| 3 | [Context and scope](03-context-and-scope.md) | 2026-11-07 |
| 4 | [Solution strategy](04-solution-strategy.md) | 2026-11-07 |
| 5 | [Building block view](05-building-block-view.md) | 2026-11-07 |
| 6 | [Runtime view](06-runtime-view.md) | 2026-11-07 |
| 7 | [Deployment view](07-deployment-view.md) | 2026-11-07 |
| 8 | [Crosscutting concepts](08-crosscutting-concepts.md) | 2026-11-07 |
| 9 | [Architecture decisions](09-architecture-decisions.md) | 2026-11-07 |
| 10 | [Quality requirements](10-quality-requirements.md) | 2026-11-07 |
| 11 | [Risks and technical debt](11-risks-and-technical-debt.md) | 2026-11-07 |
| 12 | [Glossary](12-glossary.md) | 2026-11-07 |

## Where the detail lives

| Topic | Document |
|---|---|
| Path of a value, data, packages | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Threat model, access, limits | [SECURITY-MODEL.md](../SECURITY-MODEL.md) |
| Stage kinds | [STAGES.md](../STAGES.md) |
| Providers and how well each is verified | [PROVIDERS.md](../PROVIDERS.md), [ROADMAP.md](../ROADMAP.md) |
| Agent HTTP API and MCP tools | [AGENT-API.md](../AGENT-API.md), [openapi-agent.yaml](../openapi-agent.yaml), [AGENTS.md](../AGENTS.md) |
| Browser automation and recipes | [BROWSER-AUTOMATION.md](../BROWSER-AUTOMATION.md), [RECIPES.md](../RECIPES.md) |
| Configuration and inventory | [CONFIGURATION.md](../CONFIGURATION.md) |
| Docker and small-host deployment | [DOCKER.md](../DOCKER.md) |
| Operations | [CLI.md](../CLI.md), [TROUBLESHOOTING.md](../TROUBLESHOOTING.md), [TRIAL-RUN.md](../TRIAL-RUN.md) |
| Adding a provider | [DEVELOPING-INTEGRATIONS.md](../DEVELOPING-INTEGRATIONS.md) |

## Maintenance

Whoever changes an architecture-relevant thing (a package boundary, the path of a value, the policy for agents, a
deployment element) updates the chapter and its *As of* date in the same pull request. Chapter files are English;
German appears only in quoted UI texts.
