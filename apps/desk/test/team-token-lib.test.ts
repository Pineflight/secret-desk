import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FacadeState } from "../src/lib/facade";
import { messages } from "../src/messages";
import type { ModeAccess } from "../src/lib/team-picker";
import { createLabelKey, readyTokenExpiry, teamTokenFailureText, teamTokenSteps, teamTokenView, tokenCovers, type TeamTokenInfo, type TeamTokenMeta } from "../src/lib/team-token";

const run = (p: Partial<FacadeState> = {}): FacadeState => ({ secretId: "team-token", providerId: "github-fine-grained-token", status: "idle", text: "", startedAt: "", updatedAt: "", ...p });
const meta = (p: Partial<TeamTokenMeta> = {}): TeamTokenMeta => ({ repo: "acme-org/team-config", mode: "pull", strategy: "pull-request", tokenName: "secret-desk-t~team-config-20261103-1007", createdAt: "2026-11-03T10:07:00Z", expires: "2027-02-01", valid: true, ...p });
const info = (p: Partial<TeamTokenInfo> = {}): TeamTokenInfo => ({
  available: true,
  reason: null,
  viewerUrl: "/browser/vnc.html",
  timeoutMinutes: 10,
  active: null,
  pendingRevocation: null,
  tokensUrl: "https://github.com/settings/personal-access-tokens",
  days: 90,
  rights: { pull: ["Contents: Read", "Metadata: Read"], "pull-push": ["Contents: Read and write", "Pull requests: Read and write", "Metadata: Read"] },
  run: run(),
  ...p,
});
const access = (source: ModeAccess["source"]): ModeAccess => ({ source, problem: null, mode: "pull", strategy: "pull-request", neededRights: [], checks: [], ok: true });

describe("team token view", () => {
  it("button state: loading, idle, running, waiting for confirmation, success, failed, automation off", () => {
    expect(teamTokenView(undefined)).toBe("loading");
    expect(teamTokenView(info())).toBe("idle");
    expect(teamTokenView(info({ run: run({ status: "running" }) }))).toBe("running");
    expect(teamTokenView(info({ run: run({ status: "waiting-human", phase: "confirm" }) }))).toBe("waiting");
    expect(teamTokenView(info({ run: run({ status: "done" }) }))).toBe("done");
    expect(teamTokenView(info({ run: run({ status: "failed" }) }))).toBe("failed");
    expect(teamTokenView(info({ run: run({ status: "cancelled" }) }))).toBe("failed");
    expect(teamTokenView(info({ available: false, reason: "automation-off" }))).toBe("unavailable");
  });

  it("the label offers a new token once one exists", () => {
    expect(createLabelKey(info())).toBe("teamToken.create");
    expect(createLabelKey(info({ active: meta() }))).toBe("teamToken.createNew");
    expect(messages.en["teamToken.create"]).toBe("Create team token");
    expect(messages.de["teamToken.create"]).toBe("Team-Token erstellen");
  });
});

describe("team token timeline", () => {
  const tl = (...x: [string, "active" | "done" | "failed"][]) => x.map(([phase, state]) => ({ phase, state, at: "" }));

  it("running: fixed phases, optional ones only when GitHub asked", () => {
    const steps = teamTokenSteps(run({ status: "running", timeline: tl(["opening", "done"], ["creating", "active"]) }));
    expect(steps.map((s) => s.phase)).toEqual(["opening", "creating", "testing", "ready"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "active", "pending", "pending"]);
  });

  it("waiting for the confirmation shows the confirm step as waiting", () => {
    const steps = teamTokenSteps(run({ status: "waiting-human", timeline: tl(["opening", "done"], ["confirm", "active"]) }));
    expect(steps.map((s) => `${s.phase}:${s.state}`)).toEqual(["opening:done", "confirm:waiting", "creating:pending", "testing:pending", "ready:pending"]);
  });

  it("success ends with every step done, failure leaves the active step failed", () => {
    expect(teamTokenSteps(run({ status: "done", timeline: tl(["opening", "done"], ["creating", "done"], ["testing", "done"], ["ready", "active"]) })).every((s) => s.state === "done")).toBe(true);
    const failed = teamTokenSteps(run({ status: "failed", timeline: tl(["opening", "done"], ["creating", "done"], ["testing", "active"]) }));
    expect(failed.find((s) => s.phase === "testing")?.state).toBe("failed");
  });

  it("every phase has a catalog text in both languages", () => {
    for (const p of ["opening", "signin", "confirm", "creating", "testing", "ready"]) {
      expect(messages.en[`teamToken.step.${p}`], p).toBeTruthy();
      expect(messages.de[`teamToken.step.${p}`], p).toBeTruthy();
    }
  });
});

