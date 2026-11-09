import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, dryRunRecipe, loadRecipes, loadRecipesDetailed, loginMethodsOf, textPattern } from "../src/index.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");

describe("bundled recipes", () => {
  it("load and are valid", async () => {
    const recipes = await loadRecipes([RECIPES]);
    expect(recipes.map((r) => r.id).sort()).toEqual(["anthropic-admin-key", "anthropic-api-key", "github-fine-grained-token", "grafana-cloud-access-policy", "openai-admin-key", "openai-api-key", "peecho-api-keys", "revenuecat-secret-api-key", "stripe-restricted-key", "supabase-access-token", "vesselapi-api-key"]);
  });
  it("openai-admin-key has a guided sign-in, captures only an admin key and says it is unverified", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "openai-admin-key")!;
    expect(r.host).toBe("platform.openai.com");
    expect(r.login?.form?.start).toBe("https://platform.openai.com/login");
    expect(r.login?.form?.home).toBe("https://platform.openai.com/");
    expect(r.capture.token.pattern).toBe("^(sk-admin-[A-Za-z0-9_-]+)$");
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
    expect(r.steps.find((s) => "click" in s && s.click.createsToken)).toMatchObject({ click: { role: "button", name: "Create admin key", exact: true } });
    expect(r.steps.find((s) => "fill" in s)).toMatchObject({ fill: { placeholder: "My Test Key", value: "{{name}}" } });
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google", "apple", "microsoft"]);
    expect(new RegExp(r.capture.token.pattern!).test("sk-proj-abc")).toBe(false);
    expect((await readFile(join(RECIPES, "openai-admin-key.yaml"), "utf8")).split("\n")[0]).toMatch(/^# STATUS: key creation verified live on 2026-11-03/);
  });
  it("grafana-cloud-access-policy signs in at grafana.com (email, Google, GitHub, Microsoft), asks only for what the portal needs and says it is unverified", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "grafana-cloud-access-policy")!;
    expect(r.host).toBe("grafana.com");
    expect(r.login?.form).toMatchObject({ start: "https://grafana.com/auth/sign-in" });
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google", "github", "microsoft"]);
    expect(r.params).toMatchObject([{ key: "expiry", default: "90 days", options: ["30 days", "90 days", "No expiry"] }]);
    // scopes: the three access policy actions are checkboxes, stacks:read and stack-service-accounts:write come through "Add scope"
    const scopes = r.steps.flatMap((s) => ("click" in s && s.click.role === "checkbox" ? [s.click.name] : []));
    expect(scopes).toEqual(["read accesspolicies", "write accesspolicies", "delete accesspolicies"]);
    const added = r.steps.flatMap((s) => ("fill" in s && s.fill.css === 'input[role=combobox][placeholder="Search…"]' ? [s.fill.value] : []));
    expect(added).toEqual(["stacks:read", "stack-service-accounts:write"]);
    expect(r.steps.filter((s) => "click" in s && s.click.createsToken)).toHaveLength(1);
    expect(r.steps.find((s) => "fill" in s && s.fill.label === "/token name/i")).toMatchObject({ fill: { value: "{{name}}" } });
    const pattern = new RegExp(r.capture.token.pattern!);
    expect(pattern.test("glc_eyJvIjoiMSIsIm4iOiJ0In0=")).toBe(true);
    expect(pattern.test("glsa_stack_token_0000")).toBe(false);
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
    expect(r.mask.length).toBeGreaterThan(0);
    expect((await readFile(join(RECIPES, "grafana-cloud-access-policy.yaml"), "utf8")).split("\n")[0]).toMatch(/^# STATUS: .*nothing else of this recipe is verified/);
  });
  it("a dry run of grafana-cloud-access-policy never clicks Create access policy or Create token", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "grafana-cloud-access-policy")!;
    // Every element is "visible", so a click is only missing when the run stopped before it.
    const d = new FakeDriver({
      url: "https://grafana.com/profile/org",
      on: (e, drv) => {
        if (e.action === "goto") drv.url = e.key;
        if (e.action === "click") drv.url = "https://grafana.com/orgs/acme/access-policies";
      },
    });
    Object.defineProperty(d, "visible", { value: Object.assign(new Set<string>(), { has: () => true }) });
    const result = await dryRunRecipe(r, { name: "probe", expiry: "90 days" }, d);
    expect(result.executed).toBeGreaterThan(5);
