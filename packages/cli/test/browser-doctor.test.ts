import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCmd } from "../src/browser.js";

async function doctor(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await browserCmd(["doctor", ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

let server: Server | undefined;
beforeEach(() => vi.stubEnv("SECRET_DESK_BROWSER_CDP", ""));
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  server = undefined;
});

async function devtools(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === "/json/version") res.end(JSON.stringify({ Browser: "Chrome/140.0.0.0" }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("browser doctor", () => {
  it("local mode names the mode and looks for Chrome and the profile", async () => {
    const r = await doctor([]);
    expect(r.text).toContain("Mode: local Chrome");
    expect(r.text).toContain("Profilordner:");
  });

  it("remote mode (--cdp): reports the mode, asks the endpoint, skips Chrome and the profile folder", async () => {
    const url = await devtools();
    const r = await doctor(["--cdp", url.replace("http://", "http://user:s3cret@")]);
    expect(r.text).toContain(`Mode: remote browser at ${url} (local Chrome and profile folder are not used)`);
    expect(r.text).toContain("Remote browser answers: Chrome/140.0.0.0");
    expect(r.text).not.toContain("Profilordner:");
    expect(r.text).not.toContain("Chrome gefunden");
    expect(r.text).not.toContain("s3cret");
    expect(r.code).toBe(0);
  });

  it("remote mode via the environment variable; an endpoint that does not answer fails the check", async () => {
    vi.stubEnv("SECRET_DESK_BROWSER_CDP", "http://u:s3cret@127.0.0.1:9");
    const r = await doctor([]);
    expect(r.text).toContain("Mode: remote browser at http://127.0.0.1:9");
    expect(r.text).toContain("[fail] Remote browser not reachable");
    expect(r.text).not.toContain("s3cret");
    expect(r.code).toBe(1);
  });

  it("an invalid endpoint fails without echoing it", async () => {
    const r = await doctor(["--cdp", "ftp://u:hunter2@host"]);
    expect(r.text).toContain("[fail] Invalid browser endpoint: only http, https, ws and wss are allowed");
    expect(r.text).not.toContain("hunter2");
    expect(r.code).toBe(1);
  });
});
