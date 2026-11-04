import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHOICE_STORAGE_KEY,
  confirmStep,
  EMPTY_CHOICE,
  keepChoice,
  parseChoice,
  readChoice,
  withBranch,
  withFile,
  withMode,
  withRepo,
  writeChoice,
} from "../src/lib/setup-choice";

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

describe("setup choice", () => {
  const chosen = confirmStep(withFile(withBranch(withRepo(EMPTY_CHOICE, "acme-org/other-config"), "main"), "team.yaml"), "repo");

  it("keeps the human's choice over a suggestion, whenever the discovery data refreshes", () => {
    expect(keepChoice("acme-org/other-config", "acme-org/team-config")).toBe("acme-org/other-config");
    expect(keepChoice("", "acme-org/team-config")).toBe("acme-org/team-config");
  });

  it("survives a reload through storage", () => {
    const store = memory();
    writeChoice(withMode(chosen, "pull-push", "direct"), store);
    const back = readChoice(store);
    expect(back.repo).toBe("acme-org/other-config");
    expect(back.branch).toBe("main");
    expect(back.file).toBe("team.yaml");
    expect(back.mode).toBe("pull-push");
    expect(back.strategy).toBe("direct");
    expect(back.confirmed.repo).toBe(true);
  });

  it("falls back to the empty choice for broken or blocked storage", () => {
    const store = memory();
    store.data.set(CHOICE_STORAGE_KEY, "{not json");
    expect(readChoice(store)).toEqual(EMPTY_CHOICE);
    expect(readChoice({ getItem: () => { throw new Error("blocked"); } })).toEqual(EMPTY_CHOICE);
    expect(() => writeChoice(chosen, { setItem: () => { throw new Error("full"); }, removeItem: () => undefined })).not.toThrow();
    expect(parseChoice("x")).toEqual(EMPTY_CHOICE);
  });

  it("does not trust confirmations that lack their data", () => {
    const c = parseChoice({ repo: "", branch: "main", file: "t.yaml", confirmed: { repo: true, file: true, mode: true } });
    expect(c.confirmed).toEqual({ repo: false, file: false, mode: false });
    const d = parseChoice({ repo: "a/b", branch: "main", file: "t.yaml", confirmed: { repo: false, file: true, mode: true } });
    expect(d.confirmed).toEqual({ repo: false, file: false, mode: false });
  });

  it("a different repository resets everything below it, the same one changes nothing", () => {
    const all = confirmStep(confirmStep(chosen, "file"), "mode");
    expect(withRepo(all, "acme-org/other-config")).toBe(all);
    const next = withRepo(all, "acme-org/third");
    expect(next.branch).toBe("");
    expect(next.file).toBe("");
    expect(next.confirmed).toEqual({ repo: false, file: false, mode: false });
  });

  it("changing the file or the mode withdraws the later confirmations", () => {
    const all = confirmStep(confirmStep(chosen, "file"), "mode");
    expect(withFile(all, "other.yaml").confirmed).toEqual({ repo: true, file: false, mode: false });
    expect(withMode(all, "pull-push", "pull-request").confirmed).toEqual({ repo: true, file: true, mode: false });
  });
});

describe("prompt buttons never submit a page form", () => {
  const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

  it("every prompt form prevents the native submit and stops it bubbling into a surrounding form", () => {
    const prompts = src("components/RunPrompts.tsx");
    const forms = prompts.match(/<form/g)?.length ?? 0;
    expect(forms).toBeGreaterThan(0);
    expect(prompts.match(/e\.preventDefault\(\)/g)?.length).toBe(forms);
    expect(prompts.match(/e\.stopPropagation\(\)/g)?.length).toBe(forms);
  });

  it("the setup page does not wrap the picker (which holds the prompts) in a form", () => {
    const page = src("app/setup/page.tsx");
    const picker = page.indexOf("<TeamConfigPicker");
    expect(picker).toBeGreaterThan(-1);
    const before = page.slice(0, picker);
    expect(before.lastIndexOf("<form")).toBeLessThanOrEqual(before.lastIndexOf("</form>"));
  });

  it("the shared Button defaults to type=button", () => {
    expect(src("components/ui.tsx")).toMatch(/<button\s+type="button"\s+\{\.\.\.rest\}/);
  });
});