expect(d.calls).toContain('click link "New access policy" (exact)');
    expect(d.calls.some((c) => c.includes("Add scope"))).toBe(true);
    expect(d.calls.some((c) => c.includes("Create access policy"))).toBe(false);
    expect(d.calls.some((c) => c.includes("Create token"))).toBe(false);
    expect(d.calls.some((c) => c.includes("Add token"))).toBe(false);
  });
  it("anthropic-admin-key has a passwordless email sign-in with a code step, a Google button, and captures only an admin key", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "anthropic-admin-key")!;
    expect(r.host).toBe("platform.claude.com");
    expect(r.allowHosts).toEqual(["console.anthropic.com"]);
    expect(r.login?.form).toMatchObject({ passwordless: true, start: "https://platform.claude.com/login" });
    expect(r.login?.form?.mfa).toBeDefined();
    expect(JSON.stringify(r.login?.form?.steps)).not.toContain("login.password");
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google"]);
    expect(r.login?.methods?.find((m) => m.id === "google")?.steps?.[1]).toMatchObject({ click: { role: "button", name: expect.stringContaining("Google") } });
    const pattern = new RegExp(r.capture.token.pattern!);
    expect(pattern.test("sk-ant-admin01-AbC_d-123")).toBe(true);
    expect(pattern.test("sk-ant-api03-AbC_d-123")).toBe(false);
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
    expect(r.steps.find((s) => "click" in s && s.click.createsToken)).toBeDefined();
    expect(r.mask.length).toBeGreaterThan(0);
  });
  it("anthropic-admin-key ends as unsupported (not failed) when the page has no create button", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "anthropic-admin-key")!;
    const step = r.steps.find((x) => "fail" in x);
    expect(step).toMatchObject({ fail: expect.stringContaining("Admin keys need an Anthropic organization"), unsupported: true, when: { absent: { role: "button", first: true } } });
    // the create button of the organization is told apart in both languages
    const name = (step as { when: { absent: { name: string } } }).when.absent.name;
    const rx = textPattern(name)!;
    expect(["Create Admin Key", "Admin-Schlüssel erstellen"].every((n) => rx.test(n))).toBe(true);
    expect(rx.test("Abbrechen")).toBe(false);
  });
  it("anthropic-api-key follows the verified German dialog: placeholder, submit button, expiry from days, optional workspace", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "anthropic-api-key")!;
    expect(r.host).toBe("platform.claude.com");
    expect(r.params).toMatchObject([{ key: "workspace", required: false, default: "" }]);
    expect(r.steps.find((s) => "fill" in s)).toMatchObject({ fill: { placeholder: "my-secret-key", value: "{{name}}" } });
    expect(r.steps.find((s) => "click" in s && s.click.createsToken)).toMatchObject({ click: { css: "[role=dialog] button[type=submit]" } });
    // the create button appears twice: the first visible one, in both languages
    const create = r.steps.find((s) => "click" in s && s.click.first === true && s.click.role === "button" && !s.when);
    const createName = textPattern((create as { click: { name: string } }).click.name)!;
    expect(createName.test("Schlüssel erstellen") && createName.test("Create key")).toBe(true);
    const dialogContinue = r.steps.find((s) => "click" in s && s.click.optional === true && s.click.timeoutSeconds === 5) as { click: { name: string } };
    expect(textPattern(dialogContinue.click.name)!.test("Mit einem API-Schlüssel fortfahren")).toBe(true);
    // expiry: kept at the dialog default for 30 days, otherwise chosen by option text in both languages
    const expiry = r.steps.filter((s) => "click" in s && s.when && "var" in s.when && s.when.var === "days");
    expect(expiry).toHaveLength(2);
    expect(r.capture.expires).toEqual({ from: "days" });
    const option = textPattern((expiry[1] as { click: { name: string } }).click.name.replace("{{days}}", "60"))!;
    expect(option.test("60 Tage (3. Jan. 2027)") && option.test("60 days (Jan 3, 2027)") && !option.test("30 Tage")).toBe(true);
    expect(r.capture.externalId).toEqual({ from: "name" });
    const pattern = new RegExp(r.capture.token.pattern!);
    expect(pattern.test("sk-ant-api03-AbC_d-123")).toBe(true);
    expect(pattern.test("sk-ant-admin01-AbC_d-123")).toBe(false);
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
  });
  it("the anthropic recipes state what is verified and what is not", async () => {
    for (const f of ["anthropic-admin-key.yaml", "anthropic-api-key.yaml"]) {
      const first = (await readFile(join(RECIPES, f), "utf8")).split("\n")[0] ?? "";
      expect(first, f).toMatch(/^# STATUS: sign-in verified live 2026-11-04/);
      expect(first, f).toMatch(/NOT verified/);
    }
    expect((await readFile(join(RECIPES, "anthropic-api-key.yaml"), "utf8")).split("\n")[0]).toMatch(/read-only probe/);
  });
  it("carry the status comment (format only: first line starts with `# STATUS:`)", async () => {
    const files = (await readdir(RECIPES)).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const first = (await readFile(join(RECIPES, f), "utf8")).split("\n")[0] ?? "";
      expect(first, f).toMatch(/^# STATUS: \S/);
    }
  });
});

