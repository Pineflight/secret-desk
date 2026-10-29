import { afterEach, describe, expect, it, vi } from "vitest";

const userInfoMock = vi.fn<() => { username: string }>();
vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:os")>()), userInfo: () => userInfoMock() }));

import { defaultUser } from "../src/server/router";

const saved = process.env.SECRET_DESK_USER;
afterEach(() => {
  userInfoMock.mockReset();
  if (saved === undefined) delete process.env.SECRET_DESK_USER;
  else process.env.SECRET_DESK_USER = saved;
});

describe("defaultUser", () => {
  it("SECRET_DESK_USER takes precedence over the operating system user", () => {
    process.env.SECRET_DESK_USER = "alice";
    userInfoMock.mockReturnValue({ username: "bob" });
    expect(defaultUser()).toBe("alice");
  });
  it("otherwise the operating system user", () => {
    delete process.env.SECRET_DESK_USER;
    userInfoMock.mockReturnValue({ username: "bob" });
    expect(defaultUser()).toBe("bob");
  });
  it("empty name or read error -> local", () => {
    delete process.env.SECRET_DESK_USER;
    userInfoMock.mockReturnValue({ username: "" });
    expect(defaultUser()).toBe("local");
    userInfoMock.mockImplementation(() => {
      throw new Error("kein Benutzer");
    });
    expect(defaultUser()).toBe("local");
  });
});
