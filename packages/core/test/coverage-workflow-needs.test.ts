import { describe, expect, it } from "vitest";
import { aggregateNeeds, extractWorkflowNeeds, isWorkflowFileName, refsInExpression } from "../src/workflow-needs.js";

const wf = (content: string, name = "ci.yml") => ({ name, content });
const run = (content: string) => extractWorkflowNeeds([wf(content)]);

describe("workflow file names", () => {
  it("accepts yml and yaml files without a path", () => {
    expect(isWorkflowFileName("ci.yml")).toBe(true);
    expect(isWorkflowFileName("CI.YAML")).toBe(true);
    expect(isWorkflowFileName("ci.json")).toBe(false);
    expect(isWorkflowFileName("sub/ci.yml")).toBe(false);
    expect(isWorkflowFileName("sub\\ci.yml")).toBe(false);
  });
});

describe("references", () => {
  it("reads the bracket form with double quotes", () => {
    expect(refsInExpression('secrets["A_KEY"] && vars["B_URL"]').refs).toEqual([{ kind: "secret", name: "A_KEY" }, { kind: "variable", name: "B_URL" }]);
  });

  it("a reference that is only compared is optional; an if: makes every reference optional", () => {
    expect(refsInExpression("secrets.A != ''").refs).toEqual([{ kind: "secret", name: "A", optional: true }]);
    expect(refsInExpression("'' == vars.B").refs).toEqual([{ kind: "variable", name: "B", optional: true }]);
    expect(refsInExpression("secrets.A", true).refs).toEqual([{ kind: "secret", name: "A", optional: true }]);
  });

  it("an optional use becomes binding when the same file uses the value elsewhere", () => {
    const needs = run(`
jobs:
  build:
    steps:
      - if: secrets.TOKEN_X != ''
        run: echo checking
      - run: echo \${{ secrets.TOKEN_X }}
`);
    expect(needs.refs).toEqual([{ kind: "secret", name: "TOKEN_X", file: "ci.yml" }]);
  });

  it("an optional use stays optional when nothing else uses the value", () => {
    const needs = run(`
jobs:
  build:
    steps:
      - if: secrets.TOKEN_X != ''
        run: echo checking
      - if: secrets.TOKEN_X != ''
        run: echo again
`);
    expect(needs.refs).toEqual([{ kind: "secret", name: "TOKEN_X", file: "ci.yml", optional: true }]);
  });
});

describe("workflow structure", () => {
  it("files that are no mapping are skipped; jobs that are no mapping are ignored", () => {
    expect(extractWorkflowNeeds([wf(""), wf("just text"), wf("- a\n- b")])).toEqual({ refs: [], notes: [] });
    expect(run("jobs: nope\nenv:\n  A: ${{ secrets.TOP }}\n").refs).toEqual([{ kind: "secret", name: "TOP", file: "ci.yml" }]);
    expect(run("jobs:\n  a: nope\nenv:\n  A: ${{ secrets.TOP }}\n").refs).toEqual([{ kind: "secret", name: "TOP", file: "ci.yml" }]);
  });

  it("a file that cannot be parsed is noted once", () => {
    expect(extractWorkflowNeeds([wf("a: [unclosed")]).notes).toEqual([{ code: "parse-error", file: "ci.yml" }]);
  });

  it("numbers and booleans in a job are not expressions", () => {
    expect(run("jobs:\n  a:\n    timeout-minutes: 5\n    continue-on-error: true\n    steps:\n      - run: echo \\${{ secrets.X }}\n").refs.map((r) => r.name)).toEqual(["X"]);
  });

  it("a workflow-level reference without jobs is reported for the repository level; secrets as a whole is a note", () => {
    const needs = run("env:\n  ALL: ${{ toJSON(secrets) }}\n  ANOTHER: ${{ toJSON(secrets) }}\n");
    expect(needs.notes).toEqual([{ code: "all-secrets", file: "ci.yml" }]);
  });

  it("the same note for the same job is reported once; inherit is a note", () => {
    const needs = run(`
jobs:
  call:
    secrets: inherit
    with:
      a: \${{ toJSON(secrets) }}
      b: \${{ toJSON(secrets) }}
`);
    expect(needs.notes).toEqual([{ code: "inherit", file: "ci.yml", job: "call" }, { code: "all-secrets", file: "ci.yml", job: "call" }]);
  });
});

describe("job environments", () => {
  const envs = (environment: string, extra = "") => run(`jobs:\n  deploy:\n${extra}    environment: ${environment}\n    steps:\n      - run: echo \${{ secrets.X }}\n`);

  it("a matrix of environments gives one reference per value (list and include)", () => {
    const needs = envs("${{ matrix.env }}", "    strategy:\n      matrix:\n        env: [staging, production]\n        include:\n          - env: preview\n          - other: 1\n");
    expect(needs.refs.map((r) => r.environment)).toEqual(["staging", "production", "preview"]);
    expect(needs.notes).toEqual([]);
  });

  it("matrix values that are not text are skipped", () => {
    const needs = envs("${{ matrix.env }}", "    strategy:\n      matrix:\n        env: [staging, 1, true]\n");
    expect(needs.refs.map((r) => r.environment)).toEqual(["staging"]);
  });

  it("a matrix with include only, or an include that is no list", () => {
    expect(envs("${{ matrix.env }}", "    strategy:\n      matrix:\n        include:\n          - env: a\n").refs.map((r) => r.environment)).toEqual(["a"]);
    const broken = envs("${{ matrix.env }}", "    strategy:\n      matrix:\n        include: nope\n");
    expect(broken.notes).toEqual([{ code: "dynamic-environment", file: "ci.yml", job: "deploy" }]);
  });

  it("an environment that cannot be resolved is a note", () => {
    for (const name of ["${{ inputs.target }}", "${{ matrix.env }}-x", "${{ matrix.env }}${{ matrix.other }}"]) {
      expect(envs(name).notes, name).toEqual([{ code: "dynamic-environment", file: "ci.yml", job: "deploy" }]);
    }
    expect(envs("${{ matrix.env }}", "    strategy: nope\n").notes).toHaveLength(1);
    expect(envs("${{ matrix.env }}", "    strategy:\n      matrix: nope\n").notes).toHaveLength(1);
  });

  it("plain names, object form and an empty name", () => {
    expect(envs("production").refs.map((r) => r.environment)).toEqual(["production"]);
    expect(run("jobs:\n  d:\n    environment:\n      name: staging\n      url: https://x\n    steps:\n      - run: echo ${{ secrets.X }}\n").refs.map((r) => r.environment)).toEqual(["staging"]);
    expect(envs("''").refs.map((r) => r.environment)).toEqual([undefined]);
  });
});

describe("aggregateNeeds", () => {
  it("lists a file once per environment even when it names the need twice", () => {
    const agg = aggregateNeeds([
      { kind: "secret", name: "A", file: "ci.yml", environment: "staging" },
      { kind: "secret", name: "A", file: "ci.yml", environment: "staging" },
      { kind: "secret", name: "A", file: "deploy.yml", environment: "staging" },
      { kind: "secret", name: "A", file: "ci.yml" },
      { kind: "variable", name: "A", file: "ci.yml" },
    ]);
    expect(agg).toEqual([
      { kind: "secret", name: "A", at: [{ environment: "staging", files: ["ci.yml", "deploy.yml"] }, { files: ["ci.yml"] }] },
      { kind: "variable", name: "A", at: [{ files: ["ci.yml"] }] },
    ]);
  });
});