describe("loadRecipes", () => {
  it("reports file and path in the document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipes-"));
    await writeFile(join(dir, "kaputt.yaml"), "id: a\nlabel: A\nhost: example.test\nsteps:\n  - fill: { value: x }\ncapture: { token: { find: { css: '#t' } } }\n");
    await writeFile(join(dir, "yaml.yaml"), "id: [\n");
    const { recipes, errors } = await loadRecipesDetailed([dir, join(dir, "gibt-es-nicht")]);
    expect(recipes).toEqual([]);
    const msg = errors.map((e) => e.message).join("\n");
    expect(msg).toContain("kaputt.yaml");
    expect(msg).toMatch(/steps\.0\.fill/);
    expect(msg).toContain("yaml.yaml");
    await expect(loadRecipes([dir])).rejects.toThrow(/kaputt\.yaml/);
  });
  it("later folder overrides the same id", async () => {
    const a = await mkdtemp(join(tmpdir(), "recipes-"));
    const b = await mkdtemp(join(tmpdir(), "recipes-"));
    const doc = (label: string) => `id: dup\nlabel: ${label}\nhost: example.test\nsteps:\n  - click: { role: button, name: Go, createsToken: true }\ncapture: { token: { find: { css: '#t' } } }\n`;
    await writeFile(join(a, "x.yaml"), doc("A"));
    await writeFile(join(b, "x.yaml"), doc("B"));
    expect((await loadRecipes([a, b]))[0]?.label).toBe("B");
  });
});

describe("protection of bundled recipes", () => {
  const yaml = (id: string, host = "example.test") => `id: ${id}\nlabel: X\nhost: ${host}\nallowHosts: [cdn.example.test]\nsteps:\n  - goto: "https://${host}/t"\n  - click: { role: button, name: Create, createsToken: true }\ncapture: { token: { find: { css: '#t' } } }\n`;
  it("external recipes may not override bundled ones", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const ext = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(ext, "a.yaml"), yaml("a", "boese.test"));
    await writeFile(join(ext, "b.yaml"), yaml("b"));
    const { recipes, errors } = await loadRecipesDetailed([ext, bundled], { bundledDirs: [bundled], allowExternal: true });
    expect(recipes.find((r) => r.recipe.id === "a")!.host).toBe("example.test");
    expect(recipes.map((r) => r.recipe.id).sort()).toEqual(["a", "b"]);
    expect(errors.map((e) => e.message).join()).toContain("mitgelieferten");
  });
  it("external folders are not loaded without allowExternal", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const ext = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(ext, "b.yaml"), yaml("b"));
    const { recipes, skippedDirs } = await loadRecipesDetailed([bundled, ext], { bundledDirs: [bundled] });
    expect(recipes.map((r) => r.recipe.id)).toEqual(["a"]);
    expect(skippedDirs).toEqual([ext]);
  });
  it("a missing or empty external folder is not reported as skipped", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const empty = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(empty, "notes.txt"), "no recipes here");
    const { skippedDirs } = await loadRecipesDetailed([bundled, empty, join(empty, "missing")], { bundledDirs: [bundled] });
    expect(skippedDirs).toEqual([]);
  });
  it("returns SHA-256, host and allowHosts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-"));
    const text = yaml("a");
    await writeFile(join(dir, "a.yaml"), text);
    const [r] = (await loadRecipesDetailed([dir], { bundledDirs: [dir] })).recipes;
    expect(r!.sha256).toBe((await import("node:crypto")).createHash("sha256").update(text).digest("hex"));
    expect(r!.host).toBe("example.test");
    expect(r!.allowHosts).toEqual(["cdn.example.test"]);
    expect(r!.bundled).toBe(true);
  });
});
