import { describe, expect, it } from "vitest";
import { aggregateNeeds, environmentStage, extractWorkflowNeeds, needStage, refsInExpression } from "../src/workflow-needs.js";
import { DEFAULT_STAGES } from "../src/stages.js";

const wf = (name: string, content: string) => ({ name, content });
const brief = (r: { kind: string; name: string; file: string; environment?: string }[]) => r.map((x) => `${x.file}|${x.environment ?? "-"}|${x.kind}|${x.name}`).sort();

describe("refsInExpression", () => {
  it("secrets.X, vars.X and bracket form, without GITHUB_TOKEN and foreign contexts", () => {
    const r = refsInExpression("secrets.A && vars.B || secrets['C'] || secrets.GITHUB_TOKEN || github.secrets.D || mysecrets.E");
    expect(r.refs).toEqual([{ kind: "secret", name: "C" }, { kind: "secret", name: "A" }, { kind: "variable", name: "B" }]);
    expect(r.all).toBe(false);
  });
  it("strings are no matches", () => {
    expect(refsInExpression("'secrets.X' == 'a'").refs).toEqual([]);
  });
  it("secrets as a whole is a hint", () => {
    expect(refsInExpression("toJSON(secrets)").all).toBe(true);
    expect(refsInExpression("secrets.A").all).toBe(false);
  });
});

describe("extractWorkflowNeeds", () => {
  it("jobs with environment, without environment, multiple mentions in several files", () => {
    const deploy = wf("deploy.yml", `
name: Deploy
on: push
jobs:
  staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: echo "\${{ secrets.RESEND_API_KEY }}"
      - uses: x/y@v1
        with:
          token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          url: \${{ vars.NEXT_PUBLIC_APP_URL }}
  production:
    environment:
      name: production
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        env:
          KEY: \${{ secrets.RESEND_API_KEY }}
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.TURNSTILE_SECRET_KEY }}
`);
    const ci = wf("ci.yaml", `
on: pull_request
jobs:
  t:
    environment: staging
    runs-on: x
    steps:
      - run: echo \${{ secrets.RESEND_API_KEY }}
`);
    const { refs } = extractWorkflowNeeds([deploy, ci]);
    expect(brief(refs)).toEqual([
      "ci.yaml|staging|secret|RESEND_API_KEY",
      "deploy.yml|-|secret|TURNSTILE_SECRET_KEY",
      "deploy.yml|production|secret|RESEND_API_KEY",
      "deploy.yml|staging|secret|CLOUDFLARE_API_TOKEN",
      "deploy.yml|staging|secret|RESEND_API_KEY",
      "deploy.yml|staging|variable|NEXT_PUBLIC_APP_URL",
    ]);
    const agg = aggregateNeeds(refs);
    const resend = agg.find((a) => a.name === "RESEND_API_KEY")!;
    expect(resend.at).toEqual([{ environment: "staging", files: ["deploy.yml", "ci.yaml"] }, { environment: "production", files: ["deploy.yml"] }]);
  });

  it("comments and file names like secrets.sh do not count", () => {
    const { refs } = extractWorkflowNeeds([
      wf("a.yml", `
# token: \${{ secrets.COMMENTED }}
on: push
jobs:
  j:
    runs-on: x
    steps:
      - run: node scripts/secrets.mjs && bash ./secrets.sh # \${{ secrets.TRAILING_COMMENT }}
      - run: echo vars.NOT_AN_EXPRESSION
      - run: echo \${{ secrets.REAL }}
`),
    ]);
    expect(brief(refs)).toEqual(["a.yml|-|secret|REAL"]);
  });

  it("if, with, env and workflow-wide env; GITHUB_TOKEN drops out", () => {
    const { refs } = extractWorkflowNeeds([
      wf("b.yml", `
on: push
env:
  GLOBAL: \${{ secrets.GLOBAL_KEY }}
jobs:
  a:
    environment: production
    if: vars.ENABLE_DEPLOY == 'true'
    runs-on: x
    steps:
      - if: secrets.STEP_KEY != ''
        run: echo
      - uses: x/y@v1
        with:
          t: \${{ secrets.GITHUB_TOKEN }}
          u: \${{ secrets.USER_KEY }}
  b:
    runs-on: x
    steps:
      - run: echo
`),
    ]);
    expect(brief(refs)).toEqual([
      "b.yml|-|secret|GLOBAL_KEY",
      "b.yml|production|secret|GLOBAL_KEY",
      "b.yml|production|secret|STEP_KEY",
      "b.yml|production|secret|USER_KEY",
      "b.yml|production|variable|ENABLE_DEPLOY",
    ]);
  });

  it("matrix environment is resolved, dynamic only as hint", () => {
    const { refs, notes } = extractWorkflowNeeds([
      wf("m.yml", `
on: push
jobs:
  deploy:
    strategy:
      matrix:
        env: [staging, production]
    environment: \${{ matrix.env }}
    runs-on: x
    steps:
      - run: echo \${{ secrets.DEPLOY_KEY }}
  dyn:
    environment: \${{ inputs.target }}
    runs-on: x
    steps:
      - run: echo \${{ secrets.DYN_KEY }}
`),
    ]);
    expect(brief(refs)).toEqual(["m.yml|-|secret|DYN_KEY", "m.yml|production|secret|DEPLOY_KEY", "m.yml|staging|secret|DEPLOY_KEY"]);
    expect(notes).toEqual([{ code: "dynamic-environment", file: "m.yml", job: "dyn" }]);
  });

  it("reusable workflow: secrets block counts, inherit and secrets as a whole are hints", () => {
    const { refs, notes } = extractWorkflowNeeds([
      wf("r.yml", `
on: push
jobs:
  call:
    uses: org/repo/.github/workflows/x.yml@main
    with:
      v: \${{ vars.REUSE_VAR }}
    secrets:
      token: \${{ secrets.PASSED_TOKEN }}
  call2:
    uses: org/repo/.github/workflows/y.yml@main
    secrets: inherit
  all:
    runs-on: x
    steps:
      - run: echo '\${{ toJSON(secrets) }}'
`),
    ]);
    expect(brief(refs)).toEqual(["r.yml|-|secret|PASSED_TOKEN", "r.yml|-|variable|REUSE_VAR"]);
    expect(notes.map((n) => `${n.code}:${n.job}`).sort()).toEqual(["all-secrets:all", "inherit:call2"]);
  });

  it("invalid YAML is a hint, not a crash", () => {
    const r = extractWorkflowNeeds([wf("bad.yml", "a: [unclosed\n  - x: : :")]);
    expect(r.refs).toEqual([]);
    expect(r.notes).toEqual([{ code: "parse-error", file: "bad.yml" }]);
  });
});

