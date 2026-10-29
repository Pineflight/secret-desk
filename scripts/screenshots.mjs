#!/usr/bin/env node
// Takes the screenshots used in README.md and docs/ from the demo portal (simulated GitHub, made-up data).
//
//   pnpm build            (once)
//   pnpm docs:screenshots
//
// What it does: starts the portal in demo mode on its own port with a throw-away copy of the demo configuration
// (so nothing in the repository changes and an already running portal on port 4747 is left alone), waits until it
// answers, takes 1440x900 screenshots in English and light mode with the installed Chrome (findChrome from
// @secret-desk/automation, playwright-core, no browser download), writes them to docs/images/*.png and stops the
// portal it started. Needs no accounts and no network access.
//
// Environment: SECRET_DESK_SCREENSHOT_PORT (default 4790), SECRET_DESK_CHROME (path to Chrome/Chromium/Edge).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "images");
const port = Number(process.env.SECRET_DESK_SCREENSHOT_PORT ?? 4790);
const base = `http://127.0.0.1:${port}`;
const VIEWPORT = { width: 1440, height: 900 };

const fail = (message) => {
  console.error(`docs:screenshots: ${message}`);
  process.exit(1);
};

// 1. Preconditions: built libraries, a free port, Chrome, playwright-core.
const automationEntry = join(root, "packages", "automation", "dist", "index.js");
if (!existsSync(automationEntry)) fail("packages/automation/dist is missing. Run `pnpm build` first.");
const { findChrome, chromeInstallHint } = await import(pathToFileURL(automationEntry).href);

let chromePath;
try {
  chromePath = findChrome(process.env.SECRET_DESK_CHROME);
} catch (err) {
  fail(err.message);
}
if (!chromePath) fail(`Chrome, Chromium or Edge not found. ${chromeInstallHint()} Or set SECRET_DESK_CHROME.`);

let chromium;
try {
  ({ chromium } = createRequire(join(root, "packages", "automation", "package.json"))("playwright-core"));
} catch {
  fail("playwright-core is not installed (optional dependency). Run `pnpm install`.");
}

const portInUse = await new Promise((resolve) => {
  const socket = connect({ port, host: "127.0.0.1" });
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("error", () => resolve(false));
});
if (portInUse) fail(`Port ${port} is already in use. Set SECRET_DESK_SCREENSHOT_PORT to a free port.`);

// 2. Throw-away copy of the demo configuration on our own port.
const work = mkdtempSync(join(tmpdir(), "secret-desk-shots-"));
cpSync(join(root, "examples", "demo", "inventory.yaml"), join(work, "inventory.yaml"));
const configPath = join(work, "secret-desk.config.yaml");
writeFileSync(
  configPath,
  [
    "inventory: ./inventory.yaml",
    "evidenceDir: ./.evidence",
    "github:",
    "  owner: acme",
    "  auth: { type: pat, source: { type: env, name: GITHUB_DEMO_TOKEN } }",
    "policy: { agentStages: [dev], envRoots: [] }",
    // Own vault, link file and key: the screenshots never touch your real vault, keychain or folder links.
    `vault: { enabled: true, file: ${JSON.stringify(join(work, "vault.json"))} }`,
    `linksFile: ${JSON.stringify(join(work, "repo-links.json"))}`,
    `server: { port: ${port} }`,
    "",
  ].join("\n"),
);

// `next dev` rewrites apps/desk/next-env.d.ts and may add apps/desk/AGENTS.md: remember the state and restore it at the end.
const deskDir = join(root, "apps", "desk");
const nextEnvFile = join(deskDir, "next-env.d.ts");
const nextEnvBefore = existsSync(nextEnvFile) ? readFileSync(nextEnvFile, "utf8") : null;
const agentsFileExisted = existsSync(join(deskDir, "AGENTS.md"));

