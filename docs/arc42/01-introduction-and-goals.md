# 1. Introduction and goals

*Purpose: what secret-desk is for and which qualities matter most · Audience: everyone · As of 2026-11-07 · Sources: [`README.md`](../../README.md), [`SECURITY-MODEL.md`](../SECURITY-MODEL.md), [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`CLAUDE.md`](../../CLAUDE.md)*

## 1.1 Requirements overview

Teams that deploy through GitHub Actions end up with tokens, API keys and webhook secrets spread over many
repositories and environments. secret-desk addresses three recurring problems
([README, "Why secret-desk"](../../README.md#why-secret-desk)):

| # | Requirement | Realised by |
|---|---|---|
| R1 | Know what expires when, per stage and status (ok, soon, due, expired, missing) | inventory plus `computeStatus` in [`packages/core/src/status.ts`](../../packages/core/src/status.ts); CLI `check` ([CLI.md](../CLI.md#check)) |
| R2 | Create the new value at the provider instead of copying it by hand | provider modules in [`packages/providers`](../../packages/providers), browser recipes in [`recipes/`](../../recipes) |
| R3 | A human reviews and confirms each new value before it goes live | `prepareIssuance` / `commitIssuance` in [`packages/core/src/issuance.ts`](../../packages/core/src/issuance.ts) |
| R4 | Write the value encrypted straight into GitHub; revoke the old value afterwards | sealed-box upload in [`packages/core/src/github.ts`](../../packages/core/src/github.ts) |
| R5 | Never store a secret value anywhere | `SecretValue` ([`secret.ts`](../../packages/core/src/secret.ts)), memory-only pending issuances |
| R6 | Let AI agents help without giving them the power to confirm or to see values | agent policy in [`packages/runtime/src/agent-api.ts`](../../packages/runtime/src/agent-api.ts), [AGENT-API.md](../AGENT-API.md) |
| R7 | Keep stages, variables and `.env` files for developers in line | [STAGES.md](../STAGES.md), [COMPARE.md](../COMPARE.md), [DEV-ENV.md](../DEV-ENV.md) |

Out of scope: secret-desk is not a secret store, not a runtime secret injector and has no user accounts
([ARCHITECTURE.md](../ARCHITECTURE.md#data), [DOCKER.md](../DOCKER.md)). It sends no telemetry
([ROADMAP.md](../ROADMAP.md#external-services-secret-desk-talks-to)).

Status: early version (0.1.0). Several provider endpoints are verified only against mocks; see
[README, "Project status"](../../README.md#project-status) and chapter 11.

## 1.2 Quality goals

| Priority | Q42 property | Goal |
|---|---|---|
| 1 | #secure | A secret value is never persisted, logged, reported or returned; it exists in memory for at most 15 minutes and is passed on in exactly two places (provider API, encrypted GitHub). |
| 2 | #safe | Nothing reaches GitHub and nothing is revoked before a human has confirmed the review report; agents can never confirm. |
| 3 | #reliable | A failed write leaves the old value valid and the review open; the write is re-checked and the old value revoked only after success. |
| 4 | #flexible | New providers and new browser recipes can be added without touching the core flow. |
| 5 | #operable | Runs the same on macOS, Linux and Windows, and as a container on a small always-on host. |

Measurable scenarios for these goals are in [chapter 10](10-quality-requirements.md).

## 1.3 Stakeholders

| Role | Expectation |
|---|---|
| Human operator (team member who renews secrets) | Clear overview, an understandable review report, no surprise writes. |
| Team lead / maintainer | Value-free team configuration ([TEAM.md](../TEAM.md)), parity between stages ([COMPARE.md](../COMPARE.md)). |
| Developer | A working `.env.local` per repository from dev templates ([DEV-ENV.md](../DEV-ENV.md)). |
| AI agent (via MCP or Agent API) | Metadata and renewal requests; no values, no confirmation ([AGENTS.md](../AGENTS.md)). |
| Provider module / recipe author | A small, documented extension surface ([DEVELOPING-INTEGRATIONS.md](../DEVELOPING-INTEGRATIONS.md)). |
| Security reviewer | A threat model with stated limits ([SECURITY-MODEL.md](../SECURITY-MODEL.md), [SECURITY.md](../../SECURITY.md)). |
| Publisher | Public MIT repository without internal names; checked by [`no-internal-names.test.ts`](../../packages/runtime/test/no-internal-names.test.ts). |
