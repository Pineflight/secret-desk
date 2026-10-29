import { afterEach, describe, expect, it } from "vitest";
import { defaultEnvPath } from "../src/lib/repos";
import { formatDate, formatDateTime } from "../src/lib/format";

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("plain dates in every time zone", () => {
  for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Kiritimati", "Asia/Kolkata"]) {
    it(`2026-10-27 stays the 27th in ${tz}`, () => {
      process.env.TZ = tz;
      expect(formatDate("2026-10-27")).toBe("27.10.2026");
      expect(formatDateTime("2026-10-27")).toBe("27.10.2026");
    });
  }
  it("timestamps without zone keep their time of day", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatDateTime("2026-11-02T10:05:00")).toBe("02.11.2026, 10:05");
  });
});

describe("defaultEnvPath", () => {
  it("POSIX paths", () => {
    expect(defaultEnvPath("/p/wm/", ".env.local")).toBe("/p/wm/.env.local");
    expect(defaultEnvPath("/p/wm//", "/.env.local")).toBe("/p/wm/.env.local");
  });
  it("Windows paths keep the backslash", () => {
    expect(defaultEnvPath("C:\\Users\\anna\\proj", ".env.local")).toBe("C:\\Users\\anna\\proj\\.env.local");
    expect(defaultEnvPath("C:\\Users\\anna\\proj\\", ".env.local")).toBe("C:\\Users\\anna\\proj\\.env.local");
  });
  it("no folder -> null", () => {
    expect(defaultEnvPath(undefined, ".env")).toBeNull();
  });
});