// 3. Start the portal in its own process group so that it can be stopped completely through our own handle.
const env = { ...process.env, SECRET_DESK_DEMO: "1", SECRET_DESK_NO_LAUNCH_SECRET: "1", SECRET_DESK_USER: "alice", SECRET_DESK_VAULT_KEY: randomBytes(32).toString("base64"), SECRET_DESK_CONFIG: configPath };
const args = ["--filter", "@secret-desk/desk", "exec", "next", "dev", "-H", "127.0.0.1", "-p", String(port)];
const pnpmJs = process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath) ? process.env.npm_execpath : undefined;
const win = process.platform === "win32";
const child = pnpmJs
  ? spawn(process.execPath, [pnpmJs, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: !win })
  : spawn("pnpm", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: !win, shell: win });
let serverLog = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (serverLog = (serverLog + d).slice(-4000)));
let exited = false;
child.on("exit", () => (exited = true));
child.on("error", (err) => fail(`could not start pnpm: ${err.message}`));

async function stopPortal() {
  if (exited || child.pid === undefined) return;
  if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 3000));
    if (!exited) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

let browser;
let code = 0;
try {
  // 4. Wait until the portal answers (the first request compiles the app).
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (exited) throw new Error(`the portal exited early.\n${serverLog}`);
    try {
      const res = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`the portal did not answer within 4 minutes.\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 5. Screenshots.
  mkdirSync(outDir, { recursive: true });
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US" });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("sd-locale", "en");
    } catch {
      /* storage blocked */
    }
  });
  const page = await context.newPage();
  const taken = [];

  const settle = async () => {
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(700);
  };
  const shot = async (name, path, prepare) => {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await settle();
    // Hide the Next.js development indicator, it is not part of the product.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    if (prepare) await prepare();
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    taken.push(file);
    console.log(`  ${name}.png  (${path})`);
  };

  // Load the portal once so that a session exists.
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await settle();

  // A pending review for the review screenshot: ask for a renewal of a demo secret (random value, nothing leaves the machine).
  let reviewId;
  try {
    reviewId = await page.evaluate(async () => {
      const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
      const res = await fetch("/api/ui/renewal-requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-secret-desk-csrf": session.csrf },
        body: JSON.stringify({ secretId: "cloudflare-deploy-acme-app" }),
      });
      const body = await res.json();
      return body?.issuance?.id ?? null;
    });
  } catch {
    reviewId = null;
  }

  await shot("overview", "/");

  await shot("entries", "/entries");
  await shot("secret-detail", "/secrets/cloudflare-deploy-acme-app");
  if (reviewId) {
    await shot("reviews", "/reviews");
    await shot("review-detail", `/reviews/${encodeURIComponent(reviewId)}`);
  } else console.warn("  no pending review could be created: skipping reviews.png and review-detail.png");
  await shot("variables", "/entries?kind=variable");
  await shot("compare", "/compare");
  await shot("compare-live", "/compare", async () => {
    await page.getByText("Check live against GitHub", { exact: false }).first().click();
    await page.waitForTimeout(1500);
    await settle();
    await page.evaluate(() => window.scrollTo(0, 560));
    await page.waitForTimeout(300);
  });
  await shot("repositories", "/repos");
  // Integrations: store made-up tokens in the throw-away vault so that the cards show their connected state. They are never used.
  const validUntil = new Date(Date.now() + 80 * 86_400_000).toISOString().slice(0, 10);
  await page.evaluate(async (until) => {
    const session = await (await fetch("/api/session", { credentials: "same-origin" })).json();
    for (const id of ["cloudflare", "supabase", "stripe-test", "resend"]) {
      await fetch(`/api/ui/connections/${id}/token`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-secret-desk-csrf": session.csrf },
        body: JSON.stringify({ token: `demo-not-a-real-token-${id}`, remember: true, expires: until }),
      });
    }
  }, validUntil);
  await shot("integrations", "/connections");
  await shot("settings", "/settings");

  const bad = taken.filter((f) => statSync(f).size < 10_000);
  if (bad.length > 0) throw new Error(`suspiciously small screenshots (blank page?): ${bad.join(", ")}`);
  console.log(`docs:screenshots: ${taken.length} screenshots written to docs/images/`);
} catch (err) {
  console.error(`docs:screenshots: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopPortal();
  rmSync(work, { recursive: true, force: true });
  if (nextEnvBefore !== null) writeFileSync(nextEnvFile, nextEnvBefore);
  if (!agentsFileExisted) rmSync(join(deskDir, "AGENTS.md"), { force: true });
}
process.exit(code);