describe("ready line and coverage", () => {
  it("ready with the team token shows its expiry; the integration shows none", () => {
    expect(readyTokenExpiry(access("own"), info({ active: meta() }), "acme-org/team-config")).toBe("2027-02-01");
    expect(readyTokenExpiry(access("github-pat"), info({ active: meta() }), "acme-org/team-config")).toBeNull();
    expect(readyTokenExpiry(access("own"), info({ active: meta({ valid: false }) }), "acme-org/team-config")).toBeNull();
    expect(readyTokenExpiry(access("own"), info({ active: meta() }), "acme-org/other")).toBeNull();
    expect(readyTokenExpiry(access("own"), undefined, "acme-org/team-config")).toBeNull();
  });

  it("a token for another repository or fewer rights does not cover the selection", () => {
    expect(tokenCovers(meta(), "acme-org/team-config", "pull", "pull-request")).toBe(true);
    expect(tokenCovers(meta(), "acme-org/other", "pull", "pull-request")).toBe(false);
    expect(tokenCovers(meta(), "acme-org/team-config", "pull-push", "pull-request")).toBe(false);
    expect(tokenCovers(meta({ mode: "pull-push" }), "acme-org/team-config", "pull-push", "pull-request")).toBe(true);
    expect(tokenCovers(meta({ mode: "pull-push", strategy: "direct" }), "acme-org/team-config", "pull-push", "pull-request")).toBe(false);
    expect(tokenCovers(meta({ valid: false }), "acme-org/team-config", "pull", "pull-request")).toBe(false);
    expect(tokenCovers(null, "acme-org/team-config", "pull", "pull-request")).toBe(false);
  });
});

describe("failure text", () => {
  const t = (key: string): string => (messages.de as Record<string, string>)[key] ?? key;
  it("English shows the server text, German the catalog text with detail for test and store", () => {
    const f = { code: "test", message: "x", messageEn: "The new token cannot push." };
    expect(teamTokenFailureText(f, "en", t)).toBe("The new token cannot push.");
    expect(teamTokenFailureText(f, "de", t)).toContain("The new token cannot push.");
    expect(teamTokenFailureText({ code: "cancelled", message: "x", messageEn: "Cancelled." }, "de", t)).toBe("Abgebrochen.");
    expect(teamTokenFailureText({ code: "unknown-code", message: "Fallback", messageEn: "Fallback" }, "de", t)).toBe("Fallback");
  });
});

describe("catalog", () => {
  it("every teamToken key used by the control exists in German and English", () => {
    const files = ["components/TeamTokenControl.tsx", "components/TeamConfigPicker.tsx", "lib/team-token.ts"];
    const missing: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(__dirname, "../src", f), "utf8");
      for (const m of text.matchAll(/["`(]((?:teamToken|facade)\.[\w.]+)["`]/g)) {
        const key = m[1]!;
        if (key.endsWith(".")) continue;
        if (!(key in messages.de) || !(key in messages.en)) missing.push(`${f}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
    const de = Object.keys(messages.de).filter((k) => k.startsWith("teamToken."));
    const en = Object.keys(messages.en).filter((k) => k.startsWith("teamToken."));
    expect(de.sort()).toEqual(en.sort());
  });
});

describe("team token steps with the delete step", () => {
  it("shows the revoking step only when the timeline has it", () => {
    const plain = teamTokenSteps(run({ status: "running", timeline: [{ phase: "opening", state: "active", at: "" }] })).map((s) => s.phase);
    expect(plain).not.toContain("revoking");
    const replaced = teamTokenSteps(run({ status: "running", timeline: [{ phase: "revoking", state: "active", at: "" }] }));
    expect(replaced.map((s) => s.phase)).toEqual(["opening", "creating", "testing", "revoking", "ready"]);
  });
  it("has catalog texts for every new key in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const m = messages[lang] as Record<string, string>;
      for (const k of ["teamToken.step.revoking", "run.access.method.mobile", "run.access.problem.timeout", "run.access.mobileNumber", "run.signInTitle", "teamToken.pending.reason"]) expect(m[k], `${lang} ${k}`).toBeTruthy();
    }
  });
});
