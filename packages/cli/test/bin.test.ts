import { afterEach, describe, expect, it, vi } from "vitest";

describe("bin", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("runs main with the command line arguments and sets the exit code", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "secret-desk", "no-such-command"];
    await import("../src/bin.js");
    expect(process.exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Aufruf: secret-desk"));
    expect(log).not.toHaveBeenCalled();
  });
});
