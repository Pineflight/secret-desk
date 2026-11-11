import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver, describeSelector } from "@secret-desk/automation";
import { createRuntime } from "../../src/runtime.js";

/** Made-up values: nothing here is a real key. They must never show up in a report or a log line. */
export const FAKE_TOKEN = "sk-admin-MADEUPLIVECHECKVALUE0001";
export const FAKE_PAGE_TEXT = "MADEUP-PAGE-TEXT-WITH-A-VALUE-0002";
export const FAKE_HOOK_URL = "https://hooks.example.com/MADEUPHOOKPATH0003";

const tokenSelector = describeSelector({ css: "#tok" });
export const GENERATE = describeSelector({ role: "button", name: "Generate", exact: true });

const header = (id: string, host = "a.example.com", extra = ""): string => `id: ${id}\nlabel: Recipe ${id}\nhost: ${host}\n${extra}`;
const createCapture = "capture:\n  token:\n    find: { css: \"#tok\" }\nmask: []\n";
const login = (host: string): string => `login:\n  expect: { url: "^https://${host.replaceAll(".", "\\\\.")}/keys" }\n`;

/** Small recipes that cover what the live check has to tell apart. File name = id. */
export const RECIPES: Record<string, string> = {
  "ok-create": `${header("ok-create")}${login("a.example.com")}steps:
  - goto: "https://a.example.com/keys/new?name={{name}}"
  - fill: { label: "Token name", value: "{{name}}" }
  - click: { role: button, name: Pick }
    each: repos
  - click: { role: button, name: Generate, exact: true, createsToken: true }
  - waitFor: { text: "Saved" }
${createCapture}`,
  "read-mode": `kind: read
${header("read-mode", "b.example.com")}${login("b.example.com")}steps:
  - goto: "https://b.example.com/keys"
  - waitFor: { visible: { css: "#k1" } }
  - screenshot: shown
capture:
  values:
    first: { find: { css: "#k1" }, pattern: "^(.+)$" }
mask: []
`,
  "broken-click": `${header("broken-click", "c.example.com")}${login("c.example.com")}steps:
  - goto: "https://c.example.com/keys"
  - click: { role: button, name: "Renamed button" }
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "signed-out": `${header("signed-out", "d.example.com")}${login("d.example.com")}steps:
  - goto: "https://d.example.com/keys"
  - fill: { label: "Token name", value: "{{name}}" }
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "sudo-prompt": `${header("sudo-prompt", "e.example.com")}${login("e.example.com")}steps:
  - goto: "https://e.example.com/keys/new"
  - confirmAccess:
      flow: github-sudo
      until: { visible: { label: "Token name" } }
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "needs-param": `${header("needs-param", "f.example.com", "params:\n  - key: account\n    label: Account\n")}${login("f.example.com")}steps:
  - goto: "https://f.example.com/{{account}}/keys"
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "needs-param-provider": `${header("needs-param-provider", "f.example.com", "provider: acme-api\nparams:\n  - key: account\n    label: Account\n")}${login("f.example.com")}steps:
  - goto: "https://f.example.com/{{account}}/keys"
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "list-only": `${header("list-only", "g.example.com")}${login("g.example.com")}steps:
  - click: { role: button, name: Generate, exact: true, createsToken: true }
    each: repos
${createCapture}`,
  "unsupported-page": `${header("unsupported-page", "h.example.com")}${login("h.example.com")}steps:
  - goto: "https://h.example.com/keys"
  - fail: "This account has no such feature."
    unsupported: true
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "hang": `${header("hang", "hang.example.com")}${login("hang.example.com")}steps:
  - goto: "https://hang.example.com/keys"
  - click: { role: button, name: Generate, exact: true, createsToken: true }
${createCapture}`,
  "choice-host": `kind: read
id: choice-host
label: Recipe choice-host
hostBy: portal
hosts:
  live: i.example.com
  test: test.i.example.com
params:
  - key: portal
    label: Portal
    options: ["live", "test"]
  - key: value
    label: Value
    options: ["first", "second"]
login:
  expect: { url: "^https://{{host}}/keys" }
steps:
  - goto: "https://i.example.com/keys"
    when: { var: portal, equals: live }
  - goto: "https://test.i.example.com/keys"
    when: { var: portal, equals: test }
capture:
  values:
    first: { find: { css: "#k1" }, pattern: "^(.+)$" }
    second: { find: { css: "#k2" }, pattern: "^(.+)$" }
  pick: value
mask: []
`,
};

export interface World {
  /** Hosts at which the browser is signed in (the rest is sent to a sign-in page). */
  signedIn: Set<string>;
  /** Selector descriptions that are visible on every page. */
  visible: string[];
  /** Page text on every page. */
  pageText: string[];
  /** Hosts whose pages never answer. */
  hang: Set<string>;
  drivers: FakeDriver[];
  /** Runs for every goto, before the page is shown. */
  onGoto?: (host: string) => void;
}

export function newWorld(init: Partial<World> = {}): World {
  return { signedIn: new Set(), visible: [], pageText: [], hang: new Set(), drivers: [], ...init };
}

export function driverFor(w: World): FakeDriver {
  const d = new FakeDriver({
    pollMs: 2,
    visible: w.visible,
    pageText: w.pageText,
    texts: { [tokenSelector]: FAKE_PAGE_TEXT, [describeSelector({ css: "#k1" })]: FAKE_PAGE_TEXT, [describeSelector({ css: "#k2" })]: FAKE_PAGE_TEXT },
    attributes: { [`${tokenSelector}@aria-label`]: FAKE_PAGE_TEXT },
    on: (e, drv) => {
      if (e.action !== "goto") return;
      const host = new URL(e.key).hostname;
      w.onGoto?.(host);
      if (w.hang.has(host)) return new Promise<void>(() => undefined);
      drv.url = w.signedIn.has(host) ? `https://${host}/keys` : `https://${host}/login`;
      return undefined;
    },
  });
  w.drivers.push(d);
  return d;
}

export interface SetupOptions {
  recipes?: string[];
  automation?: string;
  env?: Record<string, string>;
  connections?: string;
  fetch?: typeof fetch;
  persist?: boolean;
  dir?: string;
  world?: World;
  driver?: () => FakeDriver | Promise<FakeDriver>;
  /** Replaces the empty inventory (full YAML text). */
  inventory?: string;
}

export async function setup(opts: SetupOptions = {}) {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), "sd-live-check-")));
  const recipesDir = join(dir, "bundled");
  await mkdir(recipesDir, { recursive: true });
  for (const id of opts.recipes ?? []) await writeFile(join(recipesDir, `${id}.yaml`), RECIPES[id] ?? "");
  await writeFile(join(dir, "inventory.yaml"), opts.inventory ?? "version: 1\nsecrets: []\n");
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml\nlinksFile: ${join(dir, "data", "repo-links.json")}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${opts.connections ?? ""}${opts.automation ?? ""}`,
  );
  const world = opts.world ?? newWorld();
  const fetchCalls: { url: string; method: string; body: string | undefined; redirect: string | undefined }[] = [];
  const baseFetch = opts.fetch ?? ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
  const recordingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, redirect: init?.redirect });
    return baseFetch(url, init);
  }) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: (opts.env ?? {}) as unknown as NodeJS.ProcessEnv,
    fetch: recordingFetch,
    bundledRecipes: join(dir, "bundled"),
    automationDriver: opts.driver ?? (() => driverFor(world)),
    persistSignIn: opts.persist ?? false,
  });
  const lines: string[] = [];
  return { rt, dir, world, lines, log: (l: string) => void lines.push(l), fetchCalls };
}