describe("mapping to stages", () => {
  it("environment -> stage case-insensitively, without environment -> repo level", () => {
    expect(environmentStage(DEFAULT_STAGES, "Production")?.id).toBe("production");
    expect(environmentStage(DEFAULT_STAGES, "preview")).toBeUndefined();
    expect(needStage(DEFAULT_STAGES, "staging", "shared")).toBe("staging");
    expect(needStage(DEFAULT_STAGES, undefined, "shared")).toBe("shared");
    expect(needStage(DEFAULT_STAGES, undefined, undefined)).toBeUndefined();
    expect(needStage(DEFAULT_STAGES, "preview", "shared")).toBeUndefined();
  });
});

describe("optional names (checked only)", () => {
  const opt = (r: { name: string; optional?: boolean }[]) => r.map((x) => `${x.name}${x.optional ? "?" : ""}`).sort();
  it("refsInExpression: comparisons and if expressions are optional, values are not", () => {
    expect(opt(refsInExpression("secrets.A != ''").refs)).toEqual(["A?"]);
    expect(opt(refsInExpression("'' == secrets.A").refs)).toEqual(["A?"]);
    expect(opt(refsInExpression("secrets['B'] == ''").refs)).toEqual(["B?"]);
    expect(opt(refsInExpression("secrets.A").refs)).toEqual(["A"]);
    expect(opt(refsInExpression("secrets.A", true).refs)).toEqual(["A?"]);
  });
  it("only in if:/comparisons = optional; as env:/with: value binding", () => {
    const needs = extractWorkflowNeeds([
      wf("upptime.yml", `
on: push
jobs:
  notify:
    runs-on: x
    if: \${{ secrets.SLACK_HOOK != '' }}
    steps:
      - if: secrets.NTFY_TOPIC != ''
        run: echo hi
      - run: echo \${{ secrets.USED_TOKEN }}
      - if: secrets.USED_TOKEN != ''
        run: echo again
      - env:
          HAS_X: \${{ secrets.FLAG_ONLY == 'yes' }}
        run: echo
`),
    ]);
    const by = Object.fromEntries(needs.refs.map((r) => [r.name, r.optional === true]));
    expect(by).toEqual({ SLACK_HOOK: true, NTFY_TOPIC: true, USED_TOKEN: false, FLAG_ONLY: true });
  });
});
