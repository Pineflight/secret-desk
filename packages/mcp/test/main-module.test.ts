import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMainModule } from "../src/server.js";

describe("isMainModule", () => {
  it("compares file URLs, not strings with file://", () => {
    const self = realpathSync(process.argv[1]!);
    expect(isMainModule(pathToFileURL(self).href, process.argv[1])).toBe(true);
    expect(isMainModule(pathToFileURL(`${self}.anders`).href, process.argv[1])).toBe(false);
    expect(isMainModule("file:///C:/x/server.js", undefined)).toBe(false);
    expect(isMainModule("file:///C:/x/server.js", "C:\\gibt\\es\\nicht\\server.js")).toBe(false);
  });
});
