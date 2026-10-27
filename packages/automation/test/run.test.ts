import { describe, expect, it } from "vitest";
import { FakeDriver, RecipeRunError, dryRunRecipe, runRecipe, type HumanWait } from "../src/index.js";
import { FORM_VISIBLE, TOKEN, VARS, sampleRecipe } from "./helpers.js";

const TOKENS_URL = "https://example.test/tokens/new";

/** Fake, bei dem der Klick auf Create das Token-Feld zeigt. */
function formDriver(extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}): FakeDriver {
  return new FakeDriver({
    url: "about:blank",
    visible: FORM_VISIBLE,
    on: (e, d) => {
      if (e.action === "click" && e.key === 'button "Create"') {
        d.visible.add("css #tok");
        d.texts.set("css #tok", TOKEN);
      }
    },
    ...extra,
  });
}

describe("runRecipe", () => {
  it("liefert Wert, Kennung, Ablauf, Belege und createdName", async () => {
    const d = formDriver();
    const progress: string[] = [];
    const r = await runRecipe(sampleRecipe(), VARS, d, { onProgress: (p) => progress.push(p.label) });
    expect(r.value.reveal()).toBe(TOKEN);
    expect(r.externalId).toBe("demo-20261027");
    expect(r.expiresAt).toBe("2026-11-26");
    expect(r.createdName).toBe("demo-20261027");
    expect(r.screenshots.map((s) => s.name)).toEqual(["vorher", "nach-erzeugen"]);
    expect(d.opened && d.closed).toBe(true);
    expect(d.calls).toContain("goto https://example.test/tokens/new?name=demo-20261027&owner=acme");
    expect(d.calls.filter((c) => c.startsWith('fill Platzhalter'))).toHaveLength(2); // je Repo
    expect(progress.length).toBeGreaterThan(3);
  });

  it("Wert steht nirgends ausser im value-Feld", async () => {
    const d = formDriver();
    const hooks: unknown[] = [];
    const r = await runRecipe(sampleRecipe(), VARS, d, { onProgress: (p) => hooks.push(p) });
    expect(JSON.stringify({ ...r, value: undefined })).not.toContain(TOKEN);
    expect(JSON.stringify(hooks)).not.toContain(TOKEN);
    expect(String(r.value)).toBe("[SecretValue]");
    for (const s of r.screenshots) expect(s.png.toString()).not.toContain(TOKEN);
    expect(d.calls.join("\n")).not.toContain(TOKEN);
  });

  it("verdeckt den Token in allen Screenshots", async () => {
    const d = formDriver();
    await runRecipe(sampleRecipe(), VARS, d);
    expect(d.shots.length).toBe(2);
    for (const s of d.shots) expect(s.masks).toContain("css #tok");
  });

  it("wartet auf die Anmeldung und macht danach weiter", async () => {
    const waits: HumanWait[] = [];
    let gotos = 0;
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "goto") {
          gotos++;
          dd.url = gotos === 1 ? "https://example.test/login?token=geheim" : TOKENS_URL;
        }
        if (e.action === "click") {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", TOKEN);
        }
      },
    });
    setTimeout(() => (d.url = "https://example.test/tokens"), 40);
    const r = await runRecipe(sampleRecipe(), VARS, d, { onWaitingForHuman: (w) => void waits.push(w) }, { pollMs: 5 });
    expect(r.value.reveal()).toBe(TOKEN);
    expect(waits).toEqual([{ reason: "Bitte anmelden", url: "https://example.test/login" }]);
    expect(gotos).toBe(2); // Zielseite nach der Anmeldung erneut geladen
  });

  it("bricht nach dem Zeitlimit der Anmeldung ab", async () => {
    const d = formDriver({ on: (_e, dd) => void (dd.url = "https://example.test/login") });
    const err = await runRecipe(sampleRecipe(), VARS, d, {}, { loginTimeoutMinutes: 0.0005, pollMs: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).kind).toBe("timeout");
    expect((err as RecipeRunError).createdName).toBeUndefined();
    expect(d.closed).toBe(true);
  });

  it("respektiert das Abbruchsignal beim Warten", async () => {
    const d = formDriver({ on: (_e, dd) => void (dd.url = "https://example.test/login") });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const err = await runRecipe(sampleRecipe(), VARS, d, {}, { signal: ac.signal, pollMs: 5 }).catch((e: unknown) => e);
    expect((err as RecipeRunError).kind).toBe("abort");
  });

  it("nennt nach createsToken den angelegten Namen im Fehler", async () => {
    const d = new FakeDriver({ visible: FORM_VISIBLE, on: (e, dd) => void (e.action === "goto" && (dd.url = TOKENS_URL)) });
    // Klick klappt, aber das Token-Feld erscheint nie
    const err = (await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.createdName).toBe("demo-20261027");
    expect(err.message).toContain("demo-20261027");
  });

  it("zeigt bei falschem Format nie den gelesenen Wert", async () => {
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "click") {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", "falschesGeheimnis123");
        }
      },
    });
    const err = (await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.message).not.toContain("falschesGeheimnis123");
    expect(err.createdName).toBe("demo-20261027");
  });

  it("Fehler vor createsToken hat keinen createdName", async () => {
    const d = new FakeDriver({ visible: [], on: (e, dd) => void (e.action === "goto" && (dd.url = TOKENS_URL)) });
    const err = (await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("step");
    expect(err.createdName).toBeUndefined();
    expect(err.message).toContain('fill Feld "Name"');
  });

  it("bricht ab, wenn die Seite den erlaubten Host verlaesst", async () => {
    const d = formDriver({ on: (e, dd) => void (e.action === "goto" && (dd.url = "https://evil.test/x")) });
    const err = (await runRecipe(sampleRecipe({ login: undefined }), VARS, d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("host");
    expect(d.filled.size).toBe(0);
  });
});

describe("dryRunRecipe", () => {
  it("endet vor dem Erzeugen", async () => {
    const d = formDriver({ on: (e, dd) => void (e.action === "goto" && (dd.url = TOKENS_URL)) });
    const r = await dryRunRecipe(sampleRecipe(), VARS, d);
    expect(r.screenshots.map((s) => s.name)).toEqual(["vorher"]);
    expect(d.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(d.closed).toBe(true);
  });
});

describe("capture auf fremdem Host", () => {
  it("liest den Token nicht, wenn der Browser nach dem Klick auf einer fremden Seite steht", async () => {
    let reads = 0;
    const d = formDriver({
      on: (e, dd) => {
        if (e.action === "click" && e.key === 'button "Create"') {
          dd.visible.add("css #tok");
          dd.texts.set("css #tok", TOKEN);
          dd.url = "https://evil.test/phish";
        }
      },
    });
    const orig = d.readText.bind(d);
    d.readText = async (sel) => {
      reads++;
      return orig(sel);
    };
    const err = await runRecipe(sampleRecipe(), VARS, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeRunError);
    expect((err as RecipeRunError).kind).toBe("host");
    expect(reads).toBe(0);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });
});
