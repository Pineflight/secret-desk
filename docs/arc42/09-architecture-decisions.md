# 9. Architecture decisions

*Purpose: register of the decisions that shape the system · Audience: contributors, reviewers · As of 2026-11-07 · Sources: [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`SECURITY-MODEL.md`](../SECURITY-MODEL.md), [`BROWSER-AUTOMATION.md`](../BROWSER-AUTOMATION.md), [`STAGES.md`](../STAGES.md), [`AGENT-API.md`](../AGENT-API.md)*

The repository has no `docs/decisions/` folder yet. The decisions below were **recovered from the design documents**;
their original dates are not recorded, so the register shows the state of the documents at the *As of* date. All are
`accepted` and implemented.

**Recommendation:** record every new architecture decision as `docs/decisions/ADR-NNNN-<slug>.md` (context,
decision, consequences) and add a row here. When an existing decision changes, supersede it with a new ADR instead of
editing history.

| ID | Decision | Status | Documented in | Why it matters |
|---|---|---|---|---|
| D-01 | Secret values are never stored; held in memory for at most 15 minutes and passed on in exactly two places (provider API, encrypted GitHub) | accepted | [SECURITY-MODEL.md, Principle](../SECURITY-MODEL.md#principle) | Defines the whole security posture |
| D-02 | Two-stage issuance: prepare (create and verify, write nothing), confirm (write, re-check, revoke), discard on reject or timeout | accepted | [ARCHITECTURE.md, The path of a new value](../ARCHITECTURE.md#the-path-of-a-new-value) | Failed target keeps the old value valid |
| D-03 | Only a human can confirm; agents can never confirm, enter values, set connections or upload attachments | accepted | [SECURITY-MODEL.md, Access to the portal](../SECURITY-MODEL.md#access-to-the-portal), [AGENT-API.md](../AGENT-API.md#approvals-and-policy) | The core safety guarantee |
| D-04 | `SecretValue` wrapper: value in a private field, absent from `toString`, JSON and `util.inspect`; reports carry a 12-character SHA-256 fingerprint | accepted | [SECURITY-MODEL.md, What is protected](../SECURITY-MODEL.md#what-is-protected) | Accidental leaks fail closed |
| D-05 | Values are sealed with the target's public key (libsodium sealed box) before upload | accepted | [SECURITY-MODEL.md, What is protected](../SECURITY-MODEL.md#what-is-protected) | GitHub never receives plaintext |
| D-06 | The inventory is metadata only, lives in Git-friendly YAML, and is written by all front ends through one `InventoryStore` with lock, replay and conflict error | accepted | [ARCHITECTURE.md, Data](../ARCHITECTURE.md#data) | Safe concurrent writers |
| D-07 | Review reports and attachments live outside Git (`.secret-desk-evidence/`) | accepted | [ARCHITECTURE.md, Data](../ARCHITECTURE.md#data) | Evidence stays local |
| D-08 | Behaviour follows the stage **kind**, never the stage name; unknown stage ids are treated as `live` | accepted | [STAGES.md](../STAGES.md#kinds), [ARCHITECTURE.md, Stages](../ARCHITECTURE.md#stages) | Free stage names, strict default |
| D-09 | `core` has no UI; `runtime` bundles operations and policy; CLI, portal API and MCP server use only `runtime` | accepted | [ARCHITECTURE.md, Packages](../ARCHITECTURE.md#packages) | One policy for every front end |
| D-10 | The portal binds to `127.0.0.1` and requires a launch secret, session cookie, CSRF token, Host and Origin checks | accepted | [SECURITY-MODEL.md, Access to the portal](../SECURITY-MODEL.md#access-to-the-portal) | Local-first; no accounts |
| D-11 | Agents get their own bearer token; direct action only in `policy.agentStages` (default kind `dev`), never `live`; the rest needs an approval | accepted | [AGENT-API.md](../AGENT-API.md#approvals-and-policy), [STAGES.md](../STAGES.md#kinds) | Bounded agent power |
| D-12 | Reviews and approvals are bound to a hash of the entry; a change makes them stale and discards the new value | accepted | [AGENT-API.md](../AGENT-API.md#approvals-and-policy), [`snapshot.ts`](../../packages/core/src/snapshot.ts) | No write to a retargeted entry |
| D-13 | The vault key lives in the OS keychain (or an explicit key source); no silent plaintext fallback; a damaged vault is never overwritten | accepted | [SECURITY-MODEL.md, File permissions and platforms](../SECURITY-MODEL.md#file-permissions-and-platforms) | Key never beside the data |
| D-14 | Browser automation: visible browser, human signs in, recipes are YAML data, fail closed, browser sandbox always on | accepted | [BROWSER-AUTOMATION.md, Principles](../BROWSER-AUTOMATION.md#principles), [SECURITY-MODEL.md](../SECURITY-MODEL.md#file-permissions-and-platforms) | Providers without an API stay reachable |
| D-15 | Platform behaviour is injected (`platform`, `exec`) so Windows and Linux are testable on any system | accepted | [ARCHITECTURE.md, Platforms](../ARCHITECTURE.md#platforms) | Cross-platform with simulated tests |
| D-16 | Folder links are machine-local (`repo-links.json`), never in the inventory or team export; agents cannot set them | accepted | [ARCHITECTURE.md, Repositories and links](../ARCHITECTURE.md#repositories-and-links), [SECURITY-MODEL.md](../SECURITY-MODEL.md#folder-links) | Paths do not leak |
| D-17 | Team sync is value-free, talks to one private repository, checks `private` and push rights before writing, and needs a human to take over | accepted | [SECURITY-MODEL.md, Team sync](../SECURITY-MODEL.md#team-sync) | Sharing without values |
| D-18 | The guided sign-in is the single place a provider password is typed: human-entered, memory for one run, only on the recipe host, never stored | accepted | [SECURITY-MODEL.md, Guided sign-in](../SECURITY-MODEL.md#guided-sign-in) | Controlled exception to D-14 |
| D-19 | The GitHub write test is opt-in, per chosen target, and deletes its probe immediately | accepted | [SECURITY-MODEL.md, Write test](../SECURITY-MODEL.md#write-test) | Proves rights without side effects |
| D-20 | Companion values (for example client id beside client secret) are written only to entries the provider names, checked before anything is issued | accepted | [ARCHITECTURE.md, The path of a new value](../ARCHITECTURE.md#the-path-of-a-new-value) | No value reaches an unnamed entry |
