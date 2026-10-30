import { describe, expect, it } from "vitest";
import { parseLaunchInput } from "../src/lib/launch.js";

const SECRET = "made-up-launch-secret-for-tests_0123456789";

describe("parseLaunchInput", () => {
  it("takes the secret from a full launch address", () => {
    expect(parseLaunchInput(`http://127.0.0.1:4747/?launch=${SECRET}`)).toBe(SECRET);
    expect(parseLaunchInput(`  http://desk.local/entries?x=1&launch=${SECRET}#top  `)).toBe(SECRET);
  });

  it("takes a relative address and a bare query", () => {
    expect(parseLaunchInput(`/?launch=${SECRET}`)).toBe(SECRET);
    expect(parseLaunchInput(`?launch=${SECRET}`)).toBe(SECRET);
  });

  it("accepts the bare secret", () => {
    expect(parseLaunchInput(SECRET)).toBe(SECRET);
  });

  it("rejects empty, too short or malformed input", () => {
    expect(parseLaunchInput("")).toBeNull();
    expect(parseLaunchInput("short")).toBeNull();
    expect(parseLaunchInput("http://127.0.0.1:4747/")).toBeNull();
    expect(parseLaunchInput("http://127.0.0.1:4747/?launch=")).toBeNull();
    expect(parseLaunchInput("has spaces in the middle of it")).toBeNull();
    expect(parseLaunchInput(`http://127.0.0.1:4747/?launch=${SECRET}<script>`)).toBeNull();
  });
});
