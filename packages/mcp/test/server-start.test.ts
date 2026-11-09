import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverFile = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const transport = vi.hoisted(() => ({ failStart: false, started: 0 }));

// A fake stdio transport: the real one would take over stdin/stdout of the test worker.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    async start(): Promise<void> {
      transport.started += 1;
      if (transport.failStart) throw new Error("stdio unavailable");
    }
    async send(): Promise<void> {}
    async close(): Promise<void> {}
  },
}));

const originalArgv1 = process.argv[1];

beforeEach(() => {
  vi.resetModules();
  transport.failStart = false;
  transport.started = 0;
});
afterEach(() => {
  process.argv[1] = originalArgv1!;
  vi.restoreAllMocks();
});

describe("server entry point", () => {
  it("starts the stdio server when the file is run directly", async () => {
    process.argv[1] = realpathSync(serverFile);
    await import("../src/server.js");
    await vi.waitFor(() => expect(transport.started).toBe(1));
  });

  it("prints the error and exits 1 when the transport cannot start", async () => {
    process.argv[1] = realpathSync(serverFile);
    transport.failStart = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../src/server.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith("stdio unavailable");
  });

  it("does not start when imported by another module", async () => {
    await import("../src/server.js");
    expect(transport.started).toBe(0);
  });
});
