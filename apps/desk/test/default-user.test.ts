import { userInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultUser } from "../src/server/router";

const saved = process.env.SECRET_DESK_USER;
afterEach(() => {
  if (saved === undefined) delete process.env.SECRET_DESK_USER;
  else process.env.SECRET_DESK_USER = saved;
});

describe("defaultUser", () => {
  it("nimmt SECRET_DESK_USER, sonst den Betriebssystem-Benutzer", () => {
    process.env.SECRET_DESK_USER = "alice";
    expect(defaultUser()).toBe("alice");
    delete process.env.SECRET_DESK_USER;
    expect(defaultUser()).toBe(userInfo().username || "local");
  });
});
